/**
 * Characters that hide or reorder text, drawn so a person sees them.
 *
 * Much of what this console shows was written by the scanned target: a finding's
 * title and message, its evidence, where it was found, a recovery record's notes,
 * a scan's target. React escapes every string, so markup in one is text. What it
 * does not stop is a character that changes how the text LOOKS:
 *
 *   - a bidirectional control (U+202E RIGHT-TO-LEFT OVERRIDE and its kin) turns
 *     the text after it around, so "invoice" + U+202E + "fdp.exe" reads
 *     "invoiceexe.pdf";
 *   - a zero-width character (U+200B and its kin) is there and is not seen, so
 *     two strings that look the same are not.
 *
 * So no screen draws one bare. Every element this app's own code draws passes its
 * text through `guardHostProps` (the JSX runtime in ./target-text-jsx, which
 * vite.config.ts and vitest.config.ts compile every .tsx file with), so the rule
 * holds on every screen without each one having to remember it:
 *
 *   - in an element's text, each such character is put in its own box naming its
 *     code point ("U+202E"; the `.hidden-char` rule in client/src/index.css), boxed
 *     off so it reorders nothing outside the box. The character itself stays in
 *     the text: what a person copies, searches or exports is the string as served;
 *   - in an attribute a person reads or hears (a tooltip, an aria-label, an alt
 *     text, a placeholder), and in text that cannot hold a box (an <option>, an
 *     SVG <title> or <desc>), it is written out as "[U+202E]", so a target string
 *     cannot hide in a tooltip either.
 *
 * A library component (a Radix primitive: a select's items, a dialog's title, a
 * toast, a tooltip) draws its text through the library's own build, which this
 * runtime never sees. So each module that wraps one registers the library with
 * `drawsTargetText` (client/src/components/ui/*.tsx), and the props handed to a
 * registered component are guarded at that boundary exactly as an element's are.
 * A chart draws its text into SVG through Recharts' own build too: its axis,
 * tooltip and legend text goes through ./chartText, which writes each character
 * out.
 *
 * Pinned by tests/a-hostile-finding-renders-inert-on-every-screen.test.tsx and
 * tests/text-handed-to-a-library-component-is-drawn-marked.test.tsx.
 */
import { createElement, Fragment, type ReactNode } from "react";

/** Each character that hides or reorders text, by its Unicode name. */
const HIDDEN_CHAR_NAMES: Record<string, string> = {
  "\u061C": "ARABIC LETTER MARK",
  "\u180E": "MONGOLIAN VOWEL SEPARATOR",
  "\u200B": "ZERO WIDTH SPACE",
  "\u200C": "ZERO WIDTH NON-JOINER",
  "\u200D": "ZERO WIDTH JOINER",
  "\u200E": "LEFT-TO-RIGHT MARK",
  "\u200F": "RIGHT-TO-LEFT MARK",
  "\u202A": "LEFT-TO-RIGHT EMBEDDING",
  "\u202B": "RIGHT-TO-LEFT EMBEDDING",
  "\u202C": "POP DIRECTIONAL FORMATTING",
  "\u202D": "LEFT-TO-RIGHT OVERRIDE",
  "\u202E": "RIGHT-TO-LEFT OVERRIDE",
  "\u2060": "WORD JOINER",
  "\u2061": "FUNCTION APPLICATION",
  "\u2062": "INVISIBLE TIMES",
  "\u2063": "INVISIBLE SEPARATOR",
  "\u2064": "INVISIBLE PLUS",
  "\u2066": "LEFT-TO-RIGHT ISOLATE",
  "\u2067": "RIGHT-TO-LEFT ISOLATE",
  "\u2068": "FIRST STRONG ISOLATE",
  "\u2069": "POP DIRECTIONAL ISOLATE",
  "\uFEFF": "ZERO WIDTH NO-BREAK SPACE",
};

const CLASS = `[${Object.keys(HIDDEN_CHAR_NAMES).join("")}]`;
const ANY_HIDDEN = new RegExp(CLASS);
const EACH_HIDDEN = new RegExp(CLASS, "g");

/** "U+202E" for U+202E. */
export function codePointOf(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Whether `value` holds a character that hides or reorders text. */
export function hasHiddenChars(value: string): boolean {
  return ANY_HIDDEN.test(value);
}

/** `value` with each hidden character written out as "[U+202E]": for an attribute, or text that cannot hold a box. */
export function escapeHidden(value: string): string {
  return hasHiddenChars(value) ? value.replace(EACH_HIDDEN, (char) => `[${codePointOf(char)}]`) : value;
}

/**
 * `value` as nodes to draw: its runs of ordinary text with each hidden character
 * in its own marked box between them. Built with createElement, not JSX, so the
 * boxes do not pass back through the runtime that calls this.
 */
export function markHidden(value: string, key?: string | number): ReactNode {
  if (!hasHiddenChars(value)) return value;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const match of Array.from(value.matchAll(EACH_HIDDEN))) {
    const at = match.index!;
    if (at > from) parts.push(value.slice(from, at));
    const char = match[0];
    const code = codePointOf(char);
    parts.push(createElement("span", {
      key: at, className: "hidden-char", "data-hidden-char": code, title: `${code} ${HIDDEN_CHAR_NAMES[char]}: a hidden character`,
    }, char));
    from = at + char.length;
  }
  if (from < value.length) parts.push(value.slice(from));
  return createElement(Fragment, key === undefined ? null : { key }, ...parts);
}

