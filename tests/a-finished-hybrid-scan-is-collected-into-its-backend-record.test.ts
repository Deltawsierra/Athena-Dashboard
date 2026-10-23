import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import request from "supertest";

import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";

/**
 * A scan started through Athena-Backend (the Option 1 hybrid) is live-polled
 * from the engine as every scan was, and when the poll first sees the run
 * finished, the backend is asked to COLLECT the run into its record -- as the
 * person reading the page -- and the record is filed into the scan's row once
 * (server/collect-watch.ts, GET /api/scans/:testId):
 *
 *   - `backend` in the status answer has three states and never a fourth
 *     guessed: `collected: null` before the run ends (not asked yet), `false`
 *     while the backend is asked (pending; the backend unable to reach the
 *     engine; a person with no sign-in), `true` with the record's own status
 *     word, verdict and label, when it was collected, its engagement and its
 *     PDF through this dashboard's relay -- or, for a run stopped or failed,
 *     no verdict and the record's error message;
 *   - once collected, the answer's results and coverage are the RECORD's bytes
 *     (`engine_response`), and the row says whether they differed from what the
 *     direct poll recorded;
 *   - a 409 (the record already stands) is followed by a read of the record;
 *   - a hybrid scan is never filed into this dashboard's own findings ledger;
 *     a legacy row -- a scan this dashboard dispatched itself -- is filed as
 *     before, and its answer has no `backend`;
 *   - the mark of a run this dashboard's engine key could not read on the first
 *     direct read (`stop: "backend"`) is cleared by the first read that succeeds,
 *     and the direct Stop is offered again;
 *   - the record's PDF is relayed as the person, only for a record that has one.
 *
 * Nothing here is on a stop's path: the Stop is the engine's abort, sent direct
 * (tests/every-scan-starts-through-the-backend-and-its-stop-stays-direct.test.ts).
 */

const TOKEN = "e".repeat(64);

/** A run's results as the engine sends them: readable rows (server/routes.ts isResultRow), one rated high. */
const RESULTS = [
  { type: "sql_injection", severity: "high", url: "https://acme.example/login", message: "the login form reflected a quoted parameter into a query error", details: "parameter: user" },
  { type: "missing_header", severity: "low", url: "https://acme.example/", message: "no Content-Security-Policy header", details: null },
];

/** The engine's coverage manifest for the run (shared/scan-coverage.ts). */
const COVERAGE = {
  complete: false,
  checks: [
    { check: "sql_injection", team: "web", state: "performed", probes_attempted: 12, probes_failed: 0 },
    { check: "ssrf", team: "web", state: "not_performed", reason: "not_selected", detail: "not in the selected profile" },
  ],
  not_performed: ["ssrf"], degraded: [], unmeasured: [], limitations: { sql_injection: ["blind variants were not timed"] }, notes: [],
};

type Run = { state: string; result: Record<string, unknown> | null; reason: string | null };

/** An engine whose runs stay running until finished or aborted by the test. */
function stubEngine() {
  const calls: Array<{ method: string; url: string; key: string | null }> = [];
  const runs = new Map<string, Run>();
  const control = { tenantBound: false, finishOnLaunch: null as { state: string; result: Record<string, unknown> } | null };
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
      calls.push({ method: req.method ?? "GET", url, key: typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null });
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") {
        const active = Array.from(runs).filter(([, run]) => run.state === "running").map(([run_id]) => ({ run_id, target: "", kind: "scan", state: "running" }));
        return json(res, 200, { active });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        const run = runs.get(abort[1]);
        if (!run) return json(res, 404, { detail: "No such scan run" });
        if (run.state === "running") Object.assign(run, { state: "aborted", reason: "aborted by operator", result: { ...(run.result ?? {}), results: [], detail: "aborted by operator" } });
        return json(res, 200, { run_id: abort[1], state: "aborting" });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = decodeURIComponent(url.slice("/api/scans/".length));
        const run = runs.get(id);
        // The engine scopes a run's read to the key that asks: the backend's key sees its run; the dashboard's does not.
        if (!run || (control.tenantBound && req.headers["x-api-key"] === "dashboard-key")) return json(res, 404, { detail: "No such scan run" });
        return json(res, 200, {
          run_id: id, state: run.state, done: run.state !== "running", result: run.result ?? {}, ...(run.reason ? { reason: run.reason } : {}),
        });
      }
      if (req.method === "POST" && url === "/api/scan") {
        next += 1;
        const id = `run-${next}`;
        runs.set(id, control.finishOnLaunch ? { ...control.finishOnLaunch, reason: null } : { state: "running", result: null, reason: null });
        return json(res, 202, { run_id: id, state: control.finishOnLaunch?.state ?? "running" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  return {
    server, calls, runs, control,
    /** The run ends as the engine would record it. */
    finish(id: string, end: { state: string; result: Record<string, unknown>; reason?: string }): void {
      runs.set(id, { state: end.state, result: end.result, reason: end.reason ?? null });
    },
    aborts: () => calls.filter((one) => one.url.endsWith("/abort")),
  };
}

let engine: ReturnType<typeof stubEngine>;
let hybrid: HybridBackendStandIn;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let storage: typeof import("../server/storage-unified").storage;
let persons: typeof import("../server/person-credential");
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
  // The backend is asked often, so a case waits little; nothing else is shortened.
  (await import("../server/collect-watch")).collectWatch.intervalMs = 25;
  admin = await signIn(app);
  await signInToBackend(admin);
  storage = (await import("../server/storage-unified")).storage;
  persons = await import("../server/person-credential");
});

