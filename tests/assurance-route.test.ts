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
  // When set, the next remediation transition is refused with the backend's
  // illegal-transition 400, so the BFF's passthrough of that reason is exercised.
  let refuseTransition = false;
  // When set, the next remediation assign is refused with the backend's
  // unknown-user 400.
  let refuseAssign = false;
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

        if (path === "/api/assurance/deployments/dep-1/assurance-receipt/" && method === "GET") {
          // The full, versioned receipt: honest by construction — a
          // needs-more-evidence result carried at its true strength, an
          // undeclared policy as declared:false and nothing invented, and the
          // digests/version kept verbatim.
          return json(200, {
            receipt_version: "mythos.assurance.receipt/1.0",
            system: {
              name: "acme-chatbot", uuid: "dep-1",
              environment: "production", environment_label: "Production",
            },
            result: { decision: "needs_more_evidence", decision_label: "Needs more evidence" },
            policy: { declared: false },
            evidence: { algorithm: "sha256", root: "b".repeat(64), finding_count: 3 },
            assessments: {
              compliance: "c".repeat(64), capabilities: "d".repeat(64),
              boundary: "e".repeat(64), bom: "f".repeat(64),
            },
            algorithm: "sha256",
            digest: "a".repeat(64),
            computed_at: "2026-09-17T00:00:00Z",
          });
        }

        if (path === "/api/assurance/deployments/dep-2/assurance-receipt/" && method === "GET") {
          // A second deployment with a declared boundary, so the declared branch
          // of the policy mapper is exercised too.
          return json(200, {
            receipt_version: "mythos.assurance.receipt/1.0",
            system: {
              name: "eu-assistant", uuid: "dep-2",
              environment: "staging", environment_label: "Staging",
            },
            result: { decision: "ready", decision_label: "Ready" },
            policy: {
              declared: true, allowed_regions: ["eu"],
              training_allowed: false, third_party_sharing_allowed: true,
            },
            evidence: { algorithm: "sha256", root: "1".repeat(64), finding_count: 0 },
            assessments: {
              compliance: "2".repeat(64), capabilities: "3".repeat(64),
              boundary: "4".repeat(64), bom: "5".repeat(64),
            },
            algorithm: "sha256",
            digest: "9".repeat(64),
            computed_at: "2026-09-17T02:00:00Z",
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

        if (path === "/api/assurance/deployments/dep-1/ai-bom/" && method === "GET") {
          return json(200, {
            format: "athena-ai-bom", version: "1.0",
            deployment: { uuid: "dep-1", name: "acme-chatbot" },
            components: [
              {
                uuid: "c-1", name: "gpt-x", kind: "model", kind_label: "Model",
                identifier: "openai:gpt-x", classification: "known", classification_label: "Known",
                shadow: false, provider_uuid: "p-1", provider_name: "OpenAI",
                facts: { model: "gpt-x", version: "2026-01" },
                first_seen: "2026-09-16T00:00:00Z", last_seen: "2026-09-16T01:00:00Z",
              },
              {
                uuid: "c-2", name: "rogue-mcp", kind: "mcp_server", kind_label: "MCP server",
                identifier: "mcp://rogue", classification: "unmanaged", classification_label: "Unmanaged",
                shadow: true, provider_uuid: null, provider_name: null, facts: {},
                first_seen: "2026-09-16T00:00:00Z", last_seen: "2026-09-16T01:00:00Z",
              },
            ],
            providers: [
              {
                uuid: "p-1", name: "OpenAI", kind: "model_provider", kind_label: "Model provider",
                region: "us-east-1",
                declared_facts: [
                  {
                    field: "data_retention", field_label: "Data retention", value: "30 days",
                    evidence_class: "vendor_asserted", evidence_class_label: "Vendor asserted",
                    source: "vendor_doc", source_label: "Vendor documentation",
                  },
                ],
                declared_field_count: 1, weakest_evidence: "vendor_asserted",
              },
            ],
            summary: {
              component_count: 2, provider_count: 1, shadow_components: 1,
              components_by_kind: { model: 1, mcp_server: 1 },
              components_by_classification: { known: 1, unmanaged: 1 },
              declared_fact_count: 1, weakest_evidence: "vendor_asserted",
            },
            receipt: { algorithm: "sha256", digest: "a".repeat(64) },
            generated_at: "2026-09-17T00:00:00Z",
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

        if (path === "/api/assurance/deployments/dep-1/compliance/" && method === "GET") {
          // An honest gap map: a framework with a touched control, a framework
          // with nothing mapped (never "passing"), the unmapped types the engine
          // found, and the raw engine taxonomy references.
          return json(200, {
            frameworks: [
              {
                key: "nist_800_53", name: "NIST SP 800-53 Rev 5",
                controls: [
                  {
                    control_id: "SI-10", name: "Information Input Validation",
                    family: "SI", family_name: "System and Information Integrity",
                    catalogued: true, active_finding_count: 2, resolved_finding_count: 1,
                    worst_severity: "high", finding_types: ["sql_injection", "xss"],
                  },
                ],
                summary: { controls_touched: 1, controls_with_active_findings: 1, worst_severity: "high" },
              },
              {
                key: "owasp_2021", name: "OWASP Top 10 (2021)",
                controls: [],
                summary: { controls_touched: 0, controls_with_active_findings: 0, worst_severity: null },
              },
            ],
            unmapped: [
              {
                finding_type: "quantum_teapot_anomaly", active_finding_count: 1,
                resolved_finding_count: 0, worst_severity: "medium",
              },
            ],
            engine_references: [
              { taxonomy: "cwe", id: "CWE-89", finding_count: 2, finding_types: ["sql_injection"] },
            ],
            summary: {
              total_findings: 7, active_findings: 5, resolved_findings: 2,
              mapped_finding_types: 4, unmapped_finding_types: 1, frameworks: 4,
              controls_touched: 11, controls_with_active_findings: 9, worst_severity: "critical",
            },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/business-impact/" && method === "GET") {
          // An honest exposure map: dimensions strongest-first, a dimension with
          // active exposure, a dimension with only resolved findings (no active
          // exposure — worst_severity and exposure_band both null), the unmapped
          // types the engine found, and the ordinal summary bands.
          return json(200, {
            dimensions: [
              {
                key: "data_confidentiality", label: "Data confidentiality",
                description: "Sensitive data could be read by someone who should not.",
                active_finding_count: 2, resolved_finding_count: 1,
                worst_severity: "high", exposure_band: "elevated",
                finding_types: ["sql_injection", "xss"],
              },
              {
                key: "service_availability", label: "Service availability",
                description: "The deployment could be knocked offline.",
                active_finding_count: 0, resolved_finding_count: 2,
                worst_severity: null, exposure_band: null,
                finding_types: ["denial_of_service"],
              },
            ],
            unmapped: [
              {
                finding_type: "quantum_teapot_anomaly", active_finding_count: 1,
                resolved_finding_count: 0, worst_severity: "medium",
              },
            ],
            summary: {
              total_findings: 7, active_findings: 5, resolved_findings: 2,
              mapped_finding_types: 4, unmapped_finding_types: 1, dimensions: 6,
              dimensions_touched: 3, dimensions_with_active_exposure: 3,
              worst_severity: "critical", worst_exposure_band: "elevated",
            },
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
              // Remediation workflow (Phase 2.3): read-only on the finding.
              assignee: "alice", remediation_state: "triaged",
            },
          ]);
        }

        const remediationMatch = path.match(/^\/api\/assurance\/findings\/([^/]+)\/remediation\/$/);
        if (remediationMatch && method === "GET") {
          return json(200, {
            state: "triaged", state_label: "Triaged", assignee: "alice",
            events: [
              {
                from_state: null, to_state: "new", actor: null,
                note: "", created_at: "2026-09-16T00:00:00Z",
              },
              {
                from_state: "new", to_state: "triaged", actor: "admin",
                note: "looks real", created_at: "2026-09-16T02:00:00Z",
              },
            ],
          });
        }

        const transitionMatch = path.match(
          /^\/api\/assurance\/findings\/([^/]+)\/remediation\/transition\/$/,
        );
        if (transitionMatch && method === "POST") {
          if (refuseTransition) {
            // The backend's illegal-transition refusal, verbatim.
            return json(400, { detail: "cannot move from 'triaged' to 'resolved'" });
          }
          const b = raw ? JSON.parse(raw) : {};
          return json(200, {
            state: b.to_state, state_label: String(b.to_state), assignee: "alice",
            events: [
              {
                from_state: "triaged", to_state: b.to_state, actor: "admin",
                note: b.note ?? "", created_at: "2026-09-17T03:00:00Z",
              },
            ],
          });
        }

        const assignMatch = path.match(
          /^\/api\/assurance\/findings\/([^/]+)\/remediation\/assign\/$/,
        );
        if (assignMatch && method === "POST") {
          if (refuseAssign) {
            // The backend's unknown-user refusal, verbatim.
            return json(400, { detail: "no user named 'ghost'" });
          }
          const b = raw ? JSON.parse(raw) : {};
          return json(200, {
            state: "triaged", state_label: "Triaged",
            assignee: b.assignee ?? null,
            events: [
              {
                from_state: "triaged", to_state: "triaged", actor: "admin",
                note: b.note ?? "", created_at: "2026-09-17T04:00:00Z",
              },
            ],
          });
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
      // Remediation workflow surfaced, read-only on the finding (Phase 2.3).
      assignee: "alice", remediationState: "triaged",
    });
    expect(res.body[0].evidence[0]).toMatchObject({ classificationLabel: "Partially verified" });
  });

  it("returns a finding's remediation workflow, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/findings/f-1/remediation");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "triaged", stateLabel: "Triaged", assignee: "alice" });
    // The audit trail of moves is surfaced, camelCased.
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[1]).toMatchObject({
      fromState: "new", toState: "triaged", actor: "admin", note: "looks real",
      createdAt: "2026-09-16T02:00:00Z",
    });
  });

  it("refuses the remediation read to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/findings/f-1/remediation");
    expect(anon.status).toBe(401);
  });

  it("an admin moves a finding's remediation state (a legal transition)", async () => {
    const res = await user
      .post("/api/assurance/findings/f-1/remediation/transition")
      .send({ toState: "in_progress" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "in_progress", assignee: "alice" });
  });

  it("rejects a remediation state the schema will not accept", async () => {
    const bad = await user
      .post("/api/assurance/findings/f-1/remediation/transition")
      .send({ toState: "bogus" });
    expect(bad.status).toBe(400);
  });

  it("passes the backend's illegal-transition 400 through with its reason", async () => {
    refuseTransition = true;
    const denied = await user
      .post("/api/assurance/findings/f-1/remediation/transition")
      .send({ toState: "resolved" });
    expect(denied.status).toBe(400);
    expect(String(denied.body.error)).toContain("cannot move from");
    refuseTransition = false;
  });

  it("an admin assigns a finding's remediation, and can clear it with null", async () => {
    const assigned = await user
      .post("/api/assurance/findings/f-1/remediation/assign")
      .send({ assignee: "bob" });
    expect(assigned.status).toBe(200);
    expect(assigned.body).toMatchObject({ assignee: "bob" });

    const cleared = await user
      .post("/api/assurance/findings/f-1/remediation/assign")
      .send({ assignee: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.assignee).toBeNull();
  });

  it("passes the backend's unknown-user 400 through with its reason", async () => {
    refuseAssign = true;
    const denied = await user
      .post("/api/assurance/findings/f-1/remediation/assign")
      .send({ assignee: "ghost" });
    expect(denied.status).toBe(400);
    expect(String(denied.body.error)).toContain("no user named");
    refuseAssign = false;
  });

  it("gates the remediation writes to admins: a non-admin gets 403, the read stays open", async () => {
    await user.post("/api/users").send({
      username: "remediation-analyst", password: "analyst-pass", role: "user", isActive: true,
    });
    const analyst = await signIn(app, "remediation-analyst", "analyst-pass");

    // The read stays open to any signed-in operator.
    expect((await analyst.get("/api/assurance/findings/f-1/remediation")).status).toBe(200);

    // Both writes are admin-only, refused at the front door.
    const deniedTransition = await analyst
      .post("/api/assurance/findings/f-1/remediation/transition")
      .send({ toState: "in_progress" });
    expect(deniedTransition.status).toBe(403);
    const deniedAssign = await analyst
      .post("/api/assurance/findings/f-1/remediation/assign")
      .send({ assignee: "bob" });
    expect(deniedAssign.status).toBe(403);
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

  it("returns a deployment's full assurance receipt, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/assurance-receipt");
    expect(res.status).toBe(200);
    // The version and top-level digest are kept verbatim (the signable content).
    expect(res.body).toMatchObject({
      receiptVersion: "mythos.assurance.receipt/1.0",
      algorithm: "sha256", digest: "a".repeat(64),
      computedAt: "2026-09-17T00:00:00Z",
    });
    // The system identity, camelCased.
    expect(res.body.system).toMatchObject({
      name: "acme-chatbot", uuid: "dep-1", environment: "production", environmentLabel: "Production",
    });
    // The six-state result is carried faithfully at its true strength.
    expect(res.body.result).toMatchObject({
      decision: "needs_more_evidence", decisionLabel: "Needs more evidence",
    });
    // An undeclared policy reads as declared:false and nothing invented.
    expect(res.body.policy).toEqual({ declared: false });
    // The evidence root, its finding count, and the algorithm come through.
    expect(res.body.evidence).toMatchObject({
      algorithm: "sha256", root: "b".repeat(64), findingCount: 3,
    });
    // The four per-assessment digests are kept verbatim.
    expect(res.body.assessments).toMatchObject({
      compliance: "c".repeat(64), capabilities: "d".repeat(64),
      boundary: "e".repeat(64), bom: "f".repeat(64),
    });
  });

  it("carries a declared data boundary through the receipt policy, camelCased", async () => {
    const res = await user.get("/api/assurance/deployments/dep-2/assurance-receipt");
    expect(res.status).toBe(200);
    expect(res.body.policy).toEqual({
      declared: true, allowedRegions: ["eu"],
      trainingAllowed: false, thirdPartySharingAllowed: true,
    });
    expect(res.body.result).toMatchObject({ decision: "ready", decisionLabel: "Ready" });
  });

  it("refuses the assurance receipt to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/assurance-receipt");
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

  it("returns a deployment's AI-BOM, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/ai-bom");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ format: "athena-ai-bom", version: "1.0" });
    expect(res.body.summary).toMatchObject({
      componentCount: 2, providerCount: 1, shadowComponents: 1,
      declaredFactCount: 1, weakestEvidence: "vendor_asserted",
    });
    expect(res.body.summary.componentsByKind).toMatchObject({ model: 1, mcp_server: 1 });
    // A component's facts and the shadow flag come through.
    const shadow = res.body.components.find((c: { uuid: string }) => c.uuid === "c-2");
    expect(shadow.shadow).toBe(true);
    // The supply chain carries evidence-graded facts.
    expect(res.body.providers[0].declaredFacts[0]).toMatchObject({
      field: "data_retention", evidenceClass: "vendor_asserted",
    });
    // The tamper-evident digest is surfaced.
    expect(res.body.receipt).toMatchObject({ algorithm: "sha256", digest: "a".repeat(64) });
  });

  it("refuses the AI-BOM to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/ai-bom");
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

  it("returns a deployment's compliance map, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/compliance");
    expect(res.status).toBe(200);
    // The scoreboard counts findings and controls honestly, camelCased.
    expect(res.body.summary).toMatchObject({
      totalFindings: 7, activeFindings: 5, resolvedFindings: 2,
      mappedFindingTypes: 4, unmappedFindingTypes: 1,
      controlsTouched: 11, controlsWithActiveFindings: 9, worstSeverity: "critical",
    });
    // A framework's touched control carries its gap signal, camelCased — the
    // active-finding count and worst severity, never a "met"/"passed" flag.
    const nist = res.body.frameworks.find((f: { key: string }) => f.key === "nist_800_53");
    expect(nist).toMatchObject({ name: "NIST SP 800-53 Rev 5" });
    expect(nist.summary).toMatchObject({
      controlsTouched: 1, controlsWithActiveFindings: 1, worstSeverity: "high",
    });
    expect(nist.controls[0]).toMatchObject({
      controlId: "SI-10", name: "Information Input Validation",
      family: "SI", familyName: "System and Information Integrity",
      catalogued: true, activeFindingCount: 2, resolvedFindingCount: 1, worstSeverity: "high",
    });
    expect(nist.controls[0].findingTypes).toEqual(["sql_injection", "xss"]);
    // A framework with nothing mapped reads as untouched, never "passing".
    const owasp = res.body.frameworks.find((f: { key: string }) => f.key === "owasp_2021");
    expect(owasp.controls).toHaveLength(0);
    expect(owasp.summary).toMatchObject({ controlsTouched: 0, worstSeverity: null });
    // The unmapped finding types the engine found are surfaced, not hidden.
    expect(res.body.unmapped[0]).toMatchObject({
      findingType: "quantum_teapot_anomaly", activeFindingCount: 1, worstSeverity: "medium",
    });
    // The raw engine taxonomy references (CWE/OWASP by id) come through.
    expect(res.body.engineReferences[0]).toMatchObject({
      taxonomy: "cwe", id: "CWE-89", findingCount: 2,
    });
    expect(res.body.engineReferences[0].findingTypes).toEqual(["sql_injection"]);
  });

  it("refuses the compliance map to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/compliance");
    expect(anon.status).toBe(401);
  });

  it("returns a deployment's business-impact map, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/business-impact");
    expect(res.status).toBe(200);
    // The scoreboard counts findings and dimensions honestly, camelCased — an
    // ordinal worst band, never a quantity or a dollar figure.
    expect(res.body.summary).toMatchObject({
      totalFindings: 7, activeFindings: 5, resolvedFindings: 2,
      mappedFindingTypes: 4, unmappedFindingTypes: 1, dimensions: 6,
      dimensionsTouched: 3, dimensionsWithActiveExposure: 3,
      worstSeverity: "critical", worstExposureBand: "elevated",
    });
    // A dimension implicated by active findings carries its ordinal exposure
    // band and worst severity, camelCased — never a "safe"/"passed" flag.
    const conf = res.body.dimensions.find((d: { key: string }) => d.key === "data_confidentiality");
    expect(conf).toMatchObject({
      label: "Data confidentiality", activeFindingCount: 2, resolvedFindingCount: 1,
      worstSeverity: "high", exposureBand: "elevated",
    });
    expect(conf.findingTypes).toEqual(["sql_injection", "xss"]);
    // A dimension with no active findings reads as no active exposure, never
    // "safe": its worst severity and exposure band are both null.
    const avail = res.body.dimensions.find((d: { key: string }) => d.key === "service_availability");
    expect(avail).toMatchObject({
      activeFindingCount: 0, resolvedFindingCount: 2,
      worstSeverity: null, exposureBand: null,
    });
    // The unmapped finding types the engine found are surfaced, not hidden.
    expect(res.body.unmapped[0]).toMatchObject({
      findingType: "quantum_teapot_anomaly", activeFindingCount: 1, worstSeverity: "medium",
    });
  });

  it("refuses the business-impact map to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/business-impact");
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
