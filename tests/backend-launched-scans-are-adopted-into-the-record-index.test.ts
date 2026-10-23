import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, VERDICT_LABEL, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

/**
 * Every scan Athena-Backend lists for the person that this dashboard has no
 * row for -- started from another dashboard, from the backend's own console,
 * or by a launch whose answer was lost -- is ADOPTED into `tests`
 * (server/backend-adoption.ts, POST /api/record/adopt), so the screens, each
 * row's Stop and the kill switch cover it as they cover a scan started here
 * (the Option 1 hybrid, owner decision 4):
 *
 *   - one row per listed scan no row names: the run the RECORD names, the
 *     record's target, backendScanId and backendEngagementId, source "backend"
 *     and when it was adopted; a pending record reads "running" until the
 *     engine's live word; a finished record is adopted with the record's
 *     results and coverage (the detail's bytes), its counts and its snapshot,
 *     so the status route answers it from the record and asks the engine nothing;
 *   - idempotent: a second sync adopts nothing; a scan this dashboard launched
 *     is never adopted again (its row exists); storage refuses a second row for
 *     one backend scan however it is attempted;
 *   - the client is the one whose backendEngagementId names the engagement, and
 *     a site of it at the target's host; none, and the row has no client -- no
 *     client and no site is ever made up;
 *   - a pending scan the engine has not named a run for waits; a sync the
 *     backend's list refused changes nothing and is "could not be read"; a
 *     person with no backend sign-in is told so; a sync within the interval is
 *     answered from the last and reads nothing;
 *   - an adopted running scan: the live poll reads its run; no direct Stop until
 *     a direct read of the run has succeeded (adopted marked `stop: "backend"`,
 *     cleared by the first read that succeeds, kept by a 404); then its Stop is
 *     the engine's abort as for every scan;
 *   - nothing is ever filed into this dashboard's own findings ledger, and no
 *     run id anybody here supplies is ever written: the record's alone;
 *   - SAFETY: no sync stands between an operator and a stop -- a Stop and the
 *     kill switch are each answered while a sync is held at the backend's list.
 */

const TOKEN = "a".repeat(64);
const RESULTS = [{ type: "sql_injection", severity: "high", url: "https://acme.example/login", message: "a quoted parameter reached the query" }];
const COVERAGE = { complete: true, checks: [{ check: "sql_injection", team: "web", state: "performed" }], not_performed: [], degraded: [], unmeasured: [], limitations: {}, notes: [] };

type Run = { state: string; result: Record<string, unknown> | null; reason: string | null };

/** An engine whose runs stay running until finished or aborted; `tenantBound` makes every run read 404 to the dashboard's key. */
function stubEngine() {
  const calls: Array<{ method: string; url: string; key: string | undefined }> = [];
  const runs = new Map<string, Run>();
  const control = { tenantBound: false, completeNext: false, nameNoRunNext: false };
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
      const key = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined;
      calls.push({ method: req.method ?? "GET", url, key });
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") {
        return json(res, 200, { active: Array.from(runs).filter(([, run]) => run.state === "running").map(([run_id]) => ({ run_id, target: "", kind: "scan", state: "running" })) });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        const run = runs.get(abort[1]);
        if (!run) return json(res, 404, { detail: "No such scan run" });
        if (run.state === "running") Object.assign(run, { state: "aborted", reason: "aborted by operator", result: { results: [], detail: "aborted by operator" } });
        return json(res, 200, { run_id: abort[1], state: "aborting" });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = decodeURIComponent(url.slice("/api/scans/".length));
        const run = runs.get(id);
        if (!run || (control.tenantBound && key === "dashboard-key")) return json(res, 404, { detail: "No such scan run" });
        return json(res, 200, { run_id: id, state: run.state, done: run.state !== "running", result: run.result ?? {}, ...(run.reason ? { reason: run.reason } : {}) });
      }
      if (req.method === "POST" && url === "/api/scan") {
        if (control.nameNoRunNext) {
          control.nameNoRunNext = false;
          return json(res, 202, { state: "queued" });
        }
        next += 1;
        const id = `run-${next}`;
        if (control.completeNext) {
          control.completeNext = false;
          runs.set(id, { state: "completed", result: { results: RESULTS, coverage: COVERAGE }, reason: null });
          return json(res, 200, { run_id: id, state: "completed", result: { results: RESULTS, coverage: COVERAGE } });
        }
        runs.set(id, { state: "running", result: null, reason: null });
        return json(res, 202, { run_id: id, state: "running" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  return {
    server, calls, runs, control,
    finish(id: string, end: Run): void { runs.set(id, end); },
    reads: (runId: string) => calls.filter((one) => one.method === "GET" && one.url === `/api/scans/${runId}`),
    aborts: () => calls.filter((one) => one.url.endsWith("/abort")),
  };
}

let engine: ReturnType<typeof stubEngine>;
let hybrid: HybridBackendStandIn;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let storage: typeof import("../server/storage-unified").storage;
let adoption: typeof import("../server/backend-adoption");
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
  admin = await signIn(app);
  await signInToBackend(admin);
  storage = (await import("../server/storage-unified")).storage;
  adoption = await import("../server/backend-adoption");
  persons = await import("../server/person-credential");
  // Every case syncs afresh; the one about the interval sets its own.
  adoption.adoption.minIntervalMs = 0;
});

