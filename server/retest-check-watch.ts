/**
 * A retest's verdict, asked into Athena-Backend's record as a RETEST CHECK --
 * owner decision 8, the dashboard half (the backend half is athena-backend
 * #189). Watched, bounded, on the record: the pattern of server/collect-watch.ts.
 *
 * WHEN. Only after the dashboard's own retest watch (server/retests.ts) has
 * ENDED with a verdict -- `IStorage.endRetestWatch` has filed what this
 * dashboard files itself (its check, its finding's change) -- and only for a
 * retest of a scan that names a backend scan (shared/engine-record.ts
 * backendScanIdOf). The routes' recordEnd hook starts one of these then
 * (server/routes.ts retestWatchHooksFor). A retest of a scan this dashboard
 * recorded directly from the engine has no backend record to be in: nothing is
 * sent for it, and the row says so (`reason: "dashboard_direct"`).
 *
 * WHAT IS ASKED. The backend finding the retested finding is in the record as
 * is found from the record itself, read as the person: the deployments under
 * the scan's backend engagement (`GET /api/assurance/deployments/`), their
 * findings (`GET /api/assurance/findings/?deployment=`), and the one whose
 * `scan_uuid` is the scan's backend id -- or whose `engine_run_id` is the scan
 * run the twin was listed under -- and whose `finding_type` is the verdict's.
 * Then `POST /api/assurance/findings/<uuid>/retest-checks/collect/` with
 * `{run_id: <the retest run>, twin_run_id: <the scan run>}` (server/backend-
 * scans.ts collectRetestCheck). The backend reads the engine itself and decides
 * identity itself; where several findings of the type stand, its answer (409,
 * with the candidates) is the word, never a guess here.
 *
 * WHAT COMES BACK, and what is filed on the retest watch's row
 * (`retest_watches.result.backend`, shared/backend-record.ts RetestCheckRecordView):
 *   - 201, or 200 with the row the backend already held → `recorded`: a retest
 *     check, said as exactly that and never as closure evidence; the asking ends;
 *   - 404, 409, 422 (and a 400, this dashboard's request refused), or a 200
 *     saying the run produced no verdict → `not_in_record`, in the backend's own
 *     words; asking again changes nothing, so the asking ends;
 *   - 202 (the backend reads the run as still going), 503 (it could not read
 *     the engine), a 403 (this person may not), no finding of the type in the
 *     record yet, a person with no backend sign-in, or no answer at all →
 *     `asking` still: nothing is read as recorded, and the backend is asked
 *     again at a bounded interval, for a bounded total;
 *   - the deadline reached → `unwatched`: where the asking stood, never an
 *     outcome. Silence is "being asked", never "recorded".
 *
 * WHO ASKS: the person -- their own backend sign-in (server/person-credential.ts
 * runAsPerson), never the service account. The session of the person who
 * pressed Retest is lent at the 202 (`adopt`), and every signed-in read of the
 * retest while the asking runs lends theirs. A dashboard that restarts holds no
 * session until a person reads the retest again, and says so (`sign_in_required`).
 *
 * NEVER CLOSURE EVIDENCE, NEVER A VERDICT INVENTED: nothing here writes into
 * `finding_checks` or `findings` -- the dashboard's own filing is done before
 * this starts and is not touched -- and nothing here derives a verdict: the
 * backend's check is shown as the backend served it.
 *
 * SAFETY: nothing here is on a stop's path. The retest's Stop is the engine's
 * abort, sent by the routes and authorised from memory; the kill switch stops
 * every known run by id without reading. This starts after the retest watch
 * has ended, off every request path; no stop, no 202 and no kill switch awaits
 * a collect, and a collect that fails is recorded on the row and asked again,
 * never anything else. Nothing here holds the event loop.
 */

import * as assurance from "./assurance";
import * as backendScans from "./backend-scans";
import { ControlPlaneRefused, ControlPlaneSignInRequired } from "./control-plane";
import { PersonSignInRequired, runAsPerson } from "./person-credential";
import type { IStorage } from "./storage";
import type { RetestWatch } from "@shared/schema";
import type { RetestCheckRecordView } from "@shared/backend-record";

