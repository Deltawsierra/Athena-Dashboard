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

// ==== The ledger re-pointed (PR-C, the Option 1 hybrid, decision 1) ====
//
// Athena-Backend's findings are its record (GET /api/record/clients/:id/findings,
// read as the person); this dashboard's own findings ledger is what it filed
// directly from the engine (findings.source = "dashboard-direct"). Each surface
// shows both under its own label, and never adds them together.

/** The Risks page's own ledger, under PR #74's label: labelled by source, read-only here, never the backend's record. */
export const LEDGER_READ_ONLY =
  "This dashboard's own ledger: filed directly from the engine, labelled by source, read-only here, and never counted as the Athena-Backend record.";
/** The Risks page's backend section: whose findings, read how. */
export const RISKS_BACKEND_SOURCE =
  "Findings in the Athena-Backend record of this client's engagement deployments, read as you; each names the scan it came from.";
export const RISKS_NO_ENGAGEMENT_AT_BACKEND =
  "This client has no Athena-Backend engagement, so there is no backend record for it; one is created the first time a scan starts for the client.";
export const RISKS_BACKEND_EMPTY = "No findings in the Athena-Backend record for this client's deployments.";
export const RISKS_BACKEND_UNREAD = "The Athena-Backend record could not be read";
export const RISKS_BACKEND_READING = "Reading the Athena-Backend record…";
export const SCAN_NOT_YET_ADOPTED = "scan not yet adopted into this dashboard";

/** The Overview's record tiles: three sources, three figures, never one sum. */
export const BACKEND_FINDINGS_LABEL = "Backend record · findings";
export const OWN_FINDINGS_LABEL = "Own record · open findings";
export const ENGINE_LIVE_LABEL = "Engine · live runs";
export const OVERVIEW_RECORD_SOURCES =
  "Backend record findings are counted from Athena-Backend's deployments; this dashboard's own record is its findings ledger, " +
  "filed directly from the engine; the engine's live runs are read from the engine itself. Three figures from three sources, never added together.";
export function backendFindingsSublabel(deployments: number): string {
  return `across ${deployments} deployment${deployments === 1 ? "" : "s"} in the record`;
}
export const BACKEND_FINDINGS_UNREAD = "The record's deployments could not be read";
export const BACKEND_FINDINGS_COUNT_UNREAD = "A deployment's count could not be read";
export const OWN_FINDINGS_SUBLABEL = "Open or in review, across every client";
export const OWN_FINDINGS_UNREAD = "The findings summary could not be read";
export function engineLiveLine(running: number, aborting: number, other: number): string {
  const parts = [`${running} running`, `${aborting} aborting`];
  if (other > 0) parts.push(`${other} in another state`);
  return parts.join(" · ");
}
export const ENGINE_NOT_CONFIGURED = "No engine is configured, so no live run is listed";
export const ENGINE_LIST_UNREAD = "The engine's list of live runs could not be read";

/** The Tests page's source filter. */
export const SOURCE_FILTER_LABEL = "Filter by source";
export const SOURCE_FILTER_ALL = "All sources";
export const SOURCE_FILTER_BACKEND = "Backend record";
export const SOURCE_FILTER_DIRECT = "Recorded directly from the engine";
export const SOURCE_FILTER_NONE = "No engine run";

/** Every label above, for the lint test (tests/scan-summary-copy-lints-clean.test.ts). */
export function allSourceLabelStrings(): string[] {
  return [
    DASHBOARD_DIRECT, COVERAGE_SOURCE, BACKEND_RECORD, OVERVIEW_SOURCES, ASSURANCE_SCOPE,
    HYBRID_SOURCE, COVERAGE_RECORD_PENDING, coverageSourceFromRecord("run-1"), coverageSourceFromRecord(null),
    LEDGER_READ_ONLY, RISKS_BACKEND_SOURCE, RISKS_NO_ENGAGEMENT_AT_BACKEND, RISKS_BACKEND_EMPTY, RISKS_BACKEND_UNREAD,
    RISKS_BACKEND_READING, SCAN_NOT_YET_ADOPTED, BACKEND_FINDINGS_LABEL, OWN_FINDINGS_LABEL, ENGINE_LIVE_LABEL,
    OVERVIEW_RECORD_SOURCES, backendFindingsSublabel(1), backendFindingsSublabel(3), BACKEND_FINDINGS_UNREAD,
    BACKEND_FINDINGS_COUNT_UNREAD, OWN_FINDINGS_SUBLABEL, OWN_FINDINGS_UNREAD, engineLiveLine(1, 0, 0), engineLiveLine(2, 1, 1),
    ENGINE_NOT_CONFIGURED, ENGINE_LIST_UNREAD, SOURCE_FILTER_LABEL, SOURCE_FILTER_ALL, SOURCE_FILTER_BACKEND,
    SOURCE_FILTER_DIRECT, SOURCE_FILTER_NONE,
  ];
}
