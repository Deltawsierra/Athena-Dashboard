// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { ReactElement } from "react";

import Overview from "@/pages/Overview";
import Deployments from "@/pages/Deployments";
import { summarizeFindings } from "../server/findings-summary";

/**
 * PR #52 round 2, R2-A.
 *
 * A scan recorded on the Tests screen (POST /api/tests: status "completed",
 * criticalCount 3, highCount 5 -- a person's record of a pentest) creates no
 * lifecycle finding rows. The Overview and the Deployments pipeline read only
 * those rows, so a default build showed an unqualified all-clear next to the
 * very record that contradicted it:
 *
 *   Overview     "Nothing flagged: no client has an open critical or high
 *                 finding, and every client has a completed scan."
 *                ...beside Recent Activity's "15 findings reported".
 *   Deployments  Row "Critical · 15 (3C / 5H)", and "Review Evidence: No open
 *                 findings on record." ticked as done.
 *
 * The summary now reports that scan's counts per client (`untrackedScan`), the
 * Overview flags the client with them, Deployments keeps Review Evidence open
 * while any latest completed scan reported anything, and every all-clear
 * sentence says what it covers and appears only when neither source reports
 * anything.
 *
 * Adapted from the adversarial reproducer r2-a-manual-scan-all-clear.test.tsx.
 * The summary payload is computed by the server's own summarizeFindings from
 * the same records (no finding row, and the test filed nothing), so it is
 * exactly what the route answers for them.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const now = new Date().toISOString();
const CLIENTS = [{ id: "c1", name: "Acme", company: "Acme", status: "active", lastTestDate: null, notes: null }];
const SITES = [{ id: "s1", clientId: "c1", environment: "production" }];
// Recorded on the Tests screen: a completed pentest with 3 critical and 5 high.
const MANUAL = {
  id: "t1", clientId: "c1", siteId: "s1", testType: "penetration-test", status: "completed", severity: "critical",
  startedAt: now, completedAt: now, vulnerabilitiesFound: 15,
  criticalCount: 3, highCount: 5, mediumCount: 4, lowCount: 3,
};
// The same client's latest completed scan reporting nothing at all.
const CLEAN = { ...MANUAL, id: "t2", severity: null, vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };

function summaryFor(tests: Array<typeof MANUAL>) {
  const summary = summarizeFindings({
    clients: CLIENTS, sites: SITES, findings: [],
    tests: tests.map((t) => ({ ...t, startedAt: new Date(t.startedAt), completedAt: new Date(t.completedAt) })) as never,
    filedTestIds: new Set(),
  });
  return JSON.parse(JSON.stringify(summary));
}

function mount(ui: ReactElement, tests: Array<typeof MANUAL>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
      queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); } } },
  });
  const seed: Array<[unknown[], unknown]> = [
    [["/api/clients"], CLIENTS], [["/api/sites"], SITES], [["/api/tests"], tests],
    [["/api/findings/summary"], summaryFor(tests)], [["/api/assurance/deployments"], []],
    [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
    [["/api/auth/check"], { authenticated: true, user: null }],
  ];
  for (const [k, v] of seed) client.setQueryData(k, v);
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** A Release Readiness step's text (the hero repeats some step titles). */
function step(title: string): string {
  const steps = Array.from(document.querySelectorAll("ol > li")).filter(
    (li) => li.querySelector("p")?.textContent === title,
  );
  expect(steps, `one readiness step titled ${title}`).toHaveLength(1);
  return steps[0].textContent ?? "";
}

const ANY_ALL_CLEAR = /Nothing flagged|No open (tracked )?findings on record|No open findings/;

