/**
 * An incident's scope as Athena-Backend serves it (SPINE SP-3; athena-backend #229 at
 * abdaa57: assurance/incident_scope.py `served` and `finding_scope`,
 * assurance/recovery_record.py `served`, `scope_items` and `_incident`), one answer
 * for every shape its reads can take. Synthetic data, invented names.
 *
 * Shared by the relay test (the mapping), the render test (what the recovery view
 * draws for each) and the recovery view's own test of its words, so each view is
 * handed what this console's real routes answer for these (tests/helpers/bad-rows.ts
 * standIn).
 *
 * Each case is one incident on the deployment's recovery-records page, and where it
 * has one, the answer of its scope read (`scope`):
 *
 *   declared      a scope declared once, and a recovery accepted under it
 *   three         three revisions with adds and removes; an item added then removed
 *   widened       accepted under revision 1, then revision 2 added two items
 *   open          an item a revision added that nothing the step links names
 *   undeclared    no scope declared: every list that cannot be established is null
 *   unreadable    a revision whose items cannot be read: null, beside scope:unreadable
 *   before        rows from before the scope was versioned, on a backend that has it
 *   rows          a row that cannot be read among good ones, in every scope list
 *   kind          item kinds beyond asset and workflow, one of them unknown
 *   contradicted  served as accepted and allowed beside a scope gap (never by #229)
 *   partial       only a step's scope revision served: the rest is not known
 *   older         a backend from before #229: no scope field at all
 */

export const DEP = "0d0d0d0d-0000-4000-8000-00000000000d";
export const PRIMARY = "a0a0a0a0-0000-4000-8000-0000000000a1";
export const BACKUP = "a0a0a0a0-0000-4000-8000-0000000000a2";
export const MODEM = "a0a0a0a0-0000-4000-8000-0000000000a3";
export const EVIDENCE_1 = "e0e0e0e0-0000-4000-8000-0000000000e1";
export const EVIDENCE_2 = "e0e0e0e0-0000-4000-8000-0000000000e2";

export const NOT_DECLARED = "scope:not_declared";
export const UNREADABLE = "scope:unreadable";
/** The gap an added item leaves, as athena-backend incident_scope.gap names it. */
export const addedGap = (revision: number, kind: string, ref: string) => `scope:revision:${revision}:added:${kind}:${ref}`;

const FAR_AHEAD = "2999-01-01T00:00:00+00:00";
const RECORDED_AT = "2026-11-02T09:00:00+00:00";
const T0 = "2026-11-01T00:00:00.000000Z";
const T1 = "2026-11-02T00:00:00.000000Z";

export const CASES = [
  "declared", "three", "widened", "open", "undeclared", "unreadable", "before", "rows", "kind", "contradicted", "partial", "older",
] as const;
export type CaseName = (typeof CASES)[number];

/** Each case's finding: an id Athena-Backend issues (a uuid). */
export const FINDING = Object.fromEntries(
  CASES.map((name, index) => [name, `f0f0f0f0-0000-4000-8000-${String(index + 1).padStart(12, "0")}`]),
) as Record<CaseName, string>;

/** An item as a revision stores it, and as `added`, `removed` and a gap name it. */
export const ITEM = {
  primary: { kind: "asset", ref: PRIMARY, asset_kind: "gateway" },
  backup: { kind: "asset", ref: BACKUP, asset_kind: "gateway" },
  modem: { kind: "asset", ref: MODEM, asset_kind: "modem" },
  refund: { kind: "workflow", ref: "refund" },
  payout: { kind: "workflow", ref: "payout" },
} as const;
export const named = (item: { kind: string; ref: string }) => ({ kind: item.kind, ref: item.ref });

