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