describe("a completed scan that reported critical findings is not answered with an all-clear", () => {
  it("the summary the page reads carries the scan's counts, outside the open totals", () => {
    const summary = summaryFor([MANUAL]);
    expect(summary.byClient[0].untrackedScan).toEqual({ testId: "t1", completedAt: now, critical: 3, high: 5 });
    expect(summary.open.total).toBe(0);
  });

  it("Overview flags the client with what its latest completed scan reported", () => {
    mount(<Overview />, [MANUAL]);
    const attention = screen.getByTestId("overview-panel-attention");
    // The same page reports the scan's findings...
    expect(screen.getByTestId("overview-panel-activity").textContent).toMatch(/15 findings reported/);
    // ...so the attention panel flags the client that reported them, pilled
    // by the worst it reported, and says they are not tracked findings.
    expect(attention.textContent).not.toMatch(ANY_ALL_CLEAR);
    expect(attention.textContent).toMatch(/Acme/);
    expect(attention.textContent).toMatch(/Latest completed scan reported 3 critical \/ 5 high; not tracked as findings/);
    expect(within(attention).getByText("Critical")).toBeTruthy();
  });

  it("Overview's findings panels say they cover tracked findings, and point at the untracked scan", () => {
    mount(<Overview />, [MANUAL]);
    const issues = screen.getByTestId("overview-panel-issues").textContent ?? "";
    expect(issues).not.toMatch(/No open findings on record\./);
    expect(issues).toMatch(/No open tracked findings on record\./);
    expect(issues).toMatch(/1 client's latest completed scan reported critical or high findings that are not tracked as findings/);
    // The headline figure is tracked findings; it says what it leaves out.
    expect(screen.getByTestId("overview-metric-findings").textContent).toMatch(/1 untracked scan result not counted/);
  });

  it("Overview says nothing is flagged only when neither source reports anything, and says what that covers", () => {
    mount(<Overview />, [CLEAN]);
    const attention = screen.getByTestId("overview-panel-attention").textContent ?? "";
    expect(attention).toMatch(
      /Nothing flagged: no client has an open tracked critical or high finding, no client's latest completed scan reported one, and every client has a completed scan\./,
    );
    expect(screen.getByTestId("overview-panel-issues").textContent).toMatch(/^.*No open tracked findings on record\.$/);
  });

  it("Deployments does not tick Review Evidence as done beside a Critical row", () => {
    mount(<Deployments />, [MANUAL]);
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/\(3C \/ 5H\)/);
    expect(body).not.toMatch(/No open findings on record\./);
    const review = step("Review Evidence");
    expect(review).toContain("1 system whose latest completed scan reported findings to review.");
    expect(review).not.toContain("✓");
  });

  // A scan reports findings by its total or by any severity count; either one
  // alone keeps the step open.
  for (const [what, over] of [
    ["only medium or low findings", { vulnerabilitiesFound: 2, mediumCount: 1, lowCount: 1 }],
    ["a total with no severity split", { vulnerabilitiesFound: 4 }],
    ["severity counts with no total", { criticalCount: 1 }],
  ] as const) {
    it(`Deployments keeps Review Evidence open for a scan that reported ${what}`, () => {
      mount(<Deployments />, [{ ...CLEAN, ...over }]);
      expect(step("Review Evidence")).toContain("1 system whose latest completed scan reported findings to review.");
      expect(step("Review Evidence")).not.toContain("✓");
    });
  }

  it("Deployments ticks Review Evidence only when nothing tracked is open and no latest scan reported anything", () => {
    mount(<Deployments />, [CLEAN]);
    const review = step("Review Evidence");
    expect(review).toContain("No open tracked findings, and no system's latest completed scan reported any.");
    expect(review).toContain("✓");
  });

  it("pills a client High when its untracked scan reported only highs, and joins it to tracked findings", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); } } },
    });
    const highOnly = { ...MANUAL, criticalCount: 0, highCount: 2, vulnerabilitiesFound: 2 };
    const summary = summaryFor([highOnly]);
    // Two open tracked mediums/highs from an earlier engine scan as well.
    // The tracked one was last seen three days ago; the scan completed just now,
    // and the row is dated by whichever is later.
    const earlier = new Date(Date.now() - 3 * 86_400_000).toISOString();
    summary.byClient[0] = { ...summary.byClient[0], open: 1, high: 1, latestSeriousSeenAt: earlier };
    const seed: Array<[unknown[], unknown]> = [
      [["/api/clients"], CLIENTS], [["/api/sites"], SITES], [["/api/tests"], [highOnly]],
      [["/api/findings/summary"], summary], [["/api/assurance/deployments"], []],
      [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
      [["/api/auth/check"], { authenticated: true, user: null }],
    ];
    for (const [k, v] of seed) client.setQueryData(k, v);
    render(<QueryClientProvider client={client}><Overview /></QueryClientProvider>);
    const attention = screen.getByTestId("overview-panel-attention");
    expect(attention.textContent).toMatch(
      /1 open critical\/high finding · latest completed scan reported 0 critical \/ 2 high; not tracked as findings/,
    );
    expect(within(attention).getByText("High")).toBeTruthy();
    expect(within(attention).queryByText("Critical")).toBeNull();
    expect(attention.textContent).toMatch(/just now/);
    expect(attention.textContent).not.toMatch(/3d ago/);
  });

  it("a client the summary has not counted yet is flagged as uncounted, not cleared", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); } } },
    });
    const summary = summaryFor([CLEAN]);
    summary.byClient = [];
    const seed: Array<[unknown[], unknown]> = [
      [["/api/clients"], CLIENTS], [["/api/sites"], SITES], [["/api/tests"], [CLEAN]],
      [["/api/findings/summary"], summary], [["/api/assurance/deployments"], []],
      [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
      [["/api/auth/check"], { authenticated: true, user: null }],
    ];
    for (const [k, v] of seed) client.setQueryData(k, v);
    render(<QueryClientProvider client={client}><Overview /></QueryClientProvider>);
    const attention = screen.getByTestId("overview-panel-attention").textContent ?? "";
    expect(attention).toMatch(/Acme/);
    expect(attention).toMatch(/Not in the findings summary yet: its findings are not counted/);
    expect(attention).not.toMatch(ANY_ALL_CLEAR);
    cleanup();

    render(<QueryClientProvider client={client}><Deployments /></QueryClientProvider>);
    const review = step("Review Evidence");
    expect(review).toContain("Could not load findings: 1 system not in the findings summary yet");
    expect(review).not.toContain("✓");
  });
});
