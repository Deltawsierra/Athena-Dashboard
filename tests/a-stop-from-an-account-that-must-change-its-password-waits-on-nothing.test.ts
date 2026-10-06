import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";

import { TEST_ADMIN_PASSWORD } from "./test-admin";

/**
 * SAFETY: the first-run admin -- signed in, and made to change its password
 * before anything else -- sends a scan's Stop, a retest's Stop, the kill
 * switch and a failsafe pause exactly as fast as any admin: the guard that
 * refuses it everything else reads nothing, so a read of the account that
 * never answers holds none of them. The bound is the one a stop is held to
 * everywhere else in the suite.
 */

const BOUND_MS = 1_000;
const engineCalls: string[] = [];
let engine: http.Server;
let admin: ReturnType<typeof request.agent>;
let runningTestId: string;
let storage: import("../server/storage").IStorage;

beforeAll(async () => {
  engine = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      engineCalls.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url === "/api/scans/active" ? { active: [] } : {}));
    });
  });
  await new Promise<void>((ready) => engine.listen(0, "127.0.0.1", ready));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  storage = (await import("../server/storage-unified")).storage;
  const app = createApp();
  await initializeDefaultData();
  admin = request.agent(app);
  const login = await admin.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  expect(login.body.user.mustChangePassword).toBe(true);
  expect((await admin.get("/api/clients")).body).toEqual({ error: "password change required" });
  const client = await storage.createClient({ name: "Running", company: "R", email: "running@r.test" });
  runningTestId = (await storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "running",
    findings: { runId: "run-flagged-1", target: "https://offline.invalid/", results: [] },
  })).id;
});

afterAll(async () => {
  vi.restoreAllMocks();
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  engine.closeAllConnections?.();
  await new Promise<void>((done) => engine.close(() => done()));
});

describe("a stop from an account that must change its password waits on nothing", () => {
  it("a scan's Stop, a retest's Stop, the kill switch and a pause answer within the bound while every read of the account hangs", async () => {
    // From here, a read of the account never answers.
    vi.spyOn(storage, "getUser").mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(storage, "getUserByUsername").mockImplementation(() => new Promise(() => undefined));

    const timed = async (send: () => request.Test) => {
      const t0 = performance.now();
      const res = await send().timeout({ response: 10_000, deadline: 10_000 });
      return { res, took: performance.now() - t0 };
    };

    const scanStop = await timed(() => admin.post(`/api/scans/${runningTestId}/abort`).send({}));
    expect(scanStop.res.status).toBe(200);
    expect(scanStop.took).toBeLessThan(BOUND_MS);
    expect(engineCalls).toContain("POST /api/scans/run-flagged-1/abort");

    const retestStop = await timed(() => admin.post("/api/retests/run-flagged-2/abort").send({}));
    expect(retestStop.res.body).not.toEqual({ error: "password change required" });
    expect(retestStop.took).toBeLessThan(BOUND_MS);

    const pause = await timed(() => admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "engine-1", reason: "stop" }));
    expect(pause.res.body).not.toEqual({ error: "password change required" });
    expect(pause.took).toBeLessThan(BOUND_MS);

    const killSwitch = await timed(() => admin.patch("/api/ai-control").send({ killSwitchEnabled: true }));
    expect(killSwitch.res.status).toBe(200);
    expect(killSwitch.res.body.killSwitchEnabled).toBe(true);
    expect(killSwitch.took).toBeLessThan(BOUND_MS);
  });
});
