import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";

import { makeApp, signIn, signInToBackend } from "./helpers";

/**
 * The reads behind the four authority screens (client/src/pages/Authority.tsx),
 * against a stand-in Athena-Backend that answers in its own wire shapes
 * (athena-backend assurance/views.py approved_workflows / authority_chains /
 * decision_support):
 *
 *   - approved-workflows and authority-chains are relayed as GETs, as the
 *     signed-in person (their own backend token, never the service account's),
 *     and mapped to camelCase with every served null kept null: an approver whose
 *     account was removed, a tool no longer registered, an approved set nobody
 *     recorded. A count the backend did not serve is null, never 0.
 *   - decision-support now carries what the release-gate screen shows: the
 *     revision, every cap, the policy pin, the composition, and the chains,
 *     effects and tool contracts that hold the decision.
 *   - Neither backend route's write (the approved set's PUT, a chain's POST) is
 *     relayed: this server serves no such route, and the backend sees none.
 *   - A backend refusal reaches the screen as itself: 404 not_found, 403
 *     backend_refused.
 *   - The four recorded histories (approval-history, tool-contracts,
 *     tool-contract-bindings, decision-history; athena-backend
 *     assurance/history_reads.py) are relayed the same way: GETs as the person,
 *     every served null kept null, the page's returned / truncated / page size /
 *     offset and its whole count read as served and null when not, each filter
 *     passed on encoded, and `?offset=` checked HERE -- plain digits up to
 *     2^31 - 1 -- before anything is relayed. None of them relays a write.
 */

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);

const APPROVED = {
  approved: [
    {
      uuid: "wf-1", slug: "refunds", name: "Refunds",
      description: "The support agent may issue refunds up to 100 EUR through the payments tool.",
      approved_by: "alice", approved_at: "2026-10-20T09:00:00Z",
      tools: [
        { kind: "tool", identifier: "refund@payments", contract_digest: A, bound_at: "2026-10-20T09:00:00Z", current_digest: B, superseded: true },
        { kind: "mcp_server", identifier: "ledger", contract_digest: C, bound_at: "2026-10-20T09:00:00Z", current_digest: C, superseded: false },
        { kind: "skill", identifier: "gone-skill", contract_digest: D, bound_at: "2026-10-19T09:00:00Z", current_digest: null, superseded: true },
      ],
    },
    { uuid: "wf-2", slug: "lookup", name: "Lookup", description: "", approved_by: null, approved_at: "2026-10-21T09:00:00Z", tools: [] },
  ],
  returned: 2, truncated: false, page_size: 1000, approved_count: 2,
  composition: {
    signal: "needs_more_evidence", rule_decision: "needs_more_evidence",
    census: { held: 0, violated: 0, incomplete: 0, not_demonstrated: 2 },
    deciding: ["lookup", "refunds"], workflows_assessed: 0, workflows_expected: 2,
    workflows_unreported: 2, workflows_unapproved: 0, superseded: 0, basis_census: {},
    workflows_unexercised: 0, unexercised: [], evidence_census: {}, authorization_checked: [],
    route_census: {}, off_route: [], explanation: "2 approved workflow(s) have no chain outcome.", provenance: {},
  },
};

const NOTHING_APPROVED = {
  approved: [], returned: 0, truncated: false, page_size: 1000, approved_count: 0,
  composition: { ...APPROVED.composition, signal: null, rule_decision: null, workflows_expected: null, deciding: [] },
};

const CHAINS = {
  chains: [
    {
      uuid: "ch-2", workflow: "refunds", effect: "refund issued", digest: `sha256:${"e".repeat(64)}`,
      standing: true, verdict: "unproven", basis: "demonstrated", basis_in_force: "attested", signed: false,
      observer_engine: "achilles", outcome_id: "out-2", gate_outcome_id: "gate-2", effect_outcome_id: null,
      route: "current", observed_at: "2026-10-22T10:00:00+00:00", recorded_at: "2026-10-22T10:01:00+00:00",
      recorded_by: "alice", source: "achilles", note: "", unproven_hops: [1], broken_hops: [],
      hops: [
        {
          index: 0, from: { kind: "person", ref: "alice" }, relation: "authenticated_as", to: { kind: "user", ref: "alice@corp" },
          verdict: "proven", proven_by: [{ verdict: "proven", code: "signed_sign_in", detail: "a signed sign-in names alice@corp" }], reasons: [],
        },
        {
          index: 1, from: { kind: "agent", ref: "support-agent" }, relation: "under_policy", to: { kind: "policy", ref: "refunds", version: "f".repeat(64) },
          verdict: "unproven", proven_by: [],
          reasons: [{ verdict: "unproven", code: "no_dispatch_state", detail: "the observed effect carries no dispatch state" }],
        },
      ],
    },
    {
      uuid: "ch-1", workflow: "refunds", effect: "refund issued", digest: `sha256:${"7".repeat(64)}`,
      standing: false, verdict: "broken", basis: "attested", basis_in_force: "attested", signed: false,
      observer_engine: null, outcome_id: "", gate_outcome_id: null, effect_outcome_id: null,
      route: "moved", observed_at: null, recorded_at: "2026-10-21T10:01:00+00:00",
      recorded_by: null, source: "", note: "typed in by hand", unproven_hops: [], broken_hops: [0],
      hops: [
        {
          index: 0, from: { kind: "agent", ref: "support-agent" }, relation: "invokes", to: { kind: "tool", ref: "refund@payments" },
          verdict: "broken", proven_by: [], reasons: [{ verdict: "broken", code: "no_reach", detail: "the agent reaches no such tool" }],
        },
      ],
    },
  ],
  returned: 2, truncated: false, page_size: 100, recorded: 2, standing: 1, superseded: 1,
  verdict_census: { broken: 0, proven: 0, unproven: 1 },
  approvals_in_force: { refunds: "9".repeat(64), lookup: "8".repeat(64) },
  effects: [
    {
      digest: `sha256:${"1".repeat(64)}`, workflow: "refunds", tool_kind: "tool", tool_identifier: "refund@payments",
      effect_class: "write", class: "consequential", status: "covered", reasons: ["declared_write", "chain_in_force"],
      chains: [`sha256:${"e".repeat(64)}`], to_do: null,
    },
    {
      digest: `sha256:${"2".repeat(64)}`, workflow: null, tool_kind: "skill", tool_identifier: "summarise",
      effect_class: null, class: "unknown", status: "unknown", reasons: ["effect_class_undeclared", "tool_not_bound_to_approval"],
      chains: [], to_do: "bind skill 'summarise' to the approval of the workflow that uses it",
    },
  ],
  effect_census: { covered: 1, missing: 0, not_required: 0, unknown: 1 },
};

