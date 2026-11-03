// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import Authority from "@/pages/Authority";
import { acceptanceStanding, gapInWords } from "@/components/authority/RecoveryRecords";
import { getQueryFn, queryClient as appQueryClient } from "@/lib/queryClient";
import { lintMicrocopy } from "@shared/persona-lint";
import type {
  FindingRecoveryRecord,
  RecoveryCoverage,
  RecoveryIncident,
  RecoveryRecords,
  RecoveryStep,
} from "@shared/recovery-record";

/**
 * The recovery screen (/authority/recovery; client/src/components/authority/RecoveryRecords.tsx)
 * over what this console's server maps from Athena-Backend's recovery-record reads
 * (server/assurance.ts recoveryRecords, findingRecoveryRecord; the mapping is pinned by
 * tests/the-recovery-records-are-read-as-the-person-and-never-written.test.ts). The
 * fixtures are synthetic, in the shape athena-backend assurance/recovery_record.py
 * `served` serves (#210 at 7e97884), with invented names.
 *
 *   - every incident with its current step, and its step history oldest first, on demand;
 *   - each step: its S1 state, every condition with its witness, every gap called a gap
 *     and in words, every restriction, its coverage, its release word, and its residual
 *     uncertainty with every source;
 *   - an AUDIT_INCOMPLETE release reads incomplete, with each gap that keeps it so;
 *   - NEVER a "clean" or "recovered" summary, and nothing in the positive tone, for any
 *     fixture -- a fully accepted recovery included, which reads "accepted by <owner>
 *     until <date>" with its conditions beside it;
 *   - an incident with a gap never reads like one without;
 *   - the owner's acceptance exactly as recorded, and lapsed once its end is past;
 *   - a deployment or finding the backend answers 404 for reads "Not found", never empty;
 *   - while not every incident is loaded, how many are shown and how many more exist.
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

const T0 = "2026-11-01T00:00:00.000000Z";
const T1 = "2026-11-02T00:00:00.000000Z";
/** An acceptance end far ahead, and one long past, whatever the clock the suite runs under says. */
const FAR_AHEAD = "2999-01-01T00:00:00+00:00";
const LONG_AGO = "2001-01-01T00:00:00+00:00";

const COMPLETE: RecoveryCoverage = {
  sources: [{ source: "edr", kind: "log", start: T0, end: T1 }],
  declaredGaps: [],
  observedSources: 1, requiredSources: 1, complete: true, missing: {}, unknownInventory: [],
};

const WITH_A_GAP: RecoveryCoverage = {
  sources: [
    { source: "edr", kind: "log", start: T0, end: T1 },
    { source: "proxy-logs", kind: "log", start: T0, end: T1 },
  ],
  declaredGaps: [{ kind: "failed_collector", subject: "edr-west", detail: null, start: null, end: null }],
  observedSources: 1, requiredSources: 2, complete: false,
  missing: { "proxy-logs": [{ start: T0, end: T1 }] }, unknownInventory: [],
};

function step(finding: string, overrides: Partial<RecoveryStep> = {}): RecoveryStep {
  return {
    ref: `${finding}-step-${overrides.version ?? 1}`, version: 1, state: "under_investigation", reopens: null,
    conditions: [{ condition: "incident_recorded", witness: { kind: "finding", ref: finding } }],
    gaps: [], restrictions: [], release: "FAIL", residualUncertainty: [], coverage: COMPLETE,
    acceptedBy: null, acceptedUntil: null, recordedBy: "analyst-a", recordedAt: "2026-11-01T10:00:00+00:00",
    ...overrides,
  };
}

const TESTED = [
  { condition: "repair_agreed", witness: { kind: "repair_contract", ref: "rc-1" } },
  { condition: "repair_tested", witness: { kind: "closure_evidence", ref: "ce-1" } },
];

function incident(finding: string, title: string, steps: RecoveryStep[]): RecoveryIncident {
  const last = steps[steps.length - 1];
  return { finding, title, severity: "high", current: { version: last.version, state: last.state, release: last.release }, steps };
}

