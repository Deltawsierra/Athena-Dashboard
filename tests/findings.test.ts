import { describe, it, expect } from "vitest";

import {
  fingerprint, foldResults, ingest, nextStatus, sightingOf, statusFromVerdict,
  type Sighting,
} from "../server/findings";
import type { Finding } from "@shared/schema";

/**
 * The finding lifecycle. Two rules carry the weight and both are here.
 *
 * Identity is the place, not the payload -- the scanners try several payloads
 * against one endpoint, and a fingerprint that included them would file one
 * issue as many.
 *
 * And `fixed` is reachable only from a retest the engine answered `closed`.
 * Measured against a live engine, a target that is simply switched off answers
 * `inconclusive`; a lifecycle that treated that as a fix would report a host
 * going down as a vulnerability remediated.
 */

const place = (over: Partial<Sighting> = {}): Sighting => ({
  type: "json_injection", severity: "low", message: "JSON injection anomaly detected",
  target: "https://app.example", endpoint: null, header: null, ...over,
});

/** A store that behaves like the real one, in memory. */
function store() {
  const rows = new Map<string, Finding>();
  const sightings: Array<{ findingId: string; runId: string | null; seen: boolean }> = [];
  let next = 0;
  return {
    rows,
    sightings,
    async getFindingsByClient(clientId: string) {
      return Array.from(rows.values()).filter((one) => one.clientId === clientId);
    },
    async recordSighting(findingId: string, runId: string | null, _testId: string | null, seen: boolean) {
      const already = sightings.find((one) => one.findingId === findingId && one.runId === runId);
      if (already) { already.seen = seen; return; }
      sightings.push({ findingId, runId, seen });
    },
    async findFindingByFingerprint(clientId: string, fp: string) {
      // Keyed on the customer, as the real store is.
      return Array.from(rows.values()).find(
        (one) => one.clientId === clientId && one.fingerprint === fp,
      );
    },
    async createFinding(insert: Record<string, unknown>) {
      const now = new Date();
      const row = {
        id: `f${(next += 1)}`, siteId: null, severity: null, message: null,
        target: null, endpoint: null, header: null, status: "open", ownerId: null,
        statusNote: null, statusChangedBy: null, statusChangedAt: null,
        timesSeen: 1, lastTestId: null, lastRunId: null, fixedAt: null,
        fixedByRunId: null, fixedVerdict: null, reopenedAt: null, isSample: false,
        ...insert, firstSeenAt: now, lastSeenAt: now,
      } as unknown as Finding;
      rows.set(row.id, row);
      return row;
    },
    async updateFinding(id: string, patch: Partial<Finding>) {
      const existing = rows.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch, id } as Finding;
      rows.set(id, updated);
      return updated;
    },
  };
}

const context = {
  clientId: "c1", siteId: "s1", engagementRef: "c1:s1",
  target: "https://app.example", testId: "t1", runId: "run-1",
};

describe("what makes two sightings the same finding", () => {
  it("is the place and the customer, never the payload or the wording", () => {
    const one = fingerprint("c1", place({ endpoint: "https://app.example/api" }));
    const two = fingerprint("c1", place({
      endpoint: "https://app.example/api",
      // A different payload found it and the scanner worded it differently.
      // Same endpoint, same type: the same problem.
      message: "Server error with crafted JSON payload", severity: "medium",
    }));
    expect(one).toBe(two);

    // A different endpoint is a different problem.
    expect(fingerprint("c1", place({ endpoint: "https://app.example/api/v1" }))).not.toBe(one);
    // And a different customer is a different finding, with its own owner.
    expect(fingerprint("c2", place({ endpoint: "https://app.example/api" }))).not.toBe(one);
  });

  it("distinguishes one missing header from another", () => {
    // Five controls arrive under one finding type. Filing them as one would
    // say a site with no CSP has the same gap as one missing Referrer-Policy.
    const csp = fingerprint("c1", place({ type: "missing_security_header", header: "Content-Security-Policy" }));
    const ref = fingerprint("c1", place({ type: "missing_security_header", header: "Referrer-Policy" }));
    expect(csp).not.toBe(ref);
  });

  it("reads the place out of evidence, where the engine actually puts it", () => {
    // Measured: the pipeline moves a scanner's own fields into `evidence`
    // before the finding is returned.
    const seen = sightingOf(
      { type: "missing_security_header", severity: "low", evidence: { header: "Content-Security-Policy" } },
      "https://app.example",
    );
    expect(seen?.header).toBe("Content-Security-Policy");
    // The engine's own internal notes are not findings about the target.
    expect(sightingOf({ type: "error", internal: true }, "https://app.example")).toBeNull();
  });
});

