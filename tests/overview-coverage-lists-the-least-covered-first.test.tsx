// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within } from "@testing-library/react";

import Overview from "@/pages/Overview";

/**
 * The coverage panel listed the six best-covered clients and stopped, so an
 * estate with two unscanned clients out of eight read as six rows of "1 of 1
 * site scanned 100%": full coverage, with the clients that lacked it silently
 * dropped (adversary round 1, F10). It now lists the least covered first and
 * says how many it shows of how many, and how many have no completed scan.
 *
 * Adapted from the adversarial reproducer ("coverage panel").
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

function mount(total: number, scanned: number) {
  const clients = Array.from({ length: total }, (_, i) => ({ id: `c${i}`, name: `Client ${i}` }));
  const sites = clients.map((c, i) => ({ id: `s${i}`, clientId: c.id, environment: "production" }));
  // Clients 0..scanned-1 have a completed scan; the rest have none.
  const tests = clients.slice(0, scanned).map((c, i) => ({
    id: `t${i}`, clientId: c.id, siteId: `s${i}`, testType: "scan", status: "completed",
    startedAt: now(), completedAt: now(), vulnerabilitiesFound: 0,
  }));
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => { throw new Error(`source failed: ${JSON.stringify(queryKey)}`); },
      },
    },
  });
  const seed: Array<[unknown[], unknown]> = [
    [["/api/clients"], clients], [["/api/sites"], sites], [["/api/tests"], tests],
    [["/api/assurance/deployments"], []],
    [["/api/findings/summary"], {
      clients: total, open: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      byEnvironment: [], byMonth: [], topOpen: [],
      byClient: clients.map((c) => ({ clientId: c.id, open: 0, critical: 0, high: 0, latestSeriousSeenAt: null })),
    }],
    [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
    [["/api/auth/check"], { authenticated: true, user: null }],
  ];
  for (const [key, value] of seed) client.setQueryData(key, value);
  render(<QueryClientProvider client={client}><Overview /></QueryClientProvider>);
  return screen.getByTestId("overview-panel-coverage");
}

describe("the coverage panel", () => {
  it("lists unscanned clients first, and says how many it shows of how many", () => {
    const coverage = mount(8, 6);
    const names = Array.from(coverage.querySelectorAll("li")).map((li) => li.textContent ?? "");
    expect(names).toHaveLength(6);
    // The two clients with no scan lead the list at 0%.
    expect(names[0]).toMatch(/^Client [67]0 of 1 site scanned0%$/);
    expect(names[1]).toMatch(/^Client [67]0 of 1 site scanned0%$/);
    expect(within(coverage).getByTestId("overview-coverage-note").textContent).toBe(
      "Showing 6 of 8 clients, least covered first. 2 of 8 have no completed scan.",
    );
  });

  it("says so when every client is shown and every one has a completed scan", () => {
    const coverage = mount(3, 3);
    expect(coverage.querySelectorAll("li")).toHaveLength(3);
    expect(within(coverage).getByTestId("overview-coverage-note").textContent).toBe(
      "All 3 clients, least covered first. Every client has a completed scan.",
    );
  });
});
