// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import Money from "@/components/economics/Money";
import { MASTER, fixture, served, servedStrings, type Fixture } from "./helpers/economics-fixtures";
import { NOT_SERVED_ROI, bytesOf, decimalTokens, mountEconomics, renderedAmounts, shims } from "./helpers/economics-render";

/**
 * Honesty rule: the browser does NO arithmetic on money. No sum, no conversion, no
 * rounding beyond showing the served decimal string with the served currency's
 * minor units (JPY 0 places, KWD 3), and money is never parsed to a float.
 *
 * So every amount the views render is a string the backend served, character for
 * character, and every decimal anywhere in the rendered text is part of one: a
 * figure the browser made (a sum, a difference, a conversion, a rounding) is a
 * string no document holds.
 */

beforeAll(shims);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("an amount is the served string, exactly", () => {
  it("keeps every digit a float would lose, and every trailing zero", () => {
    const shown = (value: unknown, currency: string, minorUnit?: number) => {
      const { container } = render(<Money value={value} currency={currency} minorUnit={minorUnit} />);
      const amount = container.querySelector("[data-money]");
      const text = amount?.textContent ?? null;
      cleanup();
      return text;
    };
    // 2^53 + 1 and more: a float reads 90071992547409931.25 as 90071992547409936.
    expect(shown("90071992547409931.25", "USD", 2)).toBe("USD 90071992547409931.25");
    expect(shown("0.10", "USD", 2)).toBe("USD 0.10");
    expect(shown("1234567", "JPY", 0)).toBe("JPY 1234567");
    expect(shown("12.345", "KWD", 3)).toBe("KWD 12.345");
    expect(shown("-0.005", "KWD", 3)).toBe("KWD -0.005");
  });

  it("keeps a value below 2^53 that a double cannot hold, and adds nothing up", () => {
    const shown = (value: string, minorUnit?: number) => {
      const { container } = render(<Money value={value} currency="USD" minorUnit={minorUnit} />);
      const text = container.querySelector("[data-money]")?.textContent ?? null;
      cleanup();
      return text;
    };
    // Below 2^53, with more significant digits than a double keeps: as a float it reads 4503599627370496.
    expect(shown("4503599627370495.99", 2)).toBe("USD 4503599627370495.99");
    // An amount as recorded (no minor unit stated) is the string, never a float's rendering of it.
    expect(shown("0.3")).toBe("USD 0.3");
    expect(shown("0.30000000000000004441")).toBe("USD 0.30000000000000004441");
  });

  it("refuses anything that is not a plain decimal string, rather than converting it, and does not repeat it", () => {
    for (const value of [1234.5, "1e3", "1e21", "1,234.50", " 12", "12.", "NaN", true]) {
      const { container } = render(<Money value={value} currency="USD" minorUnit={2} />);
      expect(container.querySelector("[data-money]"), String(value)).toBeNull();
      const refused = container.querySelector("[data-unreadable-amount]");
      expect(refused, String(value)).not.toBeNull();
      // The value it refuses is not shown, quoted or otherwise (review round 1, NIT-1).
      if (typeof value === "string" && value.trim() !== "") expect(refused!.textContent, value).not.toContain(value.trim());
      cleanup();
    }
  });

  it("never pads or rounds an amount to the minor unit: one served at other places is shown as served, and marked", () => {
    const { container } = render(<Money value="1234.5" currency="USD" minorUnit={2} />);
    expect(container.querySelector("[data-money]")?.getAttribute("data-amount")).toBe("1234.5");
    expect(container.querySelector("[data-minor-unit-mismatch]")).not.toBeNull();
  });
});

/** Every rendered amount is a served string; every rendered decimal is part of one. */
async function holdsToServed(loaded: Fixture, roi: "served" | "none") {
  const docs = [served(loaded, "report"), served(loaded, "events")];
  if (roi === "served") docs.push(served(loaded, "roi"));
  const { container } = await mountEconomics(loaded, {
    report: bytesOf(loaded, "report"),
    events: bytesOf(loaded, "events"),
    roi: roi === "served" ? bytesOf(loaded, "roi") : NOT_SERVED_ROI,
  });
  const strings = servedStrings(...docs);
  const amounts = renderedAmounts(container);
  expect(amounts.length).toBeGreaterThan(20);
  for (const amount of amounts) expect(strings.has(amount), `rendered ${amount}, which no document served`).toBe(true);
  const corpus = Array.from(strings).join("\n");
  for (const token of decimalTokens(container)) expect(corpus.includes(token), `rendered ${token}, which is in no served string`).toBe(true);
  return container;
}

describe("the views render only the backend's figures", () => {
  it("a graded USD report with a policy, a market-value line and a receipt", async () => {
    await holdsToServed(fixture(MASTER, "graded-usd-policy-market-value-receipt"), "none");
  });

  it("a figure below 2^53 that a double cannot hold, through the page's own read: exact (review round 1, NIT-2)", async () => {
    const loaded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
    const planted = structuredClone(served(loaded, "report")) as Record<string, any>;
    planted.summary.lines.gross_cash.p50 = "4503599627370495.99";
    planted.summary.lines.retained_cash.mean = "0.30";
    planted.loss_events[0].components[0].base = "1234567890123.45";
    const { container } = await mountEconomics(loaded, { report: { status: 200, body: JSON.stringify(planted) }, events: bytesOf(loaded, "events"), roi: NOT_SERVED_ROI });
    const amounts = renderedAmounts(container);
    for (const figure of ["4503599627370495.99", "0.30", "1234567890123.45"]) expect(amounts, figure).toContain(figure);
    expect(amounts).not.toContain("4503599627370496.00");
    expect(container.textContent).not.toContain("4503599627370496");
  });

  it("a report and its ROI document (#160): the reduction, the investment, the ROI and the payback are the backend's", async () => {
    await holdsToServed(fixture(MASTER, "roi-clean"), "served");
    cleanup();
    await holdsToServed(fixture(MASTER, "roi-vetoed"), "served");
  });

  it("JPY at 0 places and KWD at 3: as served, none padded, none rounded", async () => {
    for (const [name, code, places] of [["graded-jpy", "JPY", 0], ["graded-kwd", "KWD", 3]] as const) {
      const loaded = fixture(MASTER, name);
      const report = served(loaded, "report") as Record<string, any>;
      expect(report.currency).toMatchObject({ code, minor_unit: places });
      const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), roi: NOT_SERVED_ROI });
      const strings = servedStrings(report);
      const loss = Array.from(container.querySelectorAll("[data-figure-section] [data-money]"));
      expect(loss.length).toBeGreaterThan(20);
      for (const one of loss) {
        expect(one.getAttribute("data-currency")).toBe(code);
        expect(strings.has(one.getAttribute("data-amount")!)).toBe(true);
      }
      // The summary's figures are at the minor unit as served, and none is marked as off it.
      const p50 = report.summary.lines.gross_cash.p50 as string;
      expect(p50.includes(".") ? p50.split(".")[1].length : 0).toBe(places);
      expect(container.querySelectorAll("[data-figure-section] [data-minor-unit-mismatch]")).toHaveLength(0);
      cleanup();
      vi.unstubAllGlobals();
    }
  });
});
