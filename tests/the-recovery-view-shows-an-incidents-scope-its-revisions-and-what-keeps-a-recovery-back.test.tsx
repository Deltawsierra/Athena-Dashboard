// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import Authority from "@/pages/Authority";
import { gapInWords, uncertaintyInWords } from "@/components/authority/RecoveryRecords";
import { kindInWords, readScopeGap, reasonsAmong, scopeGapInWords, scopeStanding } from "@/components/authority/IncidentScope";
import { getQueryFn, queryClient as appQueryClient } from "@/lib/queryClient";
import type { RecoveryIncident, RecoveryRecords, RecoveryStep } from "@shared/recovery-record";
import { standIn } from "./helpers/bad-rows";
import {
  BACKUP, CASES, DEP, EVIDENCE_1, EVIDENCE_2, FINDING, LEAK, MODEM, NOT_DECLARED, PRIMARY, ROUTE, UNREADABLE, addedGap, servedByPath,
  type CaseName,
} from "./helpers/incident-scopes";

/**
 * The recovery screen (/authority/recovery) shows an incident's scope, its revisions and
 * what about the scope keeps a recovery back (SPINE SP-3; DASH-SCOPE).
 *
 * Every view here is handed what this console's real routes answer for a backend that
 * serves the shapes of athena-backend #229 at abdaa57 (tests/helpers/incident-scopes.ts,
 * read through tests/helpers/bad-rows.ts standIn), so what is drawn is drawn from the
 * server's own mapping. Synthetic data, invented names.
 *
 *   - the current scope: its revision on the record; and, once its revisions are opened,
 *     who declared it, why, when, and its items by kind;
 *   - the history: every revision newest first, with what each added and removed, who
 *     declared it and why. None is merged or left out;
 *   - what keeps a recovery back: each thing, the item it is for and why. A recovery
 *     taken under an earlier revision that a later one widened says so in words and names
 *     the later revision and each added item, and never reads as standing;
 *   - each step shows the scope revision it was taken under;
 *   - a removed item is listed with who removed it and why;
 *   - what the backend cannot establish reads "Not known", with its reason
 *     (`scope:not_declared`, `scope:unreadable`): never "none", never an empty list;
 *   - a row that cannot be read is counted beside its list, and never throws;
 *   - a kind of item this console does not know is drawn as unknown, never dropped;
 *   - a backend that serves none of this reads "not reported by this backend".
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Answer = unknown | { status: number; body: unknown };

/** What this console's routes answered for each case, by the URL the view asks. */
const page: { whole: RecoveryRecords | null } = { whole: null };
const record = {} as Record<CaseName, RecoveryIncident & { deployment: string | null }>;
const scopeAnswer = {} as Record<CaseName, Answer>;

beforeAll(async () => {
  const backend = await standIn();
  try {
    backend.serve(servedByPath());
    const whole = await backend.user.get(ROUTE.page);
    expect(whole.status, JSON.stringify(whole.body)).toBe(200);
    page.whole = whole.body;
    for (const name of CASES) {
      const one = await backend.user.get(ROUTE.record(name));
      expect(one.status, name).toBe(200);
      record[name] = one.body;
      const scope = await backend.user.get(ROUTE.scope(name));
      scopeAnswer[name] = scope.status === 200 ? scope.body : { status: scope.status, body: scope.body };
    }
  } finally {
    await backend.close();
  }
}, 120_000);

const STATUS = { configured: true, reachable: true, authorized: true, url: "https://backend.invalid", detail: "ok" };
const DEPLOYMENTS = [{ uuid: DEP, name: "harbor-desk", environment: "production", decision: "audit_incomplete", decisionLabel: "Audit incomplete" }];
const PAGE_URL = `${ROUTE.page}?offset=0`;

/** The page holding only these incidents, each as the route answered it. */
function pageOf(incidents: RecoveryIncident[]): RecoveryRecords {
  return { ...(page.whole as RecoveryRecords), incidents, incidentCount: incidents.length, returned: incidents.length };
}

interface Asked { url: string; method: string; signal: AbortSignal | undefined }

/** A fetch that answers as this console's server did, recording each call; a URL not listed never answers. */
function serve(answers: Record<string, Answer>): Asked[] {
  const asked: Asked[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    asked.push({ url: String(url), method: init?.method ?? "GET", signal: init?.signal ?? undefined });
    if (!(String(url) in answers)) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    const answer = answers[String(url)] as { status?: unknown; body?: unknown };
    const coded = answer !== null && typeof answer === "object" && typeof answer.status === "number" && "body" in answer;
    return new Response(JSON.stringify(coded ? answer.body : answer), {
      status: coded ? (answer.status as number) : 200, headers: { "Content-Type": "application/json" },
    });
  }));
  return asked;
}

