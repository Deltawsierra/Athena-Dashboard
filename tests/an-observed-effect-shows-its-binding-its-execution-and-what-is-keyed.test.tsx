// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { ObservedEffectsView } from "@/components/authority/ObservedEffects";
import { AuthorityChainsView } from "@/components/authority/AuthorityChains";
import type { AuthorityChains } from "@/components/authority/types";
import { EXECUTION_STATES, type ChainOutcomes } from "@shared/observed-effect";
import { lintMicrocopy } from "@shared/persona-lint";
import { standIn } from "./helpers/bad-rows";
import {
  APPROVAL_WINDOWED, CANNOT_COMPARE_DETAIL, CANNOT_COMPARE_WHY, CHAIN_KEY, CHAINS_ROUTE, DEP, DEP_EMPTY, DEP_HOSTILE, DEP_OLDER, DEP_STATES,
  HIDDEN, KEYED, MARKUP, ODD_STATE, OVER, ROUTE, WORDS, overBoundDetail, servedByPath,
} from "./helpers/observed-effects";

/**
 * The observed effects on the authority chains screen, and the receipts on each chain,
 * drawn from this console's real route answers (tests/an-observed-effects-reading-is-
 * relayed-as-the-person-and-never-a-keyed-value.test.ts pins the mapping):
 *
 *   - a version 5 record's tool binding: the tool, its effect, its targets and bound, each
 *     approval with its limit per window and what was counted under it;
 *   - the backend's named finding where the binding's bound is larger than an approval's,
 *     in its words, on the record and beside the approval;
 *   - every execution word of the core's, as served, and one it does not have, as none;
 *   - every keyed reference labelled "keyed", with the backend's words and the key's id,
 *     and its value never on the screen;
 *   - each older version's parts "not recorded", in the core's words as served, never
 *     empty;
 *   - a reconciliation receipt that cannot be compared: it holds back the effect's proof,
 *     in the backend's sentence;
 *   - an unreadable row among good ones counted; a part served in a shape that cannot be
 *     read said; an older backend's records "not reported", never nothing;
 *   - hostile names drawn as text, their hidden characters marked;
 *   - and no reassurance word, and no positive tone, anywhere in what is drawn.
 */

const answers: Record<string, ChainOutcomes> = {};
let chains: AuthorityChains;

beforeAll(async () => {
  const backend = await standIn();
  try {
    backend.serve(servedByPath());
    for (const dep of [DEP, DEP_OLDER, DEP_EMPTY, DEP_HOSTILE, DEP_STATES]) {
      const res = await backend.user.get(ROUTE(dep));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      answers[dep] = res.body as ChainOutcomes;
    }
    const res = await backend.user.get(CHAINS_ROUTE(DEP));
    expect(res.status).toBe(200);
    chains = res.body as AuthorityChains;
  } finally {
    await backend.close();
  }
}, 120_000);
afterEach(cleanup);

