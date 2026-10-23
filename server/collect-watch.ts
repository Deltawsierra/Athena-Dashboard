/**
 * A scan started through Athena-Backend whose engine run has ended, watched
 * until the backend has collected its record -- on the record here, so a
 * dashboard that restarts picks each one up again (the Option 1 hybrid; the
 * pattern is server/retests.ts).
 *
 * The live poll (`GET /api/scans/:testId`) reads the run straight from the
 * engine, as it always did. When it first sees a finished state for a row that
 * names a backend scan (shared/engine-record.ts backendScanIdOf), it starts one
 * of these: a watch that asks the backend to collect the run's end
 * (`POST /api/pentest/scans/<uuid>/collect/`, PR-A) at a bounded interval, for
 * a bounded total, until the backend answers with the record (200), or says the
 * record already stands (409 -- it is then read), and files that record into
 * the scan's row ONCE: the backend's status word, verdict and label, when it
 * was collected and its error message (`findings.backend`, shared/schema.ts
 * BackendRecordSnapshot), and the run's results and coverage as the RECORD
 * holds them (`engine_response`), which from then on are what the page shows.
 * A pending answer (202), the backend unable to reach the engine (503), a
 * refusal, or a person with no backend sign-in keep the watch going: none of
 * them is ever read as collected, and no verdict comes from silence. A watch
 * past its deadline says it is no longer watched -- never an outcome -- and the
 * backend's own collector is the backstop.
 *
 * WHO ASKS: every collect goes as a PERSON, with their own backend sign-in
 * (server/person-credential.ts runAsPerson, decision 8), never the service
 * account. A watch holds, in this process's memory only, the session of the
 * person whose page read started it, and of every later signed-in read while
 * it runs (`adopt`). A dashboard that restarts holds no session until a person
 * reads the scan again: the resumed watch says so (`sign_in_required`) and
 * collects on the first read after that.
 *
 * Each watch is a row in storage (`collect_watches`): the backend scan, the
 * test, the run, when it started, its deadline, the last answer and read, and
 * its state. A dashboard starting up resumes every watch still `running`, in
 * the background, trying the read again until it succeeds. Filed once, however
 * many dashboards watch: ending a watch is one storage step that only succeeds
 * while the watch is still `running` (IStorage.endCollectWatch), and only the
 * dashboard whose claim succeeds files the record into the row.
 *
 * Nothing here is on a stop's path: the engine's abort is the stop, sent
 * directly by the routes; this asks the backend for what the engine already
 * holds, after the run has ended, and the stop mirror (server/backend-scans.ts
 * mirrorStop) is a different thing, sent by the stop routes after their
 * answer. Nothing here holds the event loop, and nothing here files into this
 * dashboard's own findings ledger: a hybrid scan's record is the backend's.
 */

import * as backendScans from "./backend-scans";
import { ControlPlaneRefused, ControlPlaneSignInRequired } from "./control-plane";
import { PersonSignInRequired, runAsPerson } from "./person-credential";
import type { CollectWatchEnd, IStorage } from "./storage";
import type { CollectWatch } from "@shared/schema";

/** How often the backend is asked, and for how long in all. Tests shorten these. */
export const collectWatch = {
  intervalMs: 2_000,
  totalMs: 60 * 60_000,
  /** How often an unchanged answer is written back to the row. */
  persistReadEveryMs: 60_000,
  /** The first wait before a failed resume read is tried again; each failure doubles it, up to resumeRetryMaxMs. */
  resumeRetryMs: 1_000,
  resumeRetryMaxMs: 60_000,
};

/**
 * The backend's last answer to a collect, as the row records it:
 *   pending          -- 202: the backend read the run and it was not over yet;
 *   collected        -- 200: the backend collected the run's end into its record;
 *   conflict         -- 409: the record already stands (collected by the backend's
 *                       own collector or another dashboard, or it names no run), and
 *                       was read; a record still pending at that moment is asked again;
 *   unavailable      -- 503, or an answer in no shape this reads, or no answer at all;
 *   refused          -- 403 or 404: the person asking may not collect, or cannot see, this scan;
 *   sign_in_required -- the person asking holds no backend sign-in, or no person is
 *                       asking (a restarted dashboard, until someone reads the scan).
 */
