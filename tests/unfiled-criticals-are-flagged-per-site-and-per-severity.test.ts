import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import { makeApp, signIn } from "./helpers";
import { reportedSerious, summarizeFindings } from "../server/findings-summary";
import { latestCompletedBySite } from "@shared/latest-scans";

/**
 * PR #52 round 3, F2 and F3. A client whose scans reported a critical or high
 * result must never read as clear unless a finding stands behind every one of
 * them. Three paths used to clear such a client:
 *
 *   A  "the test filed any sighting" counted as "its criticals are tracked".
 *      One issue seen at two severities (a weak payload's medium, then a
 *      confirmed critical, at one endpoint) was filed once at the FIRST
 *      severity, so the scan's record said 1 critical and the ledger held a
 *      medium. Now ingest files the worst, and the summary compares what each
 *      test reported with what it filed, per severity.
 *   B  "the latest completed test" was per client: a later scan of ANOTHER
 *      site replaced the one that reported the criticals. Now it is per site.
 *   B2 ...and ordered by a completion time the Tests screen never sent, so a
 *      pentest finished today ranked by when it was created. Now the server
 *      stamps completedAt when a test becomes completed.
 *   C  an acknowledged (in review) finding was not open, so the latest scan's
 *      filed critical, once acknowledged, left no flag at all. Now it is open.
 *
 * Adapted from the adversarial reproducer r3-untracked-server.test.ts.
 */
