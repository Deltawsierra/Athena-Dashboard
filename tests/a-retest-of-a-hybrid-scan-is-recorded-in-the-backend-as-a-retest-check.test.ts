import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import { makeApp, recordLegacyScan, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";

/**
 * A retest of a scan started through Athena-Backend (the Option 1 hybrid) has
 * its verdict recorded in the backend as a RETEST CHECK -- pulled by the backend
 * from the engine, never typed in -- and labelled as exactly that (owner
 * decision 8, the dashboard half; server/retest-check-watch.ts):
 *
 *   - AFTER the dashboard's own retest watch has ended with a verdict and filed
 *     what it files itself, the backend is asked, as the person who pressed
 *     Retest, with `{run_id, twin_run_id}` -- the retest run and the scan run
 *     the twin was listed under -- against the finding the record holds for
 *     that scan and type; the outcome is on the retest watch's row
 *     (`result.backend`), the check is in the backend's record under its
 *     finding (and served with it: GET /api/record/clients/:id/findings), and
 *     nothing of the backend's is filed into this dashboard's own ledger;
 *   - a retest of a scan this dashboard recorded directly from the engine has
 *     no backend record to be in: nothing is sent, and the row says so;
 *   - the backend's 404, 409 and 422 are the end, in its own words, asked once
 *     and never retried; its 202 and 503 are asked again within the bound,
 *     "asking" meanwhile and never recorded; a finding the record does not list
 *     yet is asked for again, never invented; the bound reached stops the asking
 *     and says so, never an outcome;
 *   - the kill switch pressed while a collect is held at the backend stops the
 *     running retest first, and the collect's later answer changes nothing
 *     about that; a dashboard that restarts resumes the asking, as nobody until
 *     a person reads the retest.
 *
 * SAFETY: the retest's Stop and the kill switch are untouched by all of this
 * (tests/a-stop-goes-first-and-a-retest-verdict-is-never-lost.test.ts stays as
 * it is); the collect sits after the verdict's filing, off every request path.
 */

const TOKEN = "f".repeat(64);
const HOST = "acme.example";
const TARGET = `https://${HOST}/login`;
const RESULTS = [
  { type: "sql_injection", severity: "high", url: TARGET, message: "the login form reflected a quoted parameter into a query error", details: "parameter: user" },
];
const COVERAGE = { complete: true, checks: [{ check: "sql_injection", team: "web", state: "performed", probes_attempted: 12, probes_failed: 0 }], not_performed: [], degraded: [], unmeasured: [], limitations: {}, notes: [] };
const CHECKED_AT = "2026-10-23T04:30:00+00:00";

type Run = { state: string; result: Record<string, unknown> | null; reason?: string; kind?: string; target?: string };

/** An engine whose runs are what the test sets them to; its two keys (the dashboard's, the backend's) can be told apart. */
function stubEngine() {
  const calls: Array<{ method: string; url: string; apiKey: string | null }> = [];
  const runs = new Map<string, Run>();
  const twins = new Map<string, Array<Record<string, unknown>>>();
  const control = {
    /** The next retest the engine is asked for is answered 202 with this run id, in state running. */
    nextRetestRun: "rt-0",
    /** Runs the BACKEND's key reads as the engine's 404 -- another tenant's -- while the dashboard's key reads them. */
    blindToBackend: new Set<string>(),
    /** Runs the BACKEND's key still reads as running, while the dashboard's key reads them finished. */
    runningForBackend: new Set<string>(),
  };
  let next = 0;
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = req.url ?? "";
      const apiKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : null;
      calls.push({ method: req.method ?? "GET", url, apiKey });
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") {
        const active = Array.from(runs).filter(([, run]) => ["queued", "running", "aborting"].includes(run.state))
          .map(([run_id, run]) => ({ run_id, target: run.target ?? "", kind: run.kind ?? "scan", state: run.state }));
        return json(res, 200, { active });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        const run = runs.get(abort[1]);
        if (!run) return json(res, 404, { detail: "No such scan run" });
        if (run.state === "running") Object.assign(run, { state: "aborted", reason: "aborted by operator", result: { ...(run.result ?? {}), stopped: true } });
        return json(res, 200, { run_id: abort[1], state: "aborting" });
      }
      if (req.method === "GET" && url.startsWith("/api/decisions?")) {
        const runId = new URL(url, "http://engine").searchParams.get("run_id") ?? "";
        return json(res, 200, { tenant: "default", decisions: twins.get(runId) ?? [] });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = decodeURIComponent(url.slice("/api/scans/".length));
        const run = runs.get(id);
        const backend = apiKey === "backend-key"; // pragma: allowlist secret
        if (!run || (backend && control.blindToBackend.has(id))) return json(res, 404, { detail: "No such scan run" });
        if (backend && control.runningForBackend.has(id)) return json(res, 200, { run_id: id, state: "running", done: false, result: {} });
        const done = !["queued", "running", "aborting"].includes(run.state);
        return json(res, 200, { run_id: id, state: run.state, done, result: run.result ?? {}, ...(run.reason ? { reason: run.reason } : {}) });
      }
      if (req.method === "POST" && url === "/api/scan") {
        next += 1;
        const id = `run-${next}`;
        runs.set(id, { state: "running", result: null, kind: "scan", target: String(body.target ?? "") });
        return json(res, 202, { run_id: id, state: "running" });
      }
      if (req.method === "POST" && url === "/api/remediation/retest") {
        const id = control.nextRetestRun;
        runs.set(id, { state: "running", result: null, kind: "retest", target: `https://${HOST}/` });
        return json(res, 202, { answer: "status", run_id: id, state: "running", reason: null, error: null, status_url: `/api/scans/${id}`, detail: "the retest is running; collect it from status_url" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  return {
    server, calls, runs, twins, control,
    finish(id: string, end: Run): void { runs.set(id, end); },
    /** The retest run ends with a verdict on twin 7, as athena-engine #71 records it. */
    verdict(id: string, verdict: string, result: Record<string, unknown> = {}, state = "completed"): void {
      runs.set(id, {
        state, kind: "retest", target: `https://${HOST}/`,
        result: {
          twin_id: 7, verdict, detail: `sql_injection was ${verdict === "closed" ? "not " : ""}reported against https://${HOST}/`, target: `https://${HOST}/`,
          finding_type: "sql_injection", inventory_digest: null, run_id: id, scan_record_id: 702,
          check: { id: 1, twin_id: 7, verdict, run_id: 702, checked_at: CHECKED_AT }, ...result,
        },
        ...(state === "aborted" ? { reason: "stopped by an operator" } : {}),
      });
    },
    aborts: () => calls.filter((one) => one.url.endsWith("/abort")),
  };
}

let engine: ReturnType<typeof stubEngine>;
let hybrid: HybridBackendStandIn;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let adminId: string;
let storage: typeof import("../server/storage-unified").storage;
let checks: import("../server/retest-check-watch").RetestCheckWatcher;
let retestChecks: typeof import("../server/retest-check-watch");
let n = 0;

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  const engineUrl = `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_URL = engineUrl;
  process.env.ATHENA_ENGINE_KEY = "dashboard-key"; // pragma: allowlist secret
  hybrid = await hybridBackendStandIn({ engine: { url: engineUrl, key: "backend-key" }, serviceToken: TOKEN, assurance: true }); // pragma: allowlist secret
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = TOKEN;
  vi.resetModules();
  app = await makeApp();
  // Every watch asks often, so a case waits little; nothing else is shortened.
  (await import("../server/collect-watch")).collectWatch.intervalMs = 25;
  (await import("../server/retests")).retestWatch.intervalMs = 25;
  retestChecks = await import("../server/retest-check-watch");
  retestChecks.retestCheckWatch.intervalMs = 25;
  admin = await signIn(app);
  await signInToBackend(admin);
  adminId = (await admin.get("/api/auth/check")).body.user.id as string;
  storage = (await import("../server/storage-unified")).storage;
  checks = app.locals.retestCheckWatcher;
});

afterEach(() => {
  engine.control.blindToBackend.clear();
  engine.control.runningForBackend.clear();
  hybrid.controls.engineUnreachable = false;
  hybrid.releaseRetestCheckCollects();
  retestChecks.retestCheckWatch.totalMs = 60 * 60_000;
});

afterAll(async () => {
  for (const name of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_SERVICE_TOKEN"]) delete process.env[name];
  (app.locals.retestWatcher as { halt(): void }).halt();
  (app.locals.collectWatcher as { halt(): void }).halt();
  checks.halt();
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
  await hybrid.close();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 6_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(20);
    last = await read();
  }
  return last;
}
const view = async (runId: string) => (await admin.get(`/api/retests/${runId}`)).body;
const standingOf = async (runId: string) => (await view(runId)).result?.backend ?? null;
const collectsFor = (finding: string) => hybrid.retestCheckCollects().filter((one) => one.path === `/api/assurance/findings/${finding}/retest-checks/collect/`);
const logsOf = async (action: string, runId: string) =>
  ((await admin.get("/api/logs")).body as Array<{ action: string; details: Record<string, unknown> }>)
    .filter((one) => one.action === action && one.details.engineRunId === runId);

async function aClient(host = HOST) {
  n += 1;
  const client = await admin.post("/api/clients").send({ name: `Client ${n}`, company: `Company ${n}`, email: `c${n}@x.test` });
  await admin.post("/api/sites").send({ clientId: client.body.id, name: host, url: `https://${host}` });
  return client.body.id as string;
}

/** A scan started through the backend, finished on the engine and collected into the backend's record. */
async function aCollectedHybridScan() {
  const clientId = await aClient();
  const started = await admin.post("/api/scans").send({ clientId, target: TARGET, consent: true });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const testId = started.body.test.id as string;
  const runId = started.body.runId as string;
  const scanId = started.body.test.findings.backendScanId as string;
  engine.finish(runId, { state: "completed", result: { run_id: runId, results: RESULTS, coverage: COVERAGE } });
  const collected = await until(async () => (await admin.get(`/api/scans/${testId}`)).body, (body) => body.backend?.collected === true);
  expect(collected.backend.status).toBe("completed");
  return { clientId, testId, runId, scanId, engagement: hybrid.scans.get(scanId)!.engagement as number };
}

/** The backend's ingest of that scan: a deployment under its engagement, and the one sql_injection finding of it; the engine's twin of it. */
function ingested(scan: { runId: string; scanId: string; engagement: number }, tag: string, type = "sql_injection") {
  hybrid.addDeployment({ uuid: `d-${tag}`, name: `Shop ${tag}`, engagement_id: scan.engagement });
  const finding = hybrid.addFinding({
    uuid: `f-${tag}`, deployment_uuid: `d-${tag}`, finding_type: type, title: "A quoted parameter reached the query", severity: "high",
    scan_uuid: scan.scanId, engine_run_id: scan.runId, retest_required: true,
  });
  engine.twins.set(scan.runId, [{ id: 7, run_id: scan.runId, target: TARGET, finding_type: "sql_injection", inputs: { endpoint: TARGET }, decision: { severity: "high" } }]);
  return finding;
}

/** Retest pressed on twin 7: the engine answers 202 naming `runId`, and the dashboard watches it. */
async function aRetest(testId: string, runId: string) {
  engine.control.nextRetestRun = runId;
  const res = await admin.post(`/api/tests/${testId}/retest`).send({ twinId: 7 });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  expect(res.body.engineRunId).toBe(runId);
  return res.body;
}

const ended = (runId: string) => until(() => view(runId), (body) => body.phase === "verdict" && body.result?.backend?.state !== undefined && body.result.backend.state !== "asking");

describe("a retest of a scan started through Athena-Backend", () => {
  it("after the verdict is filed, asks the backend as the person with {run_id, twin_run_id}, records the outcome on the watch row, and the check is in the backend's record -- never in this dashboard's ledger", async () => {
    const scan = await aCollectedHybridScan();
    ingested(scan, "a");
    await aRetest(scan.testId, "rt-a");
    expect((await view("rt-a")).phase).toBe("running");
    expect(collectsFor("f-a"), "nothing is asked of the backend before the verdict").toEqual([]);

    engine.verdict("rt-a", "closed");
    const done = await ended("rt-a");
    expect(done.result.backend).toMatchObject({
      state: "recorded", recorded: true, status: 201, reason: null, findingUuid: "f-a", checkId: "rt-a", lastAnswer: "recorded",
      twinRunId: scan.runId, backendScanId: scan.scanId,
      check: {
        engineRunId: "rt-a", verdict: "closed", verdictKnown: true, state: "completed", stoppedAfterRecording: false,
        engineCheckedAt: CHECKED_AT, twinId: 7, twinRunId: scan.runId, scanRecordId: "702", collectedBy: "admin",
      },
    });
    expect(done.result.backend.detail).toBe("Athena-Backend answered 201: the retest check for run rt-a is recorded against finding f-a");
    // Asked once, as the person -- their own sign-in, never the stop credential -- with the two run ids.
    const sent = collectsFor("f-a");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ account: "admin", by: "bearer", stop: false, status: 201, json: { run_id: "rt-a", twin_run_id: scan.runId } });
    // The backend's record holds the check under its finding, which is otherwise what it was.
    expect(hybrid.retestChecks.get("rt-a")).toMatchObject({ finding_uuid: "f-a", verdict: "closed", twin_run_id: scan.runId, collected_by: "admin" });
    expect(hybrid.findings.get("f-a")!.retest_checks).toHaveLength(1);
    expect(hybrid.findings.get("f-a")!.status).toBe("open");
    // This dashboard's own filing is what it was: a hybrid scan has no finding in this ledger, so no verdict was filed
    // here, and the backend's check is filed here neither -- the ledger stays empty.
    expect(done.result.notFiled).toBe("no finding on record matches this decision");
    expect(done.result.applied).toBeNull();
    expect(await storage.getFindingsByClient(scan.clientId)).toEqual([]);
    expect((await storage.getRetestWatch("rt-a"))!.result!.backend).toMatchObject({ state: "recorded", checkId: "rt-a" });
    // Served with the backend finding (server/assurance.ts retestChecks), read by its fields.
    const record = await admin.get(`/api/record/clients/${scan.clientId}/findings`);
    expect(record.status).toBe(200);
    const inRecord = record.body.findings.find((one: { uuid: string }) => one.uuid === "f-a");
    expect(inRecord.retestChecks).toEqual([{
      engineRunId: "rt-a", scanRecordId: "702", twinId: 7, twinRunId: scan.runId, verdict: "closed", verdictKnown: true,
      detail: expect.stringMatching(/^sql_injection was not reported/), state: "completed", stoppedAfterRecording: false,
      engineCheckedAt: CHECKED_AT, collectedAt: expect.any(String), collectedBy: "admin",
    }]);
    // Logged as the asking's, never as a person's act now, and never as closure evidence.
    const logs = await logsOf("retest_check_recorded", "rt-a");
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toMatchObject({ filedBy: "retest_check_watch", findingUuid: "f-a", checkId: "rt-a", status: 201, twinRunId: scan.runId, backendScanId: scan.scanId, requestedBy: adminId, closureEvidence: false });
    // Asked once, and never again.
    await sleep(150);
    expect(collectsFor("f-a")).toHaveLength(1);
    expect(checks.peek("rt-a")).toBeUndefined();
  });

  it("records a verdict whose run was then stopped as the backend records it: aborted, stopped after recording", async () => {
    const scan = await aCollectedHybridScan();
    ingested(scan, "b");
    await aRetest(scan.testId, "rt-b");
    engine.verdict("rt-b", "still_open", {}, "aborted");
    const done = await ended("rt-b");
    expect(done.result.stoppedAfterRecording).toBe("stopped by an operator");
    expect(done.result.backend).toMatchObject({ state: "recorded", recorded: true, check: { verdict: "still_open", state: "aborted", stoppedAfterRecording: true } });
  });
});

