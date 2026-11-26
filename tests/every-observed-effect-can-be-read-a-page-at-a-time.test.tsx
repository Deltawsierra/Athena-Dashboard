// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ObservedEffectsSection } from "@/components/authority/ObservedEffects";
import { getQueryFn, queryClient as appQueryClient } from "@/lib/queryClient";
import { lintMicrocopy } from "@shared/persona-lint";
import { MARKUP } from "./helpers/observed-effects";
import {
  BAD_CURSOR_WORDS, DEP_PAGES, DEP_PAGES_NO_COUNT, DEP_PAGES_NONE, DEP_PAGES_ODD_NEXT, DEP_PAGES_OLDER, HOSTILE_REFUSAL, PAGES_ROUTE,
  UNKNOWN_RECORDED_AS_WORDS, UNSIGNED, pagingBackend,
} from "./helpers/observed-effect-pages";

/**
 * Every observed effect can be read, a page at a time (DASH-EFFECT-PAGES): the
 * "Observed effects" section on the authority chains screen, through this console's
 * real route, against a stand-in for Athena-Backend's chain-outcomes read as its pull
 * request #241 serves it (tests/helpers/observed-effect-pages.ts). The section's reads
 * go through the app's own query function to this server, and this server's to the
 * stand-in, which keeps every request it was sent.
 *
 *   1. The backend is asked `?recorded_as=observed_effect`, and `&before=<next>` for a
 *      later page: the filter on EVERY page, and no other parameter. One page is read
 *      per press; the rest are never read by themselves. Every page is a read, sent as
 *      the signed-in person, never with the failsafe service token a stop carries.
 *   2. The section says how many are shown of how many the backend counts, and how many
 *      outcomes are recorded in all; never a count the backend did not give. Only when
 *      the backend says no page follows does it say that is all.
 *   3. A row recorded as an observed effect whose reading is null is drawn as that, with
 *      the backend's word for what it reads it as; never dropped, never as one in force.
 *   4. A refused cursor (400 bad_cursor): the list changed, and the first page is offered
 *      again. Any other 400 is shown with its code and its words, as text. Neither is
 *      asked again by itself.
 *   5. A page that could not be read keeps the rows in hand, says so, and is read once
 *      more per press. It is never read as the last page.
 *   6. A backend that does not page: what it gave, as before, and that more may exist.
 *      It is never sent `before`.
 *
 * No clock is read to decide anything: each test waits on the requests themselves, then
 * lets the page rest to see that no further request follows.
 */

let backend: Awaited<ReturnType<typeof pagingBackend>>;

beforeAll(async () => {
  backend = await pagingBackend();
}, 120_000);
afterAll(async () => {
  await backend?.close();
});

interface Read { url: string; signal: AbortSignal | undefined }
let reads: Read[] = [];
/** What the browser's next request does in place of reaching this server: fail as a network does, or never answer. */
let network: Array<"fails" | "hangs"> = [];

