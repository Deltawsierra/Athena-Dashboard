import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import request from "supertest";

import { makeApp, signIn } from "./helpers";

/**
 * A legacy scan (one this dashboard dispatched to the engine itself) whose run
 * the engine does not know is ended only by a PERSON's act:
 * POST /api/scans/:testId/record-not-known. The act
 *
 *   - sends the run its stop FIRST, and writes nothing while the engine holds
 *     its answer;
 *   - records `not_known` only when the engine answered that stop 404 "No such
 *     scan run": who, when, the stop's outcome and the engine's words, logged
 *     after the stop's own line (`abort_run_unknown`, then `recorded_not_known`);
 *   - records nothing when the engine knows the run (it took the stop, or
 *     answered that the run had ended: 409), when it could not be asked (503),
 *     and says the stop's outcome when the write fails (500);
 *   - is an admin's (403, nothing sent), is no stop (refused 503 while the kill
 *     switch is engaged, nothing sent), is held by its scan (a second press
 *     while the first is answered sends nothing, and one after it was recorded
 *     is answered from the record: one stop), reads no Idempotency-Key, and is
 *     refused on a hybrid row (409, nothing sent).
 *
 * And after it: the kill switch still sends the run a stop by its id and says
 * the engine does not know it; a delete sends no stop and succeeds; Max
 * Concurrent Tests' count of recorded runs leaves it out. Nobody else writes
 * the word: a person's test cannot be given it.
 */

type Call = { method: string; url: string; status: number };

/** An engine that knows only the runs the test gives it; its stops' answers can be held, refused, or cut off. */
function stubEngine() {
  const calls: Call[] = [];
  const runs = new Map<string, string>();
  const control = { holdAborts: false, abortStatus: null as number | null, cutAborts: false, activeFails: false };
  const held: Array<() => void> = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      const url = req.url ?? "";
      const call: Call = { method: req.method ?? "GET", url, status: 0 };
      calls.push(call);
      const json = (code: number, body: unknown) => {
        call.status = code;
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url === "/health") return json(200, { status: "ok" });
      if (url === "/api/scans/active") {
        if (control.activeFails) return json(500, { detail: "the registry is rebuilding" });
        return json(200, { active: Array.from(runs).filter(([, state]) => state === "running").map(([run_id]) => ({ run_id, target: "", state: "running" })) });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        if (control.cutAborts) return void req.socket.destroy();
        const answer = () => {
          if (control.abortStatus !== null) return json(control.abortStatus, { detail: "the engine is overloaded" });
          const id = decodeURIComponent(abort[1]);
          const state = runs.get(id);
          if (state === undefined) return json(404, { detail: "No such scan run" });
          if (state !== "running") return json(200, { state, detail: "not running" });
          runs.set(id, "aborted");
          return json(200, { state: "aborting" });
        };
        if (control.holdAborts) return void held.push(answer);
        return answer();
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = decodeURIComponent(url.slice("/api/scans/".length));
        const state = runs.get(id);
        if (state === undefined) return json(404, { detail: "No such scan run" });
        return json(200, { run_id: id, state, done: state !== "running", result: { results: [] } });
      }
      return json(404, { detail: "Not Found" });
    });
  });
  return {
    server, calls, runs, control,
    releaseAborts(): void {
      control.holdAborts = false;
      held.splice(0).forEach((answer) => answer());
    },
    aborts: (runId: string) => calls.filter((one) => one.method === "POST" && one.url === `/api/scans/${runId}/abort`),
  };
}

let engine: ReturnType<typeof stubEngine>;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let storage: typeof import("../server/storage-unified").storage;
let clientId = "";
let rows = 0;

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "dashboard-key";
  vi.resetModules();
  app = await makeApp();
  admin = await signIn(app);
  storage = (await import("../server/storage-unified")).storage;
  clientId = (await admin.post("/api/clients").send({ name: "Gone", company: "Gone", email: "gone@x.test" })).body.id;
  await admin.post("/api/sites").send({ clientId, name: "gone.example", url: "https://gone.example" });
});

afterEach(() => {
  vi.restoreAllMocks();
  engine.releaseAborts();
  Object.assign(engine.control, { abortStatus: null, cutAborts: false, activeFails: false });
});