describe("a retest of a scan this dashboard recorded directly from the engine", () => {
  it("sends nothing to the backend: the row says the check is not in the backend record, and the finding's check carries that", async () => {
    const clientId = await aClient("legacy.example");
    const target = "https://legacy.example/";
    const { test } = await recordLegacyScan(storage, {
      clientId, target, runId: "legacy-run-1", executedBy: adminId,
      results: [{ type: "xss", severity: "high", message: "Reflected input on /search", endpoint: "https://legacy.example/search" }],
    });
    engine.twins.set("legacy-run-1", [{ id: 7, run_id: "legacy-run-1", target, finding_type: "xss", inputs: { endpoint: "https://legacy.example/search" }, decision: { severity: "high" } }]);
    const sentBefore = hybrid.retestCheckCollects().length;
    await aRetest(test.id, "rt-legacy");
    engine.verdict("rt-legacy", "still_open", { finding_type: "xss", target, detail: "xss was reported again" });
    const done = await ended("rt-legacy");
    expect(done.result.backend).toEqual({
      state: "not_in_record", recorded: false, reason: "dashboard_direct", status: null, findingUuid: null, checkId: null, check: null,
      lastAnswer: null, lastAskedAt: null, lastReadError: null, startedAt: expect.any(String), deadlineAt: expect.any(String), endedAt: expect.any(String),
      twinRunId: "legacy-run-1", backendScanId: null,
      detail: retestChecks.DASHBOARD_DIRECT_DETAIL,
    });
    // The dashboard's own filing went as before: the ledger's finding has its check, still open.
    expect(done.result.applied).toMatchObject({ status: "open" });
    const [finding] = await storage.getFindingsByClient(clientId);
    const checksFiled = await storage.getChecks(finding.id);
    expect(checksFiled.map((one) => [one.verdict, one.engineRunId])).toEqual([["still_open", "rt-legacy"]]);
    // Nothing reached the backend for it.
    expect(hybrid.retestCheckCollects().length).toBe(sentBefore);
    expect(hybrid.seen.filter((one) => one.path.includes("legacy") || one.body.includes("legacy"))).toEqual([]);
    // The finding's check, as the Findings page reads it, says where the recording stands.
    const page = await admin.get(`/api/findings?clientId=${clientId}`);
    expect(page.status).toBe(200);
    expect(page.body.findings[0].checks[0]).toMatchObject({ verdict: "still_open", engineRunId: "rt-legacy", backend: { state: "not_in_record", reason: "dashboard_direct" } });
  });
});

