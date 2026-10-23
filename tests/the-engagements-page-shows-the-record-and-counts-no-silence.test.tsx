// @vitest-environment jsdom
/**
 * The Engagements page (client/src/pages/Engagements.tsx) shows Athena-Backend's
 * record of the engagements the person can see, read as them, and every figure
 * on it is drawn from rows the record carries -- never from silence (the
 * Option 1 hybrid, owner decisions 1 and 4; plan section 6 and 14):
 *
 *   - each engagement with the dashboard client it is linked to, or the plain
 *     word that it is linked to none (under its own heading); the backend's
 *     status word, scope hosts and testing window, "Window ended" once the
 *     window has passed;
 *   - its scans counted by the backend's status words and verdict labels from
 *     the list's rows; each scan's outcome in the backend's words; a pending
 *     scan the engine has not named a run for "awaits the launch's answer"; a
 *     row the sync adopted links to the scan page, and its report to the row's
 *     relay; the deployments ingested under it, each with its decision, its
 *     findings count and the state of its coverage manifest;
 *   - no scans recorded is said only of a list read whole: a list that could
 *     not be read shows the reason and draws no count, on the card and on the
 *     tile; a person with no backend sign-in is told so, and no list is shown;
 *   - the sync is asked on load, and its outcome said; the nav lists
 *     Engagements beside Assurance; the scan page opens the scan a record link
 *     names.
 *
 * Against the real routes, served over HTTP and signed in, with the hybrid
 * stand-in as the backend and an engine stub each test tells what to do.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import Engagements from "@/pages/Engagements";
import AthenaScan from "@/pages/AthenaScan";
import AppShell from "@/components/AppShell";
import { queryClient } from "@/lib/queryClient";
import {
  ADOPTION_COULD_NOT_BE_READ, LAUNCH_ANSWER_AWAITED, MANIFEST_COULD_NOT_BE_READ, NOT_LINKED_TO_CLIENT, NO_SCANS_RECORDED,
  PDF_LINK, RECORD_NEEDS_SIGN_IN, SCANS_COULD_NOT_BE_READ, SCOPE_NONE, WINDOW_ENDED, findingsInRecord, stoppedOnEngine,
} from "@/lib/backendRecordCopy";
import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, VERDICT_LABEL, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

const TOKEN = "b".repeat(64);
const RESULTS = [{ type: "sql_injection", severity: "high", url: "https://acme.example/login", message: "a quoted parameter reached the query" }];

type Run = { state: string; result: Record<string, unknown> | null; reason: string | null };

/** An engine whose runs stay running until finished or aborted. */
function stubEngine() {
  const runs = new Map<string, Run>();
  const control = { completeNext: false, nameNoRunNext: false };
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
        const run = runs.get(decodeURIComponent(url.slice("/api/scans/".length)));
        if (!run) return json(res, 404, { detail: "No such scan run" });
        return json(res, 200, { run_id: url.split("/")[3], state: run.state, done: run.state !== "running", result: run.result ?? {}, ...(run.reason ? { reason: run.reason } : {}) });
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
          runs.set(id, { state: "completed", result: { results: RESULTS }, reason: null });
          return json(res, 200, { run_id: id, state: "completed", result: { results: RESULTS } });
        }
        runs.set(id, { state: "running", result: null, reason: null });
        return json(res, 202, { run_id: id, state: "running" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  return { server, runs, control };
}

let engine: ReturnType<typeof stubEngine>;
let hybrid: HybridBackendStandIn;
let server: Server;
let base = "";
let session = "";
let agent: Awaited<ReturnType<typeof signIn>>;
let adoption: typeof import("../server/backend-adoption");
let persons: typeof import("../server/person-credential");
let clientCount = 0;

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;

  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  const engineUrl = `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_URL = engineUrl;
  process.env.ATHENA_ENGINE_KEY = "dashboard-key";
  hybrid = await hybridBackendStandIn({ engine: { url: engineUrl, key: "backend-key" }, serviceToken: TOKEN, assurance: true });
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = TOKEN;
  vi.resetModules();
  const app = await makeApp();
  agent = await signIn(app);
  await signInToBackend(agent);
  adoption = await import("../server/backend-adoption");
  persons = await import("../server/person-credential");
  adoption.adoption.minIntervalMs = 0;
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: TEST_ADMIN_PASSWORD }),
  });
  expect(login.status).toBe(200);
  session = (login.headers.get("set-cookie") ?? "").split(";")[0];
  await signSessionIn();
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
  window.history.pushState({}, "", "/");
  hybrid.controls.failNextScansList = null;
  hybrid.controls.failNextScanDetail = null;
  // Every run a case left live in the engine stub ends, so the next case's launches stay under Max Concurrent Tests.
  for (const [, run] of engine.runs) if (run.state === "running") run.state = "aborted";
  engine.control.completeNext = false;
  engine.control.nameNoRunNext = false;
  adoption.adoption.minIntervalMs = 0;
  adoption._resetAdoptionForTests();
});

afterAll(async () => {
  for (const name of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_SERVICE_TOKEN"]) delete process.env[name];
  const { storage } = await import("../server/storage-unified");
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
  await hybrid.close();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

/** The browser's session, signed in to the backend as the person (T6). */
async function signSessionIn(): Promise<void> {
  const signedIn = await fetch(`${base}/api/auth/backend-sign-in`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: session }, body: JSON.stringify({ password: TEST_ADMIN_PASSWORD }),
  });
  expect(signedIn.status).toBe(200);
}

/** Every request the screen sends goes to the real routes, as the signed-in admin. */
function realRoutes(): string[] {
  const outbound = globalThis.fetch;
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/")) return outbound(url, init);
    sent.push(`${init?.method ?? "GET"} ${url}`);
    return outbound(`${base}${url}`, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), Cookie: session } });
  });
  return sent;
}

const page = () => render(<QueryClientProvider client={queryClient}><Engagements /></QueryClientProvider>);
const rowsNaming = async (scanId: string) => (await agent.get("/api/tests")).body.filter((one: { findings: { backendScanId?: unknown } | null }) => one.findings?.backendScanId === scanId);

async function aClient(host: string) {
  clientCount += 1;
  const client = await agent.post("/api/clients").send({ name: `Client ${clientCount}`, company: `Company ${clientCount}`, email: `c${clientCount}@x.test` });
  await agent.post("/api/sites").send({ clientId: client.body.id, name: host, url: `https://${host}` });
  return client.body.id as string;
}

