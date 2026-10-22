import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";
import { judgeStop } from "./helpers/control-plane-stand-in";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

/**
 * The stand-in Athena-Backend the hybrid's tests launch through
 * (tests/helpers/hybrid-backend-stand-in.ts) answers the shapes PR-A pins
 * (athena-backend #188), so a dashboard that passes against it is reading
 * what the backend will send:
 *
 *   - the launch's refusals, in the backend's own words and order; the
 *     Idempotency-Key layer (a replay answers the first answer again, marked
 *     `Idempotent-Replayed`, and launches nothing; another request under the
 *     same key is 422; the same key while unanswered is 409 in flight);
 *   - `wait_seconds: 0` is exactly one engine read, then a 202 that names the
 *     run, its status url and its collect url; a run finished inside that read
 *     is a 200 with the result; a refusal, or a run that ended short of
 *     completed inside the read, is recorded failed and answered 502;
 *   - the list row is the detail without `engine_response`; the detail serves
 *     the pinned fields and never the recipient's e-mail or the preflight report;
 *   - collect answers 202 while the run goes on, 200 with the detail for every
 *     end it records (completed with a verdict; stopped, with no verdict, no
 *     PDF and "Stopped on the engine"; failed; the engine's 404 as failed), 409
 *     with the status when there is nothing to collect -- so a second collector
 *     writes nothing -- and 503 with the row untouched when the engine is away;
 *   - the stop route is a stop for every POST, taken on the failsafe service
 *     token, recorded on the row, and -- by default -- sends the engine stub no
 *     abort of its own, so the tests' counts of the stub's aborts stay the
 *     dashboard's.
 *
 * This file uses the stand-in alone; no other test does yet.
 */

const TOKEN = "c".repeat(64);

/** A stand-in engine whose runs stay running until told otherwise, recording every call and its Idempotency-Key. */
function stubEngine() {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown>; key: string | null }> = [];
  const runs = new Map<string, { state: string; result: Record<string, unknown>; reason?: string; error?: string }>();
  const control = {
    refuseLaunch: null as { status: number; body: unknown } | null,
    /** The next launch is answered 200 with this result: the run finished inline. */
    inlineResult: null as Record<string, unknown> | null,
    /** The next run the stub starts reads aborted, for this reason, from its first read. */
    abortNext: null as string | null,
    missing: new Set<string>(),
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
      const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null;
      calls.push({ method: req.method ?? "GET", url, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, key });
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") {
        return json(res, 200, { active: Array.from(runs, ([run_id, run]) => ({ run_id, target: null, kind: "scan", state: run.state })).filter((one) => one.state === "running") });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        const run = runs.get(abort[1]);
        if (!run) return json(res, 404, { detail: "No such scan run" });
        if (run.state !== "running") return json(res, 200, { run_id: abort[1], state: run.state, detail: "not running" });
        run.state = "aborted";
        run.reason = "stopped by an operator";
        return json(res, 200, { run_id: abort[1], state: "aborting" });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = url.split("/")[3];
        if (control.missing.has(id) || !runs.has(id)) return json(res, 404, { detail: "No such scan run" });
        const run = runs.get(id)!;
        return json(res, 200, {
          run_id: id, state: run.state, done: run.state !== "running", result: run.result,
          ...(run.reason ? { reason: run.reason } : {}), ...(run.error ? { error: run.error } : {}),
        });
      }
      if (req.method === "POST" && url === "/api/scan") {
        if (control.refuseLaunch) { const one = control.refuseLaunch; control.refuseLaunch = null; return json(res, one.status, one.body); }
        next += 1;
        const id = `run-${next}`;
        if (control.inlineResult) {
          const result = control.inlineResult;
          control.inlineResult = null;
          runs.set(id, { state: "completed", result });
          return json(res, 200, { run_id: id, state: "completed", result });
        }
        if (control.abortNext !== null) {
          runs.set(id, { state: "aborted", result: { results: [] }, reason: control.abortNext });
          control.abortNext = null;
        } else {
          runs.set(id, { state: "running", result: {} });
        }
        return json(res, 202, { run_id: id, state: "running", status_url: `/api/scans/${id}` });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  return {
    server, calls, runs, control,
    finish(id: string, result: Record<string, unknown>) { runs.set(id, { state: "completed", result }); },
    abort(id: string, reason: string, partial: Record<string, unknown> = {}) { runs.set(id, { state: "aborted", result: partial, reason }); },
    fail(id: string, error: string) { runs.set(id, { state: "failed", result: {}, error }); },
    launches: () => calls.filter((one) => one.method === "POST" && one.url === "/api/scan"),
    reads: () => calls.filter((one) => one.method === "GET" && /^\/api\/scans\/[^/]+$/.test(one.url) && one.url !== "/api/scans/active"),
    aborts: () => calls.filter((one) => one.url.endsWith("/abort")),
  };
}

