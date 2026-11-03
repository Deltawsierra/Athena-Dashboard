import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn, signInToBackend } from "./helpers";

/**
 * A row of a list Athena-Backend served that this console's server cannot read
 * (a null, a number, a string, a list where a record belongs) is counted, never
 * dropped silently (server/assurance.ts rowsOf; Dash #89, AT-7's follow-up).
 *
 * rowsOf used to filter such a row out: the screen drew the rows it could read
 * and nothing said one was missing, so an approval's tools, a chain's hops or a
 * page of history could read shorter than what the backend recorded, and an
 * empty list read "none recorded". Now every list read through rowsOf counts its
 * unreadable rows under its own name in `unreadable` on the object that holds
 * it, and the screens say "N rows could not be read" beside the list
 * (tests/a-row-that-cannot-be-read-is-said-on-every-authority-screen.test.tsx).
 * What such a row held is never carried: it could not be read. A list whose
 * rows were all read carries no `unreadable` at all, so the answer is the shape
 * it always was (tests/the-authority-screens-read-the-backend-as-the-person-
 * and-write-nothing.test.ts pins that shape unchanged).
 *
 * Every rowsOf list is driven here, through the real routes, against a stand-in
 * backend: the approved workflows and each one's tools; the authority chains,
 * each chain's hops, each hop's proving readings and reasons, and the effects;
 * the five lists of decision support that hold the decision, and a held chain's
 * hops; and the four histories (approval versions and each version's tools,
 * tool contracts, bindings, decision changes).
 */

/** Rows no record could be read from: four of them, none of which may reach the answer. */
const LEAK = "a-row-that-could-not-be-read";
const UNREADABLE = () => [null, 7, LEAK, [LEAK]];

const A = "a".repeat(64);
const B = "b".repeat(64);
const HISTORY = "0f0e0d0c-0b0a-4908-8706-050403020100";

const TOOL = { kind: "tool", identifier: "refund@payments", contract_digest: A, bound_at: "2026-10-20T09:00:00Z", current_digest: B, superseded: true };
const READING = { verdict: "unproven", code: "no_dispatch_state", detail: "no dispatch state" };
const HOP = {
  index: 0, from: { kind: "agent", ref: "support-agent" }, relation: "invokes", to: { kind: "tool", ref: "refund@payments" },
  verdict: "unproven", proven_by: [...UNREADABLE()], reasons: [READING, ...UNREADABLE()],
};
const CHAIN = {
  uuid: "ch-1", workflow: "refunds", effect: "refund issued", digest: `sha256:${"e".repeat(64)}`, standing: true, verdict: "unproven",
  basis: "attested", basis_in_force: "attested", signed: false, observer_engine: null, outcome_id: null, gate_outcome_id: null,
  effect_outcome_id: null, route: "current", observed_at: null, recorded_at: "2026-10-22T10:01:00+00:00", recorded_by: null,
  source: "", note: "", unproven_hops: [0], broken_hops: [], hops: [HOP, ...UNREADABLE()],
};
const EFFECT = {
  digest: `sha256:${"1".repeat(64)}`, workflow: null, tool_kind: "skill", tool_identifier: "summarise", effect_class: null,
  class: "unknown", status: "unknown", reasons: [], chains: [], to_do: null,
};
const BRIEF = {
  uuid: "ch-1", workflow: "refunds", effect: "refund issued", digest: `sha256:${"e".repeat(64)}`, verdict: "unproven",
  hops: [{ index: 0, relation: "invokes", from: { kind: "agent", ref: "a" }, to: { kind: "tool", ref: "t" }, verdict: "unproven", reasons: [] }, ...UNREADABLE()],
};
const SUPERSEDED = { subject: "workflow", claim_fingerprint: null, workflow: "refunds", tool_kind: "tool", tool_identifier: "refund@payments", bound_digest: A, current_digest: B };

