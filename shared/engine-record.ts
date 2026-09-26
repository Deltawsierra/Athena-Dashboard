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
