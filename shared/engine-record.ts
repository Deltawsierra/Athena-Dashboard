/**
 * Whether a test's record is an engine scan's, and the engine run it names.
 *
 * One rule, read by every part of the app that decides it: the status route
 * (`GET /api/scans/:testId`), the edit guard (`PATCH /api/tests/:id`), the
 * abort route's answer, the decisions and retest routes, the evidence pack, the
 * kill switch, the counts (shared/latest-scans.ts), the Tests screen and the
 * scans offered a Stop (client/src/lib/engineRuns.ts). They disagreed. The status route told a record holding a run's
 * results that it had "no engine run recorded against it" while the edit guard
 * refused its counts as an engine scan's, and the Tests screen offered those
 * same counts for editing, decided by the run id alone.
 *
 * A record is an engine scan's when its findings carry a run id, the target the
 * scan route recorded, or the run's results. Only `POST /api/scans` writes a
 * `target` or `results` (a person's test that sends either is refused), so a run
 * the engine finished or accepted without a run id is an engine scan all the
 * same. A key recorded as null is none.
 *
 * A run id is read the same way wherever the engine sends one (server/engine.ts)
 * and wherever a record holds one: text as sent, and a whole number as its
 * digits. An engine that sent `run_id: 42` was recorded as the number 42, and
 * then told it had no run id: its own Stop sent nothing, the kill switch's list
 * dropped it, and the Tests screen offered no Stop for it.
 */

/** The findings object of a record, or null when it has none. */
function recordOf(findings: unknown): Record<string, unknown> | null {
  return findings && typeof findings === "object" && !Array.isArray(findings)
    ? (findings as Record<string, unknown>)
    : null;
}

/**
 * A run id as the engine sent it, or as a record holds it: a string a stop can
 * address as it is, a whole number (a safe integer) as its digits, and anything
 * else -- a boolean, NaN, a fraction, an object -- null, which names no run.
 *
 * A string names a run only when a stop can reach exactly that run by it, as
 * one segment of `/api/scans/{run_id}/abort`. So these name none, and a scan
 * the engine started with one is a scan no Stop can reach (a breach of the
 * engine's contract, which since athena-engine #71 requires a path-safe uuid):
 * - one that is blank after trimming ("", " ", "\t");
 * - "." and "..", which the URL resolves away: a stop for ".." was sent to
 *   `POST /api/abort`, and one for "." to `POST /api/scans/abort`;
 * - one with a "/" or a "\", which the engine's router splits or refuses:
 *   "a/b" was sent to `/api/scans/a%2Fb/abort` and answered 404.
 * Every other string is kept verbatim, space included, and a stop sends it
 * percent-encoded (server/engine.ts).
 *
 * This is what the screens offer a Stop for. The kill switch sends more: see
 * stopIdFrom.
 */
export function runIdFrom(value: unknown): string | null {
  const id = stopIdFrom(value);
  return id !== null && id.trim() !== "" ? id : null;
}

/**
 * The id the kill switch sends a stop by: every id a stop can address exactly,
 * as one path segment -- runIdFrom's, and a non-empty id that is blank after
 * trimming too (" ", "\t"). Such an id is no run id to the screens (they show
 * what stops the scan in place of a Stop), but a stop sent by it reaches the
 * engine's route with the exact id, and the kill switch never sends fewer stops
 * than it can. "", "." and "..", and an id with a "/" or a "\", get none: a
 * stop by them would reach a different route, or none.
 */
