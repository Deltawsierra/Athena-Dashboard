// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { UnresolvedReferences, unresolvedReason } from "@/pages/Assurance";

/**
 * The page used to end every unresolved reference with "which discovery could
 * not place". That is true of one reason in three. An ambiguous reference WAS
 * placed -- twice -- and the backend followed it to every candidate, so telling
 * an operator nothing was found sends them looking for a component that exists.
 * A reference naming an agent where a tool belongs names something real, too.
 * These mount the component and read the sentence each reason produces.
 */

afterEach(cleanup);

const row = (reference: string, mechanism: string, reason: string | null) => ({
  source: "assistant",
  sourceKind: "agent",
  reference,
  mechanism,
  reason,
});

describe("an unresolved reference says why", () => {
  it("words each reason it knows differently", () => {
    render(
      <UnresolvedReferences
        rows={[
          row("svc-gone", "identity", "not_found"),
          row("planner", "tools", "ambiguous"),
          row("assistant", "server", "names_a_principal"),
        ]}
        reported={3}
        what="this map"
      />,
    );
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(items[0]).toContain("assistant acts as svc-gone, which discovery could not place.");
    expect(items[1]).toContain("more than one component answers to");
    expect(items[1]).toContain("every one of them was followed");
    expect(items[1]).not.toContain("could not place");
    expect(items[2]).toContain("is an agent or a service account");
    expect(items[2]).not.toContain("could not place");
  });

  it("says a superseded reference was followed and needs a rescan, not that it was never placed", () => {
    const text = unresolvedReason("superseded_identity");
    expect(text).toContain("was followed");
    expect(text).toContain("rescan");
    expect(text).not.toContain("could not place");
    expect(text).not.toContain("could not be placed");
    expect(text).not.toContain("the control plane says");
  });

  it("does not credit a control plane that sent no reason with any of them", () => {
    expect(unresolvedReason(null)).toBe("which could not be placed as exactly one component");
    expect(unresolvedReason(null)).not.toContain("discovery");
  });

  it("names a reason it was never taught as itself", () => {
    const text = unresolvedReason("revoked");
    expect(text).toContain("revoked");
    expect(text).not.toBe(unresolvedReason("not_found"));
    expect(text).not.toBe(unresolvedReason("ambiguous"));
  });
});