/** A recovery the owner accepted, on complete coverage: the fullest record there is. */
const ACCEPTED = incident("f-accepted", "Refund agent wrote outside its approval", [
  step("f-accepted", { version: 1 }),
  step("f-accepted", { version: 2, state: "repair_proposed", conditions: [step("f-accepted").conditions![0], TESTED[0]] }),
  step("f-accepted", { version: 3, state: "repair_tested", conditions: [step("f-accepted").conditions![0], ...TESTED] }),
  step("f-accepted", {
    version: 4, state: "recovery_accepted", release: "PASS",
    conditions: [step("f-accepted").conditions![0], ...TESTED, { condition: "owner_accepted", witness: { kind: "owner", ref: "user:7" } }],
    acceptedBy: "owner-a", acceptedUntil: FAR_AHEAD, recordedBy: "owner-a",
  }),
]);

/** A tested repair the owner accepted, held back by two coverage gaps: AUDIT_INCOMPLETE. */
const HELD = incident("f-held", "Ledger tool kept a stale token", [
  step("f-held", { version: 1, coverage: WITH_A_GAP, acceptedBy: "owner-a", acceptedUntil: FAR_AHEAD }),
  step("f-held", {
    version: 2, state: "repair_tested", release: "AUDIT_INCOMPLETE", coverage: WITH_A_GAP,
    conditions: [step("f-held").conditions![0], ...TESTED],
    gaps: ["coverage:failed_collector:edr-west", "coverage:missing:proxy-logs"],
    residualUncertainty: [
      { statement: "coverage:failed_collector:edr-west", sources: [{ kind: "coverage", ref: "finding:f-held" }] },
      { statement: "coverage:missing:proxy-logs", sources: [{ kind: "coverage", ref: "finding:f-held" }] },
    ],
    acceptedBy: "owner-a", acceptedUntil: FAR_AHEAD,
  }),
]);

/** An accepted recovery whose acceptance ended long ago. */
const LAPSED = incident("f-lapsed", "Support agent exported a ticket queue", [
  step("f-lapsed", {
    version: 1, state: "recovery_accepted", release: "PASS",
    conditions: [step("f-lapsed").conditions![0], ...TESTED, { condition: "owner_accepted", witness: { kind: "owner", ref: "user:9" } }],
    acceptedBy: "owner-b", acceptedUntil: LONG_AGO,
  }),
]);

/** An effect that did not take, and two things nobody can yet say, each with its sources. */
const INCOMPLETE = incident("f-incomplete", "Token revoke did not reach the mail relay", [
  step("f-incomplete", {
    version: 1, state: "recovery_incomplete",
    conditions: [
      step("f-incomplete").conditions![0],
      { condition: "effect_not_applied", witness: { kind: "receipt", ref: "rcpt-9" } },
    ],
    gaps: ["effect_not_applied:receipt:rcpt-9"],
    residualUncertainty: [
      { statement: "Which hosts still accept the old token?", sources: [{ kind: "unknown", ref: "unk-1" }, { kind: "evidence", ref: "ev-2" }] },
      { statement: "effect_unknown", sources: [{ kind: "receipt", ref: "rcpt-8" }, { kind: "permit", ref: "gate-3" }] },
    ],
  }),
]);

/** A restore with its restriction. */
const RESTRICTED = incident("f-restricted", "Payments tool restored behind a cap", [
  step("f-restricted", {
    version: 1, state: "restored_with_restrictions",
    conditions: [step("f-restricted").conditions![0], ...TESTED, { condition: "effect_read_back", witness: { kind: "receipt", ref: "rcpt-1" } }],
    restrictions: ["Refunds above 50 EUR stay disabled"],
  }),
]);

const FIXTURES = [ACCEPTED, HELD, LAPSED, INCOMPLETE, RESTRICTED];

function page(deployment: string, incidents: RecoveryIncident[], overrides: Partial<RecoveryRecords> = {}): RecoveryRecords {
  return {
    deployment, incidents, incidentCount: incidents.length, returned: incidents.length, truncated: false, pageSize: 50, offset: 0,
    ...overrides,
  };
}

