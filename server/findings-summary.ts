/**
 * The estate's findings, counted once on the server: what the Overview draws
 * and what the Deployments pipeline counts.
 *
 * The Overview used to ask for every client's findings separately -- one
 * request per client, each of which also loaded every finding's sightings and
 * checks -- only to add up a handful of counts. Two hundred clients meant two
 * hundred and six requests. This reads each client's findings from storage in
 * one request and returns only the counts.
 *
 * The rule that made the client-side version honest holds here too: the totals
 * are over every client's findings, or there are none. If any one client's
 * findings cannot be read, loadFindingsSummary rejects and the route answers
 * an error -- never a total over whichever clients happened to read cleanly,
 * which would be wrong and look right.
 *
 * Findings here are lifecycle rows, and only the engine's scans file them. A
 * test a person records on the Tests screen -- "completed, 3 critical, 5 high"
 * -- files none, so counting lifecycle rows alone answered "no open critical
 * or high finding" for a client whose latest completed scan said otherwise.
 * Each client therefore also carries what its latest completed tests reported
 * at critical and high that no finding stands behind (`untrackedScan`), and
 * the screens flag it rather than clearing the client.
 *
 * "Stands behind" is counted per severity, per test. It used to be one bit --
 * "did this test file anything?" -- so a scan that reported a critical and
 * filed only a medium (one issue seen at two severities, filed at the first)
 * read as fully tracked, and the client as clear. Now storage says how many
 * distinct critical and high findings each test sighted, and any shortfall
 * against what the test reported is untracked. The test's own recorded
 * repeats (several payloads at one place: one finding by design) are taken
 * off first, using the very fold ingest files with.
 *
 * "Latest" is per site, by completion time (shared/latest-scans.ts): a later
 * scan of another site, or an older scan that happens to have been created
 * later, no longer replaces the scan that reported the criticals.
 *
 * Everything is counted in single passes. The first version spread every
 * finding into Math.max/Math.min (a RangeError past ~125k arguments, so the
 * summary failed for good once an estate crossed it: lifecycle rows are never
 * deleted) and filtered the whole open list once per client (O(clients x
 * findings): seconds of blocked event loop at a thousand clients).
 */
import type { Client, Finding, Site, Test } from "@shared/schema";
import type { IStorage } from "./storage";
import {
  SUMMARY_SEVERITIES,
  isOpenStatus,
  type FindingsSummary,
  type SummarySeverity,
  type UntrackedScan,
} from "@shared/findings-summary";
import { completedTime, latestCompletedBySite, ratingOf, readScan } from "@shared/latest-scans";
import { foldResults } from "./findings";

export { SUMMARY_SEVERITIES, type FindingsSummary, type SummarySeverity };

/** How many of the top open findings the summary lists. */
export const TOP_OPEN = 5;
/** How many months the trend covers, ending at the latest month with a finding. */
export const TREND_MONTHS = 12;

/**
 * A finding's severity as the summary counts it: its rating (ratingOf: any
 * case, trimmed), or "unrated" when it has none or one that is no rating. It
 * was counted as info -- "not a risk" -- beside an untracked-scan note that
 * read the same result as "no severity recorded, may be critical".
 */
export function severityOf(value: string | null | undefined): SummarySeverity {
  return ratingOf(value) ?? "unrated";
}

function time(value: Date | string | number | null | undefined): number {
  if (value === null || value === undefined) return Number.NaN;
  return new Date(value).getTime();
}

function isoOf(value: Date | string | number | null | undefined): string {
  const at = time(value);
  return Number.isNaN(at) ? "" : new Date(at).toISOString();
}

const monthKey = (at: Date) => at.getUTCFullYear() * 12 + at.getUTCMonth();
const monthLabel = (key: number) =>
  `${Math.floor(key / 12)}-${String((key % 12) + 1).padStart(2, "0")}`;

/** The fields of a test the summary reads. */
export type SummaryTest = Pick<
  Test,
  "id" | "clientId" | "status" | "startedAt" | "completedAt" | "criticalCount" | "highCount"
> &
  Partial<Pick<Test, "siteId" | "severity" | "findings" | "vulnerabilitiesFound" | "mediumCount" | "lowCount">>;

