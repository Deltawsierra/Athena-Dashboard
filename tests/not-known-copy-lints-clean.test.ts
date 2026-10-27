/**
 * Every authored sentence the screens say about a scan whose run the engine
 * does not know (client/src/lib/notKnownCopy.ts) lints clean against the persona
 * fence (shared/persona-lint.ts): no verdict word about the target, no
 * ship-or-hold, no dramatization, no reassurance.
 *
 * And the copy never says what it exists to keep from being said: that such a
 * run ended, or returned a result. The reading says the status is unchanged
 * and the run may still be running; a recorded row says who recorded it, when,
 * and that the engine does not know the run -- never "Clear", never "finished
 * and returned no findings".
 */
import { describe, expect, it } from "vitest";
import { lintMicrocopy } from "@shared/persona-lint";
import {
  ASK_AN_ADMIN, NOT_KNOWN_BASIS, NOT_KNOWN_LABEL, RECORD_CONFIRM_BODY, STATUS_UNCHANGED, allNotKnownStrings, notKnownCount,
  notKnownSince, readingNote, recordedBy,
} from "@/lib/notKnownCopy";

describe("not-known copy: every authored string lints clean", () => {
  const strings = allNotKnownStrings();

  it("has every string of the module on the list", () => {
    expect(strings.length).toBeGreaterThanOrEqual(20);
    expect(new Set(strings).size).toBe(strings.length);
  });

  for (const text of strings) {
    it(`is clean: ${JSON.stringify(text)}`, () => {
      expect(lintMicrocopy(text)).toEqual([]);
    });
  }

  it("never reads as an end or a result the engine did not state", () => {
    for (const text of strings) {
      expect(text).not.toMatch(/Clear|returned no (gradable )?findings|finished and returned|\bcompleted\b/);
      // "ended" only as what the engine has NOT said.
      if (/\bended\b/.test(text)) expect(text).toBe(STATUS_UNCHANGED);
    }
  });

  it("says the reading in the plan's words: not known since, may still be running, the Stop and the kill switch, status unchanged", () => {
    expect(NOT_KNOWN_LABEL).toBe("Not known to the engine");
    expect(notKnownSince("t")).toBe(
      "Not known to the engine since t: it may still be running under another id. Stop sends the stop again; " +
      "the kill switch on the AI Control page sends it a stop by id.",
    );
    expect(STATUS_UNCHANGED).toBe("Its status is unchanged: the engine has not said it ended.");
    expect(readingNote("t")).toBe("Not known to the engine since t; its status is unchanged, and its Stop is sent as before.");
  });

  it("says a recorded row by who and when, and derives no band from it", () => {
    expect(recordedBy("ana", "t")).toBe("Recorded as not known to the engine by ana at t.");
    expect(recordedBy(null, "t")).toBe("Recorded as not known to the engine by a person whose name was not recorded at t.");
    expect(NOT_KNOWN_BASIS).toBe("The engine does not know this run, so no result and no band is derived from it.");
    expect(notKnownCount(2)).toBe("2 not known to the engine");
  });

  it("says the act sends the stop first and records only on the engine's word, and is a person's", () => {
    expect(RECORD_CONFIRM_BODY).toMatch(/^A stop is sent to the run first\. Only if the engine answers that it does not know the run/);
    expect(RECORD_CONFIRM_BODY).toContain("This is a person's act");
    expect(ASK_AN_ADMIN).toMatch(/^An admin can record it/);
  });
});
