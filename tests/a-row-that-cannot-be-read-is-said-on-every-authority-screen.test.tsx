// @vitest-environment jsdom
/**
 * Every authority screen says how many rows of a list could not be read, beside
 * the list, and never reads a list whose rows could not be read as an empty one
 * (Dash #89's follow-up).
 *
 * This console's server counts a row of a served list it cannot read under the
 * list's name in `unreadable` (server/assurance.ts rowsOf; tests/a-row-the-
 * backend-served-that-cannot-be-read-is-counted-never-dropped.test.ts). Here, each
 * screen that draws one of those lists is given such counts:
 *
 *   - "N rows could not be read" (or "1 row") is drawn for each list that has
 *     any, and nothing of what such a row held is drawn;
 *   - a list whose every row could not be read does not say there is none: no
 *     "binds no tools", "no hops served", "no chain is recorded", "names no
 *     claim", and no history page that says nothing is recorded;
 *   - a list whose rows were all read draws no such line (the control).
 *
 * The screens: the approved workflows (the set, each approval's tools), the
 * authority chains (the chains, each chain's hops, each hop's readings, the
 * effects), the tool contracts (the approvals that bind a tool), the release
 * gate (each list that holds the decision, a held chain's hops) and the four
 * histories (approval versions and their tools, contracts, bindings, decision
 * changes).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { ApprovalHistoryPages, ApprovedWorkflowsView } from "@/components/authority/ApprovedWorkflows";
import { AuthorityChainsView } from "@/components/authority/AuthorityChains";
import { ToolContractsView } from "@/components/authority/ToolContracts";
import { DecisionHistorySection, ReleaseGateView } from "@/components/authority/ReleaseGate";
import type {
  ApprovedWorkflows, AuthorityChains, DecisionSupport, ToolAsset,
} from "@/components/authority/types";
import { getQueryFn } from "@/lib/queryClient";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const A = "a".repeat(64);
const B = "b".repeat(64);
const DEPLOYMENT = "0f0e0d0c-0b0a-4908-8706-050403020100";

/** The "could not be read" lines on the page, by list: { tools: "1 row could not be read", ... } per element. */
function unreadLines(within: ParentNode = document): Array<[string, string]> {
  return Array.from(within.querySelectorAll("[data-testid='unreadable-rows']")).map((one) => [one.getAttribute("data-list") ?? "", one.textContent ?? ""]);
}

const tool = { kind: "tool", identifier: "refund@payments", approvedDigest: A, boundAt: null, currentDigest: B, superseded: true };

const approvals = (unreadable: boolean): ApprovedWorkflows => ({
  approved: [
    { uuid: "wf-1", slug: "refunds", name: "Refunds", description: "", approvedBy: "alice", approvedAt: null, tools: [], ...(unreadable ? { unreadable: { tools: 1 } } : {}) },
    { uuid: "wf-2", slug: "lookup", name: "Lookup", description: "", approvedBy: "alice", approvedAt: null, tools: [tool] },
  ],
  returned: 5, truncated: false, pageSize: 1000, approvedCount: 5, composition: null,
  ...(unreadable ? { unreadable: { approved: 3 } } : {}),
});

