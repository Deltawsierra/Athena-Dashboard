import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The typed client for Athena-Backend's pentest routes (server/backend-scans.ts)
 * reads every answer by its own field and never guesses from a shape:
 *
 *   - a launch's 202 is `status: "pending"` naming the run, with the backend's
 *     `status_url` and `collect_url`, and is never done; a 200 carries the
 *     finished run under `result`; a 502 is the engine's refusal relayed; a 4xx
 *     is the backend's refusal, quoted verbatim -- its `detail` or its `error`;
 *   - a 409 or 422 about the Idempotency-Key is about the key, never "refused";
 *     a launch sent and not answered -- a timeout, a 5xx, a shape it does not
 *     read -- may have started a run, and is said so (BackendLaunchUnanswered);
 *   - the press key goes as `Idempotency-Key`; `consent: true` and
 *     `wait_seconds: 0` go on every launch; `recipient_email` only when given;
 *   - the person's role is read from the backend's own `me` route;
 *   - an engagement is created running, widened by PATCH, and never narrowed
 *     here (refused before anything is sent); a 404 is the backend's refusal;
 *   - collect's 202 / 200 / 409 / 503 are four answers, each its own;
 *   - the stop mirror presents the failsafe service token first (`stop: true`),
 *     falls back to the person's credential only when that attempt failed, and
 *     never throws -- a mirror's failure is a fact, never a stop's failure.
 *
 * Everything that is not a stop goes as the signed-in person (T6): the stand-in
 * here names the account each request was made as.
 */

const TOKEN = "a".repeat(32) + "b".repeat(32);
const SCAN = "11111111-2222-4333-8444-555555555555";
const ENV = ["ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD", "ATHENA_FAILSAFE_SERVICE_TOKEN"];

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | "hold";
interface Seen { method: string; path: string; body: Record<string, unknown> | null; raw: string; key: string | null; serviceToken: string | null; account: string | null; by: "service token" | "bearer" | null }

// The stand-in's accounts: fixtures of this test alone, no install is seeded with them.
const ACCOUNTS: Record<string, { password: string; role: string }> = {
  alice: { password: "alice-pw", role: "admin" }, // pragma: allowlist secret
  viewer: { password: "viewer-pw", role: "viewer" }, // pragma: allowlist secret
  svc: { password: "svc-pw", role: "admin" }, // pragma: allowlist secret
};

