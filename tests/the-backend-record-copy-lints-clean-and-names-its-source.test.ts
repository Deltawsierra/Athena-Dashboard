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
} from "@/lib/backendRecordCopy";
import {
  COVERAGE_RECORD_PENDING, COVERAGE_SOURCE, HYBRID_SOURCE, allSourceLabelStrings, coverageSourceFor, coverageSourceFromRecord,
} from "@/lib/sourceLabels";

describe("backend record copy: every authored string lints clean", () => {
  const strings = allBackendRecordStrings();

  it("has every string of the module on the list", () => {
    expect(strings.length).toBeGreaterThanOrEqual(20);
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
