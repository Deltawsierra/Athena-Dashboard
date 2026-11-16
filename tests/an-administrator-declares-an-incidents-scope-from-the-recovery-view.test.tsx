// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import Authority from "@/pages/Authority";
import { getQueryFn, queryClient as appQueryClient } from "@/lib/queryClient";
import { REASON_MOST, reasonProblem } from "@shared/scope-declaration";
import {
  BACKEND_PATH, BACKUP, DEP, ELSEWHERE, EVIDENCE_1, EVIDENCE_2, INCIDENT_ID, PRIMARY, REASON, RECORDED, REFUSALS, RELAY, ROUTE_PATH,
  SERVED_WORKFLOWS, declareStandIn, refused, servedBefore, type PostAnswer,
} from "./helpers/scope-declarations";
import { FINDING, INCIDENT, ITEM, SCOPE, servedPage } from "./helpers/incident-scopes";

/**
 * An administrator declares an incident's next scope revision from the recovery screen
 * (/authority/recovery; client/src/components/authority/DeclareScope.tsx; DASH-DECLARE).
 *
 * Every view is handed what this console's real routes answer for a stand-in
 * Athena-Backend in the shapes of `master` (tests/helpers/scope-declarations.ts), the
 * write's answers included: each was taken from server/routes.ts over the stand-in
 * before the screen is drawn. Synthetic data, invented names.
 *
 *   - an administrator of this console sees the control; anyone else sees none, and so
 *     does everyone on an incident whose scope the backend does not report;
 *   - the items are picked from the deployment's own assets and approved workflows, of
 *     the two kinds the backend takes, never typed in; the evidence from the incident's own;
 *   - the reason is checked as the backend checks it, each way, before anything is sent;
 *   - before posting, what the revision adds and removes is said in words; one that
 *     changes nothing is not posted;
 *   - every refusal is said by its code -- both spellings of a missing part, an unknown
 *     code, a 403 -- never repeating what was typed, and changes nothing else on screen;
 *   - after a 201 the scope and the recovery record are read again, and the screen
 *     draws the widened scope's hold as the recovery view already does.
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

type Answer = { status: number; body: unknown };
const PAGE_URL = `${ROUTE_PATH.page}?offset=0`;

/** This console's answers, as its routes gave them over the stand-in. */
const route = {
  before: {} as Record<string, Answer>,
  after: {} as Record<string, Answer>,
  choices: {} as Record<string, Answer>,
  post: {} as Record<string, Answer>,
};

beforeAll(async () => {
  const stand = await declareStandIn();
  const read = async (path: string): Promise<Answer> => {
    const res = await stand.admin.get(path);
    return { status: res.status, body: res.body };
  };
  const reads = async () => ({
    [ROUTE_PATH.choices]: await read(ROUTE_PATH.choices),
    [PAGE_URL]: await read(PAGE_URL),
    [ROUTE_PATH.record]: await read(ROUTE_PATH.record),
    [ROUTE_PATH.scope]: await read(ROUTE_PATH.scope),
  });
  const posted = async (answer: PostAnswer, name: string, as = stand.admin) => {
    stand.serve(servedBefore());
    stand.answerPost(answer);
    const res = await as.post(ROUTE_PATH.declare).send({ items: [{ kind: "asset", ref: BACKUP }], reason: REASON, evidence: [EVIDENCE_2] });
    route.post[name] = { status: res.status, body: res.body };
  };
  try {
    route.before = await reads();
    // The choices in the shapes the form has to say differently.
    const variant = async (name: string, answers: Record<string, unknown>) => {
      stand.serve({ ...servedBefore(), ...answers });
      route.choices[name] = await read(ROUTE_PATH.choices);
    };
    await variant("first", { [BACKEND_PATH.scope]: { deployment: DEP, finding: INCIDENT_ID, current: null, revisions: [] } });
    await variant("route item", {
      [BACKEND_PATH.scope]: {
        deployment: DEP, finding: INCIDENT_ID, current: 1,
        revisions: [{ revision: 1, current: true, items: [ITEM.primary, ITEM.refund, { kind: "route", ref: "backup-route" }] }],
      },
    });
    await variant("cut", { [BACKEND_PATH.workflows]: { ...SERVED_WORKFLOWS, truncated: true, approved_count: 1200 } });
    await variant("current not known", { [BACKEND_PATH.scope]: { deployment: DEP, finding: INCIDENT_ID, current: 4, revisions: [{ revision: 1, items: [] }] } });
    for (const [code, status] of REFUSALS) await posted(refused(code, status), code);
    await posted(refused("scope_frozen", 409), "unknown code");
    await posted({ status: 403, body: { detail: "Changing the assurance record requires an admin role." } }, "backend 403");
    await posted({ status: 404, body: { detail: "No Finding matches the given query." } }, "backend 404");
    await posted({ status: 500, raw: "Server Error (500)" }, "backend 500");
    await posted({ drop: true }, "no answer");
    await posted(RECORDED, "the reader", stand.reader);
    await posted(RECORDED, "recorded");
    route.after = await reads();
    // Last: a 401 ends the admin's sign-in to the stand-in.
    await posted({ status: 401, body: { detail: "Given token not valid for any token type" } }, "backend 401");
  } finally {
    await stand.close();
  }
}, 120_000);

