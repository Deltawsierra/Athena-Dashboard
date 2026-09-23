// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { Verdict } from "@/pages/CVEClassifier";

/**
 * The reader-facing half of "an unsent confidence is not a zero".
 *
 * Making the BFF answer `null` accomplishes nothing on its own; the page has
 * to say something different when it gets one. Before this, an engine that
 * sent no confidence rendered "0.0%" beside the label -- a number nobody
 * measured, in the field this screen was rebuilt to stop inventing.
 *
 * Every assertion is paired with a control asserting that a REAL zero still
 * renders as a number. Otherwise "never print 0.0%" is satisfied by a page
 * that prints nothing, which is the same defect wearing the opposite sign.
 */

const CLASSES = ["buffer_overflow", "path_traversal", "rce", "sql_injection", "xss"];

const result = (over: Record<string, unknown> = {}) => ({
  label: "sql_injection",
  confidence: 0.284 as number | null,
  informative: true,
  baseline: 0.2 as number | null,
  classes: CLASSES,
  engineVersion: "ml-v1",
  ...over,
});

afterEach(cleanup);

describe("a confidence the engine never sent", () => {
  it("says it was not reported rather than printing a percentage", () => {
    render(<Verdict result={result({ confidence: null })} />);

    expect(screen.getByTestId("text-confidence").textContent).toBe(
      "confidence not reported",
    );
    expect(screen.getByTestId("text-confidence").textContent).not.toMatch(/%/);
    // The label still shows. Hiding it would be its own dishonesty.
    expect(screen.getByTestId("text-label").textContent).toBe("sql_injection");
    expect(screen.getByTestId("text-no-confidence")).toBeTruthy();
  });

  it("does not print the floor comparison there is nothing to compare against", () => {
    // "Against a 20.0% floor" beside no measurement invites the reader to
    // supply the missing number themselves.
    render(<Verdict result={result({ confidence: null })} />);
    expect(screen.queryByText(/Against a/)).toBeNull();
  });

  it("still prints a measured zero as a number", () => {
    // The control. A model that scored this class at nothing HAS answered.
    render(<Verdict result={result({ confidence: 0 })} />);

    expect(screen.getByTestId("text-confidence").textContent).toBe("0.0%");
    expect(screen.queryByTestId("text-no-confidence")).toBeNull();
  });

  it("still prints an ordinary confidence, and the floor beside it", () => {
    render(<Verdict result={result()} />);

    expect(screen.getByTestId("text-confidence").textContent).toBe("28.4%");
    expect(screen.getByText(/Against a 20.0% floor/)).toBeTruthy();
    expect(screen.queryByTestId("text-no-confidence")).toBeNull();
  });

  it("leaves the uninformative verdict alone", () => {
    // The floor case has its own panel and its own words; a null confidence
    // must not be routed into it, because "the model expressed no preference"
    // is a claim about the model that an absent field does not support.
    render(<Verdict result={result({ informative: false, confidence: null })} />);

    expect(screen.getByTestId("verdict-uninformative")).toBeTruthy();
    expect(screen.queryByTestId("verdict-classified")).toBeNull();
  });
});
