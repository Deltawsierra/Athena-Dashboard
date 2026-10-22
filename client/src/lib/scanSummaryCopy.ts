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
 * The form is the one pinned for the interim labelling: "The scan did not
 * finish: <engine reason>." followed by what the page holds -- no band, no
 * shield. The lint forbids the word "clean" on a finding surface, so the second
 * sentence says "Nothing here is a result." rather than "a clean result".
 *
 * Not the LIGHT microcopy registry (shared/persona-microcopy.ts): that is
 * empty / progress / error copy, and by the charter a finding surface's state
 * and verdict words are not sourced from it. These are plain, fixed and linted.
 * The engine's own `reason` and `error` are shown verbatim, and are not
 * authored here.
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

/** The Risk band's basis beneath it. */
export const NOT_ASSESSED_BASIS = "The scan did not finish, so no result and no band is derived from it.";

/** How the run ended, in the page's words, for when the engine gave no reason or error of its own. */
export const ENDED_HOW: Record<EndedState, string> = {
  aborted: "it was stopped before it finished",
  failed: "the engine reported an error",
  refused: "the engine refused it at preflight",
};

/**
 * "The scan did not finish: <engine reason>." -- `said` is the engine's own
 * reason or error, verbatim, when it sent one; else how the run ended by state.
 */
export function notFinished(state: EndedState, said: string | null): string {
  return `The scan did not finish: ${said ?? ENDED_HOW[state]}.`;
}

/** After it, when the run's results were read and hold no finding. */
export const NOTHING_HERE_IS_A_RESULT = "Nothing here is a result.";

/** After it, when the run's results were read and hold findings: a partial list, said to be one. */
export const FINDINGS_BEFORE_END = "The findings listed came back before it ended; nothing here is a complete result.";

/** Label for the engine's stored error, shown verbatim after it, when its `reason` already stands in the sentence. */
export const ENGINE_ERROR_LABEL = "Engine error";

/** Beside the Retest panel of a run that ended short of completed. */
export const RETEST_AFTER_ENDED =
  "This scan did not finish. A retest here looks again only at a finding it returned before it ended, " +
  "and says nothing about checks that did not run.";

/** Every authored string above, for the lint test (tests/scan-summary-copy-lints-clean.test.ts). */
export function allScanSummaryStrings(): string[] {
  return [
    NOT_ASSESSED,
    NOT_ASSESSED_BASIS,
    ...Object.values(ENDED_HOW),
    notFinished("aborted", null),
    notFinished("failed", null),
    notFinished("refused", null),
    NOTHING_HERE_IS_A_RESULT,
    FINDINGS_BEFORE_END,
    ENGINE_ERROR_LABEL,
    RETEST_AFTER_ENDED,
  ];
}
