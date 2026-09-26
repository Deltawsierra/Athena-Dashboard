/**
 * The kill switch reads every entry on the engine's list of live runs as a
 * live run: none is dropped, whatever its shape or state.
 *
 * An entry that was not an object was dropped. A list of bare run ids
 * (`["run-bare", 77]`) was sent no stop, counted toward no limit, and answered
 * `{ listed: true, runs: [] }`, which the AI Control page reads as "The engine
 * listed no other live run." Now an entry that is a run id (text, or a whole
 * number) is that run, and is sent a stop; any other entry is a live run no
 * stop can name, and is counted and said as one.
 *
 * And what was never pinned:
 * - a run id that is only space is a run id, as the engine sent it: its own
 *   Stop and the kill switch send it a stop, and it is never "no run id";
 * - a live run with no run id is counted in every live state the engine lists
 *   (queued, running, aborting), not only "running";
 * - the count of those runs is written to the audit log, not only answered;
 * - a scan recorded here as running takes nothing off that count.
 *
 * Fixes may only make stops reach more runs; each of these sends a stop to a
 * run, or says a run was not stopped, that went unstopped or unsaid.
 *
 * These run the real routes against a fake engine.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import type { IStorage } from "../server/storage";
import { makeApp, signIn } from "./helpers";

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let startBody: (n: number) => Record<string, unknown> = (n) => ({ run_id: `run-${n}`, state: "running" });
let active: unknown[] = [];
let runs = 0;
const calls: string[] = [];
let engine: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let clientId: string;

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    calls.push(`${req.method} ${url}`);
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active") return json(res, 200, { active });
    if (url.startsWith("/api/scanners")) return json(res, 200, { scanners: [] });
    if (req.method === "POST" && url === "/api/scan") {
      runs += 1;
      return json(res, 200, startBody(runs));
    }
    if (req.method === "POST" && url.endsWith("/abort")) return json(res, 200, {});
    if (req.method === "GET" && url.startsWith("/api/scans/")) return json(res, 200, { state: "running" });
    return json(res, 404, { detail: "not here" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  agent = await signIn(await makeApp());
  storage = (await import("../server/storage-unified")).storage;
  clientId = (await agent.post("/api/clients").send({ name: "Listed", company: "Listed", email: "k@k.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://listed.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});
afterEach(async () => {
  startBody = (n) => ({ run_id: `run-${n}`, state: "running" });
  active = [];
  await agent.patch("/api/ai-control").send({ killSwitchEnabled: false });
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
  await agent.patch("/api/ai-control").send({ maxConcurrentTests: 5 });
});

async function startScan() {
  const started = await agent.post("/api/scans").send({ clientId, target: "https://listed.example/" });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return started.body as { test: { id: string }; runId: string | null };
}

/** Engage the kill switch; answer with what it said, and the stops it sent. */
async function engage() {
  const before = calls.length;
  const engaged = await agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
  expect(engaged.status, JSON.stringify(engaged.body)).toBe(200);
  return { body: engaged.body, aborts: calls.slice(before).filter((one) => one.endsWith("/abort")) };
}

describe("an entry on the engine's list that is not an object", () => {
  it("is a run when it is a run id, and is sent a stop; any other is counted as a live run no stop can name", async () => {
    active = ["run-bare", 77, null, true, ["run-in-a-list"]];
    const { body, aborts } = await engage();
    expect(body.engineRuns).toEqual({
      listed: true,
      runs: [
        { runId: "run-bare", target: null, testId: null, stopped: true, detail: "" },
        { runId: "77", target: null, testId: null, stopped: true, detail: "" },
      ],
      unnamed: 3,
    });
    expect(aborts).toEqual(expect.arrayContaining(["POST /api/scans/run-bare/abort", "POST /api/scans/77/abort"]));
    expect(aborts).toHaveLength(2);
  });

  it("counts toward Max Concurrent Tests, each of them", async () => {
    active = ["run-bare", 77, null];
    await agent.patch("/api/ai-control").send({ maxConcurrentTests: 3 });
    const refused = await agent.post("/api/scans").send({ clientId, target: "https://listed.example/" });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body).toMatchObject({ reason: "concurrency_limit", running: 3, unnamed: 1, counted: "engine", limit: 3 });
  });
});

describe("a run id that is only space", () => {
  it("is the run the engine named: recorded as sent, and stopped by its own Stop", async () => {
    startBody = () => ({ run_id: " ", state: "running" });
    const { test, runId } = await startScan();
    expect(runId).toBe(" ");
    const before = calls.length;
    const stopped = await agent.post(`/api/scans/${test.id}/abort`);
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(calls.slice(before)).toContain("POST /api/scans/%20/abort");
  });

  it("is sent a stop by the kill switch, recorded here or only listed, and is never counted as a run with no id", async () => {
    startBody = () => ({ run_id: " ", state: "running" });
    const { test } = await startScan();
    active = [{ run_id: " ", state: "running" }, { run_id: "\t", state: "queued" }];
    const { body, aborts } = await engage();
    expect(body.stops.scans).toContainEqual(expect.objectContaining({ testId: test.id, runId: " ", stopped: true }));
    expect(body.engineRuns).toEqual({
      listed: true, runs: [{ runId: "\t", target: null, testId: null, stopped: true, detail: "" }],
    });
    expect(aborts).toEqual(expect.arrayContaining(["POST /api/scans/%20/abort", "POST /api/scans/%09/abort"]));
  });
});

describe("a live run the engine lists with no run id", () => {
  it("is counted in every live state the engine lists -- queued, running and aborting -- and in the audit log", async () => {
    active = [
      { state: "queued", target: "https://listed.example/" },
      { state: "running" },
      { state: "aborting" },
      { target: "https://listed.example/" },
    ];
    const { body, aborts } = await engage();
    expect(body.engineRuns).toEqual({ listed: true, runs: [], unnamed: 4 });
    expect(aborts).toEqual([]);
    // No other engagement in this file lists four runs with no run id, so this entry is this one's.
    const logged = await storage.getActivityLogsByEntity("ai_control", body.id);
    expect(logged.map((one) => (one.details as { engineRuns?: unknown } | null)?.engineRuns))
      .toContainEqual({ sent: 0, accepted: 0, unnamed: 4 });
  });

  it("is counted as itself beside a scan recorded here as running, which takes nothing off the count", async () => {
    const { test, runId } = await startScan();
    active = [{ run_id: runId, state: "running" }, { state: "running" }];
    const { body, aborts } = await engage();
    expect(body.stops.scans).toContainEqual(expect.objectContaining({ testId: test.id, runId, stopped: true }));
    expect(body.engineRuns).toEqual({ listed: true, runs: [], unnamed: 1 });
    expect(aborts).toContain(`POST /api/scans/${runId}/abort`);
  });
});
