import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn, signInToBackend } from "./helpers";

/**
 * No read fails whole on one bad row, and no list served as something that is
 * not a list reads as an empty one (server/assurance.ts rowsOf, claimBriefs;
 * DASH-HOSTILE-2, after Dash #93).
 *
 * 1. The decision-support read mapped each of its four claim lists
 *    (contradicted, stale, unknown, supporting) element by element with no
 *    check: one null row threw, so the whole read failed and the release gate
 *    and the assurance panel showed nothing at all; a number row drew a blank
 *    claim. Now each goes through rowsOf: the rows it can read are shown, each
 *    one it cannot is counted under the list's name in `claims.unreadable`, and
 *    what such a row held is never carried.
 *
 * 2. A list the backend served as something that is not a list (a string, a
 *    number, a record, true) read as [] with nothing said, so the screen said
 *    "none". Now `unreadable[list]` is "not a list" for it, and the screens say
 *    "The list could not be read" (tests/a-bad-row-or-a-list-that-is-not-one-
 *    is-said-never-read-as-none.test.tsx). A list not served at all (absent, or
 *    null) is not counted: it reads as it always did.
 *
 * Every rowsOf list is driven here through the real routes, against a stand-in
 * backend.
 */

const LEAK = "a-row-that-could-not-be-read";
const UNREADABLE = () => [null, 7, LEAK, [LEAK]];
const FOUR = UNREADABLE().length;
/** Values that are there and are not lists, each with what must never reach the answer. */
const NOT_LISTS: unknown[] = [LEAK, 7, { rows: [LEAK] }, true];
const NOT_A_LIST = "not a list";

const B = "b".repeat(64);
const CLAIM = (uuid: string, status: string) => ({ uuid, claim_type: "authz_boundary", status, statement: `claim ${uuid}` });

const decision = (claims: Record<string, unknown>) => ({
  decision: "needs_more_evidence", decision_label: "Needs more evidence", revision: 3, paused: false,
  claims: {
    has_claims: true, retest_pending: false,
    superseded_tool_contracts: [], authority_chains_broken: [], authority_chains_unproven: [],
    authority_chains_missing: [], effect_classes_unknown: [],
    ...claims,
  },
  note: "the decision as the backend reached it",
});

const HOP = (extra: Record<string, unknown>) => ({
  index: 0, from: { kind: "agent", ref: "a" }, relation: "invokes", to: { kind: "tool", ref: "t" }, verdict: "unproven", ...extra,
});
const CHAIN = (extra: Record<string, unknown>) => ({
  uuid: "ch-1", workflow: "refunds", effect: "refund issued", digest: `sha256:${"e".repeat(64)}`, standing: true, verdict: "unproven",
  basis: "attested", basis_in_force: "attested", signed: false, observer_engine: null, outcome_id: null, gate_outcome_id: null,
  effect_outcome_id: null, route: "current", observed_at: null, recorded_at: null, recorded_by: null, source: "", note: "",
  unproven_hops: [0], broken_hops: [], ...extra,
});
const PAGE = { returned: 1, truncated: false, page_size: 100, offset: 0 };
const HISTORY = "0f0e0d0c-0b0a-4908-8706-050403020100";

