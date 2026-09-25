// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";

import Overview from "@/pages/Overview";

/**
 * The Overview's findings figures are over every client's findings, or they
 * are not shown: a total over whichever clients happened to load would be
 * wrong and look right. Nothing tested that rule -- deleting it left every
 * Overview test green (adversary round 1, F6: mutants M1 and M1b survived).
 *
 * The rule now lives in GET /api/findings/summary, which reads every client's
 * findings and answers an error if any one of them cannot be read
 * (tests/findings-summary.test.ts holds that half). This holds the page's
 * half: when the summary fails the page says "—" and why, on every figure and
 * panel drawn from findings; while it is loading, "…" and "Loading…"; and in
 * neither case does anything from another source stand in for it.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

const CLIENTS = [
  { id: "c1", name: "Northwind Checkout" },
  { id: "c2", name: "Harbor Payroll" },
];
const SITES = [
  { id: "s1", clientId: "c1", environment: "production" },
  { id: "s2", clientId: "c2", environment: "staging" },
];
// What the route answers when one engagement's findings cannot be read.
const REFUSAL = "Could not read every engagement's findings, so no totals are given.";

type Summary = "rejects" | "never resolves";

function mount(summary: Summary) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          if (queryKey[0] === "/api/findings/summary") {
            if (summary === "never resolves") return new Promise(() => {});
            throw new Error(REFUSAL);
          }
          throw new Error(`unexpected fetch for ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  client.setQueryData(["/api/clients"], CLIENTS);
  client.setQueryData(["/api/sites"], SITES);
  client.setQueryData(["/api/tests"], []);
  client.setQueryData(["/api/assurance/deployments"], []);
  client.setQueryData(["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 });
  client.setQueryData(["/api/auth/check"], { authenticated: true, user: null });
  render(
    <QueryClientProvider client={client}>
      <Overview />
    </QueryClientProvider>,
  );
  return client;
}

function figureOf(testId: string): string {
  return screen.getByTestId(testId).querySelector(".athena-figure")?.textContent ?? "";
}

function postureFigures(): string[] {
  const posture = screen.getByTestId("overview-panel-posture");
  return Array.from(posture.querySelectorAll(".athena-figure")).map((el) => el.textContent ?? "");
}

describe("the Overview's findings figures are every client's, or none", () => {
  it("reads a findings summary the server refused as unknown, never as zero", async () => {
    mount("rejects");
    await waitFor(() => expect(screen.getByText("Could not load findings")).toBeTruthy());

    expect(figureOf("overview-metric-findings")).toBe("—");
    expect(postureFigures()).toEqual(["—", "—", "—"]);

    // Every panel drawn from findings says it could not load them, and why.
    for (const id of ["trend", "environments", "issues", "attention"]) {
      const panel = screen.getByTestId(`overview-panel-${id}`);
      expect(
        within(panel).getByText(/^Could not load .*no totals are given\.$/),
        `${id} did not say why it is empty`,
      ).toBeTruthy();
    }
    // No all-clear stands in for the missing answer.
    expect(screen.queryByText(/No open (tracked )?findings/)).toBeNull();
    expect(screen.queryByText(/Nothing flagged/)).toBeNull();
  });

  it("reads a findings summary still loading as loading, never as zero", async () => {
    const client = mount("never resolves");
    await waitFor(() =>
      expect(client.getQueryState(["/api/findings/summary"])?.fetchStatus).toBe("fetching"),
    );

    expect(figureOf("overview-metric-findings")).toBe("…");
    expect(postureFigures()).toEqual(["…", "…", "…"]);
    // The trend and the environment split wait for the whole estate, and say so.
    for (const id of ["trend", "environments", "issues", "attention"]) {
      const panel = screen.getByTestId(`overview-panel-${id}`);
      expect(within(panel).getByText("Loading…"), `${id} drew a picture before the findings arrived`).toBeTruthy();
    }
    expect(screen.queryByText(/No open (tracked )?findings/)).toBeNull();
  });
});
