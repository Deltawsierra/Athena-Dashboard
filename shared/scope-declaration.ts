/**
 * Declaring the next revision of an incident's scope (SPINE SP-3) from this console:
 * what Athena-Backend takes, and what the form is built from.
 *
 * The write is athena-backend assurance/views.py `scope_revisions` (POST
 * /api/assurance/findings/<uuid>/scope-revisions/), admin-only there
 * (`_require_admin`) and recorded as the signed-in person. Its body is exactly
 * `{"items": [{"kind", "ref"}], "reason", "evidence": [<uuid>]}`
 * (assurance/incident_scope.py `declare`): a revision names the WHOLE scope, so
 * what it adds and removes is read against the current revision, never posted.
 *
 *   - The kinds it takes are `asset` (by the asset's uuid) and `workflow` (by the
 *     approved workflow's slug), each looked up in the finding's own deployment.
 *     The scope's reads name other kinds (`route`, `identity`, ...); none is ever
 *     offered for a revision here.
 *   - The reason is one printable line of at most 500 characters, checked here as
 *     the backend checks it (`_reason`: Python's `str.isprintable`, `len` in code
 *     points), and the backend's own answer is still the one that counts.
 *   - The evidence is the incident's own (the finding's evidence). The backend takes
 *     evidence of any finding of the deployment; offering the incident's own only is
 *     stricter, never looser.
 *
 * Every refusal carries a code (`{"code", "detail"}`); this console says each in
 * words from its code alone (client/src/components/authority/DeclareScope.tsx),
 * never from the backend's detail and never repeating what a person typed.
 */
import type { ScopeItem, ScopeItemRef } from "./incident-scope";
import type { UnreadableRows } from "./unreadable-rows";

/** The kinds of item a revision may declare (athena-backend incident_scope.KINDS). */
export const DECLARABLE_KINDS = ["asset", "workflow"] as const;
export type DeclarableKind = (typeof DECLARABLE_KINDS)[number];

/** Whether `kind` is one a revision may declare. */
export function declarable(kind: string | null): kind is DeclarableKind {
  return kind !== null && (DECLARABLE_KINDS as readonly string[]).includes(kind);
}

/** The longest reason the backend takes, in characters (code points; athena-backend _REASON_MOST). */
export const REASON_MOST = 500;
/** The most items, and the most pieces of evidence, one revision may name (athena-backend _MOST). */
export const ITEMS_MOST = 100;
export const EVIDENCE_MOST = 100;

/** An asset's or a piece of evidence's reference as the backend takes it: a lower-case uuid (incident_scope._UUID). */
export const UUID_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An approved workflow's slug as the backend takes it (incident_scope._SLUG). */
export const SLUG_REF = /^[-a-zA-Z0-9_]{1,200}$/;

/** Why a reason would be refused: blank, more than one line, a character that is not printable, or too long. */
export type ReasonProblem = "blank" | "line_break" | "not_printable" | "too_long";

/** Every character Python's `str.splitlines` breaks a line at. */
const LINE_BREAK = /[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/;
/** Python's `str.strip` whitespace, near enough: a reason of nothing else is blank. */
const BLANK = /^[\s\u001c-\u001f\u0085]*$/;
/**
 * What Python's `str.isprintable` refuses: every character of Unicode category C
 * (control, format, surrogate, private use, unassigned) or Z (separators), except the
 * ASCII space. So a line break, a tab, a bidirectional control, a zero-width
 * character and a no-break space are each refused, as the backend refuses them.
 */
const NOT_PRINTABLE = new RegExp("[\\p{C}\\p{Z}]", "u");

/**
 * Whether the backend would refuse `reason`, and why; null when it takes it. Checked
 * before anything is posted. The backend reads the same rule from its own Unicode
 * tables, so a character assigned in one and not the other can still be refused
 * there: its answer is then said as it comes.
 */
export function reasonProblem(reason: string): ReasonProblem | null {
  if (BLANK.test(reason)) return "blank";
  if (LINE_BREAK.test(reason)) return "line_break";
  const characters = Array.from(reason);
  if (characters.some((one) => one !== " " && NOT_PRINTABLE.test(one))) return "not_printable";
  if (characters.length > REASON_MOST) return "too_long";
  return null;
}

/** How many characters a reason holds, as the backend counts them (code points, never UTF-16 units). */
export function reasonLength(reason: string): number {
  return Array.from(reason).length;
}

/** One item as a revision names it, and as it is posted. */
export interface DeclaredItem {
  kind: DeclarableKind;
  ref: string;
}

/** The body posted, exactly the three parts the backend takes. */
export interface DeclareScopeBody {
  items: DeclaredItem[];
  reason: string;
  evidence: string[];
}

/** One of the deployment's assets, as a revision may name it. */
export interface ScopeAssetChoice {
  uuid: string;
  name: string | null;
  kind: string | null;
  kindLabel: string | null;
  identifier: string | null;
}

/** One of the deployment's approved workflows, as a revision may name it. */
export interface ScopeWorkflowChoice {
  slug: string;
  name: string | null;
}

/** One piece of the incident's own evidence, as a revision may rest on it. */
export interface ScopeEvidenceChoice {
  uuid: string;
  classification: string | null;
  classificationLabel: string | null;
  summary: string | null;
  source: string | null;
}

/** The current revision a new one would supersede. */
export interface ScopeCurrent {
  /** Its number; null: no revision is declared yet (then `items` is empty), or none could be named. */
  revision: number | null;
  /** Its items as recorded; null: they cannot be known here (a revision not served, or not readable). */
  items: ScopeItem[] | null;
}

/**
 * What an incident's next scope revision can be declared from (server/assurance.ts
 * scopeChoices): the deployment's own assets and approved workflows, the incident's
 * own evidence, and the current revision. Each list holds only rows that were read;
 * any other is counted in `unreadable` by its list: `assets`, `workflows`,
 * `evidence`, `revisions`, `current.items`.
 */
export interface ScopeChoices {
  /** The deployment the finding belongs to, as the backend names it. */
  deployment: string | null;
  finding: string | null;
  assets: ScopeAssetChoice[];
  /** How many assets the backend answered for another deployment: never offered. */
  assetsElsewhere: number;
  workflows: ScopeWorkflowChoice[];
  /** Whether every approved workflow was returned: false when the backend cut the list, null when it did not say. */
  workflowsWhole: boolean | null;
  evidence: ScopeEvidenceChoice[];
  current: ScopeCurrent;
  unreadable?: UnreadableRows;
}

/** One item's identity, by its kind and reference as served. */
export function itemKey(item: ScopeItemRef): string {
  return JSON.stringify([item.kind, item.ref]);
}

/** What a revision naming `next` changes against the current revision's `current`: what it adds, and what it removes. */
export function scopeChange<T extends ScopeItemRef>(current: readonly ScopeItemRef[], next: readonly T[]): { added: T[]; removed: ScopeItemRef[] } {
  const now = new Set(current.map(itemKey));
  const then = new Set(next.map(itemKey));
  return {
    added: next.filter((item) => !now.has(itemKey(item))),
    removed: current.filter((item) => !then.has(itemKey(item))),
  };
}

/** A refusal code as this console passes it on: a short identifier, or nothing. Anything else is not read as a code. */
export const REFUSAL_CODE = /^[a-z][a-z0-9_]{0,63}$/;
