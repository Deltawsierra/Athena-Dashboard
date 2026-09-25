import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * R5-B. Same class as R4-3 (an edit that dropped the run id took a running
 * scan's Stop away), by another route: DELETE /api/tests/:id -- and DELETE
 * /api/clients/:id, which cascades to its tests -- removed the row of an
 * engine scan that was still RUNNING and told the engine nothing. The run
 * went on against the customer's system, its Stop answered 404 (the row was
 * gone), and the kill switch, which listed running scans from rows only, sent
 * it no stop and said "No engine scan was recorded as running".
 *
 * (The adversary's reproducer pinned that as observed behaviour: 200, the
 * Stop 404, the kill switch reporting nothing, the run still running. Its
 * assertions are inverted here.)
 *
 * Now:
 *   - a delete sends each unfinished engine run it would remove a stop first,
 *     and deletes only once the engine accepted it (and says so);
 *   - when a stop is not accepted -- refused, or the engine unreachable --
 *     the delete is refused (409) naming the run, nothing is deleted, and the
 *     scan's Stop is still there;
 *   - the kill switch also stops every run the ENGINE lists as live that no
 *     running row covers, and reports each (with no test when no row records
 *     it), or says the engine's list could not be read.
 */

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** An engine whose runs stay running until stopped; `refuse`/`drop` decide how an abort goes. */
function stubEngine() {
  const calls: string[] = [];
  const running = new Map<string, string>(); // run id -> target
  const refuse = new Set<string>();
  const drop = new Set<string>();
  const state = { listFails: false };
  let next = 0;
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url = req.url ?? "";
      calls.push(`${req.method} ${url}`);
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") {
        if (state.listFails) return json(res, 500, { detail: "database is locked" });
        return json(res, 200, { active: Array.from(running, ([run_id, target]) => ({ run_id, target, kind: "scan", state: "running" })) });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        if (drop.has(abort[1])) return void req.socket.destroy();
        if (refuse.has(abort[1])) return json(res, 500, { detail: "no" });
        running.delete(abort[1]);
        return json(res, 200, { run_id: abort[1], state: "aborting" });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = url.split("/")[3];
        return json(res, 200, { run_id: id, state: running.has(id) ? "running" : "aborted", result: { results: [] } });
      }
      next += 1;
      running.set(`run-${next}`, JSON.parse(raw || "{}").target ?? null);
      return json(res, 202, { run_id: `run-${next}`, state: "running" });
    });
  });
  return { server, calls, running, refuse, drop, state };
}

let engine: ReturnType<typeof stubEngine>;
let admin: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "k";
  vi.resetModules();
  admin = await signIn(await makeApp());
});

afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => (engine.server as Server).close(() => r()));
});

async function engagement(name: string): Promise<string> {
  const clientId = (await admin.post("/api/clients").send({ name, company: name, email: `${name}@x.test` })).body.id;
  await admin.post("/api/sites").send({ clientId, name, url: "https://acme.example" });
  return clientId;
}

async function runningScan(clientId: string) {
  const started = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/" });
  expect(started.status).toBe(201);
  return { testId: started.body.test.id as string, runId: started.body.runId as string };
}

/** Let the status route record what the engine says of each run now (aborted, once stopped). */
async function recordState(...testIds: string[]) {
  for (const id of testIds) await admin.get(`/api/scans/${id}`);
}

const aborts = () => engine.calls.filter((one) => one.endsWith("/abort"));
const KILL = { killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] };
// What the AI Control page's "Reactivate All Systems" sends.
const REACTIVATE = { killSwitchEnabled: false, systemStatus: "active", activeSystems: ["penetration-testing", "vulnerability-scanner"] };

