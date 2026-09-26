/**
 * The vocabulary the Athena scan page reads a live run in.
 *
 * There is no fixture here any more. The page renders a real scan dispatched to
 * the engine — its state, the findings it returned, and the severity counts
 * counted from those findings. What the engine does not report, the page does
 * not draw. These are the small, honest helpers that shape the real numbers:
 * the severity order the counts are read in, the four verbs of the hero rail,
 * and the risk band **derived** from the counts (not an invented score).
 */

import { ratingOf } from "@shared/latest-scans";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

/** The gradable severities, worst first — the order counts are read in. */
export const SEVERITY_ORDER: Exclude<Severity, "info">[] = ["critical", "high", "medium", "low"];

export const SEVERITY_LABEL: Record<Exclude<Severity, "info">, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** A result's rating as its badge reads it: a severity, or "unrated" when it has none. */
export type ResultLevel = Severity | "unrated";

/**
 * A result's severity from the engine, read as every other reader reads it
 * (shared/latest-scans.ts ratingOf: any case, surrounding space trimmed), or
 * "unrated" when it is missing or not a rating -- never info. Anything unknown
 * was badged "Info", which says "not a risk", beside a risk band that said the
 * same result was recorded with no severity and may be critical.
 */
export function severityToken(severity: unknown): ResultLevel {
  return ratingOf(severity) ?? "unrated";
}

/** The words a result's badge says. */
export const RESULT_LEVEL_LABEL: Record<ResultLevel, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
  unrated: "Not rated",
};

/** The colour a result's badge is drawn in: its severity's, or muted when it is not rated. */
export function levelTone(level: ResultLevel): string {
  return level === "unrated" ? "--muted-foreground" : `--sev-${level}`;
}

/** The four verbs of the pitch, used in the hero rail. */
export const SCAN_STAGES = ["Scan", "Analyze", "Evidence", "Deploy"] as const;

export type SeverityCounts = Record<Exclude<Severity, "info">, number>;

export type RiskBand = "Critical" | "Elevated" | "Moderate" | "Low" | "Clear";

/**
 * The deployment's risk band, **derived from the real finding counts** by the
 * worst severity present — not a fabricated 0–100 score. `Clear` means a
 * finished scan returned nothing gradable; it is only honest once the scan has
 * stopped, so the caller shows it only then.
 */
export function bandFromCounts(counts: SeverityCounts): RiskBand {
  if (counts.critical > 0) return "Critical";
  if (counts.high > 0) return "Elevated";
  if (counts.medium > 0) return "Moderate";
  if (counts.low > 0) return "Low";
  return "Clear";
}

/** The tone token for a risk band, so the pill's colour tracks the reading. */
export const RISK_BAND_TONE: Record<RiskBand, string> = {
  Critical: "sev-critical",
  Elevated: "sev-high",
  Moderate: "sev-medium",
  Low: "sev-low",
  Clear: "primary",
};
