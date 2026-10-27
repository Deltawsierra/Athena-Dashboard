import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import { makeApp, signIn } from "./helpers";

/**
 * A scan this dashboard dispatched to the engine itself (a legacy row) whose
 * run the engine no longer knows -- every read answered 404 "No such scan run":
 * the engine restarted and forgot it, or it runs under another id -- read
 * "running" for ever, with nothing on the page but the engine's 404 words and
 * no way to end it.
 *
 * Now, once the 404 STANDS (server/routes.ts notKnown: so many reads in a row,
 * over a floor of time -- one 404 is an engine that restarted, or a registry
 * not yet caught up):
 *   - the answer says so, from memory: `engineKnowsRun: false` and
 *     `notKnown: {since, reads, said}`, the engine's own words verbatim;
 *   - the row carries the reading (`findings.notKnown`), written without being
 *     awaited -- a write that fails still answers from memory, and is tried
 *     again;
 *   - its STATUS IS UNCHANGED: the engine has not said the run ended, and
 *     nothing here invents an end (only a person's act records one);
 *   - its Stop is sent as before;
 *   - any read the engine answers lets the reading go, and the count starts
 *     over;
 *   - a hybrid row is never given the reading: its end is its record's;
 *   - a person cannot supply the reading, and an edit keeps it.
 */

type Call = { method: string; url: string; status: number };

/** An engine that knows only the runs the test gives it: every other read and stop is answered 404 "No such scan run". */
function stubEngine() {
  const calls: Call[] = [];
  const runs = new Map<string, string>();
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
        return json(200, { active: Array.from(runs).filter(([, state]) => state === "running").map(([run_id]) => ({ run_id, target: "", state: "running" })) });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        const state = runs.get(decodeURIComponent(abort[1]));
        if (state === undefined) return json(404, { detail: "No such scan run" });
        if (state !== "running") return json(200, { state, detail: "not running" });
        runs.set(decodeURIComponent(abort[1]), "aborted");
        return json(200, { state: "aborting" });
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
    server, calls, runs,
    reads: (runId: string) => calls.filter((one) => one.method === "GET" && one.url === `/api/scans/${runId}`),
    aborts: (runId: string) => calls.filter((one) => one.method === "POST" && one.url === `/api/scans/${runId}/abort`),
  };
}

let engine: ReturnType<typeof stubEngine>;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let storage: typeof import("../server/storage-unified").storage;
let notKnown: { reads: number; floorMs: number; persistEveryMs: number };
let clientId = "";
let rows = 0;

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "dashboard-key";
  vi.resetModules();
  app = await makeApp();
  const routes = (await import("../server/routes")) as { notKnown?: typeof notKnown };
  // On the base there is no such knob: a stand-in object, so the cases run and fail on what they assert.
  notKnown = routes.notKnown ?? { reads: 5, floorMs: 30_000, persistEveryMs: 60_000 };
  admin = await signIn(app);
  storage = (await import("../server/storage-unified")).storage;
  clientId = (await admin.post("/api/clients").send({ name: "Lost", company: "Lost", email: "lost@x.test" })).body.id;
  await admin.post("/api/sites").send({ clientId, name: "lost.example", url: "https://lost.example" });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(notKnown, { reads: 5, floorMs: 30_000, persistEveryMs: 60_000 });
});

