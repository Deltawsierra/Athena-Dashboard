import { describe, it, expect } from "vitest";

import { readScan, reportedSeverity } from "../shared/latest-scans";
import { reportedSerious, summarizeFindings } from "../server/findings-summary";
import { untrackedResults } from "../shared/findings-summary";

/**
 * PR #52 round 5. Round 4 made the Deployments band the worse of a test's
 * severity field and its counts, but the findings summary, the assistant's
 * context and the Evidence card went on reading the critical and high counts
 * alone. The Tests screen records "Severity" and "Total Vulnerabilities" apart
 * from the per-severity counts, so a pentest recorded "Severity: Critical,
 * Total Vulnerabilities: 2" (counts left at 0) read there as no critical, and
 * one recorded "Total Vulnerabilities: 4" alone as no critical or high.
 *
 * Every reader now goes through one whole-record reader, readScan. These pin
 * what it reads a record as. Adapted from the round-5 reproducers R5-D..R5-G
 * and R5-J and the killer for mutant L03.
 */
const zero = { status: "completed", findings: null, vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
const test = (over: Record<string, unknown>) => ({ ...zero, severity: null, ...over }) as Parameters<typeof readScan>[0];

describe("a test's record is read whole", () => {
  it("a severity recorded in any case is that severity (L03)", () => {
    const counts = { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
    expect(reportedSeverity({ ...counts, severity: "Critical" })).toBe("critical");
    expect(reportedSeverity({ ...counts, severity: "HIGH" })).toBe("high");
    expect(readScan(test({ severity: " Medium ", vulnerabilitiesFound: 1 })).severity).toBe("medium");
    expect(readScan(test({ severity: "Critical", vulnerabilitiesFound: 2 })).ratedNotCounted).toBe("critical");
  });

  it("a rating with no count behind it is rated, not counted -- never none", () => {
    const read = readScan(test({ severity: "critical", vulnerabilitiesFound: 2 }));
    expect(read).toEqual({
      countsNotRecorded: false, severity: "critical", total: 2,
      counts: { critical: 0, high: 0, medium: 0, low: 0 }, ratedNotCounted: "critical", unrated: 0,
    });
    // Rated critical with no total either: still rated.
    expect(readScan(test({ severity: "critical" }))).toMatchObject({ severity: "critical", total: 0, ratedNotCounted: "critical" });
    // A rating its count stands behind is a breakdown.
    expect(readScan(test({ severity: "high", highCount: 2, vulnerabilitiesFound: 2 })).ratedNotCounted).toBeNull();
  });

  it("a total nobody rated is unrated, and a rating bounds what the counts leave out", () => {
    expect(readScan(test({ vulnerabilitiesFound: 4 }))).toMatchObject({ severity: null, total: 4, unrated: 4 });
    expect(readScan(test({ vulnerabilitiesFound: 4, criticalCount: 1 }))).toMatchObject({ severity: "critical", total: 4, unrated: 3 });
    expect(readScan(test({ severity: "medium", vulnerabilitiesFound: 4, mediumCount: 1 }))).toMatchObject({ unrated: 0 });
  });

  it("an engine scan's results carry their own severities", () => {
    const run = (results: unknown[], over: Record<string, unknown> = {}) =>
      readScan(test({ findings: { runId: "r", target: "https://a.example/", results }, ...over }));
    // Every result rated info: informational -- with the severity countSeverities
    // now records, and read the same off a row written before it did.
    const info = [{ type: "banner", severity: "info" }, { type: "tls", severity: "INFO" }];
    expect(run(info, { vulnerabilitiesFound: 2, severity: "info" })).toMatchObject({ severity: "info", unrated: 0 });
    expect(run(info, { vulnerabilitiesFound: 2 })).toMatchObject({ severity: "info", unrated: 0 });
    // Info beside a counted severity: the counted one, and nothing unrated.
    expect(run([...info, { type: "xss", severity: "high" }], { vulnerabilitiesFound: 3, highCount: 1, severity: "high" }))
      .toMatchObject({ severity: "high", unrated: 0, ratedNotCounted: null });
    // A result with no severity is unrated, whatever else was rated.
    expect(run([{ type: "odd" }, { type: "banner", severity: "info" }], { vulnerabilitiesFound: 2 }))
      .toMatchObject({ severity: null, unrated: 1 });
    // The engine's own diagnostics are not results.
    expect(run([{ type: "probe", internal: true }], {})).toMatchObject({ severity: null, unrated: 0, countsNotRecorded: false });
    // Results with every count zero: not recorded, not zero.
    expect(run([{ type: "sqli", severity: "critical" }]).countsNotRecorded).toBe(true);
  });

  it("what the summary counts at critical and high: a rating is at least one, unrated results are carried", () => {
    const base = { id: "t", clientId: "c1", siteId: "s1", startedAt: null, completedAt: null };
    expect(reportedSerious({ ...base, ...test({ severity: "Critical", vulnerabilitiesFound: 2 }) } as never))
      .toEqual({ critical: 1, high: 0, ratedNotCounted: true, unrated: 0 });
    expect(reportedSerious({ ...base, ...test({ severity: "high", vulnerabilitiesFound: 3, criticalCount: 1 }) } as never))
      .toEqual({ critical: 1, high: 1, ratedNotCounted: true, unrated: 0 });
    expect(reportedSerious({ ...base, ...test({ vulnerabilitiesFound: 4 }) } as never))
      .toEqual({ critical: 0, high: 0, ratedNotCounted: false, unrated: 4 });
    // Rated medium with no count: no critical or high is implied.
    expect(reportedSerious({ ...base, ...test({ severity: "medium", vulnerabilitiesFound: 4 }) } as never))
      .toEqual({ critical: 0, high: 0, ratedNotCounted: false, unrated: 0 });
  });

  it("an engine scan whose counts were never recorded carries its results that nobody rated", () => {
    const base = { id: "t", clientId: "c1", siteId: "s1", startedAt: null, completedAt: null };
    const legacy = { ...base, ...test({ findings: { runId: "r", target: "https://a.example/", results: [
      { type: "odd", endpoint: "/a" }, { type: "xss", endpoint: "/b", severity: "high" },
    ] } }) };
    expect(reportedSerious(legacy as never)).toEqual({ critical: 0, high: 1, ratedNotCounted: false, unrated: 1 });
    const onlyUnrated = { ...legacy, findings: { runId: "r", target: "https://a.example/", results: [{ type: "odd", endpoint: "/a" }] } };
    const summary = summarizeFindings({
      clients: [{ id: "c1", name: "Acme" }], sites: [], findings: [], tests: [onlyUnrated] as never,
    });
    expect(summary.byClient[0].untrackedScan).toMatchObject({ critical: 0, high: 0, ratedNotCounted: 0, unrated: 1 });
  });

  it("a rating is never read as tracked, even once a finding stands behind the one result it implies", () => {
    // Rated critical, 2 found, no counts; one critical finding filed from it.
    // How many of the two are critical is not on record, so the other is not
    // shown to be tracked -- and no "0 critical / 0 high" is said of it.
    const rated = { id: "t", clientId: "c1", siteId: "s1", startedAt: null, completedAt: "2026-09-01T10:00:00.000Z",
      ...test({ severity: "critical", vulnerabilitiesFound: 2 }) };
    const summary = summarizeFindings({
      clients: [{ id: "c1", name: "Acme" }], sites: [], findings: [], tests: [rated] as never,
      filed: new Map([["t", { critical: 1, high: 0 }]]),
    });
    const untracked = summary.byClient[0].untrackedScan;
    expect(untracked).toMatchObject({ critical: 0, high: 0, ratedNotCounted: 1, unrated: 0, scans: 1 });
    const said = untrackedResults(untracked!);
    expect(said).toBe("results rated critical or high that no count breaks down, so whether every one is tracked as a finding is not known");
    expect(said).not.toMatch(/0 critical/);
    // With a count still standing, the floor is said as a floor.
    expect(untrackedResults({ ...untracked!, critical: 1 }))
      .toBe("at least 1 critical / 0 high that are not tracked as findings (rated, not counted by severity)");
  });
});
