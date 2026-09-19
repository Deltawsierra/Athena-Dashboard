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

/** One user a remediation assignment may target (Phase 2.3 assignable-users
 *  picker). `display` is the user's full name when set, the username otherwise. */
export interface AssuranceAssignableUser {
  username: string;
  display: string;
}
/** The scoped set of users a finding's remediation work may be assigned to,
 *  plus the current assignee. Mirrors the backend `assignable` action: active
 *  users only, ordered by username — the exact set the assign action accepts. */
export interface AssuranceAssignable {
  assignable: AssuranceAssignableUser[];
  current: string | null;
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

// ==== Third-Party Vendor Assurance (commercial spine) ====
//
// The posture of the vendors a deployment leans on. It runs no scan: it
// reconciles each vendor's graded assertions (the Provider Assurance Profile),
// the components that depend on it, and the ungoverned dependencies, into a
// per-vendor posture a procurement/third-party-risk reader can act on. HONEST by
// construction: a vendor claim reads as a vendor claim — an assertion is
// `independentlyEvidenced` only when backed by evidence stronger than a bare
// vendor claim AND from a non-self-declared source, otherwise it is carried at
// its true (vendor-asserted / self-attested) strength and counted a gap. Nothing
// is claimed secure: `postureBand` is an ordinal risk band (high/elevated/
// baseline) derived from the WEAKEST evidence, a concern signal, never a grade.

/** One declared vendor fact, evidence-graded, with its honest independence flag. */
export interface VendorAssertion {
  field: string;
  fieldLabel: string;
  value: string;
  evidenceClass: string;
  evidenceClassLabel: string;
  source: string;
  sourceLabel: string;
  /**
   * True ONLY when backed by evidence stronger than a bare vendor claim and from
   * a source that is not the vendor's own say-so. A vendor_asserted (or weaker)
   * class, or a self_declared source, is never independently evidenced.
   */
  independentlyEvidenced: boolean;
  /** A weak or self-attested fact is a gap — the profile's soft spot, surfaced. */
  gap: boolean;
}
/** A component that depends on a vendor. */
export interface VendorDependentAsset {
  assetName: string;
  kind: string;
  kindLabel: string;
  classification: string;
  classificationLabel: string;
  managed: boolean;
}
export interface Vendor {
  providerUuid: string;
  providerName: string;
  kind: string;
  kindLabel: string;
  region: string;
  assertions: VendorAssertion[];
  dependentAssets: VendorDependentAsset[];
  /** Human-readable gaps: weak/self-attested claims, unmanaged dependencies. */
  gaps: string[];
  /** The softest evidence class among the assertions, or null when none. */
  weakestEvidence: string | null;
  /** Ordinal risk band (high/elevated/baseline); a concern signal, never "secure". */
  postureBand: string;
  summary: {
    assertionCount: number;
    independentlyEvidenced: number;
    /** Assertions read as vendor-asserted / self-attested (a gap). */
    vendorAsserted: number;
    gapCount: number;
    dependentAssetCount: number;
    unmanagedDependencies: number;
  };
}
/** A dependency with no vendor behind it and/or an unmanaged (shadow) component. */
export interface UngovernedDependency {
  assetName: string;
  kind: string;
  kindLabel: string;
  classification: string;
  classificationLabel: string;
  /** "no_provider" | "no_provider_and_unmanaged" | "unmanaged". */
  reason: string;
}
export interface AssuranceVendorAssurance {
  vendors: Vendor[];
  ungovernedDependencies: UngovernedDependency[];
  summary: {
    vendors: number;
    assertionsTotal: number;
    assertionsByEvidenceStrength: Record<string, number>;
    independentlyEvidenced: number;
    vendorAsserted: number;
    gaps: number;
    providerLessDependencies: number;
    unmanagedDependencies: number;
    /** Most concerning band across vendors, or null when no vendors. */
    worstPostureBand: string | null;
  };
}

// ==== Executive Summary (commercial spine) ====
//
// The assurance graph rolled up for a leadership reader — asset coverage,
// evidence distribution, finding posture by severity, remediation velocity, the
// six-state decision, an ordinal posture and assurance-maturity band, and a
// headline from each sibling assessment. Every value is a real count, a TRUE
// ratio of two real counts, or an ordinal band. There is NO dollar figure, ROI
// amount, or realized-loss number anywhere, by design; a ratio the backend could
// not compute (a zero denominator) is carried as `null`, never a fake 0%. A
// resolved *remediation* is a process claim (someone called the work done),
// never the security disposition; nothing here says the system is secure.
export interface ExecutiveAssetCoverage {
  totalAssets: number;
  classified: number;
  managed: number;
  unknown: number;
  shadow: number;
  highRisk: number;
  byClassification: Record<string, number>;
  /** classified / total, or null when there are no assets (never a fake 0). */
  coverageRatio: number | null;
  /** managed / total, or null when there are no assets (never a fake 0). */
  managedRatio: number | null;
}
export interface ExecutiveEvidence {
  byClass: Record<string, number>;
  independentlyEvidenced: number;
  unverified: number;
  findingCount: number;
}
export interface ExecutiveFindings {
  total: number;
  active: number;
  resolved: number;
  activeBySeverity: Record<string, number>;
  worstActiveSeverity: string | null;
}
export interface ExecutiveRemediation {
  open: number;
  resolved: number;
  wontFix: number;
  byState: Record<string, number>;
  statesReached: string[];
  eventCount: number;
  /**
   * A PROCESS claim: resolved-in-workflow over all findings, or null when there
   * are no findings. NOT a security closure rate — a finding is securely closed
   * only through its status, which the decision already reflects.
   */
  resolutionRatio: number | null;
}
export interface ExecutiveAssessments {
  compliance: { controlsWithActiveFindings: number; worstSeverity: string | null };
  businessImpact: { dimensionsWithActiveExposure: number; worstExposureBand: string | null };
  capabilities: { highRisk: number; shadow: number };
  boundary: { declared: boolean; violations: number; unknowns: number; shadowDestinations: number };
  vendors: {
    vendors: number;
    gaps: number;
    worstPostureBand: string | null;
    independentlyEvidenced: number;
    vendorAsserted: number;
  };
}
export interface AssuranceExecutiveSummary {
  system: { name: string; uuid: string; environment: string; environmentLabel: string };
  /** The standing six-state decision, or null when none has been computed. */
  decision: { decision: string | null; decisionLabel: string | null };
  assetCoverage: ExecutiveAssetCoverage;
  evidence: ExecutiveEvidence;
  findings: ExecutiveFindings;
  remediation: ExecutiveRemediation;
  assessments: ExecutiveAssessments;
  /** Ordinal risk posture (high/elevated/baseline); never "secure". */
  posture: string;
  /** Ordinal assurance-maturity band; describes evidence coverage, never security. */
  assuranceMaturity: string;
}

// ==== Operational / continuous-assurance roll-up (commercial spine) ====
//
// Where a deployment sits in the continuous-assurance loop (Discover → Assess →
// Remediate → Retest → Monitor-change → Reassess), tying together the signals the
// rest of the spine already computes — evidence freshness/staleness, the change
// backlog needing reassessment, remediation velocity, and the standing six-state
// decision — under one ordinal readiness band. A REUSE-ONLY read: it re-derives
// nothing. HONEST by construction and never green-by-default: the readiness band
// is ordinal and weakest-wins (steady > attention > stale), an unassessed or empty
// deployment lands honestly in `stale` (never a clean pass), every ratio is `null`
// when there is no basis to compute it (never a fake 0%), the six-state decision is
// None-safe, and a resolved remediation is a PROCESS claim, never a security
// closure. There is no dollar figure or realized-loss number anywhere.
export interface AssuranceOperationalAssurance {
  system: { name: string; uuid: string; environment: string; environmentLabel: string };
  /** The standing six-state decision, or null when none has been computed. */
  decision: { decision: string | null; decisionLabel: string | null };
  evidenceFreshness: {
    total: number;
    /** Findings whose evidence was re-observed within the TTL. */
    current: number;
    /** Findings whose evidence has aged past the TTL — a retest is due. */
    stale: number;
    ttlDays: number;
    /** current / total, or null when there are no findings to age (never a fake 0). */
    freshnessRatio: number | null;
  };
  changeBacklog: {
    total: number;
    new: number;
    recurring: number;
    cleared: number;
    byStatus: Record<string, number>;
    /** new + cleared: what moved and so needs a fresh look (recurring is steady state). */
    needsReassessment: number;
    /** needsReassessment / total, or null when there are no findings (never a fake 0). */
    needsReassessmentRatio: number | null;
  };
  /** Remediation velocity, reused wholesale from the workflow roll-up — same shape
   *  as the executive summary's. A resolved state is a PROCESS claim (work called
   *  done), never a security closure. */
  remediation: ExecutiveRemediation;
  /** Ordinal operational-readiness band (steady/attention/stale), weakest-wins.
   *  Describes the assurance loop, never that the system is healthy or secure. */
  readiness: string;
  summary: {
    totalFindings: number;
    currentEvidence: number;
    staleEvidence: number;
    freshnessRatio: number | null;
    needsReassessment: number;
    needsReassessmentRatio: number | null;
    openRemediation: number;
    resolvedRemediation: number;
    decision: string | null;
    readiness: string;
  };
}

// ==== Vertical Assurance Packs (commercial spine) ====
//
// A pack is a curated, code-only catalog entry read through an industry lens: the
// control frameworks it emphasizes (identifiers the compliance map already
// defines), the regulatory regimes it targets, and the evidence a buyer in that
// vertical expects. Applying a pack filters the compliance map to those
// frameworks — it computes no new controls. HONEST about the difference between a
// framework we compute and a regime we do not: a pack's `regulatoryRegimes` are
// carried as CONTEXT, each with a note that Athena holds no control catalog for
// it, and never as scored coverage; and a touched control is an open gap, never
// "passed" or "compliant".

/** The catalog view of one pack (identity, emphasized frameworks, regimes). */
export interface AssurancePack {
  key: string;
  name: string;
  vertical: string;
  description: string;
  /** The framework identifiers this pack emphasizes (kept verbatim). */
  frameworks: string[];
  /** Framework id → display name, for the emphasized frameworks. */
  frameworkNames: Record<string, string>;
  /** The regulatory regimes this vertical answers to — context, not coverage. */
  regulatoryRegimes: string[];
  evidenceExpectations: string[];
}
export interface AssurancePacksCatalog {
  packs: AssurancePack[];
  summary: { packs: number };
}
/**
 * A regulatory regime carried as CONTEXT, never computed coverage. The note is
 * kept verbatim — it is the "not computed coverage" disclaimer that must be
 * rendered so a reader never mistakes the regime for scored/passing coverage.
 */
export interface RegulatoryRegime {
  name: string;
  note: string;
}
export interface AssurancePackApplied {
  pack: AssurancePack;
  /** The emphasized frameworks' compliance slices, verbatim (a touched control
   *  is an open gap, carried through unchanged — never "passed"). */
  frameworks: ComplianceFramework[];
  regulatoryRegimes: RegulatoryRegime[];
  summary: {
    frameworksEmphasized: number;
    controlsTouched: number;
    controlsWithActiveFindings: number;
    worstSeverity: string | null;
    totalFindings: number;
    activeFindings: number;
    resolvedFindings: number;
    unmappedFindingTypes: number;
  };
}

// ==== Identity Assurance & Effective Access (Phase 3.1) ====
//
// The honest inventory of a deployment's PRINCIPALS — the identities that can act
// (service accounts, agents, and the app/model surface itself) — and what each can
// effectively REACH, by direct and transitive paths through the asset graph. A
// computed read, never stored. It never claims least privilege is satisfied or an
// identity is secure: it reports powers, transitive reach, and gaps only. A shadow
// (unmanaged) principal reads as shadow with its risk raised; a transitive path is
// reported only where a declared edge evidences every hop, never invented.

/** One source that grants a principal a held capability: the component and the
 *  declared permission string that attests it. */
export interface AccessCapabilitySource {
  assetName: string;
  permission: string;
}
/** A sensitive capability a principal wields, via its own or a reached tool's
 *  declared permissions. `risk` is the capability's ordinal band. */
export interface AccessCapability {
  key: string;
  label: string;
  category: string;
  risk: string;
  sources: AccessCapabilitySource[];
}
/**
 * One thing a principal can effectively reach: a concrete component (a data store,
 * an MCP server, a tool) or a capability-power. `via` is the declared path the
 * reach followed, hop by hop — evidenced, never invented. `targetClassification`
 * is null for a capability-power reach.
 */
export interface AccessReach {
  target: string;
  targetKind: string;
  targetKindLabel: string;
  targetClassification: string | null;
  targetManaged: boolean;
  via: string[];
  capability: string;
  risk: string;
}
/** An identity-assurance gap surfaced on a principal (privileged access, over-broad
 *  reach, shadow identity, ungoverned reach, orphaned). Its ordinal `risk`, a human
 *  `detail`, and the type-specific arrays the backend carried. */
export interface AccessGap {
  type: string;
  risk: string;
  detail: string;
  capabilities?: string[];
  categories?: string[];
  targets?: string[];
}
/** One principal: an identity that can act, its held capabilities, effective reach,
 *  identity-assurance gaps, and an honest risk band. `classification` is null for
 *  the deployment's own app/model base principal. */
export interface AccessPrincipal {
  key: string;
  name: string;
  kind: string;
  kindLabel: string;
  classification: string | null;
  classificationLabel: string | null;
  managed: boolean;
  shadow: boolean;
  /** "high" | "elevated" | "standard" — derived from the sensitive powers held. */
  privilegeLevel: string;
  capabilities: AccessCapability[];
  effectiveReach: AccessReach[];
  gaps: AccessGap[];
  risk: string;
  // Convenience flags the summary rolls up (concern signals, never a "pass").
  privileged: boolean;
  overBroad: boolean;
  orphaned: boolean;
}
export interface AssuranceEffectiveAccess {
  principals: AccessPrincipal[];
  summary: {
    principals: number;
    privileged: number;
    shadow: number;
    orphaned: number;
    overBroad: number;
    highRiskReach: number;
    /** Most concerning risk across principals, or null when there are none. */
    worstRisk: string | null;
  };
}

// ==== Ripple Effect / blast radius (Phase 2.5) ====
//
// For each origin worth tracing — an active high/critical finding tied to a
// component, or a privileged / high-risk principal — a FEW WELL-SUPPORTED
// downstream consequences a compromise of it could have, each tied to the evidenced
// path that supports it. Reads only the effective-access reach graph and the data
// boundary, so it re-derives no reachability. Every consequence is potential and
// evidence-based, never a realized harm or a monetary figure; the list is ranked
// and bounded to the well-supported core, and the full evidenced count is reported
// so the bounding is visible. An origin with no evidenced downstream reach reads
// honestly as such, never as safe or contained.

export interface RippleFinding {
  uuid: string;
  findingType: string;
  severity: string;
  title: string;
}
export interface RippleOrigin {
  key: string;
  origin: string;
  originTypes: string[];
  reasons: string[];
  risk: string;
  findings: RippleFinding[];
  // Present when the origin is (also) a principal.
  principalKind?: string;
  principalKindLabel?: string;
  privilegeLevel?: string;
  /** Whether the origin has any evidenced downstream reach. False is NOT "safe". */
  evidencedReach: boolean;
  consequenceCount: number;
  /** The honest note carried when there is no evidenced downstream reach. */
  note: string | null;
}
export interface RippleConsequence {
  origin: string;
  originKey: string;
  consequence: string;
  category: string;
  categoryLabel: string;
  target: string;
  targets: string[];
  via: string[];
  risk: string;
  /** Always true — a potential effect, never a realized harm. */
  potential: boolean;
  evidenceBasis: string[];
}
export interface AssuranceRippleEffect {
  origins: RippleOrigin[];
  consequences: RippleConsequence[];
  summary: {
    origins: number;
    originsWithReach: number;
    consequences: number;
    /** The full evidenced count before bounding — the bounding is visible. */
    evidencedConsequences: number;
    bounded: boolean;
    byCategory: Record<string, number>;
    worstRisk: string | null;
  };
}

// ==== Credential-gated posture (Phase 3.2 / 3.3 / 3.4) ====
//
// The three posture domains — cloud, secrets, repo — read a customer's cloud
// account, secret store, or source-control/CI through credentials the customer
// grants. INERT BY DEFAULT: with no configured credentials a domain makes no fetch
// and returns `{connected: false, ...}` with the catalog of checks it WOULD run.
// An inert domain reads as "not connected", never "all clear". When connected, a
// `pass` is the observed absence of one gap, never a claim the system is secure.

/** The posture catalog: which domains exist and whether each is configured. */
export interface PostureDomainRef {
  name: string;
  label: string;
  configured: boolean;
}
export interface AssurancePostureCatalog {
  domains: PostureDomainRef[];
}
/** One curated check as it appears in the catalog (no result — safe to show even
 *  when the domain is inert). */
export interface PostureCheckCatalog {
  check: string;
  title: string;
  severity: string;
  category: string;
  resource: string;
  description: string;
}
/** The honest answer to one check over observed data. `evidenceClass` reflects HOW
 *  it was determined (configuration- vs technically-verified). */
export interface PostureFinding {
  check: string;
  title: string;
  /** "pass" | "gap" | "unknown". */
  status: string;
  severity: string;
  evidenceClass: string;
  evidenceClassLabel: string;
  detail: string;
  resource: string;
  category: string;
}
export interface AssurancePostureDomain {
  domain: string;
  domainLabel: string;
  connected: boolean;
  /** The "not configured" reason on an inert domain; null when connected. */
  detail: string | null;
  checks: PostureCheckCatalog[];
  findings: PostureFinding[];
  summary: {
    connected: boolean;
    planned: number;
    total: number;
    pass: number;
    gap: number;
    unknown: number;
    gapsBySeverity: Record<string, number>;
    maxRisk: string;
    /** The weakest evidence behind any finding — present only when connected. */
    weakestEvidence: string | null;
  };
}

// ==== Personal Context Exposure (Phase 3.5) ====
//
// What personal / customer data the deployment holds, in which data-bearing
// components, and which principals can reach it. Reuses the effective-access reach
// graph and the data boundary. An UNCLASSIFIED data store reads as UNKNOWN
// (personal-data exposure cannot be ruled out), never "no PII". No data value is
// ever emitted.

/** A principal that can reach a data store, read from the evidenced reach graph. */
export interface PersonalReader {
  principal: string;
  principalKind: string;
  principalKindLabel: string;
  privilegeLevel: string;
  shadow: boolean;
  overBroad: boolean;
  risk: string;
  via: string[];
}
/** A personal-context gap. The roll-up variant also carries `assetName`. */
export interface PersonalGap {
  type: string;
  risk: string;
  detail: string;
  principals?: string[];
  assetName?: string;
}
export interface PersonalStore {
  assetName: string;
  kind: string;
  kindLabel: string;
  identifier: string;
  classification: string;
  classificationLabel: string;
  managed: boolean;
  providerName: string | null;
  /** "personal" | "unknown" | ... — "unknown" is not "no PII". */
  dataSensitivity: string;
  personalData: boolean;
  signals: string[];
  evidenceClass: string;
  evidenceClassLabel: string;
  reachableBy: PersonalReader[];
  readerCount: number;
  gaps: PersonalGap[];
  risk: string;
}
export interface AssurancePersonalContext {
  stores: PersonalStore[];
  gaps: PersonalGap[];
  summary: {
    dataBearingComponents: number;
    personalDataComponents: number;
    unclassifiedComponents: number;
    reachableByShadow: number;
    reachableByOverBroad: number;
    crossingBoundary: number;
    gaps: number;
    worstRisk: string | null;
  };
}

// ==== Data Lifecycle Review (Phase 3.5) ====
//
// The lifecycle stages evidenced in the graph — collected, transmitted, processed,
// logged, retained, reused, deleted — the components that evidence each (at their
// true evidence strength), and the gaps where a stage has no evidenced control. An
// UNEVIDENCED stage reads "not evidenced", never "compliant"; a weakly-evidenced
// (vendor-asserted) control is still a gap.

export interface LifecycleComponent {
  name: string;
  kindLabel: string;
  how: string;
  evidenceClass: string;
  evidenceClassLabel: string;
}
export interface LifecycleStage {
  stage: string;
  stageLabel: string;
  /** A control stage (logged/retained/reused/deleted) vs a flow stage. */
  controlStage: boolean;
  evidenced: boolean;
  components: LifecycleComponent[];
  /** The weakest evidence behind the stage, or null when unevidenced. */
  weakestEvidence: string | null;
  weakestEvidenceLabel: string | null;
  gap: boolean;
  gapDetail: string | null;
  risk: string;
}
export interface LifecycleGap {
  stage: string;
  stageLabel: string;
  risk: string;
  detail: string;
}
export interface AssuranceDataLifecycle {
  stages: LifecycleStage[];
  gaps: LifecycleGap[];
  summary: {
    stagesTotal: number;
    evidenced: number;
    notEvidenced: number;
    controlGaps: number;
    worstRisk: string | null;
  };
}

// ==== Training / Reuse Review (Phase 3.5) ====
//
// Whether customer / internal data is reused for training, sharing or retention —
// VERIFIED vs merely ASSERTED — per provider, each posture carried at its true
// evidence class. A vendor_asserted "we don't train on your data" reads as
// vendor-asserted, never verified; an unstated reuse policy is a gap (reuse cannot
// be ruled out), never "safe".

export interface ReusePosture {
  field: string;
  fieldLabel: string;
  concern: string;
  value: string;
  /** "reused" | "not_reused" | "unknown". */
  posture: string;
  evidenceClass: string;
  evidenceClassLabel: string;
  source: string;
  sourceLabel: string;
  /** True ONLY when independently evidenced — a vendor claim never upgrades. */
  verified: boolean;
}
export interface TrainingDependentAsset {
  assetName: string;
  kind: string;
  kindLabel: string;
  classification: string;
  classificationLabel: string;
  managed: boolean;
}
export interface TrainingGap {
  type: string;
  field: string;
  risk: string;
  detail: string;
  providerName?: string;
}
export interface TrainingProvider {
  providerUuid: string;
  providerName: string;
  kind: string;
  kindLabel: string;
  dependentAssets: TrainingDependentAsset[];
  postures: ReusePosture[];
  reusePossible: boolean;
  reuseDeclared: boolean;
  gaps: TrainingGap[];
  risk: string;
}
export interface AssuranceTrainingReuse {
  providers: TrainingProvider[];
  gaps: TrainingGap[];
  summary: {
    providers: number;
    reuseDeclared: number;
    reusePossible: number;
    verifiedNoReuse: number;
    gaps: number;
    worstRisk: string | null;
  };
}

// ==== Metadata & Logging Risk (Phase 3.5) ====
//
// Where prompts / traces / embeddings / metadata get logged, what sensitive
// categories could reach those sinks, and the gaps where sensitive data is logged
// with no evidenced control. NO sensitive value is ever emitted — only the presence
// of a category and its lineage; an unknown reads unknown.

export interface LogCategory {
  category: string;
  label: string;
  basis: string;
}
export interface MetadataGap {
  type: string;
  risk: string;
  detail: string;
  assetName?: string;
}
export interface LogSink {
  assetName: string;
  kind: string;
  kindLabel: string;
  identifier: string;
  classification: string;
  classificationLabel: string;
  managed: boolean;
  providerName: string | null;
  basis: string;
  evidenceClass: string;
  evidenceClassLabel: string;
  sensitiveCategories: LogCategory[];
  controlEvidenced: boolean;
  controlDetail: string | null;
  gaps: MetadataGap[];
  risk: string;
}
export interface HandledCategory {
  category: string;
  basis: string;
  label: string;
}
export interface AssuranceMetadataLogging {
  sinks: LogSink[];
  sensitiveCategoriesHandled: HandledCategory[];
  gaps: MetadataGap[];
  summary: {
    sinks: number;
    shadowSinks: number;
    sinksWithoutControl: number;
    sensitiveCategoriesHandled: number;
    gaps: number;
    worstRisk: string | null;
  };
}

// ==== Mappers ====

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
/**
 * A number carried as a number, or null when the backend emitted null. Distinct
 * from `num`: a ratio the backend reports as `null` means "no basis to compute"
 * (a zero denominator), and must never be laundered into a fake 0 (0%). Anything
 * that is not a number becomes null.
 */
const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
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

/** A {string: number} passthrough. Alias of numRecord, named for the vendor
 *  evidence-strength / by-class / by-state distributions the roll-ups carry. */
const countRecord = numRecord;

function vendorAssertion(raw: Record<string, unknown>): VendorAssertion {
  return {
    field: str(raw.field),
    fieldLabel: str(raw.field_label),
    value: str(raw.value),
    evidenceClass: str(raw.evidence_class),
    evidenceClassLabel: str(raw.evidence_class_label),
    source: str(raw.source),
    sourceLabel: str(raw.source_label),
    // Honesty flags carried at their true strength — never inferred or promoted.
    independentlyEvidenced: bool(raw.independently_evidenced),
    gap: bool(raw.gap),
  };
}

function vendorDependentAsset(raw: Record<string, unknown>): VendorDependentAsset {
  return {
    assetName: str(raw.asset_name),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    classification: str(raw.classification),
    classificationLabel: str(raw.classification_label),
    managed: bool(raw.managed),
  };
}

function vendor(raw: Record<string, unknown>): Vendor {
  const rawSummary =
    raw.summary && typeof raw.summary === "object" && !Array.isArray(raw.summary)
      ? (raw.summary as Record<string, unknown>)
      : {};
  return {
    providerUuid: str(raw.provider_uuid),
    providerName: str(raw.provider_name),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    region: str(raw.region),
    assertions: Array.isArray(raw.assertions)
      ? (raw.assertions as Record<string, unknown>[]).map(vendorAssertion)
      : [],
    dependentAssets: Array.isArray(raw.dependent_assets)
      ? (raw.dependent_assets as Record<string, unknown>[]).map(vendorDependentAsset)
      : [],
    gaps: strList(raw.gaps),
    // The band string is kept verbatim; a null weakest-evidence carries as null.
    weakestEvidence: strOrNull(raw.weakest_evidence),
    postureBand: str(raw.posture_band),
    summary: {
      assertionCount: num(rawSummary.assertion_count, 0),
      independentlyEvidenced: num(rawSummary.independently_evidenced, 0),
      vendorAsserted: num(rawSummary.vendor_asserted, 0),
      gapCount: num(rawSummary.gap_count, 0),
      dependentAssetCount: num(rawSummary.dependent_asset_count, 0),
      unmanagedDependencies: num(rawSummary.unmanaged_dependencies, 0),
    },
  };
}

function mapVendorAssurance(raw: Record<string, unknown>): AssuranceVendorAssurance {
  const rawSummary =
    raw.summary && typeof raw.summary === "object" && !Array.isArray(raw.summary)
      ? (raw.summary as Record<string, unknown>)
      : {};
  return {
    vendors: Array.isArray(raw.vendors)
      ? (raw.vendors as Record<string, unknown>[]).map(vendor)
      : [],
    ungovernedDependencies: Array.isArray(raw.ungoverned_dependencies)
      ? (raw.ungoverned_dependencies as Record<string, unknown>[]).map((u) => ({
          assetName: str(u.asset_name),
          kind: str(u.kind),
          kindLabel: str(u.kind_label),
          classification: str(u.classification),
          classificationLabel: str(u.classification_label),
          reason: str(u.reason),
        }))
      : [],
    summary: {
      vendors: num(rawSummary.vendors, 0),
      assertionsTotal: num(rawSummary.assertions_total, 0),
      assertionsByEvidenceStrength: countRecord(rawSummary.assertions_by_evidence_strength),
      independentlyEvidenced: num(rawSummary.independently_evidenced, 0),
      vendorAsserted: num(rawSummary.vendor_asserted, 0),
      gaps: num(rawSummary.gaps, 0),
      providerLessDependencies: num(rawSummary.provider_less_dependencies, 0),
      unmanagedDependencies: num(rawSummary.unmanaged_dependencies, 0),
      // The worst band is null when there are no vendors — carried, not coerced.
      worstPostureBand: strOrNull(rawSummary.worst_posture_band),
    },
  };
}

function mapExecutiveSummary(raw: Record<string, unknown>): AssuranceExecutiveSummary {
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const system = obj(raw.system);
  const decision = obj(raw.decision);
  const coverage = obj(raw.asset_coverage);
  const evidence = obj(raw.evidence);
  const findings = obj(raw.findings);
  const remediation = obj(raw.remediation);
  const assessments = obj(raw.assessments);
  const aCompliance = obj(assessments.compliance);
  const aImpact = obj(assessments.business_impact);
  const aCapabilities = obj(assessments.capabilities);
  const aBoundary = obj(assessments.boundary);
  const aVendors = obj(assessments.vendors);
  return {
    system: {
      name: str(system.name),
      uuid: str(system.uuid),
      environment: str(system.environment),
      environmentLabel: str(system.environment_label),
    },
    decision: {
      // None-safe: an unassessed deployment has no decision; never read as ready.
      decision: strOrNull(decision.decision),
      decisionLabel: strOrNull(decision.decision_label),
    },
    assetCoverage: {
      totalAssets: num(coverage.total_assets, 0),
      classified: num(coverage.classified, 0),
      managed: num(coverage.managed, 0),
      unknown: num(coverage.unknown, 0),
      shadow: num(coverage.shadow, 0),
      highRisk: num(coverage.high_risk, 0),
      byClassification: countRecord(coverage.by_classification),
      // Ratios carried as null when there is no basis to compute — never a 0.
      coverageRatio: numOrNull(coverage.coverage_ratio),
      managedRatio: numOrNull(coverage.managed_ratio),
    },
    evidence: {
      byClass: countRecord(evidence.by_class),
      independentlyEvidenced: num(evidence.independently_evidenced, 0),
      unverified: num(evidence.unverified, 0),
      findingCount: num(evidence.finding_count, 0),
    },
    findings: {
      total: num(findings.total, 0),
      active: num(findings.active, 0),
      resolved: num(findings.resolved, 0),
      activeBySeverity: countRecord(findings.active_by_severity),
      worstActiveSeverity: strOrNull(findings.worst_active_severity),
    },
    remediation: {
      open: num(remediation.open, 0),
      resolved: num(remediation.resolved, 0),
      wontFix: num(remediation.wont_fix, 0),
      byState: countRecord(remediation.by_state),
      statesReached: strList(remediation.states_reached),
      eventCount: num(remediation.event_count, 0),
      // A process claim, null when there are no findings — never a fake rate.
      resolutionRatio: numOrNull(remediation.resolution_ratio),
    },
    assessments: {
      compliance: {
        controlsWithActiveFindings: num(aCompliance.controls_with_active_findings, 0),
        worstSeverity: strOrNull(aCompliance.worst_severity),
      },
      businessImpact: {
        dimensionsWithActiveExposure: num(aImpact.dimensions_with_active_exposure, 0),
        worstExposureBand: strOrNull(aImpact.worst_exposure_band),
      },
      capabilities: {
        highRisk: num(aCapabilities.high_risk, 0),
        shadow: num(aCapabilities.shadow, 0),
      },
      boundary: {
        declared: bool(aBoundary.declared),
        violations: num(aBoundary.violations, 0),
        unknowns: num(aBoundary.unknowns, 0),
        shadowDestinations: num(aBoundary.shadow_destinations, 0),
      },
      vendors: {
        vendors: num(aVendors.vendors, 0),
        gaps: num(aVendors.gaps, 0),
        worstPostureBand: strOrNull(aVendors.worst_posture_band),
        independentlyEvidenced: num(aVendors.independently_evidenced, 0),
        vendorAsserted: num(aVendors.vendor_asserted, 0),
      },
    },
    posture: str(raw.posture),
    assuranceMaturity: str(raw.assurance_maturity),
  };
}

function mapOperationalAssurance(raw: Record<string, unknown>): AssuranceOperationalAssurance {
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const system = obj(raw.system);
  const decision = obj(raw.decision);
  const freshness = obj(raw.evidence_freshness);
  const backlog = obj(raw.change_backlog);
  const remediation = obj(raw.remediation);
  const summary = obj(raw.summary);
  return {
    system: {
      name: str(system.name),
      uuid: str(system.uuid),
      environment: str(system.environment),
      environmentLabel: str(system.environment_label),
    },
    decision: {
      // None-safe: an unassessed deployment has no decision; never read as ready.
      decision: strOrNull(decision.decision),
      decisionLabel: strOrNull(decision.decision_label),
    },
    evidenceFreshness: {
      total: num(freshness.total, 0),
      current: num(freshness.current, 0),
      stale: num(freshness.stale, 0),
      ttlDays: num(freshness.ttl_days, 0),
      // Null when there are no findings to age — never a fabricated 0%.
      freshnessRatio: numOrNull(freshness.freshness_ratio),
    },
    changeBacklog: {
      total: num(backlog.total, 0),
      new: num(backlog.new, 0),
      recurring: num(backlog.recurring, 0),
      cleared: num(backlog.cleared, 0),
      byStatus: countRecord(backlog.by_status),
      needsReassessment: num(backlog.needs_reassessment, 0),
      // Null when there are no findings — never a fabricated 0%.
      needsReassessmentRatio: numOrNull(backlog.needs_reassessment_ratio),
    },
    remediation: {
      open: num(remediation.open, 0),
      resolved: num(remediation.resolved, 0),
      wontFix: num(remediation.wont_fix, 0),
      byState: countRecord(remediation.by_state),
      statesReached: strList(remediation.states_reached),
      eventCount: num(remediation.event_count, 0),
      // A process claim, null when there are no findings — never a fake rate.
      resolutionRatio: numOrNull(remediation.resolution_ratio),
    },
    readiness: str(raw.readiness),
    summary: {
      totalFindings: num(summary.total_findings, 0),
      currentEvidence: num(summary.current_evidence, 0),
      staleEvidence: num(summary.stale_evidence, 0),
      freshnessRatio: numOrNull(summary.freshness_ratio),
      needsReassessment: num(summary.needs_reassessment, 0),
      needsReassessmentRatio: numOrNull(summary.needs_reassessment_ratio),
      openRemediation: num(summary.open_remediation, 0),
      resolvedRemediation: num(summary.resolved_remediation, 0),
      // None-safe here too: an unassessed deployment carries a null decision.
      decision: strOrNull(summary.decision),
      readiness: str(summary.readiness),
    },
  };
}

/** One pack's catalog view, snake→camel. Framework identifiers and their names
 *  are kept verbatim — they are the compliance map's own identifiers. */
function packView(raw: Record<string, unknown>): AssurancePack {
  const names =
    raw.framework_names && typeof raw.framework_names === "object" && !Array.isArray(raw.framework_names)
      ? (raw.framework_names as Record<string, unknown>)
      : {};
  const frameworkNames: Record<string, string> = {};
  for (const [k, v] of Object.entries(names)) {
    if (typeof v === "string") frameworkNames[k] = v;
  }
  return {
    key: str(raw.key),
    name: str(raw.name),
    vertical: str(raw.vertical),
    description: str(raw.description),
    frameworks: strList(raw.frameworks),
    frameworkNames,
    regulatoryRegimes: strList(raw.regulatory_regimes),
    evidenceExpectations: strList(raw.evidence_expectations),
  };
}

function mapAssurancePacks(raw: Record<string, unknown>): AssurancePacksCatalog {
  const rawSummary =
    raw.summary && typeof raw.summary === "object" && !Array.isArray(raw.summary)
      ? (raw.summary as Record<string, unknown>)
      : {};
  return {
    packs: Array.isArray(raw.packs)
      ? (raw.packs as Record<string, unknown>[]).map(packView)
      : [],
    summary: { packs: num(rawSummary.packs, 0) },
  };
}

/** One compliance framework slice (key, name, controls, summary), snake→camel.
 *  The same shape mapCompliance builds inline; reused for the pack view, whose
 *  frameworks are the compliance map's own slices, filtered to the pack. A
 *  touched control is carried through unchanged — an open gap, never "passed". */
function complianceFrameworkSlice(f: Record<string, unknown>): ComplianceFramework {
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
}

function mapAssurancePack(raw: Record<string, unknown>): AssurancePackApplied {
  const rawPack =
    raw.pack && typeof raw.pack === "object" && !Array.isArray(raw.pack)
      ? (raw.pack as Record<string, unknown>)
      : {};
  const rawSummary =
    raw.summary && typeof raw.summary === "object" && !Array.isArray(raw.summary)
      ? (raw.summary as Record<string, unknown>)
      : {};
  return {
    pack: packView(rawPack),
    frameworks: Array.isArray(raw.frameworks)
      ? (raw.frameworks as Record<string, unknown>[]).map(complianceFrameworkSlice)
      : [],
    // Each regime carries its "not computed coverage" note VERBATIM, so a
    // consumer never renders it as scored/passing coverage.
    regulatoryRegimes: Array.isArray(raw.regulatory_regimes)
      ? (raw.regulatory_regimes as Record<string, unknown>[]).map((r) => ({
          name: str(r.name),
          note: str(r.note),
        }))
      : [],
    summary: {
      frameworksEmphasized: num(rawSummary.frameworks_emphasized, 0),
      controlsTouched: num(rawSummary.controls_touched, 0),
      controlsWithActiveFindings: num(rawSummary.controls_with_active_findings, 0),
      worstSeverity: strOrNull(rawSummary.worst_severity),
      totalFindings: num(rawSummary.total_findings, 0),
      activeFindings: num(rawSummary.active_findings, 0),
      resolvedFindings: num(rawSummary.resolved_findings, 0),
      unmappedFindingTypes: num(rawSummary.unmapped_finding_types, 0),
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
  // The Django remediation endpoints name the workflow field `remediation_state`
  // /`remediation_state_label` (see assurance/views.py `remediation`,
  // `remediation_transition`, `remediation_assign` — a finding has both a
  // security `status` and a remediation state, so the field is qualified). The
  // GET read returns the full history under `events` (an array); the
  // transition/assign actions return the one move they made under `event` (a
  // single object) and omit the fields they did not touch — transition returns no
  // `assignee`, assign returns no state. This maps whichever fields are present,
  // so each response is surfaced honestly rather than crashing or fabricating.
  const events = Array.isArray(raw.events)
    ? (raw.events as Record<string, unknown>[])
    : raw.event && typeof raw.event === "object" && !Array.isArray(raw.event)
      ? [raw.event as Record<string, unknown>]
      : [];
  return {
    state: str(raw.remediation_state),
    stateLabel: str(raw.remediation_state_label),
    assignee: raw.assignee == null ? null : String(raw.assignee),
    events: events.map(remediationEvent),
  };
}

function mapAssignable(raw: Record<string, unknown>): AssuranceAssignable {
  // The backend `assignable` action (assurance/views.py) returns
  // `{assignable: [{username, display}], current: <username|null>}`. Map each
  // row defensively so a malformed entry surfaces as empty strings rather than
  // crashing the picker.
  const rows = Array.isArray(raw.assignable)
    ? (raw.assignable as Record<string, unknown>[])
    : [];
  return {
    assignable: rows.map((row) => ({
      username: str(row.username),
      display: str(row.display),
    })),
    current: strOrNull(raw.current),
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

// ==== Phase 3 + 2.5 assessment mappers ====

/** A nested object, or `{}` when the value is not a plain object. */
function objOf(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * The parsed body of a read that the mappers expect to be a JSON object, or a
 * thrown `ControlPlaneUnavailable`. Every read below checks `response.ok` first,
 * so by here the status is 2xx; but a `200` carrying `null`, a primitive, or an
 * array is not the object the mapper will index into — casting it and reading a
 * key throws a `TypeError` that surfaces as a generic 500. Treating a non-object
 * body as unavailability routes it to the honest 503 "control plane
 * unavailable" path instead.
 */
async function readObject(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ControlPlaneUnavailable(
      "the Athena control plane returned a body that was not a JSON object",
    );
  }
  return payload as Record<string, unknown>;
}

/** The optional string arrays a gap dict may carry, mapped verbatim when present.
 *  Absent keys stay absent so a gap never gains an invented empty array. */
function gapExtras(raw: Record<string, unknown>): {
  capabilities?: string[];
  categories?: string[];
  targets?: string[];
  principals?: string[];
} {
  const out: { capabilities?: string[]; categories?: string[]; targets?: string[]; principals?: string[] } = {};
  if (Array.isArray(raw.capabilities)) out.capabilities = strList(raw.capabilities);
  if (Array.isArray(raw.categories)) out.categories = strList(raw.categories);
  if (Array.isArray(raw.targets)) out.targets = strList(raw.targets);
  if (Array.isArray(raw.principals)) out.principals = strList(raw.principals);
  return out;
}

function accessCapability(raw: Record<string, unknown>): AccessCapability {
  return {
    key: str(raw.key),
    label: str(raw.label),
    category: str(raw.category),
    risk: str(raw.risk),
    sources: Array.isArray(raw.sources)
      ? (raw.sources as Record<string, unknown>[]).map((s) => ({
          assetName: str(s.asset_name),
          permission: str(s.permission),
        }))
      : [],
  };
}

function accessReach(raw: Record<string, unknown>): AccessReach {
  return {
    target: str(raw.target),
    targetKind: str(raw.target_kind),
    targetKindLabel: str(raw.target_kind_label),
    // Null for a capability-power reach — carried honestly, never "".
    targetClassification: strOrNull(raw.target_classification),
    targetManaged: bool(raw.target_managed),
    via: strList(raw.via),
    capability: str(raw.capability),
    risk: str(raw.risk),
  };
}

function accessPrincipal(raw: Record<string, unknown>): AccessPrincipal {
  return {
    key: str(raw.key),
    name: str(raw.name),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    // Null for the deployment's own app/model base principal.
    classification: strOrNull(raw.classification),
    classificationLabel: strOrNull(raw.classification_label),
    managed: bool(raw.managed),
    shadow: bool(raw.shadow),
    privilegeLevel: str(raw.privilege_level),
    capabilities: Array.isArray(raw.capabilities)
      ? (raw.capabilities as Record<string, unknown>[]).map(accessCapability)
      : [],
    effectiveReach: Array.isArray(raw.effective_reach)
      ? (raw.effective_reach as Record<string, unknown>[]).map(accessReach)
      : [],
    gaps: Array.isArray(raw.gaps)
      ? (raw.gaps as Record<string, unknown>[]).map((g) => ({
          type: str(g.type),
          risk: str(g.risk),
          detail: str(g.detail),
          ...gapExtras(g),
        }))
      : [],
    risk: str(raw.risk),
    privileged: bool(raw.privileged),
    overBroad: bool(raw.over_broad),
    orphaned: bool(raw.orphaned),
  };
}

function mapEffectiveAccess(raw: Record<string, unknown>): AssuranceEffectiveAccess {
  const summary = objOf(raw.summary);
  return {
    principals: Array.isArray(raw.principals)
      ? (raw.principals as Record<string, unknown>[]).map(accessPrincipal)
      : [],
    summary: {
      principals: num(summary.principals, 0),
      privileged: num(summary.privileged, 0),
      shadow: num(summary.shadow, 0),
      orphaned: num(summary.orphaned, 0),
      overBroad: num(summary.over_broad, 0),
      highRiskReach: num(summary.high_risk_reach, 0),
      worstRisk: strOrNull(summary.worst_risk),
    },
  };
}

function rippleOrigin(raw: Record<string, unknown>): RippleOrigin {
  const out: RippleOrigin = {
    key: str(raw.key),
    origin: str(raw.origin),
    originTypes: strList(raw.origin_types),
    reasons: strList(raw.reasons),
    risk: str(raw.risk),
    findings: Array.isArray(raw.findings)
      ? (raw.findings as Record<string, unknown>[]).map((f) => ({
          uuid: str(f.uuid),
          findingType: str(f.finding_type),
          severity: str(f.severity),
          title: str(f.title),
        }))
      : [],
    evidencedReach: bool(raw.evidenced_reach),
    consequenceCount: num(raw.consequence_count, 0),
    // The honest "no evidenced downstream reach" note, when present.
    note: strOrNull(raw.note),
  };
  // Principal fields ride along only when the origin is (also) a principal.
  if (typeof raw.principal_kind === "string") out.principalKind = raw.principal_kind;
  if (typeof raw.principal_kind_label === "string") out.principalKindLabel = raw.principal_kind_label;
  if (typeof raw.privilege_level === "string") out.privilegeLevel = raw.privilege_level;
  return out;
}

function rippleConsequence(raw: Record<string, unknown>): RippleConsequence {
  return {
    origin: str(raw.origin),
    originKey: str(raw.origin_key),
    consequence: str(raw.consequence),
    category: str(raw.category),
    categoryLabel: str(raw.category_label),
    target: str(raw.target),
    targets: strList(raw.targets),
    via: strList(raw.via),
    risk: str(raw.risk),
    potential: bool(raw.potential),
    evidenceBasis: strList(raw.evidence_basis),
  };
}

function mapRippleEffect(raw: Record<string, unknown>): AssuranceRippleEffect {
  const summary = objOf(raw.summary);
  return {
    origins: Array.isArray(raw.origins)
      ? (raw.origins as Record<string, unknown>[]).map(rippleOrigin)
      : [],
    consequences: Array.isArray(raw.consequences)
      ? (raw.consequences as Record<string, unknown>[]).map(rippleConsequence)
      : [],
    summary: {
      origins: num(summary.origins, 0),
      originsWithReach: num(summary.origins_with_reach, 0),
      consequences: num(summary.consequences, 0),
      evidencedConsequences: num(summary.evidenced_consequences, 0),
      bounded: bool(summary.bounded),
      byCategory: numRecord(summary.by_category),
      worstRisk: strOrNull(summary.worst_risk),
    },
  };
}

function mapPostureCatalog(raw: Record<string, unknown>): AssurancePostureCatalog {
  return {
    domains: Array.isArray(raw.domains)
      ? (raw.domains as Record<string, unknown>[]).map((d) => ({
          name: str(d.name),
          label: str(d.label),
          configured: bool(d.configured),
        }))
      : [],
  };
}

function postureCheckCatalog(raw: Record<string, unknown>): PostureCheckCatalog {
  return {
    check: str(raw.check),
    title: str(raw.title),
    severity: str(raw.severity),
    category: str(raw.category),
    resource: str(raw.resource),
    description: str(raw.description),
  };
}

function postureFinding(raw: Record<string, unknown>): PostureFinding {
  return {
    check: str(raw.check),
    title: str(raw.title),
    status: str(raw.status),
    severity: str(raw.severity),
    evidenceClass: str(raw.evidence_class),
    evidenceClassLabel: str(raw.evidence_class_label),
    detail: str(raw.detail),
    resource: str(raw.resource),
    category: str(raw.category),
  };
}

/**
 * One posture domain (cloud / secrets / repo). The inert `connected:false` body is
 * a NORMAL 200 response, mapped like any other — the panel reads `connected` and
 * says "not connected", never "all clear". `detail` is the not-configured reason on
 * an inert domain and null when connected; `weakestEvidence` is present only when
 * connected.
 */
function mapPostureDomain(raw: Record<string, unknown>): AssurancePostureDomain {
  const summary = objOf(raw.summary);
  return {
    domain: str(raw.domain),
    domainLabel: str(raw.domain_label),
    connected: bool(raw.connected),
    detail: strOrNull(raw.detail),
    checks: Array.isArray(raw.checks)
      ? (raw.checks as Record<string, unknown>[]).map(postureCheckCatalog)
      : [],
    findings: Array.isArray(raw.findings)
      ? (raw.findings as Record<string, unknown>[]).map(postureFinding)
      : [],
    summary: {
      connected: bool(summary.connected),
      planned: num(summary.planned, 0),
      total: num(summary.total, 0),
      pass: num(summary.pass, 0),
      gap: num(summary.gap, 0),
      unknown: num(summary.unknown, 0),
      gapsBySeverity: numRecord(summary.gaps_by_severity),
      maxRisk: str(summary.max_risk),
      weakestEvidence: strOrNull(summary.weakest_evidence),
    },
  };
}

function personalReader(raw: Record<string, unknown>): PersonalReader {
  return {
    principal: str(raw.principal),
    principalKind: str(raw.principal_kind),
    principalKindLabel: str(raw.principal_kind_label),
    privilegeLevel: str(raw.privilege_level),
    shadow: bool(raw.shadow),
    overBroad: bool(raw.over_broad),
    risk: str(raw.risk),
    via: strList(raw.via),
  };
}

function personalGap(raw: Record<string, unknown>): PersonalGap {
  const out: PersonalGap = { type: str(raw.type), risk: str(raw.risk), detail: str(raw.detail) };
  if (Array.isArray(raw.principals)) out.principals = strList(raw.principals);
  // The roll-up variant carries the asset it belongs to.
  if (typeof raw.asset_name === "string") out.assetName = raw.asset_name;
  return out;
}

function personalStore(raw: Record<string, unknown>): PersonalStore {
  return {
    assetName: str(raw.asset_name),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    identifier: str(raw.identifier),
    classification: str(raw.classification),
    classificationLabel: str(raw.classification_label),
    managed: bool(raw.managed),
    providerName: strOrNull(raw.provider_name),
    // "unknown" is an honest unknown, NOT "no PII".
    dataSensitivity: str(raw.data_sensitivity),
    personalData: bool(raw.personal_data),
    signals: strList(raw.signals),
    evidenceClass: str(raw.evidence_class),
    evidenceClassLabel: str(raw.evidence_class_label),
    reachableBy: Array.isArray(raw.reachable_by)
      ? (raw.reachable_by as Record<string, unknown>[]).map(personalReader)
      : [],
    readerCount: num(raw.reader_count, 0),
    gaps: Array.isArray(raw.gaps) ? (raw.gaps as Record<string, unknown>[]).map(personalGap) : [],
    risk: str(raw.risk),
  };
}

function mapPersonalContext(raw: Record<string, unknown>): AssurancePersonalContext {
  const summary = objOf(raw.summary);
  return {
    stores: Array.isArray(raw.stores)
      ? (raw.stores as Record<string, unknown>[]).map(personalStore)
      : [],
    gaps: Array.isArray(raw.gaps) ? (raw.gaps as Record<string, unknown>[]).map(personalGap) : [],
    summary: {
      dataBearingComponents: num(summary.data_bearing_components, 0),
      personalDataComponents: num(summary.personal_data_components, 0),
      unclassifiedComponents: num(summary.unclassified_components, 0),
      reachableByShadow: num(summary.reachable_by_shadow, 0),
      reachableByOverBroad: num(summary.reachable_by_over_broad, 0),
      crossingBoundary: num(summary.crossing_boundary, 0),
      gaps: num(summary.gaps, 0),
      worstRisk: strOrNull(summary.worst_risk),
    },
  };
}

function lifecycleComponent(raw: Record<string, unknown>): LifecycleComponent {
  return {
    name: str(raw.name),
    kindLabel: str(raw.kind_label),
    how: str(raw.how),
    evidenceClass: str(raw.evidence_class),
    evidenceClassLabel: str(raw.evidence_class_label),
  };
}

function lifecycleStage(raw: Record<string, unknown>): LifecycleStage {
  return {
    stage: str(raw.stage),
    stageLabel: str(raw.stage_label),
    controlStage: bool(raw.control_stage),
    evidenced: bool(raw.evidenced),
    components: Array.isArray(raw.components)
      ? (raw.components as Record<string, unknown>[]).map(lifecycleComponent)
      : [],
    // Null when the stage is unevidenced — a chain is as strong as its weakest link.
    weakestEvidence: strOrNull(raw.weakest_evidence),
    weakestEvidenceLabel: strOrNull(raw.weakest_evidence_label),
    gap: bool(raw.gap),
    gapDetail: strOrNull(raw.gap_detail),
    risk: str(raw.risk),
  };
}

function mapDataLifecycle(raw: Record<string, unknown>): AssuranceDataLifecycle {
  const summary = objOf(raw.summary);
  return {
    stages: Array.isArray(raw.stages)
      ? (raw.stages as Record<string, unknown>[]).map(lifecycleStage)
      : [],
    gaps: Array.isArray(raw.gaps)
      ? (raw.gaps as Record<string, unknown>[]).map((g) => ({
          stage: str(g.stage),
          stageLabel: str(g.stage_label),
          risk: str(g.risk),
          detail: str(g.detail),
        }))
      : [],
    summary: {
      stagesTotal: num(summary.stages_total, 0),
      evidenced: num(summary.evidenced, 0),
      notEvidenced: num(summary.not_evidenced, 0),
      controlGaps: num(summary.control_gaps, 0),
      worstRisk: strOrNull(summary.worst_risk),
    },
  };
}

function reusePosture(raw: Record<string, unknown>): ReusePosture {
  return {
    field: str(raw.field),
    fieldLabel: str(raw.field_label),
    concern: str(raw.concern),
    value: str(raw.value),
    posture: str(raw.posture),
    evidenceClass: str(raw.evidence_class),
    evidenceClassLabel: str(raw.evidence_class_label),
    source: str(raw.source),
    sourceLabel: str(raw.source_label),
    // Verified only when independently evidenced — a vendor claim never upgrades.
    verified: bool(raw.verified),
  };
}

function trainingGap(raw: Record<string, unknown>): TrainingGap {
  const out: TrainingGap = {
    type: str(raw.type),
    field: str(raw.field),
    risk: str(raw.risk),
    detail: str(raw.detail),
  };
  if (typeof raw.provider_name === "string") out.providerName = raw.provider_name;
  return out;
}

function trainingProvider(raw: Record<string, unknown>): TrainingProvider {
  return {
    providerUuid: str(raw.provider_uuid),
    providerName: str(raw.provider_name),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    dependentAssets: Array.isArray(raw.dependent_assets)
      ? (raw.dependent_assets as Record<string, unknown>[]).map((a) => ({
          assetName: str(a.asset_name),
          kind: str(a.kind),
          kindLabel: str(a.kind_label),
          classification: str(a.classification),
          classificationLabel: str(a.classification_label),
          managed: bool(a.managed),
        }))
      : [],
    postures: Array.isArray(raw.postures)
      ? (raw.postures as Record<string, unknown>[]).map(reusePosture)
      : [],
    reusePossible: bool(raw.reuse_possible),
    reuseDeclared: bool(raw.reuse_declared),
    gaps: Array.isArray(raw.gaps) ? (raw.gaps as Record<string, unknown>[]).map(trainingGap) : [],
    risk: str(raw.risk),
  };
}

function mapTrainingReuse(raw: Record<string, unknown>): AssuranceTrainingReuse {
  const summary = objOf(raw.summary);
  return {
    providers: Array.isArray(raw.providers)
      ? (raw.providers as Record<string, unknown>[]).map(trainingProvider)
      : [],
    gaps: Array.isArray(raw.gaps) ? (raw.gaps as Record<string, unknown>[]).map(trainingGap) : [],
    summary: {
      providers: num(summary.providers, 0),
      reuseDeclared: num(summary.reuse_declared, 0),
      reusePossible: num(summary.reuse_possible, 0),
      verifiedNoReuse: num(summary.verified_no_reuse, 0),
      gaps: num(summary.gaps, 0),
      worstRisk: strOrNull(summary.worst_risk),
    },
  };
}

function metadataGap(raw: Record<string, unknown>): MetadataGap {
  const out: MetadataGap = { type: str(raw.type), risk: str(raw.risk), detail: str(raw.detail) };
  if (typeof raw.asset_name === "string") out.assetName = raw.asset_name;
  return out;
}

function logSink(raw: Record<string, unknown>): LogSink {
  return {
    assetName: str(raw.asset_name),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    identifier: str(raw.identifier),
    classification: str(raw.classification),
    classificationLabel: str(raw.classification_label),
    managed: bool(raw.managed),
    providerName: strOrNull(raw.provider_name),
    basis: str(raw.basis),
    evidenceClass: str(raw.evidence_class),
    evidenceClassLabel: str(raw.evidence_class_label),
    sensitiveCategories: Array.isArray(raw.sensitive_categories)
      ? (raw.sensitive_categories as Record<string, unknown>[]).map((c) => ({
          category: str(c.category),
          label: str(c.label),
          basis: str(c.basis),
        }))
      : [],
    controlEvidenced: bool(raw.control_evidenced),
    controlDetail: strOrNull(raw.control_detail),
    gaps: Array.isArray(raw.gaps) ? (raw.gaps as Record<string, unknown>[]).map(metadataGap) : [],
    risk: str(raw.risk),
  };
}

function mapMetadataLogging(raw: Record<string, unknown>): AssuranceMetadataLogging {
  const summary = objOf(raw.summary);
  return {
    sinks: Array.isArray(raw.sinks) ? (raw.sinks as Record<string, unknown>[]).map(logSink) : [],
    sensitiveCategoriesHandled: Array.isArray(raw.sensitive_categories_handled)
      ? (raw.sensitive_categories_handled as Record<string, unknown>[]).map((c) => ({
          category: str(c.category),
          basis: str(c.basis),
          label: str(c.label),
        }))
      : [],
    gaps: Array.isArray(raw.gaps) ? (raw.gaps as Record<string, unknown>[]).map(metadataGap) : [],
    summary: {
      sinks: num(summary.sinks, 0),
      shadowSinks: num(summary.shadow_sinks, 0),
      sinksWithoutControl: num(summary.sinks_without_control, 0),
      sensitiveCategoriesHandled: num(summary.sensitive_categories_handled, 0),
      gaps: num(summary.gaps, 0),
      worstRisk: strOrNull(summary.worst_risk),
    },
  };
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
  return mapAssuranceReceipt(await readObject(response));
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
  return capabilityMap(await readObject(response));
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
  return mapRouteMap(await readObject(response));
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
  return mapAiBom(await readObject(response));
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
  return dataBoundaryAssessment(await readObject(response));
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
  return mapCompliance(await readObject(response));
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
  return mapBusinessImpact(await readObject(response));
}

/**
 * A deployment's Third-Party Vendor Assurance (commercial spine): the posture of
 * the vendors it depends on — what each asserts, at what evidence strength, which
 * components depend on it, an honest gap list, the ungoverned dependencies, and an
 * ordinal posture band. A read (open), so a non-ok answer is genuine
 * unavailability like the other reads. It never presents a vendor as secure or
 * compliant: a vendor_asserted claim reads as vendor-asserted, and the band is a
 * concern signal derived from the weakest evidence, not a grade.
 */
export async function vendorAssurance(uuid: string): Promise<AssuranceVendorAssurance> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/vendor-assurance/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapVendorAssurance(await readObject(response));
}

/**
 * A deployment's executive summary (commercial spine): the assurance graph rolled
 * up for a leadership reader — asset coverage, evidence distribution, finding
 * posture by severity, remediation velocity, the six-state decision, an ordinal
 * posture and assurance-maturity band, and a headline from each sibling
 * assessment. A read (open), so a non-ok answer is genuine unavailability like the
 * other reads. Every value is a real count, a true ratio of real counts, or an
 * ordinal band — no dollar figure, ROI amount, or realized-loss number anywhere,
 * and nothing claims the system is secure.
 */
export async function executiveSummary(uuid: string): Promise<AssuranceExecutiveSummary> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/executive-summary/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapExecutiveSummary(await readObject(response));
}

/**
 * A deployment's operational / continuous-assurance roll-up (commercial spine):
 * where it sits in the continuous-assurance loop — evidence freshness/staleness,
 * the change backlog needing reassessment, remediation velocity, the six-state
 * decision, and an ordinal readiness band — tied together from the signals the
 * rest of the spine already computes. A read (open), so a non-ok answer is genuine
 * unavailability like the other reads. HONEST by construction: the readiness band
 * is weakest-wins and never green-by-default (an unassessed deployment reads
 * `stale`), every ratio is null when there is no basis to compute it, and a
 * resolved remediation is a process claim, never a security closure.
 */
export async function operationalAssurance(uuid: string): Promise<AssuranceOperationalAssurance> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/operational-assurance/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapOperationalAssurance(await readObject(response));
}

/**
 * The Vertical Assurance Packs catalog (commercial spine): the static, code-only
 * catalog of industry packs — each naming the frameworks it emphasizes, the
 * regulatory regimes it targets, and the evidence a buyer in that vertical
 * expects. A read (open), so a non-ok answer is genuine unavailability like the
 * other reads. It does not read the deployment; apply one via `assurancePack`.
 */
export async function assurancePacks(uuid: string): Promise<AssurancePacksCatalog> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/assurance-packs/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapAssurancePacks(await readObject(response));
}

/**
 * Apply one vertical assurance pack to a deployment (commercial spine): its
 * compliance coverage read through the lens of that pack, plus the pack's
 * regulatory regimes carried as context. A read, but with an EXPECTED 4xx: an
 * unknown pack key is a clean backend 400, which is meaning the caller must see
 * (it is not "the control plane is down"), so — like the write reads that use
 * PASSTHROUGH_STATUS — a 400/403/404/409 is returned as `{ok:false}` with its
 * reason rather than laundered into a 503. Genuine unavailability (5xx, network)
 * still throws. Coverage is honest: a touched control is an open gap, never
 * "passed"; the regimes are context, never computed coverage.
 */
export async function assurancePack(
  uuid: string,
  packKey: string,
): Promise<{ ok: true; value: AssurancePackApplied } | { ok: false; status: number; detail: string }> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/assurance-packs/${encodeURIComponent(packKey)}/`,
  );
  if (PASSTHROUGH_STATUS.has(response.status)) {
    return { ok: false, status: response.status, detail: await body(response) };
  }
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return { ok: true, value: mapAssurancePack(await readObject(response)) };
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
  return mapRemediation(await readObject(response));
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

/**
 * A deployment's Identity Assurance & Effective Access (Phase 3.1): every principal
 * that can act, what each can effectively reach (direct and transitive, via
 * evidenced paths only), its identity-assurance gaps, and an honest roll-up. A read
 * (open), so a non-ok answer is genuine unavailability like the other reads. It
 * never claims least privilege is satisfied or an identity is secure — powers,
 * reach, and gaps only.
 */
export async function effectiveAccess(uuid: string): Promise<AssuranceEffectiveAccess> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/effective-access/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapEffectiveAccess(await readObject(response));
}

/**
 * A deployment's Ripple Effect / blast-radius (Phase 2.5): for each origin worth
 * tracing, a few well-supported downstream consequences a compromise of it could
 * have, each tied to the evidenced via-path. A read (open), so a non-ok answer is
 * genuine unavailability. Every consequence is potential and evidence-based, never a
 * realized harm or a monetary figure; the list is bounded and the full evidenced
 * count reported so the bounding is visible; an origin with no evidenced reach reads
 * honestly as such, never as safe.
 */
export async function rippleEffect(uuid: string): Promise<AssuranceRippleEffect> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/ripple-effect/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapRippleEffect(await readObject(response));
}

/**
 * The credential-gated posture catalog (Phase 3.2–3.4): the posture domains and
 * whether each is configured. A read (open), so a non-ok answer is genuine
 * unavailability. It triggers nothing — it just says which posture assessments
 * exist and which are inert for lack of credentials.
 */
export async function postureCatalog(uuid: string): Promise<AssurancePostureCatalog> {
  const response = await call(`/api/assurance/deployments/${encodeURIComponent(uuid)}/posture/`);
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapPostureCatalog(await readObject(response));
}

/**
 * A deployment's Cloud Assurance posture (Phase 3.2, credential-gated). A read
 * (open): a non-ok answer is genuine unavailability, but the INERT
 * `{connected:false, ...}` body is a NORMAL 200 that is mapped and passed through —
 * an inert domain reads as "not connected", never "all clear".
 */
export async function cloudPosture(uuid: string): Promise<AssurancePostureDomain> {
  const response = await call(`/api/assurance/deployments/${encodeURIComponent(uuid)}/cloud-posture/`);
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapPostureDomain(await readObject(response));
}

/**
 * A deployment's Secrets / Crypto posture (Phase 3.3, credential-gated). A read
 * (open): a non-ok answer is genuine unavailability, the inert `connected:false`
 * body is a normal 200 passed through. No secret value is ever emitted — only
 * presence / hygiene facts.
 */
export async function secretsPosture(uuid: string): Promise<AssurancePostureDomain> {
  const response = await call(`/api/assurance/deployments/${encodeURIComponent(uuid)}/secrets-posture/`);
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapPostureDomain(await readObject(response));
}

/**
 * A deployment's Repository / SDLC posture (Phase 3.4, credential-gated). A read
 * (open): a non-ok answer is genuine unavailability, the inert `connected:false`
 * body is a normal 200 passed through.
 */
export async function repoPosture(uuid: string): Promise<AssurancePostureDomain> {
  const response = await call(`/api/assurance/deployments/${encodeURIComponent(uuid)}/repo-posture/`);
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapPostureDomain(await readObject(response));
}

/**
 * A deployment's Personal Context Exposure (Phase 3.5): what personal / customer
 * data it holds, in which components, and which principals can reach it. A read
 * (open), so a non-ok answer is genuine unavailability. An unclassified data store
 * reads as UNKNOWN (personal-data exposure cannot be ruled out), never "no PII"; no
 * data value is emitted.
 */
export async function personalContext(uuid: string): Promise<AssurancePersonalContext> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/personal-context/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapPersonalContext(await readObject(response));
}

/**
 * A deployment's Data Lifecycle Review (Phase 3.5): the lifecycle stages evidenced
 * in the graph, the components that evidence each at their true evidence strength,
 * and the gaps where a stage has no evidenced control. A read (open), so a non-ok
 * answer is genuine unavailability. An unevidenced stage reads "not evidenced",
 * never "compliant".
 */
export async function dataLifecycle(uuid: string): Promise<AssuranceDataLifecycle> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/data-lifecycle/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapDataLifecycle(await readObject(response));
}

/**
 * A deployment's Training / Reuse Review (Phase 3.5): whether customer / internal
 * data is reused for training, sharing or retention — verified vs merely asserted —
 * per provider, each posture at its true evidence class. A read (open), so a non-ok
 * answer is genuine unavailability. A vendor_asserted "we don't train on your data"
 * reads as vendor-asserted, never verified; an unstated policy is a gap, never
 * "safe".
 */
export async function trainingReuse(uuid: string): Promise<AssuranceTrainingReuse> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/training-reuse/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapTrainingReuse(await readObject(response));
}

/**
 * A deployment's Metadata & Logging Risk (Phase 3.5): where prompts / traces /
 * embeddings / metadata get logged, the sensitive categories that could reach those
 * sinks, and the gaps where sensitive data is logged with no evidenced control. A
 * read (open), so a non-ok answer is genuine unavailability. No sensitive value is
 * ever emitted — only the presence of a category and its lineage; an unknown reads
 * unknown.
 */
export async function metadataLogging(uuid: string): Promise<AssuranceMetadataLogging> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/metadata-logging/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapMetadataLogging(await readObject(response));
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
  const payload = await readObject(response);
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
  return { ok: true, unknown: unknown(await readObject(response)) };
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
  return { ok: true, value: map(await readObject(response)) };
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
    value: dataBoundaryAssessment(await readObject(response)),
  };
}

/** The identity a human declares when registering a provider by hand. */
export interface ProviderInput {
  name: string;
  kind: string;
}

/** The identity fields a human may edit on an existing provider. Every field is
 *  optional so a form saves what it changed and leaves the rest alone. */
export interface ProviderPatch {
  name?: string;
  kind?: string;
  region?: string;
  notes?: string;
}

/**
 * Register a provider a deployment relies on (a vector DB, a gateway) — one that
 * asset discovery did not auto-register from an LLM target. Admin-only on the
 * control plane; the BFF route gates it too.
 */
export async function createProvider(input: ProviderInput) {
  return writeJson("/api/assurance/providers/", "POST", { name: input.name, kind: input.kind }, provider);
}

/**
 * Edit an existing provider's declared identity in place (Django ProviderViewSet
 * supports PATCH — see assurance/views.py `update`, admin-only). A backend
 * refusal (400/403/404) is returned with its reason rather than laundered into a
 * 503. NOTE: the ProviderViewSet does NOT expose destroy (no DestroyModelMixin,
 * and "delete" is absent from its http_method_names), so there is no remove
 * counterpart — a provider is a global registry other records point at.
 */
export async function updateProvider(uuid: string, patch: ProviderPatch) {
  const wire: Record<string, unknown> = {};
  if (patch.name !== undefined) wire.name = patch.name;
  if (patch.kind !== undefined) wire.kind = patch.kind;
  if (patch.region !== undefined) wire.region = patch.region;
  if (patch.notes !== undefined) wire.notes = patch.notes;
  return writeJson(
    `/api/assurance/providers/${encodeURIComponent(uuid)}/`,
    "PATCH",
    wire,
    provider,
  );
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

/**
 * The users a finding's remediation work may be assigned to (Phase 2.3), for a
 * picker instead of free-text entry. Admin-only on the control plane and the BFF
 * route — the same guard as {@link remediationAssign}. It returns the same
 * `{ok:true, value} | {ok:false, status, detail}` shape and error mapping as the
 * assign proxy: an EXPECTED backend 4xx (403/404) is passed back with its reason
 * rather than laundered into a 503, while genuine unavailability (5xx, network)
 * throws. The set is active users only, ordered by username — exactly what the
 * assign action will accept, so a picked user is never rejected.
 */
export async function getAssignable(
  uuid: string,
): Promise<
  | { ok: true; value: AssuranceAssignable }
  | { ok: false; status: number; detail: string }
> {
  const response = await call(
    `/api/assurance/findings/${encodeURIComponent(uuid)}/assignable/`,
  );
  if (PASSTHROUGH_STATUS.has(response.status)) {
    return { ok: false, status: response.status, detail: await body(response) };
  }
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return { ok: true, value: mapAssignable(await readObject(response)) };
}

// ============================================================================
// Continuous-assurance loop (SPINE Phases 1–3): claims, drift, decision-support,
// revalidation, retest, invalidation, operational-risk, incident packs,
// connectors. The system of record's continuous-assurance capabilities, mapped
// to camelCase here once, exactly like the reads above. Honest by construction:
// a null ratio/decision stays null (never a fabricated 0), an undeclared
// baseline reads as undeclared (never a clean bill), a resolved remediation is a
// process claim, and nothing reads green-by-default.
// ============================================================================

// ---- Assurance claims register (SPINE) ----

/** A version-bound, falsifiable assurance claim (backend AssuranceClaimSerializer).
 *  Every field is machine-derived or moved through the attributed transition
 *  action; the API never lets a claim be hand-edited into a dishonest state. */
export interface AssuranceClaim {
  uuid: string;
  deploymentUuid: string | null;
  assetUuid: string | null;
  assetName: string | null;
  claimType: string;
  claimTypeLabel: string;
  statement: string;
  fingerprint: string;
  systemFingerprint: string;
  policyVersion: string;
  environment: string;
  environmentLabel: string;
  status: string;
  statusLabel: string;
  evidenceClass: string;
  evidenceClassLabel: string;
  // Null when the backend recorded no confidence (never laundered into 0).
  confidence: number | null;
  vendorAsserted: boolean;
  // The six-state decision the claim reflects, or null when unassessed (never
  // silently read as ready).
  assessment: string | null;
  assessmentLabel: string | null;
  supportingSummary: string;
  contradictingSummary: string;
  invalidationConditions: string[];
  supersededBy: string | null;
  humanOwner: string | null;
  receiptDigest: string;
  isStale: boolean;
  validFrom: string | null;
  validTo: string | null;
  verifiedAt: string | null;
  expiration: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** One attributed step in a claim's lifecycle (backend ClaimEventSerializer). */
export interface ClaimEvent {
  uuid: string;
  fromStatus: string | null;
  fromStatusLabel: string | null;
  toStatus: string;
  toStatusLabel: string;
  actor: string | null;
  note: string;
  createdAt: string | null;
}

/** What a claim transition did: the claim's new status and the event it wrote. */
export interface ClaimTransitionResult {
  status: string;
  statusLabel: string;
  event: ClaimEvent;
}

/** The reconciliation counts a claims recompute returns (SPINE Phase 1). */
export interface ClaimRecomputeCounts {
  created: number;
  updated: number;
  superseded: number;
  stale: number;
}

function claim(raw: Record<string, unknown>): AssuranceClaim {
  return {
    uuid: str(raw.uuid),
    deploymentUuid: strOrNull(raw.deployment_uuid),
    assetUuid: strOrNull(raw.asset_uuid),
    assetName: strOrNull(raw.asset_name),
    claimType: str(raw.claim_type),
    claimTypeLabel: str(raw.claim_type_label),
    statement: str(raw.statement),
    fingerprint: str(raw.fingerprint),
    systemFingerprint: str(raw.system_fingerprint),
    policyVersion: str(raw.policy_version),
    environment: str(raw.environment),
    environmentLabel: str(raw.environment_label),
    status: str(raw.status),
    statusLabel: str(raw.status_label),
    evidenceClass: str(raw.evidence_class),
    evidenceClassLabel: str(raw.evidence_class_label),
    confidence: numOrNull(raw.confidence),
    vendorAsserted: bool(raw.vendor_asserted),
    assessment: strOrNull(raw.assessment),
    assessmentLabel: strOrNull(raw.assessment_label),
    supportingSummary: str(raw.supporting_summary),
    contradictingSummary: str(raw.contradicting_summary),
    invalidationConditions: strList(raw.invalidation_conditions),
    supersededBy: strOrNull(raw.superseded_by),
    humanOwner: strOrNull(raw.human_owner),
    receiptDigest: str(raw.receipt_digest),
    isStale: bool(raw.is_stale),
    validFrom: strOrNull(raw.valid_from),
    validTo: strOrNull(raw.valid_to),
    verifiedAt: strOrNull(raw.verified_at),
    expiration: strOrNull(raw.expiration),
    firstSeen: strOrNull(raw.first_seen),
    lastSeen: strOrNull(raw.last_seen),
    createdAt: strOrNull(raw.created_at),
    updatedAt: strOrNull(raw.updated_at),
  };
}

function claimEvent(raw: Record<string, unknown>): ClaimEvent {
  return {
    uuid: str(raw.uuid),
    fromStatus: strOrNull(raw.from_status),
    fromStatusLabel: strOrNull(raw.from_status_label),
    toStatus: str(raw.to_status),
    toStatusLabel: str(raw.to_status_label),
    actor: strOrNull(raw.actor),
    note: str(raw.note),
    createdAt: strOrNull(raw.created_at),
  };
}

/**
 * The assurance claims register (SPINE), scoped like findings on the backend. A
 * read (open); a non-ok answer is genuine unavailability like the other reads.
 * DRF-paginated, so every page is followed. Filters ride along.
 */
export async function listClaims(
  opts: { deployment?: string; claimType?: string; status?: string; all?: string } = {},
): Promise<AssuranceClaim[]> {
  const query = queryString({
    deployment: opts.deployment,
    claim_type: opts.claimType,
    status: opts.status,
    all: opts.all,
  });
  return (await pagedRows(`/api/assurance/claims/${query}`)).map(claim);
}

/**
 * One claim's attributed lifecycle history (SPINE). A read (open); a non-ok
 * answer is genuine unavailability like the other reads.
 */
export async function claimEvents(uuid: string): Promise<ClaimEvent[]> {
  const response = await call(`/api/assurance/claims/${encodeURIComponent(uuid)}/events/`);
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = await response.json().catch(() => null);
  return rows(payload).map(claimEvent);
}

/**
 * Move a claim along its lifecycle (SPINE). Admin-only on the control plane; the
 * BFF route gates it too. The backend refuses an unknown status, an illegal jump,
 * or a verify without verified evidence with a 400, passed back with its reason
 * rather than laundered into a 503.
 */
export async function transitionClaim(uuid: string, toStatus: string, note?: string) {
  const wire: Record<string, unknown> = { to_status: toStatus };
  if (note !== undefined) wire.note = note;
  return writeJson(
    `/api/assurance/claims/${encodeURIComponent(uuid)}/transition/`,
    "POST",
    wire,
    (raw): ClaimTransitionResult => ({
      status: str(raw.status),
      statusLabel: str(raw.status_label),
      event: claimEvent(objOf(raw.event)),
    }),
  );
}

/**
 * A deployment's CURRENT assurance claims (SPINE Phase 1): only the current
 * version of each claim. A read (open); a non-ok answer is genuine unavailability.
 */
export async function deploymentClaims(uuid: string): Promise<AssuranceClaim[]> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/assurance-claims/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = await response.json().catch(() => null);
  return rows(payload).map(claim);
}

/**
 * Re-derive a deployment's assurance claims from its current state (SPINE Phase
 * 1). Admin-only on the control plane; the BFF route gates it too. Returns the
 * reconciliation counts. A backend refusal is passed back with its reason.
 */
export async function recomputeClaims(uuid: string) {
  return writeJson(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/recompute-claims/`,
    "POST",
    {},
    (raw): ClaimRecomputeCounts => ({
      created: num(raw.created, 0),
      updated: num(raw.updated, 0),
      superseded: num(raw.superseded, 0),
      stale: num(raw.stale, 0),
    }),
  );
}