const card = (id: string) => {
  const found = document.querySelector(`[data-testid="observed-effect"][data-outcome="${id}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no observed effect ${id}`);
  return found;
};
const refs = (from: HTMLElement, name: string) => Array.from(from.querySelectorAll<HTMLElement>(`[data-ref="${name}"]`));
const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("a version 5 record", () => {
  it("shows the tool it was bound to, its effect, its targets within the bound, and the core's words for the binding", () => {
    render(<ObservedEffectsView data={answers[DEP]} />);
    const one = card("oe-v5");
    expect(one.getAttribute("data-effect-served")).toBe("reading");
    expect(text(within(one).getByTestId("effect-schema"))).toBe("mythos.observed-effect/v5");
    expect(text(within(one).getByTestId("effect-version"))).toBe("version 5");
    const binding = within(one).getByTestId("effect-binding");
    expect(binding.getAttribute("data-binding")).toBe("recorded");
    expect(text(within(binding).getByTestId("effect-binding-reading"))).toBe(WORDS.within);
    expect(text(within(binding).getByTestId("effect-binding-tool"))).toBe("MCP server fleet-tools");
    expect(text(within(binding).getByTestId("effect-binding-effect"))).toBe("destructive");
    expect(text(within(binding).getByTestId("effect-binding-targets"))).toBe("3 of a bound of 3");
  });

  it("shows each approval it rests on, with its own limit per window and what was counted under it, and `counted` null said as no count", () => {
    render(<ObservedEffectsView data={answers[DEP]} />);
    const approvals = within(card("oe-v5")).getAllByTestId("binding-approval");
    expect(approvals).toHaveLength(2);
    const [open, windowed] = approvals;
    expect(text(within(open).getByTestId("approval-limit"))).toBe("names no limit per window");
    expect(text(within(open).getByTestId("approval-counted"))).toBe("no count recorded");
    expect(text(within(open).getByTestId("approval-target-count"))).toBe("3");
    expect(windowed.getAttribute("data-approval")).toBe(APPROVAL_WINDOWED);
    expect(text(within(windowed).getByTestId("approval-limit"))).toBe("at most 25 targets per 3600 s");
    expect(text(within(windowed).getByTestId("approval-counted"))).toBe(
      "this dispatch counted 3 target(s); the window's count after it 23; the approval's lifetime count after it 31; rested on an earlier count of its own (a retry): no",
    );
    expect(text(within(windowed).getByTestId("approval-target-count"))).toBe("40");
    expect(within(windowed).queryByTestId("approval-finding")).toBeNull();
    expect(text(within(card("oe-v5")).getByTestId("effect-no-finding"))).toBe("the backend names no finding on this binding");
  });

  it("shows the execution word as the core says it: the state, its basis and its words", () => {
    render(<ObservedEffectsView data={answers[DEP]} />);
    const one = card("oe-v5");
    expect(text(within(one).getByTestId("effect-execution-state"))).toBe("accepted");
    expect(text(within(one).getByTestId("effect-execution-basis"))).toBe("observed");
    expect(text(within(one).getByTestId("effect-execution-words"))).toBe(WORDS.asSigned);
  });

  it("labels every keyed reference keyed, with the backend's words and the key's id, and never draws a keyed value", () => {
    const { container } = render(<ObservedEffectsView data={answers[DEP]} />);
    const one = card("oe-v5");
    for (const name of ["action", "response", "targets", "generation", "approval-targets"]) {
      const found = refs(one, name);
      expect(found.length, name).toBeGreaterThan(0);
      for (const ref of found) {
        expect(ref.getAttribute("data-testid"), name).toBe("keyed-reference");
        expect(text(ref), name).toContain(`keyed ${WORDS.keyed}`);
      }
    }
    // The id of the key the action, the answer and the targets are under: an id, and shown.
    expect(text(refs(one, "action")[0])).toBe(`keyed ${WORDS.keyed} under key id ${CHAIN_KEY}`);
    expect(text(within(one).getByTestId("effect-keyed-under"))).toContain(`chain v2, key id ${CHAIN_KEY}`);
    // The generation is keyed under the permit key, not the chain key: no chain key id beside it.
    expect(text(refs(one, "generation")[0])).toBe(`keyed ${WORDS.keyed}`);
    // No keyed value anywhere: not in the text, not in an attribute, not as a digest a person could compare.
    const html = container.innerHTML;
    for (const [name, hex] of Object.entries(KEYED)) expect(html.includes(hex), name).toBe(false);
    expect(html).not.toContain("hmac-sha256");
  });

  it("a reference withheld for another reason, or served in a form not read here, is not drawn as a value", () => {
    const { container } = render(<ObservedEffectsView data={answers[DEP]} />);
    const one = card("oe-withheld");
    const [action] = refs(one, "action");
    expect(action.getAttribute("data-testid")).toBe("withheld-reference");
    expect(text(action)).toBe("withheld withheld (chain-key-unkept): what it refers to is not known");
    const [answer] = refs(one, "response");
    expect(answer.getAttribute("data-testid")).toBe("unrecognised-reference");
    expect(text(answer)).toBe("not read served in a form this console does not read: not shown, and not checkable here");
    expect(container.innerHTML).not.toContain("77".repeat(32));
  });

  it("a v5 record whose permit bound no tool says not recorded, in the core's words", () => {
    render(<ObservedEffectsView data={answers[DEP]} />);
    const binding = within(card("oe-unbound")).getByTestId("effect-binding");
    expect(binding.getAttribute("data-binding")).toBe("not-recorded");
    expect(text(binding)).toBe(`not recorded: ${WORDS.noBound}`);
    expect(text(within(card("oe-unbound")).getByTestId("effect-no-finding"))).toBe("none to name: no binding is recorded");
  });
});

