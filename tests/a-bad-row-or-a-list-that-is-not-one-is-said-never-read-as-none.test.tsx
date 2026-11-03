// @vitest-environment jsdom
/**
 * A claim row that could not be read, and a list served as something that is
 * not a list, are said on screen: never read as "none" (DASH-HOSTILE-2).
 *
 * The server now counts a claim row it cannot read under its list's name
 * (contradicted, stale, unknown, supporting), where one such row used to fail
 * the whole decision-support read; and it marks a list served as a string, a
 * number, a record or true as "not a list" (server/assurance.ts rowsOf; tests/no-
 * read-fails-whole-on-one-bad-row-and-no-list-that-is-not-one-reads-as-none.
 * test.ts). Here, each screen that draws one of those lists is given them:
 *
 *   - the release gate and the assurance page's decision-support panel say
 *     "N rows could not be read" beside each claim list, and do not say the
 *     backend names nothing;
 *   - a list that is not a list reads "The list could not be read", in the same
 *     place and the same words a row that could not be read uses, and never the
 *     list's "none" line: on the approved workflows, the authority chains, the
 *     tool contracts, the release gate and the histories;
 *   - a list whose rows were all read draws no such line (the control).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { ApprovalHistoryPages, ApprovedWorkflowsView } from "@/components/authority/ApprovedWorkflows";
import { AuthorityChainsView } from "@/components/authority/AuthorityChains";
import { ToolContractsView } from "@/components/authority/ToolContracts";
import { DecisionHistorySection, ReleaseGateView } from "@/components/authority/ReleaseGate";
import type { ApprovedWorkflows, AuthorityChains, DecisionSupport, ToolAsset } from "@/components/authority/types";
import { DecisionSupportPanel } from "@/pages/Assurance";
import { getQueryFn } from "@/lib/queryClient";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOT_A_LIST = "not a list";
const WHOLE = "The list could not be read";
const B = "b".repeat(64);
const DEPLOYMENT = "0f0e0d0c-0b0a-4908-8706-050403020100";

/** The "could not be read" lines on the page, by list. */
function unreadLines(within: ParentNode = document): Array<[string, string]> {
  return Array.from(within.querySelectorAll("[data-testid='unreadable-rows']")).map((one) => [one.getAttribute("data-list") ?? "", one.textContent ?? ""]);
}

const claim = (uuid: string, status: string) => ({ uuid, claimType: "authz_boundary", status, statement: `claim ${uuid}` });

const decision = (claims: Partial<DecisionSupport["claims"]>) => ({
  decision: "needs_more_evidence", decisionLabel: "Needs more evidence", revision: 3, fromFindings: null, claimCap: null, coverageCap: null,
  acceptedRiskCap: null, policyVersion: null, composition: null, paused: false, note: "",
  claims: {
    hasClaims: true, retestPending: false, contradicted: [], stale: [], unknown: [], supporting: [],
    supersededToolContracts: [], authorityChainsBroken: [], authorityChainsUnproven: [], authorityChainsMissing: [], effectClassesUnknown: [],
    ...claims,
  },
}) as unknown as DecisionSupport;

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

