/**
 * Which recorded tests have an engine run that may still be running -- read
 * exactly as the server reads it (server/routes.ts runIdOf and
 * FINISHED_RUN_STATES), so every screen offers a Stop for the same scans the
 * server would stop.
 */

import {
  NOT_KNOWN_STATUS, engineRunIdOf, engineStopIdOf, isEngineRecord, notKnownMarkOf, stoppedOnlyAtBackend,
} from "@shared/engine-record";

/**
 * Engine run states after which nothing more happens -- and `not_known`, a
 * person's record that the engine does not know the run (shared/engine-record.ts
 * NOT_KNOWN_STATUS): no Stop is offered for it here, as the server sends none
 * but the kill switch's.
 */
export const FINISHED_RUN_STATES = new Set(["completed", "aborted", "failed", "refused", NOT_KNOWN_STATUS]);

/**
 * Whether the engine does not know an engine scan's run: a person recorded it
 * so (`not_known`), or -- for a row that may still be running -- the server's
 * reading stands (`findings.notKnown`: its reads answered 404 for a while; its
 * status unchanged, its Stop offered as before). The one rule the Tests
 * screen's filter and the Overview's count read.
 */
export function notKnownToEngine(test: { findings: unknown; status: string }): boolean {
  if (!isEngineRecord(test.findings)) return false;
  return test.status === NOT_KNOWN_STATUS || (!FINISHED_RUN_STATES.has(test.status) && notKnownMarkOf(test.findings) !== null);
}

/** The run id of a test whose engine run may still be running, or null. */
export function unfinishedRunOf(test: { findings: unknown; status: string }): string | null {
  // The run id by the server's own rule (shared/engine-record.ts), so a run id
  // recorded as a number is offered a Stop here as the server would stop it.
  const runId = engineRunIdOf(test.findings);
  if (runId === null) return null;
  return FINISHED_RUN_STATES.has(test.status) ? null : runId;
}

/**
 * Whether a test is an engine scan that may still be running and that no Stop
 * can reach: the engine gave it no run id a stop can name (shared/engine-record.ts
 * runIdFrom), which its contract does not allow. The server marks such a scan
 * `stop: "failsafe"`; the screens show NoStopPanel for it in place of a Stop.
 */
export function failsafeOnly(test: { findings: unknown; status: string }): boolean {
  return !FINISHED_RUN_STATES.has(test.status) && isEngineRecord(test.findings) && engineRunIdOf(test.findings) === null;
}

/**
 * Whether no stop at all can be sent to such a scan: its id is none a stop can
 * address exactly (shared/engine-record.ts stopIdFrom). A blank-looking id is
 * no run id to the screens, but the server still sends a stop by it -- on a
 * delete, and from the kill switch -- so deleting that scan needs no force.
 */
export function noStopCanBeSent(test: { findings: unknown; status: string }): boolean {
  return failsafeOnly(test) && engineStopIdOf(test.findings) === null;
}

/**
 * Whether a scan's run may still be running and only the backend's Stop reaches
 * it yet (shared/engine-record.ts stoppedOnlyAtBackend; owner decision 7): the
 * server marked the row `stop: "backend"` -- a scan adopted from the record, or
 * one whose run this dashboard's key could not read -- until a direct read of
 * the run succeeds. The screens show NoStopPanel's backend variant for it in
 * place of a Stop; the kill switch and the backend's own stop still reach it.
 */
export function backendOnly(test: { findings: unknown; status: string }): boolean {
  return unfinishedRunOf(test) !== null && stoppedOnlyAtBackend(test.findings);
}
