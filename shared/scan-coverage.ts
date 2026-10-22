/**
 * The engine's per-scan coverage manifest, read.
 *
 * Every run result the engine returns carries `coverage` (athena-engine
 * engine/core.py `run()`: `"coverage": coverage.resolve(...)`; the shape is
 * engine/coverage.py `_Manifest.resolve`): what this scan checked and what it
 * did not, so "no findings" can be read against the list of what was asked. The
 * dashboard dropped it. The relay read only `result.results`, the record
 * carried only `runId`, `target` and `results`, and the scan screens listed a
 * run's findings with nothing beside them saying which checks ran.
 *
 * This reads the manifest as the engine wrote it, and re-expresses its states;
 * it never re-decides them. `complete` is the engine's own flag, verbatim, and
 * null when the engine did not send a boolean: never computed here. Rows are
 * grouped by the engine's own `state` word. A row that cannot be read is
 * counted, never dropped in silence. A manifest that is not an object (absent,
 * null, garbled) is null -- "the engine sent none" -- which is not the same as
 * "every check ran", and the screens say so.
 *
 * The engine's vocabulary at pin aa41bb9af566 (engine/coverage.py):
 *   state:  performed | degraded | not_performed | unmeasured
 *   reason: disabled | failed | not_selected | not_reached | interrupted | precondition
 *   manifest: { complete, checks[{ check, team, state, reason?, detail?,
 *               probes_attempted?, probes_failed?, lost_on?, lost_unplaced?, answered_on? }],
 *               not_performed[], degraded[], unmeasured[], limitations{ check: [text] }, notes[] }
 *
 * This is the ENGINE's manifest for ONE scan the dashboard dispatched. The
 * Assurance page's coverage manifest is the backend's, for a deployment the
 * backend assessed: a different population, read by different code.
 */

/** One check the engine listed, in the engine's own words. */
export interface CoverageCheck {
  check: string;
  team: string | null;
  /** The engine's state word, verbatim. */
  state: string;
  /** The engine's reason word for a check that did not run, verbatim; null when it gave none. */
  reason: string | null;
  /** The engine's sentence for a reader, verbatim; null when it gave none. */
  detail: string | null;
  probesAttempted: number | null;
  probesFailed: number | null;
}

export interface ScanCoverage {
  /** The engine's own flag, verbatim; null when it sent none. Never computed here. */
  complete: boolean | null;
  /** Every row the engine listed that could be read, in its order. */
  checks: CoverageCheck[];
  performed: CoverageCheck[];
  degraded: CoverageCheck[];
  notPerformed: CoverageCheck[];
  unmeasured: CoverageCheck[];
  /** Rows in a state this reader does not know: shown with the engine's word, never re-filed. */
  other: CoverageCheck[];
  /** Rows of `checks` that were not readable records naming a check: counted, and said. */
  unreadRows: number;
  /** The engine's declared limits of checks that did run, per check. */
  limitations: Array<{ check: string; texts: string[] }>;
  notes: string[];
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A non-empty string, else null. */
function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A count: a non-negative safe integer, else null. */
function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * The manifest as the engine sent it, when it is an object; null for anything
 * else (absent, null, a list, text). What the record carries and the status
 * route answers: whole, so a later reader can read more of it than this one.
 */
export function coverageOf(raw: unknown): Record<string, unknown> | null {
  return objectOf(raw);
}

/** A manifest, read (see above); null when the engine sent none, or not an object. */
export function readCoverage(raw: unknown): ScanCoverage | null {
  const manifest = coverageOf(raw);
  if (manifest === null) return null;

  const rows = Array.isArray(manifest.checks) ? manifest.checks : [];
  const checks: CoverageCheck[] = [];
  let unreadRows = 0;
  for (const row of rows) {
    const entry = objectOf(row);
    const check = entry === null ? null : textOf(entry.check);
    const state = entry === null ? null : textOf(entry.state);
    if (entry === null || check === null || state === null) {
      unreadRows += 1;
      continue;
    }
    checks.push({
      check,
      team: textOf(entry.team),
      state,
      reason: textOf(entry.reason),
      detail: textOf(entry.detail),
      probesAttempted: countOf(entry.probes_attempted),
      probesFailed: countOf(entry.probes_failed),
    });
  }

  const limitations: Array<{ check: string; texts: string[] }> = [];
  const declared = objectOf(manifest.limitations);
  if (declared !== null) {
    for (const [check, texts] of Object.entries(declared)) {
      const kept = Array.isArray(texts) ? texts.filter((one): one is string => textOf(one) !== null) : [];
      if (kept.length > 0) limitations.push({ check, texts: kept });
    }
  }

  const notes = Array.isArray(manifest.notes)
    ? manifest.notes.filter((one): one is string => textOf(one) !== null)
    : [];

  return {
    complete: typeof manifest.complete === "boolean" ? manifest.complete : null,
    checks,
    performed: checks.filter((one) => one.state === "performed"),
    degraded: checks.filter((one) => one.state === "degraded"),
    notPerformed: checks.filter((one) => one.state === "not_performed"),
    unmeasured: checks.filter((one) => one.state === "unmeasured"),
    other: checks.filter((one) => !KNOWN_STATES.has(one.state)),
    unreadRows,
    limitations,
    notes,
  };
}

/** The engine's state words this reader groups by (engine/coverage.py). */
const KNOWN_STATES = new Set(["performed", "degraded", "not_performed", "unmeasured"]);
