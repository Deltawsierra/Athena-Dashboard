// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";

import { IncidentPackView } from "@/pages/Assurance";

/**
 * The incident evidence pack rendered "Attests integrity and provenance, never
 * the truth of the conclusion." beside two unsigned digests (adversary round
 * 1, F13) -- the claim this branch removed from the receipt panel, the finding
 * mark and the AI-BOM because a bare digest attests nothing: whoever changes
 * the content can recompute the digest beside it. And "Download JSON" offered
 * the page's own re-rendering of the pack, not the bytes that were hashed.
 *
 * The pack now says what its digests can show, whether a signature came with
 * it (as the backend reported, or that it did not say), and labels the
 * download as this view. The first test is the adversary's reproducer; its
 * `attests` value is the one the BFF fixtures carry.
 */

afterEach(cleanup);

const KEY = "/api/assurance/findings/f-1/incident-pack";

function pack(signed: boolean | null | undefined, unsignedReason: string | null = null) {
  return {
    packVersion: "mythos.incident.pack/1.0",
    attests: "integrity and provenance, never the truth of the conclusion",
    identity: {
      deployment: { name: "checkout", uuid: "d1", environment: "production", environmentLabel: "Production", owner: null },
      finding: {
        uuid: "f-1", fingerprint: "fp", category: "prompt_injection", title: "t", severity: "high",
        severityLabel: "High", status: "open", statusLabel: "Open", statusMustNotImply: null,
      },
    },
    surface: { asset: null, assetPresent: false, location: null, controlMapping: {} },
    evidence: { algorithm: "sha256", rows: [], count: 1, evidenceClass: "observed" },
    receipt: { algorithm: "sha256", digest: "9".repeat(64), evidenceCount: 1 },
    runtimeTranscript: {
      inAssuranceRecord: false, see: "", reason: "kept by the engine",
      enginePackRef: { available: false, scanUuid: null, engineRunId: null },
    },
    decision: { decision: null, decisionLabel: null },
    algorithm: "sha256",
    digest: "8".repeat(64),
    computedAt: null,
    ...(signed === undefined ? {} : { signed, unsignedReason }),
  };
}

function mount(data: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData([KEY], data);
  render(
    <QueryClientProvider client={client}>
      <IncidentPackView findingUuid="f-1" />
    </QueryClientProvider>,
  );
}

describe("incident evidence pack wording", () => {
  it("does not say an unsigned digest attests integrity", () => {
    // Exactly the adversary's payload: no `signed` field at all.
    mount(pack(undefined));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Attests integrity/i);
    expect(text).not.toMatch(/\battests\b/i);
  });

  it("says what its digests can show, and that they show nothing on their own", () => {
    mount(pack(null));
    expect(screen.getByTestId("incident-pack-digest-meaning").textContent).toMatch(
      /identify a recorded state.*show a change only against a copy obtained independently.*or one a verified signature covers.*on their own they attest nothing/,
    );
  });

  it("says no signature came with the pack when the backend said nothing", () => {
    mount(pack(null));
    const sig = screen.getByTestId("incident-pack-signature").textContent ?? "";
    expect(sig).toMatch(/No signature came with this pack/);
    expect(sig).not.toMatch(/Reported signed|Unsigned\./);
  });

  it("says unsigned, with the backend's reason, when the backend says unsigned", () => {
    mount(pack(false, "This backend holds no signing key."));
    const sig = screen.getByTestId("incident-pack-signature").textContent ?? "";
    expect(sig).toContain("Unsigned.");
    expect(sig).toContain("Backend's reason: This backend holds no signing key.");
  });

  it("says reported signed, unverified here, only when the backend says signed", () => {
    mount(pack(true));
    const sig = screen.getByTestId("incident-pack-signature").textContent ?? "";
    expect(sig).toContain("Reported signed.");
    expect(sig).toMatch(/neither shows nor verifies the signature/);
  });

  it("labels the download as this view, not the hashed pack", () => {
    mount(pack(null));
    const button = screen.getByRole("button", { name: /Download this view \(JSON\)/ });
    expect(button.getAttribute("title")).toMatch(/not the bytes the digests were computed over/);
    expect(document.body.textContent).not.toMatch(/Download JSON/);
  });
});
