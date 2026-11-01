// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import Authority from "@/pages/Authority";
import AppShell from "@/components/AppShell";
import { ApprovedWorkflowsView } from "@/components/authority/ApprovedWorkflows";
import { AuthorityChainsView } from "@/components/authority/AuthorityChains";
import { ToolContractsView } from "@/components/authority/ToolContracts";
import { ReleaseGateView } from "@/components/authority/ReleaseGate";
import type {
  ApprovedWorkflows,
  AuthorityChains,
  DecisionSupport,
  ToolAsset,
  WorkflowComposition,
} from "@/components/authority/types";
import { getQueryFn, queryClient as appQueryClient } from "@/lib/queryClient";

/**
 * The four authority screens, each rendered with the shapes this console's
 * server maps from Athena-Backend (tests/the-authority-screens-read-the-backend-
 * as-the-person-and-write-nothing.test.ts pins that mapping):
 *
 *   - what is served is shown as served -- approvals, tools, digests, hops,
 *     readings, effects, the decision and its inputs;
 *   - what is absent says so in words ("not recorded", "not declared", "not
 *     said", "not served"), never a zero, a blank or a green chip;
 *   - an unproven hop is named as one, and a verdict this console does not know
 *     is read as none of proven, unproven or broken;
 *   - on the release gate, AUDIT_INCOMPLETE and an undecided deployment are never
 *     drawn as positive, no input to the decision is ever drawn positive, an input
 *     that places no cap says only that, and under the failsafe pause the inputs
 *     the backend does not read say so;
 *   - what the backend records and does not serve (approval history, contract
 *     history, the decision's earlier revisions, a per-build release decision) is
 *     named on the screen that would show it.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);

const COMPOSITION: WorkflowComposition = {
  signal: "needs_more_evidence", ruleDecision: "needs_more_evidence",
  census: { held: 0, violated: 1, incomplete: 0, not_demonstrated: 1 },
  deciding: ["refunds"], workflowsAssessed: 1, workflowsExpected: 2, workflowsUnreported: 1, workflowsUnapproved: 0,
  workflowsUnexercised: 0, unexercised: [], authorizationChecked: [], offRoute: [],
  explanation: "1 of 2 approved workflow(s) has a chain outcome; refunds violated.",
};

const APPROVED: ApprovedWorkflows = {
  approved: [
    {
      uuid: "wf-1", slug: "refunds", name: "Refunds",
      description: "The support agent may issue refunds up to 100 EUR through the payments tool.",
      approvedBy: "alice", approvedAt: "2026-10-20T09:00:00Z",
      tools: [
        { kind: "tool", identifier: "refund@payments", approvedDigest: A, boundAt: "2026-10-20T09:00:00Z", currentDigest: B, superseded: true },
        { kind: "mcp_server", identifier: "ledger", approvedDigest: C, boundAt: "2026-10-20T09:00:00Z", currentDigest: C, superseded: false },
        { kind: "skill", identifier: "gone-skill", approvedDigest: D, boundAt: "2026-10-19T09:00:00Z", currentDigest: null, superseded: true },
        { kind: "tool", identifier: "odd-tool", approvedDigest: null, boundAt: null, currentDigest: null, superseded: null },
      ],
    },
    { uuid: "wf-2", slug: "lookup", name: "Lookup", description: "", approvedBy: null, approvedAt: null, tools: [] },
  ],
  returned: 2, truncated: false, pageSize: 1000, approvedCount: 2, composition: COMPOSITION,
};

function approvedTool(container: HTMLElement, key: string): HTMLElement {
  const found = container.querySelector(`[data-approved-tool="${key}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no approved tool ${key}`);
  return found;
}

describe("approved workflows", () => {
  it("shows what is approved, by whom and when, and each tool with the contract it was approved under against the one in force", () => {
    const { container } = render(<ApprovedWorkflowsView data={APPROVED} />);
    const refunds = within(container.querySelector('[data-workflow="refunds"]') as HTMLElement);
    expect(refunds.getByTestId("workflow-description").textContent).toBe(APPROVED.approved[0].description);
    expect(refunds.getByTestId("approved-by").textContent).toBe("alice");
    expect(refunds.getByTestId("approved-at").textContent).toBe("2026-10-20T09:00:00Z");

    const changed = within(approvedTool(container, "tool:refund@payments"));
    expect(changed.getByTestId("approved-digest").textContent).toBe(A);
    expect(changed.getByTestId("current-digest").textContent).toBe(B);
    expect(changed.getByTestId("contract-standing").textContent).toBe("Contract changed since approval");
    expect(changed.getByTestId("contract-standing").getAttribute("data-tone")).toBe("caution");

    // Unchanged is a fact about the binding, not a clear result: never green.
    const unchanged = within(approvedTool(container, "mcp_server:ledger"));
    expect(unchanged.getByTestId("contract-standing").textContent).toBe("Contract unchanged since approval");
    expect(unchanged.getByTestId("contract-standing").getAttribute("data-tone")).toBe("neutral");

    const gone = within(approvedTool(container, "skill:gone-skill"));
    expect(gone.getByTestId("contract-standing").textContent).toBe("Tool no longer registered");
    expect(gone.getByTestId("current-digest").textContent).toBe("none: the tool is no longer registered");

    // Nothing served for this binding: every field says so in words.
    const odd = within(approvedTool(container, "tool:odd-tool"));
    expect(odd.getByTestId("contract-standing").textContent).toMatch(/not said/);
    expect(odd.getByTestId("contract-standing").getAttribute("data-absent")).toBe("true");
    expect(odd.getByTestId("approved-digest").textContent).toBe("not recorded");
    expect(odd.getByTestId("bound-at").textContent).toBe("not recorded");
  });

  it("says an approver the backend does not name, a missing description and an approval binding no tools in words", () => {
    const { container } = render(<ApprovedWorkflowsView data={APPROVED} />);
    const lookup = within(container.querySelector('[data-workflow="lookup"]') as HTMLElement);
    expect(lookup.getByTestId("approved-by").textContent).toBe("not on record: the approver's account was removed");
    expect(lookup.getByTestId("workflow-description").textContent).toMatch(/^not recorded/);
    expect(lookup.getByTestId("approved-at").textContent).toBe("not recorded");
    expect(lookup.getByTestId("no-tools").textContent).toBe("This approval binds no tools.");
  });

  it("shows the composition as served, every status with its count", () => {
    render(<ApprovedWorkflowsView data={APPROVED} />);
    expect(screen.getByTestId("workflows-expected").textContent).toBe("2");
    const census = screen.getByTestId("composition-census").textContent ?? "";
    for (const part of ["Held: 0", "Violated: 1", "Incomplete: 0", "Not demonstrated: 1"]) expect(census).toContain(part);
    expect(screen.getByTestId("composition-signal").textContent).toBe("Requires additional evidence");
    expect(screen.getByTestId("composition-explanation").textContent).toBe(COMPOSITION.explanation);
  });

  it("an approved set nobody recorded reads as not recorded, never as zero; an unserved count reads not said", () => {
    render(
      <ApprovedWorkflowsView
        data={{
          approved: [], returned: null, truncated: null, pageSize: null, approvedCount: null,
          composition: { ...COMPOSITION, signal: null, workflowsExpected: null, census: {} },
        }}
      />,
    );
    expect(screen.getByTestId("no-approvals").textContent).toMatch(/^No approved set is recorded for this deployment/);
    expect(screen.getByTestId("workflows-expected").textContent).toBe("none: no approved set is recorded");
    expect(screen.getByTestId("approved-count").textContent).toBe("not said");
    expect(screen.getByTestId("composition-signal").textContent).toBe("nothing");
    expect(screen.getByTestId("composition-census").textContent).toBe("no status census was served");
  });

  it("names the approval history the backend records and does not serve", () => {
    render(<ApprovedWorkflowsView data={APPROVED} />);
    expect(screen.getByTestId("approval-history-not-served").textContent).toMatch(
      /^Approval history: Athena-Backend records each earlier version of an approval and does not serve it to this console\./,
    );
  });

  it("says when the backend returned only a page of the approvals", () => {
    render(<ApprovedWorkflowsView data={{ ...APPROVED, truncated: true, returned: 2, approvedCount: 1400 }} />);
    expect(screen.getByTestId("approved-truncated").textContent).toMatch(/^Showing 2 of 1400/);
  });
});

const CHAINS: AuthorityChains = {
  chains: [
    {
      uuid: "ch-2", workflow: "refunds", effect: "refund issued", digest: `sha256:${"e".repeat(64)}`,
      standing: true, verdict: "unproven", basis: "demonstrated", basisInForce: "attested", signed: false,
      observerEngine: "achilles", outcomeId: "out-2", gateOutcomeId: "gate-2", effectOutcomeId: null, route: "current",
      observedAt: "2026-10-22T10:00:00+00:00", recordedAt: "2026-10-22T10:01:00+00:00", recordedBy: "alice",
      source: "achilles", note: "", unprovenHops: [1], brokenHops: [],
      hops: [
        // Out of order on purpose: the screen draws them by index.
        {
          index: 1, from: { kind: "agent", ref: "support-agent", version: null }, relation: "under_policy",
          to: { kind: "policy", ref: "refunds", version: "f".repeat(64) }, verdict: "unproven", provenBy: [],
          reasons: [{ verdict: "unproven", code: "no_dispatch_state", detail: "the observed effect carries no dispatch state" }],
        },
        {
          index: 0, from: { kind: "person", ref: "alice", version: null }, relation: "authenticated_as",
          to: { kind: "user", ref: "alice@corp", version: null }, verdict: "proven",
          provenBy: [{ verdict: "proven", code: "signed_sign_in", detail: "a signed sign-in names alice@corp" }], reasons: [],
        },
      ],
    },
    {
      uuid: "ch-1", workflow: "refunds", effect: "refund issued", digest: `sha256:${"7".repeat(64)}`,
      standing: false, verdict: "broken", basis: "attested", basisInForce: "attested", signed: false,
      observerEngine: null, outcomeId: null, gateOutcomeId: null, effectOutcomeId: null, route: "moved",
      observedAt: null, recordedAt: "2026-10-21T10:01:00+00:00", recordedBy: null, source: "", note: "typed in by hand",
      unprovenHops: [], brokenHops: [0],
      hops: [
        {
          index: 0, from: { kind: "agent", ref: "support-agent", version: null }, relation: "invokes",
          to: { kind: "tool", ref: "refund@payments", version: null }, verdict: "broken", provenBy: [],
          reasons: [{ verdict: "broken", code: "no_reach", detail: "the agent reaches no such tool" }],
        },
      ],
    },
    {
      uuid: "ch-3", workflow: "lookup", effect: "record read", digest: `sha256:${"6".repeat(64)}`,
      standing: null, verdict: "mostly_fine", basis: "", basisInForce: "", signed: null,
      observerEngine: null, outcomeId: null, gateOutcomeId: null, effectOutcomeId: null, route: null,
      observedAt: null, recordedAt: null, recordedBy: null, source: "", note: "", unprovenHops: [], brokenHops: [],
      hops: [
        {
          index: 0, from: { kind: "agent", ref: "lookup-agent", version: null }, relation: "performs",
          to: { kind: "action", ref: "read", version: null }, verdict: "sort_of", provenBy: [], reasons: [],
        },
      ],
    },
  ],
  returned: 3, truncated: false, pageSize: 100, recorded: 3, standing: 1, superseded: 1,
  verdictCensus: { broken: 0, proven: 0, unproven: 1 },
  approvalsInForce: { refunds: "9".repeat(64) },
  effects: [
    {
      digest: `sha256:${"1".repeat(64)}`, workflow: "refunds", toolKind: "tool", toolIdentifier: "refund@payments",
      effectClass: "write", effectKind: "consequential", status: "covered", reasons: ["declared_write", "chain_in_force"],
      chains: [`sha256:${"e".repeat(64)}`], toDo: null,
    },
    {
      digest: `sha256:${"2".repeat(64)}`, workflow: null, toolKind: "skill", toolIdentifier: "summarise",
      effectClass: null, effectKind: "unknown", status: "unknown", reasons: ["effect_class_undeclared"],
      chains: [], toDo: "declare the effect class of skill 'summarise'",
    },
  ],
  effectCensus: { covered: 1, missing: 0, not_required: 0, unknown: 1 },
};

function chain(container: HTMLElement, uuid: string) {
  const found = container.querySelector(`[data-chain="${uuid}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no chain ${uuid}`);
  return found;
}

describe("authority chains", () => {
  it("draws each chain's hops in order, each with its verdict and what the backend found", () => {
    const { container } = render(<AuthorityChainsView data={CHAINS} />);
    const current = chain(container, "ch-2");
    expect(Array.from(current.querySelectorAll("[data-hop]")).map((hop) => hop.getAttribute("data-hop"))).toEqual(["0", "1"]);
    const [first, second] = Array.from(current.querySelectorAll<HTMLElement>("[data-hop]"));
    expect(within(first).getByTestId("hop-verdict").textContent).toBe("Proven hop");
    expect(within(first).getByTestId("hop-verdict").getAttribute("data-tone")).toBe("positive");
    expect(first.textContent).toContain("signed_sign_in: a signed sign-in names alice@corp");
    // The unproven hop is named as one, with why, and is never drawn positive.
    expect(within(second).getByTestId("hop-verdict").textContent).toBe("Unproven hop");
    expect(within(second).getByTestId("hop-verdict").getAttribute("data-tone")).toBe("caution");
    expect(second.textContent).toContain("no_dispatch_state: the observed effect carries no dispatch state");
    expect(second.textContent).toContain("f".repeat(64));
    expect(within(current).getByTestId("unproven-hops").textContent).toBe("Unproven hop: #1");
    expect(within(current).getByTestId("chain-verdict").textContent).toBe("Unproven");
    expect(within(current).getByTestId("chain-standing").textContent).toBe("In force for its effect");
    // Recorded as signed, and the signature no longer verifies: said, not read as demonstrated.
    expect(current.textContent).toContain("a signature that no longer verifies: read as typed in");
  });

  it("names a broken hop, a superseded chain and what was not recorded", () => {
    const { container } = render(<AuthorityChainsView data={CHAINS} />);
    const older = chain(container, "ch-1");
    expect(within(older).getByTestId("broken-hops").textContent).toBe("Broken hop: #0");
    expect(within(older).getByTestId("hop-verdict").getAttribute("data-tone")).toBe("critical");
    expect(within(older).getByTestId("chain-standing").textContent).toBe("Superseded by a later chain");
    expect(older.textContent).toContain("what was typed in: no engine signed it");
    expect(older.textContent).toContain("recorded against a route that no longer serves");
    expect(older.textContent).toContain("not on record");
  });

  it("reads a verdict it does not know as none of proven, unproven or broken -- never positive", () => {
    const { container } = render(<AuthorityChainsView data={CHAINS} />);
    const odd = chain(container, "ch-3");
    expect(within(odd).getByTestId("chain-verdict").textContent).toBe("verdict not recognised here: mostly_fine");
    expect(within(odd).getByTestId("chain-verdict").getAttribute("data-tone")).toBe("neutral");
    expect(within(odd).getByTestId("hop-verdict").textContent).toBe("verdict not recognised here: sort_of");
    expect(within(odd).getByTestId("hop-verdict").getAttribute("data-tone")).toBe("neutral");
    expect(within(odd).getByTestId("chain-standing").textContent).toMatch(/was not said/);
    expect(odd.textContent).toContain("no reason served");
  });

  it("shows the counts and censuses as served, and an unserved count as not said", () => {
    render(<AuthorityChainsView data={CHAINS} />);
    expect(screen.getByTestId("chains-recorded").textContent).toBe("3");
    expect(screen.getByTestId("verdict-census").textContent).toContain("Unproven: 1");
    expect(screen.getByTestId("verdict-census").textContent).toContain("Broken: 0");
    cleanup();
    render(
      <AuthorityChainsView
        data={{ ...CHAINS, chains: [], effects: [], recorded: null, standing: null, superseded: null, verdictCensus: {}, effectCensus: {}, approvalsInForce: {} }}
      />,
    );
    expect(screen.getByTestId("chains-recorded").textContent).toBe("not said");
    expect(screen.getByTestId("chains-standing").textContent).toBe("not said");
    expect(screen.getByTestId("verdict-census").textContent).toBe("no census was served");
    expect(screen.getByTestId("no-chains").textContent).toBe("No authority chain is recorded for this deployment.");
    expect(screen.getByTestId("no-approvals-in-force").textContent).toBe("No approval is in force.");
  });

  it("lists every effect the approvals cover, with its declared class -- or not declared -- and what to do", () => {
    const { container } = render(<AuthorityChainsView data={CHAINS} />);
    const covered = container.querySelector(`[data-effect="sha256:${"1".repeat(64)}"]`) as HTMLElement;
    expect(within(covered).getByTestId("effect-status").textContent).toBe("A chain in force names it");
    // Covered says a chain names the effect; that chain's verdict decides. Not a positive result on its own.
    expect(within(covered).getByTestId("effect-status").getAttribute("data-tone")).not.toBe("positive");
    expect(within(covered).getByTestId("effect-class").textContent).toBe("write");
    const unknown = container.querySelector(`[data-effect="sha256:${"2".repeat(64)}"]`) as HTMLElement;
    expect(within(unknown).getByTestId("effect-class").textContent).toBe("not declared");
    expect(within(unknown).getByTestId("effect-status").textContent).toBe("Effect class unknown");
    expect(within(unknown).getByTestId("effect-to-do").textContent).toBe("To do: declare the effect class of skill 'summarise'");
    expect(unknown.textContent).toContain("no approval binds it");
    expect(container.querySelector('[data-approval-in-force="refunds"]')?.textContent).toContain("9".repeat(64));
  });
});

const ASSETS: ToolAsset[] = [
  {
    uuid: "as-1", deploymentUuid: "dep-1", kind: "tool", kindLabel: "Tool", name: "Refund", identifier: "refund@payments",
    classification: "approved", classificationLabel: "Approved",
    metadata: {
      effect_class: "write",
      input_schema: { type: "object", properties: { amount: { type: "number" } } },
      permissions: ["payments:refund"],
    },
    firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-30T00:00:00Z",
  },
  {
    uuid: "as-2", deploymentUuid: "dep-1", kind: "skill", kindLabel: "Agent skill", name: "Summarise", identifier: "summarise",
    classification: "unknown", classificationLabel: "Unknown", metadata: {}, firstSeen: null, lastSeen: null,
  },
  {
    uuid: "as-3", deploymentUuid: "dep-1", kind: "mcp_server", kindLabel: "MCP server", name: "Ledger", identifier: "ledger",
    classification: "known", classificationLabel: "Known", metadata: { retired: true, server: "ledger.internal" },
    firstSeen: null, lastSeen: null,
  },
  {
    uuid: "as-4", deploymentUuid: "dep-1", kind: "model", kindLabel: "Model", name: "Model", identifier: "gpt-x",
    classification: "known", classificationLabel: "Known", metadata: { effect_class: "read" }, firstSeen: null, lastSeen: null,
  },
];

function tool(container: HTMLElement, key: string) {
  const found = container.querySelector(`[data-tool="${key}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no tool ${key}`);
  return found;
}

describe("tool contracts", () => {
  it("shows each tool's contract as its registration declares it, and every field it does not declare as not declared", () => {
    const { container } = render(<ToolContractsView assets={ASSETS} workflows={APPROVED} />);
    // Only what carries a contract: a model is not a tool.
    expect(container.querySelector('[data-tool="model:gpt-x"]')).toBeNull();
    const refund = within(tool(container, "tool:refund@payments"));
    expect(refund.getByTestId("contract-effect_class").textContent).toBe("write");
    expect(refund.getByTestId("contract-input_schema").textContent).toContain('"amount"');
    expect(refund.getByTestId("contract-permissions").textContent).toContain("payments:refund");
    for (const field of ["output_schema", "annotations", "server"]) {
      expect(refund.getByTestId(`contract-${field}`).textContent, field).toBe("not declared");
    }
    const summarise = within(tool(container, "skill:summarise"));
    for (const field of ["effect_class", "input_schema", "output_schema", "annotations", "permissions", "server"]) {
      expect(summarise.getByTestId(`contract-${field}`).textContent, field).toBe("not declared");
    }
  });

  it("shows when each approval was bound and whether the contract in force is still that one", () => {
    const { container } = render(<ToolContractsView assets={ASSETS} workflows={APPROVED} />);
    const refund = tool(container, "tool:refund@payments");
    expect(within(refund).getByTestId("digest-in-force").textContent).toBe(B);
    const binding = refund.querySelector('[data-binding="refunds"]') as HTMLElement;
    expect(within(binding).getByTestId("contract-standing").textContent).toBe("Contract changed since approval");
    expect(within(binding).getByTestId("binding-bound-at").textContent).toBe("2026-10-20T09:00:00Z");
    // No approval binds it: the digest in force is not served for it, and that is said.
    const summarise = within(tool(container, "skill:summarise"));
    expect(summarise.getByTestId("no-bindings").textContent).toBe("No approval binds this tool.");
    expect(summarise.getByTestId("digest-in-force").textContent).toBe("not served for a tool no approval binds");
    // A retired registration carries no contract in force.
    expect(within(tool(container, "mcp_server:ledger")).getByTestId("tool-retired").textContent).toMatch(/no contract in force/);
    // An approved tool no registration answers to now is listed apart, not dropped.
    expect(container.querySelector('[data-unregistered-tool="skill:gone-skill"]')).not.toBeNull();
  });

  it("names the contract history the backend records and does not serve", () => {
    render(<ToolContractsView assets={ASSETS} workflows={APPROVED} />);
    expect(screen.getByTestId("contract-history-not-served").textContent).toMatch(
      /^When a contract changed: Athena-Backend records each new contract of a registration, and when it was recorded, and does not serve that history to this console\./,
    );
  });

  it("says the approvals could not be read, rather than that none binds a tool", () => {
    const { container } = render(<ToolContractsView assets={ASSETS} workflows={null} workflowsError="Athena-Backend answered 503" />);
    const refund = within(tool(container, "tool:refund@payments"));
    expect(refund.getByTestId("bindings-error").textContent).toBe("the approvals could not be read: Athena-Backend answered 503");
    expect(refund.queryByTestId("no-bindings")).toBeNull();
  });

  it("says when no tool is registered", () => {
    render(<ToolContractsView assets={[ASSETS[3]]} workflows={{ ...APPROVED, approved: [] }} />);
    expect(screen.getByTestId("no-tools").textContent).toBe("No tool, MCP server or agent skill is registered on this deployment.");
  });
});

function decision(overrides: Partial<DecisionSupport> = {}): DecisionSupport {
  return {
    decision: "audit_incomplete", decisionLabel: "Audit incomplete", revision: 12,
    fromFindings: "ready", claimCap: null, coverageCap: "audit_incomplete", acceptedRiskCap: null,
    policyVersion: "mythos.assurance.policy/1.0+0123456789ab", composition: COMPOSITION, paused: false,
    claims: {
      hasClaims: true, retestPending: false, contradicted: [], stale: [], unknown: [], supporting: [],
      supersededToolContracts: [
        { subject: "workflow", claimFingerprint: null, workflow: "refunds", toolKind: "tool", toolIdentifier: "refund@payments", boundDigest: A, currentDigest: B },
      ],
      authorityChainsBroken: [],
      authorityChainsUnproven: [
        {
          uuid: "ch-2", workflow: "refunds", effect: "refund issued", digest: `sha256:${"e".repeat(64)}`, verdict: "unproven",
          hops: [{ index: 1, relation: "under_policy", from: { kind: "agent", ref: "support-agent", version: null }, to: { kind: "policy", ref: "refunds", version: null }, verdict: "unproven", reasons: ["no_dispatch_state"] }],
        },
      ],
      authorityChainsMissing: [],
      effectClassesUnknown: [],
    },
    note: "Held at 'audit incomplete': 1 critical-path component was never assessed.",
    ...overrides,
  };
}

function input(container: HTMLElement, key: string) {
  const found = container.querySelector(`[data-input="${key}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no input ${key}`);
  return within(found).getByTestId("input-reading");
}

const INPUTS = ["findings", "claims", "coverage", "accepted-risk", "workflow-chains"];

describe("release gate", () => {
  it("never draws AUDIT_INCOMPLETE as positive: the decision, and the coverage input that places it", () => {
    const { container } = render(<ReleaseGateView data={decision()} />);
    const chip = screen.getByTestId("release-decision");
    expect(chip.textContent).toBe("Audit incomplete");
    expect(chip.getAttribute("data-tone")).toBe("caution");
    expect(chip.className).not.toMatch(/emerald/);
    expect(input(container, "coverage").textContent).toBe("Audit incomplete");
    expect(input(container, "coverage").getAttribute("data-tone")).toBe("caution");
    expect(screen.getByTestId("decision-revision").textContent).toBe("r12");
    expect(screen.getByTestId("decision-policy").textContent).toBe("mythos.assurance.policy/1.0+0123456789ab");
    expect(screen.getByTestId("decision-note").textContent).toBe(decision().note);
  });

  it("draws an undecided deployment as not assessed, never positive", () => {
    const { container } = render(<ReleaseGateView data={decision({ decision: null, decisionLabel: null, fromFindings: null, coverageCap: null })} />);
    const chip = screen.getByTestId("release-decision");
    expect(chip.textContent).toBe("Not assessed: no decision is recorded");
    expect(chip.getAttribute("data-tone")).toBe("neutral");
    expect(input(container, "findings").textContent).toBe("Not assessed: no finding-based signal");
  });

  it("draws only a READY decision positive, and never an input -- READY from the findings included", () => {
    for (const state of ["ready", "ready_restricted", "needs_more_evidence", "audit_incomplete", "needs_remediation", "not_recommended", "paused"]) {
      const { container } = render(
        <ReleaseGateView
          data={decision({
            decision: state, decisionLabel: null, fromFindings: state, claimCap: state, coverageCap: state, acceptedRiskCap: state,
            composition: { ...COMPOSITION, signal: state },
          })}
        />,
      );
      expect(screen.getByTestId("release-decision").getAttribute("data-tone") === "positive", state).toBe(state === "ready");
      for (const key of INPUTS) expect(input(container, key).getAttribute("data-tone"), `${state} ${key}`).not.toBe("positive");
      cleanup();
    }
  });

  it("says an input that places no cap places none, in words and never green; coverage says that is not complete coverage", () => {
    const { container } = render(
      <ReleaseGateView data={decision({ decision: "ready", fromFindings: "ready", coverageCap: null, composition: { ...COMPOSITION, signal: null } })} />,
    );
    expect(input(container, "claims").textContent).toBe("Places no cap: no current claim holds the decision back");
    expect(input(container, "coverage").textContent).toMatch(/^Places no cap\. Not a complete-coverage result/);
    expect(input(container, "accepted-risk").textContent).toBe("Places no cap: no accepted risk holds the decision back");
    expect(input(container, "workflow-chains").textContent).toBe("Contributes nothing to the decision");
    for (const key of ["claims", "coverage", "accepted-risk", "workflow-chains"]) {
      expect(input(container, key).getAttribute("data-absent"), key).toBe("true");
      expect(input(container, key).getAttribute("data-tone"), key).toBeNull();
    }
  });

  it("under the failsafe pause, says the inputs the backend does not read are not read -- and still shows the claim cap it does", () => {
    const { container } = render(
      <ReleaseGateView
        data={decision({
          decision: "paused", decisionLabel: "Deployment paused", paused: true, fromFindings: null, coverageCap: null,
          acceptedRiskCap: null, claimCap: "needs_remediation", composition: { ...COMPOSITION, signal: null },
        })}
      />,
    );
    expect(screen.getByTestId("release-decision").textContent).toBe("Deployment paused");
    expect(screen.getByTestId("decision-paused").textContent).toBe("Operator failsafe paused");
    for (const key of ["findings", "coverage", "accepted-risk", "workflow-chains"]) {
      expect(input(container, key).textContent, key).toBe("Not read: the operator failsafe pause decides");
    }
    expect(input(container, "claims").textContent).toBe("Requires remediation");
  });

  it("reads a state it does not know as not recognised, never positive; an unserved revision and policy as not served", () => {
    const { container } = render(
      <ReleaseGateView data={decision({ decision: "super_ready", decisionLabel: null, coverageCap: "ok_ish", revision: null, policyVersion: null })} />,
    );
    expect(screen.getByTestId("release-decision").textContent).toBe("not recognised here: super_ready");
    expect(screen.getByTestId("release-decision").getAttribute("data-tone")).toBe("neutral");
    expect(input(container, "coverage").textContent).toBe("not recognised here: ok_ish");
    expect(screen.getByTestId("decision-revision").textContent).toBe("not served");
    expect(screen.getByTestId("decision-policy").textContent).toBe("not served");
  });

  it("names what holds the decision: a contract changed since its approval, a chain with an unproven hop", () => {
    render(<ReleaseGateView data={decision()} />);
    const contracts = screen.getByTestId("superseded-contracts");
    expect(contracts.textContent).toContain("refund@payments");
    expect(contracts.textContent).toContain(A);
    expect(contracts.textContent).toContain(B);
    const chains = screen.getByTestId("chains-held");
    expect(chains.textContent).toContain("Unproven hop");
    expect(chains.textContent).toContain("no_dispatch_state");
    cleanup();
    render(
      <ReleaseGateView
        data={decision({ claims: { ...decision().claims, supersededToolContracts: [], authorityChainsUnproven: [] } })}
      />,
    );
    expect(screen.getByTestId("nothing-named").textContent).toBe("The backend names no claim, chain, effect or contract here.");
  });

  it("names the release history and the per-build release decision it cannot show", () => {
    render(<ReleaseGateView data={decision()} />);
    const notice = screen.getByTestId("release-history-not-served").textContent ?? "";
    expect(notice).toMatch(/^Release decisions over time: Athena-Backend records each change of this decision and serves only the one in force/);
    expect(notice).toContain("Minotaur-Backend, which this console does not read, so none is shown");
  });
});

/** A fetch that answers as this console's server would, recording each URL; a URL not listed never answers. */
function serve(answers: Record<string, unknown>) {
  const requested: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requested.push(String(url));
    if (!(String(url) in answers)) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return new Response(JSON.stringify(answers[String(url)]), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return requested;
}

function mount(path: string) {
  const location = memoryLocation({ path, record: true });
  // The app's own query defaults, keepPreviousData included: another deployment's
  // answer must never be drawn while this one's is read.
  const client = new QueryClient({
    defaultOptions: { ...appQueryClient.getDefaultOptions(), queries: { ...appQueryClient.getDefaultOptions().queries, queryFn: getQueryFn({ on401: "throw" }) } },
  });
  render(
    <QueryClientProvider client={client}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <Authority params={{ screen: path.split("?")[0].split("/")[2] }} />
      </Router>
    </QueryClientProvider>,
  );
  return location;
}

const STATUS = { configured: true, reachable: true, authorized: true, url: "https://backend", detail: "ok" };
const DEPLOYMENTS = [
  { uuid: "dep-1", name: "acme-chatbot", environment: "production", decision: "audit_incomplete", decisionLabel: "Audit incomplete" },
  { uuid: "dep-2", name: "eu-assistant", environment: "staging", decision: null, decisionLabel: "" },
];

describe("the authority page", () => {
  it("is reached from the Tools list of the shell, for every signed-in person", () => {
    for (const isAdmin of [true, false]) {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <AppShell onLogout={() => {}} isAdmin={isAdmin} username="someone"><div /></AppShell>
        </QueryClientProvider>,
      );
      const link = screen.getByTestId("nav-authority");
      expect(link.getAttribute("href")).toBe("/authority");
      expect(link.textContent).toContain("Authority");
      cleanup();
    }
  });

  it("lists the deployments to choose from, links the four screens, and reads the chosen deployment's record", async () => {
    const requested = serve({
      "/api/assurance/status": STATUS,
      "/api/assurance/deployments": DEPLOYMENTS,
      "/api/assurance/deployments/dep-1/decision-support": decision(),
    });
    mount("/authority/release?deployment=dep-1");
    await waitFor(() => expect(screen.getByTestId("release-decision").textContent).toBe("Audit incomplete"));
    expect(screen.getByTestId("text-authority-source").textContent).toBe("From the Athena-Backend record");
    const picker = screen.getByTestId("authority-deployment") as HTMLSelectElement;
    expect(Array.from(picker.options).map((one) => one.textContent)).toEqual([
      "Choose a deployment",
      "acme-chatbot · production · Audit incomplete",
      "eu-assistant · staging · not assessed",
    ]);
    expect(picker.value).toBe("dep-1");
    for (const [key, label] of [["workflows", "Approved workflows"], ["chains", "Authority chains"], ["contracts", "Tool contracts"], ["release", "Release gate"]]) {
      const tab = screen.getByTestId(`authority-tab-${key}`);
      expect(tab.textContent).toBe(label);
      expect(tab.getAttribute("href")).toBe(`/authority/${key}?deployment=dep-1`);
    }
    expect(screen.getByTestId("authority-tab-release").getAttribute("aria-current")).toBe("page");
    // Reads only: nothing but GETs of the status, the list and the chosen deployment's decision.
    expect(new Set(requested)).toEqual(new Set([
      "/api/assurance/status", "/api/assurance/deployments", "/api/assurance/deployments/dep-1/decision-support",
    ]));
  });

  it("never draws one deployment's record under another while the next is read", async () => {
    serve({
      "/api/assurance/status": STATUS,
      "/api/assurance/deployments": DEPLOYMENTS,
      "/api/assurance/deployments/dep-1/decision-support": decision(),
      // dep-2's never answers.
    });
    const location = mount("/authority/release?deployment=dep-1");
    await waitFor(() => expect(screen.getByTestId("release-decision").textContent).toBe("Audit incomplete"));
    act(() => location.navigate("/authority/release?deployment=dep-2"));
    await waitFor(() => expect(screen.getByTestId("read-loading").textContent).toBe("Reading the release decision…"));
    expect(screen.queryByTestId("release-decision")).toBeNull();
  });

  it("asks for a deployment before reading any record", async () => {
    const requested = serve({ "/api/assurance/status": STATUS, "/api/assurance/deployments": DEPLOYMENTS });
    mount("/authority/chains");
    await waitFor(() => expect(screen.getByTestId("choose-deployment").textContent).toBe("Choose a deployment to read its records."));
    expect(requested.filter((url) => url.startsWith("/api/assurance/deployments/"))).toEqual([]);
  });

  it("says why it is not reading, and offers the Athena-Backend sign-in, when the person has none", async () => {
    const requested = serve({
      "/api/assurance/status": {
        configured: true, reachable: null, authorized: null, url: "https://backend",
        detail: "Sign in to Athena-Backend to read its record as yourself.", code: "backend_sign_in_required",
      },
    });
    mount("/authority/workflows?deployment=dep-1");
    await waitFor(() => expect(screen.getByText("You are not signed in to Athena-Backend.")).toBeTruthy());
    expect(screen.getByTestId("backend-sign-in")).toBeTruthy();
    expect(requested).toEqual(["/api/assurance/status"]);
  });
});
