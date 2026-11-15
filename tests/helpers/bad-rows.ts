import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn, signInToBackend } from "../helpers";

/**
 * Every assurance read whose lists go through rowsOf (server/assurance.ts), each
 * with one row of each bad kind beside one good row in every list it maps, and a
 * stand-in backend that serves them: shared by the read test
 * (tests/no-assurance-read-fails-whole-on-one-bad-row-of-any-list.test.ts) and
 * the screens test (tests/a-bad-row-of-any-assurance-list-is-said-on-its-panel.test.tsx),
 * so each screen is handed the answer the real route gives.
 */

export const LEAK = "a-row-that-could-not-be-read";
export const BAD = () => [null, 7, LEAK, [LEAK]];
export const FOUR = BAD().length;
export const NOT_A_LIST = "not a list";
/** One good row, then one row of each kind that cannot be read. */
export const rows = (good: Record<string, unknown>) => [good, ...BAD()];

export const DEP = "dep-rows";
export const FINDING = "fnd-rows";

export interface Case {
  /** The route this dashboard serves. */
  route: string;
  /** The backend path it reads. */
  backend: string;
  /** What the backend answers, with bad rows in every list. */
  served: Record<string, unknown>;
  /** The lists that must each show their one good row and count the rest. */
  lists: string[];
}

const deployment = (read: string) => ({
  route: `/api/assurance/deployments/${DEP}/${read}`,
  backend: `/api/assurance/deployments/${DEP}/${read}/`,
});

