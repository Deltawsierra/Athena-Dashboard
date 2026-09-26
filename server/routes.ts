import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { storage } from "./storage-unified";
import { loadFindingsSummary, SummaryReadError } from "./findings-summary";
import { requireAuth, requireAdmin, asyncHandler, actor } from "./auth";
import * as assistant from "./assistant";
import * as settings from "./settings";
import * as engine from "./engine";
import * as failsafe from "./failsafe";
import * as assurance from "./assurance";
import { controlMap, type ScanFinding } from "./compliance";
import { AI_SYSTEMS, DEFAULT_ACTIVE_SYSTEMS, systemOfScan } from "@shared/ai-systems";
import { isEngineInternal } from "@shared/engine-internal";
import { engineRunIdOf, isEngineRecord } from "@shared/engine-record";
import { ratingOf } from "@shared/latest-scans";
import { deploymentSummary } from "./summary";
import * as lifecycle from "./findings";
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
  /** True only when the engine accepted the stop. */
  stopped: boolean;
  /** Why not, in the engine's or the network's words; empty when stopped. */
  detail: string;
}

/** A cause, as the sentence a page can show. */
function causeOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The run of a test whose engine run may still be running, or null. */
function unfinishedRunOf(test: { findings: unknown; status: string }): string | null {
  const runId = runIdOf(test);
  return runId !== null && !FINISHED_RUN_STATES.has(test.status) ? runId : null;
}

/**
 * Why a scan was not started at Max Concurrent Tests, and what can stop each
 * run counted against it. A run with a run id is stopped by its Stop, where
 * this app recorded it, or by the kill switch. A run with none is stopped by
 * neither -- no stop can name it -- only by a failsafe, which stops the engine
 * itself. "Stop one" was said over runs no Stop could reach.
 */
function concurrencyRefusal(
  { running, unnamed, limit, unlisted }: { running: number; unnamed: number; limit: number; unlisted: string | null },
): string {
  const named = running - unnamed;
  const counted = `${running} engine scan${running === 1 ? " is" : "s are"} ` +
    (unlisted === null
      ? "running"
      : `recorded as running (the engine's list of live runs could not be read: ${unlisted})`) +
    `, and Max Concurrent Tests on the AI Control page is ${limit}, so this scan was not started.`;
  const byStop = "with its Stop where this app recorded it, or with the kill switch on the AI Control page";
  const byFailsafe = "pause, stand down or terminate the engine from the Failsafe console";
  if (unnamed === 0) return `${counted} Stop one -- ${byStop} -- or raise the limit, to start another.`;
  const them = (n: number) => (n === 1 ? "it" : "them");
  const noId = (n: number) => `no run id, so no Stop and no kill switch can name ${them(n)}: to stop ` +
    `${n === 1 ? "it" : "one"}, ${byFailsafe}`;
  if (named === 0) {
    return `${counted} ${running === 1 ? "It has" : "They have"} ${noId(running)}. ` +
      "Or raise the limit, to start another.";
  }
  return `${counted} ${named} of them ${named === 1 ? "has" : "have"} a run id: stop ${named === 1 ? "it" : "one"} ${byStop}. ` +
    `${unnamed} ${unnamed === 1 ? "has" : "have"} ${noId(unnamed)}. Or raise the limit, to start another.`;
}

/**
 * Send one run the abort its own Stop sends, and record what came of it.
 *
 * A stop the engine refused or could not be reached for is reported as
 * exactly that, never folded into a success. The record is written after the
 * stop and may fail: a log write that failed does not unsend the stop or hide
 * its outcome.
 */
