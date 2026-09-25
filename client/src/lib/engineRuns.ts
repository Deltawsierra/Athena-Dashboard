/**
 * Which recorded tests have an engine run that may still be running -- read
 * exactly as the server reads it (server/routes.ts runIdOf and
 * FINISHED_RUN_STATES), so every screen offers a Stop for the same scans the
 * server would stop.
 */

/** Engine run states after which nothing more happens. */
export const FINISHED_RUN_STATES = new Set(["completed", "aborted", "failed", "refused"]);

/** The run id of a test whose engine run may still be running, or null. */
export function unfinishedRunOf(test: { findings: unknown; status: string }): string | null {
  const recorded = test.findings;
  if (!recorded || typeof recorded !== "object" || Array.isArray(recorded)) return null;
  const runId = (recorded as { runId?: unknown }).runId;
  if (typeof runId !== "string" || runId === "") return null;
  return FINISHED_RUN_STATES.has(test.status) ? null : runId;
}
