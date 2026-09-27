import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import request from "supertest";
import type { Express } from "express";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

/**
 * Round two of athena-engine PR 71's dashboard half: every Stop goes to the
 * engine before any storage read or write, no retest verdict is lost at a
 * 202 or a deadline, and nothing the engine did not say is read as a verdict.
 *
 * Engine answers are the recorded fixtures (tests/fixtures/engine-retest),
 * from athena-engine 143279e and 5779e99. Where a case needs an answer no
 * recording holds -- a 202 whose state already reads `completed`, which #71
 * answers only when a run ends between its wait and its answer -- it is a
 * recorded body with one field changed, and the case says which.
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
  statusHold: Promise<void> | null;
  active: Reply;
  abort: Reply;
} = {
  fixture: null, retest: null, retestHold: null, statusReads: [], statusFail: 0, statusHold: null,
  active: { status: 200, body: { active: [] } }, abort: { status: 200, body: {} },
};
const calls: Array<{ line: string; at: number; body: Record<string, unknown> }> = [];
let engine: Server;
let app: Express;
let admin: ReturnType<typeof request.agent>;
let analyst: ReturnType<typeof request.agent>;
let storage: import("../server/storage").IStorage;
let retests: typeof import("../server/retests");
let watcher: import("../server/retests").RetestWatcher;
let adminId: string;

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      const url = req.url ?? "";
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      calls.push({ line: `${req.method} ${url}`, at: performance.now(), body });
      const fx = eng.fixture;
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") return json(res, eng.active.status, eng.active.body);
      if (req.method === "POST" && /\/abort$/.test(url)) return json(res, eng.abort.status, eng.abort.body);
      if (!fx) return json(res, 500, { detail: "no fixture" });
      if (req.method === "POST" && url === "/api/scan") return json(res, fx.exchanges[0].status, fx.exchanges[0].body);
      if (req.method === "GET" && url.startsWith("/api/decisions?")) return json(res, fx.exchanges[1].status, fx.exchanges[1].body);
      if (req.method === "POST" && url === "/api/remediation/retest") {
        if (eng.retestHold) await eng.retestHold;
        if (fx.engine.contract === "main" && body.wait_seconds !== undefined) {
          const refused = retestOf(load(MAIN, "wait-seconds-refused"));
          return json(res, refused.status, refused.body);
        }
        const answer = eng.retest ?? retestOf(fx);
        return json(res, answer.status, answer.body);
      }
      if (req.method === "GET" && /^\/api\/scans\/[^/]+$/.test(url)) {
        if (eng.statusHold) await eng.statusHold;
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
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  app = createApp();
  await initializeDefaultData();
  admin = request.agent(app);
  const login = await admin.post("/api/auth/login").send({ username: "admin", password: "admin123" });
  expect(login.status).toBe(200);
  adminId = (await admin.get("/api/auth/check")).body.user.id;
  expect((await admin.post("/api/users").send({ username: "analyst2", password: "analyst-password", role: "user", email: "a2@a.test" })).status).toBe(201);
  analyst = request.agent(app);
  expect((await analyst.post("/api/auth/login").send({ username: "analyst2", password: "analyst-password" })).status).toBe(200);
  storage = (await import("../server/storage-unified")).storage;
  retests = await import("../server/retests");
  watcher = app.locals.retestWatcher;
  retests.retestWatch.intervalMs = 25;
  retests.retestWatch.totalMs = 60_000;
});

afterAll(async () => {
  watcher.halt();
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  engine.closeAllConnections?.();
  await new Promise<void>((r) => engine.close(() => r()));
});

beforeEach(() => {
  Object.assign(eng, {
    fixture: null, retest: null, retestHold: null, statusReads: [], statusFail: 0, statusHold: null,
    active: { status: 200, body: { active: [] } }, abort: { status: 200, body: {} },
  });
  calls.length = 0;
  vi.restoreAllMocks();
  // The fixtures' run ids repeat across cases, which a real engine's never do.
  watcher.reset();
  (storage as unknown as { retestWatches: Map<string, unknown> }).retestWatches.clear();
  // ...and a check per engine run is unique: the last case's check of this run id is not this one's.
  (storage as unknown as { checks: unknown[] }).checks.length = 0;
  retests.retestWatch.totalMs = 60_000;
});

let n = 0;
async function scanned(fx: Fixture, as = admin) {
  eng.fixture = fx;
  n += 1;
  const client = await admin.post("/api/clients").send({ name: `Round2 ${n}`, company: "R", email: `r${n}@r.test` });
  const site = await admin.post("/api/sites").send({ clientId: client.body.id, name: "Main", url: "https://offline.invalid" });
  const started = await as.post("/api/scans").send({ clientId: client.body.id, siteId: site.body.id, target: fx.exchanges[0].body.target });
  expect(started.status).toBe(201);
  const findings = await storage.getFindingsByClient(client.body.id);
  expect(findings).toHaveLength(1);
  return { testId: started.body.test.id as string, twinId: fx.exchanges[1].body.decisions[0].id as number, finding: findings[0] };
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
const view = (runId: string) => admin.get(`/api/retests/${runId}`).then((r) => r.body);
const reached = (line: string) => calls.find((one) => one.line === line);

describe("every Stop goes to the engine before any storage read or write", () => {
  const slow = (ms: number) => () => new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("storage stalled")), ms));

  it("the signed-in user is not read from storage first: a stalled and a failing account read hold back no Stop", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    const res = await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 });
    const runId = res.body.engineRunId as string;
    eng.abort = abortsOf(fx)[0];
    const getUser = vi.spyOn(storage, "getUser").mockImplementation(slow(3_000));
    // The scan Stop finds its test in memory: a stalled test read holds it back no more than the account read.
    vi.spyOn(storage, "getTest").mockImplementation(slow(3_000));

    for (const [what, send] of [
      ["retest Stop", () => admin.post(`/api/retests/${runId}/abort`)],
      ["scan Stop", () => admin.post(`/api/scans/${testId}/abort`)],
    ] as const) {
      calls.length = 0;
      const pressed = performance.now();
      const answer = await send();
      expect(answer.status, what).toBe(200);
      const abort = calls.find((one) => one.line.endsWith("/abort"));
      expect(abort, what).toBeDefined();
      expect(abort!.at - pressed, what).toBeLessThan(250);
    }
    getUser.mockRejectedValue(new Error("no such table: users"));
    calls.length = 0;
    const pressed = performance.now();
    expect((await admin.post(`/api/retests/${runId}/abort`)).status).toBe(200);
    expect(reached(`POST /api/scans/${runId}/abort`)!.at - pressed).toBeLessThan(250);
    expect(getUser).not.toHaveBeenCalled();
  });

  it("the kill switch is authorised from the session: a stalled account read holds back none of its stops", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    await scanned(fx);
    const listed = activeOf(fx);
    eng.active = listed;
    eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
    vi.spyOn(storage, "getUser").mockImplementation(slow(3_000));
    calls.length = 0;
    const pressed = performance.now();
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    try {
      expect(engaged.status).toBe(200);
      expect(reached(`POST /api/scans/${listed.body.active[0].run_id}/abort`)!.at - pressed).toBeLessThan(250);
    } finally {
      vi.restoreAllMocks();
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "operational" });
    }
  });

  it("the record of a Stop is written after the stop is sent and answered: a stalled log write delays neither", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    eng.abort = abortsOf(fx)[0];
    vi.spyOn(storage, "createActivityLog").mockImplementation(slow(2_000));
    for (const url of [`/api/retests/${runId}/abort`, `/api/scans/${testId}/abort`]) {
      calls.length = 0;
      const pressed = performance.now();
      const answer = await admin.post(url);
      const answeredAt = performance.now() - pressed;
      expect(answer.status, url).toBe(200);
      expect(calls.find((one) => one.line.endsWith("/abort"))!.at - pressed, url).toBeLessThan(250);
      expect(answeredAt, url).toBeLessThan(500);
    }
  });

  it("the 202 that carries the Stop's run id is answered before the watch's row and the log are written", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    vi.spyOn(storage, "createRetestWatch").mockImplementation(slow(3_000));
    vi.spyOn(storage, "createActivityLog").mockImplementation(slow(3_000));
    const pressed = performance.now();
    const res = await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 });
    expect(res.status).toBe(202);
    expect(res.body.engineRunId).toBe(retestOf(fx).body.run_id);
    expect(performance.now() - pressed).toBeLessThan(1_000);
  });

  it("a Stop the engine refused is said, never reported as stopped", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    eng.abort = { status: 500, body: { detail: "the registry is unavailable" } };
    const stop = await admin.post(`/api/retests/${runId}/abort`);
    expect(stop.status).toBe(502);
    expect(stop.body.error).toMatch(/did not accept the stop/);
    expect((await view(runId)).stopAcceptedAt).toBeNull();
  });

  it("a Stop on a run that had already ended is answered and logged as already finished, never as aborted", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    const [, notRunning] = abortsOf(fx);
    expect(notRunning.body.detail).toBe("not running");
    eng.abort = notRunning;
    const before = ((await admin.get("/api/logs")).body as unknown[]).length;
    const stop = await admin.post(`/api/retests/${runId}/abort`);
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ stopped: false, alreadyFinished: true, runId });
    const scanStop = await admin.post(`/api/scans/${testId}/abort`);
    expect(scanStop.body).toMatchObject({ stopped: false, alreadyFinished: true });
    await sleep(50);
    const logs = (await admin.get("/api/logs")).body as Array<{ action: string; details: { runId?: string } }>;
    // Newest first: the entries these two Stops wrote.
    const mine = logs.slice(0, logs.length - before).filter((one) => one.details?.runId !== undefined);
    expect(mine).toHaveLength(2);
    expect(mine.map((one) => one.action)).toContain("abort_not_needed");
    expect(mine.map((one) => one.action)).not.toContain("aborted");
  });

  it("a retest's Stop needs an admin or the retest's owner, decided from memory; anyone else is refused and nothing is sent", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    eng.abort = abortsOf(fx)[0];
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    calls.length = 0;
    const refused = await analyst.post(`/api/retests/${runId}/abort`);
    expect(refused.status).toBe(403);
    const unknown = await analyst.post("/api/retests/some-other-dashboards-run/abort");
    expect(unknown.status).toBe(403);
    expect(calls.filter((one) => one.line.endsWith("/abort"))).toEqual([]);
    // The owner, and an admin.
    const own = await scanned(fx, analyst);
    watcher.reset();
    (storage as unknown as { retestWatches: Map<string, unknown> }).retestWatches.clear();
    const mine = (await analyst.post(`/api/tests/${own.testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    expect((await analyst.post(`/api/retests/${mine}/abort`)).status).toBe(200);
    expect((await admin.post(`/api/retests/${mine}/abort`)).status).toBe(200);
    expect(adminId).toBeTruthy();
  });
});

describe("a retest verdict is never lost, and never invented", () => {
  it("#71 is asked with wait_seconds: 0, answers 202 in state queued at once, and the watch files its verdict", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const accepted = retestOf(fx);
    expect([accepted.status, accepted.body.state, accepted.request.body?.wait_seconds]).toEqual([202, "queued", 0]);
    const { testId, finding } = await scanned(fx);
    eng.statusReads = statusReadsOf(fx);
    const res = await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 });
    expect(res.status).toBe(202);
    expect(calls.filter((one) => one.line === "POST /api/remediation/retest").map((one) => one.body.wait_seconds)).toEqual([0]);
    const ended = await until(() => view(accepted.body.run_id), (body) => body.phase !== "running");
    expect(ended).toMatchObject({ phase: "verdict", stoppable: false });
    const checks = await storage.getChecks(finding.id);
    expect(checks.map((one) => [one.verdict, one.runId])).toEqual([["closed", String(statusReadsOf(fx)[1].body.result.scan_record_id)]]);
  });

  it("a 202 whose state already reads completed (derived: at-once-then-verdict's 202 with state completed) is read at once, and its verdict filed", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const accepted = retestOf(fx);
    const { testId, finding } = await scanned(fx);
    eng.retest = { status: 202, body: { ...accepted.body, state: "completed" } };
    eng.statusReads = [statusReadsOf(fx)[1]];
    const res = await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 });
    expect(res.status).toBe(202);
    expect(res.body.phase).toBe("running");
    await until(() => storage.getChecks(finding.id), (checks) => checks.length > 0);
    expect((await storage.getChecks(finding.id)).map((one) => one.verdict)).toEqual(["closed"]);
  });

  it("a watch past its deadline reads once more: a verdict the engine already has is filed, not called unwatched", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId, finding } = await scanned(fx);
    eng.statusHold = new Promise(() => undefined);
    retests.retestWatch.totalMs = 1;
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    // The dashboard goes away with its read unanswered (held for good); the
    // engine finishes while nothing is reading it, and a dashboard starting up
    // resumes the watch past its deadline.
    await until(async () => calls.filter((one) => one.line === `GET /api/scans/${runId}`).length, (count) => count === 1);
    watcher.reset();
    eng.statusHold = null;
    eng.statusReads = [statusReadsOf(fx)[1]];
    calls.length = 0;
    watcher.resume();
    const ended = await until(() => storage.getRetestWatch(runId), (row) => row?.state !== "running");
    expect(ended!.state).toBe("verdict");
    expect(calls.filter((one) => one.line === `GET /api/scans/${runId}`)).toHaveLength(1);
    expect((await storage.getChecks(finding.id)).map((one) => one.verdict)).toEqual(["closed"]);
  });

  it("a status read that failed is said, and the watch carries on to the verdict", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId, finding } = await scanned(fx);
    eng.statusFail = 2;
    eng.statusReads = [statusReadsOf(fx)[1]];
    let failedSeen = false;
    eng.statusHold = null;
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    const during = await until(() => view(runId), (body) => {
      if (body.lastReadError) failedSeen = true;
      return body.phase !== "running";
    });
    expect(failedSeen || calls.filter((one) => one.line === `GET /api/scans/${runId}`).length >= 3).toBe(true);
    expect(during.phase).toBe("verdict");
    expect((await storage.getChecks(finding.id))).toHaveLength(1);
  });

  it("a status read that does not say the run is done is no verdict, whatever it carries (derived: done false)", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId, finding } = await scanned(fx);
    const finished = statusReadsOf(fx)[1];
    eng.statusReads = [{ status: 200, body: { ...finished.body, done: false } }];
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    await sleep(300);
    expect((await view(runId)).phase).not.toBe("verdict");
    expect(await storage.getChecks(finding.id)).toEqual([]);
  });

  it("a run the engine accepted a stop for that completes anyway is filed, marked completed despite a stop request", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId, finding } = await scanned(fx);
    let release!: () => void;
    eng.statusHold = new Promise((r) => { release = r; });
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
    expect((await admin.post(`/api/retests/${runId}/abort`)).status).toBe(200);
    eng.statusReads = [statusReadsOf(fx)[1]];
    eng.statusHold = null;
    release();
    const ended = await until(() => view(runId), (body) => body.phase !== "running");
    expect(ended.phase).toBe("verdict");
    expect(ended.result.completedDespiteStop).toBe(true);
    expect(ended.detail).toMatch(/accepted a stop for this retest, but the run completed anyway/);
    const [check] = await storage.getChecks(finding.id);
    expect(check.detail).toMatch(/Completed despite a stop request\.$/);
  });

  it("the inline check's requestedAt is when Retest was pressed, before the engine answered", async () => {
    const fx = load(PR71, "verdict-closed");
    const { testId, finding } = await scanned(fx);
    let release!: () => void;
    eng.retestHold = new Promise((r) => { release = r; });
    const pressedAt = Date.now();
    const pending = admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 }).then((r) => r);
    await sleep(300);
    release();
    expect((await pending).status).toBe(200);
    const [check] = await storage.getChecks(finding.id);
    expect(check.filedVia).toBe("retest_request");
    expect(new Date(check.requestedAt!).getTime()).toBeGreaterThanOrEqual(pressedAt - 5);
    expect(new Date(check.requestedAt!).getTime()).toBeLessThan(pressedAt + 250);
  });

  it("an answer neither contract gives is refused as unrecognised, and nothing is filed from it", async () => {
    const fx = load(PR71, "verdict-closed");
    const { testId, finding } = await scanned(fx);
    const verdict = retestOf(fx).body;
    const { answer: _answer, ...noAnswer } = verdict;
    for (const [what, reply] of [
      ["a 202 with no answer (derived)", { status: 202, body: noAnswer }],
      ["a 201 with scan_record_id and no answer (derived)", { status: 201, body: noAnswer }],
    ] as const) {
      eng.retest = reply;
      const res = await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 });
      expect(res.status, what).toBe(502);
      expect(res.body.error, what).toMatch(/^Unrecognised engine answer/);
    }
    expect(await storage.getChecks(finding.id)).toEqual([]);
  });

  it("the finished watch is dropped from memory; a no-longer-watched one is kept for the kill switch", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    eng.statusReads = statusReadsOf(fx);
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    await until(() => view(runId), (body) => body.phase === "verdict");
    expect(watcher.peek(runId)).toBeUndefined();
    expect(watcher.running().map((one) => one.engineRunId)).not.toContain(runId);
  });
});

describe("one retest at a time, and no more than the engine should hold", () => {
  it("a second retest of a finding while one is running is refused, on this page or any other", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    expect((await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).status).toBe(202);
    calls.length = 0;
    const again = await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 });
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe("retest_running");
    expect(calls.filter((one) => one.line === "POST /api/remediation/retest")).toEqual([]);
    const listed = await admin.get(`/api/tests/${testId}/retests`);
    expect(listed.body.retests.map((one: { phase: string; stoppable: boolean }) => [one.phase, one.stoppable])).toEqual([["running", true]]);
  });

  it("beyond ATHENA_MAX_INFLIGHT_RETESTS retests being asked of the engine at once, the next is refused and never sent", async () => {
    const fx = load(MAIN, "verdict-closed");
    process.env.ATHENA_MAX_INFLIGHT_RETESTS = "2";
    let release!: () => void;
    eng.retestHold = new Promise((r) => { release = r; });
    try {
      const tests = [await scanned(fx), await scanned(fx), await scanned(fx)];
      const pending = tests.slice(0, 2).map((one) => admin.post(`/api/tests/${one.testId}/retest`).send({ twinId: 1 }).then((r) => r));
      await until(async () => calls.filter((one) => one.line === "POST /api/remediation/retest").length, (count) => count >= 2);
      const third = await admin.post(`/api/tests/${tests[2].testId}/retest`).send({ twinId: 1 });
      expect(third.status).toBe(429);
      expect(third.body.reason).toBe("retests_busy");
      expect(calls.filter((one) => one.line === "POST /api/remediation/retest")).toHaveLength(2);
      release();
      for (const one of await Promise.all(pending)) expect(one.status).toBe(200);
    } finally {
      delete process.env.ATHENA_MAX_INFLIGHT_RETESTS;
    }
  });
});

describe("the kill switch", () => {
  it("sends a watched retest the engine also lists exactly one stop", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    eng.active = activeOf(fx);
    eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
    calls.length = 0;
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    try {
      expect(engaged.status).toBe(200);
      expect(calls.filter((one) => one.line === `POST /api/scans/${runId}/abort`)).toHaveLength(1);
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "operational" });
    }
  });

  it("after a restart, a watch that ended no longer watched is still sent a stop by id when the engine's list cannot be read", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    eng.statusReads = [statusReadsOf(fx)[0]];
    retests.retestWatch.totalMs = 1;
    const runId = (await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).body.engineRunId as string;
    await until(async () => (await storage.getRetestWatch(runId))?.state, (state) => state === "unwatched");
    // A restart: a dashboard that never knew it in memory.
    watcher.reset();
    watcher.resume();
    await sleep(50);
    eng.active = { status: 500, body: { detail: "list unavailable" } };
    eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
    calls.length = 0;
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    try {
      expect(engaged.body.engineRuns.listed).toBe(false);
      expect(calls.map((one) => one.line)).toContain(`POST /api/scans/${runId}/abort`);
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "operational" });
    }
  });

  it("says the records it could not write, after every stop was sent", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    await scanned(fx);
    eng.active = activeOf(fx);
    eng.abort = abortsOf(load(PR71, "at-once-then-stopped"))[0];
    vi.spyOn(storage, "createActivityLog").mockRejectedValue(new Error("database is locked"));
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    vi.restoreAllMocks();
    try {
      expect(engaged.status).toBe(200);
      expect(engaged.body.writeFailures.length).toBeGreaterThan(0);
      expect(engaged.body.writeFailures[0]).toMatch(/could not be written: database is locked/);
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "operational" });
    }
  });
});

describe("one read loop per run", () => {
  it("a watch started again for a run whose earlier read is still in flight never reads it twice: counted, not timed", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const { testId } = await scanned(fx);
    const runId = retestOf(fx).body.run_id as string;
    const reads = () => calls.filter((one) => one.line === `GET /api/scans/${runId}`).length;
    let release!: () => void;
    eng.statusReads = [statusReadsOf(fx)[0]];
    eng.statusHold = new Promise((r) => { release = r; });
    try {
      expect((await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).status).toBe(202);
      await until(async () => reads(), (count) => count === 1);
      // Forgotten and watched again while the first loop's read is still held.
      watcher.reset();
      (storage as unknown as { retestWatches: Map<string, unknown> }).retestWatches.clear();
      expect((await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 1 })).status).toBe(202);
      await until(async () => reads(), (count) => count === 2);
      // Every read from here on is held for good. Both held reads answer
      // "running": the loop that owns the run reads it once more -- one read,
      // held -- and the forgotten loop reads it never again.
      eng.statusHold = new Promise<void>(() => undefined);
      release();
      await until(async () => reads(), (count) => count >= 3);
      await sleep(300);
      expect(reads()).toBe(3);
    } finally {
      eng.statusHold = null;
    }
  });
});