/** How often the backend is asked, and for how long in all. Tests shorten these. */
export const retestCheckWatch = {
  intervalMs: 2_000,
  totalMs: 60 * 60_000,
  /** How often an unchanged answer is written back to the row. */
  persistReadEveryMs: 60_000,
  /** The first wait before a failed resume read is tried again; each failure doubles it, up to resumeRetryMaxMs. */
  resumeRetryMs: 1_000,
  resumeRetryMaxMs: 60_000,
};

/** A new asking: the retest run, the scan it retested a twin of, and the person's session to ask as. */
export interface RetestCheckAsk {
  /** The retest run the engine named: what the backend records the check under (`run_id`). */
  engineRunId: string;
  testId: string;
  /** The scan run the retested twin was listed under (`twin_run_id`). */
  twinRunId: string;
  /** The scan's backend id (`backendScanId` on the row), and the backend engagement it ran under. */
  backendScanId: string;
  backendEngagementId: number | null;
  /** The verdict's finding type, as the engine said it: what the backend finding is matched by. */
  findingType: string | null;
  sessionId: string | null;
}

/** What the routes supply: how an ended asking is recorded (the log). Best-effort: a failure changes nothing. */
export interface RetestCheckHooks {
  recordEnd(watch: RetestWatch, backend: RetestCheckRecordView): Promise<void>;
}

/** Where the asking stands, in words, while the backend is asked. */
export const ASKING = "Athena-Backend is being asked, as the person, to record this retest's verdict as a retest check";
/** Said of a retest of a scan this dashboard recorded directly from the engine: nothing is sent. */
export const DASHBOARD_DIRECT_DETAIL =
  "the scan this retest looked again at was recorded by this dashboard directly from the engine, so it has no Athena-Backend record for the check to be in; nothing was sent";

function causeOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function later(fn: () => void, ms: number): void {
  const timer = setTimeout(fn, ms);
  // An asking never keeps the process alive on its own.
  (timer as { unref?: () => void }).unref?.();
}

/** The `backend` a watch's row carries, when it carries one this reads. */
export function backendStandingOf(result: unknown): RetestCheckRecordView | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const backend = (result as Record<string, unknown>).backend;
  if (!backend || typeof backend !== "object" || Array.isArray(backend)) return null;
  const one = backend as Record<string, unknown>;
  return typeof one.state === "string" ? (one as unknown as RetestCheckRecordView) : null;
}

/** One ask of the backend: an end (recorded, or not in the record), or where the asking stands. */
type Asked =
  | { kind: "end"; backend: RetestCheckRecordView }
  | { kind: "pending"; lastAnswer: string; detail: string; status: number | null; findingUuid: string | null };

/** One asking this dashboard knows: the watch's row as last known, its standing, and what the finding is matched by. */
interface Asking {
  row: RetestWatch;
  backend: RetestCheckRecordView;
  findingType: string | null;
  backendEngagementId: number | null;
  /** An end whose write to the row failed: written on the next tick, with no second ask of the backend. */
  pendingEnd: RetestCheckRecordView | null;
}

/** One dashboard's retest-check askings. Created with the app (server/routes.ts), and resumed from storage. */
export class RetestCheckWatcher {
  private asking = new Map<string, Asking>();
  /** The runs being asked about now, each by the token of its one loop. */
  private following = new Map<string, symbol>();
  /** Askings whose standing is not on the row yet; each tick tries again. */
  private unrecorded = new Set<string>();
  private persistedAt = new Map<string, number>();
  /** The session of the person each asking goes as: the last signed-in person to press or read the retest. In memory only. */
  private sessions = new Map<string, string>();
  private resumed: { loaded: boolean; failedReads: number; lastError: string | null; nextTryAt: Date | null } = {
    loaded: false, failedReads: 0, lastError: null, nextTryAt: null,
  };
  private resumeRun = 0;
  private halted = false;

