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
 * beside a status that stands on supporting evidence, and only while that evidence
 * has not expired.
 *
 * Where it shows none, the reason it gives is what the status means in the
 * backend, true on every path that sets it -- never a cause. A person can mark a
 * claim contradicted over evidence that supports it, a derived unknown can be
 * partly known, and stale means a retest is due, whether a system change, a
 * declared condition or expiry put it there.
 */
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import {
  CLAIM_STRENGTH_BASIS,
  ClaimsPanel,
  claimStrength,
  claimStrengthBasis,
} from "@/pages/Assurance";

afterEach(cleanup);

const SUPPORTING = ["supported", "verified", "partially_verified"] as const;

const REASON: Record<string, string> = {
  contradicted: "No strength: this claim is marked contradicted.",
  unknown: "No strength: this claim is marked unknown, neither supported nor contradicted.",
  revoked: "No strength: this claim was withdrawn.",
  stale: "No strength: a retest is due before this claim can be read as current.",
  superseded: "No strength: a newer version of this claim replaces it.",
  draft: "No strength: this claim has not been assessed.",
};
const EXPIRED = "No strength: the evidence behind this claim has expired.";
const UNRECORDED = "No strength recorded for this claim.";

describe("a claim's strength", () => {
  it("is printed as the ordinal the backend sent, never as a percentage", () => {
    for (const [value, text] of [
      [1, "strength 1.00"],
      [0.52, "strength 0.52"],
      [0.16, "strength 0.16"],
      [0.1, "strength 0.10"],
    ] as const) {
      for (const status of SUPPORTING) {
        const c = { status, confidence: value, isStale: false };
        expect(claimStrength(c)).toBe(text);
        expect(claimStrengthBasis(c)).toBe(CLAIM_STRENGTH_BASIS);
      }
    }
    expect(CLAIM_STRENGTH_BASIS).toMatch(/^Ordinal:/);
    expect(CLAIM_STRENGTH_BASIS).toContain("weakest class of evidence");
    expect(CLAIM_STRENGTH_BASIS).toContain("Not a probability");
  });

  it("is never shown beside a status that does not stand on supporting evidence, and says what that status means", () => {
    for (const status of [...Object.keys(REASON), "odd"]) {
      for (const isStale of [false, true]) {
        const c = { status, confidence: 0.52, isStale };
        expect(claimStrength(c)).toBe("strength —");
        expect(claimStrengthBasis(c)).toMatch(/^No strength: /);
        expect(claimStrengthBasis(c)).not.toContain("Ordinal");
        if (status in REASON) expect(claimStrengthBasis(c)).toBe(REASON[status]);
      }
    }
    // A person can mark a claim contradicted or unknown over evidence that
    // supports it, so neither reason may say what the evidence shows.
    for (const status of ["contradicted", "unknown"]) {
      expect(claimStrengthBasis({ status, confidence: 0.52, isStale: false })).not.toMatch(
        /evidence|nothing is known/,
      );
    }
    // Stale means a retest is due; only one of the three paths to it is expiry.
    expect(claimStrengthBasis({ status: "stale", confidence: 0.52, isStale: false })).not.toContain("expired");
  });

  it("is not shown once the evidence behind it has expired, under any supporting status", () => {
    for (const status of SUPPORTING) {
      for (const confidence of [1, 0.52, 0.1, null]) {
        const c = { status, confidence, isStale: true };
        expect(claimStrength(c)).toBe("strength —");
        expect(claimStrengthBasis(c)).toBe(EXPIRED);
      }
    }
  });

  it("is absent, not zero, where none was recorded or the number is not one", () => {
    // 52 and 1.5 are a percentage and a number out of range: neither is printed.
    for (const value of [null, 0, -0.001, 1.5, 52, Number.NaN, Number.POSITIVE_INFINITY]) {
      const c = { status: "supported", confidence: value, isStale: false };
      expect(claimStrength(c)).toBe("strength —");
      expect(claimStrengthBasis(c)).toBe(UNRECORDED);
    }
  });
});

const KEY = "/api/assurance/deployments/dep/assurance-claims";

function claim(
  uuid: string,
  status: string,
  statusLabel: string,
  confidence: number | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    uuid,
    deploymentUuid: "dep",
    assetUuid: null,
    assetName: null,
    claimType: "data_boundary",
    claimTypeLabel: `Data boundary (${uuid})`,
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
    ...overrides,
  };
}

function mount(rows: { uuid: string }[]) {
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
  // Each row's lifecycle, fetched when the row is expanded.
  for (const row of rows) client.setQueryData([`/api/assurance/claims/${row.uuid}/events`], []);
  return render(
    <QueryClientProvider client={client}>
      <ClaimsPanel deploymentUuid="dep" admin={false} />
    </QueryClientProvider>,
  );
}

