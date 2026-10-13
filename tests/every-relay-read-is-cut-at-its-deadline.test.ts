import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import request from "supertest";
import { makeApp, signIn } from "./helpers";
import { TEST_ADMIN_PASSWORD } from "./test-admin";
import { stallingBackend, type StallingBackend } from "./helpers/stalling-backend";
import { READ_DEADLINE_MS, _setReadDeadlineForTests } from "../server/read-deadline";
import { ASSISTANT_RELAY_READS, ENGINE_RELAY_READS } from "../server/routes";

/**
 * SAFETY: every non-stop relay read holds the browser's connection for at most ONE
 * total deadline, headers and body (server/read-deadline.ts; READ_DEADLINE_MS,
 * shortened here). The economics relay first had it (#67); here every assurance
 * read has it, each found from the app's own routes, and the engine's and the
 * assistant's display reads. Past the deadline the browser is answered 504 and a
 * control-plane read is cancelled with it -- the backend's half-sent answer is
 * abandoned, holding nothing.
 *
 * And the deadline is laid on reads only: no stop, pause, stand-down, terminate or
 * revoke is a GET, and the failsafe console's reads -- which the control plane
 * judges stops -- are not under it (server/failsafe.ts bounds each itself).
 *
 * No clock is read: each read is cut because the deadline fires, and the test
 * waits on the answers themselves.
 */

const UUID = "00000000-0000-4000-8000-0000000000aa";
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let backend: StallingBackend;
const ENV = ["ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD", "ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY"] as const;
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));

type RouteLayer = { route?: { path: string | string[]; methods: Record<string, boolean>; stack: Array<{ handle: { name: string } }> }; name: string; handle: { name: string }; match: (path: string) => boolean };
const stackOf = (express: Express) => (express as unknown as { _router: { stack: RouteLayer[] } })._router.stack;

/** Every GET route the app registers under a prefix, as a path with sample values. */
function getRoutes(express: Express, prefix: string): string[] {
  return stackOf(express)
    .filter((layer) => layer.route && layer.route.methods.get)
    .flatMap((layer) => (Array.isArray(layer.route!.path) ? layer.route!.path : [layer.route!.path]))
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.replace(/:[A-Za-z]+/g, (name) => (name === ":pack" ? "posture" : UUID)));
}

/** Whether a request to `path` with `method` passes a read-deadline layer before its handler. */
function bounded(express: Express, method: string, path: string): boolean {
  for (const layer of stackOf(express)) {
    if (!layer.match(path)) continue;
    if (!layer.route && layer.handle.name === "boundedRelayReadLayer" && (method === "GET" || method === "HEAD")) return true;
    if (layer.route) {
      if (!layer.route.methods[method.toLowerCase()]) continue;
      if (layer.route.stack.some((one) => one.handle.name === "boundedRelayReadLayer")) return true;
      return false; // the route's own handler came first
    }
  }
  return false;
}

beforeAll(async () => {
  app = await makeApp();
  admin = await signIn(app);
});

