import { describe, it, expect, beforeAll, vi } from "vitest";
import ts from "typescript";
import path from "path";

import { makeApp, signIn } from "./helpers";

/**
 * Every query key a screen reads with reaches a route the server serves.
 *
 * The screens do not fetch: they name a query key, and the app's default query
 * function (client/src/lib/queryClient.ts) turns it into a URL -- a string
 * after the path becomes a PATH segment, an object becomes the QUERY STRING.
 * The Failsafe page keyed its engine state ["/api/failsafe/state", engineId],
 * which became GET /api/failsafe/state/athena-1; the server serves only
 * /api/failsafe/state?engineId=, so every real build answered 404 and the
 * page never read the stand-down a second operator had to co-sign. Every
 * render test passed, because each supplied its own queryFn.
 *
 * So this reads the client's source with the TypeScript checker, finds every
 * key passed to useQuery, builds it with sample values of the types the
 * source gives each part (a string a segment, an object a query string), runs
 * it through the real getQueryFn, and asks the real app for the URL. The
 * server's own "Not found" -- the answer for a path no route serves -- fails
 * the test.
 *
 * Reaching a route is not enough. A key that names the wrong query parameter
 * reaches the route and is refused: Findings keyed `?client=` for a while
 * would have been answered 400 "name the engagement: ?clientId=" in every
 * build, and passed. So a 400 fails too. And a key that names the wrong
 * record route reaches a route that answers a record-level 404 exactly as the
 * right one does: `/api/tests/${id}` says "Test not found" for the sample id
 * just as `/api/scans/${id}` does. So a record-level 404 passes only from the
 * record routes the pages are meant to read (RECORD_ROUTES), with the answer
 * that route gives; any other 404 fails.
 *
 * And a key the client INVALIDATES (or seeds) must be one a page reads: the
 * Failsafe console's relay invalidated ["/api/failsafe/command", uuid] for a
 * command read as ["/api/failsafe/commands", uuid] would refresh nothing, and
 * the co-signed stop would sit on screen as awaiting a signature until the
 * next poll. Every invalidateQueries / refetchQueries key must prefix-match a
 * useQuery key (as React Query matches it), and every setQueryData key must be
 * one exactly.
 */

const ROOT = path.resolve(__dirname, "..");
const SAMPLE = "x1";
const QUERY_HOOKS = new Set(["useQuery", "useSuspenseQuery", "useInfiniteQuery"]);
/** Cache calls that name queries by a filter's queryKey (prefix-matched)... */
const FILTER_CALLS = new Set(["invalidateQueries", "refetchQueries", "cancelQueries", "removeQueries", "resetQueries"]);
/** ...and by a key itself (matched exactly). */
const KEY_CALLS = new Set(["setQueryData"]);

/**
 * The record routes page keys are meant to read, and the answer each gives
 * for a record not on record (the sample id never is). A 404 from any other
 * URL, or with any other answer, is a key that reached the wrong route.
 */
const RECORD_ROUTES = new Map<string, string>([
  [`/api/scans/${SAMPLE}`, "Test not found"],
  [`/api/tests/${SAMPLE}/decisions`, "Test not found"],
  [`/api/compliance/${SAMPLE}`, "Client not found"],
  [`/api/findings?clientId=${SAMPLE}`, "Client not found"],
]);

/** Why the server's answer to a swept URL means the key is wrong; null when a route accepted it. */
function refusal(url: string, res: { status: number; body?: { message?: unknown } }): string | null {
  if (res.status === 400) return `answered 400 ${JSON.stringify(res.body)}`;
  if (res.status === 404) {
    const expected = RECORD_ROUTES.get(url);
    if (res.body?.message === "Not found") return "no route serves it";
    if (expected === undefined) return `answered 404 ${JSON.stringify(res.body)} from a route no page key is meant to read`;
    if (res.body?.message !== expected) return `answered 404 ${JSON.stringify(res.body)}, not "${expected}"`;
  }
  return null;
}

type Value = string | number | Record<string, string | number> | undefined;

