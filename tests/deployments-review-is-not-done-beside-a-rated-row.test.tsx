// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within } from "@testing-library/react";

import Deployments from "@/pages/Deployments";
import { summarizeFindings } from "../server/findings-summary";

/**
 * PR #52 round 5, R5-G. Round 4 made the Deployments band the worse of the
 * severity field and the counts, but left the release-readiness step's
 * "reported findings" test on the total and counts alone. A system whose
 * latest completed test was recorded "Severity: Critical" with the total and
 * counts left at 0 was drawn in the table as Critical -- and on the same page
 * "Review Evidence" was ticked done: "No open or in-review tracked findings,
 * and no site's latest completed scan reported any." The table said "0
 * reported" beside the Critical band, and Highest Risk "0 findings reported
 * (0C / 0H)".
 *
 * Both now read the record whole (shared/latest-scans.ts readScan): a rating
 * is a report, and a rating no count stands behind is said as such, not as 0.
 * Also pins (K10, mutant D03) that a system's highest-risk line says a site's
 * counts were not recorded. Adapted from the round-5 reproducer
 * r5-g-deployments-review-done-beside-a-critical-row and killer r5-k10.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
});
afterEach(cleanup);

const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const CLIENTS = [{ id: "c1", name: "Acme App", company: "Acme", status: "active", lastTestDate: null, notes: null }];
const base = {
  clientId: "c1", siteId: null, testType: "penetration-test", status: "completed", severity: null, startedAt: at(3),
  completedAt: at(2), vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, findings: null,
};

function mount(tests: unknown[]) {
  const summary = summarizeFindings({ clients: CLIENTS, sites: [], findings: [], tests: tests as never });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); } } } });
  for (const [k, v] of [
    [["/api/clients"], CLIENTS], [["/api/sites"], []], [["/api/tests"], tests],
    [["/api/findings/summary"], JSON.parse(JSON.stringify(summary))], [["/api/assurance/deployments"], []],
    [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
    [["/api/auth/check"], { authenticated: true, user: null }],
  ] as Array<[unknown[], unknown]>) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}><Deployments /></QueryClientProvider>);
}

const row = (name: string) => screen.getAllByText(name).map((el) => el.closest("tr")).find(Boolean) as HTMLElement;

describe("Deployments reads a rating as a report", () => {
  it("Review Evidence stays open beside a row the table rates Critical", () => {
    mount([{ ...base, id: "rated", severity: "critical", findings: { details: "auth bypass" } }]);
    const r = row("Acme App");
    expect(within(r).getByText("Critical")).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/no site's latest completed scan reported any/);
    expect(text).toMatch(/1 system whose latest completed scan reported findings to review\./);
  });

  it("a rating no count stands behind is said as such, not as 0 reported", () => {
    mount([{ ...base, id: "rated", severity: "Critical" }]);
    const r = row("Acme App");
    expect(r.textContent).not.toMatch(/\b0 reported/);
    expect(r.textContent).toMatch(/No count recorded/);
    expect(within(r).getByTestId("text-rated-not-counted-c1").textContent)
      .toBe("Rated critical or high, not counted by severity: the C/H figures leave it out.");
    const risk = screen.getByTestId("highest-risk-c1").textContent ?? "";
    expect(risk).toMatch(/Critical.*Acme App.*No count recorded · rated, not counted by severity/);
    expect(risk).not.toMatch(/0 findings reported/);
  });

  it("with a total, the figure stands and the rating is flagged beside it", () => {
    mount([{ ...base, id: "rated", severity: "critical", vulnerabilitiesFound: 2 }]);
    expect(row("Acme App").textContent).toContain("2 (0C / 0H)");
    expect(screen.getByTestId("highest-risk-c1").textContent)
      .toMatch(/2 findings reported \(0C \/ 0H\) · rated, not counted by severity/);
  });

  it("a medium rating needs no C/H caveat: nothing above medium is implied", () => {
    mount([{ ...base, id: "rated", severity: "medium", vulnerabilitiesFound: 4 }]);
    expect(row("Acme App").textContent).toContain("4 (0C / 0H)");
    expect(screen.queryByTestId("text-rated-not-counted-c1")).toBeNull();
    // With no total either, a rating is still no "0 reported".
    cleanup();
    mount([{ ...base, id: "rated", severity: "medium" }]);
    expect(row("Acme App").textContent).not.toMatch(/\b0 reported/);
    expect(row("Acme App").textContent).toMatch(/No count recorded/);
  });

  it("a system's highest-risk line says a site's scan counts were not recorded (K10)", () => {
    const counted = { ...base, id: "t1", siteId: "s1", criticalCount: 2 };
    const unrecorded = { ...base, id: "t2", siteId: "s2", testType: "vulnerability-scan",
      findings: { runId: "run-1", target: "https://b.example", results: [{ type: "xss", severity: "high" }] } };
    mount([counted, unrecorded]);
    expect(screen.getByTestId("highest-risk-c1").textContent)
      .toMatch(/2 findings reported \(2C \/ 0H\) · counts not recorded for 1 scan/);
  });
});
