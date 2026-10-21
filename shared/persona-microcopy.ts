/**
 * LIGHT-persona dashboard microcopy registry.
 *
 * The charter's Surfaces table marks `dashboard microcopy` as the LIGHT persona:
 * "Empty states, progress; dry-minimal allowed." This module is the governed
 * home for that microcopy on the dashboard's NON-finding surfaces only — empty
 * states, progress/loading, and error/retry. Every string here is honest and
 * dry-minimal, and every string passes the persona lint (shared/persona-lint.ts,
 * a transcription of `mythos_core.persona`; canonical source = the charter +
 * `mythos_core.persona`, a fence change MUST be mirrored there).
 *
 * BOUNDARY (charter, held by tests/persona-microcopy.test.ts): persona microcopy
 * is NEVER used on a signed/verifiable surface (signed receipts) or a
 * stop/failsafe/revoke surface. Those stay PLAIN and FIXED, worded in place:
 *   - client/src/components/economics/ReceiptDownload.tsx  (signed receipt)
 *   - client/src/components/NoStopPanel.tsx                (no-stop notice)
 *   - client/src/pages/Failsafe.tsx                        (failsafe console)
 *   - client/src/pages/AIControlPanel.tsx                  (kill switch)
 * Finding titles, finding/verdict values and the not-tested block are likewise
 * not sourced from here. This registry therefore exposes ONLY empty / progress /
 * error groups; it has no signed/stop/finding group by construction.
 *
 * Tone (charter): LIGHT is dry-minimal. No humor on a finding page, no levity on
 * an error, no reassurance the evidence does not support. Banter is allowed only
 * in conversation, empty states and engine cards — so these strings stay plain.
 */

export const microcopy = {
  /** Empty states: a surface with nothing to show yet. */
  empty: {
    /** The generic "there is nothing here yet" line. */
    nothingYet: "Nothing to report yet.",
    /** Nothing has been recorded against this surface yet. */
    noneRecorded: "None recorded yet.",
    /** No activity has happened yet. */
    noActivity: "No activity yet.",
    /** "No <things> found." — for a list that read cleanly and holds nothing. */
    noneFound: (noun: string) => `No ${noun} found.`,
    /** "No <things> defined." — for a configured set that is empty. */
    noneDefined: (noun: string) => `No ${noun} defined.`,
  },

  /** Progress / loading: a source not yet in hand. */
  progress: {
    /** The generic loading line. */
    generic: "Loading…",
    /** A read in progress. */
    reading: "Reading…",
    /** Work in progress with no finer state to report. */
    working: "Working…",
    /** "Loading <subject>…" — a loading line that names its subject. */
    loading: (subject: string) => `Loading ${subject}…`,
  },

  /**
   * Error / retry: a read that failed. Plain and honest — a failed read is not an
   * empty result, and this copy never reassures past what happened.
   */
  error: {
    /** The generic "this could not be read" line. */
    generic: "Could not load this.",
    /** The fallback detail when a thrown error carries no message. */
    requestFailed: "request failed",
    /** A retry affordance's label. */
    retry: "Retry",
    /**
     * "Could not load <what>", optionally with the reason appended. With a reason
     * the line reads "Could not load <what>: <why>"; without one it ends in a period.
     * The <why> is caller-supplied server text, not authored microcopy, so it is
     * not linted here.
     */
    couldNotLoad: (what: string, why?: string) => `Could not load ${what}${why ? `: ${why}` : "."}`,
  },
} as const;

export type Microcopy = typeof microcopy;

/**
 * Every authored microcopy string, with the function entries sampled on benign
 * inputs so their static scaffolding is linted too. The test walks this list and
 * asserts each entry is clean. The sample arguments are themselves lint-clean.
 */
export function allMicrocopyStrings(): string[] {
  return [
    microcopy.empty.nothingYet,
    microcopy.empty.noneRecorded,
    microcopy.empty.noActivity,
    microcopy.empty.noneFound("results"),
    microcopy.empty.noneDefined("roles"),
    microcopy.progress.generic,
    microcopy.progress.reading,
    microcopy.progress.working,
    microcopy.progress.loading("the report"),
    microcopy.error.generic,
    microcopy.error.requestFailed,
    microcopy.error.retry,
    microcopy.error.couldNotLoad("the report"),
    microcopy.error.couldNotLoad("the report", "the server could not be reached"),
  ];
}