const COVERAGE = {
  manifest: { sources: [{ source: "edr", kind: "log", start: T0, end: T1 }], observations: [{ source: "edr", start: T0, end: T1, basis: "observed" }], gaps: [] },
  observed_sources: 1, required_sources: 1, complete: true, missing: {}, unknown_inventory: [],
};
const TESTED = [
  { condition: "repair_agreed", witness: { kind: "repair_contract", ref: "rc-1" } },
  { condition: "repair_tested", witness: { kind: "closure_evidence", ref: "ce-1" } },
];
const ACCEPTED = { condition: "owner_accepted", witness: { kind: "owner", ref: "user:7" } };

type Served = Record<string, unknown>;

/**
 * One step as athena-backend recovery_record.served serves it since #229: under scope
 * revision 1, nothing about the scope against it, a scope that gained and lost nothing,
 * and `recorded` saying what the step itself says, unless `overrides` says otherwise.
 */
export function servedStep(finding: string, version: number, overrides: Served = {}): Served {
  const step: Served = {
    ref: `${finding.slice(0, 8)}-0000-4000-8000-${String(version).padStart(12, "0")}`,
    version,
    state: "under_investigation",
    reopens: null,
    conditions: [{ condition: "incident_recorded", witness: { kind: "finding", ref: finding } }],
    gaps: [],
    restrictions: [],
    release: "FAIL",
    scope_revision: 1,
    scope_gaps: [],
    scope_items: { added: [], removed: [] },
    residual_uncertainty: [],
    links: { incident: finding, evidence: [], permits: [], receipts: [], decision: null, repair_contract: null, closure_evidence: null, unknowns: [], gaps: [], restrictions: [], uncertainty: [] },
    coverage: COVERAGE,
    accepted_by: null,
    accepted_until: null,
    recorded_by: "analyst-k",
    recorded_at: RECORDED_AT,
    ...overrides,
  };
  if (!("recorded" in overrides)) step.recorded = { state: step.state, gaps: step.gaps, release: step.release };
  return step;
}

/** A recovery the owner accepted, as its row records it. */
const accepted = (finding: string): Served => ({
  state: "recovery_accepted", release: "PASS",
  conditions: [{ condition: "incident_recorded", witness: { kind: "finding", ref: finding } }, ...TESTED, ACCEPTED],
  accepted_by: "owner-d", accepted_until: FAR_AHEAD, recorded_by: "owner-d",
});

/** A tested repair whose release is incomplete: how a step the scope keeps back reads. */
const keptBack = (finding: string, gaps: string[]): Served => ({
  state: "repair_tested", release: "AUDIT_INCOMPLETE", gaps, scope_gaps: gaps,
  conditions: [{ condition: "incident_recorded", witness: { kind: "finding", ref: finding } }, ...TESTED],
  residual_uncertainty: gaps.map((gap) => ({ statement: gap, sources: [{ kind: "scope", ref: `finding:${finding}` }] })),
});

/** The step without the fields #229 added: as a backend from before it serves one. */
export function before229(step: Served): Served {
  const { scope_revision: _r, scope_gaps: _g, scope_items: _i, recorded: _c, ...rest } = step;
  return rest;
}

function incident(name: CaseName, title: string, steps: Served[], scope: Served): Served {
  const last = steps[steps.length - 1];
  return {
    finding: FINDING[name], title, severity: "high", ...scope,
    current: { version: last.version, state: last.state, release: last.release }, steps,
  };
}

/** One revision as athena-backend incident_scope.served serves it. */
export function servedRevision(finding: string, revision: number, overrides: Served = {}): Served {
  return {
    ref: `${finding.slice(0, 8)}-0000-4000-9000-${String(revision).padStart(12, "0")}`,
    revision,
    supersedes: revision === 1 ? null : revision - 1,
    current: false,
    items: [ITEM.primary],
    added: revision === 1 ? [named(ITEM.primary)] : [],
    removed: [],
    reason: "what the scan reached",
    evidence: [{ uuid: EVIDENCE_1, classification: "technically_verified" }],
    declared_by: "owner-d",
    declared_at: `2026-11-0${revision}T09:00:00+00:00`,
    ...overrides,
  };
}

