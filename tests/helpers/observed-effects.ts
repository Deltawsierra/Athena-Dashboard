/**
 * Athena-Backend's answers for the observed-effect view, in its own wire shapes
 * (Athena-Backend #234: assurance/observed_effects.py `shown`, assurance/serializers.py
 * `effect_reading`, assurance/authority_chain_records.py `chain_payload`,
 * assurance/effect_reconciliation.py `served`), one deployment per kind of answer.
 * Every name is invented; every keyed value is a made-up 64 hex, listed in KEYED so a
 * test can say none of them reaches this console's answer or its screen.
 *
 * The words are the core's, as the backend serves them (mythos_core.observed_effect):
 * "keyed: not checkable here", "plain digests", "plain digests: withheld from this
 * reader", "accepted, as signed", "accepted, from the recorded 2xx; this version has no
 * execution field", "within its bound", "no bound recorded", "no tool binding recorded".
 */
import { EXECUTION_STATES } from "@shared/observed-effect";

export const DEP = "dep-effects";
export const DEP_OLDER = "dep-effects-older";
export const DEP_EMPTY = "dep-effects-none";
export const DEP_HOSTILE = "dep-effects-hostile";
export const DEP_STATES = "dep-effects-states";
export const DEP_NO_LIST = "dep-effects-no-list";
export const DEP_NOT_A_LIST = "dep-effects-not-a-list";

export const ROUTE = (dep: string) => `/api/assurance/deployments/${dep}/chain-outcomes`;
export const CHAINS_ROUTE = (dep: string) => `/api/assurance/deployments/${dep}/authority-chains`;
const BACKEND = (dep: string) => `/api/assurance/deployments/${dep}/chain-outcomes/`;
const CHAINS_BACKEND = (dep: string) => `/api/assurance/deployments/${dep}/authority-chains/`;

/** The core's words. */
export const WORDS = {
  keyed: "keyed: not checkable here",
  plain: "plain digests",
  withheld: "plain digests: withheld from this reader",
  asSigned: "accepted, as signed",
  noExecutionField: "accepted, from the recorded 2xx; this version has no execution field",
  within: "within its bound",
  noBound: "no bound recorded",
  noBinding: "no tool binding recorded",
} as const;

/** Every keyed value served below: none may reach this console's answer or its screen. */
export const KEYED = {
  action: "a1".repeat(32),
  response: "b2".repeat(32),
  targets: "c3".repeat(32),
  generation: "d4".repeat(32),
  approvalTargets: "e5".repeat(32),
  windowedTargets: "f6".repeat(32),
} as const;
const ref = (hex: string) => `hmac-sha256:${hex}`;

/** The id of the chain key: an id, which holds nothing of the key, and is shown. */
export const CHAIN_KEY = "5e1f0c2a9b7d3e41";
export const APPROVAL_OPEN = `sha256:${"1a".repeat(32)}`;
export const APPROVAL_WINDOWED = `sha256:${"2b".repeat(32)}`;
export const PERMIT_DIGEST = `sha256:${"3c".repeat(32)}`;

/** The backend's sentence for the finding (assurance/observed_effects.py binding_findings). */
export const overBoundDetail = (bound: number, limit: number, approval: string) =>
  `the tool binding's bound is ${bound} targets, larger than the bound of ${limit} that approval ${approval} names: the record is kept as evidence of what was dispatched, and its binding is not within that approval's bound`;

export function binding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "mcp_server",
    identifier: "fleet-tools",
    generation: ref(KEYED.generation),
    effect: "destructive",
    target_count: 3,
    max_targets: 3,
    targets_ref: ref(KEYED.targets),
    approvals: [
      {
        approval: APPROVAL_OPEN, effect: "destructive", target_count: 3, max_targets: null, window_s: null,
        targets_ref: ref(KEYED.approvalTargets), counted: null,
      },
      {
        approval: APPROVAL_WINDOWED, effect: "destructive", target_count: 40, max_targets: 25, window_s: 3600,
        targets_ref: ref(KEYED.windowedTargets), counted: { counted: 3, rested: false, window_count: 23, lifetime_count: 31 },
      },
    ],
    ...over,
  };
}

/** A version 5 record's reading. */
export function v5(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "mythos.observed-effect/v5",
    digests: WORDS.keyed,
    digests_served: WORDS.keyed,
    action_reference: ref(KEYED.action),
    response_reference: ref(KEYED.response),
    keyed_under: { chain: "v2", chain_key: CHAIN_KEY },
    execution: { state: "accepted", basis: "observed", words: WORDS.asSigned },
    tool_binding: binding(),
    tool_binding_reading: WORDS.within,
    findings: [],
    ...over,
  };
}

/** A version 1 to 4 record's reading: the same for each, but for its schema. */
export function older(version: number): Record<string, unknown> {
  return {
    schema: `mythos.observed-effect/v${version}`,
    digests: WORDS.plain,
    digests_served: WORDS.withheld,
    action_reference: "withheld:plain-digest",
    response_reference: "withheld:plain-digest",
    keyed_under: null,
    execution: { state: "accepted", basis: "inferred", words: WORDS.noExecutionField },
    tool_binding: null,
    tool_binding_reading: WORDS.noBinding,
    findings: [],
  };
}

