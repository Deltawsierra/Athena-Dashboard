// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { ReactElement } from "react";

import Deployments from "@/pages/Deployments";
import Overview from "@/pages/Overview";
import { summarizeFindings } from "../server/findings-summary";

/**
 * Q7: a test a person records on the (routed) Tests screen with "Critical
 * Count: 2" and the Severity / Total Vulnerabilities fields left at their
 * defaults is sent as {severity: null, vulnerabilitiesFound: 0,
 * criticalCount: 2} (Tests.tsx handleCreateTest). The server's findings
 * summary reads it as 2 untracked criticals (and the Overview flags the
 * client), but the Deployments table's Risk column read it through bandOf(),
 * which looked only at `severity` and `vulnerabilitiesFound`, and the
 * Findings column was gated on vulnerabilitiesFound > 0: the row said
 * "None reported" and "0 reported" for a client whose latest completed test
 * recorded two criticals. The Overview's Recent Activity said "0 findings
 * reported" about the same test.
 *
 * The band is now the worse of the severity field and the counts, and the
 * total the larger of the total and the counts' sum. A total with no severity
 * recorded anywhere is "Not rated" -- it used to be guessed as "Medium".
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
});
afterEach(cleanup);

const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const test = (id: string, clientId: string, over: Record<string, unknown>) => ({
  id, clientId, siteId: null, testType: "penetration-test", status: "completed",
  severity: null, startedAt: at(2), completedAt: at(1), vulnerabilitiesFound: 0,
  criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, findings: null, ...over,
});
const CLIENTS = [
  { id: "c1", name: "Acme App", company: "Acme", status: "active", lastTestDate: null, notes: null },
  { id: "c2", name: "Unrated App", company: "U", status: "active", lastTestDate: null, notes: null },
  { id: "c3", name: "Unrecorded App", company: "N", status: "active", lastTestDate: null, notes: null },
];
// Exactly the body Tests.tsx builds when only "Critical Count" is filled in.
const RECORDED = test("pentest", "c1", { criticalCount: 2 });
// A total, with no severity recorded for any of it.
const UNRATED = test("unrated", "c2", { vulnerabilitiesFound: 3 });
// An engine scan finished inline before the inline-count fix: results, no counts.
const UNRECORDED = test("inline-old", "c3", {
  testType: "vulnerability-scan",
  findings: { runId: "run-1", target: "https://n.example", results: [{ type: "xss", severity: "high" }] },
});
const TESTS = [RECORDED, UNRATED, UNRECORDED];

function mount(ui: ReactElement) {
  const summary = summarizeFindings({ clients: CLIENTS, sites: [], findings: [], tests: TESTS as never });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
      queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); } } },
  });
  for (const [k, v] of [
    [["/api/clients"], CLIENTS], [["/api/sites"], []], [["/api/tests"], TESTS],
    [["/api/findings/summary"], JSON.parse(JSON.stringify(summary))], [["/api/assurance/deployments"], []],
    [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
    [["/api/auth/check"], { authenticated: true, user: null }],
  ] as Array<[unknown[], unknown]>) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return summary;
}

const row = (name: string) => screen.getAllByText(name).map((el) => el.closest("tr")).find(Boolean) as HTMLElement;

describe("Deployments reads a recorded count", () => {
  it("the summary flags the client, and the table does not call it clear", () => {
    const summary = mount(<Deployments />);
    expect(summary.byClient.find((one) => one.clientId === "c1")?.untrackedScan?.critical).toBe(2); // the server's own reading

    const r = row("Acme App");
    expect(r.textContent).not.toMatch(/None reported/);
    expect(r.textContent).not.toMatch(/\b0 reported/);
    expect(within(r).getByText("Critical")).toBeTruthy();
    expect(r.textContent).toContain("2 (2C / 0H)");
  });

  it("a total with no severity is not rated -- not guessed as medium", () => {
    mount(<Deployments />);
    const r = row("Unrated App");
    expect(within(r).getByText("Not rated")).toBeTruthy();
    expect(r.textContent).not.toMatch(/Medium/);
    expect(r.textContent).toContain("3 (0C / 0H)");
  });

  it("the highest-risk list names every system that reported findings, rated or not", () => {
    mount(<Deployments />);
    expect(screen.getByTestId("highest-risk-c1").textContent).toMatch(/Critical.*Acme App.*2 findings reported \(2C \/ 0H\)/);
    expect(screen.getByTestId("highest-risk-c2").textContent).toMatch(/Not rated.*Unrated App.*3 findings reported/);
    expect(screen.getByTestId("highest-risk-c3").textContent).toMatch(/Not recorded.*Unrecorded App.*Counts not recorded/);
    expect(document.body.textContent).not.toMatch(/No completed scan has reported a finding/);
  });
});

describe("the Overview's Recent Activity reads the same record", () => {
  it("says how many the counts recorded, and never 0 for counts nobody took", () => {
    mount(<Overview />);
    const activity = screen.getByTestId("overview-panel-activity").textContent ?? "";
    expect(activity).toMatch(/Acme App · 2 findings reported/);
    expect(activity).toMatch(/Unrated App · 3 findings reported/);
    expect(activity).toMatch(/Unrecorded App · counts not recorded/);
    expect(activity).not.toMatch(/0 findings reported/);
  });
});