let engine: ReturnType<typeof stubEngine>;
let backend: HybridBackendStandIn;
let admin = "";
let analyst = "";
let viewer = "";
let engagementId = 0;

async function signIn(username: string, password: string): Promise<string> {
  const response = await fetch(`${backend.url}/api/token/`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access: string }).access;
}

async function call(method: string, path: string, init: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${backend.url}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...(init.headers ?? {}),
    },
    ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: body as Record<string, unknown> & Record<string, any>, headers: response.headers, text };
}

const launch = (token: string, body: unknown, headers: Record<string, string> = {}) => call("POST", "/api/pentest/scan/", { token, body, headers });

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  backend = await hybridBackendStandIn({
    engine: { url: `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`, key: "ce_op_test" },
    serviceToken: TOKEN,
    accounts: {
      admin: { password: TEST_ADMIN_PASSWORD, role: "admin" },
      ann: { password: "ann-analyst-pw", role: "analyst" }, // pragma: allowlist secret
      vic: { password: "vic-viewer-pw", role: "viewer" }, // pragma: allowlist secret
    },
  });
  admin = await signIn("admin", TEST_ADMIN_PASSWORD);
  analyst = await signIn("ann", "ann-analyst-pw"); // pragma: allowlist secret
  viewer = await signIn("vic", "vic-viewer-pw"); // pragma: allowlist secret
  engagementId = backend.addEngagement({ name: "Acme — Shop [dashboard client c1]", client_name: "Acme", scope_hosts: ["acme.example"] }).id;
});

afterAll(async () => {
  await backend.close();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
});

beforeEach(() => {
  engine.calls.length = 0;
  engine.control.abortNext = null;
  engine.control.inlineResult = null;
  engine.control.refuseLaunch = null;
  backend.releaseLaunches();
  backend.releaseCollects();
  backend.seen.length = 0;
  backend.controls.engineUnreachable = false;
  backend.controls.failNextCollect = null;
  backend.controls.failNextLaunch = null;
  backend.controls.preflightRefusal = null;
  backend.controls.stopAbortsEngine = false;
});

const started = async (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
  const answer = await launch(admin, { url: "https://acme.example/", consent: true, engagement_id: engagementId, wait_seconds: 0, ...extra }, headers);
  expect(answer.status, JSON.stringify(answer.body)).toBe(202);
  return answer.body as { scan_id: string; engine_run_id: string };
};

describe("who the backend says the person is", () => {
  it("serves each account's role from its me route", async () => {
    expect((await call("GET", "/api/accounts/users/me/", { token: admin })).body).toMatchObject({ username: "admin", role: "admin" });
    expect((await call("GET", "/api/accounts/users/me/", { token: analyst })).body.role).toBe("analyst");
    expect((await call("GET", "/api/accounts/users/me/", { token: viewer })).body.role).toBe("viewer");
    expect((await call("GET", "/api/accounts/users/me/")).status).toBe(401);
  });
});