const ANSWERS: Record<string, unknown> = {
  "/api/assurance/deployments/dep-1/approved-workflows/": {
    approved: [
      { uuid: "wf-1", slug: "refunds", name: "Refunds", description: "", approved_by: "alice", approved_at: null, tools: [TOOL, ...UNREADABLE()] },
      ...UNREADABLE(),
    ],
    returned: 5, truncated: false, page_size: 1000, approved_count: 5, composition: null,
  },
  // Every row read: no `unreadable` anywhere in the answer.
  "/api/assurance/deployments/dep-clean/approved-workflows/": {
    approved: [{ uuid: "wf-1", slug: "refunds", name: "Refunds", description: "", approved_by: "alice", approved_at: null, tools: [TOOL] }],
    returned: 1, truncated: false, page_size: 1000, approved_count: 1, composition: null,
  },
  "/api/assurance/deployments/dep-1/authority-chains/": {
    chains: [CHAIN, ...UNREADABLE()], returned: 5, truncated: false, page_size: 100, recorded: 5, standing: 1, superseded: 0,
    verdict_census: {}, approvals_in_force: {}, effects: [EFFECT, ...UNREADABLE()], effect_census: {},
  },
  "/api/assurance/deployments/dep-1/decision-support/": {
    decision: "audit_incomplete", decision_label: "Audit incomplete", revision: 1, paused: false,
    claims: {
      has_claims: true, retest_pending: false, contradicted: [], stale: [], unknown: [], supporting: [],
      superseded_tool_contracts: [SUPERSEDED, ...UNREADABLE()],
      authority_chains_broken: [...UNREADABLE()],
      authority_chains_unproven: [BRIEF, ...UNREADABLE()],
      authority_chains_missing: [EFFECT, ...UNREADABLE()],
      effect_classes_unknown: [...UNREADABLE()],
    },
    note: "",
  },
  [`/api/assurance/deployments/${HISTORY}/approval-history/`]: {
    deployment: HISTORY, workflow: null, version_count: 5, returned: 5, truncated: false, page_size: 50, offset: 0,
    versions: [
      {
        version: "40", workflow: "refund", digest: B, withdrawn: false, in_force_from: null, in_force_until: null, recorded_at: null, declared_by: null,
        tools: [{ kind: "tool", identifier: "refund@payments", contract_digest: A, bound_at: null, bound_by: null, released_at: null, invalidated_at: null, invalidation_reason: null }, ...UNREADABLE()],
      },
      ...UNREADABLE(),
    ],
  },
  [`/api/assurance/deployments/${HISTORY}/tool-contracts/`]: {
    deployment: HISTORY, kind: null, identifier: null, contract_count: 5, returned: 5, truncated: false, page_size: 100, offset: 0,
    contracts: [{ kind: "tool", identifier: "refund@payments", digest: B, contract: null, recorded_at: null, superseded_at: null, current_digest: B, in_force: true }, ...UNREADABLE()],
  },
  [`/api/assurance/deployments/${HISTORY}/tool-contract-bindings/`]: {
    deployment: HISTORY, kind: null, identifier: null, binding_count: 5, returned: 5, truncated: false, page_size: 100, offset: 0,
    bindings: [{
      subject: "workflow", workflow: "refund", claim_fingerprint: null, kind: "tool", identifier: "refund@payments", contract_digest: B,
      current_digest: B, live: true, superseded: false, bound_at: null, bound_by: null, released_at: null, invalidated_at: null, invalidation_reason: null,
    }, ...UNREADABLE()],
  },
  [`/api/assurance/deployments/${HISTORY}/decision-history/`]: {
    deployment: HISTORY, transition_count: 5, returned: 5, truncated: false, page_size: 100, offset: 0,
    transitions: [{ revision: 1, from_decision: null, to_decision: "ready", basis_digest: null, created_at: null, delivered_at: null }, ...UNREADABLE()],
  },
};

const FOUR = UNREADABLE().length;