const ADMIN = { authenticated: true, user: { id: "u-1", username: "admin", role: "admin", email: "admin@tenant.test", mustChangePassword: false } };
const READER = { authenticated: true, user: { id: "u-2", username: "quinn", role: "user", email: "quinn@tenant.test", mustChangePassword: false } };
const STATUS = { configured: true, reachable: true, authorized: true, url: "https://backend.invalid", detail: "ok" };
const DEPLOYMENTS = [{ uuid: DEP, name: "harbor-desk", environment: "production", decision: "audit_incomplete", decisionLabel: "Audit incomplete" }];

interface Asked { url: string; method: string; body: string | null; at: number }

/**
 * A fetch that answers as this console's server did: each GET from `reads`, which
 * become the reads after the revision once a POST was answered 201, and each POST with
 * `post`. A URL it does not know never answers. Every call is recorded, in order.
 */
/** Who the console says is signed in; NOT_ANSWERED: /api/auth/check never answers. */
const NOT_ANSWERED = Symbol("not answered");

function serve({ session = ADMIN, reads = route.before, post = route.post.recorded, extra = {} }: {
  session?: unknown; reads?: Record<string, Answer>; post?: Answer | "hang"; extra?: Record<string, Answer>;
} = {}) {
  const asked: Asked[] = [];
  let recorded = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    asked.push({ url: String(url), method, body: typeof init?.body === "string" ? init.body : null, at: asked.length });
    const respond = (answer: Answer) => new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } });
    if (method === "POST") {
      if (post === "hang") return new Promise<Response>(() => undefined);
      if (post.status === 201) recorded = true;
      return respond(post);
    }
    const answers: Record<string, Answer> = {
      "/api/assurance/status": { status: 200, body: STATUS },
      "/api/assurance/deployments": { status: 200, body: DEPLOYMENTS },
      ...(session === NOT_ANSWERED ? {} : { "/api/auth/check": { status: 200, body: session } }),
      ...(recorded ? route.after : reads),
      ...extra,
    };
    if (!(String(url) in answers)) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return respond(answers[String(url)]);
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

const card = () => document.querySelector(`[data-testid="incident"][data-incident="${INCIDENT_ID}"]`) as HTMLElement;
const toggle = () => within(card()).queryByTestId("incident-scope-declare-toggle");
const form = () => within(card()).getByTestId("declare-scope-form");
const item = (ref: string) => within(form()).getAllByTestId("declare-item").find((one) => one.getAttribute("data-item-ref") === ref) as HTMLInputElement;
const evidenceBox = (ref: string) => within(form()).getAllByTestId("declare-evidence-item").find((one) => one.getAttribute("data-evidence-ref") === ref) as HTMLInputElement;
const reasonInput = () => within(form()).getByTestId("declare-reason") as HTMLInputElement;
const blocked = () => within(form()).queryByTestId("declare-scope-blocked")?.getAttribute("data-blocked")?.split(" ") ?? [];
const said = () => within(card()).queryByTestId("declare-scope-said");
const posts = (asked: Asked[]) => asked.filter((one) => one.method === "POST");

async function openForm(asked?: Asked[]) {
  await waitFor(() => expect(card()).toBeTruthy());
  await waitFor(() => expect(toggle()).not.toBeNull());
  if (asked) expect(asked.filter((one) => one.url.includes("/scope-choices"))).toEqual([]);
  fireEvent.click(toggle()!);
  await waitFor(() => expect(within(card()).getByTestId("declare-scope-form")).toBeTruthy());
}

