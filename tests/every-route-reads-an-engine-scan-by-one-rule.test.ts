/**
 * Every route reads "is this an engine scan" by one rule (shared/engine-record.ts):
 * its findings carry a run id, the target the scan route recorded, or the run's
 * results.
 *
 * Three rules disagreed. `GET /api/scans/:testId` checked a run id or a target
 * for "no engine run", then a run id alone for a scan still running; the edit
 * guard on `PATCH /api/tests/:id` checked a run id, a target or results. So a
 * record holding a run's results was told it had "no engine run recorded
 * against it" by the same server that refused its edit as an engine scan's, and
 * a running scan the engine accepted without a run id was told it had no engine
 * run at all -- as was its Stop.
 *
 * And a scan the engine finished without a run id was edited on the Tests screen
 * as a person's test: the screen sent `severity: null` with a summary-only edit,
 * and the guard refused it (409), naming a field nobody touched. The body the
 * screen sends now is accepted here.
 *
 * These run the real routes against a fake engine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { engineRunIdOf, isEngineRecord } from "@shared/engine-record";
import type { IStorage } from "../server/storage";
import { makeApp, signIn } from "./helpers";

const HIGH = { type: "reflected_xss", severity: "high", message: "Reflected input on /search", confidence: 0.65 };
const NO_RUN = "this test has no engine run recorded against it";
const NO_RUN_ID_TO_ASK = "the engine accepted this scan without a run id, so the engine cannot be asked about it";

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let startBody: (runId: string) => Record<string, unknown> = (runId) => ({ run_id: runId, state: "running" });
let active: Array<Record<string, unknown>> = [];
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
      return json(res, 200, startBody(`run-${runs}`));
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
  clientId = (await agent.post("/api/clients").send({ name: "One rule", company: "One rule", email: "o@o.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://one.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});

async function startScan() {
  const started = await agent.post("/api/scans").send({ clientId, target: "https://one.example/" });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return started.body as { test: { id: string }; runId: string | null };
}

describe("the rule", () => {
  it("is a run id, a target or a run's results; a key recorded as null is none", () => {
    expect(isEngineRecord({ runId: "run-1" })).toBe(true);
    expect(isEngineRecord({ runId: null, target: "https://one.example/" })).toBe(true);
    expect(isEngineRecord({ results: [HIGH] })).toBe(true);
    expect(isEngineRecord({ results: [] })).toBe(true);
    expect(isEngineRecord({ runId: null, target: "https://one.example/", results: null })).toBe(true);
    expect(isEngineRecord({ runId: null, target: null, results: null })).toBe(false);
    expect(isEngineRecord({ runId: "", details: "notes" })).toBe(false);
    expect(isEngineRecord({ details: "notes" })).toBe(false);
    expect(isEngineRecord(null)).toBe(false);
    expect(isEngineRecord([{ runId: "run-1" }])).toBe(false);
    expect(engineRunIdOf({ runId: "run-1" })).toBe("run-1");
    expect(engineRunIdOf({ runId: "" })).toBeNull();
    expect(engineRunIdOf({ runId: 7 })).toBeNull();
  });
});

describe("a record holding only a run's results", () => {
  it("is answered its findings, and its counts are refused as an engine scan's, by the same server", async () => {
    const made = await agent.post("/api/tests").send({ clientId, testType: "penetration-test", status: "completed", summary: "by hand" });
    expect(made.status).toBe(201);
    await storage.updateTest(made.body.id, { findings: { results: [HIGH] }, highCount: 1, vulnerabilitiesFound: 1, severity: "high" });

    const read = await agent.get(`/api/scans/${made.body.id}`);
    expect(read.body.detail).not.toBe(NO_RUN);
    expect(read.body.engine?.findings).toEqual([HIGH]);

    const patched = await agent.patch(`/api/tests/${made.body.id}`).send({ criticalCount: 4 });
    expect(patched.status).toBe(409);
    const summary = await agent.patch(`/api/tests/${made.body.id}`).send({ summary: "renamed" });
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
  });
});

describe("a running scan the engine accepted without a run id", () => {
  it("is never told it has no engine run, is not asked about, and its counts are the engine's", async () => {
    startBody = () => ({ state: "running", result: { results: [HIGH] } });
    const { test, runId } = await startScan();
    expect(runId).toBeNull();
    const polledBefore = calls.filter((one) => one.startsWith("GET /api/scans/run-")).length;

    const read = await agent.get(`/api/scans/${test.id}`);
    expect(read.body.state).toBe("running");
    expect(read.body.engine).toBeNull();
    expect(read.body.detail).toBe(NO_RUN_ID_TO_ASK);
    expect(read.body.detail).not.toMatch(/no engine run/);
    expect(calls.filter((one) => one.startsWith("GET /api/scans/run-")).length).toBe(polledBefore);

    const patched = await agent.patch(`/api/tests/${test.id}`).send({ criticalCount: 4 });
    expect(patched.status).toBe(409);
  });

  it("its Stop says why the engine cannot be named, never that there is no engine run, and points to the kill switch", async () => {
    startBody = () => ({ state: "running" });
    const { test } = await startScan();
    const stopped = await agent.post(`/api/scans/${test.id}/abort`);
    expect(stopped.status).toBe(409);
    expect(stopped.body.error).toMatch(/^the engine accepted this scan without a run id/);
    expect(stopped.body.error).toMatch(/kill switch sends a stop to every run the engine lists as running/);
    expect(stopped.body.error).not.toMatch(/no engine run/);
  });

  it("is reached by the kill switch when the engine lists its run", async () => {
    startBody = () => ({ state: "running" });
    await startScan();
    active = [{ run_id: "run-the-engine-named", target: "https://one.example/", state: "running" }];
    try {
      const engaged = await agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
      expect(engaged.status, JSON.stringify(engaged.body)).toBe(200);
      expect(calls).toContain("POST /api/scans/run-the-engine-named/abort");
    } finally {
      active = [];
      await agent.patch("/api/ai-control").send({ killSwitchEnabled: false });
    }
  });
});

describe("a person's test", () => {
  it("is told it has no engine run, running or completed, and its counts stay a person's", async () => {
    for (const status of ["completed", "in-progress"]) {
      const made = await agent.post("/api/tests").send({
        clientId, testType: "penetration-test", status, summary: "by hand",
        findings: { runId: null, target: null, results: null },
      });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const read = await agent.get(`/api/scans/${made.body.id}`);
      expect(read.body.detail).toBe(NO_RUN);
      const stopped = await agent.post(`/api/scans/${made.body.id}/abort`);
      expect(stopped.body.error).toBe("this test has no engine run recorded against it, so there is nothing to stop");
      const patched = await agent.patch(`/api/tests/${made.body.id}`).send({ criticalCount: 4 });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    }
  });
});

describe("a scan the engine finished without a run id, edited on the Tests screen", () => {
  it("takes the summary-only edit the screen sends, and keeps the engine's severity and counts", async () => {
    startBody = () => ({ state: "completed", result: { results: [{ type: "banner", severity: "info", message: "Server header" }] } });
    const { test } = await startScan();
    const before = (await storage.getTest(test.id))!;
    expect(before.severity).toBe("info");

    // What the Tests screen sends for an engine scan: the summary, the test type and the notes, nothing else.
    const patched = await agent.patch(`/api/tests/${test.id}`).send({
      summary: "typo fixed", testType: before.testType, findings: null,
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const after = (await storage.getTest(test.id))!;
    expect(after.summary).toBe("typo fixed");
    expect(after.severity).toBe("info");
    expect(after.vulnerabilitiesFound).toBe(before.vulnerabilitiesFound);
    expect(after.findings).toEqual(before.findings);
  });
});
