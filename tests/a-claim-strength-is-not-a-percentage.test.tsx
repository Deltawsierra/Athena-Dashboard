// @vitest-environment jsdom
/**
 * A claim's confidence is an ordinal strength, not a probability.
 *
 * athena-backend reads it from the weakest class of evidence behind the claim --
 * `max(0.1, 1.0 - 0.12 * rank)`, 1.00 for technically verified down to 0.16 for
 * not documented -- and mythos-core documents that table with the basis "ordinal
 * ... Not a probability that the claim is true". The claims panel printed it as
 * "conf 52%", which reads as a 52% chance the claim is true.
 *
 * And the backend grades the machine's reading, not a status a person set: a claim
 * a person moves to contradicted keeps the 0.52 it had while supported, and one a
 * person moves up from unknown keeps none. So the panel shows a strength only
 * beside a status that stands on supporting evidence.
 */
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";

import {
  CLAIM_STRENGTH_BASIS,
  ClaimsPanel,
  claimStrength,
  claimStrengthBasis,
} from "@/pages/Assurance";

afterEach(cleanup);

describe("a claim's strength", () => {
  it("is printed as the ordinal the backend sent, never as a percentage", () => {
    for (const [value, text] of [
      [1, "strength 1.00"],
      [0.52, "strength 0.52"],
      [0.16, "strength 0.16"],
      [0.1, "strength 0.10"],
    ] as const) {
      for (const status of ["supported", "verified", "partially_verified"]) {
        expect(claimStrength(status, value)).toBe(text);
        expect(claimStrengthBasis(status, value)).toBe(CLAIM_STRENGTH_BASIS);
      }
    }
    expect(CLAIM_STRENGTH_BASIS).toMatch(/^Ordinal:/);
    expect(CLAIM_STRENGTH_BASIS).toContain("weakest class of evidence");
    expect(CLAIM_STRENGTH_BASIS).toContain("Not a probability");
  });

  it("is never shown beside a status that does not stand on supporting evidence", () => {
    for (const status of ["contradicted", "unknown", "revoked", "stale", "superseded", "draft", "odd"]) {
      expect(claimStrength(status, 0.52)).toBe("strength —");
      expect(claimStrengthBasis(status, 0.52)).toMatch(/^No strength: /);
      expect(claimStrengthBasis(status, 0.52)).not.toContain("Ordinal");
    }
    expect(claimStrengthBasis("contradicted", 0.52)).toBe("No strength: the evidence contradicts this claim.");
    expect(claimStrengthBasis("revoked", 0.52)).toBe("No strength: this claim was withdrawn.");
  });

  it("is absent, not zero, where none was recorded or the number is not one", () => {
    for (const value of [null, 0, -0.001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(claimStrength("supported", value)).toBe("strength —");
      expect(claimStrengthBasis("supported", value)).toBe("No strength recorded for this claim.");
    }
  });
});

const KEY = "/api/assurance/deployments/dep/assurance-claims";

function claim(status: string, statusLabel: string, confidence: number | null, uuid: string) {
  return {
    uuid,
    deploymentUuid: "dep",
    assetUuid: null,
    assetName: null,
    claimType: "data_boundary",
    claimTypeLabel: `Data boundary (${statusLabel})`,
    statement: "Customer data stays in-region.",
    fingerprint: `fp-${uuid}`,
    systemFingerprint: "sys",
    policyVersion: "v1",
    environment: "prod",
    environmentLabel: "Production",
    status,
    statusLabel,
    evidenceClass: "vendor_asserted",
    evidenceClassLabel: "Vendor asserted",
    confidence,
    vendorAsserted: true,
    assessment: null,
    assessmentLabel: null,
    supportingSummary: "",
    contradictingSummary: "",
    invalidationConditions: [],
    supersededBy: null,
    humanOwner: null,
    receiptDigest: "",
    isStale: false,
    validFrom: null,
    validTo: null,
    verifiedAt: null,
    expiration: null,
    firstSeen: null,
    lastSeen: null,
    createdAt: null,
    updatedAt: null,
  };
}

function mount(rows: unknown[]) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          throw new Error(`unexpected fetch for ${String(queryKey[0])}`);
        },
      },
    },
  });
  client.setQueryData([KEY], rows);
  return render(
    <QueryClientProvider client={client}>
      <ClaimsPanel deploymentUuid="dep" admin={false} />
    </QueryClientProvider>,
  );
}

describe("the claims panel", () => {
  it("prints each claim's strength as the ordinal, with its basis, and never as a percentage", () => {
    mount([
      claim("supported", "Supported", 0.52, "a"),
      // Moved by a person: the backend still carries the machine's 0.52.
      claim("contradicted", "Contradicted", 0.52, "b"),
      claim("revoked", "Revoked", 0.52, "c"),
      // Moved up from unknown by a person: the backend carries no strength.
      claim("supported", "Supported", null, "d"),
    ]);
    const spans = screen.getAllByTestId("text-claim-strength");
    expect(spans).toHaveLength(4);
    const [supported, contradicted, revoked, unrecorded] = spans;

    expect(supported.firstChild?.textContent).toBe("strength 0.52");
    expect(supported.getAttribute("title")).toBe(CLAIM_STRENGTH_BASIS);
    expect(supported.textContent).toContain(CLAIM_STRENGTH_BASIS); // for a screen reader

    expect(contradicted.firstChild?.textContent).toBe("strength —");
    expect(contradicted.getAttribute("title")).toBe("No strength: the evidence contradicts this claim.");
    expect(revoked.firstChild?.textContent).toBe("strength —");
    expect(unrecorded.firstChild?.textContent).toBe("strength —");
    expect(unrecorded.getAttribute("title")).toBe("No strength recorded for this claim.");

    for (const span of spans) {
      expect(span.textContent).not.toMatch(/%/);
    }
  });
});
