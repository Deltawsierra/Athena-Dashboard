/**
 * A scan whose findings could not be read has no counts on record, and every
 * part of the app that reads a scan's counts says so.
 *
 * When the engine's `results` are not a list, the scan route records them as
 * `results: null` and neither counts nor files them. But the counts beside them
 * were real zeros (an inline completion counted from nothing), or whatever an
 * earlier poll had counted. `countsNotRecorded` read only a list, so `readScan`
 * read the record as a completed scan that found nothing: the assistant was
 * told "0 critical / 0 high / 0 medium / 0 low", and Overview, Deployments and
 * Evidence read it the same way. Where an earlier poll had counted findings,
 * those counts stood as the finished scan's, though the findings they were
 * counted from had been replaced by null and never filed.
 *
 * Now a finished run whose results could not be read records no counts (the
 * earlier poll's are cleared), and a completed engine record with unread results
 * and no count reads as "counts not recorded" everywhere `readScan` is read.
 *
 * These run the real routes against a fake engine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { countsNotRecorded, readScan } from "@shared/latest-scans";
import type { IStorage } from "../server/storage";
import { makeApp, signIn } from "./helpers";

const HIGH = { type: "reflected_xss", severity: "high", message: "Reflected input on /search", confidence: 0.65 };
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
let engine: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let clientId: string;

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active") return json(res, 200, { active: [] });
    if (url.startsWith("/api/scanners")) return json(res, 200, { scanners: [] });
    if (req.method === "POST" && url === "/api/scan") {
      runs += 1;
      return json(res, 200, startBody(`run-${runs}`));
    }
    if (req.method === "GET" && url.startsWith("/api/scans/run-")) return json(res, 200, pollBody());
    return json(res, 404, { detail: "not here" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  agent = await signIn(await makeApp());
  storage = (await import("../server/storage-unified")).storage;
  clientId = (await agent.post("/api/clients").send({ name: "Unread", company: "Unread", email: "u@u.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://unread.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});

async function startScan() {
  const started = await agent.post("/api/scans").send({ clientId, target: "https://unread.example/" });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return started.body as { test: { id: string } };
}

/** What every reader of a scan's counts makes of a test, read as they read it. */
async function readers(testId: string) {
  const stored = (await storage.getTest(testId))!;
  const { describeCounts } = await import("../server/summary");
  const read = readScan(stored);
  return { stored, read, described: describeCounts(read), notRecorded: countsNotRecorded(stored) };
}

/** A finished scan whose counts are not on record, as each reader reads it. */
function expectNotRecorded(r: Awaited<ReturnType<typeof readers>>) {
  expect(r.notRecorded).toBe(true);
  expect(r.read.countsNotRecorded).toBe(true);
  expect(r.described).toBe("counts not recorded");
  expect(r.described).not.toMatch(/0 critical/);
  // No count stands that the final findings do not back.
  expect(r.stored.criticalCount + r.stored.highCount + r.stored.mediumCount + r.stored.lowCount).toBe(0);
  expect(r.stored.vulnerabilitiesFound).toBe(0);
  expect(r.stored.severity).toBeNull();
  expect((r.stored.findings as { results?: unknown }).results).toBeNull();
}

