// @vitest-environment jsdom
import { it, expect, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";

import Evidence from "@/pages/Evidence";

/**
 * Q7: round 3 taught Deployments (and the summary) that a completed engine
 * test finished inline before the inline-count fix -- every count zero beside
 * real results (shared/latest-scans.ts countsNotRecorded) -- has counts that
 * were never recorded, and says "Counts not recorded", never 0. Evidence's
 * "Latest Completed Scan" card (admin, routed at /evidence) still read that
 * row as "reported 0 critical and 0 high findings" -- a measurement nobody
 * took, beside a critical the results show. It now says the counts were not
 * recorded; a row whose counts were recorded still reads them.
 */
afterEach(cleanup);

it("Evidence does not read unrecorded counts as zero", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async ({ queryKey }) => { throw new Error(`source failed: ${JSON.stringify(queryKey)}`); } } } });
  const unrecorded = {
    id: "inline-old", clientId: "c1", status: "completed", severity: null, testType: "vulnerability-scan",
    startedAt: new Date(Date.now() - 7_200_000).toISOString(), completedAt: new Date(Date.now() - 3_600_000).toISOString(),
    vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
    findings: { runId: "run-1", target: "https://app.example", results: [
      { type: "sql_injection", severity: "critical", evidence: { endpoint: "https://app.example/login" } },
    ] },
  };
  for (const [k, v] of [
    [["/api/documents"], []], [["/api/users/assignable"], []],
    [["/api/clients"], [{ id: "c1", name: "Payments API", status: "active" }]], [["/api/tests"], [unrecorded]],
  ] as Array<[unknown[], unknown]>) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}><Evidence /></QueryClientProvider>);
  const card = screen.getByTestId("evidence-latest-scan").textContent ?? "";
  expect(card).not.toMatch(/reported 0 critical and 0 high/);
  expect(card).toMatch(/Its latest completed scan returned results, but its counts were not recorded/);
});

it("Evidence still reads counts that were recorded", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async ({ queryKey }) => { throw new Error(`source failed: ${JSON.stringify(queryKey)}`); } } } });
  const recorded = {
    id: "counted", clientId: "c1", status: "completed", severity: "critical", testType: "vulnerability-scan",
    startedAt: new Date(Date.now() - 7_200_000).toISOString(), completedAt: new Date(Date.now() - 3_600_000).toISOString(),
    vulnerabilitiesFound: 1, criticalCount: 1, highCount: 0, mediumCount: 0, lowCount: 0,
    findings: { runId: "run-2", target: "https://app.example", results: [
      { type: "sql_injection", severity: "critical", evidence: { endpoint: "https://app.example/login" } },
    ] },
  };
  for (const [k, v] of [
    [["/api/documents"], []], [["/api/users/assignable"], []],
    [["/api/clients"], [{ id: "c1", name: "Payments API", status: "active" }]], [["/api/tests"], [recorded]],
  ] as Array<[unknown[], unknown]>) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}><Evidence /></QueryClientProvider>);
  expect(screen.getByTestId("evidence-latest-scan").textContent).toMatch(/reported 1 critical and 0 high finding \(/);
});
