/**
 * Page copy lints clean against the persona fence.
 *
 * The fence (shared/persona-lint.ts: no verdict word about the target, no
 * reassurance on an error, no ship-or-hold, no dramatization) was held by test
 * only on the microcopy registry and on the copy modules later pull requests
 * moved into their own files (scanSummaryCopy, scanCoverageCopy, sourceLabels,
 * backendRecordCopy). The pages themselves were not linted, so the fence was
 * defeated where people read it: "Your data is safe and the issue has been
 * logged." on the error screen, "Safer AI" and "Deploy with confidence." as
 * sign-offs on the finding pages, a "Failing" state label.
 *
 * This reads every `client/src/**\/*.tsx` file with the TypeScript compiler API
 * (never a regex over source), takes every string the page can put on screen,
 * runs `lintMicrocopy` on each and asserts none is refused. A hit is reported as
 * `file:line: "text"`.
 *
 * WHAT IS READ. A string is page copy unless it sits where code, not copy, goes:
 *   - JSX text, and every string literal or template text in a .tsx file ...
 *   - ... except where the string is code, which is skipped:
 *       import/export specifiers, type positions (a literal type), the labels
 *       of `case` and the operands of `===` / `!==` / `==` / `!=`, property
 *       keys and `obj["key"]`, the arguments of the class-name helpers (cn,
 *       cva, clsx, twMerge) and of `import()` / `require()`, and the JSX
 *       attributes that carry code (className, data-*, id, key, ref, href, src,
 *       to, type, name, htmlFor, role, value, defaultValue, variant, size,
 *       style).
 *   Everything else a tag carries is read -- title, subtitle, label,
 *   placeholder, aria-label, alt, children, whatever a component takes -- and so
 *   is every object-literal value, array element, default parameter, return
 *   value and conditional branch: a label map (`{ failing: { label: "Failing" } }`)
 *   and a default sign-off (`signoff = { muted: "Safer AI" }`) reach the screen
 *   as surely as a JSX text node does. Reading only a short list of prop names
 *   would miss both. Entities (`&apos;`) are decoded and whitespace is
 *   collapsed, as the browser would, before linting.
 *
 * WHAT TO DO ABOUT A HIT. Reword the string so it states what was observed, in
 * words that name no verdict. Do NOT exempt it. EXEMPT below is for a string
 * that is not copy at all -- a technical identifier, a product name, a route --
 * and for nothing that is about a target, a finding or a result. Each entry is
 * exact (file and string), is one token (never a sentence), states why, and
 * fails the suite when it stops matching, so it cannot outlive its reason.
 *
 * Out of scope: .ts modules (the copy modules above have their own tests), text
 * assembled at run time from a server reply, and the Python fence itself.
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { lintMicrocopy, type Violation } from "@shared/persona-lint";

const ROOT = resolve(import.meta.dirname, "..");
const CLIENT_SRC = join(ROOT, "client", "src");

/** JSX attributes whose value is code, not copy. Everything else a tag carries is read. */
const CODE_ATTRIBUTES = new Set([
  "className", "class", "id", "key", "ref", "href", "src", "to", "type", "name", "htmlFor", "role",
  "value", "defaultValue", "variant", "size", "style",
]);
/** Calls whose arguments are class names (or module specifiers), not copy. */
const CLASS_NAME_CALLS = new Set(["cn", "cva", "clsx", "twMerge", "require"]);
const EQUALITY = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/**
 * Exact exemptions: a string that is NOT copy about a target, a finding or a
 * result. One token each, with the reason. Adding a sentence here is a defect.
 */
const EXEMPT: ReadonlyArray<{ file: string; text: string; reason: string }> = [
  {
    file: "client/src/pages/Failsafe.tsx",
    text: "passed",
    reason: "the StatusTone identifier engineStateTone returns for a running engine; it only selects a colour (mythos/atoms.tsx) and is never displayed",
  },
];

interface CopyString {
  line: number;
  text: string;
}

