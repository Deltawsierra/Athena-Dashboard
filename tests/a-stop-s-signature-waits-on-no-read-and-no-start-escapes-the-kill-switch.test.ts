import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import request from "supertest";
import type { Express } from "express";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { DEFAULT_ACTIVE_SYSTEMS } from "@shared/ai-systems";

/**
 * SAFETY, round five of PR #56 (the round-four review's findings), on the
 * memory backend with the recorded engine answers (tests/fixtures/engine-retest):
 *
 *   - A stop's signature waits on no unbounded read. A command this dashboard
 *     drafted, listed or read is known here, and its pause's signature is
 *     relayed from memory with no read; any other command's action is read
 *     once, within 250 ms in all, and a read that fails or runs out of time
 *     relays the signature of a session held as an admin's as a possible
 *     stop, logged so. A resume known to be one still needs the account.
 *   - The kill switch holds from the instant it is pressed: in memory, before
 *     its flag is stored. A start in flight at the press is not sent -- or, if
 *     the engine accepted it after the press, is stopped at once by its run
 *     id and answered so.
 *   - Every kill-switch answer states the switch as it is when it is given;
 *     `superseded` only after a later change that was stored (or pressed).
 *   - A connection refused before anything was sent frees a retest's slot.
 *   - Every engine and control-plane answer's body has a limit.
 *   - And the branches the round-four review found untested.
 */

type Exchange = { request: { method: string; path: string; body?: Record<string, unknown> }; status: number; body: any };
type Fixture = { engine: { contract: string }; exchanges: Exchange[] };
const FIX = path.resolve(__dirname, "fixtures", "engine-retest");
const load = (dir: string, name: string): Fixture => JSON.parse(fs.readFileSync(path.join(FIX, dir, `${name}.json`), "utf8"));
const PR71 = "pr71-f4610ae";
const MAIN = "main-5779e99";
const pick = (fx: Fixture, method: string, t: (p: string) => boolean) =>
  fx.exchanges.filter((e) => e.request.method === method && t(e.request.path));
const retestOf = (fx: Fixture) => pick(fx, "POST", (p) => p === "/api/remediation/retest")[0];
const statusReadsOf = (fx: Fixture) => pick(fx, "GET", (p) => /^\/api\/scans\/[^/]+$/.test(p) && p !== "/api/scans/active");
const abortsOf = (fx: Fixture) => pick(fx, "POST", (p) => /\/abort$/.test(p));
const activeOf = (fx: Fixture) => pick(fx, "GET", (p) => p === "/api/scans/active")[0];

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

type Reply = { status: number; body: unknown };
const eng: {
  fixture: Fixture | null;
  retest: Reply | null;
  retestHold: Promise<void> | null;
  statusReads: Reply[];
  statusFail: number;
  active: Reply;
  abort: Reply;
  abortByRun: Map<string, Reply>;
  abortHold: Map<string, Promise<void>>;
  stallAbortBody: boolean;
  stallRetestBody: boolean;
  /** List each retest the engine is holding as a live `retest` run, as engine main does. */
  listHeldRetests: boolean;
} = {
  fixture: null, retest: null, retestHold: null, statusReads: [], statusFail: 0,
  active: { status: 200, body: { active: [] } }, abort: { status: 200, body: {} }, abortByRun: new Map(), abortHold: new Map(),
  stallAbortBody: false, stallRetestBody: false, listHeldRetests: false,
};
/** Retest requests the engine is holding right now: engine main's busy worker threads. */
let heldRetests = 0;
let stalledOpen = 0;
let resetRetestAfterMs: number | null = null;
/** Hold every /api/scans/active answer; answer /api/scan with this body, after this hold; stall these runs' abort bodies. */
let activeHoldMs = 0;
let scanReply: unknown = null;
let scanHold: Promise<void> | null = null;
const stallAbortFor = new Set<string>();
const calls: Array<{ line: string; at: number; body: Record<string, unknown> }> = [];
let engineServer: Server;
let app: Express;
let admin: ReturnType<typeof request.agent>;
let analyst: ReturnType<typeof request.agent>;
let analystId: string;
let storage: import("../server/storage").IStorage;
let retests: typeof import("../server/retests");
let engineModule: typeof import("../server/engine");
let routes: typeof import("../server/routes");
let watcher: import("../server/retests").RetestWatcher;
let failsafeModule: typeof import("../server/failsafe");
let adminId: string;

beforeAll(async () => {
  engineServer = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      const url = req.url ?? "";
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      calls.push({ line: `${req.method} ${url}`, at: performance.now(), body });
      const fx = eng.fixture;
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") {
        if (activeHoldMs > 0) await sleep(activeHoldMs);
        const listed = eng.active.body as { active?: unknown[] };
        if (eng.listHeldRetests && eng.active.status === 200 && Array.isArray(listed.active)) {
          const held = Array.from({ length: heldRetests }, (_, i) => ({
            run_id: `held-retest-${i}`, target: "https://offline.invalid/", kind: "retest", state: "running",
          }));
          return json(res, 200, { active: [...listed.active, ...held] });
        }
        return json(res, eng.active.status, eng.active.body);
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (req.method === "POST" && abort) {
        const runId = decodeURIComponent(abort[1]);
        const hold = eng.abortHold.get(runId);
        if (hold) await hold;
        if (eng.stallAbortBody || stallAbortFor.has(runId)) { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); stalledOpen += 1; res.on("close", () => { stalledOpen -= 1; }); return; }
        const answer = eng.abortByRun.get(runId) ?? eng.abort;
        return json(res, answer.status, answer.body);
      }
      if (!fx) return json(res, 500, { detail: "no fixture" });
      if (req.method === "POST" && url === "/api/scan") {
        if (scanHold) await scanHold;
        return json(res, fx.exchanges[0].status, scanReply ?? fx.exchanges[0].body);
      }
      if (req.method === "GET" && url.startsWith("/api/decisions?")) return json(res, fx.exchanges[1].status, fx.exchanges[1].body);
      if (req.method === "POST" && url === "/api/remediation/retest") {
        if (fx.engine.contract === "main" && body.wait_seconds !== undefined) {
          const refused = retestOf(load(MAIN, "wait-seconds-refused"));
          return json(res, refused.status, refused.body);
        }
        if (resetRetestAfterMs !== null) {
          // A proxy between the dashboard and engine main resets the idle
          // connection; engine main runs the retest to its end regardless.
          heldRetests += 1;
          setTimeout(() => req.socket.destroy(), resetRetestAfterMs);
          await (eng.retestHold ?? Promise.resolve());
          heldRetests -= 1;
          return;
        }
        if (eng.retestHold) {
          heldRetests += 1;
          await eng.retestHold;
          heldRetests -= 1;
        }
        if (eng.stallRetestBody) { res.writeHead(202, { "Content-Type": "application/json" }); res.write("{"); return; }
        const answer = eng.retest ?? retestOf(fx);
        return json(res, answer.status, answer.body);
      }
      if (req.method === "GET" && /^\/api\/scans\/[^/]+$/.test(url)) {
        if (eng.statusFail > 0) {
          eng.statusFail -= 1;
          return json(res, 503, { detail: "the engine is restarting" });
        }
        const next = eng.statusReads.length > 1 ? eng.statusReads.shift()! : eng.statusReads[0];
        return next ? json(res, next.status, next.body) : json(res, 404, { detail: "No such scan run" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  await new Promise<void>((r) => engineServer.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engineServer.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  app = createApp();
  await initializeDefaultData();
  admin = request.agent(app);
  expect((await admin.post("/api/auth/login").send({ username: "admin", password: "admin123" })).status).toBe(200);
  adminId = (await admin.get("/api/auth/check")).body.user.id;
  const made = await admin.post("/api/users").send({ username: "analyst3", password: "analyst-password", role: "user", email: "a3@a.test" });
  expect(made.status).toBe(201);
  analystId = made.body.id;
  analyst = request.agent(app);
  expect((await analyst.post("/api/auth/login").send({ username: "analyst3", password: "analyst-password" })).status).toBe(200);
  storage = (await import("../server/storage-unified")).storage;
  retests = await import("../server/retests");
  engineModule = await import("../server/engine");
  routes = await import("../server/routes");
  failsafeModule = await import("../server/failsafe");
  watcher = app.locals.retestWatcher;
  // The running scans these cases record are not to count against starting another.
  expect((await admin.patch("/api/ai-control").send({ maxConcurrentTests: 1000 })).status).toBe(200);
});

afterAll(async () => {
  watcher.halt();
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  engineServer.closeAllConnections?.();
  await new Promise<void>((r) => engineServer.close(() => r()));
});

/** The knobs the cases shorten: a build without one still runs each case, which then fails on what it checks. */
const timeouts = () => ((engineModule as { engineTimeouts?: Record<string, number> }).engineTimeouts ?? {}) as Record<string, number>;
const slots = () => ((routes as { retestSlots?: Record<string, number> }).retestSlots ?? {}) as Record<string, number>;
const resumeState = (): { loaded: boolean; failedReads: number } =>
  (watcher as unknown as { resumeState?: () => { loaded: boolean; failedReads: number } }).resumeState?.() ?? { loaded: false, failedReads: 0 };
const TIMEOUTS = { callMs: 20_000, bodyMs: 20_000, abortBodyMs: 2_000 };
const SLOTS = { pollMs: 5_000, ceilingMs: 30 * 60_000 };
const FAILSAFE_TIMEOUTS = { callMs: 15_000, bodyMs: 15_000, stopBodyMs: 2_000, commandReadMs: 250 };
/** The control plane's knobs; a build without them still runs each case, which then fails on what it checks. */
const fsTimeouts = () => ((failsafeModule as { failsafeTimeouts?: Record<string, number> }).failsafeTimeouts ?? {}) as Record<string, number>;
beforeEach(async () => {
  // Each case starts with the switch off, whatever the one before it left.
  await storage.updateAIControlSettings({
    killSwitchEnabled: false, systemStatus: "active", activeSystems: [...DEFAULT_ACTIVE_SYSTEMS], maxConcurrentTests: 1000,
  });
  Object.assign(eng, {
    fixture: null, retest: null, retestHold: null, statusReads: [], statusFail: 0,
    active: { status: 200, body: { active: [] } }, abort: { status: 200, body: {} }, abortByRun: new Map(), abortHold: new Map(),
    stallAbortBody: false, stallRetestBody: false, listHeldRetests: false,
  });
  calls.length = 0;
  vi.restoreAllMocks();
  activeHoldMs = 0; scanReply = null; scanHold = null; stallAbortFor.clear();
  Object.assign(fsTimeouts(), FAILSAFE_TIMEOUTS);
  watcher.reset();
  (storage as unknown as { retestWatches: Map<string, unknown> }).retestWatches.clear();
  (storage as unknown as { checks: unknown[] }).checks.length = 0;
  Object.assign(retests.retestWatch, {
    intervalMs: 25, totalMs: 60_000, resumeRetryMs: 1_000, resumeRetryMaxMs: 60_000, deadlineReadRetries: 5,
  });
  Object.assign(timeouts(), TIMEOUTS);
  Object.assign(slots(), SLOTS);
});

let n = 0;
async function scanned(fx: Fixture, as = admin) {
  eng.fixture = fx;
  n += 1;
  const client = await admin.post("/api/clients").send({ name: `Round3 ${n}`, company: "R", email: `r3-${n}@r.test` });
  const site = await admin.post("/api/sites").send({ clientId: client.body.id, name: "Main", url: "https://offline.invalid" });
  const started = await as.post("/api/scans").send({ clientId: client.body.id, siteId: site.body.id, target: fx.exchanges[0].body.target });
  expect(started.status).toBe(201);
  const findings = await storage.getFindingsByClient(client.body.id);
  return { testId: started.body.test.id as string, finding: findings[0], runId: started.body.runId as string };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 4_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(20);
    last = await read();
  }
  return last;
}
/** An engine scan recorded as running, under a run id of the case's choosing. */
async function runningTest(runId: string) {
  const client = await storage.createClient({ name: `Running ${runId}`, company: "R", email: `${runId}@r.test` });
  return storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "running",
    findings: { runId, target: "https://offline.invalid/", results: [] },
  });
}
const aborts = () => calls.filter((c) => c.line.endsWith("/abort")).map((c) => c.line);
const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p.then((v) => ({ done: true as const, v })), sleep(ms).then(() => ({ done: false as const }))]);

