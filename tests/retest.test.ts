import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * Retest: the engine goes back to the target and says whether the finding is
 * still there.
 *
 * Two properties decide whether the answer means anything, and both were
 * measured against a running engine before this was written.
 *
 * There are three verdicts, not two. With the target simply switched off the
 * engine returned `inconclusive` with the connection error as its detail --
 * not `closed`. Anything that maps this onto a boolean reports a host that
 * went down as a vulnerability remediated.
 *
 * And the engagement is composed here, from the test's own client and site,
 * never from the twin. The engine requires `engagement_ref` on this route
 * precisely because it used to derive a scope from the twin's recorded target,
 * which is a check whose only possible answer is yes.
 */
describe("retesting a finding", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;
  let server: Server;
  let sent: Array<Record<string, unknown>> = [];
  let decisions: unknown = { tenant: "default", decisions: [] };
  let verdict: Record<string, unknown> = {};
  let scanReply: Record<string, unknown> = {};

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
        if (url.startsWith("/api/decisions")) {
          sent.push({ path: url });
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(decisions));
        }
        if (url === "/api/remediation/retest") {
          sent.push(JSON.parse(raw || "{}"));
          res.writeHead(201, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(verdict));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(scanReply));
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

  /** A client, a site, and a test carrying an engine run id. */
  async function aScannedTest(withSite = true) {
    const client = await agent.post("/api/clients")
      .send({ name: "Retested", company: "Retested Ltd", email: "r@example.test" });
    let siteId: string | undefined;
    if (withSite) {
      const site = await agent.post("/api/sites")
        .send({ clientId: client.body.id, name: "Main", url: "https://retested.example" });
      siteId = site.body.id;
    }
    scanReply = { run_id: "run-1", state: "completed", result: { results: [] } };
    const started = await agent.post("/api/scans")
      .send({ clientId: client.body.id, siteId, target: "https://retested.example" });
    return { clientId: client.body.id as string, siteId, testId: started.body.test.id as string };
  }

  const twin = {
    id: 81,
    tenant: "default",
    run_id: "run-1",
    target: "https://retested.example",
    finding_type: "json_injection",
    inputs: { endpoint: "https://retested.example/api/update", details: "Server error with crafted JSON" },
    decision: { severity: "low", tier: "suspicious", confidence: 0.45 },
    captured_at: "2026-09-08T15:58:20Z",
  };

  it("lists the decisions the engine kept for this test's run", async () => {
    decisions = { tenant: "default", decisions: [twin] };
    sent = [];
    const { testId } = await aScannedTest();

    const res = await agent.get(`/api/tests/${testId}/decisions`);
    expect(res.status).toBe(200);
    // Scoped to this test's run. A list of every decision the engine ever
    // made is not a list of what this scan found.
    expect(sent.some((one) => String(one.path).includes("run_id=run-1"))).toBe(true);
    expect(res.body.decisions).toHaveLength(1);
    expect(res.body.decisions[0]).toMatchObject({
      id: 81, findingType: "json_injection", severity: "low",
      endpoint: "https://retested.example/api/update",
    });
  });

  it("says so when the engine kept more decisions than are listed", async () => {
    // Measured: one scan of one small host captured 81 decisions, so filling
    // the limit is ordinary. A list that stops silently looks complete, and
    // the operator concludes there is nothing else to retest.
    decisions = {
      tenant: "default",
      decisions: Array.from({ length: 101 }, (_unused, index) => ({ ...twin, id: index + 1 })),
    };
    const { testId } = await aScannedTest();

    const res = await agent.get(`/api/tests/${testId}/decisions`);
    expect(res.body.decisions).toHaveLength(100);
    expect(res.body.truncated).toBe(true);

    decisions = { tenant: "default", decisions: [twin] };
    const short = await agent.get(`/api/tests/${testId}/decisions`);
    expect(short.body.truncated).toBe(false);
  });

  it("says a test with no engine run has nothing to retest", async () => {
    // Rather than an empty list, which reads as "the scan found nothing".
    const client = await agent.post("/api/clients")
      .send({ name: "Manual", company: "Manual Ltd", email: "m@example.test" });
    const test = await agent.post("/api/tests").send({
      clientId: client.body.id, testType: "manual", status: "completed",
      findings: {}, vulnerabilitiesFound: 0,
    });

    const res = await agent.get(`/api/tests/${test.body.id}/decisions`);
    expect(res.body.decisions).toEqual([]);
    expect(res.body.detail).toContain("no engine run");
  });

  it("sends the engagement and its scope, composed from the test, not the twin", async () => {
    decisions = { tenant: "default", decisions: [twin] };
    verdict = {
      twin_id: 81, verdict: "still_open", detail: "json_injection is still reported",
      target: "https://retested.example", finding_type: "json_injection",
      inventory_digest: "sha256:aaa", run_id: 2,
      check: { checked_at: "2026-09-08T15:58:34Z" },
    };
    sent = [];
    const { clientId, siteId, testId } = await aScannedTest();

    const res = await agent.post(`/api/tests/${testId}/retest`).send({ twinId: 81 });
    expect(res.status).toBe(200);

    const call = sent.find((one) => one.twin_id === 81);
    expect(call).toBeDefined();
    expect(call!.engagement_ref).toBe(`${clientId}:${siteId}`);
    // The hosts on record for this engagement. Without this the engine falls
    // back to the twin's own target, and the only thing the check can refuse
    // is the thing it was derived from.
    expect(call!.scope).toEqual(["retested.example"]);
  });

  it("passes the verdict through as the engine's word, all three of them", async () => {
    decisions = { tenant: "default", decisions: [twin] };
    const { testId } = await aScannedTest();

    for (const word of ["closed", "still_open", "inconclusive"]) {
      verdict = {
        twin_id: 81, verdict: word, detail: `detail for ${word}`,
        target: "https://retested.example", finding_type: "json_injection",
        inventory_digest: "sha256:aaa", run_id: 3, check: {},
      };
      const res = await agent.post(`/api/tests/${testId}/retest`).send({ twinId: 81 });
      expect(res.body.verdict).toBe(word);
      expect(res.body.detail).toBe(`detail for ${word}`);
    }
  });

  it("treats a missing verdict as inconclusive, never as closed", async () => {
    // An engine that answered without a verdict has not said the finding is
    // gone. Defaulting the other way is how a broken retest reads as a fix.
    decisions = { tenant: "default", decisions: [twin] };
    verdict = { twin_id: 81, detail: "", check: {} };
    const { testId } = await aScannedTest();

    const res = await agent.post(`/api/tests/${testId}/retest`).send({ twinId: 81 });
    expect(res.body.verdict).toBe("inconclusive");
  });

  it("reads the run id whether the engine sends a number or a string", async () => {
    // Measured: the engine sends run_id as a number at the top level and as a
    // string inside `check`. Both name the same run.
    decisions = { tenant: "default", decisions: [twin] };
    verdict = { twin_id: 81, verdict: "closed", detail: "gone", run_id: 7, check: {} };
    const { testId } = await aScannedTest();

    const res = await agent.post(`/api/tests/${testId}/retest`).send({ twinId: 81 });
    expect(res.body.runId).toBe("7");
  });

  it("refuses when no site is on record, and records the retest", async () => {
    decisions = { tenant: "default", decisions: [twin] };
    verdict = { twin_id: 81, verdict: "closed", detail: "gone", check: {} };

    // A client with no site authorises no host, so going back to a target on
    // the strength of the twin alone is the unfalsifiable check again.
    const client = await agent.post("/api/clients")
      .send({ name: "Siteless", company: "Siteless Ltd", email: "s@example.test" });
    // Written as the scan route writes an engine scan's row: POST /api/tests
    // refuses a supplied run id (R5-A).
    const { storage } = await import("../server/storage-unified");
    const test = await storage.createTest({
      clientId: client.body.id, testType: "manual", status: "completed",
      findings: { runId: "run-1" }, vulnerabilitiesFound: 0,
    });
    const refused = await agent.post(`/api/tests/${test.id}/retest`).send({ twinId: 81 });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("no site is recorded");

    const { testId } = await aScannedTest();
    await agent.post(`/api/tests/${testId}/retest`).send({ twinId: 81 });
    const logs = await agent.get("/api/logs");
    const entry = logs.body.find(
      (one: { action: string }) => one.action === "retested",
    );
    expect(entry).toBeDefined();
    expect(entry.details).toMatchObject({ twinId: 81, verdict: "closed" });
  });
});