beforeEach(() => {
  backend.requests.length = 0;
  reads = [];
  network = [];
  // The page's requests are relative; this server's own, to the stand-in backend, are absolute and go out as they are.
  const outward = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (/^https?:/.test(String(url))) return outward(url, init);
    reads.push({ url: String(url), signal: init?.signal ?? undefined });
    const does = network.shift();
    if (does === "fails") throw new TypeError("Failed to reach this console's server");
    if (does === "hangs") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    const res = await backend.user.get(String(url));
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(dep: string) {
  const defaults = appQueryClient.getDefaultOptions();
  const client = new QueryClient({ defaultOptions: { ...defaults, queries: { ...defaults.queries, queryFn: getQueryFn({ on401: "throw" }) } } });
  return render(<QueryClientProvider client={client}><ObservedEffectsSection deployment={dep} /></QueryClientProvider>);
}

const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const shown = () => screen.queryAllByTestId("observed-effect").map((one) => one.getAttribute("data-outcome"));
const showing = () => text(screen.getByTestId("effects-showing"));
const press = (id: string) => fireEvent.click(screen.getByTestId(id));
/** Let anything that would read by itself do so: a loop shows up as a request nobody pressed for. */
const rest = () => new Promise((resolve) => setTimeout(resolve, 150));
const firstPage = async (dep: string) => {
  const view = mount(dep);
  await waitFor(() => expect(screen.queryByTestId("effects-showing") ?? screen.queryByTestId("effects-not-paged")).not.toBeNull());
  return view;
};
const sent = (dep: string) => backend.requestsFor(dep).map((one) => one.params);
const FILTER: [string, string] = ["recorded_as", "observed_effect"];

describe("1. the section reads with the filter and walks the cursor, one page per press", () => {
  it("reads the first page with the screen, asks the backend for the rows recorded as observed effects, and reads nothing more by itself", async () => {
    await firstPage(DEP_PAGES);
    expect(shown()).toEqual(["oe-1", "oe-2"]);
    await rest();
    expect(reads.map((one) => one.url)).toEqual([PAGES_ROUTE(DEP_PAGES)]);
    // What the backend was sent: the filter, and nothing else. No cache-buster, no page size, no offset.
    expect(backend.requestsFor(DEP_PAGES).map((one) => one.search)).toEqual(["?recorded_as=observed_effect"]);
  });

  it("Show more reads the page after the last one with the cursor it gave, the filter sent again: one press, one page", async () => {
    await firstPage(DEP_PAGES);
    const second = backend.cursorAfter(DEP_PAGES, 2);
    press("effects-show-more");
    await waitFor(() => expect(shown()).toEqual(["oe-1", "oe-2", UNSIGNED, "oe-4"]));
    await rest();
    expect(reads.map((one) => one.url)).toEqual([PAGES_ROUTE(DEP_PAGES), PAGES_ROUTE(DEP_PAGES, second)]);
    expect(sent(DEP_PAGES)).toEqual([[FILTER], [FILTER, ["before", second]]]);

    const third = backend.cursorAfter(DEP_PAGES, 4);
    press("effects-show-more");
    await waitFor(() => expect(shown()).toEqual(["oe-1", "oe-2", UNSIGNED, "oe-4", "oe-5"]));
    await rest();
    expect(sent(DEP_PAGES)).toEqual([[FILTER], [FILTER, ["before", second]], [FILTER, ["before", third]]]);
    // Every request carried the filter once, and no parameter the backend does not know.
    for (const request of backend.requestsFor(DEP_PAGES)) {
      expect(request.params.filter(([name]) => name === "recorded_as")).toEqual([FILTER]);
      expect(request.params.map(([name]) => name).filter((name) => name !== "recorded_as" && name !== "before")).toEqual([]);
    }
  });

  it("every page is a read, sent as the signed-in person: none carries the failsafe service token this console holds for its stops", async () => {
    await firstPage(DEP_PAGES);
    press("effects-show-more");
    await waitFor(() => expect(shown()).toHaveLength(4));
    press("effects-show-more");
    await waitFor(() => expect(shown()).toHaveLength(5));
    const pages = backend.requestsFor(DEP_PAGES);
    // The first page and the two after it, each with its cursor.
    expect(pages.map((one) => one.params.some(([name]) => name === "before"))).toEqual([false, true, true]);
    expect(backend.serviceToken.length).toBeGreaterThanOrEqual(32);
    expect(pages.map((one) => one.serviceToken)).toEqual([undefined, undefined, undefined]);
    // As the person this console signed in to the backend, never as the service account.
    expect(pages.map((one) => one.authorization)).toEqual(["Bearer access-for-admin", "Bearer access-for-admin", "Bearer access-for-admin"]);
    expect(pages.filter((one) => `${one.authorization ?? ""} ${one.search}`.includes(backend.serviceToken))).toEqual([]);
  });

  it("a press while a page is being read reads nothing more, and a left screen cancels the read", async () => {
    const view = await firstPage(DEP_PAGES);
    network = ["hangs"];
    press("effects-show-more");
    await waitFor(() => expect(text(screen.getByTestId("effects-next-reading"))).toBe("Reading the next page…"));
    // No button to press twice while it is read, and the rows in hand stay.
    expect(screen.queryByTestId("effects-show-more")).toBeNull();
    expect(screen.queryByTestId("effects-that-is-all")).toBeNull();
    expect(shown()).toEqual(["oe-1", "oe-2"]);
    expect(reads).toHaveLength(2);
    expect(reads[1].signal?.aborted).toBe(false);
    view.unmount();
    await waitFor(() => expect(reads[1].signal?.aborted).toBe(true));
  });

  it("this server sends the backend only what it knows: any other parameter, or a `before` that is no cursor, is refused here and not relayed", async () => {
    const cursor = backend.cursorAfter(DEP_PAGES, 2);
    const refused: Array<[string, string]> = [
      [`${PAGES_ROUTE(DEP_PAGES)}?offset=100`, "unknown_parameter"],
      [`${PAGES_ROUTE(DEP_PAGES)}?recorded_as=authorization_check`, "unknown_parameter"],
      [`${PAGES_ROUTE(DEP_PAGES, cursor)}&_=1700000000`, "unknown_parameter"],
      [`${PAGES_ROUTE(DEP_PAGES)}?before=`, "bad_cursor"],
      [`${PAGES_ROUTE(DEP_PAGES, cursor)}&before=${encodeURIComponent(cursor)}`, "bad_cursor"],
      [PAGES_ROUTE(DEP_PAGES, "c".repeat(513)), "bad_cursor"],
    ];
    for (const [url, code] of refused) {
      const res = await backend.user.get(url);
      expect(res.status, url).toBe(400);
      expect(res.body.code, url).toBe(code);
      expect(res.body.outcomes, url).toBeUndefined();
    }
    expect(backend.requests).toEqual([]);
    // And a page it does relay is one request to the backend, with the two parameters and no other.
    const res = await backend.user.get(PAGES_ROUTE(DEP_PAGES, cursor));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ returned: 2, truncated: true, pageSize: 2, recordedCount: 9, matchingCount: 5, next: backend.cursorAfter(DEP_PAGES, 4) });
    expect(backend.requests.map((one) => one.search)).toEqual([`?recorded_as=observed_effect&before=${encodeURIComponent(cursor)}`]);
  });
});

