// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import Authority from "@/pages/Authority";
import { ApprovalVersionList, ApprovalVersionRow } from "@/components/authority/ApprovedWorkflows";
import { BindingRecordList, BindingRecordRow, ContractRecordList, ContractRecordRow } from "@/components/authority/ToolContracts";
import { DecisionTransitionList, DecisionTransitionRow } from "@/components/authority/ReleaseGate";
import { answeredFor, nextOffset } from "@/components/authority/history";
import type {
  ApprovalHistory,
  ApprovalVersion,
  ApprovedWorkflows,
  DecisionHistory,
  DecisionSupport,
  ToolAsset,
  ToolContractBindingRecord,
  ToolContractBindings,
  ToolContractHistory,
  ToolContractRecord,
} from "@/components/authority/types";
import { getQueryFn, queryClient as appQueryClient } from "@/lib/queryClient";

/**
 * The history sections of the authority screens, over what Athena-Backend's history
 * reads serve (server/assurance.ts approvalHistory, toolContractHistory,
 * toolContractBindings, decisionHistory; the mapping is pinned by
 * tests/the-authority-screens-read-the-backend-as-the-person-and-write-nothing.test.ts):
 *
 *   - every version of an approval, with its digest or that it was withdrawn, from
 *     when until when it was in force, who declared it -- or "not recorded" -- and
 *     every tool with the binding live then: bound at, by whom, released, invalidated;
 *   - each registration's contracts, superseded_at, in_force, the digest in force
 *     (for a tool no approval binds too), and every binding, live or released, with
 *     its invalidation;
 *   - every change of the decision, from -> to, basis, accepted and confirmed, in
 *     neutral tones: nothing in it reads positive;
 *   - what is absent says so in words; an empty history says none is recorded;
 *   - "Load more" reads on from offset + returned, only while the backend says there
 *     is more;
 *   - nothing read for one deployment is drawn under another, the pages read
 *     included; and nothing is read for an approval or a tool until it is opened.
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
const E = "e".repeat(64);

/** Every chip under `root`, by the tone it is drawn in. */
function tones(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("[data-tone]")).map((one) => one.getAttribute("data-tone") ?? "");
}

function version(overrides: Partial<ApprovalVersion> = {}): ApprovalVersion {
  return {
    version: "40", workflow: "refunds", digest: B, withdrawn: false,
    inForceFrom: "2026-10-20T00:00:00Z", inForceUntil: null, recordedAt: "2026-10-21T00:00:00Z", declaredBy: "carol",
    tools: [{
      kind: "tool", identifier: "refund@payments", contractDigest: C, boundAt: "2026-10-20T00:00:00Z",
      boundBy: "binder", releasedAt: "2026-10-25T00:00:00Z", invalidatedAt: "2026-10-24T00:00:00Z",
      invalidationReason: "Tool contract changed: refund@payments",
    }],
    ...overrides,
  };
}