describe("1. a claim row that could not be read is said beside its list", () => {
  it("the release gate: contradicted, stale and unknown claims, with no 'names nothing' when every row could not be read", () => {
    render(<ReleaseGateView data={decision({ unreadable: { contradicted: 2, stale: 1, unknown: 3 } })} />);
    expect(screen.queryByTestId("nothing-named")).toBeNull();
    expect(unreadLines(screen.getByTestId("claims-contradicted"))).toEqual([["contradicted", "2 rows could not be read"]]);
    expect(unreadLines(screen.getByTestId("claims-stale"))).toEqual([["stale", "1 row could not be read"], ["unknown", "3 rows could not be read"]]);
  });

  it("the release gate: the claims that could be read are drawn beside the count", () => {
    render(<ReleaseGateView data={decision({ contradicted: [claim("c-1", "contradicted")], unreadable: { contradicted: 1 } })} />);
    const contradicted = screen.getByTestId("claims-contradicted");
    expect(contradicted.textContent).toContain("claim c-1");
    expect(unreadLines(contradicted)).toEqual([["contradicted", "1 row could not be read"]]);
  });

  it("the assurance page's decision-support panel: each claim list, read through its own query", async () => {
    serve({
      "/api/assurance/deployments/dep-1/decision-support": decision({
        contradicted: [claim("c-1", "contradicted")], supporting: [],
        unreadable: { contradicted: 1, stale: 2, unknown: NOT_A_LIST, supporting: 4 },
      }),
    });
    mount(<DecisionSupportPanel deploymentUuid="dep-1" />);
    const contradicted = await screen.findByTestId("decision-claims-contradicted");
    expect(contradicted.textContent).toContain("claim c-1");
    expect(unreadLines(contradicted)).toEqual([["contradicted", "1 row could not be read"]]);
    expect(unreadLines(screen.getByTestId("decision-claims-stale"))).toEqual([["stale", "2 rows could not be read"]]);
    expect(unreadLines(screen.getByTestId("decision-claims-unknown"))).toEqual([["unknown", WHOLE]]);
    expect(unreadLines(screen.getByTestId("decision-claims-supporting"))).toEqual([["supporting", "4 rows could not be read"]]);
  });

  it("the decision-support panel draws no such line where every row was read (the control)", async () => {
    serve({ "/api/assurance/deployments/dep-1/decision-support": decision({ contradicted: [claim("c-1", "contradicted")] }) });
    mount(<DecisionSupportPanel deploymentUuid="dep-1" />);
    await screen.findByTestId("decision-claims-contradicted");
    expect(unreadLines()).toEqual([]);
    expect(screen.queryByTestId("decision-claims-stale")).toBeNull();
  });
});

const tool = { kind: "tool", identifier: "refund@payments", approvedDigest: "a".repeat(64), boundAt: null, currentDigest: B, superseded: true };
const workflow = (slug: string, extra: Record<string, unknown> = {}) => ({
  uuid: `wf-${slug}`, slug, name: slug, description: "", approvedBy: "alice", approvedAt: null, tools: [], ...extra,
});
const approvals = (extra: Partial<ApprovedWorkflows>): ApprovedWorkflows => ({
  approved: [], returned: 1, truncated: false, pageSize: 1000, approvedCount: 1, composition: null, ...extra,
}) as ApprovedWorkflows;