describe("a binding whose bound is larger than an approval's", () => {
  it("shows the backend's named finding in its words, on the record and beside the approval", () => {
    render(<ObservedEffectsView data={answers[DEP]} />);
    const one = card("oe-over");
    expect(text(within(one).getByTestId("effect-findings-named"))).toBe(
      "The backend names a finding on this record's tool binding: see below.",
    );
    const detail = overBoundDetail(OVER.bound, OVER.limit, APPROVAL_WINDOWED);
    const [finding] = within(one).getAllByTestId("effect-finding");
    expect(finding.getAttribute("data-code")).toBe("binding_bound_over_approval");
    expect(text(finding)).toBe(`binding_bound_over_approval: ${detail}`);
    expect(finding.className).toContain("text-amber-400");
    const windowed = within(one).getAllByTestId("binding-approval").find((one) => one.getAttribute("data-approval") === APPROVAL_WINDOWED)!;
    expect(text(within(windowed).getByTestId("approval-finding"))).toBe(`binding_bound_over_approval: ${detail}`);
    expect(text(within(one).getByTestId("effect-binding-targets"))).toBe(`4 of a bound of ${OVER.bound}`);
    expect(within(one).queryByTestId("effect-no-finding")).toBeNull();
  });
});

describe("every execution word", () => {
  const TONE: Record<string, string> = { denied: "critical", failed: "critical", partial: "caution", unknown: "caution" };

  for (const state of EXECUTION_STATES) {
    it(`${state}: drawn as the core's word, with its basis and its words as served, never in a positive tone`, () => {
      render(<ObservedEffectsView data={answers[DEP_STATES]} />);
      const one = card(`state-${state}`);
      const chip = within(one).getByTestId("effect-execution-state");
      expect(text(chip)).toBe(state);
      expect(chip.getAttribute("data-tone")).toBe(TONE[state] ?? "neutral");
      expect(text(within(one).getByTestId("effect-execution-words"))).toBe(`${state}: in the words served`);
    });
  }

  it("a word the core does not have is drawn as served and read as none of its words", () => {
    render(<ObservedEffectsView data={answers[DEP_STATES]} />);
    const chip = within(card(`state-${ODD_STATE}`)).getByTestId("effect-execution-state");
    expect(text(chip)).toBe(`not recognised here: ${ODD_STATE}`);
    expect(chip.getAttribute("data-tone")).toBe("neutral");
  });
});

describe("each older version (1 to 4)", () => {
  for (const version of [1, 2, 3, 4]) {
    it(`version ${version}: each part it does not have says not recorded, in the core's words, and none is empty`, () => {
      render(<ObservedEffectsView data={answers[DEP]} />);
      const one = card(`oe-v${version}`);
      expect(text(within(one).getByTestId("effect-version"))).toBe(`version ${version}`);
      expect(text(within(one).getByTestId("effect-binding"))).toBe(`not recorded: ${WORDS.noBinding}`);
      expect(text(within(one).getByTestId("effect-keyed-under"))).toBe(`not recorded: ${WORDS.plain}`);
      expect(text(within(one).getByTestId("effect-digests"))).toBe(WORDS.plain);
      for (const name of ["action", "response"]) {
        const [ref] = refs(one, name);
        expect(ref.getAttribute("data-testid")).toBe("withheld-reference");
        expect(text(ref)).toBe(`withheld ${WORDS.withheld}`);
      }
      expect(text(within(one).getByTestId("effect-execution-state"))).toBe("accepted");
      expect(text(within(one).getByTestId("effect-execution-basis"))).toBe("inferred");
      expect(text(within(one).getByTestId("effect-execution-words"))).toBe(WORDS.noExecutionField);
      expect(text(within(one).getByTestId("effect-no-finding"))).toBe("none to name: no binding is recorded");
      expect(within(one).queryAllByTestId("keyed-reference")).toEqual([]);
      // Never committed, never within a bound it never had.
      expect(text(one)).not.toMatch(/committed|within its bound/);
      // Every labelled fact says something: no value is an empty space that looks complete.
      for (const fact of Array.from(one.querySelectorAll("div.flex-wrap.items-baseline"))) {
        const value = fact.children[1];
        expect(text(value).length, text(fact)).toBeGreaterThan(0);
      }
    });
  }
});

