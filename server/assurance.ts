/**
 * The dashboard's read/disposition client for the Athena assurance system of
 * record (Athena-Backend, /api/assurance/).
 *
 * The engine tests and the backend records; this is where the desktop console
 * reads what the backend concluded — the deployments under assurance, their
 * findings graded by *how strongly each is known*, the six-state deployment
 * decision, and the Unknowns Register (the gaps the evidence could not close).
 * The browser keeps calling this server same-origin with its session cookie;
 * this server reaches the backend with its service account (see
 * server/control-plane.ts). So a screen never learns a second origin or a
 * second auth scheme, and this file is the only place the two vocabularies
 * meet: snake_case from Django is mapped to camelCase here, once.
 *
 * Nothing here decides anything. It surfaces the backend's own conclusions;
 * a release decision stays a human's to make from them.
 */

import { call, body, baseUrl, isConfigured, ControlPlaneUnavailable } from "./control-plane";

export { ControlPlaneUnavailable, isConfigured };

// ==== Typed views (camelCase; snake_case stays on the wire) ====

export interface AssuranceEvidence {
  classification: string;
  classificationLabel: string;
  summary: string;
  source: string;
}

export interface AssuranceFinding {
  uuid: string;
  deploymentUuid: string | null;
  findingType: string;
  title: string;
  severity: string;
  confidence: number;
  status: string;
  owner: string | null;
  impact: string;
  businessImpact: string;
  recommendation: string;
  location: string;
  retestRequired: boolean;
  /** The finding's honest evidence class: the weakest link among its evidence. */
  evidenceClass: string;
  evidence: AssuranceEvidence[];
  /** The asset this finding is about, when the backend attributed it to one. */
  assetUuid: string | null;
  assetName: string | null;
  /**
   * Change intelligence (spine): the finding's state vs the deployment's latest
   * scan — "new" | "recurring" | "cleared" (cleared = no longer reported, NOT
   * fixed) — its label, and whether its evidence has gone stale (a retest is due).
   */
  changeStatus: string;
  changeLabel: string;
  ageDays: number | null;
  stale: boolean;
  /**
   * The finding's assurance receipt (spine): a recomputable digest binding it to
   * its evidence hashes. Attests integrity/provenance — that the evidence is
   * unaltered — not that the conclusion is true.
   */
  receipt: AssuranceReceipt;
  firstSeen: string | null;
  lastSeen: string | null;
  /**
   * The remediation workflow (Phase 2.3): who the finding is assigned to, and
   * which of the six workflow states it is in. Both READ-ONLY on the finding
   * serializer — moved with the dedicated remediation endpoints. This is the
   * *human process* of fixing, NOT the security disposition: `remediationState`
   * "resolved" means the workflow closed it, never that the finding is fixed in
   * the security sense (see `status`).
   */
  assignee: string | null;
  remediationState: string;
}

export interface AssuranceReceipt {
  algorithm: string;
  digest: string;
  /** Present on a finding receipt; a deployment receipt reports findingCount. */
  evidenceCount?: number;
  findingCount?: number;
  computedAt: string | null;
}

// The full, versioned Assurance Receipt standard (spine): the roadmap tuple —
// system, receipt version, policy, evidence root, result, per-assessment digests
// — as one deterministic, portable, signable payload (backend RECEIPT_SCHEMA,
// mythos.assurance.receipt/1.0). It attests INTEGRITY and PROVENANCE — that this
// is the assurance state that was recorded, unaltered — never that the
// conclusions are true or the system is secure. Every field is carried at its
// true strength; an undeclared policy reads as declared:false, never invented.
export interface AssuranceReceiptStandard {
  receiptVersion: string;
  system: { name: string; uuid: string; environment: string; environmentLabel: string };
  // A six-state deployment decision, or null when none has been computed yet
  // (never silently read as ready).
  result: { decision: string | null; decisionLabel: string | null };
  // The declared data boundary the receipt is assessed against, honestly: when no
  // boundary was ever approved this is { declared: false } and nothing else — an
  // undeclared boundary is a gap, never a policy we invent to look complete.
  policy:
    | { declared: false }
    | {
        declared: true;
        allowedRegions: string[];
        trainingAllowed: boolean;
        thirdPartySharingAllowed: boolean;
      };
  // The evidence set reduced to its Merkle-style root, with the finding count and
  // hash algorithm alongside.
  evidence: { algorithm: string; root: string; findingCount: number };
  // A digest per computed assessment — a digest attests the assessment was
  // recorded unaltered, never that it passes.
  assessments: { compliance: string; capabilities: string; boundary: string; bom: string };
  algorithm: string;
  // The top-level deterministic digest over the stable content (the value a
  // signature is taken over). Kept verbatim.
  digest: string;
  // Metadata only, OUTSIDE the hash.
  computedAt: string | null;
}

// AI System Capability Map (Phase 1.3): the ground truth of what a deployment
// can *do*, derived from its asset graph and declared tool permissions.
export interface CapabilitySource {
  assetName: string;
  kind: string;
  kindLabel: string;
  classification: string;
  classificationLabel: string;
  managed: boolean;
  detail: string;
}
export interface Capability {
  key: string;
  label: string;
  category: string;
  description: string;
  /** "high" | "elevated" | "baseline". */
  risk: string;
  /** A managed/declared component grants this power. */
  declared: boolean;
  /** Only unmanaged components grant it — a power nobody approved. */
  shadow: boolean;
  sources: CapabilitySource[];
}
export interface CapabilityCategory {
  category: string;
  count: number;
  maxRisk: string;
}
export interface AssuranceCapabilityMap {
  capabilities: Capability[];
  categories: CapabilityCategory[];
  summary: { total: number; highRisk: number; elevated: number; baseline: number; declared: number; shadow: number };
}

// System / Route Map (Phase 1.6): the layered data-flow graph, app → gateway →
// model → data → tools → logs.
export interface RouteNode {
  uuid: string;
  name: string;
  kind: string;
  kindLabel: string;
  classification: string;
  classificationLabel: string;
  layer: string;
  shadow: boolean;
  providerName: string | null;
}
export interface RouteEdge {
  source: string;
  target: string;
  kind: string;
  label: string;
  /** Declared: the inventory attests it. Inferred: the reference pipeline spine. */
  declared: boolean;
}
export interface RouteLayer {
  key: string;
  label: string;
  nodes: RouteNode[];
}
export interface RouteUnresolved {
  agent: string;
  toolIdentifier: string;
}
export interface AssuranceRouteMap {
  layers: RouteLayer[];
  nodes: RouteNode[];
  edges: RouteEdge[];
  unresolved: RouteUnresolved[];
  summary: {
    nodeCount: number;
    edgeCount: number;
    declaredEdges: number;
    inferredEdges: number;
    shadowNodes: number;
    unresolvedEdges: number;
    layersPresent: string[];
    logsObserved: boolean;
  };
}

