// @vitest-environment jsdom
/**
 * A scan whose run the engine does not know is shown, and counted, under its
 * own label -- never as running for ever, never as ended, never as a result.
 *
 *   - The scan pages (Athena, Penetration Testing): once the server's reading
 *     stands (`engineKnowsRun: false`), the reading is said beside the Stop --
 *     since when, that it may still be running under another id, the engine's
 *     words, that its status is unchanged -- and the Stop stays as it is,
 *     enabled. The scan is read every 30 s, not every 2. An admin may record it
 *     as not known to the engine, behind a confirm step; anyone else is told
 *     who can. Once recorded (`not_known`): "Not assessed", who recorded it and
 *     when, the engine's words, "Nothing here is a result." -- never "Clear",
 *     never "the scan finished and returned no findings", and no Stop.
 *   - The Tests screen: a filter option "Not known to the engine" (a recorded
 *     scan, or one whose reading stands), the label as the badge, a note on the
 *     row; no Stop for a recorded scan, the Stop kept for one that may still be
 *     running.
 *   - Scans running now leaves out a recorded scan; one that may still be
 *     running stays, with its Stop.
 *   - The Overview: Scans In Progress leaves them out; the count of them is its
 *     own figure beside the scans on record, never summed.
 *
 * The scan pages run against the real routes, signed in, with an engine that
 * knows no run; the other screens read a seeded cache.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";
import Tests from "@/pages/Tests";
import Overview from "@/pages/Overview";
import RunningScans from "@/components/RunningScans";
import { queryClient } from "@/lib/queryClient";
import { NOT_ASSESSED, NOTHING_HERE_IS_A_RESULT } from "@/lib/scanSummaryCopy";
import { ASK_AN_ADMIN, NOT_KNOWN_BASIS, RECORD_CONFIRM_BODY, STATUS_UNCHANGED } from "@/lib/notKnownCopy";
import { makeApp, signIn } from "./helpers";
import { TEST_ADMIN_PASSWORD } from "./test-admin";
// The server's own summarizer, so the seeded summary is the shape GET /api/findings/summary answers.
import { summarizeFindings } from "../server/findings-summary";

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const engineSaw: string[] = [];
let engine: Server;
let server: Server;
let base: string;
let adminCookie: string;
let viewerCookie: string;
let session: string;
let clientId: string;
let storage: typeof import("../server/storage-unified").storage;
let rows = 0;

async function cookieOf(username: string, password: string): Promise<string> {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  expect(login.status).toBe(200);
  return (login.headers.get("set-cookie") ?? "").split(";")[0];
}

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.releasePointerCapture ??= () => {};

  // An engine that knows no run: every read and every stop of one is answered 404 "No such scan run".
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    engineSaw.push(`${req.method} ${url}`);
    if (url === "/api/scans/active") return json(res, 200, { active: [] });
    if (url.startsWith("/api/scans/")) return json(res, 404, { detail: "No such scan run" });
    return json(res, 404, { detail: "Not Found" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  const app = await makeApp();
  // The 404 stands on a scan's second read, with no floor: a case waits one poll.
  const routes = (await import("../server/routes")) as { notKnown?: { reads: number; floorMs: number } };
  if (routes.notKnown) Object.assign(routes.notKnown, { reads: 2, floorMs: 0 });
  storage = (await import("../server/storage-unified")).storage;
  const agent = await signIn(app);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  adminCookie = await cookieOf("admin", TEST_ADMIN_PASSWORD);
  const viewerPassword = "a-viewer-password-long-enough"; // pragma: allowlist secret
  await storage.createUser({ username: "vic", password: viewerPassword, role: "viewer", isActive: true } as any);
  viewerCookie = await cookieOf("vic", viewerPassword);
  clientId = (await agent.post("/api/clients").send({ name: "Lost run", company: "Lost run", email: "l@l.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://lost.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
}, 60_000);
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
  engineSaw.length = 0;
  window.history.pushState({}, "", "/");
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
}, 60_000);

/** A scan this dashboard dispatched to the engine itself, recorded as running; the engine does not know its run. */
async function aLegacyScan() {
  rows += 1;
  return storage.createTest({
    clientId, testType: "vulnerability-scan", status: "running",
    findings: { runId: `lost-${rows}`, target: "https://lost.example/", results: [] },
  } as any);
}

/**
 * Every request the screen sends goes to the real routes, as `session`. For a
 * screen that shows only a scan it started (Penetration Testing), `started`
 * answers its start with that scan, in the start's own shape.
 */