  constructor(private readonly storage: IStorage, private readonly hooks: RetestCheckHooks) {}

  /**
   * A signed-in person pressed Retest (the 202 that names the run), or read the
   * retest: the asking for that run goes as them from now on. A read by no
   * person (an API key) lends nothing. Synchronous; reads nothing.
   */
  adopt(engineRunId: string, sessionId: string | null): void {
    if (sessionId === null) return;
    this.sessions.set(engineRunId, sessionId);
  }

  /**
   * Start asking for a watch that ENDED with a verdict (its row is on the record,
   * state `verdict`). Synchronous: the asking exists in memory the moment this
   * returns; its standing is written to the row in the background, and the
   * backend is asked from the next tick. A run already being asked about is not
   * asked about twice.
   */
  start(ask: RetestCheckAsk, row: RetestWatch): RetestCheckRecordView {
    const id = ask.engineRunId;
    const existing = this.asking.get(id);
    if (existing) {
      this.adopt(id, ask.sessionId);
      return { ...existing.backend };
    }
    const now = new Date();
    const backend: RetestCheckRecordView = {
      state: "asking", recorded: null, detail: ASKING, reason: null, status: null, findingUuid: null, checkId: null, check: null,
      lastAnswer: null, lastAskedAt: null, lastReadError: null,
      startedAt: now.toISOString(), deadlineAt: new Date(now.getTime() + retestCheckWatch.totalMs).toISOString(), endedAt: null,
      twinRunId: ask.twinRunId, backendScanId: ask.backendScanId,
    };
    this.adopt(id, ask.sessionId);
    this.asking.set(id, { row, backend, findingType: ask.findingType, backendEngagementId: ask.backendEngagementId, pendingEnd: null });
    this.unrecorded.add(id);
    void this.ensureRecorded(id);
    this.follow(id, 0);
    return { ...backend };
  }

  /**
   * A retest of a scan with no backend record (none is named on its row):
   * nothing is sent, and the row says so -- not in the Athena-Backend record,
   * because the scan was recorded by this dashboard directly from the engine.
   * Best-effort: a write that fails is said, and the view then has no standing
   * to show for it, which is honest.
   */
  async noteDashboardDirect(row: RetestWatch, twinRunId: string | null): Promise<RetestCheckRecordView> {
    const now = new Date().toISOString();
    const backend: RetestCheckRecordView = {
      state: "not_in_record", recorded: false, detail: DASHBOARD_DIRECT_DETAIL, reason: "dashboard_direct", status: null,
      findingUuid: null, checkId: null, check: null, lastAnswer: null, lastAskedAt: null, lastReadError: null,
      startedAt: now, deadlineAt: now, endedAt: now, twinRunId, backendScanId: null,
    };
    try {
      await this.storage.noteRetestCheckBackend(row.engineRunId, backend);
    } catch (cause) {
      console.error(`[retest-check] the standing of retest run ${row.engineRunId} (not in the backend record: dashboard-direct) could not be written: ${causeOf(cause)}`);
    }
    return backend;
  }

