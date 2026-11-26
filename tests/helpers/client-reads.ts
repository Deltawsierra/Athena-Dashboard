import ts from "typescript";
import path from "path";
import { vi } from "vitest";

/**
 * Every read the client makes, as its source names it: the sweep behind
 * tests/every-page-query-key-reaches-a-route.test.ts (the query-key guard) and
 * tests/the-service-token-rides-on-every-stop-and-on-nothing-else.test.ts (the
 * token guard), read with the TypeScript checker.
 *
 * A read is found in every form React Query has, not by the name it is called
 * by here: a call is classified by the @tanstack/react-query export it resolves
 * to (an aliased import, a namespace import or a re-export is the same hook),
 * and a call into the library this sweep does not classify is a problem, so a
 * new form is added to the sweep deliberately rather than walked past.
 *
 *   - one query, its options the first argument: useQuery, useSuspenseQuery,
 *     useInfiniteQuery (every page goes by the same key and query function),
 *     useSuspenseInfiniteQuery, usePrefetchQuery, usePrefetchInfiniteQuery;
 *   - a list of queries, each entry of `queries` one query's options (an array
 *     literal, or a `.map` whose callback returns the options): useQueries,
 *     useSuspenseQueries;
 *   - a read outside a hook, by the QueryClient: fetchQuery, prefetchQuery,
 *     ensureQueryData and their infinite forms;
 *   - a key the client names (invalidates, seeds or looks up), by a filter or
 *     by the key itself;
 *   - a wrapper: a key, or a part of one, that is the parameter of a function
 *     the client calls is read at each call, from the argument given there.
 *
 * And every fetch the client sends outside the app's query function, with the
 * credentials it sends.
 */

export const ROOT = path.resolve(__dirname, "..", "..");
export const SAMPLE = "x1";
/** One query, its options the first argument. */
const QUERY_HOOKS = new Set([
  "useQuery", "useSuspenseQuery", "useInfiniteQuery", "useSuspenseInfiniteQuery", "usePrefetchQuery", "usePrefetchInfiniteQuery",
]);
/** A list of queries: each entry of the options' `queries` is one query's options. */
const LIST_HOOKS = new Set(["useQueries", "useSuspenseQueries"]);
/** A read by the QueryClient, outside a hook, its options the first argument. */
const CLIENT_READS = new Set([
  "fetchQuery", "prefetchQuery", "ensureQueryData", "fetchInfiniteQuery", "prefetchInfiniteQuery", "ensureInfiniteQueryData",
]);
/** Cache calls that name queries by a filter's queryKey (prefix-matched)... */
const FILTER_CALLS = new Set([
  "invalidateQueries", "refetchQueries", "cancelQueries", "removeQueries", "resetQueries",
  "setQueriesData", "getQueriesData", "isFetching", "useIsFetching",
]);
/** ...and by a key itself (matched exactly). */
const KEY_CALLS = new Set(["setQueryData", "getQueryData", "getQueryState"]);
/**
 * What the client calls from the library that names no query: a write and its
 * own state, the client itself, and a hook result re-reading its own key (which
 * the hook's entry here already reads).
 */
const NOT_READS = new Set([
  "useMutation", "mutate", "mutateAsync", "reset", "useIsMutating", "useMutationState",
  "useQueryClient", "clear",
  "refetch", "fetchNextPage", "fetchPreviousPage",
]);
const LIBRARY = /[\\/]node_modules[\\/]@tanstack[\\/]/;

export type Value = string | number | Record<string, string | number> | undefined;

export interface FoundKey {
  where: string;
  /** The form it was read by: the hook or QueryClient method. */
  form: string;
  variants: Value[][];
}

/** A key the client invalidates (a filter, prefix-matched) or seeds (matched exactly). */
export interface NamedKey extends FoundKey {
  exact: boolean;
}

/** One read the client makes, in whatever form: whether its options give their own query function. */
export interface Read {
  where: string;
  form: string;
  ownQueryFn: boolean;
}

