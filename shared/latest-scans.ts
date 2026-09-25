/**
 * Which completed test is "the latest", and what its counts can be trusted to
 * say. Shared by the findings summary on the server and the Deployments table,
 * so the two cannot pick different tests.
 *
 * PER SITE, NOT PER CLIENT. A scan of one site says nothing about another --
 * ingest itself refuses to record "not seen" against a site a run never went
 * to -- so a client's later scan of site B must not replace what the latest
 * scan of site A reported. Each (client, site) pair is its own scope, and a
 * test recorded against the client with no site is one more scope of its own.
 *
 * BY WHEN IT COMPLETED. The server stamps completedAt when a test is created
 * completed or moves to completed without one (server/routes.ts), so a
 * pentest finished today ranks after an engine scan that finished yesterday.
 * Only a row written before that, with no completion time at all, falls back
 * to startedAt -- which the server sets when the row is created: tests have no
 * separate creation time.
 */

/** The fields of a test these rules read. */
export interface ScopedTest {
  clientId: string;
  siteId?: string | null;
  status: string;
  startedAt: Date | string | number | null;
  completedAt: Date | string | number | null;
}

/** The scope a test's result speaks for: its client and site, or its client alone. */
export function scopeOf(test: Pick<ScopedTest, "clientId" | "siteId">): string {
  // NUL cannot occur in an id, so no client/site pair can spell another.
  return `${test.clientId}\u0000${test.siteId ?? ""}`;
}

/** When a completed test completed; its start when no completion time was recorded. */
export function completedTime(test: Pick<ScopedTest, "startedAt" | "completedAt">): number {
  const at = test.completedAt ?? test.startedAt;
  return at === null || at === undefined ? Number.NaN : new Date(at).getTime();
}

/**
 * Each scope's latest COMPLETED test. A test still pending or running has no
 * result. A test with no readable time never displaces one that has one.
 */
export function latestCompletedBySite<T extends ScopedTest>(tests: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const test of tests) {
    if (test.status !== "completed") continue;
    const key = scopeOf(test);
    const current = latest.get(key);
    const at = completedTime(test);
    if (!current || at > completedTime(current) || (Number.isNaN(completedTime(current)) && !Number.isNaN(at))) {
      latest.set(key, test);
    }
  }
  return latest;
}

