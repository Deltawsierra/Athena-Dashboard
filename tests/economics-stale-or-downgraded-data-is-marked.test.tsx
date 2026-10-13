// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { BridgeRecord } from "@/components/economics/CurrencyBridge";
import { MASTER, fixture, served } from "./helpers/economics-fixtures";
import { NO_ROI_ROUTE, bytesOf, mountEconomics, shims } from "./helpers/economics-render";

/**
 * Honesty rule: stale or downgraded data is visibly marked -- a figure past its
 * fresh_until at the run's as-of date, the grade it lowered, and a conversion
 * step that is an estimate or carries a downgrade. Only those: fresh data carries
 * no mark.
 */

beforeAll(shims);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("stale data", () => {
  it("the figure past its fresh_until is marked stale, and the grade it lowered marked downgraded", async () => {
    const loaded = fixture(MASTER, "stale-usd");
    const report = served(loaded, "report") as Record<string, any>;
    const freshness = report.validity_card.fields.data_freshness;
    expect(freshness.stale).toEqual(["frequency"]);
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), roi: NO_ROI_ROUTE });
    for (const one of freshness.parameters) {
      const row = container.querySelector(`[data-freshness="${one.name}"]`) as HTMLElement;
      const stale = freshness.stale.includes(one.name);
      expect(row.getAttribute("data-stale"), one.name).toBe(stale ? "true" : "false");
      expect(row.querySelector('[data-mark="stale"]') !== null, one.name).toBe(stale);
    }
    expect(container.querySelector('[data-testid="card-stale-parameters"] [data-mark="stale"]')).not.toBeNull();
    const downgraded = container.querySelector('[data-testid="card-downgrades"] [data-mark="downgraded"]');
    expect(downgraded?.textContent).toContain("stale_inputs");
  });

  it("fresh data carries no mark", async () => {
    const loaded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
    const report = served(loaded, "report") as Record<string, any>;
    expect(report.validity_card.fields.data_freshness.stale).toEqual([]);
    expect(report.validity_card.fields.confidence_grade.downgrades).toEqual([]);
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), events: bytesOf(loaded, "events"), roi: NO_ROI_ROUTE });
    expect(container.querySelectorAll('[data-mark="stale"], [data-mark="downgraded"]')).toHaveLength(0);
  });
});

describe("a conversion step", () => {
  it("an interpolated rate is marked an estimate and downgraded, on its own step", () => {
    const record = fixture(MASTER, "bridge-jpy-estimated").engine_record as Record<string, any>;
    const { container } = render(<BridgeRecord record={record} />);
    for (const step of record.chain) {
      const shown = container.querySelector(`[data-bridge-step="${step.step}"]`) as HTMLElement;
      expect(shown.querySelector('[data-mark="estimate"]') !== null, step.step).toBe(step.estimate === true);
      expect(shown.querySelectorAll('[data-mark="downgraded"]').length, step.step).toBe(step.downgrades.length);
      expect(shown.querySelector('[data-mark="stale"]') !== null, step.step).toBe(step.stale === true);
    }
    expect(record.chain.some((step: any) => step.estimate)).toBe(true);
  });

  it("an exact conversion carries no mark", () => {
    const record = fixture(MASTER, "bridge-eur-normalized").engine_record as Record<string, any>;
    const { container } = render(<BridgeRecord record={record} />);
    expect(container.querySelectorAll("[data-mark]")).toHaveLength(0);
  });
});