/** Critical and high counts. */
export interface SeriousCounts {
  critical: number;
  high: number;
}

/** What a test reported at critical and high, and what its record leaves unknown there. */
export interface SeriousReading extends SeriousCounts {
  /**
   * The test is rated critical or high and counts nothing at that severity
   * ("Severity: Critical, Total Vulnerabilities: 2"): it is taken to report
   * at least one result at its rating, and its figures are a floor.
   */
  ratedNotCounted: boolean;
  /** Results it reported with no severity recorded: any of them may be critical or high. */
  unrated: number;
}

/**
 * The distinct critical and high issues a test reported: the unit the finding
 * ledger files in -- read from the whole record (shared/latest-scans.ts
 * readScan), not the critical and high counts alone. Those alone read a test
 * recorded "Severity: Critical, Total Vulnerabilities: 2" (counts left at 0)
 * as reporting no critical, and one recorded "Total Vulnerabilities: 4" with
 * no severity as reporting no critical or high, and the screens said nothing
 * needed attention beside both. A rating with no count behind it is at least
 * one result at that rating; results nobody rated are carried as unrated.
 *
 * A test's counts are counted per result, so several payloads landing on one
 * endpoint are several criticals there and one finding in the ledger. Those
 * repeats are counted from the test's own recorded results, with the fold
 * ingest files by, and taken off -- so an engine scan that filed everything
 * it found shows no shortfall, and anything a person added by editing the
 * counts still does. A test with no recorded results (one a person recorded)
 * reports what its counts say. A completed engine test whose counts were never
 * recorded (all zero beside real results) reports what its results say.
 */
export function reportedSerious(test: SummaryTest): SeriousReading {
  const read = readScan({
    status: test.status,
    severity: test.severity ?? null,
    findings: test.findings,
    vulnerabilitiesFound: test.vulnerabilitiesFound ?? 0,
    criticalCount: test.criticalCount ?? 0,
    highCount: test.highCount ?? 0,
    mediumCount: test.mediumCount ?? 0,
    lowCount: test.lowCount ?? 0,
  });
  const recorded = (test.findings ?? {}) as Record<string, unknown>;
  const results = Array.isArray(recorded.results) ? (recorded.results as unknown[]) : null;
  const folded = results
    ? foldResults(results, test.clientId, typeof recorded.target === "string" ? recorded.target : null)
    : null;
  if (folded && read.countsNotRecorded) {
    const distinct = Array.from(folded.distinct.values());
    return {
      critical: distinct.filter((one) => severityOf(one.severity) === "critical").length,
      high: distinct.filter((one) => severityOf(one.severity) === "high").length,
      ratedNotCounted: false,
      unrated: distinct.filter((one) => ratingOf(one.severity) === null).length,
    };
  }
  const floor = (band: "critical" | "high") => (read.ratedNotCounted === band ? 1 : 0);
  return {
    critical: Math.max(floor("critical"), read.counts.critical - (folded?.foldedAway.critical ?? 0)),
    high: Math.max(floor("high"), read.counts.high - (folded?.foldedAway.high ?? 0)),
    ratedNotCounted: read.ratedNotCounted === "critical" || read.ratedNotCounted === "high",
    unrated: read.unrated,
  };
}

/** Whether a test's record leaves anything at critical or high for the summary to flag. */
const flagsSerious = (reported: SeriousReading) =>
  reported.critical + reported.high > 0 || reported.ratedNotCounted || reported.unrated > 0;

/** A test whose reported critical/high results may need a finding row behind them. */
const reportsSerious = (test: SummaryTest) => flagsSerious(reportedSerious(test));

type SummaryFinding = Pick<
  Finding,
  "id" | "clientId" | "siteId" | "type" | "severity" | "message" | "status" | "firstSeenAt" | "lastSeenAt"
>;

/** Worse first; between equals, the most recently seen first. */
function worse(a: SummaryFinding, b: SummaryFinding): number {
  const rank = (one: SummaryFinding) => SUMMARY_SEVERITIES.indexOf(severityOf(one.severity));
  return rank(a) - rank(b) || time(b.lastSeenAt) - time(a.lastSeenAt);
}