describe("a reconciliation receipt that cannot be compared", () => {
  it("is said to hold back the effect's proof, in the backend's sentence, with each receipt's own words", () => {
    const { container } = render(<AuthorityChainsView data={chains} />);
    const chain = container.querySelector('[data-chain="ch-held-back"]') as HTMLElement;
    const held = within(chain).getByTestId("effect-proof-held-back");
    expect(text(held)).toBe(`A reconciliation receipt that cannot be compared holds back the proof of this effect. Athena-Backend: ${CANNOT_COMPARE_DETAIL}`);
    const receipts = within(chain).getAllByTestId("chain-receipt");
    expect(receipts.map((one) => one.getAttribute("data-receipt"))).toEqual(["rcpt-2", "rcpt-3", "rcpt-4"]);
    expect(text(within(receipts[0]).getByTestId("receipt-binds"))).toBe("binds nothing");
    expect(text(within(receipts[0]).getByTestId("receipt-why"))).toBe(CANNOT_COMPARE_WHY);
    expect(text(within(receipts[1]).getByTestId("receipt-verified"))).toBe("does not verify now");
    // Not said is said: never read as binding.
    expect(text(within(receipts[2]).getByTestId("receipt-binds"))).toBe("whether it binds is not said");
    expect(text(within(receipts[2]).getByTestId("receipt-verified"))).toBe("whether it verifies now is not said");
    expect(text(within(chain).getByTestId("unreadable-rows"))).toBe("4 rows could not be read: reconciliation receipts");
    expect(text(within(chain).getByTestId("chain-effect-outcome"))).toBe("oe-v5");
  });

  it("a chain whose receipts all compare says nothing held back; none recorded and none reported are said apart", () => {
    const { container } = render(<AuthorityChainsView data={chains} />);
    const proven = container.querySelector('[data-chain="ch-proven"]') as HTMLElement;
    expect(within(proven).queryByTestId("effect-proof-held-back")).toBeNull();
    expect(text(within(proven).getByTestId("receipt-binds"))).toBe("binds");
    const none = container.querySelector('[data-chain="ch-no-receipts"]') as HTMLElement;
    expect(text(within(none).getByTestId("chain-no-receipts"))).toBe("none recorded");
    expect(text(within(none).getByTestId("chain-effect-outcome"))).toBe("none cited");
    const older = container.querySelector('[data-chain="ch-older"]') as HTMLElement;
    expect(text(within(older).getByTestId("chain-receipts-not-reported"))).toBe("not reported by this backend");
    expect(within(older).queryByTestId("chain-no-receipts")).toBeNull();
  });
});

