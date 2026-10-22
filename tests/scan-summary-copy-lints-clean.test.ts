/**
 * Every authored sentence the scan screens say about a run that ended short
 * of completed (client/src/lib/scanSummaryCopy.ts), about the engine's
 * coverage manifest for a scan (client/src/lib/scanCoverageCopy.ts), and
 * about where what a surface shows comes from (client/src/lib/sourceLabels.ts)
 * lints clean against the persona fence (shared/persona-lint.ts): no verdict
 * word about the target (secure, safe, clean, pass, fail, no issues...), no
 * ship-or-hold, no dramatization, no reassurance. The charter says the lint is
 * a test, not a guideline; this is that test for this copy.
 *
 * And the copy never says the one thing it exists to stop: that such a run
 * "finished and returned no findings", or is "Clear"; no coverage sentence
 * calls a manifest complete on its own account; and the source labels name a
 * source, never an era, a "world" or a promise about the backend.
 */
import { describe, expect, it } from "vitest";
import { lintMicrocopy } from "@shared/persona-lint";
import { allScanSummaryStrings, endedState, notFinished } from "@/lib/scanSummaryCopy";
import { allScanCoverageStrings, SCAN_COVERAGE_COPY } from "@/lib/scanCoverageCopy";
import { allSourceLabelStrings, COVERAGE_SOURCE, DASHBOARD_DIRECT } from "@/lib/sourceLabels";

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

describe("scan coverage copy: every authored string lints clean", () => {
  const strings = allScanCoverageStrings();

  it("has every string of the module on the list", () => {
    expect(strings.length).toBeGreaterThanOrEqual(27);
    expect(new Set(strings).size).toBe(strings.length);
  });

  for (const text of strings) {
    it(`is clean: ${JSON.stringify(text)}`, () => {
      expect(lintMicrocopy(text)).toEqual([]);
    });
  }

  it("says a manifest is complete only in the engine's name, and says a missing one is not known, never complete", () => {
    expect(SCAN_COVERAGE_COPY.completeTrue).toMatch(/^The engine states/);
    expect(SCAN_COVERAGE_COPY.completeFalse).toMatch(/^The engine states/);
    expect(SCAN_COVERAGE_COPY.notSent).toContain("not known from here");
    expect(SCAN_COVERAGE_COPY.notSent).not.toMatch(/complete/);
    // The phrases the scan-screen tests hold a completed scan's page free of.
    for (const text of strings) {
      expect(text).not.toMatch(/not recorded|Not read|Clear|Informational|returned no (gradable )?findings/);
    }
  });
});

describe("source labels: every label lints clean and names a source", () => {
  const strings = allSourceLabelStrings();

  for (const text of strings) {
    it(`is clean: ${JSON.stringify(text)}`, () => {
      expect(lintMicrocopy(text)).toEqual([]);
    });
  }

  it("labels by source, never by era or world, and promises nothing of the backend", () => {
    for (const text of strings) {
      expect(text).not.toMatch(/legacy|backend will record|deployment assurance|\bworld\b|\bera\b/i);
    }
    expect(DASHBOARD_DIRECT).toBe("Recorded by this dashboard directly from the engine; not in the Athena-Backend record");
    expect(COVERAGE_SOURCE).toBe(
      "Read directly from the engine for this run. Recorded by this dashboard directly from the engine; " +
      "not in the Athena-Backend record.",
    );
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