function mount(path = `/authority/recovery?deployment=${DEP}`) {
  const location = memoryLocation({ path, record: true });
  const client = new QueryClient({
    defaultOptions: { ...appQueryClient.getDefaultOptions(), queries: { ...appQueryClient.getDefaultOptions().queries, queryFn: getQueryFn({ on401: "throw" }) } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <Authority params={{ screen: "recovery" }} />
      </Router>
    </QueryClientProvider>,
  );
}

const card = (name: CaseName) => document.querySelector(`[data-testid="incident"][data-incident="${FINDING[name]}"]`) as HTMLElement;
const current = (name: CaseName) => within(card(name)).getByTestId("incident-current");
const summary = (name: CaseName) => within(card(name)).getByTestId("incident-scope");
const one = (root: HTMLElement, testId: string) => within(root).getByTestId(testId);
const texts = (root: HTMLElement, testId: string) => within(root).queryAllByTestId(testId).map((node) => node.textContent);
/** The "could not be read" lines under `root`, as [list, count]. */
const unread = (root: HTMLElement) => within(root).queryAllByTestId("unreadable-rows").map((node) => [node.getAttribute("data-list"), node.getAttribute("data-count")]);

/** The deployment's page with these cases (all of them when none is named), and each one's scope read as the route answered it. */
async function mountCases(names: readonly CaseName[] = CASES, extra: Record<string, Answer> = {}): Promise<Asked[]> {
  const answers: Record<string, Answer> = {
    "/api/assurance/status": STATUS, "/api/assurance/deployments": DEPLOYMENTS,
    [PAGE_URL]: pageOf(names.map((name) => (page.whole as RecoveryRecords).incidents[CASES.indexOf(name)])),
  };
  for (const name of names) answers[ROUTE.scope(name)] = scopeAnswer[name];
  const asked = serve({ ...answers, ...extra });
  mount();
  await waitFor(() => expect(document.querySelectorAll('[data-testid="incident"]').length).toBe(names.length));
  return asked;
}

/** Open an incident's scope, and wait until its read has been drawn as `drawn`. */
async function openScope(name: CaseName, drawn = "scope-history"): Promise<HTMLElement> {
  fireEvent.click(one(card(name), "incident-scope-revisions-toggle"));
  await waitFor(() => expect(within(card(name)).getByTestId(drawn)).toBeTruthy());
  return within(card(name)).getByTestId(drawn);
}

const openSteps = (name: CaseName) => {
  fireEvent.click(one(card(name), "incident-steps-toggle"));
  return within(card(name)).getAllByTestId("history-step");
};

const WHY_REMOVED = "the refund workflow was never called, and the modem was never on this network";

describe("the current scope", () => {
  it("shows the revision the scope is at on the record, and reads nothing more until its revisions are opened", async () => {
    const asked = await mountCases(["declared"]);
    expect(summary("declared").getAttribute("data-scope-reported")).toBe("true");
    expect(one(summary("declared"), "scope-current").textContent).toBe("revision 1");
    // A list of removed items that was served, read whole and is empty: said as that, and only then.
    expect(one(summary("declared"), "scope-removed").getAttribute("data-row-count")).toBe("0");
    expect(one(summary("declared"), "scope-removed").textContent).toContain("No item a later revision added to this incident's scope has been removed since.");
    expect(asked.map((ask) => ask.url).filter((url) => url.includes("scope-revisions"))).toEqual([]);
    expect(within(card("declared")).queryByTestId("scope-history")).toBeNull();
  });

  it("shows who declared the current revision, why and when, and its items by kind, once opened", async () => {
    const asked = await mountCases(["declared"]);
    const history = await openScope("declared");
    expect(asked.map((ask) => ask.url).filter((url) => url.includes("scope-revisions"))).toEqual([ROUTE.scope("declared")]);
    const now = one(history, "scope-current-revision");
    expect(now.getAttribute("data-revision")).toBe("1");
    expect(one(now, "revision-declared-by").textContent).toBe("owner-d");
    expect(one(now, "revision-declared-at").textContent).toBe("2026-11-01T09:00:00+00:00");
    expect(one(now, "revision-why").textContent).toBe("what the scan reached");
    const groups = within(now).getAllByTestId("items-of-kind");
    expect(groups.map((group) => group.getAttribute("data-item-kind"))).toEqual(["asset", "workflow"]);
    expect(groups.map((group) => group.textContent)).toEqual([`Assets (1)asset ${PRIMARY} (gateway)`, "Workflows (1)workflow refund"]);
  });
});

describe("the history", () => {
  it("draws every revision newest first, with what each added and removed, who declared it and why -- none merged or left out", async () => {
    await mountCases(["three"]);
    const history = await openScope("three");
    expect(history.getAttribute("data-revision-count")).toBe("3");
    const rows = within(history).getAllByTestId("scope-revision");
    expect(rows.map((row) => row.getAttribute("data-revision"))).toEqual(["3", "2", "1"]);
    const [third, second, first] = rows;
    // Revision 3: the current one. It added nothing, and removed two items: who and why are the revision's own.
    expect(within(third).getByTestId("revision-current").textContent).toBe("current");
    expect(third.textContent).toContain("supersedes revision 2");
    expect(one(third, "revision-declared-by").textContent).toBe("owner-d");
    expect(one(third, "revision-why").textContent).toBe(WHY_REMOVED);
    expect(one(third, "revision-added").textContent).toBe("Added nothing.");
    expect(texts(one(third, "revision-removed"), "scope-item")).toEqual(["workflow refund", `asset ${MODEM}`]);
    // Revision 2: nobody on record declared it, said as that. It added two items and removed nothing.
    expect(within(second).queryByTestId("revision-current")).toBeNull();
    expect(one(second, "revision-declared-by").textContent).toBe("nobody on record");
    expect(one(second, "revision-why").textContent).toBe("a backup route and a vendor modem in the firewall export");
    expect(texts(one(second, "revision-added"), "scope-item")).toEqual([`asset ${BACKUP}`, `asset ${MODEM}`]);
    expect(one(second, "revision-removed").textContent).toBe("Removed nothing.");
    // Revision 1: supersedes none, and everything it names it added.
    expect(first.textContent).toContain("supersedes none");
    expect(texts(one(first, "revision-added"), "scope-item")).toEqual([`asset ${PRIMARY}`, "workflow refund"]);
    // Each names everything it holds, and the evidence it rests on.
    expect(rows.map((row) => one(row, "revision-items").getAttribute("data-row-count"))).toEqual(["2", "4", "2"]);
    expect(texts(first, "revision-evidence-item")).toEqual([`${EVIDENCE_1} technically_verified`]);
    expect(texts(second, "revision-evidence-item")).toEqual([`${EVIDENCE_2} technically_verified`]);
    // The current scope is the newest: revision 3, with what it names now.
    expect(one(history, "scope-current-revision").getAttribute("data-revision")).toBe("3");
    expect(texts(one(history, "scope-current-revision"), "scope-item")).toEqual([`asset ${PRIMARY} (gateway)`, `asset ${BACKUP} (gateway)`]);
  });
});

describe("removed items", () => {
  it("lists each on the record with both revisions, who removed it and why -- with no further read", async () => {
    const asked = await mountCases(["three"]);
    const removed = one(summary("three"), "scope-removed");
    expect(removed.getAttribute("data-row-count")).toBe("1");
    expect(texts(removed, "scope-removed-item")).toEqual([
      `asset ${MODEM} -- added by revision 2, removed by revision 3; removed by owner-d; why: ${WHY_REMOVED}`,
    ]);
    expect(one(removed, "removed-by").textContent).toBe("owner-d");
    expect(one(removed, "removed-why").textContent).toBe(WHY_REMOVED);
    // The step taken after the removal lists it too, beside what its scope gained and what names that.
    const step = one(current("three"), "step-scope");
    expect(texts(one(step, "step-scope-removed"), "scope-removed-item")).toEqual(texts(removed, "scope-removed-item"));
    expect(texts(one(step, "step-scope-added"), "scope-added-item")).toEqual([
      `asset ${BACKUP} -- added by revision 2; named by evidence of a finding on it ${EVIDENCE_2}; a coverage observation of it (looked at in full, nothing found) asset:${BACKUP}`,
    ]);
    expect(asked.map((ask) => ask.url).filter((url) => url.includes("scope-revisions"))).toEqual([]);
  });

  it("says who is not on record, and that no reason is, in words", async () => {
    const gone = { kind: "asset", ref: MODEM, added: null, removed: 3, removedBy: null, reason: null };
    const incident: RecoveryIncident = { ...record.three, scope: { revision: 3, removed: [gone] } };
    serve({ "/api/assurance/status": STATUS, "/api/assurance/deployments": DEPLOYMENTS, [PAGE_URL]: pageOf([incident]) });
    mount();
    await waitFor(() => expect(card("three")).toBeTruthy());
    expect(texts(one(summary("three"), "scope-removed"), "scope-removed-item")).toEqual([
      `asset ${MODEM} -- added by a revision not named, removed by revision 3; removed by nobody on record; why: no reason on record`,
    ]);
  });
});

describe("each step shows the scope revision it was taken under", () => {
  it("on the current step and on every step of the history, beside the revision the scope is at now", async () => {
    await mountCases(["three", "widened"]);
    expect(one(current("three"), "step-scope-revision").textContent).toBe("revision 3");
    expect(within(current("three")).queryByTestId("step-scope-current")).toBeNull();
    const steps = openSteps("three");
    expect(steps.map((step) => one(step, "step-scope-revision").textContent)).toEqual(["revision 1", "revision 3"]);
    // A step taken under an earlier revision says where the scope is now.
    expect(one(steps[0], "step-scope-current").textContent).toBe(" -- the incident's scope is now at revision 3");
    expect(one(steps[0], "step-scope").getAttribute("data-step-scope-revision")).toBe("1");
    // Nothing of the scope against it: the revisions between only removed items.
    expect(one(steps[0], "step-scope").getAttribute("data-scope-standing")).toBe("none_named");
    expect(one(steps[0], "step-scope-gaps").textContent).toBe("No scope gap is recorded against this step.");
    expect(one(current("widened"), "step-scope-revision").textContent).toBe("revision 1");
  });
});

describe("what keeps a recovery back", () => {
  it("says in words that the scope widened after an accepted recovery, names the later revision and each added item, and never looks reached", async () => {
    await mountCases(["widened"]);
    const now = current("widened");
    // The state and release as the backend serves them now: neither the accepted state nor an allowed release.
    expect(one(now, "step-state").textContent).toBe("repair_tested");
    expect(one(now, "step-release").textContent).toBe("Release: audit incomplete");
    expect(one(now, "step-scope-standing").textContent).toBe("Kept back by the scope");
    expect(one(now, "step-scope-standing").getAttribute("data-tone")).toBe("caution");
    expect(one(now, "step-scope").getAttribute("data-scope-standing")).toBe("kept_back");
    // In words: under which revision it was taken, which later one widened the scope, and each item it added.
    expect(one(now, "step-scope-current").textContent).toBe(" -- the incident's scope is now at revision 2");
    const widened = one(now, "step-scope-widened");
    expect(widened.textContent).toBe(
      `The scope has widened since this step was taken under revision 1: revision 2 added asset ${BACKUP}, workflow payout. What this step recorded does not stand for the wider scope.`,
    );
    expect(Array.from(widened.querySelectorAll("[data-widened-by]")).map((node) => node.getAttribute("data-widened-by"))).toEqual(["2"]);
    // Each thing that keeps it back: the item it is for, and why.
    expect(one(now, "step-scope-kept-back").textContent).toBe("Kept back by the scope: 2 things");
    expect(texts(now, "scope-gap-words")).toEqual([
      `asset ${BACKUP}: revision 2 added it to the scope after this step was taken under revision 1`,
      "workflow payout: revision 2 added it to the scope after this step was taken under revision 1",
    ]);
    expect(within(now).getAllByTestId("scope-gap").map((gap) => gap.getAttribute("data-scope-gap"))).toEqual([
      addedGap(2, "asset", BACKUP), addedGap(2, "workflow", "payout"),
    ]);
    // The step's own list of gaps names them too, as scope gaps, in words.
    expect(texts(now, "gap-words")).toEqual([
      `Scope gap: revision 2 added asset ${BACKUP} to the scope, and this step does not cover it`,
      "Scope gap: revision 2 added workflow payout to the scope, and this step does not cover it",
    ]);
    // What the row recorded is said as history, in a sentence: never as a chip, and never as how it reads now.
    const recorded = one(now, "step-recorded");
    expect(recorded.textContent).toBe(
      "As its row recorded it, under scope revision 1: state recovery_accepted; Release: allowed on this step; no gap then. That is history: it is not how this step reads now.",
    );
    expect(recorded.querySelector("[data-tone]")).toBeNull();
    // Nothing in the card reads as reached: no positive tone, and the only "allowed" is inside the history sentence.
    expect(card("widened").querySelectorAll('[data-tone="positive"]').length).toBe(0);
    expect(card("widened").innerHTML).not.toMatch(/emerald|green/);
    expect(within(card("widened")).getAllByTestId("step-release").map((node) => node.textContent)).toEqual(["Release: audit incomplete"]);
    expect(within(card("widened")).getAllByTestId("step-state").map((node) => node.textContent)).toEqual(["repair_tested"]);
    // The owner's acceptance is still shown exactly as recorded, beside a state the scope keeps short of it.
    expect(one(now, "acceptance-words").textContent).toBe("accepted by owner-d until 2999-01-01T00:00:00+00:00");
  });

  it("never draws a step as accepted or allowed beside a scope gap, even when it is served so", async () => {
    await mountCases(["contradicted"]);
    const now = current("contradicted");
    expect(record.contradicted.steps[0]).toMatchObject({ state: "recovery_accepted", release: "PASS" });
    expect(one(now, "step-state").textContent).toBe("recovery_accepted: not standing under the scope");
    expect(one(now, "step-state").getAttribute("data-tone")).toBe("caution");
    const release = one(now, "step-release");
    expect(release.textContent).toBe("Release: not read as allowed while the scope keeps this step back");
    expect(release.getAttribute("data-release-standing")).toBe("false");
    expect(release.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("caution");
    expect(now.textContent).not.toContain("Release: allowed on this step");
    expect(one(now, "step-scope-standing").textContent).toBe("Kept back by the scope");
    expect(one(now, "step-scope-widened").textContent).toContain(`revision 2 added asset ${BACKUP}`);
  });

  it("names an item a revision added that nothing the step rests on names: an open gap, the item and why", async () => {
    await mountCases(["open"]);
    const now = current("open");
    expect(one(now, "step-scope-kept-back").textContent).toBe("Kept back by the scope: 1 thing");
    expect(texts(now, "scope-gap-words")).toEqual([
      `asset ${BACKUP}: revision 2 added it to the scope, and nothing this step rests on names it`,
    ]);
    // Taken under the revision that added it: the scope did not widen after the step.
    expect(within(now).queryByTestId("step-scope-widened")).toBeNull();
    expect(within(now).queryByTestId("step-scope-current")).toBeNull();
    const added = within(one(now, "step-scope-added")).getAllByTestId("scope-added-item");
    expect(added.map((item) => item.textContent)).toEqual([
      `asset ${BACKUP} -- added by revision 2; nothing this step rests on names it: an open gap`,
      "workflow payout -- added by revision 2; named by a gate permit of it gate-7",
    ]);
    expect(within(added[0]).getByTestId("added-open")).toBeTruthy();
    expect(within(added[1]).queryByTestId("added-open")).toBeNull();
    // Its row recorded what it reads as now: no history line is needed, and none is drawn.
    expect(within(now).queryByTestId("step-recorded")).toBeNull();
  });
});

describe("not known is said as not known, with the backend's reason", () => {
  it("no scope declared: not known, because no revision is on record -- never none, never an empty list", async () => {
    await mountCases(["undeclared"]);
    expect(one(summary("undeclared"), "scope-current-none").textContent).toBe(
      "No scope is declared for this incident, so what its recovery covers is not known. The backend's reason: no scope revision is on record (scope:not_declared).",
    );
    expect(one(summary("undeclared"), "scope-removed-not-known").textContent).toBe(
      "Not known: what this incident's scope has lost cannot be established. The backend's reason: no scope revision is on record (scope:not_declared).",
    );
    expect(within(summary("undeclared")).queryByTestId("scope-removed")).toBeNull();
    expect(within(summary("undeclared")).queryByTestId("scope-current")).toBeNull();
    const now = current("undeclared");
    expect(one(now, "step-scope-revision").textContent).toBe("no revision: this step names none");
    expect(one(now, "step-scope-added-not-known").textContent).toBe(
      "Not known: what this step's scope gained cannot be established. The backend's reason: no scope revision is on record (scope:not_declared).",
    );
    expect(one(now, "step-scope-removed-not-known").textContent).toBe(
      "Not known: what this step's scope has lost cannot be established. The backend's reason: no scope revision is on record (scope:not_declared).",
    );
    expect(within(now).queryByTestId("step-scope-added")).toBeNull();
    expect(within(now).queryByTestId("step-scope-removed")).toBeNull();
    expect(texts(now, "scope-gap-words")).toEqual(["No scope revision is on record for this step, so what it covers is not known"]);
    expect(Array.from(card("undeclared").querySelectorAll("[data-scope-reason]")).every((node) => node.getAttribute("data-scope-reason") === NOT_DECLARED)).toBe(true);
    // Nowhere does the card say that nothing was added or removed.
    expect(card("undeclared").textContent).not.toMatch(/No item|Added nothing|Removed nothing/);
    // Its revisions, opened: a list that was read and is empty, said as no scope declared -- not as nothing affected.
    const history = await openScope("undeclared");
    expect(one(history, "scope-none-declared").textContent).toContain("none is declared");
    expect(one(history, "scope-none-declared").textContent).toContain("which is not the same as nothing being affected");
    expect(within(history).queryByTestId("scope-revision")).toBeNull();
  });

  it("a revision that cannot be read: not known, because a revision cannot be read -- beside what is known", async () => {
    await mountCases(["unreadable"]);
    expect(one(summary("unreadable"), "scope-current").textContent).toBe("revision 2");
    expect(one(summary("unreadable"), "scope-removed-not-known").textContent).toBe(
      "Not known: what this incident's scope has lost cannot be established. The backend's reason: a revision of the scope cannot be read (scope:unreadable).",
    );
    // The step taken under the unreadable revision: what its scope gained and lost is not known.
    const now = current("unreadable");
    expect(one(now, "step-scope-revision").textContent).toBe("revision 2");
    expect(one(now, "step-scope-added-not-known").textContent).toContain("a revision of the scope cannot be read (scope:unreadable)");
    expect(one(now, "step-scope-removed-not-known").textContent).toContain("a revision of the scope cannot be read (scope:unreadable)");
    expect(texts(now, "scope-gap-words")).toEqual(["A revision of this incident's scope cannot be read, so what is in scope is not known"]);
    // The step taken under revision 1, which could be read: its own lists are known, and empty is said of them.
    const [first] = openSteps("unreadable");
    expect(one(first, "step-scope-added").textContent).toBe("No item was added to this step's scope after its first revision.");
    expect(within(first).queryByTestId("step-scope-added-not-known")).toBeNull();
    // It was accepted and no longer reads so: the history line says what its row recorded.
    expect(one(first, "step-recorded").getAttribute("data-recorded-state")).toBe("recovery_accepted");
    expect(one(first, "step-state").textContent).toBe("repair_tested");
    // Its revisions: what the unreadable one added and removed is not known, and its item is drawn as stored.
    const history = await openScope("unreadable");
    const [second, firstRevision] = within(history).getAllByTestId("scope-revision");
    expect(one(second, "revision-added-not-known").textContent).toBe(
      "Not known: what this revision added cannot be established, because its items or those of the revision before it cannot be read. The backend's reason: a revision of the scope cannot be read (scope:unreadable).",
    );
    expect(one(second, "revision-removed-not-known").textContent).toContain("Not known: what this revision removed cannot be established");
    expect(within(second).queryByTestId("revision-added")).toBeNull();
    expect(second.textContent).not.toMatch(/Added nothing|Removed nothing/);
    expect(texts(one(second, "revision-items"), "scope-item")).toEqual(["asset no reference served"]);
    expect(one(second, "revision-evidence").textContent).toBe("It names no evidence.");
    expect(texts(one(firstRevision, "revision-added"), "scope-item")).toEqual([`asset ${PRIMARY}`]);
  });

  it("a row from before the scope was versioned: its lists are not known, and what it recorded is history", async () => {
    await mountCases(["before"]);
    const now = current("before");
    expect(one(now, "step-scope-revision").textContent).toBe("no revision: this step names none");
    expect(one(now, "step-scope-added-not-known").textContent).toContain("(scope:not_declared)");
    expect(one(now, "step-scope-removed-not-known").textContent).toContain("(scope:not_declared)");
    expect(one(now, "step-recorded").textContent).toBe(
      "As its row recorded it: state recovery_accepted; Release: allowed on this step; no gap then. That is history: it is not how this step reads now.",
    );
    expect(one(now, "step-state").textContent).toBe("repair_tested");
    expect(one(now, "step-release").textContent).toBe("Release: audit incomplete");
  });

  it("scope gaps that were not served: whether the scope keeps the step back is not known, and it is not drawn as allowed", async () => {
    await mountCases(["partial"]);
    const now = current("partial");
    expect(one(now, "step-scope").getAttribute("data-scope-standing")).toBe("not_known");
    expect(one(now, "step-scope-gaps-not-known").textContent).toBe(
      "Not known: what about the scope keeps this step back was not served, so whether anything does is not known.",
    );
    expect(one(now, "step-scope-standing").textContent).toBe("Whether the scope keeps this step back is not known");
    expect(one(now, "step-state").textContent).toBe("recovery_accepted: not standing under the scope");
    expect(one(now, "step-release").textContent).toBe("Release: not read as allowed while what the scope says of this step is not known");
    // Nothing served gives a reason, and that is said.
    expect(one(summary("partial"), "scope-removed-not-known").textContent).toBe(
      "Not known: what this incident's scope has lost cannot be established. The backend gives no reason.",
    );
    expect(one(now, "step-scope-added-not-known").textContent).toBe(
      "Not known: what this step's scope gained cannot be established. The backend gives no reason.",
    );
  });

  it("a scope read that names no revisions, or is not a scope at all: not known, never an incident without a scope", async () => {
    await mountCases(["declared"], { [ROUTE.scope("declared")]: { deployment: null, finding: null, current: null, revisions: null } });
    const none = await openScope("declared", "scope-revisions-not-known");
    expect(none.textContent).toBe(
      "Not known: Athena-Backend served no list of revisions for this incident's scope. That is not an incident without a scope.",
    );
    cleanup();
    for (const nonsense of [7, "three revisions", [1, 2], { revisions: "many" }]) {
      await mountCases(["declared"], { [ROUTE.scope("declared")]: nonsense });
      const said = await openScope("declared", "scope-answer-unreadable");
      expect(said.textContent, JSON.stringify(nonsense)).toContain("is not one this console can read, so its scope is not known here");
      expect(within(card("declared")).queryByTestId("scope-revision")).toBeNull();
      // The record it rides beside is still drawn.
      expect(one(current("declared"), "step-state").textContent).toBe("recovery_accepted");
      cleanup();
    }
  });
});

describe("a row that cannot be read is counted and said", () => {
  it("beside each list on the record, with every row that could be read, and what it held never shown", async () => {
    await mountCases(["rows"]);
    // The incident's removed items: one read, two that could not be.
    const removed = one(summary("rows"), "scope-removed");
    expect(texts(removed, "scope-removed-item")).toHaveLength(1);
    expect(removed.getAttribute("data-unread-count")).toBe("2");
    expect(within(removed).getByTestId("unreadable-rows").textContent).toBe("2 rows could not be read: removed items");
    const now = current("rows");
    expect(unread(one(now, "step-scope"))).toEqual([
      ["gaps", "3"], ["recorded.gaps", "1"], ["added", "2"], ["added.coveredBy", "2"], ["removed", "1"],
    ]);
    expect(one(now, "step-scope-gaps").textContent).toContain("3 rows could not be read: what about the scope keeps this step back");
    expect(texts(now, "scope-gap-words")).toHaveLength(1);
    expect(texts(one(now, "step-scope-added"), "scope-added-item")).toHaveLength(1);
    expect(one(now, "step-scope-added").textContent).toContain("2 rows could not be read: items this step's scope gained");
    expect(one(now, "step-scope-removed").textContent).toContain("1 row could not be read: removed items");
    expect(document.body.textContent).not.toContain(LEAK);
  });

  it("beside each list of the scope's revisions, and a list that is not one is said as unread, never as nothing", async () => {
    await mountCases(["rows"]);
    const history = await openScope("rows");
    expect(history.getAttribute("data-unread-count")).toBe("2");
    expect(history.querySelector(':scope > [data-testid="unreadable-rows"]')?.textContent).toBe(
      "2 rows could not be read: the revisions of this incident's scope",
    );
    const [second, first] = within(history).getAllByTestId("scope-revision");
    expect(unread(first)).toEqual([]);
    expect(unread(second)).toEqual([["added", "1"], ["removed", "not a list"], ["items", "2"], ["evidence", "1"]]);
    expect(one(second, "revision-added").textContent).toBe(`asset ${BACKUP}1 row could not be read: what this revision added`);
    // Served as something that is not a list: "could not be read", and never "Removed nothing."
    expect(one(second, "revision-removed").textContent).toBe("The list could not be read: what this revision removed");
    expect(one(second, "revision-removed").getAttribute("data-unread-count")).toBe("unknown");
    expect(texts(one(second, "revision-items"), "scope-item")).toEqual([`asset ${PRIMARY} (gateway)`, `asset ${BACKUP} (gateway)`]);
    expect(document.body.textContent).not.toContain(LEAK);
  });

  it("never says nothing of a list whose every row could not be read", async () => {
    const step: RecoveryStep = {
      ...record.rows.steps[0],
      scope: { revision: 2, gaps: [], added: [], removed: [], recorded: null, unreadable: { gaps: 2, added: 1, removed: "not a list" } },
    };
    const incident: RecoveryIncident = { ...record.rows, steps: [step], scope: { revision: 2, removed: [], unreadable: { removed: 3 } } };
    serve({ "/api/assurance/status": STATUS, "/api/assurance/deployments": DEPLOYMENTS, [PAGE_URL]: pageOf([incident]) });
    mount();
    await waitFor(() => expect(card("rows")).toBeTruthy());
    expect(card("rows").textContent).not.toMatch(/No item|No scope gap is recorded/);
    expect(one(summary("rows"), "scope-removed").textContent).toBe("3 rows could not be read: removed items");
    const now = current("rows");
    // Scope gaps that could not be read are not "no scope gap": whether the scope keeps the step back is not known.
    expect(scopeStanding(step)).toBe("not_known");
    expect(one(now, "step-scope-standing").textContent).toBe("Whether the scope keeps this step back is not known");
    expect(one(now, "step-scope-gaps").textContent).toBe("2 rows could not be read: what about the scope keeps this step back");
    expect(one(now, "step-scope-removed").textContent).toBe("The list could not be read: removed items");
  });
});

describe("a kind of item this console does not know", () => {
  it("is drawn as an unknown kind with its value, in the scope's items, in a gap and in what a step's scope gained -- never dropped", async () => {
    await mountCases(["kind"]);
    const now = current("kind");
    expect(texts(now, "scope-gap-words")).toEqual([
      "item of an unknown kind (modem) vendor-modem-7: revision 2 added it to the scope, and nothing this step rests on names it",
    ]);
    expect(texts(now, "gap-words")).toEqual([
      "Scope gap: revision 2 added item of an unknown kind (modem) vendor-modem-7 to the scope, and this step does not cover it",
    ]);
    expect(texts(one(now, "step-scope-added"), "scope-added-item")).toEqual([
      `route backup-route -- added by revision 2; named by evidence of a finding on it ${EVIDENCE_2}`,
      // A kind of link not known here is shown as served too.
      "identity svc-ledger -- added by revision 2; named by a link of an unknown kind (attestation) att-3",
      "item of an unknown kind (modem) vendor-modem-7 -- added by revision 2; nothing this step rests on names it: an open gap",
    ]);
    const history = await openScope("kind");
    const groups = within(one(history, "scope-current-revision")).getAllByTestId("items-of-kind");
    expect(groups.map((group) => [group.getAttribute("data-item-kind"), group.getAttribute("data-kind-known")])).toEqual([
      ["asset", "true"], ["route", "true"], ["identity", "true"], ["modem", "false"], ["", "false"],
    ]);
    expect(groups.map((group) => group.textContent)).toEqual([
      `Assets (1)asset ${PRIMARY} (gateway)`,
      "Routes (1)route backup-route",
      "Identities (1)identity svc-ledger",
      "Unknown kind (modem) (1)item of an unknown kind (modem) vendor-modem-7",
      "No kind served (1)item of no kind served an-item-of-no-kind",
    ]);
    // Every item the revision names is on the screen: five served, five drawn.
    expect(one(one(history, "scope-current-revision"), "revision-items").getAttribute("data-row-count")).toBe("5");
    expect(within(one(history, "scope-current-revision")).getAllByTestId("scope-item")).toHaveLength(5);
    expect(kindInWords("constructor")).toBe("item of an unknown kind (constructor)");
  });
});

describe("a backend that serves none of the scope", () => {
  it("reads as not reported by this backend: no scope is implied to be absent, nothing is read for it, and nothing breaks", async () => {
    const asked = await mountCases(["older"]);
    expect(record.older).not.toHaveProperty("scope");
    expect(summary("older").getAttribute("data-scope-reported")).toBe("false");
    const said = one(summary("older"), "scope-not-reported").textContent ?? "";
    expect(said).toContain("The scope is not reported by this backend.");
    expect(said).toContain("That is not an incident without a scope");
    // No revision, no "no scope declared", no empty list of removed items, and no read of a route it does not have.
    for (const absent of ["scope-current", "scope-current-none", "scope-removed", "scope-removed-not-known", "incident-scope-revisions-toggle"]) {
      expect(within(card("older")).queryByTestId(absent), absent).toBeNull();
    }
    expect(asked.map((ask) => ask.url).filter((url) => url.includes("scope-revisions"))).toEqual([]);
    const now = current("older");
    expect(one(now, "step-scope").getAttribute("data-scope-standing")).toBe("not_reported");
    expect(one(now, "step-scope-not-reported").textContent).toBe("not reported by this backend");
    expect(within(now).queryByTestId("step-scope-standing")).toBeNull();
    // The step is drawn as it always was.
    expect(one(now, "step-state").textContent).toBe("recovery_accepted");
    expect(one(now, "step-release").textContent).toBe("Release: allowed on this step");
    expect(one(now, "acceptance-words").textContent).toBe("accepted by owner-d until 2999-01-01T00:00:00+00:00");
  });
});

describe("the scope's own read", () => {
  it("reads a finding the backend answers 404 for as not found -- a backend without the route included -- never as an empty scope", async () => {
    await mountCases(["contradicted"]);
    expect(scopeAnswer.contradicted).toMatchObject({ status: 404, body: { code: "not_found" } });
    const said = await openScope("contradicted", "scope-not-found");
    expect(said.textContent).toContain("Not found.");
    expect(said.textContent).toContain("a backend without the scope's route answers the same");
    expect(said.textContent).toContain("This is not an empty scope");
    expect(within(card("contradicted")).queryByTestId("scope-none-declared")).toBeNull();
  });

  it("says a read that could not be made could not be read, and one answered for another incident is not shown", async () => {
    await mountCases(["declared"], { [ROUTE.scope("declared")]: { status: 503, body: { error: "the Athena control plane answered 500" } } });
    const failed = await openScope("declared", "read-error");
    expect(failed.textContent).toBe("Could not read this incident's scope: the Athena control plane answered 500");
    expect(one(current("declared"), "step-state").textContent).toBe("recovery_accepted");
    cleanup();
    await mountCases(["declared"], { [ROUTE.scope("declared")]: scopeAnswer.three });
    const other = await openScope("declared", "scope-other-incident");
    expect(other.textContent).toContain("so it is not shown here");
    expect(within(card("declared")).queryByTestId("scope-revision")).toBeNull();
  });

  it("is not read for a record whose finding id is not one the backend issues", async () => {
    const incident: RecoveryIncident = { ...record.declared, finding: "../../failsafe/commands" };
    const asked = serve({ "/api/assurance/status": STATUS, "/api/assurance/deployments": DEPLOYMENTS, [PAGE_URL]: pageOf([incident]) });
    mount();
    await waitFor(() => expect(document.querySelectorAll('[data-testid="incident"]').length).toBe(1));
    expect(screen.getByTestId("scope-revisions-unreadable-id").textContent).toContain("so the revisions of its scope are not read");
    expect(screen.queryByTestId("incident-scope-revisions-toggle")).toBeNull();
    expect(asked.map((ask) => ask.url).filter((url) => url.includes("scope-revisions") || url.includes("failsafe"))).toEqual([]);
  });

  it("shows one incident opened on its own with its scope too", async () => {
    serve({
      "/api/assurance/status": STATUS, "/api/assurance/deployments": DEPLOYMENTS,
      [ROUTE.record("widened")]: record.widened, [ROUTE.scope("widened")]: scopeAnswer.widened,
    });
    mount(`/authority/recovery?deployment=${DEP}&finding=${FINDING.widened}`);
    await waitFor(() => expect(card("widened")).toBeTruthy());
    expect(one(summary("widened"), "scope-current").textContent).toBe("revision 2");
    expect(one(current("widened"), "step-scope-widened")).toBeTruthy();
    const history = await openScope("widened");
    expect(within(history).getAllByTestId("scope-revision").map((row) => row.getAttribute("data-revision"))).toEqual(["2", "1"]);
    expect(one(one(history, "scope-current-revision"), "revision-declared-by").textContent).toBe("analyst-k");
  });
});

describe("nothing on it writes", () => {
  it("every read is a GET, every button only shows or hides, and there is nothing to type into", async () => {
    const asked = await mountCases();
    for (const name of CASES) {
      if (within(card(name)).queryByTestId("incident-scope-revisions-toggle") === null) continue;
      fireEvent.click(one(card(name), "incident-scope-revisions-toggle"));
      await waitFor(() => expect(one(card(name), "incident-scope-revisions").getAttribute("data-open")).toBe("true"));
    }
    const section = screen.getByTestId("recovery-section");
    const buttons = Array.from(section.querySelectorAll("button")).map((button) => button.textContent ?? "");
    expect(buttons.filter((label) => !/^(?:Show|Hide) (?:the \d+ recorded steps?, oldest first|this incident's scope: who declared it, why and when, its items, and every revision, newest first)$/.test(label))).toEqual([]);
    expect(section.querySelectorAll("input, textarea, select, form").length).toBe(0);
    expect(asked.filter((ask) => ask.method !== "GET")).toEqual([]);
  });
});

describe("the words", () => {
  it("reads each of the backend's names for a scope gap, and shows one it does not know as served", () => {
    expect(readScopeGap(NOT_DECLARED)).toEqual({ is: "not_declared" });
    expect(readScopeGap(UNREADABLE)).toEqual({ is: "unreadable" });
    expect(readScopeGap(addedGap(12, "workflow", "refund"))).toEqual({ is: "added", revision: 12, kind: "workflow", ref: "refund" });
    // A reference may hold a colon: everything after the kind is the reference.
    expect(readScopeGap("scope:revision:2:added:asset:urn:a:b")).toEqual({ is: "added", revision: 2, kind: "asset", ref: "urn:a:b" });
    expect(readScopeGap("scope:something_new")).toEqual({ is: "other" });
    expect(readScopeGap("coverage:missing:edr")).toBeNull();
    expect(scopeGapInWords(NOT_DECLARED)).toBe("Scope gap: no scope revision is on record for this step, so what it covers is not known");
    expect(scopeGapInWords(UNREADABLE)).toBe("Scope gap: a revision of this incident's scope cannot be read, so what is in scope is not known");
    expect(scopeGapInWords("scope:something_new")).toBe("Scope gap not recognised here: scope:something_new");
    expect(scopeGapInWords("modem on the backup line not in scope")).toBeNull();
    // The step's own gap and uncertainty words carry a scope gap, and leave every other gap as it read.
    expect(gapInWords(NOT_DECLARED)).toBe(scopeGapInWords(NOT_DECLARED));
    expect(uncertaintyInWords(UNREADABLE)).toBe(scopeGapInWords(UNREADABLE));
    expect(gapInWords("coverage:missing:proxy-logs")).toBe("Coverage gap: proxy-logs was not observed over all of the interval it is required for");
    expect(gapInWords("modem on the backup line not in scope")).toBe("Gap: modem on the backup line not in scope");
    expect(reasonsAmong([addedGap(2, "asset", BACKUP), UNREADABLE, NOT_DECLARED])).toEqual([NOT_DECLARED, UNREADABLE]);
    expect(reasonsAmong(null)).toEqual([]);
  });

  it("reads a step's standing against the scope only from what was served", () => {
    const step = (scope?: RecoveryStep["scope"]): RecoveryStep => ({ ...record.older.steps[0], ...(scope ? { scope } : {}) });
    const base = { revision: 1, added: [], removed: [], recorded: null };
    expect(scopeStanding(step())).toBe("not_reported");
    expect(scopeStanding(step({ ...base, gaps: [] }))).toBe("none_named");
    expect(scopeStanding(step({ ...base, gaps: [NOT_DECLARED] }))).toBe("kept_back");
    expect(scopeStanding(step({ ...base, gaps: null }))).toBe("not_known");
    expect(scopeStanding(step({ ...base, gaps: [], unreadable: { gaps: 1 } }))).toBe("not_known");
    expect(scopeStanding(step({ ...base, gaps: [], unreadable: { gaps: "not a list" } }))).toBe("not_known");
    // A row of another list that could not be read does not make the scope gaps unknown.
    expect(scopeStanding(step({ ...base, gaps: [], unreadable: { removed: 2 } }))).toBe("none_named");
  });
});
