// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within } from "@testing-library/react";

import Overview, { trendRows } from "@/pages/Overview";

/**
 * The Overview's computed figures, each pinned to the record it is computed
 * from. Five wrong versions of them left the Overview tests green (adversary
 * round 1, F7): acknowledged and accepted findings counted as open, fixed
 * findings counted by environment, every severity drawn as "low" in the trend,
 * a not-recommended decision counted as ready, and recent scans oldest first.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

const CLIENTS = [{ id: "c1", name: "Northwind Checkout" }];
const SITES = [
  { id: "s1", clientId: "c1", environment: "production" },
  { id: "s2", clientId: "c1", environment: "staging" },
];
const finding = (id: string, over: Record<string, unknown>) => ({
  id, clientId: "c1", siteId: "s1", type: "xss", severity: "medium", message: `finding ${id}`,
  status: "open", firstSeenAt: iso(3), lastSeenAt: iso(3), ...over,
});
const FINDINGS = [
  finding("open-prod", { severity: "high", siteId: "s1", message: "Open on production" }),
  finding("open-stage", { severity: "medium", siteId: "s2", message: "Open on staging" }),
  // Not open: a person acknowledged it, accepted the risk, or a retest closed it.
  finding("ack", { severity: "critical", siteId: "s1", status: "acknowledged", message: "Acknowledged one" }),
  finding("acc", { severity: "critical", siteId: "s1", status: "accepted", message: "Accepted one" }),
  finding("fixed", { severity: "critical", siteId: "s1", status: "fixed", message: "Fixed one" }),
];
const TESTS = [
  {
    id: "old", clientId: "c1", siteId: "s1", testType: "penetration-test", status: "completed",
    startedAt: iso(50), completedAt: iso(48), vulnerabilitiesFound: 1,
  },
  {
    id: "mid", clientId: "c1", siteId: "s1", testType: "compliance-audit", status: "failed",
    startedAt: iso(20), completedAt: iso(19), vulnerabilitiesFound: 0,
  },
  {
    id: "new", clientId: "c1", siteId: "s2", testType: "vulnerability-scan", status: "running",
    startedAt: iso(1), completedAt: null, vulnerabilitiesFound: 0,
  },
];
const DEPLOYMENTS = [
  { uuid: "d1", decision: "ready" },
  { uuid: "d2", decision: "not_recommended" },
  { uuid: "d3", decision: null },
];

function mount() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          throw new Error(`unexpected fetch for ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  client.setQueryData(["/api/clients"], CLIENTS);
  client.setQueryData(["/api/sites"], SITES);
  client.setQueryData(["/api/tests"], TESTS);
  client.setQueryData(["/api/assurance/deployments"], DEPLOYMENTS);
  client.setQueryData(["/api/findings", { clientId: "c1" }], { findings: FINDINGS, counts: {} });
  client.setQueryData(["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 });
  client.setQueryData(["/api/auth/check"], { authenticated: true, user: null });
  return render(
    <QueryClientProvider client={client}>
      <Overview />
    </QueryClientProvider>,
  );
}

function figureOf(testId: string): string {
  return screen.getByTestId(testId).querySelector(".athena-figure")?.textContent ?? "";
}

describe("the Overview's computed figures", () => {
  it("counts only open findings as open: not acknowledged, accepted or fixed", () => {
    mount();
    expect(figureOf("overview-metric-findings")).toBe("2");
    expect(screen.getByText("0 critical · 1 high")).toBeTruthy();
    const posture = screen.getByTestId("overview-panel-posture");
    expect(Array.from(posture.querySelectorAll(".athena-figure")).map((el) => el.textContent)).toEqual(["2", "0", "1"]);
    const issues = screen.getByTestId("overview-panel-issues");
    expect(within(issues).queryByText("Acknowledged one")).toBeNull();
    expect(within(issues).queryByText("Accepted one")).toBeNull();
    expect(within(issues).queryByText("Fixed one")).toBeNull();
    // Worst first: the open high before the open medium.
    expect(Array.from(issues.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      expect.stringContaining("Open on production"),
      expect.stringContaining("Open on staging"),
    ]);
  });

  it("splits open findings by the environment of their site, and nothing else", () => {
    mount();
    const panel = screen.getByTestId("overview-panel-environments");
    const rows = Array.from(panel.querySelectorAll("li")).map((li) => li.textContent);
    // Three non-open findings sit on production too; none of them is counted.
    expect(rows.sort()).toEqual(["Production1", "Staging1"]);
  });

  it("counts a ready decision as ready, and a not-recommended one as not", () => {
    mount();
    expect(figureOf("overview-metric-decisions")).toBe("2");
    expect(screen.getByText("of 3 deployments · 1 ready")).toBeTruthy();
  });

  it("lists recent scans newest first", () => {
    mount();
    const panel = screen.getByTestId("overview-panel-activity");
    const lines = Array.from(panel.querySelectorAll("li p:first-child")).map((p) => p.textContent);
    expect(lines).toEqual([
      "Running: Vulnerability Scan",
      "Failed: Compliance Audit",
      "Completed: Penetration Test",
    ]);
  });
});

describe("the findings trend", () => {
  const at = (y: number, m: number, d = 15) => new Date(y, m, d, 12).toISOString();
  const row = (sev: string, when: string) => ({
    id: `${sev}-${when}`, clientId: "c1", siteId: null, type: "t", severity: sev, message: null,
    status: "open", firstSeenAt: when, lastSeenAt: when,
  });

  it("puts each finding in its own severity's series, in the month it was first seen", () => {
    const rows = trendRows([
      row("critical", at(2026, 0)),
      row("high", at(2026, 0)),
      row("high", at(2026, 0)),
      row("low", at(2026, 2)),
      row("medium", at(2026, 2)),
      row("info", at(2026, 2)),
    ]);
    // January, an empty February (a month with none is a zero, not a gap), March.
    expect(rows.map(({ critical, high, medium, low }) => ({ critical, high, medium, low }))).toEqual([
      { critical: 1, high: 2, medium: 0, low: 0 },
      { critical: 0, high: 0, medium: 0, low: 0 },
      { critical: 0, high: 0, medium: 1, low: 1 },
    ]);
    expect(rows.map((r) => r.m)).toEqual(["Jan 26", "Feb 26", "Mar 26"]);
  });

  it("keeps the last twelve months", () => {
    const rows = trendRows([row("high", at(2024, 0)), row("critical", at(2026, 5))]);
    expect(rows).toHaveLength(12);
    expect(rows[0].m).toBe("Jul 25");
    expect(rows[11]).toMatchObject({ m: "Jun 26", critical: 1, high: 0 });
  });
});
