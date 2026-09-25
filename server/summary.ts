/**
 * What the assistant is told about this deployment.
 *
 * Lifted out of routes.ts unchanged so the benchmark in tools/assistant-bench
 * measures the context the product actually sends. A copy would drift, and a
 * benchmark measuring a context nothing uses is worse than no benchmark: it
 * would report a number for something that does not exist.
 */

import { storage } from "./storage-unified";
import { readScan, type ScanReading } from "@shared/latest-scans";

/**
 * One completed test's findings, as the assistant is told them: from the
 * whole record (shared/latest-scans.ts readScan), never a 0 the record does
 * not hold. A test recorded "Severity: Critical, Total Vulnerabilities: 2"
 * with the counts left at 0 was told as "0 critical / 0 high / 0 medium / 0
 * low", and asked "any criticals?" the assistant answered from that.
 */
export function describeCounts(read: ScanReading): string {
  if (read.countsNotRecorded) return "counts not recorded";
  const { critical, high, medium, low } = read.counts;
  const counted = critical + high + medium + low;
  if (counted === 0 && read.ratedNotCounted) {
    return read.total > 0
      ? `${read.total} found, rated ${read.ratedNotCounted}, not broken down by severity`
      : `rated ${read.ratedNotCounted}, no count recorded`;
  }
  if (counted === 0 && read.unrated > 0) {
    return `${read.total} found, ${read.unrated === read.total ? "no severity recorded" : `${read.unrated} with no severity recorded`}`;
  }
  if (counted === 0 && read.severity === "info") return `${read.total} found, all rated info`;
  return `${critical} critical / ${high} high / ${medium} medium / ${low} low`
    + (read.ratedNotCounted ? `, rated ${read.ratedNotCounted} with no ${read.ratedNotCounted} count recorded` : "")
    + (read.unrated > 0 ? `, and ${read.unrated} more with no severity recorded` : "");
}

/**
 * What the assistant is told about this deployment.
 *
 * Deliberately structural: how many clients, sites and tests exist, what the
 * sites are called, and the severity counts already on the record. Not the
 * bodies of findings, not documents, not anything from the audit log.
 *
 * The reason is that this leaves the machine. An operator who points
 * ATHENA_ASSISTANT_URL at a hosted provider is sending whatever is in here to
 * a third party, and in a product whose subject matter is other companies'
 * vulnerabilities the smallest useful context is the right one. The chat
 * screen says so in a line above the composer, because a disclosure nobody
 * reads is not a disclosure.
 */
export async function deploymentSummary(): Promise<string> {
  const [clients, sites, tests] = await Promise.all([
    storage.getAllClients(), storage.getAllSites(), storage.getAllTests(),
  ]);

  const totals = tests.reduce(
    (acc, test) => ({
      critical: acc.critical + test.criticalCount,
      high: acc.high + test.highCount,
      medium: acc.medium + test.mediumCount,
      low: acc.low + test.lowCount,
    }),
    { critical: 0, high: 0, medium: 0, low: 0 },
  );

  // Counts nobody took are not handed to the model as zeros: a test still
  // running has none yet, and an engine scan finished before the inline-count
  // fix returned results whose counts were never written down
  // (shared/latest-scans.ts). Told "0 critical", the assistant repeats it.
  // Nor is a test whose rating or results no count breaks down: the totals
  // say they leave those out.
  const reads = tests.filter((test) => test.status === "completed").map((test) => readScan(test));
  const unrecorded = reads.filter((read) => read.countsNotRecorded).length;
  const ratedOut = reads.filter((read) => !read.countsNotRecorded && read.ratedNotCounted !== null).length;
  const unratedOut = reads.filter((read) => !read.countsNotRecorded && read.unrated > 0).length;
  const recent = tests
    .slice()
    .sort((a, b) => Number(new Date(b.startedAt)) - Number(new Date(a.startedAt)))
    .slice(0, 8)
    .map((test) => {
      const site = sites.find((one) => one.id === test.siteId);
      const counts = test.status !== "completed" ? "no counts until it completes" : describeCounts(readScan(test));
      return `- ${test.testType} on ${site?.name ?? "an unnamed site"}: ${test.status}, ${counts}`;
    });

  return [
    `${clients.length} clients, ${sites.length} sites, ${tests.length} tests recorded.`,
    `Across all tests: ${totals.critical} critical, ${totals.high} high, `
      + `${totals.medium} medium, ${totals.low} low.`
      + (unrecorded > 0 ? ` Counts were not recorded for ${unrecorded} completed scan${unrecorded === 1 ? "" : "s"}, so these totals leave them out.` : "")
      + (ratedOut > 0 ? ` ${ratedOut} test${ratedOut === 1 ? " was" : "s were"} rated with no count at ${ratedOut === 1 ? "its" : "their"} rating, which these totals leave out.` : "")
      + (unratedOut > 0 ? ` ${unratedOut} test${unratedOut === 1 ? "" : "s"} reported results with no severity recorded, which these totals leave out.` : ""),
    recent.length ? "Most recent tests:" : "No tests have been recorded yet.",
    ...recent,
  ].join("\n");
}
