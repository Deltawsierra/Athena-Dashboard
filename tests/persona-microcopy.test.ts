/**
 * Pins the LIGHT-persona dashboard microcopy surface to the Mythos fence.
 *
 * This test is the enforcement the charter calls for ("The lint is a test, not a
 * guideline"), transcribed for the dashboard. It:
 *   1. lints every registry string clean (no forbidden word, no ship/hold, no
 *      dramatization, no false reassurance);
 *   2. pins the forbidden list to an exact set, so a fence change cannot land
 *      here unreviewed (canonical source = the charter + mythos_core.persona);
 *   3. proves the lint has teeth on known-bad copy, and does NOT over-flag the
 *      honest error/empty copy the dashboard already uses;
 *   4. asserts persona microcopy is NEVER wired onto a signed/verifiable or
 *      stop/failsafe surface, and that the registry exposes no such group.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FORBIDDEN_WORDS, lintMicrocopy, isClean } from "@shared/persona-lint";
import { microcopy, allMicrocopyStrings } from "@shared/persona-microcopy";

const repoRoot = resolve(import.meta.dirname, "..");

describe("persona microcopy: every registry string lints clean", () => {
  for (const text of allMicrocopyStrings()) {
    it(`is clean: ${JSON.stringify(text)}`, () => {
      expect(lintMicrocopy(text)).toEqual([]);
    });
  }
});

describe("persona lint: the forbidden list is pinned", () => {
  it("matches the charter / mythos_core.persona.lexicon.FORBIDDEN_WORDS set exactly", () => {
    // A change to this expectation is a reviewed mirror of a fence change.
    expect([...FORBIDDEN_WORDS]).toEqual([
      "secure",
      "safe",
      "clean",
      "guaranteed",
      "clearly",
      "obviously",
      "no issues",
      "pass",
      "fail",
      "you're protected",
    ]);
  });

  it("has exactly ten distinct terms", () => {
    expect(new Set(FORBIDDEN_WORDS).size).toBe(10);
    expect(FORBIDDEN_WORDS).toHaveLength(10);
  });
});

describe("persona lint: it catches what the fence forbids", () => {
  // Forbidden words, as verdict/reassurance tokens.
  it.each([
    ["Your data is safe", "forbidden-word"],
    ["This build is secure", "forbidden-word"],
    ["A clean scan", "forbidden-word"],
    ["No issues found", "forbidden-word"],
    ["Results are guaranteed", "forbidden-word"],
    ["It clearly works", "forbidden-word"],
    ["Obviously fine", "forbidden-word"],
    ["Marked pass.", "forbidden-word"],
    ["Marked fail.", "forbidden-word"],
    ["You're protected.", "forbidden-word"],
    ["you are protected now", "forbidden-word"],
  ])("flags %j", (text, rule) => {
    const violations = lintMicrocopy(text);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((v) => v.rule)).toContain(rule);
  });

  it("flags a ship-or-hold recommendation", () => {
    expect(lintMicrocopy("Ready to ship").map((v) => v.rule)).toContain("ship-or-hold");
    expect(lintMicrocopy("You should hold this release").map((v) => v.rule)).toContain("ship-or-hold");
  });

  it("flags dramatization (an exclamation mark)", () => {
    expect(lintMicrocopy("Done!").map((v) => v.rule)).toContain("dramatization");
  });

  it("flags false reassurance / boasting", () => {
    expect(lintMicrocopy("Rest assured, nothing to worry about.").map((v) => v.rule)).toContain("false-reassurance");
  });
});

describe("persona lint: it does NOT over-flag honest, non-verdict copy", () => {
  // The charter forbids the verdict words, not every string that contains their
  // letters. Honest error/empty copy must stay legal.
  it.each([
    "Loading…",
    "Nothing to report yet.",
    "No team members found.",
    "No roles defined.",
    "Could not load the report: the request failed",
    "The read failed; retry when the connection is back",
    "No Stop can reach this scan", // a stop-surface sentence (plain, not persona)
    "failsafe",
    "bypass the password",
  ])("is clean: %j", (text) => {
    expect(isClean(text), `${JSON.stringify(text)} should lint clean`).toBe(true);
  });
});

describe("persona microcopy: boundary — never on signed or stop surfaces", () => {
  it("exposes only non-finding groups (empty / progress / error)", () => {
    expect(Object.keys(microcopy).sort()).toEqual(["empty", "error", "progress"]);
  });

  // The signed/verifiable and stop/failsafe/revoke surfaces stay plain and fixed:
  // they must not import the persona microcopy registry or its lint.
  const CRITICAL_SURFACES = [
    "client/src/components/economics/ReceiptDownload.tsx", // signed receipt (verifiable)
    "client/src/components/NoStopPanel.tsx", // stop / failsafe notice
    "client/src/pages/Failsafe.tsx", // failsafe console: pause / stand down / terminate
    "client/src/pages/AIControlPanel.tsx", // kill switch
  ];

  it.each(CRITICAL_SURFACES)("%s does not import persona microcopy", (file) => {
    const src = readFileSync(resolve(repoRoot, file), "utf8");
    expect(src).not.toMatch(/persona-microcopy|persona-lint/);
  });
});