interface FoundKey {
  where: string;
  variants: Value[][];
}

/** A key the client invalidates (a filter, prefix-matched) or seeds (matched exactly). */
interface NamedKey extends FoundKey {
  exact: boolean;
}

/**
 * Whether two sampled strings can be the same key part. A dynamic string part
 * is sampled as SAMPLE, and stands for any value: `/api/${type}` is any
 * single-segment list path, not the path "/api/x1".
 */
function sameString(a: string, b: string): boolean {
  const pattern = (text: string) =>
    new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split(SAMPLE).join(".+")}$`);
  return a === b || pattern(a).test(b) || pattern(b).test(a);
}

/** Whether `filter` names `key` as React Query matches a part: an object by the fields it names. */
function partMatches(filter: Value, key: Value, exact: boolean): boolean {
  if (filter === undefined || key === undefined) return filter === key;
  if (typeof filter === "object" || typeof key === "object") {
    if (typeof filter !== "object" || typeof key !== "object") return false;
    const fields = (one: Record<string, string | number>) => Object.keys(one);
    if (exact && fields(filter).length !== fields(key).length) return false;
    return fields(filter).every((field) => field in key && sameString(String(filter[field]), String(key[field])));
  }
  return sameString(String(filter), String(key));
}

/** Whether a named key reaches a key a page reads. */
export function reaches(named: Value[], read: Value[], exact: boolean): boolean {
  if (exact ? named.length !== read.length : named.length > read.length) return false;
  return named.every((part, index) => partMatches(part, read[index], exact));
}

function sweep(): { found: FoundKey[]; named: NamedKey[]; problems: string[] } {
  const config = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const files = parsed.fileNames.filter((file) => file.includes(`${path.sep}client${path.sep}src${path.sep}`));
  const program = ts.createProgram(files, { ...parsed.options, incremental: false, tsBuildInfoFile: undefined, noEmit: true });
  const checker = program.getTypeChecker();
  const found: FoundKey[] = [];
  const named: NamedKey[] = [];
  const problems: string[] = [];

  /** The values a type admits, as samples: literals as themselves, a string as SAMPLE. */
  function typeValues(type: ts.Type): Value[] | null {
    if (type.isStringLiteral()) return [type.value];
    if (type.isNumberLiteral()) return [type.value];
    if (type.isUnion()) {
      const parts = type.types.filter((one) => !(one.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
      if (parts.length === 0) return [undefined];
      const all = parts.map(typeValues);
      return all.some((one) => one === null) ? null : all.flat() as Value[];
    }
    if (type.flags & ts.TypeFlags.String || type.flags & ts.TypeFlags.TemplateLiteral) return [SAMPLE];
    if (type.flags & ts.TypeFlags.Number) return [1];
    if (type.flags & ts.TypeFlags.BooleanLiteral || type.flags & ts.TypeFlags.Boolean) return ["true"];
    if (type.flags & ts.TypeFlags.Object && !checker.isArrayType(type) && !checker.isTupleType(type)) {
      const object: Record<string, string | number> = {};
      for (const property of checker.getPropertiesOfType(type)) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        if (!declaration) return null;
        const values = typeValues(checker.getTypeOfSymbolAtLocation(property, declaration));
        if (values === null) return null;
        const value = values.find((one) => one !== undefined);
        if (value !== undefined && typeof value !== "object") object[property.name] = value;
      }
      return [object];
    }
    return null;
  }

  /** String values a prop takes where the file renders its component: <Card query="cloud-posture" />. */
  function propValues(parameter: ts.BindingElement, sf: ts.SourceFile): string[] {
    let fn: ts.Node | undefined = parameter.parent;
    while (fn && !ts.isFunctionDeclaration(fn) && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) fn = fn.parent;
    const name = fn && ts.isFunctionDeclaration(fn) ? fn.name?.text
      : fn && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : undefined;
    const prop = (parameter.propertyName ?? parameter.name).getText(sf);
    if (!name) return [];
    const values: string[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(sf) === name) {
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute) && attribute.name.getText(sf) === prop && attribute.initializer
            && ts.isStringLiteral(attribute.initializer)) values.push(attribute.initializer.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return values;
  }

  /** The values an expression in a key can take. */
  function valuesOf(expr: ts.Expression, sf: ts.SourceFile): Value[] | null {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
    if (ts.isNumericLiteral(expr)) return [Number(expr.text)];
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return valuesOf(expr.expression, sf);
    if (ts.isTemplateExpression(expr)) {
      let texts = [expr.head.text];
      for (const span of expr.templateSpans) {
        const values = valuesOf(span.expression, sf);
        if (values === null) return null;
        const strings = values.filter((one) => one !== undefined && typeof one !== "object").map(String);
        texts = texts.flatMap((text) => (strings.length ? strings : [""]).map((one) => `${text}${one}${span.literal.text}`));
      }
      return texts;
    }
    if (ts.isObjectLiteralExpression(expr)) {
      const object: Record<string, string | number> = {};
      for (const property of expr.properties) {
        let values: Value[] | null;
        if (ts.isPropertyAssignment(property)) values = valuesOf(property.initializer, sf);
        else if (ts.isShorthandPropertyAssignment(property)) values = valuesOf(property.name, sf);
        else return null;
        if (values === null) return null;
        const value = values.find((one) => one !== undefined);
        if (value !== undefined && typeof value !== "object") object[property.name!.getText(sf)] = value;
      }
      return [object];
    }
    if (ts.isIdentifier(expr)) {
      const type = checker.getTypeAtLocation(expr);
      if (type.isStringLiteral() || type.isNumberLiteral()) return [type.value];
      const symbol = checker.getSymbolAtLocation(expr);
      const declaration = symbol?.valueDeclaration;
      // `for (const key of AFFECTED)`: each element of a const array.
      if (declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
        && ts.isForOfStatement(declaration.parent.parent)) {
        const elements = elementsOf(declaration.parent.parent.expression);
        if (elements) {
          const all = elements.map((element) => valuesOf(element, element.getSourceFile()));
          if (!all.some((one) => one === null)) return all.flat() as Value[];
        }
      }
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)) {
        return valuesOf(declaration.initializer, declaration.getSourceFile());
      }
      if (declaration && ts.isBindingElement(declaration)) {
        const fromJsx = propValues(declaration, declaration.getSourceFile());
        if (fromJsx.length > 0) return fromJsx;
      }
      return typeValues(type);
    }
    return typeValues(checker.getTypeAtLocation(expr));
  }

  /** The elements of an array literal, or of a const bound to one. */
  function elementsOf(expr: ts.Expression): ts.Expression[] | null {
    if (ts.isArrayLiteralExpression(expr)) return Array.from(expr.elements);
    if (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) return elementsOf(expr.expression);
    if (!ts.isIdentifier(expr)) return null;
    const declaration = checker.getSymbolAtLocation(expr)?.valueDeclaration;
    return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)
      ? elementsOf(declaration.initializer)
      : null;
  }

  /** The sampled parts of a key expression: an array literal part by part, a key built elsewhere by its tuple type. */
  function keyParts(expr: ts.Expression, sf: ts.SourceFile): Array<Value[] | null> {
    if (ts.isArrayLiteralExpression(expr)) return expr.elements.map((element) => valuesOf(element, sf));
    // A key built elsewhere (failsafeStateKey(...)): read by its tuple type.
    const type = checker.getTypeAtLocation(expr);
    return checker.isTupleType(type)
      ? checker.getTypeArguments(type as ts.TypeReference).map(typeValues)
      : [null];
  }

  function variants(parts: Value[][]): Value[][] {
    return parts.reduce<Value[][]>((acc, part) => acc.flatMap((head) => part.map((one) => [...head, one])), [[]]);
  }

  for (const sf of program.getSourceFiles()) {
    if (!files.includes(sf.fileName)) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && QUERY_HOOKS.has(node.expression.text)) {
        const where = `${path.relative(ROOT, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
        const options = node.arguments[0];
        const props = options && ts.isObjectLiteralExpression(options) ? options.properties : undefined;
        const key = props?.find((one) => one.name?.getText(sf) === "queryKey");
        if (!props || !key || !ts.isPropertyAssignment(key)) {
          problems.push(`${where}: no queryKey this sweep can read`);
        } else if (props.some((one) => one.name?.getText(sf) === "queryFn")) {
          // Its own queryFn: the key is not a URL. None does today.
          problems.push(`${where}: has its own queryFn; add it to this sweep deliberately`);
        } else {
          const parts = keyParts(key.initializer, sf);
          if (parts.some((part) => part === null)) {
            problems.push(`${where}: a part of ${key.initializer.getText(sf)} has no type this sweep can sample`);
          } else {
            found.push({ where, variants: variants(parts as Value[][]) });
          }
        }
      }
      // client.invalidateQueries({ queryKey }), client.setQueryData(key, ...).
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && (FILTER_CALLS.has(node.expression.name.text) || KEY_CALLS.has(node.expression.name.text))) {
        const where = `${path.relative(ROOT, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
        const exact = KEY_CALLS.has(node.expression.name.text);
        const first = node.arguments[0];
        let keyExpr: ts.Expression | undefined;
        if (exact) {
          keyExpr = first;
        } else if (first && ts.isObjectLiteralExpression(first)) {
          const key = first.properties.find((one) => one.name?.getText(sf) === "queryKey");
          if (key && ts.isPropertyAssignment(key)) keyExpr = key.initializer;
          // A predicate names queries by code, not by key: nothing to match.
          else if (first.properties.some((one) => one.name?.getText(sf) === "predicate")) keyExpr = undefined;
          else problems.push(`${where}: ${node.expression.name.text} with no queryKey or predicate this sweep can read`);
        } else if (first) {
          problems.push(`${where}: ${node.expression.name.text} with a filter this sweep cannot read`);
        }
        if (keyExpr) {
          const parts = keyParts(keyExpr, sf);
          if (parts.some((part) => part === null)) {
            problems.push(`${where}: a part of ${keyExpr.getText(sf)} has no type this sweep can sample`);
          } else {
            named.push({ where, variants: variants(parts as Value[][]), exact });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { found, named, problems };
}

describe("every page query key is a request its route accepts", () => {
  let found: FoundKey[] = [];
  let named: NamedKey[] = [];
  let problems: string[] = [];
  let urls: Array<{ where: string; url: string }> = [];
  let admin: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    ({ found, named, problems } = sweep());
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requested.push(String(url));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const { getQueryFn } = await import("../client/src/lib/queryClient");
    for (const key of found) {
      for (const variant of key.variants) {
        requested.length = 0;
        await getQueryFn({ on401: "throw" })({ queryKey: variant, meta: undefined, signal: new AbortController().signal } as never);
        urls.push({ where: key.where, url: requested[0] });
      }
    }
    vi.unstubAllGlobals();
    admin = await signIn(await makeApp());
  }, 60_000);

  it("reads every useQuery key in the client", () => {
    expect(problems).toEqual([]);
    // A sweep that found nothing would pass vacuously.
    expect(found.length).toBeGreaterThan(90);
    const all = urls.map((one) => one.url);
    // The keys this sweep exists for: the Failsafe console's.
    expect(all).toContain(`/api/failsafe/state?engineId=${SAMPLE}`);
    expect(all).toContain(`/api/failsafe/commands/${SAMPLE}`);
    // Keys with dynamic parts, read through their types and declarations.
    expect(all).toContain(`/api/findings?clientId=${SAMPLE}`);
    expect(all).toContain(`/api/scans/${SAMPLE}`);
    expect(all).toContain(`/api/assurance/deployments/${SAMPLE}/cloud-posture`);
    expect(all).toContain(`/api/assurance/deployments/${SAMPLE}/retest-requirements?all=true`);
  });

  it("the server accepts every URL those keys become", async () => {
    const refused: string[] = [];
    for (const { where, url } of urls) {
      expect(url.startsWith("/api/"), `${where}: ${url}`).toBe(true);
      const res = await admin.get(url);
      const why = refusal(url, res);
      if (why !== null) refused.push(`${where}: GET ${url} ${why}`);
    }
    expect(refused).toEqual([]);
    // Every record route listed is one a page key reads: the list permits
    // nothing no key needs.
    const all = new Set(urls.map((one) => one.url));
    expect(Array.from(RECORD_ROUTES.keys()).filter((url) => !all.has(url))).toEqual([]);
  }, 60_000);

  it("the check refuses a wrong query parameter, and a record route no page key is meant to read", async () => {
    // Findings keyed `?client=`: the route is reached, and refuses the request.
    const misnamed = await admin.get(`/api/findings?client=${SAMPLE}`);
    expect(refusal(`/api/findings?client=${SAMPLE}`, misnamed)).toMatch(/^answered 400/);
    // A scan's key spelled as the test route: "Test not found", from the wrong route.
    const wrongRoute = await admin.get(`/api/tests/${SAMPLE}`);
    expect(wrongRoute.status).toBe(404);
    expect(wrongRoute.body.message).toBe("Test not found");
    expect(refusal(`/api/tests/${SAMPLE}`, wrongRoute)).toMatch(/from a route no page key is meant to read/);
    // The right one, for the same sample id, is accepted.
    expect(refusal(`/api/scans/${SAMPLE}`, await admin.get(`/api/scans/${SAMPLE}`))).toBeNull();
  });

  it("every key the client invalidates or seeds is a key a page reads", () => {
    // The ones this pass exists for: the Failsafe console's.
    const where = named.map((one) => one.where);
    expect(where.some((one) => one.startsWith(path.join("client", "src", "pages", "Failsafe.tsx")))).toBe(true);
    expect(named.some((one) => one.exact)).toBe(true);
    const unread: string[] = [];
    for (const key of named) {
      for (const variant of key.variants) {
        const read = found.some((one) => one.variants.some((candidate) => reaches(variant, candidate, key.exact)));
        if (!read) unread.push(`${key.where}: ${JSON.stringify(variant)} names no key a page reads`);
      }
    }
    expect(unread).toEqual([]);
  });

  it("the check catches a relay that invalidates a key nothing reads", () => {
    const read = found.flatMap((one) => one.variants);
    // What the console reads, and the key it once nearly invalidated instead.
    expect(read.some((key) => reaches(["/api/failsafe/commands", SAMPLE], key, false))).toBe(true);
    expect(read.some((key) => reaches(["/api/failsafe/command", SAMPLE], key, false))).toBe(false);
    // A dynamic part stands for any value; a literal one only for itself.
    expect(reaches([`/api/${SAMPLE}`], ["/api/documents"], false)).toBe(true);
    expect(reaches([`/api/scan/${SAMPLE}`], [`/api/scans/${SAMPLE}`], false)).toBe(false);
    // A filter names the fields it gives; a seeded key must be the key itself.
    expect(reaches(["/api/findings", { clientId: SAMPLE }], ["/api/findings", { clientId: SAMPLE }], true)).toBe(true);
    expect(reaches(["/api/findings", { client: SAMPLE }], ["/api/findings", { clientId: SAMPLE }], false)).toBe(false);
    expect(reaches(["/api/failsafe/commands"], ["/api/failsafe/commands", SAMPLE], true)).toBe(false);
  });

  it("the check catches the key the Failsafe page used to build", async () => {
    // The old key, through the same function: the path the server does not serve.
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requested.push(String(url));
      return new Response("{}", { status: 200 });
    }));
    const { getQueryFn } = await import("../client/src/lib/queryClient");
    await getQueryFn({ on401: "throw" })({ queryKey: ["/api/failsafe/state", SAMPLE], meta: undefined } as never);
    vi.unstubAllGlobals();
    const res = await admin.get(requested[0]);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Not found");
  });
});