const STATUS = { configured: true, reachable: true, authorized: true, url: "https://backend.invalid", detail: "ok" };
const DEPLOYMENTS = [
  { uuid: "dep-1", name: "harbor-desk", environment: "production", decision: "audit_incomplete", decisionLabel: "Audit incomplete" },
  { uuid: "dep-2", name: "quay-assistant", environment: "staging", decision: null, decisionLabel: "" },
];
const BASE = { "/api/assurance/status": STATUS, "/api/assurance/deployments": DEPLOYMENTS };
const RECORDS = (deployment: string, offset = 0) => `/api/assurance/deployments/${deployment}/recovery-records?offset=${offset}`;
const FINDING = (finding: string) => `/api/assurance/findings/${finding}/recovery-record`;

/** The 404 this console's server answers when the backend answers not found (server/routes.ts assuranceUnavailable). */
const NOT_FOUND = { status: 404, body: { error: "the Athena control plane answered 404: {\"detail\":\"No Deployment matches the given query.\"}", code: "not_found" } };

type Answer = unknown | { status: number; body: unknown };

/** A fetch that answers as this console's server would, recording each call; a URL not listed never answers. */
function serve(answers: Record<string, Answer>) {
  const requested: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requested.push({ url: String(url), method: init?.method ?? "GET" });
    if (!(String(url) in answers)) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    const answer = answers[String(url)] as { status?: unknown; body?: unknown };
    const coded = answer && typeof answer === "object" && typeof answer.status === "number" && "body" in answer;
    return new Response(JSON.stringify(coded ? answer.body : answer), {
      status: coded ? (answer.status as number) : 200, headers: { "Content-Type": "application/json" },
    });
  }));
  return requested;
}

function mount(path: string) {
  const location = memoryLocation({ path, record: true });
  // The app's own query defaults, keepPreviousData included.
  const client = new QueryClient({
    defaultOptions: { ...appQueryClient.getDefaultOptions(), queries: { ...appQueryClient.getDefaultOptions().queries, queryFn: getQueryFn({ on401: "throw" }) } },
  });
  render(
    <QueryClientProvider client={client}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <Authority params={{ screen: path.split("?")[0].split("/")[2] }} />
      </Router>
    </QueryClientProvider>,
  );
  return location;
}

const incidentCard = (finding: string) => document.querySelector(`[data-testid="incident"][data-incident="${finding}"]`) as HTMLElement;
const current = (finding: string) => within(incidentCard(finding)).getByTestId("incident-current");

async function mountAll() {
  serve({ ...BASE, [RECORDS("dep-1")]: page("dep-1", FIXTURES) });
  mount("/authority/recovery?deployment=dep-1");
  await waitFor(() => expect(document.querySelectorAll('[data-testid="incident"]').length).toBe(FIXTURES.length));
}

