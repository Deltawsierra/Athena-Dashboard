/**
 * An incident's scope (SPINE SP-3) as this console's server maps it from
 * Athena-Backend (athena-backend assurance/incident_scope.py `served` and
 * `finding_scope`; assurance/recovery_record.py `served`, `scope_items` and
 * `_incident`), for the recovery screen to read
 * (client/src/components/authority/IncidentScope.tsx).
 *
 * The scope of an incident is what is believed affected. The backend keeps it as
 * numbered revisions, one per change, the newest current. A recovery step names
 * the revision it was taken under, and what about the scope holds it back now.
 *
 * camelCase. Three things are kept apart everywhere here, because each reads
 * differently on the screen:
 *
 *   - a list the backend served, empty or not: what it holds is known;
 *   - `null`: the backend served null, or no value. For the lists marked so
 *     below that is the backend saying the list CANNOT BE ESTABLISHED (no scope
 *     is declared, or a revision cannot be read). It is never turned into an
 *     empty list, which would say that nothing was added or removed;
 *   - a block that is absent altogether (`scope` on an incident or a step): the
 *     backend served none of the scope's fields, as one from before the scope
 *     was versioned does. That is "not reported", not "no scope".
 *
 * A row of any list here that cannot be read is counted in the block's
 * `unreadable` (shared/unreadable-rows.ts), never dropped unsaid and never the
 * reason a read fails.
 */
import type { UnreadableRows } from "./unreadable-rows";

/** The backend's name for a step taken with no scope revision on record. */
export const SCOPE_NOT_DECLARED = "scope:not_declared";
/** The backend's name for a scope revision whose items cannot be read. */
export const SCOPE_UNREADABLE = "scope:unreadable";

/** What names one item of a scope: its kind and its reference, both as served. */
export interface ScopeItemRef {
  /** `asset`, `workflow`, or whatever the backend served; null when it served none. */
  kind: string | null;
  /** An asset's uuid, a workflow's slug, as served; null when none was served. */
  ref: string | null;
}

/** One item a revision holds, as recorded. */
export interface ScopeItem extends ScopeItemRef {
  /** An asset's own kind, which the backend keeps beside it (`asset_kind`); null when none was served. */
  assetKind: string | null;
}

/** An item one revision added and a later one removed (athena-backend incident_scope.removed). */
export interface ScopeRemovedItem extends ScopeItemRef {
  /** The revision that added it. */
  added: number | null;
  /** The revision that removed it. */
  removed: number | null;
  /** Who declared the revision that removed it; null when nobody is on record. */
  removedBy: string | null;
  /** Why, in that revision's own words; null when none is on record. */
  reason: string | null;
}

/** A link of a step that names an added item: `evidence`, `permit` or `coverage`, with its reference. */
export type ScopeLink = ScopeItemRef;

/** An item a step's scope gained after its first revision, with every link of the step that names it. */
export interface ScopeAddedItem extends ScopeItemRef {
  /** The revision that added it. */
  revision: number | null;
  /** The links that name it. Empty: nothing names it, an open gap. null: not served. */
  coveredBy: ScopeLink[] | null;
}

/** What a step's row holds, as it was recorded: history, never rewritten by a later revision. */
export interface ScopeRecorded {
  state: string | null;
  /** null: not served. */
  gaps: string[] | null;
  release: string | null;
}

/** What a recovery step says of the scope it was taken under. */
export interface StepScope {
  /** The revision the step was taken under; null: it names none. */
  revision: number | null;
  /**
   * What about the scope holds this step back now, each as the backend names it
   * (`scope:not_declared`, `scope:unreadable`, `scope:revision:<n>:added:<kind>:<ref>`).
   * Empty: nothing does. null: not served, so whether anything does is not known.
   */
  gaps: string[] | null;
  /** What the step's scope gained. null: it cannot be established, or was not served. Never an empty list in its place. */
  added: ScopeAddedItem[] | null;
  /** What the step's scope lost. null: it cannot be established, or was not served. */
  removed: ScopeRemovedItem[] | null;
  /** null: not served. */
  recorded: ScopeRecorded | null;
  /** Rows of the lists above that could not be read, by list: `gaps`, `added`, `added.coveredBy`, `removed`, `recorded.gaps`, `scopeItems`, `recorded`. */
  unreadable?: UnreadableRows;
}

/** What a recovery record says of its incident's scope. */
export interface IncidentScope {
  /** The incident's current scope revision; null: no scope is declared. */
  revision: number | null;
  /** Every item a revision added and a later one removed. null: it cannot be established, or was not served. */
  removed: ScopeRemovedItem[] | null;
  /** Rows of `removed` that could not be read. */
  unreadable?: UnreadableRows;
}

/** A piece of evidence a revision rests on. */
export interface ScopeEvidence {
  uuid: string | null;
  classification: string | null;
}

/** One revision of an incident's scope, as its read serves it. */
export interface ScopeRevision {
  /** The revision's own id. */
  ref: string | null;
  revision: number | null;
  /** The revision it supersedes; null for the first, or when none was served. */
  supersedes: number | null;
  /** Whether the backend marks it the current one; null: not said. */
  current: boolean | null;
  /** What it holds, as recorded. null: not served. */
  items: ScopeItem[] | null;
  /** What it added to the revision before it. null: not known (its items, or those of the one before, cannot be read). */
  added: ScopeItemRef[] | null;
  /** What it removed from the revision before it. null: not known. */
  removed: ScopeItemRef[] | null;
  /** Why the scope is this, in the declarer's words. */
  reason: string | null;
  /** The evidence it rests on. null: not served. */
  evidence: ScopeEvidence[] | null;
  /** Who declared it; null when nobody is on record. */
  declaredBy: string | null;
  declaredAt: string | null;
  /** Rows of this revision's lists that could not be read, by list: `items`, `added`, `removed`, `evidence`. */
  unreadable?: UnreadableRows;
}

/** One incident's scope, every revision oldest first as served (athena-backend `finding_scope`). */
export interface FindingScope {
  /** The deployment the backend answered for; null when it named none. */
  deployment: string | null;
  finding: string | null;
  /** The number of the current revision; null: none is declared, or none was served. */
  current: number | null;
  /** Every revision, oldest first as served. null: the backend served no list of them. */
  revisions: ScopeRevision[] | null;
  /** Rows of `revisions` that could not be read. */
  unreadable?: UnreadableRows;
}
