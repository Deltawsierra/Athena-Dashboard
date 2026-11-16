import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";
import type { Express } from "express";
import request from "supertest";

import { makeApp, signInToBackendWithCookie, TEST_ADMIN_PASSWORD } from "./helpers";
import { _setReadDeadlineForTests } from "../server/read-deadline";

/**
 * SAFETY (DASH-SCOPE): the read of an incident's scope
 * (GET /api/assurance/findings/<uuid>/scope-revisions, server/assurance.ts findingScope)
 * is on no stop's path. Whatever Athena-Backend does with it -- takes it and never
 * answers, stalls mid-answer, errors, or answers something that is not a scope -- a
 * scan's Stop and the kill switch reach the engine within the existing 300 ms bound.
 *
 * The browser's pool is stood in for by an http.Agent of six sockets, kept alive
 * (Chromium's per-origin limit over HTTP/1.1, so Electron's), as in
 * a-stop-goes-while-the-backend-health-read-hangs.test.ts. The recovery screen opens one
 * incident's scope at a time (client/src/components/authority/IncidentScope.tsx
 * OneScopeAtATime; pinned by
 * tests/a-scope-read-never-holds-the-stop-control-or-the-failsafe-panel.test.tsx), so
 * one scope read is the most the page can have in flight: it goes through the pool
 * first and is held, then the stop goes through the same pool.
 *
 * And were six of them ever in flight -- more than the page can start -- none could keep
 * a connection past the read deadline (server/read-deadline.ts, shortened here): each is
 * answered 504, its backend read is cancelled, and a Stop queued behind them is answered.
 *
 * The stand-in engine runs in a process of its own, so when the stop arrives is measured
 * by a clock this process's event loop cannot hold up.
 */

/** A stop reaches the engine within this many ms of the press. */
const STOP_BOUND_MS = 300;
/** The most scope reads the recovery screen has in flight: one incident's scope is open at a time. */
const SCOPE_READS_THE_PAGE_CAN_HOLD = 1;
const BROWSER_CONNECTIONS = 6;

const FINDING = "f0f0f0f0-0000-4000-8000-0000000000f7";
const SCOPE_READ = `/api/assurance/findings/${FINDING}/scope-revisions`;

