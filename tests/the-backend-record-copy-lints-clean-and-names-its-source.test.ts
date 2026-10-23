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
  SCANS_COULD_NOT_BE_READ, WINDOW_ENDED, adoptionOutcomeLine, failedOnEngine, scanCountsLine, stoppedOnEngine, windowRemaining,
  RETEST_CHECK_ASKING, RETEST_CHECK_DIRECT_SCAN_REASON, RETEST_CHECK_RECORDED, RETEST_CHECK_STOPPED_ASKING, RETEST_CHECKS_NONE,
  retestCheckLine, retestCheckNotInRecord, retestCheckRecordLine, retestChecksCount,
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
    // The sync's outcome, from its own fields: "every scan has its row" only when nothing is left without one.
    const none = { adopted: 0, remaining: 0, awaitingRun: 0, detailUnread: 0, writeFailed: null };
    expect(adoptionOutcomeLine(none)).toBe("Every scan the record lists has its row in this dashboard.");
    expect(adoptionOutcomeLine({ ...none, adopted: 2 })).toBe("Adopted 2 scans from the record into this dashboard.");
    expect(adoptionOutcomeLine({ ...none, adopted: 25, remaining: 3 })).toBe("Adopted 25 scans from the record into this dashboard. 3 more await the next sync.");
    expect(adoptionOutcomeLine({ ...none, awaitingRun: 1 })).toBe("No scan was adopted this sync. 1 scan awaits the launch's answer and has no row here yet.");
    expect(adoptionOutcomeLine({ ...none, detailUnread: 2 })).toBe("No scan was adopted this sync. 2 finished scans could not be read now; each is adopted whole on the next sync.");
    expect(adoptionOutcomeLine({ ...none, writeFailed: "the database is locked" })).toBe("No scan was adopted this sync. A row could not be written: the database is locked; the scans after it wait for the next sync.");
    expect(adoptionOutcomeLine({ adopted: 1, remaining: 2, awaitingRun: 1, detailUnread: 1, writeFailed: "disk full" })).toBe(
      "Adopted 1 scan from the record into this dashboard. 1 scan awaits the launch's answer and has no row here yet. " +
      "1 finished scan could not be read now; it is adopted whole on the next sync. A row could not be written: disk full; the scans after it wait for the next sync. 2 more await the next sync.",
    );
    // By source, never "legacy": a row this dashboard made is said to be recorded by it directly from the engine, and an
    // adopted row to be adopted from the record; an engagement no client here names is said to be not linked, not nothing.
    expect(NOT_LINKED_TO_CLIENT).toBe("Not linked to a dashboard client");
    expect(ADOPTED_FROM_RECORD).toBe("Adopted from the Athena-Backend record; not started from this dashboard");
    for (const text of strings) expect(text).not.toMatch(/\bnone\b.*could not be read|could not be read.*\bnone\b/i);
  });

  it("says a retest check as what it is -- recorded, never closure evidence; not in the record with the backend's reason; being asked; no longer asked -- in the pinned words", () => {
    expect(RETEST_CHECK_RECORDED).toBe("Recorded in the Athena-Backend as a retest check (not closure evidence)");
    expect(retestCheckNotInRecord("the engine has no run rt-1 this backend can read")).toBe(
      "Not in the Athena-Backend record: the engine has no run rt-1 this backend can read",
    );
    expect(RETEST_CHECK_ASKING).toBe("Athena-Backend is being asked to record this retest check");
    expect(RETEST_CHECK_STOPPED_ASKING).toMatch(/^This dashboard stopped asking Athena-Backend to record this retest check/);
    // The line a view shows, by the server's state alone -- never a fifth guessed, and silence is "being asked".
    const base = {
      recorded: null, detail: "", reason: null, status: null, findingUuid: null, checkId: null, check: null, lastAnswer: null, lastAskedAt: null,
      lastReadError: null, startedAt: "2026-10-23T04:00:00.000Z", deadlineAt: "2026-10-23T05:00:00.000Z", endedAt: null, twinRunId: "run-1", backendScanId: "s1",
    } as const;
    expect(retestCheckRecordLine({ ...base, state: "asking" })).toBe(RETEST_CHECK_ASKING);
    expect(retestCheckRecordLine({ ...base, state: "recorded", recorded: true })).toBe(RETEST_CHECK_RECORDED);
    expect(retestCheckRecordLine({ ...base, state: "not_in_record", recorded: false, detail: "that scan is not in this record", status: 404 })).toBe(
      "Not in the Athena-Backend record: that scan is not in this record",
    );
    expect(retestCheckRecordLine({ ...base, state: "not_in_record", recorded: false, reason: "dashboard_direct", detail: "anything the server said" })).toBe(
      `Not in the Athena-Backend record: ${RETEST_CHECK_DIRECT_SCAN_REASON}`,
    );
    expect(retestCheckRecordLine({ ...base, state: "unwatched", recorded: false })).toBe(RETEST_CHECK_STOPPED_ASKING);
    // No string here calls a check closure evidence, or a verdict anything but the engine's word.
    for (const text of [RETEST_CHECK_RECORDED, RETEST_CHECK_ASKING, RETEST_CHECK_STOPPED_ASKING, RETEST_CHECK_DIRECT_SCAN_REASON]) {
      expect(text).not.toMatch(/\b(?:is|as) closure evidence\b|verified|fixed/i);
    }
    expect(retestChecksCount(1)).toBe("1 retest check");
    expect(retestChecksCount(3)).toBe("3 retest checks");
    expect(RETEST_CHECKS_NONE).toBe("None recorded");
    expect(retestCheckLine({ verdict: "closed", verdictKnown: true, state: "completed", engineCheckedAt: "2026-10-23T04:30:00+00:00" })).toBe(
      "closed · the run completed · checked by the engine at 2026-10-23T04:30:00+00:00",
    );
    expect(retestCheckLine({ verdict: "still_open", verdictKnown: true, state: "aborted", engineCheckedAt: null })).toBe(
      "still_open · the run ended stopped after its check was recorded · the engine's check time was not served",
    );
    expect(retestCheckLine({ verdict: "maybe", verdictKnown: false, state: null, engineCheckedAt: null })).toBe(
      "maybe (a verdict word the record does not know) · run state not served · the engine's check time was not served",
    );
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