export const CASES: Case[] = [
  {
    ...deployment("capabilities"),
    served: {
      capabilities: rows({ key: "k", label: "Can refund", sources: rows({ asset_name: "a" }) }),
      categories: rows({ category: "payments", count: 1 }),
      summary: {},
    },
    lists: ["capabilities", "capabilities.sources", "categories"],
  },
  {
    ...deployment("route-map"),
    served: {
      layers: rows({ key: "app", label: "App", nodes: rows({ uuid: "n-1" }) }),
      nodes: rows({ uuid: "n-1" }),
      edges: rows({ source: "n-1", target: "n-2" }),
      unresolved: rows({ source: "n-1", reference: "tool:refund" }),
      summary: {},
    },
    lists: ["layers", "layers.nodes", "nodes", "edges", "unresolved"],
  },
  {
    ...deployment("ai-bom"),
    served: {
      components: rows({ uuid: "c-1", name: "model" }),
      providers: rows({ uuid: "p-1", name: "provider", declared_facts: rows({ field: "region" }) }),
      summary: {}, deployment: {}, receipt: {},
    },
    lists: ["components", "providers", "providers.declaredFacts"],
  },
  {
    ...deployment("data-boundary"),
    served: { declared: true, flows: rows({ provider_uuid: "p-1" }), shadow_destinations: rows({ asset_name: "a" }), summary: {} },
    lists: ["flows", "shadowDestinations"],
  },
  {
    ...deployment("compliance"),
    served: {
      frameworks: rows({ key: "nist", controls: rows({ control_id: "AC-3" }) }),
      unmapped: rows({ finding_type: "t" }),
      engine_references: rows({ taxonomy: "owasp", id: "A01" }),
      summary: {},
    },
    lists: ["frameworks", "frameworks.controls", "unmapped", "engineReferences"],
  },
  {
    ...deployment("business-impact"),
    served: { dimensions: rows({ key: "revenue" }), unmapped: rows({ finding_type: "t" }), summary: {} },
    lists: ["dimensions", "unmapped"],
  },
  {
    ...deployment("vendor-assurance"),
    served: {
      vendors: rows({ provider_uuid: "p-1", assertions: rows({ field: "region" }), dependent_assets: rows({ asset_name: "a" }) }),
      ungoverned_dependencies: rows({ asset_name: "a" }),
      summary: {},
    },
    lists: ["vendors", "vendors.assertions", "vendors.dependentAssets", "ungovernedDependencies"],
  },
  {
    ...deployment("assurance-packs"),
    served: { packs: rows({ key: "health", name: "Health" }), summary: {} },
    lists: ["packs"],
  },
  {
    ...deployment("assurance-packs/health"),
    served: {
      pack: { key: "health" },
      frameworks: rows({ key: "nist", controls: rows({ control_id: "AC-3" }) }),
      regulatory_regimes: rows({ name: "a regime" }),
      summary: {},
    },
    lists: ["frameworks", "frameworks.controls", "regulatoryRegimes"],
  },
  {
    route: `/api/assurance/findings/${FINDING}/remediation`,
    backend: `/api/assurance/findings/${FINDING}/remediation/`,
    served: { remediation_state: "open", events: rows({ to_state: "open" }) },
    lists: ["events"],
  },
  {
    route: `/api/assurance/findings/${FINDING}/assignable`,
    backend: `/api/assurance/findings/${FINDING}/assignable/`,
    served: { assignable: rows({ username: "alice" }), current: null },
    lists: ["assignable"],
  },
  {
    ...deployment("effective-access"),
    served: {
      principals: rows({
        key: "p-1",
        capabilities: rows({ key: "c", sources: rows({ asset_name: "a" }) }),
        effective_reach: rows({ target: "db" }),
        gaps: rows({ type: "over_broad" }),
      }),
      unresolved: rows({ source: "p-1", reference: "role:admin" }),
      summary: {},
    },
    lists: ["principals", "principals.capabilities", "principals.capabilities.sources", "principals.effectiveReach", "principals.gaps", "unresolved"],
  },
  {
    ...deployment("ripple-effect"),
    served: { origins: rows({ key: "o-1", findings: rows({ uuid: "f-1" }) }), consequences: rows({ origin: "o-1" }), summary: {} },
    lists: ["origins", "origins.findings", "consequences"],
  },
  {
    ...deployment("posture"),
    served: { domains: rows({ name: "cloud" }) },
    lists: ["domains"],
  },
  ...["cloud-posture", "secrets-posture", "repo-posture"].map((read) => ({
    ...deployment(read),
    served: { domain: read, connected: true, checks: rows({ check: "c" }), findings: rows({ check: "c" }), summary: {} },
    lists: ["checks", "findings"],
  })),
  {
    ...deployment("personal-context"),
    served: {
      stores: rows({ asset_name: "s", reachable_by: rows({ principal: "p" }), gaps: rows({ type: "g" }) }),
      gaps: rows({ type: "g" }),
      summary: {},
    },
    lists: ["stores", "stores.reachableBy", "stores.gaps", "gaps"],
  },
  {
    ...deployment("data-lifecycle"),
    served: { stages: rows({ stage: "collect", components: rows({ name: "c" }) }), gaps: rows({ stage: "collect" }), summary: {} },
    lists: ["stages", "stages.components", "gaps"],
  },
  {
    ...deployment("training-reuse"),
    served: {
      providers: rows({ provider_uuid: "p-1", dependent_assets: rows({ asset_name: "a" }), postures: rows({ field: "f" }), gaps: rows({ type: "g" }) }),
      gaps: rows({ type: "g" }),
      summary: {},
    },
    lists: ["providers", "providers.dependentAssets", "providers.postures", "providers.gaps", "gaps"],
  },
  {
    ...deployment("metadata-logging"),
    served: {
      sinks: rows({ asset_name: "s", sensitive_categories: rows({ category: "c" }), gaps: rows({ type: "g" }) }),
      sensitive_categories_handled: rows({ category: "c" }),
      gaps: rows({ type: "g" }),
      summary: {},
    },
    lists: ["sinks", "sinks.sensitiveCategories", "sinks.gaps", "sensitiveCategoriesHandled", "gaps"],
  },
  {
    ...deployment("bom-drift"),
    served: { undeclared: rows({ asset_uuid: "a-1" }), missing: rows({ declared_uuid: "d-1" }), summary: {} },
    lists: ["undeclared", "missing"],
  },
  {
    ...deployment("coverage-manifest"),
    served: {
      checks: { reported: true, not_performed: rows({ check: "c" }), degraded: rows({ check: "c" }), unmeasured: rows({ check: "c" }) },
      never_observed: rows({ name: "n" }),
      declared_but_unassessed: rows({ name: "n" }),
      high_risk_unassessed: rows({ name: "n" }),
      unassessed: rows({ name: "n" }),
    },
    lists: ["checks.notPerformed", "checks.degraded", "checks.unmeasured", "neverObserved", "declaredButUnassessed", "highRiskUnassessed", "unassessed"],
  },
  {
    ...deployment("revalidation-plan"),
    served: {
      required: rows({ claim_uuid: "c-1" }),
      outstanding_unknowns: rows({ claim_uuid: "c-2" }),
      still_current: rows({ claim_uuid: "c-3" }),
      summary: {},
    },
    lists: ["required", "outstandingUnknowns", "stillCurrent"],
  },
  {
    ...deployment("operational-risk"),
    served: { classes: rows({ key: "k", signals: rows({ key: "s" }) }), summary: {}, overall: {}, system: {} },
    lists: ["classes", "classes.signals"],
  },
  {
    route: `/api/assurance/findings/${FINDING}/incident-pack`,
    backend: `/api/assurance/findings/${FINDING}/incident-pack/`,
    served: { ripple: { origins: rows({ key: "o-1", findings: rows({ uuid: "f-1" }) }), consequences: rows({ origin: "o-1" }) } },
    lists: ["ripple.origins", "ripple.origins.findings", "ripple.consequences"],
  },
  {
    ...deployment("connectors"),
    served: { connectors: rows({ name: "jira", configured: true }) },
    lists: ["connectors"],
  },
];

/** The list a key names in an answer: each segment a field, read through the first row of any list on the way. */
export function listAt(body: unknown, key: string): unknown {
  let at: unknown = body;
  for (const part of key.split(".")) {
    if (Array.isArray(at)) at = at[0];
    at = (at as Record<string, unknown> | undefined)?.[part];
  }
  return at;
}

/** A served answer with every bad row taken out: what a clean backend would have said. */
export function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((one) => one !== null && typeof one === "object" && !Array.isArray(one)).map(clean);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
  return value;
}

/** A stand-in backend answering `served` by path, and the dashboard signed in to it. */
export async function standIn(): Promise<{
  serve(answers: Record<string, unknown>): void;
  user: Awaited<ReturnType<typeof signIn>>;
  close(): Promise<void>;
}> {
  let served: Record<string, unknown> = {};
  const http = await import("http");
  const server: Server = http.createServer((req, res) => {
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
  const app: Express = await makeApp();
  const user = await signIn(app);
  await signInToBackend(user);
  return {
    serve(answers) { served = answers; },
    user,
    async close() {
      delete process.env.ATHENA_FAILSAFE_URL;
      delete process.env.ATHENA_FAILSAFE_USER;
      delete process.env.ATHENA_FAILSAFE_PASSWORD;
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
