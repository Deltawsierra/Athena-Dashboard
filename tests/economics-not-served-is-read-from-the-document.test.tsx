// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { cleanup, within } from "@testing-library/react";

import { MASTER, fixture, served } from "./helpers/economics-fixtures";
import { NOT_SERVED_ROI, bytesOf, mountEconomics, renderedAmounts, shims, type Answer } from "./helpers/economics-render";

/**
 * "Not served" is read from the served document, never written in (review round 1,
 * LOW-4): a field the document has is shown (or, where this dashboard does not
 * read it yet, said so), and only a field it truly lacks reads "not served". Against
 * Athena-Backend master 4c1edf3, which serves the deployment's standing decision
 * and the gross-cash line beside a retained headline (#160), and does not serve a
 * valuation date, a currency bridge or a receipt's signed bytes for a report.
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

  it("the valuation date: 'not served' while the report has none, and shown once it does", async () => {
    expect("valuation_date" in report).toBe(false);
    const absent = await mount(bytesOf(graded, "report"));
    expect(within(absent.container).getByTestId("scenario-valuation-date").textContent).toMatch(/^not served/);
    cleanup();
    vi.unstubAllGlobals();
    const present = await mount(withField(report, ["valuation_date"], "2026-09-30"));
    const shown = within(present.container).getByTestId("scenario-valuation-date").textContent;
    expect(shown).toBe("2026-09-30");
  });

  it("a receipt's signed bytes: 'not served' while the report names no route for them, never once it does", async () => {
    const absent = await mount(bytesOf(graded, "report"));
    expect(within(absent.container).getByTestId("receipt-download").textContent).toMatch(/not served: the report names no route/);
    cleanup();
    vi.unstubAllGlobals();
    const present = await mount(withField(report, ["receipt", "url"], "/api/assurance/economics/receipts/x/"));
    const shown = within(present.container).getByTestId("receipt-download").textContent ?? "";
    expect(shown).not.toMatch(/not served/);
    expect(shown).toMatch(/served \(receipt\.url\), but not read by this dashboard version yet/);
  });

  it("a currency bridge: 'not served' while the report carries none, and rendered from the record once it does", async () => {
    const absent = await mount(bytesOf(graded, "report"));
    expect(within(absent.container).getByTestId("bridge-steps").textContent).toMatch(/not served: Athena-Backend serves no currency bridge/);
    cleanup();
    vi.unstubAllGlobals();
    const record = fixture(MASTER, "bridge-eur-normalized").engine_record;
    const present = await mount(withField(report, ["currency_bridge"], record));
    const steps = within(present.container).getByTestId("bridge-steps");
    expect(steps.textContent).not.toMatch(/not served/);
    expect(steps.querySelectorAll("[data-bridge-step]")).toHaveLength(3);
  });
});