/** Every string a reader can meet in an element: its text and its titles and labels. */
function everythingReadable(el: Element): string[] {
  const attrs = [el, ...Array.from(el.querySelectorAll("*"))].flatMap((node) =>
    ["title", "aria-label"].map((a) => node.getAttribute(a) ?? ""),
  );
  return [el.textContent ?? "", ...attrs];
}

/** The row's text with the screen-reader-only text taken out: what is on screen. */
function visibleText(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll(".sr-only").forEach((node) => node.remove());
  return copy.textContent ?? "";
}

// What each fixture row must print, and why it is there.
const ROWS: { row: ReturnType<typeof claim>; value: string; basis: string }[] = [
  { row: claim("a", "supported", "Supported", 0.52), value: "strength 0.52", basis: CLAIM_STRENGTH_BASIS },
  {
    // Moved to contradicted by a person over evidence that supports the claim:
    // the backend still carries the machine's 0.52 and its supporting summary.
    row: claim("b", "contradicted", "Contradicted", 0.52, {
      supportingSummary: "2 of 2 data flow(s) reconciled within the approved boundary.",
    }),
    value: "strength —",
    basis: REASON.contradicted,
  },
  { row: claim("c", "revoked", "Revoked", 0.52), value: "strength —", basis: REASON.revoked },
  // Moved up from unknown by a person: the backend carries no strength.
  { row: claim("d", "supported", "Supported", null), value: "strength —", basis: UNRECORDED },
  {
    // Derived unknown and partly known, with a contradicting line on the row.
    row: claim("e", "unknown", "Unknown", null, {
      evidenceClass: "unknown",
      evidenceClassLabel: "Unknown",
      supportingSummary: "1 of 2 data flow(s) reconciled within the approved boundary.",
      contradictingSummary: "1 flow(s) with an undeclared posture.",
    }),
    value: "strength —",
    basis: REASON.unknown,
  },
  // Moved to unknown by a person, beside a vendor-asserted evidence chip.
  { row: claim("f", "unknown", "Unknown", 0.52), value: "strength —", basis: REASON.unknown },
  // Marked stale (a retest is due); the backend leaves the 0.52 in place.
  { row: claim("g", "stale", "Stale", 0.52), value: "strength —", basis: REASON.stale },
  {
    // Supported, but its evidence has expired.
    row: claim("h", "supported", "Supported", 0.52, { isStale: true }),
    value: "strength —",
    basis: EXPIRED,
  },
];

describe("the claims panel", () => {
  it("prints each claim's strength as the ordinal, with its basis, and never as a percentage", () => {
    mount(ROWS.map((r) => r.row));
    const spans = screen.getAllByTestId("text-claim-strength");
    expect(spans).toHaveLength(ROWS.length);

    spans.forEach((span, i) => {
      const { row, value, basis } = ROWS[i];
      const li = span.closest("li")!;
      expect(within(li).getByText(`Data boundary (${row.uuid})`)).toBeTruthy();

      // What is on screen: the strength alone, with the basis as its title.
      expect(within(li).getByTestId("text-claim-strength-value").textContent).toBe(value);
      expect(span.getAttribute("title")).toBe(basis);
      expect(visibleText(li)).toContain(value);
      expect(visibleText(li)).not.toContain(basis);

      // What a screen reader reads: the basis, in text it is not shown on screen.
      const sr = within(li).getByTestId("text-claim-strength-sr");
      expect(sr.classList.contains("sr-only")).toBe(true);
      expect(sr.textContent).toBe(` (${basis})`);
      expect(span.textContent).toBe(`${value} (${basis})`);

      // Nowhere in the row, text or title.
      for (const text of everythingReadable(li)) expect(text).not.toContain("%");
      expect(within(li).queryByTestId("text-claim-strength-basis")).toBeNull();
    });

    // A stale row keeps its stale mark beside the absent strength.
    const expired = spans[ROWS.findIndex((r) => r.row.uuid === "h")].closest("li")!;
    expect(within(expired).getByText("stale")).toBeTruthy();
  });

  it("gives the same basis in each claim's expanded section, and no percentage there either", () => {
    mount(ROWS.map((r) => r.row));
    const items = screen.getAllByTestId("text-claim-strength").map((span) => span.closest("li")!);
    for (const li of items) fireEvent.click(within(li).getByRole("button", { expanded: false }));

    items.forEach((li, i) => {
      const { basis } = ROWS[i];
      expect(within(li).getByRole("button", { expanded: true })).toBeTruthy();
      expect(within(li).getByTestId("text-claim-strength-basis").textContent).toBe(basis);
      // The seeded lifecycle rendered, so nothing was fetched.
      expect(within(li).getByText("No lifecycle events recorded yet.")).toBeTruthy();
      for (const text of everythingReadable(li)) expect(text).not.toContain("%");
    });
  });
});
