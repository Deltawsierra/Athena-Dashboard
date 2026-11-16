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
 * SAFETY (DASH-DECLARE): declaring an incident's scope is on no stop's path. Whatever
 * Athena-Backend does with the declaration's read (GET .../scope-choices, which reads the
 * finding, the deployment's assets and workflows and the current scope) or with its post
 * (POST .../declare-scope, the backend's POST scope-revisions/) -- takes it and never
 * answers, fails, or answers something that is not an answer -- a scan's Stop and the kill
 * switch reach the engine within the existing 300 ms bound.
 *
 * The browser's pool is stood in for by an http.Agent of six sockets, kept alive
 * (Chromium's per-origin limit over HTTP/1.1, so Electron's), as in
 * a-stop-goes-while-a-scope-read-hangs-fails-or-answers-nonsense.test.ts. The recovery
 * screen opens one incident's declaration form at a time and sends one declaration at a
 * time (client/src/components/authority/DeclareScope.tsx; pinned by
 * tests/a-scope-declaration-never-holds-the-stop-control-or-the-failsafe-panel.test.tsx),
 * beside one open scope history (#105). So the most the screen can hold is the form's
 * read, its post and a scope read: all three go through the pool first and are held,
 * then the stop goes through the same pool.
 *
 * The form's read is cut at the read deadline like every assurance read. The post is a
 * write, never under a read's deadline: it is bounded by the control plane call's own
 * timeout (server/control-plane.ts, 15 s), after which this server answers that the
 * outcome is not known and abandons the backend's request.
 *
 * The stand-in engine runs in a process of its own, so when the stop arrives is measured
 * by a clock this process's event loop cannot hold up.
 */

/** A stop reaches the engine within this many ms of the press. */
const STOP_BOUND_MS = 300;
const BROWSER_CONNECTIONS = 6;
/** The control plane call's own bound on a request that is not a stop (server/control-plane.ts TIMEOUT_MS), and a margin for this machine. */
const CALL_BOUND_MS = 15_000;
const MARGIN_MS = 3_000;

const FINDING = "f0f0f0f0-0000-4000-8000-0000000000f8";
const CHOICES = `/api/assurance/findings/${FINDING}/scope-choices`;
const DECLARE = `/api/assurance/findings/${FINDING}/declare-scope`;
const SCOPE_READ = `/api/assurance/findings/${FINDING}/scope-revisions`;
const BODY = {
  items: [{ kind: "asset", ref: "a0a0a0a0-0000-4000-8000-0000000000a2" }],
  reason: "a backup gateway answered in the firewall export",
  evidence: ["e0e0e0e0-0000-4000-8000-0000000000e2"],
};

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

/** What the stand-in backend does with the declaration's post. */
type PostAnswer = "hang" | "error" | "not json" | "not an answer";

/**
 * A stand-in Athena-Backend: a SimpleJWT sign-in; every read of the incident (the finding,
 * its scope) taken and never answered; and the declaration answered as the test says.
 * Every other path is 404.
 */
async function declarationStandIn() {
  const held = new Map<http.ServerResponse, string>();
  const seen: Array<{ method: string; path: string }> = [];
  let closed = 0;
  const stand = {
    url: "", post: "hang" as PostAnswer, seen,
    holding: (what?: string) => [...held.values()].filter((one) => what === undefined || one === what).length,
    closed: () => closed, close: async () => undefined as void,
  };
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
      const hold = (what: string) => {
        held.set(res, what);
        res.on("close", () => { if (held.delete(res)) closed += 1; });
      };
      if (method === "GET" && at === `/api/assurance/findings/${FINDING}/`) return hold("the form's read");
      if (method === "GET" && at === `/api/assurance/findings/${FINDING}/scope-revisions/`) return hold("a scope read");
      if (method === "POST" && at === `/api/assurance/findings/${FINDING}/scope-revisions/`) {
        if (stand.post === "hang") return hold("the declaration");
        if (stand.post === "error") return json(500, { detail: "Server Error (500)" });
        if (stand.post === "not json") {
          res.writeHead(201, { "Content-Type": "text/html" });
          return res.end("<html><body>gateway error</body></html>");
        }
        return json(200, ["revision 2", null]);
      }
      return json(404, { detail: "Not found." });
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  stand.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stand.close = async () => {
    for (const res of held.keys()) res.destroy();
    server.closeAllConnections?.();
    await new Promise<void>((done) => server.close(() => done()));
  };
  return stand;
}

let engine: Engine;
let stand: Awaited<ReturnType<typeof declarationStandIn>>;
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
  stand = await declarationStandIn();
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${engine.port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test"; // pragma: allowlist secret
  process.env.ATHENA_FAILSAFE_URL = stand.url;
  process.env.ATHENA_FAILSAFE_USER = "svc-dashboard";
  process.env.ATHENA_FAILSAFE_PASSWORD = "stand-in-only"; // pragma: allowlist secret
  app = await makeApp();
  const login = await request(app).post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  cookie = (login.headers["set-cookie"] as unknown as string[]).map((one) => one.split(";")[0]).join("; ");
  // The declaration and its read go as the signed-in person: signed in to the stand-in backend.
  await signInToBackendWithCookie(app, cookie);
  server = http.createServer(app);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  appPort = (server.address() as AddressInfo).port;
});

afterEach(() => {
  pool?.destroy();
  _setReadDeadlineForTests(null);
  stand.post = "hang";
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
  const client = await storage.createClient({ name: `Client ${runId}`, company: "Declare", email: `${runId}@declare.test` });
  const test = await storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "running",
    findings: { runId, target: "https://victim.example.test/", results: [] },
  });
  return test.id;
}