/** A client whose engagement exists at the backend: one scan started for it from here. */
async function anEngagedClient(host: string) {
  const clientId = await aClient(host);
  const started = await agent.post("/api/scans").send({ clientId, target: `https://${host}/`, consent: true });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return { clientId, engagementId: started.body.backend.engagementId as number, ownTestId: started.body.test.id as string, ownScanId: started.body.test.findings.backendScanId as string };
}

async function aBearer(): Promise<string> {
  const signedIn = await fetch(`${hybrid.url}/api/token/`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: TEST_ADMIN_PASSWORD }),
  });
  return ((await signedIn.json()) as { access: string }).access;
}

/** A scan started at the backend by someone other than this dashboard, under `engagementId`. */
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

/** An engagement at the backend that no dashboard client names. */
async function anEngagementElsewhere(input: Record<string, unknown>): Promise<number> {
  const answer = await fetch(`${hybrid.url}/api/pentest/engagements/`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await aBearer()}` }, body: JSON.stringify(input),
  });
  expect(answer.status).toBe(201);
  return ((await answer.json()) as { id: number }).id;
}

describe("the Engagements page reads the record as the person", () => {
  it("lists an engagement with its client, counts its scans from the rows, says each scan's outcome in the backend's words, links the adopted rows and their report, and lists the deployments ingested under it", async () => {
    const { clientId, engagementId, ownTestId } = await anEngagedClient("acme.example");
    const pending = await aScanStartedElsewhere(engagementId, "https://acme.example/shop");
    engine.control.completeNext = true;
    const completed = await aScanStartedElsewhere(engagementId, "https://acme.example/login");
    expect(hybrid.scans.get(completed.uuid)!.status).toBe("completed");
    engine.control.nameNoRunNext = true;
    const unnamed = await aScanStartedElsewhere(engagementId, "https://acme.example/queued");
    expect(unnamed.runId).toBeNull();
    const deployment = hybrid.addDeployment({ uuid: "00000000-0000-4000-8000-00000000d001", name: "Acme shop", engagement_id: engagementId, decision: "ready", decision_label: "Ready for deployment", finding_count: 2 });
    const clientName = (await agent.get(`/api/clients/${clientId}`)).body.name as string;

    const sent = realRoutes();
    page();
    const card = await screen.findByTestId(`engagement-${engagementId}`);
    // The sync was asked on load, and adopted the two scans the record names a run for; the third awaits the launch's answer.
    await waitFor(() => expect(screen.getByTestId("text-adoption-outcome").textContent).toBe(
      "Adopted 2 scans from the record into this dashboard. 1 scan awaits the launch's answer and has no row here yet.",
    ));
    expect(sent.filter((one) => one === "POST /api/record/adopt")).toHaveLength(1);

    // The client it is linked to, its status word and its window, from the record.
    expect(within(card).getByTestId("text-engagement-client").textContent).toContain(clientName);
    expect(within(card).getByTestId("text-engagement-window").textContent).toMatch(/^\d+ days remaining$/);
    expect(within(card).getByTestId("text-engagement-scope").textContent).toContain("acme.example");

    // Counts from the rows: four scans, by the backend's status words; one verdict label.
    await waitFor(() => expect(within(card).getByTestId("text-engagement-scan-counts").textContent).toContain("4 scans in the record"));
    const counts = within(card).getByTestId("text-engagement-scan-counts").textContent ?? "";
    expect(counts).toContain("pending 3");
    expect(counts).toContain("completed 1");
    expect(within(card).getByTestId("text-engagement-verdict-counts").textContent).toBe(`Verdicts · ${VERDICT_LABEL.NEEDS_REMEDIATION} 1`);
    expect(screen.getByTestId("stat-engagements").textContent).toContain("1");
    expect(screen.getByTestId("stat-record-scans").textContent).toContain("4");

    // Each scan's outcome in the backend's words; the adopted rows link to the scan page, the completed one to its report.
    const completedRow = within(card).getByTestId(`record-scan-${completed.uuid}`);
    expect(within(completedRow).getByTestId("text-scan-outcome").textContent).toBe(VERDICT_LABEL.NEEDS_REMEDIATION);
    await waitFor(() => expect(within(completedRow).getByTestId("link-open-scan")).toBeTruthy());
    const adoptedTestId = /\/athena\?test=([^&]+)$/.exec(within(completedRow).getByTestId("link-open-scan").getAttribute("href") ?? "")?.[1];
    expect(adoptedTestId).toBeTruthy();
    expect(within(completedRow).getByTestId("link-record-pdf").getAttribute("href")).toBe(`/api/scans/${adoptedTestId}/backend-pdf`);
    expect(within(completedRow).getByTestId("link-record-pdf").textContent).toContain(PDF_LINK);
    const pendingRow = within(card).getByTestId(`record-scan-${pending.uuid}`);
    expect(within(pendingRow).getByTestId("text-scan-outcome").textContent).toBe(`engine run ${pending.runId}`);
    expect(within(pendingRow).getByTestId("link-open-scan")).toBeTruthy();
    expect(within(pendingRow).queryByTestId("link-record-pdf")).toBeNull();
    const unnamedRow = within(card).getByTestId(`record-scan-${unnamed.uuid}`);
    expect(within(unnamedRow).getByTestId("text-scan-outcome").textContent).toBe(LAUNCH_ANSWER_AWAITED);
    expect(within(unnamedRow).queryByTestId("link-open-scan")).toBeNull();
    const ownRow = within(card).getByTestId(`record-scan-${(await agent.get(`/api/tests/${ownTestId}`)).body.findings.backendScanId}`);
    expect(within(ownRow).getByTestId("link-open-scan").getAttribute("href")).toBe(`/athena?test=${ownTestId}`);

    // The deployment ingested under it: its decision as served, its findings count, its link, and a manifest the backend did not serve said so.
    const deploymentRow = within(card).getByTestId(`record-deployment-${deployment.uuid}`);
    expect(deploymentRow.textContent).toContain("Acme shop");
    expect(deploymentRow.textContent).toContain("Ready for deployment");
    expect(deploymentRow.textContent).toContain(findingsInRecord(2));
    expect(within(deploymentRow).getByTestId("link-open-deployment").getAttribute("href")).toBe(`/assurance?deployment=${deployment.uuid}`);
    await waitFor(() => expect(within(deploymentRow).getByTestId("text-manifest").textContent).toContain(MANIFEST_COULD_NOT_BE_READ));
  });

  it("says no scans recorded only of a list read whole; a list that could not be read shows the reason and draws no count; an engagement no client here names is listed as not linked, with its window ended", async () => {
    const ended = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const bareId = await anEngagementElsewhere({ name: "Bare", client_name: "Nobody Ltd", status: "completed", testing_window_start: ended, testing_window_end: ended });

    realRoutes();
    page();
    const card = await screen.findByTestId(`engagement-${bareId}`);
    await waitFor(() => expect(screen.getByTestId("text-adoption-outcome").textContent).not.toMatch(/^Adopting/));
    expect(screen.getByTestId("section-unlinked").textContent).toContain(NOT_LINKED_TO_CLIENT);
    expect(within(card).getByTestId("text-engagement-client").textContent).toBe(NOT_LINKED_TO_CLIENT);
    expect(within(card).getByTestId("text-engagement-window").textContent).toBe(WINDOW_ENDED);
    expect(within(card).getByTestId("text-engagement-scope").textContent).toBe(SCOPE_NONE);
    expect(within(card).getByTestId("text-engagement-scan-counts").textContent).toBe(NO_SCANS_RECORDED);

    // The same page while the scans list cannot be read: the sync within the interval reads nothing, the list read fails.
    cleanup();
    queryClient.clear();
    adoption.adoption.minIntervalMs = 60_000;
    hybrid.controls.failNextScansList = { status: 503, body: { detail: "the list is being rebuilt" } };
    page();
    const again = await screen.findByTestId(`engagement-${bareId}`);
    await waitFor(() => expect(within(again).getByTestId("text-engagement-scan-counts").textContent).toContain(SCANS_COULD_NOT_BE_READ));
    expect(within(again).getByTestId("text-engagement-scan-counts").textContent).toContain("the list is being rebuilt");
    expect(within(again).getByTestId("text-engagement-scan-counts").textContent).not.toContain(NO_SCANS_RECORDED);
    expect(screen.getByTestId("stat-record-scans").textContent).toContain("—");
    expect(screen.getByTestId("stat-record-scans").textContent).toContain(SCANS_COULD_NOT_BE_READ);
    for (const counts of screen.getAllByTestId("text-engagement-scan-counts")) expect(counts.textContent).not.toContain(NO_SCANS_RECORDED);
  });

  it("reads a stopped record in the backend's words", async () => {
    const { engagementId } = await anEngagedClient("stopped.example");
    const scan = await aScanStartedElsewhere(engagementId, "https://stopped.example/");
    const record = hybrid.scans.get(scan.uuid)!;
    record.status = "stopped";
    record.error_message = "stopped by an operator";
    record.collected_at = new Date().toISOString();
    realRoutes();
    page();
    const card = await screen.findByTestId(`engagement-${engagementId}`);
    // A later engagement's card opens closed; its scans are shown on asking.
    expect(within(card).queryByTestId("engagement-detail")).toBeNull();
    fireEvent.click(within(card).getByTestId("button-engagement-detail"));
    const row = await within(card).findByTestId(`record-scan-${scan.uuid}`);
    expect(within(row).getByTestId("text-scan-outcome").textContent).toBe(stoppedOnEngine("stopped by an operator"));
    expect(within(row).getByTestId("text-scan-target").textContent).toBe("https://stopped.example/");
  });

  it("tells a person with no backend sign-in to sign in, and shows no list and no count", async () => {
    persons._resetPersonsForTests();
    try {
      realRoutes();
      page();
      const said = await screen.findByTestId("text-record-sign-in");
      expect(said.textContent).toBe(RECORD_NEEDS_SIGN_IN);
      expect(screen.queryByTestId("panel-no-engagements")).toBeNull();
      expect(screen.queryByTestId("stat-record-scans")).toBeNull();
      await waitFor(() => expect(screen.getByTestId("text-adoption-outcome").textContent).toContain(ADOPTION_COULD_NOT_BE_READ));
    } finally {
      await signInToBackend(agent);
      await signSessionIn();
    }
  });
});

describe("the record's links", () => {
  it("the nav lists Engagements beside Assurance", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <AppShell onLogout={() => {}} isAdmin username="admin"><div /></AppShell>
      </QueryClientProvider>,
    );
    const engagements = screen.getByTestId("nav-engagements");
    expect(engagements.getAttribute("href")).toBe("/engagements");
    expect(engagements.textContent).toContain("Engagements");
    const assurance = screen.getByTestId("nav-assurance");
    expect(assurance.nextElementSibling).toBe(engagements);
  });

  it("the scan page opens the scan a record link names, polled as one started here", async () => {
    const { engagementId } = await anEngagedClient("linked.example");
    const scan = await aScanStartedElsewhere(engagementId, "https://linked.example/");
    const synced = await agent.post("/api/record/adopt");
    const adopted = (synced.body.adopted as Array<{ testId: string; backendScanId: string }>).find((one) => one.backendScanId === scan.uuid);
    expect(adopted).toBeDefined();
    const sent = realRoutes();
    window.history.pushState({}, "", `/athena?test=${adopted!.testId}`);
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("text-state").textContent).toMatch(/running/i));
    expect(sent).toContain(`GET /api/scans/${adopted!.testId}`);
    expect(sent.filter((one) => one.startsWith("POST /api/scans") && !one.endsWith("/abort"))).toEqual([]);
  });
});

describe("the adoption outcome line is said from the answer's fields, never from silence", () => {
  const EVERY_ROW = "Every scan the record lists has its row in this dashboard.";
  const settled = async () => {
    await waitFor(() => expect(screen.getByTestId("text-adoption-outcome").textContent).not.toMatch(/^Adopting/));
    return screen.getByTestId("text-adoption-outcome").textContent ?? "";
  };

  it("a scan that awaits the launch's answer has no row yet, and the line says so rather than that every scan has its row", async () => {
    const { engagementId } = await anEngagedClient("awaiting.example");
    engine.control.nameNoRunNext = true;
    const unnamed = await aScanStartedElsewhere(engagementId, "https://awaiting.example/queued");
    expect(unnamed.runId).toBeNull();
    realRoutes();
    page();
    const line = await settled();
    expect(line).not.toContain(EVERY_ROW);
    expect(line).toMatch(/\b\d+ scans? awaits? the launch's answer and ha(s|ve) no row here yet\./);
    expect(line).toMatch(/^No scan was adopted this sync\./);
  });

  it("a finished scan whose detail could not be read now is said so, with its count, and is adopted whole on the next sync", async () => {
    const { engagementId } = await anEngagedClient("unreadable.example");
    engine.control.completeNext = true;
    const completed = await aScanStartedElsewhere(engagementId, "https://unreadable.example/done");
    expect(hybrid.scans.get(completed.uuid)!.status).toBe("completed");
    hybrid.controls.failNextScanDetail = { status: 503, body: { detail: "the record is being rebuilt" } };
    realRoutes();
    page();
    const line = await settled();
    expect(line).not.toContain(EVERY_ROW);
    expect(line).toContain("1 finished scan could not be read now; it is adopted whole on the next sync.");
    expect(await rowsNaming(completed.uuid)).toEqual([]);
    // The next load reads it, and adopts it.
    cleanup();
    queryClient.clear();
    realRoutes();
    page();
    const again = await settled();
    expect(again).toMatch(/^Adopted 1 scan from the record into this dashboard\./);
    expect(again).not.toContain("could not be read now");
    await waitFor(async () => expect(await rowsNaming(completed.uuid)).toHaveLength(1));
  });
});
