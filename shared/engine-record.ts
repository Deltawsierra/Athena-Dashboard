/**
 * Whether a test's record is an engine scan's, and the engine run it names.
 *
 * One rule, read by every part of the app that decides it: the status route
 * (`GET /api/scans/:testId`), the edit guard (`PATCH /api/tests/:id`), the
 * abort route's answer, the counts (shared/latest-scans.ts) and the Tests
 * screen. They disagreed. The status route told a record holding a run's
 * results that it had "no engine run recorded against it" while the edit guard
 * refused its counts as an engine scan's, and the Tests screen offered those
 * same counts for editing, decided by the run id alone.
 *
 * A record is an engine scan's when its findings carry a run id, the target the
 * scan route recorded, or the run's results. Only `POST /api/scans` writes a
 * `target` or `results` (a person's test that sends either is refused), so a run
 * the engine finished or accepted without a run id is an engine scan all the
 * same. A key recorded as null is none.
 */

/** The findings object of a record, or null when it has none. */
function recordOf(findings: unknown): Record<string, unknown> | null {
  return findings && typeof findings === "object" && !Array.isArray(findings)
    ? (findings as Record<string, unknown>)
    : null;
}

/** The engine run a record names, or null when it names none. */
export function engineRunIdOf(findings: unknown): string | null {
  const runId = recordOf(findings)?.runId;
  return typeof runId === "string" && runId !== "" ? runId : null;
}

/** Whether a record is an engine scan's: a run id, a target, or a run's results (see above). */
export function isEngineRecord(findings: unknown): boolean {
  if (engineRunIdOf(findings) !== null) return true;
  const recorded = recordOf(findings);
  if (recorded === null) return false;
  return typeof recorded.target === "string" || (recorded.results !== undefined && recorded.results !== null);
}