/**
 * The most the recovery screen can hold, sent through the browser's pool and held by the backend, unanswered:
 * the form's read, its declaration and a scope read. `settled()` says whether anything has answered any of them.
 */
async function theScreenHoldsAllItCan(): Promise<{ settled: () => boolean }> {
  pool = new http.Agent({ keepAlive: true, maxSockets: BROWSER_CONNECTIONS });
  let settled = 0;
  void call(pool, "GET", CHOICES).then(() => { settled += 1; });
  void call(pool, "POST", DECLARE, BODY).then(() => { settled += 1; });
  void call(pool, "GET", SCOPE_READ).then(() => { settled += 1; });
  await waitFor(
    () => stand.holding("the form's read") >= 1 && stand.holding("the declaration") >= 1 && stand.holding("a scope read") >= 1,
    "the backend holding the form's read, its declaration and a scope read",
  );
  return { settled: () => settled > 0 };
}

type RouteLayer = { route?: { path: string | string[]; methods: Record<string, boolean>; stack: Array<{ handle: { name: string } }> }; handle: { name: string }; match: (path: string) => boolean };
const stack = () => (app as unknown as { _router: { stack: RouteLayer[] } })._router.stack;

/** Whether a request to `at` with `method` passes a read-deadline layer before its handler. */
function bounded(method: string, at: string): boolean {
  for (const layer of stack()) {
    if (!layer.match(at)) continue;
    if (!layer.route && layer.handle.name === "boundedRelayReadLayer" && (method === "GET" || method === "HEAD")) return true;
    if (layer.route) {
      if (!layer.route.methods[method.toLowerCase()]) continue;
      return layer.route.stack.some((one) => one.handle.name === "boundedRelayReadLayer");
    }
  }
  return false;
}

/** The methods this server routes on a path ending `suffix` that matches `at`, as `METHOD`. */
function methodsOn(suffix: string, at: string): string[] {
  return stack()
    .filter((layer) => layer.route && typeof layer.route.path === "string" && layer.route.path.endsWith(suffix) && layer.match(at))
    .flatMap((layer) => Object.keys(layer.route!.methods).filter((method) => layer.route!.methods[method]).map((method) => method.toUpperCase()));
}

