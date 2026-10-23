// @vitest-environment jsdom
/**
 * Round 3 (#315), on the screens:
 *
 *   - one unread retest answer that named two runs, neither of whose stops
 *     took, keeps a Stop for EACH on the finding's panel -- never only the
 *     last -- and each Stop stops its own run (M2);
 *   - a kept Stop for a run that ended on its own reads "Already finished",
 *     never "Stopped"; one the engine knows no such run for says that; an
 *     admin can clear one from the panel, sending nothing;
 *   - a retest toast says "stop it here" only when the panel keeps a Stop;
 *   - a scan start that may have reached the engine (a bare 500) is titled
 *     "may still be running", never "did not start"; one whose answer was not
 *     read but whose every named run was then stopped is not "did not start"
 *     either.
 *
 * Every engine answer is a recorded one (tests/fixtures/engine-retest,
 * athena-engine f4610ae on the unpinned local core), "derived" where it was
 * changed: the launch's `answer` spelled "Status", an X-Run-Id naming a second
 * run, the recorded 503 "not admitted" served as a stop's answer, the recorded
 * "not running" stop answer given this run's id, engine main's unhandled 500
 * (Starlette's text body) as the scan's answer. The panel and the screens run
 * against the real routes, signed in.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let hybrid: HybridBackendStandIn | null = null;
const toasts = vi.hoisted(() => [] as Array<{ title?: unknown; description?: unknown }>);
vi.mock("@/hooks/use-toast", () => {
  const toast = (one: { title?: unknown; description?: unknown }) => {
    toasts.push(one);
    return { id: String(toasts.length), dismiss: () => undefined, update: () => undefined };
  };
  return { toast, useToast: () => ({ toast, toasts: [], dismiss: () => undefined }) };
});

import RetestPanel from "@/components/RetestPanel";
import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";
import { queryClient } from "@/lib/queryClient";
import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

type Exchange = { note: string; request: { method: string; path: string }; status: number; body: any; headers?: Record<string, string> };
type Fixture = { exchanges: Exchange[] };
const load = (name: string): Fixture =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "fixtures", "engine-retest", "pr71-f4610ae", `${name}.json`), "utf8"));
const launchOf = (fx: Fixture, p: string) => fx.exchanges.find((one) => !one.note.startsWith("setup") && one.request.method === "POST" && one.request.path === p)!;
const setupOf = (fx: Fixture, test: (p: string) => boolean) => fx.exchanges.find((one) => one.note.startsWith("setup") && test(one.request.path))!;
const abortsOf = (fx: Fixture) => fx.exchanges.filter((one) => one.request.method === "POST" && /^\/api\/scans\/[^/]+\/abort$/.test(one.request.path));

const verdictFx = load("at-once-then-verdict");
const retestLaunch = launchOf(verdictFx, "/api/remediation/retest");
const A = retestLaunch.body.run_id as string;
const B = "22222222-2222-4222-8222-222222222222";
const twinId = setupOf(verdictFx, (p) => p.startsWith("/api/decisions?")).body.decisions[0].id as number;
const scanLaunch = launchOf(load("scan-at-once-then-completed"), "/api/scan");
/** The recorded 500 that names a run whose work started (athena-engine #71): Athena-Backend records the scan failed and keeps the run's id. */
const failedAfterRegistration = launchOf(load("scan-failed-after-registration"), "/api/scan");
/** derived: the recorded 503 "not admitted" answer, served as a stop's answer. */
const refused = launchOf(load("not-admitted"), "/api/remediation/retest");
/** The recorded accepted stop, and (derived) the recorded "not running" answer, each given a run's id. */
const accepted = (runId: string): Exchange => { const one = abortsOf(load("running-then-stopped"))[0]; return { ...one, body: { ...one.body, run_id: runId } }; };
const notRunning = (runId: string): Exchange => { const one = abortsOf(load("running-then-stopped"))[1]; return { ...one, body: { ...one.body, run_id: runId } }; };
/** The recorded 404 to a stop by a run id the engine has no record of. */
const unknownRun = abortsOf(load("abort-unknown-run"))[0];

