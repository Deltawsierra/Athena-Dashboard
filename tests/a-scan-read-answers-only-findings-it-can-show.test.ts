import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { countsNotRecorded, readScan } from "@shared/latest-scans";
import type { IStorage } from "../server/storage";
import { makeApp, signIn } from "./helpers";

/**
 * `GET /api/scans/:testId` answers the findings a scan screen can show, and says
 * why when it has none to answer. Round 1 of PR #55's adversary found five ways it
 * did not:
 *
 * - A completed test with no engine run (a person's) was told its recorded
 *   findings "could not be read". It has none: no engine run stands behind it.
 * - A row with an object in a text field (`message: { text }`) was answered, and
 *   both scan screens threw rendering it.
 * - An engine `result.results` that is not a list was read as `[]`, so it was
 *   recorded, answered and shown as a scan that returned no findings.
 * - A truthy `internal` that is not `true` was counted as a finding while the
 *   screens listed it as a note: "returned no findings" beside High 1.
 * - The counts of an engine scan recorded with no run id could be edited, so
 *   the findings listed disagreed with the counts beside them.
 *
 * It also pins what the route already did and nothing tested: a run recorded as
 * aborted or failed is still asked about (only `completed` stops the asking),
 * and a completed read answers the engine's internal notes with its findings.
 */

const BASIS =
  "ordinal: derived from the number of independent signals in the evidence. " +
  "Not a probability that this finding is real.";