describe("a stop goes while a declaration and its read hang", () => {
  it("a scan's Stop, sent through the browser's six connections while the form's read, its declaration and a scope read are held, reaches the engine within 300 ms", async () => {
    const runId = "victim-declare-hang";
    const testId = await runningScan(runId);
    const held = await theScreenHoldsAllItCan();
    engine.calls.length = 0;
    const pressed = Date.now();
    const stopped = await call(pool, "POST", `/api/scans/${testId}/abort`);
    expect(stopped.status, stopped.body).toBe(200);
    const got = await arrived(engine, `POST /api/scans/${runId}/abort`);
    expect(got, "the Stop never reached the engine").toBeDefined();
    console.log(`[declare] a scan's Stop reached the engine ${got!.at - pressed} ms after the press, the declaration and its read held open`);
    expect(got!.at - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
    expect(stand.holding("the declaration")).toBeGreaterThanOrEqual(1);
    expect(held.settled(), "something the screen held was answered before the stop").toBe(false);
  }, 30_000);

  it("the kill switch, engaged through the same pool while they are held, reaches the engine with its stop within 300 ms", async () => {
    const runId = "victim-declare-kill";
    await runningScan(runId);
    const held = await theScreenHoldsAllItCan();
    engine.calls.length = 0;
    const pressed = Date.now();
    const answer = await call(pool, "PATCH", "/api/ai-control", { killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] });
    expect(answer.status, answer.body).toBe(200);
    expect(JSON.parse(answer.body).killSwitchEnabled).toBe(true);
    const got = await arrived(engine, `POST /api/scans/${runId}/abort`);
    expect(got, "the kill switch's stop never reached the engine").toBeDefined();
    console.log(`[declare] the kill switch's stop reached the engine ${got!.at - pressed} ms after the press, the declaration and its read held open`);
    expect(got!.at - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
    expect(held.settled()).toBe(false);
    // Released again, for the tests after this one.
    const released = await call(pool, "PATCH", "/api/ai-control", { killSwitchEnabled: false, systemStatus: "active" });
    expect(released.status, released.body).toBe(200);
  }, 30_000);
});

describe("a stop goes after a declaration that failed or answered nonsense", () => {
  for (const [answer, what] of [["error", "a 500"], ["not json", "a 201 whose body is not JSON"], ["not an answer", "a 200 that is not an answer"]] as const) {
    it(`a declaration answered with ${what} is said as not known, never as recorded, and a scan's Stop sent after it reaches the engine within 300 ms`, async () => {
      const runId = `victim-declare-${answer.replace(/ /g, "-")}`;
      const testId = await runningScan(runId);
      stand.post = answer;
      pool = new http.Agent({ keepAlive: true, maxSockets: BROWSER_CONNECTIONS });
      const declared = await call(pool, "POST", DECLARE, BODY);
      if (answer === "not json") {
        // A 201 is the backend's recording, whatever its body: this server reads no body of it.
        expect(declared.status, declared.body).toBe(201);
      } else {
        expect(declared.status, declared.body).toBe(503);
        expect(JSON.parse(declared.body).code).toBe("outcome_unknown");
      }
      engine.calls.length = 0;
      const pressed = Date.now();
      const stopped = await call(pool, "POST", `/api/scans/${testId}/abort`);
      expect(stopped.status, stopped.body).toBe(200);
      const got = await arrived(engine, `POST /api/scans/${runId}/abort`);
      expect(got, "the Stop never reached the engine").toBeDefined();
      console.log(`[declare] a scan's Stop reached the engine ${got!.at - pressed} ms after the press, after a declaration answered ${what}`);
      expect(got!.at - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
    }, 30_000);
  }
});

describe("neither the declaration nor its read keeps a connection of the browser without a bound", () => {
  it("the form's read is a GET under the read deadline; the declaration is a POST of its own, never under a read's deadline, on a path no read uses", () => {
    expect(methodsOn("/scope-choices", CHOICES)).toEqual(["GET"]);
    expect(bounded("GET", CHOICES)).toBe(true);
    expect(methodsOn("/declare-scope", DECLARE)).toEqual(["POST"]);
    expect(bounded("POST", DECLARE)).toBe(false);
    // The scope read's own path is still a read and nothing else (#105).
    expect(methodsOn("/scope-revisions", SCOPE_READ)).toEqual(["GET"]);
  });

  it("the form's read, held by the backend, is cut at the read deadline and its backend read abandoned, with a Stop queued behind it answered", async () => {
    const runId = "victim-declare-deadline";
    const testId = await runningScan(runId);
    _setReadDeadlineForTests(300);
    const closedBefore = stand.closed();
    pool = new http.Agent({ keepAlive: true, maxSockets: BROWSER_CONNECTIONS });
    const reads = Array.from({ length: BROWSER_CONNECTIONS }, () => call(pool, "GET", CHOICES));
    await waitFor(() => stand.holding("the form's read") >= BROWSER_CONNECTIONS, "six of the form's reads held by the backend");
    engine.calls.length = 0;
    const stopped = await call(pool, "POST", `/api/scans/${testId}/abort`);
    expect(stopped.status, stopped.body).toBe(200);
    expect(await arrived(engine, `POST /api/scans/${runId}/abort`), "the Stop never reached the engine").toBeDefined();
    for (const outcome of await Promise.all(reads)) {
      expect(outcome.status).toBe(504);
      expect(JSON.parse(outcome.body)).toEqual({ error: "Athena-Backend did not answer this assurance read in time", code: "backend_timeout" });
    }
    await waitFor(() => stand.closed() - closedBefore >= BROWSER_CONNECTIONS, "the backend's six held reads abandoned");
    expect(stand.holding("the form's read")).toBe(0);
  }, 30_000);

  it("a declaration the backend never answers is answered within the control plane call's own bound, as not known, and its backend request is abandoned", async () => {
    pool = new http.Agent({ keepAlive: true, maxSockets: BROWSER_CONNECTIONS });
    const closedBefore = stand.closed();
    const sent = Date.now();
    const declared = await call(pool, "POST", DECLARE, BODY);
    const took = Date.now() - sent;
    console.log(`[declare] a declaration the backend never answered was answered ${declared.status} after ${took} ms`);
    expect(declared.status, declared.body).toBe(503);
    expect(JSON.parse(declared.body)).toMatchObject({ code: "outcome_unknown", backendStatus: null });
    expect(took).toBeLessThanOrEqual(CALL_BOUND_MS + MARGIN_MS);
    await waitFor(() => stand.closed() > closedBefore, "the backend's held declaration abandoned");
    expect(stand.holding("the declaration")).toBe(0);
  }, 40_000);
});
