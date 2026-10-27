/**
 * Adoption: the scans Athena-Backend lists for the person that this dashboard
 * has no row for -- started from another dashboard, from the backend's own
 * console, or by a launch whose answer was lost -- are given a row in `tests`,
 * so everything that already reads that table covers them as it covers a scan
 * started here: the Tests screen, RunningScans, the scan pages, the Overview,
 * each row's Stop and the kill switch (the Option 1 hybrid, owner decision 4;
 * plan section 6). The backend's record stays the record; the row here is the
 * pointer the screens and the Stop need.
 *
 * WHAT IS WRITTEN. For each listed scan no row names (shared/engine-record.ts
 * backendScanIdOf), one row: the run the RECORD names -- never one anybody here
 * supplies -- the record's target, `backendScanId` and `backendEngagementId`,
 * `source: "backend"` and when it was adopted (ADOPTION_KEYS); its status from
 * the record: `pending` reads "running" here until the engine's live word on
 * the next poll; completed, stopped and failed are the record's end, with the
 * run's results and coverage read from the detail (the same bytes the record
 * holds) and the record's snapshot (`findings.backend`), so the status route
 * answers such a row from the record and asks the engine nothing. The client is
 * the one whose `backendEngagementId` names the scan's engagement; none, and
 * the row has no client (`clientId` null: the screens say "not linked to a
 * dashboard client"). No client and no site is ever created; a site is linked
 * only when the client has one at the target's host.
 *
 * WHAT IS NOT. A pending scan the engine has not named a run for: a row with no
 * run id could be neither polled nor stopped from here, so it waits (the
 * Engagements page says "the launch's answer is still awaited"). A scan this
 * dashboard launched: its row exists. A finished scan whose detail could not be
 * read: next time, whole. Nothing is filed into this dashboard's own findings
 * ledger: a backend scan's record is the backend's (decision 1).
 *
 * THE BACKSTOP. A KNOWN row still unfinished here whose record the backend
 * lists as ended -- completed, stopped or failed -- has the record's detail
 * read and filed into it through the one path the collect watch files by
 * (AdoptionDeps.fileRecord), which writes the record's end as the row's status
 * (STATUS_HERE). Such a row is one whose run this dashboard's engine key could
 * never read (decision 7: every direct read answers 404, so no read here sees
 * the end), or whose collect watch ran past its deadline. A row a direct read
 * already ended keeps the engine's own word. Counted as `endedFromRecord`;
 * every other field of the outcome keeps its meaning.
 *
 * IDEMPOTENT. One row per backend scan: the rows are read first, and storage
 * refuses a second row naming a scan (DuplicateBackendScan: a unique index on
 * SQLite), so two dashboards, or two syncs at once, cannot adopt a scan twice.
 * One sync runs at a time per session, and a sync within
 * `adoption.minIntervalMs` of the last one for that session answers that one's
 * outcome (`throttled`) and reads nothing.
 *
 * SAFETY: a sync is reads of the backend and writes of rows, bounded by the
 * read deadline (the route runs it under runBoundedRead, which cancels the
 * backend reads with it) and never awaited by a stop, the kill switch, a
 * launch's answer or the abort route. A sync that fails changes nothing and is
 * answered "could not be read". No direct Stop is offered for an adopted
 * running row until a direct read of its run has succeeded (the row is adopted
 * marked `stop: "backend"`, PR-B's rule, owner decision 7): the first such read
 * is sent after the sync's answer and never awaited by it (firstDirectReads),
 * and the status route's own reads clear the mark too. The kill switch sends
 * every adopted run its stop by id regardless, as it does every run.
 */

import * as backendScans from "./backend-scans";
import { DuplicateBackendScan, type IStorage } from "./storage";
import type { BackendRecordSnapshot, Client, NewTest, Site, Test } from "@shared/schema";
import { backendScanIdOf, stoppedOnlyAtBackend } from "@shared/engine-record";

/** How often one session's sync reads the backend at most, and how many scans one sync adopts at most (the rest next time). Tests shorten these. */
export const adoption = { minIntervalMs: 15_000, perSync: 25 };

/** The record's status words that are a run's end; anything else is read as the engine's live word on the next poll. */
const FINISHED = new Set(["completed", "stopped", "failed"]);

/**
 * The record's status word as this dashboard's rows spell a run's state. The
 * one mapping: an adopted row's status is spelled from it, and so is the end a
 * record gives a known row (recordEnd: the collect watch, and the sync's
 * backstop). Never copied.
 */
export const STATUS_HERE: Record<string, string> = { pending: "running", unknown: "running", completed: "completed", stopped: "aborted", failed: "failed" };

