import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";

import { makeApp, signIn } from "./helpers";

/**
 * The assurance BFF, against a stubbed control plane (Athena-Backend).
 *
 * The dashboard's own server reads the system of record on the browser's
 * behalf: the browser calls same-origin with its cookie, this server reaches
 * the backend with a service token. What matters here is that contract — the
 * routes are behind auth, the service token is obtained and forwarded as a
 * Bearer, the backend's snake_case is mapped to camelCase, filters are passed
 * through, a backend refusal reaches the operator with its reason, and an
 * unconfigured backend answers in words, not a crash.
 */

describe("assurance BFF", () => {
  let app: Express;
  let user: Awaited<ReturnType<typeof signIn>>;
  let server: Server;

  let sawBearer = false;
  let lastUnknownsQuery = "";
  let refusePatch = false;
  // When set, the next PATCH is refused with this status (and a reason), so the
  // BFF's 403/409 passthrough can be exercised without disturbing refusePatch.
  let patchRefusalStatus: number | null = null;
  // When set, the next provider-assertion create is refused with the backend's
  // one-per-field 400, so the BFF's passthrough of that reason can be exercised.
  let refuseAssertionCreate = false;
  const unknowns = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const method = req.method ?? "GET";
        const url = req.url ?? "";
        const path = url.split("?")[0];
        const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
        const json = (code: number, payload: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if ((req.headers.authorization ?? "").startsWith("Bearer ")) sawBearer = true;

        if (path === "/api/token/" && method === "POST") {
          return json(200, { access: "svc-access-token", refresh: "r" });
        }

        if (path === "/api/assurance/deployments/" && method === "GET") {
          return json(200, [
            {
              uuid: "dep-1", name: "acme-chatbot", environment: "production",
              decision: "needs_remediation", decision_label: "Requires remediation",
              description: "", finding_count: 3,
              created_at: "2026-09-16T00:00:00Z", updated_at: "2026-09-16T01:00:00Z",
            },
          ]);
        }

        if (path === "/api/assurance/deployments/dep-1/recompute/" && method === "POST") {
          return json(200, { decision: "ready", decision_label: "Ready" });
        }

        if (path === "/api/assurance/deployments/dep-gone/recompute/" && method === "POST") {
          // A deployment the backend does not know: a real 404, not a 503.
          return json(404, { detail: "No Deployment matches the given query." });
        }

        if (path === "/api/assurance/deployments/dep-1/receipt/" && method === "GET") {
          return json(200, {
            algorithm: "sha256", digest: "e".repeat(64), finding_count: 2,
            computed_at: "2026-09-17T00:00:00Z",
          });
        }

        if (path === "/api/assurance/deployments/dep-1/capabilities/" && method === "GET") {
          return json(200, {
            capabilities: [
              {
                key: "code_execution", label: "Execute code or shell commands",
                category: "execution", description: "A tool declares it can run code.",
                risk: "high", declared: false, shadow: true,
                sources: [
                  {
                    asset_name: "rogue-tool", kind: "tool", kind_label: "Tool",
                    classification: "unmanaged", classification_label: "Unmanaged",
                    managed: false, detail: "permission 'exec'",
                  },
                ],
              },
              {
                key: "model_inference", label: "Generate model output",
                category: "cognition", description: "Produces text from a language model.",
                risk: "baseline", declared: true, shadow: false,
                sources: [
                  {
                    asset_name: "gpt-x", kind: "model", kind_label: "Model",
                    classification: "known", classification_label: "Known",
                    managed: true, detail: "",
                  },
                ],
              },
            ],
            categories: [
              { category: "execution", count: 1, max_risk: "high" },
              { category: "cognition", count: 1, max_risk: "baseline" },
            ],
            summary: { total: 2, high_risk: 1, elevated: 0, baseline: 1, declared: 1, shadow: 1 },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/route-map/" && method === "GET") {
          return json(200, {
            layers: [
              { key: "app", label: "Application", nodes: [
                { uuid: "n-agent", name: "assistant", kind: "agent", kind_label: "Agent",
                  classification: "known", classification_label: "Known", layer: "app",
                  shadow: false, provider_name: null },
              ] },
              { key: "model", label: "Model", nodes: [
                { uuid: "n-model", name: "gpt-x", kind: "model", kind_label: "Model",
                  classification: "known", classification_label: "Known", layer: "model",
                  shadow: false, provider_name: "OpenAI" },
              ] },
              { key: "tools", label: "Tools", nodes: [
                { uuid: "n-tool", name: "rogue", kind: "mcp_server", kind_label: "MCP server",
                  classification: "unmanaged", classification_label: "Unmanaged", layer: "tools",
                  shadow: true, provider_name: null },
              ] },
            ],
            nodes: [
              { uuid: "n-agent", name: "assistant", kind: "agent", kind_label: "Agent",
                classification: "known", classification_label: "Known", layer: "app",
                shadow: false, provider_name: null },
              { uuid: "n-model", name: "gpt-x", kind: "model", kind_label: "Model",
                classification: "known", classification_label: "Known", layer: "model",
                shadow: false, provider_name: "OpenAI" },
              { uuid: "n-tool", name: "rogue", kind: "mcp_server", kind_label: "MCP server",
                classification: "unmanaged", classification_label: "Unmanaged", layer: "tools",
                shadow: true, provider_name: null },
            ],
            edges: [
              { source: "n-agent", target: "n-tool", kind: "invokes", label: "invokes", declared: true },
              { source: "n-agent", target: "n-model", kind: "prompts", label: "prompts", declared: false },
            ],
            unresolved: [{ agent: "assistant", tool_identifier: "ghost-tool" }],
            summary: {
              node_count: 3, edge_count: 2, declared_edges: 1, inferred_edges: 1,
              shadow_nodes: 1, unresolved_edges: 1, layers_present: ["app", "model", "tools"],
              logs_observed: false,
            },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/data-boundary/") {
          // The assessment shape both GET and PUT return. GET before any
          // boundary reads undeclared; a PUT declares one and the flow that was
          // an unknown now violates it, so the two are distinguished by method.
          if (method === "PUT") {
            const b = raw ? JSON.parse(raw) : {};
            return json(200, {
              declared: true,
              policy: {
                allowed_regions: b.allowed_regions ?? [],
                training_allowed: b.training_allowed ?? false,
                third_party_sharing_allowed: b.third_party_sharing_allowed ?? false,
                notes: b.notes ?? "",
                updated_at: "2026-09-17T02:00:00Z",
              },
              flows: [
                {
                  provider_uuid: "p-1", provider_name: "OpenAI", kind: "model_provider",
                  kind_label: "Model provider", assets: ["gpt-x"],
                  region: { value: "us-east-1", evidence_class: "vendor_asserted" },
                  training: null, status: "violation",
                  violations: ["declared region 'us-east-1' is not within the approved boundary ['eu']"],
                  unknowns: [],
                },
              ],
              shadow_destinations: [
                { asset_name: "shadow-mcp", kind: "mcp_server", kind_label: "MCP server", identifier: "mcp://rogue" },
              ],
              summary: { approved: 0, violations: 1, unknowns: 0, shadow_destinations: 1 },
            });
          }
          return json(200, {
            declared: false, policy: null,
            flows: [
              {
                provider_uuid: "p-1", provider_name: "OpenAI", kind: "model_provider",
                kind_label: "Model provider", assets: ["gpt-x"],
                region: { value: "us-east-1", evidence_class: "vendor_asserted" },
                training: null, status: "unknown",
                violations: [], unknowns: ["no data boundary has been approved for this deployment"],
              },
            ],
            shadow_destinations: [],
            summary: { approved: 0, violations: 0, unknowns: 1, shadow_destinations: 0 },
          });
        }

        if (path === "/api/assurance/findings/" && method === "GET") {
          return json(200, [
            {
              uuid: "f-1", deployment_uuid: "dep-1", finding_type: "prompt_injection",
              title: "Prompt injection may be possible", severity: "high", confidence: 0.6,
              status: "open", owner: null, impact: "", business_impact: "", recommendation: "",
              control_mapping: {}, location: "/chat", retest_required: true,
              evidence_class: "partially_verified",
              evidence: [{ classification: "partially_verified", classification_label: "Partially verified", summary: "", source: "engine_scan" }],
              change_status: "recurring", change_label: "Recurring", age_days: 3, stale: false,
              receipt: { algorithm: "sha256", digest: "d".repeat(64), evidence_count: 1, computed_at: "2026-09-17T00:00:00Z" },
              first_seen: "2026-09-16T00:00:00Z", last_seen: "2026-09-16T01:00:00Z",
            },
          ]);
        }

        if (path === "/api/assurance/assets/" && method === "GET") {
          return json(200, [
            {
              uuid: "a-1", deployment_uuid: "dep-1", kind: "model", kind_label: "Model",
              name: "gpt-x", identifier: "openai:gpt-x",
              classification: "known", classification_label: "Known",
              provider: 7, provider_uuid: "p-1", provider_name: "OpenAI", finding_count: 1,
              metadata: { region: "us-east-1" },
              first_seen: "2026-09-16T00:00:00Z", last_seen: "2026-09-16T01:00:00Z",
            },
          ]);
        }

        if (path === "/api/assurance/providers/" && method === "GET") {
          return json(200, [
            {
              uuid: "p-1", name: "OpenAI", kind: "model_provider", kind_label: "Model provider",
              region: "us", notes: "", evidence_class: "vendor_asserted",
              assertions: [
                {
                  uuid: "as-1", field: "region", field_label: "Region", value: "us-east",
                  evidence_class: "vendor_asserted", evidence_class_label: "Vendor asserted",
                  source: "vendor_doc", source_label: "Vendor documentation",
                  notes: "", updated_at: "2026-09-16T00:00:00Z",
                },
                {
                  uuid: "as-2", field: "logging", field_label: "Logging", value: "30 days",
                  evidence_class: "partially_verified", evidence_class_label: "Partially verified",
                  source: "vendor_doc", source_label: "Vendor documentation",
                  notes: "", updated_at: "2026-09-16T00:00:00Z",
                },
              ],
              profile: { declared_fields: 2, weakest_evidence: "vendor_asserted" },
            },
          ]);
        }

        if (path === "/api/assurance/providers/" && method === "POST") {
          const b = raw ? JSON.parse(raw) : {};
          return json(201, {
            uuid: "p-new", name: b.name, kind: b.kind, kind_label: "Vector database",
            region: "", notes: "", evidence_class: "vendor_asserted",
            assertions: [], profile: { declared_fields: 0, weakest_evidence: null },
          });
        }

        if (path === "/api/assurance/provider-assertions/" && method === "POST") {
          if (refuseAssertionCreate) {
            // The backend's one-per-field refusal, verbatim.
            return json(400, { field: "This provider already has a 'region' assertion; edit it instead." });
          }
          const b = raw ? JSON.parse(raw) : {};
          return json(201, {
            uuid: "as-new", field: b.field, field_label: "Data retention", value: b.value ?? "",
            evidence_class: b.evidence_class ?? "vendor_asserted", evidence_class_label: "Vendor asserted",
            source: b.source ?? "self_declared", source_label: "Self-declared",
            notes: b.notes ?? "", updated_at: "2026-09-17T00:00:00Z",
          });
        }

        const assertionMatch = path.match(/^\/api\/assurance\/provider-assertions\/([^/]+)\/$/);
        if (assertionMatch && method === "PATCH") {
          const b = raw ? JSON.parse(raw) : {};
          return json(200, {
            uuid: assertionMatch[1], field: "logging", field_label: "Logging",
            value: b.value ?? "30 days", evidence_class: b.evidence_class ?? "document_supported",
            evidence_class_label: "Document supported", source: b.source ?? "vendor_doc",
            source_label: "Vendor documentation", notes: b.notes ?? "", updated_at: "2026-09-17T01:00:00Z",
          });
        }
        if (assertionMatch && method === "DELETE") {
          res.writeHead(204);
          return res.end();
        }

        if (path === "/api/assurance/unknowns/" && method === "GET") {
          lastUnknownsQuery = query;
          return json(200, [
            {
              uuid: "u-1", deployment_uuid: "dep-1", finding_uuid: "f-1",
              question: "Is 'Prompt injection may be possible' real?",
              why_it_matters: "unverified", evidence_needed: "reproduce it",
              deployment_impact: "high", impact_label: "High",
              status: "open", status_label: "Open", source: "derived",
              owner: null, notes: "", review_by: null,
              first_seen: "2026-09-16T00:00:00Z", last_seen: "2026-09-16T01:00:00Z",
            },
          ]);
        }

        const patchMatch = path.match(/^\/api\/assurance\/unknowns\/([^/]+)\/$/);
        if (patchMatch && method === "PATCH") {
          if (patchRefusalStatus !== null) {
            return json(patchRefusalStatus, { detail: `the backend refused with ${patchRefusalStatus}` });
          }
          if (refusePatch) return json(400, { detail: "status is not a valid choice" });
          const uuid = patchMatch[1];
          const patch = raw ? JSON.parse(raw) : {};
          const merged = {
            uuid, deployment_uuid: "dep-1", finding_uuid: "f-1",
            question: "Is 'Prompt injection may be possible' real?",
            why_it_matters: "unverified", evidence_needed: "reproduce it",
            deployment_impact: patch.deployment_impact ?? "high", impact_label: "High",
            status: patch.status ?? "open", status_label: "Open", source: "derived",
            owner: null, notes: patch.notes ?? "", review_by: patch.review_by ?? null,
            first_seen: "2026-09-16T00:00:00Z", last_seen: "2026-09-16T02:00:00Z",
            ...unknowns.get(uuid),
          };
          unknowns.set(uuid, merged);
          return json(200, merged);
        }

        return json(404, { detail: `no route ${method} ${path}` });
      });
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

  it("refuses assurance reads to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments");
    expect(anon.status).toBe(401);
  });

  it("reports the control plane reachable and the credential accepted", async () => {
    const status = await user.get("/api/assurance/status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ configured: true, reachable: true, authorized: true });
    expect(sawBearer).toBe(true);
  });

  it("lists deployments with the six-state decision, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      uuid: "dep-1", name: "acme-chatbot", decision: "needs_remediation",
      decisionLabel: "Requires remediation", findingCount: 3,
    });
  });

  it("lists findings with the evidence class surfaced", async () => {
    const res = await user.get("/api/assurance/findings?deployment=dep-1");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      uuid: "f-1", severity: "high", evidenceClass: "partially_verified",
      // Change intelligence surfaced (spine).
      changeStatus: "recurring", changeLabel: "Recurring", ageDays: 3, stale: false,
      // Assurance receipt surfaced (spine).
      receipt: { algorithm: "sha256", digest: "d".repeat(64), evidenceCount: 1 },
    });
    expect(res.body[0].evidence[0]).toMatchObject({ classificationLabel: "Partially verified" });
  });

  it("returns a deployment's assurance receipt, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/receipt");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      algorithm: "sha256", digest: "e".repeat(64), findingCount: 2,
      computedAt: "2026-09-17T00:00:00Z",
    });
  });

  it("refuses the deployment receipt to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/receipt");
    expect(anon.status).toBe(401);
  });

  it("returns a deployment's capability map, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/capabilities");
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ total: 2, highRisk: 1, declared: 1, shadow: 1 });
    // Most-concerning capability leads; the shadow high-risk power is honest.
    expect(res.body.capabilities[0]).toMatchObject({
      key: "code_execution", risk: "high", shadow: true, declared: false,
    });
    expect(res.body.capabilities[0].sources[0]).toMatchObject({
      assetName: "rogue-tool", kindLabel: "Tool", managed: false, detail: "permission 'exec'",
    });
    expect(res.body.categories[0]).toMatchObject({ category: "execution", count: 1, maxRisk: "high" });
  });

  it("refuses the capability map to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/capabilities");
    expect(anon.status).toBe(401);
  });

  it("returns a deployment's route map, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/route-map");
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      nodeCount: 3, declaredEdges: 1, inferredEdges: 1, shadowNodes: 1,
      unresolvedEdges: 1, logsObserved: false,
    });
    expect(res.body.summary.layersPresent).toEqual(["app", "model", "tools"]);
    // A declared edge and the inferred spine are distinguished.
    const declared = res.body.edges.find((e: { kind: string }) => e.kind === "invokes");
    expect(declared).toMatchObject({ source: "n-agent", target: "n-tool", declared: true });
    const inferred = res.body.edges.find((e: { kind: string }) => e.kind === "prompts");
    expect(inferred.declared).toBe(false);
    // The shadow node and the dangling reference come through.
    expect(res.body.nodes.find((n: { uuid: string }) => n.uuid === "n-tool").shadow).toBe(true);
    expect(res.body.unresolved[0]).toMatchObject({ agent: "assistant", toolIdentifier: "ghost-tool" });
  });

  it("refuses the route map to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/route-map");
    expect(anon.status).toBe(401);
  });

  it("returns a deployment's data-boundary assessment, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/data-boundary");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      declared: false, policy: null,
      summary: { approved: 0, violations: 0, unknowns: 1, shadowDestinations: 0 },
    });
    // An undeclared boundary never reads as a pass: the flow is an unknown.
    expect(res.body.flows[0]).toMatchObject({
      providerName: "OpenAI", kindLabel: "Model provider", status: "unknown",
    });
    expect(res.body.flows[0].region).toMatchObject({ value: "us-east-1", evidenceClass: "vendor_asserted" });
  });

  it("refuses the data-boundary read to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/data-boundary");
    expect(anon.status).toBe(401);
  });

  it("declares a data boundary (admin PUT) and returns the recomputed assessment", async () => {
    const res = await user
      .put("/api/assurance/deployments/dep-1/data-boundary")
      .send({ allowedRegions: ["eu"], trainingAllowed: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      declared: true,
      policy: { allowedRegions: ["eu"], trainingAllowed: false },
      summary: { violations: 1, shadowDestinations: 1 },
    });
    // The us-east-1 flow now violates the eu-only boundary.
    expect(res.body.flows[0]).toMatchObject({ status: "violation" });
    expect(res.body.shadowDestinations[0]).toMatchObject({ assetName: "shadow-mcp", kindLabel: "MCP server" });
  });

  it("gates declaring a data boundary to admins: a non-admin gets 403", async () => {
    await user.post("/api/users").send({
      username: "boundary-analyst", password: "analyst-pass", role: "user", isActive: true,
    });
    const analyst = await signIn(app, "boundary-analyst", "analyst-pass");
    // The read stays open.
    expect((await analyst.get("/api/assurance/deployments/dep-1/data-boundary")).status).toBe(200);
    // The write is admin-only, refused at the front door.
    const denied = await analyst
      .put("/api/assurance/deployments/dep-1/data-boundary")
      .send({ allowedRegions: ["eu"] });
    expect(denied.status).toBe(403);
  });

  it("refuses the assets read to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/assets");
    expect(anon.status).toBe(401);
  });

  it("lists assets, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/assets");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      uuid: "a-1", deploymentUuid: "dep-1", kind: "model", kindLabel: "Model",
      name: "gpt-x", classification: "known", classificationLabel: "Known",
      // provider_uuid is the join key the assurance graph uses to link an asset
      // to its provider's profile; provider_name rides along for the label.
      providerUuid: "p-1", providerName: "OpenAI", findingCount: 1,
    });
  });

  it("refuses the providers read to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/providers");
    expect(anon.status).toBe(401);
  });

  it("lists providers with the declared assurance profile, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/providers");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      uuid: "p-1", name: "OpenAI", kind: "model_provider", kindLabel: "Model provider",
    });
    expect(res.body[0].profile).toMatchObject({ declaredFields: 2, weakestEvidence: "vendor_asserted" });
    expect(res.body[0].assertions).toHaveLength(2);
    expect(res.body[0].assertions[0]).toMatchObject({
      field: "region", fieldLabel: "Region", evidenceClass: "vendor_asserted",
    });
  });

  it("lists unknowns and forwards the status/impact/deployment filters", async () => {
    const res = await user.get("/api/assurance/unknowns?status=open&impact=high&deployment=dep-1");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      uuid: "u-1", deploymentImpact: "high", status: "open", source: "derived",
    });
    expect(lastUnknownsQuery).toContain("status=open");
    expect(lastUnknownsQuery).toContain("impact=high");
    expect(lastUnknownsQuery).toContain("deployment=dep-1");
  });

  it("recomputes a deployment's decision", async () => {
    const res = await user.post("/api/assurance/deployments/dep-1/recompute").send({ paused: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ decision: "ready", decisionLabel: "Ready" });
  });

  it("patches an unknown's disposition and maps camelCase to the backend", async () => {
    const res = await user.patch("/api/assurance/unknowns/u-1").send({
      status: "investigating", deploymentImpact: "medium", notes: "chasing vendor",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "investigating", deploymentImpact: "medium", notes: "chasing vendor" });
  });

  it("rejects a disposition the schema will not accept", async () => {
    const bad = await user.patch("/api/assurance/unknowns/u-1").send({ status: "bogus" });
    expect(bad.status).toBe(400);
  });

  it("passes a backend refusal through with its reason", async () => {
    refusePatch = true;
    const denied = await user.patch("/api/assurance/unknowns/u-1").send({ status: "resolved" });
    expect(denied.status).toBe(400);
    expect(String(denied.body.error)).toContain("valid choice");
    refusePatch = false;
  });

  it("surfaces a backend 404 on recompute as 404 (not 503) with the reason", async () => {
    const res = await user.post("/api/assurance/deployments/dep-gone/recompute").send({ paused: false });
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toMatch(/no deployment/i);
  });

  it("passes a backend 403 on a disposition through as 403 (not 503)", async () => {
    patchRefusalStatus = 403;
    const denied = await user.patch("/api/assurance/unknowns/u-1").send({ status: "resolved" });
    expect(denied.status).toBe(403);
    expect(String(denied.body.error)).toContain("403");
    patchRefusalStatus = null;
  });

  it("passes a backend 409 on a disposition through as 409 (not 503)", async () => {
    patchRefusalStatus = 409;
    const denied = await user.patch("/api/assurance/unknowns/u-1").send({ status: "resolved" });
    expect(denied.status).toBe(409);
    expect(String(denied.body.error)).toContain("409");
    patchRefusalStatus = null;
  });

  it("gates the two writes to admins: a non-admin gets 403, an admin succeeds", async () => {
    // Created via the admin, like the failsafe test, then signed in.
    await user.post("/api/users").send({
      username: "assurance-analyst", password: "analyst-pass", role: "user", isActive: true,
    });
    const analyst = await signIn(app, "assurance-analyst", "analyst-pass");

    // Reads stay open to any signed-in operator.
    const read = await analyst.get("/api/assurance/deployments");
    expect(read.status).toBe(200);

    // Writes are admin-only: a clean 403 at the front door.
    const deniedRecompute = await analyst
      .post("/api/assurance/deployments/dep-1/recompute")
      .send({ paused: false });
    expect(deniedRecompute.status).toBe(403);
    const deniedPatch = await analyst
      .patch("/api/assurance/unknowns/u-1")
      .send({ status: "investigating" });
    expect(deniedPatch.status).toBe(403);

    // The admin still succeeds on both.
    const okRecompute = await user
      .post("/api/assurance/deployments/dep-1/recompute")
      .send({ paused: false });
    expect(okRecompute.status).toBe(200);
    const okPatch = await user.patch("/api/assurance/unknowns/u-1").send({ status: "investigating" });
    expect(okPatch.status).toBe(200);
  });

  it("refuses provider-profile writes to anyone not signed in", async () => {
    expect((await request(app).post("/api/assurance/providers").send({ name: "X", kind: "other" })).status).toBe(401);
    expect(
      (await request(app).post("/api/assurance/provider-assertions").send({ provider: "p-1", field: "region" })).status,
    ).toBe(401);
    expect((await request(app).delete("/api/assurance/provider-assertions/as-1")).status).toBe(401);
  });

  it("an admin registers a provider, mapped to camelCase", async () => {
    const res = await user
      .post("/api/assurance/providers")
      .send({ name: "Pinecone", kind: "vector_db" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ uuid: "p-new", name: "Pinecone", kind: "vector_db", kindLabel: "Vector database" });
    expect(res.body.profile).toMatchObject({ declaredFields: 0, weakestEvidence: null });
  });

  it("an admin records a graded assertion, mapping the evidence class both ways", async () => {
    const res = await user.post("/api/assurance/provider-assertions").send({
      provider: "p-1", field: "data_retention", value: "30 days",
      evidenceClass: "document_supported", source: "vendor_doc",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      uuid: "as-new", field: "data_retention", value: "30 days",
      evidenceClass: "document_supported", source: "vendor_doc",
    });
  });

  it("rejects an assertion field the schema will not accept", async () => {
    const bad = await user
      .post("/api/assurance/provider-assertions")
      .send({ provider: "p-1", field: "not_a_field", value: "x" });
    expect(bad.status).toBe(400);
  });

  it("passes the backend's one-per-field refusal through with its reason", async () => {
    refuseAssertionCreate = true;
    const denied = await user
      .post("/api/assurance/provider-assertions")
      .send({ provider: "p-1", field: "region", value: "eu-west-1" });
    expect(denied.status).toBe(400);
    expect(String(denied.body.error)).toContain("already has a 'region' assertion");
    refuseAssertionCreate = false;
  });

  it("an admin edits an assertion in place and deletes one", async () => {
    const patched = await user
      .patch("/api/assurance/provider-assertions/as-2")
      .send({ value: "90 days", evidenceClass: "contractually_stated", source: "contract" });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ uuid: "as-2", value: "90 days" });

    const removed = await user.delete("/api/assurance/provider-assertions/as-2");
    expect(removed.status).toBe(204);
  });

  it("gates provider-profile writes to admins: a non-admin gets 403", async () => {
    await user.post("/api/users").send({
      username: "assurance-analyst-2", password: "analyst-pass", role: "user", isActive: true,
    });
    const analyst = await signIn(app, "assurance-analyst-2", "analyst-pass");

    // Reads stay open.
    expect((await analyst.get("/api/assurance/providers")).status).toBe(200);

    // Every write is admin-only, refused at the front door.
    expect((await analyst.post("/api/assurance/providers").send({ name: "X", kind: "other" })).status).toBe(403);
    expect(
      (await analyst.post("/api/assurance/provider-assertions").send({ provider: "p-1", field: "region", value: "x" }))
        .status,
    ).toBe(403);
    expect(
      (await analyst.patch("/api/assurance/provider-assertions/as-2").send({ value: "y" })).status,
    ).toBe(403);
    expect((await analyst.delete("/api/assurance/provider-assertions/as-2")).status).toBe(403);
  });
});

