/**
 * The shape of GET /api/findings/summary, shared by the server that computes
 * it (server/findings-summary.ts) and the screens that draw it.
 */
/**
 * Worst first. "unrated" is a finding with no severity recorded, or one that is
 * no rating: it may be critical, so it ranks above info and is never counted
 * as info -- which says "not a risk" -- as it was.
 */
export const SUMMARY_SEVERITIES = ["critical", "high", "medium", "low", "unrated", "info"] as const;
export type SummarySeverity = (typeof SUMMARY_SEVERITIES)[number];

/**
 * The finding statuses that count as open: the issue is still there and
 * nobody has settled it.
 *
 * "acknowledged" is here. It means a person has looked and it is in review --
 * an opinion about progress, not about the customer's system -- and counting
 * it as closed let a scan's critical, once acknowledged, drop out of every
 * open total while the screens said nothing needed attention. What is NOT
 * open: "fixed", which only a retest the engine answered `closed` may set,
 * and "accepted", a named person's recorded decision to carry the risk (a
 * rescan leaves it accepted; a retest that finds it again reopens it). The
 * screens that give an all-clear say that accepted risks and verified fixes
 * are not counted in it.
 */
export const OPEN_FINDING_STATUSES = ["open", "acknowledged"] as const;

/** Whether a finding with this status is open (see OPEN_FINDING_STATUSES). */
export function isOpenStatus(status: string | null | undefined): boolean {
  return (OPEN_FINDING_STATUSES as readonly string[]).includes(status ?? "");
}

export interface FindingsSummary {
  /** How many engagements' findings this covers: every client on record. */
  clients: number;
  /**
   * Open findings: status "open" or "acknowledged" (in review) -- not
   * accepted or fixed. See OPEN_FINDING_STATUSES.
   */
  open: Record<SummarySeverity | "total", number>;
  /**
   * Open findings by the environment of the site each was recorded on, most
   * first. `environment` is null when the finding has no site on record.
   */
  byEnvironment: Array<{ environment: string | null; open: number }>;
  /**
   * Every finding, whatever its status, by the UTC month ("YYYY-MM") it was
   * first seen, one count per severity (info is not charted). Months between
   * the first and the latest are present with zeros -- a month with no new
   * findings is a measurement -- and the window is the latest twelve.
   */
  byMonth: Array<{
    month: string; critical: number; high: number; medium: number; low: number;
    /** Findings with no severity recorded, counted by month; the chart does not draw them, and says how many. */
    unrated: number;
  }>;
  /** The worst open findings: by severity, then the most recently seen. */
  topOpen: Array<{
    id: string;
    clientId: string;
    clientName: string;
    type: string;
    severity: SummarySeverity;
    message: string | null;
    lastSeenAt: string;
  }>;
  /**
   * Every client's open findings: how many, how many critical and high, and
   * when a critical or high one was last seen (null when there is none).
   *
   * Findings are lifecycle rows, which only the engine's scans file. So each
   * client also carries the critical and high results of its latest completed
   * tests -- one per site (see shared/latest-scans.ts) -- that no finding row
   * stands behind: all of them for a scan a person recorded on the Tests
   * screen, and the shortfall for a scan that filed fewer critical or high
   * findings than it reported. Those are what the scans reported, not open
   * findings: nothing tracks whether they were fixed, so a screen must neither
   * add them into the open totals nor clear the client while they stand. It
   * also carries the scans rated critical or high with no count at that
   * severity, and results with no severity recorded: how many of those are
   * critical or high is not on record, so they are never read as tracked.
   * null when there are none.
   */
  byClient: Array<{
    clientId: string;
    open: number;
    critical: number;
    high: number;
    latestSeriousSeenAt: string | null;
    untrackedScan: UntrackedScan | null;
  }>;
}

/**
 * Critical and high results of a client's latest completed tests (one per
 * site) that no finding row stands behind, added up over those tests -- and
 * what those tests' records leave unknown at critical and high.
 */
export interface UntrackedScan {
  /** The most recently completed of those tests. */
  testId: string;
  /** When it completed (ISO), or null when no completion time is recorded. */
  completedAt: string | null;
  /** Critical results reported and not filed as critical findings, over every such test. */
  critical: number;
  /** High results reported and not filed as high findings, over every such test. */
  high: number;
  /**
   * How many of those tests are rated critical or high and count nothing at
   * that severity. Each is taken as at least one result at its rating, so
   * `critical` and `high` are then a floor, not a count.
   */
  ratedNotCounted: number;
  /** Results those tests reported with no severity recorded: any may be critical or high. */
  unrated: number;
  /** How many of the client's latest completed tests (one per site) have any. */
  scans: number;
}

/**
 * What an UntrackedScan says, in words, after "reported": "3 critical / 5 high
 * that are not tracked as findings", "at least 1 critical / 0 high ... (rated,
 * not counted by severity)", "4 results with no severity recorded ...".
 */
export function untrackedResults(scan: UntrackedScan): string {
  const rated = scan.ratedNotCounted ?? 0;
  const unrated = scan.unrated ?? 0;
  const parts: string[] = [];
  if (scan.critical + scan.high > 0) {
    parts.push(
      `${rated > 0 ? "at least " : ""}${scan.critical} critical / ${scan.high} high that are not tracked as findings`
        + (rated > 0 ? ` (rated, not counted by severity${(scan.scans ?? 1) > 1 ? `: ${rated} of those scans` : ""})` : ""),
    );
  } else if (rated > 0) {
    // The floor a rating stands for is filed, and how many more stand behind
    // it is not on record: no "0 critical / 0 high" the record never counted.
    parts.push(
      `results rated critical or high that no count breaks down${(scan.scans ?? 1) > 1 ? ` (${rated} of those scans)` : ""}, so whether every one is tracked as a finding is not known`,
    );
  }
  if (unrated > 0) {
    parts.push(
      `${unrated} result${unrated === 1 ? "" : "s"} with no severity recorded, so whether ${unrated === 1 ? "it is" : "any is"} critical or high is not known`,
    );
  }
  return parts.join(", and ");
}