/** The summary of a set of findings. Pure: everything it counts is passed in. */
export function summarizeFindings(input: {
  clients: Pick<Client, "id" | "name">[];
  sites: Pick<Site, "id" | "environment">[];
  findings: SummaryFinding[];
  /**
   * Every test on record; only each site's latest completed one is read.
   * Omitted means no test is on record.
   */
  tests?: SummaryTest[];
  /**
   * Per test, how many distinct findings it sighted as seen at critical and at
   * high. A latest completed test that reported more than it filed has the
   * difference reported as `untrackedScan`. A test missing here filed none.
   */
  filed?: ReadonlyMap<string, SeriousCounts>;
}): FindingsSummary {
  const { clients, sites, findings, tests = [], filed = new Map<string, SeriousCounts>() } = input;
  const envOf = new Map(sites.map((site) => [site.id, site.environment]));
  const nameOf = new Map(clients.map((client) => [client.id, client.name]));

  const openCounts: FindingsSummary["open"] = { total: 0, critical: 0, high: 0, medium: 0, low: 0, unrated: 0, info: 0 };
  const envCounts = new Map<string | null, number>();
  // One entry per client on record, filled in the same pass as everything
  // else: a finding finds its client by key, not by a filter over every
  // finding per client.
  const perClient = new Map(
    clients.map((client) => [client.id, { open: 0, critical: 0, high: 0, latestSerious: Number.NaN }]),
  );
  // The month each dated finding arrived in, and the first and latest of them,
  // as running values. Never a spread: an argument list the size of the estate
  // is a RangeError waiting for the estate to grow.
  const monthOf = new Array<number>(findings.length);
  let firstMonth = Number.POSITIVE_INFINITY;
  let lastMonth = Number.NEGATIVE_INFINITY;
  // The worst TOP_OPEN open findings, kept sorted as they are met. Ties keep
  // the order they arrived in, as a stable sort would.
  const topOpen: SummaryFinding[] = [];

  findings.forEach((finding, index) => {
    const first = time(finding.firstSeenAt);
    if (Number.isNaN(first)) {
      monthOf[index] = Number.NaN;
    } else {
      const key = monthKey(new Date(first));
      monthOf[index] = key;
      if (key < firstMonth) firstMonth = key;
      if (key > lastMonth) lastMonth = key;
    }

    if (!isOpenStatus(finding.status)) return;
    const sev = severityOf(finding.severity);
    openCounts.total += 1;
    openCounts[sev] += 1;

    const env = finding.siteId && envOf.has(finding.siteId) ? (envOf.get(finding.siteId) as string) : null;
    envCounts.set(env, (envCounts.get(env) ?? 0) + 1);

    const own = perClient.get(finding.clientId);
    if (own) {
      own.open += 1;
      if (sev === "critical") own.critical += 1;
      if (sev === "high") own.high += 1;
      if (sev === "critical" || sev === "high") {
        const seen = time(finding.lastSeenAt);
        if (!Number.isNaN(seen) && (Number.isNaN(own.latestSerious) || seen > own.latestSerious)) {
          own.latestSerious = seen;
        }
      }
    }

    if (topOpen.length < TOP_OPEN || worse(finding, topOpen[topOpen.length - 1]) < 0) {
      let at = topOpen.length;
      while (at > 0 && worse(finding, topOpen[at - 1]) < 0) at -= 1;
      topOpen.splice(at, 0, finding);
      if (topOpen.length > TOP_OPEN) topOpen.pop();
    }
  });

  const byEnvironment = Array.from(envCounts.entries())
    .map(([environment, count]) => ({ environment, open: count }))
    // Most first; on a tie, named environments before "no site", then by name.
    .sort(
      (a, b) =>
        b.open - a.open ||
        Number(a.environment === null) - Number(b.environment === null) ||
        String(a.environment).localeCompare(String(b.environment)),
    );

  const byMonth: FindingsSummary["byMonth"] = [];
  if (lastMonth >= firstMonth) {
    const first = Math.max(firstMonth, lastMonth - (TREND_MONTHS - 1));
    for (let key = first; key <= lastMonth; key += 1) {
      byMonth.push({ month: monthLabel(key), critical: 0, high: 0, medium: 0, low: 0, unrated: 0 });
    }
    findings.forEach((finding, index) => {
      const key = monthOf[index];
      if (Number.isNaN(key) || key < first) return;
      const sev = severityOf(finding.severity);
      // Info is not charted. A finding with no severity recorded is counted in
      // its own column, never dropped: the chart says how many it does not draw.
      if (sev !== "info") byMonth[key - first][sev] += 1;
    });
  }

  // Each site's latest completed test, and what it reported at critical and
  // high that it did not file, gathered per client.
  const untrackedOf = new Map<string, UntrackedScan>();
  const newestOf = new Map<string, SummaryTest>();
  for (const scan of Array.from(latestCompletedBySite(tests).values())) {
    const reported = reportedSerious(scan);
    const sighted = filed.get(scan.id) ?? { critical: 0, high: 0 };
    const critical = Math.max(0, reported.critical - sighted.critical);
    const high = Math.max(0, reported.high - sighted.high);
    // A rating with no count behind it, or results nobody rated, is never read
    // as tracked: how many critical or high results stand behind it is not
    // on record, so no filed finding can be shown to cover them.
    if (!flagsSerious({ ...reported, critical, high })) continue;
    const sum = untrackedOf.get(scan.clientId);
    const newest = newestOf.get(scan.clientId);
    const lead = !newest || completedTime(scan) > completedTime(newest) ? scan : newest;
    newestOf.set(scan.clientId, lead);
    untrackedOf.set(scan.clientId, {
      testId: lead.id,
      completedAt: isoOf(lead.completedAt) || null,
      critical: (sum?.critical ?? 0) + critical,
      high: (sum?.high ?? 0) + high,
      ratedNotCounted: (sum?.ratedNotCounted ?? 0) + (reported.ratedNotCounted ? 1 : 0),
      unrated: (sum?.unrated ?? 0) + reported.unrated,
      scans: (sum?.scans ?? 0) + 1,
    });
  }

  const byClient = clients.map((client) => {
    const own = perClient.get(client.id) as { open: number; critical: number; high: number; latestSerious: number };
    return {
      clientId: client.id,
      open: own.open,
      critical: own.critical,
      high: own.high,
      latestSeriousSeenAt: Number.isNaN(own.latestSerious) ? null : new Date(own.latestSerious).toISOString(),
      untrackedScan: untrackedOf.get(client.id) ?? null,
    };
  });

  return {
    clients: clients.length,
    open: openCounts,
    byEnvironment,
    byMonth,
    topOpen: topOpen.map((finding) => ({
      id: finding.id,
      clientId: finding.clientId,
      clientName: nameOf.get(finding.clientId) ?? "",
      type: finding.type,
      severity: severityOf(finding.severity),
      message: finding.message ?? null,
      lastSeenAt: isoOf(finding.lastSeenAt),
    })),
    byClient,
  };
}