describe("deleting a test whose engine run is running", () => {
  it("stops the run first, deletes once the engine accepted, and says so", async () => {
    const scan = await runningScan(await engagement("Del"));
    engine.calls.length = 0;
    const del = await admin.delete(`/api/tests/${scan.testId}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ success: true, stops: [{ testId: scan.testId, runId: scan.runId, stopped: true, detail: "" }] });
    expect(aborts()).toEqual([`POST /api/scans/${scan.runId}/abort`]);
    expect(engine.running.has(scan.runId)).toBe(false);
    expect((await admin.get(`/api/tests/${scan.testId}`)).status).toBe(404);
  });

  for (const [how, arrange, said] of [
    ["refuses the stop", (runId: string) => engine.refuse.add(runId), /did not accept the stop/],
    ["cannot be reached", (runId: string) => engine.drop.add(runId), /could not reach the engine/],
  ] as const) {
    it(`is refused, naming the run, when the engine ${how} -- and the scan keeps its Stop`, async () => {
      const scan = await runningScan(await engagement(`Kept-${how.split(" ")[0]}`));
      arrange(scan.runId);
      const del = await admin.delete(`/api/tests/${scan.testId}`);
      expect(del.status).toBe(409);
      expect(del.body.message).toMatch(/^Nothing was deleted\./);
      expect(del.body.message).toContain(`Engine run ${scan.runId} (https://acme.example/) may still be running`);
      expect(del.body.message).toMatch(said);
      expect(del.body.message).toMatch(/Stop it first/);
      expect(del.body.stops).toMatchObject([{ runId: scan.runId, stopped: false }]);
      expect((await admin.get(`/api/tests/${scan.testId}`)).status).toBe(200);
      engine.refuse.clear();
      engine.drop.clear();
      expect((await admin.post(`/api/scans/${scan.testId}/abort`)).status).toBe(200);
      // Once stopped, it can be deleted, and no second stop is sent.
      await recordState(scan.testId);
      engine.calls.length = 0;
      expect(await admin.delete(`/api/tests/${scan.testId}`).then((r) => r.body)).toEqual({ success: true });
      expect(aborts()).toEqual([]);
    });
  }

  it("a finished scan, or a person's test, is deleted with no stop sent", async () => {
    const clientId = await engagement("Done");
    const scan = await runningScan(clientId);
    await admin.post(`/api/scans/${scan.testId}/abort`);
    await recordState(scan.testId);
    const manual = (await admin.post("/api/tests").send({ clientId, testType: "manual", status: "running" })).body.id;
    engine.calls.length = 0;
    expect((await admin.delete(`/api/tests/${scan.testId}`)).body).toEqual({ success: true });
    expect((await admin.delete(`/api/tests/${manual}`)).body).toEqual({ success: true });
    expect(aborts()).toEqual([]);
  });
});

describe("deleting a client cascades to its running scans the same way", () => {
  it("stops each, then deletes", async () => {
    const clientId = await engagement("Cascade");
    const one = await runningScan(clientId);
    const two = await runningScan(clientId);
    engine.calls.length = 0;
    const del = await admin.delete(`/api/clients/${clientId}`);
    expect(del.status).toBe(200);
    expect(aborts().sort()).toEqual([`POST /api/scans/${one.runId}/abort`, `POST /api/scans/${two.runId}/abort`].sort());
    expect((del.body.stops as Array<{ testId: string; stopped: boolean }>).map((s) => [s.testId, s.stopped]).sort())
      .toEqual([[one.testId, true], [two.testId, true]].sort());
    expect((await admin.get(`/api/clients/${clientId}`)).status).toBe(404);
  });

  it("deletes nothing while one of them could not be stopped", async () => {
    const clientId = await engagement("Held");
    const stops = await runningScan(clientId);
    const holds = await runningScan(clientId);
    engine.refuse.add(holds.runId);
    const del = await admin.delete(`/api/clients/${clientId}`);
    engine.refuse.clear();
    expect(del.status).toBe(409);
    expect(del.body.message).toContain(`Engine run ${holds.runId}`);
    expect(del.body.message).toMatch(/then delete the client\. 1 other run was stopped: the engine accepted the stop\.$/);
    expect((await admin.get(`/api/clients/${clientId}`)).status).toBe(200);
    const kept = (await admin.get(`/api/tests?clientId=${clientId}`)).body.map((t: { id: string }) => t.id).sort();
    expect(kept).toEqual([stops.testId, holds.testId].sort());
    // The run that could not be stopped still has its Stop.
    expect((await admin.post(`/api/scans/${holds.testId}/abort`)).status).toBe(200);
    await recordState(stops.testId, holds.testId);
  });
});

describe("the kill switch stops every run the engine lists as live, not only the rows it has", () => {
  it("a run with no row, or whose row reads as finished, is sent a stop and reported", async () => {
    const clientId = await engagement("Sweep");
    const recorded = await runningScan(clientId);
    // A run whose row went some other way (a delete from before this fix), and
    // one started by something other than this app.
    const orphan = await runningScan(clientId);
    const { storage } = await import("../server/storage-unified");
    await storage.deleteTest(orphan.testId);
    engine.running.set("run-elsewhere", "https://elsewhere.example/");
    // A row that reads as finished although the engine still lists its run.
    const stale = await runningScan(clientId);
    await storage.updateTest(stale.testId, { status: "completed" });

    engine.calls.length = 0;
    const kill = await admin.patch("/api/ai-control").send(KILL);
    expect(kill.status).toBe(200);
    expect(aborts().sort()).toEqual(
      [recorded.runId, orphan.runId, "run-elsewhere", stale.runId].map((id) => `POST /api/scans/${id}/abort`).sort(),
    );
    expect(kill.body.stops).toEqual({
      listed: true,
      scans: [{ testId: recorded.testId, runId: recorded.runId, target: "https://acme.example/", stopped: true, detail: "" }],
    });
    expect(kill.body.engineRuns.listed).toBe(true);
    const runs = new Map((kill.body.engineRuns.runs as Array<{ runId: string }>).map((one) => [one.runId, one]));
    expect(runs.size).toBe(3);
    expect(runs.get(orphan.runId)).toEqual({ runId: orphan.runId, target: "https://acme.example/", testId: null, stopped: true, detail: "" });
    expect(runs.get("run-elsewhere")).toEqual({ runId: "run-elsewhere", target: "https://elsewhere.example/", testId: null, stopped: true, detail: "" });
    expect(runs.get(stale.runId)).toMatchObject({ testId: stale.testId, stopped: true });
    expect(engine.running.size).toBe(0);

    const logs = (await admin.get("/api/logs")).body as Array<{ action: string; entityType: string; entityId: string; details: any }>;
    expect(logs.some((l) => l.action === "aborted" && l.entityType === "engine_run" && l.entityId === "run-elsewhere"
      && l.details?.via === "kill_switch")).toBe(true);
    expect(logs.find((l) => l.entityType === "ai_control")?.details?.engineRuns).toEqual({ sent: 3, accepted: 3 });
    await recordState(recorded.testId);
    expect((await admin.patch("/api/ai-control").send(REACTIVATE)).status).toBe(200);
  });

  it("a run the engine lists that would not stop is reported as not stopped", async () => {
    engine.running.set("run-stuck", null as unknown as string);
    engine.refuse.add("run-stuck");
    const kill = await admin.patch("/api/ai-control").send(KILL);
    engine.refuse.clear();
    engine.running.delete("run-stuck");
    expect(kill.body.engineRuns).toEqual({
      listed: true,
      runs: [{ runId: "run-stuck", target: null, testId: null, stopped: false, detail: "the engine did not accept the stop; the scan may still be running" }],
    });
    await admin.patch("/api/ai-control").send(REACTIVATE);
  });

  it("an engine list that cannot be read is said to be that, and holds back no recorded scan's stop", async () => {
    const scan = await runningScan(await engagement("Unlisted"));
    engine.state.listFails = true;
    engine.calls.length = 0;
    const kill = await admin.patch("/api/ai-control").send(KILL);
    engine.state.listFails = false;
    expect(kill.status).toBe(200);
    expect(aborts()).toEqual([`POST /api/scans/${scan.runId}/abort`]);
    expect(kill.body.stops).toMatchObject({ listed: true, scans: [{ testId: scan.testId, stopped: true }] });
    expect(kill.body.engineRuns.listed).toBe(false);
    expect(kill.body.engineRuns.detail).toMatch(/answered 500 when asked for its active runs/);
    await recordState(scan.testId);
    await admin.patch("/api/ai-control").send(REACTIVATE);
  });

  it("rows that cannot be read hold back no stop to a run the engine lists", async () => {
    const scan = await runningScan(await engagement("RowsFail"));
    const { storage } = await import("../server/storage-unified");
    const spy = vi.spyOn(storage, "getAllTests").mockRejectedValueOnce(new Error("database is locked"));
    engine.calls.length = 0;
    const kill = await admin.patch("/api/ai-control").send(KILL);
    spy.mockRestore();
    expect(kill.status).toBe(200);
    expect(kill.body.stops).toEqual({ listed: false, detail: "database is locked" });
    expect(kill.body.engineRuns).toMatchObject({ listed: true, runs: [{ runId: scan.runId, testId: null, stopped: true }] });
    expect(aborts()).toEqual([`POST /api/scans/${scan.runId}/abort`]);
    await admin.patch("/api/ai-control").send(REACTIVATE);
  });
});