describe("assurance BFF without a control plane", () => {
  let app: Express;
  let user: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    vi.resetModules();
    app = await makeApp();
    user = await signIn(app);
  });

  it("says so in words on status rather than failing", async () => {
    const status = await user.get("/api/assurance/status");
    expect(status.status).toBe(200);
    expect(status.body.configured).toBe(false);
    expect(String(status.body.detail)).toMatch(/no athena control plane/i);
  });

  it("answers 503 on a read when nothing is configured", async () => {
    const res = await user.get("/api/assurance/deployments");
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toMatch(/no athena control plane/i);
  });
});

describe("assurance BFF against a paginated control plane", () => {
  // DRF PageNumberPagination (PAGE_SIZE=50) answers `{count, next, previous,
  // results}`, so a list past the first page must be followed via `next` and
  // concatenated -- otherwise everything past page 1 is silently dropped.
  let app: Express;
  let user: Awaited<ReturnType<typeof signIn>>;
  let server: Server;

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const method = req.method ?? "GET";
        const url = req.url ?? "";
        const path = url.split("?")[0];
        const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
        const json = (code: number, payload: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };

        if (path === "/api/token/" && method === "POST") {
          return json(200, { access: "svc-access-token", refresh: "r" });
        }

        if (path === "/api/assurance/deployments/" && method === "GET") {
          const page = new URLSearchParams(query).get("page");
          const row = (uuid: string, name: string) => ({
            uuid, name, environment: "production",
            decision: "ready", decision_label: "Ready",
            description: "", finding_count: 0,
            created_at: "2026-09-16T00:00:00Z", updated_at: "2026-09-16T01:00:00Z",
          });
          if (page === "2") {
            return json(200, { count: 2, next: null, previous: `http://${req.headers.host}/api/assurance/deployments/`, results: [row("dep-b", "second")] });
          }
          // The `next` link is an absolute URL on the backend's own origin, as
          // DRF emits it; the BFF must reduce it to path+query to follow.
          return json(200, { count: 2, next: `http://${req.headers.host}/api/assurance/deployments/?page=2`, previous: null, results: [row("dep-a", "first")] });
        }

        if (path === "/api/assurance/assets/" && method === "GET") {
          const page = new URLSearchParams(query).get("page");
          const row = (uuid: string, name: string) => ({
            uuid, deployment_uuid: "dep-1", kind: "model", kind_label: "Model",
            name, identifier: `id-${uuid}`,
            classification: "approved", classification_label: "Approved",
            provider: null, provider_name: null, finding_count: 0, metadata: {},
            first_seen: "2026-09-16T00:00:00Z", last_seen: "2026-09-16T01:00:00Z",
          });
          if (page === "2") {
            return json(200, { count: 2, next: null, previous: `http://${req.headers.host}/api/assurance/assets/`, results: [row("asset-b", "second")] });
          }
          return json(200, { count: 2, next: `http://${req.headers.host}/api/assurance/assets/?page=2`, previous: null, results: [row("asset-a", "first")] });
        }

        if (path === "/api/assurance/providers/" && method === "GET") {
          const page = new URLSearchParams(query).get("page");
          const row = (uuid: string, name: string) => ({
            uuid, name, kind: "model_provider", kind_label: "Model provider",
            region: "us", notes: "", evidence_class: "vendor_asserted",
            assertions: [], profile: { declared_fields: 0, weakest_evidence: null },
          });
          if (page === "2") {
            return json(200, { count: 2, next: null, previous: `http://${req.headers.host}/api/assurance/providers/`, results: [row("prov-b", "second")] });
          }
          return json(200, { count: 2, next: `http://${req.headers.host}/api/assurance/providers/?page=2`, previous: null, results: [row("prov-a", "first")] });
        }

        return json(404, { detail: `no route ${method} ${path}` });
      });
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

  it("follows the DRF `next` link and returns every page's rows", async () => {
    const res = await user.get("/api/assurance/deployments");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((d: { uuid: string }) => d.uuid)).toEqual(["dep-a", "dep-b"]);
  });

  it("follows the DRF `next` link across asset pages and returns every row", async () => {
    const res = await user.get("/api/assurance/assets");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((a: { uuid: string }) => a.uuid)).toEqual(["asset-a", "asset-b"]);
  });

  it("follows the DRF `next` link across provider pages and returns every row", async () => {
    const res = await user.get("/api/assurance/providers");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((p: { uuid: string }) => p.uuid)).toEqual(["prov-a", "prov-b"]);
  });
});