describe("each incident, with every state and what supports it", () => {
  it("shows each incident's current step: its S1 state, every condition with its witness, and the step history oldest first", async () => {
    await mountAll();
    expect(screen.getByTestId("authority-tab-recovery").textContent).toBe("Recovery records");
    const now = within(current("f-accepted"));
    expect(now.getByTestId("step-state").textContent).toBe("recovery_accepted");
    const conditions = Array.from(now.getByTestId("step-conditions").querySelectorAll("[data-condition]"));
    expect(conditions.map((one) => one.getAttribute("data-condition"))).toEqual([
      "incident_recorded", "repair_agreed", "repair_tested", "owner_accepted",
    ]);
    expect(conditions.map((one) => one.textContent)).toEqual([
      "incident_recordedwitnessfinding f-accepted",
      "repair_agreedwitnessrepair_contract rc-1",
      "repair_testedwitnessclosure_evidence ce-1",
      "owner_acceptedwitnessowner user:7",
    ]);
    // Nothing of the history is read out until it is opened; then every step, oldest first.
    expect(within(incidentCard("f-accepted")).queryAllByTestId("history-step")).toEqual([]);
    fireEvent.click(within(incidentCard("f-accepted")).getByTestId("incident-steps-toggle"));
    const history = within(incidentCard("f-accepted")).getAllByTestId("history-step");
    expect(history.map((one) => within(one).getByTestId("step-state").textContent)).toEqual([
      "under_investigation", "repair_proposed", "repair_tested", "recovery_accepted",
    ]);
    expect(within(incidentCard("f-accepted")).getByTestId("incident-steps-toggle").textContent).toBe(
      "Hide the 4 recorded steps, oldest first",
    );
  });

  it("shows a gap as a gap, in words, each one named, and an AUDIT_INCOMPLETE release as incomplete", async () => {
    await mountAll();
    const held = within(current("f-held"));
    const release = held.getByTestId("step-release");
    expect(release.getAttribute("data-release")).toBe("AUDIT_INCOMPLETE");
    expect(release.textContent).toBe("Release: audit incomplete");
    expect(within(release).getByText("Release: audit incomplete").closest("[data-tone]")?.getAttribute("data-tone")).toBe("caution");
    const gaps = held.getByTestId("step-gaps");
    expect(gaps.getAttribute("data-gap-count")).toBe("2");
    expect(gaps.textContent).toContain("2 gaps recorded on this step -- these keep its release incomplete");
    expect(Array.from(gaps.querySelectorAll("[data-gap]")).map((one) => one.getAttribute("data-gap"))).toEqual([
      "coverage:failed_collector:edr-west", "coverage:missing:proxy-logs",
    ]);
    expect(within(gaps).getAllByTestId("gap-words").map((one) => one.textContent)).toEqual([
      "Coverage gap: failed collector, at edr-west",
      "Coverage gap: proxy-logs was not observed over all of the interval it is required for",
    ]);
    // The coverage it rests on says so too: incomplete, the declared gap and the source not observed.
    expect(held.getByTestId("coverage-standing").textContent).toBe("Coverage incomplete");
    expect(held.getByTestId("step-coverage").textContent).toContain("observed 1 of 2 required sources");
    expect(held.getByTestId("coverage-declared-gap").textContent).toBe("Declared coverage gap: failed collector, at edr-west");
    expect(held.getByTestId("coverage-missing").textContent).toBe(`Not observed: proxy-logs from ${T0} to ${T1}`);
    // The owner's acceptance is shown as recorded, beside a state the gap keeps short of accepted.
    expect(held.getByTestId("step-state").textContent).toBe("repair_tested");
    expect(held.getByTestId("acceptance-words").textContent).toBe(`accepted by owner-a until ${FAR_AHEAD}`);
  });

  it("names every other kind of gap in words, and a restriction as a restriction", async () => {
    await mountAll();
    expect(within(current("f-incomplete")).getByTestId("gap-words").textContent).toBe("Gap: the effect receipt rcpt-9 reads back was not applied");
    expect(within(current("f-incomplete")).getByTestId("step-release").textContent).toBe("Release: not allowed on this step");
    expect(within(current("f-restricted")).getByTestId("step-restrictions").textContent).toBe("Restriction: Refunds above 50 EUR stay disabled");
    expect(gapInWords("coverage:unknown_inventory:badge-readers")).toBe("Coverage gap: what badge-readers covers is not known (unknown inventory)");
    expect(gapInWords("coverage:no_required_source")).toBe(
      "Coverage gap: no required source is declared, so nothing is known to have been observed",
    );
    expect(gapInWords("modem on the backup line not in scope")).toBe("Gap: modem on the backup line not in scope");
  });

  it("shows every source of every residual uncertainty", async () => {
    await mountAll();
    const items = within(current("f-incomplete")).getByTestId("step-uncertainty");
    expect(items.getAttribute("data-uncertainty-count")).toBe("2");
    const rows = Array.from(items.querySelectorAll("[data-uncertainty]")) as HTMLElement[];
    expect(rows.map((one) => within(one).getByTestId("uncertainty-words").textContent)).toEqual([
      "Which hosts still accept the old token?", "Whether the effect took is not known",
    ]);
    expect(rows.map((one) => Array.from(one.querySelectorAll("[data-source]")).map((s) => s.getAttribute("data-source")))).toEqual([
      ["unknown:unk-1", "evidence:ev-2"],
      ["receipt:rcpt-8", "permit:gate-3"],
    ]);
    expect(rows.map((one) => within(one).getByTestId("uncertainty-sources").textContent)).toEqual([
      "Sources: unknown unk-1; evidence ev-2",
      "Sources: receipt rcpt-8; permit gate-3",
    ]);
    // The coverage gaps a held step carries are its residual uncertainty too, each with its source.
    const held = within(current("f-held")).getByTestId("step-uncertainty");
    expect(within(held).getAllByTestId("uncertainty-sources").map((one) => one.textContent)).toEqual([
      "Source: coverage finding:f-held", "Source: coverage finding:f-held",
    ]);
  });
});

