/**
 * Every authored sentence about Athena-Backend's record of a scan
 * (client/src/lib/backendRecordCopy.ts) and the hybrid's source labels
 * (client/src/lib/sourceLabels.ts) lints clean against the persona fence
 * (shared/persona-lint.ts): no verdict word about the target, no ship-or-hold,
 * no dramatization, no reassurance. The pinned sentences of plan section 11
 * and 14 are held to the letter: a run that did not finish has "No verdict:
 * the run did not finish."; the coverage line swaps to the record's words
 * once collected; a label names a source, never an era, a "world", "legacy"
 * or a promise about the backend.
 */
import { describe, expect, it } from "vitest";
import { lintMicrocopy } from "@shared/persona-lint";
import {
  COLLECTING, NOT_YET_IN_RECORD, NO_VERDICT_DID_NOT_FINISH, MIRRORED, NOT_MIRRORED, RECORD_PENDING_PILL, allBackendRecordStrings,
  engagementLine, recordPill,
  ADOPTED_FROM_RECORD, LAUNCH_ANSWER_AWAITED, NOT_LINKED_TO_CLIENT, NO_SCANS_RECORDED, RECORD_COULD_NOT_BE_READ, RECORD_NEEDS_SIGN_IN,
  SCANS_COULD_NOT_BE_READ, WINDOW_ENDED, adoptedLine, failedOnEngine, scanCountsLine, stoppedOnEngine, windowRemaining,
} from "@/lib/backendRecordCopy";
import {
  COVERAGE_RECORD_PENDING, COVERAGE_SOURCE, HYBRID_SOURCE, allSourceLabelStrings, coverageSourceFor, coverageSourceFromRecord,
} from "@/lib/sourceLabels";

describe("backend record copy: every authored string lints clean", () => {
  const strings = allBackendRecordStrings();

  it("has every string of the module on the list", () => {
    expect(strings.length).toBeGreaterThanOrEqual(70);
    expect(new Set(strings).size).toBe(strings.length);
  });

  for (const text of strings) {
    it(`is clean: ${JSON.stringify(text)}`, () => {
      expect(lintMicrocopy(text)).toEqual([]);
    });
  }

  it("says the three states in the pinned words, and never a verdict from silence", () => {
    expect(NOT_YET_IN_RECORD).toBe("Not yet in the Athena-Backend record for this run.");
    expect(COLLECTING).toBe("Athena-Backend is collecting this run's record.");
    expect(NO_VERDICT_DID_NOT_FINISH).toBe("No verdict: the run did not finish.");
    for (const text of strings) {
      expect(text).not.toMatch(/Clear|returned no (gradable )?findings|finished and returned/);
      expect(text).not.toMatch(/legacy|backend will record|deployment assurance|\bworld\b|\bera\b/i);
    }
  });

  it("reads the Stop's mirror as mirrored or not, and the Tests pill as the record's label or pending", () => {
    expect(MIRRORED).toBe("Stop mirrored to the backend record.");
    expect(NOT_MIRRORED).toBe("Stop not mirrored to the backend record.");
    expect(RECORD_PENDING_PILL).toBe("Backend record: pending");
    expect(recordPill("Ready")).toBe("Backend record: Ready");
    expect(recordPill("stopped")).toBe("Backend record: stopped");
  });

  it("says what the Engagements page says in the pinned words: a count from rows, an unread list as unread, never none", () => {
    expect(NO_SCANS_RECORDED).toBe("No scans recorded for this engagement.");
    expect(SCANS_COULD_NOT_BE_READ).toBe("The record's scans could not be read");
    expect(RECORD_COULD_NOT_BE_READ).toBe("The record could not be read");
    expect(RECORD_NEEDS_SIGN_IN).toMatch(/^Sign in to Athena-Backend to read its record/);
    expect(scanCountsLine(3, [["pending", 2], ["completed", 1]])).toBe("3 scans in the record · pending 2 · completed 1");
    expect(scanCountsLine(1, [["completed", 1]])).toBe("1 scan in the record · completed 1");
    expect(WINDOW_ENDED).toBe("Window ended");
    expect(windowRemaining(1)).toBe("1 day remaining");
    expect(windowRemaining(30)).toBe("30 days remaining");
    expect(LAUNCH_ANSWER_AWAITED).toBe("The launch's answer is still awaited: the engine has not named this scan's run.");
    expect(stoppedOnEngine("stopped by an operator")).toBe("Stopped on the engine: stopped by an operator");
    expect(failedOnEngine(null)).toBe("Failed on the engine: no detail recorded");
    expect(adoptedLine(2, 0)).toBe("Adopted 2 scans from the record into this dashboard.");
    expect(adoptedLine(0, 0)).toBe("Every scan the record lists has its row in this dashboard.");
    expect(adoptedLine(25, 3)).toBe("Adopted 25 scans from the record into this dashboard. 3 more await the next sync.");
    // By source, never "legacy": a row this dashboard made is said to be recorded by it directly from the engine, and an
    // adopted row to be adopted from the record; an engagement no client here names is said to be not linked, not nothing.
    expect(NOT_LINKED_TO_CLIENT).toBe("Not linked to a dashboard client");
    expect(ADOPTED_FROM_RECORD).toBe("Adopted from the Athena-Backend record; not started from this dashboard");
    for (const text of strings) expect(text).not.toMatch(/\bnone\b.*could not be read|could not be read.*\bnone\b/i);
  });

  it("names the engagement as the plan pins it: id, deployment name, host", () => {
    expect(engagementLine(7, "Acme shop", "acme.example")).toBe("Backend engagement #7 · deployment Acme shop · acme.example");
    expect(engagementLine(7, "Acme shop", null)).toBe("Backend engagement #7 · deployment Acme shop");
    expect(engagementLine(null, null, "acme.example")).toBe("Backend engagement #? · deployment unnamed · acme.example");
  });
});

describe("the hybrid's source labels: by source, and swapped by the record's state", () => {
  const strings = allSourceLabelStrings();

  for (const text of strings) {
    it(`is clean: ${JSON.stringify(text)}`, () => {
      expect(lintMicrocopy(text)).toEqual([]);
    });
  }

  it("names the hybrid's two sources, never an era or a promise", () => {
    expect(HYBRID_SOURCE).toBe(
      "Started through Athena-Backend; the live view is read directly from the engine, and the record of this scan is Athena-Backend's",
    );
    for (const text of strings) expect(text).not.toMatch(/legacy|backend will record|deployment assurance|\bworld\b|\bera\b/i);
  });

  it("keeps PR #74's direct line, with the note that the record is not collected yet, and swaps to the record's words once it is", () => {
    expect(coverageSourceFor(null)).toEqual({ source: COVERAGE_SOURCE, note: null });
    expect(coverageSourceFor(undefined)).toEqual({ source: COVERAGE_SOURCE, note: null });
    expect(coverageSourceFor({ collected: null, engineRunId: null })).toEqual({ source: COVERAGE_SOURCE, note: COVERAGE_RECORD_PENDING });
    expect(coverageSourceFor({ collected: false, engineRunId: "run-1" })).toEqual({ source: COVERAGE_SOURCE, note: COVERAGE_RECORD_PENDING });
    expect(COVERAGE_RECORD_PENDING).toBe("Not yet in the Athena-Backend record.");
    expect(coverageSourceFor({ collected: true, engineRunId: "run-1" })).toEqual({ source: "From the Athena-Backend record of this scan, engine run run-1.", note: null });
    expect(coverageSourceFromRecord(null)).toBe("From the Athena-Backend record of this scan.");
  });
});
