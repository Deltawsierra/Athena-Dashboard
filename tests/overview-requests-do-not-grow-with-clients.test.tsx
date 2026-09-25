// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor, screen, cleanup } from "@testing-library/react";

import Overview from "@/pages/Overview";

/**
 * The Overview asked for every client's findings separately. With 200 clients
 * it issued 206 requests, 200 of them /api/findings -- each of which also
 * loaded every finding's sightings and checks -- to draw a handful of counts
 * (adversary round 1, F11). It now reads one summary, whatever the number of
 * clients.
 *
 * Adapted from the adversarial reproducer ("fan-out").
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

describe("Overview request fan-out", () => {
  it("does not grow with the number of clients", async () => {
    const N = 200;
    const calls: string[] = [];
    const clients = Array.from({ length: N }, (_, i) => ({ id: `c${i}`, name: `Client ${i}` }));
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false, staleTime: Infinity, gcTime: Infinity,
          queryFn: async ({ queryKey }) => {
            calls.push(String(queryKey[0]));
            switch (queryKey[0]) {
              case "/api/clients": return clients;
              case "/api/sites": case "/api/tests": case "/api/assurance/deployments": return [];
              case "/api/findings/summary": return {
                clients: N, open: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                byEnvironment: [], byMonth: [], topOpen: [], byClient: [],
              };
              case "/api/sample-data": return { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 };
              case "/api/auth/check": return { authenticated: true, user: null };
              default: throw new Error(`unexpected ${JSON.stringify(queryKey)}`);
            }
          },
        },
      },
    });
    render(<QueryClientProvider client={client}><Overview /></QueryClientProvider>);
    await waitFor(() =>
      expect(screen.getByTestId("overview-metric-systems").querySelector(".athena-figure")?.textContent).toBe("200"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("overview-metric-findings").querySelector(".athena-figure")?.textContent).toBe("0"),
    );
    expect(calls.filter((c) => c === "/api/findings"), "a findings request per client").toHaveLength(0);
    expect(calls.filter((c) => c === "/api/findings/summary")).toHaveLength(1);
    expect(calls.length, `requests: ${calls.join(", ")}`).toBeLessThan(20);
  });
});
