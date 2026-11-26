/**
 * What Athena-Backend serves of an observed effect's record, and of the reconciliation
 * receipts read back beside it, as this console's server maps them
 * (server/assurance.ts chainOutcomes, authorityChains).
 *
 * The record is Mythos-Core's `mythos.observed-effect` document, versions 1 to 5,
 * signed by the engine that watched the effect. Athena-Backend serves what a reader
 * is shown of it on each row of GET /api/assurance/deployments/<uuid>/chain-outcomes/
 * as `effect_reading` (Athena-Backend #234), every word in it the core's:
 *
 *   - how the record refers to its action and its answer: a version 5 record by keyed
 *     references (`hmac-sha256:` and 64 hex) that only the holder of the engine's chain
 *     key can compute, "keyed: not checkable here"; an older one by plain digests,
 *     which are withheld from this reader ("plain digests: withheld from this reader");
 *   - which stage of execution it shows: `accepted`, as signed by version 5 ("accepted,
 *     as signed") or read from an older record's 2xx ("accepted, from the recorded 2xx;
 *     this version has no execution field"), never `committed`;
 *   - the tool binding a version 5 record's permit was decided for, its approvals and
 *     what was counted under each ("within its bound", "no bound recorded", or of an
 *     older record "no tool binding recorded");
 *   - and what the backend finds in that binding (`binding_bound_over_approval`).
 *
 * HOW IT IS CARRIED. camelCase. A part the backend did not serve is absent (or null
 * where the type says so), never filled in. A part served in a shape that cannot be
 * read is named in `unreadableFields`, and a list's rows that cannot be read are
 * counted in `unreadable` (shared/unreadable-rows.ts): neither is dropped unsaid.
 *
 * NO KEYED VALUE IS CARRIED. A keyed reference is carried as what it is (`keyed`),
 * never as its 64 hex: no one this console serves holds the key, so the value is not
 * a hash a person could compare with anything, and drawing it would read as one. A
 * reference in a form this console does not know is carried as `unrecognised`, its
 * value dropped too: it may be a plain digest, which lets whoever reads it confirm a
 * guess at the action.
 */
import type { UnreadableRows } from "./unreadable-rows";

/** A record's schema: `mythos.observed-effect/v<N>`. */
export const OBSERVED_EFFECT_SCHEMA = /^mythos\.observed-effect\/v([1-9][0-9]*)$/;

/** The record's version its schema names, or null for a schema this console does not read as one. */
export function effectVersionOf(schema: string | null): number | null {
  const named = schema === null ? null : OBSERVED_EFFECT_SCHEMA.exec(schema);
  return named ? Number(named[1]) : null;
}

/** A keyed reference: an HMAC-SHA256 under the engine's chain key (Mythos-Core observed_effect `_REF`). */
export const KEYED_REFERENCE = /^hmac-sha256:[0-9a-f]{64}$/;
/** What the core puts where a reference is withheld from a reader: `withheld:<why>`. */
export const WITHHELD_PREFIX = "withheld:";
/** The core's `why` for an older record's plain digest, withheld from this reader. */
export const WITHHELD_PLAIN_DIGEST = "plain-digest";

/** The backend's named finding of a binding whose bound is larger than an approval's (assurance/observed_effects.py). */
export const BINDING_BOUND_OVER_APPROVAL = "binding_bound_over_approval";
/** The reading of a produces hop a reconciliation receipt cannot be compared on (assurance/authority_chain.py REASONS). */
export const RECONCILIATION_CANNOT_COMPARE = "reconciliation_cannot_compare";

/**
 * The core's execution states (mythos_core.status EXECUTION_STATES), in the order an
 * action moves through them. A version 5 record signs `accepted` only; any other is
 * drawn as served.
 */
export const EXECUTION_STATES = [
  "proposed", "denied", "permitted", "dispatched", "accepted", "committed", "failed", "partial", "unknown",
] as const;
/** The core's bases for an execution state: the record says it, or it is read from what the record holds. */
export const EXECUTION_BASES = ["observed", "inferred"] as const;