// ---- BOM drift + declared architecture (SPINE Stage 3) ----

export interface BomDriftUndeclared {
  assetUuid: string;
  kind: string;
  kindLabel: string;
  name: string;
  identifier: string;
  providerName: string | null;
  severity: string;
}
export interface BomDriftMissing {
  declaredUuid: string;
  kind: string;
  kindLabel: string;
  name: string;
  identifier: string;
  providerName: string | null;
}
/** Declared-vs-observed AI-BOM drift (SPINE Stage 3). `hasDeclared` is false when
 *  no declaration exists — there is then no drift to compute, and that is NOT a
 *  pass (it reads as an explicit gap, never a clean bill of materials). */
export interface BomDrift {
  deploymentUuid: string;
  hasDeclared: boolean;
  driftDetected: boolean;
  summary: {
    declaredCount: number;
    observedCount: number;
    matched: number;
    undeclared: number;
    undeclaredProviders: number;
    missing: number;
  };
  undeclared: BomDriftUndeclared[];
  undeclaredProviders: string[];
  missing: BomDriftMissing[];
  note: string;
}
/** The counts a record-bom-drift write returns (SPINE Stage 3). */
export interface BomDriftRecordCounts {
  created: number;
  updated: number;
  reopened: number;
  resolved: number;
  driftDetected: boolean;
}