  /**
   * Pick up every asking still `asking` on the record -- after a restart, or one
   * another dashboard on this database started. In the background: it returns at
   * once and holds up no start-up and no request. A read that fails is said and
   * tried again, after 1 s, then twice as long each time up to a minute. A
   * resumed asking goes as nobody until a person reads the retest (`adopt`),
   * and says so.
   */
  resume(): void {
    const run = ++this.resumeRun;
    const attempt = (wait: number) => {
      if (this.halted || run !== this.resumeRun) return;
      void (async () => {
        let rows: RetestWatch[];
        try {
          rows = await this.storage.getRetestWatchesAskingBackend();
        } catch (cause) {
          if (this.halted || run !== this.resumeRun) return;
          const next = Math.min(wait, retestCheckWatch.resumeRetryMaxMs);
          this.resumed = { loaded: false, failedReads: this.resumed.failedReads + 1, lastError: causeOf(cause), nextTryAt: new Date(Date.now() + next) };
          console.error(
            `[retest-check] the retest checks being asked for could not be read to resume them (read ${this.resumed.failedReads} failed: ` +
            `${causeOf(cause)}); trying again in ${Math.round(next / 100) / 10} s.`,
          );
          later(() => attempt(Math.min(wait * 2, retestCheckWatch.resumeRetryMaxMs)), next);
          return;
        }
        this.resumed = { loaded: true, failedReads: this.resumed.failedReads, lastError: null, nextTryAt: null };
        for (const row of rows) {
          if (this.halted) return;
          if (this.asking.has(row.engineRunId)) continue;
          const backend = backendStandingOf(row.result);
          if (backend === null || backend.state !== "asking") continue;
          // What the finding is matched by, from the row (the verdict's type) and the scan's row (its engagement).
          const result = row.result as { findingType?: unknown } | null;
          const findingType = typeof result?.findingType === "string" ? result.findingType : null;
          let backendEngagementId: number | null = null;
          try {
            const test = await this.storage.getTest(row.testId);
            const findings = test?.findings as { backendEngagementId?: unknown } | null | undefined;
            backendEngagementId = typeof findings?.backendEngagementId === "number" ? findings.backendEngagementId : null;
          } catch {
            // Matched without the engagement: every deployment the person can see is read.
          }
          if (this.halted || this.asking.has(row.engineRunId)) continue;
          this.asking.set(row.engineRunId, { row, backend: { ...backend }, findingType, backendEngagementId, pendingEnd: null });
          this.follow(row.engineRunId, 0);
        }
      })();
    };
    setImmediate(() => attempt(retestCheckWatch.resumeRetryMs));
  }

  resumeState(): { loaded: boolean; failedReads: number; lastError: string | null; nextTryAt: Date | null } {
    return { ...this.resumed };
  }

  /** The standing of an asking this dashboard knows, from memory, without a read. */
  peek(engineRunId: string): RetestCheckRecordView | undefined {
    const one = this.asking.get(engineRunId);
    return one ? { ...one.backend } : undefined;
  }

  /** Stop asking, as a dashboard that shut down does. The askings stay on the record for the next to resume. */
  halt(): void {
    this.halted = true;
    this.following.clear();
  }

  /** For tests that reuse one engine run id across cases: forget every asking this dashboard knows. */
  reset(): void {
    this.asking.clear();
    this.following.clear();
    this.unrecorded.clear();
    this.persistedAt.clear();
    this.sessions.clear();
  }

  /** Write the standing to the row if it is not there yet. False while it cannot be written. */
  private async ensureRecorded(id: string): Promise<boolean> {
    if (!this.unrecorded.has(id)) return true;
    const one = this.asking.get(id);
    if (!one) return false;
    try {
      const written = await this.storage.noteRetestCheckBackend(id, one.backend);
      if (!written) {
        // No watch of this run ended with a verdict on the record: nothing to file the standing on, so nothing is asked.
        console.error(`[retest-check] retest run ${id} has no ended watch on the record to carry its backend standing; nothing is asked for it`);
        this.asking.delete(id);
        this.unrecorded.delete(id);
        this.following.delete(id);
        return false;
      }
      this.unrecorded.delete(id);
      this.persistedAt.set(id, Date.now());
      return true;
    } catch (cause) {
      one.backend.lastReadError = `this standing could not be recorded yet (${causeOf(cause)}); a restart now would lose it`;
      return false;
    }
  }

  private follow(id: string, delay = retestCheckWatch.intervalMs): void {
    if (this.halted || this.following.has(id)) return;
    const token = Symbol(id);
    this.following.set(id, token);
    later(() => void this.tick(id, token), delay);
  }

  private current(id: string, token: symbol): boolean {
    return !this.halted && this.following.get(id) === token;
  }

  private again(id: string, token: symbol): void {
    if (!this.current(id, token)) return;
    later(() => void this.tick(id, token), retestCheckWatch.intervalMs);
  }