describe("approval history", () => {
  it("shows a version's digest, when it was in force, who declared it, and each tool with the binding live then", () => {
    const { container } = render(<ul><ApprovalVersionRow version={version()} showWorkflow /></ul>);
    const row = within(container);
    expect(row.getByTestId("version-workflow").textContent).toBe("refunds");
    expect(row.getByTestId("version-digest").textContent).toBe(B);
    expect(row.getByTestId("version-from").textContent).toBe("2026-10-20T00:00:00Z");
    expect(row.getByTestId("version-until").textContent).toBe("no later version is recorded");
    expect(row.getByTestId("version-recorded-at").textContent).toBe("2026-10-21T00:00:00Z");
    expect(row.getByTestId("version-declared-by").textContent).toBe("carol");
    const tool = within(container.querySelector('[data-version-tool="tool:refund@payments"]') as HTMLElement);
    expect(tool.getByTestId("version-tool-digest").textContent).toBe(C);
    expect(tool.getByTestId("version-tool-bound-at").textContent).toBe("2026-10-20T00:00:00Z");
    expect(tool.getByTestId("version-tool-bound-by").textContent).toBe("binder");
    expect(tool.getByTestId("version-tool-released-at").textContent).toBe("2026-10-25T00:00:00Z");
    expect(tool.getByTestId("version-tool-invalidation").textContent).toBe("2026-10-24T00:00:00Z Tool contract changed: refund@payments");
    expect(tool.getByTestId("version-tool-invalidated").getAttribute("data-tone")).toBe("caution");
    // Nothing in a version's history is drawn as a clear result.
    expect(tones(container)).not.toContain("positive");
  });

  it("says who declared a version is not recorded, whether the backend served the field as null or not at all", () => {
    for (const declaredBy of [null, undefined]) {
      // undefined: what a mapper would hand on had it not carried the backend's absent field as null.
      const { container } = render(
        <ul><ApprovalVersionRow version={version({ declaredBy: declaredBy as unknown as null })} showWorkflow={false} /></ul>,
      );
      const declared = within(container).getByTestId("version-declared-by");
      expect(declared.textContent).toBe("not recorded");
      expect(declared.getAttribute("data-absent")).toBe("true");
      // One approval's history does not repeat its slug on every version.
      expect(within(container).queryByTestId("version-workflow")).toBeNull();
      cleanup();
    }
  });

  it("draws a withdrawn version as withdrawn, neutral, with no digest and no tools", () => {
    const { container } = render(
      <ul>
        <ApprovalVersionRow
          version={version({ version: "41", digest: null, withdrawn: true, tools: [], inForceFrom: "2026-10-30T00:00:00Z", declaredBy: null })}
          showWorkflow
        />
      </ul>,
    );
    const row = within(container);
    expect(row.getByTestId("version-withdrawn").textContent).toBe("Withdrawn");
    expect(row.getByTestId("version-withdrawn").getAttribute("data-tone")).toBe("neutral");
    expect(row.getByTestId("version-digest").textContent).toBe("none: withdrawn");
    expect(row.getByTestId("version-no-tools").textContent).toBe("A withdrawn approval binds no tools.");
  });

  it("says in words what a version's record does not hold: no binding of a tool, a tool, an id, the binder, a release, an invalidation", () => {
    const { container } = render(
      <ul>
        <ApprovalVersionRow
          version={version({
            version: null, withdrawn: null, digest: null, inForceUntil: "2026-10-30T00:00:00Z",
            tools: [
              // The approval was withdrawn since, deleting its bindings: the tool and digest are named, no binding is.
              { kind: "mcp_server", identifier: "files-mcp", contractDigest: A, boundAt: null, boundBy: null, releasedAt: null, invalidatedAt: null, invalidationReason: null },
              { kind: null, identifier: null, contractDigest: null, boundAt: null, boundBy: null, releasedAt: null, invalidatedAt: null, invalidationReason: null },
              { kind: "tool", identifier: "lookup", contractDigest: E, boundAt: "2026-10-20T00:00:00Z", boundBy: null, releasedAt: null, invalidatedAt: null, invalidationReason: null },
            ],
          })}
          showWorkflow
        />
      </ul>,
    );
    const row = within(container);
    expect(row.getByTestId("version-withdrawn").textContent).toBe("whether it was withdrawn was not said");
    expect(row.getByTestId("version-digest").textContent).toBe("not recorded");
    expect(row.getByTestId("version-until").textContent).toBe("2026-10-30T00:00:00Z");
    expect(container.textContent).toContain("id not served");
    const unbound = within(container.querySelector('[data-version-tool="mcp_server:files-mcp"]') as HTMLElement);
    expect(unbound.getByTestId("version-tool-no-binding").textContent).toBe(
      "No binding of it is on record for when this version came into force.",
    );
    expect(unbound.queryByTestId("version-tool-released-at")).toBeNull();
    const nameless = within(container.querySelector('[data-version-tool=":"]') as HTMLElement);
    expect(nameless.getByTestId("version-tool-name").textContent).toBe("the tool is not recorded on this version");
    expect(nameless.getByTestId("version-tool-digest").textContent).toBe("not recorded");
    const live = within(container.querySelector('[data-version-tool="tool:lookup"]') as HTMLElement);
    expect(live.getByTestId("version-tool-bound-by").textContent).toBe("not on record");
    expect(live.getByTestId("version-tool-released-at").textContent).toBe("not released");
    expect(live.getByTestId("version-tool-invalidation").textContent).toBe("not invalidated");
    expect(live.queryByTestId("version-tool-invalidated")).toBeNull();
  });

  it("says no version is recorded on an empty first page, and nothing on an empty later one", () => {
    render(<ApprovalVersionList versions={[]} showWorkflow={false} empty="No version of this approval is recorded." />);
    expect(screen.getByTestId("no-versions").textContent).toBe("No version of this approval is recorded.");
    cleanup();
    const { container } = render(<ApprovalVersionList versions={[]} showWorkflow={false} empty={null} />);
    expect(container.textContent).toBe("");
  });
});

function contract(overrides: Partial<ToolContractRecord> = {}): ToolContractRecord {
  return {
    kind: "tool", identifier: "refund@payments", digest: B,
    contract: { contract_version: 1, kind: "tool", identifier: "refund@payments", effect_class: "write", input_schema: null, permissions: ["payments:refund"] },
    recordedAt: "2026-10-20T00:00:00Z", supersededAt: null, currentDigest: B, inForce: true,
    ...overrides,
  };
}

function binding(overrides: Partial<ToolContractBindingRecord> = {}): ToolContractBindingRecord {
  return {
    subject: "workflow", workflow: "refunds", claimFingerprint: null, kind: "tool", identifier: "refund@payments",
    contractDigest: B, currentDigest: B, live: true, superseded: false, boundAt: "2026-10-20T00:00:00Z",
    boundBy: "binder", releasedAt: null, invalidatedAt: null, invalidationReason: null,
    ...overrides,
  };
}