describe("what the backend answers", () => {
  it("404 -- the engine has no run the backend can read (another tenant's) -- ends the asking in the backend's words, asked once", async () => {
    const scan = await aCollectedHybridScan();
    ingested(scan, "c1");
    await aRetest(scan.testId, "rt-c1");
    engine.control.blindToBackend.add("rt-c1");
    engine.verdict("rt-c1", "closed");
    const done = await ended("rt-c1");
    expect(done.result.backend).toMatchObject({
      state: "not_in_record", recorded: false, status: 404, lastAnswer: "not_in_record", findingUuid: "f-c1", checkId: null, check: null,
      detail: "the engine has no run rt-c1 this backend can read",
    });
    expect((await logsOf("retest_check_not_in_record", "rt-c1"))[0].details).toMatchObject({ status: 404, findingUuid: "f-c1" });
    await sleep(150);
    expect(collectsFor("f-c1").map((one) => one.status)).toEqual([404]);
    expect(hybrid.retestChecks.has("rt-c1")).toBe(false);
  });

  it("409 -- two findings of the type in the deployment -- ends the asking with the backend's candidates, asked once", async () => {
    const scan = await aCollectedHybridScan();
    ingested(scan, "c2");
    hybrid.addFinding({ uuid: "f-c2-twin", deployment_uuid: "d-c2", finding_type: "sql_injection", scan_uuid: scan.scanId, engine_run_id: scan.runId });
    await aRetest(scan.testId, "rt-c2");
    engine.verdict("rt-c2", "closed");
    const done = await ended("rt-c2");
    expect(done.result.backend).toMatchObject({ state: "not_in_record", recorded: false, status: 409, findingUuid: "f-c2" });
    expect(done.result.backend.detail).toBe(
      "2 findings of type 'sql_injection' are in that deployment, so the run's twin cannot be told to one of them; nothing was written (candidates: f-c2, f-c2-twin)",
    );
    await sleep(150);
    expect(collectsFor("f-c2").map((one) => one.status)).toEqual([409]);
  });

  it("422 -- the verdict's target is not the scan's -- ends the asking in the backend's words, asked once", async () => {
    const scan = await aCollectedHybridScan();
    ingested(scan, "c3");
    await aRetest(scan.testId, "rt-c3");
    engine.verdict("rt-c3", "closed", { target: "https://elsewhere.example/" });
    const done = await ended("rt-c3");
    expect(done.result.backend).toMatchObject({
      state: "not_in_record", recorded: false, status: 422,
      detail: `the verdict's target host 'elsewhere.example' is not the scan's ('${HOST}'); nothing was written`,
    });
    await sleep(150);
    expect(collectsFor("f-c3").map((one) => one.status)).toEqual([422]);
  });

  it("503 -- the backend could not read the engine -- is asked again within the bound, 'asking' meanwhile and never recorded; then recorded", async () => {
    const scan = await aCollectedHybridScan();
    ingested(scan, "d1");
    await aRetest(scan.testId, "rt-d1");
    hybrid.controls.engineUnreachable = true;
    engine.verdict("rt-d1", "closed");
    const asking = await until(() => standingOf("rt-d1"), (backend) => backend?.lastAnswer === "unavailable");
    expect(asking).toMatchObject({ state: "asking", recorded: null, status: 503, findingUuid: "f-d1", checkId: null, check: null, detail: retestChecks.ASKING });
    expect(asking.lastReadError).toMatch(/Athena-Backend answered 503 to the retest-check collect: Not recorded: the engine could not be read/);
    await sleep(150);
    const sent = collectsFor("f-d1");
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent.map((one) => one.status))).toEqual(new Set([503]));
    expect((await standingOf("rt-d1")).recorded).toBeNull();
    hybrid.controls.engineUnreachable = false;
    const done = await ended("rt-d1");
    expect(done.result.backend).toMatchObject({ state: "recorded", recorded: true, status: 201, lastAnswer: "recorded" });
  });

  it("202 -- the backend reads the run as still going -- is asked again within the bound, 'asking' meanwhile; then recorded", async () => {
    const scan = await aCollectedHybridScan();
    ingested(scan, "d2");
    await aRetest(scan.testId, "rt-d2");
    engine.control.runningForBackend.add("rt-d2");
    engine.verdict("rt-d2", "closed");
    const asking = await until(() => standingOf("rt-d2"), (backend) => backend?.lastAnswer === "running");
    expect(asking).toMatchObject({ state: "asking", recorded: null, status: 202 });
    expect(asking.lastReadError).toMatch(/^Athena-Backend answered 202: the run is still going on the engine/);
    await sleep(150);
    expect(collectsFor("f-d2").length).toBeGreaterThanOrEqual(2);
    engine.control.runningForBackend.delete("rt-d2");
    expect((await ended("rt-d2")).result.backend).toMatchObject({ state: "recorded", recorded: true });
  });

  it("a finding the record does not list yet is asked for again -- never invented -- and recorded once the record lists it", async () => {
    const scan = await aCollectedHybridScan();
    await aRetest(scan.testId, "rt-d3");
    engine.twins.set(scan.runId, [{ id: 7, run_id: scan.runId, target: TARGET, finding_type: "sql_injection", inputs: { endpoint: TARGET }, decision: { severity: "high" } }]);
    engine.verdict("rt-d3", "closed");
    const asking = await until(() => standingOf("rt-d3"), (backend) => backend?.lastAnswer === "no_finding");
    expect(asking).toMatchObject({ state: "asking", recorded: null, status: null, findingUuid: null });
    expect(asking.lastReadError).toMatch(/lists no deployment under backend engagement/);
    expect(hybrid.retestCheckCollects().filter((one) => one.json?.run_id === "rt-d3")).toEqual([]);
    ingested(scan, "d3");
    const done = await ended("rt-d3");
    expect(done.result.backend).toMatchObject({ state: "recorded", recorded: true, findingUuid: "f-d3" });
  });

  it("the bound reached stops the asking and says so -- never an outcome", async () => {
    const scan = await aCollectedHybridScan();
    ingested(scan, "e");
    await aRetest(scan.testId, "rt-e");
    retestChecks.retestCheckWatch.totalMs = 150;
    hybrid.controls.engineUnreachable = true;
    engine.verdict("rt-e", "closed");
    const done = await ended("rt-e");
    expect(done.result.backend).toMatchObject({ state: "unwatched", recorded: false, lastAnswer: "unavailable", status: 503, checkId: null, check: null });
    expect(done.result.backend.detail).toMatch(/\(this dashboard stopped asking at its deadline\)$/);
    expect(await logsOf("retest_check_unwatched", "rt-e")).toHaveLength(1);
    const sent = collectsFor("f-e").length;
    hybrid.controls.engineUnreachable = false;
    await sleep(150);
    expect(collectsFor("f-e").length, "stopped asking means stopped").toBe(sent);
    expect((await standingOf("rt-e")).state).toBe("unwatched");
    expect(hybrid.retestChecks.has("rt-e")).toBe(false);
  });
});

