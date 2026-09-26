/**
 * Retests the engine is still running, watched until they end.
 *
 * athena-engine #71 answers a retest that outlasts its 30 s inline wait with
 * 202 and the run's id instead of a verdict. The verdict is then collected from
 * the engine's `/api/scans/{run_id}`, and this is what collects it: one watcher
 * per retest, reading the run's status at a bounded interval for a bounded
 * total time, filing the verdict once if the run completes with one, and
 * filing nothing if it was stopped, failed or ended without one.
 *
 * Nothing here stands in front of a stop. A stop is sent by the retest's
 * engine run id straight to the engine (POST /api/retests/:runId/abort, the
 * kill switch, a failsafe); none of them reads this map first, waits on a
 * status read, or shares a lock or a queue with one. A watcher only ever reads.
 *
 * The map lives in this process. A dashboard that restarts forgets the retests
 * it was watching: their runs go on, are still on the engine's live list (so
 * "Scans running now" and the kill switch still reach them), and their verdicts
 * land in the engine's own remediation record -- but not in this dashboard's
 * findings, and the poll route answers that it is not watching them.
 */

import * as engine from "./engine";

/** How often a watched retest is read, and for how long in all. Tests shorten both. */
export const retestWatch = {
  intervalMs: 2_000,
  totalMs: 60 * 60_000,
};

/** How many ended retests are remembered for the page to read their outcome. */
const KEEP_ENDED = 200;

/**
 * Where a watched retest is, as the dashboard says it:
 *   running    -- the engine last said queued, running or aborting;
 *   verdict    -- it completed with a verdict, which was filed (or said why not);
 *   stopped    -- it was stopped: no verdict, nothing filed;
 *   failed     -- the engine recorded it failed: no verdict, nothing filed;
 *   no_verdict -- it completed without a verdict: nothing filed;
 *   unwatched  -- the watch ran out of time with the run not over.
 */
export type RetestPhase = "running" | "verdict" | "stopped" | "failed" | "no_verdict" | "unwatched";

/** What filing a verdict came to (server/routes.ts fileRetestVerdict). */
export interface Applied { findingId: string; status: string; detail: string }

export interface WatchedRetest {
  engineRunId: string;
  testId: string;
  twinId: number;
  phase: RetestPhase;
  /** The engine's own state for the run, as last read. */
  engineState: string;
  reason: string | null;
  error: string | null;
  /** Why the last status read failed, when it did; the watch carries on. */
  lastReadError: string | null;
  startedAt: string;
  /** When a Stop sent from this dashboard by this run's id was accepted. */
  stopAcceptedAt: string | null;
  /** The verdict, once the run completed with one. */
  result: (engine.RetestResult & { applied: Applied | null; notFiled: string | null }) | null;
}

/** Files a collected verdict; answers what it came to. */
export type FileVerdict = (result: engine.RetestResult) => Promise<{ applied: Applied | null; notFiled: string | null }>;
/** Records how a watched retest ended. Best-effort: a failure changes nothing. */
export type RecordEnd = (watched: WatchedRetest) => Promise<void>;

const watched = new Map<string, WatchedRetest>();

function causeOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function forgetOldest(): void {
  if (watched.size <= KEEP_ENDED) return;
  for (const id of Array.from(watched.keys())) {
    if (watched.size <= KEEP_ENDED) return;
    if (watched.get(id)?.phase !== "running") watched.delete(id);
  }
}

function later(fn: () => void, ms: number): void {
  const timer = setTimeout(fn, ms);
  // A watch never keeps the process alive on its own.
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Watch a retest the engine answered 202 for, until it ends or the watch runs
 * out of time. Returns at once; the first read is one interval away.
 */
export function watch(
  start: { engineRunId: string; testId: string; twinId: number; engineState: string },
  file: FileVerdict,
  recordEnd: RecordEnd,
): WatchedRetest {
  const entry: WatchedRetest = {
    ...start,
    phase: "running",
    reason: null,
    error: null,
    lastReadError: null,
    startedAt: new Date().toISOString(),
    stopAcceptedAt: null,
    result: null,
  };
  watched.set(start.engineRunId, entry);
  forgetOldest();
  const deadline = Date.now() + retestWatch.totalMs;

  const end = (phase: RetestPhase) => {
    entry.phase = phase;
    void recordEnd(entry).catch(() => undefined);
  };

  const tick = async (): Promise<void> => {
    // A watch replaced (the same run watched again) or forgotten reads no more.
    if (watched.get(start.engineRunId) !== entry) return;
    if (Date.now() >= deadline) return end("unwatched");
    let read: engine.RetestAnswer;
    try {
      read = await engine.retestRun(start.engineRunId);
    } catch (cause) {
      // A read that failed is said, and the watch carries on: it is not the
      // run's end, and it is never a verdict.
      entry.lastReadError = causeOf(cause);
      return later(() => void tick(), retestWatch.intervalMs);
    }
    entry.lastReadError = null;
    if (read.answer === "verdict") {
      entry.engineState = "completed";
      let filed: { applied: Applied | null; notFiled: string | null };
      try {
        filed = await file(read.result);
      } catch (cause) {
        filed = { applied: null, notFiled: causeOf(cause) };
      }
      entry.result = { ...read.result, ...filed };
      return end("verdict");
    }
    const { state, reason, error } = read.status;
    entry.engineState = state;
    entry.reason = reason;
    entry.error = error;
    if (state === "aborted") return end("stopped");
    if (state === "failed") return end("failed");
    if (engine.RETEST_DONE_STATES.has(state)) return end("no_verdict");
    later(() => void tick(), retestWatch.intervalMs);
  };

  later(() => void tick(), retestWatch.intervalMs);
  return entry;
}

/** A watched retest by its engine run id, or undefined. */
export function get(engineRunId: string): WatchedRetest | undefined {
  return watched.get(engineRunId);
}

/** The retests still being watched as running: their run ids are stoppable by the kill switch without any read. */
export function running(): WatchedRetest[] {
  return Array.from(watched.values()).filter((one) => one.phase === "running" || one.phase === "unwatched");
}

/** Note that the engine accepted a stop for this run. In memory; it cannot fail, and it is written after the stop. */
export function stopAccepted(engineRunId: string): void {
  const entry = watched.get(engineRunId);
  if (entry) entry.stopAcceptedAt = new Date().toISOString();
}

/** For tests: forget every watch; each stops at its next read. */
export function reset(): void {
  watched.clear();
}