describe("never a single clean badge", () => {
  /** Words a summary verdict would use. None is on the screen, for any fixture. */
  const SUMMARY = /\b(?:clean|recovered|all[\s-]clear|resolved|fixed|healthy|secure|safe|no issues|pass|passed|passing|ok)\b/i;

  /** Every piece of text under `root`, one text node each: run together, two words could hide a word boundary. */
  const texts = (root: Node): string[] => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const found: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (text) found.push(text);
    }
    return found;
  };

  it("draws no clean or recovered summary, and nothing positive, for any fixture -- the fully accepted one included", async () => {
    await mountAll();
    // Every step of every incident opened, so the whole record is on screen.
    for (const one of FIXTURES) fireEvent.click(within(incidentCard(one.finding!)).getByTestId("incident-steps-toggle"));
    const section = screen.getByTestId("recovery-section");
    expect(section.querySelectorAll('[data-testid="history-step"]').length).toBe(FIXTURES.reduce((n, one) => n + one.steps.length, 0));
    for (const one of FIXTURES) {
      const card = incidentCard(one.finding!);
      expect(texts(card).filter((text) => SUMMARY.test(text)), one.finding!).toEqual([]);
      expect(card.querySelectorAll('[data-tone="positive"]').length, one.finding!).toBe(0);
      expect(card.innerHTML, one.finding!).not.toMatch(/emerald|green/);
    }
    // Nor anywhere on the page, and every word on it -- the server's answers included -- lints clean.
    expect(document.querySelectorAll('[data-tone="positive"]').length).toBe(0);
    expect(texts(section).filter((text) => SUMMARY.test(text))).toEqual([]);
    expect(texts(document.body).filter((text) => lintMicrocopy(text).length > 0)).toEqual([]);
  });

  it("reads a fully accepted recovery as accepted by its owner until its end, with its conditions beside it", async () => {
    await mountAll();
    const now = within(current("f-accepted"));
    expect(now.getByTestId("step-state").textContent).toBe("recovery_accepted");
    expect(now.getByTestId("step-acceptance").getAttribute("data-acceptance")).toBe("in_force");
    expect(now.getByTestId("acceptance-words").textContent).toBe(`accepted by owner-a until ${FAR_AHEAD}`);
    expect(now.getByTestId("acceptance-in-force").textContent).toBe("in force until its end");
    expect(now.getByTestId("step-conditions").textContent).toContain("owner_acceptedwitnessowner user:7");
    // Its release is the step's word, in neutral words, never a badge for the incident.
    expect(now.getByTestId("step-release").textContent).toBe("Release: allowed on this step");
    expect(now.getByTestId("step-release").querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("neutral");
  });

  it("never lets an incident with a gap read like one without", async () => {
    await mountAll();
    const withGap = current("f-held");
    const without = current("f-accepted");
    expect(within(withGap).getByTestId("step-gaps").getAttribute("data-gap-count")).toBe("2");
    expect(within(without).getByTestId("step-gaps").getAttribute("data-gap-count")).toBe("0");
    expect(within(without).getByTestId("step-gaps").textContent).toBe("No gap is recorded on this step.");
    expect(within(withGap).getByTestId("coverage-standing").textContent).toBe("Coverage incomplete");
    expect(within(without).getByTestId("coverage-standing").textContent).toBe("Coverage complete");
    expect(within(withGap).getByTestId("step-release").textContent).not.toBe(within(without).getByTestId("step-release").textContent);
    // Every gap the record names is on the incident's own card, in words, whatever else is shown.
    for (const one of FIXTURES) {
      const gaps = one.steps[one.steps.length - 1].gaps ?? [];
      const words = within(current(one.finding!)).queryAllByTestId("gap-words").map((g) => g.textContent);
      expect(words, one.finding!).toEqual(gaps.map(gapInWords));
    }
  });

  it("says a field the backend did not serve was not served -- never no gaps, no conditions or no uncertainty", async () => {
    const unserved = incident("f-unserved", "Partial answer", [
      step("f-unserved", { gaps: null, conditions: null, residualUncertainty: null, restrictions: null, coverage: null }),
    ]);
    serve({ ...BASE, [RECORDS("dep-1")]: page("dep-1", [unserved]) });
    mount("/authority/recovery?deployment=dep-1");
    await waitFor(() => expect(incidentCard("f-unserved")).toBeTruthy());
    const now = within(current("f-unserved"));
    expect(now.getByTestId("step-gaps-not-served").textContent).toBe("The gaps were not served, so whether this step has one is not known.");
    expect(now.getByTestId("step-conditions-not-served").textContent).toBe("The conditions were not served.");
    expect(now.getByTestId("step-uncertainty-not-served").textContent).toBe("The residual uncertainty was not served.");
    expect(now.getByTestId("step-coverage-not-served").textContent).toBe("The coverage this step rests on was not served.");
    expect(now.queryByTestId("step-gaps")).toBeNull();
  });
});