describe("safety", () => {
  it("the kill switch pressed while a collect is held at the backend stops the running retest first; the collect's later answer changes nothing about it", async () => {
    const scan = await aCollectedHybridScan();
    ingested(scan, "f1");
    await aRetest(scan.testId, "rt-f1");
    hybrid.holdRetestCheckCollects();
    engine.verdict("rt-f1", "closed");
    // The collect is in flight and held: the backend has it, unanswered.
    await hybrid.waitFor((one) => one.path === "/api/assurance/findings/f-f1/retest-checks/collect/");
    expect((await standingOf("rt-f1")).state).toBe("asking");
    // Another retest, still running on the engine.
    const other = await aCollectedHybridScan();
    ingested(other, "f2");
    await aRetest(other.testId, "rt-f2");
    expect(engine.runs.get("rt-f2")!.state).toBe("running");

    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    try {
      expect(engaged.status).toBe(200);
      // The running retest was sent its stop by id while the collect was still held -- the switch waited on no collect.
      expect(engine.aborts().map((one) => one.url)).toContain("/api/scans/rt-f2/abort");
      expect(collectsFor("f-f1").map((one) => one.status), "the collect is still held, unanswered").toEqual([0]);
      expect(engine.aborts().map((one) => one.url), "a retest that ended with a verdict is no run to stop").not.toContain("/api/scans/rt-f1/abort");
      expect((await standingOf("rt-f1")).state).toBe("asking");
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "operational" });
    }
    // Released, the collect is answered and recorded; the stop that went is what it was.
    hybrid.releaseRetestCheckCollects();
    expect((await ended("rt-f1")).result.backend).toMatchObject({ state: "recorded", recorded: true });
    expect(engine.aborts().filter((one) => one.url === "/api/scans/rt-f2/abort")).toHaveLength(1);
    expect((await view("rt-f2")).phase).toBe("stopped");
  });

  it("a dashboard that restarts resumes the asking, as nobody until a person reads the retest, then records it", async () => {
    const scan = await aCollectedHybridScan();
    ingested(scan, "g");
    await aRetest(scan.testId, "rt-g");
    hybrid.controls.engineUnreachable = true;
    engine.verdict("rt-g", "closed");
    await until(() => standingOf("rt-g"), (backend) => backend?.lastAnswer === "unavailable");
    // A restart: a dashboard that never knew the asking in memory, nor the requester's session.
    checks.reset();
    checks.resume();
    hybrid.controls.engineUnreachable = false;
    const sent = collectsFor("f-g").length;
    const unsigned = await until(() => storage.getRetestWatch("rt-g").then((row) => (row!.result as { backend: { lastAnswer: string | null } }).backend),
      (backend) => backend.lastAnswer === "sign_in_required");
    expect(unsigned).toMatchObject({ state: "asking", recorded: null });
    expect(collectsFor("f-g").length, "nothing is sent without a person's credential").toBe(sent);
    // A signed-in person reads the retest: the asking goes as them from now on.
    expect((await view("rt-g")).phase).toBe("verdict");
    const done = await ended("rt-g");
    expect(done.result.backend).toMatchObject({ state: "recorded", recorded: true, lastAnswer: "recorded" });
    expect(collectsFor("f-g").at(-1)).toMatchObject({ account: "admin", by: "bearer", status: 201 });
  });
});
