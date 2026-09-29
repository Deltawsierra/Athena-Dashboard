// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within } from "@testing-library/react";

import AIHealth from "@/pages/AIHealth";
import type { BenchmarkReading, EngineMeasurement } from "@shared/schema";

/**
 * The Health screen shows the engine's detection benchmark as it measured it:
 * every share of attacks caught (security) beside the share of legitimate work
 * let through (utility), with the counts, the run, the commit and the time,
 * and each one's change since the different measurement before it. A
 * remediation that catches more by blocking legitimate work shows as exactly
 * that, in numbers and in a sentence. With no measurement there is no number,
 * only the reason.
 *
 * It replaces a card that said the page could show neither figure, because the
 * benchmark ran only in the engine's CI and no route reported it.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
});
afterEach(() => cleanup());

const A: EngineMeasurement = {
  run: "a".repeat(32),
  measuredAt: "2026-09-26T10:00:00Z",
  commit: "1".repeat(40),
  commitModified: false,
  commitUnknown: null,
  tuned: { securityRetained: 0.9016, utilityRetained: 1, attacks: 183, caught: 165, legitimate: 83, flagged: 0 },
  holdout: { securityRetained: 0.8889, utilityRetained: 1, attacks: 27, caught: 24, legitimate: 15, flagged: 0 },
  holdoutUnmeasured: null,
};

/** The remediation: every attack caught, by flagging legitimate work. */
const B: EngineMeasurement = {
  ...A,
  run: "b".repeat(32),
  measuredAt: "2026-09-29T05:00:00Z",
  commit: "2".repeat(40),
  tuned: { securityRetained: 1, utilityRetained: 0.9398, attacks: 183, caught: 183, legitimate: 83, flagged: 5 },
  holdout: { securityRetained: 1, utilityRetained: 0.8667, attacks: 27, caught: 27, legitimate: 15, flagged: 2 },
};

const BASE = {
  id: "m1", timestamp: "2026-09-29T05:01:00Z", cpuUsage: 41, memoryUsage: 63, activeScans: 0,
  totalScansToday: 0, successRate: null, averageResponseTime: 120, detectionAccuracy: null,
  falsePositiveRate: null, modelsLoaded: [], lastTrainingDate: null, guardsChecked: 40, guardsFailing: 0,
};

function mount(reading: Record<string, unknown>) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); },
      },
    },
  });
  client.setQueryData(["/api/ai-health/latest"], reading);
  client.setQueryData(["/api/ai-health"], [reading]);
  render(<QueryClientProvider client={client}><AIHealth /></QueryClientProvider>);
}

function withBenchmark(benchmark: BenchmarkReading | null, benchmarkUnmeasured: string | null = null) {
  mount({ ...BASE, benchmark, benchmarkUnmeasured });
}

const card = () => screen.getByTestId("reading-detection");
const text = (testId: string) => screen.getByTestId(testId).textContent ?? "";

