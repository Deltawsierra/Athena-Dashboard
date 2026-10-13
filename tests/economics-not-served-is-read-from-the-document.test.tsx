// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { cleanup, within } from "@testing-library/react";

import { MASTER, fixture, served } from "./helpers/economics-fixtures";
import { NOT_SERVED_ROI, bytesOf, mountEconomics, renderedAmounts, shims, type Answer } from "./helpers/economics-render";

/**
 * "Not served" is read from the served document, never written in (review round 1,
 * LOW-4): a field the document has is shown (or, where this dashboard does not
 * read it yet, said so), and only a field it truly lacks reads "not served"; a
 * field served as not reported shows the backend's reason. Against Athena-Backend
 * master e7ee3eb, which serves the deployment's standing decision and the
 * gross-cash line beside a retained headline (#160), and a report's valuation date
 * and currency bridge, and a receipt's signed bytes (#163).
 */

beforeAll(shims);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view = (container: HTMLElement) => container.querySelector('[data-figure-section="current-against-residual"]') as HTMLElement;
const without = (doc: Record<string, unknown>, ...path: string[]): Answer => {
  const copy = structuredClone(doc) as Record<string, any>;
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key];
  delete parent[path[path.length - 1]];
  return { status: 200, body: JSON.stringify(copy) };
};
const withField = (doc: Record<string, unknown>, path: string[], value: unknown): Answer => {
  const copy = structuredClone(doc) as Record<string, any>;
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key];
  parent[path[path.length - 1]] = value;
  return { status: 200, body: JSON.stringify(copy) };
};

describe("the ROI document's fields (#160, merged)", () => {
  const policy = fixture(MASTER, "roi-policy");
  const roi = served(policy, "roi") as Record<string, any>;

  it("the deployment's standing decision is shown as served, never as 'not served'", async () => {
    expect(roi.deployment_decision.statement).toBeTruthy();
    const { container } = await mountEconomics(policy, { report: bytesOf(policy, "report"), events: bytesOf(policy, "events"), roi: bytesOf(policy, "roi") });
    const shown = within(view(container)).getByTestId("roi-deployment-decision");
    expect(shown.textContent).toContain(roi.deployment_decision.statement);
    expect(shown.textContent).toContain(roi.deployment_decision.veto);
    expect(shown.textContent).not.toMatch(/not served/);
  });

  it("is 'not served' only where the document has no such field", async () => {
    const { container } = await mountEconomics(policy, { report: bytesOf(policy, "report"), roi: without(roi, "deployment_decision") });
    expect(within(view(container)).getByTestId("roi-deployment-decision").textContent).toMatch(/^not served/);
  });

  it("the gross-cash line beside a retained headline: its figures as served", async () => {
    expect(roi.line).toBe("retained_cash");
    const gross = roi.figures.gross_cash;
    const { container } = await mountEconomics(policy, { report: bytesOf(policy, "report"), events: bytesOf(policy, "events"), roi: bytesOf(policy, "roi") });
    const shown = within(view(container)).getByTestId("roi-gross-beside-retained");
    expect(shown.textContent).not.toMatch(/not served/);
    expect(renderedAmounts(shown)).toEqual(expect.arrayContaining([
      gross.current_expected_annual_exposure, gross.residual_expected_annual_exposure, gross.expected_reduction,
      gross.tail_reduction.p90.current, gross.tail_reduction.p95.residual,
    ]));
    expect(within(shown).getByTestId("roi-gross-ratio").textContent).toContain(gross.risk_adjusted_roi.value);
    expect(within(shown).getByTestId("roi-gross-payback").textContent).toContain(gross.payback.value);
    expect(shown.textContent).toContain(roi.figures.gross_cash_statement);
  });

  it("a gross headline has no second line, and says so from the document", async () => {
    const clean = fixture(MASTER, "roi-clean");
    const cleanRoi = served(clean, "roi") as Record<string, any>;
    expect(cleanRoi.line).toBe("gross_cash");
    expect(cleanRoi.figures.gross_cash).toBeNull();
    const { container } = await mountEconomics(clean, { report: bytesOf(clean, "report"), roi: bytesOf(clean, "roi") });
    const shown = within(view(container)).getByTestId("roi-gross-beside-retained");
    expect(shown.textContent).toMatch(/The headline line is gross cash itself/);
    expect(shown.textContent).not.toMatch(/not served/);
  });

  it("the gross line is 'not served' only where the document has no such field", async () => {
    const { container } = await mountEconomics(policy, { report: bytesOf(policy, "report"), roi: without(roi, "figures", "gross_cash") });
    expect(within(view(container)).getByTestId("roi-gross-beside-retained").textContent).toMatch(/not served: the ROI document carries no gross-cash line/);
  });
});

