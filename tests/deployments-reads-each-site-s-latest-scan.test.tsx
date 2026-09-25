// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within } from "@testing-library/react";

import Deployments from "@/pages/Deployments";

/**
 * PR #52 round 3, F3 and the open item on pre-fix engine rows, on the
 * Deployments table.
 *
 * Each row read its client's single latest completed test, so a later scan of
 * site B replaced what the latest scan of site A had reported: a row that
 * said "Critical · 5 (3C / 2H)" became "Low · 1 (0C / 0H)" although nothing
 * about site A had been learned. It now reads the latest completed test of
 * every site (the same rule the findings summary uses).
 *
 * And an engine test the engine finished inline before the inline-count fix
 * was written with every count zero beside real results; the table read it as
 * "None reported · 0 reported". Those counts were never recorded, and the row
 * now says so.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const CLIENTS = [{ id: "c1", name: "Acme App", company: "Acme", status: "active", lastTestDate: null, notes: null }];
const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const test = (over: Record<string, unknown>) => ({
  id: "t", clientId: "c1", siteId: "s1", testType: "penetration-test", status: "completed", severity: null,
  startedAt: at(48), completedAt: at(47), vulnerabilitiesFound: 0,
  criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, findings: null, ...over,
});
const SUMMARY = {
  clients: 1, open: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  byEnvironment: [], byMonth: [], topOpen: [],
  byClient: [{ clientId: "c1", open: 0, critical: 0, high: 0, latestSeriousSeenAt: null, untrackedScan: null }],
};

function mount(tests: Array<ReturnType<typeof test>>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
      queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); } } },
  });
  for (const [k, v] of [
    [["/api/clients"], CLIENTS], [["/api/tests"], tests], [["/api/findings/summary"], SUMMARY],
    [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
    [["/api/auth/check"], { authenticated: true, user: null }],
  ] as Array<[unknown[], unknown]>) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}><Deployments /></QueryClientProvider>);
}
const row = () => screen.getAllByText("Acme App").map((el) => el.closest("tr")).find(Boolean) as HTMLElement;
const step = (title: string) =>
  Array.from(document.querySelectorAll("ol > li")).find((li) => li.querySelector("p")?.textContent === title)?.textContent ?? "";

describe("Deployments reads the latest completed scan of every site", () => {
  const pentestA = test({
    id: "pentest-a", severity: "critical", vulnerabilitiesFound: 5, criticalCount: 3, highCount: 2, completedAt: at(24),
  });
  const laterScanB = test({
    id: "scan-b", siteId: "s2", testType: "vulnerability-scan", severity: "low", vulnerabilitiesFound: 1, lowCount: 1,
    completedAt: at(1),
  });

  it("a later scan of another site does not replace what site A's latest scan reported", () => {
    mount([pentestA, laterScanB]);
    const r = row();
    expect(within(r).getByText("Critical")).toBeTruthy();
    expect(r.textContent).toContain("6 (3C / 2H)");
    expect(r.textContent).toContain("Latest completed scan of each of 2 sites");
  });

  it("a later scan of the same site does", () => {
    mount([pentestA, { ...laterScanB, siteId: "s1" }]);
    const r = row();
    expect(within(r).getByText("Low")).toBeTruthy();
    expect(r.textContent).toContain("1 (0C / 0H)");
    expect(r.textContent).toContain("Latest completed scan");
    expect(r.textContent).not.toContain("each of");
  });
});

describe("an engine test whose counts were never recorded", () => {
  const unrecorded = test({
    id: "inline-old", testType: "vulnerability-scan",
    findings: { runId: "run-1", target: "https://app.example", results: [
      { type: "sql_injection", severity: "critical", evidence: { endpoint: "https://app.example/login" } },
      { type: "error", internal: true },
    ] },
  });

  it("reads 'Counts not recorded', never '0 reported' or 'None reported'", () => {
    mount([unrecorded]);
    const r = row();
    expect(r.textContent).not.toMatch(/0 reported|None reported/);
    expect(within(r).getByText("Not recorded")).toBeTruthy();
    expect(screen.getByTestId("text-counts-not-recorded-c1").textContent).toMatch(
      /^Counts not recorded: results came back, but the scan's counts were never written down\.$/,
    );
    // And the review step is not ticked on the strength of those zeros.
    expect(step("Review Evidence")).not.toContain("✓");
    expect(step("Review Evidence")).toContain("1 system whose latest completed scan reported findings to review.");
  });

  it("a test that returned only internal notes, or nothing, still reads as none reported", () => {
    mount([test({ id: "quiet", findings: { runId: "run-2", results: [{ type: "error", internal: true }] } })]);
    const r = row();
    expect(within(r).getByText("None reported")).toBeTruthy();
    expect(r.textContent).toContain("0 reported");
    expect(screen.queryByTestId("text-counts-not-recorded-c1")).toBeNull();
  });

  it("beside another site's recorded counts, says how many scans are unrecorded", () => {
    mount([unrecorded, test({ id: "b", siteId: "s2", severity: "high", vulnerabilitiesFound: 2, highCount: 2 })]);
    const r = row();
    expect(within(r).getByText("High")).toBeTruthy();
    expect(r.textContent).toContain("2 (0C / 2H)");
    expect(screen.getByTestId("text-counts-not-recorded-c1").textContent).toMatch(/^Counts not recorded for 1 scan:/);
  });
});
