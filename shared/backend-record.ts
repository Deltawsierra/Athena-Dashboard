/**
 * Athena-Backend's record of a hybrid scan, as the status route answers it
 * beside the live poll (`backend` on GET /api/scans/:testId; server/routes.ts
 * backendRecordView) and as the scan pages read it (client/src/components/
 * BackendRecordPanel.tsx). One shape for both sides, so a state the server
 * does not say cannot be drawn.
 *
 * Three states, and never a fourth guessed:
 *   collected: null  -- not asked yet: no collect watch exists for the row (the
 *                       run has not been seen to end);
 *   collected: false -- the watch is asking the backend, as the person
 *                       (`watch: "running"`), or stopped asking at its deadline
 *                       (`watch: "unwatched"`): no status word beyond pending,
 *                       no verdict, nothing;
 *   collected: true  -- the record: its status word, verdict and label, when it
 *                       was collected, its error message, its engagement, and
 *                       the PDF through this dashboard's relay when it has one.
 * `lastAnswer` and `lastReadError` say where the asking stands, in the
 * backend's words. `mirror` is what a Stop's mirror to the record came to.
 */
import type { BackendMirrorReading } from "./schema";

export interface BackendRecordEngagement {
  id: number | null;
  name: string | null;
  clientName: string | null;
  status: string | null;
}

export interface BackendRecordView {
  scanId: string;
  engagementId: number | null;
  collected: boolean | null;
  watch: "running" | "collected" | "unwatched" | null;
  /** The backend's status word; `pending` while it is asked; null when not asked yet. */
  status: string | null;
  verdict: string | null;
  verdictLabel: string | null;
  /** The record's error_message once collected ("" for none); before that, where the asking stands, in words. */
  detail: string;
  collectedAt: string | null;
  /** This dashboard's relay of the record's PDF (GET /api/scans/:testId/backend-pdf), only when the record has one. */
  pdfUrl: string | null;
  engagement: BackendRecordEngagement | null;
  engineRunId: string | null;
  /** Whether the record's results and coverage differ, byte for byte, from what the direct poll recorded; null when one side recorded none. */
  differsFromDirect: { results: boolean | null; coverage: boolean | null } | null;
  mirror: BackendMirrorReading | null;
  lastAnswer: string | null;
  lastReadAt: string | null;
  lastReadError: string | null;
}

// ==== Retest checks (owner decision 8, the dashboard half) ====

/**
 * One retest check as Athena-Backend serves it (athena-backend
 * assurance/serializers.py RetestCheckSerializer; `FindingSerializer.retest_checks`
 * carries the latest ten): the engine's retest verdict the backend PULLED from
 * the engine with its own operator key and recorded against the finding. A
 * check is NOT closure evidence: it closes nothing, and the finding's `closure`
 * is what a closure stands on. Every field is the backend's word, read by its
 * own field (server/backend-scans.ts readRetestCheck); null where it served none.
 */
export interface RetestCheckView {
  /** The retest run's engine id: the check's unique key at the backend. */
  engineRunId: string;
  scanRecordId: string | null;
  twinId: number | null;
  /** The scan run the retested twin was listed under. */
  twinRunId: string | null;
  /** The verdict as the engine sent it: closed | still_open | inconclusive, or another word. */
  verdict: string | null;
  /** Whether the verdict is one of the three the engine files; false for a word the record does not know. */
  verdictKnown: boolean | null;
  detail: string | null;
  /** completed | aborted (the run ended stopped after its check was recorded). */
  state: string | null;
  stoppedAfterRecording: boolean | null;
  /** ISO 8601, as the backend served them; null when it served none. */
  engineCheckedAt: string | null;
  collectedAt: string | null;
  collectedBy: string | null;
}

/**
 * Where a retest's recording at Athena-Backend stands, as the dashboard files it
 * on the retest watch's row (`retest_watches.result.backend`, server/retest-check-
 * watch.ts) and as the retest views read it. Four states, and never a fifth
 * guessed:
 *   asking        -- the backend is being asked (recorded: null): nothing is
 *                    said to be in the record, and a run the backend has not
 *                    answered for is never read as recorded;
 *   recorded      -- the backend answered 201, or 200 with the row it already
 *                    held (recorded: true): a retest check, not closure evidence;
 *   not_in_record -- the backend answered 404, 409 or 422 (recorded: false), in
 *                    its own words (`detail`); or no backend scan stands behind
 *                    the retested scan (`reason: "dashboard_direct"`) and
 *                    nothing was sent;
 *   unwatched     -- this dashboard stopped asking at its deadline (recorded:
 *                    false): where the asking stood, never an outcome.
 */
export type RetestCheckRecordState = "asking" | "recorded" | "not_in_record" | "unwatched";

export interface RetestCheckRecordView {
  state: RetestCheckRecordState;
  recorded: boolean | null;
  /** The backend's words (verbatim) for its answer, or where the asking stands. */
  detail: string;
  /** Why nothing was sent, when nothing was: "dashboard_direct" for a scan with no backend record. Null otherwise. */
  reason: "dashboard_direct" | null;
  /** The backend's HTTP status for its last answer; null before one, or when nothing was sent. */
  status: number | null;
  /** The backend finding the check was asked of, once one was found in the record. */
  findingUuid: string | null;
  /** The check's unique key at the backend (its `engine_run_id`), once recorded. */
  checkId: string | null;
  /** The check as the backend served it, once recorded. */
  check: RetestCheckView | null;
  /**
   * The last answer, as the watch read it: recorded | existing | running |
   * not_a_verdict | not_in_record | no_finding | unavailable | refused |
   * sign_in_required; null before the first ask.
   */
  lastAnswer: string | null;
  lastAskedAt: string | null;
  lastReadError: string | null;
  startedAt: string;
  deadlineAt: string;
  endedAt: string | null;
  /** What was asked with: the scan run the twin was listed under (`twin_run_id`) and the scan's backend id; null when nothing was sent. */
  twinRunId: string | null;
  backendScanId: string | null;
}
