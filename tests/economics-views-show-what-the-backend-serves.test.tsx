// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { BridgeRecord } from "@/components/economics/CurrencyBridge";
import { MASTER, fixture, served } from "./helpers/economics-fixtures";
import { NOT_SERVED_ROI, bytesOf, mountEconomics, renderedAmounts, shims } from "./helpers/economics-render";

/**
 * The eight financial views of one scenario version (MVP step 14), each showing
 * what Athena-Backend's economics routes serve and nothing else: the scenario
 * card, the distribution of gross AND retained cash, the cost waterfall with the
 * market-value reaction on its own line, the tornado as served, current against
 * residual (#160), the currency bridge, the Validity Card, and the receipt and the
 * report's bytes. The fixtures are the backend's own answers (SYNTHETIC).
 */

beforeAll(shims);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const graded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
const report = served(graded, "report") as Record<string, any>;
const events = served(graded, "events") as Record<string, any>;

const section = (container: HTMLElement, id: string) => {
  const found = container.querySelector(`[data-figure-section="${id}"], [data-section="${id}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no ${id} section`);
  return found;
};

describe("a graded report, with a policy, a market-value reaction and a receipt (backend master)", () => {
  it("the scenario card: name, template, deployment, grade, status, as-of, and the valuation date its currency bridge serves", async () => {
    const { container } = await mountEconomics(graded, { report: bytesOf(graded, "report"), events: bytesOf(graded, "events"), roi: NOT_SERVED_ROI });
    const card = within(section(container, "scenario-card"));
    expect(card.getByTestId("scenario-name").textContent).toBe(report.scenario.title);
    const template = events.events[0].template;
    expect(card.getByTestId("scenario-template").textContent).toContain(template.name);
    expect(card.getByTestId("scenario-template").textContent).toContain(`${template.template_id} v${template.version}`);
    expect(card.getByTestId("scenario-deployment").textContent).toContain(report.scenario.deployment);
    expect(card.getByTestId("scenario-grade").textContent).toContain(report.grade);
    expect(["A", "B", "C", "D"]).toContain(report.grade);
    expect(card.getByTestId("scenario-status").textContent).toContain("completed");
    expect(card.getByTestId("scenario-as-of").textContent).toContain(report.build.as_of);
    // The valuation date is the currency bridge's, with where the backend read it from (#163).
    expect(card.getByTestId("valuation-date").textContent).toBe(report.currency_bridge.valuation_date);
    expect(card.getByTestId("valuation-date-from").textContent).toContain(report.currency_bridge.valuation_date_from);
    expect(card.getByTestId("excluded-from-totals").textContent).toContain("no");
  });

  it("the distribution: P10, P50, P90, mean, expected annual loss and severe-but-plausible for gross AND retained cash, the headline marked, each line's grade, a range with every point", async () => {
    const { container } = await mountEconomics(graded, { report: bytesOf(graded, "report"), events: bytesOf(graded, "events"), roi: NOT_SERVED_ROI });
    const distribution = section(container, "distribution");
    const lines = report.summary.lines;
    for (const line of ["gross_cash", "retained_cash"]) {
      const block = distribution.querySelector(`[data-line="${line}"]`) as HTMLElement;
      expect(block, line).not.toBeNull();
      const amounts = renderedAmounts(block);
      for (const figure of ["p10", "p50", "p90", "mean", "expected_annual_loss", "severe_plausible"]) {
        expect(amounts, `${line}.${figure}`).toContain(lines[line][figure]);
      }
      // The point with its range: P50 within P10 to P90.
      const range = block.querySelector('[data-range="p10-p90"]') as HTMLElement;
      expect(renderedAmounts(range)).toEqual([lines[line].p50, lines[line].p10, lines[line].p90]);
      // Every other point with a range: its own band, or the line's P10 to P90.
      for (const point of Array.from(block.querySelectorAll("[data-point]"))) {
        expect(renderedAmounts(point as HTMLElement).length, point.getAttribute("data-point")!).toBeGreaterThanOrEqual(3);
      }
      const grade = report.validity_card.fields.confidence_grade.lines[line].grade;
      expect(block.querySelector("[data-line-grade]")?.textContent).toBe(`grade ${grade}`);
      expect(block.querySelector("[data-headline]") !== null, line).toBe(report.summary.headline === line);
    }
    expect(report.summary.headline).toBe("retained_cash");
    expect(distribution.textContent).toContain(`Severe but plausible (P${report.summary.severe_percentile})`);
    // The market-value reaction is apart from both cash lines.
    const market = distribution.querySelector("[data-market-value-distribution]") as HTMLElement;
    expect(renderedAmounts(market)).toContain(lines.market_value.p50);
    for (const line of ["gross_cash", "retained_cash"]) {
      expect(market.querySelector(`[data-line="${line}"]`)).toBeNull();
    }
  });

  it("the cost waterfall: the components in the report's order, the totals as served, and the market-value reaction on its own line, never among the cash", async () => {
    const { container } = await mountEconomics(graded, { report: bytesOf(graded, "report"), events: bytesOf(graded, "events"), roi: NOT_SERVED_ROI });
    const waterfall = section(container, "waterfall");
    const event = report.loss_events[0];
    const cashSteps = waterfall.querySelector("[data-cash-steps]") as HTMLElement;
    const servedCash = event.components.filter((c: any) => c.cash === true).map((c: any) => c.component_id);
    const servedMarket = event.components.filter((c: any) => c.cash !== true).map((c: any) => c.component_id);
    expect(servedMarket).toEqual(["share-price-reaction"]);
    expect(Array.from(cashSteps.querySelectorAll("[data-component]")).map((one) => one.getAttribute("data-component"))).toEqual(servedCash);
    const market = waterfall.querySelector("[data-market-value-line]") as HTMLElement;
    expect(Array.from(market.querySelectorAll("[data-component]")).map((one) => one.getAttribute("data-component"))).toEqual(servedMarket);
    expect(renderedAmounts(market.querySelector('[data-testid="event-market-value"]') as HTMLElement))
      .toEqual([event.market_value.low, event.market_value.base, event.market_value.high]);
    expect(renderedAmounts(waterfall.querySelector('[data-testid="event-gross-cash"]') as HTMLElement))
      .toEqual([event.gross_cash.low, event.gross_cash.base, event.gross_cash.high]);
    expect(renderedAmounts(waterfall.querySelector('[data-testid="event-retained-cash"]') as HTMLElement))
      .toEqual([event.retained_cash.low, event.retained_cash.base, event.retained_cash.high]);
    // The market-value reaction is outside every cash step and cash total.
    expect(cashSteps.contains(market)).toBe(false);
  });

  it("the tornado: the sensitivity rows as served, in rank order", async () => {
    const { container } = await mountEconomics(graded, { report: bytesOf(graded, "report"), events: bytesOf(graded, "events"), roi: NOT_SERVED_ROI });
    const rows = Array.from(section(container, "tornado").querySelectorAll("[data-tornado-row]"));
    expect(rows.map((one) => one.getAttribute("data-tornado-row"))).toEqual(report.sensitivity.tornado.map((one: any) => one.name));
    rows.forEach((row, index) => {
      const entry = report.sensitivity.tornado[index];
      expect(row.textContent).toContain(`importance ${entry.importance}`);
      expect(renderedAmounts(row as HTMLElement)).toEqual(expect.arrayContaining([entry.swing.low_outcome, entry.swing.high_outcome]));
    });
  });

  it("current against residual, the currency bridge, the Validity Card and the receipt, as served", async () => {
    const { container, deployment, scenario } = await mountEconomics(graded, { report: bytesOf(graded, "report"), events: bytesOf(graded, "events"), roi: NOT_SERVED_ROI });
    // The backend serves no ROI document for a scenario with no option: said so, nothing computed in its place.
    expect(screen.getByTestId("roi-not-served").textContent).toMatch(/^not served: Athena-Backend does not serve the remediation option's economics/);
    expect(renderedAmounts(section(container, "current-against-residual"))).toEqual([]);
    // The bridge: the reporting currency, the valuation date and the snapshots the report serves, and its
    // statement that no figure was converted (conversions: []); no conversion step it did not serve.
    const bridge = section(container, "currency-bridge");
    expect(bridge.textContent).toContain(report.currency.code);
    expect(within(bridge).getByTestId("bridge-reporting-currency").textContent).toContain(report.currency_bridge.reporting_currency);
    expect(within(bridge).getByTestId("valuation-date").textContent).toBe(report.currency_bridge.valuation_date);
    for (const snapshot of report.source_snapshots.snapshots) expect(bridge.textContent).toContain(snapshot.content_hash);
    expect(within(bridge).getByTestId("bridge-statement").textContent).toBe(report.currency_bridge.statement);
    expect(bridge.querySelectorAll("[data-bridge-step]")).toHaveLength(0);
    expect(bridge.textContent).not.toMatch(/not served/);
    // The Validity Card.
    const card = section(container, "validity-card");
    expect(within(card).getByTestId("card-grade").textContent).toBe(report.validity_card.grade);
    expect(card.textContent).toContain(report.validity_card.digest);
    // The receipt's reference as the report states it, and the report's own bytes to download.
    const receipt = section(container, "receipt");
    expect(within(receipt).getByTestId("receipt-digest").textContent).toBe(report.receipt.document_digest);
    expect(receipt.textContent).toContain(report.receipt.receipt_id);
    expect(within(receipt).getByTestId("report-digest").textContent).toContain(report.digest);
    // The download is pinned to the result on screen, though the page named none (review round 1, LOW-2).
    const link = within(receipt).getByTestId("report-download") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      `/api/economics/report?deployment=${deployment}&scenario=${scenario}&simulation=${report.simulation.uuid}&download=1`,
    );
    expect(link.hasAttribute("download")).toBe(true);
    expect(receipt.textContent).toMatch(/A fresh read of the same result/);
    // The receipt's signed bytes are offered, checked against the digest shown (tests/economics-the-receipt-is-saved-only-when-its-digests-agree).
    expect(within(receipt).getByTestId("receipt-download-button").textContent).toMatch(/Download the signed receipt/);
  });
});