let results: unknown[] = [];
let runN = 0;
describe("a latest completed scan's unfiled criticals are flagged, per site and per severity", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;
  let server: import("http").Server;

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url === "/health") return res.end(JSON.stringify({ status: "ok" }));
        runN += 1;
        res.end(JSON.stringify({ run_id: `run-${runN}`, state: "completed", result: { results } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(server.address() as import("net").AddressInfo).port}`;
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

  async function clientWithSite(name: string, url = "https://app.example") {
    const client = (await agent.post("/api/clients").send({ name, company: name, email: `${name}@example.test` })).body;
    const site = (await agent.post("/api/sites").send({ clientId: client.id, name: "App", url })).body;
    return { client, site };
  }
  const mine = async (id: string) =>
    (await agent.get("/api/findings/summary")).body.byClient.find((one: { clientId: string }) => one.clientId === id);
  const CLEARED = { critical: 0, high: 0, untrackedScan: null };
  const cleared = (own: { critical: number; high: number; untrackedScan: unknown }) =>
    ({ critical: own.critical, high: own.high, untrackedScan: own.untrackedScan });

  it("A: one issue reported at two severities is filed at the worst, and the client carries it as an open critical", async () => {
    const { client, site } = await clientWithSite("Folded");
    results = [
      { type: "sql_injection", severity: "medium", message: "SQL error with crafted payload", evidence: { endpoint: "https://app.example/login" } },
      { type: "sql_injection", severity: "critical", message: "Time-based SQL injection confirmed", evidence: { endpoint: "https://app.example/login" } },
    ];
    const started = await agent.post("/api/scans").send({ clientId: client.id, siteId: site.id, target: "https://app.example" });
    expect(started.status).toBe(201);
    expect(started.body.test.status).toBe("completed");
    expect(started.body.test.criticalCount).toBe(1);
    const own = await mine(client.id);
    expect(cleared(own)).not.toEqual(CLEARED);
    // Tracked, and so not reported again as untracked.
    expect(own).toMatchObject({ open: 1, critical: 1, high: 0, untrackedScan: null });
    const findings = (await agent.get(`/api/findings?clientId=${client.id}`)).body.findings;
    expect(findings.map((one: { severity: string }) => one.severity)).toEqual(["critical"]);
  });

  it("A': several payloads at one place are one finding, not a shortfall", async () => {
    // The test's counts are per result (3 critical); the ledger files one. The
    // per-severity comparison must not call the other two untracked.
    const { client, site } = await clientWithSite("Payloads", "https://p.example");
    results = [1, 2, 3].map((n) => ({
      type: "sql_injection", severity: "critical", evidence: { endpoint: "https://p.example/login", payload: n },
    }));
    const started = await agent.post("/api/scans").send({ clientId: client.id, siteId: site.id, target: "https://p.example" });
    expect(started.body.test.criticalCount).toBe(3);
    expect(await mine(client.id)).toMatchObject({ critical: 1, untrackedScan: null });

    // An engine scan's counts are counted from its results, and since round 4
    // an edit may not change them (the Tests screen's edit wrote over the
    // engine run; tests/an-edit-on-the-tests-screen-keeps-the-engine-run.test.ts).
    // This used to edit the count up through PATCH /api/tests/:id and expect
    // 200; the edit is refused now, and the summary is as it was.
    const refused = await agent.patch(`/api/tests/${started.body.test.id}`).send({ criticalCount: 5 });
    expect(refused.status).toBe(409);
    expect(await mine(client.id)).toMatchObject({ critical: 1, untrackedScan: null });

    // A record that says more than its ledger holds -- written before its
    // counts were the engine's alone -- is still untracked by the difference.
    const { storage } = await import("../server/storage-unified");
    await storage.updateTest(started.body.test.id, { criticalCount: 5 });
    expect(await mine(client.id)).toMatchObject({ critical: 1, untrackedScan: { critical: 2, high: 0 } });
  });

  it("B: a later scan of ANOTHER site does not clear an earlier site's recorded criticals", async () => {
    const { client, site } = await clientWithSite("TwoSites", "https://a.example");
    const siteB = (await agent.post("/api/sites").send({ clientId: client.id, name: "B", url: "https://b.example" })).body;
    const pentest = (await agent.post("/api/tests").send({
      clientId: client.id, siteId: site.id, testType: "penetration-test", status: "completed", severity: "critical",
      vulnerabilitiesFound: 5, criticalCount: 3, highCount: 2, completedAt: new Date(Date.now() - 60_000).toISOString(),
    }).expect(201)).body;
    expect((await mine(client.id)).untrackedScan).toMatchObject({ testId: pentest.id, critical: 3, high: 2, scans: 1 });
    results = [{ type: "missing_security_header", severity: "low", evidence: { header: "Referrer-Policy" } }];
    await agent.post("/api/scans").send({ clientId: client.id, siteId: siteB.id, target: "https://b.example" }).expect(201);
    const own = await mine(client.id);
    expect(cleared(own)).not.toEqual(CLEARED);
    expect(own.untrackedScan).toMatchObject({ testId: pentest.id, critical: 3, high: 2, scans: 1 });

    // A later scan of the SAME site that files a clean result does replace it.
    results = [];
    await agent.post("/api/scans").send({ clientId: client.id, siteId: site.id, target: "https://a.example" }).expect(201);
    expect((await mine(client.id)).untrackedScan).toBeNull();
  });

  it("adds up every site whose latest completed scan has unfiled criticals, and names the newest", async () => {
    const { client, site } = await clientWithSite("Both", "https://x.example");
    const other = (await agent.post("/api/sites").send({ clientId: client.id, name: "Y", url: "https://y.example" })).body;
    const record = (siteId: string, criticalCount: number, highCount: number, completedAt: string) =>
      agent.post("/api/tests").send({
        clientId: client.id, siteId, testType: "penetration-test", status: "completed",
        criticalCount, highCount, vulnerabilitiesFound: criticalCount + highCount, completedAt,
      }).expect(201);
    await record(site.id, 1, 0, "2026-09-01T00:00:00.000Z");
    const newest = (await record(other.id, 0, 4, "2026-09-02T00:00:00.000Z")).body;
    expect((await mine(client.id)).untrackedScan).toEqual({
      testId: newest.id, completedAt: "2026-09-02T00:00:00.000Z", critical: 1, high: 4, scans: 2,
    });
  });

  it("B2: via the Tests screen's own requests, a pentest completed today ranks after an older engine scan", async () => {
    const { client, site } = await clientWithSite("SameSite", "https://d.example");
    const pentest = (await agent.post("/api/tests").send({
      clientId: client.id, siteId: site.id, testType: "penetration-test", status: "pending", severity: null,
      summary: null, findings: null, vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      completedAt: null,
    }).expect(201)).body;
    expect(pentest.completedAt).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    results = [{ type: "missing_security_header", severity: "low", evidence: { header: "Referrer-Policy" } }];
    await agent.post("/api/scans").send({ clientId: client.id, siteId: site.id, target: "https://d.example" }).expect(201);
    await new Promise((r) => setTimeout(r, 5));
    // Tests.tsx handleEditTest's body: no completedAt.
    const before = Date.now();
    const edited = await agent.patch(`/api/tests/${pentest.id}`).send({
      summary: null, testType: "penetration-test", status: "completed", severity: "critical", findings: null,
      vulnerabilitiesFound: 5, criticalCount: 3, highCount: 2, mediumCount: 0, lowCount: 0,
    }).expect(200);
    // Stamped by the server, now.
    expect(new Date(edited.body.completedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect((await mine(client.id)).untrackedScan).toMatchObject({ testId: pentest.id, critical: 3, high: 2 });
  });

  it("stamps completedAt on create when completed, keeps a supplied one, and never restamps a completed test", async () => {
    const { client } = await clientWithSite("Stamp", "https://s.example");
    const base = { clientId: client.id, testType: "penetration-test" };
    const before = Date.now();
    const stamped = (await agent.post("/api/tests").send({ ...base, status: "completed", completedAt: null }).expect(201)).body;
    expect(new Date(stamped.completedAt).getTime()).toBeGreaterThanOrEqual(before);
    const supplied = (await agent.post("/api/tests").send({
      ...base, status: "completed", completedAt: "2026-01-02T03:04:05.000Z",
    }).expect(201)).body;
    expect(supplied.completedAt).toBe("2026-01-02T03:04:05.000Z");
    const pending = (await agent.post("/api/tests").send({ ...base, status: "pending" }).expect(201)).body;
    expect(pending.completedAt).toBeNull();
    // An edit to a completed test is not a new completion.
    const edited = (await agent.patch(`/api/tests/${supplied.id}`).send({ status: "completed", summary: "typo" }).expect(200)).body;
    expect(edited.completedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("C: the latest scan's filed critical, once acknowledged (in review), is still an open critical", async () => {
    const { client, site } = await clientWithSite("Acked", "https://c.example");
    results = [{ type: "rce", severity: "critical", message: "RCE", evidence: { endpoint: "https://c.example/run" } }];
    const started = await agent.post("/api/scans").send({ clientId: client.id, siteId: site.id, target: "https://c.example" });
    expect(started.body.test.criticalCount).toBe(1);
    const findings = (await agent.get(`/api/findings?clientId=${client.id}`)).body.findings;
    await agent.patch(`/api/findings/${findings[0].id}`).send({ status: "acknowledged" }).expect(200);
    const own = await mine(client.id);
    expect(cleared(own)).not.toEqual(CLEARED);
    expect(own).toMatchObject({ open: 1, critical: 1, untrackedScan: null });

    // Accepted is a named decision to carry it: not open, and not untracked
    // either -- a finding stands behind it.
    await agent.patch(`/api/findings/${findings[0].id}`).send({ status: "accepted" }).expect(200);
    expect(await mine(client.id)).toMatchObject({ open: 0, critical: 0, untrackedScan: null });
  });
});

describe("what a completed test reported, in the ledger's unit", () => {
  const test = (over: Record<string, unknown>) => ({
    id: "t", clientId: "c1", siteId: "s1", status: "completed", startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: new Date("2026-01-02T00:00:00Z"), vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0,
    mediumCount: 0, lowCount: 0, findings: null, ...over,
  });

  it("is what a person recorded, when there are no engine results", () => {
    expect(reportedSerious(test({ criticalCount: 3, highCount: 2 }) as never)).toEqual({ critical: 3, high: 2 });
  });

  it("the latest per site is by completion time; a test with no readable time never displaces one that has one", () => {
    const scoped = (id: string, over: Record<string, unknown>) => ({
      id, clientId: "c1", siteId: "s1", status: "completed", startedAt: "2026-01-01T00:00:00Z", completedAt: null, ...over,
    });
    const undated = scoped("undated", { startedAt: "not a date" });
    const dated = scoped("dated", { completedAt: "2026-02-01T00:00:00Z" });
    const later = scoped("later", { startedAt: "2026-01-05T00:00:00Z", completedAt: "2026-03-01T00:00:00Z" });
    const other = scoped("other", { siteId: "s2", completedAt: "2025-01-01T00:00:00Z" });
    const pending = scoped("pending", { status: "pending", completedAt: "2027-01-01T00:00:00Z" });
    const latest = latestCompletedBySite([undated, dated, other, pending]);
    expect(Array.from(latest.values()).map((one) => one.id).sort()).toEqual(["dated", "other"]);
    expect(latestCompletedBySite([dated, undated]).get("c1\u0000s1")?.id).toBe("dated");
    expect(latestCompletedBySite([undated, later, dated]).get("c1\u0000s1")?.id).toBe("later");
  });

  it("takes off the repeats in its own results, at critical and at high: one place is one finding", () => {
    const results = [
      { type: "sqli", severity: "critical", evidence: { endpoint: "https://app.example/a", payload: 1 } },
      { type: "sqli", severity: "critical", evidence: { endpoint: "https://app.example/a", payload: 2 } },
      { type: "xss", severity: "high", evidence: { endpoint: "https://app.example/b", payload: 1 } },
      { type: "xss", severity: "high", evidence: { endpoint: "https://app.example/b", payload: 2 } },
      { type: "xss", severity: "high", evidence: { endpoint: "https://app.example/c" } },
    ];
    expect(reportedSerious(test({
      criticalCount: 2, highCount: 3, vulnerabilitiesFound: 5,
      findings: { runId: "r", target: "https://app.example", results },
    }) as never)).toEqual({ critical: 1, high: 2 });
  });

  it("is what the results say for an engine test whose counts were never recorded", () => {
    // Rows the engine finished inline before the inline-count fix: all zero
    // beside real results. Their criticals may have been filed as something
    // else (the first-severity fold), so they are compared, not assumed.
    const unrecorded = test({
      findings: { runId: "r", target: "https://app.example", results: [
        { type: "sqli", severity: "medium", evidence: { endpoint: "https://app.example/a" } },
        { type: "sqli", severity: "critical", evidence: { endpoint: "https://app.example/a" } },
        { type: "xss", severity: "high", evidence: { endpoint: "https://app.example/b" } },
      ] },
    });
    expect(reportedSerious(unrecorded as never)).toEqual({ critical: 1, high: 1 });
    const summary = summarizeFindings({
      clients: [{ id: "c1", name: "One" }], sites: [], findings: [], tests: [unrecorded] as never,
      // It filed the sqli at its first severity, medium, and the xss at high.
      filed: new Map([["t", { critical: 0, high: 1 }]]),
    });
    expect(summary.byClient[0].untrackedScan).toMatchObject({ critical: 1, high: 0 });
  });
});