const REACTIVATE = { killSwitchEnabled: false, systemStatus: "active" };

/**
 * A stand-in failsafe control plane. A command's action is read from its uuid
 * ("resume", "release", "standdown" in it; otherwise a pause). Its GET of one
 * command can be slow, stall its body, or fail; a draft answers a command of
 * the action asked for; its list and its state carry `listed`.
 */
async function plane(opts: {
  getDelayMs?: number; stallGetBody?: boolean; getFails?: boolean; stallSignatureBody?: boolean; stallEverything?: boolean;
  listed?: Array<{ uuid: string; action: string }>;
  /** How long its token endpoint takes (password hashing on the backend), and the token it issues. */
  tokenDelayMs?: number; token?: () => string;
  /** How long a signature takes to be answered. */
  signatureDelayMs?: number;
} = {}) {
  const seen: Array<{ line: string; at: number }> = [];
  /** Each command's status on this control plane: a signature makes it ready, a withdrawal cancels it. */
  const statuses = new Map<string, string>();
  const actionOf = (uuid: string) => (uuid.includes("resume") ? "resume" : uuid.includes("release") ? "release"
    : uuid.includes("standdown") ? "stand_down" : "pause");
  const cmd = (uuid: string, action: string) => ({ uuid, action, engine_id: "engine-1", status: "pending", signers: [], required_signatures: 1 });
  let drafted = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      seen.push({ line: `${req.method} ${req.url}`, at: Date.now() });
      if (req.url === "/api/token/") {
        if (opts.tokenDelayMs) await sleep(opts.tokenDelayMs);
        return json(res, 200, { access: opts.token?.() ?? "tok" });
      }
      if (opts.stallEverything) { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); return; }
      const sig = /^\/api\/failsafe\/commands\/([^/]+)\/signatures\/$/.exec(req.url ?? "");
      if (sig) {
        if (opts.stallSignatureBody) { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); return; }
        if (opts.signatureDelayMs) await sleep(opts.signatureDelayMs);
        if (statuses.get(sig[1]) === "canceled") return json(res, 409, { detail: "the command was canceled" });
        statuses.set(sig[1], "ready");
        return json(res, 200, { ...cmd(sig[1], actionOf(sig[1])), status: "ready", signers: ["k1"] });
      }
      const withdraw = /^\/api\/failsafe\/commands\/([^/]+)\/cancel\/$/.exec(req.url ?? "");
      if (withdraw && req.method === "POST") {
        statuses.set(withdraw[1], "canceled");
        return json(res, 200, { ...cmd(withdraw[1], actionOf(withdraw[1])), status: "canceled" });
      }
      if (req.url === "/api/failsafe/commands/" && req.method === "POST") {
        drafted += 1;
        const action = (JSON.parse(raw) as { action: string }).action;
        return json(res, 201, { ...cmd(`drafted-${action}-${drafted}-${Date.now()}`, action), signing_bytes: "00" });
      }
      if (req.url?.startsWith("/api/failsafe/commands/?") || req.url === "/api/failsafe/commands/") {
        return json(res, 200, (opts.listed ?? []).map((one) => cmd(one.uuid, one.action)));
      }
      if (req.url?.startsWith("/api/failsafe/state/")) {
        return json(res, 200, { engine_id: "engine-1", awaiting_signatures: (opts.listed ?? []).map((one) => cmd(one.uuid, one.action)), ready: [], recent: [] });
      }
      const one = /^\/api\/failsafe\/commands\/([^/]+)\/$/.exec(req.url ?? "");
      if (one && req.method === "GET") {
        if (opts.getFails) return json(res, 500, { detail: "the control plane's read replica is down" });
        if (opts.stallGetBody) { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); return; }
        if (opts.getDelayMs) await sleep(opts.getDelayMs);
        return json(res, 200, { ...cmd(one[1], actionOf(one[1])), signing_bytes: "00" });
      }
      return json(res, 200, []);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ATHENA_FAILSAFE_USER = "svc";
  process.env.ATHENA_FAILSAFE_PASSWORD = "pw";
  return {
    seen,
    signedAt: (uuid: string) => seen.find((one) => one.line === `POST /api/failsafe/commands/${uuid}/signatures/`)?.at ?? null,
    reads: (uuid: string) => seen.filter((one) => one.line === `GET /api/failsafe/commands/${uuid}/`).length,
    canceledAt: (uuid: string) => seen.find((one) => one.line === `POST /api/failsafe/commands/${uuid}/cancel/`)?.at ?? null,
    statusOf: (uuid: string) => statuses.get(uuid) ?? "pending",
    tokens: () => seen.filter((one) => one.line === "POST /api/token/").length,
    close: async () => {
      delete process.env.ATHENA_FAILSAFE_URL; delete process.env.ATHENA_FAILSAFE_USER; delete process.env.ATHENA_FAILSAFE_PASSWORD;
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

let admins = 0;
/** A second admin, signed in; changed on the record afterwards only as each case says. */
async function secondAdmin() {
  admins += 1;
  const username = `r5-admin-${admins}`;
  const made = await admin.post("/api/users").send({ username, password: "second-admin-pw", role: "admin", email: `${username}@a.test` });
  expect(made.status).toBe(201);
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ username, password: "second-admin-pw" })).status).toBe(200);
  return { agent, id: made.body.id as string };
}

