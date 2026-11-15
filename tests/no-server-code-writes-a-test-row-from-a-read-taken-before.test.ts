import { beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import ts from "typescript";

/**
 * A test row's `findings` has many writers -- the live poll, a Stop's mirror,
 * the collect watch, the not-known reading, the start's mark, the adoption, a
 * person's act and a person's edit -- and each used to read the row, await,
 * and write the whole object back with `updateTest`. Whichever landed last
 * dropped what another wrote in between
 * (tests/every-findings-writer-writes-onto-the-row-as-it-lands.test.ts,
 * tests/two-writes-to-a-scan-row-never-drop-each-others-findings.test.ts).
 * Every one of them now writes with `updateTestWith`, handed the row as it is
 * when the write lands.
 *
 * So server code names the plain write `updateTest` nowhere -- not as a call,
 * a reference or a destructured name -- except where the storage defines it.
 * A new writer that reaches for it brings the race back, and fails here.
 * Each place on the list says why it may name it; keep the list that short.
 *
 * Files named for settings are left out of the walk, as they are out of every
 * search of this repo; no storage write belongs in one.
 */

const ROOT = path.resolve(__dirname, "..");

/** Where the plain write may be named, and how many times: its definitions, nothing else. */
const ALLOWED: Record<string, { times: number; why: string }> = {
  "server/storage.ts": { times: 2, why: "IStorage declares it, and MemStorage defines it" },
  "server/storage-sqlite.ts": { times: 1, why: "SqliteStorage defines it" },
};

/** The lines (1-based) of `source` that name the plain write. */
function plainWritesIn(source: string): number[] {
  return source.split(/\r?\n/).flatMap((line, i) => (/\bupdateTest\b/.test(line) ? [i + 1] : []));
}

function serverFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (/settings/i.test(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : serverFiles(full);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [path.relative(ROOT, full).split(path.sep).join("/")] : [];
  });
}

describe("no server code writes a test row from a read taken before the write", () => {
  it("the rule finds the plain write however it is named, and passes the write onto the row as it lands", () => {
    expect(plainWritesIn("const row = await storage.getTest(id);\nawait storage.updateTest(id, { findings: { ...row.findings, x: 1 } });")).toEqual([2]);
    expect(plainWritesIn("await deps.storage.updateTest(test.id, { findings: unmarked });")).toEqual([1]);
    expect(plainWritesIn('const write = storage["updateTest"];')).toEqual([1]);
    expect(plainWritesIn("const { updateTest } = storage;")).toEqual([1]);
    expect(plainWritesIn("await storage.updateTestWith(id, (row) => ({ findings: { ...row.findings, x: 1 } }));")).toEqual([]);
    expect(plainWritesIn("await storage.updateTests(id);\nawait storage.getTest(id);")).toEqual([]);
  });

  it("each file on the list exists and names it as often as it says", () => {
    for (const [file, { times }] of Object.entries(ALLOWED)) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(plainWritesIn(fs.readFileSync(path.join(ROOT, file), "utf8")), file).toHaveLength(times);
    }
  });

  it("no other server file names the plain write", () => {
    const files = serverFiles(path.join(ROOT, "server"));
    expect(files).toEqual(expect.arrayContaining(["server/routes.ts", "server/backend-adoption.ts", "server/collect-watch.ts"]));
    const named = files
      .filter((file) => !(file in ALLOWED))
      .flatMap((file) => plainWritesIn(fs.readFileSync(path.join(ROOT, file), "utf8")).map((line) => `${file}:${line}`));
    expect(named, "write with updateTestWith, onto the row as it lands").toEqual([]);
  });
});

/*
 * The same race, hidden inside the step: an `updateTestWith` change that
 * builds the row's new findings from a row read BEFORE the call -- spread from
 * a `getTest` taken before an await, or from the row an outer function was
 * handed -- writes that earlier row back as surely as the plain write did,
 * and every check above stays green. So inside every `updateTestWith(` call
 * in server code, the change may read a row only through its own parameter
 * (the row as it is when the write lands). Found with the TypeScript compiler
 * API, not a regex: what a name in the change refers to, and whether that is
 * a row, is the type checker's to say. Two things are refused:
 *
 * 1. a `findings` value the change reads not through its own parameter or a
 *    local reached from it (`before.findings`, `polled["findings"]`,
 *    `const { findings } = test`);
 * 2. a name the change closes over that holds an earlier read of a row: a
 *    variable of a row's type (anything with an `id` and `findings`, such as
 *    `Test`) -- a `getTest`, a row query, a parameter of an outer function
 *    that is a row, the row a write answered -- or one assigned from such a
 *    read: a part of it (`const kept = before.findings`, `const { status } =
 *    before`), or what a function handed the row or its findings made of it
 *    (`completionStamp(data, before)`). What a function made from a plain
 *    value of the row -- its id, say -- is a new reading, not the row, and
 *    passes: the engine's answer for a run id, a mirror's answer for a scan id.
 *
 * A change not written at the call (`updateTestWith(id, change)`) is refused
 * too: the guard cannot see what it reads. A helper the change calls is seen
 * by what the change hands it. Files named for settings are left out, as above.
 */