// AI-BOM (Phase 1.7): the AI supply-chain bill of materials — an exportable,
// tamper-evident inventory of components and the providers behind them.
export interface BomComponent {
  uuid: string;
  name: string;
  kind: string;
  kindLabel: string;
  identifier: string;
  classification: string;
  classificationLabel: string;
  shadow: boolean;
  providerUuid: string | null;
  providerName: string | null;
  facts: Record<string, unknown>;
  firstSeen: string | null;
  lastSeen: string | null;
}
export interface BomProviderFact {
  field: string;
  fieldLabel: string;
  value: string;
  evidenceClass: string;
  evidenceClassLabel: string;
  source: string;
  sourceLabel: string;
}
export interface BomProvider {
  uuid: string;
  name: string;
  kind: string;
  kindLabel: string;
  region: string;
  declaredFacts: BomProviderFact[];
  declaredFieldCount: number;
  weakestEvidence: string | null;
}
export interface AssuranceAiBom {
  format: string;
  version: string;
  deployment: { uuid: string; name: string };
  components: BomComponent[];
  providers: BomProvider[];
  summary: {
    componentCount: number;
    providerCount: number;
    shadowComponents: number;
    componentsByKind: Record<string, number>;
    componentsByClassification: Record<string, number>;
    declaredFactCount: number;
    weakestEvidence: string | null;
  };
  receipt: { algorithm: string; digest: string };
  generatedAt: string | null;
}