describe("a row that cannot be read is said on every authority screen", () => {
  it("the approved workflows: the set, and an approval's tools, with no 'binds no tools' for one whose only tool could not be read", () => {
    render(<ApprovedWorkflowsView data={approvals(true)} />);
    expect(unreadLines()).toEqual([["tools", "1 row could not be read"], ["approved", "3 rows could not be read"]]);
    const refunds = document.querySelector("[data-workflow='refunds']")!;
    expect(refunds.querySelector("[data-testid='no-tools']"), "an approval whose tool could not be read reads as binding none").toBeNull();
    expect(unreadLines(refunds)).toEqual([["tools", "1 row could not be read"]]);
  });

  it("the approved workflows: a set whose every row could not be read never reads as none recorded", () => {
    render(<ApprovedWorkflowsView data={{ ...approvals(false), approved: [], unreadable: { approved: 2 } }} />);
    expect(screen.queryByTestId("no-approvals")).toBeNull();
    expect(unreadLines()).toEqual([["approved", "2 rows could not be read"]]);
  });

  it("the authority chains: the chains, each chain's hops, each hop's readings and the effects", () => {
    const hop = (verdict: string, list: "provenBy" | "reasons") => ({
      index: 0, from: { kind: "agent", ref: "a", version: null }, relation: "invokes", to: { kind: "tool", ref: "t", version: null },
      verdict, provenBy: [], reasons: [], unreadable: { [list]: 2 },
    });
    const chain = (uuid: string, hops: unknown[], unreadable?: Record<string, number>) => ({
      uuid, workflow: "refunds", effect: "refund issued", digest: `sha256:${uuid}`, standing: true, verdict: "unproven",
      basis: "attested", basisInForce: "attested", signed: false, observerEngine: null, outcomeId: null, gateOutcomeId: null,
      effectOutcomeId: null, route: "current", observedAt: null, recordedAt: null, recordedBy: null, source: "", note: "",
      unprovenHops: [], brokenHops: [], hops, ...(unreadable ? { unreadable } : {}),
    });
    const data = {
      chains: [chain("ch-1", [hop("unproven", "reasons")]), chain("ch-2", [hop("proven", "provenBy")]), chain("ch-3", [], { hops: 4 })],
      returned: 6, truncated: false, pageSize: 100, recorded: 6, standing: 3, superseded: 0, verdictCensus: {}, approvalsInForce: {},
      effects: [], effectCensus: {}, unreadable: { chains: 3, effects: 1 },
    } as unknown as AuthorityChains;
    render(<AuthorityChainsView data={data} />);
    const card = (uuid: string) => document.querySelector(`[data-chain='${uuid}']`)!;
    expect(unreadLines(card("ch-1"))).toEqual([["reasons", "2 rows could not be read"]]);
    expect(card("ch-1").textContent).not.toContain("no reason served");
    expect(unreadLines(card("ch-2"))).toEqual([["provenBy", "2 rows could not be read"]]);
    expect(card("ch-2").textContent).not.toContain("nothing named as proving it");
    expect(unreadLines(card("ch-3"))).toEqual([["hops", "4 rows could not be read"]]);
    expect(card("ch-3").textContent).not.toContain("no hops served");
    expect(unreadLines(screen.getByTestId("chains-section")).slice(-1)).toEqual([["chains", "3 rows could not be read"]]);
    expect(unreadLines(screen.getByTestId("effects-section"))).toEqual([["effects", "1 row could not be read"]]);
    expect(screen.queryByTestId("no-effects")).toBeNull();
  });

  it("the tool contracts: a tool no readable approval binds says the approvals had rows that could not be read", () => {
    const assets: ToolAsset[] = [{
      uuid: "as-1", deploymentUuid: null, kind: "tool", kindLabel: "Tool", name: "Refund", identifier: "ledger@payments",
      classification: "approved", classificationLabel: "Approved", metadata: {}, firstSeen: null, lastSeen: null,
    }];
    render(<ToolContractsView assets={assets} workflows={approvals(true)} />);
    expect(screen.getByTestId("no-bindings").textContent).toBe("No approval that could be read binds this tool.");
    expect(unreadLines(screen.getByTestId("contracts-section"))).toEqual([["approvals", "4 rows could not be read"]]);
  });

  it("the release gate: each list that holds the decision, and a held chain's hops; never 'names nothing' when all could not be read", () => {
    const decision = (claims: Partial<DecisionSupport["claims"]>) => ({
      decision: "audit_incomplete", decisionLabel: "Audit incomplete", revision: 1, fromFindings: null, claimCap: null, coverageCap: null,
      acceptedRiskCap: null, policyVersion: null, composition: null, paused: false, note: "",
      claims: {
        hasClaims: true, retestPending: false, contradicted: [], stale: [], unknown: [], supporting: [],
        supersededToolContracts: [], authorityChainsBroken: [], authorityChainsUnproven: [], authorityChainsMissing: [], effectClassesUnknown: [],
        ...claims,
      },
    }) as unknown as DecisionSupport;
    render(<ReleaseGateView data={decision({
      unreadable: { supersededToolContracts: 1, authorityChainsBroken: 2, authorityChainsUnproven: 3, authorityChainsMissing: 4, effectClassesUnknown: 5 },
    })} />);
    expect(screen.queryByTestId("nothing-named")).toBeNull();
    expect(unreadLines(screen.getByTestId("superseded-contracts"))).toEqual([["supersededToolContracts", "1 row could not be read"]]);
    expect(unreadLines(screen.getByTestId("chains-held"))).toEqual([
      ["authorityChainsBroken", "2 rows could not be read"], ["authorityChainsUnproven", "3 rows could not be read"],
    ]);
    expect(unreadLines(screen.getByTestId("effects-held"))).toEqual([
      ["authorityChainsMissing", "4 rows could not be read"], ["effectClassesUnknown", "5 rows could not be read"],
    ]);
    cleanup();

    render(<ReleaseGateView data={decision({
      authorityChainsUnproven: [{
        uuid: "ch-1", workflow: "refunds", effect: "refund issued", digest: "d", verdict: "unproven", hops: [], unreadable: { hops: 2 },
      }],
    })} />);
    expect(unreadLines(screen.getByTestId("chains-held"))).toEqual([["hops", "2 rows could not be read"]]);
  });

  it("draws no such line where every row was read (the control)", () => {
    render(<ApprovedWorkflowsView data={approvals(false)} />);
    expect(unreadLines()).toEqual([]);
    expect(document.querySelector("[data-workflow='refunds'] [data-testid='no-tools']")).not.toBeNull();
  });
});