interface Engine {
  port: number;
  calls: Array<{ line: string; at: number }>;
  kill: () => void;
}
async function spawnEngine(): Promise<Engine> {
  const calls: Array<{ line: string; at: number }> = [];
  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(__dirname, "helpers", "engine-in-its-own-process.cjs")],
    { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ENGINE_BIND_HOST: "127.0.0.1" } },
  );
  let buffer = "";
  const port = await new Promise<number>((ready) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const one = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (one.port) ready(one.port); else calls.push(one);
      }
    });
  });
  return { port, calls, kill: () => child.kill() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function arrived(engine: Engine, line: string) {
  for (let tries = 0; tries < 1_600; tries += 1) {
    const one = engine.calls.find((c) => c.line === line);
    if (one) return one;
    await sleep(5);
  }
  return undefined;
}

/** What the stand-in backend does with a scope read. */
type ScopeAnswer = "hang" | "stall" | "error" | "not json" | "not a scope";

/**
 * A stand-in Athena-Backend: a SimpleJWT sign-in, and the scope read answered as the
 * test says -- taken and never answered, stalled after its first bytes, a 500, a page
 * that is not JSON, or JSON that is not a scope. Every other path is 404.
 */
async function scopeStandIn() {
  const held = new Set<http.ServerResponse>();
  const seen: Array<{ method: string; path: string }> = [];
  let closed = 0;
  const stand = { url: "", answer: "hang" as ScopeAnswer, seen, holding: () => held.size, closed: () => closed, close: async () => undefined as void };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const at = new URL(req.url ?? "/", "http://stand-in").pathname;
      const method = req.method ?? "GET";
      const json = (code: number, payload: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (at === "/api/token/" && method === "POST") return json(200, { access: "access-for-admin", refresh: "refresh-for-admin" });
      if (at === "/api/token/refresh/") return json(200, { access: "access-for-admin", refresh: "refresh-for-admin" });
      seen.push({ method, path: at });
      if (method !== "GET" || !/^\/api\/assurance\/findings\/[^/]+\/scope-revisions\/$/.test(at)) return json(404, { detail: "Not found." });
      const hold = () => {
        held.add(res);
        res.on("close", () => { if (held.delete(res)) closed += 1; });
      };
      if (stand.answer === "hang") return hold();
      if (stand.answer === "stall") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"deployment": "d", "revisions": [');
        return hold();
      }
      if (stand.answer === "error") return json(500, { detail: "Server Error (500)" });
      if (stand.answer === "not json") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<html><body>gateway error</body></html>");
      }
      return json(200, ["revision 1", 2, null]);
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  stand.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stand.close = async () => {
    for (const res of held) res.destroy();
    server.closeAllConnections?.();
    await new Promise<void>((done) => server.close(() => done()));
  };
  return stand;
}

let engine: Engine;
let stand: Awaited<ReturnType<typeof scopeStandIn>>;
let app: Express;
let server: http.Server;
let appPort = 0;
let cookie = "";
let pool: http.Agent;

interface Answer { status: number | null; body: string }

/** One request through `agent` (the browser's pool), with the session. Settles however the request ends. */
function call(agent: http.Agent, method: string, reqPath: string, body?: unknown): Promise<Answer> {
  return new Promise((settle) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port: appPort, path: reqPath, method, agent,
      headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), cookie },
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => { chunks += c; });
      res.on("end", () => settle({ status: res.statusCode ?? null, body: chunks }));
      res.on("error", () => settle({ status: res.statusCode ?? null, body: chunks }));
    });
    req.on("error", () => settle({ status: null, body: "" }));
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor(test: () => boolean, what: string, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!test()) {
    if (Date.now() > until) throw new Error(`never happened: ${what}`);
    await sleep(5);
  }
}

const ENV = ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD", "ATHENA_STORAGE"] as const;
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));

