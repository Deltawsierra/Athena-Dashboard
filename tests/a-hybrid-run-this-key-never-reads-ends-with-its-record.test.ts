import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

/**
 * A scan started through Athena-Backend whose run this dashboard's engine key
 * can never read -- the engine answers every direct read 404, as it scopes a
 * run to the tenant of the key that launched it (owner decision 7) -- was a
 * dead end: the live poll caught the 404 and answered the row's status,
 * "running", writing nothing; the collect watch started only on a read that saw
 * the run END on the engine, which this key never could; and the adoption sync
 * passed over every known row. The row read "running" for ever, the backend's
 * record of the finished run standing unread beside it.
 *
 * Now the row ends with its record, and only with its record:
 *
 *   - one 404 starts nothing (an engine that restarted, a registry not yet
 *     caught up); once the 404 stands (server/routes.ts notKnown, shortened
 *     here), the collect watch starts FOR THAT REASON (`run_not_readable`,
 *     logged `collect_watch_started_run_not_readable`), and only once;
 *   - Athena-Backend, whose key launched the run, answers pending while the run
 *     goes on: the row stays running, never a verdict;
 *   - the record's end is filed into the row through the one path
 *     (fileRecordIntoRow), its status spelled by server/backend-adoption.ts
 *     STATUS_HERE (completed; stopped as aborted; failed), completedAt the
 *     record's, its results and counts the record's -- and the engine never
 *     once answered this key 200;
 *   - a row a direct read already ended keeps the engine's own word;
 *   - the adoption sync is the backstop: a known row still unfinished here whose
 *     record the backend lists as ended is ended from the record's detail,
 *     counted as `endedFromRecord`, logged `ended_from_backend_record`; a
 *     detail it could not read ends nothing until the next sync.
 *
 * No status is ever written by a 404: nothing here invents an end. Nothing here
 * is on a stop's path.
 */

const TOKEN = "d".repeat(64);

/** A run's results as the engine sends them: readable rows (server/routes.ts isResultRow), one rated high. */
const RESULTS = [
  { type: "sql_injection", severity: "high", url: "https://unread.example/login", message: "the login form reflected a quoted parameter into a query error", details: "parameter: user" },
  { type: "missing_header", severity: "low", url: "https://unread.example/", message: "no Content-Security-Policy header", details: null },
];

const COVERAGE = {
  complete: false,
  checks: [
    { check: "sql_injection", team: "web", state: "performed", probes_attempted: 12, probes_failed: 0 },
    { check: "ssrf", team: "web", state: "not_performed", reason: "not_selected", detail: "not in the selected profile" },
  ],
  not_performed: ["ssrf"], degraded: [], unmeasured: [], limitations: {}, notes: [],
};

type Run = { state: string; result: Record<string, unknown> | null; reason: string | null };
type Call = { method: string; url: string; key: string | null; status: number };

/**
 * An engine whose runs stay running until finished by the test. `tenantBound`
 * answers every read by the dashboard's key 404 "No such scan run"; the
 * backend's key reads the run as it is. Every call is kept with the key that
 * made it and the status it was answered.
 */