function standIn() {
  const seen: Seen[] = [];
  const held: ServerResponse[] = [];
  const access = new Map<string, string>();
  const engagements = new Map<number, Record<string, unknown>>();
  let nextEngagement = 100;
  let issued = 0;
  const settings = {
    acceptServiceToken: true,
    launch: ((): Answer => ({ status: 202, body: { scan_id: SCAN, status: "pending", engine_run_id: "run-1", detail: "the engine named the run", status_url: `/api/pentest/scans/${SCAN}/`, collect_url: `/api/pentest/scans/${SCAN}/collect/` } })) as (seen: Seen) => Answer,
    collect: ((): Answer => ({ status: 202, body: { scan_id: SCAN, status: "pending", engine_run_id: "run-1", detail: "still running" } })) as () => Answer,
    detail: ((): Answer => ({ status: 200, body: record() })) as () => Answer,
    list: ((): Answer => ({ status: 200, body: { count: 1, next: null, previous: null, results: [{ ...record(), engine_response: undefined }] } })) as () => Answer,
    pdf: ((): Answer => ({ status: 200 })) as () => Answer,
  };
  const record = () => ({
    uuid: SCAN, target_url: "https://k.example/", consent: true, status: "completed", verdict: "READY", verdict_label: "Ready for deployment",
    created_at: "2026-10-22T09:00:00Z", collected_at: "2026-10-22T09:05:00Z", engine_run_id: "run-1",
    stop: { state: "none", detail: null }, engine_response: { results: [{ type: "x", severity: "low" }], coverage: { complete: true, checks: [] } },
    pdf_url: `/api/pentest/scans/${SCAN}/pdf/`, email_sent: false, error_message: null,
    engagement: { id: 100, name: "Acme — Shop [dashboard client c1]", client_name: "Acme", status: "running" },
  });
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stand-in");
      const path = url.pathname;
      const method = req.method ?? "GET";
      let body: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(raw || "null") as unknown;
        body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      const header = (name: string) => {
        const value = req.headers[name];
        return Array.isArray(value) ? value.join(", ") : value ?? null;
      };
      const presented = header("x-failsafe-service-token");
      const authorization = header("authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
      const entry: Seen = { method, path, body, raw, key: header("idempotency-key"), serviceToken: presented, account: null, by: null };
      seen.push(entry);
      const json = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      const answer = (one: Answer) => {
        if (one === "hold") { held.push(res); return; }
        if (one.status === 200 && one.body === undefined && path.endsWith("/pdf/")) {
          res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="pentest_${SCAN}.pdf"` });
          res.end("%PDF-1.4 stand-in");
          return;
        }
        json(one.status, one.body, one.headers ?? {});
      };

      if (path === "/api/token/" && method === "POST") {
        const username = String(body?.username ?? "");
        entry.account = username || null;
        const account = ACCOUNTS[username];
        if (!account || account.password !== body?.password) return json(401, { detail: "No active account found with the given credentials" });
        issued += 1;
        const pair = { access: `access-${username}-${issued}`, refresh: `refresh-${username}-${issued}` };
        access.set(pair.access, username);
        return json(200, pair);
      }
      const stopRoute = /^\/api\/pentest\/scans\/[^/]+\/stop\/$/.test(path) && method === "POST";
      const withdrawal = /^\/api\/pentest\/engagements\/\d+\/$/.test(path) && method === "PATCH" && typeof body?.status === "string" && body.status !== "running";
      if ((stopRoute || withdrawal) && presented !== null && settings.acceptServiceToken && presented === TOKEN) {
        entry.by = "service token";
        entry.account = "svc-failsafe";
      } else if (bearer !== null && access.has(bearer)) {
        entry.by = "bearer";
        entry.account = access.get(bearer)!;
      } else {
        return json(401, { detail: "Authentication credentials were not provided." });
      }
      const who = entry.account!;

      if (path === "/api/accounts/users/me/") return json(200, { id: 1, username: who, email: `${who}@example.test`, role: ACCOUNTS[who]?.role ?? "viewer" });
      if (path === "/api/pentest/engagements/" && method === "GET") return json(200, Array.from(engagements.values()));
      if (path === "/api/pentest/engagements/" && method === "POST") {
        nextEngagement += 1;
        const made = {
          id: nextEngagement, name: body?.name ?? "", client_name: body?.client_name ?? null, scope_summary: null, status: body?.status ?? "planned",
          testing_window_start: body?.testing_window_start ?? null, testing_window_end: body?.testing_window_end ?? null,
          created_by: 1, created_at: "2026-10-22T09:00:00Z", updated_at: "2026-10-22T09:00:00Z", scope_hosts: body?.scope_hosts ?? [],
        };
        engagements.set(nextEngagement, made);
        return json(201, made);
      }
      const engagement = /^\/api\/pentest\/engagements\/(\d+)\/$/.exec(path);
      if (engagement) {
        const found = engagements.get(Number(engagement[1]));
        if (!found) return json(404, { detail: "Engagement not found." });
        if (method === "PATCH") {
          if (entry.by === "bearer" && who === "svc" && withdrawal) return json(403, { detail: "the service account may not withdraw it" });
          const next = { ...found, ...(body ?? {}) };
          engagements.set(Number(engagement[1]), next);
          return json(200, next);
        }
        return json(200, found);
      }
      if (path === "/api/pentest/scan/" && method === "POST") return answer(settings.launch(entry));
      if (path === "/api/pentest/scans/" && method === "GET") return answer(settings.list());
      if (stopRoute) {
        if (entry.by === "bearer" && who === "svc") return json(403, { detail: "the service account may not stop it" });
        return json(200, { scan_id: SCAN, status: "pending", engine_run_id: "run-1", stop: { state: "delivered", detail: "had already ended" }, stop_saved: true });
      }
      if (/^\/api\/pentest\/scans\/[^/]+\/collect\/$/.test(path) && method === "POST") return answer(settings.collect());
      if (/^\/api\/pentest\/scans\/[^/]+\/pdf\/$/.test(path)) return answer(settings.pdf());
      if (/^\/api\/pentest\/scans\/[^/]+\/$/.test(path)) return answer(settings.detail());
      return json(404, { detail: "Not found." });
    });
  });
  return {
    server, seen, settings, engagements,
    close: async () => {
      for (const res of held) res.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

let backend: ReturnType<typeof standIn>;
let client: typeof import("../server/backend-scans");
let persons: typeof import("../server/person-credential");
let plane: typeof import("../server/control-plane");

beforeAll(async () => {
  backend = standIn();
  await new Promise<void>((r) => backend.server.listen(0, "127.0.0.1", r));
  process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${(backend.server.address() as AddressInfo).port}`;
  process.env.ATHENA_FAILSAFE_USER = "svc";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc-pw"; // pragma: allowlist secret
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = TOKEN;
  vi.resetModules();
  client = await import("../server/backend-scans");
  persons = await import("../server/person-credential");
  plane = await import("../server/control-plane");
  await persons.signInPerson("sess-alice", "alice", "alice-pw"); // pragma: allowlist secret
  await persons.signInPerson("sess-viewer", "viewer", "viewer-pw"); // pragma: allowlist secret
});

afterEach(() => {
  backend.seen.length = 0;
  backend.settings.acceptServiceToken = true;
  client.launchTimeouts.launchMs = 25_000;
  plane._resetForTests();
});

afterAll(async () => {
  for (const name of ENV) delete process.env[name];
  await backend.close();
});

const asAlice = <T>(fn: () => Promise<T>) => persons.runAsPerson("sess-alice", fn);
const launch = (extra: Partial<Parameters<typeof client.launchScan>[0]> = {}) =>
  asAlice(() => client.launchScan({ url: "https://k.example/", engagementId: 100, consent: true, idempotencyKey: "athena-dashboard:deadbeef", ...extra }));

describe("a launch", () => {
  it("goes as the person with consent, wait_seconds 0 and the press key, and a 202 is pending, never done", async () => {
    const answer = await launch();
    expect(answer).toEqual({
      answer: "pending", scanId: SCAN, engineRunId: "run-1", detail: "the engine named the run",
      statusUrl: `/api/pentest/scans/${SCAN}/`, collectUrl: `/api/pentest/scans/${SCAN}/collect/`, replayed: false,
    });
    const sent = backend.seen.find((one) => one.path === "/api/pentest/scan/")!;
    expect(sent.account).toBe("alice");
    expect(sent.by).toBe("bearer");
    expect(sent.key).toBe("athena-dashboard:deadbeef");
    expect(sent.serviceToken).toBeNull();
    expect(sent.body).toEqual({ url: "https://k.example/", consent: true, engagement_id: 100, wait_seconds: 0 });
  });

  it("sends recipient_email only when the person opted in", async () => {
    await launch({ recipientEmail: "reports@k.example" });
    expect(backend.seen.find((one) => one.path === "/api/pentest/scan/")!.body).toMatchObject({ recipient_email: "reports@k.example" });
    backend.seen.length = 0;
    await launch({ recipientEmail: null });
    expect(backend.seen.find((one) => one.path === "/api/pentest/scan/")!.body).not.toHaveProperty("recipient_email");
  });

  it("reads a replayed answer as the first send's", async () => {
    backend.settings.launch = () => ({
      status: 202, headers: { "Idempotent-Replayed": "true" },
      body: { scan_id: SCAN, status: "pending", engine_run_id: "run-1", detail: "replayed" },
    });
    const answer = await launch();
    expect(answer.answer).toBe("pending");
    expect(answer.replayed).toBe(true);
  });

  it("reads a 200 as the finished run, naming the run from the result when the answer does not", async () => {
    backend.settings.launch = () => ({ status: 200, body: { scan_id: SCAN, result: { run_id: "run-7", results: [{ type: "x", severity: "low" }] } } });
    const answer = await launch();
    expect(answer).toMatchObject({ answer: "completed", scanId: SCAN, engineRunId: "run-7", replayed: false });
    expect((answer as { result: unknown }).result).toEqual({ run_id: "run-7", results: [{ type: "x", severity: "low" }] });
  });

  it("reads a 502 as the engine's refusal relayed, in the backend's words", async () => {
    backend.settings.launch = () => ({ status: 502, body: { scan_id: SCAN, status: "failed", error: "Scan refused: the target is a loopback address", engine_run_id: null } });
    expect(await launch()).toEqual({ answer: "failed", scanId: SCAN, error: "Scan refused: the target is a loopback address", engineRunId: null, replayed: false });
  });

  it.each([
    [400, { error: "User consent required. Include 'consent': true." }, "User consent required. Include 'consent': true."],
    [403, { error: "Engagement 'Acme' is outside its authorised testing window." }, "Engagement 'Acme' is outside its authorised testing window."],
    [404, { detail: "Engagement not found." }, "Engagement not found."],
    [409, { error: "This engine is not the deployment that was approved: x" }, "This engine is not the deployment that was approved: x"],
  ])("quotes a %s refusal verbatim, detail or error", async (status, body, words) => {
    backend.settings.launch = () => ({ status, body });
    expect(await launch()).toEqual({ answer: "refused", status, detail: words, replayed: false });
  });

  it("reads an answer about the key as about the key: in flight or unknown is unanswered, another request is a bug", async () => {
    backend.settings.launch = () => ({ status: 409, body: { detail: "the first send is still being answered", idempotency: { state: "in_flight" } } });
    await expect(launch()).rejects.toMatchObject({ name: "Error", state: "in_flight", status: 409 });
    await expect(launch()).rejects.toBeInstanceOf(client.BackendLaunchUnanswered);
    backend.settings.launch = () => ({ status: 422, body: { detail: "Idempotency-Key reused for another request", idempotency: { state: "done" } } });
    await expect(launch()).rejects.toBeInstanceOf(client.BackendKeyRefused);
  });

  it("says a launch sent and not answered may have started: a 5xx, a shape it does not read, a timeout", async () => {
    backend.settings.launch = () => ({ status: 500 });
    await expect(launch()).rejects.toBeInstanceOf(client.BackendLaunchUnanswered);
    backend.settings.launch = () => ({ status: 202, body: { status: "pending" } });
    await expect(launch()).rejects.toBeInstanceOf(client.BackendLaunchUnanswered);
    backend.settings.launch = () => ({ status: 200, body: { scan_id: SCAN } });
    await expect(launch()).rejects.toBeInstanceOf(client.BackendLaunchUnanswered);
    client.launchTimeouts.launchMs = 300;
    backend.settings.launch = () => "hold";
    const before = Date.now();
    await expect(launch()).rejects.toBeInstanceOf(client.BackendLaunchUnanswered);
    expect(Date.now() - before).toBeLessThan(5_000);
    expect(backend.seen.some((one) => one.path === "/api/pentest/scan/"), "the launch was sent").toBe(true);
  });

  it("is not sent at all for a person with no backend sign-in", async () => {
    await expect(persons.runAsPerson(null, () => client.launchScan({ url: "https://k.example/", engagementId: 100, consent: true })))
      .rejects.toBeInstanceOf(plane.ControlPlaneSignInRequired);
    expect(backend.seen.filter((one) => one.path === "/api/pentest/scan/")).toEqual([]);
  });
});

describe("the person and the engagements", () => {
  it("reads the person's role from the backend's own me route", async () => {
    expect(await asAlice(() => client.whoAmI())).toEqual({ id: 1, username: "alice", email: "alice@example.test", role: "admin" });
    expect((await persons.runAsPerson("sess-viewer", () => client.whoAmI())).role).toBe("viewer");
  });

  it("creates an engagement running with both window dates, widens its scope, and never narrows it here", async () => {
    const start = new Date("2026-10-22T09:00:00.000Z");
    const end = new Date("2027-01-20T09:00:00.000Z");
    const made = await asAlice(() => client.createEngagement({
      name: "Acme — Shop [dashboard client c1]", clientName: "Acme", scopeHosts: ["shop.acme.test"], testingWindowStart: start, testingWindowEnd: end,
    }));
    expect(backend.seen.find((one) => one.method === "POST" && one.path === "/api/pentest/engagements/")!.body).toEqual({
      name: "Acme — Shop [dashboard client c1]", client_name: "Acme", scope_hosts: ["shop.acme.test"], status: "running",
      testing_window_start: start.toISOString(), testing_window_end: end.toISOString(),
    });
    expect(made).toMatchObject({ name: "Acme — Shop [dashboard client c1]", clientName: "Acme", status: "running", scopeHosts: ["shop.acme.test"] });
    expect(made.testingWindowStart).toBe(start.toISOString());

    const widened = await asAlice(() => client.patchEngagement(made, { scopeHosts: ["shop.acme.test", "api.acme.test"] }));
    expect(widened.scopeHosts).toEqual(["shop.acme.test", "api.acme.test"]);
    const patch = backend.seen.find((one) => one.method === "PATCH")!;
    expect(patch.body).toEqual({ scope_hosts: ["shop.acme.test", "api.acme.test"] });
    expect(patch.serviceToken, "widening is not a stop").toBeNull();

    backend.seen.length = 0;
    await expect(asAlice(() => client.patchEngagement(widened, { scopeHosts: ["shop.acme.test"] }))).rejects.toThrow(/narrow/);
    expect(backend.seen, "nothing was sent for a narrowing").toEqual([]);

    expect((await asAlice(() => client.getEngagement(made.id))).id).toBe(made.id);
    expect((await asAlice(() => client.listEngagements())).map((one) => one.id)).toContain(made.id);
    await expect(asAlice(() => client.getEngagement(999))).rejects.toMatchObject({ status: 404 });
  });

  it("withdraws an engagement's authority as a stop: the service token, never a DELETE", async () => {
    const made = await asAlice(() => client.createEngagement({
      name: "Gone", clientName: "Gone", scopeHosts: ["gone.test"], testingWindowStart: new Date(), testingWindowEnd: new Date(Date.now() + 1000),
    }));
    backend.seen.length = 0;
    const outcome = await asAlice(() => client.withdrawEngagement(made.id));
    expect(outcome).toMatchObject({ mirrored: true, via: "stop credential" });
    const sent = backend.seen.find((one) => one.method === "PATCH")!;
    expect(sent.body).toEqual({ status: "completed" });
    expect(sent.by).toBe("service token");
    expect(backend.seen.some((one) => one.method === "DELETE")).toBe(false);
  });
});

describe("the record", () => {
  it("reads a scan's record, its list row, and the results and coverage the record holds", async () => {
    const record = await asAlice(() => client.readScan(SCAN));
    expect(record).toMatchObject({
      uuid: SCAN, status: "completed", verdict: "READY", verdictLabel: "Ready for deployment", engineRunId: "run-1",
      collectedAt: "2026-10-22T09:05:00Z", pdfUrl: `/api/pentest/scans/${SCAN}/pdf/`, errorMessage: null,
      engagement: { id: 100, name: "Acme — Shop [dashboard client c1]", clientName: "Acme", status: "running" },
    });
    expect(client.recordResults(record)).toEqual([{ type: "x", severity: "low" }]);
    expect(client.recordCoverage(record)).toEqual({ complete: true, checks: [] });
    const nested = client.readRecord({ uuid: SCAN, status: "completed", engine_response: { result: { results: [], coverage: { complete: false } } } })!;
    expect(client.recordResults(nested)).toEqual([]);
    expect(client.recordCoverage(nested)).toEqual({ complete: false });
    expect(client.recordResults(client.readRecord({ uuid: SCAN, status: "pending", engine_response: null })!)).toBeNull();

    const rows = await asAlice(() => client.listScans());
    expect(rows).toEqual([{ uuid: SCAN, targetUrl: "https://k.example/", status: "completed", createdAt: "2026-10-22T09:00:00Z", engineRunId: "run-1" }]);
  });

  it("reads each of collect's four answers as its own", async () => {
    expect(await asAlice(() => client.collectScan(SCAN))).toEqual({ answer: "pending", detail: "still running" });
    backend.settings.collect = () => ({ status: 200, body: { uuid: SCAN, status: "stopped", verdict: null, verdict_label: null, error_message: "Stopped on the engine: operator", engine_run_id: "run-1" } });
    const collected = await asAlice(() => client.collectScan(SCAN));
    expect(collected.answer).toBe("collected");
    expect((collected as { record: { status: string; errorMessage: string | null } }).record).toMatchObject({ status: "stopped", errorMessage: "Stopped on the engine: operator" });
    backend.settings.collect = () => ({ status: 409, body: { detail: "the scan is completed, not pending", status: "completed" } });
    expect(await asAlice(() => client.collectScan(SCAN))).toEqual({ answer: "conflict", detail: "the scan is completed, not pending" });
    backend.settings.collect = () => ({ status: 503, body: { detail: "the engine could not be reached" } });
    expect(await asAlice(() => client.collectScan(SCAN))).toEqual({ answer: "unavailable", status: 503, detail: "the engine could not be reached" });
    expect(backend.seen.filter((one) => one.path.endsWith("/collect/")).every((one) => one.account === "alice" && one.serviceToken === null)).toBe(true);
  });

  it("fetches the PDF as the person and passes the answer on as it is", async () => {
    const response = await asAlice(() => client.fetchPdf(SCAN));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(await response.text()).toBe("%PDF-1.4 stand-in");
    backend.settings.pdf = () => ({ status: 409, body: { error: "This scan is stopped, so there is no report to render.", detail: "Stopped on the engine: operator" } });
    expect((await asAlice(() => client.fetchPdf(SCAN))).status).toBe(409);
  });
});

describe("the stop mirror", () => {
  it("presents the failsafe service token and is taken on it, with no person's credential", async () => {
    const outcome = await persons.runAsPerson(null, () => client.mirrorStop(SCAN, "stopped from the Athena page"));
    expect(outcome).toEqual({ mirrored: true, via: "stop credential", status: 200, detail: "" });
    const sent = backend.seen.filter((one) => one.path === `/api/pentest/scans/${SCAN}/stop/`);
    expect(sent).toHaveLength(1);
    expect(sent[0].by).toBe("service token");
    expect(sent[0].serviceToken).toBe(TOKEN);
    expect(sent[0].body).toEqual({ reason: "stopped from the Athena page" });
    expect(backend.seen.filter((one) => one.path === "/api/token/"), "no sign-in was waited on").toEqual([]);
  });

  it("falls back to the person only after the stop credential was refused, and says so", async () => {
    backend.settings.acceptServiceToken = false;
    const outcome = await asAlice(() => client.mirrorStop(SCAN, "stopped"));
    expect(outcome).toMatchObject({ mirrored: true, via: "person", status: 200 });
    expect(outcome.detail).toContain("taken as the person");
    const stops = backend.seen.filter((one) => one.path === `/api/pentest/scans/${SCAN}/stop/`);
    // The token first (refused), the service account's bearer (refused), then the person.
    expect(stops.map((one) => one.by)).toEqual([null, "bearer", "bearer"]);
    expect(stops.map((one) => one.account)).toEqual([null, "svc", "alice"]);
  });

  it("never throws: both refused is a fact for the log, not a stop's failure", async () => {
    backend.settings.acceptServiceToken = false;
    const outcome = await persons.runAsPerson(null, () => client.mirrorStop(SCAN, "stopped"));
    expect(outcome.mirrored).toBe(false);
    expect(outcome.via).toBeNull();
    expect(outcome.detail).toContain("stop credential");
    expect(outcome.detail).toContain("sent as the person");
  });
});
