// @vitest-environment jsdom
/**
 * A URL the scanned target supplied is shown as text with a copy button, never
 * as a link, on every screen that shows one (D-RF N5, lead decision).
 *
 * A finding's endpoint or location came from the target. Drawn as a link, one
 * click on a URL the target chose would open it -- and in the desktop app the
 * window-open handler used to hand any http(s) URL to the system browser. Now
 * each such URL is the characters it is, beside a button that writes exactly
 * that string to the clipboard and nothing else (client/src/components/
 * TargetUrl.tsx; the rule lives there). Opening it is a person's own act.
 *
 * Screens: a finding's life (the Findings page), a scan's decisions (the retest
 * panel), and the Assurance console's finding row and incident pack. On each:
 * the URL is shown as text, no link carries it, the copy button writes exactly
 * it (whitespace, zero-width characters and all), nothing opens, and a
 * clipboard that refuses is said.
 *
 * The findings register (Risks, "Affected System") shows it as text, never a
 * link, and with no copy button: its ledger is read-only and holds no buttons at
 * all (tests/the-ledger-is-labelled-by-source-and-never-summed.test.tsx).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent } from "@testing-library/react";

import { queryClient } from "@/lib/queryClient";
import {
  mountAssurance, mountFindings, mountRetestPanel, mountRisks, recordingFetch, requests, standInLayoutApis, type Planted,
} from "./helpers/finding-screens";

vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const Picked = React.createContext<{ value: string; onValueChange: (value: string) => void }>({ value: "", onValueChange: () => undefined });
  return {
    Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: ReactNode }) =>
      React.createElement(Picked.Provider, { value: { value, onValueChange } }, children),
    SelectTrigger: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => React.createElement("div", props, children),
    SelectValue: ({ placeholder }: { placeholder?: string }) => React.createElement("span", null, placeholder ?? ""),
    SelectContent: ({ children }: { children: ReactNode }) => {
      const picked = React.useContext(Picked);
      return React.createElement(
        "select", { "data-testid": "native-select", value: picked.value, onChange: (event: { target: { value: string } }) => picked.onValueChange(event.target.value) },
        React.createElement("option", { value: "" }, "—"), children,
      );
    },
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => React.createElement("option", { value }, children),
  };
});

const HOST = "app.customer.example";
/** An ordinary endpoint the scanner found on the target. */
const URL_SHOWN = `https://${HOST}/search?q=%3Cb%3E&page=2#results`;
/** The same, with what a copy must not lose or add: a zero-width space inside and a space at the end. */
const URL_EXACT = `https://${HOST}/se​arch?q=a b `;

const planted = (url: string): Planted => ({ text: "Reflected input on /search", long: "", url });

/** `copy`: the URL has its copy button beside it (TargetUrl); the read-only register shows it as text alone. */
const SCREENS: Array<{ name: string; copy: boolean; mount: (p: Planted) => unknown }> = [
  { name: "the findings register (Risks)", copy: false, mount: mountRisks },
  { name: "a finding's life (Findings)", copy: true, mount: mountFindings },
  { name: "a scan's decisions (the retest panel)", copy: true, mount: mountRetestPanel },
  { name: "the Assurance console's finding row and incident pack", copy: true, mount: mountAssurance },
];

let writeText: ReturnType<typeof vi.fn>;
let opened: ReturnType<typeof vi.fn>;

beforeAll(standInLayoutApis);
beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal("fetch", recordingFetch(() => ({})));
  opened = vi.fn(() => null);
  vi.stubGlobal("open", opened);
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  queryClient.clear();
});

/** Each place the screen shows `url`: the text, in its wrapper with its copy button. */
function shownAt(url: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-testid='target-url']"))
    .filter((one) => one.querySelector("[data-testid='text-target-url']")?.textContent === url);
}

/** The innermost elements whose text is exactly `url`: where the screen shows it. */
function textAt(url: string): Element[] {
  return Array.from(document.body.querySelectorAll("*"))
    .filter((one) => one.textContent === url && !Array.from(one.children).some((child) => child.textContent === url));
}

/** Every link on the page that leads to the target's host. */
function linksToTheTarget(): string[] {
  return Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "").filter((href) => href.includes(HOST));
}

for (const one of SCREENS) {
  describe(`${one.name}: the target's URL`, () => {
    it("is shown as text, and no link on the screen carries it", async () => {
      await one.mount(planted(URL_SHOWN));
      expect(textAt(URL_SHOWN).length, "the URL as text").toBeGreaterThan(0);
      for (const place of textAt(URL_SHOWN)) expect(place.closest("a"), "the URL inside a link").toBeNull();
      expect(linksToTheTarget()).toEqual([]);
      if (one.copy) {
        expect(shownAt(URL_SHOWN).length, "the URL as text with a copy button").toBeGreaterThan(0);
        for (const place of shownAt(URL_SHOWN)) expect(place.querySelector("a")).toBeNull();
      }
    }, 30_000);

    if (!one.copy) return;

    it("has a copy button that writes exactly the URL and nothing else, and opens nothing", async () => {
      await one.mount(planted(URL_EXACT));
      const places = shownAt(URL_EXACT);
      expect(places.length, "the URL as text with a copy button").toBeGreaterThan(0);
      for (const place of places) {
        writeText.mockClear();
        const button = place.querySelector<HTMLButtonElement>("[data-testid='button-copy-target-url']");
        expect(button, "a copy button beside the URL").not.toBeNull();
        expect(button!.getAttribute("aria-label")).toBe("Copy to the clipboard");
        // The button adds no text: the URL's place reads as the URL alone.
        expect(place.textContent).toBe(URL_EXACT);
        await act(async () => { fireEvent.click(button!); });
        expect(writeText.mock.calls).toEqual([[URL_EXACT]]);
        expect(button!.getAttribute("aria-label")).toBe("Copied to the clipboard");
      }
      expect(opened).not.toHaveBeenCalled();
      expect(requests.filter((request) => request.url.includes(HOST))).toEqual([]);
    }, 30_000);

    it("says so when the clipboard refuses the copy, and opens nothing instead", async () => {
      writeText.mockRejectedValue(new DOMException("Document is not focused.", "NotAllowedError"));
      await one.mount(planted(URL_SHOWN));
      const button = shownAt(URL_SHOWN)[0]?.querySelector<HTMLButtonElement>("[data-testid='button-copy-target-url']");
      expect(button, "a copy button beside the URL").toBeTruthy();
      await act(async () => { fireEvent.click(button!); });
      expect(button!.getAttribute("aria-label")).toBe("Could not copy: the clipboard refused");
      expect(button!.getAttribute("data-copied")).toBe("failed");
      expect(opened).not.toHaveBeenCalled();
    }, 30_000);
  });
}