afterEach(() => {
  for (const [, run] of engine.runs) if (run.state === "running") run.state = "aborted";
  engine.calls.length = 0;
  engine.control.tenantBound = false;
  engine.control.completeNext = false;
  engine.control.nameNoRunNext = false;
  hybrid.seen.length = 0;
  hybrid.controls.failNextScansList = null;
  hybrid.releaseScansLists();
  adoption.adoption.minIntervalMs = 0;
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

async function aClient(host = "acme.example") {
  clientCount += 1;
  const client = await admin.post("/api/clients").send({ name: `Client ${clientCount}`, company: `Company ${clientCount}`, email: `c${clientCount}@x.test` });
  const site = await admin.post("/api/sites").send({ clientId: client.body.id, name: host, url: `https://${host}` });
  return { clientId: client.body.id as string, siteId: site.body.id as string };
}

/** A client whose engagement exists at the backend: one scan started for it from here. */
async function anEngagedClient(host = "acme.example") {
  const { clientId, siteId } = await aClient(host);
  const started = await admin.post("/api/scans").send({ clientId, target: `https://${host}/`, consent: true });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return { clientId, siteId, engagementId: started.body.backend.engagementId as number, ownTestId: started.body.test.id as string, ownScanId: started.body.test.findings.backendScanId as string, ownRunId: started.body.runId as string };
}

async function aBearer(): Promise<string> {
  const signedIn = await fetch(`${hybrid.url}/api/token/`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: TEST_ADMIN_PASSWORD }),
  });
  return ((await signedIn.json()) as { access: string }).access;
}

/** A scan started at the backend by someone other than this dashboard, under `engagementId`: the backend lists it, no row here names it. */
async function aScanStartedElsewhere(engagementId: number, url: string): Promise<{ uuid: string; runId: string | null }> {
  const answer = await fetch(`${hybrid.url}/api/pentest/scan/`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await aBearer()}` },
    body: JSON.stringify({ url, consent: true, engagement_id: engagementId, wait_seconds: 0 }),
  });
  expect([200, 202]).toContain(answer.status);
  const body = (await answer.json()) as { scan_id: string };
  const runId = hybrid.scans.get(body.scan_id)!.engine_run_id;
  return { uuid: body.scan_id, runId: runId === null ? null : String(runId) };
}

/** The backend's own collector collects a finished run into its record. */
async function collectedAtBackend(uuid: string): Promise<void> {
  const answer = await fetch(`${hybrid.url}/api/pentest/scans/${uuid}/collect/`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await aBearer()}` }, body: "{}",
  });
  expect(answer.status).toBe(200);
}

const adopt = (body?: Record<string, unknown>) => (body ? admin.post("/api/record/adopt").send(body) : admin.post("/api/record/adopt"));
const rowsNaming = async (scanId: string) => (await storage.getAllTests()).filter((one) => (one.findings as { backendScanId?: unknown } | null)?.backendScanId === scanId);