function scopeOf(name: CaseName, revisions: Served[]): Served {
  const numbered = revisions.filter((one) => one !== null && typeof one === "object" && typeof one.revision === "number");
  const current = numbered.length === 0 ? null : (numbered[numbered.length - 1].revision as number);
  return {
    deployment: DEP, finding: FINDING[name], current,
    revisions: revisions.map((one) => (one !== null && typeof one === "object" && !Array.isArray(one) ? { ...one, current: one.revision === current } : one)),
  };
}

const WHY_REMOVED = "the refund workflow was never called, and the modem was never on this network";
const MODEM_GONE = { ...named(ITEM.modem), added: 2, removed: 3, removed_by: "owner-d", reason: WHY_REMOVED };
const BACKUP_GONE = { ...named(ITEM.backup), added: 2, removed: 3, removed_by: "owner-d", reason: "a false alarm: the route was never connected" };

/** A row of each kind that cannot be read. What one held is never shown. */
export const LEAK = "a-scope-row-that-could-not-be-read";

/** Each case's incident, as the recovery reads serve it. */
export const INCIDENT: Record<CaseName, Served> = {
  declared: incident("declared", "Refund agent wrote outside its approval", [
    servedStep(FINDING.declared, 1),
    servedStep(FINDING.declared, 2, accepted(FINDING.declared)),
  ], { scope_revision: 1, scope_removed: [] }),

  three: incident("three", "Ledger tool kept a stale grant", [
    servedStep(FINDING.three, 1),
    servedStep(FINDING.three, 2, {
      ...accepted(FINDING.three), scope_revision: 3,
      scope_items: {
        added: [{
          revision: 2, ...named(ITEM.backup),
          covered_by: [{ kind: "evidence", ref: EVIDENCE_2 }, { kind: "coverage", ref: `asset:${BACKUP}` }],
        }],
        removed: [MODEM_GONE],
      },
    }),
  ], { scope_revision: 3, scope_removed: [MODEM_GONE] }),

  widened: incident("widened", "Support agent exported a ticket queue", [
    servedStep(FINDING.widened, 1),
    servedStep(FINDING.widened, 2, {
      ...keptBack(FINDING.widened, [addedGap(2, "asset", BACKUP), addedGap(2, "workflow", "payout")]),
      accepted_by: "owner-d", accepted_until: FAR_AHEAD, recorded_by: "owner-d",
      recorded: { state: "recovery_accepted", gaps: [], release: "PASS" },
    }),
  ], { scope_revision: 2, scope_removed: [] }),

  open: incident("open", "A revoke did not reach the mail relay", [
    servedStep(FINDING.open, 1, {
      ...keptBack(FINDING.open, [addedGap(2, "asset", BACKUP)]), scope_revision: 2,
      scope_items: {
        added: [
          { revision: 2, ...named(ITEM.backup), covered_by: [] },
          { revision: 2, ...named(ITEM.payout), covered_by: [{ kind: "permit", ref: "gate-7" }] },
        ],
        removed: [],
      },
    }),
  ], { scope_revision: 2, scope_removed: [] }),

  undeclared: incident("undeclared", "Payments tool restored behind a cap", [
    servedStep(FINDING.undeclared, 1, {
      ...keptBack(FINDING.undeclared, [NOT_DECLARED]), scope_revision: null, scope_items: { added: null, removed: null },
    }),
  ], { scope_revision: null, scope_removed: null }),

  unreadable: incident("unreadable", "Search index served another tenant's rows", [
    servedStep(FINDING.unreadable, 1, {
      ...keptBack(FINDING.unreadable, [UNREADABLE]),
      recorded: { state: "recovery_accepted", gaps: [], release: "PASS" },
    }),
    servedStep(FINDING.unreadable, 2, {
      ...keptBack(FINDING.unreadable, [UNREADABLE]), scope_revision: 2, scope_items: { added: null, removed: null },
    }),
  ], { scope_revision: 2, scope_removed: null }),

  before: incident("before", "Billing export ran under a retired account", [
    servedStep(FINDING.before, 1, {
      ...keptBack(FINDING.before, [NOT_DECLARED]), scope_revision: null, scope_items: null,
      recorded: { state: "recovery_accepted", gaps: [], release: "PASS" },
    }),
  ], { scope_revision: null, scope_removed: null }),

  rows: incident("rows", "Queue worker replayed a stale job", [
    servedStep(FINDING.rows, 1, {
      ...keptBack(FINDING.rows, [addedGap(2, "asset", BACKUP)]), scope_revision: 2,
      scope_gaps: [addedGap(2, "asset", BACKUP), 7, null, { gap: LEAK }],
      scope_items: {
        added: [{ revision: 2, ...named(ITEM.backup), covered_by: [{ kind: "evidence", ref: EVIDENCE_2 }, LEAK, null] }, LEAK, 7],
        removed: [BACKUP_GONE, [LEAK]],
      },
      recorded: { state: "recovery_accepted", gaps: ["a gap the row recorded", 3], release: "PASS" },
    }),
  ], { scope_revision: 2, scope_removed: [BACKUP_GONE, null, 7] }),

  kind: incident("kind", "Vendor modem answered on the backup line", [
    servedStep(FINDING.kind, 1, {
      ...keptBack(FINDING.kind, [addedGap(2, "modem", "vendor-modem-7")]), scope_revision: 2,
      scope_items: {
        added: [
          { revision: 2, kind: "route", ref: "backup-route", covered_by: [{ kind: "evidence", ref: EVIDENCE_2 }] },
          { revision: 2, kind: "identity", ref: "svc-ledger", covered_by: [{ kind: "attestation", ref: "att-3" }] },
          { revision: 2, kind: "modem", ref: "vendor-modem-7", covered_by: [] },
        ],
        removed: [],
      },
    }),
  ], { scope_revision: 2, scope_removed: [] }),

  contradicted: incident("contradicted", "Cache entry served another session", [
    servedStep(FINDING.contradicted, 1, { ...accepted(FINDING.contradicted), scope_gaps: [addedGap(2, "asset", BACKUP)] }),
  ], { scope_revision: 2, scope_removed: [] }),

  partial: {
    finding: FINDING.partial, title: "Webhook accepted an unsigned call", severity: "high", scope_revision: 1,
    current: { version: 1, state: "recovery_accepted", release: "PASS" },
    steps: [{ ...before229(servedStep(FINDING.partial, 1, accepted(FINDING.partial))), scope_revision: 1 }],
  },

  older: {
    finding: FINDING.older, title: "Report job read a draft table", severity: "high",
    current: { version: 1, state: "recovery_accepted", release: "PASS" },
    steps: [before229(servedStep(FINDING.older, 1, accepted(FINDING.older)))],
  },
};