function realRoutes(started?: { test: unknown; runId: string }) {
  const outbound = globalThis.fetch;
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/")) return outbound(url, init);
    sent.push(`${init?.method ?? "GET"} ${url}`);
    if (started && init?.method === "POST" && String(url) === "/api/scans") {
      return new Response(JSON.stringify({ ...started, state: "running" }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    return outbound(`${base}${url}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), Cookie: session },
    });
  });
  return sent;
}

/** Pick the client, type the target and start the scan, as a person does. */
async function startAScan() {
  await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
  await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
  fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
  fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://lost.example/" } });
  fireEvent.click(screen.getByTestId("checkbox-consent"));
  await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("button-start-scan"));
}

/** Open the scan on its page: Athena by its link, Penetration Testing by the start the screen sent. */
async function openTheScan(name: "Athena" | "Penetration testing", test: { id: string; findings: unknown }) {
  if (name === "Athena") {
    window.history.pushState({}, "", `/athena?test=${test.id}`);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    return;
  }
  realRoutes({ test, runId: (test.findings as { runId: string }).runId });
  render(<QueryClientProvider client={queryClient}><PentestScan /></QueryClientProvider>);
  await startAScan();
}

/** The interval the page reads its scan at now, as React Query holds it. */
function intervalOf(testId: string): unknown {
  const query = queryClient.getQueryCache().find({ queryKey: [`/api/scans/${testId}`] });
  const interval = (query?.options as { refetchInterval?: unknown } | undefined)?.refetchInterval;
  return typeof interval === "function" ? interval(query) : interval;
}

for (const name of ["Athena", "Penetration testing"] as const) {
  describe(`${name}: a scan whose run the engine does not know`, () => {
    it("says the reading beside an enabled Stop and reads it every 30 s; an admin's act, confirmed, records it: Not assessed, who and when, never Clear and never 'finished and returned no findings', and no Stop", async () => {
      session = adminCookie;
      const test = await aLegacyScan();
      await openTheScan(name, test);

      const panel = await screen.findByTestId("panel-not-known", undefined, { timeout: 8_000 });
      expect(within(panel).getByTestId("text-not-known-since").textContent).toMatch(
        /^Not known to the engine since .+: it may still be running under another id\. Stop sends the stop again; the kill switch on the AI Control page sends it a stop by id\.$/,
      );
      expect(within(panel).getByTestId("text-not-known-said").textContent).toContain("No such scan run");
      expect(within(panel).getByTestId("text-not-known-status").textContent).toBe(STATUS_UNCHANGED);
      // The Stop stays as it is: on screen and enabled.
      const stop = screen.getByTestId("button-stop-scan") as HTMLButtonElement;
      expect(stop.disabled).toBe(false);
      expect(screen.getByTestId("text-state").textContent).toContain("running");
      expect(intervalOf(test.id)).toBe(30_000);

      // The act, confirmed.
      fireEvent.click(within(panel).getByTestId("button-record-not-known"));
      expect((await screen.findByTestId("text-record-not-known-confirm")).textContent).toBe(RECORD_CONFIRM_BODY);
      fireEvent.click(screen.getByTestId("button-confirm-record-not-known"));
      const summary = await screen.findByTestId("text-not-known-recorded", undefined, { timeout: 8_000 });
      expect(summary.textContent).toMatch(/Recorded as not known to the engine by admin at .+\./);
      expect(within(summary).getByTestId("text-not-known-recorded-said").textContent).toContain("No such scan run");
      expect(summary.textContent).toContain(NOTHING_HERE_IS_A_RESULT);
      expect(engineSaw).toContain(`POST /api/scans/${(test.findings as { runId: string }).runId}/abort`);
      expect((await storage.getTest(test.id))!.status).toBe("not_known");

      if (name === "Athena") {
        expect(screen.getByTestId("text-risk-band").textContent).toBe(NOT_ASSESSED);
        expect(screen.getByTestId("text-risk-basis").textContent).toBe(NOT_KNOWN_BASIS);
      }
      expect(screen.queryByTestId("button-stop-scan")).toBeNull();
      expect(screen.queryByTestId("panel-not-known")).toBeNull();
      const page = document.body.textContent ?? "";
      expect(page).not.toMatch(/\bClear\b/);
      expect(page).not.toMatch(/finished and returned no findings/);
      expect(intervalOf(test.id)).toBe(false);
    }, 30_000);
  });
}

describe("Athena: anyone but an admin", () => {
  it("is shown the reading and told who can record it, with no act to press", async () => {
    session = viewerCookie;
    const test = await aLegacyScan();
    await openTheScan("Athena", test);
    const panel = await screen.findByTestId("panel-not-known", undefined, { timeout: 8_000 });
    expect(within(panel).getByTestId("text-not-known-ask-an-admin").textContent).toBe(ASK_AN_ADMIN);
    expect(within(panel).queryByTestId("button-record-not-known")).toBeNull();
    expect((screen.getByTestId("button-stop-scan") as HTMLButtonElement).disabled).toBe(false);
  }, 30_000);
});

// ---- The other screens, from a seeded cache ---------------------------------

const NOW = "2026-10-27T09:00:00.000Z";
const base_ = { clientId: "c1", siteId: null, testType: "vulnerability-scan", summary: "a scan", severity: null, vulnerabilitiesFound: 0,
  criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, startedAt: NOW, completedAt: null, executedBy: null, isSample: false };
/** Recorded as not known to the engine by a person. */
const RECORDED = { ...base_, id: "t-recorded", status: "not_known", completedAt: NOW,
  findings: { runId: "run-a", target: "https://a.example/", results: [], notKnown: { recorded: { by: "ana", at: NOW, stop: "x", said: "No such scan run" } } } };
/** Running, the reading standing. */
const READING = { ...base_, id: "t-reading", status: "running",
  findings: { runId: "run-b", target: "https://b.example/", results: [], notKnown: { since: NOW, reads: 5, lastReadAt: NOW, said: "the engine answered 404" } } };
/** Running, known to the engine. */
const KNOWN = { ...base_, id: "t-known", status: "running", findings: { runId: "run-c", target: "https://c.example/", results: [] } };
const SEEDED_TESTS = [RECORDED, READING, KNOWN];

function seeded(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => { throw new Error(`not seeded: ${JSON.stringify(queryKey)}`); },
      },
    },
  });
  client.setQueryData(["/api/tests"], SEEDED_TESTS);
  client.setQueryData(["/api/clients"], [{ id: "c1", name: "Lost run" }]);
  client.setQueryData(["/api/sites"], []);
  client.setQueryData(["/api/engine/runs"], { runs: [], configured: true });
  client.setQueryData(["/api/auth/check"], { authenticated: true, user: { id: "u1", username: "admin", role: "admin" } });
  client.setQueryData(["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 });
  client.setQueryData(["/api/assurance/deployments"], []);
  client.setQueryData(["/api/findings/summary"], summarizeFindings({ clients: [{ id: "c1", name: "Lost run" }], sites: [], findings: [] }));
  return client;
}

describe("Scans running now", () => {
  it("leaves out a scan recorded as not known to the engine, and keeps one that may still be running, with its Stop", async () => {
    render(<QueryClientProvider client={seeded()}><RunningScans /></QueryClientProvider>);
    await screen.findByTestId("running-scan-t-known");
    expect(screen.queryByTestId("running-scan-t-recorded")).toBeNull();
    expect(screen.getByTestId("running-scan-t-reading")).toBeTruthy();
    expect(screen.getByTestId("button-stop-scan-t-reading")).toBeTruthy();
  });
});

describe("the Overview", () => {
  it("counts neither in progress, and says how many there are as its own figure beside the scans on record", async () => {
    render(<QueryClientProvider client={seeded()}><Overview /></QueryClientProvider>);
    const card = await screen.findByTestId("overview-metric-scans");
    expect(card.querySelector(".athena-figure")?.textContent).toBe("1");
    expect(card.textContent).toContain("3 scans on record · 2 not known to the engine");
  });
});

// Last in the file: once the status filter's Select has been opened, jsdom's
// timers run late for a while (the case asserts at once, and waits on none).
describe("the Tests screen", () => {
  it("labels both, notes each, keeps the Stop only where the run may still be going, and filters them by the one rule", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    render(<QueryClientProvider client={seeded()}><Tests /></QueryClientProvider>);
    await screen.findByTestId("badge-status-t-recorded");
    expect(screen.getByTestId("badge-status-t-recorded").textContent).toContain("Not known to the engine");
    expect(screen.getByTestId("pill-not-known-t-reading").textContent).toBe("Not known to the engine");
    expect(screen.queryByTestId("pill-not-known-t-known")).toBeNull();
    expect(screen.getByTestId("text-not-known-t-recorded").textContent).toMatch(/^Recorded as not known to the engine by ana at .+\.$/);
    expect(screen.getByTestId("text-not-known-t-reading").textContent).toMatch(
      /^Not known to the engine since .+; its status is unchanged, and its Stop is sent as before\.$/,
    );
    expect(screen.queryByTestId("text-not-known-t-known")).toBeNull();
    expect(screen.queryByTestId("button-stop-t-recorded")).toBeNull();
    expect(screen.getByTestId("button-stop-t-reading")).toBeTruthy();
    expect(screen.getByTestId("button-stop-t-known")).toBeTruthy();

    // The status filter's option, by the one rule (lib/engineRuns.ts notKnownToEngine): chosen and read at once.
    const trigger = screen.getByTestId("select-filter-status");
    act(() => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("option-filter-not-known"));
    });
    expect(screen.queryByTestId("badge-status-t-known")).toBeNull();
    expect(screen.getByTestId("badge-status-t-recorded")).toBeTruthy();
    expect(screen.getByTestId("badge-status-t-reading")).toBeTruthy();
    cleanup();
  }, 60_000);
});