beforeAll(async () => {
  engine = await spawnEngine();
  stand = await scopeStandIn();
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${engine.port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test"; // pragma: allowlist secret
  process.env.ATHENA_FAILSAFE_URL = stand.url;
  process.env.ATHENA_FAILSAFE_USER = "svc-dashboard";
  process.env.ATHENA_FAILSAFE_PASSWORD = "stand-in-only"; // pragma: allowlist secret
  app = await makeApp();
  const login = await request(app).post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  cookie = (login.headers["set-cookie"] as unknown as string[]).map((one) => one.split(";")[0]).join("; ");
  // The scope is read as the signed-in person: signed in to the stand-in backend.
  await signInToBackendWithCookie(app, cookie);
  server = http.createServer(app);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  appPort = (server.address() as AddressInfo).port;
});

afterEach(() => {
  pool?.destroy();
  _setReadDeadlineForTests(null);
});

afterAll(async () => {
  engine?.kill();
  await stand?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((done) => server.close(() => done()));
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A running scan the engine is running under `runId`. */
async function runningScan(runId: string): Promise<string> {
  const { storage } = await import("../server/storage-unified");
  const client = await storage.createClient({ name: `Client ${runId}`, company: "Scope", email: `${runId}@scope.test` });
  const test = await storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "running",
    findings: { runId, target: "https://victim.example.test/", results: [] },
  });
  return test.id;
}

/**
 * The page's one scope read, sent through the browser's pool and held by the backend, unanswered.
 * `settled()` says whether anything has answered it since.
 */
async function theScopeReadIsHeld(answer: "hang" | "stall"): Promise<{ settled: () => boolean }> {
  stand.answer = answer;
  const before = stand.seen.length;
  pool = new http.Agent({ keepAlive: true, maxSockets: BROWSER_CONNECTIONS });
  let settled = 0;
  for (let sent = 0; sent < SCOPE_READS_THE_PAGE_CAN_HOLD; sent += 1) void call(pool, "GET", SCOPE_READ).then(() => { settled += 1; });
  await waitFor(() => stand.seen.length - before >= SCOPE_READS_THE_PAGE_CAN_HOLD && stand.holding() >= SCOPE_READS_THE_PAGE_CAN_HOLD, "the backend holding the scope read");
  return { settled: () => settled > 0 };
}

type RouteLayer = { route?: { path: string | string[]; methods: Record<string, boolean>; stack: Array<{ handle: { name: string } }> }; handle: { name: string }; match: (path: string) => boolean };

/** Whether a request to `at` with `method` passes a read-deadline layer before its handler. */
function bounded(method: string, at: string): boolean {
  for (const layer of (app as unknown as { _router: { stack: RouteLayer[] } })._router.stack) {
    if (!layer.match(at)) continue;
    if (!layer.route && layer.handle.name === "boundedRelayReadLayer" && (method === "GET" || method === "HEAD")) return true;
    if (layer.route) {
      if (!layer.route.methods[method.toLowerCase()]) continue;
      return layer.route.stack.some((one) => one.handle.name === "boundedRelayReadLayer");
    }
  }
  return false;
}

/** The methods this server routes on the scope's own path (not a catch-all's), as `METHOD`. */
function scopeRouteMethods(): string[] {
  return (app as unknown as { _router: { stack: RouteLayer[] } })._router.stack
    .filter((layer) => layer.route && typeof layer.route.path === "string" && layer.route.path.endsWith("/scope-revisions") && layer.match(SCOPE_READ))
    .flatMap((layer) => Object.keys(layer.route!.methods).filter((method) => layer.route!.methods[method]).map((method) => method.toUpperCase()));
}

describe("a stop goes while a scope read hangs", () => {
  for (const answer of ["hang", "stall"] as const) {
    it(`a scan's Stop, sent through the browser's six connections while the scope read is held (${answer === "hang" ? "taken, never answered" : "stalled mid-answer"}), reaches the engine within 300 ms`, async () => {
      const runId = `victim-scope-${answer}`;
      const testId = await runningScan(runId);
      const read = await theScopeReadIsHeld(answer);
      engine.calls.length = 0;
      const pressed = Date.now();
      const stopped = await call(pool, "POST", `/api/scans/${testId}/abort`);
      expect(stopped.status, stopped.body).toBe(200);
      const got = await arrived(engine, `POST /api/scans/${runId}/abort`);
      expect(got, "the Stop never reached the engine").toBeDefined();
      console.log(`[scope] a scan's Stop reached the engine ${got!.at - pressed} ms after the press, the scope read held open (${answer})`);
      expect(got!.at - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      // The scope read was held all the while, and nothing had answered it.
      expect(stand.holding()).toBeGreaterThanOrEqual(SCOPE_READS_THE_PAGE_CAN_HOLD);
      expect(read.settled(), "the scope read was answered before the stop").toBe(false);
    }, 30_000);
  }
});

describe("a stop goes after a scope read that failed or answered nonsense", () => {
  for (const [answer, what] of [["error", "a 500"], ["not json", "a page that is not JSON"], ["not a scope", "JSON that is not a scope"]] as const) {
    it(`the scope read answered with ${what} is said as unavailable, and a scan's Stop sent after it reaches the engine within 300 ms`, async () => {
      const runId = `victim-scope-${answer.replace(/ /g, "-")}`;
      const testId = await runningScan(runId);
      stand.answer = answer;
      pool = new http.Agent({ keepAlive: true, maxSockets: BROWSER_CONNECTIONS });
      const read = await call(pool, "GET", SCOPE_READ);
      // Unavailable, never an empty scope: nothing of it is passed on as revisions.
      expect(read.status, read.body).toBe(503);
      expect(JSON.parse(read.body).revisions).toBeUndefined();
      engine.calls.length = 0;
      const pressed = Date.now();
      const stopped = await call(pool, "POST", `/api/scans/${testId}/abort`);
      expect(stopped.status, stopped.body).toBe(200);
      const got = await arrived(engine, `POST /api/scans/${runId}/abort`);
      expect(got, "the Stop never reached the engine").toBeDefined();
      console.log(`[scope] a scan's Stop reached the engine ${got!.at - pressed} ms after the press, after a scope read answered ${what}`);
      expect(got!.at - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
    }, 30_000);
  }
});

describe("no scope read keeps a connection of the browser past the read deadline", () => {
  it("the scope read is a GET under the read deadline and nothing else: this server serves no write on its path", () => {
    expect(scopeRouteMethods()).toEqual(["GET"]);
    expect(bounded("GET", SCOPE_READ)).toBe(true);
    // A stop is never under a read's deadline.
    for (const [method, at] of [["POST", "/api/scans/x1/abort"], ["PATCH", "/api/ai-control"], ["POST", "/api/failsafe/commands"]] as const) {
      expect(bounded(method, at), `${method} ${at}`).toBe(false);
    }
  });

  it("six stalled scope reads fill the browser's connections: each is cut at the deadline, its backend read cancelled, and a Stop queued behind them is answered", async () => {
    const runId = "victim-scope-six";
    const testId = await runningScan(runId);
    _setReadDeadlineForTests(300);
    stand.answer = "stall";
    const before = stand.seen.length;
    const closedBefore = stand.closed();
    pool = new http.Agent({ keepAlive: true, maxSockets: BROWSER_CONNECTIONS });
    const reads = Array.from({ length: BROWSER_CONNECTIONS }, () => call(pool, "GET", SCOPE_READ));
    // All six reached the backend, which holds each mid-answer: the pool is full.
    await waitFor(() => stand.seen.length - before >= BROWSER_CONNECTIONS && stand.holding() >= BROWSER_CONNECTIONS, "six scope reads held by the backend");
    engine.calls.length = 0;
    // The Stop queues behind them in the pool, as a browser's would.
    const stopped = await call(pool, "POST", `/api/scans/${testId}/abort`);
    expect(stopped.status, stopped.body).toBe(200);
    expect(await arrived(engine, `POST /api/scans/${runId}/abort`), "the Stop never reached the engine").toBeDefined();
    // Each stalled read was answered 504 at the deadline, and the backend's six answers abandoned.
    for (const outcome of await Promise.all(reads)) {
      expect(outcome.status).toBe(504);
      expect(JSON.parse(outcome.body)).toEqual({ error: "Athena-Backend did not answer this assurance read in time", code: "backend_timeout" });
    }
    await waitFor(() => stand.closed() - closedBefore >= BROWSER_CONNECTIONS, "the backend's six held answers abandoned");
    expect(stand.holding()).toBe(0);
  }, 30_000);
});

describe("the kill switch goes while a scope read hangs", () => {
  it("engaged through the browser's six connections while the scope read is held, it reaches the engine with its stop within 300 ms", async () => {
    const runId = "victim-scope-kill";
    await runningScan(runId);
    const read = await theScopeReadIsHeld("hang");
    engine.calls.length = 0;
    const pressed = Date.now();
    const answer = await call(pool, "PATCH", "/api/ai-control", { killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] });
    expect(answer.status, answer.body).toBe(200);
    expect(JSON.parse(answer.body).killSwitchEnabled).toBe(true);
    const got = await arrived(engine, `POST /api/scans/${runId}/abort`);
    expect(got, "the kill switch's stop never reached the engine").toBeDefined();
    console.log(`[scope] the kill switch's stop reached the engine ${got!.at - pressed} ms after the press, the scope read held open`);
    expect(got!.at - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
    expect(stand.holding()).toBeGreaterThanOrEqual(SCOPE_READS_THE_PAGE_CAN_HOLD);
    expect(read.settled(), "the scope read was answered before the kill switch").toBe(false);
  }, 30_000);
});
