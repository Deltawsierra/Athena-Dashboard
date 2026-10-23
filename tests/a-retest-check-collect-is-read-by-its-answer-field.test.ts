import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

/**
 * Athena-Backend records a retest's verdict as a RETEST CHECK, pulled from the
 * engine by the backend itself (athena-backend #189, owner decision 8), and
 * this dashboard asks it to (`POST /api/assurance/findings/<uuid>/retest-checks/
 * collect/` with `{run_id, twin_run_id}`, server/backend-scans.ts
 * collectRetestCheck). Two things are held here:
 *
 *   - the stand-in backend the hybrid's tests drive (tests/helpers/hybrid-
 *     backend-stand-in.ts) answers that route as the backend does, in its
 *     order: a viewer is refused before any lookup; a run already recorded is
 *     its row; ONE engine read, whose 404 is a 404 and whose silence is a 503
 *     with nothing written; a run still going is 202 and one that ended without
 *     a verdict is 200 with its honest phase, nothing written for either; every
 *     identity check passes or nothing is written (404 for a scan not in the
 *     record, 422 and 409 -- with the candidates -- for an identity that does not
 *     hold); then one row, unique on the run id, answered 201 with the check and
 *     the finding's UNCHANGED closure. A check is never closure evidence: the
 *     finding's status and closure are what they were, and the backend never
 *     launches anything for it;
 *   - the dashboard's client reads each answer by its own field, never from a
 *     shape: 201 and a 200 that carries the row are "recorded" (the second
 *     `existing`); 202 is "running"; a 200 that carries a phase is "not a
 *     verdict"; 400, 404, 409 and 422 are "not in the record", in the backend's
 *     words and with its candidates; 503 is "unavailable"; a 401 and a 403 are
 *     the person's own (sign-in required; refused), thrown as such.
 *
 * Nothing here is a stop path: the collect is a read of the engine and a write
 * of the backend's record, after the dashboard has filed the verdict itself.
 */

const TOKEN = "d".repeat(64);

type Run = { state: string; result: Record<string, unknown> | null; reason?: string };

