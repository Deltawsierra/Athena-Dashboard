import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";
import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";
import { healthStandIn, type HealthStandIn } from "./helpers/health-stand-in";

/**
 * SAFETY (DASH-HEALTH-PANEL): the console's read of Athena-Backend's health is
 * on no stop's path. With the backend's /api/health/ taken and never answered,
 * and the browser's six connections to this server all asking for the health
 * strip, a scan's Stop and the kill switch each reach the engine within the
 * existing 300 ms bound.
 *
 * The browser's pool is stood in for by an http.Agent of six sockets, kept
 * alive (Chromium's per-origin limit over HTTP/1.1, so Electron's): the health
 * reads go through it first, then the stop. The health route answers at once
 * from what it last read and never waits on the backend
 * (server/backend-health.ts), so none of the six is held; and the backend read,
 * polled in the background, is its own request on its own socket, which nothing
 * awaits.
 *
 * The stand-in engine runs in a process of its own, so when the stop arrives is
 * measured by a clock this process's event loop cannot hold up (as in
 * a-sign-in-flood-never-delays-a-stop.test.ts).
 */

/** A stop reaches the engine within this many ms of the press. */
const STOP_BOUND_MS = 300;

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

let engine: Engine;
let stand: HealthStandIn;
let server: http.Server;
let appPort = 0;
let cookie = "";
let pool: http.Agent;
let health: typeof import("../server/backend-health");

/** One request through `agent` (the browser's pool), with the session. */
function call(agent: http.Agent | false, method: string, reqPath: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port: appPort, path: reqPath, method, agent,
      headers: {
        ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
        ...(cookie ? { cookie } : {}),
      },
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => { chunks += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: chunks }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const ENV = ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_STORAGE"] as const;
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));

beforeAll(async () => {
  engine = await spawnEngine();
  stand = await healthStandIn({ kind: "hang" });
  process.env.ATHENA_STORAGE = "memory";
  process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-characters";
  process.env.NODE_ENV = "test";
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${engine.port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  process.env.ATHENA_FAILSAFE_URL = stand.url;
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  const app = createApp();
  health = await import("../server/backend-health");
  // The backend's health read is held for the whole case: given up on long after the stop.
  health.backendHealthTiming.deadlineMs = 60_000;
  await initializeDefaultData();
  await adminHasSetPassword();
  server = http.createServer(app);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  appPort = (server.address() as AddressInfo).port;
  const login = await new Promise<{ status: number; setCookie: string }>((resolve, reject) => {
    const data = JSON.stringify({ username: "admin", password: TEST_ADMIN_PASSWORD });
    const req = http.request({
      host: "127.0.0.1", port: appPort, path: "/api/auth/login", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, setCookie: res.headers["set-cookie"]?.[0] ?? "" }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
  expect(login.status).toBe(200);
  cookie = login.setCookie.split(";")[0];
});

afterEach(() => {
  pool?.destroy();
});

afterAll(async () => {
  health?._resetBackendHealthForTests();
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
  const client = await storage.createClient({ name: `Client ${runId}`, company: "Health", email: `${runId}@health.test` });
  const test = await storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "running",
    findings: { runId, target: "https://victim.example.test/", results: [] },
  });
  return test.id;
}

/** The browser's six connections, each asking for the health strip while the backend's health read hangs. */
async function sixHealthReadsWhileTheBackendHangs(): Promise<void> {
  health._resetBackendHealthForTests();
  const before = stand.seen.length;
  // The background poll, as the entry points start it: its read of the backend is taken and never answered.
  health.startBackendHealthPolling();
  pool = new http.Agent({ keepAlive: true, maxSockets: 6 });
  const reads = await Promise.all(Array.from({ length: 6 }, () => call(pool, "GET", "/api/backend-health")));
  for (const read of reads) {
    expect(read.status).toBe(200);
    expect(JSON.parse(read.body).state).not.toBe("ok");
  }
  // The backend's health read is taken and held, unanswered.
  await stand.waitFor(() => stand.seen.length > before && stand.holding() >= 1);
}

describe("a stop goes while the backend's health read hangs", () => {
  it("a scan's Stop, sent through the browser's six connections after six health reads, reaches the engine within 300 ms", async () => {
    const testId = await runningScan("victim-health-stop");
    await sixHealthReadsWhileTheBackendHangs();
    engine.calls.length = 0;
    const pressed = Date.now();
    const answer = await call(pool, "POST", `/api/scans/${testId}/abort`);
    expect(answer.status, answer.body).toBe(200);
    const got = await arrived(engine, "POST /api/scans/victim-health-stop/abort");
    expect(got, "the Stop never reached the engine").toBeDefined();
    console.log(`[health] a scan's Stop reached the engine ${got!.at - pressed} ms after the press, the backend's health read held open`);
    expect(got!.at - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
    // The health read was hanging all the while.
    expect(stand.holding()).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("the kill switch, engaged through the same six connections, reaches the engine with its stop within 300 ms", async () => {
    await runningScan("victim-health-kill");
    await sixHealthReadsWhileTheBackendHangs();
    engine.calls.length = 0;
    const pressed = Date.now();
    const answer = await call(pool, "PATCH", "/api/ai-control", { killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] });
    expect(answer.status, answer.body).toBe(200);
    expect(JSON.parse(answer.body).killSwitchEnabled).toBe(true);
    const got = await arrived(engine, "POST /api/scans/victim-health-kill/abort");
    expect(got, "the kill switch's stop never reached the engine").toBeDefined();
    console.log(`[health] the kill switch's stop reached the engine ${got!.at - pressed} ms after the press, the backend's health read held open`);
    expect(got!.at - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
    expect(stand.holding()).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
