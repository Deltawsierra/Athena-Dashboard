// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

import Deployments from "@/pages/Deployments";

/**
 * Deployments stated things no record says (adversary round 1, F1). Two
 * clients with the API's default status "active", one never scanned and one
 * with only a pending scan, rendered as:
 *
 *   Unscanned App ... Not scanned  Clean 8/100
 *   Pending App   ... Pending      Clean 8/100
 *   Average Risk Score 0 out of 100
 *   Scan: 1 of 2 scanned · 1 in flight
 *   ✓ Review Evidence: No open findings on scanned systems.
 *   ✓ Human Approval: 2 of 2 approved for production.
 *   ✓ Deploy: 2 systems live in production.
 *
 * Nothing scanned either system, the 0-100 score was a hard-coded mapping,
 * and "approved" and "live" came only from the default client status. The
 * first three tests are the adversary's reproducers, unchanged.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

const now = () => new Date().toISOString();

/** Seeds the cache; any key not seeded rejects (i.e. that source failed). */
function mount(ui: ReactElement, seed: Array<[unknown[], unknown]>) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          throw new Error(`source failed: ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  for (const [key, value] of seed) client.setQueryData(key, value);
  const utils = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { client, ...utils };
}

const clients = [
  // Status defaults to "active" for every client the API creates.
  { id: "c1", name: "Unscanned App", company: "Co", status: "active", lastTestDate: null, notes: null },
  { id: "c2", name: "Pending App", company: "Co", status: "active", lastTestDate: null, notes: null },
];
const tests = [
  {
    id: "t1", clientId: "c2", testType: "vulnerability-scan", status: "pending", severity: null,
    completedAt: null, startedAt: now(), vulnerabilitiesFound: 0,
    criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
  },
];
const summaryOf = (byClient: Array<{ clientId: string; open: number; critical?: number; high?: number }>) => ({
  clients: byClient.length,
  open: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  byEnvironment: [], byMonth: [], topOpen: [],
  byClient: byClient.map((one) => ({ critical: 0, high: 0, latestSeriousSeenAt: null, ...one })),
});

/** The table row for a system (its name also appears in Recent Activity). */
function row(name: string): HTMLElement {
  const rows = screen.getAllByText(name).map((el) => el.closest("tr")).filter(Boolean);
  expect(rows, `one table row for ${name}`).toHaveLength(1);
  return rows[0] as HTMLElement;
}

/** A Release Readiness step's text (the hero repeats some step titles). */
function step(title: string): string {
  const steps = Array.from(document.querySelectorAll("ol > li")).filter(
    (li) => li.querySelector("p")?.textContent === title,
  );
  expect(steps, `one readiness step titled ${title}`).toHaveLength(1);
  return steps[0].textContent ?? "";
}

describe("Deployments (default build) states only what the record says", () => {
  const seed = (): Array<[unknown[], unknown]> => [
    [["/api/clients"], clients],
    [["/api/tests"], tests],
    [["/api/findings/summary"], summaryOf([{ clientId: "c1", open: 0 }, { clientId: "c2", open: 0 }])],
  ];

  it("does not call a never-scanned system Clean, nor give it an invented score", () => {
    mount(<Deployments />, seed());
    const text = document.body.textContent ?? "";
    // c1 has no test at all; c2's only test has not run.
    expect(text, "a system nobody scanned is shown as Clean").not.toMatch(/Clean/);
    expect(text, "an invented 0-100 score is shown").not.toMatch(/\b8\/100\b/);
    expect(text).not.toMatch(/\/100|out of 100/);
    for (const name of ["Unscanned App", "Pending App"]) {
      expect(within(row(name)).getAllByText("Not scanned").length, `${name} risk`).toBeGreaterThan(0);
    }
  });

  it("does not claim human approval or production deployment that nothing records", () => {
    mount(<Deployments />, seed());
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/2 of 2 approved for production/);
    expect(text).not.toMatch(/2 systems live in production/);
    expect(step("Human Approval")).toMatch(/Not tracked/);
    expect(step("Deploy")).toMatch(/Not tracked/);
    // Neither step is ticked off.
    expect(step("Human Approval")).not.toContain("✓");
    expect(step("Deploy")).not.toContain("✓");
  });

  it("does not count a pending scan as a scanned system", () => {
    mount(<Deployments />, seed());
    expect(document.body.textContent ?? "").not.toMatch(/1 of 2 scanned|2 of 2 scanned/);
    expect(step("Scan")).toContain("0 of 2 with a completed scan · 1 in flight.");
    expect(step("Review Evidence")).toContain("Awaiting the first completed scan.");
  });

  it("shows no risk score for anyone: Athena computes none", () => {
    mount(<Deployments />, seed());
    const tile = screen.getByText("Risk Score").closest("div")?.parentElement?.textContent ?? "";
    expect(tile).toContain("—");
    expect(tile).toContain("Not scored");
  });

  it("reads risk and findings from the latest completed scan, not a newer one still running", () => {
    const earlier = new Date(Date.now() - 86_400_000).toISOString();
    mount(<Deployments />, [
      [["/api/clients"], [clients[0]]],
      [["/api/tests"], [
        {
          id: "done", clientId: "c1", testType: "penetration-test", status: "completed", severity: "high",
          completedAt: earlier, startedAt: earlier, vulnerabilitiesFound: 4,
          criticalCount: 1, highCount: 2, mediumCount: 1, lowCount: 0,
        },
        {
          id: "running", clientId: "c1", testType: "vulnerability-scan", status: "running", severity: null,
          completedAt: null, startedAt: now(), vulnerabilitiesFound: 0,
          criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
        },
      ]],
      [["/api/findings/summary"], summaryOf([{ clientId: "c1", open: 3, critical: 1, high: 2 }])],
    ]);
    const r = row("Unscanned App");
    expect(within(r).getByText("Running")).toBeTruthy();
    expect(within(r).getByText("High")).toBeTruthy();
    expect(r.textContent).toContain("4 (1C / 2H)");
    expect(step("Scan")).toContain("1 of 1 with a completed scan · 1 in flight.");
    // Findings to review come from the open findings on record.
    expect(step("Review Evidence")).toContain("1 system with open findings to review.");
  });

  it("does not call a completed scan with nothing reported Clean", () => {
    mount(<Deployments />, [
      [["/api/clients"], [clients[0]]],
      [["/api/tests"], [{
        id: "done", clientId: "c1", testType: "penetration-test", status: "completed", severity: null,
        completedAt: now(), startedAt: now(), vulnerabilitiesFound: 0,
        criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      }]],
      [["/api/findings/summary"], summaryOf([{ clientId: "c1", open: 0 }])],
    ]);
    const r = row("Unscanned App");
    expect(r.textContent).not.toMatch(/Clean/);
    expect(within(r).getByText("None reported")).toBeTruthy();
    // Done only when neither the tracked findings nor the latest completed
    // scan reports anything, and the sentence says it covers both.
    expect(step("Review Evidence")).toContain(
      "No open or in-review tracked findings, and no site's latest completed scan reported any.",
    );
    expect(step("Review Evidence")).toContain("✓");
  });

  it("reads failed sources as unknown, never as an empty estate", async () => {
    const { client } = mount(<Deployments />, []);
    await waitFor(() => expect(client.getQueryState(["/api/clients"])?.status).toBe("error"));
    await waitFor(() => expect(client.getQueryState(["/api/tests"])?.status).toBe("error"));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/No systems on record yet/);
    expect(text).toMatch(/Could not load systems: source failed/);
    for (const label of ["Total Deployments", "Active Systems", "Scans Pending", "Paused"]) {
      const tile = screen.getByText(label).closest("div")?.parentElement;
      expect(tile?.querySelector(".athena-figure")?.textContent, `${label} tile`).toBe("—");
    }
  });

  it("reads a failed findings summary as unknown in the review step", async () => {
    const { client } = mount(<Deployments />, [
      [["/api/clients"], clients],
      [["/api/tests"], [{ ...tests[0], status: "completed", completedAt: now() }]],
    ]);
    await waitFor(() => expect(client.getQueryState(["/api/findings/summary"])?.status).toBe("error"));
    expect(step("Review Evidence")).toMatch(/Could not load findings: source failed/);
    expect(step("Review Evidence")).not.toContain("✓");
  });
});