describe("engagements", () => {
  it("are created with the serializer's fields, visible to their creator and to admins, widened by PATCH, and a DELETE is recorded", async () => {
    const made = await call("POST", "/api/pentest/engagements/", {
      token: analyst,
      body: { name: "Ann's", client_name: "Ann Co", scope_hosts: ["ann.example"], status: "running", testing_window_start: "2026-10-01T00:00:00Z", testing_window_end: "2026-12-30T00:00:00Z" },
    });
    expect(made.status).toBe(201);
    expect(Object.keys(made.body).sort()).toEqual([
      "client_name", "created_at", "created_by", "id", "name", "scope_hosts", "scope_summary", "status", "testing_window_end", "testing_window_start", "updated_at",
    ]);
    expect(made.body).toMatchObject({ name: "Ann's", client_name: "Ann Co", status: "running", scope_hosts: ["ann.example"], created_by: "ann" });
    const id = made.body.id as number;

    expect((await call("GET", "/api/pentest/engagements/", { token: analyst })).body).toHaveLength(1);
    expect(((await call("GET", "/api/pentest/engagements/", { token: admin })).body as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect((await call("GET", `/api/pentest/engagements/${engagementId}/`, { token: analyst })).status, "another creator's engagement is not hers to see").toBe(404);
    expect((await call("GET", `/api/pentest/engagements/${id}/`, { token: viewer })).status).toBe(403);

    const widened = await call("PATCH", `/api/pentest/engagements/${id}/`, { token: analyst, body: { scope_hosts: ["ann.example", "api.ann.example"] } });
    expect(widened.status).toBe(200);
    expect(widened.body.scope_hosts).toEqual(["ann.example", "api.ann.example"]);
    expect(backend.seen.find((one) => one.method === "PATCH")!.stop, "a widening is not a stop").toBe(false);

    expect((await call("DELETE", `/api/pentest/engagements/${id}/`, { token: analyst })).status).toBe(204);
    expect(backend.deletes()).toHaveLength(1);
  });
});

describe("a launch's refusals, in the backend's words and order, before anything reaches the engine", () => {
  it.each([
    ["a viewer", (t: Record<string, string>) => [t.viewer, { url: "https://acme.example/", consent: true, engagement_id: 1 }], 403, "detail", "You do not have permission to perform this action."],
    ["no url", (t: Record<string, string>) => [t.admin, { consent: true, engagement_id: 1 }], 400, "error", "A valid target URL is required (http:// or https://)."],
    ["no consent", (t: Record<string, string>) => [t.admin, { url: "https://acme.example/", engagement_id: 1 }], 400, "error", "User consent required. Include 'consent': true."],
    ["wait_seconds out of range", (t: Record<string, string>) => [t.admin, { url: "https://acme.example/", consent: true, engagement_id: 1, wait_seconds: 601 }], 400, "error", "wait_seconds must be a number from 0 to 600."],
    ["wait_seconds not a number", (t: Record<string, string>) => [t.admin, { url: "https://acme.example/", consent: true, engagement_id: 1, wait_seconds: "0" }], 400, "error", "wait_seconds must be a number from 0 to 600."],
    ["no engagement", (t: Record<string, string>) => [t.admin, { url: "https://acme.example/", consent: true }], 403, "error", "engagement_id is required. A scan runs under a recorded engagement that names the authorised scope and testing window."],
    ["an engagement not theirs", (t: Record<string, string>) => [t.analyst, { url: "https://acme.example/", consent: true, engagement_id: 1 }], 403, "error", "No such engagement."],
    ["a host outside the scope", (t: Record<string, string>) => [t.admin, { url: "https://other.example/", consent: true, engagement_id: 1 }], 403, "error", "other.example is not in the authorised scope for 'Acme — Shop [dashboard client c1]'."],
  ] as Array<[string, (t: Record<string, string>) => [string, unknown], number, string, string]>)("%s", async (_name, make, status, field, words) => {
    const [token, body] = make({ admin, analyst, viewer });
    const answer = await launch(token, body);
    expect(answer.status).toBe(status);
    expect(answer.body[field]).toBe(words);
    expect(engine.launches(), "nothing reached the engine").toEqual([]);
  });

  it("an engagement not running, or outside its window, refuses in the backend's words", async () => {
    const paused = backend.addEngagement({ name: "Paused one", scope_hosts: ["acme.example"], status: "paused" });
    expect((await launch(admin, { url: "https://acme.example/", consent: true, engagement_id: paused.id })).body.error)
      .toBe("Engagement 'Paused one' is paused, so testing is not authorised. Set it to running first.");
    const closed = backend.addEngagement({ name: "Closed one", scope_hosts: ["acme.example"], testing_window_end: new Date(Date.now() - 1000).toISOString() });
    expect((await launch(admin, { url: "https://acme.example/", consent: true, engagement_id: closed.id })).body.error)
      .toBe("Engagement 'Closed one' is outside its authorised testing window.");
    const dateless = backend.addEngagement({ name: "No window", scope_hosts: ["acme.example"], testing_window_start: null, testing_window_end: null });
    expect((await launch(admin, { url: "https://acme.example/", consent: true, engagement_id: dateless.id })).body.error)
      .toBe("Engagement 'No window' is outside its authorised testing window.");
    expect(engine.launches()).toEqual([]);
  });

  it("a preflight refusal is 409 with the backend's error and its report", async () => {
    backend.controls.preflightRefusal = "the routes changed since approval";
    const answer = await launch(admin, { url: "https://acme.example/", consent: true, engagement_id: engagementId });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe("This engine is not the deployment that was approved: the routes changed since approval");
    expect(answer.body).toHaveProperty("assurance");
    expect(engine.launches()).toEqual([]);
  });
});

describe("a launch with wait_seconds 0", () => {
  it("creates the row, launches on the engine with the scan's own key, reads the run exactly once, and answers 202 naming the run", async () => {
    const answer = await launch(admin, { url: "https://acme.example/", consent: true, engagement_id: engagementId, wait_seconds: 0, recipient_email: "reports@acme.example" }, { "Idempotency-Key": "press-1" });
    expect(answer.status).toBe(202);
    expect(Object.keys(answer.body).sort()).toEqual(["collect_url", "detail", "engine_run_id", "scan_id", "status", "status_url"]);
    const scanId = answer.body.scan_id as string;
    expect(answer.body).toMatchObject({
      status: "pending", engine_run_id: "run-1", status_url: `/api/pentest/scans/${scanId}/`, collect_url: `/api/pentest/scans/${scanId}/collect/`,
    });
    expect(answer.headers.get("Idempotent-Replayed")).toBeNull();
    const [sent] = engine.launches();
    expect(sent.body).toMatchObject({ target: "https://acme.example/", scope: ["acme.example"], wait_seconds: 0 });
    expect(sent.key, "the launch to the engine carries the scan's own key, not the press's").toBe(scanId);
    expect(engine.reads().map((one) => one.url), "exactly one engine read, then the 202").toEqual(["/api/scans/run-1"]);

    const detail = (await call("GET", `/api/pentest/scans/${scanId}/`, { token: admin })).body;
    expect(detail).toMatchObject({ uuid: scanId, status: "pending", engine_run_id: "run-1", verdict: null, verdict_label: null, pdf_url: null, collected_at: null, email_sent: false });
    expect(detail).not.toHaveProperty("recipient_email");
    expect(detail).not.toHaveProperty("assurance");
    expect(backend.scans.get(scanId)!.recipient_email, "the recipient is stored for the collect, and never served").toBe("reports@acme.example");
  });

  it("replays the first answer for the same key and request without a second launch, and refuses the key for another request", async () => {
    const first = await launch(admin, { url: "https://acme.example/", consent: true, engagement_id: engagementId, wait_seconds: 0 }, { "Idempotency-Key": "press-2" });
    expect(first.status).toBe(202);
    const launchesBefore = engine.launches().length;
    const again = await launch(admin, { url: "https://acme.example/", consent: true, engagement_id: engagementId, wait_seconds: 0 }, { "Idempotency-Key": "press-2" });
    expect(again.status).toBe(202);
    expect(again.body).toEqual(first.body);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(engine.launches().length, "a replay launches nothing").toBe(launchesBefore);
    const other = await launch(admin, { url: "https://acme.example/other", consent: true, engagement_id: engagementId, wait_seconds: 0 }, { "Idempotency-Key": "press-2" });
    expect(other.status).toBe(422);
    expect(other.body.idempotency).toEqual({ state: "done" });
    // Another account's press with the same key is its own.
    const theirs = await launch(analyst, { url: "https://acme.example/", consent: true, engagement_id: engagementId, wait_seconds: 0 }, { "Idempotency-Key": "press-2" });
    expect(theirs.status, "the analyst cannot see the admin's engagement, so the key is scoped to the account").toBe(403);
  });

  it("answers the same key 409 in flight while the first send is unanswered", async () => {
    backend.holdLaunches();
    const firstSend = launch(admin, { url: "https://acme.example/", consent: true, engagement_id: engagementId, wait_seconds: 0 }, { "Idempotency-Key": "press-3" });
    await backend.waitFor((one) => one.path === "/api/pentest/scan/" && one.idempotencyKey === "press-3");
    const second = await launch(admin, { url: "https://acme.example/", consent: true, engagement_id: engagementId, wait_seconds: 0 }, { "Idempotency-Key": "press-3" });
    expect(second.status).toBe(409);
    expect(second.body.idempotency).toEqual({ state: "in_flight" });
    backend.releaseLaunches();
    expect((await firstSend).status).toBe(202);
  });

  it("answers 200 with the result when the engine finished the run inside the read, the verdict derived from its findings", async () => {
    engine.control.inlineResult = { results: [{ type: "sqli", severity: "critical" }], coverage: { complete: true, checks: [] } };
    const answer = await launch(admin, { url: "https://acme.example/", consent: true, engagement_id: engagementId, wait_seconds: 0, recipient_email: "r@acme.example" });
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body).sort()).toEqual(["result", "scan_id"]);
    expect(answer.body.result).toEqual({ results: [{ type: "sqli", severity: "critical" }], coverage: { complete: true, checks: [] } });
    const detail = (await call("GET", `/api/pentest/scans/${answer.body.scan_id}/`, { token: admin })).body;
    expect(detail).toMatchObject({ status: "completed", verdict: "BLOCKED", verdict_label: "Not recommended for production", pdf_url: `/api/pentest/scans/${answer.body.scan_id}/pdf/`, email_sent: true });
    expect(detail.collected_at).toBeTruthy();
    expect((await call("GET", `/api/pentest/scans/${answer.body.scan_id}/pdf/`, { token: admin })).status).toBe(200);
  });

  it("records a refused launch failed and answers 502 with the engine's words relayed", async () => {
    engine.control.refuseLaunch = { status: 409, body: { detail: "the target is a loopback address" } };
    const answer = await launch(admin, { url: "https://acme.example/", consent: true, engagement_id: engagementId, wait_seconds: 0 });
    expect(answer.status).toBe(502);
    expect(answer.body).toMatchObject({ status: "failed", error: "Scan refused: the target is a loopback address", engine_run_id: null });
    expect((await call("GET", `/api/pentest/scans/${answer.body.scan_id}/`, { token: admin })).body.status).toBe("failed");
  });

  it("records a run that ended short of completed inside the read as failed, 502 'Scan aborted'", async () => {
    // The stub's next run reads aborted from the backend's one read of it.
    engine.control.abortNext = "killed at once";
    const answer = await launch(admin, { url: "https://acme.example/", consent: true, engagement_id: engagementId, wait_seconds: 0 });
    expect(answer.status).toBe(502);
    expect(answer.body.status).toBe("failed");
    expect(answer.body.error).toBe("Scan aborted: Stopped on the engine: killed at once");
    expect(answer.body.engine_run_id).toMatch(/^run-/);
    expect((await call("GET", `/api/pentest/scans/${answer.body.scan_id}/`, { token: admin })).body).toMatchObject({ status: "failed", verdict: null, pdf_url: null });
  });

  it("answers failNextLaunch as given, for a dashboard test that needs a timeout-free 5xx", async () => {
    backend.controls.failNextLaunch = { status: 500, body: "" };
    expect((await launch(admin, { url: "https://acme.example/", consent: true, engagement_id: engagementId, wait_seconds: 0 })).status).toBe(500);
  });
});

