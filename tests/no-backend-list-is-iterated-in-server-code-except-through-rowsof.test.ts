import { beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import ts from "typescript";

/**
 * No list the backend served is iterated in server code except through rowsOf
 * (server/assurance.ts; DASH-ROWS).
 *
 * A list read from Athena-Backend is `unknown` until something checks it, and
 * `(raw.x as Record<string, unknown>[]).map(...)` checks nothing: one null row
 * threw, and the whole read answered 500 (tests/no-assurance-read-fails-whole-
 * on-one-bad-row-of-any-list.test.ts). rowsOf hands on only the rows that are
 * records and counts the rest, so a screen says "N rows could not be read".
 *
 * So in every server file that reads the backend (one that imports `call` from
 * ./control-plane, or sends to the control plane itself), no `.map`, `.filter`, `.reduce`, `.forEach`, `.some`,
 * `.every`, `.find`, `.flatMap` or `for…of` runs over a list whose rows are
 * still unread -- typed `unknown`, `any` or `Record<string, unknown>` -- unless
 * the list is rowsOf's own answer, written at the call. Found with the
 * TypeScript compiler API, not a regex: what a list's rows are is the type
 * checker's to say. An array written in place (`[a, b]`) is built here, not
 * served, and passes.
 *
 * Each place on the list below says why it may. Keep it short; the bare-list
 * reads are on it until their answer can carry a count (DASH-ROWS report).
 * Files named for settings are left out of the walk, as they are out of every
 * search of this repo.
 */

const ROOT = path.resolve(__dirname, "..");

const STOP_LANE = "on the stop lane. command() and auditEvent() throw on a null row, so one fails the read. NOT CHANGED by DASH-ROWS: the SAFETY RULE keeps that change off every stop path; it needs its own brief (DASH-ROWS report)";
const PLANNED = "PLANNED (DASH-ROWS phase 2): a bare-list read whose answer is an array, so it has nowhere to carry a count yet; the shape is the lead's decision";

/** Where a list of unread rows may be iterated other than through rowsOf, and how often. */
const ALLOWED: Record<string, { times: number; why: string }> = {
  // rowsOf and the helpers that read a list whole or not at all.
  "server/assurance.ts for…of raw": { times: 1, why: "rowsOf itself, which checks each row" },
  "server/assurance.ts for…of list": { times: 1, why: "wholeRowsOf, which refuses the whole read (503) on a row that is not a record" },
  "server/assurance.ts raw.map": { times: 2, why: "recoveryList: a recovery record is read whole or not at all, and a row its reader cannot read is a 503 (ControlPlaneUnavailable), never a 500; and an incident pack's evidence rows, each a list of strings: a row that is not a list reads as an empty row, cannot throw" },
  // Lists of strings or numbers, not rows: each element is checked by typeof, which cannot throw.
  "server/assurance.ts raw.filter": { times: 3, why: "strList, numList and referenceReasons: a typeof filter over a list of strings or numbers, not rows; cannot throw" },
  "server/assurance.ts r.reasons.map": { times: 1, why: "a closure's reasons: String(reason) on each, cannot throw" },
  "server/assurance.ts row.filter": { times: 1, why: "an incident pack's evidence row: a list of strings, filtered by typeof; cannot throw" },
  // The bare-list reads: arrays in, arrays out.
  "server/assurance.ts raw.evidence.map": { times: 1, why: `a finding's evidence (the findings list). ${PLANNED}` },
  "server/assurance.ts raw.retest_checks.map": { times: 1, why: "a finding's retest checks: readRetestCheck reads each as unknown and cannot throw; one it cannot read is left out. PLANNED (DASH-ROWS phase 2): counted with the findings list" },
  "server/assurance.ts raw.assertions.map": { times: 1, why: `a provider's assertions (the providers list). ${PLANNED}` },
  "server/assurance.ts await pagedRows(\"/api/assurance/deployments/\").map": { times: 1, why: `the deployments list. ${PLANNED}` },
  "server/assurance.ts await pagedRows(`/api/assurance/findings/${query}`).map": { times: 1, why: `the findings list. ${PLANNED}` },
  "server/assurance.ts await pagedRows(`/api/assurance/unknowns/${query}`).map": { times: 1, why: `the unknowns list. ${PLANNED}` },
  "server/assurance.ts await pagedRows(`/api/assurance/assets/${query}`).map": { times: 1, why: `the assets list. ${PLANNED}` },
  "server/assurance.ts await pagedRows(\"/api/assurance/providers/\").map": { times: 1, why: `the providers list. ${PLANNED}` },
  "server/assurance.ts await pagedRows(`/api/assurance/claims/${query}`).map": { times: 1, why: `the claims list. ${PLANNED}` },
  "server/assurance.ts rows(payload).map": { times: 2, why: `a claim's events and a deployment's claims. ${PLANNED}` },
  "server/assurance.ts await pagedRows(`/api/assurance/retest-requirements/${query}`).map": { times: 1, why: `the retest requirements list. ${PLANNED}` },
  "server/assurance.ts await pagedRows(path, { whole: true }).map": { times: 1, why: "a deployment's retest requirements, read whole: pagedRows refuses the whole read (503) on a row that is not a record, so none reaches the map" },
  // backend-scans.ts: each reader takes the row as unknown and cannot throw.
  "server/backend-scans.ts object.scope_hosts.filter": { times: 1, why: "an engagement's scope hosts: a list of strings, filtered by typeof; cannot throw" },
  "server/backend-scans.ts object!.candidates.filter": { times: 1, why: "a list of strings, filtered by typeof; cannot throw" },
  "server/backend-scans.ts rows.map": { times: 1, why: "the engagements list: readEngagement reads each row as unknown and cannot throw; one it cannot read is left out. PLANNED (DASH-ROWS phase 2): counted" },
  "server/backend-scans.ts for…of rows": { times: 1, why: "the scans list: each row read with objectOf, cannot throw; one it cannot read is left out. PLANNED (DASH-ROWS phase 2): counted" },
  "server/backend-scans.ts for…of parsed": { times: 1, why: "the scans list read whole: readScanRow reads each as unknown, cannot throw; one it cannot read is left out. PLANNED (DASH-ROWS phase 2): counted" },
  "server/backend-scans.ts for…of pageOf.results": { times: 1, why: "the same, page by page" },
  // failsafe.ts: the stop lane's own reads, which this guard reports and does not change.
  "server/failsafe.ts raw.signers.map": { times: 1, why: "a command's signers: String(s) on each, cannot throw" },
  "server/failsafe.ts payload[key].map": { times: 1, why: `the failsafe state's command lists (awaiting signatures, ready, recent): ${STOP_LANE}` },
  "server/failsafe.ts payload.map": { times: 2, why: `the failsafe command list and its audit trail: ${STOP_LANE}` },
};

const ITERATORS = new Set(["map", "filter", "reduce", "reduceRight", "forEach", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "flatMap"]);

function unwrap(expression: ts.Expression): ts.Expression {
  let e = expression;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)
    || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

/** A row nothing has checked yet: `unknown`, `any`, or a record of unknowns. */
function unreadRow(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some((one) => unreadRow(checker, one));
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  if (!(type.flags & ts.TypeFlags.Object) || checker.isArrayType(type) || checker.isTupleType(type)) return false;
  const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  return type.getProperties().length === 0 && index !== undefined && (index.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/** Whether a list of this type holds rows nothing has checked yet. */
function unreadList(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.flags & ts.TypeFlags.Any) return true;
  if (type.isUnion()) return type.types.some((one) => unreadList(checker, one));
  if (!checker.isArrayType(type)) return false;
  const row = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  return row !== undefined && unreadRow(checker, row);
}

/** rowsOf's own answer, written at the call; or an array written in place. */
function checkedHere(receiver: ts.Expression): boolean {
  const e = unwrap(receiver);
  if (ts.isArrayLiteralExpression(e)) return true;
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "rowsOf";
}

/** Every iteration of a list of unread rows in `file`, as `what` (`receiver.method`, or `for…of receiver`). */
function unreadIterationsIn(checker: ts.TypeChecker, file: ts.SourceFile): { line: number; what: string }[] {
  const found: { line: number; what: string }[] = [];
  const text = (node: ts.Node) => node.getText(file).replace(/\s+/g, " ");
  const visit = (node: ts.Node): void => {
    let receiver: ts.Expression | null = null;
    let what = "";
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ITERATORS.has(node.expression.name.text)) {
      receiver = node.expression.expression;
      what = `${text(unwrap(receiver))}.${node.expression.name.text}`;
    } else if (ts.isForOfStatement(node)) {
      receiver = node.expression;
      what = `for…of ${text(unwrap(receiver))}`;
    }
    if (receiver !== null && !checkedHere(receiver) && unreadList(checker, checker.getTypeAtLocation(receiver))) {
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, what });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Whether a file reads the backend: it imports `call` from ./control-plane, or it
 * sends to the control plane itself, as ./control-plane and the failsafe module
 * do (each imports ./failsafe-service-token to present the stop credential).
 */
function readsTheBackend(source: ts.SourceFile): boolean {
  return source.statements.some((one) => {
    if (!ts.isImportDeclaration(one) || !ts.isStringLiteral(one.moduleSpecifier)) return false;
    if (one.moduleSpecifier.text === "./failsafe-service-token") return true;
    const names = one.importClause?.namedBindings;
    return one.moduleSpecifier.text === "./control-plane" && names !== undefined && ts.isNamedImports(names)
      && names.elements.some((name) => (name.propertyName ?? name.name).text === "call");
  });
}

function serverFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (/settings/i.test(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : serverFiles(full);
    return /\.ts$/.test(entry.name) ? [path.relative(ROOT, full).split(path.sep).join("/")] : [];
  });
}

const OPTIONS: ts.CompilerOptions = {
  noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ["lib.es2022.d.ts"], types: ["node"],
  esModuleInterop: true, skipLibCheck: true, allowImportingTsExtensions: true,
  baseUrl: ROOT, paths: { "@shared/*": ["./shared/*"] },
};

/** A file's name as the compiler host is handed it, whatever the platform writes (`C:\x` or `C:/x`, either case on Windows). */
const hostName = (file: string) => file.split("\\").join("/").toLowerCase();

/** A program over `files` whose host never opens a file named for settings: an import of one is left unresolved. */
function programOf(files: string[], virtual: Record<string, string> = {}): ts.Program {
  const host = ts.createCompilerHost(OPTIONS, true);
  const named = (file: string) => /settings/i.test(path.basename(file));
  const given = new Map(Object.entries(virtual).map(([file, code]) => [hostName(file), code]));
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (file) => given.has(hostName(file)) || (!named(file) && fileExists.call(host, file));
  host.readFile = (file) => given.get(hostName(file)) ?? (named(file) ? undefined : readFile.call(host, file));
  host.getSourceFile = (file, language, ...rest) => {
    const code = given.get(hostName(file));
    if (code !== undefined) return ts.createSourceFile(file, code, language, true);
    return named(file) ? undefined : getSourceFile.call(host, file, language, ...rest);
  };
  return ts.createProgram(files, OPTIONS, host);
}

/** The rule run on code given here, one file per case. */
function hitsInCases(cases: Record<string, string>): Record<string, string[]> {
  const prelude = [
    "declare function rowsOf(raw: unknown, unreadable: Record<string, number>, list: string): Record<string, unknown>[];",
    "declare function pagedRows(path: string): Promise<Record<string, unknown>[]>;",
    "declare const raw: Record<string, unknown>;",
    "declare const u: Record<string, number>;",
    "interface Finding { uuid: string }",
    "declare function finding(raw: Record<string, unknown>): Finding;",
    "export {};",
  ].join("\n");
  const virtual = Object.fromEntries(Object.entries(cases).map(([name, code]) => [path.join(ROOT, "__cases__", `${name}.ts`), `${prelude}\n${code}`]));
  const program = programOf(Object.keys(virtual), virtual);
  const checker = program.getTypeChecker();
  return Object.fromEntries(Object.keys(cases).map((name) => {
    const file = program.getSourceFile(path.join(ROOT, "__cases__", `${name}.ts`)) as ts.SourceFile;
    return [name, unreadIterationsIn(checker, file).map((one) => one.what)];
  }));
}

describe("no list the backend served is iterated in server code except through rowsOf", () => {
  let program: ts.Program;
  let files: string[];
  beforeAll(() => {
    files = serverFiles(path.join(ROOT, "server"))
      .filter((file) => readsTheBackend(ts.createSourceFile(file, fs.readFileSync(path.join(ROOT, file), "utf8"), ts.ScriptTarget.ES2022, true)));
    program = programOf(files.map((file) => path.join(ROOT, file)));
  }, 120_000);

  /** Every iteration of a list of unread rows in the files that read the backend, as `file what`. */
  function walk(): { key: string; at: string }[] {
    const checker = program.getTypeChecker();
    return files.flatMap((file) => {
      const source = program.getSourceFile(path.join(ROOT, file));
      expect(source, file).toBeDefined();
      return unreadIterationsIn(checker, source as ts.SourceFile).map((one) => ({ key: `${file} ${one.what}`, at: `${file}:${one.line} ${one.what}` }));
    });
  }

  it("the rule catches a list of unread rows however it is iterated, and passes rowsOf's answer and checked lists", () => {
    const found = hitsInCases({
      // Caught: the cast checks nothing.
      castAndMap: "export const a = (raw.items as Record<string, unknown>[]).map((r) => r.uuid);",
      narrowedByIsArray: "export const a = Array.isArray(raw.items) ? raw.items.map((r) => r.uuid) : [];",
      forOfUnknowns: "export function f() { for (const r of raw.items as unknown[]) void r; }",
      aLocalOfUnreadRows: "export function f() { const list = raw.items as Record<string, unknown>[]; list.forEach((r) => r.uuid); return list.filter((r) => r.ok).reduce((n) => n + 1, 0); }",
      aPagedRead: "export async function f() { return (await pagedRows('/x/')).map(finding); }",
      someEveryFind: "export const a = (raw.items as any[]).some((r) => r.ok) || (raw.items as unknown[]).find((r) => r);",
      // Passes: rowsOf's answer at the call, an array written here, and rows already read.
      throughRowsOf: "export const a = rowsOf(raw.items, u, 'items').map(finding).filter((one) => one.uuid !== '');",
      writtenHere: "export const a = [raw.code, raw.detail].filter((one): one is string => typeof one === 'string');",
      readRows: "export function f(views: Finding[], names: string[]) { for (const v of views) void v; return names.map((n) => n.trim()); }",
      entries: "export const a = Object.entries(raw).map(([k, v]) => `${k}${String(v)}`);",
    });
    expect(found.castAndMap).toEqual(["raw.items.map"]);
    expect(found.narrowedByIsArray).toEqual(["raw.items.map"]);
    expect(found.forOfUnknowns).toEqual(["for…of raw.items"]);
    expect(found.aLocalOfUnreadRows).toEqual(["list.forEach", "list.filter((r) => r.ok).reduce", "list.filter"]);
    expect(found.aPagedRead).toEqual(["await pagedRows('/x/').map"]);
    expect(found.someEveryFind).toEqual(["raw.items.some", "raw.items.find"]);
    expect(found.throughRowsOf).toEqual([]);
    expect(found.writtenHere).toEqual([]);
    expect(found.readRows).toEqual([]);
    expect(found.entries).toEqual([]);
  });

  it("the walk covers every file that reads the backend, and opens no file named for settings", () => {
    expect(files).toEqual(expect.arrayContaining(["server/assurance.ts", "server/backend-scans.ts", "server/economics.ts", "server/failsafe.ts", "server/control-plane.ts"]));
    expect(program.getSourceFiles().map((one) => one.fileName).filter((name) => /settings/i.test(path.basename(name))), "no file named for settings is opened").toEqual([]);
  });

  it("each place on the list is one exact place, found as often as it says, with a reason", () => {
    const hits = walk();
    for (const [key, { times, why }] of Object.entries(ALLOWED)) {
      const file = key.slice(0, key.indexOf(" "));
      expect(/^server\/[^*]+\.ts$/.test(file) && fs.statSync(path.join(ROOT, file)).isFile(), key).toBe(true);
      expect(times, key).toBeGreaterThan(0);
      expect(why.trim(), key).not.toBe("");
      expect(hits.filter((one) => one.key === key), key).toHaveLength(times);
    }
  });

  it("no other list the backend served is iterated except through rowsOf", () => {
    const hits = walk();
    expect(hits.filter((one) => !(one.key in ALLOWED)).map((one) => one.at), "read the list with rowsOf, which counts each row it cannot read").toEqual([]);
  });
});
