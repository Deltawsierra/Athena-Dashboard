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
  // When set, the next assignable-users read is refused with a backend 404, so
  // the BFF's passthrough of that reason can be exercised.
  let refuseAssignable = false;
  // What the BFF forwarded on the last recompute, verbatim.
  let lastRecomputeBody: string | null = null;
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
          lastRecomputeBody = raw;
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
            // The backend's own self-report, outside the digest: this copy is
            // unsigned, and why. dep-1 is the older shape that says nothing.
            signed: false,
            signature: null,
            unsigned_reason: "THIS COPY is unsigned. This backend holds no signing key.",
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
            unresolved: [{
              source: "assistant", source_kind: "agent",
              reference: "ghost-tool", mechanism: "tools",
            }],
            summary: {
              node_count: 3, edge_count: 2, declared_edges: 1, inferred_edges: 1,
              shadow_nodes: 1, unresolved_edges: 1,
              unresolved_tool_references: 1, unresolved_server_references: 0,
              layers_present: ["app", "model", "tools"],
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

        if (path === "/api/assurance/deployments/dep-1/vendor-assurance/" && method === "GET") {
          // Honest by construction: a vendor with one independently-evidenced fact
          // and one vendor-asserted / self-attested fact (a gap, shown at true
          // strength, never promoted), plus an ungoverned (shadow) dependency.
          return json(200, {
            vendors: [
              {
                provider_uuid: "p-1", provider_name: "OpenAI",
                kind: "model_provider", kind_label: "Model provider", region: "us-east-1",
                assertions: [
                  {
                    field: "logging", field_label: "Logging", value: "30 days",
                    evidence_class: "partially_verified", evidence_class_label: "Partially verified",
                    source: "measured", source_label: "Independently measured",
                    independently_evidenced: true, gap: false,
                  },
                  {
                    field: "trains_on_data", field_label: "Trains on customer data",
                    value: "No — zero-retention endpoint",
                    evidence_class: "vendor_asserted", evidence_class_label: "Vendor asserted",
                    source: "self_declared", source_label: "Self-declared",
                    independently_evidenced: false, gap: true,
                  },
                ],
                dependent_assets: [
                  {
                    asset_name: "gpt-x", kind: "model", kind_label: "Model",
                    classification: "known", classification_label: "Known", managed: true,
                  },
                ],
                gaps: [
                  "'Trains on customer data' rests on vendor asserted evidence (self-declared) — vendor-asserted, not independently evidenced",
                ],
                weakest_evidence: "vendor_asserted", posture_band: "elevated",
                summary: {
                  assertion_count: 2, independently_evidenced: 1, vendor_asserted: 1,
                  gap_count: 1, dependent_asset_count: 1, unmanaged_dependencies: 0,
                },
              },
            ],
            ungoverned_dependencies: [
              {
                asset_name: "shadow-tool", kind: "tool", kind_label: "Tool",
                classification: "unmanaged", classification_label: "Unmanaged",
                reason: "no_provider_and_unmanaged",
              },
            ],
            summary: {
              vendors: 1, assertions_total: 2,
              assertions_by_evidence_strength: { partially_verified: 1, vendor_asserted: 1 },
              independently_evidenced: 1, vendor_asserted: 1, gaps: 1,
              provider_less_dependencies: 1, unmanaged_dependencies: 1,
              worst_posture_band: "elevated",
            },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/executive-summary/" && method === "GET") {
          // A null-ratio case: no assets discovered, so coverage_ratio and
          // managed_ratio are null (never a fake 0%), and no findings, so
          // resolution_ratio is null too. The decision is carried at true strength.
          return json(200, {
            system: {
              name: "acme-chatbot", uuid: "dep-1",
              environment: "production", environment_label: "Production",
            },
            decision: { decision: "needs_more_evidence", decision_label: "Needs more evidence" },
            asset_coverage: {
              total_assets: 0, classified: 0, managed: 0, unknown: 0, shadow: 0, high_risk: 0,
              by_classification: {}, coverage_ratio: null, managed_ratio: null,
            },
            evidence: { by_class: {}, independently_evidenced: 0, unverified: 0, finding_count: 0 },
            findings: { total: 0, active: 0, resolved: 0, active_by_severity: {}, worst_active_severity: null },
            remediation: {
              open: 0, resolved: 0, wont_fix: 0, by_state: {}, states_reached: [],
              event_count: 0, resolution_ratio: null,
            },
            assessments: {
              compliance: { controls_with_active_findings: 9, worst_severity: "critical" },
              business_impact: { dimensions_with_active_exposure: 3, worst_exposure_band: "elevated" },
              capabilities: { high_risk: 1, shadow: 1 },
              boundary: { declared: false, violations: 0, unknowns: 1, shadow_destinations: 0 },
              vendors: {
                vendors: 1, gaps: 1, worst_posture_band: "elevated",
                independently_evidenced: 1, vendor_asserted: 1,
              },
            },
            posture: "high",
            assurance_maturity: "sparsely_evidenced",
            summary: {
              total_assets: 0, coverage_ratio: null, shadow_assets: 0,
              total_findings: 0, active_findings: 0, resolved_findings: 0,
              worst_active_severity: null, open_remediation: 0, resolved_remediation: 0,
              decision: "needs_more_evidence", posture: "high", assurance_maturity: "sparsely_evidenced",
            },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/operational-assurance/" && method === "GET") {
          // A null-ratio case: nothing has been assessed, so every ratio is null
          // (never a fake 0%), the decision is null (unassessed, never read as
          // ready), and the readiness band lands honestly in its weakest state —
          // `stale`, never a clean pass. ttl_days is a real number and carries
          // through.
          return json(200, {
            system: {
              name: "acme-chatbot", uuid: "dep-1",
              environment: "production", environment_label: "Production",
            },
            decision: { decision: null, decision_label: null },
            evidence_freshness: {
              total: 0, current: 0, stale: 0, ttl_days: 30, freshness_ratio: null,
            },
            change_backlog: {
              total: 0, new: 0, recurring: 0, cleared: 0,
              by_status: { new: 0, recurring: 0, cleared: 0 },
              needs_reassessment: 0, needs_reassessment_ratio: null,
            },
            remediation: {
              open: 0, resolved: 0, wont_fix: 0, by_state: {}, states_reached: [],
              event_count: 0, resolution_ratio: null,
            },
            readiness: "stale",
            summary: {
              total_findings: 0, current_evidence: 0, stale_evidence: 0, freshness_ratio: null,
              needs_reassessment: 0, needs_reassessment_ratio: null,
              open_remediation: 0, resolved_remediation: 0, decision: null, readiness: "stale",
            },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/assurance-packs/" && method === "GET") {
          // The static catalog: two of the four packs is enough to exercise the
          // mapper (frameworks kept verbatim, framework names, regimes as context).
          return json(200, {
            packs: [
              {
                key: "healthcare", name: "Healthcare (HIPAA + NIST 800-53)", vertical: "healthcare",
                description: "For AI systems handling protected health information.",
                frameworks: ["nist_800_53", "owasp_llm_2025"],
                framework_names: {
                  nist_800_53: "NIST SP 800-53 Rev 5",
                  owasp_llm_2025: "OWASP Top 10 for LLM Applications",
                },
                regulatory_regimes: ["HIPAA"],
                evidence_expectations: ["Access enforcement and least privilege on PHI stores (NIST AC family)."],
              },
              {
                key: "general-ai", name: "General AI (OWASP LLM Top 10, NIST AI RMF)", vertical: "general_ai",
                description: "The default lens for any AI system.",
                frameworks: ["owasp_llm_2025", "owasp_2021"],
                framework_names: {
                  owasp_llm_2025: "OWASP Top 10 for LLM Applications",
                  owasp_2021: "OWASP Top 10 (2021)",
                },
                regulatory_regimes: ["NIST AI RMF"],
                evidence_expectations: ["No open prompt-injection findings (OWASP LLM01)."],
              },
            ],
            summary: { packs: 2 },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/assurance-packs/healthcare/" && method === "GET") {
          // Applying a known pack: the compliance map filtered to its frameworks
          // (a touched control is an open gap, carried verbatim), and the
          // regulatory regimes as CONTEXT — each with the "not computed coverage"
          // note, never scored coverage.
          return json(200, {
            pack: {
              key: "healthcare", name: "Healthcare (HIPAA + NIST 800-53)", vertical: "healthcare",
              description: "For AI systems handling protected health information.",
              frameworks: ["nist_800_53", "owasp_llm_2025"],
              framework_names: {
                nist_800_53: "NIST SP 800-53 Rev 5",
                owasp_llm_2025: "OWASP Top 10 for LLM Applications",
              },
              regulatory_regimes: ["HIPAA"],
              evidence_expectations: ["Access enforcement and least privilege on PHI stores (NIST AC family)."],
            },
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
            ],
            regulatory_regimes: [
              {
                name: "HIPAA",
                note: "Regulatory context for this vertical. Athena holds no itemised control catalog for this regime, so it is surfaced as context, not computed coverage.",
              },
            ],
            summary: {
              frameworks_emphasized: 1, controls_touched: 1, controls_with_active_findings: 1,
              worst_severity: "high", total_findings: 7, active_findings: 5,
              resolved_findings: 2, unmapped_finding_types: 1,
            },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/assurance-packs/not-a-pack/" && method === "GET") {
          // An unknown pack: the backend's clean 400, never a guessed pack.
          return json(400, { detail: "Unknown assurance pack: 'not-a-pack'. Known packs: ['federal', 'financial-services', 'general-ai', 'healthcare']." });
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
          // The real Django read shape: the workflow field is `remediation_state`
          // /`remediation_state_label`, and the history is an `events` array
          // (assurance/views.py FindingViewSet.remediation).
          return json(200, {
            remediation_state: "triaged", remediation_state_label: "Triaged", assignee: "alice",
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
          // The real Django transition shape: `remediation_state`
          // /`remediation_state_label` and the single `event` it wrote. It does
          // NOT echo the assignee (assurance/views.py remediation_transition).
          return json(200, {
            remediation_state: b.to_state, remediation_state_label: String(b.to_state),
            event: {
              from_state: "triaged", to_state: b.to_state, actor: "admin",
              note: b.note ?? "", created_at: "2026-09-17T03:00:00Z",
            },
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
          // The real Django assign shape: the `assignee` and the single `event` it
          // wrote. It does NOT return a workflow state (assurance/views.py
          // remediation_assign — assigning does not move the workflow).
          return json(200, {
            assignee: b.assignee ?? null,
            event: {
              from_state: "triaged", to_state: "triaged", actor: "admin",
              note: b.note ?? "", created_at: "2026-09-17T04:00:00Z",
            },
          });
        }

        const assignableMatch = path.match(
          /^\/api\/assurance\/findings\/([^/]+)\/assignable\/$/,
        );
        if (assignableMatch && method === "GET") {
          if (refuseAssignable) {
            return json(404, { detail: "not found" });
          }
          // The real Django assignable shape (assurance/views.py
          // FindingViewSet.assignable): active users only, ordered by username,
          // with `display` the full name or the username, plus the current
          // assignee. Inactive users never appear.
          return json(200, {
            assignable: [
              { username: "alice", display: "Alice Analyst" },
              { username: "bob", display: "bob" },
            ],
            current: "alice",
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

        const providerMatch = path.match(/^\/api\/assurance\/providers\/([^/]+)\/$/);
        if (providerMatch && method === "PATCH") {
          if (patchRefusalStatus !== null) {
            const status = patchRefusalStatus;
            patchRefusalStatus = null;
            return json(status, { detail: "no such provider" });
          }
          const b = raw ? JSON.parse(raw) : {};
          return json(200, {
            uuid: providerMatch[1], name: b.name ?? "OpenAI", kind: b.kind ?? "model_provider",
            kind_label: "Model provider", region: b.region ?? "us", notes: b.notes ?? "",
            evidence_class: "vendor_asserted", assertions: [],
            profile: { declared_fields: 0, weakest_evidence: null },
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

        // ---- Access & Blast Radius (Phase 3.1 + 2.5) ----

        if (path === "/api/assurance/deployments/dep-1/effective-access/" && method === "GET") {
          // A privileged agent with a transitive reach (evidenced via-path) and
          // gaps, plus a shadow (unmanaged) principal — powers, reach, and gaps
          // only, never a claim of least privilege.
          return json(200, {
            principals: [
              {
                key: "asset:agent-1", name: "orchestrator", kind: "agent", kind_label: "Agent",
                classification: "known", classification_label: "Known", managed: true, shadow: false,
                privilege_level: "high",
                capabilities: [
                  {
                    key: "code_execution", label: "Execute code", category: "execution", risk: "high",
                    sources: [{ asset_name: "python-tool", permission: "exec" }],
                  },
                ],
                effective_reach: [
                  {
                    target: "customer-db", target_kind: "data_store", target_kind_label: "Data store",
                    target_classification: "known", target_managed: true,
                    via: ["orchestrator", "sql-tool", "customer-db"], capability: "data_query", risk: "elevated",
                  },
                ],
                gaps: [
                  {
                    type: "privileged_access", risk: "high",
                    detail: "Holds privileged capability: code_execution", capabilities: ["code_execution"],
                  },
                ],
                risk: "high", privileged: true, over_broad: false, orphaned: false,
              },
              {
                key: "asset:sa-1", name: "shadow-runner", kind: "service_account",
                kind_label: "Service account", classification: "unmanaged", classification_label: "Unmanaged",
                managed: false, shadow: true, privilege_level: "standard",
                capabilities: [], effective_reach: [],
                gaps: [
                  {
                    type: "shadow_identity", risk: "elevated",
                    detail: "Identity is evidenced only by unmanaged/unknown assets — a power nobody approved.",
                  },
                ],
                risk: "elevated", privileged: false, over_broad: false, orphaned: false,
              },
            ],
            summary: {
              principals: 2, privileged: 1, shadow: 1, orphaned: 0, over_broad: 0,
              high_risk_reach: 0, worst_risk: "high",
            },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/ripple-effect/" && method === "GET") {
          // A privileged origin with a bounded, evidence-based downstream
          // consequence (evidenced via-path), and an origin with NO evidenced
          // downstream reach — read honestly, never as "safe".
          return json(200, {
            origins: [
              {
                key: "asset:agent-1", origin: "orchestrator", origin_types: ["principal"],
                reasons: ["privileged principal"], risk: "high", findings: [],
                principal_kind: "agent", principal_kind_label: "Agent", privilege_level: "high",
                evidenced_reach: true, consequence_count: 1,
              },
              {
                key: "node:isolated-tool", origin: "isolated-tool", origin_types: ["finding"],
                reasons: ["active high finding: Prompt injection may be possible"], risk: "high",
                findings: [
                  { uuid: "f-9", finding_type: "prompt_injection", severity: "high", title: "Prompt injection may be possible" },
                ],
                evidenced_reach: false, consequence_count: 0,
                note: "No evidenced downstream reach — no path the asset graph attests.",
              },
            ],
            consequences: [
              {
                origin: "orchestrator", origin_key: "asset:agent-1",
                consequence: "Could read or exfiltrate data from customer-db",
                category: "data_exposure", category_label: "Data exposure",
                target: "customer-db", targets: ["customer-db"],
                via: ["orchestrator", "sql-tool", "customer-db"], risk: "elevated",
                potential: true,
                evidence_basis: ["declared reach path through the asset graph (invoke/connect edges)"],
              },
            ],
            summary: {
              origins: 2, origins_with_reach: 1, consequences: 1, evidenced_consequences: 1,
              bounded: false, by_category: { data_exposure: 1 }, worst_risk: "elevated",
            },
          });
        }

        // ---- Posture, credential-gated (Phase 3.2 / 3.3 / 3.4) ----

        if (path === "/api/assurance/deployments/dep-1/posture/" && method === "GET") {
          return json(200, {
            domains: [
              { name: "cloud", label: "Cloud Assurance", configured: false },
              { name: "secrets", label: "Secrets / Crypto", configured: false },
              { name: "repo", label: "Repository / SDLC", configured: false },
            ],
          });
        }

        if (path === "/api/assurance/deployments/dep-1/cloud-posture/" && method === "GET") {
          // Inert by default: connected:false is a NORMAL 200 body — an inert
          // domain reads as "not connected", never "all clear". The catalog of
          // checks it WOULD run rides along.
          return json(200, {
            domain: "cloud", domain_label: "Cloud Assurance", connected: false,
            detail: "cloud posture source not configured",
            checks: [
              {
                check: "public_exposure", title: "No public exposure", severity: "high",
                category: "exposure", resource: "instances", description: "Instances are not publicly reachable.",
              },
            ],
            findings: [],
            summary: {
              connected: false, planned: 1, total: 0, pass: 0, gap: 0, unknown: 0,
              gaps_by_severity: { high: 0, elevated: 0, baseline: 0 }, max_risk: "baseline",
            },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/secrets-posture/" && method === "GET") {
          return json(200, {
            domain: "secrets", domain_label: "Secrets / Crypto", connected: false,
            detail: "secrets posture source not configured",
            checks: [],
            findings: [],
            summary: {
              connected: false, planned: 0, total: 0, pass: 0, gap: 0, unknown: 0,
              gaps_by_severity: { high: 0, elevated: 0, baseline: 0 }, max_risk: "baseline",
            },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/repo-posture/" && method === "GET") {
          // A CONNECTED domain, to exercise the connected mapper: a gap finding at
          // its true evidence class — a "pass" is the observed absence of ONE gap,
          // never a claim the system is secure.
          return json(200, {
            domain: "repo", domain_label: "Repository / SDLC", connected: true,
            checks: [
              {
                check: "branch_protection", title: "Branch protection enabled", severity: "elevated",
                category: "sdlc", resource: "repo", description: "The default branch is protected.",
              },
            ],
            findings: [
              {
                check: "branch_protection", title: "Branch protection enabled", status: "gap",
                severity: "elevated", evidence_class: "configuration_verified",
                evidence_class_label: "Configuration verified",
                detail: "The default branch is not protected.", resource: "repo", category: "sdlc",
              },
            ],
            summary: {
              connected: true, planned: 1, total: 1, pass: 0, gap: 1, unknown: 0,
              gaps_by_severity: { high: 0, elevated: 1, baseline: 0 }, max_risk: "elevated",
              weakest_evidence: "configuration_verified",
            },
          });
        }

        // ---- Data & Context (Phase 3.5) ----

        if (path === "/api/assurance/deployments/dep-1/personal-context/" && method === "GET") {
          // An UNCLASSIFIED store reads as unknown — personal-data exposure cannot
          // be ruled out, never "no PII".
          return json(200, {
            stores: [
              {
                asset_name: "scratch-cache", kind: "data_store", kind_label: "Data store",
                identifier: "cache-1", classification: "unmanaged", classification_label: "Unmanaged",
                managed: false, provider_name: null,
                data_sensitivity: "unknown", personal_data: false, signals: [],
                evidence_class: "not_documented", evidence_class_label: "Not documented",
                reachable_by: [
                  {
                    principal: "orchestrator", principal_kind: "agent", principal_kind_label: "Agent",
                    privilege_level: "high", shadow: false, over_broad: false, risk: "elevated",
                    via: ["orchestrator", "sql-tool", "scratch-cache"],
                  },
                ],
                reader_count: 1,
                gaps: [
                  {
                    type: "reachable_by_privileged", risk: "elevated",
                    detail: "Reachable by high-privilege principals: orchestrator",
                    principals: ["orchestrator"],
                  },
                ],
                risk: "elevated",
              },
            ],
            gaps: [
              {
                type: "reachable_by_privileged", risk: "elevated",
                detail: "Reachable by high-privilege principals: orchestrator",
                principals: ["orchestrator"], asset_name: "scratch-cache",
              },
            ],
            summary: {
              data_bearing_components: 1, personal_data_components: 0, unclassified_components: 1,
              reachable_by_shadow: 0, reachable_by_over_broad: 0, crossing_boundary: 0,
              gaps: 1, worst_risk: "elevated",
            },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/data-lifecycle/" && method === "GET") {
          return json(200, {
            stages: [
              {
                stage: "collected", stage_label: "Collected", control_stage: false, evidenced: true,
                components: [
                  {
                    name: "gpt-x", kind_label: "Model", how: "holds or receives data",
                    evidence_class: "configuration_verified", evidence_class_label: "Configuration verified",
                  },
                ],
                weakest_evidence: "configuration_verified", weakest_evidence_label: "Configuration verified",
                gap: false, gap_detail: null, risk: "baseline",
              },
              {
                stage: "deleted", stage_label: "Deleted", control_stage: true, evidenced: false,
                components: [], weakest_evidence: null, weakest_evidence_label: null,
                gap: true, gap_detail: "No evidenced control for the 'Deleted' stage.", risk: "high",
              },
            ],
            gaps: [
              { stage: "deleted", stage_label: "Deleted", risk: "high", detail: "No evidenced control for the 'Deleted' stage." },
            ],
            summary: { stages_total: 2, evidenced: 1, not_evidenced: 1, control_gaps: 1, worst_risk: "high" },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/training-reuse/" && method === "GET") {
          // A vendor-asserted "we don't train on your data" — reads as
          // vendor-asserted, never verified.
          return json(200, {
            providers: [
              {
                provider_uuid: "p-1", provider_name: "OpenAI", kind: "model_provider",
                kind_label: "Model provider",
                dependent_assets: [
                  {
                    asset_name: "gpt-x", kind: "model", kind_label: "Model",
                    classification: "known", classification_label: "Known", managed: true,
                  },
                ],
                postures: [
                  {
                    field: "trains_on_data", field_label: "Trains on customer data",
                    concern: "Training on customer data", value: "No — zero-retention endpoint",
                    posture: "not_reused", evidence_class: "vendor_asserted",
                    evidence_class_label: "Vendor asserted", source: "self_declared",
                    source_label: "Self-declared", verified: false,
                  },
                ],
                reuse_possible: true, reuse_declared: false,
                gaps: [
                  {
                    type: "reuse_denied_unverified", field: "trains_on_data", risk: "elevated",
                    detail: "Training on customer data — declared not reused ('No — zero-retention endpoint'), but only vendor asserted; the denial is not independently verified.",
                  },
                ],
                risk: "elevated",
              },
            ],
            gaps: [
              {
                type: "reuse_denied_unverified", field: "trains_on_data", risk: "elevated",
                detail: "Training on customer data — declared not reused, not independently verified.",
                provider_name: "OpenAI",
              },
            ],
            summary: {
              providers: 1, reuse_declared: 0, reuse_possible: 1, verified_no_reuse: 0,
              gaps: 1, worst_risk: "elevated",
            },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/metadata-logging/" && method === "GET") {
          return json(200, {
            sinks: [
              {
                asset_name: "otel-collector", kind: "tool", kind_label: "Tool",
                identifier: "otel-1", classification: "known", classification_label: "Known",
                managed: true, provider_name: "Datadog",
                basis: "routes to observability provider 'Datadog'",
                evidence_class: "configuration_verified", evidence_class_label: "Configuration verified",
                sensitive_categories: [
                  { category: "prompts", label: "Prompts & traces", basis: "a model or gateway processes prompts and traces" },
                ],
                control_evidenced: false, control_detail: null,
                gaps: [
                  {
                    type: "logged_without_control", risk: "elevated",
                    detail: "Sensitive categories could reach this sink with no evidenced control: Prompts & traces",
                  },
                ],
                risk: "elevated",
              },
            ],
            sensitive_categories_handled: [
              { category: "prompts", basis: "a model or gateway processes prompts and traces", label: "Prompts & traces" },
            ],
            gaps: [
              {
                type: "logged_without_control", risk: "elevated",
                detail: "Sensitive categories could reach this sink with no evidenced control: Prompts & traces",
                asset_name: "otel-collector",
              },
            ],
            summary: {
              sinks: 1, shadow_sinks: 0, sinks_without_control: 1,
              sensitive_categories_handled: 1, gaps: 1, worst_risk: "elevated",
            },
          });
        }

        // ---- Continuous assurance loop (SPINE Phases 1–3) ----

        if (path === "/api/assurance/claims/" && method === "GET") {
          // A DRF list; the honest null case rides on the primary claim —
          // confidence null (no basis, never 0), and every nullable relation and
          // timestamp null. `all=true` toggles a superseded second row.
          const rows: Record<string, unknown>[] = [
            {
              uuid: "claim-1", deployment_uuid: "dep-1", asset_uuid: null, asset_name: null,
              claim_type: "data_boundary", claim_type_label: "Data boundary",
              statement: "All data destinations sit within the approved boundary.",
              fingerprint: "f".repeat(16), system_fingerprint: "s".repeat(16),
              policy_version: "policy/1.0", environment: "production", environment_label: "Production",
              status: "unknown", status_label: "Unknown",
              evidence_class: "unknown", evidence_class_label: "Unknown",
              confidence: null, vendor_asserted: false,
              assessment: null, assessment_label: null,
              supporting_summary: "", contradicting_summary: "",
              invalidation_conditions: ["The approved data boundary is changed."],
              superseded_by: null, human_owner: null, receipt_digest: "",
              is_stale: false, valid_from: "2026-09-16T00:00:00Z", valid_to: null,
              verified_at: null, expiration: null,
              first_seen: "2026-09-16T00:00:00Z", last_seen: "2026-09-16T00:00:00Z",
              created_at: "2026-09-16T00:00:00Z", updated_at: "2026-09-16T00:00:00Z",
            },
          ];
          if (query.includes("all=true")) {
            rows.push({
              uuid: "claim-0", deployment_uuid: "dep-1", asset_uuid: "asset-9", asset_name: "gpt-x",
              claim_type: "data_boundary", claim_type_label: "Data boundary",
              statement: "Superseded prior version.", fingerprint: "f".repeat(16),
              system_fingerprint: "0".repeat(16), policy_version: "policy/0.9",
              environment: "production", environment_label: "Production",
              status: "superseded", status_label: "Superseded",
              evidence_class: "configuration_verified", evidence_class_label: "Configuration verified",
              confidence: 0.9, vendor_asserted: false, assessment: "ready", assessment_label: "Ready",
              supporting_summary: "", contradicting_summary: "", invalidation_conditions: [],
              superseded_by: "claim-1", human_owner: "admin", receipt_digest: "a".repeat(64),
              is_stale: false, valid_from: "2026-09-01T00:00:00Z", valid_to: "2026-09-16T00:00:00Z",
              verified_at: "2026-09-01T00:00:00Z", expiration: null,
              first_seen: "2026-09-01T00:00:00Z", last_seen: "2026-09-15T00:00:00Z",
              created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-16T00:00:00Z",
            });
          }
          return json(200, rows);
        }

        if (path === "/api/assurance/claims/claim-1/events/" && method === "GET") {
          return json(200, [
            {
              uuid: "ev-1", from_status: null, from_status_label: null,
              to_status: "unknown", to_status_label: "Unknown", actor: null,
              note: "derived", created_at: "2026-09-16T00:00:00Z",
            },
            {
              uuid: "ev-2", from_status: "unknown", from_status_label: "Unknown",
              to_status: "supported", to_status_label: "Supported", actor: "admin",
              note: "boundary reconciled", created_at: "2026-09-16T02:00:00Z",
            },
          ]);
        }

        if (path === "/api/assurance/claims/claim-1/transition/" && method === "POST") {
          return json(200, {
            status: "supported", status_label: "Supported",
            event: {
              uuid: "ev-3", from_status: "unknown", from_status_label: "Unknown",
              to_status: "supported", to_status_label: "Supported", actor: "admin",
              note: JSON.parse(raw || "{}").note ?? "", created_at: "2026-09-16T03:00:00Z",
            },
          });
        }
        if (path === "/api/assurance/claims/claim-illegal/transition/" && method === "POST") {
          // The backend's illegal-transition 400, verbatim.
          return json(400, { detail: "a claim cannot move from unknown to verified" });
        }

        if (path === "/api/assurance/deployments/dep-1/assurance-claims/" && method === "GET") {
          return json(200, [
            {
              uuid: "claim-1", deployment_uuid: "dep-1", asset_uuid: null, asset_name: null,
              claim_type: "data_boundary", claim_type_label: "Data boundary",
              statement: "All data destinations sit within the approved boundary.",
              fingerprint: "f".repeat(16), system_fingerprint: "s".repeat(16),
              policy_version: "policy/1.0", environment: "production", environment_label: "Production",
              status: "unknown", status_label: "Unknown",
              evidence_class: "unknown", evidence_class_label: "Unknown",
              confidence: null, vendor_asserted: false, assessment: null, assessment_label: null,
              supporting_summary: "", contradicting_summary: "", invalidation_conditions: [],
              superseded_by: null, human_owner: null, receipt_digest: "", is_stale: false,
              valid_from: "2026-09-16T00:00:00Z", valid_to: null, verified_at: null, expiration: null,
              first_seen: "2026-09-16T00:00:00Z", last_seen: "2026-09-16T00:00:00Z",
              created_at: "2026-09-16T00:00:00Z", updated_at: "2026-09-16T00:00:00Z",
            },
          ]);
        }

        if (path === "/api/assurance/deployments/dep-1/recompute-claims/" && method === "POST") {
          return json(200, { created: 2, updated: 1, superseded: 0, stale: 1 });
        }

        if (path === "/api/assurance/deployments/dep-1/coverage-manifest/" && method === "GET") {
          // Every declared component assessed -- and the engine never ran two
          // checks, which is the case the asset counts alone cannot show.
          return json(200, {
            expected: 1, observed: 1, assessed: 1,
            verdict: "incomplete", complete: false, critical_gap: true,
            has_declared_baseline: true,
            checks: {
              reported: true, complete: false, total: 27, performed: 24,
              not_performed: [
                {
                  check: "tls", team: "blue", state: "not_performed",
                  reason: "precondition",
                  detail: "The target is http, not https, so there is no TLS configuration to inspect.",
                },
                {
                  check: "idor", team: "blue", state: "not_performed",
                  reason: "precondition",
                  detail: "Authenticated scanning was not configured.",
                },
              ],
              degraded: [
                {
                  check: "subdomain_scanner", team: "blue", state: "degraded",
                  probes_attempted: 6, probes_failed: 6,
                },
              ],
              unmeasured: [],
              limitations: { header_injection: ["Raw CRLF header injection is not probed."] },
              notes: ["Surface discovery incomplete: every probe failed."],
              reported_at: "2026-09-23T00:00:00Z",
              summary: "24 of 27 checks performed; 2 never ran; 1 degraded",
            },
            never_observed: [], declared_but_unassessed: [], high_risk_unassessed: [],
            unassessed: [],
            summary: "Expected 1 / Observed 1 / Assessed 1 / Checks 24/27 -> INCOMPLETE",
          });
        }
        if (path === "/api/assurance/deployments/dep-2/coverage-manifest/" && method === "GET") {
          // No engine said which checks it ran. Must NOT read as "all of them".
          return json(200, {
            expected: 0, observed: 2, assessed: 0,
            verdict: "undeclared", complete: false, critical_gap: false,
            has_declared_baseline: false,
            checks: {
              reported: false, complete: null, total: null, performed: null,
              not_performed: [], degraded: [], unmeasured: [],
              limitations: {}, notes: [], reported_at: null,
              summary: "No engine reported which checks it ran.",
            },
            never_observed: [], declared_but_unassessed: [], high_risk_unassessed: [],
            unassessed: [],
            summary: "Expected 0 / Observed 2 / Assessed 0 -> UNDECLARED",
          });
        }

        if (path === "/api/assurance/deployments/dep-1/bom-drift/" && method === "GET") {
          // The honest no-declaration case: has_declared false, so drift cannot be
          // computed and is NOT read as a clean bill of materials.
          return json(200, {
            deployment_uuid: "dep-1", has_declared: false, drift_detected: false,
            summary: {
              declared_count: 0, observed_count: 3, matched: 0,
              undeclared: 0, undeclared_providers: 0, missing: 0,
            },
            undeclared: [], undeclared_providers: [], missing: [],
            note: "No declared architecture: drift cannot be computed.",
          });
        }
        if (path === "/api/assurance/deployments/dep-2/bom-drift/" && method === "GET") {
          // A declared baseline with real drift, so the undeclared/missing mappers
          // are exercised.
          return json(200, {
            deployment_uuid: "dep-2", has_declared: true, drift_detected: true,
            summary: {
              declared_count: 2, observed_count: 3, matched: 1,
              undeclared: 1, undeclared_providers: 1, missing: 1,
            },
            undeclared: [
              {
                asset_uuid: "asset-3", kind: "mcp_server", kind_label: "MCP server",
                name: "shadow-mcp", identifier: "mcp://shadow", provider_name: null, severity: "high",
              },
            ],
            undeclared_providers: ["fallback-host"],
            missing: [
              {
                declared_uuid: "dc-9", kind: "tool", kind_label: "Tool",
                name: "retired-tool", identifier: "tool://retired", provider_name: null,
              },
            ],
            note: "Observed architecture drifts from the declaration.",
          });
        }

        if (path === "/api/assurance/deployments/dep-1/record-bom-drift/" && method === "POST") {
          return json(200, { created: 1, updated: 0, reopened: 0, resolved: 2, drift_detected: true });
        }

        if (path === "/api/assurance/deployments/dep-1/declared-architecture/" && method === "GET") {
          return json(200, {
            declared: [
              {
                uuid: "dc-1", kind: "model", kind_label: "Model",
                name: "gpt-x", identifier: "openai:gpt-x", provider_name: "OpenAI", note: "",
              },
            ],
            drift: {
              deployment_uuid: "dep-1", has_declared: true, drift_detected: false,
              summary: {
                declared_count: 1, observed_count: 1, matched: 1,
                undeclared: 0, undeclared_providers: 0, missing: 0,
              },
              undeclared: [], undeclared_providers: [], missing: [],
              note: "Observed architecture matches the declaration (1 component(s)).",
            },
          });
        }
        if (path === "/api/assurance/deployments/dep-1/declared-architecture/" && method === "PUT") {
          const parsed = JSON.parse(raw || "{}");
          const comps = Array.isArray(parsed.components) ? parsed.components : [];
          return json(200, {
            declared: comps.map((c: Record<string, unknown>, i: number) => ({
              uuid: `dc-new-${i}`, kind: c.kind, kind_label: "Model",
              name: c.name, identifier: c.identifier ?? "",
              provider_name: c.provider_name ?? "", note: c.note ?? "",
            })),
            drift: {
              deployment_uuid: "dep-1", has_declared: comps.length > 0, drift_detected: false,
              summary: {
                declared_count: comps.length, observed_count: 1, matched: comps.length ? 1 : 0,
                undeclared: 0, undeclared_providers: 0, missing: 0,
              },
              undeclared: [], undeclared_providers: [], missing: [],
              note: "declared",
            },
          });
        }

        if (path === "/api/assurance/deployments/dep-1/decision-support/" && method === "GET") {
          // The honest unassessed case: decision null (never read as ready), and
          // the claim buckets carried as briefs.
          return json(200, {
            decision: null, decision_label: null, from_findings: null, claim_cap: null,
            paused: false,
            claims: {
              has_claims: true, retest_pending: true,
              contradicted: [],
              stale: [],
              unknown: [
                { uuid: "claim-1", claim_type: "data_boundary", status: "unknown", statement: "Boundary holds." },
              ],
              supporting: [],
            },
            note: "Held at 'needs more evidence' by an open retest obligation.",
          });
        }

        if (path === "/api/assurance/deployments/dep-1/revalidation-plan/" && method === "GET") {
          return json(200, {
            deployment_uuid: "dep-1", system_fingerprint: "s".repeat(16),
            summary: { required: 1, still_current: 0, outstanding_unknowns: 1 },
            recompute_action: "POST deployments/{uuid}/recompute-claims to re-derive after the named retests run.",
            required: [
              {
                claim_uuid: "claim-2", claim_type: "effective_access",
                statement: "Least privilege holds.", status: "stale",
                reason: "the bound system state drifted", retest_requirement_uuid: "rr-1",
                athena_reassessments: ["effective_access"], achilles_capabilities: ["privilege_escalation"],
              },
            ],
            outstanding_unknowns: [
              { claim_uuid: "claim-1", claim_type: "data_boundary", statement: "Boundary holds.", status: "unknown" },
            ],
            still_current: [],
            note: "1 claim(s) need revalidation because of a change.",
          });
        }

        if (path === "/api/assurance/deployments/dep-1/check-invalidations/" && method === "POST") {
          return json(200, { invalidated: 2, retests_opened: 2, retests_resolved: 1 });
        }

        if (path === "/api/assurance/retest-requirements/" && method === "GET") {
          return json(200, [
            {
              uuid: "rr-1", deployment_uuid: "dep-1", claim_uuid: "claim-2",
              claim_type: "effective_access", claim_type_label: "Effective access",
              resolving_claim_uuid: null, reason: "the bound system state drifted",
              triggering_system_fingerprint: "t".repeat(16), actor: null, is_open: true,
              opened_at: "2026-09-17T00:00:00Z", resolved_at: null,
              created_at: "2026-09-17T00:00:00Z", updated_at: "2026-09-17T00:00:00Z",
            },
          ]);
        }
        if (path === "/api/assurance/deployments/dep-1/retest-requirements/" && method === "GET") {
          return json(200, [
            {
              uuid: "rr-1", deployment_uuid: "dep-1", claim_uuid: "claim-2",
              claim_type: "effective_access", claim_type_label: "Effective access",
              resolving_claim_uuid: null, reason: "the bound system state drifted",
              triggering_system_fingerprint: "t".repeat(16), actor: null, is_open: true,
              opened_at: "2026-09-17T00:00:00Z", resolved_at: null,
              created_at: "2026-09-17T00:00:00Z", updated_at: "2026-09-17T00:00:00Z",
            },
          ]);
        }

        if (path === "/api/assurance/deployments/dep-1/operational-risk/" && method === "GET") {
          // An honest register: an observed provider-outage class with a real band,
          // and an unmapped denial-of-wallet class (risk null, never a fake 0).
          return json(200, {
            system: {
              name: "acme-chatbot", uuid: "dep-1",
              environment: "production", environment_label: "Production",
            },
            classes: [
              {
                key: "provider_outage", label: "Provider outage / no fallback",
                concern: "deployment_trust", concern_label: "Deployment trust",
                question: "Is there a single model provider with no fallback?",
                status: "observed", observed: true, risk: "high", basis: ["structural"],
                active_finding_count: 0,
                signals: [
                  {
                    source: "provider", reference: "prov-1", provider_name: "OpenAI",
                    kind: "model_provider", kind_label: "Model provider",
                    detail: "single evidenced model provider — a single point of failure",
                  },
                ],
                runtime_signal: "whether failover is configured is a runtime signal",
                notes: [],
              },
              {
                key: "denial_of_wallet", label: "Denial-of-wallet / cost runaway",
                concern: "cost", concern_label: "Cost",
                question: "Is spend bounded?",
                status: "unmapped", observed: false, risk: null, basis: [],
                active_finding_count: 0, signals: [],
                runtime_signal: "budget / rate-limit caps live in the engine's execution layer",
                notes: [],
              },
            ],
            summary: {
              total_classes: 2, observed_classes: 1, unmapped_classes: 1,
              high: 1, elevated: 0, moderate: 0, worst_risk: "high",
              unmapped: ["denial_of_wallet"],
            },
            overall: {
              status: "observed", risk: "high", unmapped_classes: 1,
              note: "Worst observed risk is high; 1 class remains unmapped.",
            },
          });
        }

        if (path === "/api/assurance/findings/f-1/incident-pack/" && method === "GET") {
          // An honest pack: a null owner and a null decision carried at true
          // strength, the runtime transcript stated as an explicit gap.
          return json(200, {
            pack_version: "mythos.assurance.incident_pack/1.0",
            attests: "integrity and provenance, never the truth of the conclusion",
            identity: {
              deployment: {
                name: "acme-chatbot", uuid: "dep-1",
                environment: "production", environment_label: "Production", owner: null,
              },
              finding: {
                uuid: "f-1", fingerprint: "fp".repeat(8), category: "prompt_injection",
                title: "Prompt injection via tool output", severity: "high", severity_label: "High",
                status: "open", status_label: "Open",
              },
            },
            surface: {
              asset: {
                uuid: "asset-1", name: "assistant", kind: "agent", kind_label: "Agent",
                classification: "known", classification_label: "Known", identifier: null,
                provider: { name: "OpenAI", kind: "model_provider", kind_label: "Model provider" },
              },
              asset_present: true, location: "tool:web_fetch",
              control_mapping: { mitre: ["T1059"] },
            },
            evidence: {
              algorithm: "sha256",
              rows: [["partially_verified", "achilles", "a".repeat(64)]],
              count: 1, evidence_class: "partially_verified",
            },
            receipt: { algorithm: "sha256", digest: "d".repeat(64), evidence_count: 1 },
            runtime_transcript: {
              in_assurance_record: false, see: "engine evidence pack",
              reason: "the turn-by-turn transcript lives in the engine's pack",
              engine_pack_ref: { available: true, scan_uuid: "scan-1", engine_run_id: null },
            },
            ripple: {
              is_traced_origin: false, origins: [], consequences: [],
              deployment_summary: {
                origins: 0, origins_with_reach: 0, consequences: 0, evidenced_consequences: 0,
                bounded: true, by_category: {}, worst_risk: null,
              },
              note: "This finding is not itself a traced origin.",
            },
            decision: { decision: null, decision_label: null },
            algorithm: "sha256", digest: "e".repeat(64), computed_at: "2026-09-18T00:00:00Z",
          });
        }

        if (path === "/api/assurance/deployments/dep-1/connectors/" && method === "GET") {
          return json(200, {
            connectors: [
              { name: "github_issues", configured: false },
              { name: "jira", configured: false },
              { name: "servicenow", configured: false },
              { name: "splunk", configured: false },
              { name: "webhook", configured: false },
            ],
          });
        }
        if (path === "/api/assurance/deployments/dep-1/connectors/github_issues/push/" && method === "POST") {
          // The inert case: a normal 200 with ok:false — read ok, not the status.
          return json(200, {
            ok: false, external_ref: null, detail: "github_issues not configured",
            connector: "github_issues",
          });
        }
        if (path === "/api/assurance/deployments/dep-1/connectors/bogus/push/" && method === "POST") {
          // An unknown connector is a meaningful backend 400, not a 503.
          return json(400, { detail: "Unknown connector 'bogus'." });
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
    // The transition response carries the new state and the single move it wrote.
    // It does not echo the assignee — the mapper surfaces that as null, not a lie.
    expect(res.body).toMatchObject({ state: "in_progress", stateLabel: "in_progress", assignee: null });
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ fromState: "triaged", toState: "in_progress" });
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

  it("an admin reads the assignable users for a finding, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/findings/f-1/assignable");
    expect(res.status).toBe(200);
    // The scoped set (active users, ordered by username) and the current assignee.
    expect(res.body).toMatchObject({ current: "alice" });
    expect(res.body.assignable).toEqual([
      { username: "alice", display: "Alice Analyst" },
      { username: "bob", display: "bob" },
    ]);
  });

  it("gates the assignable read to admins: a non-admin gets 403", async () => {
    await user.post("/api/users").send({
      username: "assignable-analyst", password: "analyst-pass", role: "user", isActive: true,
    });
    const analyst = await signIn(app, "assignable-analyst", "analyst-pass");
    const denied = await analyst.get("/api/assurance/findings/f-1/assignable");
    expect(denied.status).toBe(403);
  });

  it("refuses the assignable read to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/findings/f-1/assignable");
    expect(anon.status).toBe(401);
  });

  it("passes the backend's assignable refusal through with its reason", async () => {
    refuseAssignable = true;
    const denied = await user.get("/api/assurance/findings/f-1/assignable");
    expect(denied.status).toBe(404);
    expect(String(denied.body.error)).toContain("not found");
    refuseAssignable = false;
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

  it("carries the receipt's signed/unsigned self-report, and a silence as null", async () => {
    // dep-2 says it is unsigned and why: both reach the page as the backend said.
    const said = await user.get("/api/assurance/deployments/dep-2/assurance-receipt");
    expect(said.status).toBe(200);
    expect(said.body.signed).toBe(false);
    expect(said.body.unsignedReason).toBe("THIS COPY is unsigned. This backend holds no signing key.");
    // dep-1 says nothing about signing. That is null, not false and not true:
    // the page must not print "unsigned" -- or "signed" -- for a silence.
    const silent = await user.get("/api/assurance/deployments/dep-1/assurance-receipt");
    expect(silent.status).toBe(200);
    expect(silent.body.signed).toBeNull();
    expect(silent.body.unsignedReason).toBeNull();
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
    expect(res.body.unresolved[0]).toEqual({
      source: "assistant", sourceKind: "agent", reference: "ghost-tool", mechanism: "tools", reason: null,
    });
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

  it("returns a deployment's vendor-assurance view, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/vendor-assurance");
    expect(res.status).toBe(200);
    // The roll-up counts vendors and assertions honestly, camelCased — and the
    // worst posture band is an ordinal concern signal, never a grade.
    expect(res.body.summary).toMatchObject({
      vendors: 1, assertionsTotal: 2, independentlyEvidenced: 1, vendorAsserted: 1,
      gaps: 1, providerLessDependencies: 1, unmanagedDependencies: 1, worstPostureBand: "elevated",
    });
    expect(res.body.summary.assertionsByEvidenceStrength).toMatchObject({
      partially_verified: 1, vendor_asserted: 1,
    });
    const vendor = res.body.vendors[0];
    expect(vendor).toMatchObject({
      providerName: "OpenAI", kindLabel: "Model provider", region: "us-east-1",
      weakestEvidence: "vendor_asserted", postureBand: "elevated",
    });
    // An independently-evidenced fact is marked so; a self-attested one is NOT
    // promoted — it reads as a vendor-asserted gap at its true strength.
    const independent = vendor.assertions.find((a: { field: string }) => a.field === "logging");
    expect(independent).toMatchObject({ independentlyEvidenced: true, gap: false, source: "measured" });
    const asserted = vendor.assertions.find((a: { field: string }) => a.field === "trains_on_data");
    expect(asserted).toMatchObject({
      independentlyEvidenced: false, gap: true,
      source: "self_declared", evidenceClass: "vendor_asserted",
    });
    // The ungoverned (shadow) dependency is surfaced, never dropped.
    expect(res.body.ungovernedDependencies[0]).toMatchObject({
      assetName: "shadow-tool", kindLabel: "Tool", reason: "no_provider_and_unmanaged",
    });
  });

  it("refuses the vendor-assurance view to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/vendor-assurance");
    expect(anon.status).toBe(401);
  });

  it("returns a deployment's executive summary, mapped to camelCase, carrying null ratios as null", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/executive-summary");
    expect(res.status).toBe(200);
    // The six-state decision is carried at true strength.
    expect(res.body.decision).toMatchObject({
      decision: "needs_more_evidence", decisionLabel: "Needs more evidence",
    });
    // A ratio the backend could not compute is carried as null — NEVER a fake 0.
    expect(res.body.assetCoverage.coverageRatio).toBeNull();
    expect(res.body.assetCoverage.managedRatio).toBeNull();
    expect(res.body.remediation.resolutionRatio).toBeNull();
    // The ordinal posture and maturity bands come through; no dollar/ROI field.
    expect(res.body).toMatchObject({ posture: "high", assuranceMaturity: "sparsely_evidenced" });
    // Sibling headlines are rolled up, camelCased.
    expect(res.body.assessments.compliance).toMatchObject({
      controlsWithActiveFindings: 9, worstSeverity: "critical",
    });
    expect(res.body.assessments.vendors).toMatchObject({
      gaps: 1, worstPostureBand: "elevated", independentlyEvidenced: 1, vendorAsserted: 1,
    });
    // The whole payload carries no invented money value.
    expect(JSON.stringify(res.body)).not.toMatch(/roi|dollar|\$/i);
  });

  it("refuses the executive summary to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/executive-summary");
    expect(anon.status).toBe(401);
  });

  it("returns a deployment's operational roll-up, mapped to camelCase, carrying null ratios and a null decision honestly", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/operational-assurance");
    expect(res.status).toBe(200);
    // The ordinal readiness band is weakest-wins: an unassessed/empty deployment
    // reads `stale`, never a clean pass.
    expect(res.body.readiness).toBe("stale");
    // The six-state decision is None-safe: an unassessed deployment carries null,
    // never read as ready.
    expect(res.body.decision).toMatchObject({ decision: null, decisionLabel: null });
    // Every ratio the backend could not compute is carried as null — NEVER a fake 0.
    expect(res.body.evidenceFreshness.freshnessRatio).toBeNull();
    expect(res.body.changeBacklog.needsReassessmentRatio).toBeNull();
    expect(res.body.remediation.resolutionRatio).toBeNull();
    // A real non-ratio number (the evidence TTL) maps through, camelCased.
    expect(res.body.evidenceFreshness.ttlDays).toBe(30);
    // The nested count record maps, camelCased.
    expect(res.body.changeBacklog.byStatus).toMatchObject({ new: 0, recurring: 0, cleared: 0 });
    // The summary roll-up carries the same honest nulls.
    expect(res.body.summary).toMatchObject({
      freshnessRatio: null, needsReassessmentRatio: null, decision: null, readiness: "stale",
    });
    // The whole payload carries no invented money value.
    expect(JSON.stringify(res.body)).not.toMatch(/roi|dollar|\$/i);
  });

  it("refuses the operational roll-up to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/operational-assurance");
    expect(anon.status).toBe(401);
  });

  it("returns the assurance-packs catalog, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/assurance-packs");
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ packs: 2 });
    const healthcare = res.body.packs.find((p: { key: string }) => p.key === "healthcare");
    expect(healthcare).toMatchObject({
      name: "Healthcare (HIPAA + NIST 800-53)", vertical: "healthcare",
    });
    // Framework identifiers are kept verbatim; regimes ride as context.
    expect(healthcare.frameworks).toEqual(["nist_800_53", "owasp_llm_2025"]);
    expect(healthcare.frameworkNames).toMatchObject({ nist_800_53: "NIST SP 800-53 Rev 5" });
    expect(healthcare.regulatoryRegimes).toEqual(["HIPAA"]);
  });

  it("refuses the assurance-packs catalog to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/assurance-packs");
    expect(anon.status).toBe(401);
  });

  it("applies a known pack, mapped to camelCase, with regimes carried as context", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/assurance-packs/healthcare");
    expect(res.status).toBe(200);
    expect(res.body.pack).toMatchObject({ key: "healthcare" });
    expect(res.body.summary).toMatchObject({
      frameworksEmphasized: 1, controlsTouched: 1, controlsWithActiveFindings: 1,
      worstSeverity: "high", totalFindings: 7,
    });
    // A framework slice is carried verbatim — a touched control is an open gap.
    expect(res.body.frameworks[0]).toMatchObject({ key: "nist_800_53", name: "NIST SP 800-53 Rev 5" });
    expect(res.body.frameworks[0].controls[0]).toMatchObject({
      controlId: "SI-10", activeFindingCount: 2, resolvedFindingCount: 1, worstSeverity: "high",
    });
    // The regulatory regime rides as CONTEXT — its "not computed coverage" note is
    // carried verbatim, never turned into a score.
    expect(res.body.regulatoryRegimes[0]).toMatchObject({ name: "HIPAA" });
    expect(String(res.body.regulatoryRegimes[0].note)).toContain("not computed coverage");
  });

  it("surfaces an unknown pack as a 400 (not a 503) with the backend's reason", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/assurance-packs/not-a-pack");
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("Unknown assurance pack");
  });

  it("refuses applying a pack to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/assurance-packs/healthcare");
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
    expect(JSON.parse(lastRecomputeBody ?? "null")).toEqual({ paused: false });
  });

  it("forwards no pause when the caller names none, so the backend keeps its own", async () => {
    // Defaulted to false here, a recompute lifted a pause an operator committed
    // after the page loaded.
    const res = await user.post("/api/assurance/deployments/dep-1/recompute").send({});
    expect(res.status).toBe(200);
    expect(JSON.parse(lastRecomputeBody ?? "null")).toEqual({});
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
    expect((await request(app).patch("/api/assurance/providers/p-1").send({ name: "Y" })).status).toBe(401);
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

  it("an admin edits a provider's identity in place, mapped to camelCase", async () => {
    const res = await user
      .patch("/api/assurance/providers/p-1")
      .send({ name: "OpenAI Inc.", kind: "model_provider", region: "eu" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      uuid: "p-1", name: "OpenAI Inc.", kind: "model_provider", kindLabel: "Model provider",
    });
  });

  it("rejects a provider edit that names no field to change", async () => {
    const res = await user.patch("/api/assurance/providers/p-1").send({});
    expect(res.status).toBe(400);
  });

  it("passes a provider edit's backend 404 through with its reason", async () => {
    patchRefusalStatus = 404;
    const denied = await user.patch("/api/assurance/providers/ghost").send({ name: "X" });
    expect(denied.status).toBe(404);
    expect(String(denied.body.error)).toContain("no such provider");
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
    expect((await analyst.patch("/api/assurance/providers/p-1").send({ name: "Y" })).status).toBe(403);
    expect(
      (await analyst.post("/api/assurance/provider-assertions").send({ provider: "p-1", field: "region", value: "x" }))
        .status,
    ).toBe(403);
    expect(
      (await analyst.patch("/api/assurance/provider-assertions/as-2").send({ value: "y" })).status,
    ).toBe(403);
    expect((await analyst.delete("/api/assurance/provider-assertions/as-2")).status).toBe(403);
  });

  // ---- Access & Blast Radius (Phase 3.1 + 2.5) ----

  it("returns a deployment's effective-access view, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/effective-access");
    expect(res.status).toBe(200);
    // The roll-up counts principals honestly — worst risk is an ordinal signal.
    expect(res.body.summary).toMatchObject({
      principals: 2, privileged: 1, shadow: 1, highRiskReach: 0, worstRisk: "high",
    });
    const agent = res.body.principals.find((p: { name: string }) => p.name === "orchestrator");
    expect(agent).toMatchObject({ privilegeLevel: "high", privileged: true, shadow: false, risk: "high" });
    // A held capability carries its source (asset + declared permission).
    expect(agent.capabilities[0]).toMatchObject({ key: "code_execution", risk: "high" });
    expect(agent.capabilities[0].sources[0]).toMatchObject({ assetName: "python-tool", permission: "exec" });
    // A transitive reach carries the evidenced via-path, kept verbatim.
    expect(agent.effectiveReach[0]).toMatchObject({
      target: "customer-db", targetKind: "data_store", targetManaged: true, risk: "elevated",
    });
    expect(agent.effectiveReach[0].via).toEqual(["orchestrator", "sql-tool", "customer-db"]);
    // A shadow principal reads as shadow, never smoothed.
    const shadow = res.body.principals.find((p: { name: string }) => p.name === "shadow-runner");
    expect(shadow).toMatchObject({ shadow: true, classification: "unmanaged" });
    expect(shadow.gaps[0]).toMatchObject({ type: "shadow_identity" });
  });

  it("refuses the effective-access view to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/effective-access");
    expect(anon.status).toBe(401);
  });

  it("returns a deployment's ripple-effect view, honest about bounding and no-reach", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/ripple-effect");
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      origins: 2, originsWithReach: 1, consequences: 1, evidencedConsequences: 1,
      bounded: false, worstRisk: "elevated",
    });
    // A consequence is POTENTIAL and evidence-based, with the evidenced via-path.
    const c = res.body.consequences[0];
    expect(c).toMatchObject({
      origin: "orchestrator", category: "data_exposure", target: "customer-db",
      risk: "elevated", potential: true,
    });
    expect(c.via).toEqual(["orchestrator", "sql-tool", "customer-db"]);
    expect(c.consequence).toContain("Could");
    // An origin with no evidenced downstream reach reads as exactly that, never "safe".
    const isolated = res.body.origins.find((o: { origin: string }) => o.origin === "isolated-tool");
    expect(isolated).toMatchObject({ evidencedReach: false, consequenceCount: 0 });
    expect(String(isolated.note)).toContain("No evidenced downstream reach");
  });

  it("refuses the ripple-effect view to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/ripple-effect");
    expect(anon.status).toBe(401);
  });

  // ---- Posture, credential-gated (Phase 3.2 / 3.3 / 3.4) ----

  it("returns the posture catalog, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/posture");
    expect(res.status).toBe(200);
    expect(res.body.domains).toHaveLength(3);
    expect(res.body.domains[0]).toMatchObject({ name: "cloud", label: "Cloud Assurance", configured: false });
  });

  it("refuses the posture catalog to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/posture");
    expect(anon.status).toBe(401);
  });

  it("passes an inert cloud-posture (connected:false) through as a normal 200 — never 'all clear'", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/cloud-posture");
    expect(res.status).toBe(200);
    // The inert domain reads as NOT connected; its detail says why, and the catalog
    // of checks it WOULD run is carried so nothing reads as assessed.
    expect(res.body).toMatchObject({ domain: "cloud", connected: false });
    expect(String(res.body.detail)).toContain("not configured");
    expect(res.body.checks[0]).toMatchObject({ check: "public_exposure", severity: "high" });
    expect(res.body.findings).toEqual([]);
    expect(res.body.summary).toMatchObject({ connected: false, planned: 1, gap: 0 });
    // No findings were fabricated for an inert domain.
    expect(res.body.summary.weakestEvidence).toBeNull();
  });

  it("returns a connected repo-posture with checks/findings, mapped to camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/repo-posture");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ domain: "repo", connected: true });
    // detail is null when connected (no not-configured reason).
    expect(res.body.detail).toBeNull();
    expect(res.body.findings[0]).toMatchObject({
      check: "branch_protection", status: "gap", severity: "elevated",
      evidenceClass: "configuration_verified",
    });
    expect(res.body.summary).toMatchObject({ connected: true, gap: 1, weakestEvidence: "configuration_verified" });
  });

  it("refuses the posture domains to anyone not signed in", async () => {
    expect((await request(app).get("/api/assurance/deployments/dep-1/cloud-posture")).status).toBe(401);
    expect((await request(app).get("/api/assurance/deployments/dep-1/secrets-posture")).status).toBe(401);
    expect((await request(app).get("/api/assurance/deployments/dep-1/repo-posture")).status).toBe(401);
  });

  // ---- Data & Context (Phase 3.5) ----

  it("returns personal-context, reading an unclassified store as unknown (never 'no PII')", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/personal-context");
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      dataBearingComponents: 1, personalDataComponents: 0, unclassifiedComponents: 1, worstRisk: "elevated",
    });
    const store = res.body.stores[0];
    // Unknown sensitivity is carried honestly — personalData stays false, but the
    // store is NOT read as "no PII"; its sensitivity is "unknown".
    expect(store).toMatchObject({ assetName: "scratch-cache", dataSensitivity: "unknown", personalData: false });
    // A reader carries the evidenced via-path.
    expect(store.reachableBy[0]).toMatchObject({ principal: "orchestrator", risk: "elevated" });
    expect(store.reachableBy[0].via).toEqual(["orchestrator", "sql-tool", "scratch-cache"]);
  });

  it("refuses the personal-context view to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/personal-context");
    expect(anon.status).toBe(401);
  });

  it("returns data-lifecycle, reading an unevidenced stage as 'not evidenced' (never compliant)", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/data-lifecycle");
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ stagesTotal: 2, evidenced: 1, notEvidenced: 1, controlGaps: 1, worstRisk: "high" });
    const deleted = res.body.stages.find((s: { stage: string }) => s.stage === "deleted");
    // An unevidenced control stage is a gap at true strength, weakestEvidence null.
    expect(deleted).toMatchObject({ evidenced: false, gap: true, risk: "high", weakestEvidence: null });
    expect(String(deleted.gapDetail)).toContain("No evidenced control");
  });

  it("refuses the data-lifecycle view to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/data-lifecycle");
    expect(anon.status).toBe(401);
  });

  it("returns training-reuse, carrying a vendor-asserted denial at true strength (never verified)", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/training-reuse");
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ providers: 1, reusePossible: 1, verifiedNoReuse: 0, worstRisk: "elevated" });
    const posture = res.body.providers[0].postures[0];
    // A vendor_asserted "not reused" reads as vendor-asserted and NOT verified.
    expect(posture).toMatchObject({
      field: "trains_on_data", posture: "not_reused", verified: false,
      evidenceClass: "vendor_asserted", source: "self_declared",
    });
    expect(res.body.providers[0].gaps[0]).toMatchObject({ type: "reuse_denied_unverified" });
  });

  it("refuses the training-reuse view to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/training-reuse");
    expect(anon.status).toBe(401);
  });

  it("returns metadata-logging, surfacing a sink with a sensitive category and no evidenced control", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/metadata-logging");
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ sinks: 1, sinksWithoutControl: 1, sensitiveCategoriesHandled: 1, worstRisk: "elevated" });
    const sink = res.body.sinks[0];
    expect(sink).toMatchObject({ assetName: "otel-collector", controlEvidenced: false, controlDetail: null, risk: "elevated" });
    expect(sink.sensitiveCategories[0]).toMatchObject({ category: "prompts", label: "Prompts & traces" });
    expect(res.body.sensitiveCategoriesHandled[0]).toMatchObject({ category: "prompts", label: "Prompts & traces" });
  });

  it("refuses the metadata-logging view to anyone not signed in", async () => {
    const anon = await request(app).get("/api/assurance/deployments/dep-1/metadata-logging");
    expect(anon.status).toBe(401);
  });

  // ---- Continuous assurance loop (SPINE Phases 1–3) ----

  // A non-admin operator, created once for the write-gating assertions below. The
  // reads stay open to them; every continuous-assurance write is admin-only.
  async function nonAdmin() {
    await user.post("/api/users").send({
      username: "ca-analyst", password: "analyst-pass", role: "user", isActive: true,
    });
    return signIn(app, "ca-analyst", "analyst-pass");
  }

  it("lists assurance claims, mapped to camelCase, with a null confidence carried as null", async () => {
    const res = await user.get("/api/assurance/claims?deployment=dep-1");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      uuid: "claim-1", claimType: "data_boundary", claimTypeLabel: "Data boundary",
      status: "unknown", statusLabel: "Unknown", vendorAsserted: false,
    });
    // Honest nulls: no basis for confidence (never 0), no assessment (never ready),
    // and every nullable relation/timestamp carried as null.
    expect(res.body[0].confidence).toBeNull();
    expect(res.body[0].assessment).toBeNull();
    expect(res.body[0].assessmentLabel).toBeNull();
    expect(res.body[0].assetUuid).toBeNull();
    expect(res.body[0].supersededBy).toBeNull();
    expect(res.body[0].humanOwner).toBeNull();
    expect(res.body[0].validTo).toBeNull();
    expect(res.body[0].verifiedAt).toBeNull();
    expect(res.body[0].invalidationConditions).toEqual(["The approved data boundary is changed."]);
  });

  it("follows ?all=true through to the claims history", async () => {
    const res = await user.get("/api/assurance/claims?all=true");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const superseded = res.body.find((c: { uuid: string }) => c.uuid === "claim-0");
    expect(superseded).toMatchObject({ status: "superseded", supersededBy: "claim-1", humanOwner: "admin" });
  });

  it("returns a claim's lifecycle events, mapped to camelCase with a null from-status", async () => {
    const res = await user.get("/api/assurance/claims/claim-1/events");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // The initial derive has no from-status: carried as null, not "".
    expect(res.body[0]).toMatchObject({ toStatus: "unknown", actor: null });
    expect(res.body[0].fromStatus).toBeNull();
    expect(res.body[1]).toMatchObject({ fromStatus: "unknown", toStatus: "supported", actor: "admin" });
  });

  it("returns a deployment's current assurance claims", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/assurance-claims");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ uuid: "claim-1", claimType: "data_boundary" });
    expect(res.body[0].confidence).toBeNull();
  });

  it("refuses the claims reads to anyone not signed in", async () => {
    expect((await request(app).get("/api/assurance/claims")).status).toBe(401);
    expect((await request(app).get("/api/assurance/claims/claim-1/events")).status).toBe(401);
    expect((await request(app).get("/api/assurance/deployments/dep-1/assurance-claims")).status).toBe(401);
  });

  it("an admin transitions a claim; the event is returned camelCased", async () => {
    const res = await user
      .post("/api/assurance/claims/claim-1/transition")
      .send({ toStatus: "supported", note: "boundary reconciled" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "supported", statusLabel: "Supported" });
    expect(res.body.event).toMatchObject({ toStatus: "supported", actor: "admin", note: "boundary reconciled" });
  });

  it("rejects a claim transition with an empty target the schema will not accept", async () => {
    const bad = await user.post("/api/assurance/claims/claim-1/transition").send({ toStatus: "" });
    expect(bad.status).toBe(400);
  });

  it("passes the backend's illegal claim-transition 400 through with its reason", async () => {
    const denied = await user
      .post("/api/assurance/claims/claim-illegal/transition")
      .send({ toStatus: "verified" });
    expect(denied.status).toBe(400);
    expect(String(denied.body.error)).toContain("cannot move from");
  });

  it("an admin recomputes a deployment's claims", async () => {
    const res = await user.post("/api/assurance/deployments/dep-1/recompute-claims").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, updated: 1, superseded: 0, stale: 1 });
  });

  it("gates the claim writes to admins: a non-admin gets 403, the reads stay open", async () => {
    const analyst = await nonAdmin();
    expect((await analyst.get("/api/assurance/claims")).status).toBe(200);
    const deniedTransition = await analyst
      .post("/api/assurance/claims/claim-1/transition")
      .send({ toStatus: "supported" });
    expect(deniedTransition.status).toBe(403);
    const deniedRecompute = await analyst.post("/api/assurance/deployments/dep-1/recompute-claims").send({});
    expect(deniedRecompute.status).toBe(403);
  });

  it("refuses the claim writes to anyone not signed in", async () => {
    expect((await request(app).post("/api/assurance/claims/claim-1/transition").send({ toStatus: "supported" })).status).toBe(401);
    expect((await request(app).post("/api/assurance/deployments/dep-1/recompute-claims").send({})).status).toBe(401);
  });

  it("returns BOM drift, honest about an absent declaration (never a clean bill)", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/bom-drift");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hasDeclared: false, driftDetected: false });
    expect(res.body.summary).toMatchObject({ observedCount: 3, undeclared: 0 });
  });

  it("returns BOM drift with real drift, mapping undeclared components and providers", async () => {
    const res = await user.get("/api/assurance/deployments/dep-2/bom-drift");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hasDeclared: true, driftDetected: true });
    expect(res.body.undeclared[0]).toMatchObject({ assetUuid: "asset-3", kindLabel: "MCP server", severity: "high" });
    expect(res.body.undeclaredProviders).toEqual(["fallback-host"]);
    expect(res.body.missing[0]).toMatchObject({ declaredUuid: "dc-9", name: "retired-tool" });
  });

  it("an admin records BOM drift as managed findings", async () => {
    const res = await user.post("/api/assurance/deployments/dep-1/record-bom-drift").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, resolved: 2, driftDetected: true });
  });

  it("returns the declared architecture plus its drift", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/declared-architecture");
    expect(res.status).toBe(200);
    expect(res.body.declared[0]).toMatchObject({ uuid: "dc-1", kind: "model", providerName: "OpenAI" });
    expect(res.body.drift).toMatchObject({ hasDeclared: true, driftDetected: false });
  });

  it("an admin replaces the declared architecture, snake-casing the PUT body", async () => {
    const res = await user
      .put("/api/assurance/deployments/dep-1/declared-architecture")
      .send({ components: [{ kind: "model", name: "gpt-x", providerName: "OpenAI", identifier: "openai:gpt-x" }] });
    expect(res.status).toBe(200);
    expect(res.body.declared[0]).toMatchObject({ kind: "model", name: "gpt-x", providerName: "OpenAI" });
  });

  it("rejects a declared component with a kind the schema will not accept", async () => {
    const bad = await user
      .put("/api/assurance/deployments/dep-1/declared-architecture")
      .send({ components: [{ kind: "bogus_kind", name: "x" }] });
    expect(bad.status).toBe(400);
  });

  it("gates the BOM-drift + declared-architecture writes to admins, reads stay open", async () => {
    const analyst = await nonAdmin();
    expect((await analyst.get("/api/assurance/deployments/dep-1/bom-drift")).status).toBe(200);
    expect((await analyst.get("/api/assurance/deployments/dep-1/declared-architecture")).status).toBe(200);
    expect((await analyst.post("/api/assurance/deployments/dep-1/record-bom-drift").send({})).status).toBe(403);
    const deniedPut = await analyst
      .put("/api/assurance/deployments/dep-1/declared-architecture")
      .send({ components: [] });
    expect(deniedPut.status).toBe(403);
  });

  it("refuses the BOM-drift + declared-architecture writes to anyone not signed in", async () => {
    expect((await request(app).post("/api/assurance/deployments/dep-1/record-bom-drift").send({})).status).toBe(401);
    expect((await request(app).put("/api/assurance/deployments/dep-1/declared-architecture").send({ components: [] })).status).toBe(401);
  });

  it("returns decision-support, honest that an unassessed decision is null (never ready)", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/decision-support");
    expect(res.status).toBe(200);
    expect(res.body.decision).toBeNull();
    expect(res.body.decisionLabel).toBeNull();
    expect(res.body.fromFindings).toBeNull();
    expect(res.body.claimCap).toBeNull();
    expect(res.body.claims).toMatchObject({ hasClaims: true, retestPending: true });
    expect(res.body.claims.unknown[0]).toMatchObject({ uuid: "claim-1", claimType: "data_boundary" });
  });

  it("returns the revalidation plan, mapping the per-claim work", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/revalidation-plan");
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ required: 1, stillCurrent: 0, outstandingUnknowns: 1 });
    expect(res.body.required[0]).toMatchObject({
      claimUuid: "claim-2", retestRequirementUuid: "rr-1",
    });
    expect(res.body.required[0].athenaReassessments).toEqual(["effective_access"]);
    expect(res.body.required[0].achillesCapabilities).toEqual(["privilege_escalation"]);
  });

  it("an admin runs the invalidation check and sees what got invalidated", async () => {
    const res = await user.post("/api/assurance/deployments/dep-1/check-invalidations").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ invalidated: 2, retestsOpened: 2, retestsResolved: 1 });
  });

  it("gates check-invalidations to admins; decision-support and revalidation reads stay open", async () => {
    const analyst = await nonAdmin();
    expect((await analyst.get("/api/assurance/deployments/dep-1/decision-support")).status).toBe(200);
    expect((await analyst.get("/api/assurance/deployments/dep-1/revalidation-plan")).status).toBe(200);
    expect((await analyst.post("/api/assurance/deployments/dep-1/check-invalidations").send({})).status).toBe(403);
  });

  it("refuses the decision-support/revalidation reads and invalidation write to anyone not signed in", async () => {
    expect((await request(app).get("/api/assurance/deployments/dep-1/decision-support")).status).toBe(401);
    expect((await request(app).get("/api/assurance/deployments/dep-1/revalidation-plan")).status).toBe(401);
    expect((await request(app).post("/api/assurance/deployments/dep-1/check-invalidations").send({})).status).toBe(401);
  });

  it("lists retest obligations, mapped to camelCase with a null resolving claim and machine actor", async () => {
    const res = await user.get("/api/assurance/retest-requirements?deployment=dep-1");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      uuid: "rr-1", claimUuid: "claim-2", claimType: "effective_access", isOpen: true,
    });
    // A machine-opened obligation has a null actor and no resolving claim yet.
    expect(res.body[0].actor).toBeNull();
    expect(res.body[0].resolvingClaimUuid).toBeNull();
    expect(res.body[0].resolvedAt).toBeNull();
  });

  it("returns a deployment's retest obligations", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/retest-requirements");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ uuid: "rr-1", isOpen: true });
  });

  it("refuses the retest reads to anyone not signed in", async () => {
    expect((await request(app).get("/api/assurance/retest-requirements")).status).toBe(401);
    expect((await request(app).get("/api/assurance/deployments/dep-1/retest-requirements")).status).toBe(401);
  });

  it("returns operational-risk, carrying an unmapped class as risk null (never a fabricated 0)", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/operational-risk");
    expect(res.status).toBe(200);
    const observed = res.body.classes.find((c: { key: string }) => c.key === "provider_outage");
    const unmapped = res.body.classes.find((c: { key: string }) => c.key === "denial_of_wallet");
    expect(observed).toMatchObject({ observed: true, risk: "high", concernLabel: "Deployment trust" });
    expect(observed.signals[0]).toMatchObject({ source: "provider", providerName: "OpenAI" });
    // The honest core: an unmapped class reads risk null, never 0.
    expect(unmapped).toMatchObject({ observed: false, status: "unmapped" });
    expect(unmapped.risk).toBeNull();
    expect(res.body.summary.worstRisk).toBe("high");
    expect(res.body.overall).toMatchObject({ status: "observed", risk: "high" });
  });

  it("refuses the operational-risk view to anyone not signed in", async () => {
    expect((await request(app).get("/api/assurance/deployments/dep-1/operational-risk")).status).toBe(401);
  });

  it("returns a finding's incident pack, honest about null owner/decision and the transcript gap", async () => {
    const res = await user.get("/api/assurance/findings/f-1/incident-pack");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ packVersion: "mythos.assurance.incident_pack/1.0", digest: "e".repeat(64) });
    expect(res.body.identity.deployment.owner).toBeNull();
    expect(res.body.identity.finding).toMatchObject({ uuid: "f-1", severity: "high" });
    expect(res.body.surface.asset).toMatchObject({ name: "assistant", kindLabel: "Agent" });
    expect(res.body.evidence).toMatchObject({ evidenceClass: "partially_verified", count: 1 });
    // The runtime transcript is an explicit gap, never fabricated; a null run id
    // stays null.
    expect(res.body.runtimeTranscript.inAssuranceRecord).toBe(false);
    expect(res.body.runtimeTranscript.enginePackRef).toMatchObject({ available: true, scanUuid: "scan-1" });
    expect(res.body.runtimeTranscript.enginePackRef.engineRunId).toBeNull();
    // An uncomputed decision is null, never read as ready.
    expect(res.body.decision.decision).toBeNull();
  });

  it("refuses the incident pack to anyone not signed in", async () => {
    expect((await request(app).get("/api/assurance/findings/f-1/incident-pack")).status).toBe(401);
  });

  it("lists connectors, honest that an unconfigured connector is not configured", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/connectors");
    expect(res.status).toBe(200);
    expect(res.body.connectors).toHaveLength(5);
    expect(res.body.connectors[0]).toMatchObject({ name: "github_issues", configured: false });
  });

  it("an admin pushes to an inert connector: a 200 with ok:false (read ok, not the status)", async () => {
    const res = await user
      .post("/api/assurance/deployments/dep-1/connectors/github_issues/push")
      .send({ finding: "f-1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, externalRef: null, connector: "github_issues" });
    expect(String(res.body.detail)).toContain("not configured");
  });

  it("passes the backend's unknown-connector 400 through with its reason", async () => {
    const denied = await user
      .post("/api/assurance/deployments/dep-1/connectors/bogus/push")
      .send({ finding: "f-1" });
    expect(denied.status).toBe(400);
    expect(String(denied.body.error)).toContain("Unknown connector");
  });

  it("gates the connector push to admins; the connectors read stays open", async () => {
    const analyst = await nonAdmin();
    expect((await analyst.get("/api/assurance/deployments/dep-1/connectors")).status).toBe(200);
    const denied = await analyst
      .post("/api/assurance/deployments/dep-1/connectors/github_issues/push")
      .send({ finding: "f-1" });
    expect(denied.status).toBe(403);
  });

  it("refuses the connector read and push to anyone not signed in", async () => {
    expect((await request(app).get("/api/assurance/deployments/dep-1/connectors")).status).toBe(401);
    expect((await request(app).post("/api/assurance/deployments/dep-1/connectors/github_issues/push").send({ finding: "f-1" })).status).toBe(401);
  });
  // ---- the Coverage Manifest, both axes -----------------------------------
  //
  // The distinction the whole feature turns on is in the last test here: an
  // unreported check axis must not reach the browser looking like a complete one.

  it("maps both coverage axes into camelCase", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/coverage-manifest");
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("incomplete");
    expect(res.body.criticalGap).toBe(true);
    expect(res.body.hasDeclaredBaseline).toBe(true);
    expect(res.body.checks.reported).toBe(true);
    expect(res.body.checks.total).toBe(27);
    expect(res.body.checks.performed).toBe(24);
  });

  it("carries each skipped check's reason and detail, not just its name", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/coverage-manifest");
    const names = res.body.checks.notPerformed.map((c: { check: string }) => c.check);
    expect(names).toEqual(["tls", "idor"]);
    const tls = res.body.checks.notPerformed[0];
    expect(tls.reason).toBe("precondition");
    expect(tls.detail).toContain("http, not https");
  });

  it("carries a degraded check's probe arithmetic", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/coverage-manifest");
    const [sub] = res.body.checks.degraded;
    expect(sub.check).toBe("subdomain_scanner");
    expect(sub.probesAttempted).toBe(6);
    expect(sub.probesFailed).toBe(6);
  });

  it("carries declared limitations and whole-scan notes", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/coverage-manifest");
    expect(res.body.checks.limitations.header_injection[0]).toContain("CRLF");
    expect(res.body.checks.notes[0]).toContain("Surface discovery");
  });

  it("keeps an unreported check axis null rather than complete or zero", async () => {
    // `false` would read as "the checks fell short"; `0` would read as "none
    // ran". Both are claims nobody made, and rendering either is the failure the
    // manifest exists to prevent.
    const res = await user.get("/api/assurance/deployments/dep-2/coverage-manifest");
    expect(res.status).toBe(200);
    expect(res.body.checks.reported).toBe(false);
    expect(res.body.checks.complete).toBeNull();
    expect(res.body.checks.total).toBeNull();
    expect(res.body.checks.performed).toBeNull();
  });

  it("puts the coverage manifest behind auth", async () => {
    const res = await request(app).get("/api/assurance/deployments/dep-1/coverage-manifest");
    expect(res.status).toBe(401);
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

describe("assurance BFF against a control plane returning a non-object body", () => {
  // A read mapper indexes into the parsed body; a `200` carrying `null` (or a
  // primitive/array) is not the object it expects, and casting-then-indexing it
  // throws a TypeError that would surface as a generic 500. That non-object body
  // must instead be treated as unavailability — the honest 503 "control plane
  // unavailable" path — never a 500.
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
        const path = (req.url ?? "").split("?")[0];
        const json = (code: number, payload: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };

        if (path === "/api/token/" && method === "POST") {
          return json(200, { access: "svc-access-token", refresh: "r" });
        }

        // A 200 that is honest HTTP-wise but carries `null` where the mapper
        // expects an object.
        if (path === "/api/assurance/deployments/dep-1/executive-summary/" && method === "GET") {
          return json(200, null);
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

  it("answers 503 (not 500) when a read's 200 body is not a JSON object", async () => {
    const res = await user.get("/api/assurance/deployments/dep-1/executive-summary");
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toMatch(/not a json object/i);
  });
});