describe("current against residual (Athena-Backend master e7ee3eb, #160 merged)", () => {
  const vetoed = fixture(MASTER, "roi-vetoed");
  const roi = served(vetoed, "roi") as Record<string, any>;

  it("states the veto ABOVE every figure, marks the ROI and payback display-only, and shows each figure as served", async () => {
    const { container } = await mountEconomics(vetoed, { report: bytesOf(vetoed, "report"), events: bytesOf(vetoed, "events"), roi: bytesOf(vetoed, "roi") });
    const view = section(container, "current-against-residual");
    const statement = view.querySelector("[data-veto-statement]") as HTMLElement;
    expect(roi.veto.applies).toBe(true);
    expect(statement.textContent).toBe(roi.veto.statement);
    expect(statement.textContent).toBe("remediation is required regardless of ROI");
    const amounts = Array.from(view.querySelectorAll("[data-money]"));
    expect(amounts.length).toBeGreaterThan(5);
    for (const amount of amounts) {
      expect(statement.compareDocumentPosition(amount) & Node.DOCUMENT_POSITION_FOLLOWING, amount.textContent!).toBeTruthy();
    }
    const figures = within(view).getByTestId("roi-figures");
    expect(within(figures).getByTestId("roi-ratio").textContent).toContain(roi.figures.risk_adjusted_roi.value);
    expect(within(figures).getByTestId("roi-payback").textContent).toContain(`${roi.figures.payback.value} years`);
    expect(figures.querySelectorAll("[data-display-only]")).toHaveLength(2);
    expect(renderedAmounts(within(figures).getByTestId("roi-reduction"))).toEqual([roi.figures.expected_reduction]);
    expect(renderedAmounts(within(figures).getByTestId("roi-investment")))
      .toEqual([roi.figures.first_year_investment.base, roi.figures.first_year_investment.low, roi.figures.first_year_investment.high]);
    // What #160 serves beside the economics: the deployment's standing decision, as served (never a veto),
    // and, for a gross headline, no second line.
    expect(within(view).getByTestId("roi-deployment-decision").textContent).toContain(roi.deployment_decision.statement);
    expect(within(view).getByTestId("roi-gross-beside-retained").textContent).toMatch(/The headline line is gross cash itself/);
    expect(within(view).getByTestId("roi-line").textContent).toBe("Gross cash");
  });

  it("says the veto does not apply where it does not, and shows no veto statement", async () => {
    const clean = fixture(MASTER, "roi-clean");
    const { container } = await mountEconomics(clean, { report: bytesOf(clean, "report"), events: bytesOf(clean, "events"), roi: bytesOf(clean, "roi") });
    const view = section(container, "current-against-residual");
    expect(view.querySelector('[data-veto="does-not-apply"]')).not.toBeNull();
    expect(view.querySelector("[data-veto-statement]")).toBeNull();
    expect(view.querySelectorAll("[data-display-only]")).toHaveLength(0);
  });
});