function mapBomDrift(raw: Record<string, unknown>): BomDrift {
  const summary = objOf(raw.summary);
  return {
    deploymentUuid: str(raw.deployment_uuid),
    hasDeclared: bool(raw.has_declared),
    driftDetected: bool(raw.drift_detected),
    summary: {
      declaredCount: num(summary.declared_count, 0),
      observedCount: num(summary.observed_count, 0),
      matched: num(summary.matched, 0),
      undeclared: num(summary.undeclared, 0),
      undeclaredProviders: num(summary.undeclared_providers, 0),
      missing: num(summary.missing, 0),
    },
    undeclared: Array.isArray(raw.undeclared)
      ? (raw.undeclared as Record<string, unknown>[]).map((c) => ({
          assetUuid: str(c.asset_uuid),
          kind: str(c.kind),
          kindLabel: str(c.kind_label),
          name: str(c.name),
          identifier: str(c.identifier),
          providerName: strOrNull(c.provider_name),
          severity: str(c.severity),
        }))
      : [],
    undeclaredProviders: strList(raw.undeclared_providers),
    missing: Array.isArray(raw.missing)
      ? (raw.missing as Record<string, unknown>[]).map((c) => ({
          declaredUuid: str(c.declared_uuid),
          kind: str(c.kind),
          kindLabel: str(c.kind_label),
          name: str(c.name),
          identifier: str(c.identifier),
          providerName: strOrNull(c.provider_name),
        }))
      : [],
    note: str(raw.note),
  };
}

