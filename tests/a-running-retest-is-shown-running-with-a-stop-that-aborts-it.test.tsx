// @vitest-environment jsdom
/**
 * A retest the engine answered with a status is drawn as that status -- never
 * as a verdict -- and a running one carries a Stop that stops it.
 *
 * athena-engine #71 answers a retest that outlasts its 30 s inline wait with
 * 202 and the run's id. The panel used to take any 2xx as a verdict and draw
 * a missing one as "Inconclusive". These drive the real RetestPanel and
 * RunningScans against the real routes, signed in, with an engine that
 * answers what the real engine answered (tests/fixtures/engine-retest, recorded
 * from athena-engine 143279e and 5779e99 by generate.py beside them).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import RetestPanel from "@/components/RetestPanel";
import RunningScans from "@/components/RunningScans";
import { queryClient } from "@/lib/queryClient";
import { makeApp, signIn } from "./helpers";

type Exchange = { request: { method: string; path: string }; status: number; body: any; headers?: Record<string, string> };
type Fixture = { exchanges: Exchange[] };
const load = (dir: string, name: string): Fixture =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "fixtures", "engine-retest", dir, `${name}.json`), "utf8"));
const pick = (fx: Fixture, method: string, test: (p: string) => boolean) =>
  fx.exchanges.filter((one) => one.request.method === method && test(one.request.path));
const retestOf = (fx: Fixture) => pick(fx, "POST", (p) => p === "/api/remediation/retest")[0];
const statusReadsOf = (fx: Fixture) => pick(fx, "GET", (p) => /^\/api\/scans\/[^/]+$/.test(p) && p !== "/api/scans/active");
const abortOf = (fx: Fixture) => pick(fx, "POST", (p) => /\/abort$/.test(p))[0];

const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const state: {
  fixture: Fixture | null;
  statusReads: Exchange[];
  hold: Promise<void> | null;
  active: Exchange | { status: number; body: unknown };
  abort: Exchange | null;
} = { fixture: null, statusReads: [], hold: null, active: { status: 200, body: { active: [] } }, abort: null };
const calls: string[] = [];

let engine: Server;
let server: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let base: string;
let session: string;

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", async () => {
      const url = req.url ?? "";
      calls.push(`${req.method} ${url}`);
      const fx = state.fixture;
      const reply = (one: Exchange) => json(res, one.status, one.body, one.headers ?? {});
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") return json(res, state.active.status, state.active.body);
      if (!fx) return json(res, 500, { detail: "no fixture" });
      if (req.method === "POST" && url === "/api/scan") return reply(fx.exchanges[0]);
      if (req.method === "GET" && url.startsWith("/api/decisions?")) return reply(fx.exchanges[1]);
      if (req.method === "POST" && url === "/api/remediation/retest") return reply(retestOf(fx));
      if (req.method === "POST" && url.endsWith("/abort")) return state.abort ? reply(state.abort) : json(res, 404, {});
      if (req.method === "GET" && /^\/api\/scans\/[^/]+$/.test(url)) {
        if (state.hold) await state.hold;
        const next = state.statusReads.length > 1 ? state.statusReads.shift()! : state.statusReads[0];
        return next ? reply(next) : json(res, 404, { detail: "No such scan run" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  const app = await makeApp();
  watcher = app.locals.retestWatcher;
  storageOf = (await import("../server/storage-unified")).storage;
  agent = await signIn(app);
  const retests = await import("../server/retests");
  retests.retestWatch.intervalMs = 25;
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  expect(login.status).toBe(200);
  session = (login.headers.get("set-cookie") ?? "").split(";")[0];
});
afterAll(async () => {
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
  Object.assign(state, { fixture: null, statusReads: [], hold: null, active: { status: 200, body: { active: [] } }, abort: null });
  calls.length = 0;
});

let watcher: import("../server/retests").RetestWatcher;
let storageOf: unknown;
afterEach(() => {
  // The fixtures' run ids are reused across cases, which a real engine never does.
  watcher.reset();
  (storageOf as { retestWatches: Map<string, unknown> }).retestWatches.clear();
});

/** Every request the panel sends goes to the real routes, as the signed-in admin. */
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

let n = 0;
/** A scanned test whose finding the fixture's twin is about. */
async function aScannedTest(fx: Fixture) {
  state.fixture = fx;
  n += 1;
  const client = await agent.post("/api/clients").send({ name: `Panel ${n}`, company: "Panel", email: `p${n}@p.test` });
  const site = await agent.post("/api/sites").send({ clientId: client.body.id, name: "Main", url: "https://offline.invalid" });
  const started = await agent.post("/api/scans")
    .send({ clientId: client.body.id, siteId: site.body.id, target: fx.exchanges[0].body.target });
  expect(started.status).toBe(201);
  return { testId: started.body.test.id as string, twinId: fx.exchanges[1].body.decisions[0].id as number };
}

