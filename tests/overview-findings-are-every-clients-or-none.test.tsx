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
 * Here one of two clients' findings fails, or never arrives, and the page must
 * say "—" with the reason, or "…", rather than the other client's total.
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

const CLIENTS = [
  { id: "c1", name: "Northwind Checkout" },
  { id: "c2", name: "Harbor Payroll" },
];
const SITES = [
  { id: "s1", clientId: "c1", environment: "production" },
  { id: "s2", clientId: "c2", environment: "staging" },
];
// c1's findings arrive: one open high. c2's are the ones that fail or hang.
const C1_FINDINGS = [
  {
    id: "f1", clientId: "c1", siteId: "s1", type: "sql_injection", severity: "high",
    message: "SQL injection in /login", status: "open", firstSeenAt: iso(3), lastSeenAt: iso(3),
  },
];

type C2 = "rejects" | "never resolves";

function mount(c2: C2) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          const [path, params] = queryKey as [string, { clientId?: string } | undefined];
          if (path === "/api/findings" && params?.clientId === "c2") {
            if (c2 === "never resolves") return new Promise(() => {});
            throw new Error("c2's findings could not be read");
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
  client.setQueryData(["/api/findings", { clientId: "c1" }], { findings: C1_FINDINGS, counts: {} });
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
  it("reads one client's failed findings as unknown, not as the other client's total", async () => {
    mount("rejects");
    await waitFor(() => expect(screen.getByText("Could not load findings")).toBeTruthy());

    // c1 alone would read "1" and "0 critical · 1 high". Neither may show.
    expect(figureOf("overview-metric-findings")).toBe("—");
    expect(document.body.textContent).not.toContain("0 critical · 1 high");
    expect(postureFigures()).toEqual(["—", "—", "—"]);

    // Every panel drawn from findings says it could not load them, and why.
    for (const id of ["trend", "environments", "issues", "attention"]) {
      const panel = screen.getByTestId(`overview-panel-${id}`);
      expect(within(panel).getByText(/^Could not load .*c2's findings could not be read/)).toBeTruthy();
    }
    // c1's finding is not listed as if it were the whole estate's top issue.
    expect(screen.queryByText("SQL injection in /login")).toBeNull();
  });

  it("reads one client's findings still loading as loading, not as the other client's total", async () => {
    const client = mount("never resolves");
    await waitFor(() =>
      expect(client.getQueryState(["/api/findings", { clientId: "c2" }])?.fetchStatus).toBe("fetching"),
    );

    expect(figureOf("overview-metric-findings")).toBe("…");
    expect(postureFigures()).toEqual(["…", "…", "…"]);
    // The trend and the environment split wait for every client, and say so.
    for (const id of ["trend", "environments", "issues"]) {
      const panel = screen.getByTestId(`overview-panel-${id}`);
      expect(within(panel).getByText("Loading…"), `${id} drew a partial picture`).toBeTruthy();
    }
    expect(screen.queryByText("SQL injection in /login")).toBeNull();
    expect(screen.queryByText("Production")).toBeNull();
  });
});