/**
 * The end a backend record gives a row here: the record's status word as this
 * dashboard spells it (STATUS_HERE) and when the record was collected (`now`
 * when it gave no time this reads). Null while the record is not at an end
 * (pending, unknown): nothing is derived from it.
 */
export function recordEnd(record: { status: string; collectedAt: string | null }, now: Date): { status: string; completedAt: Date } | null {
  if (!FINISHED.has(record.status)) return null;
  return { status: STATUS_HERE[record.status], completedAt: dateOf(record.collectedAt) ?? now };
}

export interface AdoptionDeps {
  storage: IStorage;
  /** The severity counts of a run's results, as the scan route counts them (server/routes.ts countSeverities). */
  countSeverities(results: unknown[]): {
    vulnerabilitiesFound: number; criticalCount: number; highCount: number; mediumCount: number; lowCount: number; severity: string | null;
  };
  /** The snapshot a collected record leaves on a row (server/routes.ts snapshotOfRecord), with no direct poll to compare against. */
  snapshotOf(record: backendScans.BackendScanRecord): BackendRecordSnapshot;
  /** The host a recorded site's url names (server/routes.ts hostOf). */
  hostOf(url: string): string | null;
  /** One direct read of a run by this dashboard's engine key: "read" when it answered, "not_found" for its 404, "unread" for anything else. Never throws. */
  readRun(runId: string): Promise<"read" | "not_found" | "unread">;
  /** Whether a row's status here is a run's end (server/routes.ts FINISHED_RUN_STATES): such a row's status is never written over by a record. */
  finishedHere(status: string): boolean;
  /**
   * File a finished record into a known row (server/routes.ts fileRecordIntoRow,
   * the path the collect watch files by): its snapshot, results, coverage and
   * counts, and -- for a row not at an end here -- the record's end as its
   * status. The end it wrote; null when it wrote none (the row had ended here
   * meanwhile, or is gone).
   */
  fileRecord(testId: string, record: backendScans.BackendScanRecord): Promise<{ status: string; completedAt: Date } | null>;
  /** The audit log, best-effort: a line that could not be written changes nothing else. */
  log(entry: {
    action: "adopted_from_backend_record" | "ended_from_backend_record";
    testId: string; details: Record<string, unknown>; userId: string | null; ipAddress: string | null;
  }): Promise<void>;
}

export interface AdoptedRow {
  testId: string;
  backendScanId: string;
  /** The run as the screens read it; null when the record names none this dashboard reads. */
  engineRunId: string | null;
  status: string;
  clientId: string | null;
}

export interface AdoptionOutcome {
  /** When the backend's list was read (ISO 8601). */
  at: string;
  /** This answer is the last sync's, within adoption.minIntervalMs of it: nothing was read or written now. */
  throttled: boolean;
  /** How many scans the backend listed for the person. */
  listed: number;
  adopted: AdoptedRow[];
  /** Listed scans a row here already named (this dashboard's launches, earlier syncs, another dashboard's). */
  alreadyRecorded: number;
  /** Pending scans the engine has not named a run for: not adopted until it does. */
  awaitingRun: number;
  /** Adopted rows whose engagement no client here names. */
  unlinked: number;
  /** Candidates left for the next sync (adoption.perSync). */
  remaining: number;
  /** Finished scans whose detail could not be read now: adopted (or, a known row, ended: `endedFromRecord`) whole next time. */
  detailUnread: Array<{ backendScanId: string; reason: string }>;
  /** A row that could not be written stopped the sync here; the rows before it stand. Null when every row was written. */
  writeFailed: string | null;
  /**
   * Known rows still unfinished here whose record the backend lists as ended,
   * that this sync ended from the record's detail (the backstop; see the head
   * of this file). At most adoption.perSync a sync; the rest next time.
   */
  endedFromRecord: number;
}

function causeOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A stored time from the record, as a Date; null when the record gave none this reads. */
function dateOf(value: string | null): Date | null {
  if (value === null) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The row an adopted scan gets: the record's words and bytes, nothing else.
 * `record` is the detail (results, coverage) for a finished scan; null for one
 * still going, whose results the live poll reads.
 */
export function adoptedRowFor(
  row: backendScans.BackendScanRow,
  record: backendScans.BackendScanRecord | null,
  client: Pick<Client, "id"> | null,
  site: Pick<Site, "id"> | null,
  deps: Pick<AdoptionDeps, "countSeverities" | "snapshotOf">,
  now: Date,
): NewTest {
  const finished = FINISHED.has(row.status);
  // The id as a stop can address it (stopIdFrom), as the scan route records a run.
  const runId = row.stopId ?? row.engineRunId;
  const results = record === null ? null : backendScans.recordResults(record);
  const coverage = record === null ? null : backendScans.recordCoverage(record);
  const counts = finished && results !== null
    ? deps.countSeverities(results)
    : { severity: null, vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
  return {
    clientId: client?.id ?? null,
    siteId: site?.id ?? null,
    testType: "penetration_test",
    status: STATUS_HERE[row.status] ?? "running",
    completedAt: finished ? dateOf(row.collectedAt) ?? now : null,
    summary: `${row.targetUrl ?? "a target the record did not name"} — engine run ${runId ?? "unknown"} · adopted from the Athena-Backend record`,
    findings: {
      runId,
      target: row.targetUrl,
      // A finished run's results are the record's bytes; unread ones are said so by
      // the status route (null), never counted as none. A run still going has none yet.
      results: finished ? results : [],
      ...(coverage !== null ? { coverage } : {}),
      backendScanId: row.uuid,
      backendEngagementId: row.engagement?.id ?? null,
      ...(finished && record !== null ? { backend: deps.snapshotOf(record) } : {}),
      source: "backend",
      adoptedAt: now.toISOString(),
      // Decision 7: no direct Stop until a direct read of the run has succeeded.
      ...(finished ? {} : { stop: "backend" }),
    },
    ...counts,
    executedBy: null,
  };
}

const lastBy = new Map<string, { at: number; outcome: AdoptionOutcome }>();
const inFlight = new Map<string, Promise<AdoptionOutcome>>();

/**
 * Sync the person's backend scans into the rows here (see the head of this
 * file): the backend's list read whole, each listed scan no row names adopted.
 * `key` is the session the sync runs as (the backend lists what that person
 * may see); a sync within adoption.minIntervalMs of the last one for the key
 * answers that outcome, throttled; two at once for one key share one. Throws
 * what the backend's list read threw: nothing was changed, and the route says
 * "could not be read".
 */
export async function adoptBackendScans(
  deps: AdoptionDeps, key: string, who: { userId: string | null; ipAddress: string | null },
): Promise<AdoptionOutcome> {
  const recent = lastBy.get(key);
  if (recent && Date.now() - recent.at < adoption.minIntervalMs) return { ...recent.outcome, throttled: true };
  let running = inFlight.get(key);
  if (!running) {
    running = sync(deps, who).finally(() => { inFlight.delete(key); });
    inFlight.set(key, running);
  }
  const outcome = await running;
  lastBy.set(key, { at: Date.now(), outcome });
  return outcome;
}

async function sync(deps: AdoptionDeps, who: { userId: string | null; ipAddress: string | null }): Promise<AdoptionOutcome> {
  const now = new Date();
  // The backend's list first and whole: a read that fails changes nothing here.
  const rows = await backendScans.listScanRows();
  const [tests, clients, sites] = await Promise.all([deps.storage.getAllTests(), deps.storage.getAllClients(), deps.storage.getAllSites()]);
  const known = new Set(tests.map((one) => backendScanIdOf(one.findings)).filter((id): id is string => id !== null));
  const clientByEngagement = new Map(
    clients.filter((one) => one.backendEngagementId !== null).map((one) => [one.backendEngagementId as number, one]),
  );
  const outcome: AdoptionOutcome = {
    at: now.toISOString(), throttled: false, listed: rows.length, adopted: [], alreadyRecorded: 0, awaitingRun: 0, unlinked: 0,
    remaining: 0, detailUnread: [], writeFailed: null, endedFromRecord: 0,
  };
  const candidates: backendScans.BackendScanRow[] = [];
  for (const row of rows) {
    if (known.has(row.uuid)) {
      outcome.alreadyRecorded += 1;
      continue;
    }
    if (!FINISHED.has(row.status) && row.stopId === null) {
      outcome.awaitingRun += 1;
      continue;
    }
    candidates.push(row);
  }
  outcome.remaining = Math.max(0, candidates.length - adoption.perSync);
  for (const row of candidates.slice(0, adoption.perSync)) {
    let record: backendScans.BackendScanRecord | null = null;
    if (FINISHED.has(row.status)) {
      try {
        record = await backendScans.readScan(row.uuid);
      } catch (cause) {
        outcome.detailUnread.push({ backendScanId: row.uuid, reason: causeOf(cause) });
        continue;
      }
    }
    const engagementId = row.engagement?.id ?? null;
    const client = engagementId === null ? null : clientByEngagement.get(engagementId) ?? null;
    const host = row.targetUrl === null ? null : deps.hostOf(row.targetUrl);
    const site = client !== null && host !== null
      ? sites.find((one) => one.clientId === client.id && deps.hostOf(one.url) === host) ?? null
      : null;
    let test: Test;
    try {
      test = await deps.storage.createTest(adoptedRowFor(row, record, client, site, deps, now));
    } catch (cause) {
      if (cause instanceof DuplicateBackendScan) {
        // Another dashboard, or another sync, adopted it meanwhile: once is once.
        outcome.alreadyRecorded += 1;
        continue;
      }
      // A row that cannot be written now: the rows before it stand, the rest wait
      // for the next sync, and the answer says so.
      outcome.writeFailed = causeOf(cause);
      break;
    }
    known.add(row.uuid);
    if (client === null) outcome.unlinked += 1;
    outcome.adopted.push({ testId: test.id, backendScanId: row.uuid, engineRunId: row.engineRunId, status: test.status, clientId: test.clientId });
    await deps.log({
      action: "adopted_from_backend_record",
      testId: test.id,
      details: {
        backendScanId: row.uuid, backendEngagementId: engagementId, engineRunId: row.engineRunId, recordStatus: row.status,
        status: test.status, clientId: test.clientId, filedBy: "record_sync",
      },
      userId: who.userId,
      ipAddress: who.ipAddress,
    }).catch(() => undefined);
  }
  // Nothing more is written to a storage that just refused a row.
  if (outcome.writeFailed === null) await endKnownRowsFromRecord(deps, who, rows, tests, outcome, now);
  return outcome;
}

/**
 * The backstop (see the head of this file): each KNOWN row still unfinished
 * here whose record the backend's list says ended has the record's detail read
 * -- the record's bytes, never the list row's word alone -- and filed into it
 * by deps.fileRecord, which writes the record's end as the row's status. At
 * most adoption.perSync a sync, the rest next time. A detail that could not be
 * read is said (`detailUnread`) and left for the next sync; a detail that says
 * the run is not at an end after all writes nothing; a row that could not be
 * written stops this here (`writeFailed`).
 */
async function endKnownRowsFromRecord(
  deps: AdoptionDeps, who: { userId: string | null; ipAddress: string | null },
  rows: backendScans.BackendScanRow[], tests: Test[], outcome: AdoptionOutcome, now: Date,
): Promise<void> {
  const byScan = new Map<string, Test>();
  for (const test of tests) {
    const id = backendScanIdOf(test.findings);
    if (id !== null) byScan.set(id, test);
  }
  const ending = rows.flatMap((row) => {
    const test = byScan.get(row.uuid);
    return test !== undefined && FINISHED.has(row.status) && !deps.finishedHere(test.status) ? [{ row, test }] : [];
  });
  for (const { row, test } of ending.slice(0, adoption.perSync)) {
    let record: backendScans.BackendScanRecord;
    try {
      record = await backendScans.readScan(row.uuid);
    } catch (cause) {
      outcome.detailUnread.push({ backendScanId: row.uuid, reason: causeOf(cause) });
      continue;
    }
    if (recordEnd(record, now) === null) continue;
    let ended: { status: string; completedAt: Date } | null;
    try {
      ended = await deps.fileRecord(test.id, record);
    } catch (cause) {
      outcome.writeFailed = causeOf(cause);
      return;
    }
    if (ended === null) continue;
    outcome.endedFromRecord += 1;
    await deps.log({
      action: "ended_from_backend_record",
      testId: test.id,
      details: {
        backendScanId: row.uuid, backendEngagementId: row.engagement?.id ?? null, engineRunId: row.engineRunId,
        recordStatus: record.status, status: ended.status, statusBefore: test.status, filedBy: "record_sync",
      },
      userId: who.userId,
      ipAddress: who.ipAddress,
    }).catch(() => undefined);
  }
}

/**
 * The first direct read of each adopted RUNNING run, by this dashboard's engine
 * key (decision 7, PR-B's rule): a read that succeeds clears the row's
 * `stop: "backend"` mark, so its direct Stop is offered; a 404 (the key cannot
 * see the run) or a read that failed leaves the mark, and the status route's
 * own reads try again. Sent AFTER the sync's answer, never awaited by it; never
 * throws.
 */
export async function firstDirectReads(deps: AdoptionDeps, adopted: AdoptedRow[]): Promise<void> {
  await Promise.all(adopted
    .filter((one) => one.status === "running" && one.engineRunId !== null)
    .map(async (one) => {
      try {
        if ((await deps.readRun(one.engineRunId as string)) !== "read") return;
        const test = await deps.storage.getTest(one.testId);
        if (!test || !stoppedOnlyAtBackend(test.findings)) return;
        const { stop: _marked, ...unmarked } = test.findings as Record<string, unknown>;
        await deps.storage.updateTest(test.id, { findings: unmarked });
      } catch {
        // Left marked: the next read of the scan clears it when it succeeds.
      }
    }));
}

/** For tests that reuse one session across cases: forget every sync's outcome. */
export function _resetAdoptionForTests(): void {
  lastBy.clear();
  inFlight.clear();
}
