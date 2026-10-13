// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { cleanup } from "@testing-library/react";

import { SERVED_BANNER } from "@/lib/economics";
import { MASTER, PR160, fixture, served } from "./helpers/economics-fixtures";
import { NO_ROI_ROUTE, bytesOf, mountEconomics, shims } from "./helpers/economics-render";

/**
 * Honesty rule: a result graded Unknown (or not graded, or refused) shows the
 * report's banner text exactly -- "Unknown: not for capital decisions" -- above
 * EVERY figure: at the head of every section that shows one, before the first
 * amount in it.
 */

beforeAll(shims);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function bannerAboveEveryFigure(container: HTMLElement, banner: string) {
  const sections = Array.from(container.querySelectorAll("[data-figure-section]"));
  expect(sections.length).toBeGreaterThanOrEqual(3);
  for (const section of sections) {
    const id = section.getAttribute("data-figure-section");
    const shown = section.querySelector("[data-economics-banner] [data-banner-text]");
    expect(shown?.textContent, `${id} has no banner`).toBe(banner);
    for (const amount of Array.from(section.querySelectorAll("[data-money]"))) {
      expect(shown!.compareDocumentPosition(amount) & Node.DOCUMENT_POSITION_FOLLOWING, `${id}: ${amount.textContent} above the banner`).toBeTruthy();
    }
  }
}

describe("an Unknown grade", () => {
  it("carries the report's banner, exactly, above every figure of every view", async () => {
    const loaded = fixture(MASTER, "unknown-usd");
    const report = served(loaded, "report") as Record<string, any>;
    expect(report.grade).toBe("Unknown");
    expect(report.banner).toBe(SERVED_BANNER);
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), events: bytesOf(loaded, "events"), roi: NO_ROI_ROUTE });
    // Its figures are still shown (the owner-adopted default), each under the banner.
    expect(container.querySelector('[data-figure-section="distribution"] [data-money]')).not.toBeNull();
    bannerAboveEveryFigure(container, report.banner);
    // And on the scenario card, above its grade.
    expect(container.querySelector('[data-section="scenario-card"] [data-banner-text]')?.textContent).toBe(report.banner);
  });

  it("over the ROI document too: the current run graded Unknown bans its figures from capital decisions (#160)", async () => {
    const loaded = fixture(PR160, "roi-unknown");
    const roi = served(loaded, "roi") as Record<string, any>;
    expect(roi.banner).toBe(SERVED_BANNER);
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), events: bytesOf(loaded, "events"), roi: bytesOf(loaded, "roi") });
    const view = container.querySelector('[data-figure-section="current-against-residual"]') as HTMLElement;
    expect(view.querySelector("[data-money]")).not.toBeNull();
    bannerAboveEveryFigure(container, roi.banner);
  });

  it("a graded report carries no banner in any view", async () => {
    const loaded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
    const { container } = await mountEconomics(loaded, { report: bytesOf(loaded, "report"), events: bytesOf(loaded, "events"), roi: NO_ROI_ROUTE });
    expect(container.querySelectorAll("[data-economics-banner]")).toHaveLength(0);
  });
});
