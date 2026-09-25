// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within } from "@testing-library/react";

import Overview from "@/pages/Overview";
import { overviewSample } from "@/sample";
import { OVERVIEW_SAMPLE } from "@/sample/overview";
// The server's own summarizer, so a fixture of raw findings reaches the page
// exactly as GET /api/findings/summary would count it.
import { summarizeFindings } from "../server/findings-summary";

/**
 * The Overview used to be fixture data from top to bottom -- 42 AI systems, a
 * 62% "Moderate Risk" ring, "Customer Support Agent 100%" coverage,
 * "Deployment approved: Fraud Detection" -- with nothing on the page to say so.
 *
 * These tests hold the two halves of the fix apart:
 *
 * - sample mode OFF (the default): every figure is the one the record gives,
 *   or a dash with the reason, and not one sample value reaches the page --
 *   neither on an empty estate nor on a populated one;
 * - sample mode ON: the sample figures show, and the banner and a label on
 *   EVERY panel say what they are.
 *
 * The query cache is seeded directly and any other fetch fails the test, so
 * nothing here can pass by rendering a loading state.
 */

beforeAll(() => {
  // recharts' ResponsiveContainer observes its box; jsdom has no observer.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

interface Seed {
  clients: unknown[];
  sites: unknown[];
  tests: unknown[];
  findings: Record<string, unknown[]>;
  deployments: unknown[];
}

/** What GET /api/findings/summary answers for this record. */
function summaryOf(seed: Seed) {
  return summarizeFindings({
    clients: seed.clients as { id: string; name: string }[],
    sites: seed.sites as { id: string; environment: string }[],
    findings: Object.values(seed.findings).flat() as Parameters<typeof summarizeFindings>[0]["findings"],
  });
}

function mount(seed: Seed | null) {
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
  if (seed) {
    client.setQueryData(["/api/clients"], seed.clients);
    client.setQueryData(["/api/sites"], seed.sites);
    client.setQueryData(["/api/tests"], seed.tests);
    client.setQueryData(["/api/assurance/deployments"], seed.deployments);
    client.setQueryData(["/api/findings/summary"], summaryOf(seed));
    client.setQueryData(["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 });
    client.setQueryData(["/api/auth/check"], { authenticated: true, user: null });
  }
  return render(
    <QueryClientProvider client={client}>
      <Overview />
    </QueryClientProvider>,
  );
}

const EMPTY: Seed = { clients: [], sites: [], tests: [], findings: {}, deployments: [] };

const POPULATED: Seed = {
  clients: [
    { id: "c1", name: "Northwind Checkout" },
    { id: "c2", name: "Harbor Payroll" },
  ],
  sites: [
    { id: "s1", clientId: "c1", environment: "production" },
    { id: "s2", clientId: "c1", environment: "staging" },
    { id: "s3", clientId: "c2", environment: "production" },
  ],
  tests: [
    {
      id: "t1", clientId: "c1", siteId: "s1", testType: "penetration-test", status: "completed",
      startedAt: iso(5), completedAt: iso(3), vulnerabilitiesFound: 3,
    },
    {
      id: "t2", clientId: "c2", siteId: "s3", testType: "vulnerability-scan", status: "running",
      startedAt: iso(1), completedAt: null, vulnerabilitiesFound: 0,
    },
  ],
  findings: {
    c1: [
      {
        id: "f1", clientId: "c1", siteId: "s1", type: "sql_injection", severity: "high",
        message: "SQL injection in /login", status: "open", firstSeenAt: iso(3), lastSeenAt: iso(3),
      },
      {
        id: "f2", clientId: "c1", siteId: "s2", type: "missing_header", severity: "medium",
        message: null, status: "open", firstSeenAt: iso(3), lastSeenAt: iso(3),
      },
      {
        // Fixed, so it is not open: it must not be counted as one.
        id: "f3", clientId: "c1", siteId: "s1", type: "xss", severity: "critical",
        message: "Reflected XSS", status: "fixed", firstSeenAt: iso(3), lastSeenAt: iso(3),
      },
    ],
    c2: [],
  },
  deployments: [
    { uuid: "d1", decision: "ready" },
    { uuid: "d2", decision: null },
  ],
};

/** Every piece of sample prose: names, notes, summaries, activity, issues. */
function sampleStrings(): string[] {
  const s = OVERVIEW_SAMPLE;
  const rows = <T,>(p: { rows: T[] } | { note: string }) => ("rows" in p ? p.rows : []);
  return [
    ...("pct" in s.posture ? [s.posture.label, s.posture.summary] : []),
    ...s.metrics.flatMap((m) => (m.delta ? [m.delta.value, m.delta.note ?? ""] : [])),
    ...rows(s.coverage).map((r) => r.name),
    ...rows(s.attention).flatMap((r) => [r.name, r.note]),
    ...rows(s.activity).flatMap((r) => [r.text, r.meta]),
    ...rows(s.reviews).map((r) => r.name),
    ...rows(s.issues).map((r) => r.t),
  ].filter((text) => text !== "");
}

/** The figures sample mode prints in the headline cards and the posture row. */
function sampleFigures(): string[] {
  return [
    ...OVERVIEW_SAMPLE.metrics.map((m) => String(m.value)),
    ...OVERVIEW_SAMPLE.postureFigures.map((f) => String(f.value)),
  ];
}

function figureOf(testId: string): string {
  const card = screen.getByTestId(testId);
  return card.querySelector(".athena-figure")?.textContent ?? "";
}

function noSampleValue() {
  const text = document.body.textContent ?? "";
  for (const phrase of sampleStrings()) {
    expect(text, `sample text "${phrase}" reached a real view`).not.toContain(phrase);
  }
  const figures = Array.from(document.querySelectorAll(".athena-figure")).map((el) => el.textContent);
  for (const value of sampleFigures()) {
    expect(figures, `sample figure "${value}" reached a real view`).not.toContain(value);
  }
  expect(screen.queryByTestId("sample-mode-banner")).toBeNull();
  expect(screen.queryAllByTestId("sample-panel-label")).toHaveLength(0);
}

describe("Overview with sample mode off (the default)", () => {
  it("shows an empty estate as empty, with no sample value anywhere", () => {
    mount(EMPTY);
    expect(figureOf("overview-metric-systems")).toBe("0");
    expect(figureOf("overview-metric-scans")).toBe("0");
    expect(figureOf("overview-metric-findings")).toBe("0");
    expect(figureOf("overview-metric-decisions")).toBe("0");
    noSampleValue();
  });

  it("computes every headline figure from the record", () => {
    mount(POPULATED);
    expect(figureOf("overview-metric-systems")).toBe("2");
    expect(screen.getByText("3 sites on record")).toBeTruthy();
    // One running scan; the completed one is not in flight.
    expect(figureOf("overview-metric-scans")).toBe("1");
    // Two open findings; the fixed critical is not one of them.
    expect(figureOf("overview-metric-findings")).toBe("2");
    expect(screen.getByText("0 critical · 1 high")).toBeTruthy();
    // One deployment has a decision; the other has none and is not counted.
    expect(figureOf("overview-metric-decisions")).toBe("1");
    expect(screen.getByText("of 2 deployments · 1 ready")).toBeTruthy();
    noSampleValue();
  });

  it("says what is not measured instead of printing a figure for it", () => {
    mount(POPULATED);
    // Nothing computes a readiness score or an overall risk score.
    expect(figureOf("overview-metric-readiness")).toBe("—");
    expect(screen.getByText(/Not measured: no readiness score is computed/)).toBeTruthy();
    const posture = screen.getByTestId("overview-panel-posture");
    expect(within(posture).getByText(/Not scored\. Athena does not compute an overall risk score/)).toBeTruthy();
    expect(within(posture).queryByText("Moderate Risk")).toBeNull();
    // No review schedule exists to list.
    const reviews = screen.getByTestId("overview-panel-reviews");
    expect(within(reviews).getByText(/Not tracked yet/)).toBeTruthy();
  });

  it("fills the lists from the record", () => {
    mount(POPULATED);
    const coverage = screen.getByTestId("overview-panel-coverage");
    expect(within(coverage).getByText("1 of 2 sites scanned")).toBeTruthy();
    expect(within(coverage).getByText("50%")).toBeTruthy();
    expect(within(coverage).getByText("0 of 1 site scanned")).toBeTruthy();

    const attention = screen.getByTestId("overview-panel-attention");
    expect(within(attention).getByText("1 open critical/high finding")).toBeTruthy();
    expect(within(attention).getByText("No completed scan on record")).toBeTruthy();

    const environments = screen.getByTestId("overview-panel-environments");
    expect(within(environments).getByText("Production")).toBeTruthy();
    expect(within(environments).getByText("Staging")).toBeTruthy();

    const activity = screen.getByTestId("overview-panel-activity");
    expect(within(activity).getByText("Running: Vulnerability Scan")).toBeTruthy();
    expect(within(activity).getByText("Completed: Penetration Test")).toBeTruthy();

    const issues = screen.getByTestId("overview-panel-issues");
    expect(within(issues).getByText("SQL injection in /login")).toBeTruthy();
    expect(within(issues).queryByText("Reflected XSS")).toBeNull();
  });

  it("reads a source that failed as unknown, never as zero", () => {
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
    client.setQueryData(["/api/clients"], POPULATED.clients);
    client.setQueryData(["/api/sites"], POPULATED.sites);
    client.setQueryData(["/api/tests"], POPULATED.tests);
    client.setQueryData(["/api/findings/summary"], summaryOf(POPULATED));
    client.setQueryData(["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 });
    client.setQueryData(["/api/auth/check"], { authenticated: true, user: null });
    // The assurance control plane is the one source not seeded: its fetch
    // fails, which is what an unreachable control plane looks like.
    return (async () => {
      render(
        <QueryClientProvider client={client}>
          <Overview />
        </QueryClientProvider>,
      );
      expect(await screen.findByText("Assurance control plane not reachable")).toBeTruthy();
      expect(figureOf("overview-metric-decisions")).toBe("—");
    })();
  });

  it("refuses to hand the sample figures to anything while sample mode is off", () => {
    expect(() => overviewSample()).toThrow(/sample mode is off/);
  });
});

describe("Overview with sample mode on", () => {
  it("labels the page and every panel it fills", () => {
    vi.stubEnv("VITE_MYTHOS_SAMPLE_MODE", "1");
    // No data seeded at all: sample mode must not fetch, and must not need to.
    mount(null);

    expect(screen.getByTestId("sample-mode-banner").textContent).toContain(
      "Sample data — not from your environment",
    );

    const panels = [
      ...OVERVIEW_SAMPLE.metrics.map((m) => `overview-metric-${m.key}`),
      "overview-panel-posture",
      "overview-panel-trend",
      "overview-panel-environments",
      "overview-panel-coverage",
      "overview-panel-attention",
      "overview-panel-activity",
      "overview-panel-reviews",
      "overview-panel-issues",
    ];
    for (const id of panels) {
      const panel = screen.getByTestId(id);
      expect(
        within(panel).getByTestId("sample-panel-label").textContent,
        `${id} carries no sample label`,
      ).toContain("Sample data — not from your environment");
    }
    // One label per panel, and no panel on the page without one.
    expect(screen.getAllByTestId("sample-panel-label")).toHaveLength(panels.length);

    // And the sample figures are what those labels are about.
    expect(figureOf("overview-metric-systems")).toBe("42");
    expect(screen.getByText("Moderate Risk")).toBeTruthy();
    expect(within(screen.getByTestId("overview-panel-coverage")).getByText("Customer Support Agent")).toBeTruthy();
  });

  it("stays off for any value other than 1", () => {
    vi.stubEnv("VITE_MYTHOS_SAMPLE_MODE", "true");
    mount(EMPTY);
    noSampleValue();
  });
});
