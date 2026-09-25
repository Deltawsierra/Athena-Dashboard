// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactElement } from "react";

import Overview from "@/pages/Overview";
import Risks from "@/pages/Risks";
import { summarizeFindings } from "../server/findings-summary";

/**
 * PR #52 round 3, F2/F3/F5, the screens' half. The all-clear sentences said
 * "no client's latest completed scan reported one" and "the latest completed
 * scan reported no critical or high one" whenever the summary's untrackedScan
 * was null. That null only ever meant "nothing untracked", and it was null
 * for scans that plainly reported a critical: one filed at the wrong severity
 * (A), and one filed, then acknowledged (C).
 *
 * Each all-clear now states exactly what it covers -- open or in-review
 * tracked findings, and whether every critical/high result of each site's
 * latest completed scan has a finding behind it -- and says accepted risks
 * and verified fixes are not counted. A and C no longer reach it at all.
 *
 * The summaries are computed by the server's own summarizeFindings from the
 * records the routes write. Adapted from the adversarial reproducer
 * r3-untracked-render.test.tsx.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const now = new Date();
const iso = now.toISOString();
const CLIENTS = [{ id: "c1", name: "Acme", company: "Acme", status: "active", lastTestDate: null, notes: null }];
const SITES = [{ id: "s1", clientId: "c1", environment: "production" }];
// An engine scan that completed inline and reported 1 critical + 1 medium on
// the same (type, endpoint): one issue. Before round 3 ingest filed it at the
// FIRST severity -- medium -- which is what a database written then holds.
const ENGINE_TEST = {
  id: "t1", clientId: "c1", siteId: "s1", testType: "vulnerability-scan", status: "completed", severity: "critical",
  startedAt: iso, completedAt: iso, vulnerabilitiesFound: 2, criticalCount: 1, highCount: 0, mediumCount: 1, lowCount: 0,
};
const finding = (over: Record<string, unknown>) => ({
  id: "f1", clientId: "c1", siteId: "s1", type: "sql_injection", severity: "medium", message: "SQL error with crafted payload",
  status: "open", firstSeenAt: now, lastSeenAt: now, target: "https://app.example", endpoint: "https://app.example/login",
  ownerId: null, sightings: [], checks: [], ...over,
});

/** What the test filed, as storage counts it: its finding's severity, if critical or high. */
function filedBy(findings: Array<ReturnType<typeof finding>>) {
  const counts = { critical: 0, high: 0 };
  for (const one of findings) {
    if (one.severity === "critical" || one.severity === "high") counts[one.severity] += 1;
  }
  return new Map([["t1", counts]]);
}