/** An engine whose runs are what the test sets them to, recording every call. */
function stubEngine() {
  const calls: Array<{ method: string; url: string }> = [];
  const runs = new Map<string, Run>();
  const twins = new Map<string, Array<Record<string, unknown>>>();
  const control = { missing: new Set<string>(), twinsUnreachable: false };
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
      calls.push({ method: req.method ?? "GET", url });
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") return json(res, 200, { active: [] });
      if (req.method === "GET" && url.startsWith("/api/decisions?")) {
        if (control.twinsUnreachable) return void res.destroy();
        const runId = new URL(url, "http://engine").searchParams.get("run_id") ?? "";
        return json(res, 200, { tenant: "default", decisions: twins.get(runId) ?? [] });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = decodeURIComponent(url.slice("/api/scans/".length));
        const run = runs.get(id);
        if (!run || control.missing.has(id)) return json(res, 404, { detail: "No such scan run" });
        const done = !["queued", "running", "aborting"].includes(run.state);
        return json(res, 200, { run_id: id, state: run.state, done, result: run.result ?? {}, ...(run.reason ? { reason: run.reason } : {}) });
      }
      if (req.method === "POST" && url === "/api/scan") {
        next += 1;
        const id = `run-${next}`;
        runs.set(id, { state: "running", result: null });
        return json(res, 202, { run_id: id, state: "running" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  return { server, calls, runs, twins, control };
}

let engine: ReturnType<typeof stubEngine>;
let backend: HybridBackendStandIn;
let admin = "";
let analyst = "";
let viewer = "";
let engagementId = 0;
/** The hybrid scan of the record whose twin is retested, and its run. */
let scanId = "";
let scanRun = "";
const TARGET = "https://acme.example/";
const FINDING = "f-xss-1";

async function signIn(username: string, password: string): Promise<string> {
  const response = await fetch(`${backend.url}/api/token/`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access: string }).access;
}

async function call(method: string, path: string, init: { token?: string | null; body?: unknown } = {}) {
  const response = await fetch(`${backend.url}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body: body as Record<string, any> };
}

const collect = (token: string | null, finding: string, body: unknown) =>
  call("POST", `/api/assurance/findings/${finding}/retest-checks/collect/`, { token, body });

/** A retest run on the engine with the verdict `verdict` on twin 7 of the scan's run, as athena-engine #71 records it. */
function verdictRun(id: string, verdict: string, extra: Partial<Run> = {}, result: Record<string, unknown> = {}) {
  engine.runs.set(id, {
    state: "completed",
    result: {
      twin_id: 7, verdict, detail: `xss was ${verdict === "closed" ? "not " : ""}reported against ${TARGET}`, target: TARGET,
      finding_type: "xss", inventory_digest: "sha256:inv", run_id: id, scan_record_id: 502,
      check: { id: 1, twin_id: 7, verdict, run_id: 502, checked_at: "2026-10-23T04:00:00+00:00" },
      ...result,
    },
    ...extra,
  });
}

/** The check's fields exactly as #189's RetestCheckSerializer serves them. */
const SERIALIZED_FIELDS = [
  "collected_at", "collected_by", "detail", "engine_checked_at", "engine_run_id", "scan_record_id", "state", "stopped_after_recording",
  "twin_id", "twin_run_id", "verdict", "verdict_known",
];

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  backend = await hybridBackendStandIn({
    engine: { url: `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`, key: "ce_op_test" },
    serviceToken: TOKEN,
    assurance: true,
    accounts: {
      admin: { password: TEST_ADMIN_PASSWORD, role: "admin" },
      ann: { password: "ann-analyst-pw", role: "analyst" }, // pragma: allowlist secret
      vic: { password: "vic-viewer-pw", role: "viewer" }, // pragma: allowlist secret
    },
  });
  admin = await signIn("admin", TEST_ADMIN_PASSWORD);
  analyst = await signIn("ann", "ann-analyst-pw"); // pragma: allowlist secret
  viewer = await signIn("vic", "vic-viewer-pw"); // pragma: allowlist secret
  engagementId = backend.addEngagement({ name: "Acme — Shop", client_name: "Acme", scope_hosts: ["acme.example"] }).id;
  // The scan of the record the retested twin was listed under, launched through the stand-in as the backend launches.
  const launched = await call("POST", "/api/pentest/scan/", { token: admin, body: { url: TARGET, consent: true, engagement_id: engagementId, wait_seconds: 0 } });
  expect(launched.status, JSON.stringify(launched.body)).toBe(202);
  scanId = launched.body.scan_id as string;
  scanRun = launched.body.engine_run_id as string;
  engine.runs.set(scanRun, { state: "completed", result: { results: [{ type: "xss", severity: "high", url: `${TARGET}search` }] } });
  expect((await call("POST", `/api/pentest/scans/${scanId}/collect/`, { token: admin, body: {} })).status).toBe(200);
  engine.twins.set(scanRun, [{ id: 7, run_id: scanRun, target: TARGET, finding_type: "xss", inputs: { endpoint: `${TARGET}search` }, decision: { severity: "high" } }]);
  // Its ingest: the deployment under the engagement, and the one xss finding of it, from that scan.
  backend.addDeployment({ uuid: "d-shop", name: "Acme shop", engagement_id: engagementId });
  backend.addFinding({ uuid: FINDING, deployment_uuid: "d-shop", finding_type: "xss", title: "Reflected input on /search", severity: "high", scan_uuid: scanId, engine_run_id: scanRun, retest_required: true });
  // Another deployment, under another engagement, with its own xss finding: never this scan's.
  const other = backend.addEngagement({ name: "Other", client_name: "Other", scope_hosts: ["other.example"] }).id;
  backend.addDeployment({ uuid: "d-other", name: "Other", engagement_id: other });
  backend.addFinding({ uuid: "f-other-xss", deployment_uuid: "d-other", finding_type: "xss", scan_uuid: null, engine_run_id: null });
});

afterAll(async () => {
  await backend.close();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
});

beforeEach(() => {
  engine.calls.length = 0;
  engine.control.missing.clear();
  engine.control.twinsUnreachable = false;
  backend.seen.length = 0;
  backend.controls.engineUnreachable = false;
  backend.controls.failNextRetestCheckCollect = null;
  backend.releaseRetestCheckCollects();
  backend.retestChecks.clear();
  for (const one of backend.findings.values()) one.retest_checks.length = 0;
});

const nothingWritten = () => {
  expect(backend.retestChecks.size).toBe(0);
  expect(backend.findings.get(FINDING)!.retest_checks).toEqual([]);
};
const engineReadsOf = (runId: string) => engine.calls.filter((one) => one.method === "GET" && one.url === `/api/scans/${runId}`);

describe("the stand-in's retest-check collect: refusals before anything is read", () => {
  it("refuses a viewer before any lookup, a finding the person cannot see as not found, and a body that names no run id", async () => {
    verdictRun("rt-refused", "closed");
    expect((await collect(viewer, FINDING, { run_id: "rt-refused", twin_run_id: scanRun })).status).toBe(403);
    // The analyst sees no deployment of the admin's: the finding is not theirs to see.
    const unseen = await collect(analyst, FINDING, { run_id: "rt-refused", twin_run_id: scanRun });
    expect(unseen.status).toBe(404);
    expect(unseen.body).toEqual({ detail: "No Finding matches the given query." });
    expect((await collect(admin, "no-such-finding", { run_id: "rt-refused", twin_run_id: scanRun })).status).toBe(404);
    expect((await collect(null, FINDING, { run_id: "rt-refused", twin_run_id: scanRun })).status).toBe(401);
    const noRun = await collect(admin, FINDING, { twin_run_id: scanRun });
    expect(noRun.status).toBe(400);
    expect(noRun.body).toEqual({ run_id: "required: the engine's run id, a non-empty string" });
    const noTwinRun = await collect(admin, FINDING, { run_id: "rt-refused", twin_run_id: "" });
    expect(noTwinRun.status).toBe(400);
    expect(Object.keys(noTwinRun.body)).toEqual(["twin_run_id"]);
    const badId = await collect(admin, FINDING, { run_id: "../active", twin_run_id: scanRun });
    expect(badId.status).toBe(400);
    expect(badId.body.run_id).toMatch(/^not a run id this backend names to the engine/);
    expect(engineReadsOf("rt-refused"), "nothing was read from the engine for a refused request").toEqual([]);
    nothingWritten();
  });
});

describe("the stand-in's retest-check collect: the engine read, and a run without a verdict", () => {
  it("answers a run still going 202 and reads the engine once; nothing is written", async () => {
    engine.runs.set("rt-running", { state: "running", result: null });
    const answer = await collect(admin, FINDING, { run_id: "rt-running", twin_run_id: scanRun });
    expect(answer.status).toBe(202);
    expect(answer.body).toMatchObject({ phase: "running", state: "running", run_id: "rt-running", recorded: false });
    expect(answer.body.detail).toMatch(/still going on the engine: nothing was recorded/);
    expect(engineReadsOf("rt-running")).toHaveLength(1);
    nothingWritten();
  });

  it("answers a run that stopped, failed or ended without a verdict 200 with its honest phase; nothing is written", async () => {
    engine.runs.set("rt-stopped", { state: "aborted", result: { stopped: true, scan_incomplete: true }, reason: "aborted by operator" });
    engine.runs.set("rt-failed", { state: "failed", result: { error: "the scanner raised" } });
    engine.runs.set("rt-ended", { state: "completed", result: { results: [] } });
    for (const [runId, phase] of [["rt-stopped", "stopped"], ["rt-failed", "failed"], ["rt-ended", "ended_without_verdict"]] as const) {
      const answer = await collect(admin, FINDING, { run_id: runId, twin_run_id: scanRun });
      expect(answer.status, runId).toBe(200);
      expect(answer.body, runId).toMatchObject({ phase, run_id: runId, recorded: false });
      expect(answer.body.detail, runId).toMatch(/nothing was recorded/);
      expect(answer.body, runId).not.toHaveProperty("check");
    }
    nothingWritten();
  });

  it("answers 404 when the engine has no such run, and 503 with nothing written when the engine cannot be read", async () => {
    const gone = await collect(admin, FINDING, { run_id: "rt-gone", twin_run_id: scanRun });
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual({ detail: "the engine has no run rt-gone this backend can read", run_id: "rt-gone", recorded: false });
    verdictRun("rt-away", "closed");
    backend.controls.engineUnreachable = true;
    const away = await collect(admin, FINDING, { run_id: "rt-away", twin_run_id: scanRun });
    expect(away.status).toBe(503);
    expect(away.body).toMatchObject({ run_id: "rt-away", recorded: false, engine: "unreachable" });
    expect(away.body.detail).toMatch(/^Not recorded: the engine could not be read about retest run rt-away/);
    nothingWritten();
  });
});

describe("the stand-in's retest-check collect: identity, every check or nothing written", () => {
  it("404 for a twin run no scan of the record ran under; 422 for another deployment, another type, another host, a twin not listed; 409 for a type with two findings", async () => {
    verdictRun("rt-id", "closed");
    const notInRecord = await collect(admin, FINDING, { run_id: "rt-id", twin_run_id: "run-nobody-ran" });
    expect(notInRecord.status).toBe(404);
    expect(notInRecord.body).toMatchObject({ twin_run_id: "run-nobody-ran", recorded: false });
    expect(notInRecord.body.detail).toMatch(/^that scan is not in this record/);

    const otherDeployment = await collect(admin, "f-other-xss", { run_id: "rt-id", twin_run_id: scanRun });
    expect(otherDeployment.status).toBe(422);
    expect(otherDeployment.body.detail).toMatch(/another deployment than this finding's; nothing was written/);

    verdictRun("rt-type", "closed", {}, { finding_type: "sql_injection" });
    const otherType = await collect(admin, FINDING, { run_id: "rt-type", twin_run_id: scanRun });
    expect(otherType.status).toBe(422);
    expect(otherType.body).toMatchObject({ finding_type: "sql_injection", recorded: false });
    expect(otherType.body.detail).toBe("the verdict is of type 'sql_injection'; this finding is of type 'xss'; nothing was written");

    verdictRun("rt-host", "closed", {}, { target: "https://elsewhere.example/" });
    const otherHost = await collect(admin, FINDING, { run_id: "rt-host", twin_run_id: scanRun });
    expect(otherHost.status).toBe(422);
    expect(otherHost.body.detail).toBe("the verdict's target host 'elsewhere.example' is not the scan's ('acme.example'); nothing was written");

    verdictRun("rt-twin", "closed", {}, { twin_id: 99 });
    const notListed = await collect(admin, FINDING, { run_id: "rt-twin", twin_run_id: scanRun });
    expect(notListed.status).toBe(422);
    expect(notListed.body.detail).toBe(`the engine lists no twin 99 of type 'xss' under scan run ${scanRun}; nothing was written`);

    // A second xss finding in the deployment: the twin cannot be told to one of them.
    backend.addFinding({ uuid: "f-xss-2", deployment_uuid: "d-shop", finding_type: "xss", scan_uuid: scanId, engine_run_id: scanRun });
    try {
      const two = await collect(admin, FINDING, { run_id: "rt-id", twin_run_id: scanRun });
      expect(two.status).toBe(409);
      expect(two.body).toMatchObject({ finding_type: "xss", candidates: [FINDING, "f-xss-2"], recorded: false });
      expect(two.body.detail).toMatch(/^2 findings of type 'xss' are in that deployment/);
    } finally {
      backend.findings.delete("f-xss-2");
    }
    expect(engine.calls.filter((one) => one.method === "POST"), "the backend launches nothing for a collect").toEqual([]);
    nothingWritten();
  });
});

describe("the stand-in's retest-check collect: the row", () => {
  it("records a completed run's verdict once: 201 with the serializer's fields and the unchanged closure; a second collect is 200 with the same row; the lists carry it", async () => {
    verdictRun("rt-1", "closed");
    const finding = backend.findings.get(FINDING)!;
    const before = JSON.stringify({ status: finding.status, closure: finding.closure, retest_required: finding.retest_required, last_seen: finding.last_seen });
    const recorded = await collect(admin, FINDING, { run_id: "rt-1", twin_run_id: scanRun });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body.recorded).toBe(true);
    expect(Object.keys(recorded.body.check).sort()).toEqual(SERIALIZED_FIELDS);
    expect(recorded.body.check).toMatchObject({
      engine_run_id: "rt-1", scan_record_id: "502", twin_id: 7, twin_run_id: scanRun, verdict: "closed", verdict_known: true,
      state: "completed", stopped_after_recording: false, engine_checked_at: "2026-10-23T04:00:00+00:00", collected_by: "admin",
    });
    expect(recorded.body.check.detail).toMatch(/^xss was not reported against/);
    // Not closure evidence: the finding is what it was, and the answer carries that standing.
    expect(JSON.stringify({ status: finding.status, closure: finding.closure, retest_required: finding.retest_required, last_seen: finding.last_seen })).toBe(before);
    expect(recorded.body.closure).toMatchObject({ standing: "not_closable", reasons: ["no closure evidence recorded"] });
    // One engine read of the run, one of the twins; no launch, no retest.
    expect(engineReadsOf("rt-1")).toHaveLength(1);
    expect(engine.calls.filter((one) => one.url.startsWith("/api/decisions?"))).toHaveLength(1);
    expect(engine.calls.filter((one) => one.method === "POST")).toEqual([]);

    const again = await collect(admin, FINDING, { run_id: "rt-1", twin_run_id: scanRun });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ recorded: false, check: { engine_run_id: "rt-1", verdict: "closed" } });
    expect(engineReadsOf("rt-1"), "a run already recorded is not read again").toHaveLength(1);
    expect(backend.retestChecks.size).toBe(1);
    // The same run collected for another finding: refused, one row.
    const elsewhere = await collect(admin, "f-other-xss", { run_id: "rt-1", twin_run_id: scanRun });
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body.detail).toMatch(/already recorded as a retest check of another finding/);

    const listed = await call("GET", `/api/assurance/findings/${FINDING}/retest-checks/`, { token: admin });
    expect(listed.status).toBe(200);
    expect(listed.body.results.map((one: { engine_run_id: string }) => one.engine_run_id)).toEqual(["rt-1"]);
    const findings = await call("GET", "/api/assurance/findings/?deployment=d-shop", { token: admin });
    expect(findings.body.results.find((one: { uuid: string }) => one.uuid === FINDING).retest_checks).toHaveLength(1);
    expect((await call("GET", `/api/assurance/findings/${FINDING}/retest-checks/`, { token: analyst })).status).toBe(404);
  });

  it("records a verdict whose run was then stopped as aborted, stopped after recording; a verdict word it does not know is kept, verdict_known false", async () => {
    verdictRun("rt-aborted", "still_open", { state: "aborted", reason: "stopped by an operator" });
    const aborted = await collect(admin, FINDING, { run_id: "rt-aborted", twin_run_id: scanRun });
    expect(aborted.status).toBe(201);
    expect(aborted.body.check).toMatchObject({ verdict: "still_open", verdict_known: true, state: "aborted", stopped_after_recording: true });
    verdictRun("rt-word", "maybe");
    const word = await collect(admin, FINDING, { run_id: "rt-word", twin_run_id: scanRun });
    expect(word.status).toBe(201);
    expect(word.body.check).toMatchObject({ verdict: "maybe", verdict_known: false });
    // Newest first on the finding; the serializer's ten at most on the list.
    expect(backend.findings.get(FINDING)!.retest_checks.map((one) => one.engine_run_id)).toEqual(["rt-word", "rt-aborted"]);
  });
});

describe("the dashboard's client reads each answer by its own field", () => {
  let backendScans: typeof import("../server/backend-scans");
  let persons: typeof import("../server/person-credential");
  const SESSION = "session-of-the-admin";
  const VIEWER_SESSION = "session-of-the-viewer";

  beforeAll(async () => {
    process.env.ATHENA_FAILSAFE_URL = backend.url;
    vi.resetModules();
    backendScans = await import("../server/backend-scans");
    persons = await import("../server/person-credential");
    expect((await persons.signInPerson(SESSION, "admin", TEST_ADMIN_PASSWORD)).state).toBe("signed_in");
    expect((await persons.signInPerson(VIEWER_SESSION, "vic", "vic-viewer-pw")).state).toBe("signed_in"); // pragma: allowlist secret
  });
  afterAll(() => {
    persons._resetPersonsForTests();
    delete process.env.ATHENA_FAILSAFE_URL;
  });

  const asAdmin = (finding: string, runId: string, twinRunId = scanRun) =>
    persons.runAsPerson(SESSION, () => backendScans.collectRetestCheck(finding, { runId, twinRunId }));

  it("reads 201 as recorded (new), 200 with the row as recorded (existing), 202 as running, a phase as not a verdict", async () => {
    verdictRun("rt-c1", "closed");
    const recorded = await asAdmin(FINDING, "rt-c1");
    expect(recorded).toMatchObject({ answer: "recorded", status: 201, existing: false });
    if (recorded.answer !== "recorded") throw new Error("unreachable");
    expect(recorded.check).toEqual({
      engineRunId: "rt-c1", scanRecordId: "502", twinId: 7, twinRunId: scanRun, verdict: "closed", verdictKnown: true,
      detail: expect.stringMatching(/^xss was not reported/), state: "completed", stoppedAfterRecording: false,
      engineCheckedAt: "2026-10-23T04:00:00+00:00", collectedAt: expect.any(String), collectedBy: "admin",
    });
    expect(recorded.closure).toMatchObject({ standing: "not_closable" });
    expect(backend.retestCheckCollects().at(-1)).toMatchObject({ account: "admin", by: "bearer", stop: false, status: 201, json: { run_id: "rt-c1", twin_run_id: scanRun } });

    const existing = await asAdmin(FINDING, "rt-c1");
    expect(existing).toMatchObject({ answer: "recorded", status: 200, existing: true, check: { engineRunId: "rt-c1" } });

    engine.runs.set("rt-c-running", { state: "running", result: null });
    expect(await asAdmin(FINDING, "rt-c-running")).toMatchObject({ answer: "running", status: 202, phase: "running" });

    engine.runs.set("rt-c-stopped", { state: "aborted", result: { stopped: true }, reason: "aborted by operator" });
    const stopped = await asAdmin(FINDING, "rt-c-stopped");
    expect(stopped).toMatchObject({ answer: "not_a_verdict", status: 200, phase: "stopped" });
    if (stopped.answer === "not_a_verdict") expect(stopped.detail).toMatch(/stopped on the engine before its check was filed/);
  });

  it("reads 404, 409 and 422 as not in the record, in the backend's words and with its candidates; 400 as this dashboard's request refused", async () => {
    expect(await asAdmin(FINDING, "rt-c-gone")).toMatchObject({ answer: "not_in_record", status: 404, detail: "the engine has no run rt-c-gone this backend can read", candidates: [] });
    verdictRun("rt-c-id", "closed");
    expect(await asAdmin(FINDING, "rt-c-id", "run-nobody-ran")).toMatchObject({ answer: "not_in_record", status: 404, detail: expect.stringMatching(/^that scan is not in this record/) });
    backend.addFinding({ uuid: "f-xss-3", deployment_uuid: "d-shop", finding_type: "xss", scan_uuid: scanId, engine_run_id: scanRun });
    try {
      const two = await asAdmin(FINDING, "rt-c-id");
      expect(two).toMatchObject({ answer: "not_in_record", status: 409, candidates: [FINDING, "f-xss-3"] });
    } finally {
      backend.findings.delete("f-xss-3");
    }
    verdictRun("rt-c-type", "closed", {}, { finding_type: "sql_injection" });
    expect(await asAdmin(FINDING, "rt-c-type")).toMatchObject({ answer: "not_in_record", status: 422, detail: expect.stringMatching(/^the verdict is of type 'sql_injection'/) });
    const refusedRequest = await asAdmin(FINDING, "../active");
    expect(refusedRequest).toMatchObject({ answer: "not_in_record", status: 400 });
    if (refusedRequest.answer === "not_in_record") expect(refusedRequest.detail).toMatch(/^Athena-Backend refused this dashboard's request \(400\)/);
  });

  it("reads 503 as unavailable, a 403 as the person refused, and sends nothing for a person with no backend sign-in", async () => {
    verdictRun("rt-c-away", "closed");
    backend.controls.engineUnreachable = true;
    const away = await asAdmin(FINDING, "rt-c-away");
    expect(away).toMatchObject({ answer: "unavailable", status: 503, detail: expect.stringMatching(/^Not recorded: the engine could not be read/) });
    backend.controls.engineUnreachable = false;
    // An answer in no shape this reads: unavailable, never recorded.
    backend.controls.failNextRetestCheckCollect = { status: 200, body: { something: "else" } };
    const odd = await asAdmin(FINDING, "rt-c-away");
    expect(odd).toMatchObject({ answer: "unavailable", status: 200 });
    if (odd.answer === "unavailable") expect(odd.detail).toMatch(/in a shape this dashboard does not read/);

    let refused: unknown = null;
    try {
      await persons.runAsPerson(VIEWER_SESSION, () => backendScans.collectRetestCheck(FINDING, { runId: "rt-c-away", twinRunId: scanRun }));
    } catch (cause) {
      refused = cause;
    }
    const { ControlPlaneRefused, ControlPlaneSignInRequired } = await import("../server/control-plane");
    expect(refused).toBeInstanceOf(ControlPlaneRefused);
    expect((refused as { status: number }).status).toBe(403);

    backend.seen.length = 0;
    let unsigned: unknown = null;
    try {
      await persons.runAsPerson("no-such-session", () => backendScans.collectRetestCheck(FINDING, { runId: "rt-c-away", twinRunId: scanRun }));
    } catch (cause) {
      unsigned = cause;
    }
    // The person's missing sign-in, in the control plane's terms (server/control-plane.ts personFailure): raised before anything is sent.
    expect(unsigned).toBeInstanceOf(ControlPlaneSignInRequired);
    expect(backend.retestCheckCollects(), "nothing is sent without the person's credential").toEqual([]);
    expect(backend.retestChecks.size).toBe(0);
  });

  it("reads a check by its fields, and nothing that is not one", () => {
    expect(backendScans.readRetestCheck(null)).toBeNull();
    expect(backendScans.readRetestCheck({ verdict: "closed" })).toBeNull();
    expect(backendScans.readRetestCheck({ engine_run_id: 7, verdict: "closed", twin_id: "7", verdict_known: "yes" })).toEqual({
      engineRunId: "7", scanRecordId: null, twinId: null, twinRunId: null, verdict: "closed", verdictKnown: null, detail: null, state: null,
      stoppedAfterRecording: null, engineCheckedAt: null, collectedAt: null, collectedBy: null,
    });
  });
});
