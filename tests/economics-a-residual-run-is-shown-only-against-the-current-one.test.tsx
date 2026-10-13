// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";

import { PR160, fixture, served } from "./helpers/economics-fixtures";
import { bytesOf, mountEconomics, shims, type Answer } from "./helpers/economics-render";

/**
 * Honesty rule: a residual (counterfactual) run -- the scenario as it would be
 * under a remediation option -- is shown only inside the current-against-residual
 * view, beside the current run, and never as exposure: not on the scenario card,
 * not in the distribution, the waterfall or the tornado. A report of a residual
 * run (a backend that served one on its results route) is refused as exposure,
 * and the exposure views wait until they can tell.
 */

beforeAll(shims);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const loaded = fixture(PR160, "roi-clean");
const report = served(loaded, "report") as Record<string, any>;
const roi = served(loaded, "roi") as Record<string, any>;
const EXPOSURE = ['[data-section="scenario-card"]', '[data-figure-section="distribution"]', '[data-figure-section="waterfall"]', '[data-figure-section="tornado"]'];

describe("the residual run", () => {
  it("is shown only in current against residual, beside the current run", async () => {
    expect(roi.residual.simulation).not.toBe(report.simulation.uuid);
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), events: bytesOf(loaded, "events"), roi: bytesOf(loaded, "roi") });
    const view = container.querySelector('[data-figure-section="current-against-residual"]') as HTMLElement;
    expect(view.textContent).toContain(roi.residual.simulation);
    expect(view.textContent).toContain(roi.current.simulation);
    const residualFigures = [roi.figures.residual_expected_annual_exposure, roi.figures.tail_reduction.p90.residual, roi.figures.tail_reduction.p95.residual];
    for (const selector of EXPOSURE) {
      const exposure = container.querySelector(selector) as HTMLElement;
      expect(exposure, selector).not.toBeNull();
      expect(exposure.textContent, selector).not.toContain(roi.residual.simulation);
      const amounts = Array.from(exposure.querySelectorAll("[data-money]")).map((one) => one.getAttribute("data-amount"));
      for (const figure of residualFigures) expect(amounts, `${selector} shows ${figure}`).not.toContain(figure);
    }
    const inView = Array.from(view.querySelectorAll("[data-money]")).map((one) => one.getAttribute("data-amount"));
    for (const figure of residualFigures) expect(inView).toContain(figure);
  });

  it("a report OF the residual run is refused as exposure, and shown only against the current run", async () => {
    // A results route that served the residual run (an older or faulty backend): its report names the residual's uuid.
    const residualReport = structuredClone(report);
    residualReport.simulation.uuid = roi.residual.simulation;
    const { container } = await mountEconomics(
      loaded,
      { report: { status: 200, body: JSON.stringify(residualReport) }, events: bytesOf(loaded, "events"), roi: bytesOf(loaded, "roi") },
      roi.residual.simulation,
    );
    expect(screen.getByTestId("residual-refused").textContent).toMatch(/not exposure/);
    for (const selector of EXPOSURE) expect(container.querySelector(selector), selector).toBeNull();
    expect(container.querySelector('[data-figure-section="current-against-residual"]')).not.toBeNull();
  });

  it("no exposure figure is shown until the views can tell whether the report is a residual run", async () => {
    let answerRoi: (answer: Answer) => void = () => {};
    const pending = new Promise<Answer>((resolve) => { answerRoi = resolve; });
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requested.push(String(url));
      if (String(url).startsWith("/api/economics/roi")) {
        const answer = await pending;
        return new Response(answer.body, { status: answer.status });
      }
      const one = bytesOf(loaded, String(url).startsWith("/api/economics/events") ? "events" : "report");
      return new Response(one.body, { status: one.status });
    }));
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { render, waitFor } = await import("@testing-library/react");
    const { getQueryFn } = await import("@/lib/queryClient");
    const { EconomicsView } = await import("@/pages/Economics");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <EconomicsView deployment={report.scenario.deployment} scenario={report.scenario.uuid} />
      </QueryClientProvider>,
    );
    // The report has arrived and been read; the ROI read has not answered.
    const reportKey = ["/api/economics/report", { deployment: report.scenario.deployment, scenario: report.scenario.uuid }];
    await waitFor(() => expect(client.getQueryData(reportKey)).toBeDefined());
    expect(requested.some((url) => url.startsWith("/api/economics/roi"))).toBe(true);
    expect(screen.getByTestId("economics-loading")).not.toBeNull();
    expect(container.querySelectorAll("[data-money]")).toHaveLength(0);
    answerRoi(bytesOf(loaded, "roi"));
    await waitFor(() => expect(container.querySelector('[data-figure-section="distribution"]')).not.toBeNull());
  });
});