/** The fields countsNotRecorded reads. */
export interface CountedTest {
  status: string;
  findings?: unknown;
  vulnerabilitiesFound: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

/**
 * A completed engine test whose results are on record but whose counts are
 * not: every count zero beside a list of real (non-internal) results. Rows the
 * engine finished inline were written like that before the inline-count fix,
 * and the status route never revisits a completed row, so they read "0" --
 * which is a measurement nobody took. Their counts are "not recorded", never 0.
 */
export function countsNotRecorded(test: CountedTest): boolean {
  if (test.status !== "completed") return false;
  if (test.vulnerabilitiesFound + test.criticalCount + test.highCount + test.mediumCount + test.lowCount > 0) {
    return false;
  }
  const recorded = test.findings;
  if (!recorded || typeof recorded !== "object") return false;
  const results = (recorded as { results?: unknown }).results;
  return Array.isArray(results) && results.some(
    (one) => one !== null && typeof one === "object" && (one as { internal?: unknown }).internal !== true,
  );
}

/** The severity bands a test's counts are recorded in, worst first. */
export const COUNTED_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type CountedSeverity = (typeof COUNTED_SEVERITIES)[number];

/**
 * How many findings a test's record says it found: its total, or the sum of
 * its per-severity counts when that is more.
 *
 * The Tests screen sends "Total Vulnerabilities" and each severity's count as
 * separate fields, and a person who fills in only "Critical Count: 2" leaves
 * the total at its default, 0. Read from the total alone, that test "reported
 * 0" beside two recorded criticals -- which the findings summary itself flags.
 */
export function reportedTotal(test: Pick<CountedTest, "vulnerabilitiesFound" | "criticalCount" | "highCount" | "mediumCount" | "lowCount">): number {
  return Math.max(test.vulnerabilitiesFound, test.criticalCount + test.highCount + test.mediumCount + test.lowCount);
}

/**
 * The worst severity a test's record reports: the worse of its severity field
 * and its worst non-zero count. null when neither says anything -- which is
 * not "none": a total with no severity recorded is unrated, not medium.
 */
export function reportedSeverity(test: Pick<CountedTest, "criticalCount" | "highCount" | "mediumCount" | "lowCount"> & { severity?: string | null }): CountedSeverity | null {
  const field = ratingOf(test.severity);
  const counts: Record<CountedSeverity, number> = {
    critical: test.criticalCount, high: test.highCount, medium: test.mediumCount, low: test.lowCount,
  };
  return COUNTED_SEVERITIES.find((one) => field === one || counts[one] > 0) ?? null;
}

/** Every severity a result or a test can be rated at: the counted ones, and info. */
export const RATINGS = [...COUNTED_SEVERITIES, "info"] as const;
export type Rating = (typeof RATINGS)[number];

/**
 * A recorded severity as one of RATINGS, whatever its case or surrounding
 * space ("Critical", " HIGH"); null for none, or for a word that is not one.
 * POST /api/tests takes the severity as any string.
 */
export function ratingOf(value: unknown): Rating | null {
  const word = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (RATINGS as readonly string[]).includes(word) ? (word as Rating) : null;
}

/** The fields readScan reads: a test's whole record of what it found. */
export type ReadableTest = CountedTest & { severity?: string | null };

/**
 * What a test's record says it found, read whole. Every screen, the findings
 * summary and the assistant's context read a scan's seriousness through this,
 * so none of them can read one field and miss what another says.
 *
 * The Tests screen records "Severity" and "Total Vulnerabilities" apart from
 * the per-severity counts, and a person may fill in any of them. "Severity:
 * Critical, Total Vulnerabilities: 2" with the counts left at 0 is a scan that
 * found two results rated critical at worst, not one that found no critical --
 * and "Total Vulnerabilities: 4" alone is four results nobody rated, which may
 * be critical, not four that are not. An engine scan records a list of results,
 * each with its own severity, and counts them (server/routes.ts
 * countSeverities).
 */
export interface ScanReading {
  /** Results came back and no count was written down (countsNotRecorded): nothing below is a reading of them. */
  countsNotRecorded: boolean;
  /**
   * The worst severity on record: the severity field or a non-zero count
   * (reportedSeverity). "info" when the only severity recorded is info -- the
   * field says so, or every result the engine returned was rated info -- which
   * is not a risk. null when nothing rates what was found.
   */
  severity: Rating | null;
  /** How many results the record says it found (reportedTotal). */
  total: number;
  /** The per-severity counts, as recorded. */
  counts: Record<CountedSeverity, number>;
  /**
   * The severity field names a band its count leaves at 0: at least one result
   * at that severity that no count records. The counts are then a floor, not
   * a breakdown. null when the field is backed by its count, or names no band.
   */
  ratedNotCounted: CountedSeverity | null;
  /**
   * Results with no severity recorded that bounds them: for an engine scan, the
   * results whose own severity is missing or not a rating; for a test a person
   * recorded, the total beyond the counts when no severity field was recorded.
   * Any of them may be critical.
   */
  unrated: number;
}

/** The results an engine run recorded, less its own diagnostics; null for a test with no results list. */
function resultsOf(test: Pick<CountedTest, "findings">): Array<Record<string, unknown>> | null {
  const recorded = test.findings;
  if (!recorded || typeof recorded !== "object") return null;
  const results = (recorded as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  return results.filter(
    (one): one is Record<string, unknown> =>
      one !== null && typeof one === "object" && (one as { internal?: unknown }).internal !== true,
  );
}

/** A test's record, read whole (see ScanReading). */
export function readScan(test: ReadableTest): ScanReading {
  const counts: Record<CountedSeverity, number> = {
    critical: test.criticalCount ?? 0, high: test.highCount ?? 0, medium: test.mediumCount ?? 0, low: test.lowCount ?? 0,
  };
  const counted = counts.critical + counts.high + counts.medium + counts.low;
  const total = Math.max(test.vulnerabilitiesFound ?? 0, counted);
  const field = ratingOf(test.severity);
  const results = resultsOf(test);
  const worst = reportedSeverity({
    criticalCount: counts.critical, highCount: counts.high, mediumCount: counts.medium, lowCount: counts.low,
    severity: test.severity,
  });
  // Engine results carry their own severities, so what no count covers is read
  // off the list; a person's record has only the field to bound it.
  const unrated = results !== null
    ? results.filter((one) => ratingOf(one.severity) === null).length
    : field === null ? total - counted : 0;
  const infoOnly = field === "info"
    || (field === null && counted === 0 && results !== null && results.length > 0
      && results.every((one) => ratingOf(one.severity) === "info"));
  return {
    countsNotRecorded: countsNotRecorded(test),
    severity: worst ?? (infoOnly ? "info" : null),
    total,
    counts,
    ratedNotCounted: field !== null && field !== "info" && counts[field] === 0 ? field : null,
    unrated,
  };
}
