/**
 * Athena-Backend's record of a scan started through it (the Option 1 hybrid),
 * beside the live view on both scan pages.
 *
 * Three states, drawn as the server says them (shared/backend-record.ts) and
 * never a fourth guessed: not asked yet, being collected, collected. A record
 * not yet collected shows no verdict; a collected record shows the backend's
 * own status word, verdict and label verbatim -- or, for a run that was
 * stopped or failed, the one pinned sentence "No verdict: the run did not
 * finish." and the record's error message. The engagement line, the PDF
 * link (only when the record has a report) and the Stop's mirror reading
 * follow. Every authored word is in client/src/lib/backendRecordCopy.ts, held
 * to the persona lint by test.
 */
import { ExternalLink, FileText } from "lucide-react";

import { Label, StatusPill, type StatusTone } from "@/components/mythos/atoms";
import {
  BACKEND_RECORD_TITLE, COLLECTING, DIFFERS_FROM_DIRECT, MIRRORED, NOT_MIRRORED, NOT_YET_IN_RECORD, NO_LONGER_ASKED,
  NO_VERDICT_DID_NOT_FINISH, NO_VERDICT_SERVED, PDF_LINK, engagementLine,
} from "@/lib/backendRecordCopy";
import type { BackendRecordView } from "@shared/backend-record";

/** The engine's and the backend's states for a run that did not finish. */
const DID_NOT_FINISH = new Set(["stopped", "failed", "aborted", "refused"]);

/** The pill's tone and words for the record's state: the backend's words where it has them. */
function pillOf(backend: BackendRecordView): { tone: StatusTone; text: string } {
  if (backend.collected === null) return { tone: "neutral", text: "not asked yet" };
  if (backend.collected === false) return { tone: backend.watch === "unwatched" ? "neutral" : "progress", text: backend.watch === "unwatched" ? "no longer asked" : "collecting" };
  if (backend.status !== null && DID_NOT_FINISH.has(backend.status)) return { tone: "neutral", text: backend.status };
  if (backend.verdictLabel !== null || backend.verdict !== null) return { tone: "complete", text: backend.verdictLabel ?? backend.verdict ?? "" };
  return { tone: "neutral", text: backend.status ?? "collected" };
}

/** The host of the scan's target, for the engagement line; null when the target is not a URL. */
function hostOf(target: string | null): string | null {
  if (!target) return null;
  try {
    return new URL(target).hostname || null;
  } catch {
    return null;
  }
}

export default function BackendRecordPanel({ backend, target, className }: {
  backend: BackendRecordView;
  /** The scan's target, for the engagement line's host. */
  target: string | null;
  className?: string;
}) {
  const pill = pillOf(backend);
  const didNotFinish = backend.collected === true && backend.status !== null && DID_NOT_FINISH.has(backend.status);
  const differs = backend.differsFromDirect !== null
    && (backend.differsFromDirect.results === true || backend.differsFromDirect.coverage === true);
  return (
    <section className={className} data-testid="panel-backend-record">
      <div className="flex items-center justify-between gap-3">
        <Label>{BACKEND_RECORD_TITLE}</Label>
        <span data-testid="pill-backend-record"><StatusPill tone={pill.tone}>{pill.text}</StatusPill></span>
      </div>

      {backend.collected === null && (
        <p className="mt-3 text-[13px] text-muted-foreground" data-testid="text-backend-record-state">{NOT_YET_IN_RECORD}</p>
      )}

      {backend.collected === false && (
        <>
          <p className="mt-3 text-[13px] text-muted-foreground" data-testid="text-backend-record-state">
            {backend.watch === "unwatched" ? NO_LONGER_ASKED : COLLECTING}
          </p>
          {/* Where the asking stands, in the server's words: a backend that could not reach the engine, a sign-in it waits on. */}
          {backend.detail && (
            <p className="mt-1 text-[11px] text-muted-foreground" data-testid="text-backend-record-detail">{backend.detail}</p>
          )}
        </>
      )}

      {backend.collected === true && (
        <div className="mt-3 space-y-2 text-[13px]">
          <p data-testid="text-backend-record-state">
            <span className="text-muted-foreground">Status: </span>
            <span className="font-medium text-foreground" data-testid="text-backend-status">{backend.status ?? "unknown"}</span>
            {backend.collectedAt && (
              <span className="text-muted-foreground"> · collected {new Date(backend.collectedAt).toLocaleString()}</span>
            )}
          </p>
          {didNotFinish || (backend.verdict === null && backend.verdictLabel === null) ? (
            <div data-testid="text-backend-verdict">
              <p className="font-medium text-foreground">{didNotFinish ? NO_VERDICT_DID_NOT_FINISH : NO_VERDICT_SERVED}</p>
              {/* The record's error_message, verbatim. */}
              {backend.detail && <p className="mt-1 text-muted-foreground" data-testid="text-backend-error">{backend.detail}</p>}
            </div>
          ) : (
            <p data-testid="text-backend-verdict">
              <span className="text-muted-foreground">Verdict: </span>
              <span className="font-medium text-foreground">{backend.verdict}</span>
              {backend.verdictLabel && backend.verdictLabel !== backend.verdict && (
                <span className="text-muted-foreground"> — {backend.verdictLabel}</span>
              )}
            </p>
          )}
          {backend.engagement && (
            <p className="text-[12px] text-muted-foreground" data-testid="text-backend-engagement">
              {engagementLine(backend.engagement.id ?? backend.engagementId, backend.engagement.name, hostOf(target))}
            </p>
          )}
          {differs && (
            <p className="text-[12px] text-sev-medium" data-testid="text-backend-differs">{DIFFERS_FROM_DIRECT}</p>
          )}
          {backend.pdfUrl && (
            <a
              href={backend.pdfUrl}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-primary hover:underline"
              data-testid="link-backend-pdf"
            >
              <FileText className="h-3.5 w-3.5" />
              {PDF_LINK}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}

      {/* What the Stop's mirror came to, when a Stop was sent from here. */}
      {backend.mirror && (
        <p
          className={backend.mirror.mirrored ? "mt-3 text-[12px] text-muted-foreground" : "mt-3 text-[12px] text-sev-medium"}
          data-testid="text-backend-mirror"
        >
          {backend.mirror.mirrored ? MIRRORED : NOT_MIRRORED}
          {!backend.mirror.mirrored && backend.mirror.detail ? ` ${backend.mirror.detail}` : ""}
        </p>
      )}
    </section>
  );
}
