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
 * SAFETY, round four of PR #56 (the round-three review's findings), on the
 * memory backend with the recorded engine answers (tests/fixtures/engine-retest):
 *
 *   - A stale account gains nothing but stops. A session this process still
 *     holds as an admin's, whose account another dashboard deleted or demoted,
 *     may still send a stop -- a pause's signature, revoking its own key -- but
 *     a resume's or a release's signature, or revoking another admin's key,
 *     needs the account read now: refused (401/403), or 503 when it cannot be
 *     read, and nothing is relayed or revoked.
 *   - Only a definite engine answer frees a retest's slot at once: a reset
 *     connection holds it, like a timeout, until the engine lists no live
 *     retest on its scope.
 *   - A stop whose answer was not read is "stop sent, answer unread": never
 *     accepted, and a verdict after it is "completed after a stop whose answer
 *     was not read". Its stalled answer holds no socket.
 *   - The AI Control settings are written in the order the requests arrived.
 *   - And the branches the round-three review found untested.
 */

type Exchange = { request: { method: string; path: string; body?: Record<string, unknown> }; status: number; body: any };
type Fixture = { engine: { contract: string }; exchanges: Exchange[] };
const FIX = path.resolve(__dirname, "fixtures", "engine-retest");
const load = (dir: string, name: string): Fixture => JSON.parse(fs.readFileSync(path.join(FIX, dir, `${name}.json`), "utf8"));
const PR71 = "pr71-143279e";
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
        if (eng.stallAbortBody) { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); stalledOpen += 1; res.on("close", () => { stalledOpen -= 1; }); return; }
        const answer = eng.abortByRun.get(runId) ?? eng.abort;
        return json(res, answer.status, answer.body);
      }
      if (!fx) return json(res, 500, { detail: "no fixture" });
      if (req.method === "POST" && url === "/api/scan") return json(res, fx.exchanges[0].status, fx.exchanges[0].body);
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
const watchRow = (runId: string, testId: string, clientId: string, over: Record<string, unknown> = {}) => {
  const now = new Date();
  return {
    engineRunId: runId, testId, clientId, twinId: 1, findingId: null, engagementRef: null, requestedBy: null,
    requestedFrom: null, startedAt: now, deadlineAt: new Date(now.getTime() + 60_000), state: "running", engineState: "running",
    reason: null, error: null, lastReadAt: null, lastReadError: null, stopAcceptedAt: null, endedAt: null, result: null, ...over,
  } as import("@shared/schema").RetestWatch;
};



/**
 * A stand-in failsafe control plane: a command whose uuid names "resume" or
 * "release" is that action; every other is a pause. `relayed` is every
 * request it received.
 */