/** A pause's signature relayed by the admin: how long after the press it reached the control plane, and the answer. */
async function relay(p: Awaited<ReturnType<typeof plane>>, uuid: string, as = admin) {
  const pressed = Date.now();
  const answer = await as.post(`/api/failsafe/commands/${uuid}/signatures`).send({ keyId: "k1", sig: "abcd" });
  const at = p.signedAt(uuid);
  return { answer, lag: at === null ? null : at - pressed };
}

/** Hold every write of the kill switch's flag (true) until let go: the switch is pressed, its flag not stored yet. */
function holdTheFlagWrite() {
  const real = storage.updateAIControlSettings.bind(storage);
  let letGo!: () => void;
  const gate = new Promise<void>((r) => { letGo = r; });
  vi.spyOn(storage, "updateAIControlSettings").mockImplementation(async (fields) => {
    if ((fields as { killSwitchEnabled?: boolean }).killSwitchEnabled === true) await gate;
    return real(fields);
  });
  return letGo;
}

async function clientAndSite(name: string) {
  const client = await admin.post("/api/clients").send({ name, company: "K", email: `${name.replace(/\W/g, "")}@k.test` });
  const site = await admin.post("/api/sites").send({ clientId: client.body.id, name: "Main", url: "https://offline.invalid" });
  return { clientId: client.body.id as string, siteId: site.body.id as string };
}

const runningAnswer = (fx: Fixture, runId: string) =>
  ({ ...fx.exchanges[0].body, run_id: runId, state: "running", done: false, finished_at: null, results: undefined });

describe("a stop's signature waits on no unbounded read", () => {
  it("a pause's signature for a command this dashboard drafted -- or listed -- is relayed from memory in under 50 ms: the command is never read", async () => {
    const p = await plane({ getDelayMs: 1_500, listed: [{ uuid: "listed-standdown-r5", action: "stand_down" }] });
    try {
      const drafted = await admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "engine-1", reason: "r5" });
      expect(drafted.status).toBe(201);
      const uuid = drafted.body.command.uuid as string;
      const { answer, lag } = await relay(p, uuid);
      expect(answer.status).toBe(200);
      expect(lag).not.toBeNull();
      expect(lag!).toBeLessThanOrEqual(50);
      expect(p.reads(uuid)).toBe(0);

      expect((await admin.get("/api/failsafe/commands")).status).toBe(200);
      const listed = await relay(p, "listed-standdown-r5");
      expect(listed.answer.status).toBe(200);
      expect(listed.lag!).toBeLessThanOrEqual(50);
      expect(p.reads("listed-standdown-r5")).toBe(0);
    } finally {
      await p.close();
    }
  }, 20_000);

  it("a command the failsafe state carried is known too: its stand-down's signature goes from memory with the kill switch engaged", async () => {
    const p = await plane({ getDelayMs: 1_500, listed: [{ uuid: "state-standdown-r5", action: "stand_down" }] });
    try {
      expect((await admin.get("/api/failsafe/state")).status).toBe(200);
      await storage.updateAIControlSettings({ killSwitchEnabled: true, systemStatus: "shutdown" });
      const { answer, lag } = await relay(p, "state-standdown-r5");
      expect(answer.status).toBe(200);
      expect(lag!).toBeLessThanOrEqual(50);
      expect(p.reads("state-standdown-r5")).toBe(0);
    } finally {
      await p.close();
    }
  }, 20_000);

  it("an unknown command whose read takes 1.5 s: the pause's signature is relayed within 300 ms, the command read once -- with the kill switch engaged too", async () => {
    const p = await plane({ getDelayMs: 1_500 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const off = await relay(p, "cmd-pause-slow-1");
      expect(off.answer.status).toBe(200);
      expect(off.lag!).toBeLessThanOrEqual(300);
      expect(p.reads("cmd-pause-slow-1")).toBe(1);
      await storage.updateAIControlSettings({ killSwitchEnabled: true, systemStatus: "shutdown" });
      const on = await relay(p, "cmd-pause-slow-2");
      expect(on.answer.status).toBe(200);
      expect(on.lag!).toBeLessThanOrEqual(300);
      // One read per relay: the guard's, reused by the kill switch's check.
      expect(p.reads("cmd-pause-slow-2")).toBe(1);
      expect(warn.mock.calls.some((one) => /cmd-pause-slow-2: action not confirmed; relayed as a possible stop/.test(String(one[0])))).toBe(true);
    } finally {
      await p.close();
    }
  }, 20_000);

  it("the control plane sends the read's headers and stalls its body: the pause's signature is relayed within 300 ms, and answered", async () => {
    const p = await plane({ stallGetBody: true });
    try {
      const sent = relay(p, "cmd-pause-stall-1");
      const outcome = await within(sent, 2_000);
      expect(outcome.done).toBe(true);
      const { answer, lag } = await sent;
      expect(answer.status).toBe(200);
      expect(lag!).toBeLessThanOrEqual(300);
    } finally {
      await p.close();
    }
  }, 20_000);

  it("the command's read fails and the account's read fails: a current admin's pause signature is relayed all the same, and logged as not confirmed", async () => {
    const p = await plane({ getFails: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      vi.spyOn(storage, "getUser").mockRejectedValue(new Error("disk I/O error"));
      const { answer, lag } = await relay(p, "cmd-pause-bothfail-1");
      expect(answer.status).toBe(200);
      expect(lag!).toBeLessThanOrEqual(300);
      expect(warn.mock.calls.some((one) => /action not confirmed; relayed as a possible stop/.test(String(one[0])))).toBe(true);
    } finally {
      await p.close();
    }
  }, 20_000);

  it("a resume known from memory (drafted here) is not a stop: an admin deleted on the record by another dashboard is refused 401, not relayed, and nothing is read from the control plane", async () => {
    const p = await plane({ getDelayMs: 1_500 });
    try {
      const drafted = await admin.post("/api/failsafe/commands").send({ action: "resume", engineId: "engine-1", reason: "r5" });
      expect(drafted.status).toBe(201);
      const uuid = drafted.body.command.uuid as string;
      const ex = await secondAdmin();
      expect(await storage.deleteUser(ex.id)).toBe(true);
      const { answer } = await relay(p, uuid, ex.agent);
      expect(answer.status).toBe(401);
      expect(p.signedAt(uuid)).toBeNull();
      expect(p.reads(uuid)).toBe(0);
    } finally {
      await p.close();
    }
  }, 20_000);

  it("A1 holds whenever the read answers in time: a resume's signature from an admin demoted on the record is refused 403 and not relayed", async () => {
    const p = await plane({ getDelayMs: 100 });
    try {
      const ex = await secondAdmin();
      await storage.updateUser(ex.id, { role: "user" });
      const { answer } = await relay(p, "cmd-resume-a1-1", ex.agent);
      expect(answer.status).toBe(403);
      expect(p.signedAt("cmd-resume-a1-1")).toBeNull();
    } finally {
      await p.close();
    }
  }, 20_000);

  it("the residual: a resume's signature whose command cannot be read, from a session held as an admin's, is relayed as a possible stop and logged so -- and, its relay's answer naming a resume from an account deleted on the record, withdrawn at once", async () => {
    const p = await plane({ getFails: true });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const ex = await secondAdmin();
      expect(await storage.deleteUser(ex.id)).toBe(true);
      const { answer } = await relay(p, "cmd-resume-residual-1", ex.agent);
      // Relayed all the same (it might have been a stop's), then withdrawn: the account could not have relayed a resume.
      expect(p.signedAt("cmd-resume-residual-1")).not.toBeNull();
      expect(p.canceledAt("cmd-resume-residual-1")).toBeGreaterThanOrEqual(p.signedAt("cmd-resume-residual-1")!);
      expect(p.statusOf("cmd-resume-residual-1")).toBe("canceled");
      expect(answer.status).toBe(401);
      expect(answer.body.withdrawal).toMatchObject({ action: "resume", learntFrom: "answer", withdrawn: true });
      const logs = (await storage.getAllActivityLogs()).filter((one) => one.entityType === "failsafe_command" && one.entityId === "cmd-resume-residual-1");
      const logged = logs.find((one) => one.action === "signed");
      expect(logged?.details).toMatchObject({ actionConfirmed: false, note: "action not confirmed; relayed as a possible stop" });
      expect(String((logged?.details as { unread?: string }).unread)).toMatch(/answered 500/);
      expect(logs.find((one) => one.action === "withdrawn")?.details).toMatchObject({ failsafeAction: "resume", relayedAsPossibleStop: true });
    } finally {
      await p.close();
    }
  }, 20_000);

  it("the relay's own answer whose body stalls is let go at the stop's limit: 503, saying the control plane took the signature", async () => {
    fsTimeouts().stopBodyMs = 200;
    const p = await plane({ stallSignatureBody: true });
    try {
      const pressed = Date.now();
      const { answer } = await relay(p, "cmd-pause-sigstall-1");
      expect(Date.now() - pressed).toBeLessThan(1_500);
      expect(answer.status).toBe(503);
      expect(answer.body.error).toMatch(/not the rest within 200 ms/);
      expect(answer.body.error).toMatch(/it took the signature; read the command again/);
      expect(p.signedAt("cmd-pause-sigstall-1")).not.toBeNull();
    } finally {
      await p.close();
    }
  }, 20_000);

  it("every control-plane answer's body has a limit: a list, the state, a command and the audit trail that stall are refused within it", async () => {
    fsTimeouts().bodyMs = 200;
    const p = await plane({ stallEverything: true });
    try {
      for (const read of [
        () => failsafeModule.listCommands(),
        () => failsafeModule.state(),
        () => failsafeModule.getCommand("cmd-any"),
        () => failsafeModule.audit(),
      ]) {
        const began = Date.now();
        await expect(read()).rejects.toBeInstanceOf(failsafeModule.FailsafeUnavailable);
        expect(Date.now() - began).toBeLessThan(1_000);
      }
    } finally {
      await p.close();
    }
  }, 20_000);
});

