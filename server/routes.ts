import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { storage } from "./storage-unified";
import { openReport } from "./db-sqlite";
import { loadFindingsSummary, SummaryReadError } from "./findings-summary";
import {
  requireAuth, requireAdmin, requireAdminUnlessStop, type StopKind, asyncHandler, actor, sessionUser, accountNow, noteAccount, noteAccountDeleted, reviseLiveSessions,
} from "./auth";
import * as assistant from "./assistant";
import * as settings from "./settings";
import * as engine from "./engine";
import * as retests from "./retests";
import * as failsafe from "./failsafe";
import * as assurance from "./assurance";
import { controlMap, type ScanFinding } from "./compliance";
import { AI_SYSTEMS, DEFAULT_ACTIVE_SYSTEMS, systemOfScan } from "@shared/ai-systems";
import { isEngineInternal } from "@shared/engine-internal";
import { engineRunIdOf, engineStopIdOf, isEngineRecord } from "@shared/engine-record";
import { ratingOf } from "@shared/latest-scans";
import { deploymentSummary } from "./summary";
import * as lifecycle from "./findings";
import type { RetestFiling } from "./storage";
import type { AIControlSetting, Finding, RetestWatch, Test } from "@shared/schema";
import {
  insertClientSchema, insertSiteSchema, createTestSchema,
  insertDocumentSchema, insertAIHealthMetricSchema,
  insertUserSchema, insertAIControlSettingSchema, insertAIChatMessageSchema,
  updateConnectionSettingsSchema,
  insertClassifierSchema, USER_ROLES,
  type User, type PublicUser,
  SETTABLE_FINDING_STATUS,
  createApiKeySchema, type ApiKey, type PublicApiKey,
} from "@shared/schema";

/**
 * Attribution comes from the session, so these fields are not accepted from the
 * request body at all. Taking `data.executedBy ?? session` let the client win,
 * and in an audit product "who ran this test" is evidence.
 */
/**
 * The host a recorded site names, or null if it does not name one.
 *
 * Sites are stored as URLs typed by a person, so this has to survive a bare
 * hostname as well as a URL. It does not invent a scheme for anything with a
 * colon in it: "engine.internal:8099" parses as a scheme, which is the same
 * trap the settings screen's URL validation fell into.
 */
function hostOf(url: string): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname || null;
  } catch {
    return null;
  }
}

/**
 * When a test becomes completed, it completed now -- unless the caller says
 * when it did.
 *
 * Nothing stamped it. The Tests screen never sends a completion time, so a
 * pentest recorded as completed today kept completedAt null, and every
 * "latest completed test" rule fell back to when the row was created: a
 * pentest opened as pending last week and finished today ranked behind an
 * engine scan that finished yesterday, and that scan's clean result cleared
 * the pentest's reported criticals. Stamped on create with status
 * "completed", and on an update that moves a test to "completed" from
 * anything else. A test already completed keeps the time it has: an edit to
 * its summary is not a new completion.
 */
function completionStamp(
  data: { status?: string | null; completedAt?: Date | null },
  before: { status: string } | null,
): { completedAt?: Date } {
  const completing = data.status === "completed" && before?.status !== "completed";
  return completing && data.completedAt == null ? { completedAt: new Date() } : {};
}

/**
 * `isSample` marks a row the installer wrote, and nothing else may claim it.
 * A caller who could set it could hide real findings behind a label that says
 * "not real", or dress invented ones up as measured. It is stripped from
 * every schema the API parses; the seeder is the only writer.
 */
const createClientSchema = insertClientSchema.omit({ isSample: true });
const createSiteSchema = insertSiteSchema.omit({ isSample: true });

// What a scan needs before the engine is asked anything: a target, and the
// engagement it is being run under. The engagement is a client and, where
// there is one, a site -- both looked up rather than taken on trust, because
// a scan filed under an engagement nobody opened is a scan nobody authorised.

// Authenticated scanning, in the engine's TargetAuthConfig shape. Bounded so a
// launch request cannot smuggle an unbounded credential blob through; the
// engine validates the contents again and refuses a malformed block.
const authIdentitySchema = z.object({
  name: z.string().min(1).max(100),
  cookies: z.record(z.string(), z.string().max(4096)).optional(),
  headers: z.record(z.string(), z.string().max(4096)).optional(),
  login_fields: z.record(z.string(), z.string().max(4096)).optional(),
});

const scanAuthSchema = z.object({
  enabled: z.boolean(),
  login_url: z.string().max(2000).nullish(),
  login_method: z.enum(["GET", "POST"]).optional(),
  authenticated_marker: z.string().max(500).nullish(),
  identities: z.array(authIdentitySchema).max(8),
});

const startScanSchema = z.object({
  clientId: z.string().min(1),
  siteId: z.string().min(1).optional(),
  target: z.string().min(1).max(2000),
  testType: z.string().min(1).max(100).default("penetration_test"),
  // Optional: present only when the operator turned on authenticated scanning.
  // Not persisted -- forwarded to the engine for the scan and then dropped.
  auth: scanAuthSchema.optional(),
});

/**
 * The severity counts, taken from the findings the engine returned.
 *
 * Counted here rather than accepted from anywhere: these numbers are what a
 * client reads on a report, and the only honest source for them is the list
 * of findings they claim to summarise.
 *
 * The severity is the worst counted one -- or "info" when every result was
 * rated info. It used to be null then, beside a total of N, which is how a
 * record says "N results, severity never recorded": the screens drew a scan
 * whose every result the engine rated info as "Not rated" and listed it among
 * the highest risks.
 *
 * Each result's severity is read as every other reader reads it (shared/
 * latest-scans.ts ratingOf: any case, surrounding space trimmed). Read here by
 * lower-casing alone, a result the engine sent as " high" was counted as no
 * band, the record's severity was left null -- "recorded with no severity" --
 * while readScan read the same result as rated high.
 */
function countSeverities(findings: unknown[]): {
  vulnerabilitiesFound: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  severity: string | null;
} {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  let total = 0;
  let info = 0;
  for (const finding of findings) {
    if (!finding || typeof finding !== "object") continue;
    const entry = finding as Record<string, unknown>;
    // The engine marks its own diagnostics `internal`. They are worth showing
    // and they are not vulnerabilities, so they are not counted as any. Any
    // truthy mark is one, as athena-engine's `engine/utils/scoring.py` reads it
    // (`if item.get("internal"):`), and as both scan screens list it.
    if (isEngineInternal(entry.internal)) continue;
    total += 1;
    const rating = ratingOf(entry.severity);
    if (rating === "info") info += 1;
    else if (rating !== null) counts[rating] += 1;
  }
  const worst = counts.critical ? "critical"
    : counts.high ? "high"
    : counts.medium ? "medium"
    : counts.low ? "low"
    : total > 0 && info === total ? "info"
    : null;
  return {
    vulnerabilitiesFound: total,
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
    severity: worst,
  };
}

/** The engine run a test records, or null when it names none (shared/engine-record.ts). */
function runIdOf(test: { findings: unknown }): string | null {
  return engineRunIdOf(test.findings);
}

/** The fields of a finding the scan screens print as text. */
const RESULT_TEXT_FIELDS = ["type", "message", "details", "severity"] as const;

/**
 * Whether one of a run's results is a finding a screen can read: a record whose
 * text fields are text, or absent (null is absent). The screens print them as
 * they are, and a `message` that is an object threw "Objects are not valid as a
 * React child" and blanked the whole page.
 */
function isResultRow(row: unknown): boolean {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
  const entry = row as Record<string, unknown>;
  return RESULT_TEXT_FIELDS.every(
    (field) => entry[field] === undefined || entry[field] === null || typeof entry[field] === "string",
  );
}

/**
 * A run's results, when every one can be shown; null when they cannot be read:
 * not a list, or with a row that is not a readable finding. One row that cannot
 * be shown makes the list unread, said to be so, and never a shorter list.
 */
function readableResults(results: unknown): unknown[] | null {
  return Array.isArray(results) && results.every(isResultRow) ? results : null;
}

/** Engine run states after which nothing more happens. */
const FINISHED_RUN_STATES = new Set(["completed", "aborted", "failed", "refused"]);

/** What a finished run whose results could not be read records as its counts: none, read as "not recorded". */
const UNREAD_COUNTS = {
  severity: null, vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
} as const;

/** Said of an engine scan the engine accepted without a run id, read before it is recorded as completed. */
const NO_RUN_ID_TO_ASK = "the engine accepted this scan without a run id, so the engine cannot be asked about it";

/**
 * Said when such a scan's own Stop is sent: nothing names it to the engine. The
 * kill switch reaches it only if the engine lists it by a run id; a run listed
 * with none is stopped by a failsafe, which stops the engine itself.
 */
const NO_RUN_ID_TO_STOP =
  "the engine accepted this scan without a run id, so its own stop has nothing to name it by; " +
  "the kill switch sends a stop to every run the engine lists by a run id, and a run it lists with none " +
  "cannot be stopped from here: pause, stand down or terminate the engine from the Failsafe console";

/** What one stop sent to the engine came to. */
interface ScanStop {
  testId: string;
  runId: string;
  target: string | null;
  /** True only when the engine answered the stop 2xx: it accepted it, or -- with `answerUnread` -- its answer was not read. */
  stopped: boolean;
  /** The engine answered "not running": the run had already ended, and nothing was stopped. `stopped` is false. */
  alreadyFinished?: boolean;
  /** Stop sent, answer unread: the 2xx was read and the rest of the answer was not. Never counted as accepted. */
  answerUnread?: boolean;
  /** Why not, in the engine's or the network's words; empty when stopped. */
  detail: string;
}

/** A cause, as the sentence a page can show. */
function causeOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The id the kill switch stops a test's unfinished run by (shared/engine-record.ts
 * stopIdFrom): its run id, or a non-empty id blank after trimming, which no
 * screen offers a Stop for but a stop still reaches exactly. null otherwise.
 */
function unfinishedStopIdOf(test: { findings: unknown; status: string }): string | null {
  const stopId = stopIdOf(test);
  return stopId !== null && !FINISHED_RUN_STATES.has(test.status) ? stopId : null;
}

/**
 * The id a stop can address a test's engine run by exactly: its run id, or, for
 * an engine scan, a non-empty id blank after trimming (shared/engine-record.ts
 * stopIdFrom). Every stop -- the kill switch, a delete, the abort route -- is
 * sent by this, so none is sent fewer times than a stop can reach; only what a
 * screen offers (a Stop, or the failsafe panel) goes by the run id alone.
 */
function stopIdOf(test: { findings: unknown }): string | null {
  return runIdOf(test) ?? (isEngineRecord(test.findings) ? engineStopIdOf(test.findings) : null);
}

/** The run of a test whose engine run may still be running, or null. */
function unfinishedRunOf(test: { findings: unknown; status: string }): string | null {
  const runId = runIdOf(test);
  return runId !== null && !FINISHED_RUN_STATES.has(test.status) ? runId : null;
}

/** A record counted against Max Concurrent Tests that no stop can name, as the refusal names it. */
interface UnnamedRecord { testId: string; target: string | null }

/**
 * Why a scan was not started at Max Concurrent Tests, and what can stop each
 * run counted against it. A run with a run id is stopped by its Stop, where
 * this app recorded it, or by the kill switch. So is a run the engine lists
 * with no run id that this app recorded with one (`recordedById`): its Stop
 * names it by the recorded id. A run with none is stopped by neither -- no stop
 * can name it -- only by a failsafe, which stops the engine itself. "Stop one"
 * was said over runs no Stop could reach, and "no Stop can name it" over a run
 * whose own Stop worked.
 *
 * Counted from the recorded rows (the engine's list could not be read), a scan
 * with no run id stays recorded as running after the engine has stopped it:
 * this app cannot ask the engine about it. A failsafe stops the engine, not
 * the count. So the refusal names each such record (`unnamedRecords`), and says
 * that deleting it frees its place.
 */
function concurrencyRefusal(
  { running, unnamed, limit, unlisted, recordedById = 0, unnamedRecords = [] }: {
    running: number; unnamed: number; limit: number; unlisted: string | null;
    recordedById?: number; unnamedRecords?: UnnamedRecord[];
  },
): string {
  const named = running - unnamed;
  const counted = `${running} engine scan${running === 1 ? " is" : "s are"} ` +
    (unlisted === null
      ? "running"
      : `recorded as running (the engine's list of live runs could not be read: ${unlisted})`) +
    `, and Max Concurrent Tests on the AI Control page is ${limit}, so this scan was not started.` +
    (recordedById > 0
      ? ` ${recordedById} of them ${recordedById === 1 ? "is" : "are"} listed by the engine with no run id but ` +
        `recorded here with one, and ${recordedById === 1 ? "its" : "their"} Stop names ` +
        `${recordedById === 1 ? "it" : "them"} by that id.`
      : "");
  const byStop = "with its Stop where this app recorded it, or with the kill switch on the AI Control page";
  const byFailsafe = "pause, stand down or terminate the engine from the Failsafe console";
  const n = unnamedRecords.length;
  const stale = n === 0 ? "" :
    ` This app cannot ask the engine about a scan with no run id, so its record stays running after the engine ` +
    `has stopped it, and a failsafe stops the engine but does not clear the record. If ` +
    `${n === 1 ? "it has" : "they have"} stopped, delete ${n === 1 ? "its record" : "their records"} on the Tests ` +
    `screen to free ${n === 1 ? "its place" : "their places"}: ` +
    `${unnamedRecords.map((one) => `${one.target ?? "a scan with no target"} (test ${one.testId})`).join(", ")}.`;
  if (unnamed === 0) return `${counted} Stop one -- ${byStop} -- or raise the limit, to start another.${stale}`;
  const them = (k: number) => (k === 1 ? "it" : "them");
  const noId = (k: number) => `no run id, so no Stop and no kill switch can name ${them(k)}: to stop ` +
    `${k === 1 ? "it" : "one"}, ${byFailsafe}`;
  if (named === 0) {
    return `${counted} ${running === 1 ? "It has" : "They have"} ${noId(running)}.${stale} ` +
      "Or raise the limit, to start another.";
  }
  return `${counted} ${named} of them ${named === 1 ? "has" : "have"} a run id: stop ${named === 1 ? "it" : "one"} ${byStop}. ` +
    `${unnamed} ${unnamed === 1 ? "has" : "have"} ${noId(unnamed)}.${stale} Or raise the limit, to start another.`;
}

/** What one stop came to, before anything about it is written. */
interface StopOutcome {
  /** True only when the engine took the stop: it is stopping the run. */
  stopped: boolean;
  /**
   * The engine answered "not running": the run had ended before the stop
   * arrived, and nothing was stopped -- `stopped` is false, and it is said and
   * logged as not running, never as stopped or accepted.
   */
  alreadyFinished?: boolean;
  /**
   * The engine answered the stop 2xx, but the rest of its answer -- whether it
   * was stopping the run, or had found it already ended -- was not read
   * within engineTimeouts.abortBodyMs: "stop sent, answer unread". `stopped`
   * is true (the 2xx is all that was read), and it is never counted, logged
   * or noted as accepted.
   */
  answerUnread?: boolean;
  /** Why not, in the engine's or the network's words; for an ended run, that it had ended; for a stop whose answer's body never arrived, that. */
  detail: string;
}

/** A stop the engine took, as far as its answer was read: never one whose answer was not read. */
const acceptedStop = (outcome: { stopped: boolean; answerUnread?: boolean }): boolean =>
  outcome.stopped && outcome.answerUnread !== true;

/** How many of the stops sent were answered 2xx with the rest of the answer unread; "" for none. */
function unreadSentence(stops: Array<{ answerUnread?: boolean }>): string {
  const unread = stops.filter((one) => one.answerUnread === true).length;
  return unread === 0 ? "" : ` ${unread} other run${unread === 1 ? " was" : "s were"} sent a stop whose answer was not read ` +
    "(stop sent, answer unread): whether the engine is stopping " + (unread === 1 ? "it" : "them") + " is not known.";
}

/** Whether a stop leaves its run not running: the engine took it, or the run had already ended. */
const notRunningAfter = (outcome: { stopped: boolean; alreadyFinished?: boolean }): boolean =>
  outcome.stopped || outcome.alreadyFinished === true;

const ALREADY_FINISHED = "already finished: the engine answered that the run was no longer running, so there was nothing to stop";
/** How a verdict that came after a stop whose answer was not read is marked: never "despite a stop request". */
const AFTER_UNREAD_STOP = "Completed after a stop whose answer was not read";
const ANSWER_UNREAD =
  "the engine answered the stop 2xx, but the rest of its answer did not arrive in time, so whether it stopped the run " +
  "or found it already ended was not read";

/** A stop's outcome from the engine's answer to it. */
function outcomeOf(outcome: engine.AbortOutcome): StopOutcome {
  if (outcome.alreadyFinished) return { stopped: false, alreadyFinished: true, detail: ALREADY_FINISHED };
  if (!outcome.accepted) return { stopped: false, detail: "the engine did not accept the stop; the scan may still be running" };
  if (outcome.answerUnread) return { stopped: true, answerUnread: true, detail: ANSWER_UNREAD };
  return { stopped: true, detail: "" };
}

/** Send one run the abort its own Stop sends. Reads and writes nothing here. */
async function sendAbort(runId: string): Promise<StopOutcome> {
  try {
    return outcomeOf(await engine.abortRun(runId));
  } catch (cause) {
    return { stopped: false, detail: causeOf(cause) };
  }
}

/** Who a stop was sent by, read once from the request -- in memory -- before the stop goes. */
type Who = ReturnType<typeof actor>;

/**
 * Write what a stop came to. Only ever run after the stop was sent -- for the
 * kill switch, after every stop was -- and never awaited by one. A write that
 * failed does not unsend the stop or hide its outcome; it is counted and said.
 */
async function writeStopRecord(
  who: Who,
  run: { runId: string; target: string | null; testId: string | null },
  via: "kill_switch" | "delete" | "start_not_recorded" | "stop" | "retest_stop",
  outcome: StopOutcome,
  note?: string,
): Promise<string | null> {
  try {
    await storage.createActivityLog({
      // A stop whose answer was not read is recorded as sent, its answer
      // unread -- never as aborted.
      action: outcome.alreadyFinished ? "abort_not_needed"
        : outcome.answerUnread ? "abort_sent_answer_unread"
          : outcome.stopped ? "aborted" : "abort_failed",
      // Against its test when one records it; against the run when none does.
      entityType: run.testId !== null ? "test" : "engine_run",
      entityId: run.testId ?? run.runId,
      details: {
        runId: run.runId, via,
        ...(run.testId === null ? { target: run.target } : {}),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        ...(note ? { note } : {}),
      },
      ...who,
    });
    return null;
  } catch (cause) {
    return `the record of the stop sent to run ${run.runId} could not be written: ${causeOf(cause)}`;
  }
}

/** Send one run its stop, then write what came of it. */
async function sendStop(
  req: Request,
  run: { runId: string; target: string | null; testId: string | null },
  via: "kill_switch" | "delete" | "start_not_recorded",
  note?: string,
): Promise<StopOutcome> {
  const who = actor(req);
  const outcome = await sendAbort(run.runId);
  await writeStopRecord(who, run, via, outcome, note);
  return outcome;
}

/** What one stop sent to a run an unread answer named came to, in a sentence. */
function unreadAnswerStopSentence(runId: string, stop: StopOutcome): string {
  return stop.answerUnread
    ? `Run ${runId} was sent a stop, and the engine answered it 2xx, but the rest of its answer was not read ` +
      "(stop sent, answer unread): whether it is stopping is not known."
    : stop.stopped
      ? `Run ${runId} was sent a stop, and the engine accepted it.`
      : stop.alreadyFinished
        ? `Run ${runId} was sent a stop, and the engine answered that it had already ended.`
        : `Run ${runId} was sent a stop and it did not take (${stop.detail}): it may still be running -- ` +
          "stop it with the kill switch or a failsafe pause.";
}

/** Stop a test's engine run, reported against the test. */
async function stopScan(req: Request, test: { id: string; findings: unknown }, runId: string, via: "kill_switch" | "delete"): Promise<ScanStop> {
  const recorded = test.findings as Record<string, unknown>;
  const target = typeof recorded.target === "string" ? recorded.target : null;
  return { testId: test.id, runId, target, ...(await sendStop(req, { runId, target, testId: test.id }, via)) };
}

/** A run the engine listed as live that no running test here recorded, and what its stop came to. */
interface EngineRunStop {
  runId: string;
  target: string | null;
  /** The test that records this run, when one does (its status says it ended); null when no row does. */
  testId: string | null;
  stopped: boolean;
  alreadyFinished?: boolean;
  detail: string;
}

/**
 * The stops sent to the scans recorded as running, or why they could not all
 * be listed. `scans` on an unlisted answer are the ones this dashboard held in
 * memory, each sent its stop all the same: the list is incomplete, not empty.
 */
type RecordedStops = { listed: true; scans: ScanStop[] } | { listed: false; detail: string; scans?: ScanStop[] };
/**
 * The stops sent to the other runs the engine listed as live, or why its list
 * could not be read. `unnamed`, present only when there are any, counts the
 * live runs it listed with no run id: no stop can name them, so none was sent,
 * and they may still be running.
 */
type EngineSweep =
  | { listed: true; runs: EngineRunStop[]; unnamed?: number }
  /**
   * The list could not be read. `retests`, present only when there are any, are
   * the retests this dashboard knows may still be running (server/retests.ts):
   * each was sent a stop by its engine run id all the same, since that needs no
   * read. `retestsUnlisted`, present only when it is so, says that the
   * retests on record have not been read either (RetestWatcher.resumeState),
   * so no list of them could be made: a retest may still be running that no
   * stop here named.
   */
  | { listed: false; detail: string; retests?: EngineRunStop[]; retestsUnlisted?: string };

type Settled<T> = { ok: true; value: T } | { ok: false; detail: string };
function settle<T>(pending: Promise<T>): Promise<Settled<T>> {
  return pending.then((value) => ({ ok: true as const, value }), (cause) => ({ ok: false as const, detail: causeOf(cause) }));
}

/** The engine scans recorded in these rows as running, by the id a stop names them by. */
function runningScansOf(rows: Test[]): Array<{ test: Test; runId: string }> {
  return rows
    .map((test) => ({ test, runId: unfinishedStopIdOf(test) }))
    .filter((one): one is { test: Test; runId: string } => one.runId !== null);
}

/**
 * Send a stop to everything that may still be running -- every retest this
 * dashboard knows may be (running, or no longer watched), every engine scan
 * recorded as running, and every run the ENGINE lists as live by a run id --
 * and only then write down what came of them.
 *
 * Every stop goes before any write, each run is sent one stop (whichever list
 * names it first), and the stops go concurrently:
 *   - the retests' stops go first, by the ids held in memory;
 *   - the recorded scans' stops go next, from the tests this process holds in
 *     memory (storage.peekAllTests);
 *   - the engine's list, and the tests on the database, are read alongside:
 *     each run on the engine's list that nothing above covered is sent its
 *     stop as soon as the list is in; and each scan the database records as
 *     running that nothing above covered -- another dashboard's among them --
 *     is sent its stop as soon as the database is read, whatever the engine's
 *     list is doing (an engine whose worker threads are all busy may not
 *     answer that list for 20 s).
 * No stop waits on a read another list needs. The records of the stops -- a
 * log line each, and the watches' notes -- are written once every stop has
 * been answered, so no write, however slow or failed, delays another run's
 * stop. A write that failed is counted in `writeFailures` and said.
 */
async function stopEverythingRunning(
  req: Request, watcher: retests.RetestWatcher, press: KillPress,
): Promise<{ stops: RecordedStops; engineRuns: EngineSweep; writeFailures: string[] }> {
  const who = actor(req);
  const records: Array<() => Promise<string | null>> = [];
  /**
   * Every run id a stop was sent to (press.claimed): one stop per run,
   * whichever list names it first -- or a start this press caught in flight
   * (stopForPress), whose stop is its own to report.
   */
  const claim = (runId: string): boolean => {
    if (press.claimed.has(runId)) return false;
    press.claimed.add(runId);
    return true;
  };
  const sendAbort = (runId: string): Promise<StopOutcome> => stopForPress(press, runId);

  const knownRetests = watcher.running();
  const retestStops = Promise.all(knownRetests.filter((one) => claim(one.engineRunId)).map(async (one): Promise<EngineRunStop> => {
    const outcome = await sendAbort(one.engineRunId);
    const run = { runId: one.engineRunId, target: null, testId: one.testId };
    // The watch's note that its stop was accepted -- only when it was -- and
    // the log line, both after every stop has been answered.
    if (outcome.answerUnread) records.push(() => watcher.stopSentUnread(one.engineRunId));
    else if (outcome.stopped) records.push(() => watcher.stopAccepted(one.engineRunId));
    records.push(() => writeStopRecord(who, run, "kill_switch", outcome));
    return { ...run, ...outcome };
  }));

  const stopScan = async ({ test, runId }: { test: Test; runId: string }): Promise<ScanStop> => {
    const recorded = test.findings as Record<string, unknown>;
    const target = typeof recorded.target === "string" ? recorded.target : null;
    const outcome = await sendAbort(runId);
    records.push(() => writeStopRecord(who, { runId, target, testId: test.id }, "kill_switch", outcome));
    return { testId: test.id, runId, target, ...outcome };
  };

  // The scans this process holds in memory as running: sent their stops now.
  const peeked = storage.peekAllTests();
  const memoryStops = Promise.all(runningScansOf(peeked ?? []).filter((one) => claim(one.runId)).map(stopScan));

  // The engine's list and the database's tests, read alongside.
  const engineRead = settle(engine.activeRuns());
  const rowsRead = settle(storage.getAllTests());

  // Each run the engine lists that no stop named yet, as soon as the list is in.
  let unnamed = 0;
  let listedAt = new Map<string | null, string | null>();
  const sweepStops: Promise<Array<Omit<EngineRunStop, "testId">>> = engineRead.then((listed) => {
    if (!listed.ok) return [];
    // Every run a stop can address exactly is sent one (stopIdFrom): a
    // blank-looking id too, which the screens read as no run id but a stop
    // still reaches. Only a run no stop can address is left unnamed.
    const named = listed.value
      .filter((run): run is engine.ActiveRun & { stopId: string } => run.stopId !== null)
      .map((run) => ({ ...run, runId: run.stopId }));
    unnamed = listed.value.length - named.length;
    listedAt = new Map(listed.value.map((run) => [run.stopId, run.target]));
    return Promise.all(named.filter((run) => claim(run.runId)).map(async (run) => {
      const outcome = await sendAbort(run.runId);
      return { runId: run.runId, target: run.target, ...outcome };
    }));
  });

  // The database's running scans -- another dashboard's among them -- as soon
  // as they are read, whatever the engine's list is doing: never after it,
  // and never only once it failed. Each is claimed against the stops already
  // sent, so a run the memory list or the engine's list reached first is not
  // sent a second stop, and the engine's sweep skips what this sent.
  const rowStops: Promise<ScanStop[]> = rowsRead.then((rows) =>
    rows.ok ? Promise.all(runningScansOf(rows.value).filter((one) => claim(one.runId)).map(stopScan)) : []);

  // Every stop has been sent; wait for their answers.
  const [retestsDone, memoryDone, sweepDone, rowsDone] = await Promise.all([retestStops, memoryStops, sweepStops, rowStops]);
  const listed = await engineRead;
  // Whether the scans stopped make a complete list: the database's read is
  // needed for that only when this process never held the tests, or the
  // engine's list could not be read (then the database is the only place
  // another dashboard's scan is recorded).
  const needRows = peeked === null || !listed.ok;
  const read = await rowsRead;
  const rows: Settled<Test[]> = needRows ? read : { ok: true, value: read.ok ? read.value : (peeked ?? []) };
  const tests = rows.ok ? rows.value : (peeked ?? []);
  const recordedBy = new Map<string, Test>();
  for (const test of tests) {
    const runId = stopIdOf(test);
    if (runId !== null) recordedBy.set(runId, test);
  }
  // A run the engine's list reached first that a test records as running is
  // that test's scan, and is said as one.
  const scans: ScanStop[] = [...memoryDone, ...rowsDone];
  const others: EngineRunStop[] = [];
  for (const run of sweepDone) {
    const test = recordedBy.get(run.runId);
    if (test && unfinishedStopIdOf(test) === run.runId) {
      scans.push({ ...run, testId: test.id });
      records.push(() => writeStopRecord(who, { runId: run.runId, target: run.target, testId: test.id }, "kill_switch", run));
    } else {
      others.push({ ...run, testId: test?.id ?? null });
      records.push(() => writeStopRecord(who, { runId: run.runId, target: run.target, testId: test?.id ?? null }, "kill_switch", run));
    }
  }

  // Then write.
  const writeFailures = (await Promise.all(records.map((write) => write()))).filter((one): one is string => one !== null);

  const resumed = watcher.resumeState();
  const engineRuns: EngineSweep = listed.ok
    ? {
      listed: true,
      runs: [...others, ...retestsDone.map((one) => ({ ...one, target: listedAt.get(one.runId) ?? null }))],
      ...(unnamed > 0 ? { unnamed } : {}),
    }
    : {
      listed: false,
      detail: listed.detail,
      ...(retestsDone.length > 0 ? { retests: retestsDone } : {}),
      ...(!resumed.loaded
        ? {
          retestsUnlisted: "the retests on record could not be read either" +
            (resumed.lastError ? ` (${resumed.lastError})` : " (the read is still in progress)") +
            ", so no list of the retests could be made: a retest this dashboard has not read may still be running",
        }
        : {}),
    };
  const stops: RecordedStops = rows.ok
    ? { listed: true, scans }
    : {
      listed: false,
      detail: peeked !== null
        ? `the scans recorded on the database could not be read (${rows.detail}); the ${scans.length} this dashboard held as running were sent a stop`
        : rows.detail,
      ...(scans.length > 0 ? { scans } : {}),
    };
  return { stops, engineRuns, writeFailures };
}

