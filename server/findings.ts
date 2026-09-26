/**
 * A finding's life: identity, ownership, and how it is allowed to end.
 *
 * Until now a finding existed only inside a scan's `findings` blob. Rescanning
 * a host produced a second unrelated copy of the same issue, nobody owned
 * anything, and there was no way to ask what was still open. Three scans of one
 * host meant three sets of rows and no continuity between them.
 *
 * TWO RULES CARRY THE WEIGHT.
 *
 * Identity is the place, not the payload. The scanners try several payloads
 * against one endpoint; a fingerprint that included the payload would file one
 * issue as many, which is the duplication this exists to end. Measured against
 * a real scan: sixteen findings over one small host, whose distinguishing
 * fields were the endpoint (api_fuzz, json_injection) or the header name
 * (missing_security_header) -- never the payload, which varied within a single
 * issue.
 *
 * And `fixed` is not a label anybody may apply. It is a claim about the
 * customer's system, and only a retest the engine answered `closed` may make
 * it. `inconclusive` -- which is what the engine says when a target is simply
 * unreachable -- explicitly does not close anything. A person may say a risk
 * is accepted or that they have looked at something; those are opinions and
 * are stored as opinions, under their name. Letting a human mark something
 * fixed would rebuild, in the one place it matters most, the failure the rest
 * of this product spent its time removing: a state that looks verified and is
 * only asserted.
 */

import { createHash } from "node:crypto";

import { isEngineInternal } from "@shared/engine-internal";
import { ratingOf } from "@shared/latest-scans";
import type { Finding } from "@shared/schema";

/** A finding as it comes off a scan result, with where it came from. */
export interface Sighting {
  type: string;
  severity: string | null;
  message: string | null;
  target: string | null;
  endpoint: string | null;
  header: string | null;
}

/**
 * Read one engine finding into a sighting.
 *
 * The engine's pipeline moves a scanner's own fields into `evidence` before
 * the finding is returned -- measured, not assumed; reading only the top level
 * is what made every missing-header finding unattributable in the compliance
 * map. Both places are read, evidence first.
 */