/** The characters the browser would show for the entities JSX text and attributes use. */
function decodeEntities(text: string): string {
  const named: Record<string, string> = { apos: "'", quot: '"', amp: "&", lt: "<", gt: ">", nbsp: " " };
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec?: string, hex?: string, name?: string) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return named[(name ?? "").toLowerCase()] ?? whole;
  });
}

/** Whether `node` is where code goes rather than copy: it, and everything under it, is not read. */
function isCodePosition(node: ts.Node, file: ts.SourceFile): boolean {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return true;
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isTypeNode(node)) return true;
  if (ts.isJsxAttribute(node)) {
    const name = node.name.getText(file);
    return CODE_ATTRIBUTES.has(name) || name.startsWith("data-");
  }
  if (ts.isCallExpression(node)) {
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
    if (ts.isIdentifier(node.expression) && CLASS_NAME_CALLS.has(node.expression.text)) return true;
  }
  const parent = node.parent;
  if (parent && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    if (ts.isCaseClause(parent) && parent.expression === node) return true;
    if (ts.isBinaryExpression(parent) && EQUALITY.has(parent.operatorToken.kind)) return true;
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  }
  return false;
}

/** Every string the file can put on screen, with the line it starts on. */
function extractCopy(fileName: string, source: string): CopyString[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: CopyString[] = [];
  const add = (node: ts.Node, raw: string) => {
    const text = decodeEntities(raw).replace(/\s+/g, " ").trim();
    if (text) found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text });
  };
  const visit = (node: ts.Node): void => {
    if (isCodePosition(node, file)) return;
    if (ts.isJsxText(node)) add(node, node.text);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      // The text around each `${}`: what is substituted in is another expression, read where it is written.
      add(node.head, node.head.text);
      for (const span of node.templateSpans) {
        visit(span.expression);
        add(span.literal, span.literal.text);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : tsxFiles(full);
      return entry.name.endsWith(".tsx") ? [full] : [];
    })
    .sort();
}

interface Refused {
  file: string;
  line: number;
  text: string;
  violations: Violation[];
}

let swept: { files: string[]; strings: Array<CopyString & { file: string }>; refused: Refused[] } | undefined;

/** Reads every client .tsx file once and lints every string it can put on screen. */
function sweep() {
  if (swept) return swept;
  const files = tsxFiles(CLIENT_SRC).map((full) => relative(ROOT, full).split(sep).join("/"));
  const strings: Array<CopyString & { file: string }> = [];
  for (const file of files) {
    for (const copy of extractCopy(file, readFileSync(join(ROOT, file), "utf8"))) strings.push({ file, ...copy });
  }
  const refused = strings
    .map((one) => ({ ...one, violations: lintMicrocopy(one.text) }))
    .filter((one) => one.violations.length > 0);
  swept = { files, strings, refused };
  return swept;
}

function report(one: Refused): string {
  const text = one.text.length > 220 ? `${one.text.slice(0, 220)}...` : one.text;
  return `${one.file}:${one.line}: ${JSON.stringify(text)} [${one.violations.map((v) => `${v.rule}: ${v.term}`).join("; ")}]`;
}