/** One component the customer declares (backend DeclaredComponentSerializer). */
export interface DeclaredComponent {
  uuid: string;
  kind: string;
  kindLabel: string;
  name: string;
  identifier: string;
  providerName: string;
  note: string;
}
/** The declared architecture plus its live drift (SPINE Stage 3). */
export interface DeclaredArchitecture {
  declared: DeclaredComponent[];
  drift: BomDrift;
}
/** One component in the PUT body that replaces the declared set. */
export interface DeclaredComponentInput {
  kind: string;
  name: string;
  identifier?: string;
  providerName?: string;
  note?: string;
}

function declaredComponent(raw: Record<string, unknown>): DeclaredComponent {
  return {
    uuid: str(raw.uuid),
    kind: str(raw.kind),
    kindLabel: str(raw.kind_label),
    name: str(raw.name),
    identifier: str(raw.identifier),
    providerName: str(raw.provider_name),
    note: str(raw.note),
  };
}

function mapDeclaredArchitecture(raw: Record<string, unknown>): DeclaredArchitecture {
  return {
    declared: Array.isArray(raw.declared)
      ? (raw.declared as Record<string, unknown>[]).map(declaredComponent)
      : [],
    drift: mapBomDrift(objOf(raw.drift)),
  };
}

/**
 * A deployment's declared-vs-observed AI-BOM drift (SPINE Stage 3). A read (open);
 * a non-ok answer is genuine unavailability. Without a declared baseline there is
 * no drift to compute, and that is surfaced (hasDeclared:false), never a pass.
 */
