// @vitest-environment jsdom
/**
 * The scan pages show Athena-Backend's record of a scan started through it
 * (client/src/components/BackendRecordPanel.tsx) in its three states and
 * never a fourth guessed; the Tests screen pins each row's record source; the
 * Clients page shows each client's backend engagement and renews its testing
 * window only by a person's confirmed act.
 *
 *   - while the run goes on: "Not yet in the Athena-Backend record for this
 *     run.", the hybrid source line, the coverage line "not yet in the record",
 *     no verdict, no PDF link, and the Stop where it always was;
 *   - once collected: the record's status word, verdict and label, the
 *     engagement line, the PDF link to this dashboard's relay (only because the
 *     record has a report), and the coverage line swapped to the record's;
 *   - a run stopped from here: "No verdict: the run did not finish." with the
 *     record's error message, no PDF link, and the Stop's mirror reading;
 *   - a run this dashboard's engine key could not read: NoStopPanel's backend
 *     variant in place of the Stop, and the Stop back once a read succeeds;
 *   - the recipient's e-mail is sent only when the person opted in;
 *   - Tests: "Backend record: <label>" / "Backend record: pending" for a hybrid
 *     row, the dashboard-direct wording for a scan this dashboard dispatched
 *     itself, nothing for a person's test;
 *   - Clients: the engagement id and window from the record, "No backend
 *     engagement yet" when there is none, and Renew / extend behind a confirm
 *     step that sends nothing until confirmed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";
import Tests from "@/pages/Tests";
import Deployments from "@/pages/Deployments";
import { queryClient } from "@/lib/queryClient";
import {
  COLLECTING, MIRRORED, NOT_YET_IN_RECORD, NO_ENGAGEMENT_YET, NO_VERDICT_DID_NOT_FINISH, NO_WINDOW_YET, RECORD_PENDING_PILL,
  RENEW_CONFIRM_BODY, recordPill,
} from "@/lib/backendRecordCopy";
import { COVERAGE_RECORD_PENDING, COVERAGE_SOURCE, DASHBOARD_DIRECT, HYBRID_SOURCE, coverageSourceFromRecord } from "@/lib/sourceLabels";
import { summarizeFindings } from "../server/findings-summary";
import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

const TOKEN = "c3".repeat(32);
const RESULTS = [{ type: "sql_injection", severity: "high", url: "https://labelled.example/login", message: "a quoted parameter reached the query", details: null }];
const COVERAGE = { complete: true, checks: [{ check: "sql_injection", team: "web", state: "performed" }], not_performed: [], degraded: [], unmeasured: [], limitations: {}, notes: [] };

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

type Run = { state: string; result: Record<string, unknown> | null; reason: string | null };
const runs = new Map<string, Run>();
const control = { tenantBound: false };
let engine: Server;
let hybrid: HybridBackendStandIn;
let server: Server;
let base: string;
let session: string;
let clientId: string;
let next = 0;

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;

  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = req.url ?? "";
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") {
        return json(res, 200, { active: Array.from(runs).filter(([, run]) => run.state === "running").map(([run_id]) => ({ run_id, target: "", kind: "scan", state: "running" })) });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        const run = runs.get(abort[1]);
        if (!run) return json(res, 404, { detail: "No such scan run" });
        if (run.state !== "running") return json(res, 200, { run_id: abort[1], state: run.state, detail: "not running" });
        Object.assign(run, { state: "aborted", reason: "aborted by operator", result: { results: [], detail: "aborted by operator" } });
        return json(res, 200, { run_id: abort[1], state: "aborting" });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = decodeURIComponent(url.slice("/api/scans/".length));
        const run = runs.get(id);
        if (!run || (control.tenantBound && req.headers["x-api-key"] === "dashboard-key")) return json(res, 404, { detail: "No such scan run" });
        return json(res, 200, { run_id: id, state: run.state, done: run.state !== "running", result: run.result ?? {}, ...(run.reason ? { reason: run.reason } : {}) });
      }
      if (req.method === "POST" && url === "/api/scan") {
        next += 1;
        runs.set(`run-${next}`, { state: "running", result: null, reason: null });
        return json(res, 202, { run_id: `run-${next}`, state: "running" });
      }
      return json(res, 404, { detail: "not here" });
    });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  const engineUrl = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_URL = engineUrl;
  process.env.ATHENA_ENGINE_KEY = "dashboard-key";
  hybrid = await hybridBackendStandIn({ engine: { url: engineUrl, key: "backend-key" }, serviceToken: TOKEN });
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = TOKEN;
  vi.resetModules();
  const app = await makeApp();
  (await import("../server/collect-watch")).collectWatch.intervalMs = 25;
  const agent = await signIn(app);
  await signInToBackend(agent);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: TEST_ADMIN_PASSWORD }),
  });
  expect(login.status).toBe(200);
  session = (login.headers.get("set-cookie") ?? "").split(";")[0];
  // The browser's own session signs in to the backend too (the console's sign-in does it in the background).
  const backendSignIn = await fetch(`${base}/api/auth/backend-sign-in`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: session }, body: JSON.stringify({ password: TEST_ADMIN_PASSWORD }),
  });
  expect(backendSignIn.status).toBe(200);
  clientId = (await agent.post("/api/clients").send({ name: "Labelled", company: "Labelled Co", email: "l@l.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://labelled.example" });
});
afterAll(async () => {
  for (const name of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_SERVICE_TOKEN"]) delete process.env[name];
  const { storage } = await import("../server/storage-unified");
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
  await hybrid.close();
  engine.closeAllConnections?.();
  server.closeAllConnections?.();
  await new Promise<void>((r) => engine.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
  control.tenantBound = false;
  hybrid.seen.length = 0;
});

/** Every request a page sends goes to the real routes, as the signed-in admin. */
function realRoutes() {
  const outbound = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/")) return outbound(url, init);
    return outbound(`${base}${url}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), Cookie: session },
    });
  });
}

/** A page over a seeded cache: every source answers from `seed`, and any other read is an error, never a loading state. */
function mountSeeded(ui: ReactElement, seed: Array<[unknown[], unknown]>) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); },
      },
    },
  });
  for (const [k, v] of seed) client.setQueryData(k, v);
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Start a scan from the mounted page; answers once the page shows it running. */
async function startFromPage() {
  await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
  await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
  fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
  fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://labelled.example/login" } });
  fireEvent.click(screen.getByTestId("checkbox-consent"));
  await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("button-start-scan"));
  await waitFor(() => expect(screen.getByTestId("text-state").textContent).toContain("running"), { timeout: 6_000 });
  const launch = hybrid.launches().at(-1)!;
  const scanId = (launch.json && typeof launch.json === "object" ? null : null) ?? Array.from(hybrid.scans.keys()).at(-1)!;
  const scan = hybrid.scans.get(scanId)!;
  return { scanId, runId: String(scan.engine_run_id) };
}

const COMMON_SEED: Array<[unknown[], unknown]> = [
  [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
  [["/api/auth/check"], { authenticated: true, user: { id: "u1", username: "admin", role: "admin" } }],
];

for (const [name, Screen] of [["Athena", AthenaScan], ["Penetration testing", PentestScan]] as const) {
  describe(`${name}: the backend record beside the live view`, () => {
    it("is not asked yet while the run goes on, and is the record -- verdict, engagement, report, coverage source -- once collected", async () => {
      realRoutes();
      render(<QueryClientProvider client={queryClient}><Screen /></QueryClientProvider>);
      const { scanId, runId } = await startFromPage();
      expect(screen.getByTestId("text-scan-source").textContent).toBe(`${HYBRID_SOURCE}.`);
      await waitFor(() => expect(screen.getByTestId("panel-backend-record")).toBeTruthy(), { timeout: 6_000 });
      expect(screen.getByTestId("text-backend-record-state").textContent).toBe(NOT_YET_IN_RECORD);
      // PR #74's direct line stands, with the note that the record is not collected yet beneath it.
      expect(screen.getByTestId("text-coverage-source").textContent).toBe(COVERAGE_SOURCE);
      expect(screen.getByTestId("text-coverage-record").textContent).toBe(COVERAGE_RECORD_PENDING);
      expect(screen.queryByTestId("text-backend-verdict")).toBeNull();
      expect(screen.queryByTestId("link-backend-pdf")).toBeNull();
      expect(screen.getByTestId("button-stop-scan")).toBeTruthy();
      expect(document.body.textContent ?? "").not.toMatch(/legacy|backend will record|deployment assurance/i);

      // The run ends; the next poll sees it and the record is collected.
      runs.set(runId, { state: "completed", result: { results: RESULTS, coverage: COVERAGE }, reason: null });
      await waitFor(() => expect(screen.getByTestId("text-backend-verdict")).toBeTruthy(), { timeout: 10_000 });
      const record = hybrid.scans.get(scanId)!;
      expect(record.status).toBe("completed");
      expect(screen.getByTestId("text-backend-status").textContent).toBe("completed");
      expect(screen.getByTestId("text-backend-verdict").textContent).toContain(record.verdict);
      expect(screen.getByTestId("text-backend-engagement").textContent).toMatch(/^Backend engagement #\d+ · deployment .+ · labelled\.example$/);
      expect((screen.getByTestId("link-backend-pdf") as HTMLAnchorElement).getAttribute("href")).toMatch(/^\/api\/scans\/[^/]+\/backend-pdf$/);
      expect(screen.getByTestId("text-coverage-source").textContent).toBe(coverageSourceFromRecord(runId));
      expect(screen.queryByTestId("text-coverage-record")).toBeNull();
      expect(screen.queryByTestId("text-backend-differs")).toBeNull();
      // The pill carries the backend's own label for its verdict (the stand-in's, as the real serializer's verdict_label), never a word of the page's.
      expect(record.verdict).toBe("NEEDS_REMEDIATION");
      expect(screen.getByTestId("pill-backend-record").textContent).toBe("Requires remediation");
      expect(screen.getByTestId("text-backend-verdict").textContent).toBe("Verdict: NEEDS_REMEDIATION — Requires remediation");
    }, 30_000);
  });
}

describe("Athena: a run that did not finish, and one no direct Stop reaches", () => {
  it("stopped from here: no verdict, the record's error message, no report, and the Stop's mirror reading", async () => {
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startFromPage();
    fireEvent.click(screen.getByTestId("button-stop-scan"));
    await waitFor(() => expect(screen.getByTestId("text-backend-verdict")).toBeTruthy(), { timeout: 10_000 });
    expect(screen.getByTestId("text-backend-status").textContent).toBe("stopped");
    expect(screen.getByTestId("text-backend-verdict").textContent).toContain(NO_VERDICT_DID_NOT_FINISH);
    expect(screen.getByTestId("text-backend-error").textContent).toBe("Stopped on the engine: aborted by operator");
    expect(screen.queryByTestId("link-backend-pdf")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("text-backend-mirror").textContent).toBe(MIRRORED), { timeout: 6_000 });
    expect(document.body.textContent ?? "").not.toMatch(/Clear/);
  }, 30_000);

  it("a run this dashboard's engine key cannot read: NoStopPanel's backend variant in place of the Stop, until a read succeeds", async () => {
    realRoutes();
    control.tenantBound = true;
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
    await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
    fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
    fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://labelled.example/login" } });
    fireEvent.click(screen.getByTestId("checkbox-consent"));
    await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("button-start-scan"));
    await waitFor(() => expect(screen.getByTestId("panel-no-stop")).toBeTruthy(), { timeout: 6_000 });
    expect(screen.getByTestId("panel-no-stop").getAttribute("data-variant")).toBe("backend");
    expect(screen.getByTestId("text-no-stop-backend").textContent).toContain("Athena-Backend's Stop on this scan's record reaches it");
    expect(screen.queryByTestId("button-stop-scan")).toBeNull();
    // The key can read the run after all: the next read clears the mark, and the Stop is back.
    control.tenantBound = false;
    await waitFor(() => expect(screen.getByTestId("button-stop-scan")).toBeTruthy(), { timeout: 8_000 });
    expect(screen.queryByTestId("panel-no-stop")).toBeNull();
    fireEvent.click(screen.getByTestId("button-stop-scan"));
  }, 30_000);

  it("sends the recipient's e-mail only when the person opted in", async () => {
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
    await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
    expect((screen.getByTestId("checkbox-email-opt-in") as HTMLElement).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("input-recipient-email")).toBeNull();
    fireEvent.click(screen.getByTestId("checkbox-email-opt-in"));
    fireEvent.change(screen.getByTestId("input-recipient-email"), { target: { value: "reports@labelled.example" } });
    fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
    fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://labelled.example/" } });
    fireEvent.click(screen.getByTestId("checkbox-consent"));
    await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("button-start-scan"));
    await waitFor(() => expect(screen.getByTestId("text-state").textContent).toContain("running"), { timeout: 6_000 });
    expect(hybrid.launches().at(-1)!.json).toMatchObject({ recipient_email: "reports@labelled.example", consent: true });
    fireEvent.click(screen.getByTestId("button-stop-scan"));
  }, 30_000);
});

describe("Tests: each row says where its record is", () => {
  it("pins a hybrid row to Athena-Backend's record -- its label, or pending -- and a dashboard-dispatched scan to this dashboard's", () => {
    const base = { clientId: "c1", siteId: null, testType: "vulnerability-scan", startedAt: new Date().toISOString(), completedAt: null, summary: null,
      vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, severity: null, executedBy: null, isSample: false };
    const tests = [
      { ...base, id: "pending", status: "running", findings: { runId: "run-1", target: "https://a.example/", results: [], backendScanId: "scan-1", backendEngagementId: 1 } },
      { ...base, id: "collected", status: "completed", findings: { runId: "run-2", target: "https://a.example/", results: [], backendScanId: "scan-2", backendEngagementId: 1,
        backend: { status: "completed", verdict: "READY", verdictLabel: "Ready", collectedAt: new Date().toISOString(), detail: "" } } },
      { ...base, id: "stopped", status: "aborted", findings: { runId: "run-3", target: "https://a.example/", results: [], backendScanId: "scan-3", backendEngagementId: 1,
        backend: { status: "stopped", verdict: null, verdictLabel: null, collectedAt: new Date().toISOString(), detail: "Stopped on the engine: aborted by operator" } } },
      { ...base, id: "direct", status: "completed", findings: { runId: "run-4", target: "https://a.example/", results: [] } },
      { ...base, id: "person", status: "completed", testType: "penetration-test", findings: null },
    ];
    mountSeeded(<Tests />, [
      ...COMMON_SEED,
      [["/api/tests"], tests],
      [["/api/clients"], [{ id: "c1", name: "Acme", company: "Acme Co", status: "active", lastTestDate: null, notes: null }]],
      [["/api/sites"], []],
    ]);
    expect(screen.getByTestId("pill-record-source-pending").textContent).toBe(RECORD_PENDING_PILL);
    expect(screen.getByTestId("pill-record-source-collected").textContent).toBe(recordPill("Ready"));
    expect(screen.getByTestId("pill-record-source-stopped").textContent).toBe(recordPill("stopped"));
    expect(screen.getByTestId("pill-record-source-direct").textContent).toBe(DASHBOARD_DIRECT);
    expect(screen.getByTestId("pill-record-source-direct").getAttribute("data-source")).toBe("direct");
    expect(screen.queryByTestId("pill-record-source-person")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/legacy|backend will record/i);
  });
});

describe("Clients: each client's backend engagement, and a window renewed only by a confirmed act", () => {
  const clients = [
    { id: "c1", name: "Acme", company: "Acme Co", status: "active", lastTestDate: null, notes: null, backendEngagementId: 7,
      testingWindowStart: "2026-10-01T00:00:00.000Z", testingWindowEnd: "2026-12-30T00:00:00.000Z" },
    { id: "c2", name: "Plain", company: "Plain Co", status: "active", lastTestDate: null, notes: null, backendEngagementId: null, testingWindowStart: null, testingWindowEnd: null },
  ];

  it("shows the engagement id and the window from the record, and says when there is none yet", () => {
    mountSeeded(<Deployments />, [
      ...COMMON_SEED, [["/api/clients"], clients], [["/api/tests"], []],
      [["/api/findings/summary"], summarizeFindings({ clients: [], sites: [], findings: [] })],
    ]);
    expect(screen.getByTestId("panel-backend-engagements")).toBeTruthy();
    expect(screen.getByTestId("text-engagement-c1").textContent).toBe("Backend engagement #7");
    expect(screen.getByTestId("text-testing-window-c1").textContent).toMatch(/^Testing window .+ → .+$/);
    expect(screen.getByTestId("text-engagement-c2").textContent).toBe(NO_ENGAGEMENT_YET);
    expect(screen.getByTestId("text-testing-window-c2").textContent).toBe(NO_WINDOW_YET);
    expect(screen.queryByTestId("button-read-engagement-c2")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/legacy|backend will record/i);
  });

  it("renews the window only after the confirm step, and reads the engagement from Athena-Backend only when asked", async () => {
    const sent: Array<{ url: string; method: string }> = [];
    // The page's own requests only: the server in this process reaches the engine and the backend through the same global fetch.
    const outbound = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (!String(url).startsWith("/")) return outbound(url, init);
      sent.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ days: 90, client: clients[0], engagement: null }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    mountSeeded(<Deployments />, [
      ...COMMON_SEED, [["/api/clients"], clients], [["/api/tests"], []],
      [["/api/findings/summary"], summarizeFindings({ clients: [], sites: [], findings: [] })],
    ]);
    expect(sent, "nothing is read from the backend on the page's load").toEqual([]);
    fireEvent.click(screen.getByTestId("button-renew-window-c1"));
    await waitFor(() => expect(screen.getByTestId("text-renew-confirm-c1").textContent).toBe(RENEW_CONFIRM_BODY));
    expect(sent, "the press alone sends nothing").toEqual([]);
    fireEvent.click(screen.getByTestId("button-confirm-renew-c1"));
    await waitFor(() => expect(sent.filter((one) => one.method === "POST"), JSON.stringify(sent)).toEqual([{ url: "/api/clients/c1/testing-window/renew", method: "POST" }]));
    expect(sent, JSON.stringify(sent)).toHaveLength(1);
  });
});
