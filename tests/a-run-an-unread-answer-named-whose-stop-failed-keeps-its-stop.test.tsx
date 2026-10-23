// @vitest-environment jsdom
/**
 * An engine answer this dashboard does not read that names a run is refused,
 * and the run is sent a stop. When that stop does not take -- the engine
 * refuses it (a 503), or cannot be reached -- the run may still be going, and
 * the operator is told so and offered a way to stop it:
 *
 *   - Retest: the finding's panel lists the run with its Stop (it is no watch:
 *     nothing is read or filed from it), and the toast's title says the retest
 *     may still be running and what stops it -- never "did not run";
 *   - Scan: the toast's title says the scan may still be running and names the
 *     kill switch and a failsafe pause -- never "did not start".
 *
 * Every engine answer is a recorded one (tests/fixtures/engine-retest,
 * recorded by generate.py at athena-engine f4610ae on the unpinned local
 * core), "derived" where one field was changed: the launch's `answer` spelled
 * "Status", and the recorded 503 "not admitted" answer served as a stop's
 * answer. The panel and the screens run against the real routes, signed in.
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
import { queryClient } from "@/lib/queryClient";
import { makeApp, recordLegacyScan, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

type Exchange = { note: string; request: { method: string; path: string }; status: number; body: any; headers?: Record<string, string> };
type Fixture = { exchanges: Exchange[] };
const load = (name: string): Fixture =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "fixtures", "engine-retest", "pr71-f4610ae", `${name}.json`), "utf8"));
const launchOf = (fx: Fixture, p: string) => fx.exchanges.find((one) => !one.note.startsWith("setup") && one.request.method === "POST" && one.request.path === p)!;
const setupOf = (fx: Fixture, test: (p: string) => boolean) => fx.exchanges.find((one) => one.note.startsWith("setup") && test(one.request.path))!;

const verdictFx = load("at-once-then-verdict");
const retestLaunch = launchOf(verdictFx, "/api/remediation/retest");
const RUN = retestLaunch.body.run_id as string;
const twinId = setupOf(verdictFx, (p) => p.startsWith("/api/decisions?")).body.decisions[0].id as number;
/** The recorded 500 that names a run whose work started (athena-engine #71): Athena-Backend records the scan failed and keeps the run's id. */
const scanLaunch = launchOf(load("scan-failed-after-registration"), "/api/scan");
/** derived: the recorded 503 "not admitted" answer, served as a stop's answer. */
const refused = launchOf(load("not-admitted"), "/api/remediation/retest");

const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const state: { scan: Exchange | null } = { scan: null };
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
      // derived: the recorded 202 with its `answer` spelled "Status".
      if (req.method === "POST" && url === "/api/remediation/retest") return json(res, 202, { ...retestLaunch.body, answer: "Status" });
      if (req.method === "POST" && url.endsWith("/abort")) return reply(refused);
      // The scan run this file launches reads as running from the engine (the dashboard's own first read, decision 7).
      if (req.method === "GET" && url === `/api/scans/${scanLaunch.body.run_id}`) return json(res, 200, { run_id: scanLaunch.body.run_id, state: "running", result: null });
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
  clientId = (await agent.post("/api/clients").send({ name: "Unread", company: "Unread", email: "u@u.test" })).body.id;
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
});

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

describe("a retest whose answer was not read, and whose run's stop was refused", () => {
  it("keeps the run on the finding's panel with its Stop, and the toast says it may still be running", async () => {
    // The scan that found the finding, recorded and filed as this dashboard's own (a scan from before the hybrid).
    const { storage } = await import("../server/storage-unified");
    const setupScan = setupOf(verdictFx, (p) => p === "/api/scan");
    const { test } = await recordLegacyScan(storage, {
      clientId, siteId, target: "https://offline.invalid/", runId: setupScan.body.run_id as string, results: setupScan.body.result.results as unknown[],
    });
    realRoutes();
    render(<QueryClientProvider client={queryClient}><RetestPanel testId={test.id} /></QueryClientProvider>);
    fireEvent.click(await screen.findByTestId(`button-retest-${twinId}`));

    await waitFor(() => expect(toasts.length).toBe(1));
    expect(String(toasts[0].title)).toMatch(/^The retest may still be running/);
    expect(String(toasts[0].title)).toContain("kill switch");
    expect(String(toasts[0].title)).toContain("failsafe pause");
    expect(String(toasts[0].title)).not.toContain("did not run");

    // The run is on the panel, with its Stop -- never a verdict.
    await waitFor(() => expect(screen.getByTestId(`text-retest-phase-${twinId}`).textContent).toBe("Running"));
    expect(screen.getByTestId(`text-retest-status-${twinId}`).textContent).toContain("may still be running");
    expect(screen.queryByTestId(`verdict-${twinId}`)).toBeNull();
    const before = calls.filter((one) => one === `POST /api/scans/${RUN}/abort`).length;
    fireEvent.click(screen.getByTestId(`button-stop-retest-${twinId}`));
    await waitFor(() => expect(calls.filter((one) => one === `POST /api/scans/${RUN}/abort`).length).toBe(before + 1));
  });
});

describe("a scan Athena-Backend recorded failed, naming a run whose stop the engine refused", () => {
  it("is recorded with its Stop and the backend's words; the refused stop says the run may still be running, and the Stop stays", async () => {
    state.scan = scanLaunch;
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
    await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
    fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
    fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://offline.invalid/" } });
    fireEvent.click(screen.getByTestId("checkbox-consent"));
    await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("button-start-scan"));

    // Recorded as running, with the backend's words beside its Stop: nothing was stopped unasked.
    const warning = await screen.findByTestId("text-start-warning");
    expect(warning.textContent).toContain(scanLaunch.body.run_id);
    expect(warning.textContent).toContain("Athena-Backend recorded this scan as failed");
    expect(toasts).toEqual([]);
    expect(calls.filter((one) => one.endsWith("/abort"))).toEqual([]);

    // The Stop goes to the engine; its refusal is said as one, and the Stop stays.
    fireEvent.click(screen.getByTestId("button-stop-scan"));
    await waitFor(() => expect(toasts.length).toBe(1));
    expect(calls).toContain(`POST /api/scans/${scanLaunch.body.run_id}/abort`);
    expect(String(toasts[0].title)).toBe("Not stopped");
    expect(String(toasts[0].description)).toContain("may still be running");
    expect(screen.getByTestId("button-stop-scan")).toBeTruthy();
  });
});