describe("the currency bridge renders the backend's own provenance record, step by step", () => {
  it("native amount, event-date FX, cost index, valuation-date FX: each with its source, observation date and snapshot hash", () => {
    const record = fixture(MASTER, "bridge-eur-normalized").engine_record as Record<string, any>;
    const { container } = render(<BridgeRecord record={record} />);
    const steps = Array.from(container.querySelectorAll("[data-bridge-step]"));
    expect(steps.map((one) => one.getAttribute("data-bridge-step"))).toEqual(["event_fx", "cost_index", "valuation_fx"]);
    steps.forEach((step, index) => {
      const served = record.chain[index];
      expect(renderedAmounts(step as HTMLElement)).toEqual([served.input.amount, served.output.amount]);
      const observations = Array.from(step.querySelectorAll("[data-observation]"));
      expect(observations).toHaveLength(served.observations.length);
      observations.forEach((observation, at) => {
        const one = served.observations[at];
        expect(observation.textContent).toContain(one.provider ?? one.series_id);
        expect(observation.textContent).toContain(one.effective_date ?? one.period);
        expect(observation.querySelector("[data-snapshot-hash]")?.textContent).toBe(one.source_snapshot_hash);
      });
    });
    expect(renderedAmounts(container).slice(0, 1)).toEqual([record.native.amount]);
    expect(container.querySelector("[data-bridge-display]")?.textContent).toBe(record.display);
  });

  it("an unavailable step is said so, with its reason, and no value is shown", () => {
    const record = fixture(MASTER, "bridge-unavailable").engine_record as Record<string, any>;
    const { container } = render(<BridgeRecord record={record} />);
    expect(record.status).toBe("unavailable");
    const unavailable = container.querySelector("[data-bridge-unavailable]") as HTMLElement;
    expect(unavailable.textContent).toContain(record.unavailable.reason);
    expect(container.querySelector("[data-bridge-display]")).toBeNull();
  });
});