/**
 * Stop the unfinished engine runs of tests about to be deleted, before they go.
 *
 * Deleting a running scan's row -- directly, or by deleting its client --
 * told the engine nothing. The run went on against the customer's system,
 * and with the row went its Stop (the abort route answered 404) and the kill
 * switch's view of it. So each run is sent a stop first, and a row is deleted
 * only once the engine has accepted its stop.
 */
function stopBeforeDeleting(req: Request, tests: Array<{ id: string; findings: unknown; status: string }>): Promise<ScanStop[]> {
  return Promise.all(tests.flatMap((test) => {
    // By any id a stop can address exactly, blank-looking ones included.
    const runId = unfinishedStopIdOf(test);
    return runId === null ? [] : [stopScan(req, test, runId, "delete")];
  }));
}

/** Refuse a delete while any of its runs could not be stopped: nothing is deleted, and the stops are reported. */
function refuseUnstoppedDelete(res: Response, what: string, stops: ScanStop[]): boolean {
  const failed = stops.filter((one) => !notRunningAfter(one));
  if (failed.length === 0) return false;
  const accepted = stops.filter(acceptedStop).length;
  res.status(409).json({
    message:
      `Nothing was deleted. ${failed.map((one) => `Engine run ${one.runId}${one.target ? ` (${one.target})` : ""} ` +
        `may still be running and could not be stopped: ${one.detail}.`).join(" ")} ` +
      `Stop ${failed.length === 1 ? "it" : "them"} first -- the scan's Stop on the Tests screen, the kill switch, ` +
      `or a failsafe pause -- then delete ${what}.` +
      (accepted > 0 ? ` ${accepted} other run${accepted === 1 ? " was" : "s were"} stopped: the engine accepted the stop.` : "") +
      unreadSentence(stops) + endedSentence(stops),
    stops,
  });
  return true;
}

/** How many of the runs sent a stop the engine answered were not running; "" for none. */
function endedSentence(stops: Array<{ alreadyFinished?: boolean }>): string {
  const ended = stops.filter((one) => one.alreadyFinished).length;
  return ended === 0 ? "" : ` ${ended} other run${ended === 1 ? " had" : "s had"} already ended: the engine answered "not running", so nothing was stopped.`;
}

/** What the deletes' stops came to, for the log: the runs stopped, and the runs the engine answered were not running. */
function stopsForLog(stops: ScanStop[]): Record<string, string[]> {
  const stopped = stops.filter(acceptedStop).map((one) => one.runId);
  const unread = stops.filter((one) => one.answerUnread === true).map((one) => one.runId);
  const ended = stops.filter((one) => one.alreadyFinished).map((one) => one.runId);
  return {
    ...(stopped.length > 0 ? { stopped } : {}),
    ...(unread.length > 0 ? { stopSentAnswerUnread: unread } : {}),
    ...(ended.length > 0 ? { notRunning: ended } : {}),
  };
}

/** An engine scan that may still be running and that no stop can name: the engine gave it no run id a stop can address. */
function unfinishedWithoutRunId(test: { findings: unknown; status: string }): boolean {
  return !FINISHED_RUN_STATES.has(test.status) && isEngineRecord(test.findings) && stopIdOf(test) === null;
}

/**
 * Refuse, unless forced (`?force=1`), a delete that takes with it a scan that
 * may still be running and that no stop can name.
 *
 * Such a scan was deleted at once (200): no stop was sent -- none can name it --
 * and no warning given, and a run that may still be scanning disappeared from
 * this app. It is deleted now only when asked in so many words, and the answer
 * says no stop was sent. This refuses a delete, never a stop: every stop the
 * delete could send was sent before this is asked.
 */
function refuseUnforcedDeleteWithoutStop(
  req: Request, res: Response, what: string, tests: Array<{ id: string; findings: unknown; status: string }>, stops: ScanStop[],
): boolean {
  if (req.query.force === "1" || req.query.force === "true") return false;
  const unnamed = tests.filter(unfinishedWithoutRunId);
  if (unnamed.length === 0) return false;
  const targets = unnamed.map((one) => {
    const target = (one.findings as { target?: unknown }).target;
    return typeof target === "string" ? target : `test ${one.id}`;
  });
  const n = unnamed.length;
  const accepted = stops.filter(acceptedStop).length;
  res.status(409).json({
    message:
      `Nothing was deleted. ${n === 1 ? "A scan" : `${n} scans`} (${targets.join(", ")}) may still be running, and the ` +
      `engine gave ${n === 1 ? "it" : "them"} no run id a stop can name, so no stop can be sent. Stop ` +
      `${n === 1 ? "it" : "them"} from the Failsafe console first (pause, stand down or terminate the engine), or ` +
      `delete ${what} with force: ${n === 1 ? "its record goes" : "their records go"}, and no stop is sent.` +
      (accepted > 0
        ? ` ${accepted} other run${accepted === 1 ? " was" : "s were"} sent a stop, and the engine accepted ${accepted === 1 ? "it" : "each"}.`
        : "") + unreadSentence(stops) + endedSentence(stops),
    reason: "no_stop_possible",
    noStop: unnamed.map((one, index) => ({ testId: one.id, target: targets[index] })),
    stops,
  });
  return true;
}
const createDocumentSchema = insertDocumentSchema.omit({ createdBy: true, isSample: true });

const updateClientSchema = createClientSchema.partial();
const updateSiteSchema = createSiteSchema.partial();
// Derived from the create schemas, so attribution is excluded on update too.
// It was stripped on create and left open on update, which meant any
// authenticated user could rewrite "who ran this test" to anyone.
const updateTestSchema = createTestSchema.partial();
const updateDocumentSchema = createDocumentSchema.partial();

/**
 * Refuse a body that tries to set attribution, rather than quietly dropping it.
 *
 * Omitting the field from the schema keeps the forged value out of the record,
 * but zod strips unknown keys silently, so the write answered 200 and the
 * caller had every reason to believe "executed by" now said what they sent.
 * In an audit product that is the difference between a rejected forgery and an
 * apparently accepted one.
 */
const ATTRIBUTION_FIELDS = ["executedBy", "createdBy"] as const;

function forgedAttribution(res: Response, body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const named = ATTRIBUTION_FIELDS.filter((field) => field in (body as Record<string, unknown>));
  if (named.length === 0) return false;
  res.status(400).json({
    message: `${named.join(" and ")} is recorded from the signed-in session and cannot be supplied`,
  });
  return true;
}
/**
 * What of an engine scan's test row the engine owns, and so no edit may change.
 *
 * The Tests screen's Edit dialog sent `findings: { details: <the textarea> }`,
 * and for an engine test the textarea held the JSON of {runId, target,
 * results}. Fixing a typo in a running scan's summary wrote over the run id:
 * its Stop answered "no engine run recorded, nothing to stop" while the engine
 * went on scanning the customer's system, the status route stopped asking the
 * engine, and whatever it found was never filed. On a completed scan, the
 * findings summary began flagging a filed critical as untracked.
 *
 * So for a test with an engine run behind it:
 *   - the run's own keys in `findings` (runId, target, results, and any
 *     other the engine writes) are KEPT whatever the body says; only
 *     `details`, a person's notes, is taken from it, and a body that tries to
 *     change one of the run's keys is refused like the fields below;
 *   - a change to anything else the engine or the scan route decided -- the
 *     engagement it ran under, its status, its counts and severity, when it
 *     completed -- is REFUSED (409), naming the fields. Sending them back
 *     unchanged is fine, so a form that sends every field still saves.
 * The summary, the test type and the notes stay a person's to edit. A test no
 * engine run stands behind may not be given one here: a run id is recorded by
 * the scan route that started the run, never supplied.
 */
const ENGINE_OWNED_TEST_FIELDS = [
  "clientId", "siteId", "status", "severity", "completedAt",
  "vulnerabilitiesFound", "criticalCount", "highCount", "mediumCount", "lowCount",
] as const;
/** The one key of an engine test's `findings` a person writes; every other key is the run's. */
const HUMAN_FINDINGS_KEY = "details";

/**
 * The keys of `findings` that only the scan route writes, from the run it
 * started: they are what makes a row an engine scan to every other part of
 * the app.
 */
const ENGINE_FINDINGS_KEYS = ["runId", "target", "results"] as const;

/**
 * Refuse a person's test whose findings carry a run's keys, on create as on
 * update.
 *
 * The rule was enforced on PATCH only. POST /api/tests took `findings` as
 * free JSON, so a test created with `findings: { runId: "run-1" }` became an
 * engine scan: the Tests screen called it "recorded by the engine", the
 * status route asked the engine for run-1 and filed another client's results
 * under this one, and the run keys were then engine-owned, so the forgery
 * could not be edited away. A key sent as null supplies nothing and is not
 * refused.
 */
function suppliedEngineKeys(res: Response, findings: unknown): boolean {
  if (!findings || typeof findings !== "object" || Array.isArray(findings)) return false;
  const sent = findings as Record<string, unknown>;
  const named = ENGINE_FINDINGS_KEYS.filter((key) => sent[key] !== undefined && sent[key] !== null);
  if (named.length === 0) return false;
  res.status(400).json({
    message: `${named.map((key) => `findings.${key}`).join(", ")} ${named.length === 1 ? "is" : "are"} recorded ` +
      "by the scan that started an engine run and cannot be supplied",
  });
  return true;
}

/** Whether a value sent back is the one on record: null and absent alike, a date by its instant. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function engineRecordEdited(
  res: Response,
  before: { findings: unknown } & Record<string, unknown>,
  data: { findings?: unknown } & Record<string, unknown>,
): boolean {
  const sent = data.findings && typeof data.findings === "object" && !Array.isArray(data.findings)
    ? (data.findings as Record<string, unknown>)
    : null;
  // An engine scan by the one rule the status route and the Tests screen use
  // (shared/engine-record.ts): a run id, a target or a run's results. Guarded by
  // its run id alone, a run the engine finished inline without one could have
  // its counts edited to disagree with the findings the scan screens list.
  if (!isEngineRecord(before.findings)) return suppliedEngineKeys(res, data.findings);

  const recorded = before.findings as Record<string, unknown>;
  const changed: string[] = ENGINE_OWNED_TEST_FIELDS.filter(
    (field) => data[field] !== undefined && !sameValue(data[field], before[field]),
  );
  for (const key of Object.keys(sent ?? {})) {
    if (key !== HUMAN_FINDINGS_KEY && !sameValue(sent![key], recorded[key])) changed.push(`findings.${key}`);
  }
  if (changed.length > 0) {
    res.status(409).json({
      message: `${changed.join(", ")} of an engine scan ${changed.length === 1 ? "is" : "are"} recorded from ` +
        "the engine and cannot be edited; the summary, the test type and the notes can",
    });
    return true;
  }

  if (data.findings !== undefined) {
    const { [HUMAN_FINDINGS_KEY]: _notes, ...kept } = recorded;
    const notes = sent?.[HUMAN_FINDINGS_KEY];
    data.findings = typeof notes === "string" && notes.trim() !== "" ? { ...kept, [HUMAN_FINDINGS_KEY]: notes } : kept;
  }
  return false;
}

/**
 * What an AI Control change may set.
 *
 * Auto-Shutdown Threshold ("system load threshold for automatic safety
 * shutdown") and Override Mode ("bypass safety protocols") were stored and
 * read by nothing: no load is measured, nothing shuts down on one, and there
 * is no protocol here to bypass. A control that does nothing, offered as a
 * safety control, is worse than none -- someone relies on it. They are no
 * longer offered, and a change that sets one is refused, naming it
 * (refusedAIControlFields) -- unless it engages the kill switch, which is
 * never refused (engagingAIControlChange); the columns stay, unread, so no
 * stored install breaks. Max Concurrent Tests is enforced when a scan starts, so it is a
 * real limit of at least one.
 */
const updateAIControlSettingSchema = insertAIControlSettingSchema
  .omit({ overrideMode: true, autoShutdownThreshold: true })
  .extend({ maxConcurrentTests: z.number().int().min(1).max(1000) })
  .partial();

const UNENFORCED_AI_CONTROL_FIELDS = ["overrideMode", "autoShutdownThreshold"] as const;

function refusedAIControlFields(res: Response, body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const named = UNENFORCED_AI_CONTROL_FIELDS.filter((field) => field in (body as Record<string, unknown>));
  if (named.length === 0) return false;
  res.status(400).json({
    message: `${named.join(" and ")} ${named.length === 1 ? "is" : "are"} not enforced by this build -- nothing ` +
      "measures load or shuts down on it, and there is no protocol to bypass -- so it cannot be set",
  });
  return true;
}

/**
 * What an engaging change stores. Engaging the kill switch is never refused
 * over the other fields sent with it: a field this build does not take (an
 * unenforced one, or a value the schema refuses) is left out and named, and
 * the switch is engaged and the stops sent all the same.
 */
function engagingAIControlChange(body: Record<string, unknown>): {
  data: z.infer<typeof updateAIControlSettingSchema>;
  ignored: string[];
} {
  const ignored = new Set<string>(UNENFORCED_AI_CONTROL_FIELDS.filter((field) => field in body));
  const without = () => Object.fromEntries(Object.entries(body).filter(([key]) => !ignored.has(key)));
  let parsed = updateAIControlSettingSchema.safeParse(without());
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.path.length > 0) ignored.add(String(issue.path[0]));
    }
    parsed = updateAIControlSettingSchema.safeParse(without());
  }
  return { data: parsed.success ? parsed.data : { killSwitchEnabled: true }, ignored: Array.from(ignored) };
}
const updateClassifierSchema = insertClassifierSchema.partial();

/**
 * Users may only have these fields changed after creation. Username is
 * immutable, and the schema is strict so unknown keys are rejected rather
 * than silently accepted.
 */
const updateUserSchema = z
  .object({
    email: z.string().email().max(254).nullable(),
    role: z.enum(USER_ROLES),
    isActive: z.boolean(),
    password: z.string().min(8).max(256),
  })
  .partial()
  .strict();

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

// The renderer is same-origin now, so no cross-origin browser client is
// expected. The set is kept empty rather than removed so that adding one
// later is a one-line change rather than a rediscovery.
/**
 * Reject a child record whose parent does not exist.
 *
 * There are no foreign keys, and nothing validated these, so a test could be
 * created against any client id at all. It also narrows the window in which a
 * create racing a client deletion leaves an orphan behind.
 */
async function parentMissing(res: Response, clientId?: string | null, siteId?: string | null): Promise<boolean> {
  if (clientId && !(await storage.getClient(clientId))) {
    res.status(400).json({ message: "No such client" });
    return true;
  }
  if (siteId && !(await storage.getSite(siteId))) {
    res.status(400).json({ message: "No such site" });
    return true;
  }
  return false;
}


/**
 * Refuse mutations while the kill switch is on.
 *
 * The switch was persisted, shown in the UI, and enforced nowhere: with
 * killSwitchEnabled true and systemStatus "shutdown", every write still
 * succeeded. An emergency stop that stops nothing is worse than none, because
 * someone will rely on it.
 *
 * The AI control route itself is exempt, or the switch could never be turned
 * back off.
 */
const killSwitchExempt = new Set(["/api/ai-control", "/api/auth/login", "/api/auth/logout"]);

/**
 * The failsafe actions that stop an engine, and the two that put one back to
 * work. Only the first kind is ever let past an engaged kill switch.
 */
const FAILSAFE_STOP_ACTIONS = new Set(["pause", "stand_down", "terminate"]);
const FAILSAFE_RECOVER_ACTIONS = new Set(["resume", "release"]);

/**
 * What a write is, as far as the kill switch is concerned.
 *
 * The switch refused every write but its own, so the moment an admin engaged
 * it every OTHER stop went out of reach: a running scan's Stop, and drafting
 * or co-signing a failsafe pause, stand-down or terminate, all answered 503 --
 * while the scan kept running, because the switch told the engine nothing.
 * An emergency stop that takes the other stops away at exactly the moment
 * someone reaches for them is worse than none.
 *
 *   "stop"    -- a scan's Stop, a failsafe draft whose action is a stop, and
 *                revoking an API key (it only takes access away). Never
 *                refused, and decided without reading anything, so no failed
 *                read can stand in its way either.
 *   "command" -- a signature for, or the withdrawal of, a failsafe command.
 *                Whether it may pass depends on the command's action, so it
 *                is decided in the route's own handler
 *                (killSwitchRefusesCommand), from the uuid Express decoded
 *                for it -- exactly the one that handler relays.
 *   null      -- an ordinary write: refused while the switch is engaged.
 *
 * Case-insensitive, as Express's own routing is, so a spelling that reaches a
 * stop's handler is a stop here too.
 */
type KillSwitchClass = { kind: "stop" | "command" } | null;

function killSwitchClass(method: string, fullPath: string, body: unknown): KillSwitchClass {
  if (method === "POST" && /^\/api\/scans\/[^/]+\/abort$/i.test(fullPath)) return { kind: "stop" };
  // A retest's Stop, by the engine run id it runs under: a scan's Stop by another route.
  if (method === "POST" && /^\/api\/retests\/[^/]+\/abort$/i.test(fullPath)) return { kind: "stop" };
  if (method === "DELETE" && /^\/api\/api-keys\/[^/]+$/i.test(fullPath)) return { kind: "stop" };
  if (method === "POST" && /^\/api\/failsafe\/commands$/i.test(fullPath)) {
    const action = body && typeof body === "object" ? (body as { action?: unknown }).action : undefined;
    return typeof action === "string" && FAILSAFE_STOP_ACTIONS.has(action) ? { kind: "stop" } : null;
  }
  if (method === "POST" && /^\/api\/failsafe\/commands\/[^/]+\/(signatures|cancel)$/i.test(fullPath)) {
    return { kind: "command" };
  }
  return null;
}

/** A command's action as a signature relay or a withdrawal learns it (failsafe.readActionWithin): at most one bounded read. */
type ActionRead = Awaited<ReturnType<typeof failsafe.readActionWithin>>;

/** The one read of a request's command's action: its guard and its handler share it, so the command is never read twice. */
const actionReads = new WeakMap<Request, Promise<ActionRead>>();
function actionOfRequest(req: Request): Promise<ActionRead> {
  let read = actionReads.get(req);
  if (!read) {
    read = failsafe.readActionWithin(req.params.uuid, failsafe.failsafeTimeouts.commandReadMs);
    actionReads.set(req, read);
  }
  return read;
}

const KILL_SWITCH_REFUSAL =
  "The AI kill switch is engaged. Writes are disabled, except stops: a scan's Stop, and a failsafe " +
  "pause, stand-down or terminate, stay available.";

// ==== The kill switch, as this dashboard pressed it ====
//
// The switch's flag is stored in the settings row, and that write can wait
// for a lock (storage-sqlite.ts withBusyRetry) while the engage's stops go
// out. Until it landed, every read of the row said the switch was off: a scan
// started 100 ms after the press passed the switch, reached the engine and
// ran on, never sent a stop. So the press is held in memory, set
// synchronously when the engage is authorised -- before anything is awaited
// or any write queued -- and every check reads memory first: the switch is
// engaged when memory OR the stored row says so.

/**
 * One press of the kill switch: the stops it sent, by run id -- each run is
 * sent one stop per press, whichever of its lists (or a start caught in
 * flight) names it first -- and each stop's outcome.
 */
interface KillPress {
  seq: number;
  claimed: Set<string>;
  stops: Map<string, Promise<StopOutcome>>;
}

/**
 * The switch as this dashboard pressed it. `engaged` is set when an engage is
 * authorised, and cleared only by a write of the flag at least as late as it
 * (its own, once stored -- from then on the stored row decides, so another
 * dashboard's disengage is honoured -- or a later disengage's). An engage
 * whose flag could not be stored stays engaged here (`notStored` says why)
 * until a disengage is stored from this dashboard: its writes are refused,
 * though another dashboard does not see it, and a restart forgets it.
 */
const killSwitchMemory: { engaged: boolean; seq: number; notStored: string | null } = { engaged: false, seq: 0, notStored: null };

/** Whether this dashboard holds the switch engaged in memory (a press whose flag is not stored yet, or could not be). */
export function killSwitchEngagedInMemory(): boolean {
  return killSwitchMemory.engaged;
}

/**
 * A scan's or a retest's start, from the moment it arrives until it is
 * answered. A press marks every one in flight (`press`): one not yet sent to
 * the engine is not sent, and one the engine accepted after the press is
 * stopped at once, by its run id.
 */
interface StartTicket {
  kind: "scan" | "retest";
  press: KillPress | null;
  /** The stop this start's run was sent because of `press`, once sent. */
  stopped: Promise<StopOutcome> | null;
}
const startsInFlight = new Set<StartTicket>();
const startTickets = new WeakMap<Request, StartTicket>();

/** Every scan or retest start is registered the moment it arrives, before anything is read or awaited. */
function trackStart(kind: StartTicket["kind"]): RequestHandler {
  return (req, res, next) => {
    const ticket: StartTicket = { kind, press: null, stopped: null };
    startsInFlight.add(ticket);
    startTickets.set(req, ticket);
    const done = () => { startsInFlight.delete(ticket); };
    res.once("finish", done);
    res.once("close", done);
    next();
  };
}

/**
 * Press the switch: synchronously, as soon as the engage is authorised. Held
 * engaged in memory (unless a later write of the flag already overtook this
 * press), and every start in flight is marked.
 */
function pressKillSwitch(seq: number, flagWrittenLaterThan: (seq: number) => boolean): KillPress {
  const press: KillPress = { seq, claimed: new Set(), stops: new Map() };
  if (!flagWrittenLaterThan(seq)) {
    killSwitchMemory.engaged = true;
    killSwitchMemory.seq = Math.max(killSwitchMemory.seq, seq);
    killSwitchMemory.notStored = null;
  }
  startsInFlight.forEach((ticket) => { ticket.press = press; });
  return press;
}

/** A write of the flag (either way) with this sequence number was stored: memory lets go of every press it is at least as late as. */
function killSwitchFlagStored(seq: number): void {
  if (killSwitchMemory.engaged && seq >= killSwitchMemory.seq) {
    killSwitchMemory.engaged = false;
    killSwitchMemory.notStored = null;
  }
}

/** An engage's flag could not be stored: it stays engaged in memory, and this says why. */
function killSwitchFlagNotStored(seq: number, why: string): void {
  if (killSwitchMemory.engaged && seq === killSwitchMemory.seq) killSwitchMemory.notStored = why;
}

/** Send a run its stop for a press: one per run per press, shared with whichever list named it first. */
function stopForPress(press: KillPress, runId: string): Promise<StopOutcome> {
  let sent = press.stops.get(runId);
  if (!sent) {
    press.claimed.add(runId);
    sent = sendAbort(runId);
    press.stops.set(runId, sent);
  }
  return sent;
}

/**
 * The stop sent to a run the engine accepted for a start the kill switch
 * caught in flight (its ticket was marked by a press), or null when there is
 * none to send: no press since it arrived, a run the engine finished or
 * refused, or no id a stop can name. Sent once per start (the ticket keeps
 * it), and once per run per press (stopForPress).
 */
function stoppedByKillSwitch(
  ticket: StartTicket | null, started: { state: string; runId: string | null; stopId?: string | null },
): Promise<StopOutcome> | null {
  if (ticket === null) return null;
  if (ticket.stopped !== null) return ticket.stopped;
  if (ticket.press === null || started.state === "completed" || started.state === "refused") return null;
  const runId = started.stopId ?? started.runId;
  if (!runId) return null;
  ticket.stopped = stopForPress(ticket.press, runId);
  return ticket.stopped;
}

/**
 * A start's ticket marked when ANOTHER dashboard on this database engaged the
 * switch -- its press cannot mark this dashboard's starts -- read from the
 * stored row now: before a start is sent, and once the engine has answered
 * it. A read that fails marks nothing (the entry check already read it, and
 * the run, once recorded, is on the row every sweep reads).
 */
async function markIfEngagedElsewhere(ticket: StartTicket | null): Promise<void> {
  if (ticket === null || ticket.press !== null) return;
  const stored = await storage.getKillSwitchState().then((one) => one?.killSwitchEnabled === true, () => false);
  if (stored && ticket.press === null) ticket.press = { seq: 0, claimed: new Set(), stops: new Map() };
}

const KILL_SWITCH_START_NOTE = "started while the kill switch was being pressed: stopped as soon as the engine answered the start";

/** What a start the kill switch caught in flight came to, in words. */
function killSwitchStartSentence(runId: string, stop: StopOutcome): string {
  return `Engine run ${runId} was stopped by the kill switch pressed while it was starting: ` + (
    stop.answerUnread ? "the engine answered its stop 2xx, but the rest of the answer was not read (stop sent, answer unread)."
      : stop.stopped ? "the engine accepted the stop."
        : stop.alreadyFinished ? "the engine answered that it had already ended."
          : `the stop did not take (${stop.detail}): it may still be running -- press the kill switch again, or use a failsafe pause.`);
}

/** Whether the switch is engaged now: in memory, or on the stored row (read only when memory does not already say so). */
async function killSwitchEngagedNow(): Promise<{ engaged: boolean; systemStatus: string | null }> {
  if (killSwitchMemory.engaged) return { engaged: true, systemStatus: "shutdown" };
  const state = await storage.getKillSwitchState();
  return { engaged: state?.killSwitchEnabled === true, systemStatus: state?.systemStatus ?? null };
}

/**
 * Whether the engaged kill switch refuses this signature relay or withdrawal,
 * from the action its request already learnt (actionOfRequest: never a
 * second read).
 *
 *   relay  -- a stop's signature, or one whose action could not be learnt in
 *             time (it may be a stop's), is never refused, and nothing is
 *             read for it. A resume's or a release's is refused while the
 *             switch is engaged -- in memory from the instant it was pressed,
 *             or on the stored row; when the row cannot be read, it is
 *             refused too (it is not a stop). One relayed as a possible stop
 *             that turns out to be a resume's or a release's is withdrawn
 *             once that is learnt (withdrawPossibleStop).
 *   cancel -- withdrawing a resume or a release is let through (it keeps an
 *             engine stopped); withdrawing a stop is refused, and so is one
 *             whose command could not be read.
 *
 * Called by the route's handler with req.params.uuid, the uuid Express
 * decoded and the handler relays: one reading of the uuid, as its guard's.
 */
