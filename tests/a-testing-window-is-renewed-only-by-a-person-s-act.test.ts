import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";

/**
 * A client's testing window -- the authorised period its Athena-Backend
 * engagement is created with (owner decision 2) -- is renewed only by a
 * person's act, and never on its own:
 *
 *   - POST /api/clients/:id/testing-window/renew re-dates the client's backend
 *     engagement first, as the person (a PATCH, never a stop), from now for 90
 *     days unless the person says how many, and then records the window here;
 *     a backend that refuses leaves the window as it was;
 *   - a client with no engagement yet records the window here alone (the first
 *     launch creates the engagement with it);
 *   - the backend's own view of the engagement -- its name, status, scope and
 *     window -- is read as the person when asked (GET /api/clients/:id/backend-engagement),
 *     beside what this dashboard recorded.
 */

const TOKEN = "b2".repeat(32);
const DAY = 24 * 60 * 60_000;

function stubEngine() {
  const runs = new Set<string>();
  let next = 0;
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = req.url ?? "";
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") return json(res, 200, { active: Array.from(runs, (run_id) => ({ run_id, target: "", kind: "scan", state: "running" })) });
      if (/^\/api\/scans\/[^/]+\/abort$/.test(url)) {
        runs.delete(url.split("/")[3]);
        return json(res, 200, { run_id: url.split("/")[3], state: "aborting" });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = decodeURIComponent(url.slice("/api/scans/".length));
        return json(res, 200, { run_id: id, state: runs.has(id) ? "running" : "aborted", done: !runs.has(id), result: runs.has(id) ? null : { results: [] } });
      }
      if (req.method === "POST" && url === "/api/scan") {
        next += 1;
        runs.add(`run-${next}`);
        return json(res, 202, { run_id: `run-${next}`, state: "running" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  return { server, runs };
}

let engine: ReturnType<typeof stubEngine>;
let hybrid: HybridBackendStandIn;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let storage: typeof import("../server/storage-unified").storage;
let clientCount = 0;

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  const engineUrl = `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_URL = engineUrl;
  process.env.ATHENA_ENGINE_KEY = "dashboard-key";
  hybrid = await hybridBackendStandIn({ engine: { url: engineUrl, key: "backend-key" }, serviceToken: TOKEN });
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = TOKEN;
  vi.resetModules();
  app = await makeApp();
  admin = await signIn(app);
  await signInToBackend(admin);
  storage = (await import("../server/storage-unified")).storage;
});

afterEach(() => {
  hybrid.seen.length = 0;
  hybrid.setRole("admin", "admin");
});

afterAll(async () => {
  for (const name of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_SERVICE_TOKEN"]) delete process.env[name];
  (app.locals.collectWatcher as { halt(): void }).halt();
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
  await hybrid.close();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
});

async function aClient(host = "acme.example") {
  clientCount += 1;
  const client = await admin.post("/api/clients").send({ name: `Client ${clientCount}`, company: `Company ${clientCount}`, email: `c${clientCount}@x.test` });
  await admin.post("/api/sites").send({ clientId: client.body.id, name: host, url: `https://${host}` });
  return client.body.id as string;
}

/** A client whose engagement exists at the backend: one scan started for it (and stopped). */
async function anEngagedClient() {
  const clientId = await aClient();
  const started = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/", consent: true });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  await admin.post(`/api/scans/${started.body.test.id}/abort`);
  const client = (await admin.get(`/api/clients/${clientId}`)).body;
  expect(client.backendEngagementId).toBe(started.body.backend.engagementId);
  return { clientId, engagementId: client.backendEngagementId as number, client };
}

const patches = () => hybrid.seen.filter((one) => one.method === "PATCH" && one.path.startsWith("/api/pentest/engagements/"));

describe("renewing the testing window", () => {
  it("re-dates the client's backend engagement as the person -- never a stop -- from now for 90 days, then records the window here", async () => {
    const { clientId, engagementId, client } = await anEngagedClient();
    const before = Date.parse(client.testingWindowEnd);
    hybrid.seen.length = 0;
    const pressed = Date.now();
    const renewed = await admin.post(`/api/clients/${clientId}/testing-window/renew`).send({});
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    expect(renewed.body.days).toBe(90);
    const start = Date.parse(renewed.body.client.testingWindowStart);
    const end = Date.parse(renewed.body.client.testingWindowEnd);
    expect(start).toBeGreaterThanOrEqual(pressed - 1000);
    expect(end - start).toBe(90 * DAY);
    expect(end).toBeGreaterThan(before);
    expect(renewed.body.engagement).toMatchObject({ id: engagementId, status: "running" });

    const sent = patches();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ account: "admin", by: "bearer", stop: false, path: `/api/pentest/engagements/${engagementId}/` });
    expect(Object.keys(sent[0].json!).sort()).toEqual(["testing_window_end", "testing_window_start"]);
    expect(Date.parse(sent[0].json!.testing_window_start as string)).toBe(start);
    expect(Date.parse(sent[0].json!.testing_window_end as string)).toBe(end);
    expect(hybrid.engagements.get(engagementId)!.testing_window_end).toBe(renewed.body.client.testingWindowEnd);

    const stored = (await admin.get(`/api/clients/${clientId}`)).body;
    expect(Date.parse(stored.testingWindowEnd)).toBe(end);
    const logs = (await admin.get("/api/logs")).body.filter((one: { action: string; entityId: string }) => one.action === "testing_window_renewed" && one.entityId === clientId);
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toMatchObject({ days: 90, backendEngagementId: engagementId, backendEngagementRedated: true });
  });

  it("takes the number of days the person says, within bounds, and refuses anything else before anything is sent", async () => {
    const { clientId } = await anEngagedClient();
    hybrid.seen.length = 0;
    const thirty = await admin.post(`/api/clients/${clientId}/testing-window/renew`).send({ days: 30 });
    expect(thirty.status).toBe(200);
    expect(Date.parse(thirty.body.client.testingWindowEnd) - Date.parse(thirty.body.client.testingWindowStart)).toBe(30 * DAY);
    expect(patches()).toHaveLength(1);
    hybrid.seen.length = 0;
    for (const body of [{ days: 0 }, { days: 366 }, { days: 1.5 }, { days: "90" }, { from: "now" }]) {
      const refused = await admin.post(`/api/clients/${clientId}/testing-window/renew`).send(body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    expect(hybrid.seen).toEqual([]);
  });

  it("a client with no engagement yet records the window here alone; the first launch creates the engagement with it", async () => {
    const clientId = await aClient();
    hybrid.seen.length = 0;
    const renewed = await admin.post(`/api/clients/${clientId}/testing-window/renew`).send({ days: 45 });
    expect(renewed.status).toBe(200);
    expect(renewed.body.engagement).toBeNull();
    expect(hybrid.seen).toEqual([]);
    const stored = (await admin.get(`/api/clients/${clientId}`)).body;
    expect(Date.parse(stored.testingWindowEnd) - Date.parse(stored.testingWindowStart)).toBe(45 * DAY);
    const started = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/", consent: true });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const made = hybrid.seen.find((one) => one.method === "POST" && one.path === "/api/pentest/engagements/")!;
    expect(Date.parse(made.json!.testing_window_end as string)).toBe(Date.parse(stored.testingWindowEnd));
    await admin.post(`/api/scans/${started.body.test.id}/abort`);
  });

  it("a backend that refuses the person leaves the window as it was, in the backend's words", async () => {
    const { clientId, client } = await anEngagedClient();
    hybrid.setRole("admin", "viewer");
    hybrid.seen.length = 0;
    const refused = await admin.post(`/api/clients/${clientId}/testing-window/renew`).send({});
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ reason: "backend_refused", backendStatus: 403 });
    expect(refused.body.error).not.toContain("Nothing was started");
    const stored = (await admin.get(`/api/clients/${clientId}`)).body;
    expect(stored.testingWindowEnd).toBe(client.testingWindowEnd);
  });

  it("is never done on its own: a start inside the window renews nothing", async () => {
    const { clientId, client } = await anEngagedClient();
    hybrid.seen.length = 0;
    const started = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/", consent: true });
    expect(started.status).toBe(201);
    await admin.post(`/api/scans/${started.body.test.id}/abort`);
    expect(patches()).toEqual([]);
    expect((await admin.get(`/api/clients/${clientId}`)).body.testingWindowEnd).toBe(client.testingWindowEnd);
  });
});

describe("reading the client's backend engagement", () => {
  it("answers what this dashboard recorded beside the backend's own view, read as the person", async () => {
    const { clientId, engagementId, client } = await anEngagedClient();
    hybrid.seen.length = 0;
    const read = await admin.get(`/api/clients/${clientId}/backend-engagement`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      backendEngagementId: engagementId, testingWindowStart: client.testingWindowStart, testingWindowEnd: client.testingWindowEnd,
      hosts: ["acme.example"],
      engagement: { id: engagementId, status: "running", scopeHosts: ["acme.example"], clientName: client.company },
    });
    expect(read.body.engagement.name).toContain(client.name);
    expect(hybrid.seen.map((one) => [one.method, one.account, one.stop])).toEqual([["GET", "admin", false]]);
  });

  it("says a client with no engagement has none, and sends nothing", async () => {
    const clientId = await aClient("plain.example");
    hybrid.seen.length = 0;
    const read = await admin.get(`/api/clients/${clientId}/backend-engagement`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ backendEngagementId: null, engagement: null, hosts: ["plain.example"] });
    expect(hybrid.seen).toEqual([]);
  });
});