describe("a scan whose findings could not be read", () => {
  it("finished inline: its counts are not recorded, and the assistant is never told 0", async () => {
    startBody = (runId) => ({ run_id: runId, state: "completed", result: { results: "garbled" } });
    const { test } = await startScan();
    const read = await agent.get(`/api/scans/${test.id}`);
    expect(read.body.detail).toBe(RECORDED_UNREAD);

    const r = await readers(test.id);
    expect(r.stored.status).toBe("completed");
    expectNotRecorded(r);

    const { deploymentSummary } = await import("../server/summary");
    const told = await deploymentSummary();
    expect(told).toMatch(/Counts were not recorded for \d+ completed scans?, so these totals leave them out\./);
    expect(told).toMatch(/penetration_test on an unnamed site: completed, counts not recorded/);
    expect(told).not.toMatch(/completed, 0 critical \/ 0 high/);
  });

  it("finished on a poll after a readable empty one: not recorded, never a measured 0", async () => {
    startBody = (runId) => ({ run_id: runId, state: "running" });
    pollBody = () => ({ state: "running", result: { results: [] } });
    const { test } = await startScan();
    await agent.get(`/api/scans/${test.id}`);
    pollBody = () => ({ state: "completed", result: { results: { 0: HIGH } } });
    const done = await agent.get(`/api/scans/${test.id}`);
    expect(done.body.detail).toBe(SENT_UNREAD);

    const r = await readers(test.id);
    expect(r.stored.status).toBe("completed");
    expectNotRecorded(r);
  });

  it("finished on a poll after one that counted a high: that count does not stand as the scan's", async () => {
    startBody = (runId) => ({ run_id: runId, state: "running" });
    pollBody = () => ({ state: "running", result: { results: [HIGH] } });
    const { test } = await startScan();
    await agent.get(`/api/scans/${test.id}`);
    expect((await storage.getTest(test.id))!.highCount).toBe(1);

    pollBody = () => ({ state: "completed", result: { results: "garbled" } });
    const done = await agent.get(`/api/scans/${test.id}`);
    expect(done.body.engine).toBeNull();
    expect(done.body.detail).toBe(SENT_UNREAD);
    // Nothing was filed from the unread poll, and the high it replaced was never filed either.
    expect(done.body.filed).toBeNull();

    const r = await readers(test.id);
    expect(r.stored.status).toBe("completed");
    expectNotRecorded(r);
    // Read again, the record says the same.
    const again = await agent.get(`/api/scans/${test.id}`);
    expect(again.body.detail).toBe(RECORDED_UNREAD);
    expect(again.body.test.highCount).toBe(0);
  });

  it("finished on a poll whose results are null: unread, never read as none", async () => {
    startBody = (runId) => ({ run_id: runId, state: "running" });
    pollBody = () => ({ state: "completed", result: { results: null } });
    const { test } = await startScan();
    const done = await agent.get(`/api/scans/${test.id}`);
    expect(done.body.engine).toBeNull();
    expect(done.body.detail).toBe(SENT_UNREAD);
    expect(done.body.filed).toBeNull();

    const r = await readers(test.id);
    expectNotRecorded(r);
  });

  it("stopped (aborted) on a poll after one that counted a high: the count is cleared with the findings", async () => {
    startBody = (runId) => ({ run_id: runId, state: "running" });
    pollBody = () => ({ state: "running", result: { results: [HIGH] } });
    const { test } = await startScan();
    await agent.get(`/api/scans/${test.id}`);
    pollBody = () => ({ state: "aborted", result: { results: { 0: HIGH } } });
    const done = await agent.get(`/api/scans/${test.id}`);
    expect(done.body.state).toBe("aborted");
    expect(done.body.detail).toBe(SENT_UNREAD);

    const stored = (await storage.getTest(test.id))!;
    expect(stored.highCount).toBe(0);
    expect(stored.severity).toBeNull();
    expect((stored.findings as { results?: unknown }).results).toBeNull();
  });

  it("while it runs, an unread poll leaves the last readable count, and a readable finish recounts", async () => {
    startBody = (runId) => ({ run_id: runId, state: "running" });
    pollBody = () => ({ state: "running", result: { results: [HIGH] } });
    const { test } = await startScan();
    await agent.get(`/api/scans/${test.id}`);
    pollBody = () => ({ state: "running", result: { results: "garbled" } });
    await agent.get(`/api/scans/${test.id}`);
    expect((await storage.getTest(test.id))!.highCount).toBe(1);

    pollBody = () => ({ state: "completed", result: { results: [HIGH, { ...HIGH, message: "Reflected input on /q" }] } });
    await agent.get(`/api/scans/${test.id}`);
    const r = await readers(test.id);
    expect(r.notRecorded).toBe(false);
    expect(r.stored.highCount).toBe(2);
    expect(r.described).toBe("0 critical / 2 high / 0 medium / 0 low");
  });

  it("reads any recorded results that are not a list, and no count, as not recorded; a count beside them stands", () => {
    const zero = { status: "completed", severity: null, vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
    for (const results of [null, "garbled", { 0: HIGH }, 7]) {
      const label = JSON.stringify(results);
      expect(countsNotRecorded({ ...zero, findings: { runId: "run-1", target: "https://unread.example/", results } }), label).toBe(true);
      // Engine records without a run id, marked by their target, or by results alone.
      expect(countsNotRecorded({ ...zero, findings: { runId: null, target: "https://unread.example/", results } }), label).toBe(true);
      // Counted from readable findings before they became unreadable: that measurement was taken.
      expect(countsNotRecorded({ ...zero, highCount: 1, findings: { runId: "run-1", results } }), label).toBe(false);
    }
    expect(countsNotRecorded({ ...zero, findings: { results: "garbled" } })).toBe(true);
    // Still running: no count is expected yet.
    expect(countsNotRecorded({ ...zero, status: "running", findings: { runId: "run-1", results: null } })).toBe(false);
    // A list the engine read as none is a measured 0.
    expect(countsNotRecorded({ ...zero, findings: { runId: "run-1", results: [] } })).toBe(false);
  });

  it("a person's test whose run keys were sent as null is still read by its counts", async () => {
    const made = await agent.post("/api/tests").send({
      clientId, testType: "penetration-test", status: "completed", summary: "by hand",
      findings: { runId: null, target: null, results: null },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const r = await readers(made.body.id);
    expect(r.notRecorded).toBe(false);
    expect(r.described).toBe("0 critical / 0 high / 0 medium / 0 low");
  });
});