export type CollectLastAnswer = "pending" | "collected" | "conflict" | "unavailable" | "refused" | "sign_in_required";

/** A new watch: the scan the backend holds, the row here, the run, and the session of the person whose read started it. */
export interface CollectStart {
  backendScanId: string;
  testId: string;
  engineRunId: string | null;
  sessionId: string | null;
}

/** What the routes supply: how a collected record is filed into the row, and how an end is recorded. */
export interface CollectHooks {
  /** File the record into the scan's row. Called once, by the dashboard whose claim succeeded. */
  fileRecord(watch: CollectWatch, record: backendScans.BackendScanRecord): Promise<void>;
  /** Record how a watch ended. Best-effort: a failure changes nothing. */
  recordEnd(watch: CollectWatch): Promise<void>;
}

function causeOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const UNRECORDED = "this watch could not be recorded yet";

/** Said of a watch whose row could not be written: it is watched, but a restart would lose it. */
function unrecordedSentence(cause: unknown): string {
  return `${UNRECORDED} (${causeOf(cause)}); a restart now would lose it`;
}

function later(fn: () => void, ms: number): void {
  const timer = setTimeout(fn, ms);
  // A watch never keeps the process alive on its own.
  (timer as { unref?: () => void }).unref?.();
}

/** One ask of the backend: what it answered, the record when there is one to file, and why not. */
interface Asked {
  lastAnswer: CollectLastAnswer;
  record: backendScans.BackendScanRecord | null;
  readError: string | null;
}

/** One dashboard's collect watches. Created with the app (server/routes.ts), and resumed from storage. */
export class CollectWatcher {
  /** The last known row of every watch this dashboard started or resumed and has not seen end. */
  private known = new Map<string, CollectWatch>();
  /** The scans this dashboard is asking about now, each by the token of its one loop. */
  private following = new Map<string, symbol>();
  /** Watches whose row is not written yet; each tick tries again. */
  private unrecorded = new Set<string>();
  /** A write of a new watch's row in flight, shared by everything that needs the row to exist. */
  private recording = new Map<string, Promise<boolean>>();
  /** When each watch's answer was last written back, so an unchanged answer is written at most once a minute. */
  private persistedReadAt = new Map<string, number>();
  /** The session of the person each watch asks as: the last signed-in person to read the scan. In memory only. */
  private sessions = new Map<string, string>();
  /** Whether the open watches on the record have been read since start-up, and what the reads came to so far. */
  private resumed: { loaded: boolean; failedReads: number; lastError: string | null; nextTryAt: Date | null } = {
    loaded: false, failedReads: 0, lastError: null, nextTryAt: null,
  };
  /** Which resume is reading: a later resume() takes over from an earlier one still trying. */
  private resumeRun = 0;
  private halted = false;

  constructor(private readonly storage: IStorage, private readonly hooks: CollectHooks) {}

  /**
   * Watch a backend scan whose run the live poll has seen end. Synchronous:
   * the watch exists in memory the moment this returns, and the caller answers
   * without waiting on the row, which is written in the background. A scan
   * already watched here is not watched twice: its watch is answered, and the
   * reader's session adopted.
   */
  start(input: CollectStart): CollectWatch {
    const existing = this.known.get(input.backendScanId);
    if (existing) {
      this.adopt(input.backendScanId, input.sessionId);
      return { ...existing };
    }
    const now = new Date();
    const row: CollectWatch = {
      backendScanId: input.backendScanId,
      testId: input.testId,
      engineRunId: input.engineRunId,
      startedAt: now,
      deadlineAt: new Date(now.getTime() + collectWatch.totalMs),
      state: "running",
      lastAnswer: null,
      lastReadAt: null,
      lastReadError: null,
      endedAt: null,
      record: null,
    };
    this.known.set(row.backendScanId, row);
    this.unrecorded.add(row.backendScanId);
    if (input.sessionId !== null) this.sessions.set(row.backendScanId, input.sessionId);
    void this.ensureRecorded(row);
    this.follow(row.backendScanId, 0);
    return { ...row };
  }

  /**
   * A signed-in person read the scan: the watch asks as them from now on. A
   * read by no person (an API key) lends nothing, and the last person's
   * session is kept.
   */
  adopt(backendScanId: string, sessionId: string | null): void {
    if (sessionId === null || !this.known.has(backendScanId)) return;
    this.sessions.set(backendScanId, sessionId);
  }