describe("contract history", () => {
  it("shows each contract recorded: in force or not, neutral; when recorded and superseded; the digest in force; the descriptor as recorded", () => {
    const { container } = render(
      <ContractRecordList
        first
        records={[
          contract(),
          contract({ digest: A, supersededAt: "2026-10-20T00:00:00Z", recordedAt: "2026-10-01T00:00:00Z", inForce: false }),
        ]}
      />,
    );
    const current = within(container.querySelector(`[data-contract-record="${B}"]`) as HTMLElement);
    expect(current.getByTestId("record-in-force").textContent).toBe("In force now");
    expect(current.getByTestId("record-superseded-at").textContent).toBe("not superseded: no later contract of it is recorded");
    expect(current.getByTestId("record-current-digest").textContent).toBe(B);
    expect(current.getByTestId("record-contract-effect_class").textContent).toBe("write");
    expect(current.getByTestId("record-contract-permissions").textContent).toContain("payments:refund");
    // A field the descriptor holds as null, or not at all, is not declared.
    expect(current.getByTestId("record-contract-input_schema").textContent).toBe("not declared");
    expect(current.getByTestId("record-contract-server").textContent).toBe("not declared");
    const older = within(container.querySelector(`[data-contract-record="${A}"]`) as HTMLElement);
    expect(older.getByTestId("record-in-force").textContent).toBe("Not in force");
    expect(older.getByTestId("record-recorded-at").textContent).toBe("2026-10-01T00:00:00Z");
    expect(older.getByTestId("record-superseded-at").textContent).toBe("2026-10-20T00:00:00Z");
    expect(older.queryByTestId("record-unrecorded-change")).toBeNull();
    // In force is a fact about the row, not a clear result.
    expect(tones(container)).toEqual(["neutral", "neutral"]);
  });

  it("says a tool no longer registered has no contract in force, a change no row records, an unsaid standing and an unserved descriptor", () => {
    const { container } = render(
      <ContractRecordList
        first
        records={[
          contract({ kind: "skill", identifier: "retired-skill", digest: C, currentDigest: null, inForce: false, contract: null }),
          contract({ digest: A, currentDigest: B, inForce: false }),
          contract({ digest: E, inForce: null }),
        ]}
      />,
    );
    const retired = within(container.querySelector(`[data-contract-record="${C}"]`) as HTMLElement);
    expect(retired.getByTestId("record-current-digest").textContent).toBe("none: the tool is no longer registered");
    expect(retired.getByTestId("record-contract").textContent).toBe("not served");
    expect(retired.queryByTestId("record-unrecorded-change")).toBeNull();
    const moved = within(container.querySelector(`[data-contract-record="${A}"]`) as HTMLElement);
    expect(moved.getByTestId("record-unrecorded-change").textContent).toBe(
      "The contract in force now is not this one, and no later contract of the registration is recorded.",
    );
    const unsaid = within(container.querySelector(`[data-contract-record="${E}"]`) as HTMLElement);
    expect(unsaid.getByTestId("record-in-force").textContent).toBe("whether it is in force was not said");
  });

  it("shows each binding, live or released, with its invalidation and release; a released one is given no standing", () => {
    const { container } = render(
      <BindingRecordList
        first
        bindings={[
          binding(),
          binding({
            contractDigest: A, live: false, superseded: null, boundAt: "2026-10-01T00:00:00Z", releasedAt: "2026-10-20T00:00:00Z",
            invalidatedAt: "2026-10-15T00:00:00Z", invalidationReason: "Tool contract changed: refund@payments", boundBy: null,
          }),
          binding({ subject: "claim", workflow: null, claimFingerprint: "f".repeat(64), currentDigest: null, superseded: true, boundBy: null }),
        ]}
      />,
    );
    const [live, released, claim] = Array.from(container.querySelectorAll<HTMLElement>("[data-binding-record]")).map((one) => within(one));
    expect(live.getByTestId("binding-subject").textContent).toBe("Approval of refunds");
    expect(live.getByTestId("binding-live").textContent).toBe("Live");
    expect(live.getByTestId("binding-standing").textContent).toBe("Contract unchanged since it was bound");
    expect(live.getByTestId("binding-standing").getAttribute("data-tone")).toBe("neutral");
    expect(live.getByTestId("binding-bound-by").textContent).toBe("binder");
    expect(live.getByTestId("binding-released-at").textContent).toBe("not released");
    expect(live.getByTestId("binding-invalidation").textContent).toBe("not invalidated");

    expect(released.getByTestId("binding-live").textContent).toBe("Released");
    expect(released.queryByTestId("binding-standing")).toBeNull();
    expect(released.getByTestId("binding-released-at").textContent).toBe("2026-10-20T00:00:00Z");
    expect(released.getByTestId("binding-invalidation").textContent).toBe("2026-10-15T00:00:00Z Tool contract changed: refund@payments");
    expect(released.getByTestId("binding-invalidated").getAttribute("data-tone")).toBe("caution");
    expect(released.getByTestId("binding-bound-by").textContent).toBe("not on record");

    expect(claim.getByTestId("binding-subject").textContent).toBe(`Assurance claim ${"f".repeat(64)}`);
    expect(claim.getByTestId("binding-standing").textContent).toBe("Tool no longer registered");
    expect(claim.getByTestId("binding-current-digest").textContent).toBe("none: the tool is no longer registered");
    expect(tones(container)).not.toContain("positive");
  });

  it("says what is not said about a binding, and a subject this console does not know", () => {
    const { container } = render(
      <ul>
        <BindingRecordRow binding={binding({ live: null, superseded: null, subject: "service_account" })} />
      </ul>,
    );
    expect(within(container).getByTestId("binding-live").textContent).toBe("whether it is live was not said");
    expect(within(container).getByTestId("binding-standing").textContent).toBe("whether the contract changed was not said");
    expect(within(container).getByTestId("binding-subject").textContent).toBe("not recognised here: service_account");
  });

  it("says none is recorded on an empty first page", () => {
    render(<ContractRecordList records={[]} first />);
    expect(screen.getByTestId("no-contract-records").textContent).toBe("No contract of this registration is recorded.");
    cleanup();
    render(<BindingRecordList bindings={[]} first />);
    expect(screen.getByTestId("no-binding-records").textContent).toBe(
      "No approval or claim is on record as bound to a contract of this registration.",
    );
  });
});