export interface AssuranceDeployment {
  uuid: string;
  name: string;
  environment: string;
  /** One of the six decision states, or null when nothing has been assessed. */
  decision: string | null;
  decisionLabel: string;
  description: string;
  findingCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AssuranceAsset {
  uuid: string;
  deploymentUuid: string | null;
  kind: string;
  kindLabel: string;
  name: string;
  identifier: string;
  classification: string;
  classificationLabel: string;
  provider: number | null;
  /** The provider this asset resolves to, by uuid — the join key to its profile. */
  providerUuid: string | null;
  providerName: string | null;
  findingCount: number;
  metadata: Record<string, unknown>;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface AssuranceProviderAssertion {
  uuid: string;
  field: string;
  fieldLabel: string;
  value: string;
  evidenceClass: string;
  evidenceClassLabel: string;
  source: string;
  sourceLabel: string;
  notes: string;
  updatedAt: string | null;
}

export interface AssuranceProvider {
  uuid: string;
  name: string;
  kind: string;
  kindLabel: string;
  region: string;
  notes: string;
  evidenceClass: string;
  assertions: AssuranceProviderAssertion[];
  /**
   * The vendor's declared assurance profile: how many facts it has declared, and
   * the WEAKEST evidence class among them (null when nothing is declared).
   */
  profile: { declaredFields: number; weakestEvidence: string | null };
}

export interface AssuranceUnknown {
  uuid: string;
  deploymentUuid: string | null;
  findingUuid: string | null;
  question: string;
  whyItMatters: string;
  evidenceNeeded: string;
  deploymentImpact: string;
  impactLabel: string;
  status: string;
  statusLabel: string;
  source: string;
  owner: string | null;
  notes: string;
  reviewBy: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
}

// ==== Remediation workflow (Phase 2.3) ====
//
// A finding's remediation workflow is the *human process* of getting it fixed —
// who owns it and where it is in the six-state pipeline (new → triaged →
// in_progress → in_review → resolved, with wont_fix off to the side). It is
// tracked and audited separately from the security disposition: a workflow move
// never changes the finding's severity, status or the deployment's decision, and
// `resolved` here means the process closed the ticket, NOT that the finding is
// fixed in the security sense. Every move is recorded as an event.

export interface RemediationEvent {
  fromState: string | null;
  toState: string;
  actor: string | null;
  note: string;
  createdAt: string | null;
}
export interface AssuranceRemediation {
  state: string;
  stateLabel: string;
  assignee: string | null;
  events: RemediationEvent[];
}

export interface AssuranceStatus {
  configured: boolean;
  reachable: boolean;
  /** Whether the backend accepted the service credential. null = could not tell. */
  authorized: boolean | null;
  url: string | null;
  detail: string;
}

// ==== Data Boundary Assessment (Phase 1.4) ====

export interface DataBoundaryPosture {
  value: string;
  evidenceClass: string;
}
export interface DataBoundaryFlow {
  providerUuid: string;
  providerName: string;
  kind: string;
  kindLabel: string;
  assets: string[];
  region: DataBoundaryPosture | null;
  training: DataBoundaryPosture | null;
  /** "approved" | "violation" | "unknown". */
  status: string;
  violations: string[];
  unknowns: string[];
}
export interface DataBoundaryShadow {
  assetName: string;
  kind: string;
  kindLabel: string;
  identifier: string;
}
export interface DataBoundaryPolicy {
  allowedRegions: string[];
  trainingAllowed: boolean;
  thirdPartySharingAllowed: boolean;
  notes: string;
  updatedAt: string | null;
}
export interface AssuranceDataBoundary {
  /** Whether an approved boundary has been declared. */
  declared: boolean;
  policy: DataBoundaryPolicy | null;
  flows: DataBoundaryFlow[];
  shadowDestinations: DataBoundaryShadow[];
  summary: { approved: number; violations: number; unknowns: number; shadowDestinations: number };
}
/** The approved boundary a human declares (the PUT body). */
export interface DataBoundaryInput {
  allowedRegions: string[];
  trainingAllowed: boolean;
  thirdPartySharingAllowed: boolean;
  notes?: string;
}

// ==== Compliance Map (Phase 2.1) ====
//
// An HONEST gap map of a deployment's findings against the compliance
// frameworks, not a certificate. A "touched" control is a control with an open
// finding against it — its `activeFindingCount` and `worstSeverity` are the gap
// signal, never a claim the control is met. Finding types no framework claims
// (`unmapped`) and the raw engine taxonomy the engine cited (`engineReferences`,
// CWE/OWASP-by-id) ride alongside, surfaced rather than hidden.

export interface ComplianceControl {
  controlId: string;
  name: string | null;
  family: string | null;
  familyName: string | null;
  /** Whether the control is in the catalogue, or only referenced by a finding. */
  catalogued: boolean;
  activeFindingCount: number;
  resolvedFindingCount: number;
  /** The worst severity among this control's findings, or null when none. */
  worstSeverity: string | null;
  findingTypes: string[];
}
export interface ComplianceFramework {
  key: string;
  name: string;
  controls: ComplianceControl[];
  summary: { controlsTouched: number; controlsWithActiveFindings: number; worstSeverity: string | null };
}
export interface ComplianceUnmapped {
  findingType: string;
  activeFindingCount: number;
  resolvedFindingCount: number;
  worstSeverity: string | null;
}
export interface ComplianceEngineReference {
  taxonomy: string;
  id: string;
  findingCount: number;
  findingTypes: string[];
}
export interface AssuranceCompliance {
  frameworks: ComplianceFramework[];
  unmapped: ComplianceUnmapped[];
  engineReferences: ComplianceEngineReference[];
  summary: {
    totalFindings: number;
    activeFindings: number;
    resolvedFindings: number;
    mappedFindingTypes: number;
    unmappedFindingTypes: number;
    frameworks: number;
    controlsTouched: number;
    controlsWithActiveFindings: number;
    worstSeverity: string | null;
  };
}

// ==== Business-impact Map (Phase 2.4) ====
//
// An HONEST map of a deployment's findings onto the business-impact dimensions
// they implicate — inferred *potential* exposure, never a realized loss or a
// dollar figure. A dimension is implicated only by its ACTIVE findings; its
// `exposureBand` (elevated/moderate/low) is an ORDINAL signal of how much is at
// stake, not a quantity, and is null when nothing is active — read as "no active
// exposure", never "safe". The finding types no dimension claims (`unmapped`)
// ride alongside, surfaced rather than hidden.

export interface BusinessImpactDimension {
  key: string;
  label: string;
  description: string;
  activeFindingCount: number;
  resolvedFindingCount: number;
  /** The worst severity among this dimension's ACTIVE findings, or null when none. */
  worstSeverity: string | null;
  /** Ordinal exposure signal (elevated/moderate/low), or null when nothing is active. */
  exposureBand: string | null;
  findingTypes: string[];
}
export interface BusinessImpactUnmapped {
  findingType: string;
  activeFindingCount: number;
  resolvedFindingCount: number;
  worstSeverity: string | null;
}
export interface AssuranceBusinessImpact {
  dimensions: BusinessImpactDimension[];
  unmapped: BusinessImpactUnmapped[];
  summary: {
    totalFindings: number;
    activeFindings: number;
    resolvedFindings: number;
    mappedFindingTypes: number;
    unmappedFindingTypes: number;
    dimensions: number;
    dimensionsTouched: number;
    dimensionsWithActiveExposure: number;
    worstSeverity: string | null;
    worstExposureBand: string | null;
  };
}

// ==== Mappers ====

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
const bool = (v: unknown): boolean => v === true;

function evidence(raw: Record<string, unknown>): AssuranceEvidence {
  return {
    classification: str(raw.classification),
    classificationLabel: str(raw.classification_label),
    summary: str(raw.summary),
    source: str(raw.source),
  };
}

function finding(raw: Record<string, unknown>): AssuranceFinding {
  return {
    uuid: str(raw.uuid),
    deploymentUuid: strOrNull(raw.deployment_uuid),
    findingType: str(raw.finding_type),
    title: str(raw.title),
    severity: str(raw.severity),
    confidence: num(raw.confidence, 0.5),
    status: str(raw.status),
    owner: raw.owner == null ? null : String(raw.owner),
    impact: str(raw.impact),
    businessImpact: str(raw.business_impact),
    recommendation: str(raw.recommendation),
    location: str(raw.location),
    retestRequired: bool(raw.retest_required),
    evidenceClass: str(raw.evidence_class),
    evidence: Array.isArray(raw.evidence)
      ? (raw.evidence as Record<string, unknown>[]).map(evidence)
      : [],
    assetUuid: strOrNull(raw.asset_uuid),
    assetName: strOrNull(raw.asset_name),
    changeStatus: str(raw.change_status),
    changeLabel: str(raw.change_label),
    ageDays: typeof raw.age_days === "number" ? raw.age_days : null,
    stale: bool(raw.stale),
    receipt: receipt(raw.receipt),
    firstSeen: strOrNull(raw.first_seen),
    lastSeen: strOrNull(raw.last_seen),
    assignee: raw.assignee == null ? null : String(raw.assignee),
    remediationState: str(raw.remediation_state),
  };
}

function receipt(raw: unknown): AssuranceReceipt {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    algorithm: str(r.algorithm),
    digest: str(r.digest),
    evidenceCount: typeof r.evidence_count === "number" ? r.evidence_count : undefined,
    findingCount: typeof r.finding_count === "number" ? r.finding_count : undefined,
    computedAt: strOrNull(r.computed_at),
  };
}

function capabilitySource(raw: Record<string, unknown>): CapabilitySource {
  return {
    assetName: str(raw.asset_name),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    classification: str(raw.classification),
    classificationLabel: str(raw.classification_label),
    managed: bool(raw.managed),
    detail: str(raw.detail),
  };
}

function capabilityMap(raw: Record<string, unknown>): AssuranceCapabilityMap {
  const rawSummary =
    raw.summary && typeof raw.summary === "object" && !Array.isArray(raw.summary)
      ? (raw.summary as Record<string, unknown>)
      : {};
  return {
    capabilities: Array.isArray(raw.capabilities)
      ? (raw.capabilities as Record<string, unknown>[]).map((c) => ({
          key: str(c.key),
          label: str(c.label),
          category: str(c.category),
          description: str(c.description),
          risk: str(c.risk),
          declared: bool(c.declared),
          shadow: bool(c.shadow),
          sources: Array.isArray(c.sources)
            ? (c.sources as Record<string, unknown>[]).map(capabilitySource)
            : [],
        }))
      : [],
    categories: Array.isArray(raw.categories)
      ? (raw.categories as Record<string, unknown>[]).map((c) => ({
          category: str(c.category),
          count: num(c.count, 0),
          maxRisk: str(c.max_risk),
        }))
      : [],
    summary: {
      total: num(rawSummary.total, 0),
      highRisk: num(rawSummary.high_risk, 0),
      elevated: num(rawSummary.elevated, 0),
      baseline: num(rawSummary.baseline, 0),
      declared: num(rawSummary.declared, 0),
      shadow: num(rawSummary.shadow, 0),
    },
  };
}

function routeNode(raw: Record<string, unknown>): RouteNode {
  return {
    uuid: str(raw.uuid),
    name: str(raw.name),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    classification: str(raw.classification),
    classificationLabel: str(raw.classification_label),
    layer: str(raw.layer),
    shadow: bool(raw.shadow),
    providerName: strOrNull(raw.provider_name),
  };
}

function mapRouteMap(raw: Record<string, unknown>): AssuranceRouteMap {
  const rawSummary =
    raw.summary && typeof raw.summary === "object" && !Array.isArray(raw.summary)
      ? (raw.summary as Record<string, unknown>)
      : {};
  return {
    layers: Array.isArray(raw.layers)
      ? (raw.layers as Record<string, unknown>[]).map((l) => ({
          key: str(l.key),
          label: str(l.label),
          nodes: Array.isArray(l.nodes) ? (l.nodes as Record<string, unknown>[]).map(routeNode) : [],
        }))
      : [],
    nodes: Array.isArray(raw.nodes) ? (raw.nodes as Record<string, unknown>[]).map(routeNode) : [],
    edges: Array.isArray(raw.edges)
      ? (raw.edges as Record<string, unknown>[]).map((e) => ({
          source: str(e.source),
          target: str(e.target),
          kind: str(e.kind),
          label: str(e.label),
          declared: bool(e.declared),
        }))
      : [],
    unresolved: Array.isArray(raw.unresolved)
      ? (raw.unresolved as Record<string, unknown>[]).map((u) => ({
          agent: str(u.agent),
          toolIdentifier: str(u.tool_identifier),
        }))
      : [],
    summary: {
      nodeCount: num(rawSummary.node_count, 0),
      edgeCount: num(rawSummary.edge_count, 0),
      declaredEdges: num(rawSummary.declared_edges, 0),
      inferredEdges: num(rawSummary.inferred_edges, 0),
      shadowNodes: num(rawSummary.shadow_nodes, 0),
      unresolvedEdges: num(rawSummary.unresolved_edges, 0),
      layersPresent: strList(rawSummary.layers_present),
      logsObserved: bool(rawSummary.logs_observed),
    },
  };
}

/** A passthrough object of {string: number}, filtered to numeric values. */
function numRecord(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

function bomComponent(raw: Record<string, unknown>): BomComponent {
  return {
    uuid: str(raw.uuid),
    name: str(raw.name),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    identifier: str(raw.identifier),
    classification: str(raw.classification),
    classificationLabel: str(raw.classification_label),
    shadow: bool(raw.shadow),
    providerUuid: strOrNull(raw.provider_uuid),
    providerName: strOrNull(raw.provider_name),
    facts:
      raw.facts && typeof raw.facts === "object" && !Array.isArray(raw.facts)
        ? (raw.facts as Record<string, unknown>)
        : {},
    firstSeen: strOrNull(raw.first_seen),
    lastSeen: strOrNull(raw.last_seen),
  };
}

function bomProvider(raw: Record<string, unknown>): BomProvider {
  return {
    uuid: str(raw.uuid),
    name: str(raw.name),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    region: str(raw.region),
    declaredFacts: Array.isArray(raw.declared_facts)
      ? (raw.declared_facts as Record<string, unknown>[]).map((f) => ({
          field: str(f.field),
          fieldLabel: str(f.field_label),
          value: str(f.value),
          evidenceClass: str(f.evidence_class),
          evidenceClassLabel: str(f.evidence_class_label),
          source: str(f.source),
          sourceLabel: str(f.source_label),
        }))
      : [],
    declaredFieldCount: num(raw.declared_field_count, 0),
    weakestEvidence: strOrNull(raw.weakest_evidence),
  };
}

function mapAiBom(raw: Record<string, unknown>): AssuranceAiBom {
  const rawSummary =
    raw.summary && typeof raw.summary === "object" && !Array.isArray(raw.summary)
      ? (raw.summary as Record<string, unknown>)
      : {};
  const rawDeployment =
    raw.deployment && typeof raw.deployment === "object" && !Array.isArray(raw.deployment)
      ? (raw.deployment as Record<string, unknown>)
      : {};
  const rawReceipt =
    raw.receipt && typeof raw.receipt === "object" && !Array.isArray(raw.receipt)
      ? (raw.receipt as Record<string, unknown>)
      : {};
  return {
    format: str(raw.format),
    version: str(raw.version),
    deployment: { uuid: str(rawDeployment.uuid), name: str(rawDeployment.name) },
    components: Array.isArray(raw.components)
      ? (raw.components as Record<string, unknown>[]).map(bomComponent)
      : [],
    providers: Array.isArray(raw.providers)
      ? (raw.providers as Record<string, unknown>[]).map(bomProvider)
      : [],
    summary: {
      componentCount: num(rawSummary.component_count, 0),
      providerCount: num(rawSummary.provider_count, 0),
      shadowComponents: num(rawSummary.shadow_components, 0),
      componentsByKind: numRecord(rawSummary.components_by_kind),
      componentsByClassification: numRecord(rawSummary.components_by_classification),
      declaredFactCount: num(rawSummary.declared_fact_count, 0),
      weakestEvidence: strOrNull(rawSummary.weakest_evidence),
    },
    receipt: { algorithm: str(rawReceipt.algorithm), digest: str(rawReceipt.digest) },
    generatedAt: strOrNull(raw.generated_at),
  };
}

function posture(raw: unknown): DataBoundaryPosture | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  return { value: str(p.value), evidenceClass: str(p.evidence_class) };
}

function strList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

function dataBoundaryFlow(raw: Record<string, unknown>): DataBoundaryFlow {
  return {
    providerUuid: str(raw.provider_uuid),
    providerName: str(raw.provider_name),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    assets: strList(raw.assets),
    region: posture(raw.region),
    training: posture(raw.training),
    status: str(raw.status),
    violations: strList(raw.violations),
    unknowns: strList(raw.unknowns),
  };
}

function dataBoundaryAssessment(raw: Record<string, unknown>): AssuranceDataBoundary {
  const rawPolicy =
    raw.policy && typeof raw.policy === "object" && !Array.isArray(raw.policy)
      ? (raw.policy as Record<string, unknown>)
      : null;
  const rawSummary =
    raw.summary && typeof raw.summary === "object" && !Array.isArray(raw.summary)
      ? (raw.summary as Record<string, unknown>)
      : {};
  return {
    declared: bool(raw.declared),
    policy: rawPolicy
      ? {
          allowedRegions: strList(rawPolicy.allowed_regions),
          trainingAllowed: bool(rawPolicy.training_allowed),
          thirdPartySharingAllowed: bool(rawPolicy.third_party_sharing_allowed),
          notes: str(rawPolicy.notes),
          updatedAt: strOrNull(rawPolicy.updated_at),
        }
      : null,
    flows: Array.isArray(raw.flows) ? (raw.flows as Record<string, unknown>[]).map(dataBoundaryFlow) : [],
    shadowDestinations: Array.isArray(raw.shadow_destinations)
      ? (raw.shadow_destinations as Record<string, unknown>[]).map((s) => ({
          assetName: str(s.asset_name),
          kind: str(s.kind),
          kindLabel: str(s.kind_label),
          identifier: str(s.identifier),
        }))
      : [],
    summary: {
      approved: num(rawSummary.approved, 0),
      violations: num(rawSummary.violations, 0),
      unknowns: num(rawSummary.unknowns, 0),
      shadowDestinations: num(rawSummary.shadow_destinations, 0),
    },
  };
}

function complianceControl(raw: Record<string, unknown>): ComplianceControl {
  return {
    controlId: str(raw.control_id),
    name: strOrNull(raw.name),
    family: strOrNull(raw.family),
    familyName: strOrNull(raw.family_name),
    catalogued: bool(raw.catalogued),
    activeFindingCount: num(raw.active_finding_count, 0),
    resolvedFindingCount: num(raw.resolved_finding_count, 0),
    worstSeverity: strOrNull(raw.worst_severity),
    findingTypes: strList(raw.finding_types),
  };
}

function mapCompliance(raw: Record<string, unknown>): AssuranceCompliance {
  const rawSummary =
    raw.summary && typeof raw.summary === "object" && !Array.isArray(raw.summary)
      ? (raw.summary as Record<string, unknown>)
      : {};
  return {
    frameworks: Array.isArray(raw.frameworks)
      ? (raw.frameworks as Record<string, unknown>[]).map((f) => {
          const fSummary =
            f.summary && typeof f.summary === "object" && !Array.isArray(f.summary)
              ? (f.summary as Record<string, unknown>)
              : {};
          return {
            key: str(f.key),
            name: str(f.name),
            controls: Array.isArray(f.controls)
              ? (f.controls as Record<string, unknown>[]).map(complianceControl)
              : [],
            summary: {
              controlsTouched: num(fSummary.controls_touched, 0),
              controlsWithActiveFindings: num(fSummary.controls_with_active_findings, 0),
              worstSeverity: strOrNull(fSummary.worst_severity),
            },
          };
        })
      : [],
    unmapped: Array.isArray(raw.unmapped)
      ? (raw.unmapped as Record<string, unknown>[]).map((u) => ({
          findingType: str(u.finding_type),
          activeFindingCount: num(u.active_finding_count, 0),
          resolvedFindingCount: num(u.resolved_finding_count, 0),
          worstSeverity: strOrNull(u.worst_severity),
        }))
      : [],
    engineReferences: Array.isArray(raw.engine_references)
      ? (raw.engine_references as Record<string, unknown>[]).map((e) => ({
          taxonomy: str(e.taxonomy),
          id: str(e.id),
          findingCount: num(e.finding_count, 0),
          findingTypes: strList(e.finding_types),
        }))
      : [],
    summary: {
      totalFindings: num(rawSummary.total_findings, 0),
      activeFindings: num(rawSummary.active_findings, 0),
      resolvedFindings: num(rawSummary.resolved_findings, 0),
      mappedFindingTypes: num(rawSummary.mapped_finding_types, 0),
      unmappedFindingTypes: num(rawSummary.unmapped_finding_types, 0),
      frameworks: num(rawSummary.frameworks, 0),
      controlsTouched: num(rawSummary.controls_touched, 0),
      controlsWithActiveFindings: num(rawSummary.controls_with_active_findings, 0),
      worstSeverity: strOrNull(rawSummary.worst_severity),
    },
  };
}

function businessImpactDimension(raw: Record<string, unknown>): BusinessImpactDimension {
  return {
    key: str(raw.key),
    label: str(raw.label),
    description: str(raw.description),
    activeFindingCount: num(raw.active_finding_count, 0),
    resolvedFindingCount: num(raw.resolved_finding_count, 0),
    worstSeverity: strOrNull(raw.worst_severity),
    exposureBand: strOrNull(raw.exposure_band),
    findingTypes: strList(raw.finding_types),
  };
}

function mapBusinessImpact(raw: Record<string, unknown>): AssuranceBusinessImpact {
  const rawSummary =
    raw.summary && typeof raw.summary === "object" && !Array.isArray(raw.summary)
      ? (raw.summary as Record<string, unknown>)
      : {};
  return {
    dimensions: Array.isArray(raw.dimensions)
      ? (raw.dimensions as Record<string, unknown>[]).map(businessImpactDimension)
      : [],
    unmapped: Array.isArray(raw.unmapped)
      ? (raw.unmapped as Record<string, unknown>[]).map((u) => ({
          findingType: str(u.finding_type),
          activeFindingCount: num(u.active_finding_count, 0),
          resolvedFindingCount: num(u.resolved_finding_count, 0),
          worstSeverity: strOrNull(u.worst_severity),
        }))
      : [],
    summary: {
      totalFindings: num(rawSummary.total_findings, 0),
      activeFindings: num(rawSummary.active_findings, 0),
      resolvedFindings: num(rawSummary.resolved_findings, 0),
      mappedFindingTypes: num(rawSummary.mapped_finding_types, 0),
      unmappedFindingTypes: num(rawSummary.unmapped_finding_types, 0),
      dimensions: num(rawSummary.dimensions, 0),
      dimensionsTouched: num(rawSummary.dimensions_touched, 0),
      dimensionsWithActiveExposure: num(rawSummary.dimensions_with_active_exposure, 0),
      worstSeverity: strOrNull(rawSummary.worst_severity),
      worstExposureBand: strOrNull(rawSummary.worst_exposure_band),
    },
  };
}

// The full, versioned Assurance Receipt standard, snake→camel. Digests and the
// version string are kept verbatim — they are the signable content. An
// undeclared policy is carried honestly as { declared: false } and nothing else,
// never fleshed out with an invented boundary.
function mapAssuranceReceipt(raw: Record<string, unknown>): AssuranceReceiptStandard {
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const system = obj(raw.system);
  const result = obj(raw.result);
  const rawPolicy = obj(raw.policy);
  const evidence = obj(raw.evidence);
  const assessments = obj(raw.assessments);
  return {
    receiptVersion: str(raw.receipt_version),
    system: {
      name: str(system.name),
      uuid: str(system.uuid),
      environment: str(system.environment),
      environmentLabel: str(system.environment_label),
    },
    result: {
      decision: strOrNull(result.decision),
      decisionLabel: strOrNull(result.decision_label),
    },
    policy:
      rawPolicy.declared === true
        ? {
            declared: true,
            allowedRegions: strList(rawPolicy.allowed_regions),
            trainingAllowed: bool(rawPolicy.training_allowed),
            thirdPartySharingAllowed: bool(rawPolicy.third_party_sharing_allowed),
          }
        : { declared: false },
    evidence: {
      algorithm: str(evidence.algorithm),
      root: str(evidence.root),
      findingCount: num(evidence.finding_count, 0),
    },
    assessments: {
      compliance: str(assessments.compliance),
      capabilities: str(assessments.capabilities),
      boundary: str(assessments.boundary),
      bom: str(assessments.bom),
    },
    algorithm: str(raw.algorithm),
    digest: str(raw.digest),
    computedAt: strOrNull(raw.computed_at),
  };
}

function deployment(raw: Record<string, unknown>): AssuranceDeployment {
  return {
    uuid: str(raw.uuid),
    name: str(raw.name),
    environment: str(raw.environment),
    decision: strOrNull(raw.decision),
    decisionLabel: str(raw.decision_label),
    description: str(raw.description),
    findingCount: num(raw.finding_count, 0),
    createdAt: strOrNull(raw.created_at),
    updatedAt: strOrNull(raw.updated_at),
  };
}

function unknown(raw: Record<string, unknown>): AssuranceUnknown {
  return {
    uuid: str(raw.uuid),
    deploymentUuid: strOrNull(raw.deployment_uuid),
    findingUuid: strOrNull(raw.finding_uuid),
    question: str(raw.question),
    whyItMatters: str(raw.why_it_matters),
    evidenceNeeded: str(raw.evidence_needed),
    deploymentImpact: str(raw.deployment_impact),
    impactLabel: str(raw.impact_label),
    status: str(raw.status),
    statusLabel: str(raw.status_label),
    source: str(raw.source),
    owner: raw.owner == null ? null : String(raw.owner),
    notes: str(raw.notes),
    reviewBy: strOrNull(raw.review_by),
    firstSeen: strOrNull(raw.first_seen),
    lastSeen: strOrNull(raw.last_seen),
  };
}

function remediationEvent(raw: Record<string, unknown>): RemediationEvent {
  return {
    fromState: strOrNull(raw.from_state),
    toState: str(raw.to_state),
    actor: raw.actor == null ? null : String(raw.actor),
    note: str(raw.note),
    createdAt: strOrNull(raw.created_at),
  };
}

function mapRemediation(raw: Record<string, unknown>): AssuranceRemediation {
  return {
    state: str(raw.state),
    stateLabel: str(raw.state_label),
    assignee: raw.assignee == null ? null : String(raw.assignee),
    events: Array.isArray(raw.events)
      ? (raw.events as Record<string, unknown>[]).map(remediationEvent)
      : [],
  };
}

function asset(raw: Record<string, unknown>): AssuranceAsset {
  return {
    uuid: str(raw.uuid),
    deploymentUuid: strOrNull(raw.deployment_uuid),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    name: str(raw.name),
    identifier: str(raw.identifier),
    classification: str(raw.classification),
    classificationLabel: str(raw.classification_label),
    provider: typeof raw.provider === "number" ? raw.provider : null,
    providerUuid: strOrNull(raw.provider_uuid),
    providerName: strOrNull(raw.provider_name),
    findingCount: num(raw.finding_count, 0),
    metadata:
      raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
        ? (raw.metadata as Record<string, unknown>)
        : {},
    firstSeen: strOrNull(raw.first_seen),
    lastSeen: strOrNull(raw.last_seen),
  };
}

function assertion(raw: Record<string, unknown>): AssuranceProviderAssertion {
  return {
    uuid: str(raw.uuid),
    field: str(raw.field),
    fieldLabel: str(raw.field_label),
    value: str(raw.value),
    evidenceClass: str(raw.evidence_class),
    evidenceClassLabel: str(raw.evidence_class_label),
    source: str(raw.source),
    sourceLabel: str(raw.source_label),
    notes: str(raw.notes),
    updatedAt: strOrNull(raw.updated_at),
  };
}

function provider(raw: Record<string, unknown>): AssuranceProvider {
  const rawProfile =
    raw.profile && typeof raw.profile === "object" && !Array.isArray(raw.profile)
      ? (raw.profile as Record<string, unknown>)
      : {};
  return {
    uuid: str(raw.uuid),
    name: str(raw.name),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    region: str(raw.region),
    notes: str(raw.notes),
    evidenceClass: str(raw.evidence_class),
    assertions: Array.isArray(raw.assertions)
      ? (raw.assertions as Record<string, unknown>[]).map(assertion)
      : [],
    profile: {
      declaredFields: num(rawProfile.declared_fields, 0),
      weakestEvidence: strOrNull(rawProfile.weakest_evidence),
    },
  };
}

/** DRF list endpoints answer either a bare array or a paginated `{results}`. */
function rows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).results)) {
    return (payload as { results: Record<string, unknown>[] }).results;
  }
  return [];
}