afterAll(async () => {
  for (const name of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY"]) delete process.env[name];
  (app.locals.collectWatcher as { halt(): void } | undefined)?.halt();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
});

/** A scan this dashboard dispatched itself, recorded running; the engine knows its run only when given `state`. */
async function aLegacyScan(state?: string, extra: Record<string, unknown> = {}) {
  rows += 1;
  const runId = `gone-${rows}`;
  if (state) engine.runs.set(runId, state);
  const test = await storage.createTest({
    clientId, testType: "vulnerability-scan", status: "running",
    findings: { runId, target: "https://gone.example/", results: [], ...extra },
  } as any);
  return { testId: test.id, runId };
}

const record = (testId: string) => admin.post(`/api/scans/${testId}/record-not-known`).send({});
const rowOf = async (testId: string) => (await storage.getTest(testId))!;
const logsOf = async (testId: string) =>
  ((await admin.get(`/api/logs?entityType=test&entityId=${testId}`)).body as Array<{ action: string; details: Record<string, unknown> }>);

describe("the act", () => {
  it("sends the stop first and writes nothing while the engine holds its answer; the engine's 404 records not_known with who, when and the engine's words, logged after the stop's own line; a second press sends no second stop", async () => {
    const { testId, runId } = await aLegacyScan();
    engine.control.holdAborts = true;
    const pressing = record(testId).then((answer) => answer);
    await vi.waitFor(() => expect(engine.aborts(runId)).toHaveLength(1));

    // The stop is out and its answer held: nothing is written.
    const meanwhile = await rowOf(testId);
    expect(meanwhile.status).toBe("running");
    expect(meanwhile.completedAt).toBeNull();
    expect(meanwhile.findings).not.toHaveProperty("notKnown");
    expect((await logsOf(testId)).map((one) => one.action)).toEqual([]);
    // Another press on the scan while the first is answered sends nothing, whatever it carries.
    const again = await record(testId);
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe("idempotency_in_flight");
    const keyed = await admin.post(`/api/scans/${testId}/record-not-known`).set("Idempotency-Key", "another-press").send({});
    expect(keyed.status).toBe(409);
    expect(engine.aborts(runId)).toHaveLength(1);

    engine.releaseAborts();
    const answered = await pressing;
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body).toMatchObject({
      recorded: true, status: "not_known",
      notKnown: { by: "admin", at: expect.any(String), said: "No such scan run", stop: expect.stringContaining("does not know this run") },
      stop: { runId, stopped: false, unknownRun: true },
    });
    const row = await rowOf(testId);
    expect(row.status).toBe("not_known");
    expect(row.completedAt).not.toBeNull();
    expect((row.findings as any).notKnown.recorded).toEqual(answered.body.notKnown);
    expect((row.findings as any).runId, "the run's own keys are kept").toBe(runId);

    // Newest first: the stop's own line, then the act's.
    const logs = await logsOf(testId);
    expect(logs.map((one) => one.action)).toEqual(["recorded_not_known", "abort_run_unknown"]);
    expect(logs[1].details).toMatchObject({ runId, via: "record_not_known" });
    expect(logs[0].details).toMatchObject({ runId, statusBefore: "running", by: "admin", said: "No such scan run" });

    // Sent again after it was recorded: answered from the record, and nothing is sent.
    const after = await record(testId);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ recorded: false, alreadyRecorded: true, status: "not_known", notKnown: answered.body.notKnown });
    expect(engine.aborts(runId)).toHaveLength(1);
  });

  it("records nothing when the engine knows the run: a stop it took, or a run it says has ended, is 409", async () => {
    const live = await aLegacyScan("running");
    const took = await record(live.testId);
    expect(took.status).toBe(409);
    expect(took.body).toMatchObject({ error: "the engine knows this run; its own end will be read", reason: "engine_knows_run", stop: { stopped: true } });
    expect(engine.aborts(live.runId)).toHaveLength(1);
    expect(await rowOf(live.testId)).toMatchObject({ status: "running", completedAt: null });
    expect((await logsOf(live.testId)).map((one) => one.action)).toEqual(["aborted"]);

    const ended = await aLegacyScan("completed");
    const notRunning = await record(ended.testId);
    expect(notRunning.status).toBe(409);
    expect(notRunning.body).toMatchObject({ reason: "engine_knows_run", stop: { stopped: false, alreadyFinished: true } });
    expect((await rowOf(ended.testId)).status).toBe("running");
  });

  it("records nothing when the engine could not be asked: refused, or unreachable, is 503", async () => {
    const { testId, runId } = await aLegacyScan();
    engine.control.abortStatus = 503;
    const refused = await record(testId);
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ reason: "engine_not_asked", stop: { stopped: false } });
    expect(refused.body.stop.unknownRun).toBeUndefined();

    engine.control.abortStatus = null;
    engine.control.cutAborts = true;
    const unreachable = await record(testId);
    expect(unreachable.status).toBe(503);
    expect(unreachable.body.reason).toBe("engine_not_asked");
    expect(engine.aborts(runId).length).toBeGreaterThanOrEqual(2);
    const row = await rowOf(testId);
    expect(row.status).toBe("running");
    expect(row.findings).not.toHaveProperty("notKnown");
  });

  it("says the stop's outcome when the record could not be written (500), and changes nothing", async () => {
    const { testId, runId } = await aLegacyScan();
    const real = storage.updateTest.bind(storage);
    vi.spyOn(storage, "updateTest").mockImplementation(async (id, data) => {
      if (id === testId) throw new Error("SQLITE_FULL: database or disk is full");
      return real(id, data);
    });
    const failed = await record(testId);
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ reason: "not_recorded", stop: { runId, stopped: false, unknownRun: true } });
    expect(failed.body.error).toContain("SQLITE_FULL");
    expect(engine.aborts(runId)).toHaveLength(1);
    expect((await rowOf(testId)).status).toBe("running");
  });

  it("is an admin's act: anyone else is refused 403, and nothing is sent", async () => {
    const { testId, runId } = await aLegacyScan();
    const password = "an-analyst-password-long-enough"; // pragma: allowlist secret
    await storage.createUser({ username: "ana", password, role: "analyst", isActive: true } as any);
    const analyst = request.agent(app);
    expect((await analyst.post("/api/auth/login").send({ username: "ana", password })).status).toBe(200);
    const refused = await analyst.post(`/api/scans/${testId}/record-not-known`).send({});
    expect(refused.status).toBe(403);
    expect(engine.aborts(runId)).toEqual([]);
    expect((await rowOf(testId)).status).toBe("running");
  });

  it("is refused on a hybrid row (its end is its record's), and nothing is sent", async () => {
    const { testId, runId } = await aLegacyScan(undefined, { backendScanId: "a1b2c3d4-0000-4000-8000-0000000000aa" });
    const refused = await record(testId);
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBe("hybrid_row");
    expect(engine.aborts(runId)).toEqual([]);
    expect((await rowOf(testId)).status).toBe("running");
  });

  it("is written by nothing else: a person's test is never given the word", async () => {
    const created = await admin.post("/api/tests").send({ clientId, testType: "penetration_test", status: "not_known" });
    expect(created.status).toBe(400);
    const mine = await admin.post("/api/tests").send({ clientId, testType: "penetration_test", status: "pending" });
    expect(mine.status).toBe(201);
    const edited = await admin.patch(`/api/tests/${mine.body.id}`).send({ status: "not_known" });
    expect(edited.status).toBe(400);
    expect((await rowOf(mine.body.id)).status).toBe("pending");
    // An engine scan's status is the engine's (and the act's): refused as every engine-owned field is.
    const { testId } = await aLegacyScan();
    expect((await admin.patch(`/api/tests/${testId}`).send({ status: "not_known" })).status).toBe(409);
    expect((await rowOf(testId)).status).toBe("running");
  });
});

