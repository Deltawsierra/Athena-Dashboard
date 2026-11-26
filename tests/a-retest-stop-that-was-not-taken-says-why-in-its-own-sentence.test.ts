// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { notStoppedNotice } from "@/components/RetestPanel";

/**
 * A copy fix (DASH-EFFECT-PAGES 7): the notice of a retest Stop that was not taken ran
 * its two sentences together when the server's reason ended in no full stop: "...the
 * retest may still be running Press Stop again, or use the kill switch...". The reason
 * is now its own sentence. Nothing about when a Stop is offered, sent or kept changes.
 */
describe("the notice of a retest Stop that was not taken", () => {
  it("ends the server's reason with a full stop before saying what to do", () => {
    expect(notStoppedNotice("the engine did not accept the stop; the retest may still be running")).toBe(
      "the engine did not accept the stop; the retest may still be running. Press Stop again, or use the kill switch on the AI Control page.",
    );
  });

  it("adds none to a reason that already ends its sentence, and still says what stops the run", () => {
    for (const reason of ["The engine refused the stop.", "Was the run still there?", "It did not take. "]) {
      const notice = notStoppedNotice(reason);
      expect(notice).toBe(`${reason.trim()} Press Stop again, or use the kill switch on the AI Control page.`);
      expect(notice).not.toMatch(/\.\./);
    }
  });
});
