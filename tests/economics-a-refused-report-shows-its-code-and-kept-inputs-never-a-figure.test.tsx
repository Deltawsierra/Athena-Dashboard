// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { cleanup, within } from "@testing-library/react";

import { MASTER, PR160, fixture, served } from "./helpers/economics-fixtures";
import { NO_ROI_ROUTE, bytesOf, mountEconomics, shims, words } from "./helpers/economics-render";

/**
 * Honesty rule: a refused report shows its refusal code and its kept inputs, and
 * never a figure -- no amount, no percentile, no band, no tornado, no waterfall.
 * That holds for a run the engine refused, for stored rows that no longer verify
 * (served as the refusal `stored_row_unverified`), and for a refused document
 * that carries a figure anyway: the views read the refusal, not the figure.
 */

beforeAll(shims);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function noFigure(container: HTMLElement) {
  expect(container.querySelectorAll("[data-money]")).toHaveLength(0);
  for (const id of ["distribution", "waterfall", "tornado"]) {
    expect(container.querySelector(`[data-figure-section="${id}"]`), id).toBeNull();
  }
}

describe("a refused report", () => {
  it("shows its refusal code and kept inputs, by name, and no figure", async () => {
    const loaded = fixture(MASTER, "refused-usd");
    const report = served(loaded, "report") as Record<string, any>;
    expect(report.status).toBe("refused");
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), events: bytesOf(loaded, "events"), roi: NO_ROI_ROUTE });
    const panel = container.querySelector('[data-section="refusal"]') as HTMLElement;
    expect(within(panel).getByTestId("refusal-panel-code").textContent).toBe(report.refusal.code);
    expect(within(container.querySelector('[data-section="scenario-card"]') as HTMLElement).getByTestId("refusal-code").textContent)
      .toBe(report.refusal.code);
    const kept = Array.from(panel.querySelectorAll("[data-kept-input]")).map((one) => one.getAttribute("data-kept-input"));
    expect(kept).toEqual(Object.keys(report.parameters));
    noFigure(container);
    // Not even the inputs' entered figures: none of them appears beside the refusal.
    const tokens = words(container);
    for (const [name, entry] of Object.entries(report.parameters as Record<string, any>)) {
      for (const point of ["low", "base", "high"]) {
        if (String(entry[point]).length >= 4) expect(tokens.has(entry[point]), `${name}.${point}`).toBe(false);
      }
    }
  });

  it("rows that no longer verify are served as a refusal, and shown as one", async () => {
    const loaded = fixture(MASTER, "unverified-usd");
    const report = served(loaded, "report") as Record<string, any>;
    expect(report.status).toBe("completed");
    expect(report.refusal.code).toBe("stored_row_unverified");
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), roi: NO_ROI_ROUTE });
    expect(within(container.querySelector('[data-section="refusal"]') as HTMLElement).getByTestId("refusal-panel-code").textContent)
      .toBe("stored_row_unverified");
    noFigure(container);
  });

  it("a refused document that carries a figure anyway still shows none of it", async () => {
    const loaded = fixture(MASTER, "refused-usd");
    const report = served(loaded, "report") as Record<string, any>;
    const planted = structuredClone(report);
    planted.summary = { lines: { gross_cash: { p10: "111111.11", p50: "222222.22", p90: "333333.33", bands: {}, not_reported: {} } }, headline: "gross_cash" };
    planted.loss_events[0].components[0].base = "444444.44";
    planted.loss_events[0].gross_cash.base = "555555.55";
    const { container } = await mountEconomics(loaded, {
      report: { status: 200, body: JSON.stringify(planted) },
      roi: NO_ROI_ROUTE,
    });
    noFigure(container);
    for (const figure of ["111111.11", "222222.22", "333333.33", "444444.44", "555555.55"]) {
      expect(container.textContent).not.toContain(figure);
    }
  });

  it("its ROI document shows no figure either (#160)", async () => {
    const loaded = fixture(PR160, "roi-refused");
    const roi = served(loaded, "roi") as Record<string, any>;
    expect(roi.status).toBe("not_computed");
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), events: bytesOf(loaded, "events"), roi: bytesOf(loaded, "roi") });
    const view = container.querySelector('[data-figure-section="current-against-residual"]') as HTMLElement;
    expect(within(view).getByTestId("roi-figures").textContent).toMatch(/^not served/);
    // The option's recorded costs are inputs, not figures of the run: with the run refused, none is shown either.
    noFigure(container);
  });
});
