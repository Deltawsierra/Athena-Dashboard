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

function isoOf(value: Date | string | number): string {
  const at = time(value);
  return Number.isNaN(at) ? "" : new Date(at).toISOString();
}

const monthKey = (at: Date) => at.getUTCFullYear() * 12 + at.getUTCMonth();
const monthLabel = (key: number) =>
  `${Math.floor(key / 12)}-${String((key % 12) + 1).padStart(2, "0")}`;

/** The summary of a set of findings. Pure: everything it counts is passed in. */
export function summarizeFindings(input: {
  clients: Pick<Client, "id" | "name">[];
  sites: Pick<Site, "id" | "environment">[];
  findings: Pick<
    Finding,
    "id" | "clientId" | "siteId" | "type" | "severity" | "message" | "status" | "firstSeenAt" | "lastSeenAt"
  >[];
}): FindingsSummary {
  const { clients, sites, findings } = input;
  const envOf = new Map(sites.map((site) => [site.id, site.environment]));
  const nameOf = new Map(clients.map((client) => [client.id, client.name]));
  const open = findings.filter((finding) => finding.status === "open");

  const openCounts: FindingsSummary["open"] = { total: open.length, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of open) openCounts[severityOf(finding.severity)] += 1;

  const envCounts = new Map<string | null, number>();
  for (const finding of open) {
    const env = finding.siteId && envOf.has(finding.siteId) ? (envOf.get(finding.siteId) as string) : null;
    envCounts.set(env, (envCounts.get(env) ?? 0) + 1);
  }
  const byEnvironment = Array.from(envCounts.entries())
    .map(([environment, count]) => ({ environment, open: count }))
    // Most first; on a tie, named environments before "no site", then by name.
    .sort(
      (a, b) =>
        b.open - a.open ||
        Number(a.environment === null) - Number(b.environment === null) ||
        String(a.environment).localeCompare(String(b.environment)),
    );

  const dated = findings
    .map((finding) => ({ finding, at: new Date(time(finding.firstSeenAt)) }))
    .filter((one) => !Number.isNaN(one.at.getTime()));
  const byMonth: FindingsSummary["byMonth"] = [];
  if (dated.length > 0) {
    const last = Math.max(...dated.map((one) => monthKey(one.at)));
    const first = Math.max(Math.min(...dated.map((one) => monthKey(one.at))), last - (TREND_MONTHS - 1));
    for (let key = first; key <= last; key += 1) {
      byMonth.push({ month: monthLabel(key), critical: 0, high: 0, medium: 0, low: 0 });
    }
    for (const { finding, at } of dated) {
      const key = monthKey(at);
      if (key < first) continue;
      const sev = severityOf(finding.severity);
      if (sev !== "info") byMonth[key - first][sev] += 1;
    }
  }

  const rank = (sev: SummarySeverity) => SUMMARY_SEVERITIES.indexOf(sev);
  const topOpen = open
    .slice()
    .sort(
      (a, b) =>
        rank(severityOf(a.severity)) - rank(severityOf(b.severity)) ||
        time(b.lastSeenAt) - time(a.lastSeenAt),
    )
    .slice(0, TOP_OPEN)
    .map((finding) => ({
      id: finding.id,
      clientId: finding.clientId,
      clientName: nameOf.get(finding.clientId) ?? "",
      type: finding.type,
      severity: severityOf(finding.severity),
      message: finding.message ?? null,
      lastSeenAt: isoOf(finding.lastSeenAt),
    }));

  const byClient = clients.map((client) => {
    const own = open.filter((finding) => finding.clientId === client.id);
    const serious = own.filter((finding) => {
      const sev = severityOf(finding.severity);
      return sev === "critical" || sev === "high";
    });
    const seen = serious.map((finding) => time(finding.lastSeenAt)).filter((t) => !Number.isNaN(t));
    const latest = seen.length > 0 ? Math.max(...seen) : Number.NaN;
    return {
      clientId: client.id,
      open: own.length,
      critical: own.filter((finding) => severityOf(finding.severity) === "critical").length,
      high: own.filter((finding) => severityOf(finding.severity) === "high").length,
      latestSeriousSeenAt: Number.isNaN(latest) ? null : new Date(latest).toISOString(),
    };
  });

  return { clients: clients.length, open: openCounts, byEnvironment, byMonth, topOpen, byClient };
}

/**
 * Every client's findings, read from storage and summarized. Rejects if any one
 * client's findings cannot be read: there is no partial summary.
 */
export async function loadFindingsSummary(storage: IStorage): Promise<FindingsSummary> {
  const [clients, sites] = await Promise.all([storage.getAllClients(), storage.getAllSites()]);
  const perClient = await Promise.all(clients.map((client) => storage.getFindingsByClient(client.id)));
  return summarizeFindings({ clients, sites, findings: perClient.flat() });
}