export function sightingOf(raw: Record<string, unknown>, target: string | null): Sighting | null {
  // The engine's own diagnostic, by the rule the counts use (shared/engine-internal).
  if (isEngineInternal(raw.internal)) return null;
  const type = typeof raw.type === "string" ? raw.type : null;
  if (!type) return null;

  const evidence = (raw.evidence ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | null => {
    if (typeof evidence[key] === "string") return evidence[key] as string;
    if (typeof raw[key] === "string") return raw[key] as string;
    return null;
  };

  return {
    type,
    // A rating is filed as the word every reader reads it as (shared/latest-scans.ts
    // ratingOf): " high" and "HIGH" are high. Filed as sent, " high" was a finding
    // the ledger read as info beside a test whose counts said high. A word that
    // is no rating is kept as the engine sent it.
    severity: typeof raw.severity === "string" ? ratingOf(raw.severity) ?? raw.severity : null,
    message: typeof raw.message === "string" ? raw.message : null,
    target,
    endpoint: pick("endpoint"),
    header: pick("header"),
  };
}

/**
 * What makes two sightings the same finding.
 *
 * The customer, the type, and the place -- the endpoint if there is one, the
 * header if it is a header finding, the target otherwise. Never the payload,
 * the severity or the message: a scanner that words its message differently on
 * a later run has not found a different problem, and a severity that moves
 * because the model was retrained has not either.
 *
 * `scope` is the client, deliberately, not the engagement reference. Scanning
 * a host with the site named and again without it produces two different
 * engagement strings for one customer, and scoping on those filed the same
 * issue twice -- the exact duplication this is here to end. The place already
 * separates one site from another, because different sites are different
 * hosts. Which engagement last saw a finding is recorded on the row; it is
 * not part of what the finding is.
 */
export function fingerprint(scope: string, sighting: Sighting): string {
  const place = sighting.endpoint ?? sighting.header ?? sighting.target ?? "";
  return createHash("sha256")
    // Joined on NUL, written as an escape rather than a literal so the file
    // stays text. A delimiter that cannot occur in a type or a URL is what
    // stops one pair concatenating into another's fingerprint.
    .update([scope, sighting.type, place].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Worst first. When one issue arrives at several severities within a scan --
 * a weak payload reads "medium", a confirmed one "critical", at the same
 * endpoint -- it is filed once, at the worst. A severity that is missing or no
 * rating ranks below low and ABOVE info: it may be critical, so it is never
 * folded into an info sighting of the same issue. It ranked below everything,
 * and an issue seen rated info and unrated at one place was filed as info.
 */
const SEVERITY_RANK = ["critical", "high", "medium", "low", "info"];
function severityRank(severity: string | null): number {
  const at = SEVERITY_RANK.indexOf(ratingOf(severity) ?? "");
  return at === -1 ? SEVERITY_RANK.indexOf("info") - 0.5 : at;
}

/** A scan's results folded into the issues they are, as ingest files them. */
export interface FoldedResults {
  /** One sighting per fingerprint, carrying the worst severity any of its results had. */
  distinct: Map<string, Sighting>;
  /** Every result that was an object at all. */
  raw: number;
  /**
   * Per lower-cased severity, how many typed results were folded into another
   * result's finding: the repeats. A test's recorded counts include them (they
   * are counted per result), and the finding ledger, by design, does not.
   */
  foldedAway: Record<string, number>;
}

/**
 * Fold a scan's results into distinct issues. The one place that decides it:
 * ingest files what this returns, and the findings summary uses the same fold
 * to tell a test's repeats from results that were never filed.
 */
export function foldResults(results: unknown[], scope: string, target: string | null): FoldedResults {
  const distinct = new Map<string, Sighting>();
  const typed: Record<string, number> = {};
  let raw = 0;
  for (const one of results) {
    if (!one || typeof one !== "object") continue;
    raw += 1;
    const sighting = sightingOf(one as Record<string, unknown>, target);
    if (!sighting) continue;
    const severity = (sighting.severity ?? "").toLowerCase();
    typed[severity] = (typed[severity] ?? 0) + 1;
    const key = fingerprint(scope, sighting);
    const kept = distinct.get(key);
    // Keep the worst. They are the same issue, and the fields that differ
    // between them (payload, wording) are not part of what it is -- but how
    // bad it is is: filing the first of a medium and a critical at one place
    // as "medium" left a scan that reported a critical with no critical
    // finding anywhere, and the screens clearing the client. The worst
    // sighting's own wording goes with it, so the message describes the
    // severity filed. Ties keep the first.
    if (!kept || severityRank(sighting.severity) < severityRank(kept.severity)) distinct.set(key, sighting);
  }
  const foldedAway: Record<string, number> = { ...typed };
  for (const sighting of Array.from(distinct.values())) {
    const severity = (sighting.severity ?? "").toLowerCase();
    foldedAway[severity] -= 1;
  }
  return { distinct, raw, foldedAway };
}

export type SightingOutcome = "created" | "updated" | "reopened";

/**
 * What a fresh sighting means for a row that already exists.
 *
 * A finding the engine had verified fixed, seen again, is a regression: it
 * reopens and records when. Silently leaving it marked fixed because a person
 * once saw a `closed` verdict would be the worst of both -- the evidence was
 * real when it was taken, and it is out of date now.
 *
 * An accepted risk seen again stays accepted; somebody decided that on
 * purpose, and a rescan is not new information about the decision.
 */
export function nextStatus(current: Finding["status"]): {
  status: string;
  outcome: SightingOutcome;
} {
  if (current === "fixed") return { status: "open", outcome: "reopened" };
  return { status: current, outcome: "updated" };
}

export type RetestVerdict = "closed" | "still_open" | "inconclusive" | string;

/**
 * What a retest verdict does to a finding's status.
 *
 * Only `closed` closes. Measured against a live engine: a target that is
 * simply switched off answers `inconclusive`, and a lifecycle that treated
 * that as a fix would report a host going down as a vulnerability remediated.
 * An unrecognised verdict is treated as inconclusive, never as closed.
 */
export function statusFromVerdict(
  verdict: RetestVerdict,
  current: Finding["status"],
): { status: string; fixed: boolean; detail: string } {
  if (verdict === "closed") {
    return {
      status: "fixed",
      fixed: true,
      detail: "the engine went back to the target and the finding was gone",
    };
  }
  if (verdict === "still_open") {
    // A retest that found it again reopens an accepted or acknowledged one:
    // it is evidence, and evidence outranks an opinion formed before it.
    return {
      status: "open",
      fixed: false,
      detail: "the engine went back to the target and found it again",
    };
  }
  return {
    status: current === "fixed" ? "open" : current,
    fixed: false,
    detail:
      "the retest was inconclusive, so nothing about this finding's status " +
      "was established either way",
  };
}

/**
 * File a scan's results as findings, folding repeats into the rows they match.
 *
 * Returns what happened, counted rather than asserted, so the caller can say
 * "3 new, 12 seen again, 1 regression" instead of "scan complete".
 */
export interface IngestResult {
  created: number;
  updated: number;
  reopened: number;
  /** Distinct issues in this scan. Lower than the raw result count by design. */
  distinct: number;
  raw: number;
  /**
   * Findings already on record at this target that this run did NOT report.
   *
   * Recorded, and deliberately not acted on. A run that does not report
   * something is not a run that proved it gone: a scanner switched off, or a
   * scan that stopped early, produces exactly the same silence. It is shown as
   * its own thing so a client asking "is what you found in March gone?" gets
   * the observations rather than an inference, and only a retest verdict of
   * `closed` ever closes anything.
   */
  notSeen: number;
}

export interface IngestContext {
  clientId: string;
  siteId: string | null;
  engagementRef: string;
  target: string | null;
  testId: string;
  runId: string | null;
}

interface FindingStore {
  findFindingByFingerprint(
    clientId: string, fingerprint: string,
  ): Promise<Finding | undefined>;
  createFinding(finding: Record<string, unknown>): Promise<Finding>;
  updateFinding(id: string, patch: Partial<Finding>): Promise<Finding | undefined>;
  getFindingsByClient(clientId: string): Promise<Finding[]>;
  recordSighting(
    findingId: string, runId: string | null, testId: string | null, seen: boolean,
  ): Promise<void>;
}

export async function ingest(
  store: FindingStore,
  results: unknown[],
  context: IngestContext,
): Promise<IngestResult> {
  const result: IngestResult = {
    created: 0, updated: 0, reopened: 0, distinct: 0, raw: 0, notSeen: 0,
  };

  // Fold within the scan first. One scan reports the same endpoint several
  // times when several payloads land, and writing each one would defeat the
  // deduplication before it reached the database. Each issue is filed at the
  // worst severity it was reported at (see foldResults).
  const folded = foldResults(results, context.clientId, context.target);
  const bySignature = folded.distinct;
  result.raw = folded.raw;
  result.distinct = bySignature.size;

  const now = new Date();
  const seenIds = new Set<string>();

  for (const [key, sighting] of Array.from(bySignature.entries())) {
    const existing = await store.findFindingByFingerprint(context.clientId, key);

    if (!existing) {
      const made = await store.createFinding({
        fingerprint: key,
        clientId: context.clientId,
        siteId: context.siteId,
        engagementRef: context.engagementRef,
        type: sighting.type,
        severity: sighting.severity,
        message: sighting.message,
        target: sighting.target,
        endpoint: sighting.endpoint,
        header: sighting.header,
        status: "open",
        lastTestId: context.testId,
        lastRunId: context.runId,
      });
      await store.recordSighting(made.id, context.runId, context.testId, true);
      seenIds.add(made.id);
      result.created += 1;
      continue;
    }

    const { status, outcome } = nextStatus(existing.status);
    await store.updateFinding(existing.id, {
      status,
      lastSeenAt: now,
      timesSeen: existing.timesSeen + 1,
      lastTestId: context.testId,
      lastRunId: context.runId,
      // Which engagement last saw it. Not part of its identity, but worth
      // knowing when the same issue turns up under a narrower scope.
      engagementRef: context.engagementRef,
      siteId: context.siteId,
      // The current severity, because a rescored finding is the same finding.
      severity: sighting.severity,
      ...(outcome === "reopened"
        ? {
            // The evidence that closed it was real when it was taken and is
            // out of date now. Both facts are kept.
            reopenedAt: now,
            fixedAt: null,
            fixedByRunId: null,
            fixedVerdict: null,
          }
        : {}),
    });
    await store.recordSighting(existing.id, context.runId, context.testId, true);
    seenIds.add(existing.id);
    if (outcome === "reopened") result.reopened += 1;
    else result.updated += 1;
  }

  // And what this run did not report.
  //
  // Only findings at the target this run actually went to: a client with three
  // sites, scanned on one of them, has learned nothing about the other two,
  // and recording "not seen" against those would be a claim the run cannot
  // support. Same reasoning as the compliance map's `not_run`.
  if (context.target) {
    for (const other of await store.getFindingsByClient(context.clientId)) {
      if (seenIds.has(other.id)) continue;
      if (other.target !== context.target) continue;
      await store.recordSighting(other.id, context.runId, context.testId, false);
      result.notSeen += 1;
    }
  }

  return result;
}
