/**
 * Retests the engine is still running, watched until they end -- on the
 * record, so a dashboard that restarts picks each one up again.
 *
 * athena-engine #71 answers a retest it has not finished with 202 and the
 * run's id instead of a verdict (this dashboard asks it to, with
 * `wait_seconds: 0`, so no engine thread is held for the verdict). The verdict
 * is then collected from the engine's `/api/scans/{run_id}`, and this is what
 * collects it: one watch per retest, reading the run's status at a bounded
 * interval for a bounded total time, filing the verdict once if the run
 * completes with one, and filing nothing if it was stopped, failed or ended
 * without one. A watch past its deadline reads once more before it says it is
 * no longer watched -- and when that read fails, tries it again with a growing
 * wait (retestWatch.deadlineReadRetries times) -- so a verdict the engine
 * already has is filed.
 *
 * Each watch is a row in the dashboard's storage (`retest_watches`): the engine
 * run id, the test and twin that name the finding (and the finding, once
 * resolved), who pressed Retest and from where, when, its deadline, the last
 * read, and its state. A dashboard starting up resumes, in the background --
 * trying the read again until it succeeds -- every watch still `running`, and knows every one that ended `unwatched` in
 * the last day -- its run may still be going, and the kill switch sends it a
 * stop by id without reading anything.
 *
 * Filed once, however many dashboards watch: ending a watch and filing its
 * verdict are one storage step that only succeeds while the watch is still
 * `running` (IStorage.endRetestWatch), and a check for an engine run that
 * already has one is refused by a unique index.
 *
 * Nothing here stands in front of a stop, and nothing here holds the event
 * loop. A stop is sent by the retest's engine run id straight to the engine;
 * the routes authorise it from memory (peek) and write nothing before it. The
 * watch writes its row only when something changes (its state, the engine's
 * state, a read error), at most once a minute otherwise, and every write goes
 * through the storage layer, which waits for a lock another connection holds
 * off the event loop (storage-sqlite.ts withBusyRetry): a locked database
 * slows a watch, never a stop.
 */

import * as engine from "./engine";
import { DuplicateRetestCheck, type IStorage, type RetestFiling, type RetestWatchEnd } from "./storage";
import type { RetestWatch } from "@shared/schema";

