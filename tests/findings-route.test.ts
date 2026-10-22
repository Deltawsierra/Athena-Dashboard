import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";

import { makeApp, recordLegacyScan, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";

/**
 * The lifecycle over HTTP.
 *
 * The route that matters most is the one that refuses: a person may not mark a
 * finding fixed. "Fixed" is a claim about the customer's system, and only a
 * retest the engine answered `closed` may make it. A status a human can set to
 * "fixed" without evidence is the same defect as a compliance control that
 * renders green because nothing tested it.
 */
let hybrid: HybridBackendStandIn | null = null;
describe("owning and closing findings", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;
  let server: Server;
  let scanResults: unknown[] = [];

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
        res.writeHead(url === "/api/scan" ? 200 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          run_id: "run-1", state: "completed", result: { results: scanResults },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_ENGINE_KEY = "ce_op_test";
    hybrid = await hybridBackendStandIn({ engine: { url: process.env.ATHENA_ENGINE_URL!, key: process.env.ATHENA_ENGINE_KEY } });
    process.env.ATHENA_FAILSAFE_URL = hybrid.url;
    vi.resetModules();
    app = await makeApp();
    agent = await signIn(app);
    await signInToBackend(agent);
  });

  afterAll(async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    await hybrid?.close();
    hybrid = null;
    delete process.env.ATHENA_ENGINE_URL;
    delete process.env.ATHENA_ENGINE_KEY;
    await new Promise<void>((r) => server.close(() => r()));
  });

  let scans = 0;
  /**
   * A scan recorded and filed as this dashboard's own (tests/helpers.ts
   * recordLegacyScan): the ledger these routes own and close is the legacy rows'.
   * A scan started through Athena-Backend is recorded there, and never filed here.
   */
  async function aScannedEngagement(results: unknown[]) {
    scanResults = results;
    scans += 1;
    const client = await agent.post("/api/clients")
      .send({ name: "Lifecycle", company: "Lifecycle Ltd", email: "l@example.test" });
    const site = await agent.post("/api/sites")
      .send({ clientId: client.body.id, name: "Main", url: "https://life.example" });
    const { storage } = await import("../server/storage-unified");
    const { test, filed } = await recordLegacyScan(storage, {
      clientId: client.body.id, siteId: site.body.id, target: "https://life.example", runId: `run-${scans}`, results,
    });
    return { clientId: client.body.id as string, test, filed };
  }
  /** The same host scanned again for the same client, as this dashboard's own scan, without naming the site. */
  async function rescanned(clientId: string, results: unknown[]) {
    scans += 1;
    const { storage } = await import("../server/storage-unified");
    return recordLegacyScan(storage, { clientId, siteId: null, target: "https://life.example", runId: `run-${scans}`, results });
  }

  const twoIssuesFourResults = [
    { type: "json_injection", severity: "low", evidence: { endpoint: "https://life.example/api", payload: { a: 1 } } },
    { type: "json_injection", severity: "low", evidence: { endpoint: "https://life.example/api", payload: { b: 2 } } },
    { type: "missing_security_header", severity: "low", evidence: { header: "Content-Security-Policy" } },
    { type: "error", internal: true, details: "noise" },
  ];

  it("files a scan's results as deduplicated findings and says what it did", async () => {
    const { clientId, filed } = await aScannedEngagement(twoIssuesFourResults);
    // Counted, not asserted: four results, one of them internal, two issues.
    expect(filed).toMatchObject({ raw: 4, distinct: 2, created: 2, updated: 0 });

    const listed = await agent.get(`/api/findings?clientId=${clientId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.findings).toHaveLength(2);
    expect(listed.body.counts).toMatchObject({ open: 2, fixed: 0 });
  });

  it("refuses to let a person mark a finding fixed, and says why", async () => {
    const { clientId } = await aScannedEngagement(twoIssuesFourResults);
    const listed = await agent.get(`/api/findings?clientId=${clientId}`);
    const id = listed.body.findings[0].id;

    const refused = await agent.patch(`/api/findings/${id}`).send({ status: "fixed" });
    expect(refused.status).toBe(400);
    // The reason is the point, so it is in the response rather than a bare 400.
    expect(refused.body.error).toContain("run a retest");
    expect(refused.body.error).toContain("mark it accepted");

    // And nothing moved.
    const after = await agent.get(`/api/findings?clientId=${clientId}`);
    expect(after.body.counts.fixed).toBe(0);
  });

  it("takes an owner and an accepted-risk decision, under the name of whoever made it", async () => {
    const { clientId } = await aScannedEngagement(twoIssuesFourResults);
    const listed = await agent.get(`/api/findings?clientId=${clientId}`);
    const id = listed.body.findings[0].id;
    const me = (await agent.get("/api/auth/check")).body.user;

    const updated = await agent.patch(`/api/findings/${id}`).send({
      status: "accepted", ownerId: me.id, note: "behind an internal gateway",
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ status: "accepted", statusNote: "behind an internal gateway" });
    expect(updated.body.statusChangedBy).toBe(me.id);
    // An opinion does not write the evidence columns.
    expect(updated.body.fixedAt).toBeNull();
    expect(updated.body.fixedVerdict).toBeNull();

    const after = await agent.get(`/api/findings?clientId=${clientId}`);
    const mine = after.body.findings.find((one: { id: string }) => one.id === id);
    expect(mine.ownerName).toBe(me.username);
  });

  it("refuses an owner who is not a user, and a finding that is not there", async () => {
    const { clientId } = await aScannedEngagement(twoIssuesFourResults);
    const listed = await agent.get(`/api/findings?clientId=${clientId}`);
    const id = listed.body.findings[0].id;

    expect((await agent.patch(`/api/findings/${id}`).send({ ownerId: "nobody" })).status).toBe(400);
    expect((await agent.patch("/api/findings/missing").send({ status: "acknowledged" })).status).toBe(404);
  });

  it("needs an engagement to list, and a session to do anything", async () => {
    const { clientId } = await aScannedEngagement(twoIssuesFourResults);
    expect((await agent.get("/api/findings")).status).toBe(400);
    expect((await request(app).get(`/api/findings?clientId=${clientId}`)).status).toBe(401);
  });

  it("does not duplicate on a rescan of the same engagement", async () => {
    const { clientId } = await aScannedEngagement(twoIssuesFourResults);
    const before = await agent.get(`/api/findings?clientId=${clientId}`);

    // The same host, scanned again -- and deliberately without naming the
    // site this time. That produces a different engagement string for the
    // same customer, and identity is scoped to the customer precisely so this
    // does not file everything twice.
    await rescanned(clientId, twoIssuesFourResults);
    const after = await agent.get(`/api/findings?clientId=${clientId}`);

    expect(after.body.findings.length).toBe(before.body.findings.length);
    expect(Math.max(...after.body.findings.map((one: { timesSeen: number }) => one.timesSeen)))
      .toBeGreaterThan(1);
  });
});
