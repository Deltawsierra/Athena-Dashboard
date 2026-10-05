// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { ClosureStanding } from "@/pages/Assurance";

/**
 * A finding shows what its closure stands on (Phase 6 item 3). "Verified closed" is
 * shown only for the backend gate's "verified_closed"; a closure without a retest
 * says it is a disposition; a refused one names every reason; a standing that was
 * not served, or one this console does not know, says that -- never "verified".
 */

afterEach(cleanup);

const RUN = { ran: true, outcome: "failed" };
const EVIDENCE = {
  uuid: "r-1", origin: "independent", contentDigest: "sha256:ab12", recordedAt: "2026-10-05T12:00:00+00:00",
  fixtures: {
    vulnerable: RUN, repaired: { ran: true, outcome: "passed" }, benign: { ran: true, outcome: "passed" },
    incompleteRepair: { displaced_effects: RUN },
  },
};

function closure(standing: string, reasons: string[] = [], evidence: typeof EVIDENCE | null = EVIDENCE) {
  return { standing, retestRequired: standing !== "closed_without_retest", reasons, evidence };
}

function shown(): string {
  return screen.queryByTestId("closure-standing")?.textContent ?? "";
}

describe("the closure standing on a finding", () => {
  it("says verified closed only for the backend's verified_closed", () => {
    render(<ClosureStanding closure={closure("verified_closed")} closed />);
    expect(shown()).toMatch(/^Verified closed/);
  });

  it.each(["closable", "not_closable", "closed_without_retest", "unknown", "super_closed"])(
    "never says verified closed for %s",
    (standing) => {
      render(<ClosureStanding closure={closure(standing)} closed />);
      expect(shown()).not.toMatch(/Verified closed/);
    },
  );

  it("calls a closure without a retest a disposition, not a verified closure", () => {
    render(<ClosureStanding closure={closure("closed_without_retest", [], null)} closed />);
    expect(shown()).toMatch(/Closed without a retest: a disposition, not an effect-verified closure/);
  });

  it("names every reason a closure would be refused, and says a closed one no longer carries it", () => {
    const reasons = ["benign: not run", "incomplete_repair/displaced_effects: passed"];
    render(<ClosureStanding closure={closure("not_closable", reasons)} closed={false} />);
    expect(shown()).toMatch(/A closure would be refused/);
    fireEvent.click(screen.getByTestId("closure-standing-toggle"));
    const detail = screen.getByTestId("closure-standing-detail").textContent ?? "";
    for (const reason of reasons) expect(detail).toContain(reason);
    expect(detail).toContain("independent observer");
    cleanup();
    render(<ClosureStanding closure={closure("not_closable", reasons)} closed />);
    expect(shown()).toMatch(/Closed, but its retest evidence does not carry the closure now/);
  });

  it("says a closed finding's closure was not said when the backend served none", () => {
    render(<ClosureStanding closure={null} closed />);
    expect(shown()).toMatch(/Closure not verified: the backend did not say/);
  });

  it("shows nothing for an open finding no retest was asked of, or with no standing served", () => {
    render(<ClosureStanding closure={closure("not_retest_gated", [], null)} closed={false} />);
    expect(screen.queryByTestId("closure-standing")).toBeNull();
    cleanup();
    render(<ClosureStanding closure={null} closed={false} />);
    expect(screen.queryByTestId("closure-standing")).toBeNull();
  });
});
