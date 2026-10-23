/**
 * The persona lint catches a verdict word in its other forms, and a promise of
 * confidence.
 *
 * The fence matches whole words, so "Failing" slipped past `fail` and "Safer AI"
 * past `safe`: the same verdict, in a state label and a sign-off. The lint now
 * matches the inflections as whole words (safe/safer/safest, secure/secured/
 * securely, clean/cleaner, pass/passing/passed, fail/failing), and refuses
 * confidence as a promise ("Deploy with confidence").
 *
 * These cases pin the lint itself. tests/page-copy-lints-clean.test.ts holds the
 * pages to it, but once the pages are clean that test cannot tell a lint that
 * was loosened again from a lint that never changed: these can.
 *
 * The charter's list (`FORBIDDEN_WORDS`) is unchanged and stays pinned by
 * tests/persona-microcopy.test.ts, which this file does not touch.
 */
import { describe, it, expect } from "vitest";
import { lintMicrocopy, isClean } from "@shared/persona-lint";

describe("persona lint: a verdict word in another form is the same verdict", () => {
  // [text, the charter word it is reported as]
  it.each([
    ["Safer AI", "safe"],
    ["a safer path.", "safe"],
    ["The safest option", "safe"],
    ["SAFER", "safe"],
    ["Secured", "secure"],
    ["Connects securely", "secure"],
    ["A cleaner build", "clean"],
    ["Passing", "pass"],
    ["12 checks passed", "pass"],
    ["Failing", "fail"],
    ["3 failing controls", "fail"],
    ["Failing controls: 3", "fail"],
  ])("flags %j as the verdict word %j", (text, word) => {
    expect(lintMicrocopy(text)).toContainEqual({ rule: "forbidden-word", term: word });
  });

  it("still flags the bare words, reported as before", () => {
    for (const word of ["secure", "safe", "clean", "pass", "fail"]) {
      expect(lintMicrocopy(`Marked ${word}.`)).toContainEqual({ rule: "forbidden-word", term: word });
    }
  });

  it("matches whole words only: a longer word that merely contains one is not a verdict", () => {
    for (const text of [
      "bypass the password",
      "passkey",
      "failsafe",
      "Failsafe console",
      "a passage of text",
      "the safeguard",
      "cleanup",
    ]) {
      expect(isClean(text), `${JSON.stringify(text)} should lint clean`).toBe(true);
    }
  });

  it("leaves `failed` legal: an operation that did not complete is honest error copy", () => {
    // The charter bans the verdict word `fail`. "The request failed" says an
    // operation did not complete, which the error copy must be free to say
    // (tests/persona-microcopy.test.ts pins two such sentences; the registry's
    // `requestFailed` is one). A "Failed" result label is the owner's call.
    for (const text of ["the request failed", "The read failed; retry when the connection is back", "Sign in failed."]) {
      expect(isClean(text), `${JSON.stringify(text)} should lint clean`).toBe(true);
    }
  });
});

describe("persona lint: confidence as a promise is false reassurance", () => {
  it.each([
    "Deploy with confidence.",
    "See the system. Understand the risks. Deploy with confidence.",
    "Deploy AI with confidence, backed by evidence, governed by people.",
    "From evidence to confidence.",
    "SHIP WITH CONFIDENCE",
    "Move from evidence to\n confidence",
  ])("flags %j", (text) => {
    expect(lintMicrocopy(text).map((v) => v.rule)).toContain("false-reassurance");
  });

  it("reports the phrase it matched, lower-cased and on one line", () => {
    expect(lintMicrocopy("Deploy with   Confidence.")).toContainEqual({ rule: "false-reassurance", term: "with confidence" });
    expect(lintMicrocopy("From evidence to\nconfidence.")).toContainEqual({ rule: "false-reassurance", term: "to confidence" });
  });

  it("leaves confidence as a measure alone", () => {
    for (const text of [
      "Confidence",
      "no confidence recorded",
      "confidence not reported",
      "The engine returned this label without a confidence figure",
      "Sorted with confidence scores",
      "Findings with confidence level above 0.8",
      "A 95% confidence interval",
      "Reported with confidence intervals",
    ]) {
      expect(isClean(text), `${JSON.stringify(text)} should lint clean`).toBe(true);
    }
  });
});