/** One chain outcome row, as WorkflowChainOutcomeSerializer serves it. `reading` undefined: the key is left out (a backend before #234). */
export function outcomeRow(id: string, reading: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: `row-${id}`, workflow: "fleet-wipe", status: "held", status_label: "Held", basis: "demonstrated",
    basis_label: "Demonstrated", basis_in_force: "demonstrated", evidence_kind: "observed_effect",
    evidence_kind_label: "Observed effect", route: "current", observed_at: "2026-11-16T12:00:00.123456+00:00",
    recorded_at: "2026-11-16T12:01:00+00:00", source: "achilles", note: "", signed: true, outcome_id: id,
    observer_engine: "achilles-effect", observer_key_id: "sha256:0f0f0f0f", evidence_digest: `sha256:${"9e".repeat(32)}`,
    approval_recipients: [],
    ...(reading === undefined ? {} : { effect_reading: reading }),
    ...over,
  };
}

/** The binding's bound raised over the windowed approval's own: the backend's finding. */
export const OVER = { bound: 30, limit: 25 };
const overReading = v5({
  tool_binding: binding({ max_targets: OVER.bound, target_count: 4 }),
  findings: [
    {
      code: "binding_bound_over_approval", approval: APPROVAL_WINDOWED,
      binding_max_targets: OVER.bound, approval_max_targets: OVER.limit, detail: overBoundDetail(OVER.bound, OVER.limit, APPROVAL_WINDOWED),
    },
  ],
});

/** A reading the backend served in part, and in shapes that cannot be read. */
const partialReading = {
  schema: "mythos.observed-effect/v5",
  digests: WORDS.keyed,
  // digests_served, response_reference and tool_binding_reading are not served.
  action_reference: 7,
  keyed_under: { chain: 2, chain_key: CHAIN_KEY },
  execution: "accepted",
  tool_binding: binding({
    target_count: "three",
    approvals: [
      { approval: APPROVAL_OPEN, effect: "destructive", target_count: 3, targets_ref: ref(KEYED.approvalTargets) },
      null, 7, "an approval", [APPROVAL_WINDOWED],
    ],
  }),
  findings: [null, "a finding", 4],
};

/** Rows that cannot be read, among good ones. */
export const BAD_ROWS = [null, 7, "a row that could not be read", ["row"]];

export const OUTCOMES = {
  outcomes: [
    outcomeRow("oe-v5", v5()),
    outcomeRow("oe-over", overReading),
    outcomeRow("oe-unbound", v5({ tool_binding: null, tool_binding_reading: WORDS.noBound })),
    ...[1, 2, 3, 4].map((version) => outcomeRow(`oe-v${version}`, older(version))),
    outcomeRow("oe-none", null),
    outcomeRow("oe-odd", "a reading that is not one"),
    outcomeRow("oe-partial", partialReading),
    outcomeRow("oe-withheld", v5({ action_reference: "withheld:chain-key-unkept", response_reference: `sha256:${"77".repeat(32)}` })),
    // The gate's own decision: not an observed effect, and no reading.
    outcomeRow("gate-1", null, { evidence_kind: "authorization_check", evidence_kind_label: "Authorization check", observer_engine: "achilles" }),
    ...BAD_ROWS,
  ],
  returned: 16, truncated: true, page_size: 100, recorded_count: 340,
  composition: { signal: null },
};

/** A backend from before #234: rows carry no `effect_reading`; one does not say its kind either. */
export const OLDER_OUTCOMES = {
  outcomes: [
    outcomeRow("old-1", undefined),
    outcomeRow("old-2", undefined),
    outcomeRow("old-3", undefined, { evidence_kind: undefined, evidence_kind_label: undefined }),
  ].map((row) => JSON.parse(JSON.stringify(row))),
  returned: 3, truncated: false, page_size: 100, recorded_count: 3,
};

/** Every execution state of the core's, and one it does not have. */
export const ODD_STATE = "mostly_done";
export const STATES_OUTCOMES = {
  outcomes: [...EXECUTION_STATES, ODD_STATE].map((state) =>
    outcomeRow(`state-${state}`, v5({ execution: { state, basis: state === "accepted" ? "observed" : "inferred", words: `${state}: in the words served` } }))),
  returned: EXECUTION_STATES.length + 1, truncated: false, page_size: 100, recorded_count: EXECUTION_STATES.length + 1,
};

/** The strings a hostile record plants: markup, and characters that hide or reorder text. */
export const MARKUP = `<script>window.__planted = "effect"</script><img src=x onerror="window.__planted = 'img'"><a href="javascript:window.__planted = 1">open</a>`;
export const HIDDEN = "‮gnp.exe‬ ​‍";
export const hostileText = (where: string) => `${where} ${MARKUP} ${HIDDEN}`;