describe("a run recorded as not known to the engine, after the act", () => {
  it("is still sent the kill switch's stop by its id, which says the engine does not know it; then a delete sends no stop and succeeds", async () => {
    const { testId, runId } = await aLegacyScan();
    expect((await record(testId)).status).toBe(200);
    expect(engine.aborts(runId)).toHaveLength(1);

    try {
      const engaged = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
      expect(engaged.status, JSON.stringify(engaged.body)).toBe(200);
      expect(engine.aborts(runId)).toHaveLength(2);
      const swept = (engaged.body.stops.scans as Array<Record<string, unknown>>).find((one) => one.testId === testId);
      expect(swept).toMatchObject({ runId, stopped: false, unknownRun: true, detail: expect.stringContaining("does not know this run") });
      expect((await rowOf(testId)).status, "the kill switch's 404 changes nothing").toBe("not_known");

      // Not a stop: refused while the switch is engaged, and nothing is sent.
      const other = await aLegacyScan();
      const refused = await record(other.testId);
      expect(refused.status).toBe(503);
      expect(engine.aborts(other.runId)).toEqual([]);
      expect((await rowOf(other.testId)).status).toBe("running");
    } finally {
      expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: false })).status).toBe(200);
    }

    const before = engine.aborts(runId).length;
    const deleted = await admin.delete(`/api/tests/${testId}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body).toMatchObject({ success: true });
    expect(deleted.body.stops).toBeUndefined();
    expect(engine.aborts(runId)).toHaveLength(before);
  });

  it("is left out of Max Concurrent Tests' count of recorded runs", async () => {
    const { testId } = await aLegacyScan();
    expect((await record(testId)).status).toBe(200);
    // The count of recorded runs is read when the engine's own list cannot be.
    const unfinished = ((await admin.get("/api/tests")).body as Array<{ status: string; findings: unknown }>)
      .filter((one) => !["completed", "aborted", "failed", "refused", "not_known"].includes(one.status)
        && one.findings !== null && typeof one.findings === "object" && "runId" in (one.findings as object)).length;
    expect((await admin.patch("/api/ai-control").send({ maxConcurrentTests: unfinished + 1 })).status).toBe(200);
    engine.control.activeFails = true;
    const started = await admin.post("/api/scans").send({ clientId, target: "https://gone.example/", consent: true });
    expect(started.body.reason, JSON.stringify(started.body)).not.toBe("concurrency_limit");
  });
});