describe("the sync adopts every listed scan no row here names", () => {
  it("one row per scan: a pending record as running with the record's run, a completed one with the record's results, counts and snapshot; a second sync adopts nothing", async () => {
    const { clientId, siteId, engagementId, ownScanId } = await anEngagedClient();
    const pending = await aScanStartedElsewhere(engagementId, "https://acme.example/login");
    engine.control.completeNext = true;
    const completed = await aScanStartedElsewhere(engagementId, "https://acme.example/shop");
    expect(hybrid.scans.get(completed.uuid)!.status).toBe("completed");
    const before = (await storage.getAllTests()).length;

    const synced = await adopt();
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(synced.body).toMatchObject({ throttled: false, listed: 3, alreadyRecorded: 1, awaitingRun: 0, unlinked: 0, remaining: 0, detailUnread: [], writeFailed: null });
    expect(synced.body.adopted).toHaveLength(2);
    expect((await storage.getAllTests()).length).toBe(before + 2);
    // The scans list was read as the person; the completed scan's detail too, for its bytes; the pending one's was not needed.
    expect(hybrid.seen.filter((one) => one.method === "GET" && one.path === "/api/pentest/scans/").map((one) => one.account)).toEqual(["admin"]);
    expect(hybrid.seen.filter((one) => one.method === "GET" && one.path === `/api/pentest/scans/${completed.uuid}/`)).toHaveLength(1);
    expect(hybrid.seen.filter((one) => one.method === "GET" && one.path === `/api/pentest/scans/${pending.uuid}/`)).toHaveLength(0);
    expect(hybrid.seen.every((one) => one.stop === false)).toBe(true);

    // The pending record: running here, the record's run, source backend, the client whose engagement it is, its site at the host.
    const [runningRow] = await rowsNaming(pending.uuid);
    expect(runningRow).toMatchObject({ clientId, siteId, status: "running", testType: "penetration_test", completedAt: null, executedBy: null, vulnerabilitiesFound: 0 });
    expect(runningRow.findings).toMatchObject({
      runId: pending.runId, target: "https://acme.example/login", results: [], backendScanId: pending.uuid, backendEngagementId: engagementId, source: "backend",
    });
    expect(typeof (runningRow.findings as { adoptedAt?: unknown }).adoptedAt).toBe("string");
    expect(runningRow.summary).toBe(`https://acme.example/login — engine run ${pending.runId} · adopted from the Athena-Backend record`);

    // The completed record: its results and coverage, byte for byte, its counts, its snapshot; completed when the record was collected.
    const record = hybrid.scans.get(completed.uuid)!;
    const [doneRow] = await rowsNaming(completed.uuid);
    expect(doneRow).toMatchObject({ clientId, status: "completed", vulnerabilitiesFound: 1, highCount: 1, criticalCount: 0, severity: "high" });
    expect(doneRow.completedAt).toEqual(new Date(record.collected_at!));
    expect(JSON.stringify((doneRow.findings as { results: unknown }).results)).toBe(JSON.stringify(record.engine_response!.results));
    expect(JSON.stringify((doneRow.findings as { coverage: unknown }).coverage)).toBe(JSON.stringify(record.engine_response!.coverage));
    expect((doneRow.findings as { backend: unknown }).backend).toMatchObject({ status: "completed", verdict: record.verdict, verdictLabel: VERDICT_LABEL[record.verdict!], collectedAt: record.collected_at, detail: "" });
    expect(doneRow.findings).not.toHaveProperty("stop");
    // Read from the record by the status route, and the engine asked nothing about it.
    engine.calls.length = 0;
    const read = await admin.get(`/api/scans/${doneRow.id}`);
    expect(read.status).toBe(200);
    expect(read.body.state).toBe("completed");
    expect(read.body.engine.detail).toBe("the findings in the Athena-Backend record of this scan");
    expect(read.body.backend).toMatchObject({ collected: true, status: "completed", verdict: record.verdict });
    expect(engine.reads(completed.runId!)).toEqual([]);
    // Never into this dashboard's own ledger.
    expect(await storage.getFindingsByClient(clientId)).toEqual([]);
    // Logged as the sync's doing, for the person who asked.
    const logs = (await admin.get("/api/logs")).body as Array<{ action: string; entityId: string; details: Record<string, unknown> }>;
    expect(logs.filter((one) => one.action === "adopted_from_backend_record").map((one) => one.details.backendScanId).sort()).toEqual([completed.uuid, pending.uuid].sort());

    // Idempotent: nothing adopted twice, and the scan this dashboard launched never.
    hybrid.seen.length = 0;
    const again = await adopt();
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ adopted: [], alreadyRecorded: 3, listed: 3 });
    expect((await storage.getAllTests()).length).toBe(before + 2);
    expect(await rowsNaming(ownScanId)).toHaveLength(1);
    expect(await rowsNaming(pending.uuid)).toHaveLength(1);
  });

  it("storage refuses a second row for one backend scan, however it is attempted", async () => {
    const { clientId, engagementId } = await anEngagedClient("twice.example");
    const scan = await aScanStartedElsewhere(engagementId, "https://twice.example/");
    expect((await adopt()).body.adopted).toHaveLength(1);
    await expect(storage.createTest({
      clientId, testType: "penetration_test", status: "running",
      findings: { runId: "run-forged", target: "https://twice.example/", results: [], backendScanId: scan.uuid },
    })).rejects.toThrow(`a test already names backend scan ${scan.uuid}`);
    expect(await rowsNaming(scan.uuid)).toHaveLength(1);
  });

  it("a scan whose engagement no client here names is adopted with no client, and no client or site is made up for it", async () => {
    await anEngagedClient("linked.example");
    const outside = hybrid.addEngagement({ name: "Outside engagement", client_name: "Outside Co", scope_hosts: ["outside.example"] });
    const scan = await aScanStartedElsewhere(outside.id, "https://outside.example/");
    const clients = (await storage.getAllClients()).length;
    const sites = (await storage.getAllSites()).length;
    const synced = await adopt();
    expect(synced.body).toMatchObject({ unlinked: 1 });
    const [row] = await rowsNaming(scan.uuid);
    expect(row.clientId).toBeNull();
    expect(row.siteId).toBeNull();
    expect(row.findings).toMatchObject({ backendEngagementId: outside.id, source: "backend" });
    expect((await admin.get(`/api/tests/${row.id}`)).body.clientId).toBeNull();
    expect((await storage.getAllClients()).length).toBe(clients);
    expect((await storage.getAllSites()).length).toBe(sites);
  });

  it("a pending scan the engine has not named a run for waits: not adopted until the record names the run", async () => {
    const { engagementId } = await anEngagedClient("unnamed.example");
    engine.control.nameNoRunNext = true;
    const unnamed = await aScanStartedElsewhere(engagementId, "https://unnamed.example/");
    expect(unnamed.runId).toBeNull();
    const synced = await adopt();
    expect(synced.body).toMatchObject({ awaitingRun: 1 });
    expect(synced.body.adopted.map((one: { backendScanId: string }) => one.backendScanId)).not.toContain(unnamed.uuid);
    expect(await rowsNaming(unnamed.uuid)).toEqual([]);
  });

  it("a stopped record is adopted as aborted with no verdict and the record's words; a failed one as failed", async () => {
    const { engagementId } = await anEngagedClient("ended.example");
    const stopped = await aScanStartedElsewhere(engagementId, "https://ended.example/stopped");
    engine.finish(stopped.runId!, { state: "aborted", result: { results: [], detail: "aborted by operator" }, reason: "aborted by operator" });
    await collectedAtBackend(stopped.uuid);
    const failed = await aScanStartedElsewhere(engagementId, "https://ended.example/failed");
    engine.finish(failed.runId!, { state: "failed", result: { results: [], error: "the target closed the connection" }, reason: null });
    await collectedAtBackend(failed.uuid);
    expect((await adopt()).body.adopted).toHaveLength(2);
    const [stoppedRow] = await rowsNaming(stopped.uuid);
    expect(stoppedRow.status).toBe("aborted");
    expect((stoppedRow.findings as { backend: unknown }).backend).toMatchObject({ status: "stopped", verdict: null, verdictLabel: null, detail: "Stopped on the engine: aborted by operator" });
    const [failedRow] = await rowsNaming(failed.uuid);
    expect(failedRow.status).toBe("failed");
    expect((failedRow.findings as { backend: unknown }).backend).toMatchObject({ status: "failed", verdict: null, detail: "Failed on the engine: the target closed the connection" });
    // Neither offers a Stop, and neither is read from the engine again.
    engine.calls.length = 0;
    expect((await admin.get(`/api/scans/${stoppedRow.id}`)).body).toMatchObject({ state: "aborted", backend: { collected: true, status: "stopped", verdict: null } });
    expect(engine.reads(stopped.runId!)).toEqual([]);
  });
});

