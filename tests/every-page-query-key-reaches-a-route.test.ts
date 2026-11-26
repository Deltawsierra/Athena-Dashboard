import { describe, it, expect, beforeAll, vi } from "vitest";
import path from "path";

import { makeApp, signIn } from "./helpers";
import { SAMPLE, sweepClientReads, urlsOf, type FoundKey, type NamedKey, type Value } from "./helpers/client-reads";

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
 *
 * A key is read in every form the client can read by, not only useQuery's: each
 * entry of a useQueries list (the Observed effects section's later pages were
 * read that way and walked past until now), the infinite and suspense hooks, a
 * QueryClient fetchQuery / prefetchQuery / ensureQueryData, a wrapper whose key
 * its callers give, and a library call this sweep does not classify is a problem
 * (tests/helpers/client-reads.ts).
 */

/**
 * The record routes page keys are meant to read, and the answer each gives
 * for a record not on record (the sample id never is). A 404 from any other
 * URL, or with any other answer, is a key that reached the wrong route.
 */
const RECORD_ROUTES = new Map<string, string>([
  [`/api/scans/${SAMPLE}`, "Test not found"],
  [`/api/tests/${SAMPLE}/decisions`, "Test not found"],
  // A retest this server is not watching (server/retests.ts): the poll route's own answer.
  [`/api/retests/${SAMPLE}`, "Retest not found"],
  [`/api/compliance/${SAMPLE}`, "Client not found"],
  [`/api/findings?clientId=${SAMPLE}`, "Client not found"],
  // The client's Athena-Backend engagement (the Clients page, read when asked).
  [`/api/clients/${SAMPLE}/backend-engagement`, "Client not found"],
  // The client's findings in the Athena-Backend record (the Risks page's backend section).
  [`/api/record/clients/${SAMPLE}/findings`, "Client not found"],
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


describe("every page query key is a request its route accepts", () => {
  let found: FoundKey[] = [];
  let named: NamedKey[] = [];
  let problems: string[] = [];
  let urls: Array<{ where: string; form: string; url: string }> = [];
  let admin: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    ({ found, named, problems } = sweepClientReads());
    urls = await urlsOf(found);
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
    // The authority screens' history pages: a filter and the offset each, as the query string.
    expect(all).toContain(`/api/assurance/deployments/${SAMPLE}/approval-history?workflow=${SAMPLE}&offset=1`);
    expect(all).toContain(`/api/assurance/deployments/${SAMPLE}/tool-contracts?kind=${SAMPLE}&identifier=${SAMPLE}&offset=1`);
    expect(all).toContain(`/api/assurance/deployments/${SAMPLE}/tool-contract-bindings?kind=${SAMPLE}&identifier=${SAMPLE}&offset=1`);
    expect(all).toContain(`/api/assurance/deployments/${SAMPLE}/decision-history?offset=1`);
  });

  it("reads the keys of every form a read takes, not only useQuery's: each useQueries entry among them", () => {
    expect(problems).toEqual([]);
    const forms = new Set(found.map((one) => one.form));
    expect(forms).toContain("useQuery");
    expect(forms).toContain("useQueries");
    // The Observed effects section's later pages: one useQueries entry each, read by its key's address.
    const listed = urls.filter((one) => one.form === "useQueries");
    expect(listed.map((one) => one.url)).toEqual([`/api/assurance/deployments/${SAMPLE}/chain-outcomes?before=${SAMPLE}`]);
    expect(listed[0].where).toMatch(/^client\/src\/components\/authority\/ObservedEffects\.tsx:\d+ \(client\/src\/components\/authority\/ObservedEffects\.tsx:\d+\)$/);
    // And no form the sweep reads is left with no key it can sample.
    expect(found.every((one) => one.variants.length > 0)).toBe(true);
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
