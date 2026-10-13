// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

import { BridgeRecord } from "@/components/economics/CurrencyBridge";
import { MASTER, fixture, served } from "./helpers/economics-fixtures";
import { NOT_SERVED_ROI, bytesOf, mountEconomics, shims } from "./helpers/economics-render";

/**
 * Honesty rule: `excluded_from_totals`, and every reason a figure is downgraded or
 * not for capital decisions, is visible -- the banner's reason, a failed integrity
 * check, every unknown, every downgrade of the grade (the headline's and each
 * line's), and a conversion's downgrades.
 */

beforeAll(shims);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card = (container: HTMLElement) => container.querySelector('[data-section="scenario-card"]') as HTMLElement;

describe("excluded from every total, and why", () => {
  it("an Unknown result says it is excluded, why, and every unknown behind it", async () => {
    const loaded = fixture(MASTER, "unknown-usd");
    const report = served(loaded, "report") as Record<string, any>;
    expect(report.excluded_from_totals).toBe(true);
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), events: bytesOf(loaded, "events"), roi: NOT_SERVED_ROI });
    expect(within(card(container)).getByTestId("excluded-from-totals").textContent).toBe("yes");
    expect(within(card(container)).getByTestId("banner-reason").textContent).toBe(report.banner_reason);
    expect(report.unknowns.length).toBeGreaterThan(0);
    for (const unknown of report.unknowns) {
      const shown = container.querySelector(`[data-unknown="${unknown.id}"]`) ?? null;
      // An unknown component is shown where the waterfall lists it, with its reason.
      const component = container.querySelector(`[data-component="${String(unknown.id).split("/")[1]}"]`);
      expect(shown !== null || component?.textContent?.includes(unknown.reason), unknown.id).toBe(true);
    }
  });

  it("a graded result says it is not excluded", async () => {
    const loaded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), events: bytesOf(loaded, "events"), roi: NOT_SERVED_ROI });
    expect(within(card(container)).getByTestId("excluded-from-totals").textContent).toBe("no");
  });

  it("rows that no longer verify name the check they failed", async () => {
    const loaded = fixture(MASTER, "unverified-usd");
    const report = served(loaded, "report") as Record<string, any>;
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), roi: NOT_SERVED_ROI });
    expect(within(card(container)).getByTestId("integrity").textContent).toBe(`not verified: failed ${report.integrity.failed.join(", ")}`);
    expect(within(card(container)).getByTestId("excluded-from-totals").textContent).toBe("yes");
    expect(within(card(container)).getByTestId("banner-reason").textContent).toBe(report.banner_reason);
    expect(container.querySelector('[data-unknown="stored_row_unverified"]')).not.toBeNull();
  });

  it("the ROI document's exclusion and its reason (#160)", async () => {
    const loaded = fixture(MASTER, "roi-unknown");
    const roi = served(loaded, "roi") as Record<string, any>;
    expect(roi.excluded_from_totals).toBe(true);
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), events: bytesOf(loaded, "events"), roi: bytesOf(loaded, "roi") });
    const view = container.querySelector('[data-figure-section="current-against-residual"]') as HTMLElement;
    const shown = within(view).getByTestId("roi-excluded-from-totals").textContent ?? "";
    expect(shown.startsWith("yes")).toBe(true);
    expect(shown).toContain(roi.banner_reason);
  });
});

describe("every downgrade reason", () => {
  it("the grade's downgrades, the headline's and each line's, by rule and meaning", async () => {
    const loaded = fixture(MASTER, "stale-usd");
    const report = served(loaded, "report") as Record<string, any>;
    const grade = report.validity_card.fields.confidence_grade;
    expect(grade.downgrades.length).toBeGreaterThan(0);
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), roi: NOT_SERVED_ROI });
    const downgrades = container.querySelector('[data-testid="card-downgrades"]') as HTMLElement;
    for (const one of grade.downgrades) {
      const shown = downgrades.querySelector(`[data-downgrade="${one.rule}"]`);
      expect(shown?.textContent, one.rule).toContain(one.meaning);
    }
    for (const [line, lineGrade] of Object.entries(grade.lines as Record<string, any>)) {
      if (lineGrade === null) continue;
      const shown = container.querySelector(`[data-card-line="${line}"]`) as HTMLElement;
      for (const one of lineGrade.downgrades) expect(shown.querySelector(`[data-downgrade="${one.rule}"]`), `${line} ${one.rule}`).not.toBeNull();
    }
  });

  it("a conversion's downgrades, where a bridge is served", () => {
    const record = fixture(MASTER, "bridge-jpy-estimated").engine_record as Record<string, any>;
    expect(record.confidence_downgrades).toEqual(["estimated_rate"]);
    const { container } = render(<BridgeRecord record={record} />);
    for (const reason of record.confidence_downgrades) {
      expect(Array.from(container.querySelectorAll('[data-mark="downgraded"]')).some((one) => one.textContent?.includes(reason))).toBe(true);
    }
  });
});
