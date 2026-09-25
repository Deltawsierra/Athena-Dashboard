// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";

import { AssuranceReceiptPanel, FindingReceiptMark } from "@/pages/Assurance";

/**
 * The receipt used to say it "attests that the recorded evidence is unaltered",
 * and a finding's digest said it was "attesting it is unaltered". A digest does
 * not do that by itself: whoever changes the content can recompute the digest
 * beside it. It shows a change only against a copy obtained independently, or
 * one a verified signature covers -- and the backend serves this receipt
 * unsigned, saying so in the payload (`signed: false`, `unsigned_reason`).
 *
 * So the panel must say what a digest can show, and state the signing status
 * exactly as the backend reported it: unsigned with its reason, reported
 * signed, or -- when the backend said nothing -- not reported. A silence is
 * neither answer.
 */

afterEach(cleanup);

const KEY = "/api/assurance/deployments/dep-1/assurance-receipt";

function receipt(signed: boolean | null, unsignedReason: string | null) {
  return {
    receiptVersion: "mythos.assurance.receipt/3.1",
    system: { name: "checkout", uuid: "dep-1", environment: "production", environmentLabel: "Production" },
    result: { decision: "needs_more_evidence", decisionLabel: "Needs more evidence" },
    policy: { declared: false },
    evidence: { algorithm: "sha256", root: "b".repeat(64), findingCount: 3 },
    assessments: { compliance: "c".repeat(64), capabilities: "d".repeat(64), boundary: "e".repeat(64), bom: "f".repeat(64) },
    algorithm: "sha256",
    digest: "a".repeat(64),
    computedAt: "2026-09-25T00:00:00Z",
    signed,
    unsignedReason,
  };
}

function mount(data: unknown) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          throw new Error(`unexpected fetch for ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  client.setQueryData([KEY], data);
  return render(
    <QueryClientProvider client={client}>
      <AssuranceReceiptPanel deploymentUuid="dep-1" />
    </QueryClientProvider>,
  );
}

function claimsNoIntegrityOnItsOwn() {
  const text = document.body.textContent ?? "";
  expect(text).not.toMatch(/unaltered/i);
  expect(text).not.toMatch(/attests that/i);
  expect(screen.getByTestId("receipt-digest-meaning").textContent).toMatch(
    /show a change only when compared with a copy obtained independently.*attest nothing/,
  );
}

describe("the assurance receipt says what its digests show, and whether it is signed", () => {
  it("says unsigned, with the backend's reason, when the backend says unsigned", () => {
    mount(receipt(false, "THIS COPY is unsigned. This backend holds no signing key."));
    claimsNoIntegrityOnItsOwn();
    expect(screen.getByTestId("receipt-signed-chip").textContent).toBe("unsigned");
    const sig = screen.getByTestId("receipt-signature").textContent ?? "";
    expect(sig).toContain("Unsigned.");
    expect(sig).toContain("Backend's reason: THIS COPY is unsigned. This backend holds no signing key.");
    expect(sig).not.toContain("Reported signed");
  });

  it("says reported signed, and that this page did not verify it, when the backend says signed", () => {
    mount(receipt(true, null));
    claimsNoIntegrityOnItsOwn();
    expect(screen.getByTestId("receipt-signed-chip").textContent).toBe("signed (reported)");
    const sig = screen.getByTestId("receipt-signature").textContent ?? "";
    expect(sig).toContain("Reported signed.");
    expect(sig).toContain("neither shows nor verifies the signature");
    expect(sig).not.toContain("Unsigned.");
  });

  it("says not reported, and neither answer, when the backend said nothing", () => {
    mount(receipt(null, null));
    claimsNoIntegrityOnItsOwn();
    expect(screen.getByTestId("receipt-signed-chip").textContent).toBe("signing not reported");
    const sig = screen.getByTestId("receipt-signature").textContent ?? "";
    expect(sig).toContain("Not reported.");
    expect(sig).not.toContain("Unsigned.");
    expect(sig).not.toContain("Reported signed");
  });
});

describe("a finding's receipt digest", () => {
  it("says no signature came with it and that on its own it attests nothing", () => {
    render(<FindingReceiptMark receipt={{ algorithm: "sha256", digest: "9".repeat(64) }} />);
    const title = screen.getByTestId("finding-receipt").getAttribute("title") ?? "";
    expect(title).not.toMatch(/unaltered/i);
    expect(title).toContain("No signature came with it.");
    expect(title).toContain("It shows a change only when compared with a copy obtained independently");
    expect(title).toContain("on its own it attests nothing");
    // The full digest still rides in the title for whoever needs to compare it.
    expect(title).toContain("9".repeat(64));
  });
});