const DECISION = {
  decision: "audit_incomplete", decision_label: "Audit incomplete", revision: 12,
  from_findings: "ready", claim_cap: null, coverage_cap: "audit_incomplete", accepted_risk_cap: null,
  accepted_risk: { standing: [], lapsed: [], valid_until: null },
  composition: APPROVED.composition,
  paused: false, policy_version: "mythos.assurance.policy/1.0+0123456789ab",
  claims: {
    has_claims: true, retest_pending: false,
    contradicted: [], stale: [], unknown: [], legally_stale: [], unread_conditions: [], held: [], supporting: [],
    superseded_tool_contracts: [
      { subject: "workflow", claim_fingerprint: null, workflow: "refunds", tool_kind: "tool", tool_identifier: "refund@payments", bound_digest: A, current_digest: B },
      { subject: "workflow", claim_fingerprint: null, workflow: "refunds", tool_kind: "skill", tool_identifier: "gone-skill", bound_digest: D, current_digest: null },
    ],
    authority_chains_broken: [],
    authority_chains_unproven: [
      {
        uuid: "ch-2", workflow: "refunds", effect: "refund issued", digest: `sha256:${"e".repeat(64)}`, verdict: "unproven",
        hops: [{ index: 1, relation: "under_policy", from: { kind: "agent", ref: "support-agent" }, to: { kind: "policy", ref: "refunds" }, verdict: "unproven", reasons: ["no_dispatch_state"] }],
      },
    ],
    authority_chains_missing: [],
    effect_classes_unknown: [CHAINS.effects[1]],
  },
  note: "Held at 'audit incomplete': 1 critical-path component was never assessed.",
};

const HISTORY_UUID = "0f0e0d0c-0b0a-4908-8706-050403020100";

/** athena-backend history_reads.approval_history, as the backend test pins it (one version declared_by, one null, one without the field). */
const APPROVAL_HISTORY = {
  deployment: HISTORY_UUID,
  workflow: null,
  versions: [
    {
      version: "41", workflow: "export", digest: null, withdrawn: true,
      in_force_from: "2026-10-30T00:00:00Z", in_force_until: null, recorded_at: "2026-10-30T00:00:00Z",
      tools: [], declared_by: null,
    },
    {
      version: "40", workflow: "refund", digest: B, withdrawn: false,
      in_force_from: "2026-10-20T00:00:00Z", in_force_until: null, recorded_at: "2026-10-21T00:00:00Z",
      declared_by: "carol",
      tools: [{
        kind: "tool", identifier: "refund@payments", contract_digest: C, bound_at: "2026-10-20T00:00:00Z",
        bound_by: null, released_at: null, invalidated_at: null, invalidation_reason: null,
      }],
    },
    {
      version: "39", workflow: "refund", digest: A, withdrawn: false,
      in_force_from: "2026-10-10T00:00:00Z", in_force_until: "2026-10-20T00:00:00Z", recorded_at: "2026-10-10T00:00:00Z",
      tools: [{
        kind: "tool", identifier: "refund@payments", contract_digest: D, bound_at: "2026-10-10T00:00:00Z",
        bound_by: "binder", released_at: "2026-10-20T00:00:00Z", invalidated_at: "2026-10-15T00:00:00Z",
        invalidation_reason: "Tool contract changed: refund@payments",
      }],
    },
  ],
  version_count: 3, returned: 3, truncated: false, page_size: 50, offset: 0,
};

