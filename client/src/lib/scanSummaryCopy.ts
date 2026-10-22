/**
 * What the two scan screens (Athena, Penetration Testing) say about a run
 * that ended short of completed: aborted, failed or refused.
 *
 * The engine keeps these states apart (athena-engine engine/utils/jobs.py), and
 * the backend refuses a verdict for them; both screens had folded them into one
 * "finished" set with `completed`, and drew a run that was stopped before it
 * started -- no result, so no findings -- as "Clear" with "The scan finished
 * and returned no findings. That is a result, not an absence of one." These
 * are the words that replace that, in one place so the two screens cannot
 * drift, and so a test can hold every one of them to the persona lint
 * (shared/persona-lint.ts): state language only, never a word about the
 * target.
 *
 * Not the LIGHT microcopy registry (shared/persona-microcopy.ts): that is
 * empty / progress / error copy, and by the charter a finding surface's state
 * and verdict words are not sourced from it. These are plain, fixed and linted.
 * The engine's own `reason` and `error` are shown beside them verbatim, and are
 * not authored here.
 */

/** The engine's terminal states short of completed: nothing is derived from a run in one. */
export type EndedState = "aborted" | "failed" | "refused";

const ENDED = new Set<string>(["aborted", "failed", "refused"]);

/** The run's state as one that ended short of completed, or null for any other (running, completed, unknown). */
export function endedState(state: string | undefined | null): EndedState | null {
  return typeof state === "string" && ENDED.has(state) ? (state as EndedState) : null;
}

/** The Risk band's word for such a run, in the muted tone "Not read" and "Not rated" use: never "Clear". */
export const NOT_ASSESSED = "Not assessed";

/** The Risk band's basis beneath it, by how the run ended. */
export const NOT_ASSESSED_BASIS: Record<EndedState, string> = {
  aborted: "The scan was stopped before it finished, so no result and no band is derived from it.",
  failed: "The scan did not complete: the engine reported an error, so no result and no band is derived from it.",
  refused: "The engine refused the scan at preflight, so no result and no band is derived from it.",
};

/** The first sentence of the Findings card's notice, by how the run ended. */
export const ENDED_SENTENCE: Record<EndedState, string> = {
  aborted: "This scan was stopped before it finished.",
  failed: "This scan did not complete: the engine reported an error.",
  refused: "The engine refused this scan at preflight.",
};

/** The second sentence when the run's results were read and hold no finding. */
export const NO_FINDINGS_BEFORE_END =
  "No findings came back before it ended. That is not a result about the target, and nothing is derived from it.";

/** The second sentence when the run's results were read and hold findings: a partial list, said to be one. */
export const FINDINGS_BEFORE_END =
  "The findings listed are what came back before it ended, not a complete assessment of the target.";

/** Labels for the engine's own words, shown verbatim after each. */
export const ENGINE_REASON_LABEL = "Engine reason";
export const ENGINE_ERROR_LABEL = "Engine error";

/** Beside the Retest panel of a run that ended short of completed. */
export const RETEST_AFTER_ENDED =
  "This scan did not complete. A retest here looks again only at a finding it returned before it ended, " +
  "and says nothing about checks that did not run.";

/** Every authored string above, for the lint test (tests/scan-summary-copy-lints-clean.test.ts). */
export function allScanSummaryStrings(): string[] {
  return [
    NOT_ASSESSED,
    ...Object.values(NOT_ASSESSED_BASIS),
    ...Object.values(ENDED_SENTENCE),
    NO_FINDINGS_BEFORE_END,
    FINDINGS_BEFORE_END,
    ENGINE_REASON_LABEL,
    ENGINE_ERROR_LABEL,
    RETEST_AFTER_ENDED,
  ];
}