function queryString(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) q.set(key, value);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * The 4xx codes a backend refusal carries meaning in, and which are returned to
 * the caller (as `{ok:false}`) rather than laundered into a 503. Everything else
 * non-ok (5xx, and network failures below) is genuine unavailability.
 */
const PASSTHROUGH_STATUS = new Set([400, 403, 404, 409]);

/** A cap on how many pages we will follow, so a backend that always sets `next` cannot spin forever. */
const MAX_PAGES = 200;

/**
 * The path+query of a DRF `next` link, or null when there is no next page.
 *
 * `next` is an absolute URL on the backend's own origin; we only want the path
 * and query to hand back to `call()`, which prepends the configured base. A
 * value that is already a bare path is passed through (made root-relative).
 */
function nextPath(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const next = (payload as Record<string, unknown>).next;
  if (typeof next !== "string" || next === "") return null;
  try {
    const u = new URL(next);
    return `${u.pathname}${u.search}`;
  } catch {
    return next.startsWith("/") ? next : `/${next}`;
  }
}

/**
 * Fetch every page of a DRF list endpoint and concatenate the rows.
 *
 * A list endpoint answers either a bare array (not paginated — the whole answer)
 * or `{count, next, previous, results}` (PageNumberPagination, PAGE_SIZE=50). We
 * follow the `next` link until it is exhausted so nothing past the first page is
 * silently dropped; query filters ride along because DRF echoes them into `next`.
 * A non-ok answer on any page is unavailability, per the existing contract.
 */