describe("filing a scan's results", () => {
  it("folds repeats within one scan into a single finding", async () => {
    const db = store();
    // Four payloads landed on the same endpoint. That is one problem.
    const results = [
      { type: "json_injection", severity: "low", evidence: { endpoint: "https://app.example/api", payload: { a: 1 } } },
      { type: "json_injection", severity: "low", evidence: { endpoint: "https://app.example/api", payload: { b: 2 } } },
      { type: "json_injection", severity: "low", evidence: { endpoint: "https://app.example/api", payload: { c: 3 } } },
      { type: "json_injection", severity: "low", evidence: { endpoint: "https://app.example/api/v1", payload: { d: 4 } } },
      { type: "error", internal: true, details: "connection reset" },
    ];
    const filed = await ingest(db, results, context);
    expect(filed.raw).toBe(5);
    expect(filed.distinct).toBe(2);
    expect(filed.created).toBe(2);
    expect(db.rows.size).toBe(2);
  });

  // Round 3, F2. The fingerprint still excludes severity (pinned above: one
  // endpoint and type can arrive at different severities and is one issue).
  // What changed is the severity the folded issue is FILED at: it kept the
  // first sighting's, so a weak payload's "medium" followed by a confirmed
  // "critical" filed a medium -- the scan's record said 1 critical, the
  // ledger held none, and the screens cleared the client.
  it("files an issue seen at several severities in one scan once, at the worst of them", async () => {
    const db = store();
    const results = [
      { type: "sql_injection", severity: "medium", message: "SQL error with crafted payload", evidence: { endpoint: "https://app.example/login" } },
      { type: "sql_injection", severity: "Critical", message: "Time-based SQL injection confirmed", evidence: { endpoint: "https://app.example/login" } },
      { type: "sql_injection", severity: "high", message: "Boolean-based", evidence: { endpoint: "https://app.example/login" } },
    ];
    const filed = await ingest(db, results, context);
    expect(filed).toMatchObject({ raw: 3, distinct: 1, created: 1 });
    const row = Array.from(db.rows.values())[0];
    // Filed as the rating every reader reads it as (shared/latest-scans.ts ratingOf), not the engine's spelling:
    // "Critical" and " critical" are both critical, and a reader that did not normalise read one of them as info.
    expect(row.severity).toBe("critical");
    // The worst sighting's own words go with it.
    expect(row.message).toBe("Time-based SQL injection confirmed");
    // One sighting of one finding, as before.
    expect(db.sightings).toHaveLength(1);

    // And a later scan that sees it at two severities rescores it to that
    // scan's worst, not its first.
    await ingest(db, [results[0], results[2]], { ...context, testId: "t2", runId: "run-2" });
    expect(Array.from(db.rows.values())[0].severity).toBe("high");
  });

  it("says, per severity, how many results were repeats folded into another's finding", () => {
    const folded = foldResults([
      { type: "xss", severity: "high", evidence: { endpoint: "https://app.example/a" } },
      { type: "xss", severity: "critical", evidence: { endpoint: "https://app.example/a" } },
      { type: "xss", severity: "critical", evidence: { endpoint: "https://app.example/a" } },
      { type: "xss", severity: "critical", evidence: { endpoint: "https://app.example/b" } },
      // Untyped: counted on the test, never filed, so never a repeat.
      { severity: "critical" },
      { type: "error", internal: true, severity: "critical" },
    ], "c1", "https://app.example");
    expect(folded.raw).toBe(6);
    expect(folded.distinct.size).toBe(2);
    expect(folded.foldedAway).toEqual({ high: 1, critical: 1 });
  });

  it("recognises the same issue on a later scan instead of duplicating it", async () => {
    const db = store();
    const results = [
      { type: "json_injection", severity: "low", evidence: { endpoint: "https://app.example/api" } },
    ];
    await ingest(db, results, context);
    const again = await ingest(db, results, { ...context, testId: "t2", runId: "run-2" });

    expect(again.created).toBe(0);
    expect(again.updated).toBe(1);
    expect(db.rows.size).toBe(1);
    const row = Array.from(db.rows.values())[0];
    expect(row.timesSeen).toBe(2);
    expect(row.lastRunId).toBe("run-2");
  });

  it("reopens a finding the engine had closed, and drops the stale evidence", async () => {
    const db = store();
    const results = [
      { type: "json_injection", severity: "low", evidence: { endpoint: "https://app.example/api" } },
    ];
    await ingest(db, results, context);
    const id = Array.from(db.rows.keys())[0];
    await db.updateFinding(id, {
      status: "fixed", fixedAt: new Date(), fixedByRunId: "run-9", fixedVerdict: "closed",
    });

    const again = await ingest(db, results, { ...context, testId: "t3", runId: "run-3" });
    expect(again.reopened).toBe(1);

    const row = db.rows.get(id) as Finding;
    expect(row.status).toBe("open");
    expect(row.reopenedAt).not.toBeNull();
    // The evidence was real when it was taken and is out of date now. Keeping
    // it beside an open finding would suggest the fix still holds.
    expect(row.fixedByRunId).toBeNull();
    expect(row.fixedVerdict).toBeNull();
  });

  it("records what a run did not report, without treating it as a fix", async () => {
    // The case a client asks about: scanned in March, scanned again in June,
    // and one of March's findings did not come back. That is an observation,
    // not a verdict -- a scanner switched off produces the same silence -- so
    // it is recorded and the finding stays exactly as it was.
    const db = store();
    const march = [
      { type: "json_injection", severity: "low", evidence: { endpoint: "https://app.example/api" } },
      { type: "open_redirect", severity: "medium", evidence: { endpoint: "https://app.example/go" } },
    ];
    await ingest(db, march, context);
    expect(db.rows.size).toBe(2);

    // June: only one of them comes back.
    const june = await ingest(db, [march[0]], { ...context, testId: "t9", runId: "run-9" });
    expect(june.updated).toBe(1);
    expect(june.notSeen).toBe(1);

    const missing = Array.from(db.rows.values()).find((one) => one.type === "open_redirect") as Finding;
    // Recorded as not seen in that run...
    expect(db.sightings.filter((one) => one.runId === "run-9" && !one.seen))
      .toHaveLength(1);
    // ...and still open, because nothing proved it gone.
    expect(missing.status).toBe("open");
    expect(missing.fixedAt).toBeNull();
  });

  it("does not claim a run saw anything about a target it never went to", async () => {
    // A client with two sites, scanned on one. The other site's findings were
    // not observed at all, and saying "not seen" about them would be a claim
    // the run cannot support.
    const db = store();
    await ingest(db, [{ type: "ssrf", severity: "high", evidence: { endpoint: "https://one.example/x" } }],
      { ...context, target: "https://one.example" });
    const filed = await ingest(db, [{ type: "ssrf", severity: "high", evidence: { endpoint: "https://two.example/x" } }],
      { ...context, target: "https://two.example", testId: "t8", runId: "run-8" });

    expect(filed.created).toBe(1);
    expect(filed.notSeen).toBe(0);
  });

  it("leaves an accepted risk accepted when it is seen again", async () => {
    // Somebody decided that on purpose; a rescan is not new information about
    // the decision.
    const db = store();
    const results = [{ type: "open_redirect", severity: "medium", evidence: { endpoint: "https://app.example/go" } }];
    await ingest(db, results, context);
    const id = Array.from(db.rows.keys())[0];
    await db.updateFinding(id, { status: "accepted", statusNote: "behind an internal gateway" });

    await ingest(db, results, { ...context, testId: "t4", runId: "run-4" });
    expect((db.rows.get(id) as Finding).status).toBe("accepted");
  });
});