describe("2. it says how many, from the backend's own counts", () => {
  it("shows N of the backend's matching count, and how many outcomes are recorded in all, as each page arrives", async () => {
    await firstPage(DEP_PAGES);
    expect(showing()).toBe("Showing 2 of 5 observed effects.");
    expect(text(screen.getByTestId("effects-recorded"))).toBe("9");
    expect(text(screen.getByTestId("effects-more-follow"))).toBe("More follow: the backend serves at most 2 at a time. Each press reads one more page.");
    // More follow: nothing says that is all.
    expect(screen.queryByTestId("effects-that-is-all")).toBeNull();
    press("effects-show-more");
    await waitFor(() => expect(showing()).toBe("Showing 4 of 5 observed effects."));
    expect(screen.queryByTestId("effects-that-is-all")).toBeNull();
  });

  it("says that is all only on the page the backend says is the last, and then offers no more", async () => {
    await firstPage(DEP_PAGES);
    press("effects-show-more");
    await waitFor(() => expect(shown()).toHaveLength(4));
    press("effects-show-more");
    await waitFor(() => expect(showing()).toBe("Showing 5 of 5 observed effects."));
    expect(text(screen.getByTestId("effects-that-is-all"))).toBe("That is all: the backend says no page follows this one.");
    expect(screen.queryByTestId("effects-show-more")).toBeNull();
    expect(text(screen.getByTestId("effects-pages"))).toBe("3");
  });

  it("never says a count the backend did not give: no `of M`, and the recorded count not said", async () => {
    await firstPage(DEP_PAGES_NO_COUNT);
    expect(showing()).toBe("Showing 2 observed effects. This backend did not say how many there are.");
    expect(showing()).not.toMatch(/ of \d/);
    expect(screen.getByTestId("effects-showing").getAttribute("data-matching")).toBe("");
    expect(text(screen.getByTestId("effects-recorded"))).toBe("not said");
    const res = await backend.user.get(PAGES_ROUTE(DEP_PAGES_NO_COUNT));
    expect(res.body).not.toHaveProperty("matchingCount");
    expect(res.body.recordedCount).toBeNull();
    expect(res.body.next).toBeNull();
  });

  it("a count that is not a count and a `next` that is not a cursor are said unread: no `of M`, no Show more, and never the last page", async () => {
    await firstPage(DEP_PAGES_ODD_NEXT);
    expect(showing()).toBe("Showing 2 observed effects. This backend did not say how many there are.");
    expect(text(screen.getByTestId("effects-next-unreadable"))).toMatch(/could not be read: more observed effects may exist than are shown, and this is not read as the last page\.$/);
    expect(screen.queryByTestId("effects-that-is-all")).toBeNull();
    expect(screen.queryByTestId("effects-show-more")).toBeNull();
    const res = await backend.user.get(PAGES_ROUTE(DEP_PAGES_ODD_NEXT));
    expect(res.body).not.toHaveProperty("next");
    expect(res.body).not.toHaveProperty("matchingCount");
    expect(res.body.unreadableFields).toEqual(["matchingCount", "next"]);
  });

  it("a deployment with no row recorded as an observed effect says so from the backend's zero, on its last page", async () => {
    await firstPage(DEP_PAGES_NONE);
    expect(showing()).toBe("Showing 0 of 0 observed effects.");
    expect(text(screen.getByTestId("no-observed-effects"))).toBe("No observed effect is recorded for this deployment.");
    expect(text(screen.getByTestId("effects-recorded"))).toBe("1");
    expect(screen.getByTestId("effects-that-is-all")).toBeTruthy();
  });
});

