/**
 * A scan the engine started without a run id a stop can name is a breach of
 * the engine's contract (athena-engine #71: a path-safe uuid), and the server
 * says so wherever it answers for that scan.
 *
 * - The 201, every status read and the abort route mark it `stop: "failsafe"`,
 *   so each screen shows what stops it (the Failsafe console) in place of a
 *   Stop that could only answer 409. Nothing else is marked: a scan with a run
 *   id, or one the engine finished inline, keeps its Stop.
 * - A run id no stop can address is no run id: one blank after trimming, "."
 *   and "..", which the URL resolved away (a stop for ".." went to
 *   `POST /api/abort`, one for "." to `POST /api/scans/abort`), and one with a
 *   "/" or a "\", which the engine's router splits or refuses ("a/b" went to
 *   `/api/scans/a%2Fb/abort`, answered 404). No stop URL is ever sent for one;
 *   every other id is sent verbatim, percent-encoded.
 * - Deleting such a scan while it may still be running was answered 200 at
 *   once, with no stop -- none can name it -- and no warning. It is refused
 *   (409) unless forced, and a forced delete says no stop was sent.
 *
 * Nothing here holds back a stop: the delete's refusal is asked only after
 * every stop the delete could send was sent.
 *
 * These run the real routes against a fake engine.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { runIdFrom } from "@shared/engine-record";
import type { IStorage } from "../server/storage";
import { makeApp, signIn } from "./helpers";

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let startBody: Record<string, unknown> = { run_id: "run-1", state: "running" };
let active: unknown[] = [];
const seen: string[] = [];
let engine: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let clientId: string;
const TARGET = "https://nostop.example/";

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    seen.push(`${req.method} ${url}`);
    if (url === "/api/scans/active") return json(res, 200, { active });
    if (url.startsWith("/api/scanners")) return json(res, 200, { scanners: [] });
    if (req.method === "POST" && url === "/api/scan") return json(res, 200, startBody);
    if (req.method === "POST" && url.endsWith("/abort")) return json(res, 200, { state: "aborting" });
    if (req.method === "GET" && url.startsWith("/api/scans/")) return json(res, 200, { state: "running" });
    return json(res, 404, { detail: "not here" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  agent = await signIn(await makeApp());
  storage = (await import("../server/storage-unified")).storage;
  clientId = (await agent.post("/api/clients").send({ name: "No stop", company: "No stop", email: "n@n.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://nostop.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});
afterEach(async () => {
  startBody = { run_id: "run-1", state: "running" };
  active = [];
  seen.length = 0;
  await agent.patch("/api/ai-control").send({ killSwitchEnabled: false });
  for (const test of await storage.getAllTests()) {
    if (!["completed", "aborted", "failed", "refused"].includes(test.status)) await storage.updateTest(test.id, { status: "aborted" });
  }
});

async function start(body: Record<string, unknown>) {
  startBody = body;
  const started = await agent.post("/api/scans").send({ clientId, target: TARGET });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return started.body as { test: { id: string }; runId: string | null; stop?: string };
}

describe("a run id no stop can address", () => {
  it("is no run id: blank after trimming, '.', '..', or with a '/' or a '\\'; every other id is kept verbatim", () => {
    for (const none of ["", " ", "\t", " \n ", ".", "..", "a/b", "/", "../x", "a\\b", "\\"]) {
      expect(runIdFrom(none), JSON.stringify(none)).toBeNull();
    }
    for (const kept of [" 42 ", "-5", "0", "...", ".a", "a.b", "run 7", "a%2Fb", "8f14e45f-ceea-467a-9575-0a5bd4b1e2c3"]) {
      expect(runIdFrom(kept), JSON.stringify(kept)).toBe(kept);
    }
  });

  for (const runId of [" ", ".", "..", "a/b", "a\\b"]) {
    it(`${JSON.stringify(runId)} from a start is recorded as none, marked failsafe, and no stop URL is ever sent for it`, async () => {
      const { test, runId: recorded, stop } = await start({ run_id: runId, state: "running" });
      expect(recorded).toBeNull();
      expect(stop).toBe("failsafe");
      const stopped = await agent.post(`/api/scans/${test.id}/abort`);
      expect(stopped.status).toBe(409);
      expect(stopped.body.stop).toBe("failsafe");
      active = [{ run_id: runId, target: TARGET, state: "running" }];
      const engaged = await agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
      expect(engaged.status, JSON.stringify(engaged.body)).toBe(200);
      expect(engaged.body.engineRuns).toMatchObject({ listed: true, runs: [], unnamed: 1 });
      expect(seen.filter((one) => one.endsWith("/abort"))).toEqual([]);
    });
  }

  it("the kill switch sends every other id its stop, verbatim and percent-encoded, and none to a route it would miss", async () => {
    active = [" 42 ", "-5", "0", "...", "a.b", "..", ".", "a/b", " ", "a\\b"];
    const engaged = await agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
    expect(engaged.status).toBe(200);
    expect(engaged.body.engineRuns.unnamed).toBe(5);
    expect(seen.filter((one) => one.startsWith("POST") && one.endsWith("/abort")).sort()).toEqual([
      "POST /api/scans/%2042%20/abort", "POST /api/scans/-5/abort", "POST /api/scans/.../abort",
      "POST /api/scans/0/abort", "POST /api/scans/a.b/abort",
    ].sort());
  });
});

describe("the server marks a scan no Stop can reach", () => {
  it("in the 201, in every status read, and in the abort route's answer", async () => {
    const { test, stop } = await start({ state: "running" });
    expect(stop).toBe("failsafe");
    for (let i = 0; i < 2; i += 1) {
      const read = await agent.get(`/api/scans/${test.id}`);
      expect(read.body).toMatchObject({ state: "running", stop: "failsafe" });
    }
    const stopped = await agent.post(`/api/scans/${test.id}/abort`);
    expect(stopped.body).toMatchObject({ stop: "failsafe" });
  });

  it("marks nothing else: a scan with a run id, and one the engine finished inline without one", async () => {
    const named = await start({ run_id: "run-named", state: "running" });
    expect(named.stop).toBeUndefined();
    expect((await agent.get(`/api/scans/${named.test.id}`)).body.stop).toBeUndefined();
    const inline = await start({ state: "completed", result: { results: [] } });
    expect(inline.stop).toBeUndefined();
    expect((await agent.get(`/api/scans/${inline.test.id}`)).body.stop).toBeUndefined();
  });
});

describe("deleting a scan no Stop can reach", () => {
  it("is refused unless forced, and a forced delete says no stop was sent", async () => {
    const { test } = await start({ state: "running" });
    const refused = await agent.delete(`/api/tests/${test.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ reason: "no_stop_possible", noStop: [{ testId: test.id, target: TARGET }] });
    expect(refused.body.message).toBe(
      `Nothing was deleted. A scan (${TARGET}) may still be running, and the engine gave it no run id a stop can ` +
      "name, so no stop can be sent. Stop it from the Failsafe console first (pause, stand down or terminate the " +
      "engine), or delete the test with force: its record goes, and no stop is sent.",
    );
    expect(await storage.getTest(test.id)).toBeDefined();
    const forced = await agent.delete(`/api/tests/${test.id}?force=1`);
    expect(forced.status).toBe(200);
    expect(forced.body.detail).toBe("deleted with force: the engine gave this scan no run id a stop can name, so no stop was sent");
    expect(await storage.getTest(test.id)).toBeUndefined();
    expect(seen.filter((one) => one.endsWith("/abort"))).toEqual([]);
    const logged = await storage.getActivityLogsByEntity("test", test.id);
    expect(logged.map((one) => one.details)).toContainEqual({ deletedWithoutStop: true });
  });

  it("deleting its client is refused unless forced too -- after the client's other runs were sent their stops", async () => {
    const other = (await agent.post("/api/clients").send({ name: "Cascade", company: "Cascade", email: "c@c.test" })).body.id as string;
    await agent.post("/api/sites").send({ clientId: other, name: "Shop", url: "https://cascade.example" });
    startBody = { state: "running" };
    const unnamed = await agent.post("/api/scans").send({ clientId: other, target: "https://cascade.example/" });
    startBody = { run_id: "run-cascade", state: "running" };
    const named = await agent.post("/api/scans").send({ clientId: other, target: "https://cascade.example/" });
    expect([unnamed.status, named.status]).toEqual([201, 201]);
    const refused = await agent.delete(`/api/clients/${other}`);
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBe("no_stop_possible");
    expect(refused.body.message).toMatch(/1 other run was sent a stop, and the engine accepted it\.$/);
    expect(seen).toContain("POST /api/scans/run-cascade/abort");
    const forced = await agent.delete(`/api/clients/${other}?force=true`);
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);
    expect(await storage.getTest(unnamed.body.test.id)).toBeUndefined();
    const logged = await storage.getActivityLogsByEntity("client", other);
    expect(logged.map((one) => (one.details as { deletedWithoutStop?: unknown } | null)?.deletedWithoutStop))
      .toContainEqual([unnamed.body.test.id]);
  });

  it("a finished scan with no run id, and a person's test, delete as before", async () => {
    const inline = await start({ state: "completed", result: { results: [] } });
    expect((await agent.delete(`/api/tests/${inline.test.id}`)).status).toBe(200);
    const person = await agent.post("/api/tests").send({ clientId, testType: "penetration-test", status: "in-progress", summary: "by hand" });
    expect((await agent.delete(`/api/tests/${person.body.id}`)).status).toBe(200);
  });
});
