// @vitest-environment jsdom
/**
 * A scan finding's confidence is printed with the engine's own basis for it.
 *
 * The engine's confidence is ordinal: mythos-core `evidence.annotate` sets it from
 * the number of independent signals in the finding's evidence, and puts beside it,
 * as `confidence_basis`, "ordinal: derived from the number of independent signals
 * in the evidence. Not a probability that this finding is real." The BFF passes
 * the engine's findings through as they came, basis and all, and the Athena and
 * Penetration Testing screens printed `confidence 0.65` alone -- which reads as a
 * 65% chance the finding is real.
 *
 * Now the number is printed with that basis, verbatim and as text, as its title,
 * in the text a screen reader reads with it, and on screen. A finding the engine
 * sent no basis for says so, and none is made up. A finding with no number says
 * no confidence was recorded, never 0. No confidence is ever a percentage, a
 * meter or a bar.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** mythos-core `evidence.BASIS`, as the engine sends it on every finding it scores. */
const BASIS =
  "ordinal: derived from the number of independent signals in the evidence. " +
  "Not a probability that this finding is real.";
/** A basis with markup in it, which must reach the screen as the characters it is. */
const HTML_BASIS =
  `<img src="x" onerror="window.__basisRan = 1"><b>ordinal</b> & "not" a 'probability' ` +
  `<script>window.__basisRan = 2</script></p>`;

const engines = (basis: string) => `The engine's basis for this number: ${basis}`;
const NO_BASIS = "The engine sent no basis for this number.";
const BASIS_NOT_TEXT = "The engine sent a basis for this number that is not text, so it is not shown.";
const NO_CONFIDENCE = "no confidence recorded";
const NOT_A_NUMBER = "confidence not shown: the engine sent a value that is not a number";

/** One finding in the engine's shape; its message names the row. */
const finding = (message: string, over: Record<string, unknown>) => ({
  type: "reflected_xss", severity: "high", message, details: "the input came back unescaped", ...over,
});

const FINDINGS = [
  finding("three signals", { confidence: 0.65, confidence_basis: BASIS }),
  finding("no basis key", { confidence: 0.45 }),
  finding("a null basis", { confidence: 0.25, confidence_basis: null }),
  finding("an empty basis", { confidence: 0.25, confidence_basis: "" }),
  finding("a blank basis", { confidence: 0.25, confidence_basis: "   " }),
  finding("a basis that is not text", { confidence: 0.45, confidence_basis: { text: BASIS } }),
  finding("a null confidence", { confidence: null, confidence_basis: BASIS }),
  finding("no confidence key", {}),
  finding("a confidence that is not a number", { confidence: "0.65", confidence_basis: BASIS }),
  finding("a recorded zero", { confidence: 0, confidence_basis: BASIS }),
  finding("the ceiling", { confidence: 1, confidence_basis: BASIS }),
  finding("a tiny value", { confidence: 0.004, confidence_basis: BASIS }),
  finding("a percentage-sized value", { confidence: 52 }),
  finding("markup in the basis", { confidence: 0.8, confidence_basis: HTML_BASIS }),
];

const SEED = (): Array<[unknown[], unknown]> => [
  [["/api/engine/status"], { configured: true, reachable: true, authorized: true, url: "http://engine.test", detail: "" }],
  [["/api/clients"], [{ id: "c1", name: "Acme" }]],
  [["/api/sites"], []],
  [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
  [["/api/auth/check"], { authenticated: true, user: null }],
  // As GET /api/scans/:testId answers a run in flight: the engine's findings as it sent them.
  [["/api/scans/t1"], {
    test: { id: "t1", startedAt: new Date().toISOString(), criticalCount: 0, highCount: FINDINGS.length, mediumCount: 0, lowCount: 0 },
    state: "running",
    engine: { findings: FINDINGS },
  }],
];

function mount(ui: ReactElement) {
  const seed = SEED();
  const data = new Map(seed.map(([k, v]) => [JSON.stringify(k), v]));
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          const key = JSON.stringify(queryKey);
          if (data.has(key)) return data.get(key);
          throw new Error(`unexpected ${key}`);
        },
      },
    },
  });
  for (const [k, v] of seed) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Start a scan on the page as a person does; the POST answers test t1. */