describe("3. a row recorded as an observed effect whose reading is null", () => {
  it("is relayed as the backend serves it and drawn as that: never dropped, never as an effect in force", async () => {
    const relayed = await backend.user.get(PAGES_ROUTE(DEP_PAGES, backend.cursorAfter(DEP_PAGES, 2)));
    expect(relayed.body.outcomes[0]).toMatchObject({ outcomeId: UNSIGNED, evidenceKind: "attested", evidenceKindLabel: "Attested", signed: false, effect: { served: "none" } });

    await firstPage(DEP_PAGES);
    press("effects-show-more");
    await waitFor(() => expect(shown()).toContain(UNSIGNED));
    const card = screen.getAllByTestId("observed-effect").find((one) => one.getAttribute("data-outcome") === UNSIGNED)!;
    expect(card.getAttribute("data-in-force")).toBe("false");
    expect(text(within(card).getByTestId("effect-not-in-force"))).toBe("recorded as an observed effect: not one in force");
    // The backend's own word for what it reads the row as.
    expect(text(within(card).getByTestId("effect-kind"))).toBe("Attested");
    expect(text(within(card).getByTestId("effect-recorded-reading-null"))).toBe(
      "This row was recorded as an observed effect. Athena-Backend serves its reading as null and reads its evidence as Attested: " +
      "the signature it was recorded under does not check now. It is shown as recorded, and is not an observed effect in force.",
    );
    // Nothing of an effect in force is drawn on it: no reading, no binding, no execution.
    for (const id of ["effect-reading", "effect-binding", "effect-execution", "effect-schema"]) expect(within(card).queryByTestId(id)).toBeNull();
    expect(text(screen.getByTestId("effects-not-in-force"))).toBe(
      "Of those shown, 1 is recorded as an observed effect and not read as one in force: each says so.",
    );
    // It is counted among those shown, and its neighbours in force say so.
    expect(showing()).toBe("Showing 4 of 5 observed effects.");
    const inForce = screen.getAllByTestId("observed-effect").filter((one) => one.getAttribute("data-in-force") === "true");
    expect(inForce.map((one) => one.getAttribute("data-outcome"))).toEqual(["oe-1", "oe-2", "oe-4"]);
  });
});