export async function bomDrift(uuid: string): Promise<BomDrift> {
  const response = await call(`/api/assurance/deployments/${encodeURIComponent(uuid)}/bom-drift/`);
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapBomDrift(await readObject(response));
}

/**
 * Turn a deployment's current BOM drift into managed findings (SPINE Stage 3).
 * Admin-only on the control plane; the BFF route gates it too. Idempotent and
 * non-destructive. Returns the reconciliation counts. Backend refusals pass back.
 */
export async function recordBomDrift(uuid: string) {
  return writeJson(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/record-bom-drift/`,
    "POST",
    {},
    (raw): BomDriftRecordCounts => ({
      created: num(raw.created, 0),
      updated: num(raw.updated, 0),
      reopened: num(raw.reopened, 0),
      resolved: num(raw.resolved, 0),
      driftDetected: bool(raw.drift_detected),
    }),
  );
}

/**
 * A deployment's declared architecture plus its live drift (SPINE Stage 3). A
 * read (open); a non-ok answer is genuine unavailability.
 */
export async function declaredArchitecture(uuid: string): Promise<DeclaredArchitecture> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/declared-architecture/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapDeclaredArchitecture(await readObject(response));
}

/**
 * Replace a deployment's declared architecture (SPINE Stage 3). A PUT: admin-only
 * on the control plane, gated again on the BFF route. The response is the fresh
 * declaration and drift. A backend refusal (a validation error) is passed back
 * with its reason rather than laundered into a 503.
 */
export async function setDeclaredArchitecture(
  uuid: string,
  components: DeclaredComponentInput[],
): Promise<
  | { ok: true; value: DeclaredArchitecture }
  | { ok: false; status: number; detail: string }
> {
  const wire = {
    components: components.map((c) => {
      const row: Record<string, unknown> = { kind: c.kind, name: c.name };
      if (c.identifier !== undefined) row.identifier = c.identifier;
      if (c.providerName !== undefined) row.provider_name = c.providerName;
      if (c.note !== undefined) row.note = c.note;
      return row;
    }),
  };
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/declared-architecture/`,
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
  return { ok: true, value: mapDeclaredArchitecture(await readObject(response)) };
}

// ---- Decision support + revalidation plan (SPINE Stage 1C / 1D) ----

/** The minimal identity of a claim in a decision-support / revalidation view. */
export interface ClaimBrief {
  uuid: string;
  claimType: string;
  status: string;
  statement: string;
}
/** A deployment's six-state decision WITH why (SPINE Stage 1C). */
export interface DecisionSupport {
  // Null when unassessed (never silently read as ready).
  decision: string | null;
  decisionLabel: string | null;
  // The finding-based signal before the claim cap; null when paused/unassessed.
  fromFindings: string | null;
  // The cap current claims impose, or null when no claim holds the decision back.
  claimCap: string | null;
  paused: boolean;
  claims: {
    hasClaims: boolean;
    retestPending: boolean;
    contradicted: ClaimBrief[];
    stale: ClaimBrief[];
    unknown: ClaimBrief[];
    supporting: ClaimBrief[];
  };
  note: string;
}

function claimBrief(raw: Record<string, unknown>): ClaimBrief {
  return {
    uuid: str(raw.uuid),
    claimType: str(raw.claim_type),
    status: str(raw.status),
    statement: str(raw.statement),
  };
}
function claimBriefs(raw: unknown): ClaimBrief[] {
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]).map(claimBrief) : [];
}

