// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

import AIHealth from "@/pages/AIHealth";
import CVEClassifier from "@/pages/CVEClassifier";

/**
 * The reader-facing half of "models loaded comes from the engine".
 *
 * Re-sourcing the server reading accomplishes nothing if the screen still
 * paints the operator's records as loaded models, or paints a silent engine as
 * "none loaded". These pin the display: the engine's inventory renders under
 * "Models loaded"; an unreachable engine reads as "unavailable", not "none"
 * and not the records; and the hand-typed records survive only as the
 * operator notes they are.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});

afterEach(cleanup);

/** Every source fails unless seeded. */
function mount(ui: ReactElement, seed: Array<[unknown[], unknown]> = []) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          throw new Error(`source failed: ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  for (const [key, value] of seed) client.setQueryData(key, value);
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return client;
}

const reading = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  timestamp: new Date("2026-10-01T10:00:00Z").toISOString(),
  cpuUsage: 10, memoryUsage: 20, activeScans: 0, totalScansToday: 0,
  successRate: null, averageResponseTime: null,
  detectionAccuracy: null, falsePositiveRate: null,
  modelsLoaded: [] as string[] | null, lastTrainingDate: null,
  guardsChecked: null, guardsFailing: null,
  benchmark: null, benchmarkUnmeasured: null,
  ...over,
});

const healthSeed = (over: Record<string, unknown> = {}): Array<[unknown[], unknown]> => [
  [["/api/ai-health/latest"], reading(over)],
  [["/api/ai-health"], [reading(over)]],
];

describe("AI Health 'Models loaded'", () => {
  it("lists the engine's model names, and no operator record or fabricated training date", async () => {
    mount(<AIHealth />, healthSeed({ modelsLoaded: ["cve_classifier", "ml_threat_classifier"] }));

    await waitFor(() => expect(screen.getByTestId("list-models")).toBeTruthy());
    const list = screen.getByTestId("list-models");
    expect(list.textContent).toContain("cve_classifier");
    expect(list.textContent).toContain("ml_threat_classifier");
    expect(list.textContent).not.toContain("operator-typed-ghost");
    // The engine inventory has no training timestamp, so the card no longer
    // claims one.
    expect(document.body.textContent).not.toMatch(/Most recently trained/);
  });

  it("says the inventory is unavailable -- not 'none' -- when modelsLoaded is null", async () => {
    mount(<AIHealth />, healthSeed({ modelsLoaded: null }));

    await waitFor(() => expect(screen.getByTestId("text-models-unavailable")).toBeTruthy());
    // null is not an empty list: neither the "no models" line nor a chip list.
    expect(screen.queryByTestId("text-no-models")).toBeNull();
    expect(screen.queryByTestId("list-models")).toBeNull();
  });

  it("says the engine reports none when the inventory is genuinely empty", async () => {
    mount(<AIHealth />, healthSeed({ modelsLoaded: [] }));

    await waitFor(() => expect(screen.getByTestId("text-no-models")).toBeTruthy());
    expect(screen.queryByTestId("text-models-unavailable")).toBeNull();
    expect(screen.queryByTestId("list-models")).toBeNull();
  });
});

describe("CVE page 'Loaded models'", () => {
  const ghost = {
    id: "c1", name: "operator-typed-ghost", type: "threat", accuracy: 99,
    status: "active", trainingDataSize: 10, lastTrainedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(), description: null,
  };

  it("shows the engine's inventory under 'Loaded models', with the operator record kept only as a note", async () => {
    mount(<CVEClassifier />, [
      [["/api/loaded-models"], [
        { name: "cve_classifier", kind: "detector", enabled: true, digest: "sha256:bbb" },
        { name: "ml_threat_model", kind: "artifact", enabled: false, digest: null },
      ]],
      [["/api/classifiers"], [ghost]],
    ]);

    await waitFor(() => expect(screen.getByTestId("list-loaded-models")).toBeTruthy());
    const loaded = screen.getByTestId("list-loaded-models");
    expect(loaded.textContent).toContain("cve_classifier");
    expect(loaded.textContent).toContain("ml_threat_model");
    // The hand-typed record is not in the engine's inventory.
    expect(loaded.textContent).not.toContain("operator-typed-ghost");

    // It survives, labelled as an operator record rather than a loaded model.
    expect(screen.getByTestId("label-operator-records")).toBeTruthy();
    expect(screen.getByTestId("list-classifiers").textContent).toContain("operator-typed-ghost");
  });

  it("says the inventory is unavailable -- not 'none' -- when the engine answered null", async () => {
    mount(<CVEClassifier />, [
      [["/api/loaded-models"], null],
      [["/api/classifiers"], []],
    ]);

    await waitFor(() => expect(screen.getByTestId("text-loaded-models-unavailable")).toBeTruthy());
    expect(screen.queryByTestId("list-loaded-models")).toBeNull();
    expect(screen.queryByTestId("text-loaded-models-empty")).toBeNull();
  });
});