describe("4. a page the backend refuses", () => {
  it("a refused cursor says the list changed and offers the first page again; it is asked once, and read again only on a press", async () => {
    await firstPage(DEP_PAGES);
    const second = backend.cursorAfter(DEP_PAGES, 2);
    backend.script(DEP_PAGES, second, { status: 400, body: { error: BAD_CURSOR_WORDS, code: "bad_cursor" } });
    press("effects-show-more");
    await waitFor(() => expect(screen.queryByTestId("effects-list-changed")).not.toBeNull());
    expect(text(screen.getByTestId("effects-list-changed"))).toMatch(/^The list changed while it was being read/);
    expect(text(screen.getByTestId("effects-refusal-code"))).toBe("bad_cursor");
    expect(text(screen.getByTestId("effects-refusal-error"))).toBe(BAD_CURSOR_WORDS);
    // The rows read before stay; a refusal is never the end of the list, and never an empty page.
    expect(shown()).toEqual(["oe-1", "oe-2"]);
    expect(screen.queryByTestId("effects-that-is-all")).toBeNull();
    expect(screen.queryByTestId("effects-show-more")).toBeNull();
    await rest();
    // Asked once: by this page, and by this server.
    expect(reads).toHaveLength(2);
    expect(backend.requestsFor(DEP_PAGES)).toHaveLength(2);

    press("effects-from-first");
    await waitFor(() => expect(reads).toHaveLength(3));
    await waitFor(() => expect(screen.queryByTestId("effects-show-more")).not.toBeNull());
    await rest();
    // One press: the first page, read anew, with no cursor. Nothing after it until the next press.
    expect(reads[2].url).toBe(PAGES_ROUTE(DEP_PAGES));
    expect(reads).toHaveLength(3);
    expect(sent(DEP_PAGES)[2]).toEqual([FILTER]);
    expect(shown()).toEqual(["oe-1", "oe-2"]);
    expect(screen.queryByTestId("effects-list-changed")).toBeNull();
  });

  it("any other 400 is shown with its code and its words, as text, and is not asked again", async () => {
    const { container } = await firstPage(DEP_PAGES);
    const second = backend.cursorAfter(DEP_PAGES, 2);
    backend.script(DEP_PAGES, second, { status: 400, body: { error: `${UNKNOWN_RECORDED_AS_WORDS} ${HOSTILE_REFUSAL}`, code: "unknown_recorded_as" } });
    press("effects-show-more");
    await waitFor(() => expect(screen.queryByTestId("effects-next-refused")).not.toBeNull());
    expect(text(screen.getByTestId("effects-refusal-code"))).toBe("unknown_recorded_as");
    expect(screen.getByTestId("effects-refusal-error").textContent).toContain(UNKNOWN_RECORDED_AS_WORDS);
    // The backend's words are drawn as the characters they are: nothing in them became an element or a handler.
    expect(screen.getByTestId("effects-refusal-error").textContent).toContain(MARKUP);
    expect(container.querySelectorAll("script, img, iframe, a, style")).toHaveLength(0);
    expect((window as { __planted?: unknown }).__planted).toBeUndefined();
    expect(container.querySelectorAll("[data-hidden-char]").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("effects-list-changed")).toBeNull();
    expect(screen.queryByTestId("effects-that-is-all")).toBeNull();
    expect(shown()).toEqual(["oe-1", "oe-2"]);
    await rest();
    expect(reads).toHaveLength(2);
    expect(backend.requestsFor(DEP_PAGES)).toHaveLength(2);
  });

  it("this server passes the refusal on as a 400 with the backend's code and words; a code that is not one is not passed on as one", async () => {
    const second = backend.cursorAfter(DEP_PAGES, 2);
    backend.script(DEP_PAGES, second, { status: 400, body: { error: BAD_CURSOR_WORDS, code: "bad_cursor" } });
    const refused = await backend.user.get(PAGES_ROUTE(DEP_PAGES, second));
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: BAD_CURSOR_WORDS, code: "bad_cursor" });
    backend.script(DEP_PAGES, second, { status: 400, body: { error: 7, code: HOSTILE_REFUSAL } });
    const odd = await backend.user.get(PAGES_ROUTE(DEP_PAGES, second));
    expect(odd.status).toBe(400);
    expect(odd.body.code).toBe("backend_refused");
    expect(JSON.stringify(odd.body)).not.toContain("script");
    // A cursor the real route would refuse (one made up) is the backend's 400 too, asked once.
    backend.requests.length = 0;
    const madeUp = await backend.user.get(PAGES_ROUTE(DEP_PAGES, "not-a-cursor:this-read-issued"));
    expect(madeUp.status).toBe(400);
    expect(madeUp.body).toEqual({ error: BAD_CURSOR_WORDS, code: "bad_cursor" });
    expect(backend.requests).toHaveLength(1);
  });
});

