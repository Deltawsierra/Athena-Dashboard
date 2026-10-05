import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import request from "supertest";
import type { Express } from "express";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { DEFAULT_ACTIVE_SYSTEMS } from "@shared/ai-systems";
import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";

/**
 * SAFETY, round three of PR #56: nothing -- a stale session, a failed or slow
 * read, an answer whose body never finishes -- holds back or blocks a stop,
 * and nothing is said about a stop that is not so.
 *
 *   - A session's stops follow its account as it is now: promoted, the kill
 *     switch is its to engage; demoted, deactivated or deleted, it is not. And
 *     a kill switch authorised from the session authorises the switch alone:
 *     every other field sent with it waits for the stops, and is then
 *     authorised from the account.
 *   - A failed resume read is tried again until it succeeds; until then a
 *     retest's Stop is sent for anyone signed in who may run retests, and the
 *     kill switch says it could not list the retests.
 *   - A stop's answer is read from its headers; a body that stalls holds no
 *     Stop, no kill switch and no retest slot.
 *   - A retest the engine did not answer in time keeps its slot until the
 *     engine lists it ended, or a hard ceiling.
 *   - A run the engine answered "not running" is said and logged as not
 *     running: never stopped, never accepted.
 *
 * Engine answers are the recorded fixtures (tests/fixtures/engine-retest).
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
        if (eng.stallAbortBody) { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); return; }
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
  await adminHasSetPassword();
  admin = request.agent(app);
  expect((await admin.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD })).status).toBe(200);
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

describe("a session's stops follow its account as it is now", () => {
  it("a user promoted to admin while signed in engages the kill switch and stops another's retest at once", async () => {
    expect((await admin.patch(`/api/users/${analystId}`).send({ role: "admin" })).status).toBe(200);
    try {
      const fx = load(PR71, "at-once-then-verdict");
      await scanned(fx);
      eng.active = activeOf(fx);
      eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
      calls.length = 0;
      const engaged = await analyst.patch("/api/ai-control").send({ killSwitchEnabled: true });
      expect(engaged.status).toBe(200);
      expect(aborts().length).toBeGreaterThan(0);
      await admin.patch("/api/ai-control").send(REACTIVATE);

      const fx2 = load(PR71, "at-once-then-stopped");
      const { testId } = await scanned(fx2);
      eng.statusReads = [statusReadsOf(fx2)[0]];
      const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
      calls.length = 0;
      const stop = await analyst.post(`/api/retests/${runId}/abort`);
      expect(stop.status).toBe(200);
      expect(aborts()).toEqual([`POST /api/scans/${runId}/abort`]);
    } finally {
      await admin.patch(`/api/users/${analystId}`).send({ role: "user" });
    }
  });

  it("a demoted, deactivated or deleted admin's live session is refused the kill switch, sends no stop and changes no setting", async () => {
    const original = (await admin.get("/api/ai-control")).body;
    const fx = load(PR71, "at-once-then-verdict");
    await scanned(fx);
    eng.active = activeOf(fx);
    for (const [how, refusedWith] of [["demoted", 403], ["deactivated", 401], ["deleted", 401]] as const) {
      const name = `admin3-${how}`;
      const made = await admin.post("/api/users").send({ username: name, password: "second-admin-pw", role: "admin", email: `${name}@a.test` });
      expect(made.status).toBe(201);
      const second = request.agent(app);
      expect((await second.post("/api/auth/login").send({ username: name, password: "second-admin-pw" })).status).toBe(200);
      if (how === "demoted") expect((await admin.patch(`/api/users/${made.body.id}`).send({ role: "user" })).status).toBe(200);
      if (how === "deactivated") expect((await admin.patch(`/api/users/${made.body.id}`).send({ isActive: false })).status).toBe(200);
      if (how === "deleted") expect((await admin.delete(`/api/users/${made.body.id}`)).status).toBe(200);
      calls.length = 0;
      const engaged = await second.patch("/api/ai-control")
        .send({ killSwitchEnabled: true, maxConcurrentTests: 999, activeSystems: [], systemStatus: "hacked" });
      expect(engaged.status).toBe(refusedWith);
      expect(aborts()).toEqual([]);
      const after = (await admin.get("/api/ai-control")).body;
      expect(after.killSwitchEnabled).toBe(false);
      expect(after.maxConcurrentTests).toBe(original.maxConcurrentTests);
      expect(after.systemStatus).toBe(original.systemStatus);
      expect(after.activeSystems).toEqual(original.activeSystems);
    }
  });

  it("a signed-in user who is not an admin is refused the kill switch, and no stop is sent", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    await scanned(fx);
    eng.active = activeOf(fx);
    calls.length = 0;
    const engaged = await analyst.patch("/api/ai-control").send({ killSwitchEnabled: true });
    expect(engaged.status).toBe(403);
    expect(aborts()).toEqual([]);
    expect((await admin.get("/api/ai-control")).body.killSwitchEnabled).toBe(false);
  });

  it("the switch is engaged from the session, and every other field sent with it is authorised from the account after the stops", async () => {
    const original = (await admin.get("/api/ai-control")).body;
    const name = "admin3-changed-elsewhere";
    const made = await admin.post("/api/users").send({ username: name, password: "second-admin-pw", role: "admin", email: `${name}@a.test` });
    const second = request.agent(app);
    expect((await second.post("/api/auth/login").send({ username: name, password: "second-admin-pw" })).status).toBe(200);
    const runId = "r3-session-run";
    await runningTest(runId);
    eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
    // Demoted on the record by something this process did not see (another
    // dashboard on this database): the session still reads as an admin's.
    await storage.updateUser(made.body.id, { role: "user" });
    const reads: number[] = [];
    const realGetUser = storage.getUser.bind(storage);
    vi.spyOn(storage, "getUser").mockImplementation(async (id: string) => { reads.push(performance.now()); return realGetUser(id); });
    calls.length = 0;
    const engaged = await second.patch("/api/ai-control")
      .send({ killSwitchEnabled: true, maxConcurrentTests: 999, activeSystems: [], systemStatus: "hacked" });
    const firstStop = calls.find((c) => c.line === `POST /api/scans/${runId}/abort`);
    expect(firstStop).toBeDefined();
    // The account was read only after the stop had gone.
    expect(reads.length).toBeGreaterThan(0);
    expect(Math.min(...reads)).toBeGreaterThan(firstStop!.at);
    expect(engaged.status).toBe(403);
    expect(engaged.body.engaged).toBe(true);
    expect(engaged.body.refused).toEqual(expect.arrayContaining(["maxConcurrentTests", "activeSystems", "systemStatus"]));
    expect(engaged.body.message).toMatch(/were not saved: the account behind this session is no longer an admin/);
    const after = (await admin.get("/api/ai-control")).body;
    expect(after.killSwitchEnabled).toBe(true);
    expect(after.maxConcurrentTests).toBe(original.maxConcurrentTests);
    expect(after.systemStatus).toBe(original.systemStatus);
    vi.restoreAllMocks();
    await admin.patch("/api/ai-control").send({ ...REACTIVATE, systemStatus: original.systemStatus });

    // An admin whose account is an admin's: the same request stores everything.
    const ok = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] });
    await admin.patch("/api/ai-control").send({ ...REACTIVATE, systemStatus: original.systemStatus, activeSystems: original.activeSystems });
  });

  it("revoking an API key and drafting a failsafe pause are authorised from the session, without reading the account", async () => {
    const key = await admin.post("/api/api-keys").send({ name: "round3" });
    expect(key.status).toBe(201);
    const getUser = vi.spyOn(storage, "getUser");
    const revoked = await admin.delete(`/api/api-keys/${key.body.key.id}`);
    expect(revoked.status).toBe(200);
    const drafted = await admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "engine-1", reason: "round3" });
    // No control plane is configured here: the draft is answered by that fact, not by an account read.
    expect([401, 403]).not.toContain(drafted.status);
    expect(getUser).not.toHaveBeenCalled();
    // A non-admin session is refused both, from memory too.
    expect((await analyst.post("/api/failsafe/commands").send({ action: "pause", engineId: "engine-1", reason: "x" })).status).toBe(403);
  });
});

describe("a stop's answer whose body never finishes holds nothing", () => {
  it("a scan's Stop is answered from the headers, and says the rest of the answer was not read", async () => {
    timeouts().abortBodyMs = 300;
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    eng.stallAbortBody = true;
    calls.length = 0;
    const got = await within(admin.post(`/api/scans/${testId}/abort`), 5_000);
    engineServer.closeAllConnections?.();
    expect(got.done).toBe(true);
    if (!got.done) return;
    expect(got.v.status).toBe(200);
    expect(got.v.body).toMatchObject({ stopped: true, answerUnread: true });
    expect(aborts().length).toBe(1);
  });

  it("the kill switch answers, and writes its records, when a stop's answer body stalls", async () => {
    timeouts().abortBodyMs = 300;
    const testId = (await runningTest("r3-stalled-run")).id;
    eng.stallAbortBody = true;
    calls.length = 0;
    const got = await within(admin.patch("/api/ai-control").send({ killSwitchEnabled: true }), 5_000);
    engineServer.closeAllConnections?.();
    eng.stallAbortBody = false;
    expect(got.done).toBe(true);
    if (got.done) {
      expect(got.v.status).toBe(200);
      expect(got.v.body.stops.scans.find((one: { testId: string }) => one.testId === testId)).toMatchObject({ stopped: true, answerUnread: true });
    }
    // Recorded as a stop sent whose answer was not read -- never as aborted (accepted).
    const logged = await storage.getActivityLogsByEntity("test", testId);
    expect(logged.some((one) => one.action === "abort_sent_answer_unread")).toBe(true);
    expect(logged.some((one) => one.action === "aborted")).toBe(false);
    await admin.patch("/api/ai-control").send(REACTIVATE);
  });
});

describe("the retests sent at once", () => {
  it("a retest answer whose body stalls is no definite answer: its slot is held until the engine lists no live retest on its scope", async () => {
    process.env.ATHENA_MAX_INFLIGHT_RETESTS = "2";
    timeouts().bodyMs = 300;
    slots().pollMs = 100;
    const fx = load(PR71, "at-once-then-verdict");
    try {
      const tests = [await scanned(fx), await scanned(fx), await scanned(fx)];
      // The engine lists a live retest on the scope while it answers.
      eng.active = { status: 200, body: { active: [{ run_id: "stalled-live", target: "https://offline.invalid/", kind: "retest", state: "running" }] } };
      eng.stallRetestBody = true;
      const stalled = await Promise.all(tests.slice(0, 2).map((one) => admin.post(`/api/tests/${one.testId}/retest`).send({ twinId: 1 })));
      expect(stalled.map((r) => r.status)).toEqual([503, 503]);
      expect(stalled[0].body.reason).toBe("retest_unconfirmed");
      eng.stallRetestBody = false;
      engineServer.closeAllConnections?.();
      calls.length = 0;
      eng.statusReads = [statusReadsOf(fx)[0]];
      // Both slots are held: the next is refused, and never sent.
      await sleep(250);
      const refused = await admin.post(`/api/tests/${tests[2].testId}/retest`).send({ twinId: 1 });
      expect(refused.status).toBe(429);
      expect(calls.filter((c) => c.line === "POST /api/remediation/retest")).toEqual([]);
      // The engine lists no live retest any more: the slots come free at the next read.
      eng.active = { status: 200, body: { active: [] } };
      await sleep(400);
      const third = await admin.post(`/api/tests/${tests[2].testId}/retest`).send({ twinId: 1 });
      expect(third.status).not.toBe(429);
      expect(calls.filter((c) => c.line === "POST /api/remediation/retest").length).toBe(1);
    } finally {
      delete process.env.ATHENA_MAX_INFLIGHT_RETESTS;
    }
  });

  it("two retests of one finding pressed at once: one is sent, the other refused 409", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    const real = storage.getOpenRetestWatches.bind(storage);
    vi.spyOn(storage, "getOpenRetestWatches").mockImplementation(async (since: Date) => { await sleep(60); return real(since); });
    calls.length = 0;
    const [a, b] = await Promise.all([
      admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 }),
      admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 }),
    ]);
    expect([a.status, b.status].filter((s) => s === 409)).toHaveLength(1);
    expect(calls.filter((c) => c.line === "POST /api/remediation/retest").length).toBe(1);
  });

  it("a retest another dashboard is watching on the record is refused 409, and nothing is sent", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    const clientId = (await storage.getTest(testId))!.clientId;
    await storage.createRetestWatch(watchRow("elsewhere-run", testId, clientId));
    calls.length = 0;
    const second = await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 });
    expect(second.status).toBe(409);
    expect(second.body.reason).toBe("retest_running");
    expect(calls.filter((c) => c.line === "POST /api/remediation/retest")).toEqual([]);
  });

  it("only a 422 refusing wait_seconds is asked again; any other 422 is said, and sent once", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    eng.retest = { status: 422, body: { detail: [{ loc: ["body", "twin_id"], msg: "value is not a valid integer", type: "type_error" }] } };
    calls.length = 0;
    const answered = await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 });
    expect(answered.status).toBe(503);
    expect(answered.body.error).toMatch(/422/);
    expect(calls.filter((c) => c.line === "POST /api/remediation/retest").length).toBe(1);
  });

  it("on engine main a retest the engine did not answer in time keeps its slot until the engine lists it ended (status poll), or the hard ceiling", async () => {
    process.env.ATHENA_MAX_INFLIGHT_RETESTS = "2";
    timeouts().callMs = 400;
    slots().pollMs = 100;
    const fx = load(MAIN, "verdict-closed");
    let release!: () => void;
    try {
      const tests = [await scanned(fx), await scanned(fx), await scanned(fx), await scanned(fx)];
      eng.listHeldRetests = true;
      eng.retestHold = new Promise<void>((r) => { release = r; });
      const first = await Promise.all(tests.slice(0, 2).map((one) => admin.post(`/api/tests/${one.testId}/retest`).send({ twinId: 1 })));
      expect(first.map((r) => r.status)).toEqual([503, 503]);
      expect(first[0].body.reason).toBe("retest_unanswered");
      // The engine is still running both: nothing more is sent while it lists them.
      await sleep(300);
      const more = await Promise.all(tests.slice(2).map((one) => admin.post(`/api/tests/${one.testId}/retest`).send({ twinId: 1 })));
      expect(more.map((r) => r.status)).toEqual([429, 429]);
      expect(more[0].body.error).toMatch(/did not answer in time and may still be running/);
      // The same finding cannot be retested again while its first may be running.
      expect((await admin.post(`/api/tests/${tests[0].testId}/retest`).send({ twinId: 1 })).status).toBe(409);
      expect(heldRetests).toBe(2);
      // The engine finishes them and lists none: the slots come free at the next read.
      timeouts().callMs = 20_000;
      release();
      await until(async () => heldRetests, (held) => held === 0);
      await sleep(400);
      eng.retestHold = null;
      const after = await admin.post(`/api/tests/${tests[2].testId}/retest`).send({ twinId: 1 });
      expect(after.status).not.toBe(429);

      // Listed without end: freed at the hard ceiling, and not before.
      timeouts().callMs = 400;
      slots().ceilingMs = 1_500;
      eng.retestHold = new Promise<void>((r) => { release = r; });
      const stuck = await admin.post(`/api/tests/${tests[3].testId}/retest`).send({ twinId: 1 });
      expect(stuck.status).toBe(503);
      expect((await admin.post(`/api/tests/${tests[3].testId}/retest`).send({ twinId: 1 })).status).toBe(409);
      await sleep(2_000);
      timeouts().callMs = 20_000;
      release();
      await until(async () => heldRetests, (held) => held === 0);
      eng.retestHold = null;
      expect((await admin.post(`/api/tests/${tests[3].testId}/retest`).send({ twinId: 1 })).status).not.toBe(409);
    } finally {
      release?.();
      eng.retestHold = null;
      delete process.env.ATHENA_MAX_INFLIGHT_RETESTS;
    }
  }, 30_000);
});

describe("a failed read of the watches on record is tried again, and holds back no Stop meanwhile", () => {
  it("a failed resume read is tried again: the owner's Stop goes, the watch is read, and the kill switch stops it by id", async () => {
    retests.retestWatch.resumeRetryMs = 100;
    const fx = load(PR71, "at-once-then-verdict");
    const own = await scanned(fx, analyst);
    const runId = "resumed-run-r3";
    await storage.createRetestWatch(watchRow(runId, own.testId, (await storage.getTest(own.testId))!.clientId, { requestedBy: analystId }));
    watcher.reset();
    const errors = vi.spyOn(console, "error");
    vi.spyOn(storage, "getOpenRetestWatches").mockRejectedValueOnce(new Error("disk I/O error"));
    eng.statusReads = [statusReadsOf(load(PR71, "at-once-then-stopped"))[0]];
    const before = resumeState().failedReads;
    watcher.resume();
    await until(async () => resumeState(), (state) => state.failedReads === before + 1 && state.loaded, 3_000);
    expect(resumeState()).toMatchObject({ loaded: true, failedReads: before + 1 });
    expect(errors.mock.calls.some((c) => /could not be read to resume them.*trying again/.test(String(c[0])))).toBe(true);
    await until(async () => calls.filter((c) => c.line === `GET /api/scans/${runId}`).length, (reads) => reads > 0, 2_000);
    eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
    calls.length = 0;
    const stop = await analyst.post(`/api/retests/${runId}/abort`);
    expect(stop.status).toBe(200);
    expect(aborts()).toEqual([`POST /api/scans/${runId}/abort`]);
    eng.active = { status: 500, body: { detail: "list unavailable" } };
    calls.length = 0;
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    expect(engaged.status).toBe(200);
    expect(aborts()).toContain(`POST /api/scans/${runId}/abort`);
    await admin.patch("/api/ai-control").send(REACTIVATE);
  });

  it("until the watches are read, a retest's Stop is sent for anyone signed in, and logged with who sent it; the kill switch says it could not list the retests", async () => {
    retests.retestWatch.resumeRetryMs = 60_000;
    watcher.reset();
    // As a dashboard just started: the watches on record not read yet.
    const resumed = (watcher as unknown as { resumed?: { loaded: boolean } }).resumed;
    if (resumed) resumed.loaded = false;
    const fail = vi.spyOn(storage, "getOpenRetestWatches").mockRejectedValue(new Error("disk I/O error"));
    watcher.resume();
    await until(async () => resumeState().failedReads, (failed) => failed > 0, 2_000);
    eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
    calls.length = 0;
    // Nobody here knows whose retest this is: stopping is the safe direction.
    const stop = await analyst.post("/api/retests/someone-elses-run/abort");
    expect(stop.status).toBe(200);
    expect(aborts()).toEqual(["POST /api/scans/someone-elses-run/abort"]);
    const logged = await until(() => storage.getActivityLogsByEntity("engine_run", "someone-elses-run"), (rows) => rows.length > 0, 2_000);
    expect(logged[0]).toMatchObject({ action: "aborted", userId: analystId });
    expect((logged[0].details as { note?: string }).note).toMatch(/before this dashboard had read the retests on record/);

    eng.active = { status: 500, body: { detail: "list unavailable" } };
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    expect(engaged.status).toBe(200);
    expect(engaged.body.engineRuns.listed).toBe(false);
    expect(engaged.body.engineRuns.retestsUnlisted).toMatch(/no list of the retests could be made/);
    await admin.patch("/api/ai-control").send(REACTIVATE);

    // Once the read succeeds, an unknown retest is an admin's or its owner's to stop again.
    fail.mockRestore();
    retests.retestWatch.resumeRetryMs = 50;
    watcher.resume();
    await until(async () => resumeState().loaded, (loaded) => loaded, 2_000);
    expect((await analyst.post("/api/retests/someone-elses-run/abort")).status).toBe(403);
  });

  it("a watch resumed past its deadline whose last read fails tries it again, and files the verdict the engine has", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId, finding } = await scanned(fx);
    const reads = statusReadsOf(fx);
    const verdictRead = reads[reads.length - 1];
    const runId = String(verdictRead.body.run_id ?? "d1-run");
    const past = new Date(Date.now() - 60_000);
    await storage.createRetestWatch(watchRow(runId, testId, (await storage.getTest(testId))!.clientId, {
      requestedBy: adminId, startedAt: new Date(past.getTime() - 3_600_000), deadlineAt: past,
    }));
    eng.statusReads = [verdictRead];
    eng.statusFail = 1;
    watcher.reset();
    retests.retestWatch.resumeRetryMs = 50;
    watcher.resume();
    const row = await until(() => storage.getRetestWatch(runId), (r) => r?.state !== "running", 3_000);
    expect(row?.state).toBe("verdict");
    expect(((storage as unknown as { checks: Array<{ findingId: string }> }).checks).filter((c) => c.findingId === finding.id)).toHaveLength(1);
  });

  it("a watch past its deadline whose reads keep failing ends unwatched only after its retries, and says so", async () => {
    retests.retestWatch.deadlineReadRetries = 2;
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    const past = new Date(Date.now() - 60_000);
    const runId = "deadline-fails-run";
    await storage.createRetestWatch(watchRow(runId, testId, (await storage.getTest(testId))!.clientId, { deadlineAt: past }));
    eng.statusFail = 100;
    watcher.reset();
    retests.retestWatch.resumeRetryMs = 50;
    watcher.resume();
    const row = await until(() => storage.getRetestWatch(runId), (r) => r?.state !== "running", 3_000);
    expect(row?.state).toBe("unwatched");
    expect(calls.filter((c) => c.line === `GET /api/scans/${runId}`).length).toBe(3);
    expect(row?.lastReadError).toMatch(/tried 3 times past the deadline/);
  });
});

describe("the kill switch says what each stop came to, and writes it after every stop is answered", () => {
  it("a run the engine answered 'not running' is said and logged as not running -- never stopped, never accepted", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    const { testId } = await scanned(fx);
    const t = (await storage.getTest(testId))!;
    const ended = await storage.createTest({ clientId: t.clientId, testType: "vulnerability-scan", status: "running",
      findings: { runId: "r3-ended-run", target: "https://offline.invalid/", results: [] } });
    eng.abortByRun.set("r3-ended-run", abortsOf(fx)[1]);
    eng.abort = abortsOf(fx)[0];
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    const scans = engaged.body.stops.scans as Array<{ testId: string; stopped: boolean; alreadyFinished?: boolean }>;
    expect(scans.some((one) => one.stopped && one.alreadyFinished)).toBe(false);
    expect(scans.find((one) => one.testId === ended.id)).toMatchObject({ stopped: false, alreadyFinished: true });
    const log = (await storage.getActivityLogsByEntity("test", ended.id))[0];
    expect(log.action).toBe("abort_not_needed");
    const switchLogs = (await storage.getAllActivityLogs())
      .filter((one) => one.entityType === "ai_control" && (one.details as { stops?: unknown } | null)?.stops)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    const counted = (switchLogs[0].details as { stops: { sent: number; accepted: number; notRunning?: number } }).stops;
    expect(counted.notRunning).toBe(1);
    expect(counted.accepted).toBe(counted.sent - 1);
    await admin.patch("/api/ai-control").send(REACTIVATE);
  });

  it("a watch's note that its stop was accepted is written, and one that could not be is counted in writeFailures", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    await sleep(100);
    eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    expect(engaged.status).toBe(200);
    expect(watcher.peek(runId)?.stopAcceptedAt).toBeInstanceOf(Date);
    expect((await storage.getRetestWatch(runId))?.stopAcceptedAt).toBeInstanceOf(Date);
    await admin.patch("/api/ai-control").send(REACTIVATE);

    const fx2 = load(PR71, "at-once-then-verdict");
    const second = await scanned(fx2);
    eng.statusReads = [statusReadsOf(fx2)[0]];
    const runId2 = (await admin.post(`/api/tests/${second.testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    await sleep(100);
    vi.spyOn(storage, "updateRunningRetestWatch").mockRejectedValue(new Error("database is locked"));
    const again = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    vi.restoreAllMocks();
    expect(again.status).toBe(200);
    expect(again.body.writeFailures).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`stop of retest run ${runId2} could not be written`))]));
    await admin.patch("/api/ai-control").send(REACTIVATE);
  });

  it("a retest's Stop the engine answered 'not running' notes no accepted stop on the watch", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    eng.abort = abortsOf(fx)[1];
    const stop = await admin.post(`/api/retests/${runId}/abort`);
    expect(stop.body).toMatchObject({ stopped: false, alreadyFinished: true });
    await sleep(50);
    expect(watcher.peek(runId)?.stopAcceptedAt ?? null).toBeNull();
    expect((await storage.getRetestWatch(runId))?.stopAcceptedAt ?? null).toBeNull();
  });

  it("no record of a stop is written before every stop has been answered", async () => {
    const quickRun = "r3-quick-run";
    const slowRun = "r3-slow-run";
    await runningTest(quickRun);
    await runningTest(slowRun);
    eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
    let slowAnswered = 0;
    eng.abortHold.set(slowRun, sleep(300).then(() => { slowAnswered = performance.now(); }));
    const writes: number[] = [];
    const real = storage.createActivityLog.bind(storage);
    vi.spyOn(storage, "createActivityLog").mockImplementation(async (log) => { writes.push(performance.now()); return real(log); });
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    vi.restoreAllMocks();
    expect(engaged.status).toBe(200);
    expect(aborts()).toEqual(expect.arrayContaining([`POST /api/scans/${quickRun}/abort`, `POST /api/scans/${slowRun}/abort`]));
    expect(slowAnswered).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
    expect(Math.min(...writes)).toBeGreaterThanOrEqual(slowAnswered);
    await admin.patch("/api/ai-control").send(REACTIVATE);
  });
});
