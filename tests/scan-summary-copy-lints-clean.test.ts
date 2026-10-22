/**
 * Every authored sentence the scan screens say about a run that ended short
 * of completed lints clean against the persona fence (shared/persona-lint.ts):
 * no verdict word about the target (secure, safe, clean, pass, fail, no
 * issues...), no ship-or-hold, no dramatization, no reassurance. The charter
 * says the lint is a test, not a guideline; this is that test for the copy in
 * client/src/lib/scanSummaryCopy.ts.
 *
 * And the copy never says the one thing it exists to stop: that such a run
 * "finished and returned no findings", or is "Clear".
 */
import { describe, expect, it } from "vitest";
import { lintMicrocopy } from "@shared/persona-lint";
import { allScanSummaryStrings, endedState } from "@/lib/scanSummaryCopy";

describe("scan summary copy: every authored string lints clean", () => {
  const strings = allScanSummaryStrings();

  it("has every string of the module on the list", () => {
    expect(strings.length).toBeGreaterThanOrEqual(11);
    expect(new Set(strings).size).toBe(strings.length);
  });

  for (const text of strings) {
    it(`is clean: ${JSON.stringify(text)}`, () => {
      expect(lintMicrocopy(text)).toEqual([]);
    });
  }

  it("never reads as a result over a run that returned none", () => {
    for (const text of strings) {
      expect(text).not.toMatch(/Clear/);
      expect(text).not.toMatch(/returned no (gradable )?findings/);
      expect(text).not.toMatch(/finished and returned/);
    }
  });
});

describe("endedState: the states short of completed, and nothing else", () => {
  it.each(["aborted", "failed", "refused"])("%s ended short of completed", (state) => {
    expect(endedState(state)).toBe(state);
  });

  it.each(["completed", "running", "queued", "aborting", "unknown", "", undefined, null])(
    "%j did not", (state) => {
      expect(endedState(state as string | undefined | null)).toBeNull();
    },
  );
});