afterEach(() => {
  engine.calls.length = 0;
  engine.control.tenantBound = false;
  engine.control.finishOnLaunch = null;
  hybrid.seen.length = 0;
  hybrid.controls.engineUnreachable = false;
  hybrid.releaseCollects();
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

async function aClient(host = "acme.example") {
  clientCount += 1;
  const client = await admin.post("/api/clients").send({ name: `Client ${clientCount}`, company: `Company ${clientCount}`, email: `c${clientCount}@x.test` });
  await admin.post("/api/sites").send({ clientId: client.body.id, name: host, url: `https://${host}` });
  return client.body.id as string;
}

/** A scan started through the backend, running on the stub. */
async function aRunningScan(clientId?: string) {
  const client = clientId ?? await aClient();
  const started = await admin.post("/api/scans").send({ clientId: client, target: "https://acme.example/login", consent: true });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return {
    clientId: client,
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

/** The collects the backend saw for one scan (a watch of another case may still be asking). */
const collectsOf = (scanId: string) => hybrid.collects().filter((one) => one.path === `/api/pentest/scans/${scanId}/collect/`);

const collectedLogs = async (scanId: string) =>
  (await admin.get("/api/logs")).body.filter((one: { action: string; details: { backendScanId?: string } }) =>
    one.action === "backend_record_collected" && one.details.backendScanId === scanId);

describe("the first finished read starts the collect watch", () => {
  it("asks Athena-Backend to collect the record as the person, once, and files it: status, verdict and label, engagement, PDF; the results and coverage are the record's bytes", async () => {
    const { clientId, testId, runId, scanId } = await aRunningScan();

    // While the run goes on: the live poll, and the record not asked for yet.
    const live = await read(testId);
    expect(live.state).toBe("running");
    expect(live.backend).toMatchObject({ scanId, collected: null, watch: null, status: null, verdict: null, verdictLabel: null, pdfUrl: null });
    expect(live.stop).toBeUndefined();
    expect(collectsOf(scanId)).toEqual([]);

    // The run ends on the engine with results and a coverage manifest.
    engine.finish(runId, { state: "completed", result: { run_id: runId, results: RESULTS, coverage: COVERAGE } });
    const finished = await read(testId);
    expect(finished.state).toBe("completed");
    expect(finished.engine.findings).toEqual(RESULTS);
    expect(finished.filed, "a hybrid scan is not filed into this dashboard's ledger").toBeNull();
    // The first finished read starts the watch: asked, not answered yet -- never a verdict from silence.
    expect(finished.backend).toMatchObject({ scanId, collected: false, watch: "running", status: "pending", verdict: null, verdictLabel: null, pdfUrl: null });

    const collected = await readUntil(testId, (body) => body.backend?.collected === true);
    const record = hybrid.scans.get(scanId)!;
    expect(record.status).toBe("completed");
    expect(collected.backend).toMatchObject({
      scanId, collected: true, watch: "collected", status: "completed",
      verdict: record.verdict, verdictLabel: expect.any(String), detail: "", collectedAt: record.collected_at,
      pdfUrl: `/api/scans/${testId}/backend-pdf`, engineRunId: runId,
      engagement: { id: record.engagement, name: expect.any(String), clientName: `Company ${clientCount}`, status: "running" },
      engagementId: record.engagement,
      differsFromDirect: { results: false, coverage: false },
      mirror: null,
    });
    expect(collected.backend.verdict).not.toBeNull();

    // Asked once, as the person -- their own sign-in, never the stop credential -- and never again.
    const collects = collectsOf(scanId);
    expect(collects).toHaveLength(1);
    expect(collects[0]).toMatchObject({ account: "admin", by: "bearer", stop: false, status: 200 });
    await new Promise((r) => setTimeout(r, 120));
    expect(collectsOf(scanId)).toHaveLength(1);

    // The answer is the RECORD's now: its results and coverage, byte for byte -- and they equal the direct poll's.
    expect(collected.engine.detail).toBe("the findings in the Athena-Backend record of this scan");
    expect(JSON.stringify(collected.engine.findings)).toBe(JSON.stringify(record.engine_response!.results));
    expect(JSON.stringify(collected.test.findings.coverage)).toBe(JSON.stringify(record.engine_response!.coverage));
    expect(JSON.stringify(collected.test.findings.coverage)).toBe(JSON.stringify(COVERAGE));
    // The manifest is answered as the engine wrote it (shared/scan-coverage.ts coverageOf): the record's bytes.
    expect(JSON.stringify(collected.coverage)).toBe(JSON.stringify(record.engine_response!.coverage));
    expect(collected.test.findings.backend).toMatchObject({ status: "completed", verdict: record.verdict, collectedAt: record.collected_at, detail: "" });
    expect(collected.test.status).toBe("completed");
    expect(collected.test).toMatchObject({ highCount: 1, lowCount: 1, vulnerabilitiesFound: 2 });

    // Filed once, by the watch, on the record of this test; and never into the findings ledger.
    const logs = await collectedLogs(scanId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ entityType: "test", entityId: testId, details: { filedBy: "collect_watch", status: "completed", engineRunId: runId } });
    expect(await storage.getFindingsByClient(clientId)).toEqual([]);
    expect(await storage.getCollectWatch(scanId)).toMatchObject({ testId, engineRunId: runId, state: "collected", lastAnswer: "collected" });
  });

  it("a run the engine finished inside the backend's launch read is recorded completed, and its first read starts the watch too", async () => {
    engine.control.finishOnLaunch = { state: "completed", result: { results: RESULTS, coverage: COVERAGE } };
    const { testId, scanId } = await aRunningScan();
    expect((await storage.getTest(testId))!.status).toBe("completed");
    // The launch read the record once for the run's id (the 200 carries none); what follows is the watch's.
    hybrid.seen.length = 0;
    const first = await read(testId);
    expect(first.state).toBe("completed");
    expect(first.backend).toMatchObject({ collected: false, watch: "running" });
    const collected = await readUntil(testId, (body) => body.backend?.collected === true);
    // The backend's record was completed at the launch: its collect answers 409, and the record is read.
    expect(collectsOf(scanId).map((one) => one.status)).toEqual([409]);
    expect(hybrid.seen.filter((one) => one.method === "GET" && one.path === `/api/pentest/scans/${scanId}/`).map((one) => one.account)).toEqual(["admin"]);
    expect(collected.backend).toMatchObject({ collected: true, status: "completed", verdict: hybrid.scans.get(scanId)!.verdict, differsFromDirect: { results: false, coverage: false } });
    expect(collected.engine.findings).toEqual(RESULTS);
  });

  it("a 409 -- the record already stands -- is followed by a read of the record, which is filed", async () => {
    const { testId, runId, scanId } = await aRunningScan();
    engine.finish(runId, { state: "completed", result: { results: RESULTS, coverage: COVERAGE } });
    // The backend's own collector got there first.
    const collectedByBackend = await fetch(`${hybrid.url}/api/pentest/scans/${scanId}/collect/`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await aBearer()}` }, body: "{}",
    });
    expect(collectedByBackend.status).toBe(200);
    hybrid.seen.length = 0;
    const collected = await readUntil(testId, (body) => body.backend?.collected === true);
    expect(collectsOf(scanId).map((one) => one.status)).toEqual([409]);
    expect(collected.backend).toMatchObject({ collected: true, status: "completed", verdict: hybrid.scans.get(scanId)!.verdict });
    expect(await collectedLogs(scanId)).toHaveLength(1);
  });

  it("the backend unable to reach the engine (503) keeps the watch asking, and nothing is read as collected", async () => {
    const { testId, runId, scanId } = await aRunningScan();
    hybrid.controls.engineUnreachable = true;
    try {
      engine.finish(runId, { state: "completed", result: { results: RESULTS, coverage: COVERAGE } });
      const asked = await readUntil(testId, (body) => body.backend?.lastAnswer === "unavailable");
      expect(asked.backend).toMatchObject({ collected: false, watch: "running", status: "pending", verdict: null, verdictLabel: null, pdfUrl: null, lastAnswer: "unavailable" });
      expect(asked.backend.detail).toContain("Athena-Backend could not collect the record yet");
      expect(asked.backend.detail).toContain("the engine could not be reached");
      expect(asked.backend.lastReadError).toContain("Athena-Backend answered 503 to the collect");
      // Asked again, and again answered 503: still pending, still no verdict.
      await new Promise((r) => setTimeout(r, 120));
      const again = collectsOf(scanId);
      expect(again.length).toBeGreaterThanOrEqual(2);
      expect(new Set(again.map((one) => one.status))).toEqual(new Set([503]));
      expect((await read(testId)).backend).toMatchObject({ collected: false, verdict: null });
    } finally {
      hybrid.controls.engineUnreachable = false;
    }
    const collected = await readUntil(testId, (body) => body.backend?.collected === true);
    expect(collected.backend.status).toBe("completed");
  });

  it("a person with no backend sign-in: the collect waits and says so; it goes once a signed-in person is lent", async () => {
    const { testId, runId, scanId } = await aRunningScan();
    engine.finish(runId, { state: "completed", result: { results: RESULTS, coverage: COVERAGE } });
    persons._resetPersonsForTests();
    try {
      const waiting = await readUntil(testId, (body) => body.backend?.lastAnswer === "sign_in_required");
      expect(waiting.backend).toMatchObject({ collected: false, watch: "running", lastAnswer: "sign_in_required" });
      expect(waiting.backend.detail).toContain("the collect waits on a person signed in to Athena-Backend");
      expect(collectsOf(scanId), "nothing was sent without a credential").toEqual([]);
    } finally {
      await signInToBackend(admin);
    }
    const collected = await readUntil(testId, (body) => body.backend?.collected === true);
    expect(collected.backend.status).toBe("completed");
    expect(collectsOf(scanId)[0]).toMatchObject({ account: "admin", by: "bearer" });
  });
});

describe("a run that did not finish", () => {
  it("stopped from here: the record says stopped, with the record's error message and no verdict and no PDF", async () => {
    const { testId, runId, scanId } = await aRunningScan();
    const stopped = await admin.post(`/api/scans/${testId}/abort`);
    expect(stopped.status).toBe(200);
    expect(engine.aborts().map((one) => one.url)).toEqual([`/api/scans/${runId}/abort`]);
    const collected = await readUntil(testId, (body) => body.backend?.collected === true);
    expect(collected.state).toBe("aborted");
    expect(collected.backend).toMatchObject({
      collected: true, status: "stopped", verdict: null, verdictLabel: null, pdfUrl: null,
      detail: "Stopped on the engine: aborted by operator",
    });
    expect(collected.test.findings.backend).toMatchObject({ status: "stopped", verdict: null, detail: "Stopped on the engine: aborted by operator" });
    // No report to relay: the backend's 409, in its words.
    const pdf = await admin.get(`/api/scans/${testId}/backend-pdf`);
    expect(pdf.status).toBe(409);
    expect(pdf.body).toMatchObject({ reason: "backend_refused", backendStatus: 409 });
    expect(pdf.body.error).toContain("This scan is stopped, so there is no report to render.");
    expect(hybrid.seen.filter((one) => one.path === `/api/pentest/scans/${scanId}/pdf/`).map((one) => one.account)).toEqual(["admin"]);
  });

  it("failed on the engine: the record says failed, with the engine's error, no verdict and no PDF", async () => {
    const { testId, runId } = await aRunningScan();
    engine.finish(runId, { state: "failed", result: { results: [], error: "the target closed the connection" } });
    const collected = await readUntil(testId, (body) => body.backend?.collected === true);
    expect(collected.state).toBe("failed");
    expect(collected.backend).toMatchObject({
      collected: true, status: "failed", verdict: null, verdictLabel: null, pdfUrl: null,
      detail: "Failed on the engine: the target closed the connection",
    });
  });
});

describe("the record's PDF", () => {
  it("is relayed as the person for a completed record, with the backend's headers", async () => {
    const { testId, runId, scanId } = await aRunningScan();
    engine.finish(runId, { state: "completed", result: { results: RESULTS, coverage: COVERAGE } });
    await readUntil(testId, (body) => body.backend?.collected === true);
    hybrid.seen.length = 0;
    const pdf = await admin.get(`/api/scans/${testId}/backend-pdf`).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toBe(`attachment; filename="pentest_${scanId}.pdf"`);
    expect((pdf.body as Buffer).toString("utf8")).toBe(`%PDF-1.4 stand-in report for ${scanId}`);
    const relayed = hybrid.seen.filter((one) => one.path === `/api/pentest/scans/${scanId}/pdf/`);
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ account: "admin", by: "bearer", stop: false, status: 200 });
  });

  it("is refused for a scan with no backend record, before anything is sent", async () => {
    const clientId = await aClient();
    const legacy = await storage.createTest({
      clientId, name: "Legacy scan", testType: "vulnerability-scan", status: "completed",
      findings: { runId: "legacy-pdf", target: "https://acme.example/", results: [] },
    } as any);
    const pdf = await admin.get(`/api/scans/${legacy.id}/backend-pdf`);
    expect(pdf.status).toBe(409);
    expect(pdf.body.reason).toBe("no_backend_record");
    expect(hybrid.seen).toEqual([]);
  });
});

describe("a scan this dashboard dispatched itself (a legacy row)", () => {
  it("is filed into the findings ledger as before, and its answer has no backend", async () => {
    const clientId = await aClient("legacy.example");
    engine.runs.set("legacy-1", { state: "running", result: null, reason: null });
    const legacy = await storage.createTest({
      clientId, name: "Legacy scan", testType: "vulnerability-scan", status: "running",
      findings: { runId: "legacy-1", target: "https://legacy.example/", results: [] },
    } as any);
    const live = await read(legacy.id);
    expect(live.state).toBe("running");
    expect(live.backend).toBeNull();
    engine.finish("legacy-1", { state: "completed", result: { results: RESULTS, coverage: COVERAGE } });
    const finished = await read(legacy.id);
    expect(finished.state).toBe("completed");
    expect(finished.backend).toBeNull();
    expect(finished.filed).not.toBeNull();
    expect(await storage.getFindingsByClient(clientId)).toHaveLength(2);
    expect(hybrid.seen.filter((one) => one.path.includes("legacy")), "nothing of a legacy row reaches the backend").toEqual([]);
    expect(await storage.getCollectWatchByTest(legacy.id)).toBeUndefined();
  });
});

describe("a run this dashboard's engine key could not read on the first direct read", () => {
  it("keeps its mark while reads fail, and the first read that succeeds clears it: the direct Stop is offered again", async () => {
    engine.control.tenantBound = true;
    const { testId, runId, body } = await aRunningScan();
    expect(body.stop).toBe("backend");
    expect(body.test.findings.stop).toBe("backend");
    const unread = await read(testId);
    expect(unread.engine).toBeNull();
    expect(unread.stop).toBe("backend");
    expect(unread.backend).toMatchObject({ collected: null });

    engine.control.tenantBound = false;
    const readable = await read(testId);
    expect(readable.state).toBe("running");
    expect(readable.stop).toBeUndefined();
    expect(readable.test.findings.stop).toBeUndefined();
    expect((await storage.getTest(testId))!.findings).not.toHaveProperty("stop");
    const stopped = await admin.post(`/api/scans/${testId}/abort`);
    expect(stopped.status).toBe(200);
    expect(engine.aborts().map((one) => one.url)).toEqual([`/api/scans/${runId}/abort`]);
  });
});

/** The admin's own bearer token at the stand-in, for a request made as the backend's own collector would be. */
async function aBearer(): Promise<string> {
  const signedIn = await fetch(`${hybrid.url}/api/token/`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: (await import("./test-admin")).TEST_ADMIN_PASSWORD }),
  });
  return ((await signedIn.json()) as { access: string }).access;
}