  /**
   * Pick up every watch still `running` on the record -- after a restart, or
   * one another dashboard on this database started. In the background: it
   * returns at once and holds up no start-up and no request. A read that fails
   * is said (the log, and resumeState) and tried again, after 1 s, then twice
   * as long each time up to a minute, until it succeeds: a watch is never left
   * unread, its record uncollected, by one failed read. A resumed watch asks as
   * nobody until a person reads its scan (`adopt`), and says so.
   */
  resume(): void {
    const run = ++this.resumeRun;
    const attempt = (wait: number) => {
      if (this.halted || run !== this.resumeRun) return;
      void (async () => {
        let rows: CollectWatch[];
        try {
          rows = await this.storage.getOpenCollectWatches();
        } catch (cause) {
          if (this.halted || run !== this.resumeRun) return;
          const next = Math.min(wait, collectWatch.resumeRetryMaxMs);
          this.resumed = {
            loaded: false, failedReads: this.resumed.failedReads + 1, lastError: causeOf(cause), nextTryAt: new Date(Date.now() + next),
          };
          console.error(
            `[collect] the open collect watches could not be read to resume them (read ${this.resumed.failedReads} failed: ` +
            `${causeOf(cause)}); trying again in ${Math.round(next / 100) / 10} s. Until then a finished scan's backend record ` +
            "is collected by the backend's own collector alone.",
          );
          later(() => attempt(Math.min(wait * 2, collectWatch.resumeRetryMaxMs)), next);
          return;
        }
        if (this.resumed.failedReads > 0) {
          console.log(`[collect] the open collect watches were read after ${this.resumed.failedReads} failed read(s): ${rows.length} resumed.`);
        }
        this.resumed = { loaded: true, failedReads: this.resumed.failedReads, lastError: null, nextTryAt: null };
        for (const row of rows) {
          if (this.halted) return;
          if (!this.known.has(row.backendScanId)) this.known.set(row.backendScanId, row);
          this.follow(row.backendScanId, 0);
        }
      })();
    };
    setImmediate(() => attempt(collectWatch.resumeRetryMs));
  }

  /** Whether the open watches on the record have been read since start-up; if not, why, and when it is tried next. */
  resumeState(): { loaded: boolean; failedReads: number; lastError: string | null; nextTryAt: Date | null } {
    return { ...this.resumed };
  }

  /** A watch this dashboard knows, from memory, without a read. */
  peek(backendScanId: string): CollectWatch | undefined {
    const row = this.known.get(backendScanId);
    return row ? { ...row } : undefined;
  }

  /** A watch by its backend scan: as recorded, or as known here when the record cannot be read or is not written yet. */
  async view(backendScanId: string): Promise<CollectWatch | undefined> {
    const mine = this.known.get(backendScanId);
    if (mine && this.unrecorded.has(backendScanId)) return { ...mine };
    try {
      const row = await this.storage.getCollectWatch(backendScanId);
      if (row) return row;
    } catch {
      // Answered from what this dashboard knows.
    }
    return mine ? { ...mine } : undefined;
  }

  /** Stop asking, as a dashboard that shut down does. Its watches stay on the record for the next to resume. */
  halt(): void {
    this.halted = true;
    this.following.clear();
  }

  /** For tests that reuse one backend scan across cases: forget every watch this dashboard knows. */
  reset(): void {
    this.known.clear();
    this.following.clear();
    this.unrecorded.clear();
    this.recording.clear();
    this.persistedReadAt.clear();
    this.sessions.clear();
  }