  private done(id: string, token: symbol): void {
    if (this.following.get(id) === token) this.following.delete(id);
  }

  private async tick(id: string, token: symbol): Promise<void> {
    if (!this.current(id, token)) return;
    const one = this.asking.get(id);
    if (!one) return this.done(id, token);
    try {
      await this.step(one, token);
    } catch (cause) {
      // A write that failed is said, and tried again: the standing is not lost to one failed write.
      one.backend.lastReadError = causeOf(cause);
      this.again(id, token);
    }
  }

  /**
   * The backend finding the retested finding is in the record as, from the
   * record, read as the person: the deployments under the scan's engagement,
   * their findings, the one of the verdict's type from the scan. Throws what the
   * reads throw.
   */
  private async findBackendFinding(one: Asking): Promise<{ uuid: string } | { none: string }> {
    const { backendScanId, twinRunId } = one.backend;
    const type = one.findingType;
    const deployments = (await assurance.listDeployments())
      .filter((deployment) => one.backendEngagementId === null || deployment.engagementId === one.backendEngagementId);
    if (deployments.length === 0) {
      return { none: `the Athena-Backend record lists no deployment under backend engagement #${one.backendEngagementId ?? "?"} yet` };
    }
    const candidates: string[] = [];
    for (const deployment of deployments) {
      for (const finding of await assurance.listFindings({ deployment: deployment.uuid })) {
        const sameScan = finding.scanUuid === backendScanId || (finding.engineRunId !== null && finding.engineRunId === twinRunId);
        if (sameScan && (type === null || finding.findingType === type)) candidates.push(finding.uuid);
      }
    }
    if (candidates.length === 0) {
      return {
        none: `the Athena-Backend record lists no finding${type === null ? "" : ` of type ${type}`} ingested from scan ${backendScanId}` +
          ` (engine run ${twinRunId ?? "unknown"}) yet`,
      };
    }
    // Several of the type from one scan: the backend's identity check is the word (409 with the candidates), never a guess here.
    return { uuid: candidates[0] };
  }

  /** Ask the backend once, as the person the asking holds. Never throws. */
  private async ask(one: Asking): Promise<Asked> {
    const id = one.row.engineRunId;
    const sessionId = this.sessions.get(id) ?? null;
    const pending = (lastAnswer: string, detail: string, status: number | null, findingUuid = one.backend.findingUuid): Asked =>
      ({ kind: "pending", lastAnswer, detail, status, findingUuid });
    try {
      return await runAsPerson(sessionId, async (): Promise<Asked> => {
        let findingUuid = one.backend.findingUuid;
        if (findingUuid === null) {
          const found = await this.findBackendFinding(one);
          if ("none" in found) return pending("no_finding", found.none, null);
          findingUuid = found.uuid;
        }
        const twinRunId = one.backend.twinRunId;
        if (twinRunId === null) {
          return pending("no_finding", "the scan names no engine run this dashboard can name to Athena-Backend as the twin's run", null, findingUuid);
        }
        const answer = await backendScans.collectRetestCheck(findingUuid, { runId: id, twinRunId });
        const at = new Date().toISOString();
        const base = { ...one.backend, findingUuid, lastAskedAt: at, lastReadError: null, status: answer.status, endedAt: at };
        switch (answer.answer) {
          case "recorded":
            return {
              kind: "end",
              backend: {
                ...base, state: "recorded", recorded: true, lastAnswer: answer.existing ? "existing" : "recorded",
                checkId: answer.check.engineRunId, check: answer.check,
                detail: answer.existing
                  ? `Athena-Backend answered 200: it already held the retest check for run ${id} against finding ${findingUuid}`
                  : `Athena-Backend answered 201: the retest check for run ${id} is recorded against finding ${findingUuid}`,
              },
            };
          case "not_in_record":
            return {
              kind: "end",
              backend: {
                ...base, state: "not_in_record", recorded: false, lastAnswer: "not_in_record",
                detail: answer.candidates.length > 0 ? `${answer.detail} (candidates: ${answer.candidates.join(", ")})` : answer.detail,
              },
            };
          case "not_a_verdict":
            // The backend read the run as ended without a verdict it keeps: asking again changes nothing. Its words stand.
            return { kind: "end", backend: { ...base, state: "not_in_record", recorded: false, lastAnswer: "not_a_verdict", detail: answer.detail } };
          case "running":
            return pending("running", `Athena-Backend answered 202: ${answer.detail}`, 202, findingUuid);
          default:
            return pending("unavailable", `Athena-Backend answered ${answer.status} to the retest-check collect: ${answer.detail}`, answer.status, findingUuid);
        }
      });
    } catch (cause) {
      if (cause instanceof ControlPlaneSignInRequired || cause instanceof PersonSignInRequired) {
        return pending("sign_in_required", `the collect waits on a person signed in to Athena-Backend: ${causeOf(cause)}`, null);
      }
      if (cause instanceof ControlPlaneRefused) return pending("refused", causeOf(cause), cause.status);
      return pending("unavailable", causeOf(cause), null);
    }
  }