function mount(ui: ReactElement, findings: Array<ReturnType<typeof finding>>) {
  const summary = JSON.parse(JSON.stringify(summarizeFindings({
    clients: CLIENTS, sites: SITES, findings: findings as never,
    tests: [{ ...ENGINE_TEST, startedAt: now, completedAt: now }] as never,
    filed: filedBy(findings),
  })));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
      queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); } } },
  });
  const counts = { open: 0, acknowledged: 0, accepted: 0, fixed: 0 } as Record<string, number>;
  for (const f of findings) counts[f.status as string] += 1;
  const seed: Array<[unknown[], unknown]> = [
    [["/api/clients"], CLIENTS], [["/api/sites"], SITES], [["/api/tests"], [ENGINE_TEST]],
    [["/api/findings/summary"], summary], [["/api/assurance/deployments"], []],
    [["/api/findings", { clientId: "c1" }], { findings: JSON.parse(JSON.stringify(findings)), counts }],
    [["/api/users/assignable"], []],
    [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
    [["/api/auth/check"], { authenticated: true, user: null }],
  ];
  for (const [k, v] of seed) client.setQueryData(k, v);
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const OVERVIEW_ALL_CLEAR =
  "Nothing flagged: no client has an open or in-review critical or high finding, every critical or high result of each site's latest completed scan is tracked as a finding, and every client has a completed scan. Accepted risks and verified fixes are not counted as open.";
const RISKS_ALL_CLEAR =
  "No open or in-review tracked findings, and every critical or high result of this engagement's latest completed scans is tracked as a finding. Nothing here needs attention right now. Accepted risks and verified fixes are not counted.";

describe("an all-clear says only what the record supports", () => {
  it("A: a scan whose critical was filed as a medium is flagged for it on the Overview, not cleared", () => {
    mount(<Overview />, [finding({})]);
    const attention = screen.getByTestId("overview-panel-attention").textContent ?? "";
    expect(attention).not.toMatch(/Nothing flagged/);
    expect(attention).not.toMatch(/no client's latest completed scan reported one/);
    expect(attention).toMatch(/Latest completed scan reported 1 critical \/ 0 high that are not tracked as findings/);
  });

  it("A: and Risks names the critical it cannot see", () => {
    mount(<Risks />, [finding({ status: "fixed" })]);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain(RISKS_ALL_CLEAR);
    expect(text).toMatch(/the latest completed scan reported 1 critical \/ 0 high that are not tracked as findings/);
  });

  it("C: an acknowledged critical is still open: Risks leads with it, and gives no all-clear", () => {
    mount(<Risks />, [finding({ type: "rce", severity: "critical", message: "RCE", status: "acknowledged" })]);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/the latest completed scan reported no critical or high one/);
    expect(text).not.toMatch(/Nothing here needs attention/);
    expect(text).toMatch(/"RCE" — critical severity on https:\/\/app\.example\./);
    // And the headline figures count it as open.
    const tile = (label: string) => {
      let node: Element | null = Array.from(document.querySelectorAll(".athena-label")).find((el) => el.textContent === label) ?? null;
      while (node && !node.querySelector(".athena-figure")) node = node.parentElement;
      return node?.querySelector(".athena-figure")?.textContent;
    };
    expect(tile("Total Open Risks")).toBe("1");
    expect(tile("Critical Risks")).toBe("1");
    expect(tile("Acknowledged")).toBe("1");
  });

  it("C: and the Overview flags the client with it", () => {
    mount(<Overview />, [finding({ type: "rce", severity: "critical", message: "RCE", status: "acknowledged" })]);
    const attention = screen.getByTestId("overview-panel-attention").textContent ?? "";
    expect(attention).not.toMatch(/Nothing flagged/);
    expect(attention).toMatch(/1 open critical\/high finding/);
  });

  it("several sites' latest scans with untracked results are said as several, and added up", () => {
    const tests = [
      { ...ENGINE_TEST, id: "p1", testType: "penetration-test", criticalCount: 1, highCount: 0, findings: null },
      { ...ENGINE_TEST, id: "p2", siteId: "s2", testType: "penetration-test", criticalCount: 0, highCount: 4, findings: null },
    ];
    const summary = JSON.parse(JSON.stringify(summarizeFindings({
      clients: CLIENTS, sites: SITES, findings: [],
      tests: tests.map((t) => ({ ...t, startedAt: now, completedAt: now })) as never,
    })));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); } } },
    });
    for (const [k, v] of [
      [["/api/clients"], CLIENTS], [["/api/sites"], SITES], [["/api/tests"], tests],
      [["/api/findings/summary"], summary], [["/api/assurance/deployments"], []],
      [["/api/findings", { clientId: "c1" }], { findings: [], counts: { open: 0, acknowledged: 0, accepted: 0, fixed: 0 } }],
      [["/api/users/assignable"], []],
      [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
      [["/api/auth/check"], { authenticated: true, user: null }],
    ] as Array<[unknown[], unknown]>) client.setQueryData(k, v);
    render(<QueryClientProvider client={client}><Overview /></QueryClientProvider>);
    expect(screen.getByTestId("overview-panel-attention").textContent).toMatch(
      /2 latest completed scans \(one per site\) reported 1 critical \/ 4 high that are not tracked as findings/,
    );
    cleanup();
    render(<QueryClientProvider client={client}><Risks /></QueryClientProvider>);
    expect(document.body.textContent).toMatch(
      /but 2 latest completed scans \(one per site\) reported 1 critical \/ 4 high that are not tracked as findings/,
    );
  });

  it("a critical that was filed and then verified fixed: the all-clear says what it covers, not that none was reported", () => {
    mount(<Overview />, [finding({ type: "rce", severity: "critical", message: "RCE", status: "fixed" })]);
    expect(screen.getByTestId("overview-panel-attention").textContent).toContain(OVERVIEW_ALL_CLEAR);
    cleanup();
    mount(<Risks />, [finding({ type: "rce", severity: "critical", message: "RCE", status: "fixed" })]);
    expect(document.body.textContent).toContain(RISKS_ALL_CLEAR);
  });
});