async function startAScan() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ test: { id: "t1" }, runId: "run-1" }), {
    status: 201, headers: { "Content-Type": "application/json" },
  })));
  fireEvent.change(document.querySelectorAll("select")[0], { target: { value: "c1" } });
  fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://acme.test" } });
  fireEvent.click(screen.getByTestId("button-start-scan"));
  await waitFor(() => expect(screen.getByTestId("list-findings")).toBeTruthy());
}

/** The finding's row, found by its message. */
function row(message: string): HTMLElement {
  const item = screen.getByText(message).closest("li");
  expect(item, `no row for "${message}"`).not.toBeNull();
  return item as HTMLElement;
}

/** Whether a person looking at the screen can see `el`: nothing on it or above it hides it. */
function onScreen(el: Element): boolean {
  for (let at: Element | null = el; at; at = at.parentElement) {
    if (at.hasAttribute("hidden") || at.getAttribute("aria-hidden") === "true") return false;
    if (at.classList.contains("sr-only") || at.classList.contains("hidden")) return false;
  }
  return true;
}

/** Whether a screen reader reads `el`: nothing on it or above it hides it from one. */
function readAloud(el: Element): boolean {
  for (let at: Element | null = el; at; at = at.parentElement) {
    if (at.hasAttribute("hidden") || at.getAttribute("aria-hidden") === "true") return false;
    if (at.classList.contains("hidden")) return false;
  }
  return true;
}

/** No percentage in the row's text or in any attribute, and no meter, progress or bar. */
function expectNoPercentageOrMeter(item: HTMLElement) {
  expect(item.textContent).not.toMatch(/%/);
  for (const el of [item, ...Array.from(item.querySelectorAll("*"))]) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.value, `${el.tagName} ${attr.name}`).not.toMatch(/%/);
    }
  }
  expect(item.querySelector("meter, progress, [role='meter'], [role='progressbar']")).toBeNull();
}

/** The row prints `value`, with `basis` as the number's title, its screen-reader text and on screen. */
function expectConfidence(message: string, value: string, basis: string) {
  const item = row(message);
  expect(item.textContent, `the number on "${message}"`).toContain(value);
  expect(item.textContent, `the basis on "${message}"`).toContain(basis);
  const line = item.querySelector("[data-testid='text-finding-confidence']");
  expect(line, `no confidence line on "${message}"`).not.toBeNull();
  const shown = item.querySelector("[data-testid='text-finding-confidence-value']")!;
  expect(shown.textContent).toBe(value);
  expect(onScreen(shown)).toBe(true);
  expect(line!.getAttribute("title")).toBe(basis);

  const sr = item.querySelector("[data-testid='text-finding-confidence-sr']");
  expect(sr, `no screen-reader basis on "${message}"`).not.toBeNull();
  expect(sr!.className).toBe("sr-only");
  expect(sr!.textContent).toBe(` (${basis})`);
  expect(readAloud(sr!)).toBe(true);

  const visible = item.querySelector("[data-testid='text-finding-confidence-basis']");
  expect(visible, `no visible basis on "${message}"`).not.toBeNull();
  expect(visible!.textContent).toBe(basis);
  expect(onScreen(visible!)).toBe(true);
  expect(readAloud(visible!)).toBe(true);

  expectNoPercentageOrMeter(item);
}

/** The row says `value` and nothing else about a confidence: no number, and no basis for one. */
function expectNoNumber(message: string, value: string) {
  const item = row(message);
  expect(item.textContent, `what "${message}" says of its confidence`).toContain(value);
  const line = item.querySelector("[data-testid='text-finding-confidence']");
  expect(line, `no confidence line on "${message}"`).not.toBeNull();
  expect(line!.textContent).toBe(value);
  expect(onScreen(line!)).toBe(true);
  expect(line!.hasAttribute("title")).toBe(false);
  expect(line!.textContent).not.toMatch(/\d/);
  expect(item.querySelector("[data-testid='text-finding-confidence-sr']")).toBeNull();
  expect(item.querySelector("[data-testid='text-finding-confidence-basis']")).toBeNull();
  expect(item.textContent).not.toContain(BASIS);
  expectNoPercentageOrMeter(item);
}