describe("a possible stop that turns out to be a resume or a release goes through no engaged kill switch", () => {
  /** The activity records of a command, by what they record. */
  const recordsOf = async (uuid: string) =>
    (await storage.getAllActivityLogs()).filter((one) => one.entityType === "failsafe_command" && one.entityId === uuid);

  /** The relay went first (never held), the withdrawal after it, and the command ends withdrawn: no resume took effect. */
  function expectWithdrawn(p: Awaited<ReturnType<typeof plane>>, uuid: string, answer: request.Response, status: number) {
    expect(p.signedAt(uuid)).not.toBeNull();
    expect(p.canceledAt(uuid)).not.toBeNull();
    expect(p.canceledAt(uuid)!).toBeGreaterThanOrEqual(p.signedAt(uuid)!);
    expect(p.statusOf(uuid)).toBe("canceled");
    expect(answer.status).toBe(status);
    expect(answer.body.relayedAsPossibleStop).toBe(true);
    expect(answer.body.withdrawal).toMatchObject({ action: "resume", withdrawn: true });
    expect(answer.body.error).toMatch(/relayed before its command's action was known \(a possible stop\)\. The command is a resume/);
    expect(answer.body.error).toMatch(/it was withdrawn at once/);
  }

  it("R1a: the switch engaged and stored, the command's read answering in 300 ms: a current admin's RESUME signature is relayed as a possible stop, then withdrawn at once -- answered 503 and recorded against the admin", async () => {
    const p = await plane({ getDelayMs: 300 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
      expect((await storage.getAIControlSettings())!.killSwitchEnabled).toBe(true);
      const { answer, lag } = await relay(p, "cmd-resume-r6-1a");
      expect(lag!).toBeLessThanOrEqual(300);
      expectWithdrawn(p, "cmd-resume-r6-1a", answer, 503);
      expect(answer.body.withdrawal.refusedBecause).toBe("the AI kill switch is engaged");
      const withdrawn = (await recordsOf("cmd-resume-r6-1a")).find((one) => one.action === "withdrawn");
      expect(withdrawn?.userId).toBe(adminId);
      expect(withdrawn?.details).toMatchObject({ failsafeAction: "resume", relayedAsPossibleStop: true, refusedBecause: "the AI kill switch is engaged" });
    } finally {
      await admin.patch("/api/ai-control").send(REACTIVATE);
      await p.close();
    }
  }, 20_000);

  it("R1b: the press held in memory while its flag waits to be written: the RESUME signature relayed as a possible stop is withdrawn at once", async () => {
    const p = await plane({ getDelayMs: 300 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const letGo = holdTheFlagWrite();
    try {
      const kill = admin.patch("/api/ai-control").send({ killSwitchEnabled: true }).then((r) => r);
      await sleep(100);
      expect((await storage.getAIControlSettings())!.killSwitchEnabled).toBe(false);
      const { answer } = await relay(p, "cmd-resume-r6-1b");
      expectWithdrawn(p, "cmd-resume-r6-1b", answer, 503);
      letGo();
      expect((await kill).status).toBe(200);
    } finally {
      letGo();
      await admin.patch("/api/ai-control").send(REACTIVATE);
      await p.close();
    }
  }, 20_000);

  it("R1c: no token in hand and the token endpoint taking 400 ms: one token is obtained -- the read's, cut off at 250 ms, is cached when it arrives and the relay uses it -- and the RESUME signature is withdrawn", async () => {
    failsafeModule._resetForTests();
    const p = await plane({ tokenDelayMs: 400 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
      const { answer } = await relay(p, "cmd-resume-r6-1c");
      expectWithdrawn(p, "cmd-resume-r6-1c", answer, 503);
      expect(p.tokens()).toBe(1);
    } finally {
      await admin.patch("/api/ai-control").send(REACTIVATE);
      await p.close();
      failsafeModule._resetForTests();
    }
  }, 20_000);

  it("R1d: an admin deleted on the record, the switch off, the command's read answering in 300 ms: the RESUME signature relayed as a possible stop is withdrawn (answered 401)", async () => {
    const p = await plane({ getDelayMs: 300 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const ex = await secondAdmin();
      expect(await storage.deleteUser(ex.id)).toBe(true);
      const { answer } = await relay(p, "cmd-resume-r6-1d", ex.agent);
      expectWithdrawn(p, "cmd-resume-r6-1d", answer, 401);
    } finally {
      await p.close();
    }
  }, 20_000);

  it("its read finishing after the relay went (the relay's answer slower still): the withdrawal goes as soon as the read names a resume, before the relay is answered", async () => {
    const p = await plane({ getDelayMs: 300, signatureDelayMs: 700 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await storage.updateAIControlSettings({ killSwitchEnabled: true, systemStatus: "shutdown" });
      const pressed = Date.now();
      const answer = await admin.post("/api/failsafe/commands/cmd-resume-r6-late/signatures").send({ keyId: "k1", sig: "abcd" });
      const answered = Date.now();
      expect(p.signedAt("cmd-resume-r6-late")! - pressed).toBeLessThanOrEqual(300);
      expect(p.canceledAt("cmd-resume-r6-late")).not.toBeNull();
      // Withdrawn on the read's word, while the relay's answer was still on its way.
      expect(p.canceledAt("cmd-resume-r6-late")! - pressed).toBeLessThan(700);
      expect(answered - p.canceledAt("cmd-resume-r6-late")!).toBeGreaterThan(100);
      expect(p.statusOf("cmd-resume-r6-late")).toBe("canceled");
      expect(answer.body.withdrawal).toMatchObject({ action: "resume", learntFrom: "read", withdrawn: true });
      expect(answer.status).toBe(409);
    } finally {
      await storage.updateAIControlSettings({ killSwitchEnabled: false, systemStatus: "active" });
      await p.close();
    }
  }, 20_000);

  it("a current admin's RESUME with the switch off, relayed as a possible stop, is not withdrawn: nothing would have refused it", async () => {
    const p = await plane({ getDelayMs: 300 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { answer } = await relay(p, "cmd-resume-r6-ok");
      await sleep(200);
      expect(answer.status).toBe(200);
      expect(p.canceledAt("cmd-resume-r6-ok")).toBeNull();
      expect(p.statusOf("cmd-resume-r6-ok")).toBe("ready");
    } finally {
      await p.close();
    }
  }, 20_000);

  it("a PAUSE's signature with the switch engaged and its read taking 1.5 s: still relayed within 300 ms, answered 200, and never withdrawn once its read names a pause", async () => {
    const p = await plane({ getDelayMs: 1_500 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await storage.updateAIControlSettings({ killSwitchEnabled: true, systemStatus: "shutdown" });
      const { answer, lag } = await relay(p, "cmd-pause-r6-1");
      expect(answer.status).toBe(200);
      expect(lag!).toBeLessThanOrEqual(300);
      await until(async () => failsafeModule.knownActionOf("cmd-pause-r6-1"), (known) => known !== undefined, 4_000);
      expect(failsafeModule.knownActionOf("cmd-pause-r6-1")).toBe("pause");
      await sleep(100);
      expect(p.canceledAt("cmd-pause-r6-1")).toBeNull();
      expect(p.statusOf("cmd-pause-r6-1")).toBe("ready");
    } finally {
      await storage.updateAIControlSettings({ killSwitchEnabled: false, systemStatus: "active" });
      await p.close();
    }
  }, 20_000);

  it("the press reads the commands the control plane lists: a RESUME listed there is refused from memory while the switch is engaged -- never relayed, never read", async () => {
    const p = await plane({ getDelayMs: 1_500, listed: [{ uuid: "cmd-resume-r6-listed", action: "resume" }] });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(failsafeModule.knownActionOf("cmd-resume-r6-listed")).toBeUndefined();
      expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
      await until(async () => failsafeModule.knownActionOf("cmd-resume-r6-listed"), (known) => known !== undefined, 2_000);
      const { answer } = await relay(p, "cmd-resume-r6-listed");
      expect(answer.status).toBe(503);
      expect(p.signedAt("cmd-resume-r6-listed")).toBeNull();
      expect(p.reads("cmd-resume-r6-listed")).toBe(0);
    } finally {
      await admin.patch("/api/ai-control").send(REACTIVATE);
      await p.close();
    }
  }, 20_000);

  it("the relay's own answer teaches the command's action: a second signature for the same RESUME, once the switch is engaged, is refused from memory", async () => {
    const p = await plane({ getDelayMs: 1_500 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await relay(p, "cmd-resume-r6-taught")).answer.status).toBe(200);
      expect(failsafeModule.knownActionOf("cmd-resume-r6-taught")).toBe("resume");
      await storage.updateAIControlSettings({ killSwitchEnabled: true, systemStatus: "shutdown" });
      const second = await admin.post("/api/failsafe/commands/cmd-resume-r6-taught/signatures").send({ keyId: "k2", sig: "abcd" });
      expect(second.status).toBe(503);
      expect(p.seen.filter((one) => one.line === "POST /api/failsafe/commands/cmd-resume-r6-taught/signatures/").length).toBe(1);
    } finally {
      await storage.updateAIControlSettings({ killSwitchEnabled: false, systemStatus: "active" });
      await p.close();
    }
  }, 20_000);
});

describe("the control plane's token is kept warm", () => {
  it("a token cut off at a read's 250 ms is cached when it arrives: the next relay's read uses it, learns its command in time, and no second token is asked for", async () => {
    failsafeModule._resetForTests();
    const p = await plane({ tokenDelayMs: 400 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const first = await relay(p, "cmd-pause-r6-tok-1");
      expect(first.answer.status).toBe(200);
      expect(warn.mock.calls.some((one) => /cmd-pause-r6-tok-1: action not confirmed/.test(String(one[0])))).toBe(true);
      const second = await relay(p, "cmd-pause-r6-tok-2");
      expect(second.answer.status).toBe(200);
      expect(warn.mock.calls.some((one) => /cmd-pause-r6-tok-2: action not confirmed/.test(String(one[0])))).toBe(false);
      expect(p.reads("cmd-pause-r6-tok-2")).toBe(1);
      expect(p.tokens()).toBe(1);
    } finally {
      await p.close();
      failsafeModule._resetForTests();
    }
  }, 20_000);

  it("a token that already reads as expired when it arrives is not asked for again at once", async () => {
    failsafeModule._resetForTests();
    const expired = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3_600 })).toString("base64url")}.s`;
    const p = await plane({ token: () => expired });
    try {
      expect((await admin.get("/api/failsafe/commands")).status).toBe(200);
      await sleep(1_000);
      expect(p.tokens()).toBe(1);
    } finally {
      await p.close();
      failsafeModule._resetForTests();
    }
  }, 20_000);

  it("a token is obtained again ahead of its expiry, with no call waiting on it", async () => {
    failsafeModule._resetForTests();
    const jwt = (expSeconds: number) =>
      `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.s`;
    let expiresAt = 0;
    // A lifetime of 2-3 s (`exp` is in whole seconds): obtained again a fifth of it early.
    const p = await plane({ token: () => { expiresAt = Math.floor((Date.now() + 3_000) / 1000) * 1000; return jwt(expiresAt / 1000); } });
    try {
      expect((await admin.get("/api/failsafe/commands")).status).toBe(200);
      expect(p.tokens()).toBe(1);
      const firstExpiry = expiresAt;
      await until(async () => p.tokens(), (n) => n >= 2, 4_000);
      expect(p.tokens()).toBe(2);
      // Obtained again before the first one expired.
      const refreshedAt = p.seen.filter((one) => one.line === "POST /api/token/")[1].at;
      expect(refreshedAt).toBeLessThan(firstExpiry);
    } finally {
      await p.close();
      failsafeModule._resetForTests();
    }
  }, 20_000);
});

describe("the kill switch holds from the instant it is pressed", () => {
  it("while its flag is not stored yet: every write is refused, a scan start is refused and never sent, a resume's signature is refused -- a pause's goes; once stored, it reads engaged", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    eng.fixture = fx;
    const { clientId, siteId } = await clientAndSite("Held flag");
    const p = await plane();
    const letGo = holdTheFlagWrite();
    try {
      const drafted = await admin.post("/api/failsafe/commands").send({ action: "resume", engineId: "engine-1", reason: "r5" });
      const resumeUuid = drafted.body.command.uuid as string;
      calls.length = 0;
      const kill = admin.patch("/api/ai-control").send({ killSwitchEnabled: true }).then((r) => r);
      await sleep(100);
      // Stored: still off. Held in memory: on.
      expect((await storage.getAIControlSettings())!.killSwitchEnabled).toBe(false);
      expect((await admin.get("/api/ai-control")).body.killSwitchEnabled).toBe(true);
      const write = await admin.post("/api/clients").send({ name: "Refused", company: "R", email: "refused@r.test" });
      expect(write.status).toBe(503);
      const started = await admin.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
      expect(started.status).toBe(503);
      expect(calls.some((c) => c.line === "POST /api/scan")).toBe(false);
      const resume = await relay(p, resumeUuid);
      expect(resume.answer.status).toBe(503);
      expect(p.signedAt(resumeUuid)).toBeNull();
      const pause = await relay(p, "cmd-pause-held-1");
      expect(pause.answer.status).toBe(200);
      letGo();
      const engaged = await kill;
      expect(engaged.status).toBe(200);
      expect(engaged.body.killSwitchEnabled).toBe(true);
      expect((await storage.getAIControlSettings())!.killSwitchEnabled).toBe(true);
      expect((await admin.patch("/api/ai-control").send(REACTIVATE)).status).toBe(200);
      expect((await admin.post("/api/clients").send({ name: "Allowed", company: "A", email: "allowed@a.test" })).status).toBe(201);
    } finally {
      letGo();
      await p.close();
    }
  }, 20_000);

  it("a scan start in flight at the press -- reading the engine's list -- is not sent to the engine, and is answered so", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    eng.fixture = fx;
    const { clientId, siteId } = await clientAndSite("In flight");
    scanReply = runningAnswer(fx, `r5-inflight-${Date.now()}`);
    activeHoldMs = 400;
    calls.length = 0;
    const start = admin.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" }).then((r) => r);
    await sleep(100);
    const kill = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    const started = await start;
    expect(kill.status).toBe(200);
    expect(started.status).toBe(503);
    expect(started.body.reason).toBe("kill_switch");
    expect(started.body.error).toMatch(/kill switch was engaged while this scan was starting, so it was not started: nothing was sent to the engine/);
    expect(calls.some((c) => c.line === "POST /api/scan")).toBe(false);
    await admin.patch("/api/ai-control").send(REACTIVATE);
  }, 20_000);

  it("a scan the engine accepts after the press is stopped at once by its run id -- one stop, recorded -- and answered 'stopped by the kill switch pressed while it was starting'", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    eng.fixture = fx;
    const { clientId, siteId } = await clientAndSite("Accepted late");
    const runId = `r5-late-${Date.now()}`;
    scanReply = runningAnswer(fx, runId);
    let letGo!: () => void;
    scanHold = new Promise<void>((r) => { letGo = r; });
    calls.length = 0;
    const start = admin.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" }).then((r) => r);
    await until(async () => calls.some((c) => c.line === "POST /api/scan"), (sent) => sent, 2_000);
    const kill = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    expect(kill.status).toBe(200);
    const answeredAt = performance.now();
    letGo();
    const started = await start;
    const stop = calls.find((c) => c.line === `POST /api/scans/${runId}/abort`);
    expect(stop).toBeDefined();
    expect(stop!.at - answeredAt).toBeLessThan(200);
    expect(calls.filter((c) => c.line === `POST /api/scans/${runId}/abort`)).toHaveLength(1);
    expect(started.status).toBe(409);
    expect(started.body.reason).toBe("kill_switch");
    expect(started.body.error).toMatch(new RegExp(`^Engine run ${runId} was stopped by the kill switch pressed while it was starting: the engine accepted the stop\\.`));
    expect(started.body.stopped).toBe(true);
    const row = await storage.getTest(started.body.test.id);
    expect((row!.findings as { runId: string }).runId).toBe(runId);
    const logged = (await storage.getActivityLogsByEntity("test", started.body.test.id))
      .find((one) => (one.details as { via?: string } | null)?.via === "kill_switch");
    expect(logged?.action).toBe("aborted");
    expect((logged?.details as { note?: string }).note).toMatch(/started while the kill switch was being pressed/);
    await admin.patch("/api/ai-control").send(REACTIVATE);
  }, 20_000);

  it("another dashboard's kill switch, stored while a start here was in flight: not sent if it had not been; stopped at once if the engine had accepted it", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    eng.fixture = fx;
    const { clientId, siteId } = await clientAndSite("Elsewhere");
    // Before the send: stored by the other dashboard while this start read the engine's list.
    scanReply = runningAnswer(fx, `r5-elsewhere-a-${Date.now()}`);
    activeHoldMs = 300;
    calls.length = 0;
    const first = admin.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" }).then((r) => r);
    await sleep(100);
    await storage.updateAIControlSettings({ killSwitchEnabled: true, systemStatus: "shutdown" });
    const refused = await first;
    expect(refused.status).toBe(503);
    expect(refused.body.reason).toBe("kill_switch");
    expect(calls.some((c) => c.line === "POST /api/scan")).toBe(false);
    await storage.updateAIControlSettings({ killSwitchEnabled: false, systemStatus: "active" });
    activeHoldMs = 0;

    // After the engine accepted it.
    const runId = `r5-elsewhere-b-${Date.now()}`;
    scanReply = runningAnswer(fx, runId);
    let letGo!: () => void;
    scanHold = new Promise<void>((r) => { letGo = r; });
    const second = admin.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" }).then((r) => r);
    await until(async () => calls.some((c) => c.line === "POST /api/scan"), (sent) => sent, 2_000);
    await storage.updateAIControlSettings({ killSwitchEnabled: true, systemStatus: "shutdown" });
    letGo();
    const stopped = await second;
    expect(stopped.status).toBe(409);
    expect(stopped.body.error).toMatch(/stopped by the kill switch pressed while it was starting: the engine accepted the stop/);
    expect(calls.filter((c) => c.line === `POST /api/scans/${runId}/abort`)).toHaveLength(1);
  }, 20_000);

  it("the same start, when its row cannot be written either: stopped once by the kill switch, answered 409, no second stop", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    eng.fixture = fx;
    const { clientId, siteId } = await clientAndSite("Accepted late, unrecorded");
    const runId = `r5-late-unrec-${Date.now()}`;
    scanReply = runningAnswer(fx, runId);
    let letGo!: () => void;
    scanHold = new Promise<void>((r) => { letGo = r; });
    calls.length = 0;
    const start = admin.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" }).then((r) => r);
    await until(async () => calls.some((c) => c.line === "POST /api/scan"), (sent) => sent, 2_000);
    expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
    vi.spyOn(storage, "createTest").mockRejectedValue(new Error("SQLITE_FULL: database or disk is full"));
    letGo();
    const started = await start;
    vi.restoreAllMocks();
    expect(started.status).toBe(409);
    expect(started.body.error).toMatch(/stopped by the kill switch pressed while it was starting: the engine accepted the stop\. It could not be recorded here either \(SQLITE_FULL/);
    expect(calls.filter((c) => c.line === `POST /api/scans/${runId}/abort`)).toHaveLength(1);
    await admin.patch("/api/ai-control").send(REACTIVATE);
  }, 20_000);

  it("a retest the engine answers running after the press is watched, stopped at once by its run id, and answered so; its slot is free", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    let letGo!: () => void;
    eng.retestHold = new Promise<void>((r) => { letGo = r; });
    calls.length = 0;
    const start = admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 }).then((r) => r);
    await until(async () => heldRetests, (held) => held === 1, 2_000);
    expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
    letGo();
    const started = await start;
    eng.retestHold = null;
    expect(started.status).toBe(409);
    expect(started.body.reason).toBe("kill_switch");
    const runId = started.body.engineRunId as string;
    expect(started.body.error).toMatch(new RegExp(`^Retest run ${runId} was stopped by the kill switch pressed while it was starting`));
    expect(calls.filter((c) => c.line === `POST /api/scans/${runId}/abort`)).toHaveLength(1);
    await until(async () => watcher.peek(runId)?.stopAcceptedAt ?? null, (at) => at !== null, 2_000);
    expect(watcher.peek(runId)?.stopAcceptedAt).toBeInstanceOf(Date);
    await admin.patch("/api/ai-control").send(REACTIVATE);
  }, 20_000);

  it("a retest start in flight at the press -- reading the watches on record -- is not sent, and its slot is free at once", async () => {
    process.env.ATHENA_MAX_INFLIGHT_RETESTS = "1";
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    const real = storage.getOpenRetestWatches.bind(storage);
    vi.spyOn(storage, "getOpenRetestWatches").mockImplementation(async (since) => { await sleep(300); return real(since); });
    try {
      calls.length = 0;
      const start = admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 }).then((r) => r);
      await sleep(100);
      expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
      const refused = await start;
      expect(refused.status).toBe(503);
      expect(refused.body.reason).toBe("kill_switch");
      expect(refused.body.error).toMatch(/kill switch was engaged while this retest was starting, so it was not started/);
      expect(calls.some((c) => c.line === "POST /api/remediation/retest")).toBe(false);
      vi.restoreAllMocks();
      await admin.patch("/api/ai-control").send(REACTIVATE);
      eng.statusReads = [statusReadsOf(fx)[0]];
      const next = await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 });
      expect(next.status).toBe(202);
    } finally {
      delete process.env.ATHENA_MAX_INFLIGHT_RETESTS;
    }
  }, 20_000);
});

describe("every kill-switch answer states the switch as it is when it is given", () => {
  it("a later disengage whose write failed supersedes nothing: the engage is answered engaged, without `superseded`", async () => {
    const t = await runningTest(`r5-k1c-${Date.now()}`);
    const runId = (t.findings as { runId: string }).runId;
    let release!: () => void;
    eng.abortHold.set(runId, new Promise<void>((r) => { release = r; }));
    const real = storage.updateAIControlSettings.bind(storage);
    vi.spyOn(storage, "updateAIControlSettings").mockImplementation(async (fields) => {
      if ((fields as { killSwitchEnabled?: boolean }).killSwitchEnabled === false) throw new Error("disk I/O error");
      return real(fields);
    });
    const on = admin.patch("/api/ai-control").send({ killSwitchEnabled: true }).then((r) => r);
    await sleep(150);
    const off = await admin.patch("/api/ai-control").send(REACTIVATE);
    release();
    const engaged = await on;
    vi.restoreAllMocks();
    expect(off.status).toBe(500);
    expect((await storage.getAIControlSettings())!.killSwitchEnabled).toBe(true);
    expect(engaged.status).toBe(200);
    expect(engaged.body.killSwitchEnabled).toBe(true);
    expect(engaged.body.superseded).toBeUndefined();
    await admin.patch("/api/ai-control").send(REACTIVATE);
  });

  it("the page's engage, then a disengage 100 ms later: the engage answers last, and says the switch is OFF -- as stored -- and that a later change superseded it", async () => {
    const t = await runningTest(`r5-k1d-${Date.now()}`);
    const runId = (t.findings as { runId: string }).runId;
    let release!: () => void;
    eng.abortHold.set(runId, new Promise<void>((r) => { release = r; }));
    const order: string[] = [];
    const on = admin.patch("/api/ai-control").send({ killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] })
      .then((r) => { order.push("engage"); return r; });
    await sleep(100);
    const off = await admin.patch("/api/ai-control").send(REACTIVATE);
    order.push("disengage");
    release();
    const engaged = await on;
    const stored = (await storage.getAIControlSettings())!;
    expect(order).toEqual(["disengage", "engage"]);
    expect(off.body.killSwitchEnabled).toBe(false);
    expect(stored.killSwitchEnabled).toBe(false);
    expect(engaged.status).toBe(409);
    expect(engaged.body.engaged).toBe(false);
    expect(engaged.body.killSwitchEnabled).toBe(false);
    expect(engaged.body.systemStatus).toBe(stored.systemStatus);
    expect(engaged.body.superseded).toMatch(/later change/);
    expect(engaged.body.refused).toEqual(expect.arrayContaining(["systemStatus", "activeSystems"]));
    expect(engaged.body.message).toMatch(/a later change has since switched it off \(it is off now\)/);
    expect(aborts()).toContain(`POST /api/scans/${runId}/abort`);
  });

  it("an engage whose flag a later disengage stored first is overtaken: its stops go all the same (409 'Every stop was sent all the same'), it writes nothing, and its log says so", async () => {
    const made = await admin.post("/api/api-keys").send({ name: "r5 automation" });
    expect(made.status).toBe(201);
    const secret = made.body.secret as string;
    const t = await runningTest(`r5-overtaken-${Date.now()}`);
    const runId = (t.findings as { runId: string }).runId;
    const real = storage.findActiveApiKeyByHash.bind(storage);
    vi.spyOn(storage, "findActiveApiKeyByHash").mockImplementation(async (hash) => { await sleep(300); return real(hash); });
    await storage.updateAIControlSettings({ killSwitchEnabled: true, systemStatus: "shutdown" });
    calls.length = 0;
    const byKey = request(app).patch("/api/ai-control").set("X-API-Key", secret).send({ killSwitchEnabled: true }).then((r) => r);
    await sleep(50);
    const off = await admin.patch("/api/ai-control").send(REACTIVATE);
    expect(off.status).toBe(200);
    const engaged = await byKey;
    vi.restoreAllMocks();
    expect(engaged.status).toBe(409);
    expect(engaged.body.message).toMatch(/^Nothing of this change was saved: a later change .*Every stop was sent all the same; what each came to is below\.$/);
    expect(engaged.body.written).toBe(false);
    expect(engaged.body.engaged).toBe(false);
    expect(engaged.body.killSwitchEnabled).toBe(false);
    expect(aborts()).toContain(`POST /api/scans/${runId}/abort`);
    expect((await storage.getAIControlSettings())!.killSwitchEnabled).toBe(false);
    const log = (await storage.getAllActivityLogs())
      .filter((one) => one.entityType === "ai_control" && (one.details as { notWritten?: string } | null)?.notWritten);
    expect(log.length).toBeGreaterThan(0);
    expect((log[0].details as { notWritten: string }).notWritten).toMatch(/later change/);
    // Not held engaged in memory either: a write goes through.
    expect((await admin.post("/api/clients").send({ name: "After", company: "A", email: "after@a.test" })).status).toBe(201);
  });

  it("a later write of other fields alone overtakes no engage: the switch sent before it is stored", async () => {
    const made = await admin.post("/api/api-keys").send({ name: "r5 automation 2" });
    const secret = made.body.secret as string;
    const real = storage.findActiveApiKeyByHash.bind(storage);
    vi.spyOn(storage, "findActiveApiKeyByHash").mockImplementation(async (hash) => { await sleep(300); return real(hash); });
    const byKey = request(app).patch("/api/ai-control").set("X-API-Key", secret).send({ killSwitchEnabled: true }).then((r) => r);
    await sleep(50);
    const other = await admin.patch("/api/ai-control").send({ maxConcurrentTests: 999 });
    expect(other.status).toBe(200);
    const engaged = await byKey;
    vi.restoreAllMocks();
    expect(engaged.status).toBe(200);
    expect(engaged.body.killSwitchEnabled).toBe(true);
    expect(engaged.body.superseded).toBeUndefined();
    const stored = (await storage.getAIControlSettings())!;
    expect(stored.killSwitchEnabled).toBe(true);
    expect(stored.maxConcurrentTests).toBe(999);
    await admin.patch("/api/ai-control").send({ ...REACTIVATE, maxConcurrentTests: 1000 });
  });
});

describe("a connection refused before anything was sent frees a retest's slot", () => {
  it("answered 503 'the engine refused the connection; the retest was not started', and the next retest is sent", async () => {
    process.env.ATHENA_MAX_INFLIGHT_RETESTS = "1";
    const fx = load(PR71, "at-once-then-verdict");
    const a = await scanned(fx); const b = await scanned(fx);
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const live = process.env.ATHENA_ENGINE_URL;
    process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${deadPort}`;
    try {
      const first = await admin.post(`/api/tests/${a.testId}/retest`).send({ twinId: 1 });
      expect(first.status).toBe(503);
      expect(first.body.error).toMatch(/^the engine refused the connection; the retest was not started \(.*ECONNREFUSED/);
      expect(first.body.error).not.toMatch(/may still be running/);
      process.env.ATHENA_ENGINE_URL = live;
      eng.statusReads = [statusReadsOf(fx)[0]];
      const second = await admin.post(`/api/tests/${b.testId}/retest`).send({ twinId: 1 });
      expect(second.status).toBe(202);
    } finally {
      process.env.ATHENA_ENGINE_URL = live;
      delete process.env.ATHENA_MAX_INFLIGHT_RETESTS;
    }
  }, 20_000);
});

describe("every engine answer's body has a limit", () => {
  it("a scan start, a run's state, its decisions, an evidence pack, a classification and the loaded scanners: a body that stalls is given up on within the limit", async () => {
    timeouts().bodyMs = 200;
    let stalled = 0;
    const stall = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); stalled += 1; });
    });
    await new Promise<void>((r) => stall.listen(0, "127.0.0.1", r));
    const live = process.env.ATHENA_ENGINE_URL;
    process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(stall.address() as AddressInfo).port}`;
    try {
      const calls: Array<[string, () => Promise<unknown>]> = [
        ["startScan", () => engineModule.startScan({ target: "https://offline.invalid/", engagementRef: "e", scope: ["offline.invalid"] })],
        ["runState", () => engineModule.runState("r5-run")],
        ["listDecisions", () => engineModule.listDecisions("r5-run")],
        ["buildEvidencePack", () => engineModule.buildEvidencePack({ engagementRef: "e", reason: "r5" })],
        ["classifyCve", () => engineModule.classifyCve("a description")],
      ];
      for (const [what, call] of calls) {
        const began = Date.now();
        await expect(call(), what).rejects.toBeInstanceOf(engineModule.EngineUnavailable);
        expect(Date.now() - began, what).toBeLessThan(1_000);
      }
      const began = Date.now();
      expect(await engineModule.loadedScanners()).toBeNull();
      expect(Date.now() - began).toBeLessThan(1_000);
      expect(stalled).toBe(6);
    } finally {
      process.env.ATHENA_ENGINE_URL = live;
      stall.closeAllConnections?.();
      await new Promise<void>((r) => stall.close(() => r()));
    }
  }, 20_000);
});

describe("the branches the round-four review found untested", () => {
  it("deleting a test whose stop was answered 2xx with its body unread deletes it, and logs the run under stopSentAnswerUnread", async () => {
    timeouts().abortBodyMs = 200;
    const t = await runningTest(`r5-del-unread-${Date.now()}`);
    const runId = (t.findings as { runId: string }).runId;
    stallAbortFor.add(runId);
    const deleted = await admin.delete(`/api/tests/${t.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.stops[0]).toMatchObject({ runId, stopped: true, answerUnread: true });
    const log = (await storage.getActivityLogsByEntity("test", t.id)).find((one) => one.action === "deleted");
    expect(log?.details).toMatchObject({ stopSentAnswerUnread: [runId] });
    expect((log?.details as { stopped?: string[] }).stopped).toBeUndefined();
  });

  it("a client delete refused because one stop failed says of another that it was sent a stop whose answer was not read", async () => {
    timeouts().abortBodyMs = 200;
    const client = await storage.createClient({ name: "Two runs", company: "T", email: "two@t.test" });
    const unread = `r5-unread-${Date.now()}`;
    const failing = `r5-failing-${Date.now()}`;
    for (const runId of [unread, failing]) {
      await storage.createTest({ clientId: client.id, testType: "vulnerability-scan", status: "running", findings: { runId, target: "https://offline.invalid/", results: [] } });
    }
    stallAbortFor.add(unread);
    eng.abortByRun.set(failing, { status: 500, body: { detail: "no" } });
    const refused = await admin.delete(`/api/clients/${client.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/1 other run was sent a stop whose answer was not read \(stop sent, answer unread\): whether the engine is stopping it is not known\./);
    expect(await storage.getClient(client.id)).toBeDefined();
  });

  it("a single test's delete that fails after a stop whose answer was not read says so in its 500; a client's says its wording", async () => {
    timeouts().abortBodyMs = 200;
    const t = await runningTest(`r5-del500-${Date.now()}`);
    const runId = (t.findings as { runId: string }).runId;
    stallAbortFor.add(runId);
    vi.spyOn(storage, "deleteTest").mockRejectedValue(new Error("disk I/O error"));
    const one = await admin.delete(`/api/tests/${t.id}`);
    expect(one.status).toBe(500);
    expect(one.body.message).toMatch(new RegExp(`^Engine run ${runId} was sent a stop whose answer was not read \\(stop sent, answer unread\\), but the test could not be deleted: disk I/O error`));

    const t2 = await runningTest(`r5-delc500-${Date.now()}`);
    stallAbortFor.add((t2.findings as { runId: string }).runId);
    vi.spyOn(storage, "deleteClient").mockRejectedValue(new Error("disk I/O error"));
    const whole = await admin.delete(`/api/clients/${t2.clientId}`);
    expect(whole.status).toBe(500);
    expect(whole.body.message).toMatch(/or was answered 2xx with the rest of its answer unread \(stop sent, answer unread\), but the client could not be deleted: disk I\/O error/);
  });

  it("a scan started but not recorded, whose stop's answer was not read, says so", async () => {
    timeouts().abortBodyMs = 200;
    const fx = load(PR71, "at-once-then-stopped");
    eng.fixture = fx;
    const { clientId, siteId } = await clientAndSite("Unrecorded unread");
    const runId = `r5-unrec-unread-${Date.now()}`;
    scanReply = runningAnswer(fx, runId);
    stallAbortFor.add(runId);
    vi.spyOn(storage, "createTest").mockRejectedValue(new Error("disk I/O error"));
    const started = await admin.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
    expect(started.status).toBe(500);
    expect(started.body.error).toMatch(/the run was sent a stop, and the engine answered it 2xx, but the rest of its answer was not read \(stop sent, answer unread\): whether it is stopping is not known/);
  });

  it("a retest answered 5xx holds its slot (retest_unconfirmed) and the next is refused 429 saying it may still be running", async () => {
    process.env.ATHENA_MAX_INFLIGHT_RETESTS = "1";
    const fx = load(PR71, "at-once-then-verdict");
    try {
      const a = await scanned(fx); const b = await scanned(fx);
      slots().pollMs = 400;
      eng.retest = { status: 500, body: { detail: "internal error" } };
      const first = await admin.post(`/api/tests/${a.testId}/retest`).send({ twinId: 1 });
      expect(first.status).toBe(503);
      expect(first.body.reason).toBe("retest_unconfirmed");
      expect(first.body.error).toMatch(/It may still be running this retest/);
      eng.retest = null;
      const second = await admin.post(`/api/tests/${b.testId}/retest`).send({ twinId: 1 });
      expect(second.status).toBe(429);
      expect(second.body.error).toMatch(/did not answer in time and may still be running/);
      // The engine lists no live retest: the slot comes free at the next read.
      const again = await until(async () => {
        eng.statusReads = [statusReadsOf(fx)[0]];
        return (await admin.post(`/api/tests/${b.testId}/retest`).send({ twinId: 1 })).status;
      }, (status) => status !== 429, 3_000);
      expect(again).toBe(202);
    } finally {
      delete process.env.ATHENA_MAX_INFLIGHT_RETESTS;
    }
  }, 20_000);

  it("a retest answered 2xx with a body that is not an object is unrecognised (502) and holds its slot", async () => {
    process.env.ATHENA_MAX_INFLIGHT_RETESTS = "1";
    const fx = load(PR71, "at-once-then-verdict");
    try {
      const a = await scanned(fx); const b = await scanned(fx);
      slots().pollMs = 400;
      eng.retest = { status: 200, body: [1, 2, 3] };
      const first = await admin.post(`/api/tests/${a.testId}/retest`).send({ twinId: 1 });
      expect(first.status).toBe(502);
      expect(first.body.reason).toBe("unrecognised_engine_answer");
      expect(first.body.held).toMatch(/It may still be running this retest/);
      eng.retest = null;
      expect((await admin.post(`/api/tests/${b.testId}/retest`).send({ twinId: 1 })).status).toBe(429);
      const again = await until(async () => {
        eng.statusReads = [statusReadsOf(fx)[0]];
        return (await admin.post(`/api/tests/${b.testId}/retest`).send({ twinId: 1 })).status;
      }, (status) => status !== 429, 3_000);
      expect(again).toBe(202);
    } finally {
      delete process.env.ATHENA_MAX_INFLIGHT_RETESTS;
    }
  }, 20_000);

  it("no engine configured: a retest is answered 503 at once and its slot is free", async () => {
    process.env.ATHENA_MAX_INFLIGHT_RETESTS = "1";
    const fx = load(PR71, "at-once-then-verdict");
    const a = await scanned(fx);
    const live = process.env.ATHENA_ENGINE_URL;
    const said = vi.spyOn(console, "log");
    delete process.env.ATHENA_ENGINE_URL;
    try {
      const first = await admin.post(`/api/tests/${a.testId}/retest`).send({ twinId: 1 });
      expect(first.status).toBe(503);
      expect(first.body.error).toMatch(/no engine is configured/);
      expect(said.mock.calls.some((one) => /is free at once: no engine is configured/.test(String(one[0])))).toBe(true);
      const second = await admin.post(`/api/tests/${a.testId}/retest`).send({ twinId: 1 });
      expect(second.status).toBe(503);
    } finally {
      process.env.ATHENA_ENGINE_URL = live;
      delete process.env.ATHENA_MAX_INFLIGHT_RETESTS;
    }
  });

  it("the kill switch, the tests held in memory and the engine's list read, the database's read failing: a run the engine lists is said against the finished test memory records for it", async () => {
    const runId = `r5-finished-listed-${Date.now()}`;
    const client = await storage.createClient({ name: "Finished", company: "F", email: "finished@f.test" });
    const finished = await storage.createTest({
      clientId: client.id, testType: "vulnerability-scan", status: "completed",
      findings: { runId, target: "https://offline.invalid/", results: [] },
    });
    eng.active = { status: 200, body: { active: [{ run_id: runId, target: "https://offline.invalid/", kind: "scan", state: "running" }] } };
    vi.spyOn(storage, "getAllTests").mockRejectedValue(new Error("disk I/O error"));
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    vi.restoreAllMocks();
    expect(engaged.status).toBe(200);
    // The rows were not needed (memory held the tests, the engine's list was read): listed from memory.
    expect(engaged.body.stops.listed).toBe(true);
    expect(engaged.body.engineRuns.runs).toEqual(expect.arrayContaining([expect.objectContaining({ runId, testId: finished.id, stopped: true })]));
    await admin.patch("/api/ai-control").send(REACTIVATE);
  });
});
