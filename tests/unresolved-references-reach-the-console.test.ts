import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { readFileSync } from "fs";
import { resolve } from "path";

import { makeApp, signIn } from "./helpers";

/**
 * A reference the inventory declares and discovery could not place is a fact:
 * this system names a component nobody can find. The backend now reports it in
 * one shape from BOTH readers of the asset graph — the effective-access reach
 * assessment and the route map — because they used to resolve the same strings
 * differently and so disagreed about which hops exist.
 *
 * This console is the last hop before an operator, and it is exactly where that
 * fact can quietly stop existing: a mapper that reads keys the backend no longer
 * sends produces an empty string, and an empty string renders as a gap with no
 * name. So these tests do not check that the field is "mapped" — they check that
 * what reaches the response is something an operator could act on, and that a
 * reach assessment computed over an incomplete graph says so.
 *
 * The shape is `{source, source_kind, reference, mechanism}`. `mechanism` is
 * "tools" (an agent naming a tool it cannot reach) or "server" (a component
 * naming a backend that is not there) — different problems, and the page words
 * them differently.
 */

const ROUTE_MAP = {
  layers: [
    {
      key: "app",
      label: "Application",
      nodes: [
        {
          uuid: "n-agent", name: "assistant", kind: "agent", kind_label: "Agent",
          classification: "known", classification_label: "Known", layer: "app",
          shadow: false, provider_name: null,
        },
      ],
    },
  ],
  nodes: [
    {
      uuid: "n-agent", name: "assistant", kind: "agent", kind_label: "Agent",
      classification: "known", classification_label: "Known", layer: "app",
      shadow: false, provider_name: null,
    },
  ],
  edges: [],
  unresolved: [
    { source: "assistant", source_kind: "agent", reference: "ghost-tool", mechanism: "tools" },
    { source: "report-builder", source_kind: "tool", reference: "mcp-ghost", mechanism: "server" },
  ],
  summary: {
    node_count: 1, edge_count: 0, declared_edges: 0, inferred_edges: 0,
    shadow_nodes: 0, unresolved_edges: 2,
    unresolved_tool_references: 1, unresolved_server_references: 1,
    layers_present: ["app"], logs_observed: false,
  },
};

const EFFECTIVE_ACCESS = {
  principals: [
    {
      key: "asset:n-agent", name: "assistant", kind: "agent", kind_label: "Agent",
      classification: "known", classification_label: "Known",
      privilege: "baseline", privilege_label: "Baseline", privileged: false,
      shadow: false, orphaned: false, over_broad: false, risk: "baseline",
      capabilities: [], effective_reach: [], gaps: [],
    },
  ],
  unresolved: [
    { source: "assistant", source_kind: "agent", reference: "ghost-tool", mechanism: "tools" },
  ],
  summary: {
    principals: 1, privileged: 0, shadow: 0, orphaned: 0, over_broad: 0,
    high_risk_reach: 0, unresolved_references: 1, worst_risk: "baseline",
  },
};