/* ---- the histories, read through the screens' own queries ---------------------- */

function serve(answers: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url).split("?")[0];
    const body = answers[path];
    return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200, headers: { "Content-Type": "application/json" } });
  }));
}

function mount(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const page = { deployment: DEPLOYMENT, returned: 5, truncated: false, pageSize: 100, offset: 0 };
const base = `/api/assurance/deployments/${encodeURIComponent(DEPLOYMENT)}`;

describe("a row that cannot be read is said on every history page", () => {
  it("the approval history: the page's versions, and a version's tools; an empty page never says none is recorded", async () => {
    serve({
      [`${base}/approval-history`]: {
        ...page, workflow: null, versionCount: 5, unreadable: { versions: 4 },
        versions: [{
          version: "40", workflow: "refund", digest: B, withdrawn: false, inForceFrom: null, inForceUntil: null, recordedAt: null,
          declaredBy: null, tools: [], unreadable: { tools: 2 },
        }],
      },
    });
    mount(<ApprovalHistoryPages deployment={DEPLOYMENT} />);
    await screen.findByTestId("history-footer");
    expect(unreadLines()).toEqual([["tools", "2 rows could not be read"], ["versions", "4 rows could not be read"]]);
    expect(screen.queryByTestId("version-no-tools")).toBeNull();
    cleanup();

    serve({ [`${base}/approval-history`]: { ...page, workflow: null, versionCount: 3, versions: [], unreadable: { versions: 3 } } });
    mount(<ApprovalHistoryPages deployment={DEPLOYMENT} />);
    await screen.findByTestId("history-footer");
    expect(screen.queryByTestId("no-versions")).toBeNull();
    expect(unreadLines()).toEqual([["versions", "3 rows could not be read"]]);
  });

  it("the decision history: an empty page never says no change is recorded", async () => {
    serve({ [`${base}/decision-history`]: { ...page, transitionCount: 2, transitions: [], unreadable: { transitions: 2 } } });
    mount(<DecisionHistorySection deployment={DEPLOYMENT} />);
    await screen.findByTestId("history-footer");
    expect(document.body.textContent).not.toContain("No change of this deployment");
    expect(unreadLines()).toEqual([["transitions", "2 rows could not be read"]]);
  });

  it("a tool's contracts and bindings: the pages say so, and the digest in force is not read as no contract recorded", async () => {
    serve({
      [`${base}/tool-contracts`]: { ...page, kind: "tool", identifier: "ledger@payments", contractCount: 1, contracts: [], unreadable: { contracts: 1 } },
      [`${base}/tool-contract-bindings`]: { ...page, kind: "tool", identifier: "ledger@payments", bindingCount: 2, bindings: [], unreadable: { bindings: 2 } },
    });
    const assets: ToolAsset[] = [{
      uuid: "as-1", deploymentUuid: DEPLOYMENT, kind: "tool", kindLabel: "Tool", name: "Ledger", identifier: "ledger@payments",
      classification: "approved", classificationLabel: "Approved", metadata: {}, firstSeen: null, lastSeen: null,
    }];
    mount(<ToolContractsView assets={assets} workflows={{ ...approvals(false), approved: [] }} deployment={DEPLOYMENT} />);
    await act(async () => { fireEvent.click(screen.getByTestId("tool-contract-history-toggle")); });
    await screen.findAllByTestId("history-footer");
    const history = screen.getByTestId("tool-contract-history");
    expect(history.textContent).not.toContain("No contract of this registration is recorded.");
    expect(history.textContent).not.toContain("No approval or claim is on record as bound");
    expect(unreadLines(history)).toEqual([["contracts", "1 row could not be read"], ["bindings", "2 rows could not be read"]]);
    expect(screen.getByTestId("digest-in-force").textContent).toBe("not shown: the recorded contracts could not be read");
  });
});