function mapDecisionSupport(raw: Record<string, unknown>): DecisionSupport {
  const claims = objOf(raw.claims);
  return {
    decision: strOrNull(raw.decision),
    decisionLabel: strOrNull(raw.decision_label),
    fromFindings: strOrNull(raw.from_findings),
    claimCap: strOrNull(raw.claim_cap),
    paused: bool(raw.paused),
    claims: {
      hasClaims: bool(claims.has_claims),
      retestPending: bool(claims.retest_pending),
      contradicted: claimBriefs(claims.contradicted),
      stale: claimBriefs(claims.stale),
      unknown: claimBriefs(claims.unknown),
      supporting: claimBriefs(claims.supporting),
    },
    note: str(raw.note),
  };
}

/**
 * A deployment's six-state decision with its supporting rationale (SPINE Stage
 * 1C). A read (open); a non-ok answer is genuine unavailability. A READY decision
 * stands only while its supporting claims stay current — a contradicted claim
 * holds it at 'needs remediation', a stale/unknown claim or open retest at 'needs
 * more evidence'; an unassessed deployment reads null, never ready.
 */
export async function decisionSupport(uuid: string): Promise<DecisionSupport> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/decision-support/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapDecisionSupport(await readObject(response));
}

/** The revalidation work for one drifted/stale/contradicted claim (SPINE 1D). */
export interface RevalidationWork {
  claimUuid: string;
  claimType: string;
  statement: string;
  status: string;
  reason: string;
  retestRequirementUuid: string | null;
  athenaReassessments: string[];
  achillesCapabilities: string[];
}
export interface RevalidationUnknown {
  claimUuid: string;
  claimType: string;
  statement: string;
  status: string;
}
export interface RevalidationCurrent {
  claimUuid: string;
  claimType: string;
  status: string;
}
/** The minimal revalidation plan (SPINE Stage 1D): what must re-run because of a
 *  change, not "run the whole assessment again". */
