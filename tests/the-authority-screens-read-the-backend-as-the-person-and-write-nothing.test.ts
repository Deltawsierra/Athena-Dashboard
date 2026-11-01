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
 */

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);

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

interface Seen { method: string; path: string; authorization: string }

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
        const path = (req.url ?? "").split("?")[0];
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
        seen.push({ method, path, authorization: req.headers.authorization ?? "" });
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

  it("relays no write of either route: this server serves none, and the backend sees none", async () => {
    const before = seen.length;
    for (const send of [
      () => user.put("/api/assurance/deployments/dep-1/approved-workflows").send({ workflows: [] }),
      () => user.post("/api/assurance/deployments/dep-1/approved-workflows").send({ workflows: [] }),
      () => user.post("/api/assurance/deployments/dep-1/authority-chains").send({ workflow: "refunds", hops: [] }),
      () => user.patch("/api/assurance/deployments/dep-1/authority-chains").send({}),
      () => user.delete("/api/assurance/deployments/dep-1/approved-workflows"),
    ]) {
      const res = await send();
      expect(res.status).toBe(404);
    }
    expect(seen.slice(before)).toEqual([]);
    expect(seen.filter((one) => one.method !== "GET").map((one) => `${one.method} ${one.path}`)).toEqual([]);
  });

  it("went to the backend as the signed-in person every time, never as the service account", async () => {
    const reads = seen.filter((one) => /\/(approved-workflows|authority-chains|decision-support)\/$/.test(one.path));
    expect(reads.length).toBeGreaterThan(5);
    expect(reads.filter((one) => one.authorization !== "Bearer access-for-admin").map((one) => `${one.path} ${one.authorization}`)).toEqual([]);
  });
});