async function pagedRows(firstPath: string): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  let path: string | null = firstPath;
  for (let page = 0; path !== null && page < MAX_PAGES; page += 1) {
    const response = await call(path);
    if (!response.ok) {
      throw new ControlPlaneUnavailable(
        `the Athena control plane answered ${response.status}: ${await body(response)}`,
      );
    }
    const payload = await response.json();
    // A bare array is not paginated: it is the complete answer.
    if (Array.isArray(payload)) return payload as Record<string, unknown>[];
    collected.push(...rows(payload));
    path = nextPath(payload);
  }
  return collected;
}

// ==== Reads ====

/** Is the assurance backend there, and does it accept our service credential? */
export async function status(): Promise<AssuranceStatus> {
  const url = baseUrl();
  if (!url) {
    return {
      configured: false,
      reachable: false,
      authorized: false,
      url: null,
      detail:
        "no Athena control plane is configured, so this console has no system " +
        "of record to read. Set ATHENA_FAILSAFE_URL (and a service credential, " +
        "ATHENA_FAILSAFE_USER/ATHENA_FAILSAFE_PASSWORD) on the backend.",
    };
  }
  try {
    // The deployments list authenticates and is cheap; a 200 proves both
    // reachable and authorized in one call.
    const response = await call("/api/assurance/deployments/");
    if (response.status === 401 || response.status === 403) {
      return {
        configured: true,
        reachable: true,
        authorized: false,
        url,
        detail: `the control plane rejected the service credential (${response.status})`,
      };
    }
    if (!response.ok) {
      return {
        configured: true,
        reachable: true,
        authorized: null,
        url,
        detail: `the control plane answered ${response.status}: ${await body(response)}`,
      };
    }
    return {
      configured: true,
      reachable: true,
      authorized: true,
      url,
      detail: "the control plane answered and accepted the service credential",
    };
  } catch (cause) {
    if (cause instanceof ControlPlaneUnavailable) {
      return { configured: true, reachable: false, authorized: false, url, detail: cause.message };
    }
    throw cause;
  }
}

