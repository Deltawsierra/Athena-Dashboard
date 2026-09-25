/**
 * After a test or a finding changes, every answer computed from them is out
 * of date -- not only the list that changed.
 *
 * The screens invalidated ["/api/tests"] and nothing else, so the findings
 * summary -- which carries the untracked-scan flag, the open totals and the
 * top open findings -- stayed cached for its 30 seconds beside a fresh test
 * list. Back on the Overview after recording a completed pentest with 3
 * critical / 2 high, Recent Activity said "5 findings reported" and the
 * attention panel, from the old summary, said "Nothing flagged". A stale
 * source must never be drawn as current (owner decision Q7), and nothing
 * makes a cached answer current except asking again.
 *
 * So every change to a test or a finding -- the Tests screen's create, edit
 * and delete, a scan started or finished on the Athena and Penetration
 * Testing screens, a retest, a finding's status, a deletion, the sample-data
 * removal -- calls this, and it marks every query derived from tests or
 * findings stale at once.
 */
import type { QueryClient } from "@tanstack/react-query";
import { queryClient as appQueryClient } from "./queryClient";

/** Read exactly as their paths: each is computed from tests or findings. */
const EXACT = new Set(["/api/tests", "/api/findings", "/api/findings/summary", "/api/sample-data"]);
/**
 * Read with something after the path: the per-client findings some screens
 * key as one string ("/api/findings?clientId=..."), and the compliance map
 * computed from a client's tests ("/api/compliance/<clientId>").
 */
const PREFIXES = ["/api/findings?", "/api/compliance/"];

/** Whether a query's answer is computed from tests or findings. */
export function derivedFromTestsOrFindings(queryKey: readonly unknown[]): boolean {
  const head = queryKey[0];
  if (typeof head !== "string") return false;
  return EXACT.has(head) || PREFIXES.some((prefix) => head.startsWith(prefix));
}

/** Mark every answer computed from tests or findings stale; the ones on screen are read again. */
export function invalidateTestsAndFindings(client: QueryClient = appQueryClient): Promise<void> {
  return client.invalidateQueries({ predicate: (query) => derivedFromTestsOrFindings(query.queryKey) });
}