describe("the report's fields", () => {
  const graded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
  const report = served(graded, "report") as Record<string, any>;
  const mount = (answer: Answer) => mountEconomics(graded, { report: answer, events: bytesOf(graded, "events"), roi: NOT_SERVED_ROI });

  it("the valuation date: the currency bridge's, with where it was read from, never 'not served'", async () => {
    const bridge = report.currency_bridge;
    expect(bridge.valuation_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const { container } = await mount(bytesOf(graded, "report"));
    const shown = within(container).getByTestId("scenario-valuation-date");
    expect(within(shown).getByTestId("valuation-date").textContent).toBe(bridge.valuation_date);
    expect(within(shown).getByTestId("valuation-date-from").textContent).toContain(bridge.valuation_date_from);
    expect(shown.textContent).not.toMatch(/not served/);
  });

  it("a valuation date read from the stored inputs says so, as served", async () => {
    const inputs = fixture(MASTER, "valuation-from-inputs-usd");
    const bridge = (served(inputs, "report") as Record<string, any>).currency_bridge;
    expect(bridge.valuation_date_from).not.toBe(report.currency_bridge.valuation_date_from);
    const { container } = await mountEconomics(inputs, { report: bytesOf(inputs, "report"), roi: NOT_SERVED_ROI });
    const shown = within(container).getByTestId("scenario-valuation-date");
    expect(within(shown).getByTestId("valuation-date").textContent).toBe(bridge.valuation_date);
    expect(within(shown).getByTestId("valuation-date-from").textContent).toContain(bridge.valuation_date_from);
  });

  it("a valuation date the report does not report shows the backend's reason: served, so never 'not served'", async () => {
    const missing = fixture(MASTER, "valuation-not-reported-usd");
    const bridge = (served(missing, "report") as Record<string, any>).currency_bridge;
    expect(bridge.valuation_date).toBeNull();
    const { container } = await mountEconomics(missing, { report: bytesOf(missing, "report"), roi: NOT_SERVED_ROI });
    for (const where of [within(container).getByTestId("scenario-valuation-date"), within(container).getByTestId("bridge-valuation-date")]) {
      expect(where.textContent).toContain(`not reported: ${bridge.not_reported}`);
      expect(where.textContent).not.toMatch(/not served/);
    }
  });

  it("a report with no currency bridge (v1) says the valuation date and the bridge are not served", async () => {
    const { container } = await mount(without(report, "currency_bridge"));
    expect(within(container).getByTestId("scenario-valuation-date").textContent).toMatch(/^not served: the report states no valuation date/);
    expect(within(container).getByTestId("bridge-steps").textContent).toMatch(/not served: Athena-Backend serves no currency bridge/);
  });

  it("the currency bridge: no conversion, with the backend's statement why, while `conversions` is empty", async () => {
    expect(report.currency_bridge.conversions).toEqual([]);
    const { container } = await mount(bytesOf(graded, "report"));
    const steps = within(container).getByTestId("bridge-steps");
    expect(within(steps).getByTestId("bridge-statement").textContent).toBe(report.currency_bridge.statement);
    expect(steps.textContent).not.toMatch(/not served/);
    expect(steps.querySelectorAll("[data-bridge-step]")).toHaveLength(0);
  });

  it("a conversion, once one is served, is rendered from its record", async () => {
    // The engine's own normalization record (bridge-eur-normalized): the shape a
    // conversion has; no route serves one at e7ee3eb (a run converts nothing).
    const record = fixture(MASTER, "bridge-eur-normalized").engine_record;
    const { container } = await mount(withField(report, ["currency_bridge", "conversions"], [record]));
    const steps = within(container).getByTestId("bridge-steps");
    expect(steps.textContent).not.toMatch(/not served/);
    expect(within(steps).queryByTestId("bridge-no-conversion")).toBeNull();
    expect(steps.querySelectorAll("[data-bridge-step]")).toHaveLength(3);
  });

  it("a receipt's signed bytes: offered for a recorded receipt, never 'not served'", async () => {
    const { container } = await mount(bytesOf(graded, "report"));
    const shown = within(container).getByTestId("receipt-download");
    expect(within(shown).getByTestId("receipt-download-button")).toBeTruthy();
    expect(shown.textContent).not.toMatch(/not served/);
  });

  it("a result with no receipt shows the backend's reason, and offers no bytes", async () => {
    const unknown = fixture(MASTER, "unknown-usd");
    const receipt = (served(unknown, "report") as Record<string, any>).receipt;
    expect(receipt.not_reported).toBeTruthy();
    const { container } = await mountEconomics(unknown, { report: bytesOf(unknown, "report"), roi: NOT_SERVED_ROI });
    expect(within(container).getByTestId("receipt-reference").textContent).toBe(`not reported: ${receipt.not_reported}`);
    const shown = within(container).getByTestId("receipt-download");
    expect(within(shown).queryByTestId("receipt-download-button")).toBeNull();
    expect(shown.textContent).toMatch(/none: this result has no recorded receipt/);
  });

  it("a report with no receipt field says it is not served", async () => {
    const { container } = await mount(without(report, "receipt"));
    expect(within(container).getByTestId("receipt-reference").textContent).toBe("not served: the report names no receipt");
    expect(within(container).queryByTestId("receipt-download-button")).toBeNull();
  });
});