export async function listDeployments(): Promise<AssuranceDeployment[]> {
  return (await pagedRows("/api/assurance/deployments/")).map(deployment);
}

/**
 * A deployment's assurance receipt: one recomputable digest over its findings'
 * evidence hashes, for an auditor to verify the evidence is unaltered. A read
 * (open), so a non-ok answer is genuine unavailability like the other reads.
 */
export async function deploymentReceipt(uuid: string): Promise<AssuranceReceipt> {
  const response = await call(`/api/assurance/deployments/${encodeURIComponent(uuid)}/receipt/`);
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return receipt(await response.json());
}

/**
 * A deployment's full, versioned **Assurance Receipt** (spine): the roadmap tuple
 * — system, receipt version, policy, evidence root, result, per-assessment
 * digests — as one deterministic, portable, signable payload (the standardised
 * superset of the bare `receipt` above). A read (open), so a non-ok answer is
 * genuine unavailability like the other reads. It attests integrity and
 * provenance — that this is the assurance state that was recorded, unaltered —
 * never that the conclusions are true or the system is secure.
 */
export async function assuranceReceipt(uuid: string): Promise<AssuranceReceiptStandard> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/assurance-receipt/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapAssuranceReceipt((await response.json()) as Record<string, unknown>);
}

/**
 * A deployment's AI System Capability Map (Phase 1.3): the ground-truth
 * inventory of what it can *do*, derived from its asset graph and declared tool
 * permissions. A read (open), so a non-ok answer is genuine unavailability like
 * the other reads.
 */