/** A change that reads a row other than the one it is handed. */
interface StaleRead { line: number; what: string }

/** Where a change may read a findings value not through its parameter, and how often. Keep it this short. */
const STALE_ALLOWED: Record<string, { times: number; why: string }> = {
  "server/routes.ts polled.findings": {
    times: 1,
    why: "the engine's answer for the run (EngineScan, no id): its results, read from the engine, not from this row",
  },
};

const ROW_WRITE = "updateTestWith";

function calleeName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) return callee.argumentExpression.text;
  return null;
}

/** A name in a position that names a property or a type, not a value in scope. */
function namesNoValue(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === id)
    || (ts.isPropertyAssignment(parent) && parent.name === id)
    || (ts.isBindingElement(parent) && parent.propertyName === id)
    || (ts.isMethodDeclaration(parent) && parent.name === id)
    || (ts.isPropertyDeclaration(parent) && parent.name === id)
    || ts.isQualifiedName(parent)
    || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent);
}

function unwrap(expression: ts.Expression): ts.Expression {
  let e = expression;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)
    || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

/** Every `updateTestWith` change in one source file that reads a row other than the one it is handed. */
function staleReadsIn(checker: ts.TypeChecker, file: ts.SourceFile): StaleRead[] {
  const found: StaleRead[] = [];
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

  // Every value written to a name by assignment, by the name's symbol.
  const assigned = new Map<ts.Symbol, ts.Expression[]>();
  const collect = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(unwrap(node.left))) {
      const symbol = checker.getSymbolAtLocation(unwrap(node.left));
      if (symbol) assigned.set(symbol, [...(assigned.get(symbol) ?? []), node.right]);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);

  const isRow = (type: ts.Type, seen = new Set<ts.Type>()): boolean => {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.isUnion()) return type.types.some((one) => isRow(one, seen));
    const awaited = checker.getAwaitedType(type);
    if (awaited && awaited !== type) return isRow(awaited, seen);
    if (checker.isArrayType(type)) return checker.getTypeArguments(type as ts.TypeReference).some((one) => isRow(one, seen));
    return checker.getPropertyOfType(type, "findings") !== undefined && checker.getPropertyOfType(type, "id") !== undefined;
  };
  const PLAIN = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike
    | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.EnumLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void
    | ts.TypeFlags.Never;
  const isPlain = (type: ts.Type): boolean =>
    type.isUnion() ? type.types.every(isPlain) : (type.flags & PLAIN) !== 0;

  const visitCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeName(node.expression) === ROW_WRITE && node.arguments.length >= 2) {
      checkChange(node.arguments[1]);
    }
    ts.forEachChild(node, visitCalls);
  };

  function checkChange(argument: ts.Expression): void {
    const change = unwrap(argument);
    if (!ts.isArrowFunction(change) && !ts.isFunctionExpression(change)) {
      found.push({ line: lineOf(argument), what: `${argument.getText(file)}: the change is not written at the call` });
      return;
    }
    const inside = (node: ts.Node) => node.getSourceFile() === file && node.pos >= change.pos && node.end <= change.end;
    const local = (symbol: ts.Symbol | undefined) => (symbol?.declarations ?? []).some(inside);
    const taint = new Map<ts.Symbol, boolean>();

    // Does this value, written outside the change, carry an earlier read of a row?
    const carries = (node: ts.Node): boolean => {
      if (ts.isTypeNode(node) || ts.isFunctionLike(node) || ts.isClassLike(node)) return false;
      if (ts.isIdentifier(node)) {
        if (namesNoValue(node)) return false;
        const symbol = checker.getSymbolAtLocation(node);
        if (!symbol || local(symbol)) return false;
        return isRow(checker.getTypeAtLocation(node)) || tainted(symbol);
      }
      if (ts.isShorthandPropertyAssignment(node)) {
        const symbol = checker.getShorthandAssignmentValueSymbol(node);
        return symbol !== undefined && !local(symbol) && tainted(symbol);
      }
      if (ts.isExpression(node) && isRow(checker.getTypeAtLocation(node))) return true;
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        // What a function made of the row, or of its findings, carries it; what it made of a plain value of the row is a new reading.
        const handed = (one: ts.Expression) => !isPlain(checker.getTypeAtLocation(one)) && carries(one);
        const callee = unwrap(node.expression);
        return (node.arguments ?? []).some(handed)
          || ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && handed(callee.expression));
      }
      if (ts.isPropertyAccessExpression(node)) return carries(node.expression);
      return ts.forEachChild(node, (child) => (carries(child) ? true : undefined)) === true;
    };

    // Does this name, declared outside the change, hold an earlier read of a row?
    function tainted(symbol: ts.Symbol): boolean {
      const known = taint.get(symbol);
      if (known !== undefined) return known;
      taint.set(symbol, false);
      const holds = (symbol.declarations ?? []).some((declaration) => {
        if (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) {
          if (isRow(checker.getTypeAtLocation(declaration))) return true;
        }
        if (ts.isVariableDeclaration(declaration)) return declaration.initializer !== undefined && carries(declaration.initializer);
        if (ts.isBindingElement(declaration)) {
          let holder: ts.Node = declaration.parent;
          while (ts.isBindingElement(holder) || ts.isObjectBindingPattern(holder) || ts.isArrayBindingPattern(holder)) holder = holder.parent;
          if (ts.isParameter(holder)) return isRow(checker.getTypeAtLocation(holder));
          return ts.isVariableDeclaration(holder) && holder.initializer !== undefined && carries(holder.initializer);
        }
        return false;
      }) || (assigned.get(symbol) ?? []).some((value) => !inside(value) && carries(value));
      taint.set(symbol, holds);
      return holds;
    }

    /** Is this receiver of a `findings` the change's own parameter, or a local reached from it? */
    const throughParameter = (expression: ts.Expression): boolean => {
      const e = unwrap(expression);
      if (ts.isIdentifier(e)) return local(checker.getSymbolAtLocation(e));
      if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return throughParameter(e.expression);
      if (ts.isBinaryExpression(e)) return throughParameter(e.left) && throughParameter(e.right);
      if (ts.isConditionalExpression(e)) return throughParameter(e.whenTrue) && throughParameter(e.whenFalse);
      return false;
    };

    const seen = new Set<string>();
    const report = (node: ts.Node, what: string) => {
      const key = `${lineOf(node)} ${what}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ line: lineOf(node), what });
      }
    };

    const visit = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) return;
      // 1. A findings value not reached through the change's own parameter.
      if (ts.isPropertyAccessExpression(node) && node.name.text === "findings" && !throughParameter(node.expression)) {
        report(node, node.getText(file));
      }
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
        && node.argumentExpression.text === "findings" && !throughParameter(node.expression)) {
        report(node, node.getText(file));
      }
      if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(file) === "findings") {
        let holder: ts.Node = node.parent;
        while (ts.isBindingElement(holder) || ts.isObjectBindingPattern(holder) || ts.isArrayBindingPattern(holder)) holder = holder.parent;
        if (ts.isVariableDeclaration(holder) && holder.initializer !== undefined && !throughParameter(holder.initializer)) {
          report(node, `{ findings } = ${holder.initializer.getText(file)}`);
        }
      }
      // 2. A name the change closes over that holds an earlier read of a row.
      if (ts.isIdentifier(node) && !namesNoValue(node)) {
        const parent = node.parent;
        const written = ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        const symbol = ts.isShorthandPropertyAssignment(parent) && parent.name === node
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(node);
        if (!written && symbol && (symbol.declarations ?? []).length > 0 && !local(symbol)
          && (isRow(checker.getTypeAtLocation(node)) || tainted(symbol))) {
          report(node, node.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    change.parameters.forEach((parameter) => parameter.initializer && visit(parameter.initializer));
    visit(change.body);
  }

  visitCalls(file);
  return found;
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
function staleReadsInCases(cases: Record<string, string>): Record<string, string[]> {
  const prelude = [
    "interface Test { id: string; status: string; findings: unknown }",
    "declare const storage: {",
    "  getTest(id: string): Promise<Test | undefined>;",
    "  getTestsBySite(site: string): Promise<Test[]>;",
    "  updateTestWith(id: string, change: (test: Test) => Partial<Test> | null): Promise<Test | undefined>;",
    "};",
    "declare const engine: { runState(runId: string): Promise<{ state: string; findings: unknown[] | null }> };",
    "declare function stampOf(data: { status?: string }, before: { status: string } | null): { completedAt?: Date };",
    "declare function mirrorStop(scanId: string): Promise<{ mirrored: boolean }>;",
    "declare function scanIdOf(findings: unknown): string | null;",
    "export {};",
  ].join("\n");
  const virtual = Object.fromEntries(Object.entries(cases).map(([name, code]) => [path.join(ROOT, "__cases__", `${name}.ts`), `${prelude}\n${code}`]));
  const program = programOf(Object.keys(virtual), virtual);
  const checker = program.getTypeChecker();
  return Object.fromEntries(Object.keys(cases).map((name) => {
    const file = program.getSourceFile(path.join(ROOT, "__cases__", `${name}.ts`)) as ts.SourceFile;
    return [name, staleReadsIn(checker, file).map((one) => one.what)];
  }));
}

describe("no updateTestWith change builds a row's findings from a row read before the write", () => {
  let program: ts.Program;
  let files: string[];
  beforeAll(() => {
    files = serverFiles(path.join(ROOT, "server")).filter((file) => /\.tsx?$/.test(file));
    program = programOf(files.map((file) => path.join(ROOT, file)));
  }, 120_000);

  /** Every change in server code that reads another row, as `file line what`; and how many changes were checked. */
  function walk(): { hits: { key: string; at: string }[]; calls: number } {
    const checker = program.getTypeChecker();
    const hits: { key: string; at: string }[] = [];
    let calls = 0;
    for (const file of files) {
      const source = program.getSourceFile(path.join(ROOT, file));
      expect(source, file).toBeDefined();
      const count = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && calleeName(node.expression) === ROW_WRITE && node.arguments.length >= 2) calls += 1;
        ts.forEachChild(node, count);
      };
      count(source as ts.SourceFile);
      for (const one of staleReadsIn(checker, source as ts.SourceFile)) hits.push({ key: `${file} ${one.what}`, at: `${file}:${one.line} ${one.what}` });
    }
    return { hits, calls };
  }

  it("the rule catches a change that reads an earlier row, and passes one built from its own parameter", () => {
    const found = staleReadsInCases({
      // Caught: a closure over a row read before the write.
      closureOverAnEarlierRead: `export async function f(id: string) {
        const before = await storage.getTest(id);
        await new Promise((r) => setTimeout(r, 1));
        await storage.updateTestWith(id, (row) => ({ findings: { ...(before?.findings as object), x: 1 } }));
      }`,
      partOfAnEarlierRead: `export async function f(id: string) {
        const before = (await storage.getTest(id))!;
        const kept = before.findings as Record<string, unknown>;
        await storage.updateTestWith(id, () => ({ findings: { ...kept, x: 1 } }));
      }`,
      destructuredEarlierRead: `export async function f(id: string) {
        const before = (await storage.getTest(id))!;
        const { findings } = before;
        await storage.updateTestWith(id, (row) => ({ findings: { ...(findings as object), x: 1 } }));
      }`,
      anOuterFunctionsRow: `export async function mark(test: Test) {
        await storage.updateTestWith(test.id, () => ({ findings: { ...(test.findings as object), stop: "backend" } }));
      }`,
      anOuterRowOfAQuery: `export async function f(site: string) {
        for (const test of await storage.getTestsBySite(site)) {
          await storage.updateTestWith(test.id, (row) => ({ findings: { ...(row.findings as object), status: test.status } }));
        }
      }`,
      madeFromAnEarlierRow: `export async function f(id: string, data: { status?: string }) {
        const before = (await storage.getTest(id))!;
        const edit = { ...data, ...stampOf(data, before) };
        await storage.updateTestWith(id, (row) => ({ ...edit, findings: row.findings }));
      }`,
      anEarlierWritesAnswer: `export async function f(id: string) {
        let test = (await storage.getTest(id))!;
        const marked = await storage.updateTestWith(id, (row) => ({ findings: row.findings }));
        if (marked) test = marked;
        await storage.updateTestWith(id, (row) => ({ findings: { ...(row.findings as object), seen: test.findings } }));
      }`,
      findingsDestructuredInside: `export async function f(id: string) {
        const before = (await storage.getTest(id))!;
        await storage.updateTestWith(id, () => { const { findings } = before; return { findings }; });
      }`,
      notWrittenAtTheCall: `export async function f(id: string) {
        const change = (row: Test) => ({ findings: row.findings });
        await storage.updateTestWith(id, change);
      }`,
      // Passes: the change's own parameter, a local reached from it, and values that are not a row.
      itsOwnParameter: `export async function f(id: string) {
        await storage.updateTestWith(id, (row) => {
          const now = (row.findings ?? {}) as Record<string, unknown>;
          const { findings } = row;
          const { stop: _marked, ...unmarked } = now;
          return { findings: { ...unmarked, again: findings, kept: [1].map((one) => one + 1) } };
        });
      }`,
      anUnrelatedConstant: `const MARK = "backend";
      const LIMITS = { reads: 3 };
      export async function f(id: string) {
        const at = new Date().toISOString();
        await storage.updateTestWith(id, (row) => ({ findings: { ...(row.findings as object), stop: MARK, at, ...LIMITS } }));
      }`,
      aNewReadingByAnId: `export async function f(id: string) {
        const before = (await storage.getTest(id))!;
        const scanId = scanIdOf(before.findings);
        if (scanId === null) return;
        const mirror = await mirrorStop(scanId);
        const reading = { mirrored: mirror.mirrored };
        await storage.updateTestWith(before.id, (row) => ({ findings: { ...(row.findings as object), reading } }));
      }`,
      writtenFromTheRow: `export async function f(id: string) {
        let reading: unknown;
        await storage.updateTestWith(id, (latest) => { reading = (latest.findings as Record<string, unknown>).notKnown; return null; });
        return reading;
      }`,
      // Caught, and so on the list where server code does it: another source's findings, even one that is no row.
      theEnginesFindings: `export async function f(id: string, runId: string) {
        const polled = await engine.runState(runId);
        await storage.updateTestWith(id, (row) => ({ status: polled.state, findings: { ...(row.findings as object), results: polled.findings } }));
      }`,
    });
    expect(found.closureOverAnEarlierRead).toEqual(["before?.findings", "before"]);
    expect(found.partOfAnEarlierRead).toEqual(["kept"]);
    expect(found.destructuredEarlierRead).toEqual(["findings"]);
    expect(found.anOuterFunctionsRow).toEqual(["test.findings", "test"]);
    expect(found.anOuterRowOfAQuery).toEqual(["test"]);
    expect(found.madeFromAnEarlierRow).toEqual(["edit"]);
    expect(found.anEarlierWritesAnswer).toEqual(["test.findings", "test"]);
    expect(found.findingsDestructuredInside).toEqual(["{ findings } = before", "before"]);
    expect(found.notWrittenAtTheCall).toEqual(["change: the change is not written at the call"]);
    expect(found.itsOwnParameter).toEqual([]);
    expect(found.anUnrelatedConstant).toEqual([]);
    expect(found.aNewReadingByAnId).toEqual([]);
    expect(found.writtenFromTheRow).toEqual([]);
    expect(found.theEnginesFindings).toEqual(["polled.findings"]);
  });

  it("the list names single places, each found as often as it says", () => {
    const { hits } = walk();
    for (const [key, { times, why }] of Object.entries(STALE_ALLOWED)) {
      const [file, what] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
      expect(/^server\/[^*]+\.ts$/.test(file) && fs.statSync(path.join(ROOT, file)).isFile(), key).toBe(true);
      expect(what, key).toMatch(/^\S+$/);
      expect(why.trim(), key).not.toBe("");
      expect(hits.filter((one) => one.key === key), key).toHaveLength(times);
    }
  });

  it("no change in server code reads a row other than the one it is handed", () => {
    const { hits, calls } = walk();
    expect(program.getSourceFiles().map((one) => one.fileName).filter((name) => /settings/i.test(path.basename(name))), "no file named for settings is opened").toEqual([]);
    // Every writer of a scan row's findings is checked: the mirror, the poll, the filing, the reading, the mark, the act, the edit, the adoption.
    expect(calls).toBeGreaterThanOrEqual(8);
    expect(hits.filter((one) => !(one.key in STALE_ALLOWED)).map((one) => one.at), "build the change from the row it is handed").toEqual([]);
  });
});