/**
 * How a record refers to something: by a keyed reference (its value not carried), by
 * a reference withheld from this reader (with the core's `why`), or in a form this
 * console does not read (its value not carried either).
 */
export type EffectReference =
  | { form: "keyed" }
  | { form: "withheld"; why: string }
  | { form: "unrecognised" };

/** The key a version 5 record's references are keyed under: the chain's version and the key's id, which holds nothing of the key. */
export interface KeyedUnder {
  chain: string | null;
  chainKey: string | null;
  unreadableFields?: string[];
}

/** Which stage of execution the record shows, and the core's words for it. */
export interface EffectExecution {
  state: string | null;
  basis: string | null;
  words: string | null;
  unreadableFields?: string[];
}

/** What was counted under one approval's limit per window by this dispatch (Achilles' window counter). */
export interface WindowCount {
  /** The targets this dispatch counted. */
  counted: number | null;
  /** Whether it rested on an earlier count of its own (a retry). */
  rested: boolean | null;
  /** The window's count after it. */
  windowCount: number | null;
  /** The approval's lifetime count after it. */
  lifetimeCount: number | null;
  unreadableFields?: string[];
}

/** One approval a tool binding rests on, as signed. */
export interface BindingApproval {
  /** The approval's id: a sha256 over its random nonce and MAC, computable from no guess. */
  approval: string | null;
  effect: string | null;
  /** The population the approval names. */
  targetCount: number | null;
  /** Its limit per window; null when it names none. Absent: not served. */
  maxTargets?: number | null;
  /** Its window in seconds; null when it names no limit per window. Absent: not served. */
  windowS?: number | null;
  /** Its population, keyed. Absent: not served. */
  targets?: EffectReference;
  /** What was counted under it; null when nothing was counted. Absent: not served. */
  counted?: WindowCount | null;
  unreadableFields?: string[];
}

/** The tool a version 5 record's permit was decided for, as signed. */
export interface ToolBinding {
  kind: string | null;
  identifier: string | null;
  /** The registry generation, keyed under the permit key. Absent: not served. */
  generation?: EffectReference;
  effect: string | null;
  targetCount: number | null;
  /** The binding's bound. */
  maxTargets: number | null;
  /** The population, keyed. Absent: not served. */
  targets?: EffectReference;
  /** Absent: not served (never read as resting on none). */
  approvals?: BindingApproval[];
  unreadable?: UnreadableRows;
  unreadableFields?: string[];
}

/** A finding the backend names in a binding: today one, binding_bound_over_approval. */
export interface BindingFinding {
  code: string | null;
  approval: string | null;
  bindingMaxTargets: number | null;
  approvalMaxTargets: number | null;
  /** The backend's sentence for it. */
  detail: string | null;
  unreadableFields?: string[];
}

/** What a reader is shown of one observed effect's record, as Athena-Backend serves it (`effect_reading`). */
export interface EffectReading {
  schema: string | null;
  /** The core's words for how the record refers to its action and its answer. */
  digests: string | null;
  /** What this reader is told of them. */
  digestsServed: string | null;
  /** Absent: not served. */
  actionReference?: EffectReference;
  /** Absent: not served. */
  responseReference?: EffectReference;
  /** null: the record keys nothing (versions 1 to 4). Absent: not served. */
  keyedUnder?: KeyedUnder | null;
  /** Absent: not served. */
  execution?: EffectExecution;
  /** null: no binding was recorded (the reading's words say why). Absent: not served. */
  toolBinding?: ToolBinding | null;
  /** The core's words for what the record shows of its binding. */
  toolBindingReading: string | null;
  /** Absent: not served (never read as no finding). */
  findings?: BindingFinding[];
  unreadable?: UnreadableRows;
  unreadableFields?: string[];
}