describe("the owner's acceptance, exactly as recorded", () => {
  it("reads an acceptance whose end is past as lapsed, never as in force", async () => {
    await mountAll();
    const lapsed = within(current("f-lapsed"));
    expect(lapsed.getByTestId("step-acceptance").getAttribute("data-acceptance")).toBe("lapsed");
    expect(lapsed.getByTestId("acceptance-words").textContent).toBe(`accepted by owner-b until ${LONG_AGO}`);
    expect(lapsed.getByTestId("acceptance-lapsed").textContent).toBe("Lapsed: its end is in the past");
    expect(lapsed.getByTestId("acceptance-lapsed").getAttribute("data-tone")).toBe("caution");
    expect(lapsed.queryByTestId("acceptance-in-force")).toBeNull();
  });

  it("is in force before its end and lapsed from it, and a date it cannot read is said so", () => {
    const end = Date.parse("2026-11-03T12:00:00Z");
    expect(acceptanceStanding("2026-11-03T12:00:00Z", end - 1)).toBe("in_force");
    expect(acceptanceStanding("2026-11-03T12:00:00Z", end)).toBe("lapsed");
    expect(acceptanceStanding("2026-11-03T12:00:00Z", end + 1)).toBe("lapsed");
    expect(acceptanceStanding("next week", end)).toBe("unreadable");
    expect(acceptanceStanding(null, end)).toBe("unreadable");
  });

  it("shows no acceptance where none is recorded, and offers none: nothing on the screen writes or accepts", async () => {
    const requested = serve({ ...BASE, [RECORDS("dep-1")]: page("dep-1", FIXTURES) });
    mount("/authority/recovery?deployment=dep-1");
    await waitFor(() => expect(document.querySelectorAll('[data-testid="incident"]').length).toBe(FIXTURES.length));
    expect(within(current("f-restricted")).getByTestId("step-acceptance").getAttribute("data-acceptance")).toBe("none");
    expect(within(current("f-restricted")).getByTestId("step-acceptance").textContent).toBe("No owner's acceptance is recorded on this step.");
    const buttons = Array.from(screen.getByTestId("recovery-section").querySelectorAll("button")).map((one) => one.textContent ?? "");
    expect(buttons.filter((one) => !/^(?:Show|Hide) the \d+ recorded steps?, oldest first$/.test(one))).toEqual([]);
    expect(screen.getByTestId("recovery-section").querySelectorAll("input, textarea, form").length).toBe(0);
    expect(requested.filter((one) => one.method !== "GET")).toEqual([]);
  });
});