async function sendStop(
  req: Request,
  run: { runId: string; target: string | null; testId: string | null },
  via: "kill_switch" | "delete" | "start_not_recorded",
): Promise<{ stopped: boolean; detail: string }> {
  let outcome: { stopped: boolean; detail: string };
  try {
    const accepted = await engine.abort(run.runId);
    outcome = { stopped: accepted, detail: accepted ? "" : "the engine did not accept the stop; the scan may still be running" };
  } catch (cause) {
    outcome = { stopped: false, detail: causeOf(cause) };
  }
  try {
    await storage.createActivityLog({
      action: outcome.stopped ? "aborted" : "abort_failed",
      // Against its test when one records it; against the run when none does.
      entityType: run.testId !== null ? "test" : "engine_run",
      entityId: run.testId ?? run.runId,
      details: {
        runId: run.runId, via,
        ...(run.testId === null ? { target: run.target } : {}),
        ...(outcome.stopped ? {} : { detail: outcome.detail }),
      },
      ...actor(req),
    });
  } catch {
    // The stop was sent either way.
  }
  return outcome;
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
  detail: string;
}

/** The stops sent to the scans recorded here as running, or why they could not be listed. */
type RecordedStops = { listed: true; scans: ScanStop[] } | { listed: false; detail: string };
/**
 * The stops sent to the other runs the engine listed as live, or why its list
 * could not be read. `unnamed`, present only when there are any, counts the
 * live runs it listed with no run id: no stop can name them, so none was sent,
 * and they may still be running.
 */
type EngineSweep = { listed: true; runs: EngineRunStop[]; unnamed?: number } | { listed: false; detail: string };

type Settled<T> = { ok: true; value: T } | { ok: false; detail: string };
function settle<T>(pending: Promise<T>): Promise<Settled<T>> {
  return pending.then((value) => ({ ok: true as const, value }), (cause) => ({ ok: false as const, detail: causeOf(cause) }));
}

/**
 * Send a stop to everything that may still be running: every engine scan
 * recorded here as running, and every run the ENGINE lists as live by a run id.
 * A live run it lists with none is counted and said, since no stop can name it.
 *
 * Engaging the kill switch used to store a flag and nothing else; then it
 * stopped the scans this app had rows for -- and only those. A run whose row
 * was deleted, or never written, was scanning the customer's system with
 * nothing here able to see it, and the page said no scan was running. So the
 * engine's own list is read too, and each run on it that no running row
 * covers is sent the same stop. The two reads start together and neither
 * waits on the other: the rows' stops go as soon as the rows are read, and a
 * list that could not be read holds back no stop from the other. Each outcome
 * is reported, and one that could not be listed is said to be exactly that.
 */
async function stopEverythingRunning(req: Request): Promise<{ stops: RecordedStops; engineRuns: EngineSweep }> {
  const rowsRead = settle(storage.getAllTests());
  const engineRead = settle(engine.activeRuns());

  const rows = await rowsRead;
  const running = rows.ok
    ? rows.value
      .map((test) => ({ test, runId: unfinishedRunOf(test) }))
      .filter((one): one is { test: (typeof one)["test"]; runId: string } => one.runId !== null)
    : [];
  const scansStopped = Promise.all(running.map(({ test, runId }) => stopScan(req, test, runId, "kill_switch")));

  const listed = await engineRead;
  let engineRuns: EngineSweep;
  if (!listed.ok) {
    engineRuns = { listed: false, detail: listed.detail };
  } else {
    const covered = new Set(running.map((one) => one.runId));
    const recordedBy = new Map<string, string>();
    for (const test of rows.ok ? rows.value : []) {
      const runId = runIdOf(test);
      if (runId !== null) recordedBy.set(runId, test.id);
    }
    const named = listed.value.filter((run): run is engine.ActiveRun & { runId: string } => run.runId !== null);
    const unnamed = listed.value.length - named.length;
    engineRuns = {
      listed: true,
      runs: await Promise.all(named
        .filter((run) => !covered.has(run.runId))
        .map(async (run): Promise<EngineRunStop> => {
          const testId = recordedBy.get(run.runId) ?? null;
          return { runId: run.runId, target: run.target, testId, ...(await sendStop(req, { ...run, testId }, "kill_switch")) };
        })),
      ...(unnamed > 0 ? { unnamed } : {}),
    };
  }

  const stops: RecordedStops = rows.ok ? { listed: true, scans: await scansStopped } : { listed: false, detail: rows.detail };
  return { stops, engineRuns };
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
    const runId = unfinishedRunOf(test);
    return runId === null ? [] : [stopScan(req, test, runId, "delete")];
  }));
}

