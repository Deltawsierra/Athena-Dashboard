import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * SAFETY: the Tests screen's Edit dialog (routed at /tests) pre-filled the
 * Findings textarea with renderFindings(test.findings) -- for an engine test,
 * the JSON of {runId, target, results} -- and handleEditTest sent it back as
 * findings: { details: "<that JSON as a string>" }. PATCH /api/tests/:id took
 * it, and the engine run id was gone from the record. Fixing a typo in a
 * RUNNING scan's summary therefore:
 *   - took its Stop away: POST /api/scans/:id/abort answered 409 "this test
 *     has no engine run recorded against it, so there is nothing to stop"
 *     while the engine was still scanning the customer's system;
 * and for a COMPLETED scan whose results repeated one issue (two payloads,
 * one finding -- all of it filed), the summary started flagging a critical
 * "not tracked as findings" that is tracked.
 *
 * The route now keeps an engine test's run keys whatever the body says (only
 * the notes, `details`, are a person's), refuses a change to what the engine
 * decided -- status, severity, counts, the engagement -- and refuses to give a
 * person's test an engine run it never had.
 */
describe("editing an engine test on the Tests screen", () => {
  let app: Express;
  let admin: Awaited<ReturnType<typeof signIn>>;
  let engine: Server;
  let state = "running";
  const aborts: string[] = [];
  const RESULTS = [
    { type: "sql_injection", severity: "critical", evidence: { endpoint: "https://acme.example/login" }, payload: "' OR 1=1" },
    { type: "sql_injection", severity: "critical", evidence: { endpoint: "https://acme.example/login" }, payload: "'; --" },
  ];

  beforeAll(async () => {
    const http = await import("http");
    engine = http.createServer((req, res) => {
      const url = req.url ?? "";
      const json = (c: number, b: unknown) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
      if (url === "/health") return json(200, { status: "ok" });
      if (url.endsWith("/abort")) { aborts.push(url); return json(200, {}); }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        return json(200, { run_id: url.split("/")[3], state, result: { results: state === "completed" ? RESULTS : [] } });
      }
      return json(202, { run_id: `run-${Math.random().toString(36).slice(2, 7)}`, state: "running" });
    });
    await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
    process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
    process.env.ATHENA_ENGINE_KEY = "ce_op_test";
    vi.resetModules();
    app = await makeApp();
    admin = await signIn(app);
  });
  afterAll(async () => {
    delete process.env.ATHENA_ENGINE_URL; delete process.env.ATHENA_ENGINE_KEY;
    await new Promise<void>((r) => engine.close(() => r()));
  });

  /** Exactly what Tests.tsx handleEditTest sends when only the summary is changed. */
  const editBody = (t: Record<string, any>, summary: string) => ({
    summary, testType: t.testType, status: t.status, severity: t.severity ?? null,
    findings: { details: JSON.stringify(t.findings) },
    vulnerabilitiesFound: t.vulnerabilitiesFound, criticalCount: t.criticalCount, highCount: t.highCount,
    mediumCount: t.mediumCount, lowCount: t.lowCount,
  });

  async function engagement(name: string) {
    const c = await admin.post("/api/clients").send({ name, company: name, email: `${name}@x.test` });
    await admin.post("/api/sites").send({ clientId: c.body.id, name: "S", url: "https://acme.example" });
    return c.body.id as string;
  }

  it("a running scan keeps its Stop after its summary is edited", async () => {
    state = "running";
    const clientId = await engagement("Running");
    const started = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/" });
    const edited = await admin.patch(`/api/tests/${started.body.test.id}`).send(editBody(started.body.test, "typo fixed"));
    expect(edited.status).toBe(200);
    expect(edited.body.summary).toBe("typo fixed");
    expect(edited.body.findings).toMatchObject({ runId: started.body.runId, target: "https://acme.example/" });
    aborts.length = 0;
    const stop = await admin.post(`/api/scans/${started.body.test.id}/abort`);
    expect(stop.status).toBe(200);
    expect(aborts).toEqual([`/api/scans/${started.body.runId}/abort`]);
  });

  it("a person's notes are kept beside the run, not over it", async () => {
    state = "running";
    const clientId = await engagement("Notes");
    const started = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/" });
    const id = started.body.test.id;
    // What the Tests screen now sends for an engine test.
    const noted = await admin.patch(`/api/tests/${id}`).send({ summary: "s", testType: "vulnerability-scan", findings: { details: "seen by Ann" } });
    expect(noted.status).toBe(200);
    expect(noted.body.findings).toEqual({ runId: started.body.runId, target: "https://acme.example/", results: [], details: "seen by Ann" });
    expect(noted.body.testType).toBe("vulnerability-scan");
    // Clearing the notes clears only the notes.
    const cleared = await admin.patch(`/api/tests/${id}`).send({ findings: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.findings).toEqual({ runId: started.body.runId, target: "https://acme.example/", results: [] });
  });

  it("what the engine decided is refused as an edit, and the record is left as it was", async () => {
    state = "running";
    const clientId = await engagement("Owned");
    const other = await engagement("Other");
    const started = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/" });
    const id = started.body.test.id;
    for (const [body, named] of [
      [{ status: "completed" }, "status"],
      [{ criticalCount: 0, highCount: 3 }, "highCount"],
      [{ severity: "low" }, "severity"],
      [{ clientId: other }, "clientId"],
      [{ findings: { runId: "run-forged" } }, "findings.runId"],
      [{ findings: { details: "x", results: [] , target: "https://elsewhere.example/" } }, "findings.target"],
    ] as Array<[Record<string, unknown>, string]>) {
      const refused = await admin.patch(`/api/tests/${id}`).send({ summary: "try", ...body });
      expect(refused.status, JSON.stringify(body)).toBe(409);
      expect(refused.body.message, JSON.stringify(body)).toContain(named);
    }
    const after = (await admin.get(`/api/tests/${id}`)).body;
    expect(after.status).toBe("running");
    expect(after.summary).not.toBe("try");
    expect(after.findings.runId).toBe(started.body.runId);
    expect((await admin.post(`/api/scans/${id}/abort`)).status).toBe(200);
  });

  it("a person's test cannot be given an engine run, and stays theirs to edit", async () => {
    const clientId = await engagement("Manual");
    const created = await admin.post("/api/tests").send({ clientId, testType: "penetration-test", status: "pending" });
    const id = created.body.id;
    const forged = await admin.patch(`/api/tests/${id}`).send({ findings: { runId: "run-1", details: "x" } });
    expect(forged.status).toBe(400);
    expect((await admin.get(`/api/tests/${id}`)).body.findings).toBeNull();
    const edited = await admin.patch(`/api/tests/${id}`).send({
      status: "completed", criticalCount: 2, findings: { details: "two criticals" },
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ status: "completed", criticalCount: 2, findings: { details: "two criticals" } });
  });

  it("a completed scan that filed everything it found is not flagged after its summary is edited", async () => {
    state = "running";
    const clientId = await engagement("Completed");
    const started = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/" });
    state = "completed";
    const done = await admin.get(`/api/scans/${started.body.test.id}`); // files the findings
    expect(done.body.test.criticalCount).toBe(2);
    const before = (await admin.get("/api/findings/summary")).body.byClient.find((c: any) => c.clientId === clientId);
    expect(before.untrackedScan).toBeNull(); // one critical finding, filed: nothing untracked
    await admin.patch(`/api/tests/${started.body.test.id}`).send(editBody(done.body.test, "typo fixed"));
    const after = (await admin.get("/api/findings/summary")).body.byClient.find((c: any) => c.clientId === clientId);
    expect(after.untrackedScan).toBeNull();
  });
});
