import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import { makeApp, signInToBackendWithCookie } from "./helpers";
import { TEST_ADMIN_PASSWORD } from "./test-admin";
import { stallingBackend, type StallingBackend } from "./helpers/stalling-backend";
import { _setReadDeadlineForTests, boundedRelayRead } from "../server/read-deadline";
import { readSignalFor } from "../server/control-plane";

/**
 * SAFETY: no read may delay a stop. A browser keeps six connections to this server
 * (Chromium, so Electron, over HTTP/1.1), and a request past them waits for one to
 * free -- a pause included. Here an http.Agent of six sockets stands in for that
 * pool: six assurance reads the backend stalls mid-answer fill it, and a pause of
 * the deployment sent after them is answered, because each read is cut at the read
 * deadline (server/read-deadline.ts, shortened here) and its connection freed.
 *
 * And the stop itself is never under a read's deadline: a pause the backend is
 * slow to answer outlives a read's deadline and is answered, and the control-plane
 * client never gives a stop (or any write) a read's cancellation signal.
 *
 * No clock is read: the tests wait on the answers themselves.
 */

const DEPLOYMENT = "00000000-0000-4000-8000-0000000000bb";
const READ = `/api/assurance/deployments/${DEPLOYMENT}/posture`;
const PAUSE = `/api/assurance/deployments/${DEPLOYMENT}/recompute`;

let app: Express;
let server: http.Server;
let port: number;
let cookie: string;
let backend: StallingBackend;
const ENV = ["ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD"] as const;
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));

beforeAll(async () => {
  app = await makeApp();
  const login = await request(app).post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  cookie = (login.headers["set-cookie"] as unknown as string[]).map((one) => one.split(";")[0]).join("; ");
  server = http.createServer(app);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(async () => {
  backend = await stallingBackend();
  process.env.ATHENA_FAILSAFE_URL = backend.url;
  process.env.ATHENA_FAILSAFE_USER = "svc-dashboard";
  process.env.ATHENA_FAILSAFE_PASSWORD = "stand-in-only"; // pragma: allowlist secret
  (await import("../server/control-plane"))._resetForTests();
  // T6: the person reads the backend as themselves; signed in to this one.
  await signInToBackendWithCookie(app, cookie);
  _setReadDeadlineForTests(300);
});

afterEach(async () => {
  _setReadDeadlineForTests(null);
  await backend.close();
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

interface Outcome {
  status: number | null;
  complete: boolean;
  body: string;
}

function send(agent: http.Agent, method: string, path: string, body?: string): Promise<Outcome> {
  return new Promise((settle) => {
    const req = http.request(
      {
        host: "127.0.0.1", port, path, method, agent,
        headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => settle({ status: res.statusCode ?? null, complete: res.complete, body: text }));
        res.on("error", () => settle({ status: res.statusCode ?? null, complete: false, body: text }));
      },
    );
    req.on("error", () => settle({ status: null, complete: false, body: "" }));
    if (body) req.write(body);
    req.end();
  });
}

describe("six stalled assurance reads never hold back a stop", () => {
  it("with the browser's six connections all held by stalled reads, a pause sent after them is answered", async () => {
    const pool = new http.Agent({ keepAlive: true, maxSockets: 6 });
    const reads = Array.from({ length: 6 }, () => send(pool, "GET", READ));
    // All six reached the backend, which holds each mid-answer: the pool is full.
    await backend.readsAtLeast(6);
    expect(backend.open()).toBe(6);
    // The pause queues behind them in the pool, as a browser's would.
    const paused = await send(pool, "POST", PAUSE, JSON.stringify({ paused: true }));
    expect(paused.status).toBe(200);
    expect(JSON.parse(paused.body).decision).toBe("paused");
    expect(backend.seen.some((one) => one.method === "POST" && one.path === `${PAUSE}/` && one.body === JSON.stringify({ paused: true }))).toBe(true);
    // Each stalled read was answered 504 at the deadline, and the backend's six answers abandoned.
    for (const outcome of await Promise.all(reads)) expect(outcome.status).toBe(504);
    await backend.closedAtLeast(6);
    expect(backend.open()).toBe(0);
    pool.destroy();
  });
});

describe("a stop is never under a read's deadline", () => {
  it("a pause the backend is slow to answer outlives a read's deadline, and is answered", async () => {
    backend.holdPosts();
    const pool = new http.Agent({ keepAlive: true, maxSockets: 6 });
    const pause = send(pool, "POST", PAUSE, JSON.stringify({ paused: true }));
    await backend.arrived((one) => one.method === "POST" && one.path === `${PAUSE}/`);
    // A read started after the pause, and cut at its deadline: the deadline has passed.
    const read = await send(pool, "GET", READ);
    expect(read.status).toBe(504);
    // The pause was not: it is still waiting on the backend, and is answered when it answers.
    backend.releasePosts();
    const paused = await pause;
    expect(paused.status).toBe(200);
    expect(JSON.parse(paused.body).decision).toBe("paused");
    pool.destroy();
  });

  it("the control-plane client gives a read the deadline's signal, and never a stop or a write", async () => {
    const probe = express();
    probe.use(boundedRelayRead({ who: "a test", what: "a probe" }));
    probe.get("/probe", (_req, res) => {
      res.json({
        read: readSignalFor({}) !== undefined,
        head: readSignalFor({ method: "HEAD" }) !== undefined,
        stop: readSignalFor({ stop: true }) !== undefined,
        stopRead: readSignalFor({ method: "GET", stop: true }) !== undefined,
        post: readSignalFor({ method: "POST" }) !== undefined,
        patch: readSignalFor({ method: "PATCH" }) !== undefined,
      });
    });
    const res = await request(probe).get("/probe");
    expect(res.body).toEqual({ read: true, head: true, stop: false, stopRead: false, post: false, patch: false });
    // Outside a bounded read, nothing.
    expect(readSignalFor({})).toBeUndefined();
  });
});