describe("not found is not found, never empty", () => {
  it("reads a deployment the backend answers 404 for as not found, never as an empty record", async () => {
    serve({ ...BASE, [RECORDS("dep-1")]: NOT_FOUND });
    mount("/authority/recovery?deployment=dep-1");
    await waitFor(() => expect(screen.getByTestId("recovery-not-found")).toBeTruthy());
    expect(screen.getByTestId("recovery-not-found").getAttribute("data-not-found")).toBe("deployment");
    expect(screen.getByTestId("recovery-not-found").textContent).toContain("Not found.");
    expect(screen.getByTestId("recovery-not-found").textContent).toContain("This is not an empty record");
    expect(screen.queryByTestId("recovery-empty")).toBeNull();
    expect(screen.queryByTestId("recovery-footer")).toBeNull();
    expect(document.querySelectorAll('[data-testid="incident"]').length).toBe(0);
  });

  it("reads a deployment with no recovery record as empty, and never as not found", async () => {
    serve({ ...BASE, [RECORDS("dep-1")]: page("dep-1", []) });
    mount("/authority/recovery?deployment=dep-1");
    await waitFor(() => expect(screen.getByTestId("recovery-empty")).toBeTruthy());
    expect(screen.getByTestId("recovery-empty").textContent).toContain("records no recovery record for any finding of this deployment");
    expect(screen.queryByTestId("recovery-not-found")).toBeNull();
    expect(screen.getByTestId("recovery-shown").textContent).toBe("Showing 0 of 0 incidents.");
  });

  it("reads a finding the backend answers 404 for as not found", async () => {
    serve({ ...BASE, [FINDING("f-hidden")]: NOT_FOUND });
    mount("/authority/recovery?deployment=dep-1&finding=f-hidden");
    await waitFor(() => expect(screen.getByTestId("recovery-not-found")).toBeTruthy());
    expect(screen.getByTestId("recovery-not-found").getAttribute("data-not-found")).toBe("finding");
    expect(screen.queryByTestId("recovery-empty")).toBeNull();
  });

  it("reads one incident by its finding, and never draws one the backend answered for another deployment", async () => {
    const own: FindingRecoveryRecord = { deployment: "dep-1", ...HELD };
    const requested = serve({ ...BASE, [FINDING("f-held")]: own, [FINDING("f-elsewhere")]: { deployment: "dep-9", ...ACCEPTED } });
    mount("/authority/recovery?deployment=dep-1&finding=f-held");
    await waitFor(() => expect(incidentCard("f-held")).toBeTruthy());
    expect(within(current("f-held")).getByTestId("step-release").textContent).toBe("Release: audit incomplete");
    expect(screen.queryByTestId("incident-alone")).toBeNull();
    expect(requested.map((one) => one.url)).not.toContain(RECORDS("dep-1"));
    cleanup();
    mount("/authority/recovery?deployment=dep-1&finding=f-elsewhere");
    await waitFor(() => expect(screen.getByTestId("recovery-other-deployment")).toBeTruthy());
    expect(document.querySelectorAll('[data-testid="incident"]').length).toBe(0);
  });

  it("reads nothing for a finding id that would walk the read onto another route", async () => {
    for (const crafted of ["../../kill-switch", "f-1/../../users", "f-1?x=1"]) {
      const requested = serve({ ...BASE, [RECORDS("dep-1")]: page("dep-1", []) });
      mount(`/authority/recovery?deployment=dep-1&finding=${encodeURIComponent(crafted)}`);
      await waitFor(() => expect(screen.getByTestId("finding-id-refused")).toBeTruthy());
      expect(requested.map((one) => one.url).filter((url) => url.includes("/findings/"))).toEqual([]);
      cleanup();
    }
  });
});