const CONTRACT_HISTORY = {
  deployment: HISTORY_UUID, kind: null, identifier: null,
  contracts: [
    {
      kind: "tool", identifier: "refund@payments", digest: B,
      contract: { contract_version: 1, kind: "tool", identifier: "refund@payments", effect_class: "write", input_schema: null, output_schema: null, annotations: null, permissions: ["payments:refund"], server: null },
      recorded_at: "2026-10-20T00:00:00Z", superseded_at: null, current_digest: B, in_force: true,
    },
    {
      kind: "tool", identifier: "refund@payments", digest: A,
      contract: { contract_version: 1, kind: "tool", identifier: "refund@payments", effect_class: "read" },
      recorded_at: "2026-10-01T00:00:00Z", superseded_at: "2026-10-20T00:00:00Z", current_digest: B, in_force: false,
    },
    {
      kind: "skill", identifier: "retired-skill", digest: C, contract: null,
      recorded_at: "2026-09-01T00:00:00Z", superseded_at: null, current_digest: null, in_force: false,
    },
  ],
  contract_count: 3, returned: 3, truncated: false, page_size: 100, offset: 0,
};

const BINDINGS = {
  deployment: HISTORY_UUID, kind: null, identifier: null,
  bindings: [
    {
      subject: "workflow", workflow: "refund", claim_fingerprint: null, kind: "tool", identifier: "refund@payments",
      contract_digest: B, current_digest: B, live: true, superseded: false, bound_at: "2026-10-20T00:00:00Z",
      bound_by: null, released_at: null, invalidated_at: null, invalidation_reason: null,
    },
    {
      subject: "workflow", workflow: "refund", claim_fingerprint: null, kind: "tool", identifier: "refund@payments",
      contract_digest: A, current_digest: B, live: false, superseded: null, bound_at: "2026-10-01T00:00:00Z",
      bound_by: "binder", released_at: "2026-10-20T00:00:00Z", invalidated_at: "2026-10-15T00:00:00Z",
      invalidation_reason: "Tool contract changed: refund@payments",
    },
    {
      subject: "claim", workflow: null, claim_fingerprint: "f".repeat(64), kind: "skill", identifier: "retired-skill",
      contract_digest: C, current_digest: null, live: true, superseded: true, bound_at: "2026-09-01T00:00:00Z",
      bound_by: null, released_at: null, invalidated_at: null, invalidation_reason: null,
    },
  ],
  binding_count: 3, returned: 3, truncated: false, page_size: 100, offset: 0,
};

const DECISIONS = {
  deployment: HISTORY_UUID,
  transitions: [
    { revision: 3, from_decision: "ready", to_decision: "audit_incomplete", basis_digest: null, created_at: "2026-10-22T00:00:00Z", delivered_at: null },
    { revision: 2, from_decision: "needs_more_evidence", to_decision: "ready", basis_digest: E, created_at: "2026-10-12T00:00:00Z", delivered_at: "2026-10-12T00:01:00Z" },
    { revision: 1, from_decision: null, to_decision: "needs_more_evidence", basis_digest: null, created_at: "2026-10-01T00:00:00Z", delivered_at: "2026-10-01T00:01:00Z" },
  ],
  transition_count: 3, returned: 3, truncated: false, page_size: 100, offset: 0,
};

const HISTORY_ROUTES = ["approval-history", "tool-contracts", "tool-contract-bindings", "decision-history"] as const;

/** A history page for `offset`, of `total` decision changes, a page of `size`: what the backend's paging answers. */
function decisionPage(offset: number, total: number, size: number) {
  const revisions = Array.from({ length: Math.max(0, Math.min(size, total - offset)) }, (_, i) => total - offset - i);
  return {
    deployment: "dep-paged",
    transitions: revisions.map((revision) => ({
      revision, from_decision: null, to_decision: "ready", basis_digest: null, created_at: "2026-10-01T00:00:00Z", delivered_at: null,
    })),
    transition_count: total, returned: revisions.length, truncated: offset + revisions.length < total, page_size: size, offset,
  };
}

interface Seen { method: string; path: string; query: string; authorization: string }