/** How often a watched retest is read, and for how long in all. Tests shorten these. */
export const retestWatch = {
  intervalMs: 2_000,
  totalMs: 60 * 60_000,
  /** How long a watch that ended `unwatched` is still sent a stop by the kill switch. */
  keepUnwatchedMs: 24 * 60 * 60_000,
  /** How often an unchanged read is written back to the row. */
  persistReadEveryMs: 60_000,
  /** The first wait before a failed resume read is tried again; each failure doubles it, up to resumeRetryMaxMs. */
  resumeRetryMs: 1_000,
  resumeRetryMaxMs: 60_000,
  /** How many more times a watch past its deadline tries its last read when it fails, each after twice the wait of the one before. */
  deadlineReadRetries: 5,
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

/** The phases after which a run does nothing more. `unwatched` is not one: its run may still be going. */
const ENDED: ReadonlySet<string> = new Set(["verdict", "stopped", "failed", "no_verdict"]);

/** Engine states in which a run is still doing something to the target. */
const LIVE_ENGINE_STATES: ReadonlySet<string> = new Set(["queued", "running", "aborting"]);

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
  /** The last known row of every watch this dashboard started, resumed or read and has not seen end. */
  private known = new Map<string, RetestWatch>();
  /** The runs this dashboard is reading now, each by the token of its one read loop. */
  private following = new Map<string, symbol>();
  /** Watches whose row is not written yet; each read tries again. */
  private unrecorded = new Set<string>();
  /** A write of a new watch's row in flight, shared by everything that needs the row to exist. */
  private recording = new Map<string, Promise<boolean>>();
  /** When each watch's read was last written back, so an unchanged read is written at most once a minute. */
  private persistedReadAt = new Map<string, number>();
  /** How many times each watch past its deadline has failed its last read. */
  private deadlineMisses = new Map<string, number>();
  /** Whether the open watches on the record have been read since start-up, and what the reads came to so far. */
  private resumed: { loaded: boolean; failedReads: number; lastError: string | null; nextTryAt: Date | null } = {
    loaded: false, failedReads: 0, lastError: null, nextTryAt: null,
  };
  /** Which resume is reading: a later resume() takes over from an earlier one still trying. */
  private resumeRun = 0;
  private halted = false;

  constructor(private readonly storage: IStorage, private readonly hooks: WatchHooks) {}

  /**
   * Watch a retest the engine answered 202 for. Synchronous: the watch exists
   * in memory -- and its Stop is authorised -- the moment this returns, and
   * the caller answers without waiting on the row, which is written in the
   * background. A run the engine already reports ended is read at once.
   */
  start(input: WatchStart): RetestWatch {
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
      stopUnreadAt: null,
      endedAt: null,
      result: null,
    };
    this.known.set(row.engineRunId, row);
    this.unrecorded.add(row.engineRunId);
    void this.ensureRecorded(row);
    this.follow(row.engineRunId, LIVE_ENGINE_STATES.has(input.engineState) ? retestWatch.intervalMs : 0);
    return row;
  }

  /**
   * Pick up every watch still `running` on the record -- after a restart, or
   * one another dashboard on this database started -- and know every recent
   * `unwatched` one, for the kill switch. In the background: it returns at
   * once and holds up no start-up and no request. A read that fails is said
   * (the log, and resumeState) and tried again, after 1 s, then twice as long
   * each time up to a minute, until it succeeds: a watch is never left
   * unread, its verdict uncollected and its Stop unauthorised, by one failed
   * read. Until it succeeds a retest's Stop is sent for any signed-in user
   * who may run retests (routes.ts), and the kill switch says it could not
   * list the retests.
   */
  resume(): void {
    const run = ++this.resumeRun;
    const attempt = (wait: number) => {
      if (this.halted || run !== this.resumeRun) return;
      void (async () => {
        let rows: RetestWatch[];
        try {
          rows = await this.storage.getOpenRetestWatches(new Date(Date.now() - retestWatch.keepUnwatchedMs));
        } catch (cause) {
          if (this.halted || run !== this.resumeRun) return;
          const next = Math.min(wait, retestWatch.resumeRetryMaxMs);
          this.resumed = {
            loaded: false, failedReads: this.resumed.failedReads + 1, lastError: causeOf(cause), nextTryAt: new Date(Date.now() + next),
          };
          console.error(
            `[retest] the open retest watches could not be read to resume them (read ${this.resumed.failedReads} failed: ` +
            `${causeOf(cause)}); trying again in ${Math.round(next / 100) / 10} s. Until then a retest's Stop is sent for ` +
            "anyone signed in who may run retests, and the kill switch says it could not list the retests.",
          );
          later(() => attempt(Math.min(wait * 2, retestWatch.resumeRetryMaxMs)), next);
          return;
        }
        if (this.resumed.failedReads > 0) {
          console.log(`[retest] the open retest watches were read after ${this.resumed.failedReads} failed read(s): ${rows.length} resumed or known.`);
        }
        this.resumed = { loaded: true, failedReads: this.resumed.failedReads, lastError: null, nextTryAt: null };
        for (const row of rows) {
          if (this.halted) return;
          if (!this.known.has(row.engineRunId)) this.known.set(row.engineRunId, row);
          if (row.state === "running") this.follow(row.engineRunId, 0);
        }
      })();
    };
    setImmediate(() => attempt(retestWatch.resumeRetryMs));
  }

  /** Whether the open watches on the record have been read since start-up; if not, why, and when it is tried next. */
  resumeState(): { loaded: boolean; failedReads: number; lastError: string | null; nextTryAt: Date | null } {
    return { ...this.resumed };
  }

  /** A watch this dashboard knows, from memory: what a Stop is authorised by, without a read. */
  peek(engineRunId: string): RetestWatch | undefined {
    const row = this.known.get(engineRunId);
    return row ? { ...row } : undefined;
  }

  /** The watches this dashboard knows for one test, from memory. */
  knownForTest(testId: string): RetestWatch[] {
    return Array.from(this.known.values()).filter((one) => one.testId === testId).map((one) => ({ ...one }));
  }

  /** A watch by its engine run id: as recorded, or as known here when the record cannot be read or is not written yet. */
  async view(engineRunId: string): Promise<RetestWatch | undefined> {
    const mine = this.known.get(engineRunId);
    if (mine && this.unrecorded.has(engineRunId)) return { ...mine };
    try {
      const row = await this.storage.getRetestWatch(engineRunId);
      if (row) {
        // Memory holds what has not reached the record yet: a stop accepted, or
        // sent with its answer unread, a moment ago.
        return {
          ...row,
          ...(mine?.stopAcceptedAt && !row.stopAcceptedAt ? { stopAcceptedAt: mine.stopAcceptedAt } : {}),
          ...(mine?.stopUnreadAt && !row.stopUnreadAt ? { stopUnreadAt: mine.stopUnreadAt } : {}),
        };
      }
    } catch {
      // Answered from what this dashboard knows.
    }
    return mine ? { ...mine } : undefined;
  }

  /**
   * The watches this dashboard knows may still be running: `running`, and
   * `unwatched` in the last day. The kill switch sends each a stop without
   * reading anything. Older `unwatched` ones are forgotten here.
   */
  running(): RetestWatch[] {
    const since = Date.now() - retestWatch.keepUnwatchedMs;
    const out: RetestWatch[] = [];
    for (const [id, one] of Array.from(this.known.entries())) {
      if (one.state === "unwatched" && (one.endedAt?.getTime() ?? 0) < since) {
        this.known.delete(id);
        continue;
      }
      if (one.state === "running" || one.state === "unwatched") out.push({ ...one });
    }
    return out;
  }

  /**
   * Note that the engine accepted a stop for this run: in memory at once, on
   * the record in the background. Only ever called after the stop was sent,
   * and never awaited by it.
   */
  stopAccepted(engineRunId: string): Promise<string | null> {
    const at = new Date();
    const row = this.known.get(engineRunId);
    if (row) row.stopAcceptedAt = at;
    // What writing the note came to: null when it is on the record (or there
    // is no running watch to note it on), else why not -- the kill switch
    // counts it in its writeFailures.
    return this.storage.updateRunningRetestWatch(engineRunId, { stopAcceptedAt: at }).then(
      () => null,
      (cause) => `the note that the engine accepted the stop of retest run ${engineRunId} could not be written: ${causeOf(cause)}`,
    );
  }

  /**
   * Note that a stop was sent for this run and the engine answered it 2xx,
   * but the rest of its answer was not read: "stop sent, answer unread" --
   * never an accepted stop. In memory at once, on the record in the
   * background. What writing the note came to: null when it is on the record
   * (or there is no running watch to note it on), else why not.
   */
  stopSentUnread(engineRunId: string): Promise<string | null> {
    const at = new Date();
    const row = this.known.get(engineRunId);
    if (row) row.stopUnreadAt = at;
    return this.storage.updateRunningRetestWatch(engineRunId, { stopUnreadAt: at }).then(
      () => null,
      (cause) => `the note that a stop was sent to retest run ${engineRunId}, its answer unread, could not be written: ${causeOf(cause)}`,
    );
  }

  /** Stop reading, as a dashboard that shut down does. Its watches stay on the record for the next to resume. */
  halt(): void {
    this.halted = true;
    this.following.clear();
  }

  /** For tests that reuse one engine run id across cases: forget every watch this dashboard knows. */
  reset(): void {
    this.deadlineMisses.clear();
    this.known.clear();
    this.following.clear();
    this.unrecorded.clear();
    this.recording.clear();
    this.persistedReadAt.clear();
  }

  /** Resolve and keep the finding a new watch is about, off the request's path. Best-effort: filing resolves it again if this did not. */
  async noteFinding(engineRunId: string): Promise<void> {
    const row = this.known.get(engineRunId);
    if (!row || row.findingId) return;
    const found = await this.hooks.resolveFinding(row);
    if ("missing" in found) return;
    row.findingId = found.findingId;
    if (await this.ensureRecorded(row)) {
      await this.storage.updateRunningRetestWatch(engineRunId, { findingId: found.findingId });
    }
  }

  /** Write a new watch's row if it is not written yet. One write in flight per watch; false while it cannot be written. */
  private ensureRecorded(row: RetestWatch): Promise<boolean> {
    const id = row.engineRunId;
    if (!this.unrecorded.has(id)) return Promise.resolve(true);
    const inFlight = this.recording.get(id);
    if (inFlight) return inFlight;
    const attempt = this.storage.createRetestWatch({ ...row })
      .then(() => {
        this.unrecorded.delete(id);
        if (row.lastReadError?.startsWith("this watch could not be recorded yet")) row.lastReadError = null;
        return true;
      }, (cause) => {
        row.lastReadError = unrecordedSentence(cause);
        return false;
      })
      .finally(() => this.recording.delete(id));
    this.recording.set(id, attempt);
    return attempt;
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
    if (!(await this.ensureRecorded(row))) throw new Error(row.lastReadError ?? "this watch could not be recorded yet");
    const ended = await this.storage.endRetestWatch(row.engineRunId, end, filing);
    this.done(row.engineRunId, token);
    this.deadlineMisses.delete(row.engineRunId);
    this.persistedReadAt.delete(row.engineRunId);
    if (ended) {
      const now = { ...row, ...end };
      // An ended watch is read from the record from now on; an unwatched one
      // is kept, for the kill switch.
      if (ENDED.has(now.state)) this.known.delete(row.engineRunId);
      else this.known.set(row.engineRunId, now);
      await this.hooks.recordEnd(now).catch(() => undefined);
    } else {
      await this.endedElsewhere(row, token);
    }
    return ended;
  }

  private async tick(engineRunId: string, token: symbol): Promise<void> {
    if (!this.current(engineRunId, token)) return;
    const row = this.known.get(engineRunId);
    if (!row) return this.done(engineRunId, token);
    try {
      await this.step(row, token);
    } catch (cause) {
      // A write or a filing that failed is said, and tried again: the run's
      // verdict is not lost to one failed write.
      row.lastReadError = causeOf(cause);
      this.again(engineRunId, token);
    }
  }

  /** File a collected verdict and end the watch with it. */
  private async fileVerdict(row: RetestWatch, token: symbol, result: engine.RetestResult, at: Date): Promise<void> {
    // A run the engine accepted a stop for, that completed anyway with a
    // verdict: the run did finish and the engine did decide, so it is filed --
    // and said to have completed despite the stop.
    const despiteStop = row.stopAcceptedAt != null;
    // A stop was sent, but its answer was not read: whether the engine took it
    // is not known, so the verdict is never said to have come despite one --
    // it came after a stop whose answer was not read.
    const afterUnreadStop = !despiteStop && row.stopUnreadAt != null;
    // A verdict whose check the engine filed before a stop landed: the run
    // ended ABORTED, and the verdict stands (engine.retestRun).
    const base: RetestWatchEnd = {
      state: "verdict", engineState: result.stoppedAfterRecording ? "aborted" : "completed",
      reason: result.stoppedAfterRecording ?? null, error: null, endedAt: new Date(),
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
            ...base, findingId,
            result: { ...result, applied: planned.applied, notFiled: null, completedDespiteStop: despiteStop, completedAfterUnreadStop: afterUnreadStop },
          }, planned.filing);
          return;
        } catch (cause) {
          // This engine run already has its check: it is filed, once.
          if (!(cause instanceof DuplicateRetestCheck)) throw cause;
          missing = "a check for this engine run is already on record, so it was not filed again";
        }
      }
    }
    await this.end(row, token, {
      ...base, findingId, result: { ...result, applied: null, notFiled: missing, completedDespiteStop: despiteStop, completedAfterUnreadStop: afterUnreadStop },
    });
  }

  /** End the watch from a status the engine answered, if that status is an end. True when it was. */
  private async endFromStatus(row: RetestWatch, token: symbol, status: engine.RetestStatus, at: Date): Promise<boolean> {
    const { state, reason, error } = status;
    const phase: RetestPhase | null =
      state === "aborted" ? "stopped"
        : state === "failed" ? "failed"
          : engine.RETEST_DONE_STATES.has(state) ? "no_verdict"
            : null;
    if (phase === null) return false;
    await this.end(row, token, {
      state: phase, engineState: state, reason, error, endedAt: new Date(), lastReadAt: at, lastReadError: null, result: null,
    });
    return true;
  }

  /** Write a read back to the row: at once when something changed, otherwise at most once a minute. */
  private async persistRead(row: RetestWatch, token: symbol, changed: boolean): Promise<void> {
    const last = this.persistedReadAt.get(row.engineRunId) ?? 0;
    if (!changed && Date.now() - last < retestWatch.persistReadEveryMs) return;
    if (!(await this.ensureRecorded(row))) return;
    let still: boolean;
    try {
      still = await this.storage.updateRunningRetestWatch(row.engineRunId, {
        engineState: row.engineState, reason: row.reason, error: row.error,
        lastReadAt: row.lastReadAt, lastReadError: row.lastReadError,
      });
    } catch {
      // Not written this time: the next read tries again. The watch goes on.
      return;
    }
    this.persistedReadAt.set(row.engineRunId, Date.now());
    if (!still) await this.endedElsewhere(row, token);
  }

  private async step(row: RetestWatch, token: symbol): Promise<void> {
    const at = new Date();
    const pastDeadline = at.getTime() >= row.deadlineAt.getTime();

    let read: engine.RetestAnswer | null = null;
    let readError: string | null = null;
    try {
      read = await engine.retestRun(row.engineRunId);
    } catch (cause) {
      readError = causeOf(cause);
    }

    if (read?.answer === "verdict") return this.fileVerdict(row, token, read.result, at);
    if (read && (await this.endFromStatus(row, token, read.status, at))) return;

    if (pastDeadline) {
      if (read === null) {
        // The last read failed: a verdict the engine already has must not be
        // lost to one failed read. It is tried again, after twice the wait
        // each time, deadlineReadRetries times, before the watch gives up.
        const misses = (this.deadlineMisses.get(row.engineRunId) ?? 0) + 1;
        if (misses <= retestWatch.deadlineReadRetries) {
          this.deadlineMisses.set(row.engineRunId, misses);
          const changed = row.lastReadError !== readError;
          Object.assign(row, { lastReadAt: at, lastReadError: readError });
          await this.persistRead(row, token, changed);
          if (this.current(row.engineRunId, token)) {
            later(() => void this.tick(row.engineRunId, token), retestWatch.intervalMs * 2 ** misses);
          }
          return;
        }
        readError = `${readError} (the last read, tried ${misses} times past the deadline, failed each time)`;
      }
      this.deadlineMisses.delete(row.engineRunId);
      // The last read found the run not over (or could not read it however
      // often it was tried): the watch stops here, and says so -- never as an outcome.
      await this.end(row, token, {
        state: "unwatched", engineState: read ? read.status.state : row.engineState, reason: row.reason, error: row.error,
        endedAt: at, lastReadAt: at, lastReadError: readError, result: null,
      });
      return;
    }

    if (read === null) {
      // A read that failed is said, and the watch carries on: it is not the
      // run's end, and it is never a verdict.
      const changed = row.lastReadError !== readError;
      Object.assign(row, { lastReadAt: at, lastReadError: readError });
      await this.persistRead(row, token, changed);
      this.again(row.engineRunId, token);
      return;
    }

    const { state, reason, error } = read.status;
    const changed = row.engineState !== state || row.reason !== reason || row.error !== error || row.lastReadError !== null;
    Object.assign(row, { engineState: state, reason, error, lastReadAt: at, lastReadError: null });
    await this.persistRead(row, token, changed);
    this.again(row.engineRunId, token);
  }

  /** The record says this watch has ended -- another dashboard ended it. Stop reading, and forget it here. */
  private async endedElsewhere(row: RetestWatch, token: symbol): Promise<void> {
    this.done(row.engineRunId, token);
    const recorded = await this.storage.getRetestWatch(row.engineRunId).catch(() => undefined);
    if (recorded && ENDED.has(recorded.state)) this.known.delete(row.engineRunId);
    else if (recorded) this.known.set(row.engineRunId, recorded);
  }
}
