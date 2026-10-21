// @vitest-environment jsdom
/**
 * A scan finding's narrative is shown on the scan-detail card when the engine
 * sent one, and nothing is shown when it did not.
 *
 * mythos-core's persona may render a short prose account of a real finding and
 * place it on the finding row as `narrative`, a plain string, under the engine's
 * own key. The BFF passes the engine's findings through as they came
 * (`GET /api/scans/:testId` -> `engine.findings`), so the narrative reaches the
 * Athena and Penetration Testing screens under that key.
 *
 * It is additive. Read off the wire, it is not trusted to be the type it should
 * be: it is shown, verbatim and as text, only when it is a string with something
 * in it a person can see. A finding whose narrative is absent, null, empty,
 * blank, invisible, or not a string at all is shown exactly as it was before --
 * no empty line, no placeholder, no `[object Object]` -- with its message and
 * its confidence line unchanged.
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

/** A narrative the engine sent, shown verbatim. */
const NARRATIVE =
  "The scanner sent a crafted value and the page returned it unescaped, so a value it is given can run as script in a visitor's session.";
/** A narrative with markup in it, which must reach the screen as the characters it is. */
const HTML_NARRATIVE =
  `<img src="x" onerror="window.__narrativeRan = 1"><b>reflected</b> & "unescaped" ` +
  `<script>window.__narrativeRan = 2</script>`;
/** A narrative with text in it among characters nobody sees, shown as sent. */
const VISIBLE_AMONG_INVISIBLE = "​the engine­ wrote⁠ this\u0007";

/** The engine's basis, carried so the confidence line is present and can be checked unchanged. */
const BASIS =
  "ordinal: derived from the number of independent signals in the evidence. " +
  "Not a probability that this finding is real.";

/** One finding in the engine's shape; its message names the row. */
const finding = (message: string, over: Record<string, unknown>) => ({
  type: "reflected_xss", severity: "high", message, details: "the input came back unescaped",
  confidence: 0.65, confidence_basis: BASIS, ...over,
});

/** Messages whose narrative is absent or has nothing to read: nothing is shown. */
const NOTHING_SHOWN = [
  "no narrative key", "a null narrative", "an empty narrative", "a blank narrative",
  "a zero-width narrative", "a narrative of controls and separators", "a default-ignorable narrative",
];
/** Messages whose narrative is not a string: ignored, and its shape is never printed. */
const NOT_A_STRING = [
  "a number for a narrative", "an object for a narrative", "an array for a narrative", "a boolean for a narrative",
];

const FINDINGS = [
  // Something to read: shown verbatim, as text.
  finding("a plain narrative", { narrative: NARRATIVE }),
  finding("text among invisible characters", { narrative: VISIBLE_AMONG_INVISIBLE }),
  finding("markup in the narrative", { narrative: HTML_NARRATIVE }),
  // Absent, or nothing to read: nothing is shown, and the finding is unchanged.
  finding("no narrative key", {}),
  finding("a null narrative", { narrative: null }),
  finding("an empty narrative", { narrative: "" }),
  finding("a blank narrative", { narrative: "   " }),
  finding("a zero-width narrative", { narrative: "​­⁠﻿" }),
  finding("a narrative of controls and separators", { narrative: "\u0000\u0007   \t\n" }),
  finding("a default-ignorable narrative", { narrative: "͏️ㅤᅟ" }),
  // Not a string: ignored, and its shape is never printed.
  finding("a number for a narrative", { narrative: 42 }),
  finding("an object for a narrative", { narrative: { text: NARRATIVE } }),
  finding("an array for a narrative", { narrative: ["a narrative in an array"] }),
  finding("a boolean for a narrative", { narrative: true }),
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

/** The row's narrative line, or null when it shows none. */
function narrativeOf(item: HTMLElement): Element | null {
  return item.querySelector("[data-testid='text-finding-narrative']");
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

/** The row's display apart from the narrative is intact: its message, and its confidence line. */
function expectFindingIntact(message: string) {
  const item = row(message);
  expect(item.textContent, `the message on "${message}"`).toContain(message);
  const confidence = item.querySelector("[data-testid='text-finding-confidence']");
  expect(confidence, `no confidence line on "${message}"`).not.toBeNull();
  expect(onScreen(confidence!)).toBe(true);
}

for (const [name, Page] of [["Athena", AthenaScan], ["Penetration testing", PentestScan]] as const) {
  describe(`${name}: a finding's narrative`, () => {
    it("is shown verbatim, as text, and on screen when the engine sent one", async () => {
      mount(<Page />);
      await startAScan();

      const plain = narrativeOf(row("a plain narrative"));
      expect(plain, "no narrative shown for a plain narrative").not.toBeNull();
      expect(plain!.textContent).toBe(NARRATIVE);
      expect(onScreen(plain!)).toBe(true);
      expect(readAloud(plain!)).toBe(true);

      // Invisible characters and all, exactly as the engine sent it.
      const among = narrativeOf(row("text among invisible characters"));
      expect(among, "no narrative shown among invisible characters").not.toBeNull();
      expect(among!.textContent).toBe(VISIBLE_AMONG_INVISIBLE);

      // The narrative does not disturb the rest of the card.
      expectFindingIntact("a plain narrative");
    });

    it("shows nothing where the engine sent no narrative, or one with nothing to read, and leaves the finding unchanged", async () => {
      mount(<Page />);
      await startAScan();

      for (const message of NOTHING_SHOWN) {
        const item = row(message);
        expect(narrativeOf(item), `a narrative was shown for "${message}"`).toBeNull();
        // The display is exactly what it was before: message and confidence line intact.
        expectFindingIntact(message);
      }
    });

    it("ignores a narrative that is not a string, and never prints its shape", async () => {
      mount(<Page />);
      await startAScan();

      for (const message of NOT_A_STRING) {
        const item = row(message);
        expect(narrativeOf(item), `a narrative was shown for "${message}"`).toBeNull();
        expect(item.textContent, `a non-string shape leaked on "${message}"`).not.toContain("[object Object]");
        expect(item.textContent).not.toContain("a narrative in an array");
        expectFindingIntact(message);
      }
      // The number, the boolean: their values are never printed as the narrative.
      expect(narrativeOf(row("a number for a narrative"))).toBeNull();
      expect(narrativeOf(row("a boolean for a narrative"))).toBeNull();
    });

    it("renders a narrative with markup in it as text, never as HTML", async () => {
      (window as unknown as { __narrativeRan?: number }).__narrativeRan = undefined;
      mount(<Page />);
      await startAScan();

      const item = row("markup in the narrative");
      const line = narrativeOf(item);
      expect(line, "no narrative shown for markup in the narrative").not.toBeNull();
      expect(line!.textContent).toBe(HTML_NARRATIVE);
      expect(line!.querySelector("img, b, script")).toBeNull();
      expect(line!.children).toHaveLength(0);
      expect((window as unknown as { __narrativeRan?: number }).__narrativeRan).toBeUndefined();
    });

    it("shows exactly one narrative line per finding that has one, and none for the rest", async () => {
      mount(<Page />);
      await startAScan();

      const shown = ["a plain narrative", "text among invisible characters", "markup in the narrative"];
      const all = screen.getByTestId("list-findings").querySelectorAll("[data-testid='text-finding-narrative']");
      expect(all.length).toBe(shown.length);
      for (const message of shown) expect(narrativeOf(row(message))).not.toBeNull();
    });
  });
}