/**
 * A read the summary depends on failed. Kept apart from a failure to count
 * what was read, so the route blames storage only when storage failed.
 */
export class SummaryReadError extends Error {
  constructor(readonly reason: unknown) {
    super(`could not read every engagement's findings: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = "SummaryReadError";
  }
}

/**
 * Every client's findings, read from storage and summarized. Rejects with a
 * SummaryReadError if any one read fails: there is no partial summary. An
 * error thrown while counting what was read is passed on as it is.
 */
export async function loadFindingsSummary(storage: IStorage): Promise<FindingsSummary> {
  let read: Parameters<typeof summarizeFindings>[0];
  try {
    const [clients, sites, tests] = await Promise.all([
      storage.getAllClients(),
      storage.getAllSites(),
      storage.getAllTests(),
    ]);
    const perClient = await Promise.all(clients.map((client) => storage.getFindingsByClient(client.id)));
    // Only each site's latest completed test counts, and only when it reported
    // something critical or high is it worth asking what it filed.
    const candidates = Array.from(latestCompletedBySite(tests).values()).filter(reportsSerious);
    const filed = await Promise.all(candidates.map((test) => storage.filedSeriousFindings(test.id)));
    read = {
      clients,
      sites,
      findings: perClient.flat(),
      tests,
      filed: new Map(candidates.map((test, index) => [test.id, filed[index]])),
    };
  } catch (cause) {
    throw new SummaryReadError(cause);
  }
  return summarizeFindings(read);
}
