/**
 * What this scan checked, and what it did not: the engine's per-scan coverage
 * manifest (shared/scan-coverage.ts), drawn beside the findings on both scan
 * screens.
 *
 * It mirrors the Assurance page's CoverageManifestPanel in shape, and is a
 * different thing: that one is the backend's manifest for a deployment the
 * backend assessed; this is the ENGINE's manifest for THIS scan, the run the
 * dashboard dispatched. The two populations are not conflated, and the panel
 * says its source in one line (lib/sourceLabels.ts COVERAGE_SOURCE) that a
 * later change of source swaps without touching this layout.
 *
 * The one rule that matters: a scan whose record carries no manifest -- an
 * older record, or an engine that sent none -- says so, and is never drawn as
 * complete. `complete` is the engine's own word, verbatim; nothing here
 * decides it. Rows are grouped by the engine's own state word, a row in a
 * state this page does not know is shown under that word, and a row that
 * could not be read is counted and said, never dropped. While the run goes
 * on there is no manifest yet -- the engine writes it when the run ends --
 * and the panel says that, not "none was sent".
 */
import { ShieldQuestion } from "lucide-react";

import { readCoverage, type CoverageCheck } from "@shared/scan-coverage";
import { COVERAGE_REASON, SCAN_COVERAGE_COPY as COPY } from "@/lib/scanCoverageCopy";
import { COVERAGE_SOURCE } from "@/lib/sourceLabels";
import { cn } from "@/lib/utils";

function CheckRows({ rows, tone, testId }: { rows: CoverageCheck[]; tone: string; testId: string }) {
  return (
    <ul className="mt-1 space-y-1" data-testid={testId}>
      {rows.map((row) => (
        <li key={row.check} className="text-[12px] leading-snug">
          <span className={cn("font-medium", tone)}>{row.check}</span>
          {row.team !== null && <span className="athena-mono text-[11px] text-muted-foreground"> {row.team}</span>}
          {row.reason !== null && (
            <span className="text-muted-foreground"> — {COVERAGE_REASON[row.reason] ?? row.reason}</span>
          )}
          {row.probesAttempted !== null && row.probesFailed !== null && row.probesFailed > 0 && (
            <span className="text-muted-foreground"> ({COPY.probesLost(row.probesFailed, row.probesAttempted)})</span>
          )}
          {row.probesAttempted !== null && (row.probesFailed === null || row.probesFailed === 0) && row.probesAttempted > 0 && (
            <span className="text-muted-foreground"> ({COPY.probes(row.probesAttempted)})</span>
          )}
          {row.detail !== null && <p className="text-muted-foreground">{row.detail}</p>}
        </li>
      ))}
    </ul>
  );
}

function Group({ heading, tone, rows, testId }: { heading: string; tone: string; rows: CoverageCheck[]; testId: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3">
      <p className={cn("text-[10px] font-semibold uppercase tracking-wide", tone)}>{heading}</p>
      <CheckRows rows={rows} tone={tone} testId={testId} />
    </div>
  );
}

/**
 * The engine's manifest for this scan, as recorded (`coverage` on
 * GET /api/scans/:testId); anything not an object is none. `running`: the run
 * has not ended, so no manifest exists yet.
 */
export default function ScanCoverage({ coverage, running = false, source = COVERAGE_SOURCE, note = null, className }: {
  coverage: unknown;
  running?: boolean;
  /** Where the manifest was read from (lib/sourceLabels.ts): the direct line unless the page says the record's. */
  source?: string;
  /** Beneath the source line (lib/sourceLabels.ts coverageSourceFor): that the record is not collected yet, when it is not. */
  note?: string | null;
  className?: string;
}) {
  const read = readCoverage(coverage);
  return (
    <section className={className} data-testid="panel-scan-coverage">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="h-4 w-4 shrink-0 text-primary" />
        <p className="athena-label">{COPY.heading}</p>
      </div>
      {/* The one source line: swap lib/sourceLabels.ts COVERAGE_SOURCE, not this layout. */}
      <p className="mt-1 text-[11px] text-muted-foreground" data-testid="text-coverage-source">{source}</p>
      {note && <p className="text-[11px] text-muted-foreground" data-testid="text-coverage-record">{note}</p>}

      {running ? (
        <p className="mt-3 text-[13px] text-muted-foreground" data-testid="text-coverage-pending">{COPY.pending}</p>
      ) : read === null ? (
        // No manifest on the record. Not "every check ran": not known, and said so.
        <p className="mt-3 text-[13px] text-muted-foreground" data-testid="text-coverage-not-sent">{COPY.notSent}</p>
      ) : (
        <>
          <p className="mt-2 text-[11px] text-muted-foreground">{COPY.lead}</p>

          {/* The engine's own flag, verbatim: true, false, or not said. */}
          <p
            className={cn(
              "mt-3 text-[13px] font-medium",
              read.complete === true ? "text-primary" : read.complete === false ? "text-sev-medium" : "text-muted-foreground",
            )}
            data-testid="text-coverage-complete"
          >
            {read.complete === true ? COPY.completeTrue : read.complete === false ? COPY.completeFalse : COPY.completeUnsaid}
          </p>

          {read.checks.length === 0 ? (
            <p className="mt-2 text-[12px] text-muted-foreground" data-testid="text-coverage-no-rows">{COPY.noRows}</p>
          ) : (
            <>
              <p className="mt-2 text-[12px] text-foreground" data-testid="text-coverage-performed">
                {COPY.performed(read.performed.length, read.checks.length)}
              </p>
              <Group heading={COPY.performedHeading} tone="text-foreground" rows={read.performed} testId="list-coverage-performed" />
              <Group heading={COPY.degradedHeading} tone="text-sev-medium" rows={read.degraded} testId="list-coverage-degraded" />
              <Group heading={COPY.notPerformedHeading} tone="text-sev-medium" rows={read.notPerformed} testId="list-coverage-not-performed" />
              <Group heading={COPY.unmeasuredHeading} tone="text-muted-foreground" rows={read.unmeasured} testId="list-coverage-unmeasured" />
              <Group heading={COPY.otherHeading} tone="text-muted-foreground" rows={read.other} testId="list-coverage-other" />
            </>
          )}

          {read.unreadRows > 0 && (
            <p className="mt-2 text-[12px] text-sev-medium" data-testid="text-coverage-unread-rows">
              {COPY.unreadRows(read.unreadRows)}
            </p>
          )}

          {read.limitations.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{COPY.limitationsHeading}</p>
              <ul className="mt-1 space-y-1" data-testid="list-coverage-limitations">
                {read.limitations.map(({ check, texts }) => (
                  <li key={check} className="text-[12px] leading-snug">
                    <span className="font-medium text-foreground">{check}</span>
                    {texts.map((text) => (
                      <p key={text} className="text-muted-foreground">{text}</p>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {read.notes.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{COPY.notesHeading}</p>
              <ul className="mt-1 space-y-1" data-testid="list-coverage-notes">
                {read.notes.map((note) => (
                  <li key={note} className="text-[12px] leading-snug text-muted-foreground">{note}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
