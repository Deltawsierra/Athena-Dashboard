import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import request from "supertest";

import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";
import { controlPlaneStandIn, newServiceToken, type ControlPlaneStandIn } from "./helpers/control-plane-stand-in";

/**
 * SAFETY RULE: the console's read of Athena-Backend's health (server/backend-health.ts)
 * never delays a stop. Here the backend's /api/health/ hangs -- its headers never
 * sent, or its body stalled half-way -- while it is being read, and each stop is
 * pressed then:
 *
 *   - a scan's Stop, which goes to the engine;
 *   - a failsafe pause, relayed to the SAME backend whose health read hangs;
 *   - the kill switch, which sends a stop for every scan that may be running.
 *
 * Each reaches its destination within STOP_BOUND_MS of the press (the existing
 * bound: tests/a-stop-presents-the-service-token-and-waits-on-no-sign-in.test.ts),
 * and the health read is still hanging after it: nothing on a stop's way waited
 * for it, or cut it short.
 *
 * The engine stand-in runs in a process of its own and stamps each request's
 * arrival (tests/helpers/engine-in-its-own-process.cjs); the control plane's
 * stand-in stamps each stop's arrival on this process's monotonic clock.
 */

/** A stop reaches its destination within this many ms of the press. */
const STOP_BOUND_MS = 300;

const TOKEN = newServiceToken();
const engineCalls: Array<{ line: string; at: number }> = [];
let engine: ChildProcess;
let enginePort = 0;
const ENV = ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD", "ATHENA_FAILSAFE_SERVICE_TOKEN"] as const;
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));

beforeAll(async () => {
  engine = spawn(process.execPath, [path.join(__dirname, "helpers", "engine-in-its-own-process.cjs")], { stdio: ["ignore", "pipe", "inherit"] });
  let buffer = "";
  await new Promise<void>((ready) => {
    engine.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const one = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (one.port) { enginePort = one.port; ready(); } else engineCalls.push(one);
      }
    });
  });
});

afterAll(() => {
  engine.kill();
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** The control plane, behind a front whose /api/health/ hangs; everything else is passed through. */
async function hangingHealthFront(target: string, how: "headers" | "body") {
  const held: http.ServerResponse[] = [];
  let healthAsked = 0;
  const server = http.createServer((req, res) => {
    if ((req.url ?? "").split("?")[0] === "/api/health/") {
      healthAsked += 1;
      held.push(res);
      if (how === "body") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"status": "ok", "counts": {"stderr_lines_lo');
      }
      return; // never finished
    }
    const upstream = http.request(`${target}${req.url}`, { method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    healthAsked: () => healthAsked,
    /** Whether a health read is held open now. */
    hanging: () => held.some((res) => !res.writableEnded && !res.destroyed),
    close: async () => {
      for (const res of held) res.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

let plane: ControlPlaneStandIn | null = null;
let front: Awaited<ReturnType<typeof hangingHealthFront>> | null = null;
let resetHealth: (() => void) | null = null;

afterEach(async () => {
  resetHealth?.();
  await front?.close();
  await plane?.close();
  front = null;
  plane = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function engineArrival(line: string, ms = 3_000) {
  for (let waited = 0; waited <= ms; waited += 10) {
    const one = engineCalls.find((call) => call.line === line);
    if (one) return one;
    await sleep(10);
  }
  return undefined;
}

/** A console signed in as an admin, two scans recorded as running, and its read of the backend's health hanging. */
async function boot(how: "headers" | "body", tag: string) {
  plane = await controlPlaneStandIn({ serviceToken: TOKEN });
  front = await hangingHealthFront(plane.url, how);
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${enginePort}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  process.env.ATHENA_FAILSAFE_URL = front.url;
  process.env.ATHENA_FAILSAFE_USER = "svc-failsafe";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc-password"; // pragma: allowlist secret
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = TOKEN;
  process.env.ATHENA_STORAGE = "memory";
  process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-characters"; // pragma: allowlist secret
  process.env.NODE_ENV = "test";
  vi.resetModules();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  const health = await import("../server/backend-health");
  // Long enough that the read is still hanging when every stop has been pressed.
  health.backendHealthTimings.timeoutMs = 60_000;
  // Started as the server's entry points start it.
  health.startBackendHealthReads();
  resetHealth = health._resetBackendHealthForTests;
  const app = createApp();
  await initializeDefaultData();
  await adminHasSetPassword();
  const admin = request.agent(app);
  expect((await admin.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD })).status).toBe(200);
  const { storage } = await import("../server/storage-unified");
  const client = await storage.createClient({ name: "Health", company: "Health", email: "h@h.test" });
  const scan = async (runId: string) => (await storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "running",
    findings: { runId, target: "https://offline.invalid/", results: [] },
  })).id;
  const scans = { stop: await scan(`stop-${tag}`), kill: await scan(`kill-${tag}`) };

  // The console asks for the backend's health; the backend takes the read and never finishes it.
  expect((await admin.get("/api/backend-health")).status).toBe(200);
  for (let i = 0; i < 300 && !front.hanging(); i += 1) await sleep(10);
  expect(front.hanging(), "the health read is hanging").toBe(true);
  return { admin, scans };
}

describe.each([
  ["its headers never sent", "headers" as const],
  ["its body stalled half-way", "body" as const],
])("the backend's health read hanging, %s", (_label, how) => {
  it("a scan's Stop, a failsafe pause and the kill switch each arrive within the bound, and the health read is still hanging", async () => {
    const { admin, scans } = await boot(how, how);

    // A scan's Stop, to the engine.
    let pressed = Date.now();
    const stopped = await admin.post(`/api/scans/${scans.stop}/abort`);
    const stopArrived = await engineArrival(`POST /api/scans/stop-${how}/abort`);
    expect(stopped.status).toBe(200);
    expect(stopArrived, "the scan's Stop reached the engine").toBeDefined();
    expect(stopArrived!.at - pressed, "the scan's Stop").toBeLessThan(STOP_BOUND_MS);
    expect(front!.hanging()).toBe(true);

    // A failsafe pause, to the backend whose health read hangs.
    const from = plane!.seen.length;
    const pausePressed = performance.now();
    const paused = await admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "engine-1", reason: "health hangs" });
    const pause = plane!.seen.slice(from).find((one) => one.method === "POST" && one.path === "/api/failsafe/commands/" && one.body.includes('"pause"'));
    expect(paused.status).toBe(201);
    expect(pause, "the pause reached the control plane").toBeDefined();
    expect(pause!.serviceToken).toBe(TOKEN);
    expect(pause!.at - pausePressed, "the failsafe pause").toBeLessThan(STOP_BOUND_MS);
    expect(front!.hanging()).toBe(true);

    // The kill switch.
    pressed = Date.now();
    const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
    const killArrived = await engineArrival(`POST /api/scans/kill-${how}/abort`);
    expect(engaged.status).toBe(200);
    expect(killArrived, "the kill switch's stop reached the engine").toBeDefined();
    expect(killArrived!.at - pressed, "the kill switch").toBeLessThan(STOP_BOUND_MS);
    expect(front!.hanging()).toBe(true);

    // One health read, still hanging: no stop asked for another, or waited on this one.
    expect(front!.healthAsked()).toBe(1);
  }, 30_000);
});
