import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import { makeApp, signInToBackendWithCookie } from "./helpers";
import { TEST_ADMIN_PASSWORD } from "./test-admin";
import { economicsStandIn, type EconomicsStandIn } from "./helpers/economics-stand-in";
import { MASTER, exchange, fixture, idsOf, served } from "./helpers/economics-fixtures";
import { _setEconomicsDeadlineForTests, ECONOMICS_DEADLINE_MS, ECONOMICS_ROUTES } from "../server/economics";

/**
 * SAFETY (review round 1, MEDIUM-3; the lead's decision): a stalled economics read
 * never holds a browser connection a stop needs. A browser keeps few connections
 * to one origin (Chromium, so Electron: six over HTTP/1.1), and every request past
 * them waits for one to free -- a pause or a kill switch included. So each
 * economics read has ONE total deadline, headers and body (ECONOMICS_DEADLINE_MS,
 * shortened here): past it the browser's connection is answered or cut, and the
 * backend read cancelled.
 *
 * The browser's pool is stood in for by an http.Agent of six sockets, kept alive,
 * as Chromium's per-origin limit: six economics reads stalled by the backend
 * mid-body fill it, and a pause sent through it is answered. Without the deadline
 * the pause waits for a socket that never frees.
 *
 * The deployment's two reads (Athena-Backend #163) are under the same deadline:
 * the scenario list, streamed like a document, and a receipt's signed bytes,
 * which are held until both digests are checked -- so a receipt stalled anywhere
 * is answered 504 with none of its bytes, and its backend read is cancelled.
 *
 * No clock is read: the reads are cut because the deadline fires, and the test
 * waits on the answers themselves.
 */

const graded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
const list = fixture(MASTER, "scenario-list");
const { deployment, scenario } = idsOf(graded);
const reportPath = exchange(graded, "report").path;
const reportUrl = `/api/economics/report?deployment=${deployment}&scenario=${scenario}`;
const receiptPath = exchange(graded, "receipt").path;
const receiptId = /receipts\/([0-9a-f-]{36})\//.exec(receiptPath)![1];
const receiptUrl = `/api/economics/receipt?deployment=${deployment}&receipt=${receiptId}&digest=${(served(graded, "report") as Record<string, any>).receipt.document_digest}`;
const listPath = exchange(list, "list-default").path;
const listDeployment = /deployments\/([0-9a-f-]{36})\//.exec(listPath)![1];
const listUrl = `/api/economics/scenarios?deployment=${listDeployment}`;

let app: Express;
let server: http.Server;
let port: number;
let cookie: string;
let backend: EconomicsStandIn;
const saved = { url: process.env.ATHENA_FAILSAFE_URL, user: process.env.ATHENA_FAILSAFE_USER, password: process.env.ATHENA_FAILSAFE_PASSWORD };

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
  backend = await economicsStandIn([...graded.exchanges!, ...list.exchanges!]);
  process.env.ATHENA_FAILSAFE_URL = backend.url;
  process.env.ATHENA_FAILSAFE_USER = "svc-dashboard";
  process.env.ATHENA_FAILSAFE_PASSWORD = "stand-in-only"; // pragma: allowlist secret
  (await import("../server/control-plane"))._resetForTests();
  // T6: the person reads the backend as themselves; signed in to this one.
  await signInToBackendWithCookie(app, cookie);
  _setEconomicsDeadlineForTests(300);
});

afterEach(async () => {
  _setEconomicsDeadlineForTests(null);
  await backend.close();
  for (const [key, value] of [["ATHENA_FAILSAFE_URL", saved.url], ["ATHENA_FAILSAFE_USER", saved.user], ["ATHENA_FAILSAFE_PASSWORD", saved.password]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Outcome {
  status: number | null;
  /** Whether the whole answer arrived. */
  complete: boolean;
  body: string;
  error: string | null;
}

/** One request through `agent`, settled however it ends: answered, cut, or failed. */
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
        res.on("end", () => settle({ status: res.statusCode ?? null, complete: res.complete, body: text, error: null }));
        res.on("error", (cause) => settle({ status: res.statusCode ?? null, complete: false, body: text, error: cause.message }));
        res.on("aborted", () => settle({ status: res.statusCode ?? null, complete: false, body: text, error: "aborted" }));
      },
    );
    req.on("error", (cause) => settle({ status: null, complete: false, body: "", error: cause.message }));
    if (body) req.write(body);
    req.end();
  });
}

describe("a stalled economics read is cut at its deadline", () => {
  it("the default deadline bounds headers and body together, at 20 s", () => {
    expect(ECONOMICS_DEADLINE_MS).toBe(20_000);
  });

  it("a body the backend stalls mid-way: the browser's connection is cut and the backend read cancelled", async () => {
    backend.hold(reportPath);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const outcome = await send(agent, "GET", reportUrl);
    expect(outcome.status).toBe(200);
    expect(outcome.complete).toBe(false);
    expect(outcome.body.length).toBeLessThan(exchange(graded, "report").body.length);
    // The backend's half-sent answer was abandoned too: its connection closed.
    await backend.heldClosedAtLeast(1);
    expect(backend.holdingOpen()).toBe(false);
    agent.destroy();
  });

  it("headers the backend never sends: the browser is answered 504, with a fixed sentence", async () => {
    backend.holdHeaders(reportPath);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const outcome = await send(agent, "GET", reportUrl);
    expect(outcome.status).toBe(504);
    expect(outcome.complete).toBe(true);
    expect(JSON.parse(outcome.body)).toEqual({ error: "Athena-Backend did not answer the report of a stored result in time", code: "backend_timeout" });
    agent.destroy();
  });
});