describe("2. a list that is not a list reads 'The list could not be read', never none", () => {
  it("the approved workflows: the set, and an approval's tools", () => {
    render(<ApprovedWorkflowsView data={approvals({ unreadable: { approved: NOT_A_LIST } })} />);
    expect(screen.queryByTestId("no-approvals")).toBeNull();
    expect(unreadLines()).toEqual([["approved", WHOLE]]);
    cleanup();

    render(<ApprovedWorkflowsView data={approvals({ approved: [workflow("refunds", { unreadable: { tools: NOT_A_LIST } })] } as never)} />);
    const refunds = document.querySelector("[data-workflow='refunds']")!;
    expect(refunds.querySelector("[data-testid='no-tools']"), "an approval whose tools were not a list reads as binding none").toBeNull();
    expect(unreadLines(refunds)).toEqual([["tools", WHOLE]]);
  });

  it("the authority chains: the chains, the effects, a chain's hops and a hop's readings", () => {
    const hop = (verdict: string, list: "provenBy" | "reasons") => ({
      index: 0, from: { kind: "agent", ref: "a", version: null }, relation: "invokes", to: { kind: "tool", ref: "t", version: null },
      verdict, provenBy: [], reasons: [], unreadable: { [list]: NOT_A_LIST },
    });
    const chain = (uuid: string, hops: unknown[], unreadable?: Record<string, string>) => ({
      uuid, workflow: "refunds", effect: "refund issued", digest: `sha256:${uuid}`, standing: true, verdict: "unproven",
      basis: "attested", basisInForce: "attested", signed: false, observerEngine: null, outcomeId: null, gateOutcomeId: null,
      effectOutcomeId: null, route: "current", observedAt: null, recordedAt: null, recordedBy: null, source: "", note: "",
      unprovenHops: [], brokenHops: [], hops, ...(unreadable ? { unreadable } : {}),
    });
    const data = {
      chains: [chain("ch-1", [hop("unproven", "reasons")]), chain("ch-2", [hop("proven", "provenBy")]), chain("ch-3", [], { hops: NOT_A_LIST })],
      returned: 3, truncated: false, pageSize: 100, recorded: 3, standing: 3, superseded: 0, verdictCensus: {}, approvalsInForce: {},
      effects: [], effectCensus: {}, unreadable: { chains: NOT_A_LIST, effects: NOT_A_LIST },
    } as unknown as AuthorityChains;
    render(<AuthorityChainsView data={data} />);
    const card = (uuid: string) => document.querySelector(`[data-chain='${uuid}']`)!;
    expect(unreadLines(card("ch-1"))).toEqual([["reasons", WHOLE]]);
    expect(card("ch-1").textContent).not.toContain("no reason served");
    expect(unreadLines(card("ch-2"))).toEqual([["provenBy", WHOLE]]);
    expect(card("ch-2").textContent).not.toContain("nothing named as proving it");
    expect(unreadLines(card("ch-3"))).toEqual([["hops", WHOLE]]);
    expect(card("ch-3").textContent).not.toContain("no hops served");
    expect(unreadLines(screen.getByTestId("chains-section")).slice(-1)).toEqual([["chains", WHOLE]]);
    expect(unreadLines(screen.getByTestId("effects-section"))).toEqual([["effects", WHOLE]]);
    expect(screen.queryByTestId("no-effects")).toBeNull();
  });

  it("the tool contracts: a tool no readable approval binds says the approvals could not be read, never a count nobody knows", () => {
    const assets: ToolAsset[] = [{
      uuid: "as-1", deploymentUuid: null, kind: "tool", kindLabel: "Tool", name: "Refund", identifier: "ledger@payments",
      classification: "approved", classificationLabel: "Approved", metadata: {}, firstSeen: null, lastSeen: null,
    }];
    const workflows = approvals({ approved: [workflow("refunds", { tools: [tool] }), workflow("lookup", { unreadable: { tools: NOT_A_LIST } })], unreadable: { approved: 2 } } as never);
    render(<ToolContractsView assets={assets} workflows={workflows} />);
    expect(screen.getByTestId("no-bindings").textContent).toBe("No approval that could be read binds this tool.");
    expect(unreadLines(screen.getByTestId("contracts-section"))).toEqual([["approvals", WHOLE]]);
  });

  it("the release gate: each list that holds the decision, and a held chain's hops", () => {
    render(<ReleaseGateView data={decision({
      unreadable: {
        contradicted: NOT_A_LIST, stale: NOT_A_LIST, unknown: NOT_A_LIST, supersededToolContracts: NOT_A_LIST,
        authorityChainsBroken: NOT_A_LIST, authorityChainsUnproven: NOT_A_LIST, authorityChainsMissing: NOT_A_LIST, effectClassesUnknown: NOT_A_LIST,
      },
    })} />);
    expect(screen.queryByTestId("nothing-named")).toBeNull();
    expect(unreadLines(screen.getByTestId("claims-contradicted"))).toEqual([["contradicted", WHOLE]]);
    expect(unreadLines(screen.getByTestId("claims-stale"))).toEqual([["stale", WHOLE], ["unknown", WHOLE]]);
    expect(unreadLines(screen.getByTestId("superseded-contracts"))).toEqual([["supersededToolContracts", WHOLE]]);
    expect(unreadLines(screen.getByTestId("chains-held"))).toEqual([["authorityChainsBroken", WHOLE], ["authorityChainsUnproven", WHOLE]]);
    expect(unreadLines(screen.getByTestId("effects-held"))).toEqual([["authorityChainsMissing", WHOLE], ["effectClassesUnknown", WHOLE]]);
    cleanup();

    render(<ReleaseGateView data={decision({
      authorityChainsUnproven: [{ uuid: "ch-1", workflow: "refunds", effect: "refund issued", digest: "d", verdict: "unproven", hops: [], unreadable: { hops: NOT_A_LIST } }],
    } as never)} />);
    expect(unreadLines(screen.getByTestId("chains-held"))).toEqual([["hops", WHOLE]]);
  });

  const page = { deployment: DEPLOYMENT, returned: 1, truncated: false, pageSize: 100, offset: 0 };
  const base = `/api/assurance/deployments/${encodeURIComponent(DEPLOYMENT)}`;

  it("the approval history: a page, and a version's tools", async () => {
    serve({
      [`${base}/approval-history`]: {
        ...page, workflow: null, versionCount: 1,
        versions: [{
          version: "40", workflow: "refund", digest: B, withdrawn: false, inForceFrom: null, inForceUntil: null, recordedAt: null,
          declaredBy: null, tools: [], unreadable: { tools: NOT_A_LIST },
        }],
      },
    });
    mount(<ApprovalHistoryPages deployment={DEPLOYMENT} />);
    await screen.findByTestId("history-footer");
    expect(screen.queryByTestId("version-no-tools")).toBeNull();
    expect(unreadLines()).toEqual([["tools", WHOLE]]);
    cleanup();

    serve({ [`${base}/approval-history`]: { ...page, workflow: null, versionCount: 1, versions: [], unreadable: { versions: NOT_A_LIST } } });
    mount(<ApprovalHistoryPages deployment={DEPLOYMENT} />);
    await screen.findByTestId("history-footer");
    expect(screen.queryByTestId("no-versions")).toBeNull();
    expect(unreadLines()).toEqual([["versions", WHOLE]]);
  });

  it("the decision history", async () => {
    serve({ [`${base}/decision-history`]: { ...page, transitionCount: 1, transitions: [], unreadable: { transitions: NOT_A_LIST } } });
    mount(<DecisionHistorySection deployment={DEPLOYMENT} />);
    await screen.findByTestId("history-footer");
    expect(document.body.textContent).not.toContain("No change of this deployment");
    expect(unreadLines()).toEqual([["transitions", WHOLE]]);
  });

  it("a tool's contracts and bindings, and the digest in force", async () => {
    serve({
      [`${base}/tool-contracts`]: { ...page, kind: "tool", identifier: "ledger@payments", contractCount: 1, contracts: [], unreadable: { contracts: NOT_A_LIST } },
      [`${base}/tool-contract-bindings`]: { ...page, kind: "tool", identifier: "ledger@payments", bindingCount: 1, bindings: [], unreadable: { bindings: NOT_A_LIST } },
    });
    const assets: ToolAsset[] = [{
      uuid: "as-1", deploymentUuid: DEPLOYMENT, kind: "tool", kindLabel: "Tool", name: "Ledger", identifier: "ledger@payments",
      classification: "approved", classificationLabel: "Approved", metadata: {}, firstSeen: null, lastSeen: null,
    }];
    mount(<ToolContractsView assets={assets} workflows={approvals({})} deployment={DEPLOYMENT} />);
    await act(async () => { fireEvent.click(screen.getByTestId("tool-contract-history-toggle")); });
    await screen.findAllByTestId("history-footer");
    const history = screen.getByTestId("tool-contract-history");
    expect(history.textContent).not.toContain("No contract of this registration is recorded.");
    expect(history.textContent).not.toContain("No approval or claim is on record as bound");
    expect(unreadLines(history)).toEqual([["contracts", WHOLE], ["bindings", WHOLE]]);
    expect(screen.getByTestId("digest-in-force").textContent).toBe("not shown: the recorded contracts could not be read");
  });

  it("draws no such line where every list was a list and every row was read (the control)", () => {
    render(<ApprovedWorkflowsView data={approvals({ approved: [workflow("refunds")] } as never)} />);
    expect(unreadLines()).toEqual([]);
    expect(document.querySelector("[data-workflow='refunds'] [data-testid='no-tools']")).not.toBeNull();
  });
});