async function pressRetest(fx: Fixture) {
  const { testId, twinId } = await aScannedTest(fx);
  realRoutes();
  render(<QueryClientProvider client={queryClient}><RetestPanel testId={testId} /></QueryClientProvider>);
  const button = await screen.findByTestId(`button-retest-${twinId}`);
  fireEvent.click(button);
  return twinId;
}

describe("the retest panel reads a status as a status", () => {
  it("202: shown Running, never as a verdict, with a Stop that aborts the engine's run by its run_id", async () => {
    const fx = load("pr71-143279e", "running-then-stopped");
    const runId = retestOf(fx).body.run_id as string;
    let release!: () => void;
    state.hold = new Promise<void>((r) => { release = r; });
    state.statusReads = [statusReadsOf(fx)[0]];
    state.abort = abortOf(fx);
    const twinId = await pressRetest(fx);

    await waitFor(() => expect(screen.getByTestId(`text-retest-phase-${twinId}`).textContent).toBe("Running"));
    expect(screen.queryByTestId(`verdict-${twinId}`)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Inconclusive|Closed|Still open/);
    const stop = screen.getByTestId(`button-stop-retest-${twinId}`) as HTMLButtonElement;
    // The watcher's read is held open; the Stop does not wait on it.
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    await waitFor(() => expect(calls).toContain(`POST /api/scans/${runId}/abort`));

    release();
    state.hold = null;
    await waitFor(() => expect(screen.getByTestId(`text-retest-phase-${twinId}`).textContent).toBe("Stopped"), { timeout: 6_000 });
    expect(screen.getByTestId(`text-retest-status-${twinId}`).textContent).toMatch(/before it reached a verdict\. Nothing was filed/);
    expect(screen.queryByTestId(`verdict-${twinId}`)).toBeNull();
    expect(screen.queryByTestId(`button-stop-retest-${twinId}`)).toBeNull();
  });

  it("202 then the verdict: drawn as the verdict once the run completes", async () => {
    const fx = load("pr71-143279e", "running-then-verdict");
    state.statusReads = statusReadsOf(fx);
    const twinId = await pressRetest(fx);
    await waitFor(() => expect(screen.getByTestId(`text-verdict-${twinId}`).textContent).toBe("Closed"), { timeout: 8_000 });
    expect(screen.queryByTestId(`retest-status-${twinId}`)).toBeNull();
  });

  it("200 stopped while the engine waited: Stopped, with no verdict and no Stop", async () => {
    const fx = load("pr71-143279e", "stopped-while-waiting");
    const twinId = await pressRetest(fx);
    await waitFor(() => expect(screen.getByTestId(`text-retest-phase-${twinId}`).textContent).toBe("Stopped"));
    expect(screen.queryByTestId(`verdict-${twinId}`)).toBeNull();
    expect(screen.queryByTestId(`button-stop-retest-${twinId}`)).toBeNull();
  });

  it("200 failed: Failed, in the engine's words", async () => {
    const fx = load("pr71-143279e", "failed");
    const twinId = await pressRetest(fx);
    await waitFor(() => expect(screen.getByTestId(`text-retest-phase-${twinId}`).textContent).toBe("Failed"));
    expect(screen.getByTestId(`text-retest-status-${twinId}`).textContent).toContain(retestOf(fx).body.error);
    expect(screen.queryByTestId(`verdict-${twinId}`)).toBeNull();
  });

  it("201 verdict on #71, and the synchronous verdict on main, are drawn as verdicts", async () => {
    for (const [dir, word] of [["pr71-143279e", "Closed"], ["main-5779e99", "Closed"]] as const) {
      const fx = load(dir, "verdict-closed");
      const twinId = await pressRetest(fx);
      await waitFor(() => expect(screen.getByTestId(`text-verdict-${twinId}`).textContent, dir).toBe(word));
      expect(screen.queryByTestId(`retest-status-${twinId}`)).toBeNull();
      cleanup();
    }
  });
});

describe("Scans running now lists a running retest from the engine's list", () => {
  it("with a Stop that aborts it by its run_id", async () => {
    const fx = load("pr71-143279e", "running-then-verdict");
    const run = pick(fx, "GET", (p) => p === "/api/scans/active")[0].body.active[0];
    state.fixture = fx;
    state.active = pick(fx, "GET", (p) => p === "/api/scans/active")[0];
    state.abort = abortOf(load("pr71-143279e", "running-then-stopped"));
    realRoutes();
    render(<QueryClientProvider client={queryClient}><RunningScans exclude={null} /></QueryClientProvider>);
    const row = await screen.findByTestId(`running-retest-${run.run_id}`);
    expect(row.textContent).toContain(`retest · engine run ${run.run_id} · running`);
    fireEvent.click(screen.getByTestId(`button-stop-retest-run-${run.run_id}`));
    await waitFor(() => expect(calls).toContain(`POST /api/scans/${run.run_id}/abort`));
  });
});