export function stopIdFrom(value: unknown): string | null {
  if (typeof value === "string") return isAddressableRunId(value) ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

/** Whether a stop can address exactly this run by this id, as one path segment (see stopIdFrom). */
function isAddressableRunId(value: string): boolean {
  if (value === "" || value === "." || value === "..") return false;
  return !value.includes("/") && !value.includes("\\");
}

/** The id the kill switch stops a record's run by (stopIdFrom), or null when a stop can address none. */
export function engineStopIdOf(findings: unknown): string | null {
  return stopIdFrom(recordOf(findings)?.runId);
}

/** The engine run a record names, or null when it names none. */
export function engineRunIdOf(findings: unknown): string | null {
  return runIdFrom(recordOf(findings)?.runId);
}

/** Whether a record is an engine scan's: a run id, a target, or a run's results (see above). */
export function isEngineRecord(findings: unknown): boolean {
  if (engineRunIdOf(findings) !== null) return true;
  const recorded = recordOf(findings);
  if (recorded === null) return false;
  return typeof recorded.target === "string" || (recorded.results !== undefined && recorded.results !== null);
}

/**
 * The keys of a record that come from Athena-Backend's record of the scan
 * (the Option 1 hybrid), owned by the scan route and the collect watch as the
 * run's own keys are: a person may not supply them, and an edit keeps them.
 *
 *   - `backendScanId`: the backend's scan uuid -- what is collected, what a
 *     stop is mirrored to, what the PDF is read by;
 *   - `backendEngagementId`: the engagement the launch ran under;
 *   - `backend`: the record once collected (shared/schema.ts BackendRecordSnapshot);
 *   - `backendMirror`: what a Stop's mirror to the record came to;
 *   - `stop`: "backend" while this dashboard's engine key cannot read the run
 *     (its first direct read answered 404), so no direct Stop is offered and
 *     the screens name the backend's Stop and the failsafes; cleared by the
 *     first direct read that succeeds.
 */
export const BACKEND_RECORD_KEYS = ["backendScanId", "backendEngagementId", "backend", "backendMirror", "stop"] as const;

/** The backend scan uuid a record names, or null when it names none (a scan this dashboard dispatched to the engine itself). */
export function backendScanIdOf(findings: unknown): string | null {
  const value = recordOf(findings)?.backendScanId;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The backend engagement a record names, or null. */
export function backendEngagementIdOf(findings: unknown): number | null {
  const value = recordOf(findings)?.backendEngagementId;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Whether a record's run is one no direct Stop reaches: this dashboard's engine key could not read it (see BACKEND_RECORD_KEYS). */
export function stoppedOnlyAtBackend(findings: unknown): boolean {
  return recordOf(findings)?.stop === "backend";
}

/**
 * The keys of a row ADOPTED from Athena-Backend's record -- a scan the backend
 * lists for the person that this dashboard had no row for, started from
 * elsewhere (server/backend-adoption.ts; the Option 1 hybrid, owner decision
 * 4) -- owned by the adoption as the run's own keys are: a person may not
 * supply them, and an edit keeps them.
 *
 *   - `source`: "backend" -- the row was made from the backend's record, not
 *     from a launch this dashboard made; the screens say so, by source;
 *   - `adoptedAt`: when the record was read into the row (ISO 8601).
 *
 * Kept apart from BACKEND_RECORD_KEYS, which the record's own tests pin.
 */
export const ADOPTION_KEYS = ["source", "adoptedAt"] as const;

/** Whether a row was adopted from the backend's record (see ADOPTION_KEYS). */
export function adoptedFromRecord(findings: unknown): boolean {
  return recordOf(findings)?.source === "backend";
}

/**
 * A scan's status once a PERSON has recorded that the engine does not know its
 * run (POST /api/scans/:testId/record-not-known): the act sent the run a stop,
 * and the engine answered it 404 "No such scan run". Written by nothing but
 * that act -- never by a read, a count or a mark -- and only on a scan this
 * dashboard dispatched to the engine itself (a hybrid row's end is its
 * record's). A run's end as far as this dashboard is concerned (FINISHED_RUN_STATES):
 * a delete sends it no stop. The kill switch still sends it one by its id. The
 * same word, with the same meaning, as the retest handle's `not_known` phase:
 * one vocabulary.
 */
export const NOT_KNOWN_STATUS = "not_known";

/**
 * The key of a scan's `findings` that holds what this dashboard knows of a run
 * the engine does not know, owned by the status route and the act as the run's
 * own keys are (a person may not supply it, and an edit keeps it):
 *
 *   - the READING (NotKnownMark): the engine's 404 to the row's reads has stood
 *     (server/routes.ts notKnown) -- written by the status read, never awaited
 *     by it, and let go by any read the engine answers;
 *   - `recorded`: the person's act that ended the row (NotKnownRecorded).
 */
export const NOT_KNOWN_KEY = "notKnown";

/** The reading of a run the engine has not known for a while: since when, how many reads, the engine's latest words. */
export interface NotKnownMark {
  since: string;
  reads: number;
  lastReadAt: string;
  said: string;
}

/** A person's act that recorded the run as not known to the engine (NOT_KNOWN_STATUS). */
export interface NotKnownRecorded {
  /** The person, by name where the account has one. */
  by: string | null;
  at: string;
  /** What the stop the act sent came to, in this dashboard's words. */
  stop: string;
  /** The engine's own words to that stop. */
  said: string;
}

function notKnownOf(findings: unknown): Record<string, unknown> | null {
  const value = recordOf(findings)?.[NOT_KNOWN_KEY];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The standing reading on a row (NotKnownMark), or null when it holds none. */
export function notKnownMarkOf(findings: unknown): NotKnownMark | null {
  const held = notKnownOf(findings);
  if (held === null || typeof held.since !== "string" || typeof held.reads !== "number") return null;
  return {
    since: held.since, reads: held.reads,
    lastReadAt: typeof held.lastReadAt === "string" ? held.lastReadAt : held.since,
    said: typeof held.said === "string" ? held.said : "",
  };
}

/** The person's act on a row (NotKnownRecorded), or null when none was recorded. */
export function notKnownRecordedOf(findings: unknown): NotKnownRecorded | null {
  const recorded = notKnownOf(findings)?.recorded;
  if (!recorded || typeof recorded !== "object" || Array.isArray(recorded)) return null;
  const one = recorded as Record<string, unknown>;
  if (typeof one.at !== "string") return null;
  return {
    by: typeof one.by === "string" ? one.by : null,
    at: one.at,
    stop: typeof one.stop === "string" ? one.stop : "",
    said: typeof one.said === "string" ? one.said : "",
  };
}