describe("a row the backend served that cannot be read", () => {
  let app: Express;
  let user: Awaited<ReturnType<typeof signIn>>;
  let server: Server;

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const [path] = (req.url ?? "").split("?");
        const json = (code: number, payload: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (path === "/api/token/" && req.method === "POST") {
          let username = "(none)";
          try { username = String((JSON.parse(raw || "{}") as { username?: unknown }).username); } catch { /* not JSON */ }
          return json(200, { access: `access-for-${username}`, refresh: `refresh-for-${username}` });
        }
        if (path === "/api/token/revoke/") return json(200, { revoked: true });
        if (path === "/api/token/refresh/") return json(200, { access: "access-for-admin", refresh: "refresh-for-admin" });
        if (req.method === "GET" && path in ANSWERS) return json(200, ANSWERS[path]);
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

  async function read(path: string) {
    const res = await user.get(path);
    expect(res.status, `${path}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
    // What an unreadable row held is never carried.
    expect(JSON.stringify(res.body)).not.toContain(LEAK);
    return res.body;
  }

  it("counts them in the approved workflows and in each approval's tools, keeping every row it read", async () => {
    const body = await read("/api/assurance/deployments/dep-1/approved-workflows");
    expect(body.approved).toHaveLength(1);
    expect(body.unreadable).toEqual({ approved: FOUR });
    expect(body.approved[0].tools).toEqual([
      { kind: "tool", identifier: "refund@payments", approvedDigest: A, boundAt: "2026-10-20T09:00:00Z", currentDigest: B, superseded: true },
    ]);
    expect(body.approved[0].unreadable).toEqual({ tools: FOUR });
  });

  it("carries no count at all where every row was read: the answer is the shape it was", async () => {
    const body = await read("/api/assurance/deployments/dep-clean/approved-workflows");
    expect(body).not.toHaveProperty("unreadable");
    expect(body.approved[0]).not.toHaveProperty("unreadable");
  });

  it("counts them in the chains, each chain's hops, each hop's readings and the effects", async () => {
    const body = await read("/api/assurance/deployments/dep-1/authority-chains");
    expect(body.unreadable).toEqual({ chains: FOUR, effects: FOUR });
    expect(body.chains).toHaveLength(1);
    expect(body.effects).toHaveLength(1);
    const [chain] = body.chains;
    expect(chain.unreadable).toEqual({ hops: FOUR });
    expect(chain.hops).toHaveLength(1);
    expect(chain.hops[0].unreadable).toEqual({ provenBy: FOUR, reasons: FOUR });
    expect(chain.hops[0].provenBy).toEqual([]);
    expect(chain.hops[0].reasons).toEqual([{ verdict: "unproven", code: "no_dispatch_state", detail: "no dispatch state" }]);
  });

  it("counts them in every list that holds the decision, and in a held chain's hops", async () => {
    const body = await read("/api/assurance/deployments/dep-1/decision-support");
    expect(body.claims.unreadable).toEqual({
      supersededToolContracts: FOUR, authorityChainsBroken: FOUR, authorityChainsUnproven: FOUR,
      authorityChainsMissing: FOUR, effectClassesUnknown: FOUR,
    });
    expect(body.claims.supersededToolContracts).toHaveLength(1);
    expect(body.claims.authorityChainsBroken).toEqual([]);
    expect(body.claims.authorityChainsUnproven).toHaveLength(1);
    expect(body.claims.authorityChainsUnproven[0].unreadable).toEqual({ hops: FOUR });
    expect(body.claims.authorityChainsUnproven[0].hops).toHaveLength(1);
    expect(body.claims.authorityChainsMissing).toHaveLength(1);
    expect(body.claims.effectClassesUnknown).toEqual([]);
  });

  it("counts them in each history page, and in each approval version's tools", async () => {
    const versions = await read(`/api/assurance/deployments/${HISTORY}/approval-history`);
    expect(versions.unreadable).toEqual({ versions: FOUR });
    expect(versions.versions).toHaveLength(1);
    expect(versions.versions[0].unreadable).toEqual({ tools: FOUR });
    expect(versions.versions[0].tools).toHaveLength(1);
    // The page still says how many it returned, as served: the next page starts after every row, read or not.
    expect(versions.returned).toBe(5);

    const contracts = await read(`/api/assurance/deployments/${HISTORY}/tool-contracts`);
    expect(contracts.unreadable).toEqual({ contracts: FOUR });
    expect(contracts.contracts).toHaveLength(1);

    const bindings = await read(`/api/assurance/deployments/${HISTORY}/tool-contract-bindings`);
    expect(bindings.unreadable).toEqual({ bindings: FOUR });
    expect(bindings.bindings).toHaveLength(1);

    const transitions = await read(`/api/assurance/deployments/${HISTORY}/decision-history`);
    expect(transitions.unreadable).toEqual({ transitions: FOUR });
    expect(transitions.transitions).toHaveLength(1);
  });
});
