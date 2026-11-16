// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { cleanup, within } from "@testing-library/react";

import { DIFFERENCE_LABEL } from "@/components/economics/CurrentAgainstResidual";
import { AT6B, MASTER, fixture, served, type Fixture } from "./helpers/economics-fixtures";
import { bytesOf, mountEconomics, renderedAmounts, shims, textNodes, type Answer } from "./helpers/economics-render";

/**
 * The ROI view says what each figure is (Athena-Backend #237, the ROI document's v2):
 * each figure's kind as the backend states it, "estimate" on an estimated expense,
 * the pairs it sets side by side with the reason they do not add, and what each
 * figure nets. A tail's difference of two percentiles reads "difference of modelled
 * percentiles, not a saving", whether the backend serves it as
 * `difference_of_percentiles` (#237) or as `reduction` (an older backend): either
 * merges first. The view never says clean, resolved, secure or safe, and never
 * calls a modelled difference a saving. Every document is the backend's own answer,
 * SYNTHETIC (tests/fixtures/economics/generate.py).
 */

beforeAll(shims);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NEW = fixture(AT6B, "roi-policy");
const OLD = fixture(MASTER, "roi-policy");
const REASSURANCE = /\b(clean(?:ed|ly)?|resolve[ds]?|secured?|safe(?:ly)?)\b/i;
const SAVING = /\bsav(?:e|ed|es|ing|ings)\b/gi;
const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>‮​ & "quoted"`;
const LINES: Array<[string, (roi: any) => any]> = [["roi-tail", (roi) => roi.figures], ["roi-gross-tail", (roi) => roi.figures.gross_cash]];

async function view(loaded: Fixture, roi?: Answer): Promise<HTMLElement> {
  const { container } = await mountEconomics(loaded, {
    report: bytesOf(loaded, "report"),
    events: bytesOf(loaded, "events"),
    roi: roi ?? bytesOf(loaded, "roi"),
  });
  const found = container.querySelector('[data-figure-section="current-against-residual"]') as HTMLElement | null;
  if (found === null) throw new Error("the current-against-residual view is not rendered");
  return found;
}

function edited(change: (roi: any) => void): Answer {
  const roi = structuredClone(served(NEW, "roi")) as any;
  change(roi);
  return { ...bytesOf(NEW, "roi"), body: JSON.stringify(roi) };
}

describe("a tail's difference of two percentiles", () => {
  for (const [backend, loaded, key] of [["#237", NEW, "difference_of_percentiles"], ["an older backend", OLD, "reduction"]] as const) {
    it(`is read from ${key} (${backend}) and labelled a difference of modelled percentiles, not a saving`, async () => {
      const roi = served(loaded, "roi") as any;
      const el = await view(loaded);
      for (const [id, block] of LINES) {
        for (const tail of ["p90", "p95"]) {
          const part = block(roi).tail_reduction[tail];
          expect(typeof part[key]).toBe("string");
          const row = within(el).getByTestId(`${id}-${tail}`);
          expect(renderedAmounts(row)).toEqual([part.current, part.residual, part[key]]);
          expect(row.querySelector("[data-tail-difference]")?.textContent).toBe(DIFFERENCE_LABEL);
          // The view's own words never call it a reduction (the backend's quoted reason may name one).
          const own = row.cloneNode(true) as HTMLElement;
          own.querySelectorAll("[data-not-a-measure]").forEach((one) => one.remove());
          expect(own.textContent).not.toMatch(/\breduction\b/);
        }
      }
      expect(DIFFERENCE_LABEL).toBe("difference of modelled percentiles, not a saving");
    });
  }

  it("served as not reported shows the backend's reason, under either key", async () => {
    for (const key of ["difference_of_percentiles", "reduction"]) {
      const answer = edited((roi) => {
        const part = roi.figures.tail_reduction.p95;
        delete part.difference_of_percentiles;
        part[key] = null;
        part.not_reported = "the runs' severe-but-plausible percentile is not 95";
      });
      const row = within(await view(NEW, answer)).getByTestId("roi-tail-p95");
      expect(row.querySelector("[data-not-served]")?.textContent).toContain("the runs' severe-but-plausible percentile is not 95");
      cleanup();
      vi.unstubAllGlobals();
    }
  });
});

describe("each figure's kind", () => {
  it("is shown as #237 states it, with 'estimate' on the estimated expense and the reason a figure is not a measure", async () => {
    const roi = served(NEW, "roi") as any;
    const el = await view(NEW);
    const kinds = Array.from(el.querySelectorAll("[data-kind]")).map((one) => one.getAttribute("data-kind"));
    // Every figure shown on both lines, the first-year investment once (its base).
    expect(kinds).toHaveLength(roi.measures.length - 2);
    expect(new Set(kinds)).toEqual(new Set(["modeled_exposure", "remediation_expense"]));
    expect(within(el).getByTestId("roi-reduction").querySelector('[data-kind="modeled_exposure"]')?.textContent).toBe("(modelled exposure)");
    const investment = within(el).getByTestId("roi-investment");
    expect(investment.querySelector('[data-kind="remediation_expense"]')?.textContent).toContain("(expense)");
    expect(investment.querySelector('[data-mark="estimate"]')).not.toBeNull();
    expect(el.querySelectorAll('[data-mark="estimate"]')).toHaveLength(1);
    const difference = roi.measures.find((one: any) => one.label === "tail_reduction.p90.difference_of_percentiles" && one.section === "headline");
    expect(difference.measure).toBeNull();
    const row = within(el).getByTestId("roi-tail-p90");
    expect(row.querySelector("[data-not-a-measure]")?.textContent).toBe(`not held as a measure: ${difference.why}`);
    expect(within(el).queryByTestId("roi-kinds-not-served")).toBeNull();
  });

  it("follows the served flag: an expense not served as an estimate carries no estimate mark", async () => {
    const answer = edited((roi) => {
      for (const one of roi.measures) if (one.kind === "remediation_expense") one.estimate = false;
    });
    const el = await view(NEW, answer);
    expect(el.querySelector('[data-mark="estimate"]')).toBeNull();
    expect(within(el).getByTestId("roi-investment").querySelector('[data-kind="remediation_expense"]')).not.toBeNull();
  });

  it("from a backend that serves no kinds, is said not to be served, and nothing is guessed", async () => {
    const el = await view(OLD);
    expect(el.querySelectorAll("[data-kind]")).toHaveLength(0);
    expect(within(el).getByTestId("roi-kinds-not-served").textContent).toBe("The kind of each figure is not served by this backend version.");
    expect(within(el).queryByTestId("roi-side-by-side")).toBeNull();
    expect(within(el).getByTestId("roi-nets").textContent).toContain("this backend version does not say what each figure nets");
  });
});

describe("the pairs set side by side, and what each figure nets", () => {
  it("shows every pair with both kinds and the reason they do not add", async () => {
    const roi = served(NEW, "roi") as any;
    const el = await view(NEW);
    const items = Array.from(within(el).getByTestId("roi-side-by-side").querySelectorAll("[data-side-by-side]"));
    expect(items).toHaveLength(roi.side_by_side.length);
    expect(roi.side_by_side.length).toBeGreaterThan(0);
    roi.side_by_side.forEach((pair: any, index: number) => {
      expect(items[index].querySelector("[data-do-not-add]")?.textContent).toBe(`they do not add (${pair.do_not_add})`);
      expect(items[index].textContent).toContain(pair.statement);
    });
    const costPair = items[roi.side_by_side.findIndex((pair: any) => pair.do_not_add === "modeled_with_booked")];
    expect(costPair.textContent).toContain("headline: expected reduction (modelled exposure) beside headline: first year investment.base (expense)");
  });

  it("shows what the document says each figure nets", async () => {
    const roi = served(NEW, "roi") as any;
    const nets = within(await view(NEW)).getByTestId("roi-nets");
    for (const statement of Object.values(roi.nets) as string[]) expect(nets.textContent).toContain(statement);
    for (const label of ["Expected reduction", "Tail percentiles", "First-year investment", "Risk-adjusted ROI", "Payback", "Period", "Basis"]) {
      expect(nets.textContent).toContain(label);
    }
  });
});

describe("its words", () => {
  for (const [backend, loaded] of [["#237", NEW], ["an older backend", OLD]] as const) {
    it(`never say clean, resolved, secure or safe, and never call a modelled difference a saving (${backend})`, async () => {
      const el = await view(loaded);
      const nodes = textNodes(el);
      expect(nodes.filter((one) => REASSURANCE.test(one))).toEqual([]);
      for (const node of nodes) {
        for (const match of node.matchAll(SAVING)) {
          const clause = node.slice(0, match.index).split(/[.;:]/).pop() ?? "";
          expect(clause, node).toMatch(/\b(not|never)\b/);
        }
      }
    });
  }

  it("render served hostile text inert: no markup, the characters as text", async () => {
    const answer = edited((roi) => {
      roi.nets.expected_reduction = HOSTILE;
      roi.side_by_side[0].statement = HOSTILE;
      roi.side_by_side[0].left = HOSTILE;
      roi.side_by_side[1].do_not_add = HOSTILE;
      const difference = roi.measures.find((one: any) => one.measure === null);
      difference.why = HOSTILE;
      roi.measures[0].kind = HOSTILE;
    });
    const el = await view(NEW, answer);
    expect(el.querySelector("img, script")).toBeNull();
    const shown = textNodes(el).join("");
    expect(shown).toContain('<img src=x onerror="alert(1)">');
    expect(shown).toContain("<script>alert(2)</script>");
    expect(within(el).getByTestId("roi-nets").textContent).toContain(HOSTILE);
  });
});