beforeEach(async () => {
  backend = await stallingBackend();
  process.env.ATHENA_FAILSAFE_URL = backend.url;
  process.env.ATHENA_FAILSAFE_USER = "svc-dashboard";
  process.env.ATHENA_FAILSAFE_PASSWORD = "stand-in-only"; // pragma: allowlist secret
  (await import("../server/control-plane"))._resetForTests();
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

describe("every relay read has one total deadline", () => {
  it("the deadline is 20 s, for headers and body together", () => {
    expect(READ_DEADLINE_MS).toBe(20_000);
  });

  it("every assurance read is under the deadline", () => {
    const paths = getRoutes(app, "/api/assurance");
    expect(paths.length).toBeGreaterThan(40);
    expect(paths.filter((path) => !bounded(app, "GET", path))).toEqual([]);
  });

  it("every assurance read whose body the backend stalls is answered 504 at the deadline, and its backend read cancelled", async () => {
    // Every assurance read but the status check, which reads only the answer's
    // status line and never its body (so a stalled body cannot hold it).
    const paths = getRoutes(app, "/api/assurance").filter((path) => path !== "/api/assurance/status");
    expect(paths.length).toBeGreaterThan(40);
    // All at once, through a browser-like pool on a listening server.
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
    const cookie = (login.headers["set-cookie"] as unknown as string[]).map((one) => one.split(";")[0]).join("; ");
    const server = http.createServer(app);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const port = (server.address() as AddressInfo).port;
    const pool = new http.Agent({ keepAlive: true, maxSockets: 64 });
    try {
      const read = (path: string) => new Promise<{ path: string; status: number | null; body: string }>((done) => {
        const req = http.request({ host: "127.0.0.1", port, path, agent: pool, headers: { Cookie: cookie } }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => { text += chunk; });
          res.on("end", () => done({ path, status: res.statusCode ?? null, body: text }));
        });
        req.on("error", (cause) => done({ path, status: null, body: cause.message }));
        req.end();
      });
      const answers = await Promise.all(paths.map(read));
      const expected = JSON.stringify({ error: "Athena-Backend did not answer this assurance read in time", code: "backend_timeout" });
      const wrong = answers.filter(({ status, body }) => status !== 504 || body !== expected).map(({ path, status, body }) => `${path}: ${status} ${body.slice(0, 160)}`);
      expect(wrong).toEqual([]);
      // Each reached the backend, which held it mid-answer; each held answer was then abandoned.
      expect(backend.reads().length).toBeGreaterThanOrEqual(paths.length);
      await backend.closedAtLeast(backend.reads().length);
      expect(backend.open()).toBe(0);
    } finally {
      pool.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it("the engine's display reads, and the assistant's status read, are under the same deadline", async () => {
    for (const path of [...ENGINE_RELAY_READS, ...ASSISTANT_RELAY_READS]) {
      expect(bounded(app, "GET", path.replace(/:[A-Za-z]+/g, "x1")), path).toBe(true);
    }
    // The engine, stalling its health answer mid-body: the browser is answered at the deadline.
    const engine = await stallingBackend();
    process.env.ATHENA_ENGINE_URL = engine.url;
    process.env.ATHENA_ENGINE_KEY = "ce_op_test";
    try {
      const res = await admin.get("/api/engine/status");
      expect(res.status).toBe(504);
      expect(res.body).toEqual({ error: "the engine did not answer this engine read in time", code: "backend_timeout" });
    } finally {
      await engine.close();
    }
  });

  it("no stop is under it: no write, and no failsafe read, passes a read deadline", () => {
    for (const path of ["/api/failsafe/state", "/api/failsafe/commands", `/api/failsafe/commands/${UUID}`, "/api/failsafe/audit", "/api/failsafe/status", "/api/ai-control"]) {
      expect(bounded(app, "GET", path), path).toBe(false);
    }
    for (const [method, path] of [
      ["POST", `/api/assurance/deployments/${UUID}/recompute`],
      ["POST", `/api/assurance/claims/${UUID}/transition`],
      ["POST", "/api/failsafe/commands"],
      ["POST", `/api/failsafe/commands/${UUID}/signatures`],
      ["POST", `/api/scans/${UUID}/abort`],
      ["POST", `/api/retests/${UUID}/abort`],
      ["PATCH", "/api/ai-control"],
    ] as const) {
      expect(bounded(app, method, path), `${method} ${path}`).toBe(false);
    }
  });
});

describe("a read the browser leaves is cancelled at the backend too", () => {
  it("closing the browser's connection mid-read abandons the backend's answer, before any deadline", async () => {
    _setReadDeadlineForTests(null);
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
    const cookie = (login.headers["set-cookie"] as unknown as string[]).map((one) => one.split(";")[0]).join("; ");
    const server = http.createServer(app);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const port = (server.address() as AddressInfo).port;
    try {
      const req = http.request({ host: "127.0.0.1", port, path: `/api/assurance/deployments/${UUID}/posture`, headers: { Cookie: cookie } });
      req.on("error", () => undefined);
      req.end();
      await backend.readsAtLeast(1);
      req.destroy();
      await backend.closedAtLeast(1);
      expect(backend.open()).toBe(0);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