export async function capabilities(uuid: string): Promise<AssuranceCapabilityMap> {
  const response = await call(`/api/assurance/deployments/${encodeURIComponent(uuid)}/capabilities/`);
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return capabilityMap((await response.json()) as Record<string, unknown>);
}

/**
 * A deployment's System / Route Map (Phase 1.6): the layered data-flow graph
 * (app → gateway → model → data → tools → logs) reconstructed from its asset
 * graph and declared edges. A read (open), so a non-ok answer is genuine
 * unavailability like the other reads.
 */
export async function routeMap(uuid: string): Promise<AssuranceRouteMap> {
  const response = await call(`/api/assurance/deployments/${encodeURIComponent(uuid)}/route-map/`);
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapRouteMap((await response.json()) as Record<string, unknown>);
}

/**
 * A deployment's AI-BOM (Phase 1.7): the AI supply-chain bill of materials — its
 * components and the providers behind them, each provider fact evidence-graded,
 * with a tamper-evident digest. A read (open), so a non-ok answer is genuine
 * unavailability like the other reads.
 */
export async function aiBom(uuid: string): Promise<AssuranceAiBom> {
  const response = await call(`/api/assurance/deployments/${encodeURIComponent(uuid)}/ai-bom/`);
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapAiBom((await response.json()) as Record<string, unknown>);
}

/**
 * A deployment's AI data-boundary assessment (Phase 1.4): the approved boundary
 * a human declared reconciled against the deployment's actual data destinations
 * (its provider flows and their declared postures), plus the shadow destinations
 * that escape it. A read (open), so a non-ok answer is genuine unavailability.
 */
export async function dataBoundary(uuid: string): Promise<AssuranceDataBoundary> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/data-boundary/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return dataBoundaryAssessment((await response.json()) as Record<string, unknown>);
}

/**
 * A deployment's compliance map (Phase 2.1): an honest gap map of its findings
 * against the compliance frameworks (NIST 800-53, OWASP 2021, OWASP LLM 2025,
 * DoD Zero Trust). A touched control is a control with an open finding against
 * it — its active-finding count and worst severity are the gap signal, never a
 * claim the control is met; the unmapped finding types and engine taxonomy
 * references ride alongside. A read (open), so a non-ok answer is genuine
 * unavailability like the other reads.
 */
export async function compliance(uuid: string): Promise<AssuranceCompliance> {
  const response = await call(`/api/assurance/deployments/${encodeURIComponent(uuid)}/compliance/`);
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapCompliance((await response.json()) as Record<string, unknown>);
}

/**
 * A deployment's business-impact map (Phase 2.4): the business-impact dimensions
 * its findings implicate. This is inferred *potential* exposure, never a realized
 * loss or a dollar figure — a dimension is implicated only by its active
 * findings, and its exposure band is an ordinal signal (elevated/moderate/low)
 * of how much is at stake, never a quantity. A dimension with no active findings
 * carries no exposure band and reads as "no active exposure", never "safe"; the
 * unmapped finding types ride alongside. A read (open), so a non-ok answer is
 * genuine unavailability like the other reads.
 */
export async function businessImpact(uuid: string): Promise<AssuranceBusinessImpact> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/business-impact/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapBusinessImpact((await response.json()) as Record<string, unknown>);
}

/**
 * A finding's remediation workflow (Phase 2.3): its current workflow state, the
 * assignee, and the full audit trail of state moves. An open read (any operator
 * may see who is working a finding and how far along it is), so a non-ok answer
 * is genuine unavailability like the other reads.
 */
