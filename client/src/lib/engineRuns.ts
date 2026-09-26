/**
 * Which recorded tests have an engine run that may still be running -- read
 * exactly as the server reads it (server/routes.ts runIdOf and
 * FINISHED_RUN_STATES), so every screen offers a Stop for the same scans the
 * server would stop.
 */

import { engineRunIdOf } from "@shared/engine-record";

/** Engine run states after which nothing more happens. */
export const FINISHED_RUN_STATES = new Set(["completed", "aborted", "failed", "refused"]);

/** The run id of a test whose engine run may still be running, or null. */
export function unfinishedRunOf(test: { findings: unknown; status: string }): string | null {
  // The run id by the server's own rule (shared/engine-record.ts), so a run id
  // recorded as a number is offered a Stop here as the server would stop it.
  const runId = engineRunIdOf(test.findings);
  if (runId === null) return null;
  return FINISHED_RUN_STATES.has(test.status) ? null : runId;
}