/** A fetch the client sends itself: where, and the credentials it asks for (null when it names none). */
export interface RawFetch {
  file: string;
  where: string;
  credentials: string | null;
  /** Its init names a header that carries a credential. */
  credentialHeader: boolean;
}

export interface Sweep {
  found: FoundKey[];
  named: NamedKey[];
  problems: string[];
  reads: Read[];
  fetches: RawFetch[];
}

export function sweepClientReads(): Sweep {
  const config = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const files = parsed.fileNames.filter((file) => file.includes(`${path.sep}client${path.sep}src${path.sep}`));
  const program = ts.createProgram(files, { ...parsed.options, incremental: false, tsBuildInfoFile: undefined, noEmit: true });
  const checker = program.getTypeChecker();
  const found: FoundKey[] = [];
  const named: NamedKey[] = [];
  const problems: string[] = [];
  const reads: Read[] = [];
  const fetches: RawFetch[] = [];
  const clientFiles = program.getSourceFiles().filter((sf) => files.includes(sf.fileName));

  const whereOf = (node: ts.Node) => {
    const sf = node.getSourceFile();
    return `${path.relative(ROOT, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  };

  /** Every call in the client, once: a wrapper's callers are looked up here. */
  const calls: ts.CallExpression[] = [];
  for (const sf of clientFiles) {
    const collect = (node: ts.Node) => {
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, collect);
    };
    collect(sf);
  }

  const resolved = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };

  /**
   * A key, or a part of one, that is a plain parameter of a named function: the
   * argument each call of that function gives in its place. null when it is not
   * one, or nothing calls the function.
   */
  function argumentsFor(expr: ts.Expression): Array<{ call: ts.CallExpression; arg: ts.Expression }> | null {
    if (!ts.isIdentifier(expr)) return null;
    const declaration = checker.getSymbolAtLocation(expr)?.valueDeclaration;
    if (!declaration || !ts.isParameter(declaration) || !ts.isIdentifier(declaration.name) || declaration.dotDotDotToken) return null;
    const fn = declaration.parent;
    const index = fn.parameters.indexOf(declaration);
    const nameNode = ts.isFunctionDeclaration(fn) ? fn.name
      : (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
        ? fn.parent.name : undefined;
    if (!nameNode) return null;
    const target = resolved(nameNode);
    if (!target) return null;
    const at = calls.filter((call) => resolved(call.expression) === target);
    if (at.length === 0) return null;
    return at.map((call) => ({ call, arg: call.arguments[index] }));
  }

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
  function valuesOf(expr: ts.Expression, sf: ts.SourceFile, depth = 0): Value[] | null {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
    if (ts.isNumericLiteral(expr)) return [Number(expr.text)];
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return valuesOf(expr.expression, sf, depth);
    if (ts.isTemplateExpression(expr)) {
      let texts = [expr.head.text];
      for (const span of expr.templateSpans) {
        const values = valuesOf(span.expression, sf, depth);
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
        if (ts.isPropertyAssignment(property)) values = valuesOf(property.initializer, sf, depth);
        else if (ts.isShorthandPropertyAssignment(property)) values = valuesOf(property.name, sf, depth);
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
          const all = elements.map((element) => valuesOf(element, element.getSourceFile(), depth));
          if (!all.some((one) => one === null)) return all.flat() as Value[];
        }
      }
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)) {
        return valuesOf(declaration.initializer, declaration.getSourceFile(), depth);
      }
      if (declaration && ts.isBindingElement(declaration)) {
        const fromJsx = propValues(declaration, declaration.getSourceFile());
        if (fromJsx.length > 0) return fromJsx;
      }
      // A wrapper's parameter: the values the arguments its callers give can take.
      const given = depth < 4 ? argumentsFor(expr) : null;
      if (given && given.every(({ arg }) => arg !== undefined)) {
        const all = given.map(({ arg }) => valuesOf(arg, arg.getSourceFile(), depth + 1));
        if (!all.some((one) => one === null)) return all.flat() as Value[];
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

  /**
   * Where a key expression comes from: itself, or -- when it is a wrapper's
   * parameter -- each argument the wrapper's callers give in its place, read
   * where it is given.
   */
  function keySources(expr: ts.Expression, where: string, depth = 0): Array<{ where: string; expr: ts.Expression }> | string {
    const given = depth < 4 ? argumentsFor(expr) : null;
    if (given === null) {
      const declaration = ts.isIdentifier(expr) ? checker.getSymbolAtLocation(expr)?.valueDeclaration : undefined;
      if (declaration && ts.isParameter(declaration) && !checker.isTupleType(checker.getTypeAtLocation(expr))) {
        return `${where}: its key ${expr.getText()} is a parameter no call of its function gives`;
      }
      return [{ where, expr }];
    }
    const sources: Array<{ where: string; expr: ts.Expression }> = [];
    for (const { call, arg } of given) {
      if (arg === undefined) return `${whereOf(call)}: gives no key to ${call.expression.getText()}`;
      const next = keySources(arg, `${whereOf(call)} (through ${where})`, depth + 1);
      if (typeof next === "string") return next;
      sources.push(...next);
    }
    return sources;
  }

  function variants(parts: Value[][]): Value[][] {
    return parts.reduce<Value[][]>((acc, part) => acc.flatMap((head) => part.map((one) => [...head, one])), [[]]);
  }

  /** A key's sampled variants at each place it comes from, or the problem that keeps it from being read. */
  function sampleKey(keyExpr: ts.Expression, where: string, form: string, into: (key: FoundKey) => void): void {
    const sources = keySources(keyExpr, where);
    if (typeof sources === "string") {
      problems.push(sources);
      return;
    }
    for (const source of sources) {
      const parts = keyParts(source.expr, source.expr.getSourceFile());
      if (parts.some((part) => part === null)) {
        problems.push(`${source.where}: a part of ${source.expr.getText()} has no type this sweep can sample`);
      } else {
        into({ where: source.where, form, variants: variants(parts as Value[][]) });
      }
    }
  }

  /** One query's options, read where `form` gives them. */
  function readOptions(options: ts.Expression | undefined, where: string, form: string): void {
    const props = options && ts.isObjectLiteralExpression(options) ? options.properties : undefined;
    const key = props?.find((one) => one.name?.getText() === "queryKey");
    const ownQueryFn = props?.some((one) => one.name?.getText() === "queryFn") ?? false;
    reads.push({ where, form, ownQueryFn });
    if (!props || !key || !ts.isPropertyAssignment(key)) {
      problems.push(`${where}: no queryKey this sweep can read`);
    } else if (ownQueryFn) {
      // Its own queryFn: the key is not a URL. None does today.
      problems.push(`${where}: has its own queryFn; add it to this sweep deliberately`);
    } else {
      sampleKey(key.initializer, where, form, (one) => found.push(one));
    }
  }

  /** The entries of a list hook's `queries`: an array literal's elements, or what a `.map` callback returns. */
  function entriesOf(queries: ts.Expression): ts.Expression[] | null {
    if (ts.isParenthesizedExpression(queries) || ts.isAsExpression(queries)) return entriesOf(queries.expression);
    if (ts.isArrayLiteralExpression(queries)) {
      return queries.elements.some((one) => ts.isSpreadElement(one)) ? null : Array.from(queries.elements);
    }
    if (ts.isCallExpression(queries) && ts.isPropertyAccessExpression(queries.expression) && queries.expression.name.text === "map") {
      const fn = queries.arguments[0];
      if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null;
      const unwrap = (one: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(one) ? unwrap(one.expression) : one);
      if (!ts.isBlock(fn.body)) return [unwrap(fn.body)];
      const returned: ts.Expression[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node)) {
          if (!node.expression) return;
          returned.push(unwrap(node.expression));
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(fn.body, visit);
      return returned.length > 0 ? returned : null;
    }
    const elements = elementsOf(queries);
    return elements;
  }

  for (const sf of clientFiles) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const nameNode = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
        const symbol = nameNode ? resolved(nameNode) : undefined;
        const fromLibrary = !!symbol?.declarations?.some((one) => LIBRARY.test(one.getSourceFile().fileName));
        const name = fromLibrary ? symbol!.name : nameNode?.text;
        const bare = ts.isIdentifier(callee);
        const where = whereOf(node);
        // Classified by the export it resolves to; by its name here when it resolves to none (as before).
        const is = (set: Set<string>, byName: boolean) => !!name && set.has(name) && (fromLibrary || byName);
        if (is(QUERY_HOOKS, bare)) {
          readOptions(node.arguments[0], where, name!);
        } else if (is(LIST_HOOKS, bare)) {
          const options = node.arguments[0];
          const queries = options && ts.isObjectLiteralExpression(options)
            ? options.properties.find((one) => one.name?.getText() === "queries") : undefined;
          const entries = queries && ts.isPropertyAssignment(queries) ? entriesOf(queries.initializer) : null;
          if (entries === null) problems.push(`${where}: ${name} with queries this sweep cannot read`);
          else for (const entry of entries) readOptions(entry, `${where} (${whereOf(entry)})`, name!);
        } else if (is(CLIENT_READS, !bare)) {
          readOptions(node.arguments[0], where, name!);
        } else if (is(FILTER_CALLS, !bare) || is(KEY_CALLS, !bare)) {
          // client.invalidateQueries({ queryKey }), client.setQueryData(key, ...).
          const exact = KEY_CALLS.has(name!);
          const first = node.arguments[0];
          let keyExpr: ts.Expression | undefined;
          if (exact) {
            keyExpr = first;
          } else if (first && ts.isObjectLiteralExpression(first)) {
            const key = first.properties.find((one) => one.name?.getText(sf) === "queryKey");
            if (key && ts.isPropertyAssignment(key)) keyExpr = key.initializer;
            // A predicate names queries by code, not by key: nothing to match.
            else if (first.properties.some((one) => one.name?.getText(sf) === "predicate")) keyExpr = undefined;
            else problems.push(`${where}: ${name} with no queryKey or predicate this sweep can read`);
          } else if (first) {
            problems.push(`${where}: ${name} with a filter this sweep cannot read`);
          }
          if (keyExpr) sampleKey(keyExpr, where, name!, (one) => named.push({ ...one, exact }));
        } else if (fromLibrary && !NOT_READS.has(name!)) {
          problems.push(`${where}: ${name} from @tanstack is a form this sweep does not read; add it to this sweep deliberately`);
        }
        // A fetch the client sends itself (the platform's, not one of the client's own functions).
        const fetchSymbol = bare && callee.text === "fetch" ? resolved(callee) : undefined;
        if (fetchSymbol && !fetchSymbol.declarations?.some((one) => files.includes(one.getSourceFile().fileName))) {
          const init = node.arguments[1];
          const credentials = init && ts.isObjectLiteralExpression(init)
            ? init.properties.find((one) => one.name?.getText(sf) === "credentials") : undefined;
          fetches.push({
            file: path.relative(ROOT, sf.fileName),
            where,
            credentials: credentials && ts.isPropertyAssignment(credentials) && ts.isStringLiteralLike(credentials.initializer)
              ? credentials.initializer.text : null,
            credentialHeader: !!init && /authorization|service-token|bearer|x-api-key/i.test(init.getText(sf)),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { found, named, problems, reads, fetches };
}

/** The URL each found key's variants become through the app's own query function (client/src/lib/queryClient.ts). */
export async function urlsOf(found: FoundKey[]): Promise<Array<{ where: string; form: string; url: string }>> {
  const requested: string[] = [];
  const urls: Array<{ where: string; form: string; url: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requested.push(String(url));
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  try {
    const { getQueryFn } = await import("../../client/src/lib/queryClient");
    for (const key of found) {
      for (const variant of key.variants) {
        requested.length = 0;
        await getQueryFn({ on401: "throw" })({ queryKey: variant, meta: undefined, signal: new AbortController().signal } as never);
        urls.push({ where: key.where, form: key.form, url: requested[0] });
      }
    }
  } finally {
    vi.unstubAllGlobals();
  }
  return urls;
}