describe("what may close a finding", () => {
  it("closes only on the engine's own word for it", () => {
    expect(statusFromVerdict("closed", "open")).toMatchObject({ status: "fixed", fixed: true });
  });

  it("never closes on inconclusive, whatever the finding was", () => {
    // The measured case: a target that is simply switched off.
    for (const current of ["open", "acknowledged", "accepted"] as const) {
      const decided = statusFromVerdict("inconclusive", current);
      expect(decided.fixed).toBe(false);
      expect(decided.status).toBe(current);
      expect(decided.detail).toContain("nothing about this finding's status");
    }
  });

  it("treats a verdict it does not recognise as inconclusive, never as closed", () => {
    expect(statusFromVerdict("something_new", "open")).toMatchObject({ status: "open", fixed: false });
    expect(statusFromVerdict("", "open").fixed).toBe(false);
  });

  it("reopens an accepted finding the engine found again", () => {
    // Evidence outranks an opinion formed before the evidence.
    expect(statusFromVerdict("still_open", "accepted")).toMatchObject({ status: "open", fixed: false });
  });

  it("reopens a fixed finding when a later retest cannot confirm it", () => {
    expect(statusFromVerdict("inconclusive", "fixed").status).toBe("open");
    expect(nextStatus("fixed")).toMatchObject({ status: "open", outcome: "reopened" });
  });
});