export interface RevalidationPlan {
  deploymentUuid: string;
  systemFingerprint: string;
  summary: { required: number; stillCurrent: number; outstandingUnknowns: number };
  recomputeAction: string;
  required: RevalidationWork[];
  outstandingUnknowns: RevalidationUnknown[];
  stillCurrent: RevalidationCurrent[];
  note: string;
}

function mapRevalidationPlan(raw: Record<string, unknown>): RevalidationPlan {
  const summary = objOf(raw.summary);
  return {
    deploymentUuid: str(raw.deployment_uuid),
    systemFingerprint: str(raw.system_fingerprint),
    summary: {
      required: num(summary.required, 0),
      stillCurrent: num(summary.still_current, 0),
      outstandingUnknowns: num(summary.outstanding_unknowns, 0),
    },
    recomputeAction: str(raw.recompute_action),
    required: Array.isArray(raw.required)
      ? (raw.required as Record<string, unknown>[]).map((w) => ({
          claimUuid: str(w.claim_uuid),
          claimType: str(w.claim_type),
          statement: str(w.statement),
          status: str(w.status),
          reason: str(w.reason),
          retestRequirementUuid: strOrNull(w.retest_requirement_uuid),
          athenaReassessments: strList(w.athena_reassessments),
          achillesCapabilities: strList(w.achilles_capabilities),
        }))
      : [],
    outstandingUnknowns: Array.isArray(raw.outstanding_unknowns)
      ? (raw.outstanding_unknowns as Record<string, unknown>[]).map((w) => ({
          claimUuid: str(w.claim_uuid),
          claimType: str(w.claim_type),
          statement: str(w.statement),
          status: str(w.status),
        }))
      : [],
    stillCurrent: Array.isArray(raw.still_current)
      ? (raw.still_current as Record<string, unknown>[]).map((w) => ({
          claimUuid: str(w.claim_uuid),
          claimType: str(w.claim_type),
          status: str(w.status),
        }))
      : [],
    note: str(raw.note),
  };
}

/**
 * A deployment's minimal revalidation plan (SPINE Stage 1D). A read (open); a
 * non-ok answer is genuine unavailability. It names exactly what a change
 * invalidated and must re-run, and everything that stays current and need not be.
 */
export async function revalidationPlan(uuid: string): Promise<RevalidationPlan> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/revalidation-plan/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapRevalidationPlan(await readObject(response));
}

/** The counts a check-invalidations write returns (SPINE Phase 2). */
export interface InvalidationCounts {
  invalidated: number;
  retestsOpened: number;
  retestsResolved: number;
}

/**
 * Run the invalidation engine over a deployment (SPINE Phase 2). Admin-only on
 * the control plane; the BFF route gates it too. Idempotent and transactional —
 * a re-run opens no duplicate obligation. Returns the counts. Backend refusals
 * pass back with their reason.
 */
