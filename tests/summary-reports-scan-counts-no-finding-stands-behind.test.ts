import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";
import type { IStorage } from "../server/storage";
import { summarizeFindings } from "../server/findings-summary";

/**
 * PR #52 round 2, R2-A (server half).
 *
 * The summary counted lifecycle findings only, and only the engine's scans
 * file those. A completed pentest a person records on the Tests screen --
 * "3 critical, 5 high" -- filed none, so the summary answered open 0 for that
 * client, and the Overview printed "Nothing flagged: no client has an open
 * critical or high finding" beside "15 findings reported", while Deployments
 * ticked "Review Evidence: No open findings on record" beside a Critical row.
 *
 * The summary now carries, per client, the latest completed test's reported
 * critical/high counts whenever that test filed none of its results as
 * findings. They are not open findings (nothing tracks whether they were
 * fixed), so they stay out of the open totals; they are there so no screen can
 * clear the client while they stand.
 *
 * Adapted from the adversarial reproducer r2-a-server.test.ts, which pinned
 * the old payload (untracked counts invisible).
 */

describe("a completed scan's counts that no finding stands behind are reported", () => {
  let app: Express;
  let storage: IStorage;
  beforeAll(async () => {
    vi.resetModules();
    app = await makeApp();
    storage = (await import("../server/storage-unified")).storage;
  });

  async function aClient(agent: Awaited<ReturnType<typeof signIn>>, name: string) {
    return (await agent.post("/api/clients").send({ name, company: name, email: `${name}@example.test` })).body as { id: string };
  }
  const mineIn = (summary: { byClient: Array<{ clientId: string }> }, id: string) =>
    summary.byClient.find((one) => one.clientId === id);

  it("a completed pentest recorded on the Tests screen reports its critical/high counts", async () => {
    const agent = await signIn(app);
    const client = await aClient(agent, "Acme");
    const created = await agent.post("/api/tests").send({
      clientId: client.id, testType: "penetration-test", status: "completed", severity: "critical",
      vulnerabilitiesFound: 15, criticalCount: 3, highCount: 5, mediumCount: 4, lowCount: 3,
      completedAt: "2026-09-01T10:00:00.000Z",
    });
    expect(created.status).toBe(201);

    const summary = (await agent.get("/api/findings/summary")).body;
    expect(mineIn(summary, client.id)).toEqual({
      clientId: client.id, open: 0, critical: 0, high: 0, latestSeriousSeenAt: null,
      untrackedScan: { testId: created.body.id, completedAt: "2026-09-01T10:00:00.000Z", critical: 3, high: 5, scans: 1 },
    });
    // Reported, not open: nothing tracks whether those were fixed.
    expect(summary.open.total).toBe(0);
  });

  it("reads only the latest completed test: a newer clean one clears it, a newer unfinished one does not", async () => {
    const agent = await signIn(app);
    const client = await aClient(agent, "Rescanned");
    const base = { clientId: client.id, testType: "penetration-test" };
    await agent.post("/api/tests").send({
      ...base, status: "completed", criticalCount: 1, highCount: 0, vulnerabilitiesFound: 1,
      completedAt: "2026-08-01T00:00:00.000Z",
    }).expect(201);
    // Still running: not a result, whatever counts it carries.
    await agent.post("/api/tests").send({
      ...base, status: "running", criticalCount: 9, highCount: 9, vulnerabilitiesFound: 18,
    }).expect(201);
    let summary = (await agent.get("/api/findings/summary")).body;
    expect(mineIn(summary, client.id)).toMatchObject({ untrackedScan: { critical: 1, high: 0 } });

    await agent.post("/api/tests").send({
      ...base, status: "completed", criticalCount: 0, highCount: 0, mediumCount: 2, vulnerabilitiesFound: 2,
      completedAt: "2026-09-01T00:00:00.000Z",
    }).expect(201);
    summary = (await agent.get("/api/findings/summary")).body;
    expect(mineIn(summary, client.id)).toMatchObject({ untrackedScan: null });
  });

  it("a test that filed its results as findings is tracked through them, not reported again", async () => {
    const agent = await signIn(app);
    const client = await aClient(agent, "Filed");
    const test = await storage.createTest({
      clientId: client.id, testType: "vulnerability-scan", status: "completed", completedAt: new Date(),
      criticalCount: 1, highCount: 1, vulnerabilitiesFound: 2, findings: { runId: "run-filed" },
    });
    const critical = await storage.createFinding({
      fingerprint: "filed-1", clientId: client.id, engagementRef: client.id, type: "sqli", severity: "critical",
    });
    const high = await storage.createFinding({
      fingerprint: "filed-2", clientId: client.id, engagementRef: client.id, type: "xss", severity: "high",
    });
    await storage.updateFinding(critical.id, { status: "accepted" });
    await storage.updateFinding(high.id, { status: "fixed" });
    await storage.recordSighting(critical.id, "run-filed", test.id, true);
    await storage.recordSighting(high.id, "run-filed", test.id, true);

    const summary = (await agent.get("/api/findings/summary")).body;
    // Its critical was accepted and its high verified fixed, so nothing is
    // open -- and the scan's own counts are not a second, untracked copy.
    expect(mineIn(summary, client.id)).toMatchObject({ open: 0, critical: 0, untrackedScan: null });
  });

  it("a test that filed fewer criticals or highs than it reported has the shortfall reported", async () => {
    // Round 3, F2: "filed anything" used to count as "filed everything".
    const agent = await signIn(app);
    const client = await aClient(agent, "Short");
    const test = await storage.createTest({
      clientId: client.id, testType: "vulnerability-scan", status: "completed", completedAt: new Date(),
      criticalCount: 2, highCount: 1, mediumCount: 1, vulnerabilitiesFound: 4, findings: { runId: "run-short" },
    });
    // It filed one critical and a medium; the second critical and the high
    // stand behind nothing.
    for (const [fp, severity] of [["short-1", "critical"], ["short-2", "medium"]]) {
      const one = await storage.createFinding({ fingerprint: fp, clientId: client.id, engagementRef: client.id, type: fp, severity });
      await storage.recordSighting(one.id, "run-short", test.id, true);
    }
    const summary = (await agent.get("/api/findings/summary")).body;
    expect(mineIn(summary, client.id)).toMatchObject({
      open: 2, critical: 1, untrackedScan: { testId: test.id, critical: 1, high: 1, scans: 1 },
    });
  });

  it("a test that only recorded findings as NOT seen filed nothing, so its counts are still reported", async () => {
    const agent = await signIn(app);
    const client = await aClient(agent, "Unseen");
    const test = await storage.createTest({
      clientId: client.id, testType: "penetration-test", status: "completed", completedAt: new Date(),
      criticalCount: 0, highCount: 2, vulnerabilitiesFound: 2,
    });
    // A HIGH finding it went looking for and did not see: that stands behind
    // none of the highs it reported.
    const finding = await storage.createFinding({
      fingerprint: "unseen-1", clientId: client.id, engagementRef: client.id, type: "xss", severity: "high",
    });
    await storage.recordSighting(finding.id, "run-unseen", test.id, false);

    const summary = (await agent.get("/api/findings/summary")).body;
    expect(mineIn(summary, client.id)).toMatchObject({ untrackedScan: { testId: test.id, critical: 0, high: 2 } });
  });

  it("gives no totals, and blames storage, when the tests cannot be read", async () => {
    const agent = await signIn(app);
    const spy = vi.spyOn(storage, "getAllTests").mockRejectedValueOnce(new Error("tests table unreadable"));
    const res = await agent.get("/api/findings/summary");
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: "Could not read every engagement's findings, so no totals are given." });
  });

  it("gives no totals when whether a test filed anything cannot be read", async () => {
    const agent = await signIn(app);
    const spy = vi.spyOn(storage, "filedSeriousFindings").mockRejectedValueOnce(new Error("sightings unreadable"));
    const res = await agent.get("/api/findings/summary");
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/^Could not read every engagement's findings/);
    expect(res.body.open).toBeUndefined();
  });
});

