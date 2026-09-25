/**
 * The shape of GET /api/findings/summary, shared by the server that computes
 * it (server/findings-summary.ts) and the screens that draw it.
 */
export const SUMMARY_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type SummarySeverity = (typeof SUMMARY_SEVERITIES)[number];

export interface FindingsSummary {
  /** How many engagements' findings this covers: every client on record. */
  clients: number;
  /** Findings whose status is "open" -- not acknowledged, accepted or fixed. */
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
  byMonth: Array<{ month: string; critical: number; high: number; medium: number; low: number }>;
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
   */
  byClient: Array<{
    clientId: string;
    open: number;
    critical: number;
    high: number;
    latestSeriousSeenAt: string | null;
  }>;
}