/** The answers, by the deployment the path names: one per value that is not a list. */
function answers(): Record<string, unknown> {
  const out: Record<string, unknown> = {
    // (1) one bad row of each kind in each claim list, beside rows that can be read.
    "/api/assurance/deployments/dep-rows/decision-support/": decision({
      contradicted: [CLAIM("c-1", "contradicted"), ...UNREADABLE()],
      stale: [...UNREADABLE(), CLAIM("s-1", "stale")],
      unknown: [null],
      supporting: [CLAIM("p-1", "supported"), 0],
    }),
    // A claim list whose every row is one: still a read, never a failure.
    "/api/assurance/deployments/dep-null/decision-support/": decision({
      contradicted: [null], stale: [], unknown: [], supporting: [],
    }),
    // Lists not served, or served as null: not counted, read as they always were.
    "/api/assurance/deployments/dep-absent/decision-support/": decision({
      contradicted: null, stale: null, supporting: [CLAIM("p-1", "supported")],
      superseded_tool_contracts: null, authority_chains_broken: undefined,
    }),
    "/api/assurance/deployments/dep-absent/approved-workflows/": {
      approved: [{ uuid: "wf-1", slug: "refunds", name: "Refunds", description: "", approved_by: "alice", approved_at: null, tools: null }],
      returned: 1, truncated: false, page_size: 1000, approved_count: 1, composition: null,
    },
  };
  NOT_LISTS.forEach((value, i) => {
    const dep = `dep-${i}`;
    out[`/api/assurance/deployments/${dep}/decision-support/`] = decision({
      contradicted: value, stale: value, unknown: value, supporting: value,
      superseded_tool_contracts: value, authority_chains_broken: value, authority_chains_unproven: [{
        uuid: "ch-1", workflow: "refunds", effect: "refund issued", digest: "d", verdict: "unproven", hops: value,
      }],
      authority_chains_missing: value, effect_classes_unknown: value,
    });
    out[`/api/assurance/deployments/${dep}/approved-workflows/`] = {
      approved: value, returned: 1, truncated: false, page_size: 1000, approved_count: 1, composition: null,
    };
    out[`/api/assurance/deployments/${dep}-tools/approved-workflows/`] = {
      approved: [{ uuid: "wf-1", slug: "refunds", name: "Refunds", description: "", approved_by: "alice", approved_at: null, tools: value }],
      returned: 1, truncated: false, page_size: 1000, approved_count: 1, composition: null,
    };
    out[`/api/assurance/deployments/${dep}/authority-chains/`] = {
      chains: value, effects: value, returned: 1, truncated: false, page_size: 100, recorded: 1, standing: 1, superseded: 0,
      verdict_census: {}, approvals_in_force: {}, effect_census: {},
    };
    out[`/api/assurance/deployments/${dep}-hops/authority-chains/`] = {
      chains: [CHAIN({ hops: value }), CHAIN({ uuid: "ch-2", hops: [HOP({ proven_by: value, reasons: value })] })],
      effects: [], returned: 2, truncated: false, page_size: 100, recorded: 2, standing: 2, superseded: 0,
      verdict_census: {}, approvals_in_force: {}, effect_census: {},
    };
  });
  return out;
}

/** The histories: each page's list, and an approval version's tools, as a value that is not a list. */
function histories(value: unknown): Record<string, unknown> {
  const base = `/api/assurance/deployments/${HISTORY}`;
  return {
    [`${base}/approval-history/`]: {
      deployment: HISTORY, workflow: null, version_count: 2, ...PAGE,
      versions: value === "versions" ? LEAK : [{
        version: "40", workflow: "refund", digest: B, withdrawn: false, in_force_from: null, in_force_until: null, recorded_at: null,
        declared_by: null, tools: { rows: [LEAK] },
      }],
    },
    [`${base}/tool-contracts/`]: { deployment: HISTORY, kind: null, identifier: null, contract_count: 1, ...PAGE, contracts: 7 },
    [`${base}/tool-contract-bindings/`]: { deployment: HISTORY, kind: null, identifier: null, binding_count: 1, ...PAGE, bindings: LEAK },
    [`${base}/decision-history/`]: { deployment: HISTORY, transition_count: 1, ...PAGE, transitions: { rows: [LEAK] } },
  };
}