describe("page copy: the extractor reads what a page can put on screen, and skips code", () => {
  const read = (source: string) => extractCopy("probe.tsx", source).map((one) => one.text);

  it("reads JSX text, string and template children, and conditional branches", () => {
    expect(read('export const A = () => <p>Your data is safe. <b>Really</b> {"literal"} {ok ? "Yes" : `No ${n} here`}</p>;')).toEqual([
      "Your data is safe.", "Really", "literal", "Yes", "No", "here",
    ]);
  });

  it("reads every attribute a tag carries except the ones that hold code", () => {
    expect(
      read(
        '<Foo title="T" subtitle="S" label="L" placeholder="P" aria-label="A" alt="Al" description={"D"} ' +
          'className="c" data-testid="d" id="i" href="/h" key="k" variant="v" size="s" type="t" value="va" />',
      ),
    ).toEqual(["T", "S", "L", "P", "A", "Al", "D"]);
  });

  it("reads a label map and a default parameter, which reach the screen like a JSX text node", () => {
    expect(read('const META = { failing: { label: "Failing" }, tested: { label: "Tested" } };')).toEqual(["Failing", "Tested"]);
    expect(read('function Hero({ signoff = { gold: ["Greater", "Clarity"], muted: "Safer AI" } }) { return null; }')).toEqual([
      "Greater", "Clarity", "Safer AI",
    ]);
  });

  it("reads a string returned or bound to a name, so copy in a helper is not a blind spot", () => {
    expect(read('function label(s: string) { switch (s) { case "canceled": return "Canceled"; default: return "Unknown"; } }')).toEqual([
      "Canceled", "Unknown",
    ]);
    expect(read('const TAGLINE = "Control today.";')).toEqual(["Control today."]);
  });

  it("skips code positions: imports, types, comparisons, case labels, keys, class names, import()", () => {
    expect(
      read(
        [
          'import x from "pkg-safe";',
          'export { y } from "./failing";',
          'type S = "failing" | "passed";',
          'interface P { kind: "safe" }',
          'const f = (s: string) => s === "passed" || s !== "failing" || s == "secure" || s != "clean";',
          'function g(v: string) { switch (v) { case "failing": break; } }',
          'const h = obj["secure"];',
          'const k = { "owl-seal": 1 };',
          'const c = cn("a !b", cond && "c-safe");',
          'const v = cva("base !p-0", { variants: { size: { lg: "h-12 p-0!" } } });',
          'const lazyPage = lazy(() => import("@/pages/Safe"));',
          'const d = <div className="safe" data-testid="x-passed" />;',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("decodes entities and collapses whitespace as a browser does", () => {
    expect(read("const a = <p>Don&apos;t   worry\n   about it &amp; &quot;more&quot; &#39;x&#39; &#x41;</p>;")).toEqual([
      "Don't worry about it & \"more\" 'x' A",
    ]);
  });

  it("reports the line a string starts on: the first character of a text node, not the tag before it", () => {
    const lines = extractCopy("probe.tsx", 'const a = (\n  <p className="x">\n    first\n  </p>\n);\nconst b = "second";\n');
    expect(lines).toEqual([
      { line: 3, text: "first" },
      { line: 6, text: "second" },
    ]);
  });
});

describe("page copy: every string a client page can put on screen lints clean", () => {
  it("reads the whole client tree, not a corner of it", () => {
    const { files, strings } = sweep();
    expect(files.length).toBeGreaterThan(100);
    for (const known of [
      "client/src/components/ErrorBoundary.tsx",
      "client/src/components/AppShell.tsx",
      "client/src/components/mythos/PageHero.tsx",
      "client/src/pages/Compliance.tsx",
      "client/src/pages/Evidence.tsx",
    ]) {
      expect(files, `${known} is walked`).toContain(known);
      expect(strings.filter((one) => one.file === known).length, `${known} yields copy`).toBeGreaterThan(0);
    }
  });

  it("holds none that the persona lint refuses (file:line: text)", () => {
    const exempt = (one: Refused) => EXEMPT.some((e) => e.file === one.file && e.text === one.text);
    const refused = sweep().refused.filter((one) => !exempt(one));
    expect(refused.map(report), "page copy the persona lint refuses -- reword it; do not exempt a sentence").toEqual([]);
  });

  it("keeps every exemption to one token, with a reason, and only while it is still needed", () => {
    const { refused } = sweep();
    const seen = new Set<string>();
    for (const e of EXEMPT) {
      const name = `${e.file} ${JSON.stringify(e.text)}`;
      expect(/\s/.test(e.text), `${name} is a sentence: an exemption is for a technical identifier, never for copy`).toBe(false);
      expect(e.reason.trim().length, `${name} states why`).toBeGreaterThan(20);
      expect(seen.has(name), `${name} is listed once`).toBe(false);
      seen.add(name);
      expect(
        refused.some((one) => one.file === e.file && one.text === e.text),
        `${name} no longer matches a string the lint refuses: remove the exemption`,
      ).toBe(true);
    }
  });
});