function stubEngine() {
  const calls: Call[] = [];
  const runs = new Map<string, Run>();
  const control = { tenantBound: false };
  let next = 0;
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      const url = req.url ?? "";
      const key = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : null;
      const call: Call = { method: req.method ?? "GET", url, key, status: 0 };
      calls.push(call);
      const json = (code: number, body: unknown) => {
        call.status = code;
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url === "/health") return json(200, { status: "ok" });
      if (url === "/api/scans/active") {
        const active = Array.from(runs).filter(([, run]) => run.state === "running").map(([run_id]) => ({ run_id, target: "", kind: "scan", state: "running" }));
        return json(200, { active });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        const run = runs.get(abort[1]);
        if (!run) return json(404, { detail: "No such scan run" });
        if (run.state === "running") Object.assign(run, { state: "aborted", reason: "aborted by operator", result: { results: [], detail: "aborted by operator" } });
        return json(200, { run_id: abort[1], state: "aborting" });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = decodeURIComponent(url.slice("/api/scans/".length));
        const run = runs.get(id);
        if (!run || (control.tenantBound && key === "dashboard-key")) return json(404, { detail: "No such scan run" });
        return json(200, { run_id: id, state: run.state, done: run.state !== "running", result: run.result ?? {}, ...(run.reason ? { reason: run.reason } : {}) });
      }
      if (req.method === "POST" && url === "/api/scan") {
        next += 1;
        const id = `run-${next}`;
        runs.set(id, { state: "running", result: null, reason: null });
        return json(202, { run_id: id, state: "running" });
      }
      return json(404, { detail: "Not Found" });
    });
  });
  return {
    server, calls, runs, control,
    finish(id: string, end: { state: string; result: Record<string, unknown>; reason?: string }): void {
      runs.set(id, { state: end.state, result: end.result, reason: end.reason ?? null });
    },
    /** Every direct read of `runId` by this dashboard's key, with the status it was answered. */
    dashboardReads: (runId: string) => calls.filter((one) => one.method === "GET" && one.url === `/api/scans/${runId}` && one.key === "dashboard-key"),
  };
}

let engine: ReturnType<typeof stubEngine>;
let hybrid: HybridBackendStandIn;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let storage: typeof import("../server/storage-unified").storage;
let adoption: typeof import("../server/backend-adoption");
let clientCount = 0;

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  const engineUrl = `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_URL = engineUrl;
  process.env.ATHENA_ENGINE_KEY = "dashboard-key";
  hybrid = await hybridBackendStandIn({ engine: { url: engineUrl, key: "backend-key" }, serviceToken: TOKEN });
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = TOKEN;
  vi.resetModules();
  app = await makeApp();
  // The backend is asked often, so a case waits little; the 404 stands on a
  // row's second read with no floor, so a case reads twice. Nothing else is
  // shortened.
  (await import("../server/collect-watch")).collectWatch.intervalMs = 25;
  const routes = (await import("../server/routes")) as { notKnown?: { reads: number; floorMs: number } };
  if (routes.notKnown) Object.assign(routes.notKnown, { reads: 2, floorMs: 0 });
  adoption = await import("../server/backend-adoption");
  adoption.adoption.minIntervalMs = 0;
  admin = await signIn(app);
  await signInToBackend(admin);
  storage = (await import("../server/storage-unified")).storage;
});

afterEach(() => {
  engine.calls.length = 0;
  engine.control.tenantBound = false;
  hybrid.seen.length = 0;
  hybrid.controls.failNextScanDetail = null;
  hybrid.releaseCollects();
  adoption._resetAdoptionForTests();
});

afterAll(async () => {
  for (const name of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_SERVICE_TOKEN"]) delete process.env[name];
  (app.locals.collectWatcher as { halt(): void }).halt();
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
  await hybrid.close();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
});

async function aClient(host = "unread.example") {
  clientCount += 1;
  const client = await admin.post("/api/clients").send({ name: `Client ${clientCount}`, company: `Company ${clientCount}`, email: `c${clientCount}@x.test` });
  await admin.post("/api/sites").send({ clientId: client.body.id, name: host, url: `https://${host}` });
  return client.body.id as string;
}

/** A scan started through the backend, running on the stub. */
async function aRunningScan() {
  const clientId = await aClient();
  const started = await admin.post("/api/scans").send({ clientId, target: "https://unread.example/login", consent: true });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return {
    clientId,
    testId: started.body.test.id as string,
    runId: started.body.runId as string,
    scanId: started.body.test.findings.backendScanId as string,
    body: started.body,
  };
}

const read = async (testId: string) => (await admin.get(`/api/scans/${testId}`)).body;

/** The status answer once `ok` holds, asked up to `tries` times, a short pause apart. */
async function readUntil(testId: string, ok: (body: any) => boolean, tries = 200): Promise<any> {
  let body = await read(testId);
  for (let i = 0; i < tries && !ok(body); i++) {
    await new Promise((r) => setTimeout(r, 20));
    body = await read(testId);
  }
  return body;
}