describe("5. a page that could not be read", () => {
  for (const [how, fail] of [
    ["the backend answers 500", (cursor: string) => backend.script(DEP_PAGES, cursor, { status: 500, body: { detail: "Server error." } })],
    ["the request never reaches this server", () => { network = ["fails"]; }],
  ] as Array<[string, (cursor: string) => void]>) {
    it(`${how}: the rows in hand stay, the section says the next page could not be read, and one press reads it once more`, async () => {
      await firstPage(DEP_PAGES);
      const second = backend.cursorAfter(DEP_PAGES, 2);
      fail(second);
      press("effects-show-more");
      await waitFor(() => expect(screen.queryByTestId("effects-next-not-read")).not.toBeNull());
      expect(text(screen.getByTestId("effects-next-not-read"))).toMatch(/^The next page could not be read: .+ more are recorded than are shown\.$/);
      expect(shown()).toEqual(["oe-1", "oe-2"]);
      expect(showing()).toBe("Showing 2 of 5 observed effects.");
      // Never read as "no more": nothing says that is all, and the count still says three are not shown.
      expect(screen.queryByTestId("effects-that-is-all")).toBeNull();
      expect(screen.queryByTestId("no-observed-effects")).toBeNull();
      await rest();
      // Not read again by itself, here or on this server.
      expect(reads).toHaveLength(2);
      expect(backend.requestsFor(DEP_PAGES).length).toBeLessThanOrEqual(2);

      press("effects-read-again");
      await waitFor(() => expect(shown()).toEqual(["oe-1", "oe-2", UNSIGNED, "oe-4"]));
      await rest();
      expect(reads.map((one) => one.url)).toEqual([PAGES_ROUTE(DEP_PAGES), PAGES_ROUTE(DEP_PAGES, second), PAGES_ROUTE(DEP_PAGES, second)]);
      expect(screen.queryByTestId("effects-next-not-read")).toBeNull();
    });
  }

  it("a page that fails again is offered again, one read per press, and the walk goes on from it once it is read", async () => {
    await firstPage(DEP_PAGES);
    const second = backend.cursorAfter(DEP_PAGES, 2);
    network = ["fails", "fails"];
    press("effects-show-more");
    await waitFor(() => expect(screen.queryByTestId("effects-read-again")).not.toBeNull());
    press("effects-read-again");
    await waitFor(() => expect(reads).toHaveLength(3));
    await waitFor(() => expect(screen.queryByTestId("effects-read-again")).not.toBeNull());
    await rest();
    expect(reads).toHaveLength(3);
    expect(shown()).toEqual(["oe-1", "oe-2"]);
    press("effects-read-again");
    await waitFor(() => expect(shown()).toHaveLength(4));
    press("effects-show-more");
    await waitFor(() => expect(showing()).toBe("Showing 5 of 5 observed effects."));
    expect(reads).toHaveLength(5);
    expect(reads[1].url).toBe(PAGES_ROUTE(DEP_PAGES, second));
  });

  it("this server answers a failed page as unavailable, never as an empty page, and asks the backend once", async () => {
    const second = backend.cursorAfter(DEP_PAGES, 2);
    backend.script(DEP_PAGES, second, { status: 500, body: { detail: "Server error." } });
    const res = await backend.user.get(PAGES_ROUTE(DEP_PAGES, second));
    expect(res.status).toBe(503);
    expect(res.body.outcomes).toBeUndefined();
    expect(res.body.next).toBeUndefined();
    expect(backend.requests).toHaveLength(1);
  });
});