  /**
   * Write a new watch's row if it is not written yet. One write in flight per
   * watch; false while it cannot be written. A row that is there already --
   * another dashboard's watch of the same scan, or this one's before a restart
   * -- IS the watch: it is adopted when still running, and when it has ended
   * the watch here ends with it.
   */
  private ensureRecorded(row: CollectWatch): Promise<boolean> {
    const id = row.backendScanId;
    if (!this.unrecorded.has(id)) return Promise.resolve(true);
    const inFlight = this.recording.get(id);
    if (inFlight) return inFlight;
    const attempt = this.storage.createCollectWatch({ ...row })
      .then(() => {
        this.unrecorded.delete(id);
        if (row.lastReadError?.startsWith(UNRECORDED)) row.lastReadError = null;
        return true;
      }, async (cause: unknown) => {
        const existing = await this.storage.getCollectWatch(id).catch(() => undefined);
        if (existing) {
          this.unrecorded.delete(id);
          if (existing.state === "running") {
            Object.assign(row, existing);
            return true;
          }
          // Ended elsewhere already: nothing is asked for it here.
          this.known.delete(id);
          this.following.delete(id);
          this.sessions.delete(id);
          return false;
        }
        row.lastReadError = unrecordedSentence(cause);
        return false;
      })
      .finally(() => this.recording.delete(id));
    this.recording.set(id, attempt);
    return attempt;
  }

  private follow(backendScanId: string, delay = collectWatch.intervalMs): void {
    if (this.halted || this.following.has(backendScanId)) return;
    const token = Symbol(backendScanId);
    this.following.set(backendScanId, token);
    later(() => void this.tick(backendScanId, token), delay);
  }

  /** Whether this loop is still the one asking about this scan: one loop per scan, never two. */
  private current(backendScanId: string, token: symbol): boolean {
    return !this.halted && this.following.get(backendScanId) === token;
  }

  private again(backendScanId: string, token: symbol): void {
    if (!this.current(backendScanId, token)) return;
    later(() => void this.tick(backendScanId, token), collectWatch.intervalMs);
  }

  private done(backendScanId: string, token: symbol): void {
    if (this.following.get(backendScanId) === token) this.following.delete(backendScanId);
  }

  private async tick(backendScanId: string, token: symbol): Promise<void> {
    if (!this.current(backendScanId, token)) return;
    const row = this.known.get(backendScanId);
    if (!row) return this.done(backendScanId, token);
    try {
      await this.step(row, token);
    } catch (cause) {
      // A write that failed is said, and tried again: the record is not lost to one failed write.
      row.lastReadError = causeOf(cause);
      this.again(backendScanId, token);
    }
  }

  /** Ask the backend once, as the person the watch holds. Never throws. */
  private async ask(row: CollectWatch): Promise<Asked> {
    const sessionId = this.sessions.get(row.backendScanId) ?? null;
    const id = row.backendScanId;
    try {
      const got = await runAsPerson(sessionId, () => backendScans.collectScan(id));
      if (got.answer === "collected") return { lastAnswer: "collected", record: got.record, readError: null };
      if (got.answer === "pending") return { lastAnswer: "pending", record: null, readError: null };
      if (got.answer === "unavailable") {
        return { lastAnswer: "unavailable", record: null, readError: `Athena-Backend answered ${got.status} to the collect: ${got.detail}` };
      }
      // 409: the record stands as it is, and is read. A record still pending
      // this moment (another collector holds the claim) is asked about again.
      try {
        const record = await runAsPerson(sessionId, () => backendScans.readScan(id));
        if (record.status !== "pending") return { lastAnswer: "conflict", record, readError: null };
        return {
          lastAnswer: "conflict", record: null,
          readError: `Athena-Backend answered 409 to the collect (${got.detail}) and its record is still pending`,
        };
      } catch (cause) {
        return {
          lastAnswer: this.signInRequired(cause) ? "sign_in_required" : "unavailable", record: null,
          readError: `Athena-Backend answered 409 to the collect (${got.detail}); reading its record: ${causeOf(cause)}`,
        };
      }
    } catch (cause) {
      if (this.signInRequired(cause)) return { lastAnswer: "sign_in_required", record: null, readError: causeOf(cause) };
      if (cause instanceof ControlPlaneRefused) return { lastAnswer: "refused", record: null, readError: causeOf(cause) };
      return { lastAnswer: "unavailable", record: null, readError: causeOf(cause) };
    }
  }

  private signInRequired(cause: unknown): boolean {
    return cause instanceof ControlPlaneSignInRequired || cause instanceof PersonSignInRequired;
  }