describe("no read fails whole on one bad row, and a list that is not one never reads as none", () => {
  let app: Express;
  let user: Awaited<ReturnType<typeof signIn>>;
  let server: Server;
  let served: Record<string, unknown> = {};

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
        if (req.method === "GET" && path in served) return json(200, served[path]);
        return json(404, { detail: "Not found." });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_FAILSAFE_USER = "svc-operator";
    process.env.ATHENA_FAILSAFE_PASSWORD = "svc-secret"; // pragma: allowlist secret
    served = answers();
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
    expect(res.status, `${path}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    // What an unreadable row, or a list that is not one, held is never carried.
    expect(JSON.stringify(res.body)).not.toContain(LEAK);
    return res.body;
  }

  describe("1. a claim row that cannot be read", () => {
    it("never fails the decision-support read: the rows it can read are shown, and each one it cannot is counted", async () => {
      const body = await read("/api/assurance/deployments/dep-rows/decision-support");
      expect(body.decision).toBe("needs_more_evidence");
      expect(body.note).toBe("the decision as the backend reached it");
      expect(body.claims.contradicted).toEqual([{ uuid: "c-1", claimType: "authz_boundary", status: "contradicted", statement: "claim c-1" }]);
      expect(body.claims.stale).toEqual([{ uuid: "s-1", claimType: "authz_boundary", status: "stale", statement: "claim s-1" }]);
      expect(body.claims.unknown).toEqual([]);
      expect(body.claims.supporting).toEqual([{ uuid: "p-1", claimType: "authz_boundary", status: "supported", statement: "claim p-1" }]);
      expect(body.claims.unreadable).toEqual({ contradicted: FOUR, stale: FOUR, unknown: 1, supporting: 1 });
    });

    it("a list whose only row is null is a read that says so, not a failed read", async () => {
      const body = await read("/api/assurance/deployments/dep-null/decision-support");
      expect(body.claims.contradicted).toEqual([]);
      expect(body.claims.unreadable).toEqual({ contradicted: 1 });
    });

    it("a list not served, or served as null, is not counted: the answer is the shape it was (the control)", async () => {
      const support = await read("/api/assurance/deployments/dep-absent/decision-support");
      expect(support.claims).not.toHaveProperty("unreadable");
      expect(support.claims.contradicted).toEqual([]);
      expect(support.claims.supporting).toHaveLength(1);
      const workflows = await read("/api/assurance/deployments/dep-absent/approved-workflows");
      expect(workflows).not.toHaveProperty("unreadable");
      expect(workflows.approved[0]).not.toHaveProperty("unreadable");
      expect(workflows.approved[0].tools).toEqual([]);
    });
  });

  describe("2. a list served as something that is not a list", () => {
    NOT_LISTS.forEach((value, i) => {
      const as = JSON.stringify(value);
      it(`is "not a list" in every list that holds the decision, never an empty one (${as})`, async () => {
        const body = await read(`/api/assurance/deployments/dep-${i}/decision-support`);
        expect(body.claims.unreadable).toEqual({
          contradicted: NOT_A_LIST, stale: NOT_A_LIST, unknown: NOT_A_LIST, supporting: NOT_A_LIST,
          supersededToolContracts: NOT_A_LIST, authorityChainsBroken: NOT_A_LIST,
          authorityChainsMissing: NOT_A_LIST, effectClassesUnknown: NOT_A_LIST,
        });
        for (const list of ["contradicted", "stale", "unknown", "supporting", "supersededToolContracts", "authorityChainsBroken", "authorityChainsMissing", "effectClassesUnknown"]) {
          expect(body.claims[list], list).toEqual([]);
        }
        expect(body.claims.authorityChainsUnproven).toHaveLength(1);
        expect(body.claims.authorityChainsUnproven[0].hops).toEqual([]);
        expect(body.claims.authorityChainsUnproven[0].unreadable).toEqual({ hops: NOT_A_LIST });
      });

      it(`is "not a list" in the approved set and in an approval's tools (${as})`, async () => {
        const set = await read(`/api/assurance/deployments/dep-${i}/approved-workflows`);
        expect(set.approved).toEqual([]);
        expect(set.unreadable).toEqual({ approved: NOT_A_LIST });
        const tools = await read(`/api/assurance/deployments/dep-${i}-tools/approved-workflows`);
        expect(tools).not.toHaveProperty("unreadable");
        expect(tools.approved[0].tools).toEqual([]);
        expect(tools.approved[0].unreadable).toEqual({ tools: NOT_A_LIST });
      });

      it(`is "not a list" in the chains, the effects, a chain's hops and a hop's readings (${as})`, async () => {
        const top = await read(`/api/assurance/deployments/dep-${i}/authority-chains`);
        expect(top.chains).toEqual([]);
        expect(top.effects).toEqual([]);
        expect(top.unreadable).toEqual({ chains: NOT_A_LIST, effects: NOT_A_LIST });
        const nested = await read(`/api/assurance/deployments/dep-${i}-hops/authority-chains`);
        expect(nested).not.toHaveProperty("unreadable");
        expect(nested.chains[0].hops).toEqual([]);
        expect(nested.chains[0].unreadable).toEqual({ hops: NOT_A_LIST });
        expect(nested.chains[1]).not.toHaveProperty("unreadable");
        expect(nested.chains[1].hops[0].unreadable).toEqual({ provenBy: NOT_A_LIST, reasons: NOT_A_LIST });
      });
    });

    it('is "not a list" in each history page, and in an approval version\'s tools', async () => {
      Object.assign(served, histories("tools"));
      const versions = await read(`/api/assurance/deployments/${HISTORY}/approval-history`);
      expect(versions).not.toHaveProperty("unreadable");
      expect(versions.versions[0].tools).toEqual([]);
      expect(versions.versions[0].unreadable).toEqual({ tools: NOT_A_LIST });

      Object.assign(served, histories("versions"));
      const page = await read(`/api/assurance/deployments/${HISTORY}/approval-history`);
      expect(page.versions).toEqual([]);
      expect(page.unreadable).toEqual({ versions: NOT_A_LIST });

      const contracts = await read(`/api/assurance/deployments/${HISTORY}/tool-contracts`);
      expect(contracts.contracts).toEqual([]);
      expect(contracts.unreadable).toEqual({ contracts: NOT_A_LIST });

      const bindings = await read(`/api/assurance/deployments/${HISTORY}/tool-contract-bindings`);
      expect(bindings.bindings).toEqual([]);
      expect(bindings.unreadable).toEqual({ bindings: NOT_A_LIST });

      const transitions = await read(`/api/assurance/deployments/${HISTORY}/decision-history`);
      expect(transitions.transitions).toEqual([]);
      expect(transitions.unreadable).toEqual({ transitions: NOT_A_LIST });
    });
  });
});