describe("the untracked-scan rule, pure", () => {
  const clients = [{ id: "c1", name: "One" }, { id: "c2", name: "Two" }];
  const test = (over: Record<string, unknown>) => ({
    id: "t", clientId: "c1", status: "completed", startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: new Date("2026-01-02T00:00:00Z"), criticalCount: 0, highCount: 0, ...over,
  });

  it("takes the latest completed test by completion time, falling back to its start", () => {
    const summary = summarizeFindings({
      clients, sites: [], findings: [],
      tests: [
        test({ id: "old", criticalCount: 4, completedAt: new Date("2026-01-05T00:00:00Z") }),
        // No completion time recorded: dated by its start, which is later.
        test({ id: "new", highCount: 1, completedAt: null, startedAt: new Date("2026-02-01T00:00:00Z") }),
        test({ id: "other", clientId: "c2", criticalCount: 1, status: "failed" }),
      ] as never,
    });
    expect(summary.byClient.map((one) => one.untrackedScan)).toEqual([
      { testId: "new", completedAt: null, critical: 0, high: 1, scans: 1 },
      null,
    ]);
  });

  it("orders by completion, not start: a long scan that finished last is the latest", () => {
    const summary = summarizeFindings({
      clients, sites: [], findings: [],
      tests: [
        test({ id: "long", criticalCount: 2, startedAt: new Date("2026-01-01T00:00:00Z"), completedAt: new Date("2026-03-01T00:00:00Z") }),
        test({ id: "short", highCount: 1, startedAt: new Date("2026-02-01T00:00:00Z"), completedAt: new Date("2026-02-02T00:00:00Z") }),
      ] as never,
    });
    expect(summary.byClient[0].untrackedScan).toMatchObject({ testId: "long", critical: 2, high: 0 });
  });

  it("reports only critical or high: a latest scan of mediums is not flagged here", () => {
    const summary = summarizeFindings({
      clients, sites: [], findings: [],
      tests: [test({ id: "m", criticalCount: 0, highCount: 0, mediumCount: 5 })] as never,
    });
    expect(summary.byClient[0].untrackedScan).toBeNull();
  });

  it("names nothing untracked for a test that filed a finding for every critical and high it reported", () => {
    const summary = summarizeFindings({
      clients, sites: [], findings: [],
      tests: [test({ id: "f", criticalCount: 2, highCount: 1 })] as never,
      filed: new Map([["f", { critical: 2, high: 1 }]]),
    });
    expect(summary.byClient[0].untrackedScan).toBeNull();
  });

  it("compares per severity: a filed high does not stand behind a reported critical", () => {
    const summary = summarizeFindings({
      clients, sites: [], findings: [],
      tests: [test({ id: "f", criticalCount: 1, highCount: 0 })] as never,
      filed: new Map([["f", { critical: 0, high: 3 }]]),
    });
    expect(summary.byClient[0].untrackedScan).toMatchObject({ testId: "f", critical: 1, high: 0 });
  });
});

