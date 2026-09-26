/**
 * Retests the engine is still running, watched until they end -- on the
 * record, so a dashboard that restarts picks each one up again.
 *
 * athena-engine #71 answers a retest that outlasts its 30 s inline wait with
 * 202 and the run's id instead of a verdict. The verdict is then collected from
 * the engine's `/api/scans/{run_id}`, and this is what collects it: one watch
 * per retest, reading the run's status at a bounded interval for a bounded
 * total time, filing the verdict once if the run completes with one, and
 * filing nothing if it was stopped, failed or ended without one.
 *
 * Each watch is a row in the dashboard's storage (`retest_watches`): the engine
 * run id, the test and twin that name the finding (and the finding, once
 * resolved), who pressed Retest and from where, when, its deadline, the last
 * read, and its state. A dashboard starting up resumes every watch still
 * `running`, in the background. A watch past its deadline is ended as
 * `unwatched` -- said as that, never as an outcome -- and its run stays on the
 * engine's live list, where Scans running now and the kill switch reach it.
 *
 * Filed once, however many dashboards watch: ending a watch and filing its
 * verdict are one storage step that only succeeds while the watch is still
 * `running` (IStorage.endRetestWatch), and a check for an engine run that
 * already has one is refused by a unique index.
 *
 * Nothing here stands in front of a stop. A stop is sent by the retest's
 * engine run id straight to the engine (POST /api/retests/:runId/abort, the
 * kill switch, a failsafe); none of them reads a watch first, waits on a
 * status read, a resume, or a storage write, or shares a lock or a queue with
 * one. A watch only reads the engine.
 */

import * as engine from "./engine";
import { DuplicateRetestCheck, type IStorage, type RetestFiling, type RetestWatchEnd } from "./storage";
import type { RetestWatch } from "@shared/schema";

/** How often a watched retest is read, and for how long in all. Tests shorten both. */
export const retestWatch = {
  intervalMs: 2_000,
  totalMs: 60 * 60_000,
};

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

/** What filing a verdict came to. */
export interface Applied { findingId: string; status: string; detail: string }

/** A new watch: who asked, for what, and where the engine said the run was. */
export interface WatchStart {
  engineRunId: string;
  testId: string;
  clientId: string;
  twinId: number;
  engagementRef: string | null;
  requestedBy: string | null;
  requestedFrom: string | null;
  engineState: string;
}

/** What the routes supply: how a watch's finding is found, a verdict filed, and an end recorded. */
export interface WatchHooks {
  /** The finding a watch's twin is about; `missing` says why there is none. Throws when it cannot be asked now. */
  resolveFinding(watch: RetestWatch): Promise<{ findingId: string } | { missing: string }>;
  /** The finding's change and its check, for this verdict, filed as the watch's requester. */
  filingFor(watch: RetestWatch, findingId: string, result: engine.RetestResult): Promise<{ filing: RetestFiling; applied: Applied } | { missing: string }>;
  /** Record how a watch ended. Best-effort: a failure changes nothing. */
  recordEnd(watch: RetestWatch): Promise<void>;
}

function causeOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Said of a watch whose row could not be written: it is watched, but a restart would lose it. */
function unrecordedSentence(cause: unknown): string {
  return `this watch could not be recorded yet (${causeOf(cause)}); a restart now would lose it`;
}

function later(fn: () => void, ms: number): void {
  const timer = setTimeout(fn, ms);
  // A watch never keeps the process alive on its own.
  (timer as { unref?: () => void }).unref?.();
}

/** One dashboard's watches. Created with the app (server/routes.ts), and resumed from storage. */
export class RetestWatcher {
  /** The last known row of every watch this dashboard started, resumed or read. */
  private known = new Map<string, RetestWatch>();
  /** The runs this dashboard is reading now, each by the token of its one read loop. */
  private following = new Map<string, symbol>();
  /** Watches whose row could not be written yet; each read tries again. */
  private unrecorded = new Set<string>();
  private halted = false;

  constructor(private readonly storage: IStorage, private readonly hooks: WatchHooks) {}

  /**
   * Watch a retest the engine answered 202 for. The row is written, then the
   * run is read every interval. A row that could not be written is still
   * watched here, and written as soon as a write succeeds.
   */
  async start(input: WatchStart): Promise<RetestWatch> {
    const now = new Date();
    const row: RetestWatch = {
      ...input,
      findingId: null,
      startedAt: now,
      deadlineAt: new Date(now.getTime() + retestWatch.totalMs),
      state: "running",
      reason: null,
      error: null,
      lastReadAt: null,
      lastReadError: null,
      stopAcceptedAt: null,
      endedAt: null,
      result: null,
    };
    this.known.set(row.engineRunId, row);
    try {
      await this.storage.createRetestWatch(row);
    } catch (cause) {
      this.unrecorded.add(row.engineRunId);
      row.lastReadError = unrecordedSentence(cause);
    }
    this.follow(row.engineRunId);
    return row;
  }

