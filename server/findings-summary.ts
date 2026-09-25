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
 * Everything is counted in single passes. The first version spread every
 * finding into Math.max/Math.min (a RangeError past ~125k arguments, so the
 * summary failed for good once an estate crossed it: lifecycle rows are never
 * deleted) and filtered the whole open list once per client (O(clients x
 * findings): seconds of blocked event loop at a thousand clients).
 */
import type { Client, Finding, Site } from "@shared/schema";
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
}): FindingsSummary {
  const { clients, sites, findings } = input;
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

  const byClient = clients.map((client) => {
    const own = perClient.get(client.id) as { open: number; critical: number; high: number; latestSerious: number };
    return {
      clientId: client.id,
      open: own.open,
      critical: own.critical,
      high: own.high,
      latestSeriousSeenAt: Number.isNaN(own.latestSerious) ? null : new Date(own.latestSerious).toISOString(),
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
    const [clients, sites] = await Promise.all([storage.getAllClients(), storage.getAllSites()]);
    const perClient = await Promise.all(clients.map((client) => storage.getFindingsByClient(client.id)));
    read = { clients, sites, findings: perClient.flat() };
  } catch (cause) {
    throw new SummaryReadError(cause);
  }
  return summarizeFindings(read);
}
