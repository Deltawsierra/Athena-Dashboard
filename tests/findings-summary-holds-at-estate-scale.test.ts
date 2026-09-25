import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import type { Express } from "express";

import { makeApp, signIn } from "./helpers";
import { summarizeFindings, TREND_MONTHS } from "../server/findings-summary";

/**
 * PR #52 round 2, R2-C.
 *
 * summarizeFindings spread every dated finding -- of any status: fixed and
 * accepted ones accumulate for ever, lifecycle rows are never deleted -- into
 * Math.max/Math.min. V8 throws "RangeError: Maximum call stack size exceeded"
 * once that argument list passes roughly 125k-150k entries, so from then on
 * GET /api/findings/summary answered 500 "Could not read every engagement's
 * findings" (every read had succeeded) and the Overview's findings figures and
 * the Deployments review step read "—" permanently, with a cause that sent
 * operators to debug storage. Counting per client also filtered the whole open
 * list once per client: about 2.1s of blocked event loop at 1000 clients and
 * 100k findings.
 *
 * Adapted from the adversarial reproducer r2-c-summary-at-scale.test.ts.
 */
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
function finding(i: number, clients: number) {
  return {
    id: `f${i}`, clientId: `c${i % clients}`, siteId: i % 2 === 0 ? "s0" : null, type: "missing_security_header",
    severity: SEVERITIES[i % 4], message: null,
    status: i % 3 === 0 ? "open" : "fixed",
    firstSeenAt: new Date(Date.UTC(2025, i % 18, 1)), lastSeenAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60)),
  };
}
const clientsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `Client ${i}` }));

describe("the findings summary at estate scale", () => {
  it("summarizes 200,000 findings without throwing, and counts them right", () => {
    const N = 200_000;
    const clients = clientsOf(50);
    const findings = Array.from({ length: N }, (_, i) => finding(i, 50));
    const summary = summarizeFindings({ clients, sites: [{ id: "s0", environment: "production" }], findings: findings as never });

    // Expected values counted the slow, obvious way.
    const open = findings.filter((one) => one.status === "open");
    expect(summary.open.total).toBe(open.length);
    for (const sev of SEVERITIES) {
      expect(summary.open[sev], sev).toBe(open.filter((one) => one.severity === sev).length);
    }
    expect(summary.byEnvironment).toEqual([
      { environment: "production", open: open.filter((one) => one.siteId === "s0").length },
      { environment: null, open: open.filter((one) => one.siteId === null).length },
    ]);
    // Eighteen months of arrivals, the latest twelve kept: 2025-07 .. 2026-06.
    expect(summary.byMonth).toHaveLength(TREND_MONTHS);
    expect(summary.byMonth[0].month).toBe("2025-07");
    expect(summary.byMonth[TREND_MONTHS - 1].month).toBe("2026-06");
    const inMonth = (m: number, sev: string) =>
      findings.filter((one) => one.firstSeenAt.getUTCMonth() === m && one.firstSeenAt.getUTCFullYear() === 2025 && one.severity === sev).length;
    expect(summary.byMonth[0]).toEqual({
      month: "2025-07", critical: inMonth(6, "critical"), high: inMonth(6, "high"), medium: inMonth(6, "medium"), low: inMonth(6, "low"),
    });
    // Every client's counts, each from its own findings.
    const c7 = open.filter((one) => one.clientId === "c7");
    expect(summary.byClient[7]).toMatchObject({
      clientId: "c7",
      open: c7.length,
      critical: c7.filter((one) => one.severity === "critical").length,
      high: c7.filter((one) => one.severity === "high").length,
    });
    const latest = Math.max(...c7.filter((one) => one.severity === "critical" || one.severity === "high")
      .map((one) => one.lastSeenAt.getTime()));
    expect(summary.byClient[7].latestSeriousSeenAt).toBe(new Date(latest).toISOString());
    // The worst open ones: criticals, most recently seen first.
    expect(summary.topOpen).toHaveLength(5);
    expect(summary.topOpen.every((one) => one.severity === "critical")).toBe(true);
    const seen = summary.topOpen.map((one) => one.lastSeenAt);
    expect(seen).toEqual([...seen].sort().reverse());
    expect(seen[0]).toBe(new Date(Math.max(...open.filter((one) => one.severity === "critical")
      .map((one) => one.lastSeenAt.getTime()))).toISOString());
  });

  it("summarizes 1000 clients and 100,000 findings in well under a second", () => {
    const clients = clientsOf(1000);
    const findings = Array.from({ length: 100_000 }, (_, i) => ({ ...finding(i, 1000), status: "open" }));
    const started = performance.now();
    const summary = summarizeFindings({ clients, sites: [], findings: findings as never });
    const took = performance.now() - started;
    expect(summary.open.total).toBe(100_000);
    expect(summary.byClient.every((one) => one.open === 100)).toBe(true);
    // Measured at under 100ms here; the quadratic version took ~2100ms. The bound is
    // generous so a slow CI machine does not flake, and still catches O(n x m).
    expect(took).toBeLessThan(1000);
  });

  describe("route", () => {
    let app: Express;
    let storage: typeof import("../server/storage-unified")["storage"];
    beforeAll(async () => {
      vi.resetModules();
      app = await makeApp();
      storage = (await import("../server/storage-unified")).storage;
    });
    afterEach(() => vi.restoreAllMocks());

    it("answers 200, not a storage-read error, when every read succeeded", async () => {
      const agent = await signIn(app);
      const c = await storage.createClient({ name: "Big", company: "Big", email: "b@big.test" });
      const rows = Array.from({ length: 160_000 }, (_, i) => ({ ...finding(i, 1), clientId: c.id }));
      vi.spyOn(storage, "getFindingsByClient").mockImplementation(async (id: string) => (id === c.id ? rows : []) as never);
      const res = await agent.get("/api/findings/summary");
      expect(res.body.message ?? "").not.toMatch(/Could not read every engagement's findings/);
      expect(res.status).toBe(200);
      expect(res.body.open.total).toBe(rows.filter((one) => one.status === "open").length);
    });

    it("says counting failed, not reading, when the reads succeeded and the count threw", async () => {
      const agent = await signIn(app);
      const c = await storage.createClient({ name: "Odd", company: "Odd", email: "o@odd.test" });
      // A row the count cannot handle: reading its status throws.
      const poisoned = { ...finding(0, 1), clientId: c.id, get status(): string { throw new Error("secret internals"); } };
      vi.spyOn(storage, "getFindingsByClient").mockImplementation(async (id: string) => (id === c.id ? [poisoned] : []) as never);
      const res = await agent.get("/api/findings/summary");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        message: "Every engagement's findings were read, but counting them failed, so no totals are given.",
      });
      expect(JSON.stringify(res.body)).not.toContain("secret internals");
    });
  });
});