  /** End the asking: the standing on the row, then the record of the end. */
  private async end(one: Asking, token: symbol, backend: RetestCheckRecordView): Promise<void> {
    const id = one.row.engineRunId;
    one.backend = backend;
    one.pendingEnd = backend;
    this.unrecorded.delete(id);
    // Thrown to the tick on failure: written on the next tick, with no second ask of the backend.
    await this.storage.noteRetestCheckBackend(id, backend);
    one.pendingEnd = null;
    this.done(id, token);
    this.asking.delete(id);
    this.sessions.delete(id);
    this.persistedAt.delete(id);
    await this.hooks.recordEnd({ ...one.row, result: { ...(one.row.result ?? {}), backend } }, backend).catch(() => undefined);
  }

  /** Write the standing back to the row: at once when something changed, otherwise at most once a minute. */
  private async persist(one: Asking, changed: boolean): Promise<void> {
    const id = one.row.engineRunId;
    if (this.unrecorded.has(id)) return void (await this.ensureRecorded(id));
    const last = this.persistedAt.get(id) ?? 0;
    if (!changed && Date.now() - last < retestCheckWatch.persistReadEveryMs) return;
    try {
      await this.storage.noteRetestCheckBackend(id, one.backend);
      this.persistedAt.set(id, Date.now());
    } catch {
      // Not written this time: the next tick tries again. The asking goes on.
    }
  }

  private async step(one: Asking, token: symbol): Promise<void> {
    const id = one.row.engineRunId;
    if (one.pendingEnd !== null) return this.end(one, token, one.pendingEnd);
    const at = new Date();
    const pastDeadline = at.getTime() >= Date.parse(one.backend.deadlineAt);
    const asked = await this.ask(one);
    // Halted, or superseded, while the backend was answering: nothing is filed by this loop.
    if (!this.current(id, token)) return;
    if (asked.kind === "end") return this.end(one, token, asked.backend);

    if (pastDeadline) {
      // The asking stops here, and says so -- never as an outcome.
      return this.end(one, token, {
        ...one.backend, state: "unwatched", recorded: false, findingUuid: asked.findingUuid, lastAnswer: asked.lastAnswer, status: asked.status,
        lastAskedAt: at.toISOString(), lastReadError: asked.detail, endedAt: at.toISOString(),
        detail: `${asked.detail} (this dashboard stopped asking at its deadline)`,
      });
    }
    const changed = one.backend.lastAnswer !== asked.lastAnswer || one.backend.lastReadError !== asked.detail || one.backend.findingUuid !== asked.findingUuid;
    one.backend = {
      ...one.backend, findingUuid: asked.findingUuid, lastAnswer: asked.lastAnswer, status: asked.status,
      lastAskedAt: at.toISOString(), lastReadError: asked.detail, detail: ASKING,
    };
    await this.persist(one, changed);
    this.again(id, token);
  }
}