  /**
   * End the watch on the record. The claim: true when this call ended it, false
   * when another dashboard had, in which case nothing is filed here.
   */
  private async end(row: CollectWatch, token: symbol, end: CollectWatchEnd): Promise<boolean> {
    const id = row.backendScanId;
    if (!(await this.ensureRecorded(row))) {
      if (!this.known.has(id)) {
        // Ended elsewhere before this dashboard's row could be written.
        this.done(id, token);
        return false;
      }
      throw new Error(row.lastReadError ?? UNRECORDED);
    }
    const ended = await this.storage.endCollectWatch(id, end);
    this.done(id, token);
    this.persistedReadAt.delete(id);
    if (ended) {
      // An ended watch is read from the record from now on.
      this.known.delete(id);
      this.sessions.delete(id);
    } else {
      await this.endedElsewhere(row, token);
    }
    return ended;
  }

  /** The record is collected: claim the watch's end, and file the record into the row once. */
  private async file(row: CollectWatch, token: symbol, record: backendScans.BackendScanRecord, lastAnswer: CollectLastAnswer, at: Date): Promise<void> {
    const end: CollectWatchEnd = {
      state: "collected", endedAt: new Date(), record: record.raw, lastAnswer, lastReadAt: at, lastReadError: null,
    };
    if (!(await this.end(row, token, end))) return;
    const now: CollectWatch = { ...row, ...end };
    try {
      await this.hooks.fileRecord(now, record);
    } catch (cause) {
      // The record is on the watch's row, and the status route files it from there
      // on the next read (server/routes.ts). Said here, so it is not lost in silence.
      console.error(`[collect] the record of backend scan ${row.backendScanId} could not be filed into test ${row.testId}: ${causeOf(cause)}`);
    }
    await this.hooks.recordEnd(now).catch(() => undefined);
  }

  /** Write an answer back to the row: at once when something changed, otherwise at most once a minute. */
  private async persistRead(row: CollectWatch, token: symbol, changed: boolean): Promise<void> {
    const last = this.persistedReadAt.get(row.backendScanId) ?? 0;
    if (!changed && Date.now() - last < collectWatch.persistReadEveryMs) return;
    if (!(await this.ensureRecorded(row))) return;
    let still: boolean;
    try {
      still = await this.storage.updateRunningCollectWatch(row.backendScanId, {
        lastAnswer: row.lastAnswer, lastReadAt: row.lastReadAt, lastReadError: row.lastReadError,
      });
    } catch {
      // Not written this time: the next tick tries again. The watch goes on.
      return;
    }
    this.persistedReadAt.set(row.backendScanId, Date.now());
    if (!still) await this.endedElsewhere(row, token);
  }

  private async step(row: CollectWatch, token: symbol): Promise<void> {
    const at = new Date();
    const pastDeadline = at.getTime() >= row.deadlineAt.getTime();
    const asked = await this.ask(row);
    // Halted, or superseded, while the backend was answering: nothing is filed by this loop.
    if (!this.current(row.backendScanId, token)) return;

    if (asked.record !== null) return this.file(row, token, asked.record, asked.lastAnswer, at);

    if (pastDeadline) {
      // The watch stops asking here, and says so -- never as an outcome: the
      // backend's own collector records the run's end when it can.
      const end: CollectWatchEnd = {
        state: "unwatched", endedAt: at, record: null, lastAnswer: asked.lastAnswer, lastReadAt: at,
        lastReadError: `${asked.readError ?? `the last answer was ${asked.lastAnswer}`} (this dashboard stopped asking at its deadline)`,
      };
      if (await this.end(row, token, end)) await this.hooks.recordEnd({ ...row, ...end }).catch(() => undefined);
      return;
    }

    const changed = row.lastAnswer !== asked.lastAnswer || row.lastReadError !== asked.readError;
    Object.assign(row, { lastAnswer: asked.lastAnswer, lastReadAt: at, lastReadError: asked.readError });
    await this.persistRead(row, token, changed);
    this.again(row.backendScanId, token);
  }

  /** The record says this watch has ended -- another dashboard ended it. Stop asking, and forget it here. */
  private async endedElsewhere(row: CollectWatch, token: symbol): Promise<void> {
    this.done(row.backendScanId, token);
    const recorded = await this.storage.getCollectWatch(row.backendScanId).catch(() => undefined);
    if (recorded && recorded.state !== "running") {
      this.known.delete(row.backendScanId);
      this.sessions.delete(row.backendScanId);
    } else if (recorded) {
      this.known.set(row.backendScanId, recorded);
    }
  }
}
