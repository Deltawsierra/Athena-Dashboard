/**
 * Max Concurrent Tests counts a live run with no run id whichever list it is
 * counted from, and its refusal says what can stop each run it counted.
 *
 * A scan the engine accepted without a run id counted toward the limit only
 * while the engine's list of live runs could be read. When it could not, the
 * rows recorded as running were counted by run id alone, so the same running
 * scan was not counted, and the start went ahead: 409 one moment, 201 the next.
 * Now the rows are counted as the engine scans they are (shared/engine-record.ts
 * isEngineRecord), run id or not.
 *
 * And the refusal said "Stop one, or raise the limit" when every run it counted
 * had no run id, which no Stop and no kill switch can name. It now says which
 * counted runs a Stop or the kill switch can reach, and that the rest are
 * stopped only by a failsafe: pause, stand down or terminate.
 *
 * Only a start is refused here. Nothing counted here holds back a stop.
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
let listReadable = true;
let runs = 0;
let engine: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let clientId: string;

const FAILSAFE = "pause, stand down or terminate the engine from the Failsafe console";
const BY_STOP = "with its Stop where this app recorded it, or with the kill switch on the AI Control page";

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active") return listReadable ? json(res, 200, { active }) : json(res, 503, { detail: "list down" });
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
  clientId = (await agent.post("/api/clients").send({ name: "Limit", company: "Limit", email: "l@l.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://limit.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});
afterEach(async () => {
  // Each test starts with no scan recorded as running and the default limit.
  startBody = (n) => ({ run_id: `run-${n}`, state: "running" });
  active = [];
  listReadable = true;
  for (const test of await storage.getAllTests()) {
    if (test.status === "running" || test.status === "in-progress") await storage.updateTest(test.id, { status: "aborted" });
  }
  await agent.patch("/api/ai-control").send({ maxConcurrentTests: 5 });
});

const start = () => agent.post("/api/scans").send({ clientId, target: "https://limit.example/" });
const limitTo = async (n: number) => expect((await agent.patch("/api/ai-control").send({ maxConcurrentTests: n })).status).toBe(200);

describe("a running scan the engine accepted without a run id", () => {
  it("counts toward the limit when the engine's list cannot be read, as it does when the list is read", async () => {
    startBody = () => ({ state: "running" });
    const first = await start();
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.runId).toBeNull();
    expect((await storage.getTest(first.body.test.id))!.status).toBe("running");
    await limitTo(1);

    // The engine lists it, with no run id.
    active = [{ target: "https://limit.example/", state: "running" }];
    const byEngine = await start();
    expect(byEngine.status).toBe(409);
    expect(byEngine.body).toMatchObject({ reason: "concurrency_limit", running: 1, unnamed: 1, counted: "engine", limit: 1 });

    // The list cannot be read: the same scan, recorded as running, counts all the same.
    listReadable = false;
    const byRows = await start();
    expect(byRows.status, JSON.stringify(byRows.body)).toBe(409);
    expect(byRows.body).toMatchObject({ reason: "concurrency_limit", running: 1, unnamed: 1, counted: "recorded", limit: 1 });
    expect(byRows.body.error).toBe(
      "1 engine scan is recorded as running (the engine's list of live runs could not be read: the engine answered " +
      "503 when asked for its active runs: {\"detail\":\"list down\"}), and Max Concurrent Tests on the AI Control page " +
      `is 1, so this scan was not started. It has no run id, so no Stop and no kill switch can name it: to stop it, ${FAILSAFE}. ` +
      "Or raise the limit, to start another.",
    );
  });

  it("is not counted once it is recorded as finished, and a person's test in progress is never counted", async () => {
    startBody = () => ({ state: "completed", result: { results: [] } });
    expect((await start()).status).toBe(201);
    const person = await agent.post("/api/tests").send({ clientId, testType: "penetration-test", status: "in-progress", summary: "by hand" });
    expect(person.status, JSON.stringify(person.body)).toBe(201);
    await limitTo(1);
    listReadable = false;
    startBody = (n) => ({ run_id: `run-${n}`, state: "running" });
    const next = await start();
    expect(next.status, JSON.stringify(next.body)).toBe(201);
  });

  it("counts beside a recorded scan that has a run id, and each is said by what can stop it", async () => {
    startBody = () => ({ state: "running" });
    expect((await start()).status).toBe(201);
    startBody = (n) => ({ run_id: `run-${n}`, state: "running" });
    expect((await start()).status).toBe(201);
    await limitTo(2);
    listReadable = false;
    const refused = await start();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ running: 2, unnamed: 1, counted: "recorded", limit: 2 });
    expect(refused.body.error).toMatch(
      new RegExp(
        "so this scan was not started\\. 1 of them has a run id: stop it with its Stop where this app recorded it, or " +
        "with the kill switch on the AI Control page\\. 1 has no run id, so no Stop and no kill switch can name it: to " +
        "stop it, pause, stand down or terminate the engine from the Failsafe console\\. Or raise the limit, to start " +
        "another\\.$",
      ),
    );
  });
});

describe("the refusal says what can stop each run it counted", () => {
  it("never says 'Stop one' when no Stop can reach any of them", async () => {
    active = [{ target: "https://limit.example/", state: "running" }, { state: "queued" }];
    await limitTo(2);
    const refused = await start();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ reason: "concurrency_limit", running: 2, unnamed: 2, counted: "engine", limit: 2 });
    expect(refused.body.error).toBe(
      "2 engine scans are running, and Max Concurrent Tests on the AI Control page is 2, so this scan was not " +
      `started. They have no run id, so no Stop and no kill switch can name them: to stop one, ${FAILSAFE}. ` +
      "Or raise the limit, to start another.",
    );
    expect(refused.body.error).not.toMatch(/Stop one/);
  });

  it("names both, when the engine lists runs with a run id and runs with none", async () => {
    active = [{ run_id: "run-a", state: "running" }, { run_id: "run-b", state: "running" }, { state: "aborting" }];
    await limitTo(3);
    const refused = await start();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ running: 3, unnamed: 1, counted: "engine" });
    expect(refused.body.error).toBe(
      "3 engine scans are running, and Max Concurrent Tests on the AI Control page is 3, so this scan was not " +
      `started. 2 of them have a run id: stop one ${BY_STOP}. 1 has no run id, so no Stop and no kill switch can ` +
      `name it: to stop it, ${FAILSAFE}. Or raise the limit, to start another.`,
    );
  });

  it("says Stop one, and how, when every run it counted has a run id", async () => {
    active = [{ run_id: "run-a", state: "running" }];
    await limitTo(1);
    const refused = await start();
    expect(refused.body).toMatchObject({ running: 1, unnamed: 0 });
    expect(refused.body.error).toBe(
      "1 engine scan is running, and Max Concurrent Tests on the AI Control page is 1, so this scan was not " +
      `started. Stop one -- ${BY_STOP} -- or raise the limit, to start another.`,
    );
  });
});