describe("detection on the Health screen", () => {
  it("shows every share of attacks caught beside the share of legitimate work let through, in one row", () => {
    withBenchmark({ current: B, previous: A });

    for (const [corpus, security, utility, caught, through] of [
      ["tuned", "100.0%", "94.0%", "183 of 183 attack cases caught", "78 of 83 legitimate cases let through"],
      ["holdout", "100.0%", "86.7%", "27 of 27 attack cases caught", "13 of 15 legitimate cases let through"],
    ] as const) {
      const row = screen.getByTestId(`row-detection-${corpus}`);
      expect(within(row).getByTestId(`row-detection-${corpus}-security`).textContent).toBe(security);
      expect(within(row).getByTestId(`row-detection-${corpus}-utility`).textContent).toBe(utility);
      expect(row.textContent).toContain(caught);
      expect(row.textContent).toContain(through);
    }
  });

  it("shows a remediation that raised security and dropped utility as exactly that", () => {
    withBenchmark({ current: B, previous: A });

    expect(text("row-detection-tuned-security-change")).toBe("▲ +9.8 pts since the measurement before");
    expect(text("row-detection-tuned-utility-change")).toBe("▼ −6.0 pts since the measurement before");
    expect(text("row-detection-holdout-security-change")).toBe("▲ +11.1 pts since the measurement before");
    expect(text("row-detection-holdout-utility-change")).toBe("▼ −13.3 pts since the measurement before");
    const said = screen.getAllByTestId("text-detection-trade-off").map((one) => one.textContent);
    expect(said).toEqual([
      "Security rose (tuned corpus +9.8 pts, holdout corpus +11.1 pts) while utility fell " +
      "(tuned corpus −6.0 pts, holdout corpus −13.3 pts): more attacks are caught, and less legitimate work gets through.",
    ]);
  });

  it("says the opposite trade too", () => {
    withBenchmark({ current: A, previous: B });
    expect(text("row-detection-tuned-security-change")).toBe("▼ −9.8 pts since the measurement before");
    expect(text("row-detection-tuned-utility-change")).toBe("▲ +6.0 pts since the measurement before");
    expect(screen.getAllByTestId("text-detection-trade-off").map((one) => one.textContent)).toEqual([
      "Utility rose (tuned corpus +6.0 pts, holdout corpus +13.3 pts) while security fell " +
      "(tuned corpus −9.8 pts, holdout corpus −11.1 pts): more legitimate work gets through, and fewer attacks are caught.",
    ]);
  });

  it("says the trade when security rose on one corpus and utility fell on the other", () => {
    // What a real remediation did (athena-engine, a quote read as SQL injection):
    // it caught the one holdout attack missed, and flagged one legitimate tuned line.
    const before: EngineMeasurement = {
      ...A,
      tuned: { securityRetained: 1, utilityRetained: 1, attacks: 183, caught: 183, legitimate: 83, flagged: 0 },
      holdout: { securityRetained: 0.963, utilityRetained: 1, attacks: 27, caught: 26, legitimate: 15, flagged: 0 },
    };
    const after: EngineMeasurement = {
      ...B,
      tuned: { securityRetained: 1, utilityRetained: 0.988, attacks: 183, caught: 183, legitimate: 83, flagged: 1 },
      holdout: { securityRetained: 1, utilityRetained: 1, attacks: 27, caught: 27, legitimate: 15, flagged: 0 },
    };
    withBenchmark({ current: after, previous: before });

    expect(text("row-detection-tuned-security-change")).toBe("no change");
    expect(text("row-detection-tuned-utility-change")).toBe("▼ −1.2 pts since the measurement before");
    expect(text("row-detection-holdout-security-change")).toBe("▲ +3.7 pts since the measurement before");
    expect(text("row-detection-holdout-utility-change")).toBe("no change");
    expect(screen.getAllByTestId("text-detection-trade-off").map((one) => one.textContent)).toEqual([
      "Security rose (holdout corpus +3.7 pts) while utility fell (tuned corpus −1.2 pts): " +
      "more attacks are caught, and less legitimate work gets through.",
    ]);
  });

  it("says nothing of a trade when both shares moved the same way", () => {
    withBenchmark({
      current: B,
      previous: { ...B, tuned: { ...B.tuned, securityRetained: 0.9016, caught: 165, utilityRetained: 0.8795, flagged: 10 } },
    });
    expect(text("row-detection-tuned-security-change")).toBe("▲ +9.8 pts since the measurement before");
    expect(text("row-detection-tuned-utility-change")).toBe("▲ +6.0 pts since the measurement before");
    expect(screen.queryByTestId("text-detection-trade-off")).toBeNull();
  });

  it("names the run, the commit and the time of both measurements", () => {
    withBenchmark({ current: B, previous: A });
    const provenance = text("text-detection-provenance");
    expect(provenance).toContain(`run bbbbbbbb, commit 2222222, measured ${new Date(B.measuredAt).toLocaleString()}`);
    const previous = text("text-detection-previous");
    expect(previous).toContain(`run aaaaaaaa, commit 1111111, measured ${new Date(A.measuredAt).toLocaleString()}`);
  });

  it("with nothing earlier on record, shows no change and says why", () => {
    withBenchmark({ current: B, previous: null });
    expect(screen.queryByTestId("row-detection-tuned-security-change")).toBeNull();
    expect(screen.queryByTestId("row-detection-tuned-utility-change")).toBeNull();
    expect(screen.queryByTestId("text-detection-trade-off")).toBeNull();
    expect(text("text-detection-previous")).toBe(
      "No earlier measurement that differs from this one is on record here, so no change is shown.",
    );
  });

  it("shows no number when the reading holds no measurement, only why", () => {
    const why = "the engine has no measurement to report: the engine started its benchmark run at 2026-09-29T07:00:00Z and it has not finished";
    withBenchmark(null, why);
    expect(text("text-detection-unmeasured")).toBe(`—${why}`);
    expect(card().textContent).not.toMatch(/%/);
    expect(screen.queryByTestId("row-detection-tuned")).toBeNull();
  });

  it("says a reading from before the report holds none", () => {
    mount(BASE);
    expect(text("text-detection-unmeasured")).toBe("—this reading holds no report of the engine's measurement");
    expect(card().textContent).not.toMatch(/%/);
  });

  it("shows a holdout the engine did not measure as not measured, with no number", () => {
    withBenchmark({
      current: { ...B, holdout: null, holdoutUnmeasured: "the benchmark measured no holdout set" },
      previous: A,
    });
    const row = screen.getByTestId("row-detection-holdout");
    expect(text("row-detection-holdout-unmeasured")).toBe("—Not measured: the benchmark measured no holdout set");
    expect(row.textContent).not.toMatch(/%/);
    // And a previous holdout with no current one to compare says nothing of a change.
    expect(screen.getAllByTestId("text-detection-trade-off").map((one) => one.textContent)).toEqual([
      "Security rose (tuned corpus +9.8 pts) while utility fell (tuned corpus −6.0 pts): " +
      "more attacks are caught, and less legitimate work gets through.",
    ]);
  });

  it("says when the earlier measurement had no figure to compare", () => {
    withBenchmark({ current: B, previous: { ...A, holdout: null, holdoutUnmeasured: "the benchmark measured no holdout set" } });
    expect(text("row-detection-holdout-security-change")).toBe("no earlier figure to compare");
    expect(text("row-detection-holdout-utility-change")).toBe("no earlier figure to compare");
  });

  it("says why there is no commit, and when the code differed from it", () => {
    withBenchmark({
      current: { ...B, commit: null, commitModified: null, commitUnknown: "the engine's source is not a git checkout, so its commit cannot be read" },
      previous: { ...A, commitModified: true },
    });
    expect(text("text-detection-provenance")).toContain(
      "commit not known (the engine's source is not a git checkout, so its commit cannot be read)",
    );
    expect(text("text-detection-previous")).toContain("commit 1111111, with uncommitted changes to tracked files");
  });

  it("never rounds a miss up to a perfect score, nor a catch down to none", () => {
    withBenchmark({
      current: {
        ...B,
        tuned: { securityRetained: 0.9996, utilityRetained: 0.0004, attacks: 2500, caught: 2499, legitimate: 2500, flagged: 2499 },
      },
      previous: null,
    });
    expect(text("row-detection-tuned-security")).toBe("99.9%");
    expect(text("row-detection-tuned-utility")).toBe("0.1%");
  });
});
