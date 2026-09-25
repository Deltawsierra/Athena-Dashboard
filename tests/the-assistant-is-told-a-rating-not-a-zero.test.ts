import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { makeApp } from "./helpers";

/**
 * PR #52 round 5, R5-D. What the assistant is told (server/summary.ts
 * deploymentSummary) read the per-severity counts alone. A pentest recorded on
 * the Tests screen "Severity: Critical, Total Vulnerabilities: 2" with the
 * counts left at 0 went into the model's context as
 *   "- penetration-test on Checkout: completed, 0 critical / 0 high / 0 medium / 0 low"
 *   "Across all tests: 0 critical, 0 high, 0 medium, 0 low."
 * -- asked "any criticals?", the assistant was handed "none" -- while
 * Deployments drew the same row as Critical.
 *
 * Each line is now read whole (shared/latest-scans.ts readScan), and the totals
 * say how many tests they leave out because a rating has no count behind it
 * or results have no severity. The benchmark restates this context
 * (tools/assistant-bench/bench.mjs), so it is run on the same records and must
 * say exactly the same. Adapted from the round-5 reproducer
 * r5-d-assistant-told-none-beside-a-recorded-critical.
 */
let summary = "";
let records: { clients: unknown[]; sites: unknown[]; tests: unknown[] } = { clients: [], sites: [], tests: [] };

beforeAll(async () => {
  await makeApp();
  const { storage } = await import("../server/storage-unified");
  const { deploymentSummary } = await import("../server/summary");
  const client = await storage.createClient({ name: "Acme", company: "Acme", email: "a@acme.test", status: "active" } as never);
  const site = await storage.createSite({ clientId: client.id, name: "Checkout", url: "https://acme.example" } as never);
  const t = async (over: Record<string, unknown>) => {
    await storage.createTest({
      clientId: client.id, siteId: site.id, testType: "penetration-test", status: "completed", completedAt: new Date(),
      vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, ...over,
    } as never);
    // Distinct start times, so "most recent" has one order.
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  // Exactly what the Tests screen's create form sends with Severity=Critical, Total=2, counts left at 0.
  await t({ severity: "critical", vulnerabilitiesFound: 2, summary: "two criticals", findings: { details: "2 critical SQLi" } });
  // "Total Vulnerabilities: 4" alone.
  await t({ severity: null, vulnerabilitiesFound: 4 });
  // An engine scan whose every result was rated info.
  await t({
    testType: "vulnerability-scan", severity: "info", vulnerabilitiesFound: 2,
    findings: { runId: "run-i", target: "https://acme.example/", results: [{ type: "banner", severity: "info" }, { type: "tls", severity: "info" }] },
  });
  // Counts as a person recorded them.
  await t({ severity: "high", vulnerabilitiesFound: 3, highCount: 2, mediumCount: 1 });
  summary = await deploymentSummary();
  records = { clients: await storage.getAllClients(), sites: await storage.getAllSites(), tests: await storage.getAllTests() };
});

describe("the assistant is told what a scan's rating says, never a zero it does not hold", () => {
  it("a test rated critical with no counts is told as rated critical, not as none", () => {
    expect(summary).toContain("- penetration-test on Checkout: completed, 2 found, rated critical, not broken down by severity");
    expect(summary).not.toMatch(/completed, 0 critical \/ 0 high \/ 0 medium \/ 0 low/);
  });

  it("results nobody rated are told as unrated, and info-only results as info", () => {
    expect(summary).toContain("- penetration-test on Checkout: completed, 4 found, no severity recorded");
    expect(summary).toContain("- vulnerability-scan on Checkout: completed, 2 found, all rated info");
    expect(summary).toContain("- penetration-test on Checkout: completed, 0 critical / 2 high / 1 medium / 0 low");
  });

  it("the totals say which tests they leave out", () => {
    expect(summary).toContain(
      "Across all tests: 0 critical, 2 high, 1 medium, 0 low."
        + " 1 test was rated with no count at its rating, which these totals leave out."
        + " 1 test reported results with no severity recorded, which these totals leave out.",
    );
  });

  it("the benchmark builds the same context from the same rows", () => {
    // bench.mjs reads the database's raw rows; hand its summary builder those
    // rows, as sqlite holds them, and compare what it says with the product.
    const bench = readFileSync(join(__dirname, "../tools/assistant-bench/bench.mjs"), "utf8");
    const start = bench.indexOf("function summaryContext() {");
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = bench.indexOf("{", start);
    for (; end < bench.length; end += 1) {
      if (bench[end] === "{") depth += 1;
      if (bench[end] === "}" && --depth === 0) break;
    }
    const source = bench.slice(start, end + 1);
    const snake = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
      value instanceof Date ? value.getTime() : key === "findings" && value !== null && value !== undefined ? JSON.stringify(value) : value,
    ]));
    const rows: Record<string, unknown[]> = {
      clients: records.clients.map((one) => snake(one as Record<string, unknown>)),
      sites: records.sites.map((one) => snake(one as Record<string, unknown>)),
      tests: records.tests.map((one) => snake(one as Record<string, unknown>)),
    };
    const db = { prepare: (sql: string) => ({ all: () => rows[/FROM (\w+)/.exec(sql)![1]] }) };
    const context = new Function("db", `${source}\nreturn summaryContext();`)(db) as string;
    expect(context).toBe(summary);
  });
});
