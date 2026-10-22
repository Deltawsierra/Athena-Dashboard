/**
 * The words the scan screens' coverage panel (components/ScanCoverage.tsx)
 * says about the engine's per-scan manifest (shared/scan-coverage.ts). In one
 * place so a test can hold every one to the persona lint (shared/persona-lint.ts):
 * they re-express the engine's own states and never re-decide them, and the
 * one state the engine did not send -- no manifest at all -- is said as not
 * known, never as complete. The panel's source line is lib/sourceLabels.ts
 * COVERAGE_SOURCE: one swappable constant.
 *
 * Not the LIGHT microcopy registry (shared/persona-microcopy.ts): by the
 * charter the not-tested block is not sourced from it. These are plain, fixed
 * and linted. The engine's `detail`, `team`, check names and notes are shown
 * verbatim and are not authored here.
 */

export const SCAN_COVERAGE_COPY = {
  heading: "Coverage — what this scan checked, and what it did not",
  lead:
    "A findings list is only as good as the list of questions behind it. This is the engine's own list for " +
    "this scan: which checks ran, and which did not.",
  /** While the run goes on: the engine writes the manifest when the run ends, so there is none to show yet. */
  pending: "Reported by the engine when the run ends.",
  /** No manifest on the record: an older record, or an engine that sent none. Never drawn as complete. */
  notSent:
    "The engine sent no coverage manifest for this scan, so which checks ran is not known from here. " +
    "That is not the same as every check having run.",
  completeTrue: "The engine states this manifest is complete: every check it offers ran and saw what it tried to see.",
  completeFalse:
    "The engine states this manifest is not complete: at least one check did not run, lost probes, or could not " +
    "say what it looked at.",
  completeUnsaid: "The engine did not say whether this manifest is complete.",
  noRows: "The manifest lists no checks.",
  performed: (n: number, total: number) => `${n} of ${total} checks performed`,
  performedHeading: "Performed",
  degradedHeading: "Ran, lost probes",
  notPerformedHeading: "Did not run",
  unmeasuredHeading: "Ran, but did not count its probes",
  otherHeading: "In a state this page does not know",
  limitationsHeading: "Declared limits of checks that did run",
  notesHeading: "Notes from the engine",
  probes: (attempted: number) => `${attempted} ${attempted === 1 ? "probe" : "probes"}`,
  probesLost: (failed: number, attempted: number) => `${failed} of ${attempted} probes lost`,
  unreadRows: (n: number) =>
    `${n} ${n === 1 ? "row" : "rows"} of the manifest could not be read, and ${n === 1 ? "is" : "are"} not listed.`,
} as const;

/**
 * The engine's reason words for a check that did not run, in a reader's words
 * (each is the engine's own gloss in engine/coverage.py). A word not listed here
 * is shown as the engine sent it.
 */
export const COVERAGE_REASON: Record<string, string> = {
  disabled: "switched off in the engine's configuration",
  failed: "the scanner raised an error",
  not_selected: "chaining did not select it",
  not_reached: "the scan ended before it ran",
  interrupted: "the scan stopped during it",
  precondition: "it needed something it did not have",
};

/** Every authored string above, with the function entries sampled on benign inputs, for the lint test. */
export function allScanCoverageStrings(): string[] {
  const c = SCAN_COVERAGE_COPY;
  return [
    c.heading, c.lead, c.pending, c.notSent, c.completeTrue, c.completeFalse, c.completeUnsaid, c.noRows,
    c.performed(2, 6), c.performedHeading, c.degradedHeading, c.notPerformedHeading, c.unmeasuredHeading,
    c.otherHeading, c.limitationsHeading, c.notesHeading, c.probes(1), c.probes(12), c.probesLost(3, 8),
    c.unreadRows(1), c.unreadRows(2),
    ...Object.values(COVERAGE_REASON),
  ];
}
