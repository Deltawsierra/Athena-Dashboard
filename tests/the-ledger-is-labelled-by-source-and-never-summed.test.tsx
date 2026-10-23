// @vitest-environment jsdom
/**
 * The ledger re-pointed (the Option 1 hybrid, owner decision 1; plan section
 * 6, 11 and 14): Athena-Backend's findings are its record, read as the person;
 * this dashboard's own findings ledger is what it filed directly from the
 * engine. Each surface shows both under its own label, by SOURCE, and never
 * adds them together.
 *
 *   - every row of this dashboard's own ledger, and every sighting, carries
 *     source "dashboard-direct" -- rows written before the column existed read
 *     so too (tests/db-migration.test.ts) -- and the Risks page's register says
 *     the ledger is read-only here and never counted as the record;
 *   - the Risks page's Backend record section lists the selected client's
 *     findings in the Athena-Backend record (severity, title, status, the
 *     deployment, the engine run, and the scan it came from -- a link to the
 *     scan page where a row here names that scan); a client with no engagement
 *     at the backend is told so; a read that failed is said to have failed; the
 *     ledger's own figures above count the ledger alone;
 *   - the Overview's record tiles are three figures from three sources -- the
 *     backend's deployments' findings, the own ledger's open findings, the
 *     engine's live runs (running and aborting) -- never one sum (mutation: a
 *     tile that adds two of them fails this), each "—" with the reason where
 *     its source is not in hand; PR #74's tiles and their source line stand;
 *   - the Tests page filters its rows by source; a row adopted from the record
 *     says so by source, names no client when its engagement is linked to none,
 *     and offers no direct Stop while only the backend's Stop reaches its run.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import Overview from "@/pages/Overview";
import Risks from "@/pages/Risks";
import Tests from "@/pages/Tests";
import { queryClient } from "@/lib/queryClient";
import {
  ENGINE_LIST_UNREAD, ENGINE_NOT_CONFIGURED, LEDGER_READ_ONLY, OVERVIEW_RECORD_SOURCES, OVERVIEW_SOURCES, RISKS_BACKEND_EMPTY,
  RISKS_BACKEND_UNREAD, RISKS_NO_ENGAGEMENT_AT_BACKEND, SCAN_NOT_YET_ADOPTED, SOURCE_FILTER_BACKEND, allSourceLabelStrings,
  backendFindingsSublabel, engineLiveLine,
} from "@/lib/sourceLabels";
import { ADOPTED_FROM_RECORD, NOT_LINKED_TO_CLIENT, recordPill } from "@/lib/backendRecordCopy";
import { lintMicrocopy } from "@shared/persona-lint";
import { LEDGER_SOURCE_DASHBOARD_DIRECT } from "@shared/schema";
import { summarizeFindings } from "../server/findings-summary";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
});

/** A page over a seeded cache: every source answers from `seed`, and any other read is an error, never a loading state. */
function mountSeeded(ui: ReactElement, seed: Array<[unknown[], unknown]>) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); },
      },
    },
  });
  for (const [k, v] of seed) client.setQueryData(k, v);
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const COMMON_SEED: Array<[unknown[], unknown]> = [
  [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
  [["/api/auth/check"], { authenticated: true, user: null }],
];
const CLIENT = { id: "c1", name: "Acme", company: "Acme", status: "active", lastTestDate: null, notes: null };
const now = new Date().toISOString();
/** A row of this dashboard's own ledger, as /api/findings serves it. */
const ledgerFinding = (id: string, severity: string) => ({
  id, clientId: "c1", siteId: null, type: "sql_injection", severity, message: `SQL error ${id}`, status: "open",
  firstSeenAt: now, lastSeenAt: now, target: "https://app.example", endpoint: `https://app.example/${id}`, ownerId: null,
  source: LEDGER_SOURCE_DASHBOARD_DIRECT, sightings: [], checks: [],
});
const LEDGER = [ledgerFinding("f1", "high")];
const FOUR_OPEN = ["f1", "f2", "f3", "f4"].map((id) => ledgerFinding(id, "medium"));
const summaryOf = (findings: unknown[]) => summarizeFindings({ clients: [CLIENT], sites: [], findings: findings as never });

/** The Athena-Backend record of the client's findings, as GET /api/record/clients/:id/findings answers it. */
const RECORD = {
  clientId: "c1", engagementId: 7, readAt: now,
  deployments: [{ uuid: "d1", name: "Acme shop" }],
  findings: [
    { uuid: "bf1", title: "Prompt injection via tool output", severity: "high", status: "open", statusLabel: "Open", findingType: "prompt_injection",
      deploymentUuid: "d1", scanUuid: "s1", engineRunId: "run-77", test: { id: "t9", status: "completed" } },
    { uuid: "bf2", title: "Over-broad token scope", severity: "medium", status: "open", statusLabel: "Open", findingType: "excessive_agency",
      deploymentUuid: "d1", scanUuid: "s2", engineRunId: null, test: null },
  ],
};

function risksSeed(record: unknown | undefined, ledger = LEDGER): Array<[unknown[], unknown]> {
  const seed: Array<[unknown[], unknown]> = [
    [["/api/clients"], [CLIENT]], [["/api/tests"], []], [["/api/sites"], []], [["/api/users/assignable"], []],
    [["/api/assurance/deployments"], []],
    [["/api/findings/summary"], summaryOf(ledger)],
    [["/api/findings", { clientId: "c1" }], { findings: ledger, counts: { open: ledger.length, acknowledged: 0, accepted: 0, fixed: 0 } }],
    ...COMMON_SEED,
  ];
  if (record !== undefined) seed.push([["/api/record/clients/c1/findings"], record]);
  return seed;
}

describe("the ledger's rows are labelled by their one source", () => {
  it("every finding and sighting this dashboard files is dashboard-direct, in memory storage as in SQLite", async () => {
    process.env.ATHENA_STORAGE = "memory";
    vi.resetModules();
    const { storage } = await import("../server/storage-unified");
    const client = await storage.createClient({ name: "L", company: "L", email: "l@l.test" });
    const made = await storage.createFinding({
      fingerprint: "fp-1", clientId: client.id, engagementRef: "acme.example", type: "sql_injection", severity: "high", status: "open",
    });
    expect(made.source).toBe("dashboard-direct");
    expect(LEDGER_SOURCE_DASHBOARD_DIRECT).toBe("dashboard-direct");
    await storage.recordSighting(made.id, "run-1", null, true);
    expect((await storage.getSightings(made.id)).map((one) => one.source)).toEqual(["dashboard-direct"]);
    expect((await storage.getFindingsByClient(client.id)).map((one) => one.source)).toEqual(["dashboard-direct"]);
  });

  it("every source label lints clean and names a source, never an era", () => {
    for (const text of allSourceLabelStrings()) {
      expect(lintMicrocopy(text), text).toEqual([]);
      expect(text).not.toMatch(/legacy|backend will record|deployment assurance|\bworld\b|\bera\b/i);
    }
    expect(LEDGER_READ_ONLY).toBe(
      "This dashboard's own ledger: filed directly from the engine, labelled by source, read-only here, and never counted as the Athena-Backend record.",
    );
    expect(engineLiveLine(2, 1, 0)).toBe("2 running · 1 aborting");
    expect(backendFindingsSublabel(2)).toBe("across 2 deployments in the record");
  });
});

describe("Risks: the backend record in its own section, the ledger in its own", () => {
  it("lists the client's findings in the Athena-Backend record with their scan, and counts the ledger's figures from the ledger alone", () => {
    mountSeeded(<Risks />, risksSeed(RECORD));
    const section = screen.getByTestId("panel-risks-backend-record");
    expect(within(section).getByTestId("text-risks-backend-title").textContent).toContain("2 findings in the record");
    const first = within(section).getByTestId("record-finding-bf1");
    expect(within(first).getByTestId("text-record-finding-title").textContent).toBe("Prompt injection via tool output");
    expect(within(first).getByTestId("text-record-finding-run").textContent).toBe("engine run run-77");
    expect(within(first).getByTestId("link-record-finding-scan").getAttribute("href")).toBe("/athena?test=t9");
    expect(first.textContent).toContain("Acme shop");
    const second = within(section).getByTestId("record-finding-bf2");
    expect(within(second).getByTestId("text-record-finding-scan").textContent).toBe(SCAN_NOT_YET_ADOPTED);
    expect(within(second).getByTestId("text-record-finding-run").textContent).toBe("—");
    // The ledger's register stands under PR #74's label, read-only, with its own row; its figures count it alone.
    expect(screen.getByTestId("text-risks-source").textContent).toBe(
      "Recorded by this dashboard directly from the engine; not in the Athena-Backend record.",
    );
    expect(screen.getByTestId("text-risks-ledger-read-only").textContent).toBe(LEDGER_READ_ONLY);
    const register = screen.getByTestId("text-risks-source").closest("[class*=rounded-xl]") as HTMLElement;
    expect(register.textContent).toContain("SQL error f1");
    expect(within(register).queryAllByRole("button")).toEqual([]);
    expect(screen.getByText("Total Open Risks").parentElement?.parentElement?.textContent).toContain("1");
    expect(document.body.textContent ?? "").not.toMatch(/\b3\b open/);
  });

  it("says a client with no engagement at the backend has no record there, and a failed read as failed, never as empty", async () => {
    mountSeeded(<Risks />, risksSeed({ ...RECORD, engagementId: null, deployments: [], findings: [] }));
    expect(screen.getByTestId("text-risks-backend-no-engagement").textContent).toBe(RISKS_NO_ENGAGEMENT_AT_BACKEND);
    cleanup();
    mountSeeded(<Risks />, risksSeed({ ...RECORD, findings: [] }));
    expect(screen.getByTestId("text-risks-backend-empty").textContent).toBe(RISKS_BACKEND_EMPTY);
    cleanup();
    mountSeeded(<Risks />, risksSeed(undefined));
    // The seeded cache answers the unseeded read with an error a tick later: the section says so, and never reads as empty.
    expect((await screen.findByTestId("text-risks-backend-unread")).textContent).toContain(RISKS_BACKEND_UNREAD);
    expect(screen.queryByTestId("text-risks-backend-empty")).toBeNull();
  });
});

describe("Overview: three record figures from three sources, never one sum", () => {
  const overviewSeed = (extra: Array<[unknown[], unknown]>): Array<[unknown[], unknown]> => [
    [["/api/clients"], [CLIENT]], [["/api/sites"], []], [["/api/tests"], []],
    [["/api/findings/summary"], summaryOf(FOUR_OPEN)],
    ...COMMON_SEED, ...extra,
  ];

  it("counts the backend's findings from its deployments, the own ledger's open findings, and the engine's live runs, each on its own tile", () => {
    mountSeeded(<Overview />, overviewSeed([
      [["/api/assurance/deployments"], [{ uuid: "d1", decision: "ready", findingCount: 3 }, { uuid: "d2", decision: null, findingCount: 2 }]],
      [["/api/engine/runs"], { configured: true, runs: [{ runId: "run-1", state: "running" }, { runId: "run-2", state: "aborting" }] }],
    ]));
    const tiles = screen.getByTestId("overview-record-tiles");
    expect(within(tiles).getByTestId("overview-record-backend-findings").textContent).toContain("5");
    expect(within(tiles).getByTestId("overview-record-backend-findings").textContent).toContain(backendFindingsSublabel(2));
    expect(within(tiles).getByTestId("overview-record-own-findings").textContent).toContain("4");
    expect(within(tiles).getByTestId("overview-record-engine-live").textContent).toContain("2");
    expect(within(tiles).getByTestId("overview-record-engine-live").textContent).toContain(engineLiveLine(1, 1, 0));
    // Never one sum: 5 + 4, 5 + 2 and 4 + 2 appear on no tile.
    for (const tile of ["overview-record-backend-findings", "overview-record-own-findings", "overview-record-engine-live"]) {
      expect(within(tiles).getByTestId(tile).querySelector(".athena-figure")?.textContent).not.toMatch(/^(9|7|6|11)$/);
    }
    expect(screen.getByTestId("text-overview-record-sources").textContent).toBe(OVERVIEW_RECORD_SOURCES);
    // PR #74's tiles and their line stand as they were.
    expect(screen.getByTestId("text-overview-sources").textContent).toBe(OVERVIEW_SOURCES);
    expect(screen.getByTestId("overview-metric-findings").textContent).toContain("Open Findings");
    expect(screen.getByTestId("overview-metric-decisions").textContent).toContain("Assurance Decisions");
  });

  it("shows — with the reason where a source is not in hand: no engine configured, an engine list unread, deployments unread", async () => {
    mountSeeded(<Overview />, overviewSeed([
      [["/api/assurance/deployments"], []],
      [["/api/engine/runs"], { configured: false, runs: [] }],
    ]));
    expect(screen.getByTestId("overview-record-engine-live").textContent).toContain("—");
    expect(screen.getByTestId("overview-record-engine-live").textContent).toContain(ENGINE_NOT_CONFIGURED);
    expect(screen.getByTestId("overview-record-backend-findings").querySelector(".athena-figure")?.textContent).toBe("0");
    cleanup();
    // Neither the engine's list nor the deployments seeded: each read fails, and each tile says so.
    mountSeeded(<Overview />, overviewSeed([]));
    await waitFor(() => expect(screen.getByTestId("overview-record-engine-live").querySelector(".athena-figure")?.textContent).toBe("—"));
    expect(screen.getByTestId("overview-record-engine-live").textContent).toContain(ENGINE_LIST_UNREAD);
    await waitFor(() => expect(screen.getByTestId("overview-record-backend-findings").querySelector(".athena-figure")?.textContent).toBe("—"));
  });
});

describe("Tests: rows by source", () => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const BASE = { clientId: "c1", siteId: null, testType: "penetration-test", startedAt: at, completedAt: null, severity: null,
    summary: "s", vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, executedBy: null, isSample: false };
  const ADOPTED = { ...BASE, id: "adopted", clientId: null, status: "running", findings: {
    runId: "run-1", target: "https://elsewhere.example/", results: [], backendScanId: "s1", backendEngagementId: 9,
    source: "backend", adoptedAt: at, stop: "backend",
  } };
  const DIRECT = { ...BASE, id: "direct", status: "running", findings: { runId: "run-2", target: "https://a.example/", results: [] } };
  const HYBRID = { ...BASE, id: "hybrid", status: "completed", findings: {
    runId: "run-3", target: "https://a.example/", results: [], backendScanId: "s3", backendEngagementId: 9,
    backend: { status: "completed", verdict: "READY", verdictLabel: "Ready for deployment" },
  } };
  const MANUAL = { ...BASE, id: "manual", status: "completed", findings: { details: "by hand" } };

  function serve() {
    const data: Record<string, unknown> = {
      "/api/tests": [ADOPTED, DIRECT, HYBRID, MANUAL], "/api/clients": [CLIENT], "/api/sites": [],
      "/api/sample-data": { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }, "/api/auth/check": { authenticated: true, user: null },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const found = data[String(url).split("?")[0]];
      return new Response(JSON.stringify(found ?? null), { status: found === undefined ? 404 : 200, headers: { "Content-Type": "application/json" } });
    }));
    render(<QueryClientProvider client={queryClient}><Tests /></QueryClientProvider>);
  }

  it("an adopted row says so by source, names no client, and offers the backend's Stop in place of its own while only that reaches the run", async () => {
    serve();
    await screen.findByTestId("text-test-type-adopted");
    expect(screen.getByTestId("text-adopted-adopted").textContent).toBe(ADOPTED_FROM_RECORD);
    expect(screen.getByTestId("text-client-adopted").textContent).toBe(NOT_LINKED_TO_CLIENT);
    expect(screen.queryByTestId("button-stop-adopted")).toBeNull();
    expect(screen.getByTestId("panel-no-stop-adopted").getAttribute("data-variant")).toBe("backend");
    // A scan started here keeps its Stop; the pills name each source.
    expect(screen.getByTestId("button-stop-direct")).toBeTruthy();
    expect(screen.getByTestId("pill-record-source-direct").getAttribute("data-source")).toBe("direct");
    expect(screen.getByTestId("pill-record-source-hybrid").getAttribute("data-source")).toBe("backend");
    expect(screen.getByTestId("pill-record-source-hybrid").textContent).toBe(recordPill("Ready for deployment"));
    expect(screen.getByTestId("pill-record-source-adopted").getAttribute("data-source")).toBe("backend");
    expect(screen.queryByTestId("text-adopted-direct")).toBeNull();
    expect(screen.getByTestId("text-client-direct").textContent).toBe("Acme");
  });

  it("filters the rows by source", async () => {
    serve();
    await screen.findByTestId("text-test-type-manual");
    const filter = screen.getByTestId("select-filter-source") as HTMLSelectElement;
    expect(Array.from(filter.options).map((one) => one.textContent)).toContain(SOURCE_FILTER_BACKEND);
    fireEvent.change(filter, { target: { value: "backend" } });
    await waitFor(() => expect(screen.queryByTestId("text-test-type-direct")).toBeNull());
    expect(screen.getByTestId("text-test-type-adopted")).toBeTruthy();
    expect(screen.getByTestId("text-test-type-hybrid")).toBeTruthy();
    expect(screen.queryByTestId("text-test-type-manual")).toBeNull();
    fireEvent.change(filter, { target: { value: "none" } });
    await waitFor(() => expect(screen.queryByTestId("text-test-type-adopted")).toBeNull());
    expect(screen.getByTestId("text-test-type-manual")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "direct" } });
    await waitFor(() => expect(screen.getByTestId("text-test-type-direct")).toBeTruthy());
    expect(screen.queryByTestId("text-test-type-hybrid")).toBeNull();
  });
});
