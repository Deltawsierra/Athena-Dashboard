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
      { source: "assistant", sourceKind: "agent", reference: "ghost-tool", mechanism: "tools" },
      { source: "report-builder", sourceKind: "tool", reference: "mcp-ghost", mechanism: "server" },
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
      { source: "assistant", sourceKind: "agent", reference: "ghost-tool", mechanism: "tools" },
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

  it("words a dangling server reference differently from a dangling tool reference", () => {
    // "assistant names ghost-tool" and "report-builder is wired to mcp-ghost"
    // are different problems. Flattening them to one verb would lose which kind
    // of declaration to go and fix.
    expect(source).toContain('u.mechanism === "server" ? "is wired to" : "names"');
  });

  it("renders the reach assessment's holes under its evidenced-paths claim", () => {
    // The claim is "every path is evidenced". The qualification is that the
    // graph those paths were traced through was incomplete. It has to sit with
    // the claim, not at the bottom of the panel.
    const claim = source.indexOf("Every path is");
    const caveat = source.indexOf(
      '<UnresolvedReferences rows={data.unresolved} what="this assessment" />',
      claim,
    );
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

  it("keeps one component for both readers rather than two renderings of one fact", () => {
    const occurrences = source.split("<UnresolvedReferences").length - 1;
    expect(occurrences).toBe(3);
    expect(source.split("function UnresolvedReferences").length - 1).toBe(1);
  });
});