describe("the list, the detail and the collect", () => {
  it("lists the detail's fields without engine_response, newest first, visible to the person", async () => {
    const { scan_id } = await started();
    const list = (await call("GET", "/api/pentest/scans/", { token: admin })).body as { count: number; results: Array<Record<string, unknown>> };
    expect(list.results[0].uuid).toBe(scan_id);
    expect(list.results[0]).not.toHaveProperty("engine_response");
    expect(Object.keys(list.results[0]).sort()).toEqual([
      "collected_at", "consent", "created_at", "email_sent", "engagement", "engine_run_id", "error_message", "id", "pdf_url", "status", "stop", "target_url", "user", "uuid", "verdict", "verdict_label",
    ]);
    expect((await call("GET", "/api/pentest/scans/", { token: analyst })).body.count).toBe(0);
    expect((await call("GET", `/api/pentest/scans/${scan_id}/`, { token: analyst })).status).toBe(404);
  });

  it("collects a running run as pending, a finished run as completed with its verdict and PDF, and refuses a second collect with the status", async () => {
    const { scan_id, engine_run_id } = await started();
    const pending = await call("POST", `/api/pentest/scans/${scan_id}/collect/`, { token: admin, body: {} });
    expect(pending.status).toBe(202);
    expect(pending.body).toEqual({ scan_id, status: "pending", engine_run_id, detail: "still running" });

    engine.finish(engine_run_id, { results: [{ type: "xss", severity: "medium" }], coverage: { complete: false, checks: [{ check: "xss", state: "performed" }] } });
    const collected = await call("POST", `/api/pentest/scans/${scan_id}/collect/`, { token: admin, body: {} });
    expect(collected.status).toBe(200);
    expect(collected.body).toMatchObject({
      uuid: scan_id, status: "completed", verdict: "READY_RESTRICTED", verdict_label: "Ready with restrictions", engine_run_id,
      pdf_url: `/api/pentest/scans/${scan_id}/pdf/`, error_message: null,
      engine_response: { results: [{ type: "xss", severity: "medium" }], coverage: { complete: false, checks: [{ check: "xss", state: "performed" }] } },
      engagement: { id: engagementId, name: "Acme — Shop [dashboard client c1]", client_name: "Acme", status: "running" },
    });
    expect(collected.body.collected_at).toBeTruthy();

    const again = await call("POST", `/api/pentest/scans/${scan_id}/collect/`, { token: admin, body: {} });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ status: "completed" });
    expect(typeof again.body.detail).toBe("string");
    expect((await call("POST", `/api/pentest/scans/${scan_id}/collect/`, { token: viewer, body: {} })).status).toBe(403);
    expect((await call("GET", `/api/pentest/scans/${scan_id}/pdf/`, { token: admin })).status).toBe(200);
  });

  it("records a stopped run as stopped: no verdict, no PDF, the partial response kept, 'Stopped on the engine'", async () => {
    const { scan_id, engine_run_id } = await started();
    engine.abort(engine_run_id, "operator pressed Stop", { results: [{ type: "early", severity: "low" }] });
    const collected = await call("POST", `/api/pentest/scans/${scan_id}/collect/`, { token: admin, body: {} });
    expect(collected.status).toBe(200);
    expect(collected.body).toMatchObject({
      status: "stopped", verdict: null, verdict_label: null, pdf_url: null, error_message: "Stopped on the engine: operator pressed Stop",
      engine_response: { results: [{ type: "early", severity: "low" }] },
    });
    const pdf = await call("GET", `/api/pentest/scans/${scan_id}/pdf/`, { token: admin });
    expect(pdf.status).toBe(409);
    expect(pdf.body).toEqual({ error: "This scan is stopped, so there is no report to render.", detail: "Stopped on the engine: operator pressed Stop" });
  });

  it("records a failed run, and a run the engine has forgotten, as failed with the reason", async () => {
    const one = await started();
    engine.fail(one.engine_run_id, "the scanner raised");
    expect((await call("POST", `/api/pentest/scans/${one.scan_id}/collect/`, { token: admin, body: {} })).body).toMatchObject({
      status: "failed", verdict: null, error_message: "Failed on the engine: the scanner raised",
    });
    const two = await started();
    engine.control.missing.add(two.engine_run_id);
    expect((await call("POST", `/api/pentest/scans/${two.scan_id}/collect/`, { token: admin, body: {} })).body).toMatchObject({
      status: "failed", verdict: null, error_message: `the engine has no run ${two.engine_run_id}`,
    });
  });

  it("answers 503 and leaves the row pending when the engine cannot be reached", async () => {
    const { scan_id } = await started();
    backend.controls.engineUnreachable = true;
    const away = await call("POST", `/api/pentest/scans/${scan_id}/collect/`, { token: admin, body: {} });
    expect(away.status).toBe(503);
    expect(typeof away.body.detail).toBe("string");
    expect((await call("GET", `/api/pentest/scans/${scan_id}/`, { token: admin })).body.status).toBe("pending");
  });
});