describe("decision history", () => {
  it("shows each change from -> to, its basis, when it was accepted and confirmed -- and nothing in it reads positive", () => {
    const { container } = render(
      <DecisionTransitionList
        first
        transitions={[
          { revision: 3, fromDecision: "ready", toDecision: "audit_incomplete", basisDigest: null, createdAt: "2026-10-22T00:00:00Z", deliveredAt: null },
          { revision: 2, fromDecision: "needs_more_evidence", toDecision: "ready", basisDigest: E, createdAt: "2026-10-12T00:00:00Z", deliveredAt: "2026-10-12T00:01:00Z" },
          { revision: 1, fromDecision: null, toDecision: "needs_more_evidence", basisDigest: null, createdAt: "2026-10-01T00:00:00Z", deliveredAt: "2026-10-01T00:01:00Z" },
        ]}
      />,
    );
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-transition]"));
    expect(rows.map((one) => one.getAttribute("data-transition"))).toEqual(["3", "2", "1"]);
    const [third, second, first] = rows.map((one) => within(one));
    expect(third.getByTestId("transition-revision").textContent).toBe("r3");
    expect(third.getByTestId("transition-from").textContent).toBe("Ready");
    expect(third.getByTestId("transition-to").textContent).toBe("Audit incomplete");
    expect(third.getByTestId("transition-basis").textContent).toBe("no basis digest supplied");
    expect(third.getByTestId("transition-delivered-at").textContent).toBe("not yet confirmed");
    expect(second.getByTestId("transition-to").textContent).toBe("Ready");
    expect(second.getByTestId("transition-basis").textContent).toBe(E);
    expect(second.getByTestId("transition-created-at").textContent).toBe("2026-10-12T00:00:00Z");
    expect(second.getByTestId("transition-delivered-at").textContent).toBe("2026-10-12T00:01:00Z");
    expect(first.getByTestId("transition-from").textContent).toBe("none before");
    expect(first.getByTestId("transition-from").getAttribute("data-absent")).toBe("true");
    // Neutral throughout: a past READY is a fact about the record, never a result drawn here.
    expect(new Set(tones(container))).toEqual(new Set(["neutral"]));
    expect(container.innerHTML).not.toMatch(/emerald/);
  });

  it("names a state it does not know as not recognised, a decision none came after, and an unserved revision", () => {
    const { container } = render(
      <ul>
        <DecisionTransitionRow transition={{ revision: null, fromDecision: "super_ready", toDecision: null, basisDigest: null, createdAt: null, deliveredAt: null }} />
      </ul>,
    );
    const row = within(container);
    expect(row.getByTestId("transition-revision").textContent).toBe("revision not served");
    expect(row.getByTestId("transition-from").textContent).toBe("not recognised here: super_ready");
    expect(row.getByTestId("transition-from").getAttribute("data-tone")).toBe("neutral");
    expect(row.getByTestId("transition-to").textContent).toBe("none after");
    expect(row.getByTestId("transition-created-at").textContent).toBe("not recorded");
  });

  it("says no change is recorded on an empty first page", () => {
    render(<DecisionTransitionList transitions={[]} first />);
    expect(screen.getByTestId("no-transitions").textContent).toBe("No change of this deployment's decision is recorded.");
  });
});

describe("paging", () => {
  const page = (truncated: boolean | null, returned: number | null) => ({ deployment: "dep-1", truncated, returned, pageSize: 100, offset: 0 });

  it("reads on from offset + returned only while the backend says there is more", () => {
    expect(nextOffset(0, page(true, 100))).toBe(100);
    expect(nextOffset(200, page(true, 50))).toBe(250);
    expect(nextOffset(0, page(false, 100))).toBeNull();
    expect(nextOffset(0, page(null, 100))).toBeNull();
    // More said, but no rows on this page or none counted: nowhere to read on from.
    expect(nextOffset(0, page(true, 0))).toBeNull();
    expect(nextOffset(0, page(true, null))).toBeNull();
    // Never past the furthest offset the backend takes.
    expect(nextOffset(2 ** 31 - 1, page(true, 1))).toBeNull();
    expect(nextOffset(2 ** 31 - 2, page(true, 1))).toBe(2 ** 31 - 1);
  });

  it("draws a page only for the deployment it was asked for", () => {
    expect(answeredFor("dep-1", "dep-1")).toBe(true);
    expect(answeredFor("0F0E0D0C-0B0A-4908-8706-050403020100", "0f0e0d0c0b0a49088706050403020100")).toBe(true);
    expect(answeredFor(null, "dep-1")).toBe(true);
    expect(answeredFor("dep-2", "dep-1")).toBe(false);
  });
});

// ---- the screens, mounted with the app's own query defaults ----

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
  // keepPreviousData included: another deployment's answer, or another page's, must never be drawn.
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
  return { location };
}

const STATUS = { configured: true, reachable: true, authorized: true, url: "https://backend", detail: "ok" };
const DEPLOYMENTS = [
  { uuid: "dep-1", name: "acme-chatbot", environment: "production", decision: "audit_incomplete", decisionLabel: "Audit incomplete" },
  { uuid: "dep-2", name: "eu-assistant", environment: "staging", decision: null, decisionLabel: "" },
];