describe("6. a backend that does not page", () => {
  it("shows what it gave as before, says it does not page and that more may exist, and offers no further page", async () => {
    await firstPage(DEP_PAGES_OLDER);
    expect(text(screen.getByTestId("effects-not-paged"))).toBe(
      "This backend does not page its chain outcomes: what is shown is what it gave, its newest outcomes of every kind, and " +
      "it did not say how many observed effects there are. More observed effects may exist than are shown.",
    );
    // As before: the observed effects among what it gave, with its own counts.
    expect(shown()).toEqual(["old-1", "old-2"]);
    expect(text(screen.getByTestId("effects-returned"))).toBe("3");
    expect(text(screen.getByTestId("effects-recorded"))).toBe("3");
    expect(text(screen.getByTestId("effects-count"))).toBe("2");
    // No count it did not give, no walk, and nothing that reads as the whole list.
    expect(screen.queryByTestId("effects-showing")).toBeNull();
    expect(screen.queryByTestId("effects-show-more")).toBeNull();
    expect(screen.queryByTestId("effects-that-is-all")).toBeNull();
    await rest();
    expect(reads.map((one) => one.url)).toEqual([PAGES_ROUTE(DEP_PAGES_OLDER)]);
    // It was never sent `before`.
    expect(backend.requestsFor(DEP_PAGES_OLDER).flatMap((one) => one.params.map(([name]) => name))).toEqual(["recorded_as"]);
  });

  it("its answer is relayed with neither key filled in, and rows it gives to a read that named a cursor are not passed on as that page", async () => {
    const res = await backend.user.get(PAGES_ROUTE(DEP_PAGES_OLDER));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["outcomes", "pageSize", "recordedCount", "returned", "truncated"]);
    const asked = await backend.user.get(PAGES_ROUTE(DEP_PAGES_OLDER, "a-cursor:from-another-day"));
    expect(asked.status).toBe(503);
    expect(asked.body.outcomes).toBeUndefined();
  });
});

describe("what the section draws reads in the console's voice", () => {
  const WORD = /\b(?:clean|resolved|secure|secured|safe|safer|all[\s-]clear|no issues|pass|passed|passing|ok)\b/i;

  it("no reassurance word and no positive tone, on a walk, on a refusal, on a failed page and on a backend that does not page", async () => {
    const check = (container: HTMLElement, what: string) => {
      const drawn = container.textContent ?? "";
      expect(drawn.match(WORD), what).toBeNull();
      expect(lintMicrocopy(drawn), what).toEqual([]);
      expect(container.querySelectorAll('[data-tone="positive"]'), what).toHaveLength(0);
    };
    const walked = await firstPage(DEP_PAGES);
    check(walked.container, "first page");
    press("effects-show-more");
    await waitFor(() => expect(shown()).toHaveLength(4));
    backend.script(DEP_PAGES, backend.cursorAfter(DEP_PAGES, 4), { status: 400, body: { error: BAD_CURSOR_WORDS, code: "bad_cursor" } });
    press("effects-show-more");
    await waitFor(() => expect(screen.queryByTestId("effects-list-changed")).not.toBeNull());
    check(walked.container, "a refused cursor");
    press("effects-from-first");
    await waitFor(() => expect(screen.queryByTestId("effects-show-more")).not.toBeNull());
    network = ["fails"];
    press("effects-show-more");
    await waitFor(() => expect(screen.queryByTestId("effects-next-not-read")).not.toBeNull());
    check(walked.container, "a failed page");
    cleanup();
    check((await firstPage(DEP_PAGES_OLDER)).container, "a backend that does not page");
    cleanup();
    check((await firstPage(DEP_PAGES_ODD_NEXT)).container, "an unreadable next");
  });
});