describe("an unresolved reference survives the BFF", () => {
  let app: Express;
  let user: Awaited<ReturnType<typeof signIn>>;
  let server: Server;

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      const method = req.method ?? "GET";
      const path = (req.url ?? "").split("?")[0];
      const json = (code: number, payload: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (path === "/api/token/" && method === "POST") {
        return json(200, { access: "svc-access-token", refresh: "r" });
      }
      if (path === "/api/assurance/deployments/dep-1/route-map/" && method === "GET") {
        return json(200, ROUTE_MAP);
      }
      if (path === "/api/assurance/deployments/dep-1/effective-access/" && method === "GET") {
        return json(200, EFFECTIVE_ACCESS);
      }
      // A deployment whose graph resolved completely. The negative control: if
      // the console started manufacturing gaps, this is what catches it.
      if (path === "/api/assurance/deployments/dep-clean/route-map/" && method === "GET") {
        return json(200, {
          ...ROUTE_MAP,
          unresolved: [],
          summary: {
            ...ROUTE_MAP.summary,
            unresolved_edges: 0,
            unresolved_tool_references: 0,
            unresolved_server_references: 0,
          },
        });
      }
      if (path === "/api/assurance/deployments/dep-clean/effective-access/" && method === "GET") {
        return json(200, {
          ...EFFECTIVE_ACCESS,
          unresolved: [],
          summary: { ...EFFECTIVE_ACCESS.summary, unresolved_references: 0 },
        });
      }
      // A control plane that predates the field entirely: it sends no `unresolved`
      // and no count. It has not said the graph resolved cleanly; it has said
      // nothing. This console ships independently of the control plane, so this
      // is the ordinary skew case, not a hypothetical.
      if (path === "/api/assurance/deployments/dep-old/route-map/" && method === "GET") {
        const { unresolved: _u, summary, ...rest } = ROUTE_MAP;
        const {
          unresolved_edges: _e,
          unresolved_tool_references: _t,
          unresolved_server_references: _s,
          ...summaryRest
        } = summary;
        return json(200, { ...rest, summary: summaryRest });
      }
      if (path === "/api/assurance/deployments/dep-old/effective-access/" && method === "GET") {
        const { unresolved: _u, summary, ...rest } = EFFECTIVE_ACCESS;
        const { unresolved_references: _r, ...summaryRest } = summary;
        return json(200, { ...rest, summary: summaryRest });
      }
      // A control plane that counts two and can only name one. The count is its
      // own; the row it dropped is still a gap.
      if (path === "/api/assurance/deployments/dep-undercount/route-map/" && method === "GET") {
        return json(200, {
          ...ROUTE_MAP,
          unresolved: [ROUTE_MAP.unresolved[0], { ...ROUTE_MAP.unresolved[1], reference: "  " }],
        });
      }
      // A mechanism this console has never been taught.
      if (path === "/api/assurance/deployments/dep-mechanism/route-map/" && method === "GET") {
        return json(200, {
          ...ROUTE_MAP,
          unresolved: [
            { source: "assistant", source_kind: "agent", reference: "vault-prod", mechanism: "credential" },
          ],
          summary: {
            ...ROUTE_MAP.summary,
            unresolved_edges: 1,
            unresolved_tool_references: 0,
            unresolved_server_references: 0,
          },
        });
      }
      // A control plane that says WHY each reference could not be placed, for
      // each mechanism it knows, including the account an agent acts as.
      if (path === "/api/assurance/deployments/dep-reasons/route-map/" && method === "GET") {
        return json(200, {
          ...ROUTE_MAP,
          unresolved: [
            { source: "assistant", source_kind: "agent", reference: "svc-gone", mechanism: "identity", reason: "not_found" },
            { source: "assistant", source_kind: "agent", reference: "planner", mechanism: "tools", reason: " ambiguous " },
            { source: "reader", source_kind: "tool", reference: "assistant", mechanism: "server", reason: "names_a_principal" },
            { source: "reader", source_kind: "tool", reference: "db", mechanism: "server", reason: "" },
            { source: "reader", source_kind: "tool", reference: "cache", mechanism: "server", reason: 7 },
          ],
          summary: {
            ...ROUTE_MAP.summary,
            unresolved_edges: 5,
            unresolved_tool_references: 1,
            unresolved_server_references: 3,
            unresolved_identity_references: 1,
          },
        });
      }
      // A backend that sends a row with nothing in it. Not a gap an operator can
      // chase; counting it would be a manufactured finding.
      if (path === "/api/assurance/deployments/dep-blank/route-map/" && method === "GET") {
        return json(200, {
          ...ROUTE_MAP,
          unresolved: [{ source: "assistant", source_kind: "agent", reference: "  ", mechanism: "tools" }],
        });
      }
      return json(404, { detail: "not found" });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_FAILSAFE_USER = "svc-operator";
    process.env.ATHENA_FAILSAFE_PASSWORD = "svc-secret";
    vi.resetModules();
    app = await makeApp();
    user = await signIn(app);
  });

  afterAll(async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    delete process.env.ATHENA_FAILSAFE_USER;
    delete process.env.ATHENA_FAILSAFE_PASSWORD;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("gives the route map's dangling references a source, a target and a mechanism", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/route-map");
    expect(res.status).toBe(200);
    expect(res.body.unresolved).toEqual([
      { source: "assistant", sourceKind: "agent", reference: "ghost-tool", mechanism: "tools", reason: null },
      { source: "report-builder", sourceKind: "tool", reference: "mcp-ghost", mechanism: "server", reason: null },
    ]);
  });

  it("splits the route map's unresolved count by mechanism", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/route-map");
    expect(res.body.summary).toMatchObject({
      unresolvedEdges: 2,
      unresolvedToolReferences: 1,
      unresolvedServerReferences: 1,
    });
  });

  it("carries the reach assessment's unresolved references, which it had no channel for", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/effective-access");
    expect(res.status).toBe(200);
    expect(res.body.unresolved).toEqual([
      { source: "assistant", sourceKind: "agent", reference: "ghost-tool", mechanism: "tools", reason: null },
    ]);
    expect(res.body.summary.unresolvedReferences).toBe(1);
  });

  it("reports no gaps for a graph that resolved completely", async () => {
    const map = await user.get("/api/assurance/deployments/dep-clean/route-map");
    expect(map.body.unresolved).toEqual([]);
    expect(map.body.summary.unresolvedEdges).toBe(0);

    const access = await user.get("/api/assurance/deployments/dep-clean/effective-access");
    expect(access.body.unresolved).toEqual([]);
    expect(access.body.summary.unresolvedReferences).toBe(0);
  });

  it("drops a row with no reference in it rather than showing an unnamed gap", async () => {
    const res = await user.get("/api/assurance/deployments/dep-blank/route-map");
    expect(res.body.unresolved).toEqual([]);
  });

  it("does not let a control plane that cannot answer look like a clean graph", async () => {
    // The defect this closes: with `[]` and `0` as the fallbacks, a control plane
    // predating the field produced a response byte-identical to one reporting a
    // graph that resolved cleanly -- so the negative control below passed for
    // both, and the page rendered no caveat at all beside its unqualified
    // "every path is evidenced" claim. Null is the answer "nobody said".
    const oldMap = await user.get("/api/assurance/deployments/dep-old/route-map");
    expect(oldMap.body.unresolved).toBeNull();
    expect(oldMap.body.summary.unresolvedEdges).toBeNull();
    expect(oldMap.body.summary.unresolvedToolReferences).toBeNull();

    const oldAccess = await user.get("/api/assurance/deployments/dep-old/effective-access");
    expect(oldAccess.body.unresolved).toBeNull();
    expect(oldAccess.body.summary.unresolvedReferences).toBeNull();

    // And the two are distinguishable, which is the whole point.
    const cleanMap = await user.get("/api/assurance/deployments/dep-clean/route-map");
    expect(cleanMap.body.unresolved).toEqual([]);
    expect(cleanMap.body.summary.unresolvedEdges).toBe(0);
    expect(JSON.stringify(oldMap.body)).not.toBe(JSON.stringify(cleanMap.body));
  });

  it("keeps the control plane's own count when it can name fewer rows than it counted", async () => {
    // The count is the control plane's; the list is what survived mapping. They
    // can disagree, and both numbers have to reach the operator: deriving the
    // sentence from the list alone hides a row the backend counted and did not
    // send, and printing the total alone claims to have named rows that are not
    // on screen.
    const res = await user.get("/api/assurance/deployments/dep-undercount/route-map");
    expect(res.body.unresolved).toHaveLength(1);
    expect(res.body.summary.unresolvedEdges).toBe(2);
  });

  it("does not give an unknown mechanism the wording reserved for a known one", async () => {
    const res = await user.get("/api/assurance/deployments/dep-mechanism/route-map");
    expect(res.body.unresolved).toEqual([
      { source: "assistant", sourceKind: "agent", reference: "vault-prod", mechanism: "credential", reason: null },
    ]);
    // The mechanism reaches the page as itself, so the page can decline to word
    // it as either of the two it knows.
    expect(res.body.summary.unresolvedEdges).toBe(1);
    expect(res.body.summary.unresolvedToolReferences).toBe(0);
    expect(res.body.summary.unresolvedServerReferences).toBe(0);
  });

  it("carries why each reference could not be placed, and nothing it was not told", async () => {
    const res = await user.get("/api/assurance/deployments/dep-reasons/route-map");
    expect(res.body.unresolved.map((u: { reason: string | null }) => u.reason)).toEqual([
      "not_found",
      "ambiguous",
      "names_a_principal",
      // Blank and non-string are the control plane not saying, never a reason.
      null,
      null,
    ]);
    expect(res.body.summary.unresolvedIdentityReferences).toBe(1);
  });

  it("does not report an identity count a control plane never sent", async () => {
    const old = await user.get("/api/assurance/deployments/dep-1/route-map");
    expect(old.body.summary.unresolvedIdentityReferences).toBeNull();
  });

  it("refuses either assessment to anyone not signed in", async () => {
    const request = (await import("supertest")).default;
    expect((await request(app).get("/api/assurance/deployments/dep-1/route-map")).status).toBe(401);
    expect((await request(app).get("/api/assurance/deployments/dep-1/effective-access")).status).toBe(401);
  });
});