describe("paging names what is not loaded", () => {
  const all = Array.from({ length: 120 }, (_, i) =>
    incident(`f-${String(i + 1).padStart(3, "0")}`, `Incident ${i + 1}`, [step(`f-${i + 1}`)]),
  );
  const slice = (offset: number) =>
    page("dep-1", all.slice(offset, offset + 50), {
      incidentCount: 120, returned: Math.min(50, 120 - offset), truncated: offset + 50 < 120, offset,
    });
  const shownIds = () => Array.from(document.querySelectorAll('[data-testid="incident"]')).map((one) => one.getAttribute("data-incident"));

  it("says how many are shown and how many more are recorded, and reads on from offset + returned until there is no more", async () => {
    const requested = serve({ ...BASE, [RECORDS("dep-1", 0)]: slice(0), [RECORDS("dep-1", 50)]: slice(50), [RECORDS("dep-1", 100)]: slice(100) });
    mount("/authority/recovery?deployment=dep-1");
    await waitFor(() => expect(shownIds().length).toBe(50));
    expect(screen.getByTestId("recovery-shown").textContent).toBe("Showing 50 of 120 incidents.");
    expect(screen.getByTestId("recovery-not-loaded").textContent).toBe("70 more are recorded and not loaded.");
    fireEvent.click(screen.getByTestId("recovery-load-more"));
    await waitFor(() => expect(shownIds().length).toBe(100));
    expect(screen.getAllByTestId("recovery-footer")).toHaveLength(1);
    expect(screen.getByTestId("recovery-shown").textContent).toBe("Showing 100 of 120 incidents.");
    expect(screen.getByTestId("recovery-not-loaded").textContent).toBe("20 more are recorded and not loaded.");
    fireEvent.click(screen.getByTestId("recovery-load-more"));
    await waitFor(() => expect(shownIds().length).toBe(120));
    expect(screen.getByTestId("recovery-shown").textContent).toBe("Showing 120 of 120 incidents.");
    expect(screen.queryByTestId("recovery-not-loaded")).toBeNull();
    expect(screen.queryByTestId("recovery-load-more")).toBeNull();
    expect(shownIds()).toEqual(all.map((one) => one.finding));
    expect(requested.map((one) => one.url).filter((url) => url.includes("recovery-records"))).toEqual([
      RECORDS("dep-1", 0), RECORDS("dep-1", 50), RECORDS("dep-1", 100),
    ]);
  });

  it("says when the backend did not say how many there are, or whether there are more, or where the next page starts", async () => {
    serve({ ...BASE, [RECORDS("dep-1")]: page("dep-1", all.slice(0, 3), { incidentCount: null, truncated: null, returned: 3 }) });
    mount("/authority/recovery?deployment=dep-1");
    await waitFor(() => expect(shownIds().length).toBe(3));
    expect(screen.getByTestId("recovery-shown").textContent).toBe("Showing 3 incidents; how many are recorded was not said.");
    expect(screen.getByTestId("recovery-truncation-not-said").textContent).toBe("Whether more are recorded was not said.");
    expect(screen.queryByTestId("recovery-load-more")).toBeNull();
    cleanup();

    serve({ ...BASE, [RECORDS("dep-1")]: page("dep-1", all.slice(0, 3), { incidentCount: 9, truncated: true, returned: null }) });
    mount("/authority/recovery?deployment=dep-1");
    await waitFor(() => expect(shownIds().length).toBe(3));
    expect(screen.getByTestId("recovery-not-loaded").textContent).toBe("6 more are recorded and not loaded.");
    expect(screen.getByTestId("recovery-no-next").textContent).toBe(
      "More are recorded than shown, and this page does not say where the next one starts.",
    );
  });

  it("never draws a page the backend answered for another deployment", async () => {
    serve({ ...BASE, [RECORDS("dep-1")]: page("dep-2", FIXTURES) });
    mount("/authority/recovery?deployment=dep-1");
    await waitFor(() => expect(screen.getByTestId("recovery-other-deployment")).toBeTruthy());
    expect(shownIds()).toEqual([]);
  });
});