afterAll(async () => {
  for (const name of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY"]) delete process.env[name];
  (app.locals.collectWatcher as { halt(): void } | undefined)?.halt();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
});

/** A scan this dashboard dispatched itself, recorded running, whose run the engine does not know (unless the test gives it one). */
async function aLegacyScan(extra: Record<string, unknown> = {}) {
  rows += 1;
  const runId = `lost-${rows}`;
  const test = await storage.createTest({
    clientId, testType: "vulnerability-scan", status: "running",
    findings: { runId, target: "https://lost.example/", results: [], ...extra },
  } as any);
  return { testId: test.id, runId };
}

const read = async (testId: string) => (await admin.get(`/api/scans/${testId}`)).body;
const rowOf = async (testId: string) => (await storage.getTest(testId))!;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a legacy scan whose run the engine answers 404", () => {
  it("says nothing more than the engine's words on the first reads; once the 404 stands over the floor it is read as not known to the engine -- its status unchanged, its Stop sent as before", async () => {
    Object.assign(notKnown, { reads: 5, floorMs: 150 });
    const { testId, runId } = await aLegacyScan();

    for (let i = 1; i <= 4; i++) {
      const answer = await read(testId);
      expect(answer.state, `read ${i}`).toBe("running");
      expect(answer.engine).toBeNull();
      expect(answer.detail).toContain("No such scan run");
      expect(answer.engineKnowsRun, `read ${i}`).toBeUndefined();
      expect(answer.notKnown, `read ${i}`).toBeUndefined();
    }
    expect((await rowOf(testId)).findings).not.toHaveProperty("notKnown");

    await pause(200);
    const standing = await read(testId);
    expect(standing.engineKnowsRun).toBe(false);
    expect(standing.notKnown).toEqual({ since: expect.any(String), reads: 5, said: standing.detail });
    expect(standing.notKnown.said).toContain("No such scan run");
    expect(Date.parse(standing.notKnown.since)).toBeLessThanOrEqual(Date.now());
    // The status is the row's, unchanged: the engine has not said the run ended.
    expect(standing.state).toBe("running");
    expect(standing.test.status).toBe("running");
    expect(standing.stop).toBeUndefined();

    // The row carries the reading, written after the answer.
    await vi.waitFor(async () => expect((await rowOf(testId)).findings).toHaveProperty("notKnown"));
    const row = await rowOf(testId);
    expect(row.status).toBe("running");
    expect(row.completedAt).toBeNull();
    expect((row.findings as any).notKnown).toEqual({ since: standing.notKnown.since, reads: 5, lastReadAt: expect.any(String), said: standing.notKnown.said });

    // The Stop is sent as before: the reading holds nothing back.
    const before = engine.aborts(runId).length;
    await admin.post(`/api/scans/${testId}/abort`);
    expect(engine.aborts(runId).length).toBe(before + 1);
    expect((await rowOf(testId)).status, "a stop's 404 writes no status either").toBe("running");
  });

  it("is never read as not known before the floor, however many reads -- and is, on the next read past it", async () => {
    Object.assign(notKnown, { reads: 2, floorMs: 60_000 });
    const { testId } = await aLegacyScan();
    for (let i = 0; i < 7; i++) expect((await read(testId)).engineKnowsRun).toBeUndefined();
    await pause(50);
    expect((await rowOf(testId)).findings).not.toHaveProperty("notKnown");
    // The floor was all that held it: the count of 404s stood all along.
    notKnown.floorMs = 0;
    expect((await read(testId)).notKnown).toMatchObject({ reads: 8 });
  });

  it("lets the reading go on any read the engine answers -- the answer, the count and the row's mark -- and starts the count over", async () => {
    Object.assign(notKnown, { reads: 2, floorMs: 0 });
    const { testId, runId } = await aLegacyScan();
    await read(testId);
    expect((await read(testId)).engineKnowsRun).toBe(false);
    await vi.waitFor(async () => expect((await rowOf(testId)).findings).toHaveProperty("notKnown"));

    // The engine knows the run after all.
    engine.runs.set(runId, "running");
    const known = await read(testId);
    expect(known.state).toBe("running");
    expect(known.engineKnowsRun).toBeUndefined();
    expect(known.notKnown).toBeUndefined();
    expect((await rowOf(testId)).findings).not.toHaveProperty("notKnown");

    // Forgotten again: one 404 is one, not the third of a run.
    engine.runs.delete(runId);
    expect((await read(testId)).engineKnowsRun).toBeUndefined();
    expect((await read(testId)).engineKnowsRun).toBe(false);
  });

  it("answers from memory when the reading could not be written, and writes it on a later read", async () => {
    Object.assign(notKnown, { reads: 2, floorMs: 0, persistEveryMs: 60_000 });
    const { testId } = await aLegacyScan();
    const real = storage.updateTest.bind(storage);
    const spy = vi.spyOn(storage, "updateTest").mockImplementation(async (id, data) => {
      if (id === testId) throw new Error("database is locked");
      return real(id, data);
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await read(testId);
    const standing = await read(testId);
    expect(standing.engineKnowsRun).toBe(false);
    expect(standing.notKnown).toMatchObject({ reads: 2 });
    await vi.waitFor(() => expect(errors.mock.calls.some(([line]) => String(line).includes("could not be written"))).toBe(true));
    expect((await rowOf(testId)).findings).not.toHaveProperty("notKnown");

    spy.mockRestore();
    const later = await read(testId);
    expect(later.notKnown).toMatchObject({ reads: 3 });
    await vi.waitFor(async () => expect((await rowOf(testId)).findings).toMatchObject({ notKnown: { reads: 3 } }));
  });

  it("refreshes the row's reading at most once per persistEveryMs", async () => {
    Object.assign(notKnown, { reads: 2, floorMs: 0, persistEveryMs: 60_000 });
    const { testId } = await aLegacyScan();
    await read(testId);
    await read(testId);
    await vi.waitFor(async () => expect((await rowOf(testId)).findings).toMatchObject({ notKnown: { reads: 2 } }));
    const spy = vi.spyOn(storage, "updateTest");
    await read(testId);
    await read(testId);
    await pause(50);
    expect(spy.mock.calls.filter(([id]) => id === testId)).toEqual([]);
    expect((await read(testId)).notKnown).toMatchObject({ reads: 5 });
  });
});

describe("what is never given the reading", () => {
  it("a hybrid row: its 404 asks for its record, and it is never marked", async () => {
    Object.assign(notKnown, { reads: 2, floorMs: 0 });
    const { testId } = await aLegacyScan({ backendScanId: "a1b2c3d4-0000-4000-8000-000000000001" });
    let answer: any;
    for (let i = 0; i < 4; i++) {
      answer = await read(testId);
      expect(answer.state).toBe("running");
      expect(answer.engineKnowsRun).toBeUndefined();
      expect(answer.notKnown).toBeUndefined();
    }
    // Its record is asked for instead (tests/a-hybrid-run-this-key-never-reads-ends-with-its-record.test.ts).
    expect(answer.backend).toMatchObject({ collected: false, watch: "running" });
    await pause(50);
    expect((await rowOf(testId)).findings).not.toHaveProperty("notKnown");
    expect((await rowOf(testId)).status).toBe("running");
  });

  it("a person: the reading cannot be supplied, and an edit of the scan keeps it", async () => {
    const supplied = await admin.post("/api/tests").send({
      clientId, testType: "vulnerability-scan", status: "running", findings: { notKnown: { since: new Date().toISOString(), reads: 9, said: "made up" } },
    });
    expect(supplied.status).toBe(400);
    expect(supplied.body.message).toContain("findings.notKnown");

    Object.assign(notKnown, { reads: 2, floorMs: 0 });
    const { testId } = await aLegacyScan();
    await read(testId);
    await read(testId);
    await vi.waitFor(async () => expect((await rowOf(testId)).findings).toHaveProperty("notKnown"));
    const mark = (await rowOf(testId)).findings as Record<string, unknown>;

    const forged = await admin.patch(`/api/tests/${testId}`).send({ findings: { ...mark, notKnown: { since: "2020-01-01T00:00:00.000Z", reads: 1, said: "x" } } });
    expect(forged.status).toBe(409);
    expect(forged.body.message).toContain("findings.notKnown");
    const edited = await admin.patch(`/api/tests/${testId}`).send({ findings: { details: "a person's note" } });
    expect(edited.status).toBe(200);
    expect((await rowOf(testId)).findings).toMatchObject({ details: "a person's note", notKnown: mark.notKnown });
  });
});
