/**
 * Labels by SOURCE for what a surface shows, pinned for the interim before
 * dashboard scans are routed through Athena-Backend (the Option 1 hybrid plan,
 * section 11): by source, never by era or "world".
 *
 * A scan the dashboard dispatches to the engine itself is recorded here, from
 * the engine's own answers, and nowhere else: no backend verdict, claim or
 * report is made about it. The Assurance page reads the backend's record of the
 * assessments the backend launched. The two populations are not reconciled
 * here, and each surface says which one it shows.
 *
 * Each label is one swappable constant, so a later change of source changes
 * the words without touching a layout, and a test holds every one to the
 * persona lint (shared/persona-lint.ts).
 */

/** A scan the dashboard dispatched itself: on both scan pages, the Overview tiles and the coverage panel. */
export const DASHBOARD_DIRECT = "Recorded by this dashboard directly from the engine; not in the Athena-Backend record";

/** The coverage panel's one source line: where this scan's manifest was read from. Swap here, not in the layout. */
export const COVERAGE_SOURCE = `Read directly from the engine for this run. ${DASHBOARD_DIRECT}.`;

/** Every label above, for the lint test (tests/scan-summary-copy-lints-clean.test.ts). */
export function allSourceLabelStrings(): string[] {
  return [DASHBOARD_DIRECT, COVERAGE_SOURCE];
}