const WIDER = [
  servedRevision(FINDING.widened, 1),
  servedRevision(FINDING.widened, 2, {
    items: [ITEM.primary, ITEM.backup, ITEM.payout], added: [named(ITEM.backup), named(ITEM.payout)],
    reason: "a backup route found in the firewall export", declared_by: "analyst-k",
    evidence: [{ uuid: EVIDENCE_2, classification: "technically_verified" }],
  }),
];

/** Each case's scope read (GET findings/<uuid>/scope-revisions/). A case not here has none served: a 404. */
export const SCOPE: Partial<Record<CaseName, Served>> = {
  declared: scopeOf("declared", [
    servedRevision(FINDING.declared, 1, { items: [ITEM.primary, ITEM.refund], added: [named(ITEM.primary), named(ITEM.refund)] }),
  ]),

  three: scopeOf("three", [
    servedRevision(FINDING.three, 1, { items: [ITEM.primary, ITEM.refund], added: [named(ITEM.primary), named(ITEM.refund)] }),
    servedRevision(FINDING.three, 2, {
      items: [ITEM.primary, ITEM.refund, ITEM.backup, ITEM.modem], added: [named(ITEM.backup), named(ITEM.modem)],
      reason: "a backup route and a vendor modem in the firewall export", declared_by: null,
      evidence: [{ uuid: EVIDENCE_2, classification: "technically_verified" }],
    }),
    servedRevision(FINDING.three, 3, {
      items: [ITEM.primary, ITEM.backup], added: [], removed: [named(ITEM.refund), named(ITEM.modem)], reason: WHY_REMOVED,
    }),
  ]),

  widened: scopeOf("widened", WIDER),
  open: scopeOf("open", WIDER.map((one) => ({ ...one, ref: String(one.ref).replace(FINDING.widened.slice(0, 8), FINDING.open.slice(0, 8)) }))),

  undeclared: scopeOf("undeclared", []),
  before: scopeOf("before", []),

  unreadable: scopeOf("unreadable", [
    servedRevision(FINDING.unreadable, 1),
    servedRevision(FINDING.unreadable, 2, { items: [{ kind: "asset" }], added: null, removed: null, reason: "x", evidence: [], declared_by: null }),
  ]),

  rows: scopeOf("rows", [
    servedRevision(FINDING.rows, 1),
    null as unknown as Served,
    servedRevision(FINDING.rows, 2, {
      items: [ITEM.primary, ITEM.backup, 5, LEAK], added: [named(ITEM.backup), null], removed: LEAK,
      evidence: [{ uuid: EVIDENCE_2, classification: "technically_verified" }, 9],
      reason: "a backup route found in the firewall export",
    }),
    LEAK as unknown as Served,
  ]),

  kind: scopeOf("kind", [
    servedRevision(FINDING.kind, 1),
    servedRevision(FINDING.kind, 2, {
      items: [
        ITEM.primary, { kind: "route", ref: "backup-route" }, { kind: "identity", ref: "svc-ledger" },
        { kind: "modem", ref: "vendor-modem-7" }, { ref: "an-item-of-no-kind" },
      ],
      added: [
        { kind: "route", ref: "backup-route" }, { kind: "identity", ref: "svc-ledger" },
        { kind: "modem", ref: "vendor-modem-7" }, { ref: "an-item-of-no-kind" },
      ],
      reason: "the vendor's modem and the service identity that reached it", declared_by: "analyst-k",
    }),
  ]),
};

