// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { UnresolvedReferences, unresolvedReason, unresolvedReasons } from "@/pages/Assurance";

/**
 * The page used to end every unresolved reference with "which discovery could
 * not place". That is true of one reason in three. An ambiguous reference WAS
 * placed -- twice -- and the backend followed it to every candidate, so telling
 * an operator nothing was found sends them looking for a component that exists.
 * A reference naming an agent where a tool belongs names something real, too.
 * These mount the component and read the sentence each reason produces.
 */

afterEach(cleanup);

const row = (reference: string, mechanism: string, reason: string | null, reasons?: string[]) => ({
  source: "assistant",
  sourceKind: "agent",
  reference,
  mechanism,
  reason,
  reasons: reasons ?? (reason === null ? [] : [reason]),
});

const header = () => screen.getByText(/So this map was built over/).textContent ?? "";

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

/**
 * One reference is one row however many reasons hold. The control plane used to
 * send a row per reason, which counted an ambiguous reference with a superseded
 * candidate twice; it now sends the reasons as a list, and the page says every
 * one of them -- the second is the one that says a rescan is due.
 */
describe("a reference reported for more than one reason", () => {
  it("says every reason, first reason first", () => {
    render(
      <UnresolvedReferences
        rows={[row("planner", "tools", "ambiguous", ["ambiguous", "superseded_identity"])]}
        reported={1}
        what="this map"
      />,
    );
    const [item] = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(item).toContain("more than one component answers to");
    expect(item).toContain("rescan to confirm it");
    expect(item.indexOf("more than one component")).toBeLessThan(item.indexOf("rescan"));
    // One row, one count.
    expect(header()).toContain("1 declared reference could not be placed as exactly one component");
    expect(header()).not.toContain("more were followed");
  });

  it("falls back to the one reason when the list is empty", () => {
    expect(unresolvedReasons({ reason: "not_found", reasons: [] })).toBe(unresolvedReason("not_found"));
    expect(unresolvedReasons({ reason: null, reasons: [] })).toBe(unresolvedReason(null));
  });
});

describe("a reference that was followed and waits only on a rescan", () => {
  it("is not counted as a reference that could not be placed", () => {
    render(
      <UnresolvedReferences
        rows={[row("reader", "tools", "superseded_identity"), row("svc", "identity", "superseded_identity")]}
        reported={2}
        what="this map"
      />,
    );
    const text = header();
    expect(text).toContain("2 declared references were followed to or from a component recorded under identity rules");
    expect(text).toContain("a rescan is what confirms them");
    expect(text).toContain("built over a graph a rescan has yet to confirm");
    expect(text).not.toContain("could not be placed");
    expect(text).not.toContain("incomplete graph");
  });

  it("is counted apart from the references that could not be placed", () => {
    render(
      <UnresolvedReferences
        rows={[
          row("ghost", "tools", "not_found"),
          row("planner", "tools", "ambiguous", ["ambiguous", "superseded_identity"]),
          row("reader", "tools", "superseded_identity"),
        ]}
        reported={3}
        what="this map"
      />,
    );
    const text = header();
    expect(text).toContain("2 declared references could not be placed as exactly one component");
    expect(text).toContain("1 more was followed to or from a component");
    expect(text).toContain("a rescan is what confirms it");
    expect(text).toContain("built over an incomplete graph");
  });

  it("does not claim a count it cannot name is either kind", () => {
    render(
      <UnresolvedReferences rows={[row("reader", "tools", "superseded_identity")]} reported={3} what="this map" />,
    );
    const text = header();
    expect(text).toContain("3 declared references were reported unresolved");
    expect(text).toContain("only 1 of them");
    expect(text).toContain("built over an incomplete graph");
  });
});

/**
 * The old identity rules wrote one row for every unnamed agent at once, and the
 * current rules key each unnamed agent by where it is -- so no rescan re-records
 * that row, and the references it declares are not ones a rescan confirms. The
 * page used to have two buckets, and a reference from that row fell into
 * "could not be placed" (false: it was followed and counted) or, reaching an
 * old row too, would have been told "rescan to confirm it" (false: none does).
 */
describe("a reference from the old row for every unnamed agent", () => {
  it("is not told it could not be placed, nor that a rescan confirms it", () => {
    render(
      <UnresolvedReferences
        rows={[
          row("files-mcp", "tools", "legacy_unnamed_agent"),
          row("github", "tools", "legacy_unnamed_agent", ["legacy_unnamed_agent", "superseded_identity"]),
        ]}
        reported={2}
        what="this map"
      />,
    );
    const text = header();
    expect(text).toContain(
      "2 declared references come from the row the old identity rules wrote for every unnamed agent at once",
    );
    expect(text).toContain("the reach through them is counted");
    expect(text).toContain("no rescan re-records that row");
    expect(text).toContain("built over a graph that still counts reach through the old unnamed-agent row.");
    expect(text).not.toContain("could not be placed");
    expect(text).not.toContain("incomplete graph");
    expect(text).not.toContain("a rescan is what confirms");
    expect(text).not.toContain("yet to confirm");
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    for (const item of items) {
      expect(item).toContain("no rescan re-records that row");
      expect(item).not.toContain("rescan to confirm");
      expect(item).not.toContain("could not place");
    }
    expect(items[1]).toContain("which reaches a component also recorded under the old identity rules");
  });

  it("does not claim a reference was followed when its other reason says it names nothing", () => {
    const said = unresolvedReasons({ reason: "not_found", reasons: ["not_found", "legacy_unnamed_agent"] });
    expect(said).toContain("which discovery could not place");
    expect(said).toContain("no rescan re-records that row");
    expect(said).not.toContain("followed");
    render(
      <UnresolvedReferences
        rows={[row("ghost", "tools", "not_found", ["not_found", "legacy_unnamed_agent"])]}
        reported={1}
        what="this map"
      />,
    );
    const text = header();
    expect(text).toContain("1 declared reference could not be placed as exactly one component");
    expect(text).not.toContain("come from the row");
    expect(text).not.toContain("comes from the row");
    expect(text).toContain("built over an incomplete graph");
  });

  it("is counted apart from the references a rescan confirms", () => {
    render(
      <UnresolvedReferences
        rows={[
          row("reader", "tools", "superseded_identity"),
          row("files-mcp", "tools", "legacy_unnamed_agent"),
        ]}
        reported={2}
        what="this map"
      />,
    );
    const text = header();
    expect(text).toContain("1 declared reference was followed to or from a component");
    expect(text).toContain("a rescan is what confirms it");
    expect(text).toContain("1 more comes from the row the old identity rules wrote");
    expect(text).toContain("the reach through it is counted");
    expect(text).toContain(
      "built over a graph a rescan has yet to confirm, and that still counts reach through the old unnamed-agent row.",
    );
    expect(text).not.toContain("could not be placed");
  });

  it("follows the references that could not be placed as more", () => {
    render(
      <UnresolvedReferences
        rows={[row("ghost", "tools", "not_found"), row("files-mcp", "tools", "legacy_unnamed_agent")]}
        reported={2}
        what="this map"
      />,
    );
    const text = header();
    expect(text).toContain("1 declared reference could not be placed as exactly one component");
    expect(text).toContain("1 more comes from the row");
    expect(text).toContain("built over an incomplete graph");
  });
});
