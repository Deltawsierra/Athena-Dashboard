// @vitest-environment jsdom
/**
 * A character that hides or reorders text (a right-to-left override, a zero-width
 * space) is drawn marked wherever this app draws text, and the text itself is
 * kept exactly as served (client/src/lib/hiddenChars.ts, the JSX runtime in
 * client/src/lib/target-text-jsx).
 *
 * tests/a-hostile-finding-renders-inert-on-every-screen.test.tsx drives a planted
 * finding through every screen that shows target text and finds each such
 * character marked there. This file pins the rule itself:
 *
 *   - (the build compiles every .tsx with this runtime: tests/the-build-draws-
 *     with-the-runtime-that-marks-hidden-characters.test.ts);
 *   - in an element's text, each such character is alone in a box naming its
 *     code point, the text around it unchanged, and the string's characters all
 *     still there (textContent is the string as served);
 *   - in a fragment's text, the same;
 *   - in an <option>, which cannot hold a box, it is written out as "[U+202E]",
 *     and so it is in a tooltip, an aria-label, an alt text and a placeholder;
 *   - a <textarea>'s text (a value a person edits) is left exactly as it is;
 *   - a component is handed its props as they are: a component that reads a
 *     string reads the string;
 *   - text with no such character is handed on as the same string, the 200 KB
 *     one included.
 */
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { guardHostProps } from "@/lib/hiddenChars";

afterEach(cleanup);

const RLO = "\u202E";
const ZWSP = "\u200B";
const SPOOF = `invoice${RLO}fdp.exe${ZWSP}!`;

describe("a character that hides or reorders text", () => {
  it("is drawn alone in a box naming its code point, with the text around it and the string as served", () => {
    const { container } = render(<p data-testid="shown">{SPOOF}</p>);
    const shown = container.querySelector("p")!;
    expect(shown.textContent).toBe(SPOOF);
    const boxes = Array.from(shown.querySelectorAll("[data-hidden-char]"));
    expect(boxes.map((box) => [box.getAttribute("data-hidden-char"), box.textContent, box.className])).toEqual([
      ["U+202E", RLO, "hidden-char"],
      ["U+200B", ZWSP, "hidden-char"],
    ]);
    expect(Array.from(shown.childNodes).map((node) => node.textContent)).toEqual(["invoice", RLO, "fdp.exe", ZWSP, "!"]);
  });

  it("is marked in a fragment's text, and among an element's other children", () => {
    const { container } = render(
      <div>
        <>{`a${RLO}b`}</>
        {["one", `two${ZWSP}`]}
        <b>bold</b>
      </div>,
    );
    expect(container.textContent).toBe(`a${RLO}bonetwo${ZWSP}bold`);
    expect(Array.from(container.querySelectorAll("[data-hidden-char]")).map((box) => box.getAttribute("data-hidden-char"))).toEqual(["U+202E", "U+200B"]);
  });

  it("is written out in an <option>, which cannot hold a box", () => {
    const { container } = render(<select><option value="v">{SPOOF}</option></select>);
    const option = container.querySelector("option")!;
    expect(option.textContent).toBe("invoice[U+202E]fdp.exe[U+200B]!");
    expect(option.value).toBe("v");
  });

  it("is written out in an attribute a person reads or hears: a tooltip, a label, an alt text, a placeholder", () => {
    const { container } = render(
      <div title={SPOOF} aria-label={SPOOF} data-note={SPOOF}>
        <img alt={SPOOF} src="" />
        <input placeholder={SPOOF} />
      </div>,
    );
    const written = "invoice[U+202E]fdp.exe[U+200B]!";
    const div = container.querySelector("div")!;
    expect(div.getAttribute("title")).toBe(written);
    expect(div.getAttribute("aria-label")).toBe(written);
    expect(container.querySelector("img")!.getAttribute("alt")).toBe(written);
    expect(container.querySelector("input")!.getAttribute("placeholder")).toBe(written);
    // An attribute nobody reads (data the page itself uses) is left as served.
    expect(div.getAttribute("data-note")).toBe(SPOOF);
  });

  it("is left exactly as it is in a <textarea>, a value a person edits", () => {
    const { container } = render(<textarea defaultValue={SPOOF} readOnly />);
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(SPOOF);
  });

  it("reaches a component as the string it is: only an element's text is marked", () => {
    const seen: unknown[] = [];
    function Reads({ text, children }: { text: string; children: string }) {
      seen.push(text, children);
      return <span>{text.length}</span>;
    }
    render(<Reads text={SPOOF}>{SPOOF}</Reads>);
    expect(seen).toEqual([SPOOF, SPOOF]);
  });

  it("leaves text with none of them as the same string, a 200 KB one included", () => {
    const long = "A".repeat(200 * 1024);
    const props = { children: long };
    expect(guardHostProps("p", props)).toBe(props);
    const { container } = render(<p>{long}</p>);
    expect(container.querySelector("[data-hidden-char]")).toBeNull();
    expect(container.textContent).toBe(long);
  });
});