export const HOSTILE_OUTCOMES = {
  outcomes: [
    outcomeRow("oe-hostile", v5({
      tool_binding: binding({
        identifier: hostileText("tool"),
        effect: hostileText("effect"),
        approvals: [{
          approval: hostileText("approval"), effect: "destructive", target_count: 3, max_targets: 2, window_s: 60,
          targets_ref: ref(KEYED.approvalTargets), counted: null,
        }],
      }),
      execution: { state: "accepted", basis: "observed", words: hostileText("words") },
      findings: [{
        code: "binding_bound_over_approval", approval: hostileText("approval"), binding_max_targets: 3, approval_max_targets: 2,
        detail: hostileText("finding"),
      }],
    }), { workflow: hostileText("workflow"), observer_engine: hostileText("engine") }),
  ],
  returned: 1, truncated: false, page_size: 100, recorded_count: 1,
};

// ---- the chains, with the receipts read back into their produces hop ----

const HOP = (over: Record<string, unknown>) => ({
  index: 0, from: { kind: "action", ref: "fleet.wipe" }, relation: "produces", to: { kind: "effect", ref: "devices wiped" },
  verdict: "proven", proven_by: [], reasons: [], ...over,
});

/** The backend's sentences for a receipt that cannot be compared (assurance/authority_chain.py `_same_action`, `readback`). */
export const CANNOT_COMPARE_WHY =
  "action reference: cannot compare with observed effect oe-v5 of the same dispatch (two key ids, or a keyed reference beside a plain digest): whether the two name one action is unknown";
export const CANNOT_COMPARE_DETAIL =
  `receipt rcpt-2: ${CANNOT_COMPARE_WHY}. A receipt that cannot be compared with the record binds nothing about dispatch d-77: it is neither a match nor a conflict`;

const chainRow = (uuid: string, over: Record<string, unknown>) => ({
  uuid, workflow: "fleet-wipe", effect: "devices wiped", digest: `sha256:${"4d".repeat(32)}`, standing: true,
  verdict: "unproven", basis: "demonstrated", basis_in_force: "demonstrated", signed: true, observer_engine: "achilles",
  outcome_id: `out-${uuid}`, gate_outcome_id: "gate-1", effect_outcome_id: "oe-v5", route: "current",
  observed_at: "2026-11-16T12:00:00+00:00", recorded_at: "2026-11-16T12:02:00+00:00", recorded_by: "operator-one",
  source: "achilles", note: "", unproven_hops: [0], broken_hops: [], ...over,
});

export const receipt = (id: string, over: Record<string, unknown> = {}) => ({
  receipt_id: id, dispatch_id: "d-77", attempt: 1, gate_outcome_id: "gate-1", answer: "applied", conclusion: "committed",
  read_at: "2026-11-16T12:05:00.000000Z", provider: "fleet-provider", verified: true, binds: true, why: null, ...over,
});

export const CHAINS = {
  chains: [
    chainRow("ch-held-back", {
      hops: [HOP({ verdict: "unproven", reasons: [{ verdict: "unproven", code: "reconciliation_cannot_compare", detail: CANNOT_COMPARE_DETAIL }] })],
      reconciliations: [
        receipt("rcpt-2", { binds: false, why: CANNOT_COMPARE_WHY }),
        receipt("rcpt-3", { verified: false, binds: false, why: "it does not verify under the observed-effect key in the keyring in force, or its row is not what it signs: it binds nothing" }),
        receipt("rcpt-4", { verified: null, binds: null }),
        ...BAD_ROWS,
      ],
    }),
    chainRow("ch-proven", {
      verdict: "proven", unproven_hops: [], effect_outcome_id: "oe-over",
      hops: [HOP({ proven_by: [{ verdict: "proven", code: "readback", detail: "receipt rcpt-1 read the dispatch back as applied" }] })],
      reconciliations: [receipt("rcpt-1")],
    }),
    chainRow("ch-no-receipts", { verdict: "proven", unproven_hops: [], effect_outcome_id: null, hops: [HOP({})], reconciliations: [] }),
    // A backend from before F1: no receipts are served at all.
    chainRow("ch-older", { verdict: "proven", unproven_hops: [], hops: [HOP({})] }),
  ],
  returned: 4, truncated: false, page_size: 100, recorded: 4, standing: 4, superseded: 0,
  verdict_census: { proven: 3, unproven: 1, broken: 0 }, approvals_in_force: {}, effects: [], effect_census: {},
};

/** Every answer above, by the backend path it is served at. */
export function servedByPath(): Record<string, unknown> {
  return {
    [BACKEND(DEP)]: OUTCOMES,
    [BACKEND(DEP_OLDER)]: OLDER_OUTCOMES,
    [BACKEND(DEP_EMPTY)]: { outcomes: [], returned: 0, truncated: false, page_size: 100, recorded_count: 0 },
    [BACKEND(DEP_HOSTILE)]: HOSTILE_OUTCOMES,
    [BACKEND(DEP_STATES)]: STATES_OUTCOMES,
    [BACKEND(DEP_NO_LIST)]: { returned: 0, truncated: false },
    [BACKEND(DEP_NOT_A_LIST)]: { outcomes: "sixteen of them", returned: 16, truncated: false, page_size: 100, recorded_count: 16 },
    [CHAINS_BACKEND(DEP)]: CHAINS,
  };
}