async function controlPlane(options: { unreadable?: boolean } = {}) {
  const relayed: string[] = [];
  const actionOf = (uuid: string) => (uuid.includes("resume") ? "resume" : uuid.includes("release") ? "release" : "pause");
  const plane = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      relayed.push(`${req.method} ${req.url}`);
      if (req.url === "/api/token/") return json(res, 200, { access: "tok" });
      const sig = /^\/api\/failsafe\/commands\/([^/]+)\/signatures\/$/.exec(req.url ?? "");
      if (sig) return json(res, 200, { uuid: sig[1], action: actionOf(sig[1]), engine_id: "engine-1", status: "ready", signers: ["k1"], required_signatures: 1 });
      const one = /^\/api\/failsafe\/commands\/([^/]+)\/$/.exec(req.url ?? "");
      if (one) {
        if (options.unreadable) return json(res, 500, { detail: "the control plane is restarting" });
        return json(res, 200, { uuid: one[1], action: actionOf(one[1]), engine_id: "engine-1", status: "pending", signing_bytes: "00" });
      }
      if (req.url === "/api/failsafe/commands/" && req.method === "POST") {
        return json(res, 201, { uuid: "drafted-1", action: "pause", engine_id: "engine-1", status: "pending", signing_bytes: "00" });
      }
      return json(res, 200, []);
    });
  });
  await new Promise<void>((r) => plane.listen(0, "127.0.0.1", r));
  process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${(plane.address() as AddressInfo).port}`;
  process.env.ATHENA_FAILSAFE_USER = "svc";
  process.env.ATHENA_FAILSAFE_PASSWORD = "pw";
  return {
    relayed,
    signed: (uuid: string) => relayed.includes(`POST /api/failsafe/commands/${uuid}/signatures/`),
    close: async () => {
      delete process.env.ATHENA_FAILSAFE_URL;
      delete process.env.ATHENA_FAILSAFE_USER;
      delete process.env.ATHENA_FAILSAFE_PASSWORD;
      await new Promise<void>((r) => plane.close(() => r()));
    },
  };
}

let admins = 0;
/** A second admin, signed in; changed on the record afterwards only as each case says. */
async function secondAdmin() {
  admins += 1;
  const username = `r4-admin-${admins}`;
  const made = await admin.post("/api/users").send({ username, password: "second-admin-pw", role: "admin", email: `${username}@a.test` });
  expect(made.status).toBe(201);
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ username, password: "second-admin-pw" })).status).toBe(200);
  return { agent, id: made.body.id as string };
}

describe("a stale account gains nothing but stops", () => {
  it("an admin deleted on the record by another dashboard: a pause's signature is relayed from memory, a resume's is refused 401 and never relayed", async () => {
    const plane = await controlPlane();
    try {
      const ex = await secondAdmin();
      // Deleted on the shared record by another dashboard: this process's user routes never ran.
      expect(await storage.deleteUser(ex.id)).toBe(true);
      const getUser = vi.spyOn(storage, "getUser");

      const pause = await ex.agent.post("/api/failsafe/commands/cmd-pause-1/signatures").send({ keyId: "k1", sig: "abcd" });
      expect(pause.status).toBe(200);
      expect(plane.signed("cmd-pause-1")).toBe(true);
      // A stop: authorised from memory, without reading the account.
      expect(getUser).not.toHaveBeenCalled();

      const resume = await ex.agent.post("/api/failsafe/commands/cmd-resume-1/signatures").send({ keyId: "k1", sig: "abcd" });
      expect(resume.status).toBe(401);
      expect(plane.signed("cmd-resume-1")).toBe(false);
      // Not a stop: the account was read, and found gone.
      expect(getUser).toHaveBeenCalled();
    } finally {
      await plane.close();
    }
  });

  it("an admin demoted on the record by another dashboard is refused a resume's or a release's signature (403), and neither is relayed", async () => {
    const plane = await controlPlane();
    try {
      const ex = await secondAdmin();
      await storage.updateUser(ex.id, { role: "user" });
      for (const uuid of ["cmd-resume-2", "cmd-release-2"]) {
        const relayed = await ex.agent.post(`/api/failsafe/commands/${uuid}/signatures`).send({ keyId: "k1", sig: "abcd" });
        expect(relayed.status, uuid).toBe(403);
        expect(plane.signed(uuid), uuid).toBe(false);
      }
    } finally {
      await plane.close();
    }
  });

  it("a resume's signature whose account cannot be read is answered 503 and never relayed; a pause's goes without the read", async () => {
    const plane = await controlPlane();
    try {
      vi.spyOn(storage, "getUser").mockRejectedValue(new Error("disk I/O error"));
      const resume = await admin.post("/api/failsafe/commands/cmd-resume-3/signatures").send({ keyId: "k1", sig: "abcd" });
      expect(resume.status).toBe(503);
      expect(resume.body.message).toMatch(/could not be read \(disk I\/O error\)/);
      expect(plane.signed("cmd-resume-3")).toBe(false);
      const pause = await admin.post("/api/failsafe/commands/cmd-pause-3/signatures").send({ keyId: "k1", sig: "abcd" });
      expect(pause.status).toBe(200);
      expect(plane.signed("cmd-pause-3")).toBe(true);
    } finally {
      await plane.close();
    }
  });

  it("a signature whose command's action cannot be read is not taken for a stop: the account is read, and a current admin's is relayed", async () => {
    const plane = await controlPlane({ unreadable: true });
    try {
      const ex = await secondAdmin();
      await storage.deleteUser(ex.id);
      const stale = await ex.agent.post("/api/failsafe/commands/cmd-pause-4/signatures").send({ keyId: "k1", sig: "abcd" });
      expect(stale.status).toBe(401);
      expect(plane.signed("cmd-pause-4")).toBe(false);
      const current = await admin.post("/api/failsafe/commands/cmd-pause-5/signatures").send({ keyId: "k1", sig: "abcd" });
      expect(current.status).toBe(200);
      expect(plane.signed("cmd-pause-5")).toBe(true);
    } finally {
      await plane.close();
    }
  });

  it("an admin deleted on the record by another dashboard revokes its own key from memory, but not another admin's (401, not revoked)", async () => {
    const ex = await secondAdmin();
    const own = await ex.agent.post("/api/api-keys").send({ name: "ex-admin's own" });
    expect(own.status).toBe(201);
    const others = await admin.post("/api/api-keys").send({ name: "the real admin's automation" });
    expect(others.status).toBe(201);
    expect(await storage.deleteUser(ex.id)).toBe(true);
    const getUser = vi.spyOn(storage, "getUser");

    const mine = await ex.agent.delete(`/api/api-keys/${own.body.key.id}`);
    expect(mine.status).toBe(200);
    expect(getUser).not.toHaveBeenCalled();

    const theirs = await ex.agent.delete(`/api/api-keys/${others.body.key.id}`);
    expect(theirs.status).toBe(401);
    const stored = (await storage.getAllApiKeys()).find((one) => one.id === others.body.key.id);
    expect(stored?.revokedAt ?? null).toBeNull();

    // A current admin revokes another's key, the account read and found an admin's.
    const byAdmin = await admin.delete(`/api/api-keys/${own.body.key.id}`);
    expect(byAdmin.status).toBe(200);
  });

  it("revoking another admin's key when the account cannot be read is answered 503, and nothing is revoked", async () => {
    const ex = await secondAdmin();
    const theirs = await ex.agent.post("/api/api-keys").send({ name: "second admin's key" });
    expect(theirs.status).toBe(201);
    vi.spyOn(storage, "getUser").mockRejectedValue(new Error("disk I/O error"));
    const revoked = await admin.delete(`/api/api-keys/${theirs.body.key.id}`);
    expect(revoked.status).toBe(503);
    vi.restoreAllMocks();
    expect((await storage.getAllApiKeys()).find((one) => one.id === theirs.body.key.id)?.revokedAt ?? null).toBeNull();
  });

  it("a guard's read of an account deleted on the record is remembered: its session's next stop is authorised by nothing", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    const ex = await secondAdmin();
    const runId = `r4-guard-read-${Date.now()}`;
    await runningTest(runId);
    eng.abort = abortsOf(fx)[0];
    expect(await storage.deleteUser(ex.id)).toBe(true);
    // Before anything here read the account, the session's stop is authorised from memory (the safe direction).
    const getUser = vi.spyOn(storage, "getUser");
    calls.length = 0;
    expect((await ex.agent.post("/api/retests/r4-unrelated-run/abort")).status).toBe(200);
    expect(getUser).not.toHaveBeenCalled();
    // A guarded request that is not a stop reads the account, and finds it gone (noteAccountDeleted).
    expect((await ex.agent.get("/api/failsafe/commands")).status).toBe(401);
    expect(getUser).toHaveBeenCalledTimes(1);
    // From then on the session authorises nothing -- its stops included -- from memory.
    calls.length = 0;
    const engaged = await ex.agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
    expect(engaged.status).toBe(401);
    expect(aborts()).toEqual([]);
    expect((await admin.get("/api/ai-control")).body.killSwitchEnabled).toBe(false);
  });
});

describe("the live sessions of an account follow it (reviseLiveSessions)", () => {
  it("a changed role is written into every live session of that account; a deactivated or deleted account's sessions are ended", async () => {
    const session = (await import("express-session")).default;
    const createMemoryStore = (await import("memorystore")).default;
    const { reviseLiveSessions } = await import("../server/auth");
    // The store the app keeps its sessions in (server/app.ts).
    const store = new (createMemoryStore(session))({ checkPeriod: 24 * 60 * 60 * 1000 });
    const put = (sid: string, data: Record<string, unknown>) =>
      new Promise<void>((r) => store.set(sid, { cookie: { originalMaxAge: 60_000 }, ...data } as never, () => r()));
    const get = (sid: string) => new Promise<Record<string, unknown> | null | undefined>((r) => store.get(sid, (_e, s) => r(s as never)));
    await put("s1", { userId: "u1", role: "admin" });
    await put("s2", { userId: "u1", role: "admin" });
    await put("s3", { userId: "u2", role: "admin" });
    await put("s4", { userId: "u3", role: "admin" });

    reviseLiveSessions(store, "u1", { role: "user", isActive: true });
    await sleep(20);
    expect((await get("s1"))?.role).toBe("user");
    expect((await get("s2"))?.role).toBe("user");
    expect((await get("s3"))?.role).toBe("admin");

    reviseLiveSessions(store, "u2", null);
    reviseLiveSessions(store, "u3", { role: "admin", isActive: false });
    await sleep(20);
    expect(await get("s3")).toBeFalsy();
    expect(await get("s4")).toBeFalsy();
    expect((await get("s1"))?.role).toBe("user");
  });

  it("demoting an admin through the user routes rewrites that admin's live session in the app's store", async () => {
    const ex = await secondAdmin();
    let store: import("express-session").Store | undefined;
    // The app's own store, as its session middleware holds it.
    app.get("/__r4-store", (req, res) => { store = req.sessionStore; res.json({}); });
    await ex.agent.get("/__r4-store");
    expect(store).toBeDefined();
    const roles = () => new Promise<string[]>((resolve) => store!.all!((_e, all) => {
      const list = Array.isArray(all) ? [] : Object.values(all ?? {}) as Array<{ userId?: string; role?: string }>;
      resolve(list.filter((one) => one.userId === ex.id).map((one) => String(one.role)));
    }));
    expect(await roles()).toEqual(["admin"]);
    expect((await admin.patch(`/api/users/${ex.id}`).send({ role: "user" })).status).toBe(200);
    await sleep(20);
    expect(await roles()).toEqual(["user"]);
    expect((await admin.delete(`/api/users/${ex.id}`)).status).toBe(200);
    await sleep(20);
    expect(await roles()).toEqual([]);
  });
});

describe("the other fields sent with the kill switch, when the account or the switch cannot be stored", () => {
  it("the account behind the session cannot be read: the switch is engaged and every stop sent; the other fields are refused 503, by name", async () => {
    const original = (await admin.get("/api/ai-control")).body;
    const runId = `r4-unread-account-${Date.now()}`;
    await runningTest(runId);
    eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
    vi.spyOn(storage, "getUser").mockRejectedValue(new Error("disk I/O error"));
    calls.length = 0;
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true, maxConcurrentTests: 7, systemStatus: "shutdown" });
    vi.restoreAllMocks();
    expect(engaged.status).toBe(503);
    expect(engaged.body.engaged).toBe(true);
    expect(engaged.body.refused).toEqual(expect.arrayContaining(["maxConcurrentTests", "systemStatus"]));
    expect(engaged.body.message).toMatch(/could not be read \(disk I\/O error\)/);
    expect(aborts()).toContain(`POST /api/scans/${runId}/abort`);
    const after = (await admin.get("/api/ai-control")).body;
    expect(after.killSwitchEnabled).toBe(true);
    expect(after.maxConcurrentTests).toBe(original.maxConcurrentTests);
    await admin.patch("/api/ai-control").send({ ...REACTIVATE, systemStatus: original.systemStatus });
  });

  it("the switch itself cannot be stored: every stop is sent, the answer says NOT engaged, and the other fields are refused by name", async () => {
    const runId = `r4-unstored-${Date.now()}`;
    await runningTest(runId);
    eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
    vi.spyOn(storage, "updateAIControlSettings").mockRejectedValue(new Error("database or disk is full"));
    calls.length = 0;
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true, maxConcurrentTests: 7 });
    vi.restoreAllMocks();
    expect(engaged.status).toBe(500);
    expect(engaged.body.engaged).toBe(false);
    expect(engaged.body.refused).toEqual(["maxConcurrentTests"]);
    expect(engaged.body.message).toMatch(/could not be engaged: database or disk is full/);
    expect(engaged.body.message).toMatch(/other fields sent with it \(maxConcurrentTests\) were not saved/);
    expect(engaged.body.stops.scans.some((one: { runId: string; stopped: boolean }) => one.runId === runId && one.stopped)).toBe(true);
    expect(aborts()).toContain(`POST /api/scans/${runId}/abort`);
    const switchLog = (await storage.getAllActivityLogs())
      .filter((one) => one.entityType === "ai_control")
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
    expect((switchLog.details as { notStored?: string; refused?: string[] }).notStored).toMatch(/disk is full/);
    expect((switchLog.details as { refused?: string[] }).refused).toEqual(["maxConcurrentTests"]);
    expect((await admin.get("/api/ai-control")).body.killSwitchEnabled).toBe(false);
  });
});

describe("only a definite engine answer frees a retest's slot at once", () => {
  it("engine main, its retest's connection reset (not timed out): the slot is held while the engine runs it, and freed when the engine lists none", async () => {
    process.env.ATHENA_MAX_INFLIGHT_RETESTS = "1";
    slots().pollMs = 100;
    const fx = load(MAIN, "verdict-closed");
    const said = vi.spyOn(console, "log");
    let release!: () => void;
    try {
      const a = await scanned(fx); const b = await scanned(fx); const c = await scanned(fx);
      eng.listHeldRetests = true;
      eng.retestHold = new Promise<void>((r) => { release = r; });
      resetRetestAfterMs = 300;
      calls.length = 0;
      const first = await admin.post(`/api/tests/${a.testId}/retest`).send({ twinId: 1 });
      expect(first.status).toBe(503);
      expect(first.body.reason).toBe("retest_unconfirmed");
      expect(first.body.error).toMatch(/may still be running this retest/);
      await sleep(300);
      const second = await admin.post(`/api/tests/${b.testId}/retest`).send({ twinId: 1 });
      const third = await admin.post(`/api/tests/${c.testId}/retest`).send({ twinId: 1 });
      expect([second.status, third.status]).toEqual([429, 429]);
      // The cap holds on the engine: one retest thread, not three.
      expect(heldRetests).toBe(1);
      expect(calls.filter((one) => one.line === "POST /api/remediation/retest").length).toBeLessThanOrEqual(2);
      // The engine finishes it and lists none: the slot comes free at the next read, and the log says so.
      resetRetestAfterMs = null;
      release();
      await until(async () => heldRetests, (held) => held === 0);
      eng.retestHold = null;
      await until(async () => said.mock.calls.some((args) => /status poll/.test(String(args[0]))), (freed) => freed, 2_000);
      expect(said.mock.calls.some((args) => /status poll/.test(String(args[0])))).toBe(true);
      const after = await admin.post(`/api/tests/${b.testId}/retest`).send({ twinId: 1 });
      expect(after.status).not.toBe(429);
    } finally {
      resetRetestAfterMs = null;
      release?.();
      await until(async () => heldRetests, (h) => h === 0);
      eng.retestHold = null;
      delete process.env.ATHENA_MAX_INFLIGHT_RETESTS;
    }
  }, 30_000);

  it("a refusal (4xx) is definite: the slot is free at once, and the next retest is sent", async () => {
    process.env.ATHENA_MAX_INFLIGHT_RETESTS = "1";
    const fx = load(PR71, "at-once-then-verdict");
    try {
      const a = await scanned(fx); const b = await scanned(fx);
      eng.retest = { status: 400, body: { detail: "scope does not cover the twin's target" } };
      const refused = await admin.post(`/api/tests/${a.testId}/retest`).send({ twinId: 1 });
      expect(refused.status).toBe(503);
      expect(refused.body.reason).toBeUndefined();
      eng.retest = null;
      eng.statusReads = [statusReadsOf(fx)[0]];
      calls.length = 0;
      const next = await admin.post(`/api/tests/${b.testId}/retest`).send({ twinId: 1 });
      expect(next.status).toBe(202);
      expect(calls.filter((one) => one.line === "POST /api/remediation/retest").length).toBe(1);
    } finally {
      delete process.env.ATHENA_MAX_INFLIGHT_RETESTS;
    }
  });
});

describe("a stop whose answer was not read is never an accepted one", () => {
  it("a retest's Stop whose answer body stalls is noted as sent, its answer unread; the verdict after it is filed as completed after a stop whose answer was not read", async () => {
    timeouts().abortBodyMs = 200;
    const fx = load(PR71, "at-once-then-verdict");
    const { testId, finding } = await scanned(fx);
    const reads = statusReadsOf(fx);
    eng.statusReads = [reads[0]];
    const started = await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 });
    expect(started.status).toBe(202);
    const runId = started.body.engineRunId as string;
    eng.stallAbortBody = true;
    const stop = await admin.post(`/api/retests/${runId}/abort`);
    eng.stallAbortBody = false;
    engineServer.closeAllConnections?.();
    expect(stop.body).toMatchObject({ stopped: true, answerUnread: true });
    await sleep(50);
    expect(watcher.peek(runId)?.stopAcceptedAt ?? null).toBeNull();
    expect(watcher.peek(runId)?.stopUnreadAt).toBeInstanceOf(Date);
    const running = (await admin.get(`/api/retests/${runId}`)).body;
    expect(running.detail).toMatch(/stop sent, answer unread/);
    expect(running.detail).not.toMatch(/accepted a stop/);
    const logged = await until(() => storage.getActivityLogsByEntity("test", testId),
      (rows) => rows.some((one) => (one.details as { via?: string } | null)?.via === "retest_stop"), 2_000);
    const stopLog = logged.find((one) => (one.details as { via?: string } | null)?.via === "retest_stop")!;
    expect(stopLog.action).toBe("abort_sent_answer_unread");

    // The run had in fact finished with a verdict.
    eng.statusReads = [reads[reads.length - 1]];
    const view = await until(async () => (await admin.get(`/api/retests/${runId}`)).body, (v) => v.phase !== "running", 4_000);
    expect(view.phase).toBe("verdict");
    expect(view.result?.completedDespiteStop).toBe(false);
    expect(view.result?.completedAfterUnreadStop).toBe(true);
    expect(view.detail).toMatch(/completed after a stop whose answer was not read/i);
    expect(view.detail).not.toMatch(/accepted a stop|despite a stop/);
    const [check] = await storage.getChecks(finding.id);
    expect(check.detail).toMatch(/Completed after a stop whose answer was not read\.\)?$/);
    expect(check.detail).not.toMatch(/despite a stop/);
  });

  it("the kill switch counts a stop whose answer was not read as that, never as accepted, and notes it so on the watch", async () => {
    timeouts().abortBodyMs = 200;
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    await sleep(100);
    eng.stallAbortBody = true;
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    eng.stallAbortBody = false;
    engineServer.closeAllConnections?.();
    expect(engaged.status).toBe(200);
    expect(watcher.peek(runId)?.stopAcceptedAt ?? null).toBeNull();
    expect((await storage.getRetestWatch(runId))?.stopUnreadAt).toBeInstanceOf(Date);
    const switchLog = (await storage.getAllActivityLogs())
      .filter((one) => one.entityType === "ai_control" && (one.details as { stops?: unknown } | null)?.stops)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
    const counted = (switchLog.details as { stops: { sent: number; accepted: number; answerUnread?: number } }).stops;
    expect(counted.accepted).toBe(0);
    expect(counted.answerUnread).toBe(counted.sent);
    await admin.patch("/api/ai-control").send(REACTIVATE);
  });

  it("a stalled stop answer lets its socket go at the body limit: none of three is held 1.5 s later", async () => {
    timeouts().abortBodyMs = 200;
    engineServer.closeAllConnections?.();
    await sleep(100);
    stalledOpen = 0;
    const tests = await Promise.all([1, 2, 3].map((i) => runningTest(`r4-socket-${i}-${Date.now()}`)));
    eng.stallAbortBody = true;
    try {
      for (const t of tests) expect((await admin.post(`/api/scans/${t.id}/abort`)).body.answerUnread).toBe(true);
    } finally {
      eng.stallAbortBody = false;
    }
    await sleep(1_500);
    expect(stalledOpen).toBe(0);
  });
});

describe("the AI Control settings are written in the order the requests arrived", () => {
  it("disengage pressed, then engage 50 ms later, the disengage's account read taking 300 ms: the switch ends ON, and the disengage writes nothing and says superseded", async () => {
    await storage.updateAIControlSettings({ killSwitchEnabled: true, systemStatus: "shutdown" });
    const real = storage.getUser.bind(storage);
    let slowOnce = true;
    vi.spyOn(storage, "getUser").mockImplementation(async (id: string) => {
      if (slowOnce) { slowOnce = false; await sleep(300); }
      return real(id);
    });
    const writes = vi.spyOn(storage, "updateAIControlSettings");
    const off = admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" }).then((r) => r);
    await sleep(50);
    const on = admin.patch("/api/ai-control").send({ killSwitchEnabled: true }).then((r) => r);
    const [a, b] = await Promise.all([off, on]);
    const stored = (await storage.getAIControlSettings())!;
    expect(stored.killSwitchEnabled).toBe(true);
    expect(b.status).toBe(200);
    expect(b.body.killSwitchEnabled).toBe(true);
    expect(b.body.superseded).toBeUndefined();
    // The disengage arrived first and was overtaken: nothing of it was written, and its answer says so.
    expect(a.status).toBe(409);
    expect(a.body.written).toBe(false);
    expect(a.body.superseded).toMatch(/later change/);
    expect(a.body.killSwitchEnabled).toBe(stored.killSwitchEnabled);
    expect(writes.mock.calls.map(([fields]) => (fields as { killSwitchEnabled?: boolean }).killSwitchEnabled)).toEqual([true]);
    vi.restoreAllMocks();
    await admin.patch("/api/ai-control").send(REACTIVATE);
  });
});

describe("before the watches on record are read", () => {
  it("a retest's Stop is sent to whatever engine run id it names, and logged as sent before watches loaded, its id not verified as a retest", async () => {
    retests.retestWatch.resumeRetryMs = 60_000;
    watcher.reset();
    const resumed = (watcher as unknown as { resumed?: { loaded: boolean } }).resumed;
    if (resumed) resumed.loaded = false;
    const fail = vi.spyOn(storage, "getOpenRetestWatches").mockRejectedValue(new Error("disk I/O error"));
    try {
      watcher.resume();
      await until(async () => resumeState().failedReads, (failed) => failed > 0, 2_000);
      eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
      calls.length = 0;
      const runId = `a-scan-not-a-retest-${Date.now()}`;
      const stop = await analyst.post(`/api/retests/${runId}/abort`);
      expect(stop.status).toBe(200);
      expect(aborts()).toEqual([`POST /api/scans/${runId}/abort`]);
      const logged = await until(() => storage.getActivityLogsByEntity("engine_run", runId), (rows) => rows.length > 0, 2_000);
      expect((logged[0].details as { note?: string }).note).toMatch(/^sent before watches loaded, id not verified as a retest/);
    } finally {
      fail.mockRestore();
      retests.retestWatch.resumeRetryMs = 50;
      watcher.resume();
      await until(async () => resumeState().loaded, (loaded) => loaded, 2_000);
    }
  });
});

describe("a call waiting on a busy database past its time (BusyLine)", () => {
  it("the head fails with the busy error it met; a call queued behind it that never tried fails saying the lock was held longer than it waits", async () => {
    const { withBusyRetry, BusyLine } = await import("../server/storage-sqlite");
    let tries = 0;
    let others = 0;
    const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const target = {
      async createThing() { tries += 1; throw busy(); },
      async createOther() { others += 1; return "written"; },
    };
    // One line; the call behind waits 100 ms in all, the one ahead 400 ms.
    const line = new BusyLine();
    const patient = withBusyRetry(target, 400, line);
    const hasty = withBusyRetry(target, 100, line);
    const started = Date.now();
    const head = patient.createThing().then(() => "ok", (cause: Error) => cause);
    const behind = hasty.createOther().then(() => "ok", (cause: Error) => cause);
    // The call behind leaves at its own deadline, while the head is still trying.
    const b0 = await behind;
    expect(Date.now() - started).toBeLessThan(300);
    const [a, b] = [await head, b0];
    expect(a).toBeInstanceOf(Error);
    expect((a as Error).message).toBe("database is locked");
    expect(tries).toBeGreaterThan(1);
    expect(b).toBeInstanceOf(Error);
    expect((b as Error & { code?: string }).code).toBe("SQLITE_BUSY");
    expect((b as Error).message).toMatch(/held its lock for longer than this call waits/);
    // Made in the same turn as a try still out, it waited its turn and never tried.
    expect(others).toBe(0);
  });
});
