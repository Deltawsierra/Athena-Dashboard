// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";

import Overview, { trendFromSummary } from "@/pages/Overview";
import { summarizeFindings } from "../server/findings-summary";

/**
 * PR #52 round 2, R2-D: killing tests for four non-equivalent mutants of new
 * branches that survived the whole suite (555 passing) at baed23b. Ported from
 * the adversarial reproducer r2-d-mutant-killers.test.tsx.
 *
 *   M1  server/findings-summary.ts monthKey: getUTCFullYear/getUTCMonth ->
 *       getFullYear/getMonth. Survives because CI and this container run in
 *       UTC, where the two agree; the F11 "UTC month buckets" rule is untested.
 *   M7  Overview trendFromSummary: drop `timeZone: "UTC"` from the label.
 *       Same reason.
 *   M3  client/src/lib/loaded.ts: return `ready` whenever data exists, before
 *       checking isError -- i.e. show the last answer after a failed refetch.
 *       No test refetches; every "failed" test fails the first read.
 *   M8  Overview attention: `sev: own.critical > 0 ? "critical" : "high"` ->
 *       `sev: "high"`. A client with open criticals is pilled "High".
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const EMPTY = { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 };

describe("UTC month buckets hold outside UTC (M1, M7)", () => {
  const saved = process.env.TZ;
  beforeAll(() => { process.env.TZ = "America/Los_Angeles"; });
  afterAll(() => { process.env.TZ = saved; });

  it("server: a finding first seen 2026-03-01T03:00Z is March, not February", () => {
    expect(new Date("2026-03-01T03:00:00Z").getMonth()).toBe(1); // the zone really is in effect
    const s = summarizeFindings({
      clients: [{ id: "c", name: "C" }], sites: [],
      findings: [{
        id: "f", clientId: "c", siteId: null, type: "x", severity: "high", message: null, status: "open",
        firstSeenAt: new Date("2026-03-01T03:00:00Z"), lastSeenAt: new Date("2026-03-01T03:00:00Z"),
      }] as never,
    });
    expect(s.byMonth).toEqual([{ month: "2026-03", critical: 0, high: 1, medium: 0, low: 0 }]);
  });

  it("client: the 2026-03 bucket is labelled Mar 26", () => {
    expect(trendFromSummary([{ month: "2026-03", critical: 0, high: 1, medium: 0, low: 0 }])[0].m).toBe("Mar 26");
  });
});

function mount(seed: Array<[unknown[], unknown]>, fail: () => boolean = () => true) {
  const data = new Map(seed.map(([k, v]) => [JSON.stringify(k), v]));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
      queryFn: async ({ queryKey }) => {
        if (fail()) throw new Error("summary unavailable");
        return data.get(JSON.stringify(queryKey));
      } } },
  });
  for (const [k, v] of seed) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}><Overview /></QueryClientProvider>);
  return client;
}

const SUMMARY = {
  clients: 1,
  open: { total: 4, critical: 1, high: 0, medium: 3, low: 0, info: 0 },
  byEnvironment: [], byMonth: [], topOpen: [],
  byClient: [{ clientId: "c1", open: 4, critical: 1, high: 0, latestSeriousSeenAt: null, untrackedScan: null }],
};
const BASE: Array<[unknown[], unknown]> = [
  [["/api/clients"], [{ id: "c1", name: "Acme" }]],
  [["/api/sites"], []],
  [["/api/tests"], []],
  [["/api/assurance/deployments"], []],
  [["/api/sample-data"], EMPTY],
  [["/api/auth/check"], { authenticated: true, user: null }],
  [["/api/findings/summary"], SUMMARY],
];

describe("Overview figures (M3, M8)", () => {
  it("M3: after a failed refetch the open-findings figure reads unknown, not the last answer", async () => {
    let failing = false;
    const client = mount(BASE, () => failing);
    const tile = () => screen.getByTestId("overview-metric-findings").textContent ?? "";
    expect(tile()).toMatch(/4/);
    failing = true;
    await act(async () => { await client.refetchQueries({ queryKey: ["/api/findings/summary"] }); });
    await waitFor(() => expect(client.getQueryState(["/api/findings/summary"])?.status).toBe("error"));
    expect(tile()).toMatch(/—/);
    expect(tile()).not.toMatch(/\b4\b/);
  });

  it("M8: a client with an open critical finding is pilled Critical, not High", () => {
    mount(BASE, () => false);
    const panel = screen.getByTestId("overview-panel-attention").textContent ?? "";
    expect(panel).toMatch(/Acme/);
    expect(panel).toMatch(/Critical/);
    expect(panel).not.toMatch(/High/);
  });
});
