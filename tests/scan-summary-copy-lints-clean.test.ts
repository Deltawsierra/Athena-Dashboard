/**
 * Every authored sentence the scan screens say about a run that ended short
 * of completed (client/src/lib/scanSummaryCopy.ts) lints clean against the
 * persona fence (shared/persona-lint.ts): no verdict word about the target
 * (secure, safe, clean, pass, fail, no issues...), no ship-or-hold, no
 * dramatization, no reassurance. The charter says the lint is a test, not a
 * guideline; this is that test for this copy.
 *
 * And the copy never says the one thing it exists to stop: that such a run
 * "finished and returned no findings", or is "Clear".
 */
import { describe, expect, it } from "vitest";
import { lintMicrocopy } from "@shared/persona-lint";
import { allScanSummaryStrings, endedState, notFinished } from "@/lib/scanSummaryCopy";

describe("scan summary copy: every authored string lints clean", () => {
  const strings = allScanSummaryStrings();

  it("has every string of the module on the list", () => {
    expect(strings.length).toBeGreaterThanOrEqual(12);
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

  it("says how the run ended in the pinned form, with the engine's words when it sent them", () => {
    expect(notFinished("aborted", "stopped by an operator")).toBe("The scan did not finish: stopped by an operator.");
    expect(notFinished("aborted", null)).toBe("The scan did not finish: it was stopped before it finished.");
    expect(notFinished("failed", null)).toBe("The scan did not finish: the engine reported an error.");
    expect(notFinished("refused", null)).toBe("The scan did not finish: the engine refused it at preflight.");
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