export async function checkInvalidations(uuid: string) {
  return writeJson(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/check-invalidations/`,
    "POST",
    {},
    (raw): InvalidationCounts => ({
      invalidated: num(raw.invalidated, 0),
      retestsOpened: num(raw.retests_opened, 0),
      retestsResolved: num(raw.retests_resolved, 0),
    }),
  );
}

// ---- Retest requirements (SPINE Phase 2) ----

/** An open/closed retest obligation on a claim (backend RetestRequirementSerializer). */
export interface RetestRequirement {
  uuid: string;
  deploymentUuid: string | null;
  claimUuid: string | null;
  claimType: string;
  claimTypeLabel: string;
  resolvingClaimUuid: string | null;
  reason: string;
  triggeringSystemFingerprint: string;
  actor: string | null;
  isOpen: boolean;
  openedAt: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function retestRequirement(raw: Record<string, unknown>): RetestRequirement {
  return {
    uuid: str(raw.uuid),
    deploymentUuid: strOrNull(raw.deployment_uuid),
    claimUuid: strOrNull(raw.claim_uuid),
    claimType: str(raw.claim_type),
    claimTypeLabel: str(raw.claim_type_label),
    resolvingClaimUuid: strOrNull(raw.resolving_claim_uuid),
    reason: str(raw.reason),
    triggeringSystemFingerprint: str(raw.triggering_system_fingerprint),
    actor: strOrNull(raw.actor),
    isOpen: bool(raw.is_open),
    openedAt: strOrNull(raw.opened_at),
    resolvedAt: strOrNull(raw.resolved_at),
    createdAt: strOrNull(raw.created_at),
    updatedAt: strOrNull(raw.updated_at),
  };
}

/**
 * The retest-obligation register (SPINE Phase 2), scoped like claims on the
 * backend. A read (open); a non-ok answer is genuine unavailability. DRF-
 * paginated, so every page is followed. Defaults to open; `all=true` includes
 * resolved history, `status=open|resolved` asks explicitly.
 */
export async function listRetestRequirements(
  opts: { deployment?: string; claim?: string; status?: string; all?: string } = {},
): Promise<RetestRequirement[]> {
  const query = queryString({
    deployment: opts.deployment,
    claim: opts.claim,
    status: opts.status,
    all: opts.all,
  });
  return (await pagedRows(`/api/assurance/retest-requirements/${query}`)).map(retestRequirement);
}

/**
 * A deployment's retest obligations (SPINE Phase 2). A read (open); a non-ok
 * answer is genuine unavailability. Defaults to open; `all=true` includes the
 * resolved history.
 */
export async function deploymentRetestRequirements(
  uuid: string,
  all = false,
): Promise<RetestRequirement[]> {
  const query = all ? "?all=true" : "";
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/retest-requirements/${query}`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = await response.json().catch(() => null);
  return rows(payload).map(retestRequirement);
}

// ---- Operational-risk register (Phase 3.9) ----

/** One cited signal behind an operational-risk class (asset / provider / finding).
 *  Heterogeneous by source; the common fields are carried and the source-specific
 *  ones ride along when present, never invented. */
export interface OperationalRiskSignal {
  source: string;
  reference: string;
  detail: string;
  assetName?: string;
  providerName?: string;
  findingType?: string;
  title?: string;
  severity?: string;
  kind?: string;
  kindLabel?: string;
  classification?: string;
  classificationLabel?: string;
  managed?: boolean;
}
/** One operational-risk class, honest: a real ordinal `risk` band ONLY with a
 *  basis, else `null` (unmapped) — never a fabricated 0. */
export interface OperationalRiskClass {
  key: string;
  label: string;
  concern: string;
  concernLabel: string;
  question: string;
  status: string;
  observed: boolean;
  risk: string | null;
  basis: string[];
  activeFindingCount: number;
  signals: OperationalRiskSignal[];
  runtimeSignal: string;
  notes: string[];
}
export interface OperationalRisk {
  system: { name: string; uuid: string; environment: string; environmentLabel: string };
  classes: OperationalRiskClass[];
  summary: {
    totalClasses: number;
    observedClasses: number;
    unmappedClasses: number;
    high: number;
    elevated: number;
    moderate: number;
    // Worst OBSERVED band; null (not 0) when nothing is observed.
    worstRisk: string | null;
    unmapped: string[];
  };
  overall: { status: string; risk: string | null; unmappedClasses: number; note: string };
}

function operationalRiskSignal(raw: Record<string, unknown>): OperationalRiskSignal {
  const out: OperationalRiskSignal = {
    source: str(raw.source),
    reference: str(raw.reference),
    detail: str(raw.detail),
  };
  if (typeof raw.asset_name === "string") out.assetName = raw.asset_name;
  if (typeof raw.provider_name === "string") out.providerName = raw.provider_name;
  if (typeof raw.finding_type === "string") out.findingType = raw.finding_type;
  if (typeof raw.title === "string") out.title = raw.title;
  if (typeof raw.severity === "string") out.severity = raw.severity;
  if (typeof raw.kind === "string") out.kind = raw.kind;
  if (typeof raw.kind_label === "string") out.kindLabel = raw.kind_label;
  if (typeof raw.classification === "string") out.classification = raw.classification;
  if (typeof raw.classification_label === "string") out.classificationLabel = raw.classification_label;
  if (typeof raw.managed === "boolean") out.managed = raw.managed;
  return out;
}

function operationalRiskClass(raw: Record<string, unknown>): OperationalRiskClass {
  return {
    key: str(raw.key),
    label: str(raw.label),
    concern: str(raw.concern),
    concernLabel: str(raw.concern_label),
    question: str(raw.question),
    status: str(raw.status),
    observed: bool(raw.observed),
    risk: strOrNull(raw.risk),
    basis: strList(raw.basis),
    activeFindingCount: num(raw.active_finding_count, 0),
    signals: Array.isArray(raw.signals)
      ? (raw.signals as Record<string, unknown>[]).map(operationalRiskSignal)
      : [],
    runtimeSignal: str(raw.runtime_signal),
    notes: strList(raw.notes),
  };
}

function mapOperationalRisk(raw: Record<string, unknown>): OperationalRisk {
  const system = objOf(raw.system);
  const summary = objOf(raw.summary);
  const overall = objOf(raw.overall);
  return {
    system: {
      name: str(system.name),
      uuid: str(system.uuid),
      environment: str(system.environment),
      environmentLabel: str(system.environment_label),
    },
    classes: Array.isArray(raw.classes)
      ? (raw.classes as Record<string, unknown>[]).map(operationalRiskClass)
      : [],
    summary: {
      totalClasses: num(summary.total_classes, 0),
      observedClasses: num(summary.observed_classes, 0),
      unmappedClasses: num(summary.unmapped_classes, 0),
      high: num(summary.high, 0),
      elevated: num(summary.elevated, 0),
      moderate: num(summary.moderate, 0),
      worstRisk: strOrNull(summary.worst_risk),
      unmapped: strList(summary.unmapped),
    },
    overall: {
      status: str(overall.status),
      risk: strOrNull(overall.risk),
      unmappedClasses: num(overall.unmapped_classes, 0),
      note: str(overall.note),
    },
  };
}

/**
 * A deployment's narrow operational-risk register (Phase 3.9). A read (open); a
 * non-ok answer is genuine unavailability. An honest register, not a green
 * dashboard: an unmapped class reads `unmapped` (risk null, never a fabricated
 * 0/0%), and the overall roll-up is weakest-honest, never a clean pass.
 */
export async function operationalRisk(uuid: string): Promise<OperationalRisk> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/operational-risk/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapOperationalRisk(await readObject(response));
}

// ---- Incident evidence pack (Phase 3.7) ----

export interface IncidentPackAssetProvider {
  name: string;
  kind: string;
  kindLabel: string;
}
export interface IncidentPackAsset {
  uuid: string;
  name: string;
  kind: string;
  kindLabel: string;
  classification: string;
  classificationLabel: string;
  identifier: string | null;
  provider: IncidentPackAssetProvider | null;
}
/** A finding's AI Incident Evidence Pack (Phase 3.7): a portable, verifiable pack
 *  reconstructed from the stored graph. Attests integrity and provenance, never
 *  that the conclusion is true or the system secure/fixed. */
export interface IncidentPack {
  packVersion: string;
  attests: string;
  identity: {
    deployment: {
      name: string;
      uuid: string;
      environment: string;
      environmentLabel: string;
      owner: string | null;
    };
    finding: {
      uuid: string;
      fingerprint: string;
      category: string;
      title: string;
      severity: string;
      severityLabel: string;
      status: string;
      statusLabel: string;
    };
  };
  surface: {
    asset: IncidentPackAsset | null;
    assetPresent: boolean;
    location: string | null;
    controlMapping: Record<string, unknown>;
  };
  evidence: { algorithm: string; rows: string[][]; count: number; evidenceClass: string };
  receipt: { algorithm: string; digest: string; evidenceCount: number };
  runtimeTranscript: {
    inAssuranceRecord: boolean;
    see: string;
    reason: string;
    enginePackRef: { available: boolean; scanUuid: string | null; engineRunId: string | null };
  };
  ripple: {
    isTracedOrigin: boolean;
    origins: RippleOrigin[];
    consequences: RippleConsequence[];
    deploymentSummary: {
      origins: number;
      originsWithReach: number;
      consequences: number;
      evidencedConsequences: number;
      bounded: boolean;
      byCategory: Record<string, number>;
      worstRisk: string | null;
    };
    note: string | null;
  };
  decision: { decision: string | null; decisionLabel: string | null };
  algorithm: string;
  digest: string;
  computedAt: string | null;
}

function incidentPackAsset(raw: unknown): IncidentPackAsset | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const provider = a.provider;
  return {
    uuid: str(a.uuid),
    name: str(a.name),
    kind: str(a.kind),
    kindLabel: str(a.kind_label),
    classification: str(a.classification),
    classificationLabel: str(a.classification_label),
    identifier: strOrNull(a.identifier),
    provider:
      provider && typeof provider === "object" && !Array.isArray(provider)
        ? {
            name: str((provider as Record<string, unknown>).name),
            kind: str((provider as Record<string, unknown>).kind),
            kindLabel: str((provider as Record<string, unknown>).kind_label),
          }
        : null,
  };
}

function evidenceRows(raw: unknown): string[][] {
  return Array.isArray(raw)
    ? raw.map((row) => (Array.isArray(row) ? row.filter((v): v is string => typeof v === "string") : []))
    : [];
}

function mapIncidentPack(raw: Record<string, unknown>): IncidentPack {
  const identity = objOf(raw.identity);
  const dep = objOf(identity.deployment);
  const find = objOf(identity.finding);
  const surface = objOf(raw.surface);
  const evidence = objOf(raw.evidence);
  const receipt = objOf(raw.receipt);
  const transcript = objOf(raw.runtime_transcript);
  const enginePackRef = objOf(transcript.engine_pack_ref);
  const ripple = objOf(raw.ripple);
  const rippleSummary = objOf(ripple.deployment_summary);
  const decision = objOf(raw.decision);
  return {
    packVersion: str(raw.pack_version),
    attests: str(raw.attests),
    identity: {
      deployment: {
        name: str(dep.name),
        uuid: str(dep.uuid),
        environment: str(dep.environment),
        environmentLabel: str(dep.environment_label),
        owner: strOrNull(dep.owner),
      },
      finding: {
        uuid: str(find.uuid),
        fingerprint: str(find.fingerprint),
        category: str(find.category),
        title: str(find.title),
        severity: str(find.severity),
        severityLabel: str(find.severity_label),
        status: str(find.status),
        statusLabel: str(find.status_label),
      },
    },
    surface: {
      asset: incidentPackAsset(surface.asset),
      assetPresent: bool(surface.asset_present),
      location: strOrNull(surface.location),
      controlMapping: objOf(surface.control_mapping),
    },
    evidence: {
      algorithm: str(evidence.algorithm),
      rows: evidenceRows(evidence.rows),
      count: num(evidence.count, 0),
      evidenceClass: str(evidence.evidence_class),
    },
    receipt: {
      algorithm: str(receipt.algorithm),
      digest: str(receipt.digest),
      evidenceCount: num(receipt.evidence_count, 0),
    },
    runtimeTranscript: {
      inAssuranceRecord: bool(transcript.in_assurance_record),
      see: str(transcript.see),
      reason: str(transcript.reason),
      enginePackRef: {
        available: bool(enginePackRef.available),
        scanUuid: strOrNull(enginePackRef.scan_uuid),
        engineRunId: strOrNull(enginePackRef.engine_run_id),
      },
    },
    ripple: {
      isTracedOrigin: bool(ripple.is_traced_origin),
      origins: Array.isArray(ripple.origins)
        ? (ripple.origins as Record<string, unknown>[]).map(rippleOrigin)
        : [],
      consequences: Array.isArray(ripple.consequences)
        ? (ripple.consequences as Record<string, unknown>[]).map(rippleConsequence)
        : [],
      deploymentSummary: {
        origins: num(rippleSummary.origins, 0),
        originsWithReach: num(rippleSummary.origins_with_reach, 0),
        consequences: num(rippleSummary.consequences, 0),
        evidencedConsequences: num(rippleSummary.evidenced_consequences, 0),
        bounded: bool(rippleSummary.bounded),
        byCategory: numRecord(rippleSummary.by_category),
        worstRisk: strOrNull(rippleSummary.worst_risk),
      },
      note: strOrNull(ripple.note),
    },
    decision: {
      decision: strOrNull(decision.decision),
      decisionLabel: strOrNull(decision.decision_label),
    },
    algorithm: str(raw.algorithm),
    digest: str(raw.digest),
    computedAt: strOrNull(raw.computed_at),
  };
}

/**
 * A finding's AI Incident Evidence Pack (Phase 3.7). A read (open); a non-ok
 * answer is genuine unavailability. Computed, never stored; it attests integrity
 * and provenance, never that the incident conclusion is true or the system fixed.
 * The runtime transcript is stated as an explicit gap, never fabricated.
 */
export async function incidentPack(uuid: string): Promise<IncidentPack> {
  const response = await call(
    `/api/assurance/findings/${encodeURIComponent(uuid)}/incident-pack/`,
  );
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapIncidentPack(await readObject(response));
}

// ---- Outbound connectors (commercial spine) ----

/** One outbound connector and whether it is configured. */
export interface ConnectorRef {
  name: string;
  configured: boolean;
}
export interface ConnectorsView {
  connectors: ConnectorRef[];
}
/** What an outbound push did, reported honestly. `ok` is whether the external
 *  system accepted it; an unconfigured connector is inert (`ok:false`). */
export interface ConnectorPushResult {
  ok: boolean;
  externalRef: string | null;
  detail: string;
  connector: string;
}

function mapConnectors(raw: Record<string, unknown>): ConnectorsView {
  return {
    connectors: Array.isArray(raw.connectors)
      ? (raw.connectors as Record<string, unknown>[]).map((c) => ({
          name: str(c.name),
          configured: bool(c.configured),
        }))
      : [],
  };
}

/**
 * A deployment's outbound connectors and whether each is configured (commercial
 * spine). A read (open); a non-ok answer is genuine unavailability. It triggers
 * nothing — it just says which integrations exist and which are inert for lack
 * of credentials.
 */
export async function connectors(uuid: string): Promise<ConnectorsView> {
  const response = await call(`/api/assurance/deployments/${encodeURIComponent(uuid)}/connectors/`);
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return mapConnectors(await readObject(response));
}

/**
 * Push one of a deployment's findings out to an external system (commercial
 * spine). Admin-only on the control plane; the BFF route gates it too. The
 * connector's result is always HTTP 200 — read `ok`, not the status (the house
 * idiom): with no credentials the connector is inert and returns `{ok:false,
 * detail:"<name> not configured"}` making no network call. A backend refusal (an
 * unknown connector or a finding not in this deployment, a 400/404) is passed
 * back with its reason rather than laundered into a 503.
 */
export async function pushConnector(
  uuid: string,
  connector: string,
  finding: string,
): Promise<
  | { ok: true; value: ConnectorPushResult }
  | { ok: false; status: number; detail: string }
> {
  const response = await call(
    `/api/assurance/deployments/${encodeURIComponent(uuid)}/connectors/${encodeURIComponent(connector)}/push/`,
    { method: "POST", body: JSON.stringify({ finding }) },
  );
  if (PASSTHROUGH_STATUS.has(response.status)) {
    return { ok: false, status: response.status, detail: await body(response) };
  }
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = await readObject(response);
  return {
    ok: true,
    value: {
      ok: bool(payload.ok),
      externalRef: strOrNull(payload.external_ref),
      detail: str(payload.detail),
      connector: str(payload.connector),
    },
  };
}