  /**
   * Pick up every watch still `running` on the record: after a restart, or
   * one another dashboard on this database started. In the background: it
   * returns at once, holds up no start-up and no request, and a read that
   * fails is logged and tried no further.
   */
  resume(): void {
    setImmediate(() => {
      void (async () => {
        let rows: RetestWatch[];
        try {
          rows = await this.storage.getUnfinishedRetestWatches();
        } catch (cause) {
          console.error(`[retest] the unfinished retest watches could not be read to resume them: ${causeOf(cause)}`);
          return;
        }
        for (const row of rows) {
          if (this.halted) return;
          this.known.set(row.engineRunId, row);
          this.follow(row.engineRunId, 0);
        }
      })();
    });
  }

  /** A watch by its engine run id: as recorded, or as known here when the record cannot be read. */
  async view(engineRunId: string): Promise<RetestWatch | undefined> {
    try {
      const row = await this.storage.getRetestWatch(engineRunId);
      if (row) {
        if (!this.unrecorded.has(engineRunId)) this.known.set(engineRunId, row);
        return row;
      }
    } catch {
      // Answered from what this dashboard knows.
    }
    return this.known.get(engineRunId);
  }

  /** The watches this dashboard knows may still be running: the kill switch sends each a stop without reading anything. */
  running(): RetestWatch[] {
    return Array.from(this.known.values()).filter((one) => one.state === "running" || one.state === "unwatched");
  }

  /** Note, after the fact, that the engine accepted a stop for this run. Never before, and never in its way. */
  stopAccepted(engineRunId: string): void {
    const at = new Date();
    const row = this.known.get(engineRunId);
    if (row) row.stopAcceptedAt = at;
    void this.storage.updateRunningRetestWatch(engineRunId, { stopAcceptedAt: at }).catch(() => undefined);
  }

  /** For tests that reuse one engine run id across cases: forget every watch this dashboard knows. */
  reset(): void {
    this.known.clear();
    this.following.clear();
    this.unrecorded.clear();
  }

  /** Stop reading, as a dashboard that shut down does. Its watches stay on the record for the next to resume. */
  halt(): void {
    this.halted = true;
    this.following.clear();
  }

  private follow(engineRunId: string, delay = retestWatch.intervalMs): void {
    if (this.halted || this.following.has(engineRunId)) return;
    const token = Symbol(engineRunId);
    this.following.set(engineRunId, token);
    later(() => void this.tick(engineRunId, token), delay);
  }

  /** Whether this loop is still the one reading this run: one loop per run, never two. */
  private current(engineRunId: string, token: symbol): boolean {
    return !this.halted && this.following.get(engineRunId) === token;
  }

  private again(engineRunId: string, token: symbol): void {
    if (!this.current(engineRunId, token)) return;
    later(() => void this.tick(engineRunId, token), retestWatch.intervalMs);
  }

  private done(engineRunId: string, token: symbol): void {
    if (this.following.get(engineRunId) === token) this.following.delete(engineRunId);
  }

  /** End the watch on the record, filing with it when there is a filing. False when it had already ended. */
  private async end(row: RetestWatch, token: symbol, end: RetestWatchEnd, filing?: RetestFiling): Promise<boolean> {
    if (this.unrecorded.has(row.engineRunId)) {
      await this.storage.createRetestWatch(row);
      this.unrecorded.delete(row.engineRunId);
    }
    const ended = await this.storage.endRetestWatch(row.engineRunId, end, filing);
    this.done(row.engineRunId, token);
    if (ended) {
      const now = { ...row, ...end };
      this.known.set(row.engineRunId, now);
      await this.hooks.recordEnd(now).catch(() => undefined);
    } else {
      // Ended by another dashboard on this record: read what it came to.
      const recorded = await this.storage.getRetestWatch(row.engineRunId).catch(() => undefined);
      if (recorded) this.known.set(row.engineRunId, recorded);
    }
    return ended;
  }

