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
 * the test. Any other answer (a record not found, a backend not configured)
 * means a route was reached.
 */

const ROOT = path.resolve(__dirname, "..");
const SAMPLE = "x1";
const QUERY_HOOKS = new Set(["useQuery", "useSuspenseQuery", "useInfiniteQuery"]);

type Value = string | number | Record<string, string | number> | undefined;

interface FoundKey {
  where: string;
  variants: Value[][];
}

function sweep(): { found: FoundKey[]; problems: string[] } {
  const config = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const files = parsed.fileNames.filter((file) => file.includes(`${path.sep}client${path.sep}src${path.sep}`));
  const program = ts.createProgram(files, { ...parsed.options, incremental: false, tsBuildInfoFile: undefined, noEmit: true });
  const checker = program.getTypeChecker();
  const found: FoundKey[] = [];
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
          let parts: Array<Value[] | null>;
          if (ts.isArrayLiteralExpression(key.initializer)) {
            parts = key.initializer.elements.map((element) => valuesOf(element, sf));
          } else {
            // A key built elsewhere (failsafeStateKey(...)): read by its tuple type.
            const type = checker.getTypeAtLocation(key.initializer);
            parts = checker.isTupleType(type)
              ? checker.getTypeArguments(type as ts.TypeReference).map(typeValues)
              : [null];
          }
          if (parts.some((part) => part === null)) {
            problems.push(`${where}: a part of ${key.initializer.getText(sf)} has no type this sweep can sample`);
          } else {
            found.push({ where, variants: variants(parts as Value[][]) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { found, problems };
}

describe("every page query key reaches a route the server serves", () => {
  let found: FoundKey[] = [];
  let problems: string[] = [];
  let urls: Array<{ where: string; url: string }> = [];
  let admin: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    ({ found, problems } = sweep());
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

  it("the server serves every URL those keys become", async () => {
    const unserved: string[] = [];
    for (const { where, url } of urls) {
      expect(url.startsWith("/api/"), `${where}: ${url}`).toBe(true);
      const res = await admin.get(url);
      if (res.status === 404 && res.body?.message === "Not found") unserved.push(`${where}: GET ${url}`);
    }
    expect(unserved).toEqual([]);
  }, 60_000);

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
