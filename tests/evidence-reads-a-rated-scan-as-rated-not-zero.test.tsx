// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";

import Evidence from "@/pages/Evidence";

/**
 * PR #52 round 5, R5-E. Evidence's "Latest Completed Scan" card read the
 * critical and high counts alone. A test recorded on the Tests screen
 * "Severity: Critical, Total Vulnerabilities: 2" with the per-severity counts
 * left at 0 -- drawn "Critical", 2 findings, on Deployments -- was described
 * here as "Its latest completed scan reported 0 critical and 0 high findings".
 *
 * The card now reads the record whole (shared/latest-scans.ts readScan) and
 * says what it holds. Adapted from the round-5 reproducer
 * r5-e-evidence-reads-a-rated-critical-as-zero.
 */
afterEach(cleanup);

function card(test: Record<string, unknown>): string {
  cleanup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async ({ queryKey }) => { throw new Error(`source failed: ${JSON.stringify(queryKey)}`); } } } });
  const latest = {
    id: "manual-1", clientId: "c1", status: "completed", severity: null, testType: "penetration-test",
    startedAt: new Date(Date.now() - 7_200_000).toISOString(), completedAt: null,
    vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, findings: null, ...test,
  };
  for (const [k, v] of [
    [["/api/documents"], []], [["/api/users/assignable"], []],
    [["/api/clients"], [{ id: "c1", name: "Payments API", status: "active" }]], [["/api/tests"], [latest]],
  ] as Array<[unknown[], unknown]>) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}><Evidence /></QueryClientProvider>);
  return screen.getByTestId("evidence-latest-scan").textContent ?? "";
}

describe("Evidence reads the latest scan's record whole", () => {
  it("a scan rated critical with 2 findings and no counts is rated critical, not 0 critical", () => {
    const text = card({ severity: "critical", vulnerabilitiesFound: 2, findings: { details: "two critical SQL injections" } });
    expect(text).not.toMatch(/reported 0 critical and 0 high findings/);
    expect(text).toMatch(/Its latest completed scan reported 2 findings, rated critical; not broken down by severity\./);
  });

  it("a rating with no total either is said as a rating with no count", () => {
    expect(card({ severity: "High" })).toMatch(/Its latest completed scan was rated high, with no count recorded\./);
  });

  it("findings nobody rated are said as unrated", () => {
    const text = card({ vulnerabilitiesFound: 4 });
    expect(text).not.toMatch(/0 critical/);
    expect(text).toMatch(/Its latest completed scan reported 4 findings with no severity recorded\./);
  });

  it("counts, and what they leave unrated or uncounted, are both said", () => {
    expect(card({ severity: "critical", vulnerabilitiesFound: 3, highCount: 2 }))
      .toMatch(/reported 0 critical and 2 high findings; rated critical, with no critical count recorded\./);
    expect(card({ vulnerabilitiesFound: 5, criticalCount: 1 }))
      .toMatch(/reported 1 critical and 0 high finding; 4 findings with no severity recorded\./);
  });

  it("counts as recorded are still read as recorded", () => {
    expect(card({ severity: "critical", vulnerabilitiesFound: 3, criticalCount: 1, highCount: 2 }))
      .toMatch(/Its latest completed scan reported 1 critical and 2 high findings\./);
  });
});