describe("a sync that cannot read the backend changes nothing", () => {
  it("is answered 'could not be read' with the backend's refusal, and writes no row", async () => {
    const { engagementId } = await anEngagedClient("refused.example");
    const scan = await aScanStartedElsewhere(engagementId, "https://refused.example/");
    const before = (await storage.getAllTests()).length;
    hybrid.controls.failNextScansList = { status: 500, body: { detail: "the scans table is locked" } };
    const synced = await adopt();
    expect(synced.status).toBe(500);
    expect(synced.body).toMatchObject({ couldNotBeRead: true, reason: "backend_refused", backendStatus: 500 });
    expect(synced.body.error).toMatch(/^The backend's scans list could not be read: .*the scans table is locked/);
    expect((await storage.getAllTests()).length).toBe(before);
    expect(await rowsNaming(scan.uuid)).toEqual([]);
    // Readable again: adopted now.
    expect((await adopt()).body.adopted.map((one: { backendScanId: string }) => one.backendScanId)).toContain(scan.uuid);
  });

  it("a person with no backend sign-in is told so, and nothing is sent", async () => {
    persons._resetPersonsForTests();
    try {
      hybrid.seen.length = 0;
      const synced = await adopt();
      expect(synced.status).toBe(503);
      expect(synced.body).toMatchObject({ reason: "backend_sign_in_required", code: "backend_sign_in_required", couldNotBeRead: true });
      expect(hybrid.seen).toEqual([]);
    } finally {
      await signInToBackend(admin);
    }
  });

  it("a sync within the interval answers the last one's outcome, throttled, and reads nothing", async () => {
    const { engagementId } = await anEngagedClient("interval.example");
    adoption.adoption.minIntervalMs = 60_000;
    const first = await adopt();
    expect(first.body.throttled).toBe(false);
    await aScanStartedElsewhere(engagementId, "https://interval.example/later");
    hybrid.seen.length = 0;
    const second = await adopt();
    expect(second.status).toBe(200);
    expect(second.body.throttled).toBe(true);
    expect(second.body.listed).toBe(first.body.listed);
    expect(hybrid.seen.filter((one) => one.method === "GET"), "nothing was read within the interval").toEqual([]);
  });
});

describe("an adopted running scan", () => {
  it("is adopted with no direct Stop; the first direct read that succeeds -- after the sync's answer -- brings the Stop; then it is stopped as every scan is", async () => {
    const { engagementId } = await anEngagedClient("live.example");
    const scan = await aScanStartedElsewhere(engagementId, "https://live.example/");
    engine.calls.length = 0; // the launch's own bounded read was the backend's
    const synced = await adopt();
    const adopted = synced.body.adopted.find((one: { backendScanId: string }) => one.backendScanId === scan.uuid) as { testId: string; engineRunId: string };
    expect(adopted).toMatchObject({ engineRunId: scan.runId, status: "running" });
    // The mark is cleared by the first direct read, sent after the answer: read by this dashboard's key, never the backend's.
    let row = await storage.getTest(adopted.testId);
    for (let i = 0; i < 100 && (row!.findings as { stop?: unknown }).stop === "backend"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      row = await storage.getTest(adopted.testId);
    }
    expect(row!.findings).not.toHaveProperty("stop");
    expect(engine.reads(scan.runId!).map((one) => one.key)).toEqual(["dashboard-key"]);
    // The live poll reads the run; the Stop is the engine's abort.
    const live = await admin.get(`/api/scans/${adopted.testId}`);
    expect(live.status).toBe(200);
    expect(live.body.state).toBe("running");
    expect(live.body.stop).toBeUndefined();
    expect(live.body.backend).toMatchObject({ scanId: scan.uuid, collected: null });
    const stopped = await admin.post(`/api/scans/${adopted.testId}/abort`);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ stopped: true, runId: scan.runId });
    expect(engine.aborts().map((one) => one.url)).toEqual([`/api/scans/${scan.runId}/abort`]);
  });

  it("keeps the mark while this dashboard's key cannot read the run (404): the page names the backend's Stop, and the Stop is back once a read succeeds", async () => {
    const { engagementId } = await anEngagedClient("tenant.example");
    engine.control.tenantBound = true;
    const scan = await aScanStartedElsewhere(engagementId, "https://tenant.example/");
    const synced = await adopt();
    const adopted = synced.body.adopted.find((one: { backendScanId: string }) => one.backendScanId === scan.uuid) as { testId: string };
    await new Promise((r) => setTimeout(r, 100));
    expect((await storage.getTest(adopted.testId))!.findings).toMatchObject({ stop: "backend" });
    const unread = await admin.get(`/api/scans/${adopted.testId}`);
    expect(unread.status).toBe(200);
    expect(unread.body.stop).toBe("backend");
    expect(unread.body.engine).toBeNull();
    // The key can read the run after all: the next read clears the mark.
    engine.control.tenantBound = false;
    const readable = await admin.get(`/api/scans/${adopted.testId}`);
    expect(readable.body.state).toBe("running");
    expect(readable.body.stop).toBeUndefined();
    expect((await storage.getTest(adopted.testId))!.findings).not.toHaveProperty("stop");
  });
});

