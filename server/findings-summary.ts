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
 * Each client therefore also carries that scan's reported counts whenever none
 * of its results were filed as findings (`untrackedScan`), and the screens
 * flag it rather than clearing the client.
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
  type FindingsSummary,
  type SummarySeverity,
} from "@shared/findings-summary";

export { SUMMARY_SEVERITIES, type FindingsSummary, type SummarySeverity };

/** How many of the top open findings the summary lists. */
export const TOP_OPEN = 5;
/** How many months the trend covers, ending at the latest month with a finding. */
export const TREND_MONTHS = 12;

export function severityOf(value: string | null | undefined): SummarySeverity {
  const v = (value ?? "").toLowerCase();
  return (SUMMARY_SEVERITIES as readonly string[]).includes(v) ? (v as SummarySeverity) : "info";
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
>;

/**
 * Each client's latest COMPLETED test -- by when it completed, or started when
 * no completion time is recorded -- the same test the Deployments table reads
 * its risk and counts from. A test still pending or running has no result.
 */
export function latestCompletedByClient<T extends SummaryTest>(tests: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  const when = (test: T) => time(test.completedAt ?? test.startedAt);
  for (const test of tests) {
    if (test.status !== "completed") continue;
    const current = latest.get(test.clientId);
    if (!current || when(test) > when(current)) latest.set(test.clientId, test);
  }
  return latest;
}

/** A test whose reported critical/high counts may need a finding row behind them. */
const reportsSerious = (test: SummaryTest) => (test.criticalCount ?? 0) + (test.highCount ?? 0) > 0;

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
   * Every test on record; only each client's latest completed one is read.
   * Omitted means no test is on record.
   */
  tests?: SummaryTest[];
  /**
   * The tests that filed at least one of their results as a finding. A latest
   * completed test missing from this set has counts no finding row stands
   * behind, and they are reported as `untrackedScan`.
   */
  filedTestIds?: ReadonlySet<string>;
}): FindingsSummary {
  const { clients, sites, findings, tests = [], filedTestIds = new Set<string>() } = input;
  const envOf = new Map(sites.map((site) => [site.id, site.environment]));
  const nameOf = new Map(clients.map((client) => [client.id, client.name]));

  const openCounts: FindingsSummary["open"] = { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
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

    if (finding.status !== "open") return;
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
      byMonth.push({ month: monthLabel(key), critical: 0, high: 0, medium: 0, low: 0 });
    }
    findings.forEach((finding, index) => {
      const key = monthOf[index];
      if (Number.isNaN(key) || key < first) return;
      const sev = severityOf(finding.severity);
      if (sev !== "info") byMonth[key - first][sev] += 1;
    });
  }

  const latestDone = latestCompletedByClient(tests);
  const byClient = clients.map((client) => {
    const own = perClient.get(client.id) as { open: number; critical: number; high: number; latestSerious: number };
    const scan = latestDone.get(client.id);
    return {
      clientId: client.id,
      open: own.open,
      critical: own.critical,
      high: own.high,
      latestSeriousSeenAt: Number.isNaN(own.latestSerious) ? null : new Date(own.latestSerious).toISOString(),
      untrackedScan:
        scan && reportsSerious(scan) && !filedTestIds.has(scan.id)
          ? {
              testId: scan.id,
              completedAt: isoOf(scan.completedAt) || null,
              critical: scan.criticalCount ?? 0,
              high: scan.highCount ?? 0,
            }
          : null,
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
    // Only a client's latest completed test counts, and only when it reported
    // something critical or high is it worth asking whether it filed anything.
    const candidates = Array.from(latestCompletedByClient(tests).values()).filter(reportsSerious);
    const filed = await Promise.all(candidates.map((test) => storage.testFiledFindings(test.id)));
    read = {
      clients,
      sites,
      findings: perClient.flat(),
      tests,
      filedTestIds: new Set(candidates.filter((_, index) => filed[index]).map((test) => test.id)),
    };
  } catch (cause) {
    throw new SummaryReadError(cause);
  }
  return summarizeFindings(read);
}