describe("what a test filed at critical and high, on the SQLite backend", () => {
  let sqlite: IStorage;
  beforeAll(async () => {
    process.env.ATHENA_DB_PATH = ":memory:";
    sqlite = (await import("../server/storage-sqlite")).storage;
  });

  it("counts the distinct critical and high findings a test sighted as seen, and nothing it did not", async () => {
    const client = await sqlite.createClient({ name: "Q", company: "Q", email: "q@example.test" });
    const make = (fp: string, severity: string | null) => sqlite.createFinding({
      fingerprint: fp, clientId: client.id, engagementRef: client.id, type: "xss", severity,
    });
    const high = await make("q-1", "high");
    const critical = await make("q-2", "Critical");
    const medium = await make("q-3", "medium");
    const unrated = await make("q-4", null);
    await sqlite.recordSighting(high.id, "run-seen", "test-seen", true);
    // The same finding sighted again under another run of the same test is one finding.
    await sqlite.recordSighting(high.id, "run-seen-2", "test-seen", true);
    await sqlite.recordSighting(critical.id, "run-seen", "test-seen", true);
    await sqlite.recordSighting(medium.id, "run-seen", "test-seen", true);
    await sqlite.recordSighting(unrated.id, "run-seen", "test-seen", true);
    await sqlite.recordSighting(high.id, "run-unseen", "test-unseen", false);
    expect(await sqlite.filedSeriousFindings("test-seen")).toEqual({ critical: 1, high: 1 });
    expect(await sqlite.filedSeriousFindings("test-unseen")).toEqual({ critical: 0, high: 0 });
    expect(await sqlite.filedSeriousFindings("test-never")).toEqual({ critical: 0, high: 0 });
  });
});

/**
 * End to end with a fake engine: a scan the engine finished inline is written
 * with the counts it returned (it used to be written with zeros, so a scan
 * that found a critical read "0 reported"), and because it filed those
 * results as findings, the summary tracks them there and reports nothing
 * untracked.
 */
describe("an engine scan that finished inline", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;
  let server: Server;

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url === "/health") return res.end(JSON.stringify({ status: "ok" }));
        res.end(JSON.stringify({
          run_id: "run-inline", state: "completed",
          result: { results: [
            { type: "sql_injection", severity: "critical", evidence: { endpoint: "https://inline.example/login" } },
            { type: "xss", severity: "high", evidence: { endpoint: "https://inline.example/search" } },
            { type: "error", internal: true, details: "noise" },
          ] },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.ATHENA_ENGINE_KEY = "ce_op_test";
    vi.resetModules();
    app = await makeApp();
    agent = await signIn(app);
  });

  afterAll(async () => {
    delete process.env.ATHENA_ENGINE_URL;
    delete process.env.ATHENA_ENGINE_KEY;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("records what came back on the test, and the summary tracks it as findings", async () => {
    const client = (await agent.post("/api/clients").send({ name: "Inline", company: "Inline", email: "i@example.test" })).body;
    const site = (await agent.post("/api/sites").send({ clientId: client.id, name: "Main", url: "https://inline.example" })).body;
    const started = await agent.post("/api/scans").send({ clientId: client.id, siteId: site.id, target: "https://inline.example" });
    expect(started.status).toBe(201);
    expect(started.body.test).toMatchObject({
      status: "completed", vulnerabilitiesFound: 2, criticalCount: 1, highCount: 1, severity: "critical",
    });
    expect(started.body.test.completedAt).toBeTruthy();

    const summary = (await agent.get("/api/findings/summary")).body;
    const mine = summary.byClient.find((one: { clientId: string }) => one.clientId === client.id);
    expect(mine).toMatchObject({ open: 2, critical: 1, high: 1, untrackedScan: null });
  });
});