/** Refuse a delete while any of its runs could not be stopped: nothing is deleted, and the stops are reported. */
function refuseUnstoppedDelete(res: Response, what: string, stops: ScanStop[]): boolean {
  const failed = stops.filter((one) => !one.stopped);
  if (failed.length === 0) return false;
  const accepted = stops.length - failed.length;
  res.status(409).json({
    message:
      `Nothing was deleted. ${failed.map((one) => `Engine run ${one.runId}${one.target ? ` (${one.target})` : ""} ` +
        `may still be running and could not be stopped: ${one.detail}.`).join(" ")} ` +
      `Stop ${failed.length === 1 ? "it" : "them"} first -- the scan's Stop on the Tests screen, the kill switch, ` +
      `or a failsafe pause -- then delete ${what}.` +
      (accepted > 0 ? ` ${accepted} other run${accepted === 1 ? " was" : "s were"} stopped: the engine accepted the stop.` : ""),
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

/** The action of a failsafe command, or null when it cannot be read. */
async function failsafeActionOf(uuid: string): Promise<string | null> {
  try {
    const drafted = await failsafe.getCommand(uuid);
    return drafted ? drafted.command.action : null;
  } catch {
    return null;
  }
}

const KILL_SWITCH_REFUSAL =
  "The AI kill switch is engaged. Writes are disabled, except stops: a scan's Stop, and a failsafe " +
  "pause, stand-down or terminate, stay available.";

/**
 * Whether the engaged kill switch refuses this signature relay or withdrawal.
 *
 *   relay  -- a stop's signature is let through; a resume's or a release's
 *             is refused. When the settings or the command cannot be read
 *             the relay is let through: it might be a stop's, and the
 *             control plane and the engine check every signature.
 *   cancel -- withdrawing a resume or a release is let through (it keeps an
 *             engine stopped); withdrawing a stop is refused, and so is one
 *             whose command cannot be read.
 *
 * Called by the route's handler with req.params.uuid, the uuid Express
 * decoded and the handler relays. The middleware used to re-parse the path
 * and decode it itself, so what it looked up and what was relayed were two
 * readings of one string: an escaped character or a capitalised route
 * segment read differently in each was all it took to relay a resume's
 * signature past the switch. Now there is one reading.
 */
async function killSwitchRefusesCommand(res: Response, kind: "relay" | "cancel", uuid: string): Promise<boolean> {
  let settings;
  try {
    settings = await storage.getAIControlSettings();
  } catch (cause) {
    // A relay that may be a stop's is not refused because a read failed.
    if (kind === "relay") return false;
    throw cause;
  }
  if (!settings?.killSwitchEnabled) return false;
  const action = await failsafeActionOf(uuid);
  if (kind === "relay" && (action === null || !FAILSAFE_RECOVER_ACTIONS.has(action))) return false;
  if (kind === "cancel" && action !== null && FAILSAFE_RECOVER_ACTIONS.has(action)) return false;
  res.status(503).json({ message: KILL_SWITCH_REFUSAL, systemStatus: settings.systemStatus });
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

  (async () => {
    const settings = await storage.getAIControlSettings();
    if (!settings?.killSwitchEnabled) return void next();
    res.status(503).json({ message: KILL_SWITCH_REFUSAL, systemStatus: settings.systemStatus });
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

export function registerRoutes(app: Express): void {
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
      // each attempt still paid for a synchronous key derivation.
      if (loginBlocked(key, now) || loginBlocked(byAddress, now, LOGIN_MAX_FAILURES_PER_ADDRESS)) {
        res.status(429).json({ message: "Too many failed sign-in attempts. Try again later." });
        return;
      }

      const user = await storage.validateUser(parsed.data.username, parsed.data.password);
      if (!user || !user.isActive) {
        recordLoginFailure(key, now);
        recordLoginFailure(byAddress, now);
        res.status(401).json({ message: "Invalid username or password" });
        return;
      }

      loginFailures.delete(key);
      loginFailures.delete(byAddress);
      await regenerateSession(req);
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;

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

    let success: boolean;
    try {
      success = await storage.deleteClient(req.params.id);
    } catch (cause) {
      if (stops.length === 0) throw cause;
      // The stops were accepted; that is not to be reported as a failure.
      return void res.status(500).json({
        message: `Every running scan of this client was stopped (the engine accepted each stop), but the client ` +
          `could not be deleted: ${causeOf(cause)}`,
        stops,
      });
    }
    if (!success) return notFound(res, "Client");

    try {
      await storage.createActivityLog({
        action: "deleted", entityType: "client", entityId: req.params.id,
        details: { cascaded, ...(stops.length > 0 ? { stopped: stops.map((one) => one.runId) } : {}) }, ...actor(req),
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

    let success: boolean;
    try {
      success = await storage.deleteTest(req.params.id);
    } catch (cause) {
      if (stops.length === 0) throw cause;
      return void res.status(500).json({
        message: `Engine run ${stops[0].runId} was stopped (the engine accepted the stop), but the test could not ` +
          `be deleted: ${causeOf(cause)}`,
        stops,
      });
    }
    if (!success) return notFound(res, "Test");
    try {
      await storage.createActivityLog({
        action: "deleted", entityType: "test", entityId: req.params.id,
        details: stops.length > 0 ? { stopped: stops.map((one) => one.runId) } : null, ...actor(req),
      });
    } catch (cause) {
      if (stops.length === 0) throw cause;
    }
    res.json(stops.length > 0 ? { success: true, stops } : { success: true });
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
    try {
      const live = await engine.activeRuns();
      running = live.length;
      unnamed = live.filter((run) => run.runId === null).length;
    } catch (cause) {
      if (!(cause instanceof engine.EngineUnavailable)) throw cause;
      unlisted = cause.message;
      const recorded = (await storage.getAllTests())
        .filter((test) => !FINISHED_RUN_STATES.has(test.status) && isEngineRecord(test.findings));
      running = recorded.length;
      unnamed = recorded.filter((test) => unfinishedRunOf(test) === null).length;
    }
    if (running >= limit) {
      return void res.status(409).json({
        error: concurrencyRefusal({ running, unnamed, limit, unlisted }),
        reason: "concurrency_limit",
        running,
        unnamed,
        counted: unlisted === null ? "engine" : "recorded",
        limit,
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

    // A run the engine finished inline has its results now, and its row is
    // written as finished: counted from what came back and dated. It used to
    // be written with zero counts and no completion time, and the status
    // route never revisits a completed row -- so a scan that returned a
    // critical read as "0 reported" on every screen that reads the test.
    const completedInline = started.state === "completed";
    let test;
    try {
      test = await storage.createTest({
        clientId: data.clientId,
        siteId: data.siteId ?? null,
        testType: data.testType,
        status: completedInline ? "completed" : "running",
        completedAt: completedInline ? new Date() : null,
        summary: `${data.target} — engine run ${started.runId ?? "unknown"}`,
        findings: { runId: started.runId, target: data.target, results: started.findings },
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
      if (!started.runId || completedInline) throw cause;
      const stop = await sendStop(req, { runId: started.runId, target: data.target, testId: null }, "start_not_recorded");
      return void res.status(500).json({
        error: `the engine started run ${started.runId} but it could not be recorded here (${causeOf(cause)}); ` +
          (stop.stopped
            ? "the run was sent a stop, and the engine accepted it"
            : `the run was sent a stop and it did not take (${stop.detail}): it may still be running -- ` +
              "stop it with the kill switch or a failsafe pause"),
        runId: started.runId,
        stopped: stop.stopped,
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
        details: { target: data.target, engagementRef, runId: started.runId, filed },
        ...actor(req),
      });
    } catch {
      // The run started and its row exists; the page needs its test id more than the log line.
    }

    res.status(201).json({
      test, runId: started.runId, state: started.state, filed,
      ...(notFiled !== null ? { detail: `the run's results could not be filed as findings: ${notFiled}` } : {}),
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
    const test = await storage.getTest(req.params.testId);
    if (!test) return notFound(res, "Test");

    const runId = runIdOf(test);
    if (!runId && isEngineRecord(test.findings)) {
      // An engine scan the engine accepted without a run id: a stop has nothing
      // to name it by. It is not "no engine run". It is pointed at the kill
      // switch, which stops every run the engine lists by a run id, and at the
      // failsafes, which stop the engine whatever it lists.
      return void res.status(409).json({ error: NO_RUN_ID_TO_STOP });
    }
    if (!runId) {
      return void res.status(409).json({
        error: "this test has no engine run recorded against it, so there is nothing to stop",
      });
    }

    let stopped: boolean;
    try {
      stopped = await engine.abort(runId);
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }

    // The engine's answer, not an assumption. Recording "aborted" on a stop
    // the engine did not accept would be the record saying a scan halted when
    // it is still running against somebody's system.
    if (!stopped) {
      return void res.status(502).json({
        error: "the engine did not accept the stop; the scan may still be running",
      });
    }

    // After the stop, and best-effort: a log write that failed (a full disk)
    // turned a stop the engine had accepted into "Internal server error".
    try {
      await storage.createActivityLog({
        action: "aborted", entityType: "test", entityId: test.id,
        details: { runId }, ...actor(req),
      });
    } catch (cause) {
      console.error(`[abort] run ${runId} was stopped; its activity log could not be written: ${causeOf(cause)}`);
    }

    res.json({ stopped: true, runId });
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
      // has no engine run.
      return void res.json({ test, state: test.status, engine: null, detail: NO_RUN_ID_TO_ASK });
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

    let result;
    try {
      result = await engine.retest({ twinId: data.twinId, engagementRef, scope });
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }

    // Carry the verdict into the finding it is about.
    //
    // The finding is identified from the twin's own recorded place, fetched
    // from the engine -- not from anything the caller sent. A caller who could
    // name the finding to mark fixed could mark any finding fixed, which is
    // the one thing this lifecycle exists to prevent.
    let applied: { findingId: string; status: string; detail: string } | null = null;
    const runId = runIdOf(test);
    if (runId) {
      try {
        const listed = await engine.listDecisions(runId);
        const twin = listed.decisions.find((one) => one.id === data.twinId);
        if (twin) {
          const key = lifecycle.fingerprint(client.id, {
            type: twin.findingType,
            severity: null, message: null,
            target: twin.target,
            endpoint: twin.endpoint,
            header: null,
          });
          const finding = await storage.findFindingByFingerprint(client.id, key);
          if (finding) {
            const decided = lifecycle.statusFromVerdict(result.verdict, finding.status);
            await storage.updateFinding(finding.id, {
              status: decided.status,
              statusNote: decided.detail,
              statusChangedBy: req.session.userId ?? null,
              statusChangedAt: new Date(),
              // Only a `closed` verdict writes these, and they are what makes
              // the claim checkable afterwards.
              ...(decided.fixed
                ? { fixedAt: new Date(), fixedByRunId: result.runId, fixedVerdict: result.verdict }
                : { fixedAt: null, fixedByRunId: null, fixedVerdict: null }),
            });
            // Appended, never replaced. The answer given today does not erase
            // the answer given last month: a client asking whether March's
            // findings are gone is owed the sequence, not the last word.
            await storage.recordCheck({
              findingId: finding.id,
              verdict: result.verdict,
              detail: result.detail || decided.detail,
              runId: result.runId,
              inventoryDigest: result.inventoryDigest,
              checkedBy: req.session.userId ?? null,
            });
            applied = { findingId: finding.id, status: decided.status, detail: decided.detail };
          }
        }
      } catch (cause) {
        // The retest itself succeeded; failing to file it is worth saying but
        // is not worth throwing away the verdict the operator asked for.
        if (!(cause instanceof engine.EngineUnavailable)) throw cause;
      }
    }

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
      },
      ...actor(req),
    });

    res.json({ ...result, applied });
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
    const settings = await storage.getAIControlSettings();
    res.json(settings ?? (await storage.updateAIControlSettings({})));
  }));

  app.patch("/api/ai-control", requireAdmin, asyncHandler(async (req, res) => {
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
    // The flag first, so every other write is refused from here on; then the
    // stops (stopEverythingRunning). Sent again each time the switch is sent
    // on, so an operator can retry the scans that could not be reached.
    //
    // A flag that could not be stored holds back no stop. On a full disk (or
    // a read-only or locked database) the write failed and the handler
    // answered 500 before sending a single stop, although the engine was
    // reachable and the running scans could be read. Now the stops are sent
    // whatever the write did, and the answer carries both outcomes.
    let settings: Awaited<ReturnType<typeof storage.updateAIControlSettings>> | null = null;
    let notStored: string | null = null;
    try {
      settings = await storage.updateAIControlSettings({ ...data, lastModifiedBy: req.session.userId ?? null });
    } catch (cause) {
      if (data.killSwitchEnabled !== true) throw cause;
      notStored = causeOf(cause);
    }
    let stops: RecordedStops | null = null;
    let engineRuns: EngineSweep | null = null;
    if (data.killSwitchEnabled === true) {
      // Neither list failing is a 500: what the page must say is which list
      // could not be read -- not that nothing ran.
      ({ stops, engineRuns } = await stopEverythingRunning(req));
    }
    const logged = stops === null || engineRuns === null ? data : {
      ...data,
      ...noted,
      ...(notStored !== null ? { notStored } : {}),
      stops: stops.listed
        ? { sent: stops.scans.length, accepted: stops.scans.filter((one) => one.stopped).length }
        : { listed: false, detail: stops.detail },
      engineRuns: engineRuns.listed
        ? {
          sent: engineRuns.runs.length, accepted: engineRuns.runs.filter((one) => one.stopped).length,
          ...(engineRuns.unnamed !== undefined ? { unnamed: engineRuns.unnamed } : {}),
        }
        : { listed: false, detail: engineRuns.detail },
    };
    try {
      await storage.createActivityLog({
        action: "updated", entityType: "ai_control", entityId: settings?.id ?? "ai_control", details: logged, ...actor(req),
      });
    } catch (cause) {
      // Once stops were sent, their outcome reaches the page whatever the log did.
      if (stops === null) throw cause;
    }
    if (notStored !== null) {
      // Not engaged -- the flag is not stored, so writes are not refused -- and
      // the stops went out all the same: both are said.
      return void res.status(500).json({
        message: `The kill switch could not be engaged: ${notStored}. Every stop was sent all the same; ` +
          "what each came to is below. Writes are not refused until the switch is engaged.",
        engaged: false,
        stops,
        engineRuns,
        ...noted,
      });
    }
    res.json(stops === null ? settings : { ...settings, stops, engineRuns, ...noted });
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
    res.json({ fields: settings.readable() });
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

  app.post("/api/failsafe/commands/:uuid/signatures", requireAdmin, asyncHandler(async (req, res) => {
    if (await killSwitchRefusesCommand(res, "relay", req.params.uuid)) return;
    const data = submitSignatureSchema.parse(req.body);
    let result;
    try {
      result = await failsafe.submitSignature(req.params.uuid, data);
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) {
      // A rejected signature (bad key, forged, already signed) is the operator's
      // to see verbatim -- it is the whole point of relaying it here.
      return void res.status(result.status).json({ error: result.detail });
    }
    await recordFailsafeAct(req, "signed", req.params.uuid, {
      keyId: data.keyId, status: result.command.status, signers: result.command.signers,
    });
    res.json(result.command);
  }));

  app.post("/api/failsafe/commands/:uuid/cancel", requireAdmin, asyncHandler(async (req, res) => {
    if (await killSwitchRefusesCommand(res, "cancel", req.params.uuid)) return;
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