const DECISION: DecisionSupport = {
  decision: "audit_incomplete", decisionLabel: "Audit incomplete", revision: 250,
  fromFindings: "ready", claimCap: null, coverageCap: "audit_incomplete", acceptedRiskCap: null,
  policyVersion: "mythos.assurance.policy/1.0+0123456789ab", composition: null, paused: false,
  claims: {
    hasClaims: false, retestPending: false, contradicted: [], stale: [], unknown: [], supporting: [],
    supersededToolContracts: [], authorityChainsBroken: [], authorityChainsUnproven: [], authorityChainsMissing: [], effectClassesUnknown: [],
  },
  note: "",
};

/** A page of `total` decision changes for `deployment` from `offset`, a page of 100, newest first. */
function decisions(deployment: string, offset: number, total: number): DecisionHistory {
  const count = Math.max(0, Math.min(100, total - offset));
  return {
    deployment, transitionCount: total, returned: count, truncated: offset + count < total, pageSize: 100, offset,
    transitions: Array.from({ length: count }, (_, i) => ({
      revision: total - offset - i, fromDecision: "needs_more_evidence", toDecision: "ready", basisDigest: null,
      createdAt: "2026-10-01T00:00:00Z", deliveredAt: null,
    })),
  };
}

const revisionsShown = () =>
  Array.from(document.querySelectorAll("[data-transition]")).map((one) => Number(one.getAttribute("data-transition")));

describe("the release gate's decision history, read a page at a time", () => {
  it("reads the first page, and the next from offset + returned on Load more, until the backend says there is no more", async () => {
    const requested = serve({
      "/api/assurance/status": STATUS,
      "/api/assurance/deployments": DEPLOYMENTS,
      "/api/assurance/deployments/dep-1/decision-support": DECISION,
      "/api/assurance/deployments/dep-1/decision-history?offset=0": decisions("dep-1", 0, 250),
      "/api/assurance/deployments/dep-1/decision-history?offset=100": decisions("dep-1", 100, 250),
      "/api/assurance/deployments/dep-1/decision-history?offset=200": decisions("dep-1", 200, 250),
    });
    mount("/authority/release?deployment=dep-1");
    await waitFor(() => expect(revisionsShown().length).toBe(100));
    expect(screen.getByTestId("history-shown").textContent).toBe("Showing 100 of 250");
    fireEvent.click(screen.getByTestId("history-load-more"));
    await waitFor(() => expect(revisionsShown().length).toBe(200));
    // One footer, on the last page read.
    expect(screen.getAllByTestId("history-footer")).toHaveLength(1);
    expect(screen.getByTestId("history-shown").textContent).toBe("Showing 200 of 250");
    fireEvent.click(screen.getByTestId("history-load-more"));
    await waitFor(() => expect(revisionsShown().length).toBe(250));
    expect(screen.getByTestId("history-shown").textContent).toBe("Showing 250 of 250");
    expect(screen.queryByTestId("history-load-more")).toBeNull();
    // Every change once, newest first.
    expect(revisionsShown()).toEqual(Array.from({ length: 250 }, (_, i) => 250 - i));
    expect(requested.filter((url) => url.includes("decision-history"))).toEqual([
      "/api/assurance/deployments/dep-1/decision-history?offset=0",
      "/api/assurance/deployments/dep-1/decision-history?offset=100",
      "/api/assurance/deployments/dep-1/decision-history?offset=200",
    ]);
    // Nothing in it reads positive.
    expect(tones(screen.getByTestId("decision-history-section"))).not.toContain("positive");
  });

  it("never draws one deployment's history -- nor the pages read of it -- under another", async () => {
    const requested = serve({
      "/api/assurance/status": STATUS,
      "/api/assurance/deployments": DEPLOYMENTS,
      "/api/assurance/deployments/dep-1/decision-support": DECISION,
      "/api/assurance/deployments/dep-2/decision-support": { ...DECISION, revision: 7 },
      "/api/assurance/deployments/dep-1/decision-history?offset=0": decisions("dep-1", 0, 250),
      "/api/assurance/deployments/dep-1/decision-history?offset=100": decisions("dep-1", 100, 250),
      // dep-2's history never answers.
    });
    const { location } = mount("/authority/release?deployment=dep-1");
    await waitFor(() => expect(revisionsShown().length).toBe(100));
    fireEvent.click(screen.getByTestId("history-load-more"));
    await waitFor(() => expect(revisionsShown().length).toBe(200));
    act(() => location.navigate("/authority/release?deployment=dep-2"));
    await waitFor(() => expect(screen.getByTestId("decision-revision").textContent).toBe("r7"));
    await waitFor(() => expect(within(screen.getByTestId("decision-history-section")).getByTestId("read-loading").textContent).toBe(
      "Reading the decision history…",
    ));
    expect(revisionsShown()).toEqual([]);
    expect(screen.queryByTestId("history-load-more")).toBeNull();
    // dep-2 starts from its first page: dep-1's offsets are not carried over.
    expect(requested.filter((url) => url.includes("dep-2/decision-history"))).toEqual(["/api/assurance/deployments/dep-2/decision-history?offset=0"]);
  });

  it("does not draw a page the backend answered for another deployment", async () => {
    serve({
      "/api/assurance/status": STATUS,
      "/api/assurance/deployments": DEPLOYMENTS,
      "/api/assurance/deployments/dep-1/decision-support": DECISION,
      "/api/assurance/deployments/dep-1/decision-history?offset=0": decisions("dep-2", 0, 3),
    });
    mount("/authority/release?deployment=dep-1");
    await waitFor(() => expect(screen.getByTestId("history-other-deployment").textContent).toBe(
      "Athena-Backend answered this read for another deployment (dep-2), so it is not shown here.",
    ));
    expect(revisionsShown()).toEqual([]);
  });

  it("offers no Load more where the backend says there is more but not where it starts, and says when it did not say", async () => {
    serve({
      "/api/assurance/status": STATUS,
      "/api/assurance/deployments": DEPLOYMENTS,
      "/api/assurance/deployments/dep-1/decision-support": DECISION,
      "/api/assurance/deployments/dep-1/decision-history?offset=0": { ...decisions("dep-1", 0, 0), truncated: true, returned: 0, transitionCount: 5 },
      "/api/assurance/deployments/dep-2/decision-support": DECISION,
      "/api/assurance/deployments/dep-2/decision-history?offset=0": { ...decisions("dep-2", 0, 2), truncated: null, transitionCount: null },
    });
    const { location } = mount("/authority/release?deployment=dep-1");
    await waitFor(() => expect(screen.getByTestId("history-no-next")).toBeTruthy());
    expect(screen.getByTestId("no-transitions").textContent).toBe("No change of this deployment's decision is recorded.");
    expect(screen.queryByTestId("history-load-more")).toBeNull();
    act(() => location.navigate("/authority/release?deployment=dep-2"));
    await waitFor(() => expect(screen.getByTestId("history-truncation-not-said").textContent).toBe("whether more are recorded was not said"));
    expect(screen.getByTestId("history-shown").textContent).toBe("Showing 2; how many are recorded was not said");
    expect(screen.queryByTestId("history-load-more")).toBeNull();
  });
});

