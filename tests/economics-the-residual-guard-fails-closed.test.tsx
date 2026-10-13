// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";

import { MASTER, fixture, served } from "./helpers/economics-fixtures";
import { NETWORK_ERROR, NOT_SERVED_ROI, bytesOf, mountEconomics, refusedWith, shims, type Answer } from "./helpers/economics-render";

/**
 * The residual guard FAILS CLOSED (review round 1, MEDIUM-1). A residual
 * (counterfactual) run is never exposure, so a result's figures are shown only
 * when it is shown to be the scenario's own run:
 *
 * - the report says so itself: `residual_of: null` (Athena-Backend #160, merged at
 *   4c1edf3). A report that says it is a residual run is refused as exposure; one
 *   that does not say, or says it unreadably, shows no figure;
 * - and the ROI read settled: served (and not naming this result as its residual
 *   run), or answered "not served" by the backend itself (its 404: no option).
 *   Any other failure -- a 5xx, a refusal, this server's own 404, a dropped
 *   connection -- shows no figure of the result, only why.
 */

beforeAll(shims);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const graded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
const clean = fixture(MASTER, "roi-clean");
const EXPOSURE = ['[data-section="scenario-card"]', '[data-figure-section="distribution"]', '[data-figure-section="waterfall"]', '[data-figure-section="tornado"]'];

function noFigureOnlyWhy(container: HTMLElement, why: RegExp) {
  expect(container.querySelectorAll("[data-money]")).toHaveLength(0);
  for (const selector of EXPOSURE) expect(container.querySelector(selector), selector).toBeNull();
  expect(screen.getByTestId("residual-unchecked").textContent).toMatch(why);
}

/** The report's bytes with `residual_of` set to `value`, or removed. */
function reportWith(loaded: typeof graded, value: unknown | "remove"): Answer {
  const report = structuredClone(served(loaded, "report")) as Record<string, unknown>;
  if (value === "remove") delete report.residual_of;
  else report.residual_of = value;
  return { status: 200, body: JSON.stringify(report) };
}

describe("the report says it is the scenario's own run", () => {
  it("and the backend answers that there is no ROI document (its 404): the figures are shown", async () => {
    expect(served(graded, "report").residual_of).toBeNull();
    const { container } = await mountEconomics(graded, { report: bytesOf(graded, "report"), events: bytesOf(graded, "events"), roi: NOT_SERVED_ROI });
    for (const selector of EXPOSURE) expect(container.querySelector(selector), selector).not.toBeNull();
    expect(container.querySelectorAll("[data-money]").length).toBeGreaterThan(20);
    expect(screen.getByTestId("roi-not-served").textContent).toMatch(/^not served: Athena-Backend does not serve/);
  });

  it("but the ROI read failed with a 503: no figure, only why", async () => {
    const { container } = await mountEconomics(graded, {
      report: bytesOf(graded, "report"), events: bytesOf(graded, "events"),
      roi: refusedWith(503, "Athena-Backend could not serve the remediation option's economics (a server error)", "backend_error"),
    });
    noFigureOnlyWhy(container, /could not be checked: the ROI read failed: Athena-Backend could not serve/);
  });

  it("but the ROI read's connection failed: no figure, only why", async () => {
    const { container } = await mountEconomics(graded, { report: bytesOf(graded, "report"), events: bytesOf(graded, "events"), roi: NETWORK_ERROR });
    noFigureOnlyWhy(container, /could not be checked: the ROI read failed: Failed to fetch/);
  });

  it("but the ROI read timed out, was refused, or met this server's own 404: no figure", async () => {
    const failures: Answer[] = [
      refusedWith(504, "Athena-Backend did not answer the remediation option's economics in time", "backend_timeout"),
      refusedWith(403, "Athena-Backend refused the read of the remediation option's economics", "backend_refused"),
      { status: 404, body: JSON.stringify({ message: "Not found" }) },
    ];
    for (const roi of failures) {
      const { container } = await mountEconomics(graded, { report: bytesOf(graded, "report"), roi });
      noFigureOnlyWhy(container, /could not be checked: the ROI read failed/);
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("and the ROI document is served and names another run as its residual: the figures are shown", async () => {
    const roi = served(clean, "roi") as Record<string, any>;
    expect(roi.residual.simulation).not.toBe((served(clean, "report") as Record<string, any>).simulation.uuid);
    const { container } = await mountEconomics(clean, { report: bytesOf(clean, "report"), events: bytesOf(clean, "events"), roi: bytesOf(clean, "roi") });
    expect(container.querySelector('[data-figure-section="distribution"]')).not.toBeNull();
  });
});

describe("the report does not say it is the scenario's own run", () => {
  it("it says it is a residual run (the backend's own report of one): refused as exposure", async () => {
    const residual = fixture(MASTER, "residual-report");
    const report = JSON.parse(residual.residual_report!.body) as Record<string, any>;
    expect(report.residual_of).not.toBeNull();
    expect(report.excluded_from_totals).toBe(true);
    const { container } = await mountEconomics(
      residual,
      { report: { status: 200, body: residual.residual_report!.body }, events: bytesOf(residual, "events"), roi: bytesOf(residual, "roi") },
      residual.residual_report!.simulation,
    );
    expect(screen.getByTestId("residual-refused").textContent).toMatch(/not exposure/);
    for (const selector of EXPOSURE) expect(container.querySelector(selector), selector).toBeNull();
    expect(container.querySelector('[data-figure-section="current-against-residual"]')).not.toBeNull();
  });

  it("it carries no residual_of (a backend from before #160): no figure, even with the ROI document served", async () => {
    const { container } = await mountEconomics(clean, { report: reportWith(clean, "remove"), events: bytesOf(clean, "events"), roi: bytesOf(clean, "roi") });
    noFigureOnlyWhy(container, /the report does not say \(it carries no residual_of\)/);
  });

  it("its residual_of cannot be read: no figure", async () => {
    for (const value of ["no", 0, false, ["option"]]) {
      const { container } = await mountEconomics(clean, { report: reportWith(clean, value), events: bytesOf(clean, "events"), roi: bytesOf(clean, "roi") });
      noFigureOnlyWhy(container, /residual_of cannot be read/);
      cleanup();
      vi.unstubAllGlobals();
    }
  });
});
