// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import type { ReactElement } from "react";

import Overview from "@/pages/Overview";
import DeletionManagement from "@/pages/DeletionManagement";
import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";

/**
 * PR #52 round 2, R2-E (demo installs only: ATHENA_SEED_SAMPLE_DATA=1).
 *
 * 1. SampleDataNotice read /api/sample-data and returned null when it had no
 *    data -- which is also what it did when that request FAILED. On a demo
 *    install the seeded Acme/TechStart rows then rendered with no disclosure
 *    at all: a failed source read as "nothing seeded here". It now says it
 *    could not check, and a count it failed to refresh is not shown as current.
 * 2. /deletion lists and counts the seeded clients, tests and documents, and
 *    /athena and /pentest list seeded clients and sites in their pickers, with
 *    no notice. Each now carries one.
 *
 * Adapted from the adversarial reproducer r2-e-sample-notice-gaps.test.tsx.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

const now = new Date().toISOString();
const SEEDED = { clients: 3, sites: 4, tests: 3, documents: 3, findings: 23 };
const NONE = { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 };
const CLIENTS = [{ id: "a", name: "Acme Corporation", company: "Acme Corp", status: "active", lastTestDate: null, notes: null, isSample: true }];
const TESTS = [{ id: "t", clientId: "a", siteId: "s", testType: "penetration-test", status: "completed", severity: "high",
  startedAt: now, completedAt: now, vulnerabilitiesFound: 15, criticalCount: 3, highCount: 5, mediumCount: 4, lowCount: 3, isSample: true }];
const DOCS = [{ id: "d", clientId: "a", title: "Security Assessment Report Q1 2024", documentType: "Report", isSample: true }];

function mount(ui: ReactElement, sampleData: unknown | "fail", failing: () => boolean = () => true) {
  const answers = new Map<string, unknown>();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
      queryFn: async ({ queryKey }) => {
        const key = JSON.stringify(queryKey);
        if (!failing() && answers.has(key)) return answers.get(key);
        throw new Error(`source failed: ${key}`);
      } } },
  });
  const seed: Array<[unknown[], unknown]> = [
    [["/api/clients"], CLIENTS], [["/api/sites"], [{ id: "s", clientId: "a", name: "Acme Production", environment: "production" }]],
    [["/api/tests"], TESTS], [["/api/documents"], DOCS], [["/api/assurance/deployments"], []],
    [["/api/findings/summary"], { clients: 1, open: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      byEnvironment: [], byMonth: [], topOpen: [],
      byClient: [{ clientId: "a", open: 0, critical: 0, high: 0, latestSeriousSeenAt: null,
        untrackedScan: { testId: "t", completedAt: now, critical: 3, high: 5 } }] }],
    [["/api/auth/check"], { authenticated: true, user: null }],
  ];
  if (sampleData !== "fail") seed.push([["/api/sample-data"], sampleData]);
  for (const [k, v] of seed) {
    client.setQueryData(k, v);
    answers.set(JSON.stringify(k), v);
  }
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return client;
}

describe("seeded rows stay disclosed", () => {
  it("Overview says it could not check for sample rows when the count cannot be read", async () => {
    const client = mount(<Overview />, "fail");
    await waitFor(() => expect(client.getQueryState(["/api/sample-data"])?.status).toBe("error"));
    // The seeded client and its seeded scan are on screen...
    expect(document.body.textContent).toMatch(/15 findings reported/);
    // ...and the page says it could not tell whether they are seeded.
    const notice = screen.queryByTestId("notice-sample-data");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toMatch(/Could not check for installer sample rows: source failed/);
    expect(notice?.textContent).not.toMatch(/written by the installer for a demo/);
  });

  it("a count it failed to refresh is not shown as the current one", async () => {
    let failing = false;
    const client = mount(<Overview />, SEEDED, () => failing);
    expect(screen.getByTestId("notice-sample-data").textContent).toMatch(/3 clients, 4 sites, 3 tests and 23 findings/);
    failing = true;
    await act(async () => { await client.refetchQueries({ queryKey: ["/api/sample-data"] }); });
    await waitFor(() => expect(client.getQueryState(["/api/sample-data"])?.status).toBe("error"));
    const notice = screen.getByTestId("notice-sample-data").textContent ?? "";
    expect(notice).toMatch(/Could not check for installer sample rows/);
    expect(notice).not.toMatch(/3 clients, 4 sites/);
  });

  const SCREENS: Array<[string, () => ReactElement, RegExp]> = [
    ["Deletion management", () => <DeletionManagement />, /3 clients, 3 tests and 3 documents/],
    ["Athena", () => <AthenaScan />, /3 clients and 4 sites/],
    ["Penetration testing", () => <PentestScan />, /3 clients and 4 sites/],
  ];
  for (const [name, ui, said] of SCREENS) {
    it(`${name} discloses the seeded rows it lists`, () => {
      mount(ui(), SEEDED);
      const notice = screen.queryByTestId("notice-sample-data");
      expect(notice, `${name} shows seeded rows with no notice`).not.toBeNull();
      expect(notice?.textContent).toMatch(said);
      expect(notice?.textContent).toMatch(/written by the installer/);
    });

    it(`${name} shows no notice when nothing seeded is on record`, () => {
      mount(ui(), NONE);
      expect(screen.queryByTestId("notice-sample-data")).toBeNull();
    });
  }

  it("Deletion management lists the seeded client beside its notice", () => {
    mount(<DeletionManagement />, SEEDED);
    expect(document.body.textContent).toMatch(/Acme Corporation/);
    expect(screen.queryByTestId("notice-sample-data")).not.toBeNull();
  });
});