describe("what cannot be read, and what was not served", () => {
  it("an unreadable row among good ones is counted beside the list, and every good row is drawn", () => {
    render(<ObservedEffectsView data={answers[DEP]} />);
    const section = screen.getByTestId("observed-effects-section");
    const counts = within(section).getAllByTestId("unreadable-rows").filter((one) => one.getAttribute("data-list") === "outcomes");
    expect(counts.map(text)).toEqual(["4 rows could not be read: chain outcomes"]);
    expect(within(section).getAllByTestId("observed-effect")).toHaveLength(11);
    expect(text(screen.getByTestId("effects-count"))).toBe("11");
    expect(text(screen.getByTestId("effects-truncated"))).toBe(
      "Showing the observed effects among the newest 16 of 340 chain outcomes: the backend returns at most 100 at a time.",
    );
    // The gate's own decision is not drawn as an observed effect.
    expect(document.querySelector('[data-outcome="gate-1"]')).toBeNull();
  });

  it("a part served in a shape that cannot be read says so; one not served says not served; bad rows in a binding or its findings are counted", () => {
    render(<ObservedEffectsView data={answers[DEP]} />);
    const one = card("oe-partial");
    expect(text(within(one).getByTestId("effect-unreadable-fields"))).toBe("Served in a shape that could not be read: action reference, execution");
    expect(text(within(one).getAllByTestId("reference-missing")[0])).toBe("could not be read");
    expect(text(within(one).getByTestId("effect-execution"))).toBe("could not be read");
    // The answer's reference was not served at all.
    expect(within(one).getAllByTestId("reference-missing").map(text)).toContain("not served");
    expect(text(within(one).getByTestId("effect-binding-reading"))).toBe("not served");
    expect(text(within(one).getByTestId("effect-binding-targets"))).toBe("could not be read of a bound of 3");
    const lists = within(one).getAllByTestId("unreadable-rows").map(text);
    expect(lists).toEqual(["4 rows could not be read: approvals", "3 rows could not be read: findings"]);
    // Findings that could not be read are never "no finding".
    expect(within(one).queryByTestId("effect-no-finding")).toBeNull();
    // An approval that serves neither its limit nor its count: not served, never "names none" or "no count".
    const [approval] = within(one).getAllByTestId("binding-approval");
    expect(text(within(approval).getByTestId("approval-limit"))).toBe("not served");
    expect(text(within(approval).getByTestId("approval-counted"))).toBe("not served");
  });

  it("a record the backend serves no reading for, and one whose reading cannot be read, say so apart", () => {
    render(<ObservedEffectsView data={answers[DEP]} />);
    expect(text(within(card("oe-none")).getByTestId("effect-no-reading"))).toMatch(/^Athena-Backend serves no reading of this record/);
    expect(text(within(card("oe-odd")).getByTestId("effect-reading-unreadable"))).toBe("This record's reading was served in a shape that could not be read.");
  });

  it("an older backend: each record's reading is not reported by this backend, never nothing to show", () => {
    render(<ObservedEffectsView data={answers[DEP_OLDER]} />);
    expect(text(screen.getByTestId("effects-not-reported"))).toMatch(/is not reported by this backend\. Each record below says so; none is read as having nothing to show\.$/);
    const cards = screen.getAllByTestId("observed-effect");
    expect(cards.map((one) => one.getAttribute("data-outcome"))).toEqual(["old-1", "old-2"]);
    for (const one of cards) {
      expect(text(within(one).getByTestId("effect-not-reported"))).toMatch(/^This record's reading \(its tool binding, its execution and what is keyed\) is not reported by this backend/);
      expect(within(one).queryByTestId("effect-reading")).toBeNull();
    }
    expect(text(screen.getByTestId("effects-kind-not-said"))).toBe(
      "Chain outcomes that name no kind of evidence and carry no reading: 1. Any of them may be an observed effect this backend does not report.",
    );
    expect(screen.queryByTestId("no-observed-effects")).toBeNull();
  });

  it("an empty page says no outcome was read, and only then", () => {
    render(<ObservedEffectsView data={answers[DEP_EMPTY]} />);
    expect(text(screen.getByTestId("no-observed-effects"))).toBe("No chain outcome is among those read for this deployment.");
    expect(text(screen.getByTestId("effects-recorded"))).toBe("0");
  });
});

describe("hostile names are drawn inert", () => {
  /** Characters that hide or reorder text, listed here, not read from the component. */
  const HIDING = /[؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

  it("a tool name, an approval, a finding, the execution's words, a workflow and an engine: text, never markup, every hidden character boxed", () => {
    const { container } = render(<ObservedEffectsView data={answers[DEP_HOSTILE]} />);
    const one = card("oe-hostile");
    // Nothing from the payload became an element or an attribute that runs or fetches.
    expect(container.querySelectorAll("script, img, iframe, a, style")).toHaveLength(0);
    for (const element of Array.from(container.querySelectorAll("*"))) {
      for (const attribute of Array.from(element.attributes)) expect(attribute.name.startsWith("on"), attribute.name).toBe(false);
    }
    expect((window as { __planted?: unknown }).__planted).toBeUndefined();
    // On the screen as the characters it is.
    const shown = one.textContent ?? "";
    for (const where of ["tool", "approval", "finding", "words", "workflow", "engine", "effect"]) {
      expect(shown.includes(`${where} ${MARKUP}`), where).toBe(true);
    }
    // Every hidden character is alone in its own marked box.
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const bare: string[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const value = node.nodeValue ?? "";
      if (!HIDING.test(value)) continue;
      const box = node.parentElement;
      const marked = box !== null && value.length === 1 && box.getAttribute("data-hidden-char") !== null && box.classList.contains("hidden-char");
      if (!marked) bare.push(JSON.stringify(value.slice(0, 20)));
    }
    expect(bare).toEqual([]);
    const boxed = Array.from(container.querySelectorAll("[data-hidden-char]")).map((one) => one.getAttribute("data-hidden-char"));
    expect(boxed.filter((code) => code === "U+202E").length).toBeGreaterThanOrEqual(7);
    expect(HIDDEN).toContain("‮");
    // The hostile approval still matches its finding: the finding is drawn beside it.
    expect(within(one).getAllByTestId("approval-finding")).toHaveLength(1);
  });
});

describe("no reassurance word and no positive tone in anything drawn", () => {
  const WORD = /\b(?:clean|resolved|secure|secured|safe|safer|all[\s-]clear|no issues|pass|passed|passing|ok)\b/i;

  it("over every shape: the observed effects and the chains' receipts", () => {
    for (const dep of [DEP, DEP_OLDER, DEP_EMPTY, DEP_STATES]) {
      const { container } = render(<ObservedEffectsView data={answers[dep]} />);
      const drawn = container.textContent ?? "";
      expect(drawn.match(WORD), dep).toBeNull();
      expect(lintMicrocopy(drawn), dep).toEqual([]);
      expect(container.querySelectorAll('[data-tone="positive"]'), dep).toHaveLength(0);
      cleanup();
    }
    const { container } = render(<AuthorityChainsView data={chains} />);
    for (const id of ["effect-proof-held-back", "chain-receipts", "chain-receipts-not-reported"]) {
      for (const one of Array.from(container.querySelectorAll(`[data-testid="${id}"]`))) {
        expect((one.textContent ?? "").match(WORD), id).toBeNull();
        expect(lintMicrocopy(one.textContent ?? ""), id).toEqual([]);
        expect(one.querySelectorAll('[data-tone="positive"]'), id).toHaveLength(0);
      }
    }
  });
});
