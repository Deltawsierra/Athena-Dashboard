import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import type { Express } from "express";
import request from "supertest";

import { makeApp, signIn } from "./helpers";
import { summarizeFindings } from "../server/findings-summary";

/**
 * GET /api/findings/summary: the estate's findings counted once on the server.
 *
 * It replaces one /api/findings request per client (two hundred clients meant
 * two hundred and six requests, each also loading every finding's history)
 * with one. What must survive the move is the rule that made the per-client
 * version honest: every client's findings, or no totals at all.
 */

const at = (iso: string) => new Date(iso);
let n = 0;
function finding(over: Partial<{
  clientId: string; siteId: string | null; severity: string | null; status: string;
  firstSeenAt: Date; lastSeenAt: Date; message: string | null; type: string;
}>) {
  n += 1;
  return {
    id: `f${n}`, clientId: "c1", siteId: null, type: "xss", severity: "medium", message: `finding ${n}`,
    status: "open", firstSeenAt: at("2026-03-10T12:00:00Z"), lastSeenAt: at("2026-03-10T12:00:00Z"),
    ...over,
  };
}

describe("summarizeFindings", () => {
  const clients = [{ id: "c1", name: "Northwind" }, { id: "c2", name: "Harbor" }, { id: "c3", name: "Quiet" }];
  const sites = [
    { id: "s1", environment: "production" },
    { id: "s2", environment: "staging" },
  ];

  it("counts only open findings as open: not acknowledged, accepted or fixed", () => {
    const summary = summarizeFindings({
      clients, sites,
      findings: [
        finding({ severity: "high" }),
        finding({ severity: "critical", status: "acknowledged" }),
        finding({ severity: "critical", status: "accepted" }),
        finding({ severity: "critical", status: "fixed" }),
        finding({ severity: "low", clientId: "c2" }),
        finding({ severity: "banana", clientId: "c2" }),
      ],
    });
    expect(summary.clients).toBe(3);
    expect(summary.open).toEqual({ total: 3, critical: 0, high: 1, medium: 0, low: 1, info: 1 });
  });

  it("splits open findings by the environment of their site, and nothing else", () => {
    const summary = summarizeFindings({
      clients, sites,
      findings: [
        finding({ siteId: "s1" }),
        finding({ siteId: "s2" }),
        finding({ siteId: "s2" }),
        finding({ siteId: null }),
        finding({ siteId: "gone" }),
        // Not open, so not placed anywhere.
        finding({ siteId: "s1", status: "fixed" }),
        finding({ siteId: "s1", status: "accepted" }),
      ],
    });
    expect(summary.byEnvironment).toEqual([
      { environment: "staging", open: 2 },
      { environment: null, open: 2 },
      { environment: "production", open: 1 },
    ]);
  });

  it("counts every finding into its own severity's series, by UTC month first seen", () => {
    const summary = summarizeFindings({
      clients, sites,
      findings: [
        finding({ severity: "critical", firstSeenAt: at("2026-01-02T00:00:00Z") }),
        finding({ severity: "high", firstSeenAt: at("2026-01-31T23:00:00Z") }),
        // Fixed still counts: the trend is when findings arrived, not what is open.
        finding({ severity: "high", status: "fixed", firstSeenAt: at("2026-01-15T00:00:00Z") }),
        finding({ severity: "medium", firstSeenAt: at("2026-03-01T00:00:00Z") }),
        finding({ severity: "low", firstSeenAt: at("2026-03-20T00:00:00Z") }),
        finding({ severity: "info", firstSeenAt: at("2026-03-20T00:00:00Z") }),
      ],
    });
    expect(summary.byMonth).toEqual([
      { month: "2026-01", critical: 1, high: 2, medium: 0, low: 0 },
      // A month with none is a zero, not a gap.
      { month: "2026-02", critical: 0, high: 0, medium: 0, low: 0 },
      { month: "2026-03", critical: 0, high: 0, medium: 1, low: 1 },
    ]);
  });

  it("keeps the latest twelve months of the trend", () => {
    const summary = summarizeFindings({
      clients, sites,
      findings: [
        finding({ severity: "high", firstSeenAt: at("2024-01-15T00:00:00Z") }),
        finding({ severity: "critical", firstSeenAt: at("2026-06-15T00:00:00Z") }),
      ],
    });
    expect(summary.byMonth).toHaveLength(12);
    expect(summary.byMonth[0].month).toBe("2025-07");
    expect(summary.byMonth[11]).toEqual({ month: "2026-06", critical: 1, high: 0, medium: 0, low: 0 });
    expect(summary.byMonth.reduce((sum, row) => sum + row.high, 0)).toBe(0);
  });

  it("lists the worst open findings, worst first then most recently seen, with their client", () => {
    const summary = summarizeFindings({
      clients, sites,
      findings: [
        finding({ severity: "low", message: "low one" }),
        finding({ severity: "high", message: "older high", lastSeenAt: at("2026-03-01T00:00:00Z") }),
        finding({ severity: "high", message: "newer high", lastSeenAt: at("2026-03-05T00:00:00Z"), clientId: "c2" }),
        finding({ severity: "critical", message: "the critical", status: "fixed" }),
        finding({ severity: "medium", message: null, type: "missing_header" }),
      ],
    });
    expect(summary.topOpen.map((one) => [one.message, one.severity, one.clientName])).toEqual([
      ["newer high", "high", "Harbor"],
      ["older high", "high", "Northwind"],
      [null, "medium", "Northwind"],
      ["low one", "low", "Northwind"],
    ]);
    expect(summary.topOpen[0].lastSeenAt).toBe("2026-03-05T00:00:00.000Z");
  });

  it("gives every client its open, critical and high counts, and when a serious one was last seen", () => {
    const summary = summarizeFindings({
      clients, sites,
      findings: [
        finding({ severity: "critical", lastSeenAt: at("2026-03-02T00:00:00Z") }),
        finding({ severity: "high", lastSeenAt: at("2026-03-04T00:00:00Z") }),
        finding({ severity: "low", lastSeenAt: at("2026-03-09T00:00:00Z") }),
        finding({ severity: "critical", status: "accepted" }),
        finding({ severity: "medium", clientId: "c2" }),
      ],
    });
    expect(summary.byClient).toEqual([
      // No test on record, so no scan's counts stand outside the findings.
      { clientId: "c1", open: 3, critical: 1, high: 1, latestSeriousSeenAt: "2026-03-04T00:00:00.000Z", untrackedScan: null },
      { clientId: "c2", open: 1, critical: 0, high: 0, latestSeriousSeenAt: null, untrackedScan: null },
      { clientId: "c3", open: 0, critical: 0, high: 0, latestSeriousSeenAt: null, untrackedScan: null },
    ]);
  });

  it("summarizes an empty estate as empty", () => {
    expect(summarizeFindings({ clients: [], sites: [], findings: [] })).toEqual({
      clients: 0,
      open: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      byEnvironment: [], byMonth: [], topOpen: [], byClient: [],
    });
  });
});