async function killSwitchRefusesCommand(res: Response, kind: "relay" | "cancel", read: ActionRead): Promise<boolean> {
  const action = read.action;
  if (kind === "relay" && (action === null || !FAILSAFE_RECOVER_ACTIONS.has(action))) return false;
  if (kind === "cancel" && action !== null && FAILSAFE_RECOVER_ACTIONS.has(action)) return false;
  let now: { engaged: boolean; systemStatus: string | null };
  try {
    now = await killSwitchEngagedNow();
  } catch (cause) {
    res.status(503).json({
      message: `Whether the AI kill switch is engaged could not be read (${causeOf(cause)}), and this is not a stop. ` +
        "Nothing was done; try again.",
    });
    return true;
  }
  if (!now.engaged) return false;
  res.status(503).json({ message: KILL_SWITCH_REFUSAL, systemStatus: now.systemStatus });
  return true;
}

export const enforceKillSwitch: RequestHandler = (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  // Mounted under "/api", so req.path is relative to that mount: the AI
  // control route arrives here as "/ai-control", not "/api/ai-control".
  // Comparing the full path silently exempted nothing, which would have left
  // no way to switch the kill switch back off.
  const fullPath = `${req.baseUrl}${req.path}`.replace(/\/+$/, "") || req.path;
  if (killSwitchExempt.has(fullPath)) {
    next();
    return;
  }
  const kind = killSwitchClass(req.method, fullPath, req.body);
  // Before the settings are read: a stop does not wait on that read, or fail
  // with it; and a command's handler decides for itself.
  if (kind !== null) {
    next();
    return;
  }

  // Engaged in memory from the instant it was pressed: refused at once, with
  // no read -- the stored row may not say so yet.
  if (killSwitchMemory.engaged) {
    res.status(503).json({ message: KILL_SWITCH_REFUSAL, systemStatus: "shutdown" });
    return;
  }
  (async () => {
    const state = await storage.getKillSwitchState();
    if (!state?.killSwitchEnabled && !killSwitchMemory.engaged) return void next();
    res.status(503).json({ message: KILL_SWITCH_REFUSAL, systemStatus: state?.systemStatus ?? "shutdown" });
  })().catch(next);
};

/**
 * Whether a request path is aimed at the API, whatever spelling it arrived in.
 *
 * Decodes once, collapses repeated slashes, and resolves dot segments, so
 * "/./api/x", "/y/../api/x", "//api/x" and "/%61pi/x" all read as API paths.
 */
function looksLikeApiPath(rawPath: string): boolean {
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    // A malformed escape cannot be decoded; test what we were given.
  }

  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments[0]?.toLowerCase() === "api";
}

/** Refuse a query parameter that was supplied more than once. */
function badQueryParam(res: Response, value: unknown): boolean {
  if (value !== undefined && typeof value !== "string") {
    res.status(400).json({ message: "Query parameters must be supplied once" });
    return true;
  }
  return false;
}

/** Whether a parsed update actually carries a change worth recording. */
function hasChanges(data: object): boolean {
  return Object.values(data).some((value) => value !== undefined);
}

const ALLOWED_ORIGINS = new Set<string>([]);

/**
 * Login throttling.
 *
 * There was none: 200 failed sign-ins in seven seconds all answered 401 and the
 * account still worked afterwards. Failures are counted per address and
 * username; a successful sign-in clears the counter.
 */
const LOGIN_MAX_FAILURES = 10;
// Higher than the per-username limit: several people can share one address.
const LOGIN_MAX_FAILURES_PER_ADDRESS = 50;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map<string, { count: number; first: number }>();

function loginKey(req: Request, username: string): string {
  // Not lowercased. The account lookup is case sensitive, so folding here let
  // an attacker who knew only the lowercase spelling of a username lock the
  // real account out by failing ten times against a casing that does not exist.
  return `${req.ip ?? "unknown"}|${username}`;
}

/** A second bucket, per address only, so a spray across usernames is bounded. */
function addressKey(req: Request): string {
  return `addr|${req.ip ?? "unknown"}`;
}

function loginBlocked(key: string, now: number, limit = LOGIN_MAX_FAILURES): boolean {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (now - entry.first > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= limit;
}

const LOGIN_MAP_LIMIT = 10_000;

function recordLoginFailure(key: string, now: number): void {
  // Bounding runs first. It used to sit after the early return below, which is
  // the path a spray across many usernames always takes, so the one case the
  // bound existed for could never reach it.
  if (loginFailures.size >= LOGIN_MAP_LIMIT) {
    pruneLoginFailures(now);
  }

  const entry = loginFailures.get(key);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, first: now });
    return;
  }
  entry.count += 1;
}

function pruneLoginFailures(now: number): void {
  const entries = Array.from(loginFailures.entries());
  for (const [key, value] of entries) {
    if (now - value.first > LOGIN_WINDOW_MS) loginFailures.delete(key);
  }

  // Still over the cap means nothing had expired, which is exactly what a fast
  // spray looks like. Drop the oldest until it fits.
  if (loginFailures.size >= LOGIN_MAP_LIMIT) {
    Array.from(loginFailures.entries())
      .sort((a, b) => a[1].first - b[1].first)
      .slice(0, Math.ceil(LOGIN_MAP_LIMIT / 4))
      .forEach(([key]) => loginFailures.delete(key));
  }
}

/** Exported for tests, which need a clean slate between cases. */
export function resetLoginThrottle(): void {
  loginFailures.clear();
}

function publicUser(user: User): PublicUser {
  const { password: _password, ...rest } = user;
  return rest;
}

/** An API key as it is safe to return: the hash never leaves the server. */
function publicApiKey(key: ApiKey): PublicApiKey {
  const { keyHash: _keyHash, ...rest } = key;
  return rest;
}

