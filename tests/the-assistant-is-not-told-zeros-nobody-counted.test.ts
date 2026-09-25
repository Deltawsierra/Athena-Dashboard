import { describe, it, expect, beforeAll } from "vitest";

import { makeApp } from "./helpers";

/**
 * Q7, the same rule as Deployments and Evidence, in what the assistant is
 * told: every test's counts went into its context as "0 critical / 0 high / 0
 * medium / 0 low" -- a scan still running, whose counts do not exist yet, and
 * an engine scan finished before the inline-count fix, whose results came
 * back and whose counts were never written down. Asked about either, the
 * assistant repeated a zero nobody measured.
 */
describe("the assistant is not told zeros nobody counted", () => {
  let summary = "";

  beforeAll(async () => {
    await makeApp();
    const { storage } = await import("../server/storage-unified");
    const { deploymentSummary } = await import("../server/summary");
    const client = await storage.createClient({ name: "Acme", company: "Acme", email: "a@acme.test", status: "active" } as never);
    const site = await storage.createSite({ clientId: client.id, name: "Checkout", url: "https://acme.example" } as never);
    const t = (over: Record<string, unknown>) => storage.createTest({
      clientId: client.id, siteId: site.id, testType: "vulnerability-scan", ...over,
    } as never);
    await t({ status: "running", findings: { runId: "run-live", target: "https://acme.example", results: [] } });
    await t({
      status: "completed", completedAt: new Date(),
      findings: { runId: "run-old", target: "https://acme.example", results: [{ type: "sqli", severity: "critical" }] },
    });
    await t({ status: "completed", completedAt: new Date(), testType: "penetration-test", criticalCount: 2, highCount: 1 });
    summary = await deploymentSummary();
  });

  it("a running scan has no counts yet", () => {
    expect(summary).toContain("- vulnerability-scan on Checkout: running, no counts until it completes");
  });

  it("a scan whose counts were never recorded says so, and the totals say they leave it out", () => {
    expect(summary).toContain("- vulnerability-scan on Checkout: completed, counts not recorded");
    expect(summary).toContain(
      "Across all tests: 2 critical, 1 high, 0 medium, 0 low. Counts were not recorded for 1 completed scan, so these totals leave them out.",
    );
  });

  it("recorded counts are still given as they were recorded", () => {
    expect(summary).toContain("- penetration-test on Checkout: completed, 2 critical / 1 high / 0 medium / 0 low");
  });
});