/** Widen the scope by the backup gateway, resting on the firewall export, for `reason`. */
function widen(reason = REASON) {
  fireEvent.click(item(BACKUP));
  fireEvent.click(evidenceBox(EVIDENCE_2));
  fireEvent.change(reasonInput(), { target: { value: reason } });
}

async function send() {
  fireEvent.click(within(form()).getByTestId("declare-scope-review"));
  fireEvent.click(within(form()).getByTestId("declare-scope-send"));
}

describe("who sees the control: an administrator, where the backend reports the scope", () => {
  it("an administrator of this console sees it; nothing is read for it until it is opened", async () => {
    const asked = serve();
    mount();
    await openForm(asked);
    expect(asked.filter((one) => one.url === ROUTE_PATH.choices)).toHaveLength(1);
  });

  it("a console account that is not an admin sees none, nor does anyone while who they are is not known", async () => {
    for (const session of [READER, { authenticated: true, user: null }, NOT_ANSWERED]) {
      const asked = serve({ session });
      mount();
      await waitFor(() => expect(card()).toBeTruthy());
      expect(within(card()).getByTestId("incident-scope").getAttribute("data-scope-reported")).toBe("true");
      expect(toggle(), String(typeof session === "symbol" ? "not answered" : JSON.stringify(session))).toBeNull();
      expect(within(card()).queryByTestId("incident-scope-declaration")).toBeNull();
      expect(card().querySelectorAll("input, textarea, form").length).toBe(0);
      expect(asked.filter((one) => one.url.includes("/scope-choices") || one.method !== "GET")).toEqual([]);
      cleanup();
    }
  });

  it("no one sees it on an incident whose scope the backend does not report (an older backend)", async () => {
    const older = { ...(route.before[PAGE_URL].body as Record<string, unknown>) };
    const olderIncident = (servedPage(["older"]) as { incidents: unknown[] }).incidents[0];
    expect(olderIncident).toBe(INCIDENT.older);
    // The incident as this console's route maps an older backend's: no scope block at all.
    const mapped = { ...(older.incidents as Array<Record<string, unknown>>)[0] };
    delete mapped.scope;
    for (const step of mapped.steps as Array<Record<string, unknown>>) delete step.scope;
    serve({ extra: { [PAGE_URL]: { status: 200, body: { ...older, incidents: [mapped] } } } });
    mount();
    await waitFor(() => expect(card()).toBeTruthy());
    expect(within(card()).getByTestId("scope-not-reported")).toBeTruthy();
    expect(toggle()).toBeNull();
  });
});