/** Attributes a person reads or hears: a hidden character in one is written out. */
const READ_ATTRIBUTES = ["title", "aria-label", "aria-description", "aria-roledescription", "aria-valuetext", "alt", "placeholder"];

/** Elements whose text is drawn as written, never as boxes: written out instead. */
const PLAIN_TEXT_ELEMENTS = new Set(["option", "title", "desc"]);

/** Elements whose text is code or an edited value: left exactly as it is. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "text", "tspan", "textPath"]);

/**
 * The library components whose props are guarded as an element's are: each draws
 * the text it is handed through its library's own build, past this runtime.
 *
 * Kept on the global object under a registered symbol, not in this module alone:
 * the development server pre-bundles the JSX runtime (and its copy of this
 * module) apart from the app's own modules, so a wrapper's registration and the
 * runtime's check can reach two copies of this module. Both find the one set.
 */
const REGISTRY = Symbol.for("athena-dashboard.hidden-chars.text-drawing-library-components");
const TEXT_DRAWING_LIBRARY_COMPONENTS: WeakSet<object> =
  ((globalThis as Record<symbol, unknown>)[REGISTRY] as WeakSet<object> | undefined)
  ?? ((globalThis as Record<symbol, unknown>)[REGISTRY] = new WeakSet<object>()) as WeakSet<object>;

/**
 * Registers every component a library exports (a Radix primitive's namespace,
 * `import * as SelectPrimitive`) as one that draws the text it is handed, so the
 * props this app hands it are guarded at that boundary: its text marked and its
 * read attributes written out (guardHostProps). Called once by each module that
 * wraps such a library, before anything is drawn.
 */
export function drawsTargetText(library: Readonly<Record<string, unknown>>): void {
  for (const one of Object.values(library)) {
    if (typeof one === "function" || (typeof one === "object" && one !== null)) TEXT_DRAWING_LIBRARY_COMPONENTS.add(one);
  }
}

/** Whether `type` is a library component registered with drawsTargetText. */
export function isTextDrawingLibraryComponent(type: unknown): boolean {
  return (typeof type === "function" || (typeof type === "object" && type !== null)) && TEXT_DRAWING_LIBRARY_COMPONENTS.has(type);
}

/** Children with every string marked; the same object when nothing changed. */
function markChildren(children: unknown, plain: boolean, key?: number): unknown {
  if (typeof children === "string") {
    if (!hasHiddenChars(children)) return children;
    return plain ? escapeHidden(children) : markHidden(children, key);
  }
  if (Array.isArray(children)) {
    let changed: unknown[] | null = null;
    children.forEach((child, index) => {
      const marked = markChildren(child, plain, index);
      if (marked !== child) (changed ??= children.slice())[index] = marked;
    });
    return changed ?? children;
  }
  return children;
}

/**
 * The props of an element the app draws (or a fragment, or a library component
 * registered with drawsTargetText), with every hidden character in its text
 * marked and every one in an attribute a person reads written out. The app's own
 * component's props are left as they are (it may read a string as a string):
 * what it draws reaches an element, and is marked there. The same object when
 * nothing changed.
 */
export function guardHostProps(type: unknown, props: Record<string, unknown>): Record<string, unknown> {
  if (props === null || typeof props !== "object") return props;
  // A fragment's text lands in the element around it: marked as that element's would be.
  if (type === Fragment) {
    const children = markChildren(props.children, false);
    return children === props.children ? props : { ...props, children };
  }
  if (typeof type !== "string" && !isTextDrawingLibraryComponent(type)) return props;
  // A box this module drew: already marked.
  if (props["data-hidden-char"] !== undefined) return props;
  let guarded: Record<string, unknown> | null = null;
  for (const name of READ_ATTRIBUTES) {
    const value = props[name];
    if (typeof value === "string" && hasHiddenChars(value)) (guarded ??= { ...props })[name] = escapeHidden(value);
  }
  const tag = typeof type === "string" ? type : "";
  if (!RAW_TEXT_ELEMENTS.has(tag) && "children" in props) {
    const children = markChildren(props.children, PLAIN_TEXT_ELEMENTS.has(tag));
    if (children !== props.children) (guarded ??= { ...props }).children = children;
  }
  return guarded ?? props;
}
