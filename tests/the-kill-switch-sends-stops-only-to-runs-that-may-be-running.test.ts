import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * The kill switch sends a stop only to runs that may still be running.
 *
 * Its own test pinned only "completed" as finished. The engine refuses to
 * abort a run that has already ended, so a failed or an aborted run sent a
 * stop -- or a row whose findings say runId "" sent POST /api/scans//abort --
 * made the page report "N running scans were sent a stop ... could not be
 * stopped ... may still be running" about scans that ended long ago. The
 * engine's own list of live runs is read too (it lists only live ones), so a
 * run that ended is not sent a stop by that route either.
 *
 * (Pins mutants R01-R03 of the round-5 mutation run, which survived the whole
 * suite.)
 */
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

function stubEngine() {
  const calls: string[] = [];
  const state = new Map<string, string>();
  let next = 0;
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    calls.push(`${req.method} ${url}`);
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active") {
      const live = Array.from(state).filter(([, one]) => one === "running");
      return json(res, 200, { active: live.map(([run_id]) => ({ run_id, target: "https://k.example/", state: "running" })) });
    }
    const abort = /^\/api\/scans\/([^/]*)\/abort$/.exec(url);
    if (abort) return state.get(abort[1]) === "running" ? json(res, 200, {}) : json(res, 409, { detail: "run has ended" });
    if (req.method === "GET" && url.startsWith("/api/scans/")) {
      const id = url.split("/")[3];
      return json(res, 200, { run_id: id, state: state.get(id) ?? "unknown", result: { results: [] } });
    }
    next += 1;
    state.set(`run-${next}`, "running");
    return json(res, 202, { run_id: `run-${next}`, state: "running" });
  });
  return { server, calls, state };
}

let engine: ReturnType<typeof stubEngine>;
let admin: Awaited<ReturnType<typeof signIn>>;
let clientId = "";

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "k";
  vi.resetModules();
  admin = await signIn(await makeApp());
  clientId = (await admin.post("/api/clients").send({ name: "K", company: "K", email: "k@k.test" })).body.id;
  await admin.post("/api/sites").send({ clientId, name: "K", url: "https://k.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => (engine.server as Server).close(() => r()));
});

async function endedScan(end: "failed" | "aborted") {
  const started = await admin.post("/api/scans").send({ clientId, target: "https://k.example/" });
  engine.state.set(started.body.runId, end);
  const polled = await admin.get(`/api/scans/${started.body.test.id}`); // the status route records the end
  expect(polled.body.test.status).toBe(end);
  return started.body.test.id as string;
}

const KILL = { killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] };
// What the AI Control page's "Reactivate All Systems" sends.
const REACTIVATE = { killSwitchEnabled: false, systemStatus: "active", activeSystems: ["penetration-testing", "vulnerability-scanner"] };

describe("the kill switch sends a stop only to runs that may still be running", () => {
  for (const end of ["failed", "aborted"] as const) {
    it(`a scan the engine recorded as ${end} is not sent a stop`, async () => {
      const testId = await endedScan(end);
      engine.calls.length = 0;
      const kill = await admin.patch("/api/ai-control").send(KILL);
      expect(kill.status).toBe(200);
      expect((kill.body.stops.scans as Array<{ testId: string }>).map((one) => one.testId)).not.toContain(testId);
      expect(engine.calls.filter((one) => one.endsWith("/abort"))).toEqual([]);
      expect(kill.body.engineRuns).toEqual({ listed: true, runs: [] });
      await admin.patch("/api/ai-control").send(REACTIVATE);
    });
  }

  it('a row whose findings name runId "" has no engine run, and is not sent a stop', async () => {
    const { storage } = await import("../server/storage-unified");
    const blank = await storage.createTest({
      clientId, siteId: null, testType: "vulnerability-scan", status: "running", findings: { runId: "" },
    } as never);
    engine.calls.length = 0;
    const kill = await admin.patch("/api/ai-control").send(KILL);
    expect((kill.body.stops.scans as Array<{ testId: string }>).map((one) => one.testId)).not.toContain(blank.id);
    expect(engine.calls.filter((one) => one.endsWith("/abort"))).toEqual([]);
    await admin.patch("/api/ai-control").send(REACTIVATE);
  });
});