const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const state: {
  scan: Exchange | null;
  retestHeaders: Record<string, string>;
  retestBody: Record<string, unknown> | null;
  abortFor: (runId: string) => Exchange;
} = { scan: null, retestHeaders: {}, retestBody: null, abortFor: () => refused };
const calls: string[] = [];
let engine: Server;
let server: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let base: string;
let session: string;
let clientId: string;
let siteId: string;

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      calls.push(`${req.method} ${url}`);
      const reply = (one: Exchange) => json(res, one.status, one.body, one.headers ?? {});
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") return json(res, 200, { active: [] });
      if (req.method === "POST" && url === "/api/scan") return reply(state.scan ?? setupOf(verdictFx, (p) => p === "/api/scan"));
      if (req.method === "GET" && url.startsWith("/api/decisions?")) return reply(setupOf(verdictFx, (p) => p.startsWith("/api/decisions?")));
      if (req.method === "POST" && url === "/api/remediation/retest") {
        // derived: the recorded 202 with its `answer` spelled "Status".
        return json(res, 202, state.retestBody ?? { ...retestLaunch.body, answer: "Status" }, state.retestHeaders);
      }
      // The scan runs this file launches read as running from the engine (the dashboard's own first read, decision 7); every other id is unknown to it, as before.
      const read = /^\/api\/scans\/([^/]+)$/.exec(url);
      if (req.method === "GET" && read && [scanLaunch.body.run_id, failedAfterRegistration.body.run_id].includes(decodeURIComponent(read[1]))) {
        return json(res, 200, { run_id: decodeURIComponent(read[1]), state: "running", result: null });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (req.method === "POST" && abort) return reply(state.abortFor(decodeURIComponent(abort[1])));
      return json(res, 404, { detail: "Not Found" });
    });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  hybrid = await hybridBackendStandIn({ engine: { url: process.env.ATHENA_ENGINE_URL!, key: process.env.ATHENA_ENGINE_KEY } });
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  vi.resetModules();
  const app = await makeApp();
  agent = await signIn(app);
  await signInToBackend(agent);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: TEST_ADMIN_PASSWORD }),
  });
  expect(login.status).toBe(200);
  session = (login.headers.get("set-cookie") ?? "").split(";")[0];
  clientId = (await agent.post("/api/clients").send({ name: "Round3", company: "Round3", email: "r3@r3.test" })).body.id;
  siteId = (await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://offline.invalid" })).body.id;
});
afterAll(async () => {
  delete process.env.ATHENA_FAILSAFE_URL;
  await hybrid?.close();
  hybrid = null;
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  engine.closeAllConnections?.();
  server.closeAllConnections?.();
  await new Promise<void>((r) => engine.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
  toasts.length = 0;
  calls.length = 0;
  state.scan = null;
  state.retestHeaders = {};
  state.retestBody = null;
  state.abortFor = () => refused;
});

function realRoutes(cookie = session) {
  const outbound = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/")) return outbound(url, init);
    return outbound(`${base}${url}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), Cookie: cookie },
    });
  });
}

/** A fresh test (its scan answered by the recorded setup scan), its panel rendered -- signed in as `cookie`'s account -- and Retest pressed. */
async function retestOnPanel(cookie = session) {
  const started = await agent.post("/api/scans").send({ consent: true, clientId, siteId, target: "https://offline.invalid/" });
  expect(started.status).toBe(201);
  realRoutes(cookie);
  render(<QueryClientProvider client={queryClient}><RetestPanel testId={started.body.test.id} /></QueryClientProvider>);
  fireEvent.click(await screen.findByTestId(`button-retest-${twinId}`));
  await waitFor(() => expect(toasts.length).toBe(1));
  return started.body.test.id as string;
}

const stopsShown = () => screen.queryAllByTestId(`button-stop-retest-${twinId}`).map((one) => one.getAttribute("data-run-id"));
const phaseOf = (runId: string) =>
  document.querySelector(`[data-testid="retest-status-${twinId}"][data-run-id="${runId}"] [data-testid="text-retest-phase-${twinId}"]`)?.textContent;

describe("M2: a finding keeps a Stop for every run an unread answer named", () => {
  it("(derived: the recorded 202, answer \"Status\", naming A, its X-Run-Id naming B; both stops refused) two Stops, each stopping its own run", async () => {
    state.retestHeaders = { "X-Run-Id": B };
    await retestOnPanel();
    expect(String(toasts[0].title)).toMatch(/^The retest may still be running: stop it here/);
    await waitFor(() => expect(stopsShown().sort()).toEqual([A, B].sort()));
    const sent = (runId: string) => calls.filter((one) => one === `POST /api/scans/${runId}/abort`).length;
    const [beforeA, beforeB] = [sent(A), sent(B)];
    state.abortFor = (runId) => accepted(runId);
    fireEvent.click(screen.getAllByTestId(`button-stop-retest-${twinId}`).find((one) => one.getAttribute("data-run-id") === B)!);
    await waitFor(() => expect(sent(B)).toBe(beforeB + 1));
    expect(sent(A)).toBe(beforeA);
    // A keeps its Stop until it is pressed.
    await waitFor(() => expect(stopsShown()).toEqual([A]));
    fireEvent.click(screen.getAllByTestId(`button-stop-retest-${twinId}`).find((one) => one.getAttribute("data-run-id") === A)!);
    await waitFor(() => expect(sent(A)).toBe(beforeA + 1));
    await waitFor(() => expect(stopsShown()).toEqual([]));
    // Both stopped: the finding can be retested again.
    await waitFor(() => expect((screen.getByTestId(`button-retest-${twinId}`) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("#5 and #4: a kept Stop says how its run ended", () => {
  it("(derived: the recorded 'not running' answer) Already finished, never Stopped", async () => {
    await retestOnPanel();
    await waitFor(() => expect(stopsShown()).toEqual([A]));
    state.abortFor = (runId) => notRunning(runId);
    fireEvent.click(screen.getByTestId(`button-stop-retest-${twinId}`));
    await waitFor(() => expect(toasts.length).toBe(2));
    expect(String(toasts[1].title)).toBe("Already finished");
    await waitFor(() => expect(phaseOf(A)).toBe("Already finished"));
    // Once the finding's open retests are read again (Retest is offered), the run is still shown as it ended.
    await waitFor(() => expect((screen.getByTestId(`button-retest-${twinId}`) as HTMLButtonElement).disabled).toBe(false));
    expect(phaseOf(A)).toBe("Already finished");
    expect(document.body.textContent).not.toMatch(/\bStopped\b/);
  });

  // Round 4 #1: the kept Stop's id was named by an answer this dashboard did
  // not read, so the engine's 404 is no end: the run that retest began may be
  // live under another id. At da5af32 it read "Not known to the engine" and
  // offered Retest again.
  it("the recorded 404 \"No such scan run\" to a kept Stop: may still be running, the Stop kept, and Retest not offered", async () => {
    await retestOnPanel();
    await waitFor(() => expect(stopsShown()).toEqual([A]));
    state.abortFor = () => unknownRun;
    const sent = calls.filter((one) => one === `POST /api/scans/${A}/abort`).length;
    fireEvent.click(screen.getByTestId(`button-stop-retest-${twinId}`));
    await waitFor(() => expect(toasts.length).toBe(2));
    expect(calls.filter((one) => one === `POST /api/scans/${A}/abort`).length).toBe(sent + 1);
    expect(String(toasts[1].title)).toBe("May still be running");
    expect(String(toasts[1].description)).toContain(
      "the engine does not know the run this answer named; a run it started may still be running under another id -- " +
      "the kill switch or a failsafe pause stops it",
    );
    expect(String(toasts[1].description)).not.toMatch(/ended or never ran/);
    await waitFor(() => expect(document.body.textContent).toContain("under another id"));
    expect(phaseOf(A)).toBe("Running");
    expect(stopsShown()).toEqual([A]);
    expect((screen.getByTestId(`button-retest-${twinId}`) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("#4: an admin can clear a kept Stop from the panel", () => {
  it("(derived: the recorded 202, answer \"Status\"; its stop refused) Clear sends nothing, the run reads cleared, and Retest is offered again", async () => {
    await retestOnPanel();
    await waitFor(() => expect(stopsShown()).toEqual([A]));
    const sent = calls.length;
    fireEvent.click(await screen.findByTestId(`button-clear-retest-${twinId}`));
    await waitFor(() => expect(toasts.length).toBe(2));
    expect(String(toasts[1].title)).toBe("Stop cleared");
    expect(calls.slice(sent).filter((one) => one.includes("/abort"))).toEqual([]);
    await waitFor(() => expect(phaseOf(A)).toBe("Cleared by an admin"));
    expect(stopsShown()).toEqual([]);
    await waitFor(() => expect((screen.getByTestId(`button-retest-${twinId}`) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("round 4 #7 (pins K9): only an admin is offered Clear", () => {
  it("(derived: the recorded 202, answer \"Status\"; its stop refused) the requester, not an admin, keeps the Stop and is offered no Clear", async () => {
    const name = `r4-panel-${Date.now()}`;
    const made = await agent.post("/api/users").send({ username: name, password: "a-long-enough-password", role: "user", email: `${name}@r4.test` });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: name, password: "a-long-enough-password" }),
    });
    expect(login.status).toBe(200);
    const theirs = (login.headers.get("set-cookie") ?? "").split(";")[0];
    await retestOnPanel(theirs);
    await waitFor(() => expect(stopsShown()).toEqual([A]));
    // Its own view read (GET /api/retests/:runId, the requester's to read) has come back, still with no Clear.
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByTestId(`button-clear-retest-${twinId}`)).toBeNull();
    expect(phaseOf(A)).toBe("Running");
  });

  it("an admin is offered Clear on the same kept Stop", async () => {
    await retestOnPanel();
    await waitFor(() => expect(stopsShown()).toEqual([A]));
    expect(await screen.findByTestId(`button-clear-retest-${twinId}`)).toBeTruthy();
  });
});

describe("#7: \"stop it here\" only when the panel keeps a Stop", () => {
  it("(derived: the recorded 202 with answer \"Status\" and run_id \"a/b\") no Stop can be kept: the title names the kill switch, not \"here\"", async () => {
    state.retestBody = { ...retestLaunch.body, answer: "Status", run_id: "a/b" };
    await retestOnPanel();
    expect(String(toasts[0].title)).toMatch(/^The retest may still be running/);
    expect(String(toasts[0].title)).not.toContain("stop it here");
    expect(String(toasts[0].title)).toContain("kill switch");
    expect(stopsShown()).toEqual([]);
  });
});

async function startScanOn(page: "athena" | "pentest") {
  realRoutes();
  render(<QueryClientProvider client={queryClient}>{page === "athena" ? <AthenaScan /> : <PentestScan />}</QueryClientProvider>);
  await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
  await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
  fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
  fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://offline.invalid/" } });
  fireEvent.click(screen.getByTestId("checkbox-consent"));
  await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("button-start-scan"));
  await waitFor(() => expect(toasts.length).toBe(1));
  return String(toasts[0].title);
}

describe("#1 and #7: a scan start is \"did not start\" only when nothing may be running", () => {
  it("(derived: engine main's unhandled 500, Starlette's text body) the backend records the scan failed naming no run: did not start, in the backend's words, the kill switch named", async () => {
    state.scan = { ...scanLaunch, status: 500, body: "Internal Server Error", headers: { "Content-Type": "text/plain; charset=utf-8" } };
    const title = await startScanOn("athena");
    expect(title).toBe("The scan did not start");
    const description = String(toasts[0].description);
    expect(description).toContain("Athena-Backend recorded this scan as failed");
    expect(description).toContain("kill switch");
    expect(description).toContain("failsafe pause");
    expect(calls.filter((one) => one.endsWith("/abort"))).toEqual([]);
  });

  it("(the recorded 500 naming a run whose work started) the backend records the scan failed, yet the run it names may be running: recorded with its Stop and the backend's words, never \"did not start\"", async () => {
    state.scan = failedAfterRegistration;
    realRoutes();
    render(<QueryClientProvider client={queryClient}><PentestScan /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
    await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
    fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
    fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://offline.invalid/" } });
    fireEvent.click(screen.getByTestId("checkbox-consent"));
    await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("button-start-scan"));
    const warning = await screen.findByTestId("text-start-warning");
    expect(warning.textContent).toContain(failedAfterRegistration.body.run_id);
    expect(warning.textContent).toContain("Athena-Backend recorded this scan as failed");
    expect(warning.textContent).toContain(failedAfterRegistration.body.error);
    expect(screen.getByTestId("button-stop-scan")).toBeTruthy();
    expect(toasts).toEqual([]);
    expect(calls.filter((one) => one.endsWith("/abort"))).toEqual([]);
  });

  it("the engine's refusal (the recorded 503 not admitted, naming no run) is still \"did not start\"", async () => {
    state.scan = launchOf(load("scan-not-admitted"), "/api/scan");
    const title = await startScanOn("athena");
    expect(title).toBe("The scan did not start");
  });
});