/**
 * A row's reading as served: not reported (a backend before #234 serves no
 * `effect_reading`), none (the backend serves null: it holds no evidence document for
 * the row that matches its signed digest), a value that could not be read, or the
 * reading.
 */
export type EffectReadingAsServed =
  | { served: "not_reported" }
  | { served: "none" }
  | { served: "unreadable" }
  | { served: "reading"; reading: EffectReading };

/** The evidence kind of an observed effect's row (athena-backend assurance/composition.py EVIDENCE_OBSERVED_EFFECT). */
export const EVIDENCE_OBSERVED_EFFECT = "observed_effect";

/** One chain outcome (athena-backend assurance/serializers.py WorkflowChainOutcomeSerializer), as far as this view reads it. */
export interface ChainOutcomeRow {
  uuid: string;
  outcomeId: string | null;
  workflow: string;
  status: string;
  statusLabel: string | null;
  evidenceKind: string | null;
  evidenceKindLabel: string | null;
  observerEngine: string | null;
  basisInForce: string | null;
  signed: boolean | null;
  observedAt: string | null;
  recordedAt: string | null;
  effect: EffectReadingAsServed;
}

/**
 * The filter this console reads a deployment's observed effects with (Athena-Backend
 * #241, `?recorded_as=`): the rows RECORDED AS observed effects. Each row still says
 * for itself what it is in force: one whose signature no longer checks is among them,
 * with `effect_reading` null.
 */
export const RECORDED_AS_OBSERVED_EFFECT = "observed_effect";
/** The longest cursor Athena-Backend reads (assurance/outcome_pages.py MAX_CURSOR_CHARS). */
export const MAX_CURSOR_CHARS = 512;
/** The backend's code for a cursor it does not take: the walk starts again from the first page. */
export const BAD_CURSOR = "bad_cursor";

/**
 * One page of a deployment's chain outcomes, with the counts served beside it.
 *
 * A backend that pages (Athena-Backend #241) serves `next` and `matching_count`, and
 * the rows are those the filter matched. One that does not serves neither: the rows
 * are its newest outcomes of every kind, and both stay absent here, never filled in.
 */
export interface ChainOutcomes {
  outcomes: ChainOutcomeRow[];
  returned: number | null;
  truncated: boolean | null;
  pageSize: number | null;
  /** Every outcome of the deployment, whatever the filter and whichever the page. */
  recordedCount: number | null;
  /** What the filter matched, on every page. Absent: not served, or not a count (then named in `unreadableFields`). */
  matchingCount?: number;
  /**
   * The cursor for the page after this one; null: the backend says this is the last.
   * Absent: not served (a backend that does not page), or served as something that is
   * not a cursor (then named in `unreadableFields`): never read as the last page.
   */
  next?: string | null;
  unreadable?: UnreadableRows;
  unreadableFields?: string[];
}

/** Whether an answer came from a backend that pages: it served `next`, readable or not. */
export function servesPages(page: ChainOutcomes): boolean {
  return page.next !== undefined || (page.unreadableFields ?? []).includes("next");
}

/** Whether a row is an observed effect: by its evidence kind, or by a reading served on it. */
export function isObservedEffect(row: ChainOutcomeRow): boolean {
  return row.evidenceKind === EVIDENCE_OBSERVED_EFFECT || row.effect.served === "reading" || row.effect.served === "unreadable";
}

/**
 * One reconciliation receipt read back into a chain's produces hop
 * (athena-backend assurance/effect_reconciliation.py `served`): whether it verifies now,
 * whether it binds, and the backend's words for why not.
 */
export interface ReconciliationReceipt {
  receiptId: string | null;
  dispatchId: string | null;
  attempt: number | null;
  gateOutcomeId: string | null;
  answer: string | null;
  conclusion: string | null;
  readAt: string | null;
  provider: string | null;
  verified: boolean | null;
  binds: boolean | null;
  why: string | null;
}