const HIGH = { type: "reflected_xss", severity: "high", message: "Reflected input", confidence: 0.65, confidence_basis: BASIS };
const NO_RUN = "this test has no engine run recorded against it";
const RECORDED_UNREAD = "the findings recorded for this scan could not be read";
const SENT_UNREAD = "the findings the engine sent for this run could not be read";

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** What the engine answers a start and a poll with; each test sets its own. */
let startBody: (runId: string) => Record<string, unknown> = (runId) => ({ run_id: runId, state: "running" });
let pollBody: () => Record<string, unknown> = () => ({ state: "running" });
let runs = 0;
const polls: string[] = [];
let engine: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let clientId: string;

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active") return json(res, 200, { active: [] });
    if (req.method === "POST" && url === "/api/scan") {
      runs += 1;
      return json(res, 200, startBody(`run-${runs}`));
    }
    if (req.method === "GET" && url.startsWith("/api/scans/run-")) {
      polls.push(url);
      return json(res, 200, pollBody());
    }
    return json(res, 404, { detail: "not here" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  agent = await signIn(await makeApp());
  storage = (await import("../server/storage-unified")).storage;
  clientId = (await agent.post("/api/clients").send({ name: "Shown", company: "Shown", email: "s@s.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://shown.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});

async function startScan() {
  const started = await agent.post("/api/scans").send({ clientId, target: "https://shown.example/" });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return started.body as { test: { id: string; findings: Record<string, unknown> }; runId: string | null; detail?: string };
}

/** A run the engine finishes inline with `results`. */
const finishesInline = (results: unknown, withRunId = true) => {
  startBody = (runId) => ({ ...(withRunId ? { run_id: runId } : {}), state: "completed", result: { results } });
};

describe("a test no engine run stands behind", () => {
  it("answers that it has no engine run, completed or not, and asks no engine", async () => {
    const asked = polls.length;
    const bodies = [
      { status: "completed", summary: "by hand", findings: { details: "two criticals" }, criticalCount: 2, vulnerabilitiesFound: 2 },
      { status: "completed", summary: "by hand, nothing recorded" },
      { status: "completed", summary: "by hand, run keys sent as null", findings: { runId: null, target: null, results: null } },
      { status: "running", summary: "by hand, running" },
    ];
    for (const body of bodies) {
      const made = await agent.post("/api/tests").send({ clientId, testType: "penetration-test", ...body });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const read = await agent.get(`/api/scans/${made.body.id}`);
      expect(read.status, body.summary).toBe(200);
      expect(read.body.engine, body.summary).toBeNull();
      expect(read.body.detail, body.summary).toBe(NO_RUN);
      expect(read.body.state, body.summary).toBe(body.status);
    }
    expect(polls).toHaveLength(asked);
  });
});

describe("an engine scan recorded with no run id", () => {
  it("answers its findings when completed, and refuses a change to its counts", async () => {
    finishesInline([HIGH], false);
    const { test, runId } = await startScan();
    expect(runId).toBeNull();

    // It is a run the engine finished, not a test with no run behind it.
    const read = await agent.get(`/api/scans/${test.id}`);
    expect(read.body.detail).not.toBe(NO_RUN);
    expect(read.body.engine?.findings).toEqual([HIGH]);
    expect(read.body.engine.runId).toBeNull();

    const patched = await agent.patch(`/api/tests/${test.id}`).send({ criticalCount: 5, vulnerabilitiesFound: 5 });
    expect(patched.status, JSON.stringify(patched.body)).toBe(409);
    expect(patched.body.message).toMatch(/criticalCount/);
    const after = await agent.get(`/api/scans/${test.id}`);
    expect(after.body.test.criticalCount).toBe(0);
    expect(after.body.test.highCount).toBe(1);
    expect(after.body.engine.findings).toEqual([HIGH]);

    // The summary is still a person's to edit.
    const summary = await agent.patch(`/api/tests/${test.id}`).send({ summary: "renamed" });
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
  });

  it("guards one whose results could not be read, by the target the scan route recorded", async () => {
    finishesInline("garbled", false);
    const { test } = await startScan();
    expect(test.findings.results).toBeNull();
    expect(test.findings.target).toBe("https://shown.example/");
    const patched = await agent.patch(`/api/tests/${test.id}`).send({ highCount: 2 });
    expect(patched.status, JSON.stringify(patched.body)).toBe(409);
  });

  it("guards a record holding only a run's results, and leaves a person's test editable", async () => {
    const made = await agent.post("/api/tests").send({ clientId, testType: "penetration-test", status: "completed", summary: "by hand" });
    expect((await agent.patch(`/api/tests/${made.body.id}`).send({ criticalCount: 3 })).status).toBe(200);

    await storage.updateTest(made.body.id, { findings: { results: [HIGH] } });
    const patched = await agent.patch(`/api/tests/${made.body.id}`).send({ criticalCount: 4 });
    expect(patched.status, JSON.stringify(patched.body)).toBe(409);
    expect((await agent.get(`/api/tests/${made.body.id}`)).body.criticalCount).toBe(3);
  });
});

describe("a run recorded as aborted or failed", () => {
  it("is asked about again: only a run recorded as completed stops the asking", async () => {
    for (const state of ["aborted", "failed"]) {
      startBody = (runId) => ({ run_id: runId, state: "running" });
      pollBody = () => ({ state, result: { results: [HIGH] } });
      const { test } = await startScan();

      const first = await agent.get(`/api/scans/${test.id}`);
      expect(first.body.test.status, state).toBe(state);
      const asked = polls.length;
      const again = await agent.get(`/api/scans/${test.id}`);
      expect(polls, state).toHaveLength(asked + 1);
      expect(again.body.state, state).toBe(state);
      expect(again.body.engine?.findings, state).toEqual([HIGH]);
      expect(again.body.engine.detail, state).not.toBe("the findings recorded when the run completed");
    }
  });
});

describe("results the engine sent that are not a list", () => {
  it("are recorded as unread when the engine finished the run inline, and answered as unread", async () => {
    for (const results of ["garbled", { 0: HIGH }, null, 7]) {
      const label = JSON.stringify(results);
      finishesInline(results);
      const asked = polls.length;
      const started = await startScan();
      expect(started.test.findings.results, label).toBeNull();
      expect(started.detail, label).toBe(
        "the run's results could not be filed as findings: the engine's results for this run could not be read",
      );

      const read = await agent.get(`/api/scans/${started.test.id}`);
      expect(read.body.state, label).toBe("completed");
      expect(read.body.engine, label).toBeNull();
      expect(read.body.detail, label).toBe(RECORDED_UNREAD);
      expect(polls, label).toHaveLength(asked);
    }
  });

  it("are answered as unread on the poll that completes the run, never counted, and unread when read again", async () => {
    startBody = (runId) => ({ run_id: runId, state: "running" });
    pollBody = () => ({ state: "running", result: { results: [HIGH] } });
    const { test } = await startScan();
    const running = await agent.get(`/api/scans/${test.id}`);
    expect(running.body.engine.findings).toEqual([HIGH]);
    expect(running.body.test.highCount).toBe(1);

    pollBody = () => ({ state: "completed", result: { results: { 0: HIGH, 1: HIGH } } });
    const completing = await agent.get(`/api/scans/${test.id}`);
    expect(completing.status).toBe(200);
    expect(completing.body.state).toBe("completed");
    expect(completing.body.engine).toBeNull();
    expect(completing.body.detail).toBe(SENT_UNREAD);
    expect(completing.body.filed).toBeNull();
    expect(completing.body.test.findings.results).toBeNull();
    // Not counted from what could not be read, and the earlier poll's high does
    // not stand as the finished scan's: no count is on record, and that is read
    // as "not recorded", never as none.
    expect(completing.body.test.highCount).toBe(0);
    expect(completing.body.test.vulnerabilitiesFound).toBe(0);
    expect(completing.body.test.severity).toBeNull();
    expect(countsNotRecorded(completing.body.test)).toBe(true);
    expect(completing.body.test.status).toBe("completed");

    const asked = polls.length;
    const again = await agent.get(`/api/scans/${test.id}`);
    expect(polls).toHaveLength(asked);
    expect(again.body.engine).toBeNull();
    expect(again.body.detail).toBe(RECORDED_UNREAD);
  });

  it("are still none when the engine sent no results at all", async () => {
    startBody = (runId) => ({ run_id: runId, state: "running" });
    pollBody = () => ({ state: "running" });
    const { test } = await startScan();
    const read = await agent.get(`/api/scans/${test.id}`);
    expect(read.body.engine?.findings).toEqual([]);
  });
});

describe("a row a scan screen cannot show", () => {
  const unshowable = [
    { ...HIGH, message: { text: "an object message" } },
    { ...HIGH, severity: { level: "high" } },
    { ...HIGH, type: 7 },
    { ...HIGH, details: ["a", "list"] },
  ];

  it("makes the findings unread, on a poll and read again once completed, and is never answered", async () => {
    for (const row of unshowable) {
      const label = JSON.stringify(row);
      startBody = (runId) => ({ run_id: runId, state: "running" });
      pollBody = () => ({ state: "running", result: { results: [HIGH, row] } });
      const { test } = await startScan();

      const polled = await agent.get(`/api/scans/${test.id}`);
      expect(polled.status, label).toBe(200);
      expect(polled.body.engine, label).toBeNull();
      expect(polled.body.detail, label).toBe(SENT_UNREAD);

      pollBody = () => ({ state: "completed", result: { results: [HIGH, row] } });
      await agent.get(`/api/scans/${test.id}`);
      const again = await agent.get(`/api/scans/${test.id}`);
      expect(again.body.state, label).toBe("completed");
      expect(again.body.engine, label).toBeNull();
      expect(again.body.detail, label).toBe(RECORDED_UNREAD);
      // Counted, not dropped: the high the rows carry is in the record's counts.
      expect(again.body.test.highCount, label).toBeGreaterThanOrEqual(1);
    }
  });

  it("is answered when a text field is null, which is none", async () => {
    finishesInline([{ ...HIGH, details: null, type: null }]);
    const { test } = await startScan();
    const read = await agent.get(`/api/scans/${test.id}`);
    expect(read.body.engine?.findings).toEqual([{ ...HIGH, details: null, type: null }]);
  });
});

describe("the engine's internal notes", () => {
  it("are any truthy `internal`, as the engine reads it: never counted, and answered with the findings once completed", async () => {
    const notes = [
      { type: "engine_error", severity: "high", message: "marked true", internal: true },
      { type: "engine_error", severity: "high", message: "marked yes", internal: "yes" },
      { type: "engine_error", severity: "critical", message: "marked 1", internal: 1 },
      { type: "engine_error", severity: "critical", message: "marked with a list", internal: ["why"] },
    ];
    // Falsy as Python reads it: `if item.get("internal"):` in athena-engine's scoring.py.
    const counted = [
      { ...HIGH, message: "marked 0", internal: 0 },
      { ...HIGH, message: "marked with an empty list", internal: [] },
      { ...HIGH, message: "marked with an empty object", internal: {} },
    ];
    finishesInline([HIGH, ...notes, ...counted]);
    const { test } = await startScan();

    const read = await agent.get(`/api/scans/${test.id}`);
    expect(read.body.test.highCount).toBe(4);
    expect(read.body.test.criticalCount).toBe(0);
    expect(read.body.test.vulnerabilitiesFound).toBe(4);
    expect(read.body.engine?.findings).toEqual([HIGH, ...notes, ...counted]);

    // Nor filed as a finding with a life of its own.
    const filed = await storage.getFindingsByClient(clientId);
    expect(filed.some((one) => one.type === "reflected_xss")).toBe(true);
    expect(filed.filter((one) => one.type === "engine_error")).toEqual([]);
  });

  it("are read by the same rule where a record's counts are read", () => {
    // A severity that is no rating, so a note read as a result would be an unrated one.
    const note = { type: "engine_error", severity: "bogus", message: "marked yes", internal: "yes" };
    const record = {
      status: "completed", findings: { runId: "run-x", target: "https://shown.example/", results: [note] },
      vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, severity: null,
    };
    // Every count zero beside only a note is a scan that found nothing, not counts never recorded.
    expect(countsNotRecorded(record)).toBe(false);
    expect(readScan(record).unrated).toBe(0);
    // A result the engine did not mark is still one.
    const real = { ...record, findings: { ...record.findings, results: [{ ...note, internal: [] }] } };
    expect(countsNotRecorded(real)).toBe(true);
    expect(readScan(real).unrated).toBe(1);
  });
});
