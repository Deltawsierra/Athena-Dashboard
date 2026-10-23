/**
 * Labels by SOURCE for what a surface shows (the Option 1 hybrid plan,
 * section 11): by source, never by era or "world".
 *
 * A scan this dashboard dispatched to the engine itself -- every scan before
 * the hybrid, and none since -- is recorded here, from the engine's own
 * answers, and nowhere else: no backend verdict, claim or report is made about
 * it. A scan started through Athena-Backend (the hybrid) is live-polled from
 * the engine, and its RECORD is Athena-Backend's, collected when the run ends
 * (shared/backend-record.ts). The Assurance page reads the backend's record of
 * the assessments the backend launched. The populations are not reconciled
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

/** A scan started through Athena-Backend: on both scan pages, where the live view and the record each come from. */
export const HYBRID_SOURCE =
  "Started through Athena-Backend; the live view is read directly from the engine, and the record of this scan is Athena-Backend's";

/** Beneath the coverage panel's direct source line for such a scan, until its record is collected. */
export const COVERAGE_RECORD_PENDING = "Not yet in the Athena-Backend record.";

/** The coverage panel's source line once the record is collected: the manifest is the record's. */
export function coverageSourceFromRecord(engineRunId: string | null): string {
  return `From the Athena-Backend record of this scan${engineRunId ? `, engine run ${engineRunId}` : ""}.`;
}

/**
 * The coverage panel's source line and the note beneath it for a scan, by its
 * record's state (shared/backend-record.ts): the record's line once collected;
 * the direct line (COVERAGE_SOURCE, PR #74's, unchanged) with the note "not
 * yet in the record" for a scan started through the backend before that; and
 * the direct line alone for a scan this dashboard dispatched itself.
 */
export function coverageSourceFor(
  backend: { collected: boolean | null; engineRunId: string | null } | null | undefined,
): { source: string; note: string | null } {
  if (!backend) return { source: COVERAGE_SOURCE, note: null };
  if (backend.collected === true) return { source: coverageSourceFromRecord(backend.engineRunId), note: null };
  return { source: COVERAGE_SOURCE, note: COVERAGE_RECORD_PENDING };
}

/** What the Assurance page reads: the backend's record of the assessments the backend launched. */
export const BACKEND_RECORD = "From the Athena-Backend record";

/** Beneath the Overview's headline tiles: which record each of the two counting tiles counts. */
export const OVERVIEW_SOURCES =
  `Open Findings — ${DASHBOARD_DIRECT}. Assurance Decisions — ${BACKEND_RECORD}. ` +
  "The two tiles count separate populations and are not reconciled here.";

/** Beneath the Assurance page's hero, under BACKEND_RECORD. */
export const ASSURANCE_SCOPE =
  "This page describes assessments launched through Athena-Backend. A scan started from this dashboard's " +
  "Athena or Penetration Testing page is not in that record; it is recorded by this dashboard directly from the engine.";

/** Every label above, for the lint test (tests/scan-summary-copy-lints-clean.test.ts). */
export function allSourceLabelStrings(): string[] {
  return [
    DASHBOARD_DIRECT, COVERAGE_SOURCE, BACKEND_RECORD, OVERVIEW_SOURCES, ASSURANCE_SCOPE,
    HYBRID_SOURCE, COVERAGE_RECORD_PENDING, coverageSourceFromRecord("run-1"), coverageSourceFromRecord(null),
  ];
}