/**
 * Source-shape ratchets. The page is a single 8000-line file and the honest
 * thing about a gap is where it is said, not that a string exists somewhere: a
 * caveat rendered below a fold nobody opens is not a caveat. These pin the three
 * placements that make the gap unmissable, so a later refactor that drops one
 * fails here rather than silently.
 */
describe("the Assurance page says where the graph had holes", () => {
  const source = readFileSync(
    resolve(__dirname, "../client/src/pages/Assurance.tsx"),
    "utf8",
  );

  it("words each mechanism it knows differently, and refuses to word one it does not", () => {
    // "assistant names ghost-tool" and "report-builder is wired to mcp-ghost"
    // are different problems. Flattening them to one verb would lose which kind
    // of declaration to go and fix.
    expect(source).toContain('tools: "names"');
    expect(source).toContain('server: "is wired to"');
    expect(source).toContain('identity: "acts as"');
    // And the lookup must be a MAP with an explicit unknown branch, not a
    // two-way ternary. A ternary's else-arm hands every future mechanism the
    // wording reserved for one of these two: a dangling credential binding would
    // read as an agent's tool declaration and send an operator to audit the
    // wrong manifest.
    expect(source).toContain("MECHANISM_PHRASING[u.mechanism] ??");
    expect(source).not.toContain('u.mechanism === "server" ?');
  });

  it("renders the reach assessment's holes under its evidenced-paths claim", () => {
    // The claim is "every path is evidenced". The qualification is that the
    // graph those paths were traced through was incomplete. It has to sit with
    // the claim, not at the bottom of the panel.
    const claim = source.indexOf("Every path is");
    const caveat = source.indexOf("<UnresolvedReferences", claim);
    const chips = source.indexOf("principal{summary.principals === 1", claim);
    expect(claim).toBeGreaterThan(-1);
    expect(caveat).toBeGreaterThan(claim);
    expect(caveat).toBeLessThan(chips);
  });

  it("does not let an unreadable inventory read as an empty one", () => {
    // Zero principals AND dangling references is not "no identity that can act
    // is on record" — it is "we could not place part of what is on record".
    const empty = source.indexOf("no identity that can act is on record");
    expect(empty).toBeGreaterThan(-1);
    const after = source.slice(empty, empty + 600);
    expect(after).toContain("<UnresolvedReferences");
  });

  it("gives an unknown risk band its own tone and the backend's own word", () => {
    // The chip this replaces was a closed three-way ternary whose final arm was
    // an unconditional "Baseline" in muted grey, so a backend `critical`
    // rendered as the LOWEST band. That inverts the severity rather than losing
    // it. Same treatment the disposition chip already has.
    expect(source).toContain("const RISK_TONE");
    expect(source).toContain("RISK_TONE[risk] ?? { cls: RISK_UNKNOWN, label: risk }");
    expect(source).toContain('label: "risk not stated"');
    // And no call site may launder a missing risk into the lowest band.
    expect(source).not.toContain('worstRisk ?? "baseline"');
  });

  it("renders the high-risk-reach roll-up the BFF maps", () => {
    // It was mapped by the server and referenced exactly once on this page: in
    // the interface declaration. Every other field in the same summary object
    // had a chip.
    expect(source.split("summary.highRiskReach").length - 1).toBeGreaterThan(1);
    expect(source).toContain("high-risk reach");
  });

  it("keeps one component for both readers rather than two renderings of one fact", () => {
    const occurrences = source.split("<UnresolvedReferences").length - 1;
    expect(occurrences).toBe(3);
    expect(source.split("function UnresolvedReferences").length - 1).toBe(1);
  });
});