  private async tick(engineRunId: string, token: symbol): Promise<void> {
    if (!this.current(engineRunId, token)) return;
    const row = this.known.get(engineRunId);
    if (!row) return this.done(engineRunId, token);
    let notRecorded: unknown = null;
    try {
      if (this.unrecorded.has(engineRunId)) {
        await this.storage.createRetestWatch(row);
        this.unrecorded.delete(engineRunId);
        row.lastReadError = null;
      }
    } catch (cause) {
      // Tried again on the next read, and said until it succeeds.
      notRecorded = cause;
    }
    try {
      await this.step(row, token);
      if (notRecorded !== null && this.unrecorded.has(engineRunId)) row.lastReadError = unrecordedSentence(notRecorded);
    } catch (cause) {
      // A write or a filing that failed is said, and tried again: the run's
      // verdict is not lost to one failed write.
      row.lastReadError = causeOf(cause);
      this.again(engineRunId, token);
    }
  }

  private async step(row: RetestWatch, token: symbol): Promise<void> {
    const at = new Date();
    if (at.getTime() >= row.deadlineAt.getTime()) {
      await this.end(row, token, {
        state: "unwatched", engineState: row.engineState, reason: row.reason, error: row.error, endedAt: at, result: null,
      });
      return;
    }

    let read: engine.RetestAnswer;
    try {
      read = await engine.retestRun(row.engineRunId);
    } catch (cause) {
      // A read that failed is said, and the watch carries on: it is not the
      // run's end, and it is never a verdict.
      row.lastReadAt = at;
      row.lastReadError = causeOf(cause);
      const still = await this.storage.updateRunningRetestWatch(row.engineRunId, { lastReadAt: at, lastReadError: row.lastReadError })
        .catch(() => true);
      if (still || this.unrecorded.has(row.engineRunId)) this.again(row.engineRunId, token);
      else await this.endedElsewhere(row, token);
      return;
    }

    if (read.answer === "verdict") {
      const result = read.result;
      const base: RetestWatchEnd = {
        state: "verdict", engineState: "completed", reason: null, error: null, endedAt: new Date(),
        lastReadAt: at, lastReadError: null, result: null,
      };
      let findingId = row.findingId;
      let missing: string | null = null;
      if (!findingId) {
        const found = await this.hooks.resolveFinding(row);
        if ("missing" in found) missing = found.missing;
        else findingId = found.findingId;
      }
      if (findingId) {
        const planned = await this.hooks.filingFor(row, findingId, result);
        if ("missing" in planned) missing = planned.missing;
        else {
          try {
            await this.end(row, token, {
              ...base, findingId, result: { ...result, applied: planned.applied, notFiled: null },
            }, planned.filing);
            return;
          } catch (cause) {
            // This engine run already has its check: it is filed, once.
            if (!(cause instanceof DuplicateRetestCheck)) throw cause;
            missing = "a check for this engine run is already on record, so it was not filed again";
          }
        }
      }
      await this.end(row, token, { ...base, findingId, result: { ...result, applied: null, notFiled: missing } });
      return;
    }

    const { state, reason, error } = read.status;
    const end = (phase: RetestPhase) =>
      this.end(row, token, { state: phase, engineState: state, reason, error, endedAt: new Date(), lastReadAt: at, lastReadError: null, result: null });
    if (state === "aborted") return void (await end("stopped"));
    if (state === "failed") return void (await end("failed"));
    if (engine.RETEST_DONE_STATES.has(state)) return void (await end("no_verdict"));

    Object.assign(row, { engineState: state, reason, error, lastReadAt: at, lastReadError: null });
    const still = await this.storage.updateRunningRetestWatch(row.engineRunId, {
      engineState: state, reason, error, lastReadAt: at, lastReadError: null,
    });
    if (still || this.unrecorded.has(row.engineRunId)) this.again(row.engineRunId, token);
    else await this.endedElsewhere(row, token);
  }

  /** The record says this watch has ended -- another dashboard ended it. Stop reading, and know what it came to. */
  private async endedElsewhere(row: RetestWatch, token: symbol): Promise<void> {
    this.done(row.engineRunId, token);
    const recorded = await this.storage.getRetestWatch(row.engineRunId).catch(() => undefined);
    if (recorded) this.known.set(row.engineRunId, recorded);
  }

  /** Resolve and keep the finding a new watch is about, off the request's path. Best-effort: filing resolves it again if this did not. */
  async noteFinding(engineRunId: string): Promise<void> {
    const row = this.known.get(engineRunId);
    if (!row || row.findingId) return;
    const found = await this.hooks.resolveFinding(row);
    if ("missing" in found) return;
    row.findingId = found.findingId;
    await this.storage.updateRunningRetestWatch(engineRunId, { findingId: found.findingId });
  }
}