describe("the pickers offer only the deployment's own items, of the kinds the backend takes, never typed in", () => {
  it("assets by uuid and approved workflows by slug, the current revision's picked; never another deployment's asset; the incident's own evidence", async () => {
    serve();
    mount();
    await openForm();
    const offered = within(form()).getAllByTestId("declare-item");
    expect(offered.map((one) => `${one.getAttribute("data-item-kind")}:${one.getAttribute("data-item-ref")}`)).toEqual([
      `asset:${PRIMARY}`, `asset:${BACKUP}`, `asset:${RELAY}`, "workflow:refund", "workflow:payout",
    ]);
    expect(offered.filter((one) => (one as HTMLInputElement).checked).map((one) => one.getAttribute("data-item-ref"))).toEqual([PRIMARY, "refund"]);
    expect(form().textContent).not.toContain(ELSEWHERE);
    expect(form().textContent).not.toContain("another-tenant-gateway");
    expect(within(form()).getByTestId("declare-assets-elsewhere").textContent).toBe("1 asset was answered for another deployment and is not offered.");
    expect(within(form()).getAllByTestId("declare-evidence-item").map((one) => one.getAttribute("data-evidence-ref"))).toEqual([EVIDENCE_1, EVIDENCE_2]);
    // The only text a person types is the reason: no field takes an item or a piece of evidence.
    expect(Array.from(form().querySelectorAll("input:not([type=checkbox]), textarea, select")).map((one) => one.getAttribute("data-testid"))).toEqual(["declare-reason"]);
  });

  it("offers no kind the backend does not take: a route in the current scope is named as one the revision removes, never offered or posted", async () => {
    const asked = serve({ extra: { [ROUTE_PATH.choices]: route.choices["route item"] } });
    mount();
    await openForm();
    const kinds = new Set(within(form()).getAllByTestId("declare-item").map((one) => one.getAttribute("data-item-kind")));
    expect([...kinds]).toEqual(["asset", "workflow"]);
    expect(within(form()).getByTestId("declare-not-offered").getAttribute("data-item-count")).toBe("1");
    expect(within(form()).getByTestId("declare-not-offered-items").textContent).toContain("route backup-route");
    fireEvent.click(evidenceBox(EVIDENCE_1));
    fireEvent.change(reasonInput(), { target: { value: "the backup route was never connected" } });
    fireEvent.click(within(form()).getByTestId("declare-scope-review"));
    expect(within(form()).getByTestId("declare-scope-removes").textContent).toContain("route backup-route");
    fireEvent.click(within(form()).getByTestId("declare-scope-send"));
    await waitFor(() => expect(posts(asked)).toHaveLength(1));
    expect(JSON.parse(posts(asked)[0].body!)).toEqual({
      items: [{ kind: "asset", ref: PRIMARY }, { kind: "workflow", ref: "refund" }],
      reason: "the backup route was never connected",
      evidence: [EVIDENCE_1],
    });
  });

  it("posts exactly the items picked from the lists, the evidence picked and the reason typed", async () => {
    const asked = serve();
    mount();
    await openForm();
    widen();
    await send();
    await waitFor(() => expect(posts(asked)).toHaveLength(1));
    expect(posts(asked)[0].url).toBe(ROUTE_PATH.declare);
    expect(JSON.parse(posts(asked)[0].body!)).toEqual({
      items: [{ kind: "asset", ref: PRIMARY }, { kind: "asset", ref: BACKUP }, { kind: "workflow", ref: "refund" }],
      reason: REASON,
      evidence: [EVIDENCE_2],
    });
  });

  it("offers nothing for posting while a list could not be read whole, or the current revision is not known", async () => {
    for (const [variant, why] of [["cut", "lists"], ["current not known", "current"]] as const) {
      const asked = serve({ extra: { [ROUTE_PATH.choices]: route.choices[variant] } });
      mount();
      await openForm();
      widen();
      expect(blocked(), variant).toContain(why);
      expect((within(form()).getByTestId("declare-scope-review") as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(within(form()).getByTestId("declare-scope-review"));
      expect(posts(asked)).toEqual([]);
      cleanup();
    }
  });
});

describe("the reason is checked as the backend checks it, each way", () => {
  // Accepted by athena-backend incident_scope._reason (and #231's core rule): leading and trailing spaces, any
  // printable letter, up to 500 characters counted as code points (500 astral letters are 1000 UTF-16 units).
  const TAKEN = [
    " the backup route was decommissioned ", "Die Leitung war außer Betrieb", "x", "x".repeat(REASON_MOST), "é".repeat(REASON_MOST),
    "\u{1D538}".repeat(REASON_MOST), "a reason with 'quotes', <angle brackets> & ampersands",
  ];
  // Refused: blank, every line break, a tab, a control, a direction override, a zero-width and a no-break space,
  // a NUL, a lone surrogate, and one character too many.
  const REFUSED_REASONS: Array<[string, string]> = [
    ["", "blank"], ["   ", "blank"], ["\t", "blank"], ["first line\nsecond line", "line_break"], ["one line\n", "line_break"],
    ["one line\rover it", "line_break"], ["one\u2028two", "line_break"], ["a tab\tin it", "not_printable"], ["one line\u0007", "not_printable"],
    ["approved by \u202Eresu eht", "not_printable"], ["one\u200Bline", "not_printable"], ["a\u00A0no-break space", "not_printable"],
    ["nul\u0000", "not_printable"], ["half \uD800 a pair", "not_printable"], ["x".repeat(REASON_MOST + 1), "too_long"],
    ["\u{1D538}".repeat(REASON_MOST + 1), "too_long"],
  ];

  it("the rule itself: each refused reason for its own reason, each taken one taken", () => {
    for (const reason of TAKEN) expect(reasonProblem(reason), JSON.stringify(reason.slice(0, 20))).toBeNull();
    for (const [reason, problem] of REFUSED_REASONS) expect(reasonProblem(reason), JSON.stringify(reason.slice(0, 20))).toBe(problem);
  });

  // A text input drops LF and CR itself (HTML's value sanitization), so on screen a line break is one it keeps.
  const ON_SCREEN: Array<[string, string]> = [
    ...REFUSED_REASONS.filter(([reason]) => !/[\n\r]/.test(reason)),
    ["one\u0085two", "line_break"], ["one\u000Btwo", "line_break"], ["one\u000Ctwo", "line_break"], ["one\u2029two", "line_break"],
  ];

  it("a line feed or carriage return typed or pasted never reaches what is sent: the input drops it", async () => {
    serve();
    mount();
    await openForm();
    fireEvent.change(reasonInput(), { target: { value: "first line\nsecond line\r" } });
    expect(reasonInput().value).not.toMatch(/[\n\r]/);
  });

  it("a refused reason is said before anything is sent, and never sent", async () => {
    const asked = serve();
    mount();
    await openForm();
    fireEvent.click(item(BACKUP));
    fireEvent.click(evidenceBox(EVIDENCE_2));
    for (const [reason, problem] of ON_SCREEN) {
      expect(reason, "every reason here is one the input keeps as typed").not.toMatch(/[\n\r]/);
      fireEvent.change(reasonInput(), { target: { value: reason } });
      expect(blocked(), JSON.stringify(reason.slice(0, 20))).toContain(`reason:${problem}`);
      const review = within(form()).getByTestId("declare-scope-review") as HTMLButtonElement;
      expect(review.disabled).toBe(true);
      fireEvent.click(review);
      expect(within(form()).queryByTestId("declare-scope-send")).toBeNull();
      // What is said never repeats the reason.
      const words = within(form()).getByTestId("declare-scope-blocked").textContent ?? "";
      if (reason.trim().length > 3) expect(words).not.toContain(reason);
    }
    expect(posts(asked)).toEqual([]);
  });

  it("a taken reason is sent exactly as typed", async () => {
    for (const reason of [TAKEN[0], TAKEN[5]]) {
      const asked = serve();
      mount();
      await openForm();
      widen(reason);
      expect(blocked()).toEqual([]);
      await send();
      await waitFor(() => expect(posts(asked)).toHaveLength(1));
      expect(JSON.parse(posts(asked)[0].body!).reason).toBe(reason);
      cleanup();
    }
  });

  it("one the console takes and the backend refuses is said as the backend answers", async () => {
    serve({ post: route.post.malformed });
    mount();
    await openForm();
    widen("a reason with a letter newer than the backend's own tables: \u{1E5D0}");
    await send();
    await waitFor(() => expect(said()).not.toBeNull());
    expect(said()!.getAttribute("data-code")).toBe("malformed");
    expect(said()!.textContent).toContain("malformed");
  });
});

describe("before posting, what the revision changes is said in words", () => {
  it("what it adds and what it removes against the current revision", async () => {
    serve();
    mount();
    await openForm();
    widen();
    fireEvent.click(item("refund"));
    fireEvent.click(within(form()).getByTestId("declare-scope-review"));
    const change = within(form()).getByTestId("declare-scope-change");
    expect(within(change).getByTestId("declare-scope-change-heading").textContent).toBe("Against revision 1, revision 2 would:");
    expect(within(change).getByTestId("declare-scope-adds").textContent).toBe(`asset backup-gateway (Gateway) ${BACKUP}`);
    expect(within(change).getByTestId("declare-scope-removes").textContent).toBe("workflow Refunds refund");
    expect(within(change).getByTestId("declare-scope-rests-on").textContent).toBe("1 piece of this incident's evidence");
    expect(within(change).getByTestId("declare-scope-send").textContent).toBe("Declare revision 2");
  });

  it("a widening only adds, a narrowing only removes, and each says nothing for the other", async () => {
    serve();
    mount();
    await openForm();
    widen();
    fireEvent.click(within(form()).getByTestId("declare-scope-review"));
    expect(within(form()).getByTestId("declare-scope-removes").textContent).toBe("nothing");
    fireEvent.click(within(form()).getByTestId("declare-scope-change-back"));
    fireEvent.click(item(BACKUP));
    fireEvent.click(item("refund"));
    fireEvent.click(within(form()).getByTestId("declare-scope-review"));
    expect(within(form()).getByTestId("declare-scope-adds").textContent).toBe("nothing");
    expect(within(form()).getByTestId("declare-scope-removes").getAttribute("data-item-count")).toBe("1");
  });

  it("an incident's first revision adds everything it names", async () => {
    serve({ extra: { [ROUTE_PATH.choices]: route.choices.first } });
    mount();
    await openForm();
    expect(within(form()).getAllByTestId("declare-item").filter((one) => (one as HTMLInputElement).checked)).toEqual([]);
    fireEvent.click(item(PRIMARY));
    fireEvent.click(evidenceBox(EVIDENCE_1));
    fireEvent.change(reasonInput(), { target: { value: "what the scan reached" } });
    fireEvent.click(within(form()).getByTestId("declare-scope-review"));
    expect(within(form()).getByTestId("declare-scope-change-heading").textContent).toBe("Revision 1 would be this incident's first scope.");
    expect(within(form()).getByTestId("declare-scope-adds").getAttribute("data-item-count")).toBe("1");
    expect(within(form()).getByTestId("declare-scope-removes").textContent).toBe("nothing");
  });

  it("a revision that changes nothing is not posted, and the form says so", async () => {
    const asked = serve();
    mount();
    await openForm();
    fireEvent.click(evidenceBox(EVIDENCE_1));
    fireEvent.change(reasonInput(), { target: { value: "the same scope, said again" } });
    expect(blocked()).toEqual(["nothing"]);
    expect(within(form()).getByTestId("declare-scope-blocked").textContent).toBe(
      "This revision would change nothing against revision 1: it names exactly the same items. Athena-Backend would refuse it, so it is not sent.",
    );
    // Taken out and put back: still the same items.
    fireEvent.click(item(BACKUP));
    fireEvent.click(item(BACKUP));
    expect(blocked()).toEqual(["nothing"]);
    fireEvent.click(within(form()).getByTestId("declare-scope-review"));
    expect(within(form()).queryByTestId("declare-scope-send")).toBeNull();
    expect(posts(asked)).toEqual([]);
  });
});

describe("a refusal is said by its code, never repeats what was typed, and changes nothing else on screen", () => {
  const cases: Array<[string, RegExp]> = [
    ...REFUSALS.map(([code]) => [code, /Nothing was recorded\.$|Nothing was recorded\. /] as [string, RegExp]),
    ["unknown code", /refused this revision \(it answered 409\) with a code this console does not know: scope_frozen\.$/],
    ["backend 403", /administrator's role on Athena-Backend.*\(it answered 403\)/],
    ["backend 404", /has no such finding for you \(404\)/],
    ["backend 401", /^Not recorded: Athena-Backend does not take your sign-in/],
    ["the reader", /^This console refused to send this revision: declaring a scope takes an administrator's role in this console \(it answered 403\)/],
  ];
  const sentences = new Map<string, string>();

  for (const [name, words] of cases) {
    it(name, async () => {
      expect(route.post[name], name).toBeDefined();
      const asked = serve({ post: route.post[name] });
      mount();
      await openForm();
      widen();
      await send();
      await waitFor(() => expect(said()).not.toBeNull());
      const text = said()!.textContent ?? "";
      expect(text).toMatch(words);
      expect(text).not.toContain(REASON);
      expect(text).not.toContain("refused: ");
      expect(said()!.getAttribute("data-said")).toBe(name === "the reader" || name === "backend 401" ? "not_sent" : "refused");
      if (REFUSALS.some(([code]) => code === name)) expect(said()!.getAttribute("data-code")).toBe(name);
      sentences.set(name, text);
      // Nothing else changed: no read was made again, and the form holds what was picked and typed.
      const at = posts(asked)[0].at;
      expect(asked.slice(at + 1).filter((one) => one.method === "GET")).toEqual([]);
      expect(reasonInput().value).toBe(REASON);
      expect(item(BACKUP).checked).toBe(true);
      expect(evidenceBox(EVIDENCE_2).checked).toBe(true);
      expect(within(card()).getByTestId("incident-scope").getAttribute("data-scope-revision")).toBe("1");
      expect(within(form()).getByTestId("declare-scope-change")).toBeTruthy();
    });
  }

  it("each code is said in a sentence of its own", () => {
    const known = REFUSALS.map(([code]) => sentences.get(code));
    expect(known.every((one) => typeof one === "string")).toBe(true);
    expect(new Set(known).size).toBe(REFUSALS.length);
  });

  it("both spellings of a part left out are said: master's malformed, and #231's items_required, reason_required, evidence_required", () => {
    expect(sentences.get("malformed")).toBe(
      "Athena-Backend refused this revision as malformed: one of its parts is not in the form a scope revision takes, or is missing. Nothing was recorded.",
    );
    expect(sentences.get("items_required")).toContain("or its items were left out");
    expect(sentences.get("reason_required")).toContain("its reason is blank, or was left out");
    expect(sentences.get("evidence_required")).toContain("or its evidence was left out");
  });
});

describe("after a recording, the scope and the recovery record are read again", () => {
  it("reads them again after the 201 and draws what the backend serves now: the widened scope's hold on the accepted step", async () => {
    const asked = serve();
    mount();
    await openForm();
    // Before: revision 1, nothing keeps the accepted step back.
    expect(within(card()).getByTestId("incident-scope").getAttribute("data-scope-revision")).toBe("1");
    expect(within(card()).queryByTestId("step-scope-widened")).toBeNull();
    widen();
    await send();
    await waitFor(() => expect(said()?.getAttribute("data-said")).toBe("recorded"));
    const at = posts(asked)[0].at;
    await waitFor(() => expect(asked.slice(at + 1).map((one) => one.url)).toContain(PAGE_URL));
    // Drawn from the read made after it, as the recovery view draws a widened scope.
    await waitFor(() => expect(within(card()).getByTestId("incident-scope").getAttribute("data-scope-revision")).toBe("2"));
    const widened = within(within(card()).getByTestId("incident-current")).getByTestId("step-scope-widened");
    expect(widened.textContent).toContain("revision 2 added asset");
    expect(widened.textContent).toContain(BACKUP);
    expect(within(within(card()).getByTestId("incident-current")).getByTestId("step-scope-standing").textContent).toBe("Kept back by the scope");
    // The form closed; nothing of the write's answer stands in for a read.
    expect(within(card()).queryByTestId("declare-scope-form")).toBeNull();
    expect(said()!.textContent).toContain("being read again");
  });

  it("an open scope history and the one-incident view are read again too", async () => {
    const asked = serve();
    mount(`/authority/recovery?deployment=${DEP}&finding=${INCIDENT_ID}`);
    await waitFor(() => expect(card()).toBeTruthy());
    fireEvent.click(within(card()).getByTestId("incident-scope-revisions-toggle"));
    await waitFor(() => expect(within(card()).getAllByTestId("scope-revision")).toHaveLength(1));
    await openForm();
    widen();
    await send();
    await waitFor(() => expect(said()?.getAttribute("data-said")).toBe("recorded"));
    const at = posts(asked)[0].at;
    await waitFor(() => expect(asked.slice(at + 1).map((one) => one.url)).toEqual(expect.arrayContaining([ROUTE_PATH.record, ROUTE_PATH.scope])));
    await waitFor(() => expect(within(card()).getAllByTestId("scope-revision")).toHaveLength(2));
    expect(within(card()).getByTestId("scope-current-revision").getAttribute("data-revision")).toBe("2");
  });

  it("an answer that leaves it unknown whether a revision was recorded is said so, and the scope is read again", async () => {
    for (const name of ["backend 500", "no answer"]) {
      const asked = serve({ post: route.post[name] });
      mount();
      await openForm();
      widen();
      await send();
      await waitFor(() => expect(said()?.getAttribute("data-said")).toBe("unknown"));
      expect(said()!.textContent).toMatch(/^Whether Athena-Backend recorded this revision is not known/);
      expect(said()!.textContent).not.toContain(REASON);
      const at = posts(asked)[0].at;
      await waitFor(() => expect(asked.slice(at + 1).map((one) => one.url)).toContain(PAGE_URL));
      cleanup();
    }
  });
});

describe("the fixtures are what the backend serves", () => {
  it("the scope this form starts from is the incident's served revision 1", () => {
    const current = (route.before[ROUTE_PATH.choices].body as { current: unknown }).current;
    expect(current).toEqual({ revision: 1, items: [{ kind: "asset", ref: PRIMARY, assetKind: "gateway" }, { kind: "workflow", ref: "refund", assetKind: null }] });
    expect((SCOPE.declared as { current: number }).current).toBe(1);
    expect(FINDING.declared).toBe(INCIDENT_ID);
  });
});