describe("GET /api/findings/summary", () => {
  let app: Express;
  let storage: typeof import("../server/storage-unified")["storage"];

  beforeAll(async () => {
    vi.resetModules();
    app = await makeApp();
    storage = (await import("../server/storage-unified")).storage;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses anyone not signed in, like the per-client findings route", async () => {
    expect((await request(app).get("/api/findings/summary")).status).toBe(401);
    expect((await request(app).get("/api/findings?clientId=x")).status).toBe(401);
  });

  it("counts the findings on record across every client", async () => {
    const agent = await signIn(app);
    const a = await storage.createClient({ name: "Alpha", company: "A", email: "a@example.test" });
    const b = await storage.createClient({ name: "Beta", company: "B", email: "b@example.test" });
    const prod = await storage.createSite({ clientId: a.id, url: "https://a.example", name: "A", environment: "production", status: "active" });
    const base = { engagementRef: "e", type: "xss" };
    await storage.createFinding({ ...base, fingerprint: "1", clientId: a.id, siteId: prod.id, severity: "critical", message: "alpha critical" });
    await storage.createFinding({ ...base, fingerprint: "2", clientId: a.id, siteId: null, severity: "high" });
    const accepted = await storage.createFinding({ ...base, fingerprint: "3", clientId: a.id, severity: "critical" });
    await storage.updateFinding(accepted.id, { status: "accepted" });
    await storage.createFinding({ ...base, fingerprint: "4", clientId: b.id, severity: "low" });

    const res = await agent.get("/api/findings/summary");
    expect(res.status).toBe(200);
    expect(res.body.open).toEqual({ total: 3, critical: 1, high: 1, medium: 0, low: 1, info: 0 });
    expect(res.body.byEnvironment).toEqual([
      { environment: null, open: 2 },
      { environment: "production", open: 1 },
    ]);
    expect(res.body.topOpen[0]).toMatchObject({ message: "alpha critical", severity: "critical", clientName: "Alpha" });
    const alpha = res.body.byClient.find((one: { clientId: string }) => one.clientId === a.id);
    expect(alpha).toMatchObject({ open: 2, critical: 1, high: 1 });
    // All four were first seen now, whatever their status.
    const month = res.body.byMonth[res.body.byMonth.length - 1];
    expect(month.critical + month.high + month.medium + month.low).toBe(4);
    // Only counts: no finding's history rides along.
    expect(JSON.stringify(res.body)).not.toMatch(/sightings|checks/);
  });

  it("gives no totals at all when one client's findings cannot be read", async () => {
    const agent = await signIn(app);
    const clients = await storage.getAllClients();
    expect(clients.length).toBeGreaterThan(1);
    const real = storage.getFindingsByClient.bind(storage);
    vi.spyOn(storage, "getFindingsByClient").mockImplementation(async (clientId: string) => {
      if (clientId === clients[1].id) throw new Error("disk read failed for one engagement");
      return real(clientId);
    });

    const res = await agent.get("/api/findings/summary");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      message: "Could not read every engagement's findings, so no totals are given.",
    });
    // Neither a partial total nor the storage error's text reaches the caller.
    expect(res.body.open).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("disk read failed");
  });
});
