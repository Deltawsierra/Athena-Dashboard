// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactElement } from "react";

import Overview from "@/pages/Overview";
import Deployments from "@/pages/Deployments";
import Evidence from "@/pages/Evidence";
import Risks from "@/pages/Risks";
import Compliance from "@/pages/Compliance";

/**
 * Rows the installer wrote for a demo are real database rows, so every screen
 * that reads clients, tests, documents or findings counts them. The README
 * promised "a notice on each screen that shows them", but only Overview, Tests
 * and Documents carried one: Deployments showed the seeded "Acme Corporation"
 * as "High ... 15 (3C / 5H)" under Highest Risk Deployments with nothing on
 * the page saying no scan produced it. Seeding is now off by default; where a
 * demo install has turned it on, each of these screens says so.
 *
 * Adapted from the adversarial reproducer for PR #52 round 1 (F3).
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

// Exactly what server/init-data.ts writes when ATHENA_SEED_SAMPLE_DATA=1.
const SEEDED_CLIENTS = [
  { id: "a", name: "Acme Corporation", company: "Acme Corp", status: "active", lastTestDate: null, notes: null },
];
const SEEDED_SITES = [{ id: "s", clientId: "a", environment: "production" }];
const SEEDED_TESTS = [
  {
    id: "t", clientId: "a", siteId: "s", testType: "penetration-test", status: "completed", severity: "high",
    completedAt: now(), startedAt: now(), vulnerabilitiesFound: 15,
    criticalCount: 3, highCount: 5, mediumCount: 4, lowCount: 3,
  },
];
const SEEDED_DOCS = [
  {
    id: "d", title: "Security Assessment Report Q1 2024", description: null, documentType: "Report",
    fileUrl: null, createdAt: now(), createdBy: null,
  },
];
const EMPTY_SUMMARY = {
  clients: 1,
  open: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  byEnvironment: [], byMonth: [], topOpen: [],
  byClient: [{ clientId: "a", open: 0, critical: 0, high: 0, latestSeriousSeenAt: null }],
};

const SEEDED = { clients: 3, sites: 4, tests: 3, documents: 3, findings: 23 };
const NONE = { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 };

function mount(ui: ReactElement, sample: typeof SEEDED) {
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
  const seed: Array<[unknown[], unknown]> = [
    [["/api/clients"], SEEDED_CLIENTS],
    [["/api/sites"], SEEDED_SITES],
    [["/api/tests"], SEEDED_TESTS],
    [["/api/documents"], SEEDED_DOCS],
    [["/api/users/assignable"], []],
    [["/api/assurance/deployments"], []],
    [["/api/findings/summary"], EMPTY_SUMMARY],
    [["/api/findings", { clientId: "a" }], { findings: [], counts: {} }],
    [["/api/compliance/a"], {
      client: { id: "a", name: "Acme Corporation" }, testsConsidered: 1, scannersLoaded: null, rows: [],
      summary: { version: "4.0.3", failing: 0, tested: 0, notRun: 0, notCovered: 0, total: 0 },
    }],
    [["/api/sample-data"], sample],
    [["/api/auth/check"], { authenticated: true, user: null }],
  ];
  for (const [key, value] of seed) client.setQueryData(key, value);
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const SCREENS: Array<[string, () => ReactElement]> = [
  ["Overview", () => <Overview />],
  ["Deployments", () => <Deployments />],
  ["Evidence", () => <Evidence />],
  ["Risks", () => <Risks />],
  ["Compliance", () => <Compliance />],
];

describe("seeded rows are disclosed on every screen that reads them", () => {
  for (const [name, ui] of SCREENS) {
    it(`${name} says seeded rows are on screen when a demo install wrote them`, () => {
      mount(ui(), SEEDED);
      const notice = screen.queryByTestId("notice-sample-data");
      expect(notice, `${name} shows seeded rows with no notice`).not.toBeNull();
      expect(notice?.textContent).toMatch(/written by the installer/);
    });

    it(`${name} shows no notice when nothing seeded is on record`, () => {
      mount(ui(), NONE);
      expect(screen.queryByTestId("notice-sample-data")).toBeNull();
    });
  }

  it("Deployments names the seeded severity counts as not from a scan", () => {
    mount(<Deployments />, SEEDED);
    // The seeded test's figures are on the page ...
    expect(document.body.textContent).toContain("(3C / 5H)");
    // ... and so is the sentence that says what they are.
    expect(screen.getByTestId("notice-sample-data").textContent).toMatch(/No scan produced those findings/);
  });
});