/** The deployment's recovery-records page holding `cases`, as athena-backend `deployment_records` serves it. */
export function servedPage(cases: readonly CaseName[] = CASES): Served {
  const incidents = cases.map((name) => INCIDENT[name]);
  return { deployment: DEP, incidents, incident_count: incidents.length, returned: incidents.length, truncated: false, page_size: 50, offset: 0 };
}

/** The backend's paths, and this console's routes for them. */
export const BACKEND = {
  page: `/api/assurance/deployments/${DEP}/recovery-records/`,
  record: (name: CaseName) => `/api/assurance/findings/${FINDING[name]}/recovery-record/`,
  scope: (name: CaseName) => `/api/assurance/findings/${FINDING[name]}/scope-revisions/`,
};
export const ROUTE = {
  page: `/api/assurance/deployments/${DEP}/recovery-records`,
  record: (name: CaseName) => `/api/assurance/findings/${FINDING[name]}/recovery-record`,
  scope: (name: CaseName) => `/api/assurance/findings/${FINDING[name]}/scope-revisions`,
};

/** Everything the stand-in backend answers for these cases, by its path. */
export function servedByPath(): Record<string, unknown> {
  const answers: Record<string, unknown> = { [BACKEND.page]: servedPage() };
  for (const name of CASES) {
    answers[BACKEND.record(name)] = { deployment: DEP, ...INCIDENT[name] };
    if (SCOPE[name] !== undefined) answers[BACKEND.scope(name)] = SCOPE[name];
  }
  return answers;
}