describe("the run ids written are the record's alone", () => {
  it("ignores any run id the request names, and refuses a person's test carrying an adoption key", async () => {
    const { engagementId } = await anEngagedClient("forged.example");
    const scan = await aScanStartedElsewhere(engagementId, "https://forged.example/");
    const synced = await adopt({ runId: "forged-by-a-person", findings: { runId: "forged-by-a-person", backendScanId: scan.uuid } });
    expect(synced.status).toBe(200);
    const [row] = await rowsNaming(scan.uuid);
    expect((row.findings as { runId: unknown }).runId).toBe(scan.runId);
    expect((await storage.getAllTests()).some((one) => (one.findings as { runId?: unknown } | null)?.runId === "forged-by-a-person")).toBe(false);
    for (const findings of [{ source: "backend" }, { adoptedAt: new Date().toISOString() }]) {
      const refused = await admin.post("/api/tests").send({ clientId: (await storage.getAllClients())[0].id, testType: "manual", status: "pending", findings });
      expect(refused.status).toBe(400);
      expect(refused.body.message).toContain(`findings.${Object.keys(findings)[0]}`);
    }
  });
});

describe("no sync stands between an operator and a stop", () => {
  const KILL = { killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] };
  /** The answer, or `held` when none came while the list was held: the bound is the test's, the answers are what is waited on. */
  const raced = <T>(answer: Promise<T>) => Promise.race([answer, new Promise<"held">((r) => setTimeout(() => r("held"), 2_000))]);

  it("a Stop and the kill switch are each answered while a sync is held at the backend's list; the sync is answered after them", async () => {
    const { ownTestId, ownRunId, engagementId } = await anEngagedClient("held.example");
    const elsewhere = await aScanStartedElsewhere(engagementId, "https://held.example/elsewhere");
    expect((await adopt()).body.adopted.map((one: { backendScanId: string }) => one.backendScanId)).toContain(elsewhere.uuid);

    // A sync in flight, its list read held by the backend.
    hybrid.holdScansLists();
    const syncing = (async () => await adopt())();
    const heldList = await hybrid.waitFor((one) => one.method === "GET" && one.path === "/api/pentest/scans/" && one.status === 0);
    try {
      // The Stop of a scan started here: answered, the engine's abort sent, the list still held.
      const stopped = await raced(admin.post(`/api/scans/${ownTestId}/abort`));
      expect(stopped, "the Stop waited on the sync").not.toBe("held");
      expect((stopped as { status: number }).status).toBe(200);
      expect((stopped as { body: unknown }).body).toMatchObject({ stopped: true, runId: ownRunId });
      expect(heldList.status).toBe(0);
      // The kill switch: answered, every live run's stop sent -- the adopted one's among them -- the list still held.
      const killed = await raced(admin.patch("/api/ai-control").send(KILL));
      expect(killed, "the kill switch waited on the sync").not.toBe("held");
      expect((killed as { status: number }).status).toBe(200);
      expect(engine.aborts().map((one) => one.url)).toEqual(expect.arrayContaining([`/api/scans/${ownRunId}/abort`, `/api/scans/${elsewhere.runId}/abort`]));
      expect(heldList.status).toBe(0);
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
      hybrid.releaseScansLists();
    }
    const synced = await syncing;
    expect(synced.status).toBe(200);
    expect(synced.body.throttled).toBe(false);
  });
});
