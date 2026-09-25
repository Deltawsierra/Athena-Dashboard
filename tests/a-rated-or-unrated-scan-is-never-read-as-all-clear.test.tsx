// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { ReactElement } from "react";

import { makeApp, signIn } from "./helpers";
import Risks from "@/pages/Risks";
import Overview from "@/pages/Overview";

/**
 * PR #52 round 5, R5-F. The all-clear rule ("a critical any site's latest
 * scan reported is never read as clear") was decided from the findings
 * summary's `untrackedScan`, which counted a scan's criticals from
 * criticalCount / highCount alone. A pentest recorded on the Tests screen
 * exactly as its create form sends it -- "Severity: Critical, Total
 * Vulnerabilities: 2", counts left at 0 -- had no untrackedScan, and Risks
 * said "every critical or high result of this engagement's latest completed
 * scans is tracked as a finding. Nothing here needs attention right now."
 * beside it; so did one recorded "Total Vulnerabilities: 4" with no severity.
 *
 * The summary now reads each scan whole (shared/latest-scans.ts readScan): a
 * rating with no count at it is at least one result at that rating, flagged
 * as rated but not counted, and results nobody rated are carried as unrated.
 * Neither is ever read as tracked. End to end through the real server.
 * Adapted from the round-5 reproducer r5-f-risks-all-clear-beside-a-rated-critical.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

let summary: any;
let clients: any[];
let tests: any[];
let ratedId = "";
let unratedId = "";
const findingsOf = new Map<string, unknown>();

beforeAll(async () => {
  const admin = await signIn(await makeApp());
  const engagement = async (name: string, body: Record<string, unknown>) => {
    const clientId = (await admin.post("/api/clients").send({ name, company: name, email: `${name.length}@x.test` })).body.id;
    const siteId = (await admin.post("/api/sites").send({ clientId, name, url: `https://${clientId}.example` })).body.id;
    // The Tests screen's create body.
    const created = await admin.post("/api/tests").send({
      clientId, siteId, testType: "penetration-test", status: "completed",
      criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, ...body,
    });
    expect(created.status).toBe(201);
    findingsOf.set(clientId, (await admin.get(`/api/findings?clientId=${clientId}`)).body);
    return clientId;
  };
  ratedId = await engagement("Payments API", {
    severity: "critical", vulnerabilitiesFound: 2, summary: "Two SQL injections", findings: { details: "2 critical SQLi" },
  });
  unratedId = await engagement("Unrated API", { severity: null, vulnerabilitiesFound: 4 });
  summary = (await admin.get("/api/findings/summary")).body;
  clients = (await admin.get("/api/clients")).body;
  tests = (await admin.get("/api/tests")).body;
});

function mount(ui: ReactElement, clientId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async ({ queryKey }) => { throw new Error(`unseeded: ${JSON.stringify(queryKey)}`); } } } });
  const only = <T extends { id?: string; clientId?: string }>(list: T[], key: "id" | "clientId") =>
    clientId ? list.filter((one) => one[key] === clientId) : list;
  for (const [k, v] of [
    [["/api/clients"], only(clients, "id")], [["/api/tests"], only(tests, "clientId")], [["/api/sites"], []],
    [["/api/users/assignable"], []], [["/api/findings/summary"], summary], [["/api/assurance/deployments"], []],
    [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
    [["/api/auth/check"], { authenticated: true, user: null }],
    ...Array.from(findingsOf.entries()).map(([id, body]) => [["/api/findings", { clientId: id }], body]),
  ] as Array<[unknown[], unknown]>) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const RISKS_ALL_CLEAR = /every critical or high result of this engagement's latest completed scans is tracked|Nothing here needs attention/;

describe("a scan rated critical, or whose results nobody rated, is never read as all clear", () => {
  it("the findings summary flags both: at least one critical for the rating, and the unrated results", () => {
    const own = (id: string) => summary.byClient.find((one: { clientId: string }) => one.clientId === id).untrackedScan;
    expect(own(ratedId)).toMatchObject({ critical: 1, high: 0, ratedNotCounted: 1, unrated: 0, scans: 1 });
    expect(own(unratedId)).toMatchObject({ critical: 0, high: 0, ratedNotCounted: 0, unrated: 4, scans: 1 });
  });

  it("Risks gives no all-clear beside the rated critical, and says what the record holds", () => {
    mount(<Risks />, ratedId);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(RISKS_ALL_CLEAR);
    expect(text).toMatch(
      /but the latest completed scan reported at least 1 critical \/ 0 high that are not tracked as findings \(rated, not counted by severity\)\./,
    );
  });

  it("Risks gives no all-clear beside four results nobody rated", () => {
    mount(<Risks />, unratedId);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(RISKS_ALL_CLEAR);
    expect(text).toMatch(/reported 4 results with no severity recorded, so whether any is critical or high is not known\./);
  });

  it("the Overview flags both clients, and says nothing is clear", () => {
    mount(<Overview />);
    const attention = screen.getByTestId("overview-panel-attention").textContent ?? "";
    expect(attention).not.toMatch(/Nothing flagged/);
    expect(attention).toMatch(/Payments API.*Latest completed scan reported at least 1 critical \/ 0 high that are not tracked as findings \(rated, not counted by severity\)/);
    expect(attention).toMatch(/Unrated API.*Latest completed scan reported 4 results with no severity recorded/);
    // The rated scan is pilled Critical; results nobody rated get no pill: they
    // are not known to be high.
    const row = (name: string) => Array.from(screen.getByTestId("overview-panel-attention").querySelectorAll("li"))
      .find((li) => li.textContent?.includes(name)) as HTMLElement;
    expect(within(row("Payments API")).getByText("Critical")).toBeTruthy();
    expect(within(row("Unrated API")).queryByText(/^(Critical|High|Medium|Low|Info)$/)).toBeNull();
    const issues = screen.getByTestId("overview-panel-issues").textContent ?? "";
    expect(issues).toMatch(/2 clients have critical or high results, or results with no severity recorded, from a latest completed scan that are not tracked as findings/);
  });
});