describe("an upstream control plane behind the stand-in", () => {
  it("is sent every request this stand-in does not serve, and an unknown account's sign-in, whose token is then taken here", async () => {
    const upstreamSeen: Array<{ method: string; path: string; token: string | undefined }> = [];
    const upstream = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        upstreamSeen.push({ method: req.method ?? "", path: req.url ?? "", token: req.headers["x-failsafe-service-token"] as string | undefined });
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url === "/api/token/") return res.end(JSON.stringify({ access: "upstream-access", refresh: "upstream-refresh" }));
        res.end(JSON.stringify({ engine_id: "engine-1", awaiting_signatures: [], ready: [], recent: [], body: raw }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const fronted = await hybridBackendStandIn({
      engine: { url: `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}` },
      serviceToken: TOKEN, upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      accounts: { admin: { password: TEST_ADMIN_PASSWORD, role: "admin" } },
    });
    try {
      const state = await fetch(`${fronted.url}/api/failsafe/state/`, { headers: { "X-Failsafe-Service-Token": TOKEN } });
      expect(state.status).toBe(200);
      expect((await state.json() as { engine_id: string }).engine_id).toBe("engine-1");
      expect(upstreamSeen).toEqual([{ method: "GET", path: "/api/failsafe/state/", token: TOKEN }]);

      // The test's own service account signs in upstream; its token is a bearer here too.
      const signedIn = await fetch(`${fronted.url}/api/token/`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "svc", password: "svc" }),
      });
      expect(await signedIn.json()).toEqual({ access: "upstream-access", refresh: "upstream-refresh" });
      const me = await fetch(`${fronted.url}/api/accounts/users/me/`, { headers: { Authorization: "Bearer upstream-access" } });
      expect(me.status).toBe(200);
      expect((await me.json() as { username: string; role: string })).toMatchObject({ username: "svc", role: "admin" });
      // The stand-in's own accounts still sign in here, not upstream.
      const own = await fetch(`${fronted.url}/api/token/`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: TEST_ADMIN_PASSWORD }),
      });
      expect(own.status).toBe(200);
      expect(upstreamSeen.filter((one) => one.path === "/api/token/")).toHaveLength(1);
    } finally {
      await fronted.close();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });
});