describe("the authority screens' reads", () => {
  let app: Express;
  let user: Awaited<ReturnType<typeof signIn>>;
  let server: Server;
  const seen: Seen[] = [];

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const method = req.method ?? "GET";
        const [path, query = ""] = (req.url ?? "").split("?");
        const json = (code: number, payload: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (path === "/api/token/" && method === "POST") {
          // Each account gets a token that names it, so a read says whose credential it went with.
          let username = "(none)";
          try { username = String((JSON.parse(raw || "{}") as { username?: unknown }).username); } catch { /* not JSON */ }
          return json(200, { access: `access-for-${username}`, refresh: `refresh-for-${username}` });
        }
        if (path === "/api/token/revoke/") return json(200, { revoked: true });
        // A read answered 401 is retried once with the person's renewed token: renewed as the same person.
        if (path === "/api/token/refresh/") return json(200, { access: "access-for-admin", refresh: "refresh-for-admin" });
        seen.push({ method, path, query, authorization: req.headers.authorization ?? "" });
        const history = `/api/assurance/deployments/${HISTORY_UUID}/`;
        if (method === "GET" && path.startsWith(history)) {
          const route = path.slice(history.length).replace(/\/$/, "");
          const page = { "approval-history": APPROVAL_HISTORY, "tool-contracts": CONTRACT_HISTORY, "tool-contract-bindings": BINDINGS, "decision-history": DECISIONS }[route];
          if (page) return json(200, page);
        }
        if (method === "GET" && path === "/api/assurance/deployments/dep-paged/decision-history/") {
          const offset = Number(new URLSearchParams(query).get("offset") ?? "0");
          return json(200, decisionPage(offset, 250, 100));
        }
        // A filter the backend does not take: its 400, in its words.
        if (method === "GET" && path === "/api/assurance/deployments/dep-1/tool-contracts/" && new URLSearchParams(query).get("kind") === "model") {
          return json(400, { kind: ["must be one of ['mcp_server', 'skill', 'tool'], not 'model'."] });
        }
        if (method === "GET" && /^\/api\/assurance\/deployments\/dep-(?:1|bare|echo%2F1)\/(?:approval-history|tool-contracts|tool-contract-bindings|decision-history)\/$/.test(path)) {
          // The filters and offset reach `seen` as the backend received them, for the test to read back.
          return json(200, path.includes("dep-bare") ? {} : { deployment: "dep-1" });
        }
        const answers: Record<string, [number, unknown]> = {
          "/api/assurance/deployments/dep-1/approved-workflows/": [200, APPROVED],
          "/api/assurance/deployments/dep-empty/approved-workflows/": [200, NOTHING_APPROVED],
          "/api/assurance/deployments/dep-bare/approved-workflows/": [200, {}],
          "/api/assurance/deployments/dep-hidden/approved-workflows/": [404, { detail: "No Deployment matches the given query." }],
          "/api/assurance/deployments/dep-1/authority-chains/": [200, CHAINS],
          "/api/assurance/deployments/dep-bare/authority-chains/": [200, {}],
          "/api/assurance/deployments/dep-forbidden/authority-chains/": [403, { detail: "You do not have permission to perform this action." }],
          "/api/assurance/deployments/dep-1/decision-support/": [200, DECISION],
          "/api/assurance/deployments/dep-bare/decision-support/": [200, {}],
          "/api/assurance/deployments/dep-hidden/approval-history/": [404, { detail: "No Deployment matches the given query." }],
          "/api/assurance/deployments/dep-hidden/tool-contracts/": [404, { detail: "No Deployment matches the given query." }],
          "/api/assurance/deployments/dep-hidden/tool-contract-bindings/": [404, { detail: "No Deployment matches the given query." }],
          "/api/assurance/deployments/dep-hidden/decision-history/": [404, { detail: "No Deployment matches the given query." }],
          "/api/assurance/deployments/dep-forbidden/approval-history/": [403, { detail: "You do not have permission to perform this action." }],
          "/api/assurance/deployments/dep-forbidden/tool-contracts/": [403, { detail: "You do not have permission to perform this action." }],
          "/api/assurance/deployments/dep-forbidden/tool-contract-bindings/": [403, { detail: "You do not have permission to perform this action." }],
          "/api/assurance/deployments/dep-forbidden/decision-history/": [403, { detail: "You do not have permission to perform this action." }],
          "/api/assurance/deployments/dep-signed-out/decision-history/": [401, { detail: "Given token not valid for any token type" }],
        };
        const answer = answers[path];
        if (answer && method === "GET") return json(answer[0], answer[1]);
        return json(404, { detail: "Not found." });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_FAILSAFE_USER = "svc-operator";
    process.env.ATHENA_FAILSAFE_PASSWORD = "svc-secret"; // pragma: allowlist secret
    app = await makeApp();
    user = await signIn(app);
    await signInToBackend(user);
  });

  afterAll(async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    delete process.env.ATHENA_FAILSAFE_USER;
    delete process.env.ATHENA_FAILSAFE_PASSWORD;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("maps the approved workflows, keeping every null the backend served", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/approved-workflows");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ returned: 2, truncated: false, pageSize: 1000, approvedCount: 2 });
    const [refunds, lookup] = res.body.approved;
    expect(refunds).toMatchObject({
      uuid: "wf-1", slug: "refunds", name: "Refunds", approvedBy: "alice", approvedAt: "2026-10-20T09:00:00Z",
      description: APPROVED.approved[0].description,
    });
    expect(refunds.tools).toEqual([
      { kind: "tool", identifier: "refund@payments", approvedDigest: A, boundAt: "2026-10-20T09:00:00Z", currentDigest: B, superseded: true },
      { kind: "mcp_server", identifier: "ledger", approvedDigest: C, boundAt: "2026-10-20T09:00:00Z", currentDigest: C, superseded: false },
      // No longer registered: no contract in force, and that is null, not an empty string or the old digest.
      { kind: "skill", identifier: "gone-skill", approvedDigest: D, boundAt: "2026-10-19T09:00:00Z", currentDigest: null, superseded: true },
    ]);
    // The approver's account was removed: null, never "" and never a name made up here.
    expect(lookup.approvedBy).toBeNull();
    expect(lookup.tools).toEqual([]);
    expect(res.body.composition).toMatchObject({
      signal: "needs_more_evidence", workflowsExpected: 2, workflowsAssessed: 0, workflowsUnreported: 2,
      census: { held: 0, violated: 0, incomplete: 0, not_demonstrated: 2 },
      explanation: "2 approved workflow(s) have no chain outcome.",
    });
  });

  it("keeps an approved set nobody recorded as null, and an answer that says nothing as nothing -- never as zero", async () => {
    const empty = await user.get("/api/assurance/deployments/dep-empty/approved-workflows");
    expect(empty.status).toBe(200);
    expect(empty.body.approved).toEqual([]);
    expect(empty.body.composition.workflowsExpected).toBeNull();
    expect(empty.body.composition.signal).toBeNull();

    const bare = await user.get("/api/assurance/deployments/dep-bare/approved-workflows");
    expect(bare.status).toBe(200);
    expect(bare.body).toEqual({ approved: [], returned: null, truncated: null, pageSize: null, approvedCount: null, composition: null });
  });

  it("maps the authority chains: every hop with its verdict and readings, the unproven and broken hops named, the effects and the approvals in force", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/authority-chains");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      returned: 2, truncated: false, pageSize: 100, recorded: 2, standing: 1, superseded: 1,
      verdictCensus: { broken: 0, proven: 0, unproven: 1 },
      approvalsInForce: { refunds: "9".repeat(64), lookup: "8".repeat(64) },
      effectCensus: { covered: 1, missing: 0, not_required: 0, unknown: 1 },
    });
    const [current, older] = res.body.chains;
    expect(current).toMatchObject({
      uuid: "ch-2", standing: true, verdict: "unproven", basis: "demonstrated", basisInForce: "attested", signed: false,
      observerEngine: "achilles", gateOutcomeId: "gate-2", effectOutcomeId: null, route: "current",
      recordedBy: "alice", unprovenHops: [1], brokenHops: [],
    });
    expect(current.hops[1]).toEqual({
      index: 1, from: { kind: "agent", ref: "support-agent", version: null }, relation: "under_policy",
      to: { kind: "policy", ref: "refunds", version: "f".repeat(64) }, verdict: "unproven", provenBy: [],
      reasons: [{ verdict: "unproven", code: "no_dispatch_state", detail: "the observed effect carries no dispatch state" }],
    });
    expect(current.hops[0].provenBy[0]).toEqual({ verdict: "proven", code: "signed_sign_in", detail: "a signed sign-in names alice@corp" });
    expect(older).toMatchObject({ uuid: "ch-1", standing: false, verdict: "broken", brokenHops: [0], recordedBy: null, observedAt: null, outcomeId: null });
    expect(res.body.effects[1]).toEqual({
      digest: `sha256:${"2".repeat(64)}`, workflow: null, toolKind: "skill", toolIdentifier: "summarise",
      effectClass: null, effectKind: "unknown", status: "unknown",
      reasons: ["effect_class_undeclared", "tool_not_bound_to_approval"], chains: [],
      toDo: "bind skill 'summarise' to the approval of the workflow that uses it",
    });

    const bare = await user.get("/api/assurance/deployments/dep-bare/authority-chains");
    expect(bare.body).toMatchObject({
      chains: [], effects: [], recorded: null, standing: null, superseded: null, returned: null, truncated: null,
      verdictCensus: {}, effectCensus: {}, approvalsInForce: {},
    });
  });

  it("carries what the release gate shows on the decision-support read: the revision, every cap, the policy, the composition and what holds the decision", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/decision-support");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      decision: "audit_incomplete", decisionLabel: "Audit incomplete", revision: 12,
      fromFindings: "ready", claimCap: null, coverageCap: "audit_incomplete", acceptedRiskCap: null,
      policyVersion: "mythos.assurance.policy/1.0+0123456789ab", paused: false,
      note: DECISION.note,
    });
    expect(res.body.composition).toMatchObject({ signal: "needs_more_evidence", workflowsExpected: 2 });
    expect(res.body.claims.supersededToolContracts).toEqual([
      { subject: "workflow", claimFingerprint: null, workflow: "refunds", toolKind: "tool", toolIdentifier: "refund@payments", boundDigest: A, currentDigest: B },
      { subject: "workflow", claimFingerprint: null, workflow: "refunds", toolKind: "skill", toolIdentifier: "gone-skill", boundDigest: D, currentDigest: null },
    ]);
    expect(res.body.claims.authorityChainsUnproven[0]).toMatchObject({ uuid: "ch-2", verdict: "unproven" });
    expect(res.body.claims.authorityChainsUnproven[0].hops[0]).toMatchObject({ index: 1, relation: "under_policy", reasons: ["no_dispatch_state"] });
    expect(res.body.claims.effectClassesUnknown[0]).toMatchObject({ toolIdentifier: "summarise", effectClass: null, status: "unknown" });
    expect(res.body.claims.authorityChainsBroken).toEqual([]);
    expect(res.body.claims.authorityChainsMissing).toEqual([]);

    // An answer that serves none of it: every cap, the revision and the policy are null -- never a default.
    const bare = await user.get("/api/assurance/deployments/dep-bare/decision-support");
    expect(bare.body).toMatchObject({
      decision: null, revision: null, fromFindings: null, claimCap: null, coverageCap: null,
      acceptedRiskCap: null, policyVersion: null, composition: null,
    });
  });

  it("passes a backend refusal on as itself: 404 not_found, 403 backend_refused", async () => {
    const hidden = await user.get("/api/assurance/deployments/dep-hidden/approved-workflows");
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe("not_found");
    const forbidden = await user.get("/api/assurance/deployments/dep-forbidden/authority-chains");
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe("backend_refused");
  });

  it("refuses the reads to anyone not signed in to this console", async () => {
    expect((await request(app).get("/api/assurance/deployments/dep-1/approved-workflows")).status).toBe(401);
    expect((await request(app).get("/api/assurance/deployments/dep-1/authority-chains")).status).toBe(401);
  });

  // ---- the recorded histories ----

  it("maps the approval history: every version, its tools and the binding live then, with every null kept null", async () => {
    const res = await user.get(`/api/assurance/deployments/${HISTORY_UUID}/approval-history`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      deployment: HISTORY_UUID, workflow: null, versionCount: 3, returned: 3, truncated: false, pageSize: 50, offset: 0,
      versions: [
        {
          // Withdrawn: its digest is null, never "" and never the version before it. Declared by null: not recorded.
          version: "41", workflow: "export", digest: null, withdrawn: true,
          inForceFrom: "2026-10-30T00:00:00Z", inForceUntil: null, recordedAt: "2026-10-30T00:00:00Z",
          declaredBy: null, tools: [],
        },
        {
          version: "40", workflow: "refund", digest: B, withdrawn: false,
          inForceFrom: "2026-10-20T00:00:00Z", inForceUntil: null, recordedAt: "2026-10-21T00:00:00Z",
          // Served by a backend that records it: carried as served.
          declaredBy: "carol",
          tools: [{
            kind: "tool", identifier: "refund@payments", contractDigest: C, boundAt: "2026-10-20T00:00:00Z",
            boundBy: null, releasedAt: null, invalidatedAt: null, invalidationReason: null,
          }],
        },
        {
          version: "39", workflow: "refund", digest: A, withdrawn: false,
          inForceFrom: "2026-10-10T00:00:00Z", inForceUntil: "2026-10-20T00:00:00Z", recordedAt: "2026-10-10T00:00:00Z",
          // The field absent (a backend that does not record it): null, as an explicit null is.
          declaredBy: null,
          tools: [{
            kind: "tool", identifier: "refund@payments", contractDigest: D, boundAt: "2026-10-10T00:00:00Z",
            boundBy: "binder", releasedAt: "2026-10-20T00:00:00Z", invalidatedAt: "2026-10-15T00:00:00Z",
            invalidationReason: "Tool contract changed: refund@payments",
          }],
        },
      ],
    });
  });

  it("maps the tool contract history: the descriptor as recorded, superseded_at, in_force and the digest in force -- null for a tool no longer registered", async () => {
    const res = await user.get(`/api/assurance/deployments/${HISTORY_UUID}/tool-contracts`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      deployment: HISTORY_UUID, kind: null, identifier: null, contractCount: 3, returned: 3, truncated: false, pageSize: 100, offset: 0,
    });
    expect(res.body.contracts).toEqual([
      {
        kind: "tool", identifier: "refund@payments", digest: B, contract: CONTRACT_HISTORY.contracts[0].contract,
        recordedAt: "2026-10-20T00:00:00Z", supersededAt: null, currentDigest: B, inForce: true,
      },
      {
        kind: "tool", identifier: "refund@payments", digest: A, contract: CONTRACT_HISTORY.contracts[1].contract,
        recordedAt: "2026-10-01T00:00:00Z", supersededAt: "2026-10-20T00:00:00Z", currentDigest: B, inForce: false,
      },
      {
        kind: "skill", identifier: "retired-skill", digest: C, contract: null,
        recordedAt: "2026-09-01T00:00:00Z", supersededAt: null, currentDigest: null, inForce: false,
      },
    ]);
  });

  it("maps the bindings: live and released, invalidation and release kept, superseded null on a released binding", async () => {
    const res = await user.get(`/api/assurance/deployments/${HISTORY_UUID}/tool-contract-bindings`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deployment: HISTORY_UUID, bindingCount: 3, returned: 3, truncated: false, pageSize: 100, offset: 0 });
    expect(res.body.bindings).toEqual([
      {
        subject: "workflow", workflow: "refund", claimFingerprint: null, kind: "tool", identifier: "refund@payments",
        contractDigest: B, currentDigest: B, live: true, superseded: false, boundAt: "2026-10-20T00:00:00Z",
        boundBy: null, releasedAt: null, invalidatedAt: null, invalidationReason: null,
      },
      {
        // Released: it holds nothing, so superseded is null -- never false.
        subject: "workflow", workflow: "refund", claimFingerprint: null, kind: "tool", identifier: "refund@payments",
        contractDigest: A, currentDigest: B, live: false, superseded: null, boundAt: "2026-10-01T00:00:00Z",
        boundBy: "binder", releasedAt: "2026-10-20T00:00:00Z", invalidatedAt: "2026-10-15T00:00:00Z",
        invalidationReason: "Tool contract changed: refund@payments",
      },
      {
        subject: "claim", workflow: null, claimFingerprint: "f".repeat(64), kind: "skill", identifier: "retired-skill",
        contractDigest: C, currentDigest: null, live: true, superseded: true, boundAt: "2026-09-01T00:00:00Z",
        boundBy: null, releasedAt: null, invalidatedAt: null, invalidationReason: null,
      },
    ]);
  });

  it("maps the decision history: the first change from none, a basis nobody supplied and a change not yet confirmed all null", async () => {
    const res = await user.get(`/api/assurance/deployments/${HISTORY_UUID}/decision-history`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      deployment: HISTORY_UUID, transitionCount: 3, returned: 3, truncated: false, pageSize: 100, offset: 0,
      transitions: [
        { revision: 3, fromDecision: "ready", toDecision: "audit_incomplete", basisDigest: null, createdAt: "2026-10-22T00:00:00Z", deliveredAt: null },
        { revision: 2, fromDecision: "needs_more_evidence", toDecision: "ready", basisDigest: E, createdAt: "2026-10-12T00:00:00Z", deliveredAt: "2026-10-12T00:01:00Z" },
        { revision: 1, fromDecision: null, toDecision: "needs_more_evidence", basisDigest: null, createdAt: "2026-10-01T00:00:00Z", deliveredAt: "2026-10-01T00:01:00Z" },
      ],
    });
  });

  it("reads an answer that serves nothing as nothing: every list empty, every count, flag and offset null -- never 0 or false", async () => {
    const expected = {
      "approval-history": { deployment: null, workflow: null, versions: [], versionCount: null, returned: null, truncated: null, pageSize: null, offset: null },
      "tool-contracts": { deployment: null, kind: null, identifier: null, contracts: [], contractCount: null, returned: null, truncated: null, pageSize: null, offset: null },
      "tool-contract-bindings": { deployment: null, kind: null, identifier: null, bindings: [], bindingCount: null, returned: null, truncated: null, pageSize: null, offset: null },
      "decision-history": { deployment: null, transitions: [], transitionCount: null, returned: null, truncated: null, pageSize: null, offset: null },
    };
    for (const route of HISTORY_ROUTES) {
      const res = await user.get(`/api/assurance/deployments/dep-bare/${route}`);
      expect(res.status, route).toBe(200);
      expect(res.body, route).toEqual(expected[route]);
    }
  });

  it("passes each filter and the offset on, encoded, and encodes the deployment's path segment", async () => {
    const asked = async (url: string) => {
      const before = seen.length;
      const res = await user.get(url);
      expect(res.status, url).toBe(200);
      const sent = seen.slice(before);
      expect(sent.length, url).toBe(1);
      return sent[0];
    };
    const approvals = await asked("/api/assurance/deployments/dep-1/approval-history?workflow=refund&offset=50");
    expect(approvals.path).toBe("/api/assurance/deployments/dep-1/approval-history/");
    expect(Object.fromEntries(new URLSearchParams(approvals.query))).toEqual({ workflow: "refund", offset: "50" });

    // A value that would break out of the query is sent as a value: encoded, and read back as itself.
    const odd = "a b&kind=skill#x?y/z";
    const contracts = await asked(`/api/assurance/deployments/dep-1/tool-contracts?kind=tool&identifier=${encodeURIComponent(odd)}&offset=0`);
    expect(contracts.query).not.toContain("#");
    expect(contracts.query).not.toContain("&kind=skill");
    expect(Array.from(new URLSearchParams(contracts.query).entries())).toEqual([["kind", "tool"], ["identifier", odd], ["offset", "0"]]);

    const bindings = await asked("/api/assurance/deployments/dep-1/tool-contract-bindings?kind=mcp_server&identifier=files-mcp");
    expect(Object.fromEntries(new URLSearchParams(bindings.query))).toEqual({ kind: "mcp_server", identifier: "files-mcp" });

    // Nothing asked, nothing sent: no filter and no offset is invented.
    const decisions = await asked("/api/assurance/deployments/dep-1/decision-history");
    expect(decisions.query).toBe("");

    // Leading zeros are digits: the backend takes them, and is sent the number.
    const zeros = await asked("/api/assurance/deployments/dep-1/decision-history?offset=007");
    expect(zeros.query).toBe("offset=7");
    // The furthest offset the backend takes is relayed.
    const furthest = await asked("/api/assurance/deployments/dep-1/decision-history?offset=2147483647");
    expect(furthest.query).toBe("offset=2147483647");

    // A deployment id carrying a slash is one encoded path segment, never a second one.
    const slashed = await asked("/api/assurance/deployments/dep-echo%2F1/approval-history");
    expect(slashed.path).toBe("/api/assurance/deployments/dep-echo%2F1/approval-history/");
  });

  it("refuses an offset that is not plain digits up to 2^31 - 1 with a 400 here, and relays nothing for it", async () => {
    const malformed = ["-1", "+1", " 1", "1 ", "1.0", "1e3", "0x10", "\uFF11", "", "1_000", "1,000", "2147483648", "9999999999999", "abc"];
    for (const route of HISTORY_ROUTES) {
      for (const offset of malformed) {
        const before = seen.length;
        const res = await user.get(`/api/assurance/deployments/dep-1/${route}?offset=${encodeURIComponent(offset)}`);
        expect(res.status, `${route} ${JSON.stringify(offset)}`).toBe(400);
        expect(res.body.code, `${route} ${JSON.stringify(offset)}`).toBe("invalid_offset");
        expect(seen.slice(before), `${route} ${JSON.stringify(offset)} reached the backend`).toEqual([]);
      }
      // Given twice, it is neither: refused, never read as no offset.
      const before = seen.length;
      const twice = await user.get(`/api/assurance/deployments/dep-1/${route}?offset=1&offset=2`);
      expect(twice.status, route).toBe(400);
      expect(seen.slice(before)).toEqual([]);
    }
  });

  it("refuses a filter given twice, rather than reading it as no filter, and relays nothing for it", async () => {
    for (const url of [
      "/api/assurance/deployments/dep-1/approval-history?workflow=refund&workflow=export",
      "/api/assurance/deployments/dep-1/tool-contracts?kind=tool&kind=skill",
      "/api/assurance/deployments/dep-1/tool-contract-bindings?identifier=a&identifier=b",
    ]) {
      const before = seen.length;
      const res = await user.get(url);
      expect(res.status, url).toBe(400);
      expect(seen.slice(before), url).toEqual([]);
    }
  });

  it("passes on a filter the backend refuses as its 400, in its words -- never as an outage", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/tool-contracts?kind=model");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("backend_refused");
    expect(res.body.error).toContain("must be one of");
  });

  it("reads on from offset + returned while the backend says there is more, every row once", async () => {
    const revisions: number[] = [];
    let offset = 0;
    for (let page = 0; page < 5; page += 1) {
      const res = await user.get(`/api/assurance/deployments/dep-paged/decision-history?offset=${offset}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ transitionCount: 250, pageSize: 100, offset });
      revisions.push(...res.body.transitions.map((t: { revision: number }) => t.revision));
      if (res.body.truncated !== true) break;
      offset += res.body.returned;
    }
    expect(revisions).toEqual(Array.from({ length: 250 }, (_, i) => 250 - i));
    const asked = seen.filter((one) => one.path === "/api/assurance/deployments/dep-paged/decision-history/").map((one) => one.query);
    expect(asked).toEqual(["offset=0", "offset=100", "offset=200"]);
  });

  it("passes a history refusal on as itself: 404 not_found, 403 backend_refused, a person's ended sign-in as 503 backend_sign_in_required", async () => {
    for (const route of HISTORY_ROUTES) {
      const hidden = await user.get(`/api/assurance/deployments/dep-hidden/${route}`);
      expect(hidden.status, route).toBe(404);
      expect(hidden.body.code, route).toBe("not_found");
      const forbidden = await user.get(`/api/assurance/deployments/dep-forbidden/${route}?offset=0`);
      expect(forbidden.status, route).toBe(403);
      expect(forbidden.body.code, route).toBe("backend_refused");
    }
    // The backend refuses the person's token, renewed and all: their sign-in to it ended. Never 401
    // here, which would send the browser to this console's sign-in, away from the kill switch.
    const signedOut = await user.get("/api/assurance/deployments/dep-signed-out/decision-history");
    expect(signedOut.status).toBe(503);
    expect(signedOut.body.code).toBe("backend_sign_in_required");
  });

  it("refuses the history reads to anyone not signed in to this console, and relays nothing for them", async () => {
    const before = seen.length;
    for (const route of HISTORY_ROUTES) {
      expect((await request(app).get(`/api/assurance/deployments/${HISTORY_UUID}/${route}`)).status, route).toBe(401);
      expect((await request(app).get(`/api/assurance/deployments/${HISTORY_UUID}/${route}?offset=x`)).status, route).toBe(401);
    }
    expect(seen.slice(before)).toEqual([]);
  });

  it("relays no write of any route: this server serves none, and the backend sees none", async () => {
    const before = seen.length;
    for (const send of [
      () => user.put("/api/assurance/deployments/dep-1/approved-workflows").send({ workflows: [] }),
      () => user.post("/api/assurance/deployments/dep-1/approved-workflows").send({ workflows: [] }),
      () => user.post("/api/assurance/deployments/dep-1/authority-chains").send({ workflow: "refunds", hops: [] }),
      () => user.patch("/api/assurance/deployments/dep-1/authority-chains").send({}),
      () => user.delete("/api/assurance/deployments/dep-1/approved-workflows"),
      ...HISTORY_ROUTES.flatMap((route) => [
        () => user.post(`/api/assurance/deployments/${HISTORY_UUID}/${route}`).send({ versions: [], transitions: [] }),
        () => user.put(`/api/assurance/deployments/${HISTORY_UUID}/${route}`).send({}),
        () => user.patch(`/api/assurance/deployments/${HISTORY_UUID}/${route}`).send({}),
        () => user.delete(`/api/assurance/deployments/${HISTORY_UUID}/${route}`),
      ]),
    ]) {
      const res = await send();
      expect(res.status).toBe(404);
    }
    expect(seen.slice(before)).toEqual([]);
    expect(seen.filter((one) => one.method !== "GET").map((one) => `${one.method} ${one.path}`)).toEqual([]);
  });

  it("went to the backend as the signed-in person every time, never as the service account", async () => {
    const reads = seen.filter((one) =>
      /\/(approved-workflows|authority-chains|decision-support|approval-history|tool-contracts|tool-contract-bindings|decision-history)\/$/.test(one.path),
    );
    expect(reads.length).toBeGreaterThan(5);
    // Each history route among them, so none is left out of the check.
    for (const route of HISTORY_ROUTES) expect(reads.some((one) => one.path.endsWith(`/${route}/`)), route).toBe(true);
    expect(reads.filter((one) => one.authorization !== "Bearer access-for-admin").map((one) => `${one.path} ${one.authorization}`)).toEqual([]);
  });
});
