/**
 * A claim's confidence is an ordinal strength, not a probability.
 *
 * athena-backend reads it from the weakest class of evidence behind the claim --
 * `max(0.1, 1.0 - 0.12 * rank)`, 1.00 for technically verified down to 0.16 for
 * not documented -- and mythos-core documents that table with the basis "ordinal
 * ... Not a probability that the claim is true". The claims panel printed it as
 * "conf 52%", which reads as a 52% chance the claim is true.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { claimStrength, claimStrengthBasis } from "../client/src/pages/Assurance";

describe("a claim's strength", () => {
  it("is printed as the ordinal the backend sent, never as a percentage", () => {
    for (const [value, text] of [
      [1, "strength 1.00"],
      [0.52, "strength 0.52"],
      [0.16, "strength 0.16"],
      [0.1, "strength 0.10"],
    ] as const) {
      expect(claimStrength(value)).toBe(text);
      expect(claimStrength(value)).not.toMatch(/%/);
    }
  });

  it("says what the number is and is not", () => {
    expect(claimStrengthBasis(0.52)).toMatch(/^Ordinal:/);
    expect(claimStrengthBasis(0.52)).toContain("weakest class of evidence");
    expect(claimStrengthBasis(0.52)).toContain("Not a probability");
  });

  it("is absent, not zero, where the claim stands on no supporting evidence", () => {
    expect(claimStrength(null)).toBe("strength —");
    expect(claimStrength(null)).not.toMatch(/0/);
    expect(claimStrengthBasis(null)).toContain("not standing on supporting evidence");
  });

  it("is the only way the claims panel prints it", () => {
    const source = readFileSync(resolve(__dirname, "../client/src/pages/Assurance.tsx"), "utf8");
    expect(source).not.toMatch(/c\.confidence\s*\*\s*100/);
    expect(source).toContain("{claimStrength(c.confidence)}");
  });
});