function notFound(res: Response, what: string): void {
  res.status(404).json({ message: `${what} not found` });
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

// ==== RETEST: filing a verdict, and answering a status ====

/** Who asked for a retest. A verdict collected later is filed as theirs, and says it was collected. */
interface RetestAsker {
  userId: string | null;
  actor: { userId: string | null; ipAddress: string | null };
}

interface RetestContext {
  test: { id: string; findings: unknown };
  client: { id: string };
  twinId: number;
  who: RetestAsker;
}

/**
 * The finding a retested twin is about, found from the twin's own recorded
 * place, fetched from the engine -- not from anything the caller sent. A caller
 * who could name the finding to mark fixed could mark any finding fixed, which
 * is the one thing this lifecycle exists to prevent. Throws EngineUnavailable
 * when the engine cannot be asked.
 */
async function findingOfTwin(
  test: { findings: unknown }, clientId: string, twinId: number,
): Promise<{ finding: Finding } | { missing: string }> {
  const runId = runIdOf(test);
  if (!runId) return { missing: "this test has no engine run recorded, so its finding cannot be found" };
  const listed = await engine.listDecisions(runId);
  const twin = listed.decisions.find((one) => one.id === twinId);
  if (!twin) return { missing: `the engine no longer lists decision ${twinId} for this test's run` };
  const key = lifecycle.fingerprint(clientId, {
    type: twin.findingType,
    severity: null, message: null,
    target: twin.target,
    endpoint: twin.endpoint,
    header: null,
  });
  const finding = await storage.findFindingByFingerprint(clientId, key);
  return finding ? { finding } : { missing: "no finding on record matches this decision" };
}

/**
 * What a VERDICT changes: the finding's status, a fix on `closed` only, and
 * an appended check -- filed against the scan record the retest produced
 * (`result.runId`: `scan_record_id` on athena-engine #71), never against the
 * registry id a stop names, which the check keeps as `engineRunId`.
 */
function retestFiling(
  finding: Finding,
  result: engine.RetestResult,
  how: {
    requestedBy: string | null; requestedAt: Date; filedVia: "retest_request" | "retest_watch";
    /** The engine accepted a stop for this run, and it completed with this verdict anyway. */
    completedDespiteStop?: boolean;
    /** A stop was sent for this run, its answer unread, and it completed with this verdict after it. */
    completedAfterUnreadStop?: boolean;
    /** The run ended stopped after its check was recorded, by a stop this dashboard sent and the engine took. */
    stopTakenHere?: boolean;
    /** The run ended stopped after its check was recorded; this dashboard had sent a stop whose answer was not read. */
    stopSentUnreadHere?: boolean;
  },
): { filing: RetestFiling; applied: retests.Applied } {
  const decided = lifecycle.statusFromVerdict(result.verdict, finding.status);
  // A run the engine ended ABORTED after its check was filed: the verdict
  // stands, and is filed -- marked, on the check and the finding, as stopped
  // after its check was recorded, never as a run that finished (anyway).
  // Otherwise a run stopped too late to stop it: the engine did finish, and
  // did decide, so the verdict is filed -- and says so.
  const despite = result.stoppedAfterRecording
    ? ` ${stoppedAfterRecordingSentence(result.stoppedAfterRecording, how)}`
    : how.completedDespiteStop
      ? " Completed despite a stop request."
      : how.completedAfterUnreadStop ? ` ${AFTER_UNREAD_STOP}.` : "";
  // Said on the finding as well as on the check: a verdict the watch collected
  // is the requester's retest, filed when the engine finished it -- not a
  // status they set by hand at that moment.
  const note = how.filedVia === "retest_watch"
    ? `${decided.detail} (Filed by the dashboard when the engine ${result.stoppedAfterRecording ? "ended" : "finished"} ` +
      `the retest requested at ${how.requestedAt.toISOString()}.${despite})`
    : `${decided.detail}${despite}`;
  return {
    filing: {
      findingId: finding.id,
      findingPatch: {
        status: decided.status,
        statusNote: note,
        statusChangedBy: how.requestedBy,
        statusChangedAt: new Date(),
        // Only a `closed` verdict writes these, and they are what makes
        // the claim checkable afterwards.
        ...(decided.fixed
          ? { fixedAt: new Date(), fixedByRunId: result.runId, fixedVerdict: result.verdict }
          : { fixedAt: null, fixedByRunId: null, fixedVerdict: null }),
      },
      // Appended, never replaced. The answer given today does not erase
      // the answer given last month: a client asking whether March's
      // findings are gone is owed the sequence, not the last word.
      check: {
        findingId: finding.id,
        verdict: result.verdict,
        detail: (result.detail || decided.detail) + despite,
        runId: result.runId,
        inventoryDigest: result.inventoryDigest,
        checkedBy: how.requestedBy,
        engineRunId: result.engineRunId,
        filedVia: how.filedVia,
        requestedAt: how.requestedAt,
      },
    },
    applied: { findingId: finding.id, status: decided.status, detail: decided.detail },
  };
}

/**
 * How a verdict whose run ended stopped after its check was recorded is
 * marked, on the check and the finding: with the engine's reason, and whether
 * the stop this dashboard sent was the one taken.
 */
function stoppedAfterRecordingSentence(reason: string, how: { stopTakenHere?: boolean; stopSentUnreadHere?: boolean }): string {
  return `Stopped after its check was recorded (${reason}): the engine filed this verdict's check, then a stop landed ` +
    "and the run ended stopped. The verdict stands." +
    (how.stopTakenHere ? " The stop sent from this dashboard was taken."
      : how.stopSentUnreadHere ? " A stop was sent from this dashboard; its answer was not read." : "");
}

/**
 * Carry a verdict the engine answered to the Retest request itself into the
 * finding it is about. Only ever called with a verdict
 * (engine.RetestAnswer `answer: "verdict"`), never with a status.
 */
async function fileRetestVerdict(
  { test, client, twinId, who }: RetestContext,
  result: engine.RetestResult,
  requestedAt: Date,
): Promise<{ applied: retests.Applied | null; notFiled: string | null }> {
  try {
    const found = await findingOfTwin(test, client.id, twinId);
    if ("missing" in found) return { applied: null, notFiled: found.missing };
    const { filing, applied } = retestFiling(found.finding, result, {
      requestedBy: who.userId, requestedAt, filedVia: "retest_request",
    });
    await storage.updateFinding(filing.findingId, filing.findingPatch);
    await storage.recordCheck(filing.check);
    return { applied, notFiled: null };
  } catch (cause) {
    // The retest itself succeeded; failing to file it is worth saying but
    // is not worth throwing away the verdict the operator asked for.
    if (!(cause instanceof engine.EngineUnavailable)) throw cause;
    return { applied: null, notFiled: cause.message };
  }
}

/**
 * How a watch (server/retests.ts) finds a finding, files a verdict and
 * records its end. A verdict is filed as the user who pressed Retest --
 * `checkedBy` on the check, `statusChangedBy` on the finding -- and says
 * it was collected: `filedVia: "retest_watch"` and `requestedAt` on the
 * check, a sentence on the finding, and a `retest_collected` log entry
 * naming the requester and when they asked.
 */
const retestWatchHooks: retests.WatchHooks = {
  async resolveFinding(watch) {
    const test = await storage.getTest(watch.testId);
    if (!test) return { missing: "the test this retest was run from is no longer on record" };
    const found = await findingOfTwin(test, watch.clientId, watch.twinId);
    return "missing" in found ? found : { findingId: found.finding.id };
  },
  async filingFor(watch, findingId, result) {
    const finding = await storage.getFinding(findingId);
    if (!finding) return { missing: "the finding this retest was about is no longer on record" };
    return retestFiling(finding, result, {
      requestedBy: watch.requestedBy, requestedAt: watch.startedAt, filedVia: "retest_watch",
      // Never "completed despite a stop" for a run the engine ended aborted
      // after recording (retests.stopMarkingOf).
      ...retests.stopMarkingOf(watch, result),
    });
  },
  async recordEnd(watch) {
    const result = (watch.result ?? null) as (engine.RetestResult & { applied?: unknown; notFiled?: unknown }) | null;
    await storage.createActivityLog({
      action: watch.state === "verdict" ? "retest_collected" : `retest_${watch.state}`,
      entityType: "test",
      entityId: watch.testId,
      details: {
        twinId: watch.twinId,
        engineRunId: watch.engineRunId,
        engagementRef: watch.engagementRef,
        state: watch.engineState,
        // Filed on the requester's behalf, by the dashboard, when the engine
        // finished: not an act of theirs at this moment.
        filedBy: "retest_watch",
        requestedBy: watch.requestedBy,
        requestedAt: watch.startedAt.toISOString(),
        ...(result
          ? { verdict: result.verdict, findingType: result.findingType, target: result.target,
            applied: result.applied ?? null, notFiled: result.notFiled ?? null,
            completedDespiteStop: (result as { completedDespiteStop?: unknown }).completedDespiteStop === true,
            completedAfterUnreadStop: (result as { completedAfterUnreadStop?: unknown }).completedAfterUnreadStop === true,
            stoppedAfterRecording: result.stoppedAfterRecording || null,
            stopTakenHere: (result as { stopTakenHere?: unknown }).stopTakenHere === true,
            stopSentUnreadHere: (result as { stopSentUnreadHere?: unknown }).stopSentUnreadHere === true }
          : { reason: watch.reason, error: watch.error }),
      },
      userId: watch.requestedBy,
      ipAddress: watch.requestedFrom,
    });
  },
};

/** Engine run states in which a retest is still doing something to the target. */
const LIVE_RETEST_STATES = new Set(["queued", "running", "aborting"]);

/**
 * A retest this dashboard stopped waiting for -- the engine did not answer
 * within engineTimeouts.callMs -- keeps its in-flight slot, because engine
 * main runs a retest to its end on one of its worker threads whoever is
 * waiting: freeing the slot at the timeout let a dashboard hold twice its cap
 * of engine threads, then three times, every 20 s. The slot is held until the
 * engine's list of live runs, read every `pollMs`, lists no live retest on
 * that retest's scope (the status poll) -- or, when the engine keeps listing
 * one or its list cannot be read, until `ceilingMs` have passed (the hard
 * ceiling). Which of the two freed it is logged. Tests shorten these.
 */
export const retestSlots = { pollMs: 5_000, ceilingMs: 30 * 60_000 };

/** The most retests one dashboard asks of the engine at once (ATHENA_MAX_INFLIGHT_RETESTS, default 4). */
function maxInflightRetests(): number {
  const set = Number.parseInt(process.env.ATHENA_MAX_INFLIGHT_RETESTS ?? "", 10);
  return Number.isSafeInteger(set) && set >= 1 ? set : 4;
}

/** A watch as the page reads it: its phase, in words, and what stops it. */
function retestView(watched: RetestWatch) {
  const phase = watched.state as retests.RetestPhase;
  const stoppable = phase === "running" || phase === "unwatched";
  return {
    answer: phase === "verdict" ? "verdict" as const : "status" as const,
    phase,
    engineRunId: watched.engineRunId,
    testId: watched.testId,
    twinId: watched.twinId,
    findingId: watched.findingId,
    state: watched.engineState ?? "unknown",
    reason: watched.reason,
    error: watched.error,
    requestedBy: watched.requestedBy,
    startedAt: watched.startedAt,
    lastReadAt: watched.lastReadAt,
    lastReadError: watched.lastReadError,
    stopAcceptedAt: watched.stopAcceptedAt,
    stopUnreadAt: watched.stopUnreadAt ?? null,
    stoppable,
    detail: retestPhaseSentence(phase, {
      ...watched,
      completedDespiteStop: (watched.result as { completedDespiteStop?: unknown } | null)?.completedDespiteStop === true,
      completedAfterUnreadStop: (watched.result as { completedAfterUnreadStop?: unknown } | null)?.completedAfterUnreadStop === true,
      stoppedAfterRecording: (watched.result as { stoppedAfterRecording?: unknown } | null)?.stoppedAfterRecording ?? null,
      stopTakenHere: (watched.result as { stopTakenHere?: unknown } | null)?.stopTakenHere === true,
      stopSentUnreadHere: (watched.result as { stopSentUnreadHere?: unknown } | null)?.stopSentUnreadHere === true,
    }),
    ...(watched.result ? { result: watched.result } : {}),
  };
}

/** What a retest's phase means, said so a status is never read as a verdict. */
function retestPhaseSentence(
  phase: retests.RetestPhase | "refused",
  about: {
    reason: string | null; error: string | null; stopAcceptedAt?: Date | string | null; stopUnreadAt?: Date | string | null;
    completedDespiteStop?: boolean; completedAfterUnreadStop?: boolean; stoppedAfterRecording?: unknown;
    stopTakenHere?: boolean; stopSentUnreadHere?: boolean;
  },
): string {
  switch (phase) {
    case "running":
      return about.stopAcceptedAt
        ? "The engine accepted a stop for this retest and is stopping it. It has not reached a verdict, and nothing has been filed."
        : about.stopUnreadAt
          ? "A stop was sent for this retest, but the engine's answer to it was not read (stop sent, answer unread), so " +
            "whether it is stopping is not known. It has not reached a verdict, and nothing has been filed."
          : "The engine is still running this retest against the target. It has not reached a verdict, and nothing has been filed.";
    case "verdict":
      if (typeof about.stoppedAfterRecording === "string" && about.stoppedAfterRecording !== "") {
        return `The retest reached a verdict and the engine filed its check; a stop (${about.stoppedAfterRecording}) ` +
          "landed while that check was being written, so the run ended stopped. The verdict stands and was filed." +
          (about.stopTakenHere ? " The stop sent from this dashboard was taken."
            : about.stopSentUnreadHere ? " A stop was sent from this dashboard; its answer was not read." : "");
      }
      return about.completedDespiteStop
        ? "The engine accepted a stop for this retest, but the run completed anyway, with a verdict. The verdict was " +
          "filed, marked as completed despite a stop request."
        : about.completedAfterUnreadStop
          ? "A stop was sent for this retest, but the engine's answer to it was not read, and the run completed with a " +
            `verdict. The verdict was filed, marked as ${AFTER_UNREAD_STOP.toLowerCase()}.`
          : "The retest finished with a verdict.";
    case "stopped":
      return "Stopped" + (about.reason ? ` (${about.reason})` : "") +
        " before it reached a verdict. Nothing was filed, and the finding is unchanged.";
    case "failed":
      return "The engine recorded this retest as failed" + (about.error ? `: ${about.error}` : " and gave no reason") +
        ". It reached no verdict; nothing was filed, and the finding is unchanged.";
    case "no_verdict":
      return "The engine finished this retest without a verdict. Nothing was filed, and the finding is unchanged.";
    case "unwatched":
      return "This dashboard stopped waiting for the retest before the engine finished it. It may still be running: stop it " +
        "here or with the kill switch. Its verdict, when it comes, is in the engine's remediation record and was not filed here.";
    case "refused":
      return "The engine's worker queue is full, so the retest was not started" + (about.error ? ` (${about.error})` : "") +
        ". Nothing was sent to the target and nothing was filed. Try again once a running scan has finished.";
  }
}

/**
 * Answer a retest the engine answered with a status, and watch it if it is
 * still running. Nothing here files anything or touches a finding.
 */
async function answerRetestStatus(
  res: Response,
  watcher: retests.RetestWatcher,
  ctx: RetestContext & { engagementRef: string },
  status: engine.RetestStatus,
): Promise<void> {
  const { test, client, twinId, engagementRef, who } = ctx;
  const log = async (action: string, extra: Record<string, unknown>) => {
    try {
      await storage.createActivityLog({
        action, entityType: "test", entityId: test.id,
        details: { twinId, engagementRef, engineRunId: status.engineRunId, state: status.state, ...extra },
        ...who.actor,
      });
    } catch {
      // The answer -- and a running retest's Stop -- matters more than the log line.
    }
  };

  if (status.httpStatus === 429) {
    await log("retest_refused", { error: status.error });
    return void res.status(429).json({
      error: retestPhaseSentence("refused", status),
      answer: "status", phase: "failed", engineRunId: status.engineRunId, state: status.state,
      reason: status.reason, stoppable: false,
    });
  }

  // A 202 is a run the engine has not finished answering for, whatever state
  // it names: it is watched. A state that already reads ended -- the run
  // finished between the engine's wait and its answer -- is read at once, and
  // its verdict, if it has one, filed. So is a 500 that names a run whose
  // work started (athena-engine #71: the engine failed after registering it,
  // and it is running): watched, with its Stop (engine.retestMayBeRunning).
  if (engine.retestMayBeRunning(status)) {
    if (status.engineRunId !== null) {
      // In memory, synchronously: the answer -- and the Stop's run id in it --
      // goes back without waiting on the watch's row, the log, or the finding.
      watcher.start({
        engineRunId: status.engineRunId, testId: test.id, clientId: client.id, twinId, engagementRef,
        requestedBy: who.userId, requestedFrom: who.actor.ipAddress, engineState: status.state,
      });
    }
    res.status(202).json({
      answer: "status", phase: "running", engineRunId: status.engineRunId, testId: test.id, twinId, state: status.state,
      reason: status.reason, error: status.error, stoppable: status.engineRunId !== null,
      detail: status.engineRunId !== null
        ? retestPhaseSentence("running", status)
        : "The engine is running this retest but gave it no run id, so nothing here can name it to stop it: " +
          "the kill switch stops every run the engine lists by an id, and a failsafe pause stops the engine.",
    });
    if (status.engineRunId !== null) void watcher.noteFinding(status.engineRunId).catch(() => undefined);
    await log("retest_started", {});
    return;
  }

  const phase: retests.RetestPhase =
    status.state === "aborted" ? "stopped" : status.state === "failed" ? "failed" : "no_verdict";
  await log(`retest_${phase}`, { reason: status.reason, error: status.error });
  res.json({
    answer: "status", phase, engineRunId: status.engineRunId, testId: test.id, twinId, state: status.state,
    reason: status.reason, error: status.error, stoppable: false,
    detail: retestPhaseSentence(phase, status),
  });
}

export function registerRoutes(app: Express): void {
  // This app's retest watches, resumed from the record in the background:
  // a restart loses no verdict, and holds up no start-up and no stop.
  const watcher = new retests.RetestWatcher(storage, retestWatchHooks);
  app.locals.retestWatcher = watcher;
  watcher.resume();
  // The tests, read once in the background so a Stop finds its run in memory
  // (storage.peekTest) without asking the database. Holds up nothing.
  setImmediate(() => void storage.getAllTests().catch(() => undefined));
  /** The retests being asked of the engine right now, by test and twin. */
  const retestsInFlight = new Set<string>();
  /**
   * A retest of a finding between its one-at-a-time check and its send: taken
   * in memory, before anything is awaited, so two presses at once cannot both
   * pass the check.
   */
  const retestsReserved = new Set<string>();
  /** Retests the engine may still be running after this dashboard stopped waiting for them (retestSlots). */
  const retestsHeld = new Map<string, { scope: string[]; since: number }>();
  let heldPoll = false;
  const pollHeldRetests = (): void => {
    if (heldPoll || retestsHeld.size === 0) return;
    heldPoll = true;
    const timer = setTimeout(() => {
      void (async () => {
        let live: engine.ActiveRun[] | null = null;
        try {
          const watched = new Set(watcher.running().map((one) => one.engineRunId));
          live = (await engine.activeRuns()).filter((run) =>
            (run.kind === null || run.kind === "retest") && (LIVE_RETEST_STATES.has(run.state) || run.state === "unknown")
            && !(run.stopId !== null && watched.has(run.stopId)));
        } catch {
          live = null;
        }
        const now = Date.now();
        for (const [key, held] of Array.from(retestsHeld.entries())) {
          const listed = live === null || live.some((run) => {
            const host = run.target === null ? null : hostOf(run.target);
            return host === null || held.scope.includes(host);
          });
          if (!listed) {
            retestsHeld.delete(key);
            console.log(`[retest] the in-flight slot of retest ${key} is free: the engine lists no live retest on ` +
              `${held.scope.join(", ")} any more (status poll).`);
          } else if (now - held.since >= retestSlots.ceilingMs) {
            retestsHeld.delete(key);
            console.error(`[retest] the in-flight slot of retest ${key} is free at the hard ceiling ` +
              `(${Math.round(retestSlots.ceilingMs / 60_000)} min): ` +
              (live === null ? "the engine's list of live runs could not be read" : "the engine still lists a live retest on its scope") +
              ", so it may still be running.");
          }
        }
        heldPoll = false;
        pollHeldRetests();
      })();
    }, retestSlots.pollMs);
    (timer as { unref?: () => void }).unref?.();
  };
  // Allow the packaged Electron renderer (app://athena) to call the API with cookies.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // ==== AUTHENTICATION (public) ====
  app.post(
    "/api/auth/login",
    asyncHandler(async (req, res) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Username and password are required" });
        return;
      }
      const now = Date.now();
      const key = loginKey(req, parsed.data.username);
      const byAddress = addressKey(req);

      // Per username and per address. Only the first existed, so a flood of
      // distinct usernames from one address never engaged the throttle and
      // each attempt still paid for a key derivation.
      if (loginBlocked(key, now) || loginBlocked(byAddress, now, LOGIN_MAX_FAILURES_PER_ADDRESS)) {
        res.status(429).json({ message: "Too many failed sign-in attempts. Try again later." });
        return;
      }

      // Counted before the password is verified, not after: the hash now runs
      // off the loop (server/password.ts), so many concurrent attempts can be
      // mid-hash at once, and none of them would yet look like a failure to
      // the next one's check if this ran after theirs resolved -- a flood
      // limited to 10 or 50 by this counter could otherwise all reach the
      // hash together. Counting first closes that: a success below undoes it.
      recordLoginFailure(key, now);
      recordLoginFailure(byAddress, now);

      const user = await storage.validateUser(parsed.data.username, parsed.data.password);
      if (!user || !user.isActive) {
        res.status(401).json({ message: "Invalid username or password" });
        return;
      }

      loginFailures.delete(key);
      loginFailures.delete(byAddress);
      await regenerateSession(req);
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      // The account as it is now: what this session's stops are authorised by (auth.ts).
      noteAccount(user);

      await storage.createActivityLog({
        action: "login",
        entityType: "user",
        entityId: user.id,
        userId: user.id,
        ipAddress: req.ip ?? null,
        details: null,
      });

      res.json({ user: publicUser(user) });
    }),
  );

  app.post(
    "/api/auth/logout",
    asyncHandler(async (req, res) => {
      const who = actor(req);
      if (req.session) {
        await destroySession(req);
      }
      res.clearCookie("athena.sid");
      if (who.userId) {
        await storage.createActivityLog({
          action: "logout", entityType: "user", entityId: who.userId, details: null, ...who,
        });
      }
      res.json({ success: true });
    }),
  );

  app.get(
    "/api/auth/check",
    asyncHandler(async (req, res) => {
      if (req.session?.userId) {
        const user = await storage.getUser(req.session.userId);
        if (user && user.isActive) {
          res.json({ authenticated: true, user: publicUser(user) });
          return;
        }
      }
      res.json({ authenticated: false });
    }),
  );

  // Everything below requires a session.
  // A change to the AI Control settings takes its place in line the moment it
  // arrives -- before the session guard, or anything else, is awaited -- so
  // its write is ordered by when it was pressed, not by how long its
  // authorisation took (the writes, and `superseded`, below at PATCH
  // /api/ai-control).
  let aiControlArrivals = 0;
  const aiControlSeq = new WeakMap<Request, number>();
  app.patch("/api/ai-control", (req, _res, next) => {
    aiControlArrivals += 1;
    aiControlSeq.set(req, aiControlArrivals);
    next();
  });
  // Every scan and retest start is registered as it arrives, so a kill switch
  // pressed while it is starting catches it (trackStart, pressKillSwitch).
  app.post("/api/scans", trackStart("scan"));
  app.post("/api/tests/:testId/retest", trackStart("retest"));

  app.use("/api", requireAuth);

  // ...and, for writes, that the kill switch is not engaged.
  app.use("/api", enforceKillSwitch);

  // ==== CLIENTS ====
  app.get("/api/clients", asyncHandler(async (_req, res) => {
    res.json(await storage.getAllClients());
  }));

  app.get("/api/clients/:id", asyncHandler(async (req, res) => {
    const client = await storage.getClient(req.params.id);
    if (!client) return notFound(res, "Client");
    res.json(client);
  }));

  app.post("/api/clients", asyncHandler(async (req, res) => {
    const data = createClientSchema.parse(req.body);
    const client = await storage.createClient(data);
    await storage.createActivityLog({
      action: "created", entityType: "client", entityId: client.id,
      details: { name: client.name, company: client.company }, ...actor(req),
    });
    res.status(201).json(client);
  }));

  app.patch("/api/clients/:id", asyncHandler(async (req, res) => {
    const data = updateClientSchema.parse(req.body);
    const client = await storage.updateClient(req.params.id, data);
    if (!client) return notFound(res, "Client");
    if (hasChanges(data)) {
      await storage.createActivityLog({ action: "updated", entityType: "client", entityId: client.id, details: null, ...actor(req) });
    }
    res.json(client);
  }));

  app.delete("/api/clients/:id", asyncHandler(async (req, res) => {
    if (!(await storage.getClient(req.params.id))) return notFound(res, "Client");
    // Deleting a client removes its tests, sites and documents. Those rows
    // used to disappear with no audit trace at all, so the log recorded one
    // deletion where ten had happened. Count them before they are gone.
    const tests = await storage.getTestsByClient(req.params.id);
    const cascaded = {
      tests: tests.map((t) => t.id),
      sites: (await storage.getSitesByClient(req.params.id)).map((s) => s.id),
      documents: (await storage.getDocumentsByClient(req.params.id)).map((d) => d.id),
    };

    // Its tests' running engine runs are stopped first; nothing is deleted
    // while one of them could not be (stopBeforeDeleting).
    const stops = await stopBeforeDeleting(req, tests);
    if (refuseUnstoppedDelete(res, "the client", stops)) return;
    if (refuseUnforcedDeleteWithoutStop(req, res, "the client", tests, stops)) return;
    const withoutStop = tests.filter(unfinishedWithoutRunId).map((one) => one.id);

    let success: boolean;
    try {
      success = await storage.deleteClient(req.params.id);
    } catch (cause) {
      if (stops.length === 0) throw cause;
      // The stops were accepted; that is not to be reported as a failure.
      return void res.status(500).json({
        message: `Every running scan of this client was sent a stop, and each was stopped (the engine accepted it), had ` +
          `already ended (the engine answered "not running"), or was answered 2xx with the rest of its answer unread ` +
          `(stop sent, answer unread), but the client could not be deleted: ${causeOf(cause)}`,
        stops,
      });
    }
    if (!success) return notFound(res, "Client");

    try {
      await storage.createActivityLog({
        action: "deleted", entityType: "client", entityId: req.params.id,
        details: {
          cascaded,
          ...stopsForLog(stops),
          ...(withoutStop.length > 0 ? { deletedWithoutStop: withoutStop } : {}),
        }, ...actor(req),
      });
    } catch (cause) {
      if (stops.length === 0) throw cause;
    }
    res.json(stops.length > 0 ? { success: true, stops } : { success: true });
  }));

  // ==== SITES ====
  app.get("/api/sites", asyncHandler(async (req, res) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    res.json(clientId ? await storage.getSitesByClient(clientId) : await storage.getAllSites());
  }));

  app.post("/api/sites", asyncHandler(async (req, res) => {
    const data = createSiteSchema.parse(req.body);
    if (await parentMissing(res, (data as { clientId?: string }).clientId, (data as { siteId?: string | null }).siteId)) return;
    const site = await storage.createSite(data);
    await storage.createActivityLog({
      action: "created", entityType: "site", entityId: site.id,
      details: { url: site.url, clientId: site.clientId }, ...actor(req),
    });
    res.status(201).json(site);
  }));

  app.patch("/api/sites/:id", asyncHandler(async (req, res) => {
    const data = updateSiteSchema.parse(req.body);
    const site = await storage.updateSite(req.params.id, data);
    if (!site) return notFound(res, "Site");
    if (hasChanges(data)) {
      await storage.createActivityLog({ action: "updated", entityType: "site", entityId: site.id, details: null, ...actor(req) });
    }
    res.json(site);
  }));

  app.delete("/api/sites/:id", asyncHandler(async (req, res) => {
    const success = await storage.deleteSite(req.params.id);
    if (!success) return notFound(res, "Site");
    await storage.createActivityLog({ action: "deleted", entityType: "site", entityId: req.params.id, details: null, ...actor(req) });
    res.json({ success: true });
  }));

  // ==== TESTS ====
  app.get("/api/tests", asyncHandler(async (req, res) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
    if (clientId) return void res.json(await storage.getTestsByClient(clientId));
    if (siteId) return void res.json(await storage.getTestsBySite(siteId));
    res.json(await storage.getAllTests());
  }));

  app.get("/api/tests/:id", asyncHandler(async (req, res) => {
    const test = await storage.getTest(req.params.id);
    if (!test) return notFound(res, "Test");
    res.json(test);
  }));

  app.post("/api/tests", asyncHandler(async (req, res) => {
    // Attribution is evidence in an audit product, so it comes from the
    // session and is not part of the input schema at all. The spread below
    // already overrode it, but a schema that still accepted the field is how
    // the update path came to allow forging it.
    if (forgedAttribution(res, req.body)) return;
    const data = createTestSchema.parse(req.body);
    // A person's test: a run's keys are the scan route's to write, never this one's.
    if (suppliedEngineKeys(res, data.findings)) return;
    if (await parentMissing(res, data.clientId, data.siteId)) return;
    const test = await storage.createTest({
      ...data,
      ...completionStamp(data, null),
      executedBy: req.session.userId ?? null,
    });
    await storage.createActivityLog({
      action: "created", entityType: "test", entityId: test.id,
      details: { testType: test.testType, clientId: test.clientId }, ...actor(req),
    });
    res.status(201).json(test);
  }));

  app.patch("/api/tests/:id", asyncHandler(async (req, res) => {
    if (forgedAttribution(res, req.body)) return;
    const data = updateTestSchema.parse(req.body);
    const before = await storage.getTest(req.params.id);
    if (!before) return notFound(res, "Test");
    if (engineRecordEdited(res, before, data)) return;
    const test = await storage.updateTest(req.params.id, { ...data, ...completionStamp(data, before) });
    if (!test) return notFound(res, "Test");
    if (hasChanges(data)) {
      await storage.createActivityLog({ action: "updated", entityType: "test", entityId: test.id, details: null, ...actor(req) });
    }
    res.json(test);
  }));

  app.delete("/api/tests/:id", asyncHandler(async (req, res) => {
    const test = await storage.getTest(req.params.id);
    if (!test) return notFound(res, "Test");
    // A running engine scan is stopped first, and deleted only once the engine
    // accepted the stop (stopBeforeDeleting): its row is its Stop.
    const stops = await stopBeforeDeleting(req, [test]);
    if (refuseUnstoppedDelete(res, "the test", stops)) return;
    if (refuseUnforcedDeleteWithoutStop(req, res, "the test", [test], stops)) return;
    const withoutStop = unfinishedWithoutRunId(test);

    let success: boolean;
    try {
      success = await storage.deleteTest(req.params.id);
    } catch (cause) {
      if (stops.length === 0) throw cause;
      return void res.status(500).json({
        message: `Engine run ${stops[0].runId} ${stops[0].alreadyFinished ? "had already ended (the engine answered \"not running\")"
          : stops[0].answerUnread ? "was sent a stop whose answer was not read (stop sent, answer unread)" : "was stopped (the engine accepted the stop)"}, ` +
          `but the test could not be deleted: ${causeOf(cause)}`,
        stops,
      });
    }
    if (!success) return notFound(res, "Test");
    try {
      await storage.createActivityLog({
        action: "deleted", entityType: "test", entityId: req.params.id,
        details: stops.length > 0 ? stopsForLog(stops)
          : withoutStop ? { deletedWithoutStop: true } : null,
        ...actor(req),
      });
    } catch (cause) {
      if (stops.length === 0 && !withoutStop) throw cause;
    }
    res.json({
      success: true,
      ...(stops.length > 0 ? { stops } : {}),
      ...(withoutStop ? { detail: "deleted with force: the engine gave this scan no run id a stop can name, so no stop was sent" } : {}),
    });
  }));

  // ==== SCANS: the engine, and what it found ====
  //
  // A test row is the record; the engine is what makes it true. These two
  // routes are the only place the two meet, and they are deliberately thin:
  // Athena decides who may ask and under which engagement, the engine decides
  // whether the target may be reached, and neither pretends to do the other's
  // job. A refusal from the engine is passed through with its reason intact,
  // because "the target is a loopback address" is the sentence the operator
  // needs and "scan failed" is not.

  app.get("/api/engine/status", asyncHandler(async (_req, res) => {
    res.json(await engine.status());
  }));

  app.post("/api/scans", asyncHandler(async (req, res) => {
    const data = startScanSchema.parse(req.body);

    const client = await storage.getClient(data.clientId);
    if (!client) return notFound(res, "Client");
    const site = data.siteId ? await storage.getSite(data.siteId) : null;
    if (data.siteId && !site) return notFound(res, "Site");
    // A site that belongs to another client is not a site of this engagement.
    if (site && site.clientId !== data.clientId) {
      return void res.status(400).json({
        error: "that site belongs to a different client",
      });
    }

    // The engagement the engine will record against every effect. It is the
    // client and the site, not something the caller composes, so a scan
    // cannot be filed under an engagement nobody opened.
    const engagementRef = site ? `${client.id}:${site.id}` : client.id;

    // The hosts this engagement authorises, taken from the sites somebody
    // recorded against the client. One site if one was chosen, otherwise all
    // of the client's.
    //
    // This is the half of the scope check the engine cannot do. Given no
    // scope it falls back to the target's own host, and a check whose only
    // possible answer is "yes" is not a check -- so the side holding the site
    // list is the side that has to send it.
    const engagementSites = site ? [site] : await storage.getSitesByClient(client.id);
    const scope = engagementSites
      .map((one) => hostOf(one.url))
      .filter((host): host is string => host !== null);

    if (scope.length === 0) {
      // No recorded site means nothing on record authorises any host, and
      // scanning on the strength of the target the caller just typed is the
      // unfalsifiable check again, one layer up. Refuse and say what is
      // missing.
      return void res.status(400).json({
        error:
          `no site is recorded for ${client.name}, so nothing on record ` +
          `authorises scanning ${data.target}. Add the site to the client first.`,
      });
    }

    // What the AI Control page says about starting scans, enforced here --
    // at the start, and only there: nothing on that page can hold back a
    // stop. Its system switches and Max Concurrent Tests were stored and
    // read by nothing, so switching scanning off stopped no scan from
    // starting. A settings read that fails refuses the start (asyncHandler's
    // 500); it never touches a stop.
    const control = await storage.getAIControlSettings();
    const system = systemOfScan(data.testType);
    const active = control ? control.activeSystems ?? [] : DEFAULT_ACTIVE_SYSTEMS;
    if (!active.includes(system)) {
      const label = AI_SYSTEMS.find((one) => one.id === system)!.label;
      return void res.status(409).json({
        error: `${label} is switched off on the AI Control page, so this scan was not started. Switch it on there to ` +
          "start it.",
        reason: "system_off",
        system,
      });
    }
    // Counted from the engine's own list of live runs: a row reads
    // "running" until someone polls its status, so rows alone would count
    // scans that finished long ago and refuse every start once enough pages
    // were left -- and would miss a live run that has no row. Only when that
    // list cannot be read are the rows recorded as running counted instead.
    // A run with no run id is live all the same, and counts either way: listed
    // by the engine with none, or recorded here as an unfinished engine scan
    // (shared/engine-record.ts) that has none. The recorded rows were counted
    // by run id alone, so the same running scan counted while the engine's
    // list could be read and did not while it could not.
    const limit = control?.maxConcurrentTests ?? 5;
    let running: number;
    let unnamed: number;
    let unlisted: string | null = null;
    let live: engine.ActiveRun[] = [];
    let unnamedRecords: UnnamedRecord[] = [];
    try {
      live = await engine.activeRuns();
      running = live.length;
      // Unnamed: a run no stop can address, so neither a Stop nor the kill
      // switch reaches it (stopIdFrom). A blank-looking id is reached by the
      // kill switch, and counted as one it names.
      unnamed = live.filter((run) => run.stopId === null).length;
    } catch (cause) {
      if (!(cause instanceof engine.EngineUnavailable)) throw cause;
      unlisted = cause.message;
      const recorded = (await storage.getAllTests())
        .filter((test) => !FINISHED_RUN_STATES.has(test.status) && isEngineRecord(test.findings));
      running = recorded.length;
      unnamedRecords = recorded.filter((test) => unfinishedRunOf(test) === null).map((test) => {
        const target = (test.findings as { target?: unknown }).target;
        return { testId: test.id, target: typeof target === "string" ? target : null };
      });
      unnamed = recorded.filter((test) => unfinishedStopIdOf(test) === null).length;
    }
    if (running >= limit) {
      // A run the engine lists with no run id, at the target of a scan recorded
      // here as running with a run id the engine did not list: that scan's own
      // Stop names it by the recorded id, so it is stoppable, and said so. Only
      // read when refusing, and a read that fails matches nothing.
      let recordedById = 0;
      if (unlisted === null && unnamed > 0) {
        const listedIds = new Set(live.map((run) => run.stopId).filter((id): id is string => id !== null));
        let rows: Awaited<ReturnType<typeof storage.getAllTests>> = [];
        try {
          rows = await storage.getAllTests();
        } catch {
          rows = [];
        }
        const unlistedTargets = rows
          .filter((test) => { const id = unfinishedRunOf(test); return id !== null && !listedIds.has(id); })
          .map((test) => (test.findings as { target?: unknown }).target)
          .filter((target): target is string => typeof target === "string");
        for (const run of live) {
          if (run.stopId !== null || run.target === null) continue;
          const at = unlistedTargets.indexOf(run.target);
          if (at === -1) continue;
          unlistedTargets.splice(at, 1);
          recordedById += 1;
        }
        unnamed -= recordedById;
      }
      return void res.status(409).json({
        error: concurrencyRefusal({ running, unnamed, limit, unlisted, recordedById, unnamedRecords }),
        reason: "concurrency_limit",
        running,
        unnamed,
        ...(recordedById > 0 ? { recordedById } : {}),
        ...(unnamedRecords.length > 0 ? { unnamedRecords } : {}),
        counted: unlisted === null ? "engine" : "recorded",
        limit,
      });
    }

    // The kill switch pressed since this start arrived -- while its settings
    // or the engine's list were being read -- or held engaged in memory:
    // nothing is sent to the engine.
    const ticket = startTickets.get(req) ?? null;
    await markIfEngagedElsewhere(ticket);
    if (ticket?.press || killSwitchMemory.engaged) {
      return void res.status(503).json({
        message: KILL_SWITCH_REFUSAL,
        error: "the kill switch was engaged while this scan was starting, so it was not started: nothing was sent to the engine",
        reason: "kill_switch",
      });
    }

    let started;
    try {
      started = await engine.startScan({
        target: data.target,
        engagementRef,
        scope,
        // Forwarded only when the operator enabled authenticated scanning.
        ...(data.auth?.enabled ? { auth: data.auth } : {}),
      });
    } catch (cause) {
      if (cause instanceof engine.UnrecognisedScanAnswer) {
        // The engine took the start (2xx) and answered in a shape this
        // dashboard does not read: nothing is recorded from it, and the run it
        // named -- which may be scanning, with no row here to carry its Stop --
        // is stopped, as a start that could not be recorded is.
        if (cause.stopId === null) {
          return void res.status(502).json({ error: cause.message, reason: "unrecognised_engine_answer" });
        }
        // Every run it named -- its body's, and its X-Run-Id header's when the
        // two differ -- is sent its stop, all at once; the record of each says why.
        const ids = cause.stopIds;
        const why = `sent because the engine answered a scan start in a shape this dashboard does not read, naming this run: ${cause.message}`;
        const stops = await Promise.all(ids.map((runId) =>
          sendStop(req, { runId, target: data.target, testId: null }, "start_not_recorded", why)));
        return void res.status(502).json({
          error: `${cause.message} ${ids.map((runId, at) => unreadAnswerStopSentence(runId, stops[at])).join(" ")}`,
          reason: "unrecognised_engine_answer",
          runId: ids[0],
          runIds: ids,
          stopped: stops.every((one) => one.stopped),
          stops: ids.map((runId, at) => ({ runId, ...stops[at] })),
          ...(stops.some((one) => one.alreadyFinished) ? { alreadyFinished: stops.every((one) => one.alreadyFinished === true) } : {}),
          ...(stops.some((one) => one.answerUnread) ? { answerUnread: true } : {}),
        });
      }
      if (cause instanceof engine.EngineUnavailable) {
        // 503, not 500. Nothing is broken: the engine is not there, or not
        // answering, and that is a fact about the deployment.
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }

    if (started.state === "refused") {
      return void res.status(409).json({
        error: "the engine refused this scan",
        detail: started.refused ?? "",
      });
    }

    // The kill switch pressed while the engine was being asked: the run it
    // accepted is stopped now, by its run id, before anything is written --
    // this press's sweep could not have named it (stoppedByKillSwitch).
    if (started.state !== "completed" && started.state !== "refused") await markIfEngagedElsewhere(ticket);
    const pressedStop = stoppedByKillSwitch(ticket, started);
    if (pressedStop !== null) await pressedStop;

    // A run the engine finished inline has its results now, and its row is
    // written as finished: counted from what came back and dated. It used to
    // be written with zero counts and no completion time, and the status
    // route never revisits a completed row -- so a scan that returned a
    // critical read as "0 reported" on every screen that reads the test.
    // Only an answer that is the run's end (a 200): a 202 is never done,
    // whatever state it names (engine.EngineScan.final), and its results are
    // collected on the status route.
    const completedInline = started.final === true && started.state === "completed";
    let test;
    try {
      test = await storage.createTest({
        clientId: data.clientId,
        siteId: data.siteId ?? null,
        testType: data.testType,
        status: completedInline ? "completed" : "running",
        completedAt: completedInline ? new Date() : null,
        summary: `${data.target} — engine run ${started.runId ?? "unknown"}`,
        // The id as a stop can address it (stopIdFrom): the run id, or a
        // non-empty id blank after trimming. The screens read the latter as no
        // run id (runIdFrom); the kill switch still sends it its stop.
        findings: { runId: started.stopId ?? started.runId, target: data.target, results: started.findings },
        // Results the engine sent that could not be read (null) count as
        // nothing here; the status route answers them as unread, never as none.
        ...(completedInline
          ? countSeverities(started.findings ?? [])
          : { severity: null, vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 }),
        executedBy: req.session.userId ?? null,
      });
    } catch (cause) {
      // The engine is scanning, and the row that is this run's Stop -- and
      // the kill switch's view of it -- could not be written. Answering "the
      // start failed" left the run going with nothing here able to stop it.
      // So the run just started is stopped, and the answer says what came of
      // that.
      // By any id a stop can address exactly, blank-looking ones included.
      const stopId = started.stopId ?? started.runId;
      if (!stopId || completedInline) throw cause;
      const byKillSwitch = stoppedByKillSwitch(ticket, started);
      if (byKillSwitch !== null) {
        // Already stopped by the kill switch pressed while it was starting.
        const stop = await byKillSwitch;
        void writeStopRecord(actor(req), { runId: stopId, target: data.target, testId: null }, "kill_switch", stop,
          KILL_SWITCH_START_NOTE).then((failed) => { if (failed) console.error(`[scan] ${failed}`); });
        return void res.status(409).json({
          error: `${killSwitchStartSentence(stopId, stop)} It could not be recorded here either (${causeOf(cause)}).`,
          reason: "kill_switch", runId: stopId, stopped: stop.stopped,
          ...(stop.alreadyFinished ? { alreadyFinished: true } : {}), ...(stop.answerUnread ? { answerUnread: true } : {}),
        });
      }
      const stop = await sendStop(req, { runId: stopId, target: data.target, testId: null }, "start_not_recorded");
      return void res.status(500).json({
        error: `the engine started run ${stopId} but it could not be recorded here (${causeOf(cause)}); ` +
          (stop.answerUnread
            ? "the run was sent a stop, and the engine answered it 2xx, but the rest of its answer was not read " +
              "(stop sent, answer unread): whether it is stopping is not known"
            : stop.stopped
            ? "the run was sent a stop, and the engine accepted it"
            : stop.alreadyFinished
              ? "the run was sent a stop, and the engine answered that it had already ended"
              : `the run was sent a stop and it did not take (${stop.detail}): it may still be running -- ` +
                "stop it with the kill switch or a failsafe pause"),
        runId: stopId,
        stopped: stop.stopped,
        ...(stop.alreadyFinished ? { alreadyFinished: true } : {}),
      });
    }

    // Stopped by the kill switch pressed while it was starting -- before the
    // engine answered, or since, before its row was in: recorded, and said.
    const killed = stoppedByKillSwitch(ticket, started);
    if (killed !== null) {
      const stop = await killed;
      const runId = started.stopId ?? started.runId!;
      const failed = await writeStopRecord(actor(req), { runId, target: data.target, testId: test.id }, "kill_switch", stop,
        KILL_SWITCH_START_NOTE);
      if (failed) console.error(`[scan] ${failed}`);
      return void res.status(409).json({
        error: killSwitchStartSentence(runId, stop),
        reason: "kill_switch", test, runId, stopped: stop.stopped,
        ...(stop.alreadyFinished ? { alreadyFinished: true } : {}), ...(stop.answerUnread ? { answerUnread: true } : {}),
      });
    }

    // From here the row -- and so the run's Stop -- exists. Nothing after it
    // may answer "the start failed" over a run that is scanning: a filing or
    // log write that fails is reported, and the page still gets its test.
    let filed: lifecycle.IngestResult | null = null;
    let notFiled: string | null = null;
    if (started.findings === null) {
      // Results the engine sent that could not be read are filed as nothing,
      // and said so; the record holds them as unread.
      notFiled = "the engine's results for this run could not be read";
    } else {
      try {
        // File what came back as findings with a life of their own. A scan that
        // completes inline has its results now; one still running is filed when
        // it finishes, on the status route.
        filed = await lifecycle.ingest(storage, started.findings, {
          clientId: data.clientId,
          siteId: data.siteId ?? null,
          engagementRef,
          target: data.target,
          testId: test.id,
          runId: started.runId ?? null,
        });
      } catch (cause) {
        notFiled = causeOf(cause);
      }
    }

    try {
      await storage.createActivityLog({
        action: "started", entityType: "test", entityId: test.id,
        details: { target: data.target, engagementRef, runId: started.runId, filed, ...(started.warning ? { warning: started.warning } : {}) },
        ...actor(req),
      });
    } catch {
      // The run started and its row exists; the page needs its test id more than the log line.
    }

    res.status(201).json({
      test, runId: started.runId, state: started.state, filed,
      // A run the engine started without a run id a stop can name breaks the
      // engine's contract: no Stop can reach it, and the screens say what can
      // (the Failsafe console) in place of a Stop that would answer 409.
      ...(started.runId === null && !completedInline ? { stop: "failsafe" as const } : {}),
      ...(notFiled !== null ? { detail: `the run's results could not be filed as findings: ${notFiled}` } : {}),
      ...(started.warning ? { warning: started.warning } : {}),
    });
  }));

  /**
   * Stop a scan that is going wrong.
   *
   * The engine has had a stop button since the abort registry landed, and the
   * client here has had `abort` since the engine was first wired up. Nothing
   * called it: there was no route, so there was no button, and an operator
   * watching a scan they wanted to halt could revoke the whole API key or
   * nothing. Making the stop fast is worth little while it is unreachable.
   */
  app.post("/api/scans/:testId/abort", asyncHandler(async (req, res) => {
    // The test from memory when this process has seen it -- it wrote every
    // scan it started, and reads every test list -- so the stop goes to the
    // engine without asking the database first. Only a test this process has
    // never seen is read, and that read is all that comes before its stop.
    const test = storage.peekTest(req.params.testId) ?? (await storage.getTest(req.params.testId));
    if (!test) return notFound(res, "Test");
    const who = actor(req);

    // By any id a stop can address exactly: a blank-looking id the screens
    // offer no Stop for is still sent this stop, if asked (stopIdOf).
    const runId = stopIdOf(test);
    if (!runId && isEngineRecord(test.findings)) {
      // An engine scan the engine accepted without a run id: a stop has nothing
      // to name it by. It is not "no engine run". It is pointed at the kill
      // switch, which stops every run the engine lists by a run id, and at the
      // failsafes, which stop the engine whatever it lists.
      return void res.status(409).json({ error: NO_RUN_ID_TO_STOP, stop: "failsafe" });
    }
    if (!runId) {
      return void res.status(409).json({
        error: "this test has no engine run recorded against it, so there is nothing to stop",
      });
    }

    let outcome: engine.AbortOutcome;
    try {
      outcome = await engine.abortRun(runId);
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }

    // The engine's answer, not an assumption. Recording "aborted" on a stop
    // the engine did not accept would be the record saying a scan halted when
    // it is still running against somebody's system -- and a run that had
    // already ended was not aborted by this either.
    if (!outcome.accepted && !outcome.alreadyFinished) {
      return void res.status(502).json({
        error: "the engine did not accept the stop; the scan may still be running",
      });
    }
    const stopOutcome = outcomeOf(outcome);
    res.json(outcome.alreadyFinished
      ? { stopped: false, alreadyFinished: true, runId, state: outcome.state, detail: ALREADY_FINISHED }
      : { stopped: true, runId, ...(outcome.answerUnread ? { answerUnread: true, detail: ANSWER_UNREAD } : {}) });

    // After the stop and its answer, and best-effort: a log write that failed
    // (a full disk, a locked database) neither unsends the stop nor delays it.
    const failed = await writeStopRecord(who, { runId, target: null, testId: test.id }, "stop", stopOutcome);
    if (failed) console.error(`[abort] ${failed}`);
  }));

  app.get("/api/scans/:testId", asyncHandler(async (req, res) => {
    const test = await storage.getTest(req.params.testId);
    if (!test) return notFound(res, "Test");

    const recorded = (test.findings ?? {}) as Record<string, unknown>;
    const runId = runIdOf(test);
    // A test no engine run stands behind -- a person's, or a sample row -- has
    // no findings of a run's to answer, completed or not. Decided by the one
    // rule the edit guard and the Tests screen use (shared/engine-record.ts):
    // only the scan route writes a run id, a target or a run's results.
    if (!isEngineRecord(test.findings)) {
      return void res.json({
        test, state: test.status, engine: null, detail: "this test has no engine run recorded against it",
      });
    }
    if (test.status === "completed") {
      // The engine is not asked again about a run recorded as completed, so what
      // it returned is what was recorded then: the last poll's findings, or the
      // start's for a run the engine finished inline. They are answered in the
      // shape the engine's own are, `confidence_basis` and all. This answered
      // `engine: null`, and the scan screens read that as "returned no findings"
      // beside the counts those same findings were counted into. Findings that
      // cannot be read are said to be unread, never answered as none.
      const results = readableResults(recorded.results);
      if (results === null) {
        return void res.json({
          test, state: test.status, engine: null,
          detail: "the findings recorded for this scan could not be read",
        });
      }
      const answered: engine.EngineScan = {
        runId, state: test.status, findings: results, detail: "the findings recorded when the run completed",
      };
      return void res.json({ test, state: test.status, engine: answered });
    }
    if (!runId) {
      // An engine scan the engine accepted without a run id, not recorded as
      // completed: the engine cannot be asked about it, and it is never told it
      // has no engine run. No Stop can reach it either: every read says so, so
      // the screens show what stops it in place of a Stop.
      return void res.json({
        test, state: test.status, engine: null, detail: NO_RUN_ID_TO_ASK,
        ...(FINISHED_RUN_STATES.has(test.status) ? {} : { stop: "failsafe" as const }),
      });
    }

    let current;
    try {
      current = await engine.runState(runId);
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        // The record stands even when the engine has gone. Saying so beats
        // reporting the row's last known status as if it were current.
        return void res.status(200).json({
          test, state: test.status, engine: null, detail: cause.message,
        });
      }
      throw cause;
    }

    const finished = current.state === "completed" || current.state === "aborted"
      || current.state === "failed";
    // Counted from what came back, never from what was asked for. Results the
    // engine sent that could not be read (null: not a list) are recorded as
    // unread and not counted. While the run goes on, the counts stay as the last
    // readable poll left them. On the poll that finishes it they are cleared: a
    // count from a poll before is not what the run found, and left standing it
    // would be read as the finished scan's own. Zero beside unread results is
    // read as "not recorded", never as none (shared/latest-scans.ts).
    const counts = current.findings !== null
      ? countSeverities(current.findings)
      : finished ? UNREAD_COUNTS : {};

    const updated = await storage.updateTest(test.id, {
      status: current.state,
      completedAt: finished ? new Date() : null,
      findings: { ...recorded, results: current.findings },
      ...counts,
    });

    // Filed once the run has stopped moving. Filing a scan still in flight
    // would record half a picture as the current state of the engagement,
    // and the next poll would file the same findings again.
    let filed: lifecycle.IngestResult | null = null;
    if (finished && current.findings !== null) {
      const client = await storage.getClient(test.clientId);
      const site = test.siteId ? await storage.getSite(test.siteId) : null;
      if (client) {
        filed = await lifecycle.ingest(storage, current.findings, {
          clientId: client.id,
          siteId: test.siteId ?? null,
          engagementRef: site ? `${client.id}:${site.id}` : client.id,
          target: typeof recorded.target === "string" ? recorded.target : null,
          testId: test.id,
          runId,
        });
      }
    }

    // Findings the screens cannot show are said to be unread, with the reason,
    // and never answered as a list: not as none, and not as a row that blanks the
    // page. The same rule answers them once the run is recorded as completed.
    if (readableResults(current.findings) === null) {
      return void res.json({
        test: updated ?? test, state: current.state, engine: null, filed,
        detail: "the findings the engine sent for this run could not be read",
      });
    }
    res.json({ test: updated ?? test, state: current.state, engine: current, filed });
  }));

  // ==== RETEST ====
  //
  // "Prove it was fixed" is the second of the six deliverables this product
  // advertises that the engine has always been able to answer and this app
  // never asked. The engine captures a decision twin per real finding during a
  // scan, and /api/remediation/retest goes back to the target and looks again.
  //
  // The verdict is the engine's own word and is passed through unchanged.
  // There are three, and they are not two: closed, still_open, inconclusive.
  // Measured against a live engine with the target simply switched off, the
  // answer is `inconclusive` with the connection error as its detail -- not
  // `closed`. A screen that renders this as fixed/not-fixed would report a
  // host that went down as a vulnerability remediated.

  /** The decisions the engine kept during this test's run. */
  app.get("/api/tests/:testId/decisions", asyncHandler(async (req, res) => {
    const test = await storage.getTest(req.params.testId);
    if (!test) return notFound(res, "Test");

    // By the one rule (shared/engine-record.ts), as every other route reads it.
    const runId = runIdOf(test);
    if (!runId && isEngineRecord(test.findings)) {
      // An engine scan the engine gave no run id -- one it finished inline, say.
      // It has an engine run behind it; nothing names that run to ask for its
      // decisions. It was told it had no engine run.
      return void res.json({
        decisions: [],
        truncated: false,
        detail: "the engine gave this scan no run id, so its decisions cannot be asked for, and nothing can be retested",
      });
    }
    if (!runId) {
      // A test with no engine run behind it -- a sample row, or one recorded
      // before the engine was wired up -- has nothing to retest. Said plainly
      // rather than returning an empty list, which reads as "the scan found
      // nothing worth keeping".
      return void res.json({
        decisions: [],
        truncated: false,
        detail: "this test has no engine run behind it, so there is nothing to retest",
      });
    }

    try {
      const listed = await engine.listDecisions(runId);
      res.json({ ...listed, detail: "" });
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }
  }));

  const retestSchema = z.object({ twinId: z.number().int().nonnegative() });

  app.post("/api/tests/:testId/retest", asyncHandler(async (req, res) => {
    const data = retestSchema.parse(req.body);

    const test = await storage.getTest(req.params.testId);
    if (!test) return notFound(res, "Test");

    const client = await storage.getClient(test.clientId);
    if (!client) return notFound(res, "Client");
    const site = test.siteId ? await storage.getSite(test.siteId) : null;

    // Composed here, from the engagement this test was filed under -- not
    // taken from the twin. A retest touches the customer's system, and the
    // engine used to derive its scope from the twin's own recorded target,
    // which is a check whose only possible answer is yes. The side holding
    // the site list is the side that has to send it.
    const engagementRef = site ? `${client.id}:${site.id}` : client.id;
    const engagementSites = site ? [site] : await storage.getSitesByClient(client.id);
    const scope = engagementSites
      .map((one) => hostOf(one.url))
      .filter((host): host is string => host !== null);

    if (scope.length === 0) {
      return void res.status(400).json({
        error:
          `no site is recorded for ${client.name}, so nothing on record ` +
          `authorises going back to that target. Add the site to the client first.`,
      });
    }

    // One retest of a finding at a time: a second, while the first is still
    // being asked for, watched, or run by an engine that stopped answering, is
    // refused and points at the one running. The check and the reservation
    // are one step in memory, before anything is awaited.
    const key = `${test.id}:${data.twinId}`;
    const runningHere = retestsInFlight.has(key) || retestsReserved.has(key) || retestsHeld.has(key)
      || watcher.knownForTest(test.id).some((one) => one.twinId === data.twinId && one.state === "running");
    const alreadyRunning = () => res.status(409).json({
      error: "a retest of this finding is already running; stop it, or wait for its verdict, before starting another",
      reason: "retest_running",
    });
    if (runningHere) return void alreadyRunning();
    retestsReserved.add(key);
    try {
      let running = false;
      try {
        // Another dashboard on this database may be watching one.
        const open = await storage.getOpenRetestWatches(new Date());
        running = open.some((one) => one.testId === test.id && one.twinId === data.twinId && one.state === "running");
      } catch {
        // The record could not be read: what this dashboard holds decides.
      }
      if (running) return void alreadyRunning();
      // At most maxInflightRetests() retests are being asked of the engine at
      // once from this dashboard, or held by one it stopped waiting for
      // (retestSlots). Engine main answers a retest only when it is over,
      // holding one of its worker threads -- the same threads its Stop is
      // served by -- the whole time; beyond the cap a retest is refused here
      // and never reaches the engine.
      const cap = maxInflightRetests();
      const busy = retestsInFlight.size + retestsHeld.size;
      if (busy >= cap) {
        const held = retestsHeld.size;
        return void res.status(429).json({
          error: `${busy} retest${busy === 1 ? " is" : "s are"} already being asked of the engine ` +
            `from this dashboard, the most it sends at once (${cap}, set by ATHENA_MAX_INFLIGHT_RETESTS)` +
            (held > 0
              ? `; ${held} of them the engine did not answer in time and may still be running, and ` +
                `${held === 1 ? "it keeps its" : "each keeps its"} place until the engine lists no live retest on its target ` +
                `(read every ${Math.round(retestSlots.pollMs / 1000)} s) or ${Math.round(retestSlots.ceilingMs / 60_000)} min pass`
              : "") +
            ". Nothing was sent; try again once one has answered.",
          reason: "retests_busy",
        });
      }
      retestsInFlight.add(key);
    } finally {
      retestsReserved.delete(key);
    }

    // The kill switch pressed since this retest arrived, or held engaged in
    // memory: nothing is sent, and its slot is free at once.
    const ticket = startTickets.get(req) ?? null;
    await markIfEngagedElsewhere(ticket);
    if (ticket?.press || killSwitchMemory.engaged) {
      retestsInFlight.delete(key);
      return void res.status(503).json({
        message: KILL_SWITCH_REFUSAL,
        error: "the kill switch was engaged while this retest was starting, so it was not started: nothing was sent to the engine",
        reason: "kill_switch",
      });
    }

    // When Retest was pressed: the check says so, however the verdict arrives.
    const requestedAt = new Date();
    let answered: engine.RetestAnswer;
    try {
      answered = await engine.retest({ twinId: data.twinId, engagementRef, scope });
    } catch (cause) {
      const heldSaid = "It may still be running this retest: this finding cannot be retested again, and its place among the " +
        "retests sent at once stays taken, until the engine lists no live retest on its target or " +
        `${Math.round(retestSlots.ceilingMs / 60_000)} min pass. The kill switch stops it.`;
      if (cause instanceof engine.UnrecognisedRetestAnswer && cause.stopIds.length > 0) {
        // An answer this dashboard does not read that names a run: a 202 is a
        // live run, and so may any other be. Refused (nothing is filed) and
        // each run it named is sent its stop -- its slot stays taken until the
        // stop is answered, and after, unless every stop was taken or found
        // the run ended.
        const ids = cause.stopIds;
        let stops: StopOutcome[] = [];
        try {
          const why = `sent because the engine answered a retest in a shape this dashboard does not read, naming this run: ${cause.message}`;
          stops = await Promise.all(ids.map((runId) =>
            sendStop(req, { runId, target: null, testId: test.id }, "start_not_recorded", why)));
        } finally {
          retestsInFlight.delete(key);
        }
        const free = stops.length === ids.length && stops.every((one) => acceptedStop(one) || one.alreadyFinished === true);
        if (free) {
          console.log(`[retest] the in-flight slot of retest ${key} is free: the engine's answer was not read, and the stop ` +
            `sent to ${ids.join(", ")} was answered (taken, or the run had ended).`);
        } else {
          retestsHeld.set(key, { scope, since: Date.now() });
          console.error(`[retest] the in-flight slot of retest ${key} is held: the engine's answer was not read, and the ` +
            `stop sent to ${ids.join(", ")} was not taken, or its answer not read.`);
          pollHeldRetests();
        }
        return void res.status(502).json({
          error: `${cause.message} ${ids.map((runId, at) => unreadAnswerStopSentence(runId, stops[at])).join(" ")}` +
            (free ? "" : ` ${heldSaid}`),
          reason: "unrecognised_engine_answer",
          runId: ids[0],
          runIds: ids,
          stopped: stops.every((one) => one.stopped),
          stops: ids.map((runId, at) => ({ runId, ...stops[at] })),
          ...(free ? {} : { held: heldSaid }),
        });
      }
      retestsInFlight.delete(key);
      // Only a definite answer frees the slot at once: a refusal (4xx), no
      // engine to send to, or a connection the engine's host refused before
      // anything was sent (engine.EngineConnectionRefused: nothing reached it,
      // so nothing was started). A timeout, a reset or aborted connection, a
      // 5xx, an answer that could not be read or was not recognised -- the
      // request may have reached the engine, and engine main runs a retest to
      // its end whoever is waiting. Its slot is held (retestSlots) until the
      // engine lists no live retest on its scope, or the ceiling.
      if (cause instanceof engine.EngineConnectionRefused) {
        console.log(`[retest] the in-flight slot of retest ${key} is free at once: ${causeOf(cause)} (refused before anything was sent).`);
        return void res.status(503).json({
          error: `the engine refused the connection; the retest was not started (${causeOf(cause)})`,
          reason: "engine_refused_connection",
        });
      }
      const definite = cause instanceof engine.EngineRefused || cause instanceof engine.EngineNotConfigured
        || (cause instanceof engine.UnrecognisedRetestAnswer && cause.answered);
      if (!definite) {
        retestsHeld.set(key, { scope, since: Date.now() });
        console.error(`[retest] the in-flight slot of retest ${key} is held: ${causeOf(cause)}. The engine may still be ` +
          "running it; the slot is freed when the engine lists no live retest on " +
          `${scope.join(", ")}, or after ${Math.round(retestSlots.ceilingMs / 60_000)} min.`);
        pollHeldRetests();
      } else {
        console.log(`[retest] the in-flight slot of retest ${key} is free at once: ${causeOf(cause)} (a definite answer).`);
      }
      if (cause instanceof engine.UnrecognisedRetestAnswer) {
        return void res.status(502).json({ error: cause.message, reason: "unrecognised_engine_answer", ...(definite ? {} : { held: heldSaid }) });
      }
      return void res.status(503).json(definite ? { error: causeOf(cause) } : {
        error: `${causeOf(cause)}. ${heldSaid}`,
        reason: cause instanceof engine.EngineTimedOut ? "retest_unanswered" : "retest_unconfirmed",
      });
    }
    // A definite answer: the slot is free at once.
    retestsInFlight.delete(key);
    console.log(`[retest] the in-flight slot of retest ${key} is free at once: the engine answered with a ${answered.answer}.`);

    const who = { userId: req.session.userId ?? null, actor: actor(req) };

    // The kill switch pressed while the engine was being asked, and the
    // engine answered with a retest still running: it is watched (its verdict,
    // if it comes to one, is filed as any is) and stopped now, by its run id.
    const liveRetest = answered.answer === "status" && answered.status.engineRunId !== null
      && engine.retestMayBeRunning(answered.status);
    if (liveRetest) await markIfEngagedElsewhere(ticket);
    if (liveRetest && answered.answer === "status" && ticket?.press) {
      const status = answered.status;
      const runId = status.engineRunId!;
      watcher.start({
        engineRunId: runId, testId: test.id, clientId: client.id, twinId: data.twinId, engagementRef,
        requestedBy: who.userId, requestedFrom: who.actor.ipAddress, engineState: status.state,
      });
      ticket.stopped ??= stopForPress(ticket.press, runId);
      const stop = await ticket.stopped;
      res.status(409).json({
        error: killSwitchStartSentence(runId, stop).replace(/^Engine run/, "Retest run"),
        reason: "kill_switch", answer: "status", phase: "running", engineRunId: runId, testId: test.id, twinId: data.twinId,
        state: status.state, stopped: stop.stopped, stoppable: true,
        ...(stop.alreadyFinished ? { alreadyFinished: true } : {}), ...(stop.answerUnread ? { answerUnread: true } : {}),
      });
      // After the answer: the watch's note, and the record of the stop.
      const noted = stop.answerUnread ? watcher.stopSentUnread(runId) : stop.stopped ? watcher.stopAccepted(runId) : Promise.resolve(null);
      const failed = [await noted.catch((cause) => causeOf(cause)),
        await writeStopRecord(who.actor, { runId, target: null, testId: test.id }, "kill_switch", stop, KILL_SWITCH_START_NOTE)]
        .filter((one): one is string => typeof one === "string" && one !== "");
      for (const one of failed) console.error(`[retest] ${one}`);
      return;
    }

    // A status is where the run is, never a verdict: nothing is filed, no
    // finding is changed, and nothing is called fixed or inconclusive from it
    // (athena-engine #71). Read before anything reads a verdict.
    if (answered.answer === "status") {
      return void (await answerRetestStatus(res, watcher, { test, client, twinId: data.twinId, engagementRef, who }, answered.status));
    }
    const result = answered.result;

    // Carry the verdict into the finding it is about.
    const { applied } = await fileRetestVerdict({ test, client, twinId: data.twinId, who }, result, requestedAt);

    // A retest sends real requests to somebody's system, so it is an act and
    // belongs in the record with the authority it ran under.
    await storage.createActivityLog({
      action: "retested", entityType: "test", entityId: test.id,
      details: {
        twinId: data.twinId,
        engagementRef,
        verdict: result.verdict,
        findingType: result.findingType,
        target: result.target,
        applied,
        // A verdict whose run the engine ended aborted after its check was
        // filed: said so in the record, never as a clean run.
        stoppedAfterRecording: result.stoppedAfterRecording || null,
      },
      ...who.actor,
    });

    res.json({ answer: "verdict", ...result, applied });
  }));

  /**
   * A retest the engine answered 202 for, as its watcher last found it
   * (server/retests.ts). The page polls this until the phase is not
   * `running`; its Stop does not wait on it.
   */
  app.get("/api/retests/:runId", asyncHandler(async (req, res) => {
    const watched = await watcher.view(req.params.runId);
    if (!watched) return notFound(res, "Retest");
    res.json(retestView(watched));
  }));

  /**
   * Stop a retest, by the engine run id the engine answered it with.
   *
   * Sent to the engine first, before anything is read or written: no read,
   * no watch and no log write stands in front of it. The kill switch lets it
   * through as a stop (killSwitchClass). Any run id is sent its stop -- a stop
   * is never refused for not being on record here.
   */
  app.post("/api/retests/:runId/abort", asyncHandler(async (req, res) => {
    const runId = req.params.runId;
    // Authorised from memory, never from a read: an admin, or the owner of the
    // retest -- who pressed Retest, or who ran the test it was run from. The
    // session's role is the account's now (auth.ts sessionUser).
    const me = sessionUser(req) ?? (req.currentUser ? { id: req.currentUser.id, role: req.currentUser.role } : null);
    const watched = watcher.peek(runId);
    const owner = watched !== undefined && me !== null
      && (watched.requestedBy === me.id || storage.peekTest(watched.testId)?.executedBy === me.id);
    // Until the watches on record have been read (RetestWatcher.resume, which
    // tries until it can), who owns a retest this dashboard has not read is
    // not known here -- nor whether the run id is a retest's at all -- and
    // stopping is the safe direction. So the Stop is sent for anyone signed in
    // who may run retests (every signed-in user may), to whatever engine run
    // id it names, and the log says who sent it: "sent before watches loaded,
    // id not verified as a retest".
    const unverified = watched === undefined && me !== null && !watcher.resumeState().loaded;
    if (me?.role !== "admin" && !owner && !unverified) {
      return void res.status(403).json({
        error: "only an admin, or the owner of the test this retest was run from, can stop it here. " +
          "An admin's kill switch on the AI Control page stops every run the engine lists.",
      });
    }
    const who = actor(req);
    let outcome: engine.AbortOutcome;
    try {
      outcome = await engine.abortRun(runId);
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }
    if (!outcome.accepted && !outcome.alreadyFinished) {
      return void res.status(502).json({
        error: "the engine did not accept the stop; the retest may still be running",
      });
    }
    const stopOutcome = outcomeOf(outcome);
    // Noted in memory at once (a watch's own read after this knows it), on
    // the record in the background: an accepted stop only when the engine
    // took it and said so; a 2xx whose answer was not read as just that --
    // "stop sent, answer unread" -- never as accepted.
    if (outcome.accepted) {
      const noted = outcome.answerUnread ? watcher.stopSentUnread(runId) : watcher.stopAccepted(runId);
      void noted.then((failed) => { if (failed) console.error(`[retest] ${failed}`); });
    }
    res.json(outcome.alreadyFinished
      ? { stopped: false, alreadyFinished: true, runId, state: outcome.state, detail: ALREADY_FINISHED }
      : { stopped: true, runId, ...(outcome.answerUnread ? { answerUnread: true, detail: ANSWER_UNREAD } : {}) });
    // After the stop and its answer: a write that failed unsends nothing.
    const note = unverified && me?.role !== "admin"
      ? `sent before watches loaded, id not verified as a retest: sent by ${who.userId ?? "an unnamed session"} before ` +
        "this dashboard had read the retests on record, so neither whether this run id is a retest's nor whether they " +
        "own it was checked -- it is sent to any engine run id; stopping is the safe direction"
      : undefined;
    const failed = await writeStopRecord(who, {
      runId, target: null, testId: watched?.testId ?? null,
    }, "retest_stop", stopOutcome, note);
    if (failed) console.error(`[retest] ${failed}`);
  }));

  /** The retests this dashboard knows for a test, still open: a page opened again shows each running one with its Stop. */
  app.get("/api/tests/:testId/retests", asyncHandler(async (req, res) => {
    const testId = req.params.testId;
    const byRun = new Map<string, RetestWatch>();
    try {
      for (const one of await storage.getOpenRetestWatches(new Date(Date.now() - retests.retestWatch.keepUnwatchedMs))) {
        if (one.testId === testId) byRun.set(one.engineRunId, one);
      }
    } catch {
      // Answered from what this dashboard knows.
    }
    for (const one of watcher.knownForTest(testId)) {
      if (!byRun.has(one.engineRunId) && (one.state === "running" || one.state === "unwatched")) byRun.set(one.engineRunId, one);
    }
    res.json({ retests: Array.from(byRun.values()).map((one) => retestView(one)) });
  }));

  /**
   * The runs the engine lists as live right now, each with its kind. "Scans
   * running now" reads the retests from this: a retest is no test row, and
   * the engine's list is where it is.
   */
  app.get("/api/engine/runs", asyncHandler(async (_req, res) => {
    // No engine, no runs: said, not refused, so a page without one shows no error.
    if (!engine.isConfigured()) return void res.json({ runs: [], configured: false });
    try {
      res.json({ runs: await engine.activeRuns(), configured: true });
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }
  }));

  // ==== DOCUMENTS ====
  app.get("/api/documents", asyncHandler(async (req, res) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    res.json(clientId ? await storage.getDocumentsByClient(clientId) : await storage.getAllDocuments());
  }));

  app.post("/api/documents", asyncHandler(async (req, res) => {
    if (forgedAttribution(res, req.body)) return;
    const data = createDocumentSchema.parse(req.body);
    if (await parentMissing(res, (data as { clientId?: string }).clientId, (data as { siteId?: string | null }).siteId)) return;
    const document = await storage.createDocument({ ...data, createdBy: req.session.userId ?? null });
    await storage.createActivityLog({
      action: "created", entityType: "document", entityId: document.id,
      details: { title: document.title, clientId: document.clientId }, ...actor(req),
    });
    res.status(201).json(document);
  }));

  app.patch("/api/documents/:id", asyncHandler(async (req, res) => {
    if (forgedAttribution(res, req.body)) return;
    const data = updateDocumentSchema.parse(req.body);
    const document = await storage.updateDocument(req.params.id, data);
    if (!document) return notFound(res, "Document");
    if (hasChanges(data)) {
      await storage.createActivityLog({ action: "updated", entityType: "document", entityId: document.id, details: null, ...actor(req) });
    }
    res.json(document);
  }));

  app.delete("/api/documents/:id", asyncHandler(async (req, res) => {
    const success = await storage.deleteDocument(req.params.id);
    if (!success) return notFound(res, "Document");
    await storage.createActivityLog({ action: "deleted", entityType: "document", entityId: req.params.id, details: null, ...actor(req) });
    res.json({ success: true });
  }));

  // ==== ACTIVITY LOGS (read-only; entries are written by the server) ====
  // Admin-only: the log carries every user's id, IP address and sign-in
  // times, and the user administration it describes is itself admin-only.
  app.get("/api/logs", requireAdmin, asyncHandler(async (req, res) => {
    // A repeated or array-valued parameter used to fail the string test and be
    // dropped, so the filter silently disappeared and the endpoint returned
    // everything rather than refusing.
    if (badQueryParam(res, req.query.entityType) || badQueryParam(res, req.query.entityId)) return;
    const entityType = typeof req.query.entityType === "string" ? req.query.entityType : undefined;
    const entityId = typeof req.query.entityId === "string" ? req.query.entityId : undefined;
    if (entityType && entityId) {
      return void res.json(await storage.getActivityLogsByEntity(entityType, entityId));
    }
    res.json(await storage.getAllActivityLogs());
  }));

  // ==== AI HEALTH ====
  app.get("/api/ai-health/latest", asyncHandler(async (_req, res) => {
    // null rather than 404. "No reading has been taken yet" is a state of a
    // healthy deployment in its first minute, not a missing resource, and a
    // 404 made the screen render its error fallback on every fresh install.
    res.json((await storage.getLatestAIHealthMetric()) ?? null);
  }));

  app.get("/api/ai-health", asyncHandler(async (req, res) => {
    const raw = parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1000) : 50;
    res.json(await storage.getAIHealthMetrics(limit));
  }));

  app.post("/api/ai-health", requireAdmin, asyncHandler(async (req, res) => {
    const data = insertAIHealthMetricSchema.parse(req.body);
    const metric = await storage.createAIHealthMetric(data);
    await storage.createActivityLog({
      action: "created", entityType: "ai_health_metric", entityId: metric.id,
      details: null, ...actor(req),
    });
    res.status(201).json(metric);
  }));

  // ==== USERS (admin only) ====
  /**
   * Who a finding can be given to.
   *
   * Separate from /api/users, which is admin-only and returns the whole user
   * record. Assigning an owner is ordinary work for any operator, and this
   * returns only what a picker needs -- an id and a name. The findings list
   * already shows owners by name, so this discloses nothing it does not.
   */
  app.get("/api/users/assignable", asyncHandler(async (_req, res) => {
    const users = await storage.getAllUsers();
    res.json(users
      .filter((one) => one.isActive)
      .map((one) => ({ id: one.id, username: one.username })));
  }));

  app.get("/api/users", requireAdmin, asyncHandler(async (_req, res) => {
    const users = await storage.getAllUsers();
    res.json(users.map(publicUser));
  }));

  app.post("/api/users", requireAdmin, asyncHandler(async (req, res) => {
    const data = insertUserSchema.parse(req.body);
    if (await storage.getUserByUsername(data.username)) {
      res.status(409).json({ message: "Username already exists" });
      return;
    }
    const user = await storage.createUser(data);
    await storage.createActivityLog({
      action: "created", entityType: "user", entityId: user.id,
      details: { username: user.username, role: user.role }, ...actor(req),
    });
    res.status(201).json(publicUser(user));
  }));

  app.patch("/api/users/:id", requireAdmin, asyncHandler(async (req, res) => {
    const data = updateUserSchema.parse(req.body);
    const isSelf = req.params.id === req.session.userId;
    if (isSelf && (data.role === "user" || data.isActive === false)) {
      res.status(400).json({ message: "You cannot demote or deactivate your own account" });
      return;
    }
    const user = await storage.updateUser(req.params.id, data);
    if (!user) return notFound(res, "User");
    // Every live session of this account follows it at once: a stop is
    // authorised from memory, by the role it has now (auth.ts).
    noteAccount(user);
    reviseLiveSessions(req.sessionStore, user.id, user);
    const changed = Object.keys(data).filter((k) => k !== "password");
    await storage.createActivityLog({
      action: "updated", entityType: "user", entityId: user.id,
      details: { fields: data.password ? [...changed, "password"] : changed }, ...actor(req),
    });
    res.json(publicUser(user));
  }));

  app.delete("/api/users/:id", requireAdmin, asyncHandler(async (req, res) => {
    if (req.params.id === req.session.userId) {
      res.status(400).json({ message: "You cannot delete your own account" });
      return;
    }
    const success = await storage.deleteUser(req.params.id);
    if (!success) return notFound(res, "User");
    // Its live sessions authorise nothing from now on, stops included.
    noteAccountDeleted(req.params.id);
    reviseLiveSessions(req.sessionStore, req.params.id, null);
    await storage.createActivityLog({ action: "deleted", entityType: "user", entityId: req.params.id, details: null, ...actor(req) });
    res.json({ success: true });
  }));

  // ==== API KEYS ====
  //
  // Programmatic credentials for this dashboard's own API, owned by the same
  // server that owns auth. Minting, listing and revoking are all admin-only: an
  // API key is a standing grant of a real account's access, so handing one out is
  // an administrator's act. The plaintext secret is returned exactly once, at
  // creation, and is never stored or logged — only its SHA-256 hash is kept, so a
  // leaked database yields no working key. A key authenticates as the account
  // that created it (see auth.ts), and revoking retires it permanently.

  app.get("/api/api-keys", requireAdmin, asyncHandler(async (_req, res) => {
    const keys = await storage.getAllApiKeys();
    res.json(keys.map(publicApiKey));
  }));

  app.post("/api/api-keys", requireAdmin, asyncHandler(async (req, res) => {
    const { name } = createApiKeySchema.parse(req.body);
    const { key, secret } = await storage.createApiKey({ name, createdBy: req.session.userId ?? null });
    // The name and prefix are recorded; the secret is not — an audit log that
    // held the key would be a second place the credential lives.
    await storage.createActivityLog({
      action: "created", entityType: "api_key", entityId: key.id,
      details: { name: key.name, prefix: key.prefix }, ...actor(req),
    });
    // The one and only time the plaintext is on the wire. The client shows it
    // once and cannot ask for it again.
    res.status(201).json({ key: publicApiKey(key), secret });
  }));

  app.delete("/api/api-keys/:id", requireAdmin, asyncHandler(async (req, res) => {
    // Authorised from the session in memory (auth.ts isStopRequest) only for
    // a key of the session's own account. Another account's key is revoked
    // only by an admin whose account, read now, is one: a session this
    // process still holds as an admin's, whose account another dashboard
    // demoted or deleted, cannot take every other admin's automation away.
    if (req.authorisedFromSession === true) {
      const key = (await storage.getAllApiKeys()).find((one) => one.id === req.params.id);
      if (key && key.createdBy !== req.session.userId) {
        let account: User | undefined;
        try {
          account = await accountNow(req);
        } catch (cause) {
          return void res.status(503).json({
            message: `The account behind this session could not be read (${causeOf(cause)}), and revoking another ` +
              "account's key needs it. Nothing was revoked; try again.",
          });
        }
        if (!account) return void res.status(401).json({ message: "Authentication required" });
        if (account.role !== "admin") return void res.status(403).json({ message: "Admin role required" });
      }
    }
    const revoked = await storage.revokeApiKey(req.params.id);
    if (!revoked) return notFound(res, "API key");
    await storage.createActivityLog({
      action: "revoked", entityType: "api_key", entityId: revoked.id,
      details: { name: revoked.name, prefix: revoked.prefix }, ...actor(req),
    });
    res.json(publicApiKey(revoked));
  }));

  // ==== AI CONTROL ====
  app.get("/api/ai-control", asyncHandler(async (_req, res) => {
    const settings = (await storage.getAIControlSettings()) ?? (await storage.updateAIControlSettings({}));
    // A press this dashboard holds in memory is the switch's state whatever the row says yet (killSwitchMemory).
    res.json(killSwitchMemory.engaged
      ? { ...settings, killSwitchEnabled: true, ...(killSwitchMemory.notStored !== null ? { killSwitchNotStored: killSwitchMemory.notStored } : {}) }
      : settings);
  }));

  /**
   * Every write of the AI control settings, in the order the requests
   * ARRIVED -- not the order their authorisation finished. Each request takes
   * a sequence number the moment it arrives, before anything is awaited
   * (aiControlArrival, ahead of requireAdmin): a disengage whose account read
   * takes 300 ms, pressed before an engage authorised from memory at once,
   * still comes before it. The writes are made one after another (a flag
   * write under a held lock waits off the event loop, and two retrying at
   * once landed in either order), and a write is not made at all when a
   * later-sequenced request has already stored one of the same fields: that
   * request is answered `superseded`, and writes nothing. A later write of
   * other fields alone overtakes nothing. So each field stored is the last
   * press's that set it; and every answer states the settings stored when it
   * is given -- with the switch as memory holds it (killSwitchMemory).
   */
  let aiControlWrites: Promise<unknown> = Promise.resolve();
  /** For each field, the sequence number of the latest request whose write of it was stored. */
  const aiControlFieldWritten = new Map<string, number>();
  /** The settings as this dashboard's latest stored write left them. */
  let aiControlLatest: AIControlSetting | null = null;
  const laterWriteOf = (fields: string[], seq: number): boolean =>
    fields.some((field) => (aiControlFieldWritten.get(field) ?? 0) > seq);
  const flagWrittenLaterThan = (seq: number): boolean => laterWriteOf(["killSwitchEnabled"], seq);
  /** Write, unless a later-sequenced request already stored one of these fields: then null, and nothing is written. */
  const writeAIControl = (seq: number, fields: Parameters<typeof storage.updateAIControlSettings>[0]) => {
    const names = Object.keys(fields).filter((field) => field !== "lastModifiedBy");
    const written = aiControlWrites.then(async () => {
      if (laterWriteOf(names, seq)) return null;
      let stored: AIControlSetting;
      try {
        stored = await storage.updateAIControlSettings(fields);
      } catch (cause) {
        if (fields.killSwitchEnabled === true) killSwitchFlagNotStored(seq, causeOf(cause));
        throw cause;
      }
      for (const field of names) aiControlFieldWritten.set(field, Math.max(aiControlFieldWritten.get(field) ?? 0, seq));
      aiControlLatest = stored;
      if (names.includes("killSwitchEnabled")) killSwitchFlagStored(seq);
      return stored;
    });
    aiControlWrites = written.catch(() => undefined);
    return written;
  };
  /** The settings stored now, as far as this dashboard wrote them, with the switch as memory holds it. */
  const aiControlNow = (fallback: AIControlSetting | null): AIControlSetting | null => {
    const stored = aiControlLatest ?? fallback;
    if (stored === null) return null;
    return { ...stored, killSwitchEnabled: stored.killSwitchEnabled === true || killSwitchMemory.engaged };
  };
  const SUPERSEDED = "a later change to these settings was sent while this one was being saved; the stored settings are that one's";

  app.patch("/api/ai-control", requireAdmin, asyncHandler(async (req, res) => {
    const seq = aiControlSeq.get(req) ?? ++aiControlArrivals;
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
    let data: z.infer<typeof updateAIControlSettingSchema>;
    let ignored: string[] = [];
    if (body.killSwitchEnabled === true) {
      ({ data, ignored } = engagingAIControlChange(body));
    } else {
      if (refusedAIControlFields(res, req.body)) return;
      data = updateAIControlSettingSchema.parse(req.body);
    }
    const noted = ignored.length > 0 ? { ignored } : {};
    // Engaging: pressed now, in memory, before anything is awaited or any
    // write queued (pressKillSwitch). From this instant every write but a stop
    // is refused, a start in flight is not sent -- or, accepted after this,
    // is stopped by its run id -- and a resume's or a release's signature is
    // refused, whatever the stored row says yet.
    const press = data.killSwitchEnabled === true ? pressKillSwitch(seq, flagWrittenLaterThan) : null;
    // The stops first (stopEverythingRunning): each goes to the engine before
    // anything is written, and they go together. Then the flag, so every other
    // dashboard refuses writes too. Sent again each time the switch is sent
    // on, so an operator can retry the scans that could not be reached.
    //
    // A flag that could not be stored holds back no stop: on a full disk, or
    // a read-only or locked database, the stops have gone already, and the
    // answer carries both outcomes. The flag's write waits for a lock off the
    // event loop (storage-sqlite.ts withBusyRetry), alongside the stops still
    // being answered, so it delays none of them.
    const sweep = press !== null ? stopEverythingRunning(req, watcher, press) : null;
    // And, once the stops are on their way, the failsafe commands the control
    // plane lists are read, and their actions remembered (failsafe.remember):
    // a resume or a release among them is then refused from memory while the
    // switch is engaged, with no read to wait on. Never awaited; a read that
    // fails changes nothing.
    if (press !== null && failsafe.isConfigured()) {
      setImmediate(() => {
        failsafe.listCommands().catch((cause) => {
          console.warn(`[failsafe] the kill switch's read of the failsafe commands failed (${causeOf(cause)}); ` +
            "a command not known here is read when its signature is relayed");
        });
      });
    }

    // Engaging, authorised from the session in memory (auth.ts isStopRequest),
    // authorises the switch and nothing else: every other field sent with it
    // waits until the stops are answered, and is then authorised from the
    // account as it is now -- and refused, by name, if the account is not an
    // active admin, or cannot be read.
    const fromMemory = req.authorisedFromSession === true && data.killSwitchEnabled === true;
    const { killSwitchEnabled: _flag, ...others } = data;
    const unauthorised = fromMemory ? others : {};
    const now = fromMemory ? { killSwitchEnabled: true } : data;

    let settings: Awaited<ReturnType<typeof storage.updateAIControlSettings>> | null = null;
    let notStored: string | null = null;
    /** A later-sequenced request stored one of these fields first: this one writes nothing, and says so. */
    let overtaken = false;
    try {
      settings = await writeAIControl(seq, { ...now, lastModifiedBy: req.session.userId ?? null });
      if (settings === null) overtaken = true;
    } catch (cause) {
      if (data.killSwitchEnabled !== true) throw cause;
      notStored = causeOf(cause);
    }
    let stops: RecordedStops | null = null;
    let engineRuns: EngineSweep | null = null;
    let writeFailures: string[] = [];
    if (sweep !== null) {
      // Neither list failing is a 500: what the page must say is which list
      // could not be read -- not that nothing ran.
      ({ stops, engineRuns, writeFailures } = await sweep);
    }

    // The other fields, now that every stop is answered.
    const otherFields = Object.keys(unauthorised);
    let refused: { status: number; why: string } | null = null;
    if (otherFields.length > 0) {
      let account: User | undefined;
      let unread: string | null = null;
      try {
        account = await accountNow(req);
      } catch (cause) {
        unread = causeOf(cause);
      }
      if (unread !== null) refused = { status: 503, why: `the account behind this session could not be read (${unread})` };
      else if (!account) refused = { status: 401, why: "the account behind this session is no longer active" };
      else if (account.role !== "admin") refused = { status: 403, why: "the account behind this session is no longer an admin" };
      else if (notStored !== null) refused = { status: 500, why: "the kill switch itself could not be stored" };
      else if (overtaken) refused = { status: 409, why: SUPERSEDED };
      else {
        try {
          const stored = await writeAIControl(seq, { ...unauthorised, lastModifiedBy: req.session.userId ?? null });
          if (stored === null) refused = { status: 409, why: SUPERSEDED };
          else settings = stored;
        } catch (cause) {
          refused = { status: 500, why: `they could not be stored (${causeOf(cause)})` };
        }
      }
    }
    const refusedNote = refused === null ? {} : { refused: otherFields };

    // Counted as the engine answered: accepted, or (said only when there
    // are any) answered "not running" -- never a run that had ended as accepted.
    const count = (list: Array<{ stopped: boolean; alreadyFinished?: boolean; answerUnread?: boolean }>) => {
      const notRunning = list.filter((one) => one.alreadyFinished).length;
      const answerUnread = list.filter((one) => one.answerUnread === true).length;
      return {
        sent: list.length, accepted: list.filter(acceptedStop).length,
        ...(answerUnread > 0 ? { answerUnread } : {}), ...(notRunning > 0 ? { notRunning } : {}),
      };
    };
    const notWritten = overtaken ? { notWritten: SUPERSEDED } : {};
    const logged = stops === null || engineRuns === null ? { ...data, ...notWritten } : {
      ...(fromMemory ? { killSwitchEnabled: true, ...(refused === null ? others : {}) } : data),
      ...notWritten,
      ...noted,
      ...refusedNote,
      ...(notStored !== null ? { notStored } : {}),
      stops: stops.listed
        ? count(stops.scans)
        : { listed: false, detail: stops.detail, ...count(stops.scans ?? []) },
      engineRuns: engineRuns.listed
        ? {
          ...count(engineRuns.runs),
          ...(engineRuns.unnamed !== undefined ? { unnamed: engineRuns.unnamed } : {}),
        }
        : {
          listed: false, detail: engineRuns.detail, ...count(engineRuns.retests ?? []),
          ...(engineRuns.retestsUnlisted ? { retestsUnlisted: engineRuns.retestsUnlisted } : {}),
        },
    };
    try {
      await storage.createActivityLog({
        action: "updated", entityType: "ai_control", entityId: settings?.id ?? "ai_control", details: logged, ...actor(req),
      });
    } catch (cause) {
      // Once stops were sent, their outcome reaches the page whatever the log did.
      if (stops === null) throw cause;
      writeFailures.push(`the record of engaging the kill switch could not be written: ${causeOf(cause)}`);
    }
    // A later change to one of these fields was STORED after this one's own
    // write settled -- or before it, overtaking it, so this one wrote nothing:
    // this answer states the settings stored now, not this request's, and
    // says so (the page reads them again). A later change that was only
    // authorised, or whose write failed, supersedes nothing.
    const sent = Object.keys(data);
    const isSuperseded = overtaken || laterWriteOf(sent, seq)
      // A later press of the switch, held in memory while its flag is written.
      || (sent.includes("killSwitchEnabled") && killSwitchMemory.engaged && killSwitchMemory.seq > seq);
    const superseded = isSuperseded ? { superseded: SUPERSEDED } : {};
    const current = isSuperseded
      ? aiControlNow((await storage.getAIControlSettings().catch(() => undefined)) ?? settings)
      : settings === null ? null : { ...settings, killSwitchEnabled: settings.killSwitchEnabled === true || killSwitchMemory.engaged };
    /** The switch as it is now: stored, or held in memory. */
    const engagedNow = current?.killSwitchEnabled === true || killSwitchMemory.engaged;
    if (overtaken) {
      // Nothing of this request was written: a request that arrived after it
      // stored one of these fields first. Its stops, if it sent any, went all
      // the same, and are said; the settings answered are the ones stored now.
      return void res.status(409).json({
        message: `Nothing of this change was saved: ${SUPERSEDED}.` +
          (stops !== null ? " Every stop was sent all the same; what each came to is below." : ""),
        ...current,
        ...(stops !== null ? { engaged: engagedNow, stops, engineRuns } : {}),
        ...(writeFailures.length > 0 ? { writeFailures } : {}),
        ...noted,
        written: false,
        ...superseded,
      });
    }
    if (notStored !== null) {
      // The flag is not stored; the press is held in memory all the same
      // (killSwitchMemory) unless a later change let it go: said, with the
      // stops, which went out regardless.
      return void res.status(500).json({
        message: engagedNow
          ? `The kill switch's flag could not be stored: ${notStored}. It is engaged in this dashboard's memory: every ` +
            "write here but a stop is refused until it is switched off here, but another dashboard on this database " +
            "does not see it, and a restart of this one forgets it -- press it again once the database takes writes. " +
            "Every stop was sent all the same; what each came to is below." +
            (refused !== null ? ` The other fields sent with it (${otherFields.join(", ")}) were not saved.` : "")
          : `The kill switch could not be engaged: ${notStored}, and a later change has since switched it off. Every ` +
            "stop was sent all the same; what each came to is below. Writes are not refused." +
            (refused !== null ? ` The other fields sent with it (${otherFields.join(", ")}) were not saved.` : ""),
        engaged: engagedNow,
        stored: false,
        stops,
        engineRuns,
        ...(writeFailures.length > 0 ? { writeFailures } : {}),
        ...noted,
        ...refusedNote,
        ...superseded,
      });
    }
    if (refused !== null) {
      // Every stop sent; the rest of the request refused, by name -- with the
      // switch as it stands now, which a later change may have turned off.
      return void res.status(refused.status).json({
        message: (engagedNow
          ? "The kill switch was engaged and every stop was sent, but the other fields sent with it "
          : "The kill switch was engaged and every stop was sent, and a later change has since switched it off " +
            "(it is off now); the other fields sent with it ") +
          `(${otherFields.join(", ")}) were not saved: ${refused.why}. Engaging the kill switch is authorised from ` +
          "the signed-in session; every other setting needs an active admin account.",
        ...current,
        engaged: engagedNow,
        stops,
        engineRuns,
        ...(writeFailures.length > 0 ? { writeFailures } : {}),
        ...noted,
        ...refusedNote,
        ...superseded,
      });
    }
    res.json(stops === null
      ? { ...current, ...superseded }
      : { ...current, stops, engineRuns, ...(writeFailures.length > 0 ? { writeFailures } : {}), ...noted, ...superseded });
  }));

  // ==== AI CHAT ====
  app.get("/api/chat", asyncHandler(async (req, res) => {
    res.json(await storage.getChatMessagesByUser(req.session.userId!));
  }));

  // ==== SETTINGS: where this deployment talks to ====
  //
  // Admin only, both ways. These fields decide where a customer's data goes
  // -- which engine is asked to scan them, and which third party sees a
  // summary of what was found -- so they are not an ordinary user's to read
  // or to change.

  app.get("/api/settings/connections", requireAdmin, asyncHandler(async (_req, res) => {
    // Secrets come back as `set: true` and `value: null`. There is no benign
    // version of an API key on the wire: it reaches a browser, a devtools
    // network tab and whatever is between, and the only thing the screen
    // needs is whether somebody has to type one.
    // And what opening the database found and could not do (db-sqlite.ts
    // openReport): said on the Settings screen, not only in the server's log.
    res.json({ fields: settings.readable(), database: { duplicateEngineRunIds: [...openReport.duplicateEngineRunIds] } });
  }));

  app.patch("/api/settings/connections", requireAdmin, asyncHandler(async (req, res) => {
    const data = updateConnectionSettingsSchema.parse(req.body);
    await settings.save(data, req.session.userId ?? null);

    // Which fields moved, never what they moved to. An audit log that records
    // a credential is a second place the credential lives.
    await storage.createActivityLog({
      action: "updated", entityType: "connection_settings", entityId: "singleton",
      details: { fields: Object.keys(data).sort() },
      ...actor(req),
    });

    res.json({ fields: settings.readable() });
  }));

  // ==== SAMPLE DATA ====
  // The installer seeds three clients, four sites, three tests and three
  // documents so a fresh install is not a blank screen. Two of those tests
  // carry severity counts, and until now the dashboard added them into its
  // totals with nothing to say they were written rather than found. Reading
  // is open to anyone signed in, because every screen that counts these rows
  // needs to say so; removing them is an admin's.

  app.get("/api/sample-data", asyncHandler(async (_req, res) => {
    res.json(await storage.countSampleData());
  }));

  app.delete("/api/sample-data", requireAdmin, asyncHandler(async (req, res) => {
    const removed = await storage.removeSampleData();
    await storage.createActivityLog({
      action: "deleted", entityType: "sample_data", entityId: null,
      details: removed, ...actor(req),
    });
    res.json({ removed });
  }));

  /**
   * Classify a vulnerability description with the engine's model.
   *
   * The screen behind this printed "SQL Injection, 92% confident" for every
   * input, then stopped classifying at all on the stated grounds that the
   * engine had no such route. It has one. This is that route.
   */
  const classifyRequestSchema = z.object({
    text: z.string().trim().min(1, "there is nothing to classify").max(20_000),
  });

  app.post("/api/classify-cve", asyncHandler(async (req, res) => {
    // Rejected here rather than sent on. An empty string is a question the
    // model cannot be asked: it answers at the floor with a tie-break label,
    // which reads exactly like a finding.
    const data = classifyRequestSchema.parse(req.body);

    let result;
    try {
      result = await engine.classifyCve(data.text);
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }

    if (result.unavailable) {
      // The engine's own words. Its model can be absent while the engine is
      // up, and that is a different thing from the engine being down.
      return void res.status(503).json({ error: result.unavailable });
    }

    res.json(result);
  }));

  // ==== EVIDENCE ====
  // "Evidence Pack" is one of the six things this product says it produces.
  // The engine has built them all along -- signed, Merkle-committed, with a
  // per-source status -- and nothing in this app ever asked for one.

  const evidenceRequestSchema = z.object({
    clientId: z.string().min(1),
    siteId: z.string().optional(),
    testId: z.string().optional(),
    reason: z.string().trim().min(1, "say what this pack is for").max(1000),
  });

  app.post("/api/evidence-pack", requireAdmin, asyncHandler(async (req, res) => {
    // Admin only. A pack is a cross-source record of what this deployment did
    // to somebody's systems, assembled for handing to a third party.
    const data = evidenceRequestSchema.parse(req.body);

    const client = await storage.getClient(data.clientId);
    if (!client) return notFound(res, "Client");
    const site = data.siteId ? await storage.getSite(data.siteId) : null;
    if (data.siteId && !site) return notFound(res, "Site");
    if (site && site.clientId !== data.clientId) {
      return void res.status(400).json({ error: "that site belongs to a different client" });
    }

    // The same engagement string the scan was filed under, composed the same
    // way. A pack scoped to a different spelling of the engagement is a pack
    // about nothing.
    const engagementRef = site ? `${client.id}:${site.id}` : client.id;

    // The engine's run id, when this pack is about one test. Recorded in the
    // test's findings by the scan route.
    let runId: string | undefined;
    if (data.testId) {
      const test = await storage.getTest(data.testId);
      if (!test) return notFound(res, "Test");
      if (test.clientId !== data.clientId) {
        return void res.status(400).json({ error: "that test belongs to a different client" });
      }
      runId = runIdOf(test) ?? undefined;
    }

    let pack;
    try {
      pack = await engine.buildEvidencePack({ engagementRef, reason: data.reason, runId });
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }

    // Recorded because issuing one is an act: it assembles a customer's
    // records into a document that leaves this machine. What it was for is
    // part of that, which is why `reason` is required.
    await storage.createActivityLog({
      action: "issued", entityType: "evidence_pack", entityId: engagementRef,
      details: {
        reason: data.reason,
        signed: pack.signed,
        leafCount: pack.leafCount,
        merkleRoot: pack.merkleRoot,
        runId: runId ?? null,
      },
      ...actor(req),
    });

    res.json(pack);
  }));

  // ==== FAILSAFE ====
  //
  // The operator console for the three engine failsafes -- pause, stand-down,
  // terminate. This server drafts commands and RELAYS operator signatures; it
  // never holds a signing key, so nothing here can make an engine act on its
  // own. Operators sign out of band with `mythos-failsafe` (their private key
  // stays on their machine), stand-down and terminate need two distinct
  // operators, and the engine independently verifies every command before
  // obeying. See server/failsafe.ts for the trust model.
  //
  // Every route is admin-only: these are the highest-stakes controls in the
  // product, so reaching the console at all is a guarded action. The
  // cryptographic two-person rule is the guard on the actions themselves.

  const FAILSAFE_ACTIONS = ["pause", "resume", "stand_down", "release", "terminate"] as const;
  const draftCommandSchema = z.object({
    action: z.enum(FAILSAFE_ACTIONS),
    engineId: z.string().trim().min(1, "an engine id is required").max(200),
    reason: z.string().max(2000).optional().default(""),
  });
  const submitSignatureSchema = z.object({
    keyId: z.string().trim().min(1).max(128),
    sig: z.string().trim().regex(/^[0-9a-fA-F]+$/, "a signature is hex").max(256),
  });
  const failsafeUnavailable = (res: Response, cause: unknown): boolean => {
    if (cause instanceof failsafe.FailsafeUnavailable) {
      // 503, not 500: the control plane is not there or not answering, which
      // is a fact about the deployment, not a bug in this server.
      res.status(503).json({ error: cause.message });
      return true;
    }
    return false;
  };

  /**
   * Record a failsafe act on this side, after the control plane took it.
   *
   * Best-effort: the draft, the signature or the withdrawal has happened on
   * the control plane by now, and answering 500 because the log could not be
   * written reported it as failed -- and lost the uuid of a drafted pause,
   * which the console needs to open it for signing. The failure is logged.
   */
  async function recordFailsafeAct(req: Request, action: string, uuid: string, details: Record<string, unknown>): Promise<void> {
    try {
      await storage.createActivityLog({ action, entityType: "failsafe_command", entityId: uuid, details, ...actor(req) });
    } catch (cause) {
      console.error(`[failsafe] ${action} ${uuid} went through; its activity log could not be written: ${causeOf(cause)}`);
    }
  }

  app.get("/api/failsafe/status", requireAdmin, asyncHandler(async (_req, res) => {
    // status() answers its own unreachability rather than throwing, so a
    // control plane that is simply not configured renders as words on the
    // page, not a 503.
    res.json({ ...(await failsafe.status()), defaultEngineId: failsafe.defaultEngineId() });
  }));

  app.get("/api/failsafe/state", requireAdmin, asyncHandler(async (req, res) => {
    const engineId = typeof req.query.engineId === "string" ? req.query.engineId : undefined;
    try {
      res.json(await failsafe.state(engineId));
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  app.get("/api/failsafe/commands", requireAdmin, asyncHandler(async (req, res) => {
    const engineId = typeof req.query.engineId === "string" ? req.query.engineId : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    try {
      res.json(await failsafe.listCommands({ engineId, status }));
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  app.post("/api/failsafe/commands", requireAdmin, asyncHandler(async (req, res) => {
    const data = draftCommandSchema.parse(req.body);
    let result;
    try {
      result = await failsafe.draftCommand(data);
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) {
      // The backend's own refusal, verbatim -- e.g. terminate from a service
      // account that is not an admin. The operator needs the reason.
      return void res.status(result.status).json({ error: result.detail });
    }
    // Drafting a failsafe command is an act worth recording on this side too,
    // independent of the backend's own audit trail -- after the draft, and
    // best-effort: a log write that failed answered 500 for a pause the control
    // plane had drafted, and the page never received the uuid it signs.
    await recordFailsafeAct(req, "drafted", result.drafted.command.uuid, {
      failsafeAction: data.action, engineId: data.engineId, reason: data.reason,
    });
    res.status(201).json(result.drafted);
  }));

  app.get("/api/failsafe/commands/:uuid", requireAdmin, asyncHandler(async (req, res) => {
    let drafted;
    try {
      drafted = await failsafe.getCommand(req.params.uuid);
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
    if (!drafted) return notFound(res, "Command");
    res.json(drafted);
  }));

  // A signature is a stop only when its command is one: a pause's, a
  // stand-down's or a terminate's. Its action comes from memory when this
  // dashboard has proxied the command (a draft, a list or a detail answer, a
  // relay's or a withdrawal's answer, the kill switch's sweep:
  // failsafe.knownActionOf), with no read; otherwise from one read of the
  // command, waited for at most 250 ms (failsafe.readActionWithin), whose
  // answer the kill switch's check reuses. A read that fails or runs out of
  // time never holds a relay back: the signature of a session held as an
  // admin's is relayed as a possible stop, and logged so -- the control plane
  // verifies every keyholder's signature itself, which is the real authority.
  // Only a command known to be a resume or a release needs the account, read
  // now (auth.ts requireAdminUnlessStop). And a possible stop that turns out
  // to be a resume or a release -- its read finishing after the relay went,
  // or the relay's own answer naming its action -- is withdrawn at once when
  // it would have been refused (possibleStopLearnt).
  const relayKind = async (req: Request): Promise<StopKind> => {
    const read = await actionOfRequest(req);
    if (read.action === null) return "possible_stop";
    return FAILSAFE_STOP_ACTIONS.has(read.action) ? "stop" : "not_stop";
  };

  /** What became of a possible stop that turned out to be a resume or a release. */
  interface Withdrawal {
    action: string;
    /** How its action was learnt: its read, finishing after the relay went; or the relay's own answer. */
    learntFrom: "read" | "answer";
    /** Why it would have been refused, had its action been known in time. */
    refusedBecause: string;
    /** Whether the control plane took the withdrawal. */
    withdrawn: boolean;
    detail: string;
    status: number;
  }

  /**
   * Whether a relay of this action, from this request, would have been
   * refused had its action been known in time -- and why: the kill switch
   * engaged (in memory, or on the stored row), or not known to be off; or
   * the account behind the session not an active admin's now, or not read.
   * Null when it would have gone through: a current admin's resume with the
   * switch off, which nothing here withdraws.
   */
  async function wouldRefuseRecovery(req: Request): Promise<{ why: string; status: number } | null> {
    if (killSwitchMemory.engaged) return { why: "the AI kill switch is engaged", status: 503 };
    try {
      const now = await killSwitchEngagedNow();
      if (now.engaged) return { why: "the AI kill switch is engaged", status: 503 };
    } catch (cause) {
      return { why: `whether the AI kill switch is engaged could not be read (${causeOf(cause)})`, status: 503 };
    }
    let account: Awaited<ReturnType<typeof accountNow>>;
    try {
      account = await accountNow(req);
    } catch (cause) {
      return { why: `the account behind this session could not be read (${causeOf(cause)})`, status: 503 };
    }
    if (!account) return { why: "the account behind this session is not an active account now", status: 401 };
    if (account.role !== "admin") return { why: "the account behind this session is not an admin's now", status: 403 };
    return null;
  }

  /**
   * A signature relayed as a possible stop whose command turned out to be a
   * resume or a release. When the relay would have been refused had that been
   * known (wouldRefuseRecovery), the command is withdrawn at once -- by this
   * dashboard's service account, the one credential it holds on the control
   * plane, in the name of the admin whose session relayed it -- and recorded
   * against that admin. Withdrawing a resume or a release keeps an engine
   * stopped; it is never refused (killSwitchRefusesCommand). Tried twice.
   */
  async function withdrawPossibleStop(
    req: Request, uuid: string, action: string, learntFrom: Withdrawal["learntFrom"],
  ): Promise<Withdrawal | null> {
    // With the switch engaged in memory, the withdrawal goes before anything is read.
    const refused = killSwitchMemory.engaged
      ? { why: "the AI kill switch is engaged", status: 503 }
      : await wouldRefuseRecovery(req);
    if (refused === null) return null;
    let withdrawn = false;
    let detail = "";
    for (let attempt = 0; attempt < 2 && !withdrawn; attempt += 1) {
      try {
        const result = await failsafe.cancelCommand(uuid);
        withdrawn = result.ok;
        detail = result.ok ? `the control plane took the withdrawal; the command is ${result.command.status}`
          : `the control plane refused the withdrawal (${result.status}): ${result.detail}`;
        if (!result.ok) break;
      } catch (cause) {
        detail = `the withdrawal could not be sent: ${causeOf(cause)}`;
      }
    }
    const outcome: Withdrawal = { action, learntFrom, refusedBecause: refused.why, withdrawn, detail, status: refused.status };
    const said = `[failsafe] signature for command ${uuid} was relayed as a possible stop; its action is ${action} ` +
      `(learnt from the ${learntFrom === "read" ? "command's read, after the relay went" : "relay's own answer"}), and ` +
      `${refused.why}: ${withdrawn ? "withdrawn" : "NOT withdrawn"} (${detail})`;
    if (withdrawn) console.warn(said);
    else console.error(said + ". Withdraw it from the failsafe console.");
    await recordFailsafeAct(req, withdrawn ? "withdrawn" : "withdrawal_failed", uuid, {
      failsafeAction: action, relayedAsPossibleStop: true, learntFrom, refusedBecause: refused.why, detail,
    });
    return outcome;
  }

  app.post("/api/failsafe/commands/:uuid/signatures", requireAdminUnlessStop(relayKind), asyncHandler(async (req, res) => {
    const read = await actionOfRequest(req);
    if (await killSwitchRefusesCommand(res, "relay", read)) return;
    const data = submitSignatureSchema.parse(req.body);
    const uuid = req.params.uuid;
    const unconfirmed = read.action === null;
    // A possible stop's action, once learnt -- by its read finishing late, or
    // by the relay's own answer, whichever is first: a resume or a release is
    // withdrawn then, at once, whether or not this request is still answering.
    let followUp: Promise<Withdrawal | null> | null = null;
    let relayRejected = false;
    const learnt = (action: string | null, from: Withdrawal["learntFrom"]) => {
      if (followUp !== null || relayRejected || action === null || !FAILSAFE_RECOVER_ACTIONS.has(action)) return;
      followUp = withdrawPossibleStop(req, uuid, action, from).catch((cause) => {
        console.error(`[failsafe] command ${uuid}: a possible stop found to be a ${action} could not be dealt with: ${causeOf(cause)}`);
        return null;
      });
    };
    let result: Awaited<ReturnType<typeof failsafe.submitSignature>> | null = null;
    let failed: unknown = null;
    try {
      // Relayed first; said after, so nothing -- not even the log line -- stands before it.
      const relayed = failsafe.submitSignature(uuid, data);
      if (unconfirmed) {
        console.warn(`[failsafe] signature for command ${uuid}: action not confirmed; relayed as a possible stop ` +
          `(${read.unread ?? "its action could not be read"}). The control plane verifies the keyholders' signatures.`);
        void read.later?.then((late) => learnt(late.action, "read"));
      }
      result = await relayed;
    } catch (cause) {
      failed = cause;
    }
    if (result !== null && !result.ok) relayRejected = true;
    if (unconfirmed && result?.ok) learnt(result.command.action || null, "answer");
    // Settled already, or being settled now: said in this answer.
    const withdrawal = followUp === null ? null : await (followUp as Promise<Withdrawal | null>);
    const withdrawnNote = withdrawal === null ? {} : {
      relayedAsPossibleStop: true,
      withdrawal: {
        action: withdrawal.action, learntFrom: withdrawal.learntFrom, refusedBecause: withdrawal.refusedBecause,
        withdrawn: withdrawal.withdrawn, detail: withdrawal.detail,
      },
    };
    const withdrawnSentence = withdrawal === null ? "" :
      `This signature was relayed before its command's action was known (a possible stop). The command is a ` +
      `${withdrawal.action}, and ${withdrawal.refusedBecause}, so ` + (withdrawal.withdrawn
        ? `it was withdrawn at once: ${withdrawal.detail}.`
        : `it had to be withdrawn, and the withdrawal did not take: ${withdrawal.detail}. Withdraw it from the failsafe console now.`);
    if (failed !== null) {
      if (failed instanceof failsafe.FailsafeUnavailable) {
        return void res.status(503).json({ error: withdrawnSentence ? `${failed.message}. ${withdrawnSentence}` : failed.message, ...withdrawnNote });
      }
      throw failed;
    }
    if (result === null) return;
    if (!result.ok) {
      // A rejected signature (bad key, forged, already signed) is the operator's
      // to see verbatim -- it is the whole point of relaying it here.
      return void res.status(result.status).json({ error: withdrawnSentence ? `${result.detail}. ${withdrawnSentence}` : result.detail, ...withdrawnNote });
    }
    await recordFailsafeAct(req, "signed", uuid, {
      keyId: data.keyId, status: result.command.status, signers: result.command.signers,
      ...(unconfirmed ? { actionConfirmed: false, note: "action not confirmed; relayed as a possible stop", unread: read.unread ?? null } : {}),
    });
    if (withdrawal !== null) {
      // Relayed, then withdrawn (or not): not a signature that went through, and said so.
      return void res.status(withdrawal.status).json({ error: withdrawnSentence, message: withdrawnSentence, ...withdrawnNote, command: result.command });
    }
    res.json(result.command);
  }));

  app.post("/api/failsafe/commands/:uuid/cancel", requireAdmin, asyncHandler(async (req, res) => {
    if (await killSwitchRefusesCommand(res, "cancel", await actionOfRequest(req))) return;
    let result;
    try {
      result = await failsafe.cancelCommand(req.params.uuid);
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) {
      return void res.status(result.status).json({ error: result.detail });
    }
    await recordFailsafeAct(req, "canceled", req.params.uuid, { status: result.command.status });
    res.json(result.command);
  }));

  app.get("/api/failsafe/audit", requireAdmin, asyncHandler(async (req, res) => {
    const command = typeof req.query.command === "string" ? req.query.command : undefined;
    try {
      res.json(await failsafe.audit({ command }));
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // ==== ASSURANCE (system of record, read + disposition) ====
  //
  // A read-through to the Athena control plane (Athena-Backend), which is the
  // system of record for the assurance graph: the deployments under assurance,
  // their findings graded by how strongly each is known, the six-state
  // deployment decision, and the Unknowns Register. The browser calls this
  // server same-origin with its session cookie; this server reaches the backend
  // with its service account (server/assurance.ts). Every route is behind the
  // `/api` requireAuth guard above; the reads stay open to any signed-in
  // operator, but the two writes -- recompute a decision, dispose of an Unknown
  // -- are admin-only, so a non-admin gets a clean 403 at the front door rather
  // than reaching the backend (which enforces the same rule independently).
  // When no control plane is configured the calls answer 503 with a reason, and
  // the screen says so in words rather than inventing data.

  const assuranceUnavailable = (res: Response, cause: unknown): boolean => {
    if (cause instanceof assurance.ControlPlaneUnavailable) {
      res.status(503).json({ error: cause.message });
      return true;
    }
    return false;
  };
  const qp = (req: Request, key: string): string | undefined =>
    typeof req.query[key] === "string" ? (req.query[key] as string) : undefined;

  app.get("/api/assurance/status", asyncHandler(async (_req, res) => {
    // status() answers its own unreachability rather than throwing, so an
    // unconfigured backend renders as words, not a 503.
    res.json(await assurance.status());
  }));

  app.get("/api/assurance/deployments", asyncHandler(async (_req, res) => {
    try {
      res.json(await assurance.listDeployments());
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's assurance receipt (spine): a recomputable digest an auditor
  // verifies. A read, behind requireAuth like the rest of the assurance reads.
  app.get("/api/assurance/deployments/:uuid/receipt", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.deploymentReceipt(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's full, versioned Assurance Receipt (spine): the roadmap tuple
  // — system, receipt version, policy, evidence root, result, per-assessment
  // digests — as one deterministic, portable, signable payload. The standardised
  // superset of the bare receipt above; computed, never stored. A read, behind
  // requireAuth like the rest of the assurance reads. Served unsigned by the
  // backend, which says so in the payload; its digests show a change only
  // against an independently obtained copy, never that the conclusions are true.
  app.get("/api/assurance/deployments/:uuid/assurance-receipt", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.assuranceReceipt(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's AI System Capability Map (Phase 1.3): the ground-truth
  // inventory of what it can do. A read, behind requireAuth like the rest.
  app.get("/api/assurance/deployments/:uuid/capabilities", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.capabilities(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's System / Route Map (Phase 1.6): the layered data-flow graph
  // (app → gateway → model → data → tools → logs). A read, behind requireAuth.
  app.get("/api/assurance/deployments/:uuid/route-map", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.routeMap(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's AI-BOM (Phase 1.7): the AI supply-chain bill of materials,
  // an exportable inventory with an unsigned digest. A read, behind requireAuth.
  app.get("/api/assurance/deployments/:uuid/ai-bom", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.aiBom(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's AI data-boundary assessment (Phase 1.4): the approved
  // boundary a human declared reconciled against the deployment's actual data
  // destinations. A read, behind requireAuth like the rest of the reads.
  app.get("/api/assurance/deployments/:uuid/data-boundary", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.dataBoundary(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's compliance map (Phase 2.1): an honest gap map of its
  // findings against the compliance frameworks -- which controls a finding has
  // touched (an open finding against them), never which controls are "met". A
  // read, behind requireAuth like the rest of the assurance reads.
  app.get("/api/assurance/deployments/:uuid/compliance", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.compliance(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's business-impact map (Phase 2.4): the business-impact
  // dimensions its findings implicate — inferred potential exposure, never a
  // realized loss or a dollar figure. A read, behind requireAuth like the rest
  // of the assurance reads.
  app.get("/api/assurance/deployments/:uuid/business-impact", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.businessImpact(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's Third-Party Vendor Assurance (commercial spine): the posture
  // of the vendors it depends on — what each asserts, at what evidence strength,
  // an honest gap list, and the ungoverned dependencies. It never presents a
  // vendor as secure: a vendor_asserted claim reads as vendor-asserted. A read,
  // behind requireAuth like the rest of the assurance reads.
  app.get("/api/assurance/deployments/:uuid/vendor-assurance", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.vendorAssurance(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's executive summary (commercial spine): the assurance graph
  // rolled up for a leadership reader — asset coverage, evidence distribution,
  // finding posture, remediation velocity, the six-state decision, and ordinal
  // posture/maturity bands. Every value is a real count, a true ratio, or an
  // ordinal band — no dollar figure or ROI amount anywhere. A read, behind
  // requireAuth like the rest of the assurance reads.
  app.get("/api/assurance/deployments/:uuid/executive-summary", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.executiveSummary(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's operational / continuous-assurance roll-up (commercial
  // spine): where it sits in the continuous-assurance loop — evidence
  // freshness/staleness, the change backlog needing reassessment, remediation
  // velocity, the six-state decision, and an ordinal readiness band (weakest-wins,
  // never green-by-default; an unassessed deployment reads `stale`). Every ratio is
  // null when there is no basis to compute it. A read, behind requireAuth like the
  // rest of the assurance reads.
  app.get("/api/assurance/deployments/:uuid/operational-assurance", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.operationalAssurance(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // ---- Access & Blast Radius (Phase 3.1 + 2.5) ----

  // The deployment's Identity Assurance & Effective Access (Phase 3.1): every
  // principal that can act and what each can effectively reach (direct and
  // transitive, evidenced paths only), with its identity-assurance gaps. It never
  // claims least privilege is satisfied — powers, reach, and gaps only. A read,
  // behind requireAuth like the rest of the assurance reads.
  app.get("/api/assurance/deployments/:uuid/effective-access", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.effectiveAccess(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's Ripple Effect / blast-radius (Phase 2.5): for each origin
  // worth tracing, a few well-supported downstream consequences a compromise of it
  // could have, each tied to the evidenced via-path. Every consequence is potential
  // and evidence-based, never a realized harm or a monetary figure; an origin with
  // no evidenced reach reads honestly as such, never as safe. A read, behind
  // requireAuth like the rest of the assurance reads.
  app.get("/api/assurance/deployments/:uuid/ripple-effect", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.rippleEffect(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // ---- Posture (credential-gated, Phase 3.2 / 3.3 / 3.4) ----

  // The posture catalog: which posture domains exist and whether each is
  // configured. A read, behind requireAuth. It triggers nothing.
  app.get("/api/assurance/deployments/:uuid/posture", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.postureCatalog(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's Cloud Assurance posture (Phase 3.2, credential-gated). A read,
  // behind requireAuth. Inert by default: with no credentials the backend answers a
  // normal 200 `{connected:false, ...}`, which is passed through — an inert domain
  // reads as "not connected", never "all clear".
  app.get("/api/assurance/deployments/:uuid/cloud-posture", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.cloudPosture(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's Secrets / Crypto posture (Phase 3.3, credential-gated). A read,
  // behind requireAuth. Inert by default; no secret value is ever emitted.
  app.get("/api/assurance/deployments/:uuid/secrets-posture", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.secretsPosture(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's Repository / SDLC posture (Phase 3.4, credential-gated). A
  // read, behind requireAuth. Inert by default.
  app.get("/api/assurance/deployments/:uuid/repo-posture", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.repoPosture(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // ---- Data & Context (Phase 3.5) ----

  // The deployment's Personal Context Exposure (Phase 3.5): what personal / customer
  // data it holds, in which components, and which principals can reach it. An
  // unclassified store reads as unknown (exposure cannot be ruled out), never "no
  // PII"; no data value is emitted. A read, behind requireAuth like the rest.
  app.get("/api/assurance/deployments/:uuid/personal-context", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.personalContext(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's Data Lifecycle Review (Phase 3.5): the lifecycle stages
  // evidenced in the graph, the components that evidence each at their true strength,
  // and the gaps where a stage has no evidenced control. An unevidenced stage reads
  // "not evidenced", never "compliant". A read, behind requireAuth like the rest.
  app.get("/api/assurance/deployments/:uuid/data-lifecycle", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.dataLifecycle(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's Training / Reuse Review (Phase 3.5): whether customer / internal
  // data is reused for training, sharing or retention — verified vs merely asserted —
  // per provider, each at its true evidence class. A vendor_asserted "we don't train
  // on your data" reads as vendor-asserted, never verified; an unstated policy is a
  // gap, never "safe". A read, behind requireAuth like the rest.
  app.get("/api/assurance/deployments/:uuid/training-reuse", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.trainingReuse(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The deployment's Metadata & Logging Risk (Phase 3.5): where prompts / traces /
  // embeddings / metadata get logged, the sensitive categories that could reach those
  // sinks, and the gaps where sensitive data is logged with no evidenced control. No
  // sensitive value is ever emitted — only the presence of a category and its
  // lineage. A read, behind requireAuth like the rest.
  app.get("/api/assurance/deployments/:uuid/metadata-logging", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.metadataLogging(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The Vertical Assurance Packs catalog (commercial spine): the static, code-only
  // catalog of industry packs. A read, behind requireAuth like the rest. Apply one
  // to the deployment via the pack route below.
  app.get("/api/assurance/deployments/:uuid/assurance-packs", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.assurancePacks(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // Apply one vertical assurance pack to the deployment (commercial spine): its
  // compliance coverage read through the pack's lens, with the regulatory regimes
  // carried as context, never computed coverage. A read, behind requireAuth. An
  // unknown pack is a meaningful backend 400 (not a control-plane outage), so it
  // is surfaced to the operator as a 400 with its reason rather than a 503 —
  // mirroring how the disposition writes pass a backend 4xx through.
  app.get("/api/assurance/deployments/:uuid/assurance-packs/:pack", asyncHandler(async (req, res) => {
    let result;
    try {
      result = await assurance.assurancePack(req.params.uuid, req.params.pack);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) {
      // The backend's own refusal (an unknown pack key), verbatim, so the
      // operator sees why rather than a bare 503.
      return void res.status(result.status).json({ error: result.detail });
    }
    res.json(result.value);
  }));

  // A finding's remediation workflow (Phase 2.3): its current workflow state,
  // assignee, and the audit trail of moves. This is the human process of getting
  // a finding fixed, tracked separately from the security disposition — a read,
  // behind requireAuth like the rest of the assurance reads.
  app.get("/api/assurance/findings/:uuid/remediation", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.remediation(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  app.get("/api/assurance/findings", asyncHandler(async (req, res) => {
    try {
      res.json(
        await assurance.listFindings({
          deployment: qp(req, "deployment"),
          severity: qp(req, "severity"),
          status: qp(req, "status"),
        }),
      );
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  app.get("/api/assurance/unknowns", asyncHandler(async (req, res) => {
    try {
      res.json(
        await assurance.listUnknowns({
          deployment: qp(req, "deployment"),
          status: qp(req, "status"),
          impact: qp(req, "impact"),
        }),
      );
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  app.get("/api/assurance/assets", asyncHandler(async (req, res) => {
    try {
      res.json(
        await assurance.listAssets({
          deployment: qp(req, "deployment"),
          kind: qp(req, "kind"),
          classification: qp(req, "classification"),
        }),
      );
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  app.get("/api/assurance/providers", asyncHandler(async (_req, res) => {
    try {
      res.json(await assurance.listProviders());
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // `paused` is forwarded only when the caller names it. Absent, the backend keeps
  // whatever pause its locked row holds; defaulting it to false here lifted a
  // pause an operator committed after this page loaded, on the next Recompute.
  const recomputeSchema = z.object({ paused: z.boolean().optional() });

  app.post("/api/assurance/deployments/:uuid/recompute", requireAdmin, asyncHandler(async (req, res) => {
    const { paused } = recomputeSchema.parse(req.body ?? {});
    let result;
    try {
      result = await assurance.recomputeDecision(req.params.uuid, paused);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) {
      // The backend's own refusal (a deployment that is gone, a credential that
      // may not recompute it), verbatim, so the operator sees why.
      return void res.status(result.status).json({ error: result.detail });
    }
    await storage.createActivityLog({
      action: "recomputed",
      entityType: "assurance_deployment",
      entityId: req.params.uuid,
      details: { decision: result.decision, paused: paused ?? null },
      ...actor(req),
    });
    res.json({ decision: result.decision, decisionLabel: result.decisionLabel });
  }));

  const dataBoundarySchema = z.object({
    allowedRegions: z.array(z.string().max(64)).max(64).optional().default([]),
    trainingAllowed: z.boolean().optional().default(false),
    thirdPartySharingAllowed: z.boolean().optional().default(false),
    notes: z.string().max(2000).optional(),
  });

  // Declare (or replace) a deployment's approved data boundary (Phase 1.4).
  // Admin-only: this is the human ruling the assessment reconciles against.
  app.put("/api/assurance/deployments/:uuid/data-boundary", requireAdmin, asyncHandler(async (req, res) => {
    const data = dataBoundarySchema.parse(req.body ?? {});
    let result;
    try {
      result = await assurance.setDataBoundary(req.params.uuid, data);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) {
      // The backend's own refusal, verbatim, so the operator sees why.
      return void res.status(result.status).json({ error: result.detail });
    }
    await storage.createActivityLog({
      action: "declared",
      entityType: "assurance_data_boundary",
      entityId: req.params.uuid,
      details: {
        allowedRegions: result.value.policy?.allowedRegions ?? [],
        trainingAllowed: result.value.policy?.trainingAllowed ?? false,
        violations: result.value.summary.violations,
      },
      ...actor(req),
    });
    res.json(result.value);
  }));

  const unknownPatchSchema = z
    .object({
      status: z.enum(["open", "investigating", "resolved", "accepted"]).optional(),
      deploymentImpact: z.enum(["low", "medium", "high"]).optional(),
      notes: z.string().max(2000).optional(),
      reviewBy: z.string().max(32).nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: "name at least one field to change" });

  app.patch("/api/assurance/unknowns/:uuid", requireAdmin, asyncHandler(async (req, res) => {
    const data = unknownPatchSchema.parse(req.body);
    let result;
    try {
      result = await assurance.patchUnknown(req.params.uuid, data);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) {
      // The backend's own refusal, verbatim, so the operator sees why.
      return void res.status(result.status).json({ error: result.detail });
    }
    await storage.createActivityLog({
      action: "updated",
      entityType: "assurance_unknown",
      entityId: req.params.uuid,
      details: { status: result.unknown.status, deploymentImpact: result.unknown.deploymentImpact },
      ...actor(req),
    });
    res.json(result.unknown);
  }));

  // ==== REMEDIATION WORKFLOW (Phase 2.3; admin-only writes) ====
  //
  // A finding's remediation workflow is the human process of getting it fixed:
  // who owns it and where it is in the six-state pipeline. Moving the state and
  // (re)assigning it mutate the record, so both are admin-only here and on the
  // control plane; a non-admin gets a clean 403 at the front door. A workflow
  // move never touches the finding's security status or the deployment's
  // decision. The backend refuses an illegal transition or an unknown user with
  // a 400, returned verbatim so the operator sees why rather than a bare 503.

  // Mirrors assurance/models.py; kept in lockstep so the console never offers a
  // state the backend will reject.
  const REMEDIATION_STATES = [
    "new",
    "triaged",
    "in_progress",
    "in_review",
    "resolved",
    "wont_fix",
  ] as const;

  const remediationTransitionSchema = z.object({
    toState: z.enum(REMEDIATION_STATES),
    note: z.string().max(2000).optional(),
  });

  app.post(
    "/api/assurance/findings/:uuid/remediation/transition",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const data = remediationTransitionSchema.parse(req.body ?? {});
      let result;
      try {
        result = await assurance.remediationTransition(req.params.uuid, data.toState, data.note);
      } catch (cause) {
        if (assuranceUnavailable(res, cause)) return;
        throw cause;
      }
      if (!result.ok) {
        // The backend's own refusal (an illegal transition is a 400), verbatim,
        // so the operator sees why the move did not take.
        return void res.status(result.status).json({ error: result.detail });
      }
      await storage.createActivityLog({
        action: "remediation_transitioned",
        entityType: "assurance_finding",
        entityId: req.params.uuid,
        details: { toState: result.value.state },
        ...actor(req),
      });
      res.json(result.value);
    }),
  );

  const remediationAssignSchema = z.object({
    // null clears the assignee; a non-empty username assigns it. The backend
    // refuses an unknown user with a 400.
    assignee: z.string().trim().min(1).max(150).nullable(),
    note: z.string().max(2000).optional(),
  });

  app.post(
    "/api/assurance/findings/:uuid/remediation/assign",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const data = remediationAssignSchema.parse(req.body ?? {});
      let result;
      try {
        result = await assurance.remediationAssign(req.params.uuid, data.assignee, data.note);
      } catch (cause) {
        if (assuranceUnavailable(res, cause)) return;
        throw cause;
      }
      if (!result.ok) {
        // The backend's own refusal (an unknown user is a 400), verbatim.
        return void res.status(result.status).json({ error: result.detail });
      }
      await storage.createActivityLog({
        action: "remediation_assigned",
        entityType: "assurance_finding",
        entityId: req.params.uuid,
        details: { assignee: result.value.assignee },
        ...actor(req),
      });
      res.json(result.value);
    }),
  );

  // The users a remediation assignment may target, for a picker instead of
  // free-text entry (Phase 2.3). Admin-only — the SAME guard as the assign route
  // above — since it enumerates operator accounts. The backend scopes this to
  // active users only, exactly the set the assign route accepts. A backend
  // refusal (403/404) is passed back verbatim.
  app.get(
    "/api/assurance/findings/:uuid/assignable",
    requireAdmin,
    asyncHandler(async (req, res) => {
      let result;
      try {
        result = await assurance.getAssignable(req.params.uuid);
      } catch (cause) {
        if (assuranceUnavailable(res, cause)) return;
        throw cause;
      }
      if (!result.ok) {
        return void res.status(result.status).json({ error: result.detail });
      }
      res.json(result.value);
    }),
  );

  // ==== PROVIDER ASSURANCE PROFILE (admin-only writes) ====
  //
  // A provider's profile is declared, not measured, so a human records it: an
  // admin registers a provider a deployment relies on and records each graded
  // fact (region, retention, logging, training) with the evidence class that is
  // honest for it. Reads are open (above); every write is admin-only here and on
  // the control plane, and a backend refusal (a duplicate field, a validation
  // error) is returned verbatim so the operator sees why.

  // Mirrors assurance/models.py; kept in lockstep so the console never offers a
  // choice the backend will reject.
  const EVIDENCE_CLASSES = [
    "technically_verified",
    "configuration_verified",
    "document_supported",
    "contractually_stated",
    "vendor_asserted",
    "partially_verified",
    "unknown",
    "not_documented",
  ] as const;
  const ASSERTION_FIELDS = [
    "region",
    "data_retention",
    "logging",
    "trains_on_data",
    "subprocessors",
    "certifications",
    "dpa",
  ] as const;
  const ASSERTION_SOURCES = ["vendor_doc", "contract", "self_declared", "measured"] as const;
  const PROVIDER_KINDS = [
    "model_provider",
    "gateway",
    "embedding",
    "vector_db",
    "observability",
    "cloud",
    "other",
  ] as const;

  const providerCreateSchema = z.object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(PROVIDER_KINDS),
  });

  app.post("/api/assurance/providers", requireAdmin, asyncHandler(async (req, res) => {
    const input = providerCreateSchema.parse(req.body);
    let result;
    try {
      result = await assurance.createProvider(input);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) return void res.status(result.status).json({ error: result.detail });
    await storage.createActivityLog({
      action: "created",
      entityType: "assurance_provider",
      entityId: result.value.uuid,
      details: { name: result.value.name, kind: result.value.kind },
      ...actor(req),
    });
    res.status(201).json(result.value);
  }));

  // Edit a provider's declared identity in place. Admin-only here and on the
  // control plane (Django ProviderViewSet.update). At least one editable field
  // must be named. There is deliberately no DELETE counterpart: the Django
  // ProviderViewSet exposes no destroy (a provider is a global registry other
  // records point at), so a remove route could only ever answer 405.
  const providerPatchSchema = z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      kind: z.enum(PROVIDER_KINDS).optional(),
      region: z.string().max(200).optional(),
      notes: z.string().max(4000).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: "name at least one field to change" });

  app.patch("/api/assurance/providers/:uuid", requireAdmin, asyncHandler(async (req, res) => {
    const patch = providerPatchSchema.parse(req.body);
    let result;
    try {
      result = await assurance.updateProvider(req.params.uuid, patch);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) return void res.status(result.status).json({ error: result.detail });
    await storage.createActivityLog({
      action: "updated",
      entityType: "assurance_provider",
      entityId: req.params.uuid,
      details: { name: result.value.name, kind: result.value.kind },
      ...actor(req),
    });
    res.json(result.value);
  }));

  const assertionCreateSchema = z.object({
    provider: z.string().trim().min(1),
    field: z.enum(ASSERTION_FIELDS),
    value: z.string().max(4000).optional().default(""),
    evidenceClass: z.enum(EVIDENCE_CLASSES).optional(),
    source: z.enum(ASSERTION_SOURCES).optional(),
    notes: z.string().max(4000).optional(),
  });

  app.post("/api/assurance/provider-assertions", requireAdmin, asyncHandler(async (req, res) => {
    const input = assertionCreateSchema.parse(req.body);
    let result;
    try {
      result = await assurance.createProviderAssertion(input);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) return void res.status(result.status).json({ error: result.detail });
    await storage.createActivityLog({
      action: "created",
      entityType: "assurance_provider_assertion",
      entityId: result.value.uuid,
      details: { provider: input.provider, field: result.value.field, evidenceClass: result.value.evidenceClass },
      ...actor(req),
    });
    res.status(201).json(result.value);
  }));

  const assertionPatchSchema = z
    .object({
      value: z.string().max(4000).optional(),
      evidenceClass: z.enum(EVIDENCE_CLASSES).optional(),
      source: z.enum(ASSERTION_SOURCES).optional(),
      notes: z.string().max(4000).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: "name at least one field to change" });

  app.patch("/api/assurance/provider-assertions/:uuid", requireAdmin, asyncHandler(async (req, res) => {
    const patch = assertionPatchSchema.parse(req.body);
    let result;
    try {
      result = await assurance.updateProviderAssertion(req.params.uuid, patch);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) return void res.status(result.status).json({ error: result.detail });
    await storage.createActivityLog({
      action: "updated",
      entityType: "assurance_provider_assertion",
      entityId: req.params.uuid,
      details: { field: result.value.field, evidenceClass: result.value.evidenceClass },
      ...actor(req),
    });
    res.json(result.value);
  }));

  app.delete("/api/assurance/provider-assertions/:uuid", requireAdmin, asyncHandler(async (req, res) => {
    let result;
    try {
      result = await assurance.deleteProviderAssertion(req.params.uuid);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) return void res.status(result.status).json({ error: result.detail });
    await storage.createActivityLog({
      action: "deleted",
      entityType: "assurance_provider_assertion",
      entityId: req.params.uuid,
      details: {},
      ...actor(req),
    });
    res.status(204).end();
  }));

  // ==== CONTINUOUS ASSURANCE LOOP (SPINE Phases 1–3) ====
  //
  // The system of record's continuous-assurance capabilities, surfaced end-to-
  // end: the assurance claims register and its lifecycle, declared-vs-observed
  // BOM drift and the declared-architecture baseline it compares against, the
  // decision-support and revalidation views, the retest-obligation register,
  // the invalidation engine, the operational-risk register, per-finding incident
  // packs, and the outbound connectors. Reads stay open to any signed-in operator
  // (behind the `/api` requireAuth guard above); every write is admin-only here
  // and on the control plane, so a non-admin gets a clean 403 at the front door.
  // A backend refusal (a 400/403/404/409 that carries meaning — an illegal claim
  // transition, an unknown connector, a validation error) is returned verbatim so
  // the operator sees why, rather than a bare 503.

  // The assurance claims register (SPINE): the version-bound, falsifiable claims
  // derived from the assessments, each at its honest status and weakest-evidence
  // strength. A read, behind requireAuth like the rest of the assurance reads.
  app.get("/api/assurance/claims", asyncHandler(async (req, res) => {
    try {
      res.json(
        await assurance.listClaims({
          deployment: qp(req, "deployment"),
          claimType: qp(req, "claimType"),
          status: qp(req, "status"),
          all: qp(req, "all"),
        }),
      );
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // One claim's attributed lifecycle history (SPINE): every status change, who
  // made it, from where to where, and why. A read, behind requireAuth.
  app.get("/api/assurance/claims/:uuid/events", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.claimEvents(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // A deployment's CURRENT assurance claims (SPINE Phase 1): only the current
  // version of each claim. A read, behind requireAuth like the rest.
  app.get("/api/assurance/deployments/:uuid/assurance-claims", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.deploymentClaims(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // A deployment's declared-vs-observed AI-BOM drift (SPINE Stage 3): the shadow
  // components/providers and the declared components no longer observed. Without a
  // declared baseline there is no drift to compute, and that is surfaced rather
  // than read as a clean bill of materials. A read, behind requireAuth.
  // The Coverage Manifest: what was assessed and what was not, on both axes --
  // breadth over the inventory (expected/observed/assessed) and depth over the
  // question set (which checks the latest scan ran). Neither implies the other,
  // and an absent check axis reaches the client as `reported: false` rather than
  // as a complete one. A read, behind requireAuth.
  app.get("/api/assurance/deployments/:uuid/coverage-manifest", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.coverageManifest(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  app.get("/api/assurance/deployments/:uuid/bom-drift", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.bomDrift(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // A deployment's declared architecture plus its live drift (SPINE Stage 3): the
  // admin-editable baseline BOM drift compares against. A read, behind requireAuth.
  app.get("/api/assurance/deployments/:uuid/declared-architecture", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.declaredArchitecture(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // A deployment's six-state decision WITH why (SPINE Stage 1C): the finding-based
  // signal, the claim cap, and exactly which current claims support or undermine
  // it. A READY decision stands only while its supporting claims stay current; an
  // unassessed deployment reads null, never ready. A read, behind requireAuth.
  app.get("/api/assurance/deployments/:uuid/decision-support", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.decisionSupport(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // A deployment's minimal revalidation plan (SPINE Stage 1D): what a change
  // invalidated and must re-run, and everything that stays current and need not
  // be re-run. A read, behind requireAuth like the rest of the assurance reads.
  app.get("/api/assurance/deployments/:uuid/revalidation-plan", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.revalidationPlan(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // The retest-obligation register (SPINE Phase 2): the durable, attributed
  // obligations to re-test a claim whose bound system state changed. Defaults to
  // open; `all=true`/`status=` widen it. A read, behind requireAuth.
  app.get("/api/assurance/retest-requirements", asyncHandler(async (req, res) => {
    try {
      res.json(
        await assurance.listRetestRequirements({
          deployment: qp(req, "deployment"),
          claim: qp(req, "claim"),
          status: qp(req, "status"),
          all: qp(req, "all"),
        }),
      );
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // A deployment's retest obligations (SPINE Phase 2). Defaults to open; `all=true`
  // includes the resolved history. A read, behind requireAuth like the rest.
  app.get("/api/assurance/deployments/:uuid/retest-requirements", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.deploymentRetestRequirements(req.params.uuid, qp(req, "all") === "true"));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // A deployment's narrow operational-risk register (Phase 3.9): the four
  // operational-risk classes, each an ordinal band with a real basis or honestly
  // `unmapped` (risk null, never a fabricated 0). Distinct from operational-
  // ASSURANCE above. A read, behind requireAuth like the rest.
  app.get("/api/assurance/deployments/:uuid/operational-risk", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.operationalRisk(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // A finding's AI Incident Evidence Pack (Phase 3.7): a portable, verifiable pack
  // reconstructed from the stored graph. It attests integrity and provenance,
  // never that the incident conclusion is true or the system fixed. A read,
  // behind requireAuth like the rest of the assurance reads.
  app.get("/api/assurance/findings/:uuid/incident-pack", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.incidentPack(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // A deployment's outbound connectors and whether each is configured (commercial
  // spine). A read, behind requireAuth. It triggers nothing — a connector with no
  // credentials reads as not configured, never as a live integration.
  app.get("/api/assurance/deployments/:uuid/connectors", asyncHandler(async (req, res) => {
    try {
      res.json(await assurance.connectors(req.params.uuid));
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // ---- Continuous-assurance writes (admin-only; the control plane is the gate too) ----

  const claimTransitionSchema = z.object({
    // The backend validates the target against AssuranceClaim.ClaimStatus and the
    // legal-move / evidence-gate rules; the BFF requires a non-empty string and
    // lets the backend's 400 carry the exact reason.
    toStatus: z.string().trim().min(1).max(40),
    note: z.string().max(2000).optional(),
  });

  // Move a claim along its lifecycle (SPINE). Admin-only: it mutates the shared
  // record. A backend refusal (unknown status, illegal jump, verify without
  // verified evidence — all 400s) is returned verbatim so the operator sees why.
  app.post("/api/assurance/claims/:uuid/transition", requireAdmin, asyncHandler(async (req, res) => {
    const data = claimTransitionSchema.parse(req.body ?? {});
    let result;
    try {
      result = await assurance.transitionClaim(req.params.uuid, data.toStatus, data.note);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) return void res.status(result.status).json({ error: result.detail });
    await storage.createActivityLog({
      action: "claim_transitioned",
      entityType: "assurance_claim",
      entityId: req.params.uuid,
      details: { status: result.value.status },
      ...actor(req),
    });
    res.json(result.value);
  }));

  // Re-derive a deployment's assurance claims from its current state (SPINE Phase
  // 1). Admin-only: it mutates the shared record. Idempotent and transactional.
  app.post("/api/assurance/deployments/:uuid/recompute-claims", requireAdmin, asyncHandler(async (req, res) => {
    let result;
    try {
      result = await assurance.recomputeClaims(req.params.uuid);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) return void res.status(result.status).json({ error: result.detail });
    await storage.createActivityLog({
      action: "claims_recomputed",
      entityType: "assurance_deployment",
      entityId: req.params.uuid,
      details: { ...result.value },
      ...actor(req),
    });
    res.json(result.value);
  }));

  // Turn a deployment's current BOM drift into managed findings (SPINE Stage 3).
  // Admin-only: it mutates the shared record. Idempotent and non-destructive.
  app.post("/api/assurance/deployments/:uuid/record-bom-drift", requireAdmin, asyncHandler(async (req, res) => {
    let result;
    try {
      result = await assurance.recordBomDrift(req.params.uuid);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) return void res.status(result.status).json({ error: result.detail });
    await storage.createActivityLog({
      action: "bom_drift_recorded",
      entityType: "assurance_deployment",
      entityId: req.params.uuid,
      details: { ...result.value },
      ...actor(req),
    });
    res.json(result.value);
  }));

  const declaredComponentSchema = z.object({
    // Mirrors DeclaredComponent.Kind on the backend; kept in lockstep so the
    // console never offers a kind the backend will reject.
    kind: z.enum([
      "model",
      "gateway",
      "tool",
      "skill",
      "api",
      "mcp_server",
      "vector_db",
      "data_store",
      "service_account",
      "agent",
      "other",
    ]),
    name: z.string().trim().min(1).max(200),
    identifier: z.string().max(500).optional(),
    providerName: z.string().max(200).optional(),
    note: z.string().max(2000).optional(),
  });
  const declaredArchitectureSchema = z.object({
    components: z.array(declaredComponentSchema).max(500),
  });

  // Replace a deployment's declared architecture (SPINE Stage 3). Admin-only: it
  // is the human-declared baseline BOM drift compares against. Mirrors the data-
  // boundary editor. A backend validation refusal is returned verbatim.
  app.put("/api/assurance/deployments/:uuid/declared-architecture", requireAdmin, asyncHandler(async (req, res) => {
    const data = declaredArchitectureSchema.parse(req.body ?? {});
    let result;
    try {
      result = await assurance.setDeclaredArchitecture(req.params.uuid, data.components);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) return void res.status(result.status).json({ error: result.detail });
    await storage.createActivityLog({
      action: "declared",
      entityType: "assurance_declared_architecture",
      entityId: req.params.uuid,
      details: { declaredCount: result.value.declared.length, driftDetected: result.value.drift.driftDetected },
      ...actor(req),
    });
    res.json(result.value);
  }));

  // Run the invalidation engine over a deployment (SPINE Phase 2). Admin-only: it
  // opens/resolves obligations and marks drifted claims stale. Idempotent.
  app.post("/api/assurance/deployments/:uuid/check-invalidations", requireAdmin, asyncHandler(async (req, res) => {
    let result;
    try {
      result = await assurance.checkInvalidations(req.params.uuid);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) return void res.status(result.status).json({ error: result.detail });
    await storage.createActivityLog({
      action: "invalidations_checked",
      entityType: "assurance_deployment",
      entityId: req.params.uuid,
      details: { ...result.value },
      ...actor(req),
    });
    res.json(result.value);
  }));

  const connectorPushSchema = z.object({
    // The connector name is in the path; the finding to push is the body. The
    // backend validates the finding belongs to the deployment (404 otherwise).
    finding: z.string().trim().min(1),
  });

  // Push one of a deployment's findings out to an external system (commercial
  // spine). Admin-only: it is an outbound action against a customer's live GRC /
  // CI-CD / SIEM. Always HTTP 200 on a reached connector — read `ok`; an
  // unconfigured connector is inert (`ok:false`, no network call). A backend
  // refusal (unknown connector, finding not in this deployment) is returned
  // verbatim so the operator sees why.
  app.post(
    "/api/assurance/deployments/:uuid/connectors/:connector/push",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const data = connectorPushSchema.parse(req.body ?? {});
      let result;
      try {
        result = await assurance.pushConnector(req.params.uuid, req.params.connector, data.finding);
      } catch (cause) {
        if (assuranceUnavailable(res, cause)) return;
        throw cause;
      }
      if (!result.ok) return void res.status(result.status).json({ error: result.detail });
      await storage.createActivityLog({
        action: "connector_pushed",
        entityType: "assurance_deployment",
        entityId: req.params.uuid,
        details: { connector: req.params.connector, finding: data.finding, ok: result.value.ok },
        ...actor(req),
      });
      res.json(result.value);
    }),
  );

  // ==== FINDING LIFECYCLE ====
  //
  // A finding as a thing with a life: an identity that survives a rescan, an
  // owner, and a status. The rule that matters is what a person may set.
  // `fixed` is not on that list. It is a claim about the customer's system and
  // only a retest the engine answered `closed` may make it -- the route below
  // refuses it, and the retest route writes it along with the run that earned
  // it. A human may accept a risk or say they have looked at something; those
  // are opinions, stored under their name as opinions.

  // The estate's findings counted once, for the Overview and the Deployments
  // pipeline: open counts by severity, by site environment and per client,
  // new findings by month, and the worst open ones. One request instead of one
  // per client (each of which also loaded every finding's history). Every
  // client's findings, or an error: a total over the clients that happened to
  // read cleanly would be wrong and look right. See server/findings-summary.ts.
  //
  // A read that failed and a count that failed are different faults with
  // different fixes, so they are answered with different sentences: the first
  // sends an operator to storage, the second to this code. Neither carries a
  // total, and neither leaks the underlying error's text.
  app.get("/api/findings/summary", asyncHandler(async (_req, res) => {
    let summary;
    try {
      summary = await loadFindingsSummary(storage);
    } catch (cause) {
      if (cause instanceof SummaryReadError) {
        console.error("[findings] summary: could not read every engagement's findings:", cause.reason);
        return void res.status(500).json({
          message: "Could not read every engagement's findings, so no totals are given.",
        });
      }
      console.error("[findings] summary: read every engagement's findings but could not count them:", cause);
      return void res.status(500).json({
        message: "Every engagement's findings were read, but counting them failed, so no totals are given.",
      });
    }
    res.json(summary);
  }));

  app.get("/api/findings", asyncHandler(async (req, res) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : null;
    if (!clientId) {
      return void res.status(400).json({ error: "name the engagement: ?clientId=" });
    }
    const client = await storage.getClient(clientId);
    if (!client) return notFound(res, "Client");

    const status = typeof req.query.status === "string" ? req.query.status : null;
    const rows = (await storage.getFindingsByClient(clientId))
      .filter((one) => (status ? one.status === status : true))
      .sort((a, b) => Number(b.lastSeenAt) - Number(a.lastSeenAt));

    // Owners as names, so the page does not have to hold a user table to
    // render "who has this".
    const users = await storage.getAllUsers();
    const nameOf = new Map(users.map((one) => [one.id, one.username]));

    // Each finding's own history: what every run observed, and every retest
    // that has ever been run against it. This is what makes a second
    // engagement weeks later answer "is what you found last time gone?" --
    // from a record of observations rather than a status field whose past was
    // overwritten each time it changed.
    const withHistory = await Promise.all(rows.map(async (one) => ({
      ...one,
      ownerName: one.ownerId ? nameOf.get(one.ownerId) ?? null : null,
      sightings: (await storage.getSightings(one.id))
        .sort((a, b) => Number(a.observedAt) - Number(b.observedAt)),
      checks: (await storage.getChecks(one.id))
        .sort((a, b) => Number(a.checkedAt) - Number(b.checkedAt)),
    })));

    res.json({
      findings: withHistory,
      counts: {
        open: rows.filter((one) => one.status === "open").length,
        acknowledged: rows.filter((one) => one.status === "acknowledged").length,
        accepted: rows.filter((one) => one.status === "accepted").length,
        fixed: rows.filter((one) => one.status === "fixed").length,
      },
    });
  }));

  const findingPatchSchema = z.object({
    // `fixed` is deliberately absent. A caller who sends it gets the sentence
    // below rather than a silent rejection, because the reason is the point.
    status: z.enum(SETTABLE_FINDING_STATUS).optional(),
    ownerId: z.string().nullable().optional(),
    note: z.string().trim().max(1000).optional(),
  });

  app.patch("/api/findings/:id", asyncHandler(async (req, res) => {
    if (req.body?.status === "fixed") {
      return void res.status(400).json({
        error:
          "a finding cannot be marked fixed by hand. Fixed means the engine went " +
          "back to the target and did not find it: run a retest, and if it comes " +
          "back closed the finding is closed with the run that proved it. If the " +
          "risk is being carried rather than removed, mark it accepted.",
      });
    }
    const data = findingPatchSchema.parse(req.body);

    const finding = await storage.getFinding(req.params.id);
    if (!finding) return notFound(res, "Finding");

    if (data.ownerId) {
      const owner = await storage.getUser(data.ownerId);
      if (!owner) return void res.status(400).json({ error: "no such user to own it" });
    }

    const updated = await storage.updateFinding(finding.id, {
      ...(data.status ? { status: data.status } : {}),
      ...(data.ownerId !== undefined ? { ownerId: data.ownerId } : {}),
      ...(data.note !== undefined ? { statusNote: data.note } : {}),
      ...(data.status || data.note !== undefined
        ? { statusChangedBy: req.session.userId ?? null, statusChangedAt: new Date() }
        : {}),
      // Whatever a person does here, the evidence columns are theirs to read
      // and nobody's to write.
    });

    await storage.createActivityLog({
      action: "updated", entityType: "finding", entityId: finding.id,
      details: {
        status: data.status ?? finding.status,
        ownerId: data.ownerId ?? finding.ownerId,
        note: data.note ?? null,
      },
      ...actor(req),
    });

    res.json(updated);
  }));

  // ==== COMPLIANCE ====
  //
  // "Compliance mapping" is the third of the six advertised deliverables, and
  // the one with the most room to mislead. The engine's scanners bear on 21 of
  // ASVS 4.0.3's 286 requirements. A screen that rendered 286 rows and left
  // 265 of them looking satisfied would tell a customer something false about
  // the great majority of the standard -- and convincingly, because the 21 are
  // real. So the four states are kept apart all the way to the page, and the
  // untested ones are counted out loud.

  app.get("/api/compliance/:clientId", asyncHandler(async (req, res) => {
    const client = await storage.getClient(req.params.clientId);
    if (!client) return notFound(res, "Client");

    const siteId = typeof req.query.siteId === "string" ? req.query.siteId : null;
    if (siteId) {
      const site = await storage.getSite(siteId);
      if (!site) return notFound(res, "Site");
      if (site.clientId !== client.id) {
        return void res.status(400).json({ error: "that site belongs to a different client" });
      }
    }

    const tests = (await storage.getTestsByClient(client.id))
      .filter((test) => (siteId ? test.siteId === siteId : true))
      // A row the installer wrote is not evidence about a customer's systems.
      // Counting sample findings towards a compliance verdict would be the
      // seeded-dashboard failure again, in the one place it matters most.
      .filter((test) => test.isSample !== true);

    const findings: ScanFinding[] = [];
    for (const test of tests) {
      const recorded = (test.findings ?? {}) as Record<string, unknown>;
      const results = Array.isArray(recorded.results) ? recorded.results : [];
      for (const one of results) {
        const finding = one as Record<string, unknown>;
        // Measured against a live engine: the scanner emits `header` at the
        // top level, and the pipeline moves a scanner's own fields into
        // `evidence` before the finding is returned. Reading only the top
        // level found nothing, so every missing-header finding was reported
        // as one the standard does not cover -- a wrong answer that looked
        // like a considered one. Both places are read; evidence wins.
        const evidence = (finding.evidence ?? {}) as Record<string, unknown>;
        const header = typeof evidence.header === "string"
          ? evidence.header
          : typeof finding.header === "string" ? finding.header : undefined;
        findings.push({
          testId: test.id,
          type: typeof finding.type === "string" ? finding.type : undefined,
          header,
          severity: typeof finding.severity === "string" ? finding.severity : undefined,
          message: typeof finding.message === "string" ? finding.message : undefined,
          internal: isEngineInternal(finding.internal),
        });
      }
    }

    // Null when the engine could not be asked, and null is not an empty list:
    // an engine that did not answer has not told us anything ran, so every
    // requirement a scanner could reach is reported as not run rather than
    // tested. Reading silence as a pass is the failure this screen is about.
    const scanners = await engine.loadedScanners();

    const { rows, summary } = controlMap(findings, scanners);
    res.json({
      client: { id: client.id, name: client.name },
      siteId,
      testsConsidered: tests.length,
      scannersLoaded: scanners,
      rows,
      summary,
    });
  }));

  app.get("/api/assistant/status", asyncHandler(async (_req, res) => {
    res.json(await assistant.status());
  }));

  app.post("/api/chat", asyncHandler(async (req, res) => {
    // `sender` is the server's to set, not the caller's. The browser used to
    // POST `sender: "ai"` with a string it had chosen itself, so the record
    // could not distinguish a message an assistant produced from one the page
    // made up -- which is exactly what it was doing. A caller may say what
    // they typed; who said it is decided here.
    const data = insertAIChatMessageSchema.parse({
      ...req.body, sender: "user", userId: req.session.userId,
    });
    const message = await storage.createChatMessage(data);
    await storage.createActivityLog({
      action: "created", entityType: "chat_message", entityId: message.id,
      details: null, ...actor(req),
    });

    // The reply is produced here, not in the browser.
    //
    // It used to be produced in the browser, by picking one of five strings
    // out of the page's own source and POSTing it back with `sender: "ai"`.
    // Anything a client can POST as an assistant message is a message the
    // record cannot vouch for, so the client no longer sends one at all --
    // and a client that tries is refused above, because `sender` is now the
    // server's to set on this path.
    if (!assistant.isConfigured()) {
      return void res.status(201).json({ message, reply: null });
    }

    const history = await storage.getChatMessagesByUser(req.session.userId!);
    let text: string;
    try {
      text = await assistant.reply(
        history.map((one) => ({
          role: one.sender === "ai" ? ("assistant" as const) : ("user" as const),
          content: one.message,
        })),
        await deploymentSummary(),
      );
    } catch (cause) {
      if (cause instanceof assistant.AssistantUnavailable) {
        // The operator's message is kept -- they typed it, it is theirs --
        // and the failure is reported instead of being papered over with a
        // sentence nothing produced.
        return void res.status(201).json({
          message, reply: null, error: cause.message,
        });
      }
      throw cause;
    }

    const answer = await storage.createChatMessage({
      userId: req.session.userId!, message: text, sender: "ai", attachments: null,
    });
    res.status(201).json({ message, reply: answer });
  }));

  app.delete("/api/chat/:id", asyncHandler(async (req, res) => {
    // GET scopes to the session's own messages; DELETE did not, so any
    // authenticated user could delete anyone else's chat history by id.
    const message = await storage.getChatMessage(req.params.id);
    if (!message || message.userId !== req.session.userId) return notFound(res, "Message");

    const success = await storage.deleteChatMessage(req.params.id);
    if (!success) return notFound(res, "Message");
    await storage.createActivityLog({
      action: "deleted", entityType: "chat_message", entityId: req.params.id,
      details: null, ...actor(req),
    });
    res.json({ success: true });
  }));

  // ==== CLASSIFIERS ====
  app.get("/api/classifiers", asyncHandler(async (_req, res) => {
    res.json(await storage.getAllClassifiers());
  }));

  app.get("/api/classifiers/:id", asyncHandler(async (req, res) => {
    const classifier = await storage.getClassifier(req.params.id);
    if (!classifier) return notFound(res, "Classifier");
    res.json(classifier);
  }));

  app.post("/api/classifiers", asyncHandler(async (req, res) => {
    const data = insertClassifierSchema.parse(req.body);
    const classifier = await storage.createClassifier(data);
    await storage.createActivityLog({
      action: "created", entityType: "classifier", entityId: classifier.id,
      details: { name: classifier.name, type: classifier.type }, ...actor(req),
    });
    res.status(201).json(classifier);
  }));

  app.patch("/api/classifiers/:id", asyncHandler(async (req, res) => {
    const data = updateClassifierSchema.parse(req.body);
    const classifier = await storage.updateClassifier(req.params.id, data);
    if (!classifier) return notFound(res, "Classifier");
    if (hasChanges(data)) {
      await storage.createActivityLog({ action: "updated", entityType: "classifier", entityId: classifier.id, details: null, ...actor(req) });
    }
    res.json(classifier);
  }));

  app.delete("/api/classifiers/:id", asyncHandler(async (req, res) => {
    const success = await storage.deleteClassifier(req.params.id);
    if (!success) return notFound(res, "Classifier");
    await storage.createActivityLog({ action: "deleted", entityType: "classifier", entityId: req.params.id, details: null, ...actor(req) });
    res.json({ success: true });
  }));

  // Unknown API paths must not fall through to the SPA catch-all. The literal
  // "/api/*" pattern missed "//api/clients" and "/api%2fclients"; widening it
  // by hand then still missed "/./api/clients", "/x/../api/clients" and
  // percent-encoded letters such as "/%61pi/clients". Normalising the path and
  // testing that covers the whole family rather than the spellings we thought
  // of. None of these ever reached a handler, but answering an API caller with
  // a page of HTML and a 200 is its own bug.
  app.all("*", (req, res, next) => {
    if (looksLikeApiPath(req.path)) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    next();
  });
}