describe("the stop route", () => {
  it("is a stop for every POST: taken on the service token, recorded on the row, and sends the engine no abort of its own", async () => {
    const { scan_id, engine_run_id } = await started();
    engine.calls.length = 0;
    expect(judgeStop("POST", `/api/pentest/scans/${scan_id}/stop/`, JSON.stringify({ reason: "x" }), () => undefined)).toBe(true);
    const stopped = await call("POST", `/api/pentest/scans/${scan_id}/stop/`, { body: { reason: "stopped from the dashboard" }, headers: { "X-Failsafe-Service-Token": TOKEN } });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ scan_id, status: "pending", engine_run_id, stop: { state: "delivered" }, stop_saved: true });
    const sent = backend.stops()[0];
    expect(sent.by).toBe("service token");
    expect(sent.stop).toBe(true);
    expect(sent.account).toBe("svc-failsafe");
    expect(engine.aborts(), "the dashboard's direct abort is the stop; the stand-in sends none by default").toEqual([]);
    expect((await call("GET", `/api/pentest/scans/${scan_id}/`, { token: admin })).body.stop).toEqual({ state: "delivered", detail: "the engine answered that the run had already ended" });
  });

  it("without the token, a person's bearer stops their own scan; a wrong token is refused outright", async () => {
    const { scan_id } = await started();
    expect((await call("POST", `/api/pentest/scans/${scan_id}/stop/`, { token: admin, body: { reason: "x" } })).status).toBe(200);
    expect((await call("POST", `/api/pentest/scans/${scan_id}/stop/`, { body: { reason: "x" }, headers: { "X-Failsafe-Service-Token": "wrong" } })).status).toBe(401);
    expect((await call("POST", `/api/pentest/scans/${scan_id}/stop/`, { token: analyst, body: { reason: "x" } })).status, "not hers to see").toBe(404);
  });

  it("sends the engine an abort of its own only when asked to (stopAbortsEngine)", async () => {
    const { scan_id, engine_run_id } = await started();
    backend.controls.stopAbortsEngine = true;
    engine.calls.length = 0;
    expect((await call("POST", `/api/pentest/scans/${scan_id}/stop/`, { body: { reason: "x" }, headers: { "X-Failsafe-Service-Token": TOKEN } })).status).toBe(200);
    expect(engine.aborts().map((one) => one.url)).toEqual([`/api/scans/${engine_run_id}/abort`]);
  });
});