const APPROVED: ApprovedWorkflows = {
  approved: [
    { uuid: "wf-1", slug: "refunds", name: "Refunds", description: "", approvedBy: "alice", approvedAt: "2026-10-20T09:00:00Z", tools: [] },
    { uuid: "wf-2", slug: "lookup", name: "Lookup", description: "", approvedBy: "alice", approvedAt: "2026-10-20T09:00:00Z", tools: [] },
  ],
  returned: 2, truncated: false, pageSize: 1000, approvedCount: 2, composition: null,
};

function approvalHistory(deployment: string, workflow: string | null, versions: ApprovalVersion[], extra: Partial<ApprovalHistory> = {}): ApprovalHistory {
  return {
    deployment, workflow, versions, versionCount: versions.length, returned: versions.length, truncated: false, pageSize: 50, offset: 0, ...extra,
  };
}

describe("the approved workflows' version history", () => {
  it("reads nothing until an approval's history is opened, then reads that approval's, a page at a time", async () => {
    const requested = serve({
      "/api/assurance/status": STATUS,
      "/api/assurance/deployments": DEPLOYMENTS,
      "/api/assurance/deployments/dep-1/approved-workflows": APPROVED,
      "/api/assurance/deployments/dep-1/approval-history?workflow=refunds&offset=0": approvalHistory(
        "dep-1", "refunds", [version({ version: "40" })], { versionCount: 51, returned: 50, truncated: true },
      ),
      "/api/assurance/deployments/dep-1/approval-history?workflow=refunds&offset=50": approvalHistory(
        "dep-1", "refunds", [version({ version: "1", declaredBy: null })], { versionCount: 51, returned: 1, truncated: false, offset: 50 },
      ),
    });
    mount("/authority/workflows?deployment=dep-1");
    await waitFor(() => expect(document.querySelector('[data-workflow="refunds"]')).not.toBeNull());
    expect(requested.filter((url) => url.includes("approval-history"))).toEqual([]);
    const refunds = within(document.querySelector('[data-workflow="refunds"]') as HTMLElement);
    fireEvent.click(refunds.getByTestId("approval-version-history-toggle"));
    await waitFor(() => expect(refunds.getByTestId("version-declared-by").textContent).toBe("carol"));
    expect(refunds.getByTestId("history-shown").textContent).toBe("Showing 1 of 51");
    fireEvent.click(refunds.getByTestId("history-load-more"));
    await waitFor(() => expect(refunds.getAllByTestId("version-declared-by").map((one) => one.textContent)).toEqual(["carol", "not recorded"]));
    expect(refunds.queryByTestId("history-load-more")).toBeNull();
    // One approval's history only: the other approval's was not read.
    expect(requested.filter((url) => url.includes("approval-history"))).toEqual([
      "/api/assurance/deployments/dep-1/approval-history?workflow=refunds&offset=0",
      "/api/assurance/deployments/dep-1/approval-history?workflow=refunds&offset=50",
    ]);
  });

  it("reads every approval's versions together when asked, approvals since withdrawn included", async () => {
    const requested = serve({
      "/api/assurance/status": STATUS,
      "/api/assurance/deployments": DEPLOYMENTS,
      "/api/assurance/deployments/dep-1/approved-workflows": APPROVED,
      "/api/assurance/deployments/dep-1/approval-history?offset=0": approvalHistory("dep-1", null, [
        version({ version: "41", workflow: "export", digest: null, withdrawn: true, tools: [], declaredBy: null }),
        version({ version: "40" }),
      ]),
    });
    mount("/authority/workflows?deployment=dep-1");
    await waitFor(() => expect(screen.getByTestId("every-approval-version-toggle")).toBeTruthy());
    fireEvent.click(screen.getByTestId("every-approval-version-toggle"));
    const section = within(screen.getByTestId("approval-history-section"));
    await waitFor(() => expect(section.getAllByTestId("version-workflow").map((one) => one.textContent)).toEqual(["export", "refunds"]));
    expect(section.getByTestId("version-withdrawn").textContent).toBe("Withdrawn");
    expect(section.getByTestId("history-shown").textContent).toBe("Showing 2 of 2");
    expect(requested.filter((url) => url.includes("approval-history"))).toEqual(["/api/assurance/deployments/dep-1/approval-history?offset=0"]);
  });

  it("says an approval with no version recorded has none", async () => {
    serve({
      "/api/assurance/status": STATUS,
      "/api/assurance/deployments": DEPLOYMENTS,
      "/api/assurance/deployments/dep-1/approved-workflows": APPROVED,
      "/api/assurance/deployments/dep-1/approval-history?workflow=lookup&offset=0": approvalHistory("dep-1", "lookup", []),
    });
    mount("/authority/workflows?deployment=dep-1");
    await waitFor(() => expect(document.querySelector('[data-workflow="lookup"]')).not.toBeNull());
    const lookup = within(document.querySelector('[data-workflow="lookup"]') as HTMLElement);
    fireEvent.click(lookup.getByTestId("approval-version-history-toggle"));
    await waitFor(() => expect(lookup.getByTestId("no-versions").textContent).toBe("No version of this approval is recorded."));
    expect(lookup.getByTestId("history-shown").textContent).toBe("Showing 0 of 0");
  });

  it("never draws one deployment's approval history under another", async () => {
    const requested = serve({
      "/api/assurance/status": STATUS,
      "/api/assurance/deployments": DEPLOYMENTS,
      "/api/assurance/deployments/dep-1/approved-workflows": APPROVED,
      "/api/assurance/deployments/dep-2/approved-workflows": APPROVED,
      "/api/assurance/deployments/dep-1/approval-history?workflow=refunds&offset=0": approvalHistory("dep-1", "refunds", [version()]),
      // dep-2's history never answers.
    });
    const { location } = mount("/authority/workflows?deployment=dep-1");
    await waitFor(() => expect(document.querySelector('[data-workflow="refunds"]')).not.toBeNull());
    fireEvent.click(within(document.querySelector('[data-workflow="refunds"]') as HTMLElement).getByTestId("approval-version-history-toggle"));
    await waitFor(() => expect(screen.getByTestId("version-declared-by").textContent).toBe("carol"));
    act(() => location.navigate("/authority/workflows?deployment=dep-2"));
    // The screen is read again for dep-2, and its history is closed until opened there.
    await waitFor(() => expect(document.querySelector('[data-workflow="refunds"]')).not.toBeNull());
    expect(screen.queryByTestId("version-declared-by")).toBeNull();
    const refunds = within(document.querySelector('[data-workflow="refunds"]') as HTMLElement);
    expect(refunds.getByTestId("approval-version-history").getAttribute("data-open")).toBe("false");
    fireEvent.click(refunds.getByTestId("approval-version-history-toggle"));
    await waitFor(() => expect(refunds.getByTestId("read-loading").textContent).toBe("Reading this approval's version history…"));
    expect(screen.queryByTestId("version-declared-by")).toBeNull();
    expect(requested).toContain("/api/assurance/deployments/dep-2/approval-history?workflow=refunds&offset=0");
  });
});

