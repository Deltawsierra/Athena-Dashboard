import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * The compliance route, whose job is to feed the map real findings and a real
 * scanner inventory -- and to refuse to invent either.
 */
describe("the compliance map over an engagement", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;
  let server: Server;
  let extensions: Record<string, unknown> = {};
  let extensionsStatus = 200;

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const url = req.url ?? "";
        if (url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ status: "ok" }));
        }
        if (url === "/api/extensions") {
          res.writeHead(extensionsStatus, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(extensions));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: "run-1", state: "completed", result: { results: [] } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_ENGINE_KEY = "ce_op_test";
    vi.resetModules();
    app = await makeApp();
    agent = await signIn(app);
  });

  afterAll(async () => {
    delete process.env.ATHENA_ENGINE_URL;
    delete process.env.ATHENA_ENGINE_KEY;
    await new Promise<void>((r) => server.close(() => r()));
  });

  const scanner = (name: string) => ({ name, kind: "scanner", enabled: true });

  async function anEngagement(results: unknown[]) {
    const client = await agent.post("/api/clients")
      .send({ name: "Mapped", company: "Mapped Ltd", email: "m@example.test" });
    // An engine scan's row, as the scan route writes it: a run's keys are
    // that route's to record, and POST /api/tests refuses them (R5-A).
    const { storage } = await import("../server/storage-unified");
    await storage.createTest({
      clientId: client.body.id, testType: "pentest", status: "completed",
      findings: { runId: "run-1", results }, vulnerabilitiesFound: results.length,
    });
    return client.body.id as string;
  }

  it("reads only scanners the engine says are loaded and enabled", async () => {
    extensionsStatus = 200;
    extensions = {
      extensions: [
        scanner("command_injection"),
        // A detector is not a scanner: it produces no finding a requirement is
        // judged on, and counting it would claim coverage that does not exist.
        { name: "rule_detector", kind: "detector", enabled: true },
        // Present on disk but switched off did not run.
        { name: "ssrf", kind: "scanner", enabled: false },
      ],
    };
    const clientId = await anEngagement([]);

    const res = await agent.get(`/api/compliance/${clientId}`);
    expect(res.status).toBe(200);
    expect(res.body.scannersLoaded).toEqual(["command_injection"]);

    const rows = res.body.rows as Array<{ requirement: { id: string }; state: string }>;
    const byId = (id: string) => rows.find((one) => one.requirement.id === id)?.state;
    expect(byId("V5.3.8")).toBe("tested");   // command_injection ran
    expect(byId("V5.2.6")).toBe("not_run");  // ssrf is off
  });

  it("reports not run, never tested, when the engine will not answer", async () => {
    extensionsStatus = 503;
    extensions = {};
    const clientId = await anEngagement([]);

    const res = await agent.get(`/api/compliance/${clientId}`);
    expect(res.body.scannersLoaded).toBeNull();
    expect(res.body.summary.tested).toBe(0);
    expect(res.body.summary.notRun).toBeGreaterThan(0);
  });

  it("counts findings against requirements, and leaves sample rows out", async () => {
    extensionsStatus = 200;
    extensions = { extensions: [scanner("command_injection"), scanner("header_scanner")] };
    const clientId = await anEngagement([
      { type: "command_injection", severity: "high", message: "Command injection vulnerability detected" },
      // The shape a live engine actually returns: the scanner sets `header`,
      // and the pipeline moves a scanner's own fields into `evidence` before
      // the finding leaves. A fixture that put the header at the top level
      // passed while every real missing-header finding went unmapped.
      {
        type: "missing_security_header", severity: "medium",
        message: "CSP helps prevent XSS and data injection",
        evidence: { header: "Content-Security-Policy", details: "CSP helps prevent XSS" },
      },
      // Internal notes are the engine reporting its own trouble.
      { type: "error", internal: true, details: "connection reset" },
    ]);

    const res = await agent.get(`/api/compliance/${clientId}`);
    const rows = res.body.rows as Array<{ requirement: { id: string }; state: string; findings: unknown[] }>;
    const row = (id: string) => rows.find((one) => one.requirement.id === id);
    expect(row("V5.3.8")?.state).toBe("failing");
    expect(row("V14.4.3")?.state).toBe("failing");
    expect(row("V14.4.6")?.state).toBe("tested");
    expect(res.body.summary.unmapped).toEqual([]);
  });

  it("says why a missing-header finding could not be attributed, when it names no header", async () => {
    // Not "the standard does not cover it": ASVS covers these headers. The
    // finding did not say which one, which is a different failure and needs a
    // different sentence.
    extensionsStatus = 200;
    extensions = { extensions: [scanner("header_scanner")] };
    const clientId = await anEngagement([
      { type: "missing_security_header", severity: "low", evidence: {} },
    ]);

    const res = await agent.get(`/api/compliance/${clientId}`);
    const entry = res.body.summary.unmapped.find(
      (one: { type: string }) => one.type === "missing_security_header",
    );
    expect(entry.reason).toContain("did not name a header");
    expect(entry.reason).not.toContain("no requirement in this version");
  });

  it("refuses a site belonging to another client", async () => {
    extensionsStatus = 200;
    extensions = { extensions: [scanner("command_injection")] };
    const mine = await anEngagement([]);
    const other = await agent.post("/api/clients")
      .send({ name: "Other", company: "Other Ltd", email: "o@example.test" });
    const theirSite = await agent.post("/api/sites")
      .send({ clientId: other.body.id, name: "Theirs", url: "https://other.example" });

    const res = await agent.get(`/api/compliance/${mine}?siteId=${theirSite.body.id}`);
    expect(res.status).toBe(400);
  });
});