for (const [name, Page] of [["Athena", AthenaScan], ["Penetration testing", PentestScan]] as const) {
  describe(`${name}: a finding's confidence`, () => {
    it("is printed with the engine's basis, verbatim", async () => {
      mount(<Page />);
      await startAScan();
      expectConfidence("three signals", "confidence 0.65", engines(BASIS));
      expect(row("three signals").textContent).toContain(BASIS);
    });

    it("says the engine sent no basis where it sent none, and makes none up", async () => {
      mount(<Page />);
      await startAScan();
      expectConfidence("no basis key", "confidence 0.45", NO_BASIS);
      expectConfidence("a null basis", "confidence 0.25", NO_BASIS);
      expectConfidence("an empty basis", "confidence 0.25", NO_BASIS);
      expectConfidence("a blank basis", "confidence 0.25", NO_BASIS);
      expectConfidence("a percentage-sized value", "confidence 52.00", NO_BASIS);
      expectConfidence("a basis that is not text", "confidence 0.45", BASIS_NOT_TEXT);
      for (const message of ["no basis key", "a null basis", "an empty basis", "a blank basis", "a basis that is not text"]) {
        expect(row(message).textContent).not.toContain("ordinal");
        expect(row(message).textContent).not.toContain("[object Object]");
      }
    });

    it("says no confidence was recorded where there is no number, and never prints a zero for it", async () => {
      mount(<Page />);
      await startAScan();
      expectNoNumber("a null confidence", NO_CONFIDENCE);
      expectNoNumber("no confidence key", NO_CONFIDENCE);
      expectNoNumber("a confidence that is not a number", NOT_A_NUMBER);
      // A zero the engine did record is still a number, with its basis.
      expectConfidence("a recorded zero", "confidence 0.00", engines(BASIS));
    });

    it("prints the number as the engine sent it, never as a percentage, a meter or a bar", async () => {
      mount(<Page />);
      await startAScan();
      expectConfidence("three signals", "confidence 0.65", engines(BASIS));
      expectConfidence("the ceiling", "confidence 1.00", engines(BASIS));
      // Two places would print 0.00, a different number.
      expectConfidence("a tiny value", "confidence 0.004", engines(BASIS));
      expectConfidence("a percentage-sized value", "confidence 52.00", NO_BASIS);
      const list = screen.getByTestId("list-findings");
      expect(list.textContent).not.toMatch(/65 ?%|100 ?%|0\.4 ?%|52 ?%/);
      expectNoPercentageOrMeter(list);
    });

    it("renders a basis with markup in it as text, never as HTML", async () => {
      (window as unknown as { __basisRan?: number }).__basisRan = undefined;
      mount(<Page />);
      await startAScan();
      expectConfidence("markup in the basis", "confidence 0.80", engines(HTML_BASIS));
      const item = row("markup in the basis");
      expect(item.querySelector("img, b, script")).toBeNull();
      expect(item.querySelector("[data-testid='text-finding-confidence-basis']")!.children).toHaveLength(0);
      expect(item.querySelector("[data-testid='text-finding-confidence-sr']")!.children).toHaveLength(0);
      expect((window as unknown as { __basisRan?: number }).__basisRan).toBeUndefined();
    });

    it("gives a screen reader the basis with the number, and hides nothing on screen from one", async () => {
      mount(<Page />);
      await startAScan();
      // Every number is read aloud with a basis.
      for (const one of FINDINGS.filter((f) => typeof f.confidence === "number")) {
        const sr = row(one.message).querySelector(".sr-only");
        expect(sr, `no screen-reader text on "${one.message}"`).not.toBeNull();
        expect(sr!.textContent).toMatch(/^ \((The engine's basis for this number: .+|The engine sent .+)\)$/);
      }
      for (const item of Array.from(screen.getByTestId("list-findings").querySelectorAll("li"))) {
        const line = item.querySelector("[data-testid='text-finding-confidence']");
        expect(line, `no confidence line on "${item.textContent}"`).not.toBeNull();
        expect(readAloud(line!)).toBe(true);
        const sr = line!.querySelector("[data-testid='text-finding-confidence-sr']");
        const title = line!.getAttribute("title");
        // Where the line has a basis, a screen reader reads that same basis with the
        // number, and it is on screen beside it.
        if (title !== null) {
          expect(sr!.className).toBe("sr-only");
          expect(sr!.textContent).toBe(` (${title})`);
          expect(readAloud(sr!)).toBe(true);
          expect(item.querySelector("[data-testid='text-finding-confidence-basis']")!.textContent).toBe(title);
        } else {
          expect(sr).toBeNull();
        }
        for (const el of Array.from(item.querySelectorAll("[aria-hidden='true'], [hidden]"))) {
          expect(el.textContent, "text hidden from a screen reader").toBe("");
        }
      }
    });
  });
}