const collectsOf = (scanId: string) => hybrid.collects().filter((one) => one.path === `/api/pentest/scans/${scanId}/collect/`);

const logsOf = async (action: string, testId: string) =>
  ((await admin.get("/api/logs")).body as Array<{ action: string; entityId: string; details: Record<string, unknown> }>)
    .filter((one) => one.action === action && one.entityId === testId);

/** The admin's own bearer token at the stand-in, for what the backend's own collector does. */
async function aBearer(): Promise<string> {
  const signedIn = await fetch(`${hybrid.url}/api/token/`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: TEST_ADMIN_PASSWORD }),
  });
  return ((await signedIn.json()) as { access: string }).access;
}

/** The backend's own collector collects a finished run into its record: no watch here, no read by this dashboard. */
async function collectedAtBackend(scanId: string): Promise<void> {
  const answer = await fetch(`${hybrid.url}/api/pentest/scans/${scanId}/collect/`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await aBearer()}` }, body: "{}",
  });
  expect(answer.status).toBe(200);
}

const adopt = () => admin.post("/api/record/adopt");

describe("a hybrid run this dashboard's key never reads (decision 7)", () => {
  it("asks for nothing on the first 404; once the 404 stands its record is asked for, pending while the run goes on, and the record's end ends the row -- no direct read ever answered 200", async () => {
    engine.control.tenantBound = true;
    const { clientId, testId, runId, scanId, body } = await aRunningScan();
    expect(body.stop).toBe("backend");

    // One 404 starts nothing, and writes nothing.
    const first = await read(testId);
    expect(first.state).toBe("running");
    expect(first.engine).toBeNull();
    expect(first.stop).toBe("backend");
    expect(first.backend).toMatchObject({ scanId, collected: null, watch: null, status: null, verdict: null });
    expect(collectsOf(scanId)).toEqual([]);

    // The 404 stands: the watch starts for that reason, and no status is written.
    const second = await read(testId);
    expect(second.state, "a 404 writes no status").toBe("running");
    expect(second.stop).toBe("backend");
    expect(second.backend).toMatchObject({ scanId, collected: false, watch: "running", status: "pending", verdict: null, verdictLabel: null, pdfUrl: null });
    await vi.waitFor(async () => expect(await logsOf("collect_watch_started_run_not_readable", testId)).toHaveLength(1));
    const started = await logsOf("collect_watch_started_run_not_readable", testId);
    expect(started[0].details).toMatchObject({
      backendScanId: scanId, engineRunId: runId, filedBy: "status_route", reads: 2, said: expect.stringContaining("No such scan run"),
    });

    // The backend, whose key launched the run, reads it still going: pending, never a verdict, the row still running.
    const asked = await readUntil(testId, (one) => one.backend?.lastAnswer === "pending");
    expect(asked.backend).toMatchObject({ collected: false, watch: "running", status: "pending", lastAnswer: "pending", verdict: null });
    expect(collectsOf(scanId).map((one) => one.status)).toContain(202);
    expect(collectsOf(scanId).every((one) => one.account === "admin" && one.by === "bearer" && one.stop === false)).toBe(true);
    expect((await storage.getTest(testId))!.status).toBe("running");
    // A scan already watched is not watched twice: more reads start no second watch.
    await read(testId);
    await read(testId);
    expect(await logsOf("collect_watch_started_run_not_readable", testId)).toHaveLength(1);

    // The run ends on the engine. Only the backend's key sees it.
    engine.finish(runId, { state: "completed", result: { run_id: runId, results: RESULTS, coverage: COVERAGE } });
    const ended = await readUntil(testId, (one) => one.state === "completed");
    const record = hybrid.scans.get(scanId)!;
    expect(record.status).toBe("completed");
    expect(ended.state).toBe("completed");
    expect(ended.test.status).toBe("completed");
    expect(new Date(ended.test.completedAt).toISOString()).toBe(new Date(record.collected_at!).toISOString());
    expect(ended.backend).toMatchObject({
      scanId, collected: true, watch: "collected", status: "completed", verdict: record.verdict,
      collectedAt: record.collected_at, pdfUrl: `/api/scans/${testId}/backend-pdf`, engineRunId: runId,
    });
    expect(ended.backend.verdict).not.toBeNull();
    // The answer is the RECORD's: its results, its counts.
    expect(ended.engine.detail).toBe("the findings in the Athena-Backend record of this scan");
    expect(ended.engine.findings).toEqual(RESULTS);
    expect(ended.test).toMatchObject({ highCount: 1, lowCount: 1, vulnerabilitiesFound: 2, severity: "high" });

    // This key never read the run: every direct read it sent was answered 404.
    const direct = engine.dashboardReads(runId);
    expect(direct.length).toBeGreaterThanOrEqual(2);
    expect(direct.every((one) => one.status === 404)).toBe(true);
    // Filed once by the watch, and never into this dashboard's own ledger.
    expect(await logsOf("backend_record_collected", testId)).toHaveLength(1);
    expect(await storage.getFindingsByClient(clientId)).toEqual([]);
    // Ended, the row is read from the record: the engine is asked nothing more.
    engine.calls.length = 0;
    expect((await read(testId)).state).toBe("completed");
    expect(engine.dashboardReads(runId)).toEqual([]);
  });

  it.each([
    { engineState: "aborted", result: { results: [], detail: "aborted by operator" }, reason: "aborted by operator", recordStatus: "stopped", here: "aborted" },
    { engineState: "failed", result: { results: [], error: "the target refused every connection" }, reason: "the target refused every connection", recordStatus: "failed", here: "failed" },
  ])("a run that ended $engineState while this key never read it: the record says $recordStatus, the row ends $here here, and no verdict is derived", async ({ engineState, result, reason, recordStatus, here }) => {
    engine.control.tenantBound = true;
    const { testId, runId, scanId } = await aRunningScan();
    await read(testId);
    expect((await read(testId)).backend).toMatchObject({ collected: false, watch: "running" });

    engine.finish(runId, { state: engineState, result, reason });
    const ended = await readUntil(testId, (one) => one.state === here);
    expect(ended.state).toBe(here);
    expect(ended.test.status).toBe(here);
    expect(ended.test.completedAt).not.toBeNull();
    expect(ended.backend).toMatchObject({ collected: true, status: recordStatus, verdict: null, verdictLabel: null, pdfUrl: null });
    expect(hybrid.scans.get(scanId)!.status).toBe(recordStatus);
    expect(engine.dashboardReads(runId).every((one) => one.status === 404)).toBe(true);
  });
});

describe("a row a direct read already ended", () => {
  // A guard on the head's new status write: green on the base too, by design.
  it("keeps the engine's own word: the record's end goes into the snapshot beside it, never over the status", async () => {
    const { testId, runId, scanId } = await aRunningScan();
    // The collect is held, so the record can be changed under the watch before it reads it.
    hybrid.holdCollects();
    engine.finish(runId, { state: "completed", result: { results: RESULTS, coverage: COVERAGE } });
    const finished = await read(testId);
    expect(finished.state).toBe("completed");
    expect(finished.backend).toMatchObject({ collected: false, watch: "running" });
    // Another hand ended the record as stopped before the watch collected it.
    const record = hybrid.scans.get(scanId)!;
    record.status = "stopped";
    record.error_message = "Stopped on the engine: by another hand";
    record.collected_at = new Date().toISOString();
    hybrid.releaseCollects();

    const ended = await readUntil(testId, (one) => one.backend?.collected === true);
    expect(ended.backend).toMatchObject({ collected: true, status: "stopped", detail: "Stopped on the engine: by another hand" });
    expect(ended.state).toBe("completed");
    expect(ended.test.status).toBe("completed");
    expect((await storage.getTest(testId))!.status).toBe("completed");
  });
});

describe("the adoption sync is the backstop", () => {
  it("ends a known row still unfinished here whose record the backend's own collector ended -- no watch, no direct read -- counts it as endedFromRecord, and ends nothing twice", async () => {
    engine.control.tenantBound = true;
    const { clientId, testId, runId, scanId } = await aRunningScan();
    // Nothing reads the row: no watch starts. The run ends and the backend's own collector records it.
    engine.finish(runId, { state: "completed", result: { results: RESULTS, coverage: COVERAGE } });
    await collectedAtBackend(scanId);
    expect((await storage.getTest(testId))!.status).toBe("running");
    expect(await storage.getCollectWatch(scanId)).toBeUndefined();
    hybrid.seen.length = 0;

    const synced = await adopt();
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(synced.body).toMatchObject({ throttled: false, endedFromRecord: 1, adopted: [], detailUnread: [], writeFailed: null });
    expect(synced.body.alreadyRecorded).toBeGreaterThanOrEqual(1);
    // The detail was read as the person, once, for this row alone.
    expect(hybrid.seen.filter((one) => one.method === "GET" && one.path === `/api/pentest/scans/${scanId}/`).map((one) => one.account)).toEqual(["admin"]);

    const record = hybrid.scans.get(scanId)!;
    const row = (await storage.getTest(testId))!;
    expect(row.status).toBe("completed");
    expect(row.completedAt).toEqual(new Date(record.collected_at!));
    expect(row).toMatchObject({ highCount: 1, lowCount: 1, vulnerabilitiesFound: 2, severity: "high" });
    expect(row.findings).toMatchObject({ backend: { status: "completed", verdict: record.verdict, collectedAt: record.collected_at } });
    const logs = await logsOf("ended_from_backend_record", testId);
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toMatchObject({
      backendScanId: scanId, engineRunId: runId, recordStatus: "completed", status: "completed", statusBefore: "running", filedBy: "record_sync",
    });

    // Read from the record from now on, the engine asked nothing; never into this dashboard's ledger.
    engine.calls.length = 0;
    const answered = await read(testId);
    expect(answered.state).toBe("completed");
    expect(answered.backend).toMatchObject({ collected: true, status: "completed", verdict: record.verdict });
    expect(answered.engine.findings).toEqual(RESULTS);
    expect(engine.dashboardReads(runId)).toEqual([]);
    expect(await storage.getFindingsByClient(clientId)).toEqual([]);

    // Once is once.
    const again = await adopt();
    expect(again.status).toBe(200);
    expect(again.body.endedFromRecord).toBe(0);
    expect(await logsOf("ended_from_backend_record", testId)).toHaveLength(1);
  });

  it("a record the list says ended whose detail could not be read ends nothing, is said on the console and not as the adoption's, and the next sync ends it", async () => {
    engine.control.tenantBound = true;
    const { testId, runId, scanId } = await aRunningScan();
    engine.finish(runId, { state: "aborted", result: { results: [], detail: "aborted by operator" }, reason: "aborted by operator" });
    await collectedAtBackend(scanId);
    expect(hybrid.scans.get(scanId)!.status).toBe("stopped");

    hybrid.controls.failNextScanDetail = { status: 500, body: { detail: "the scans table is locked" } };
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unread = await adopt();
    expect(unread.status).toBe(200);
    // detailUnread is the adoption's own (scans to adopt): it keeps that meaning.
    expect(unread.body).toMatchObject({ endedFromRecord: 0, adopted: [], detailUnread: [] });
    expect(warned.mock.calls.some(([line]) => String(line).includes(scanId) && String(line).includes("the scans table is locked"))).toBe(true);
    warned.mockRestore();
    expect((await storage.getTest(testId))!.status, "nothing is written from a detail that was not read").toBe("running");

    const next = await adopt();
    expect(next.body).toMatchObject({ endedFromRecord: 1, detailUnread: [] });
    const row = (await storage.getTest(testId))!;
    expect(row.status).toBe("aborted");
    expect(row.findings).toMatchObject({ backend: { status: "stopped", verdict: null, detail: "Stopped on the engine: aborted by operator" } });
    expect((await logsOf("ended_from_backend_record", testId))[0].details).toMatchObject({ recordStatus: "stopped", status: "aborted", statusBefore: "running" });
  });
});