const ASSETS: ToolAsset[] = [
  {
    uuid: "as-2", deploymentUuid: "dep-1", kind: "skill", kindLabel: "Agent skill", name: "Summarise", identifier: "summarise",
    classification: "unknown", classificationLabel: "Unknown", metadata: {}, firstSeen: null, lastSeen: null,
  },
  {
    uuid: "as-5", deploymentUuid: "dep-1", kind: "tool", kindLabel: "Tool", name: "Fresh", identifier: "fresh tool/v2",
    classification: "unknown", classificationLabel: "Unknown", metadata: {}, firstSeen: null, lastSeen: null,
  },
];

function contracts(deployment: string, records: ToolContractRecord[]): ToolContractHistory {
  return { deployment, kind: "skill", identifier: "summarise", contracts: records, contractCount: records.length, returned: records.length, truncated: false, pageSize: 100, offset: 0 };
}

function bindings(deployment: string, records: ToolContractBindingRecord[]): ToolContractBindings {
  return { deployment, kind: "skill", identifier: "summarise", bindings: records, bindingCount: records.length, returned: records.length, truncated: false, pageSize: 100, offset: 0 };
}

describe("the tool contracts' history", () => {
  it("reads a registration's contracts and bindings only when opened, and shows the digest in force for a tool no approval binds", async () => {
    const requested = serve({
      "/api/assurance/status": STATUS,
      "/api/assurance/deployments": DEPLOYMENTS,
      "/api/assurance/assets?deployment=dep-1": ASSETS,
      "/api/assurance/deployments/dep-1/approved-workflows": { ...APPROVED, approved: [] },
      "/api/assurance/deployments/dep-1/tool-contracts?kind=skill&identifier=summarise&offset=0": contracts("dep-1", [
        contract({ kind: "skill", identifier: "summarise", digest: C, currentDigest: C, inForce: true }),
      ]),
      "/api/assurance/deployments/dep-1/tool-contract-bindings?kind=skill&identifier=summarise&offset=0": bindings("dep-1", [
        binding({ subject: "claim", workflow: null, claimFingerprint: "f".repeat(64), kind: "skill", identifier: "summarise", contractDigest: C, currentDigest: C, live: false, superseded: null, releasedAt: "2026-10-21T00:00:00Z" }),
      ]),
      "/api/assurance/deployments/dep-1/tool-contracts?kind=tool&identifier=fresh+tool%2Fv2&offset=0": { ...contracts("dep-1", []), kind: "tool", identifier: "fresh tool/v2" },
      "/api/assurance/deployments/dep-1/tool-contract-bindings?kind=tool&identifier=fresh+tool%2Fv2&offset=0": { ...bindings("dep-1", []), kind: "tool", identifier: "fresh tool/v2" },
    });
    mount("/authority/contracts?deployment=dep-1");
    await waitFor(() => expect(document.querySelector('[data-tool="skill:summarise"]')).not.toBeNull());
    const summarise = within(document.querySelector('[data-tool="skill:summarise"]') as HTMLElement);
    await waitFor(() => expect(summarise.getByTestId("digest-in-force").textContent).toBe("no approval binds this tool: read with its contract history"));
    expect(requested.filter((url) => /tool-contract/.test(url))).toEqual([]);

    fireEvent.click(summarise.getByTestId("tool-contract-history-toggle"));
    await waitFor(() => expect(summarise.getByTestId("digest-in-force").textContent).toBe(C));
    await waitFor(() => expect(summarise.getByTestId("binding-subject").textContent).toBe(`Assurance claim ${"f".repeat(64)}`));
    expect(summarise.getByTestId("record-in-force").textContent).toBe("In force now");
    expect(summarise.getByTestId("binding-live").textContent).toBe("Released");
    // The digest in force and the first page of its contracts are one read, shared.
    expect(requested.filter((url) => url.includes("tool-contracts?kind=skill"))).toEqual([
      "/api/assurance/deployments/dep-1/tool-contracts?kind=skill&identifier=summarise&offset=0",
    ]);

    // An identifier that is not a plain word is sent as a value, encoded.
    const fresh = within(document.querySelector('[data-tool="tool:fresh tool/v2"]') as HTMLElement);
    fireEvent.click(fresh.getByTestId("tool-contract-history-toggle"));
    await waitFor(() => expect(fresh.getByTestId("no-contract-records").textContent).toBe("No contract of this registration is recorded."));
    expect(fresh.getByTestId("no-binding-records")).toBeTruthy();
    expect(fresh.getByTestId("digest-in-force").textContent).toBe("no contract of this registration is recorded");
    expect(requested).toContain("/api/assurance/deployments/dep-1/tool-contracts?kind=tool&identifier=fresh+tool%2Fv2&offset=0");
  });

  it("never draws one deployment's contract history under another", async () => {
    serve({
      "/api/assurance/status": STATUS,
      "/api/assurance/deployments": DEPLOYMENTS,
      "/api/assurance/assets?deployment=dep-1": ASSETS,
      "/api/assurance/assets?deployment=dep-2": ASSETS,
      "/api/assurance/deployments/dep-1/approved-workflows": { ...APPROVED, approved: [] },
      "/api/assurance/deployments/dep-2/approved-workflows": { ...APPROVED, approved: [] },
      "/api/assurance/deployments/dep-1/tool-contracts?kind=skill&identifier=summarise&offset=0": contracts("dep-1", [
        contract({ kind: "skill", identifier: "summarise", digest: C, currentDigest: C }),
      ]),
      "/api/assurance/deployments/dep-1/tool-contract-bindings?kind=skill&identifier=summarise&offset=0": bindings("dep-1", []),
    });
    const { location } = mount("/authority/contracts?deployment=dep-1");
    await waitFor(() => expect(document.querySelector('[data-tool="skill:summarise"]')).not.toBeNull());
    fireEvent.click(within(document.querySelector('[data-tool="skill:summarise"]') as HTMLElement).getByTestId("tool-contract-history-toggle"));
    await waitFor(() => expect(screen.getByTestId("record-in-force")).toBeTruthy());
    act(() => location.navigate("/authority/contracts?deployment=dep-2"));
    await waitFor(() => expect(document.querySelector('[data-tool="skill:summarise"]')).not.toBeNull());
    const summarise = within(document.querySelector('[data-tool="skill:summarise"]') as HTMLElement);
    expect(summarise.getByTestId("tool-contract-history").getAttribute("data-open")).toBe("false");
    fireEvent.click(summarise.getByTestId("tool-contract-history-toggle"));
    await waitFor(() => expect(summarise.getByTestId("digest-in-force").textContent).toBe("reading…"));
    expect(screen.queryByTestId("record-in-force")).toBeNull();
    expect(screen.queryByText(C)).toBeNull();
  });
});