describe("the deployment's reads are cut at the same deadline", () => {
  it("every economics route is mounted behind the read deadline", () => {
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { name: string } }> } };
    const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
    for (const path of ECONOMICS_ROUTES) {
      const layer = stack.find((one) => one.route?.path === path);
      expect(layer?.route?.methods.get, path).toBe(true);
      expect(layer!.route!.stack.map((one) => one.handle.name)[0], path).toBe("boundedRelayReadLayer");
    }
  });

  it("a receipt whose headers never come: the browser is answered 504, with a fixed sentence", async () => {
    backend.holdHeaders(receiptPath);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const outcome = await send(agent, "GET", receiptUrl);
    expect(outcome.status).toBe(504);
    expect(JSON.parse(outcome.body)).toEqual({ error: "Athena-Backend did not answer a Financial Exposure Receipt's signed bytes in time", code: "backend_timeout" });
    // The backend read was abandoned too: the held answer's connection closed.
    await backend.heldClosedAtLeast(1);
    agent.destroy();
  });

  it("a receipt stalled mid-body: answered 504 with none of its bytes, and the backend read cancelled", async () => {
    backend.hold(receiptPath);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const outcome = await send(agent, "GET", receiptUrl);
    expect(outcome.status).toBe(504);
    expect(outcome.complete).toBe(true);
    expect(JSON.parse(outcome.body).code).toBe("backend_timeout");
    expect(outcome.body).not.toContain(JSON.parse(exchange(graded, "receipt").body).payload.slice(0, 32));
    await backend.heldClosedAtLeast(1);
    expect(backend.holdingOpen()).toBe(false);
    agent.destroy();
  });

  it("a scenario list stalled mid-body: the browser's connection is cut and the backend read cancelled", async () => {
    backend.hold(listPath);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const outcome = await send(agent, "GET", listUrl);
    expect(outcome.status).toBe(200);
    expect(outcome.complete).toBe(false);
    await backend.heldClosedAtLeast(1);
    expect(backend.holdingOpen()).toBe(false);
    agent.destroy();
  });

  it("a scenario list whose headers never come: answered 504", async () => {
    backend.holdHeaders(listPath);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const outcome = await send(agent, "GET", listUrl);
    expect(outcome.status).toBe(504);
    expect(JSON.parse(outcome.body)).toEqual({ error: "Athena-Backend did not answer the deployment's scenario versions in time", code: "backend_timeout" });
    agent.destroy();
  });

  it("with the browser's six connections held by stalled receipts and lists, a pause sent after them is answered", async () => {
    backend.hold(receiptPath);
    backend.holdHeaders(listPath);
    const pool = new http.Agent({ keepAlive: true, maxSockets: 6 });
    const reads = [
      ...Array.from({ length: 3 }, () => send(pool, "GET", receiptUrl)),
      ...Array.from({ length: 3 }, () => send(pool, "GET", listUrl)),
    ];
    await backend.waitFor(() => backend.seen.filter((seen) => seen.path === receiptPath).length >= 3);
    await backend.waitFor(() => backend.seen.filter((seen) => seen.path === listPath).length >= 3);
    const paused = await send(pool, "POST", `/api/assurance/deployments/${deployment}/recompute`, JSON.stringify({ paused: true }));
    expect(paused.status).toBe(200);
    expect(JSON.parse(paused.body).decision).toBe("paused");
    const outcomes = await Promise.all(reads);
    for (const outcome of outcomes) expect(outcome.status).toBe(504);
    await backend.heldClosedAtLeast(6);
    pool.destroy();
  });
});

describe("six stalled economics reads never hold back a stop", () => {
  it("with the browser's six connections all held by stalled reads, a pause sent after them is answered", async () => {
    backend.hold(reportPath);
    // The browser's pool to this server: six connections, kept alive.
    const pool = new http.Agent({ keepAlive: true, maxSockets: 6 });
    const reads = Array.from({ length: 6 }, () => send(pool, "GET", reportUrl));
    // All six reached the backend, which holds each mid-answer: the pool is full.
    for (let count = 1; count <= 6; count += 1) {
      await backend.waitFor((one) => backend.seen.filter((seen) => seen.path === reportPath).length >= count);
    }
    expect(backend.holdingOpen()).toBe(true);
    // The pause queues behind them in the pool, as a browser's would.
    const pause = send(pool, "POST", `/api/assurance/deployments/${deployment}/recompute`, JSON.stringify({ paused: true }));
    const paused = await pause;
    expect(paused.status).toBe(200);
    expect(JSON.parse(paused.body).decision).toBe("paused");
    expect(backend.seen.some((one) => one.method === "POST" && one.path.endsWith("/recompute/") && one.body === JSON.stringify({ paused: true }))).toBe(true);
    // Each stalled read was cut, none of them completed, and the backend's six answers were abandoned.
    const outcomes = await Promise.all(reads);
    for (const outcome of outcomes) expect(outcome.complete).toBe(false);
    await backend.heldClosedAtLeast(6);
    pool.destroy();
  });
});