export async function remediation(uuid: string): Promise<AssuranceRemediation> {
  const response = await call(
    `/api/assurance/findings/${encodeURIComponent(uuid)}/remediation/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapRemediation((await response.json()) as Record<string, unknown>);
}

export async function listFindings(
  opts: { deployment?: string; severity?: string; status?: string } = {},
): Promise<AssuranceFinding[]> {
  const query = queryString({
    deployment: opts.deployment,
    severity: opts.severity,
    status: opts.status,
  });
  return (await pagedRows(`/api/assurance/findings/${query}`)).map(finding);
}

export async function listUnknowns(
  opts: { deployment?: string; status?: string; impact?: string } = {},
): Promise<AssuranceUnknown[]> {
  const query = queryString({
    deployment: opts.deployment,
    status: opts.status,
    impact: opts.impact,
  });
  return (await pagedRows(`/api/assurance/unknowns/${query}`)).map(unknown);
}

export async function listAssets(
  opts: { deployment?: string; kind?: string; classification?: string } = {},
): Promise<AssuranceAsset[]> {
  const query = queryString({
    deployment: opts.deployment,
    kind: opts.kind,
    classification: opts.classification,
  });
  return (await pagedRows(`/api/assurance/assets/${query}`)).map(asset);
}

/**
 * The provider registry: the third-party vendors under a deployment's supply
 * chain and each one's declared assurance profile. It is a global registry, not
 * scoped to a deployment, so it takes no filters.
 */
export async function listProviders(): Promise<AssuranceProvider[]> {
  return (await pagedRows("/api/assurance/providers/")).map(provider);
}

// ==== Writes ====

/**
 * Recompute a deployment's six-state decision from its live findings. The
 * `paused` flag mirrors the operator failsafe state and, when true, overrides
 * the decision to "Deployment paused". Returns the new decision.
 */
export async function recomputeDecision(
  uuid: string,
  paused: boolean,
): Promise<
  | { ok: true; decision: string | null; decisionLabel: string }
  | { ok: false; status: number; detail: string }
> {
  const response = await call(`/api/assurance/deployments/${encodeURIComponent(uuid)}/recompute/`, {
    method: "POST",
    body: JSON.stringify({ paused }),
  });
  // A backend refusal (e.g. the deployment is gone, or the credential may not
  // recompute it) is the operator's to see with its reason -- not a 503 that
  // says the control plane is down when it answered perfectly.
  if (PASSTHROUGH_STATUS.has(response.status)) {
    return { ok: false, status: response.status, detail: await body(response) };
  }
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  return { ok: true, decision: strOrNull(payload.decision), decisionLabel: str(payload.decision_label) };
}

/** The disposition fields a human may set on an Unknown. */
export interface UnknownPatch {
  status?: string;
  deploymentImpact?: string;
  notes?: string;
  reviewBy?: string | null;
}

/**
 * Update the human disposition of an Unknown. A backend refusal (400/403/404/409)
 * is returned to the caller with its reason rather than thrown, so the console
 * can show exactly why an edit did not take.
 */
export async function patchUnknown(
  uuid: string,
  patch: UnknownPatch,
): Promise<{ ok: true; unknown: AssuranceUnknown } | { ok: false; status: number; detail: string }> {
  const wire: Record<string, unknown> = {};
  if (patch.status !== undefined) wire.status = patch.status;
  if (patch.deploymentImpact !== undefined) wire.deployment_impact = patch.deploymentImpact;
  if (patch.notes !== undefined) wire.notes = patch.notes;
  if (patch.reviewBy !== undefined) wire.review_by = patch.reviewBy;

  const response = await call(`/api/assurance/unknowns/${encodeURIComponent(uuid)}/`, {
    method: "PATCH",
    body: JSON.stringify(wire),
  });
  if (PASSTHROUGH_STATUS.has(response.status)) {
    return { ok: false, status: response.status, detail: await body(response) };
  }
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return { ok: true, unknown: unknown((await response.json()) as Record<string, unknown>) };
}

/**
 * A write that expects a JSON body back (create/update). Backend refusals
 * (400/403/404/409 — a validation error, a duplicate field, the credential not
 * being allowed to write) are returned to the caller with their reason rather
 * than laundered into a 503, so the console can show exactly why the write did
 * not take. Genuine unavailability (5xx, network) still throws.
 */
async function writeJson<T>(
  path: string,
  method: "POST" | "PATCH",
  wire: Record<string, unknown>,
  map: (raw: Record<string, unknown>) => T,
): Promise<{ ok: true; value: T } | { ok: false; status: number; detail: string }> {
  const response = await call(path, { method, body: JSON.stringify(wire) });
  if (PASSTHROUGH_STATUS.has(response.status)) {
    return { ok: false, status: response.status, detail: await body(response) };
  }
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return { ok: true, value: map((await response.json()) as Record<string, unknown>) };
}

/**
 * Declare (or replace) the approved data boundary for a deployment (Phase 1.4).
 * A PUT: admin-only on the control plane, gated again on the BFF route. The
 * response is the freshly recomputed assessment. A backend refusal (400/403/404)
 * is returned with its reason rather than laundered into a 503.
 */
export async function setDataBoundary(
  uuid: string,
  input: DataBoundaryInput,
): Promise<
  | { ok: true; value: AssuranceDataBoundary }
  | { ok: false; status: number; detail: string }
> {
  const wire: Record<string, unknown> = {
    allowed_regions: input.allowedRegions,
    training_allowed: input.trainingAllowed,
    third_party_sharing_allowed: input.thirdPartySharingAllowed,
  };
  if (input.notes !== undefined) wire.notes = input.notes;

  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/data-boundary/`,
    { method: "PUT", body: JSON.stringify(wire) },
  );
  if (PASSTHROUGH_STATUS.has(response.status)) {
    return { ok: false, status: response.status, detail: await body(response) };
  }
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return {
    ok: true,
    value: dataBoundaryAssessment((await response.json()) as Record<string, unknown>),
  };
}

/** The identity a human declares when registering a provider by hand. */
export interface ProviderInput {
  name: string;
  kind: string;
}

/**
 * Register a provider a deployment relies on (a vector DB, a gateway) — one that
 * asset discovery did not auto-register from an LLM target. Admin-only on the
 * control plane; the BFF route gates it too.
 */
export async function createProvider(input: ProviderInput) {
  return writeJson("/api/assurance/providers/", "POST", { name: input.name, kind: input.kind }, provider);
}

/** The fields a human sets when recording or editing a provider assertion. */
export interface ProviderAssertionInput {
  provider: string;
  field: string;
  value: string;
  evidenceClass?: string;
  source?: string;
  notes?: string;
}
export interface ProviderAssertionPatch {
  value?: string;
  evidenceClass?: string;
  source?: string;
  notes?: string;
}

function assertionWire(input: Partial<ProviderAssertionInput>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  if (input.provider !== undefined) wire.provider = input.provider;
  if (input.field !== undefined) wire.field = input.field;
  if (input.value !== undefined) wire.value = input.value;
  if (input.evidenceClass !== undefined) wire.evidence_class = input.evidenceClass;
  if (input.source !== undefined) wire.source = input.source;
  if (input.notes !== undefined) wire.notes = input.notes;
  return wire;
}

/** Record a new graded fact in a provider's assurance profile. */
export async function createProviderAssertion(input: ProviderAssertionInput) {
  return writeJson("/api/assurance/provider-assertions/", "POST", assertionWire(input), assertion);
}

/** Edit an existing assertion in place (its value, evidence class, source, notes). */
export async function updateProviderAssertion(uuid: string, patch: ProviderAssertionPatch) {
  return writeJson(
    `/api/assurance/provider-assertions/${encodeURIComponent(uuid)}/`,
    "PATCH",
    assertionWire(patch),
    assertion,
  );
}

/**
 * Delete an assertion. A backend refusal (403/404) is returned to the caller;
 * a 204 (or 200) is success. Genuine unavailability throws.
 */
export async function deleteProviderAssertion(
  uuid: string,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
  const response = await call(`/api/assurance/provider-assertions/${encodeURIComponent(uuid)}/`, {
    method: "DELETE",
  });
  if (PASSTHROUGH_STATUS.has(response.status)) {
    return { ok: false, status: response.status, detail: await body(response) };
  }
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return { ok: true };
}

/**
 * Move a finding's remediation workflow to a new state (Phase 2.3). Admin-only
 * on the control plane; the BFF route gates it too. The backend refuses an
 * illegal transition with a 400 (only certain moves are legal — see the state
 * machine), which is passed back to the caller with its reason rather than
 * laundered into a 503, so the console can say exactly why the move did not
 * take. The response is the updated workflow (its new state and audit trail).
 * A workflow move never changes the finding's security status or the
 * deployment's decision.
 */
export async function remediationTransition(uuid: string, toState: string, note?: string) {
  const wire: Record<string, unknown> = { to_state: toState };
  if (note !== undefined) wire.note = note;
  return writeJson(
    `/api/assurance/findings/${encodeURIComponent(uuid)}/remediation/transition/`,
    "POST",
    wire,
    mapRemediation,
  );
}

/**
 * Set or clear a finding's remediation assignee (Phase 2.3). `null` clears it.
 * Admin-only on the control plane and the BFF route. The backend refuses an
 * unknown user with a 400, passed back with its reason rather than a 503.
 */
export async function remediationAssign(uuid: string, assignee: string | null, note?: string) {
  const wire: Record<string, unknown> = { assignee };
  if (note !== undefined) wire.note = note;
  return writeJson(
    `/api/assurance/findings/${encodeURIComponent(uuid)}/remediation/assign/`,
    "POST",
    wire,
    mapRemediation,
  );
}
