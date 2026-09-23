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

  it("leaves an engine-stated uninformative verdict alone", () => {
    // A real `informative: false` is the engine's own statement and keeps its
    // own panel. This is a control for the branch below, not for the confidence
    // routing: it supplies informative: false, so it would pass whatever the
    // confidence branch did. Test 1 is what pins the confidence routing.
    render(<Verdict result={result({ informative: false, confidence: null })} />);

    expect(screen.getByTestId("verdict-uninformative")).toBeTruthy();
    expect(screen.queryByTestId("verdict-classified")).toBeNull();
    expect(screen.queryByTestId("verdict-unstated")).toBeNull();
  });
});

describe("an informative flag the engine never sent", () => {
  it("does not claim the model expressed no preference", () => {
    // The sentence in the uninformative panel is a claim ABOUT THE MODEL. An
    // engine that omitted the field made no such claim. Reading absent as false
    // published it anyway -- and with a measured 0.9 against a 0.2 floor in the
    // same response, the page told the reader every class scored 20.0%.
    render(<Verdict result={result({ informative: null, confidence: 0.9 })} />);

    expect(screen.getByTestId("verdict-unstated")).toBeTruthy();
    expect(screen.queryByTestId("verdict-uninformative")).toBeNull();
    expect(screen.queryByTestId("verdict-classified")).toBeNull();
    expect(screen.queryByText(/scored every one of its classes equally/)).toBeNull();
    expect(screen.queryByText(/because something/)).toBeNull();
    // The label and the measured number both still show: hiding them would be
    // its own dishonesty, and 0.9 IS what the engine reported.
    expect(screen.getByTestId("text-label").textContent).toBe("sql_injection");
    expect(screen.getByTestId("text-confidence").textContent).toBe("90.0%");
  });

  it("does not present it as a classification either", () => {
    // Fail-safe in both directions -- which is what the old `false` default was
    // for. Absent must not become "this is a finding".
    render(<Verdict result={result({ informative: null, confidence: 0.9 })} />);
    expect(screen.queryByTestId("verdict-classified")).toBeNull();
    expect(screen.getByText(/not presented as a classification/)).toBeTruthy();
  });

  it("carries an unsent confidence through the unstated branch too", () => {
    render(<Verdict result={result({ informative: null, confidence: null })} />);
    expect(screen.getByTestId("text-confidence").textContent).toBe(
      "confidence not reported",
    );
  });

  it("still routes a stated flag to its own panel, either way", () => {
    // Two controls in one: null must be the ONLY state that reaches the new
    // branch. If it swallowed `true` or `false` the page would stop saying
    // anything at all, which is the same defect wearing the opposite sign.
    render(<Verdict result={result({ informative: true })} />);
    expect(screen.getByTestId("verdict-classified")).toBeTruthy();
    expect(screen.queryByTestId("verdict-unstated")).toBeNull();
    cleanup();

    render(<Verdict result={result({ informative: false })} />);
    expect(screen.getByTestId("verdict-uninformative")).toBeTruthy();
    expect(screen.queryByTestId("verdict-unstated")).toBeNull();
  });
});
