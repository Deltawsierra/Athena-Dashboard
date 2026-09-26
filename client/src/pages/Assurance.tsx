/**
 * Assurance: the system of record, read straight from the Athena control plane.
 *
 * The other pages read this desktop app's own store; this one reads the Django
 * backend that is the source of truth for the assurance graph — the deployments
 * under assurance and their six-state decision (Phase 0.5), the findings graded
 * by how strongly each is known (evidence classification, Phase 0.3), the assets
 * each deployment is built from (Phase 1.1), the providers it depends on and
 * their declared profiles (Phase 1.5), and the Unknowns Register (Phase 0.4):
 * the gaps the evidence could not close, tracked as managed objects instead of
 * rounded down to "fine" or up to "broken".
 *
 * The default Graph view assembles those flat records into the shape they
 * actually have — Deployment → Assets → Findings, with each deployment's
 * Unknowns and the providers it depends on — so a reader sees a system, not five
 * disconnected tables. A List view keeps the flat registries for when a reader
 * wants every finding or the full provider profiles in one place.
 *
 * It is honest about its own absence. When no control plane is configured, or
 * it cannot be reached, the page says so in words and shows nothing invented —
 * an unconfigured backend is a fact about the deployment, not an error to hide.
 * Nothing here decides anything: it surfaces the backend's conclusions so a
 * human can make the release decision from them.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { loaded } from "@/lib/loaded";
import { type Query, useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Boxes,
  Briefcase,
  Building2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Cpu,
  Download,
  FileText,
  Fingerprint,
  GitBranch,
  HelpCircle,
  History,
  LayoutList,
  Network,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  Route,
  Scale,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
  User,
  Waypoints,
  Wrench,
  Zap,
} from "lucide-react";
import PageHero from "@/components/mythos/PageHero";
import GlassCard from "@/components/GlassCard";
import { Divider } from "@/components/mythos/Ornament";
import {
  AssetClassChip,
  DecisionPill,
  EvidenceClassChip,
  SeverityPill,
  type Severity,
} from "@/components/mythos/atoms";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface AssuranceStatus {
  configured: boolean;
  reachable: boolean;
  authorized: boolean | null;
  url: string | null;
  detail: string;
}
interface Deployment {
  uuid: string;
  name: string;
  environment: string;
  decision: string | null;
  decisionLabel: string;
  findingCount: number;
  updatedAt: string | null;
}
interface Finding {
  uuid: string;
  deploymentUuid: string | null;
  title: string;
  severity: string;
  // The security disposition: the slug, the backend's own label for it, and what
  // it must NOT be read as. All three are served (assurance/models.py carries the
  // caveat as data) so this console cannot invent its own wording for a state
  // whose wrong reading is the reason the state exists.
  status: string;
  statusLabel: string;
  statusMustNotImply: string | null;
  evidenceClass: string;
  location: string;
  assetUuid: string | null;
  assetName: string | null;
  // Change intelligence (spine): state vs the deployment's latest scan.
  changeStatus: string;
  changeLabel: string;
  ageDays: number | null;
  stale: boolean;
  // Assurance receipt (spine): a recomputable digest over the finding's evidence.
  // No signature comes with it; see FindingReceiptMark for what it can show.
  receipt: { algorithm: string; digest: string; evidenceCount?: number };
  // Remediation workflow (Phase 2.3): the human process of getting the finding
  // fixed — who owns it and where it is in the six-state pipeline. Read-only on
  // the finding; changed via the dedicated remediation endpoints. NOT the
  // security disposition (see `status`).
  assignee: string | null;
  remediationState: string;
}
// The full remediation workflow for one finding, read from
// `/api/assurance/findings/:uuid/remediation` (Phase 2.3). The `events` are the
// attributed audit trail of moves; `state` is the current workflow state, which
// is the human process of getting the finding fixed — NOT its security status.
interface RemediationEvent {
  fromState: string | null;
  toState: string;
  actor: string | null;
  note: string;
  createdAt: string | null;
}
interface RemediationDetail {
  state: string;
  stateLabel: string;
  assignee: string | null;
  events: RemediationEvent[];
}
interface Asset {
  uuid: string;
  deploymentUuid: string | null;
  kind: string;
  kindLabel: string;
  name: string;
  identifier: string;
  classification: string;
  classificationLabel: string;
  providerUuid: string | null;
  providerName: string | null;
  findingCount: number;
}
interface Assertion {
  uuid: string;
  field: string;
  fieldLabel: string;
  value: string;
  evidenceClass: string;
  evidenceClassLabel: string;
  source: string;
  sourceLabel: string;
}
interface Provider {
  uuid: string;
  name: string;
  kind: string;
  kindLabel: string;
  assertions: Assertion[];
  profile: { declaredFields: number; weakestEvidence: string | null };
}
interface Unknown {
  uuid: string;
  deploymentUuid: string | null;
  question: string;
  whyItMatters: string;
  evidenceNeeded: string;
  deploymentImpact: string;
  impactLabel: string;
  status: string;
  statusLabel: string;
  source: string;
  reviewBy: string | null;
}
interface CapabilitySource {
  assetName: string;
  kind: string;
  kindLabel: string;
  classification: string;
  classificationLabel: string;
  managed: boolean;
  detail: string;
}
interface Capability {
  key: string;
  label: string;
  category: string;
  description: string;
  risk: string;
  declared: boolean;
  shadow: boolean;
  sources: CapabilitySource[];
}
interface CapabilityMap {
  capabilities: Capability[];
  categories: { category: string; count: number; maxRisk: string }[];
  summary: { total: number; highRisk: number; elevated: number; baseline: number; declared: number; shadow: number };
}
interface RouteNode {
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
interface RouteEdge {
  source: string;
  target: string;
  kind: string;
  label: string;
  declared: boolean;
}
// A reference the inventory declares and discovery could not place. The backend
// resolves every asset-to-asset edge at read time from strings in the asset's
// metadata; both readers of that graph — the reach assessment and the route map —
// report a miss in this one shape, so the console describes the same gap the same
// way wherever it appears.
//
// `reasons` is every reason the reference is reported for, `reason` first: one
// reference is one row however many reasons hold.
interface UnresolvedReference {
  source: string;
  sourceKind: string;
  reference: string;
  mechanism: string;
  reason: string | null;
  reasons: string[];
}
interface RouteMap {
  layers: { key: string; label: string; nodes: RouteNode[] }[];
  nodes: RouteNode[];
  edges: RouteEdge[];
  unresolved: UnresolvedReference[] | null;
  summary: {
    nodeCount: number;
    edgeCount: number;
    declaredEdges: number;
    inferredEdges: number;
    shadowNodes: number;
    unresolvedEdges: number | null;
    unresolvedToolReferences: number | null;
    unresolvedServerReferences: number | null;
    unresolvedIdentityReferences: number | null;
    layersPresent: string[];
    logsObserved: boolean;
  };
}
interface BomComponent {
  uuid: string;
  name: string;
  kind: string;
  kindLabel: string;
  identifier: string;
  classification: string;
  classificationLabel: string;
  shadow: boolean;
  providerName: string | null;
  facts: Record<string, unknown>;
}
interface BomProviderFact {
  field: string;
  fieldLabel: string;
  value: string;
  evidenceClass: string;
  evidenceClassLabel: string;
}
interface BomProvider {
  uuid: string;
  name: string;
  kindLabel: string;
  region: string;
  declaredFacts: BomProviderFact[];
  weakestEvidence: string | null;
}
interface AiBom {
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
interface BoundaryPosture {
  value: string;
  evidenceClass: string;
}
interface BoundaryFlow {
  providerUuid: string;
  providerName: string;
  kind: string;
  kindLabel: string;
  assets: string[];
  region: BoundaryPosture | null;
  training: BoundaryPosture | null;
  status: string;
  violations: string[];
  unknowns: string[];
}
interface BoundaryShadow {
  assetName: string;
  kind: string;
  kindLabel: string;
  identifier: string;
}
interface DataBoundary {
  declared: boolean;
  policy: {
    allowedRegions: string[];
    trainingAllowed: boolean;
    thirdPartySharingAllowed: boolean;
    notes: string;
    updatedAt: string | null;
  } | null;
  flows: BoundaryFlow[];
  shadowDestinations: BoundaryShadow[];
  summary: { approved: number; violations: number; unknowns: number; shadowDestinations: number };
}
interface ComplianceControl {
  controlId: string;
  name: string | null;
  family: string | null;
  familyName: string | null;
  catalogued: boolean;
  activeFindingCount: number;
  resolvedFindingCount: number;
  worstSeverity: string | null;
  findingTypes: string[];
}
interface ComplianceFramework {
  key: string;
  name: string;
  controls: ComplianceControl[];
  summary: { controlsTouched: number; controlsWithActiveFindings: number; worstSeverity: string | null };
}
interface ComplianceUnmapped {
  findingType: string;
  activeFindingCount: number;
  resolvedFindingCount: number;
  worstSeverity: string | null;
}
interface ComplianceEngineReference {
  taxonomy: string;
  id: string;
  findingCount: number;
  findingTypes: string[];
}
interface Compliance {
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

interface BusinessImpactDimension {
  key: string;
  label: string;
  description: string;
  activeFindingCount: number;
  resolvedFindingCount: number;
  worstSeverity: string | null;
  exposureBand: string | null;
  findingTypes: string[];
}
interface BusinessImpactUnmapped {
  findingType: string;
  activeFindingCount: number;
  resolvedFindingCount: number;
  worstSeverity: string | null;
}
interface BusinessImpact {
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

// The full, versioned Assurance Receipt (spine): the roadmap tuple — system,
// receipt version, policy, evidence root, result, per-assessment digests — as one
// deterministic, portable, signable payload. Its digests identify one recorded
// state; they show a change only against a copy obtained independently or one a
// verified signature covers, and never that the conclusions are true or the
// system is secure. Whether this copy is signed is the backend's to say
// (`signed`, null when it did not). An undeclared policy reads as
// declared:false, never an invented boundary.
interface AssuranceReceipt {
  receiptVersion: string;
  system: { name: string; uuid: string; environment: string; environmentLabel: string };
  result: { decision: string | null; decisionLabel: string | null };
  policy:
    | { declared: false }
    | {
        declared: true;
        allowedRegions: string[];
        trainingAllowed: boolean;
        thirdPartySharingAllowed: boolean;
      };
  evidence: { algorithm: string; root: string; findingCount: number };
  assessments: { compliance: string; capabilities: string; boundary: string; bom: string };
  algorithm: string;
  digest: string;
  computedAt: string | null;
  signed: boolean | null;
  unsignedReason: string | null;
}

// Third-Party Vendor Assurance (commercial spine): the posture of the vendors a
// deployment leans on. HONEST by construction — a vendor claim reads as a vendor
// claim (`independentlyEvidenced` is true only for evidence stronger than a bare
// vendor claim from a non-self-declared source), nothing is claimed secure
// (`postureBand` is an ordinal concern signal, not a grade), and an ungoverned
// dependency is surfaced, never dropped.
interface VendorAssertion {
  field: string;
  fieldLabel: string;
  value: string;
  evidenceClass: string;
  evidenceClassLabel: string;
  source: string;
  sourceLabel: string;
  independentlyEvidenced: boolean;
  gap: boolean;
}
interface VendorDependentAsset {
  assetName: string;
  kind: string;
  kindLabel: string;
  classification: string;
  classificationLabel: string;
  managed: boolean;
}
interface Vendor {
  providerUuid: string;
  providerName: string;
  kind: string;
  kindLabel: string;
  region: string;
  assertions: VendorAssertion[];
  dependentAssets: VendorDependentAsset[];
  gaps: string[];
  weakestEvidence: string | null;
  postureBand: string;
  summary: {
    assertionCount: number;
    independentlyEvidenced: number;
    vendorAsserted: number;
    gapCount: number;
    dependentAssetCount: number;
    unmanagedDependencies: number;
  };
}
interface UngovernedDependency {
  assetName: string;
  kind: string;
  kindLabel: string;
  classification: string;
  classificationLabel: string;
  reason: string;
}
interface VendorAssurance {
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
    worstPostureBand: string | null;
  };
}

// Executive summary (commercial spine): the assurance graph rolled up for a
// leadership reader. Every value is a real count, a TRUE ratio of two real counts
// (null when there is no basis to compute — never a fake 0%), or an ordinal band.
// There is NO dollar figure or ROI amount anywhere, by design.
interface ExecutiveSummary {
  system: { name: string; uuid: string; environment: string; environmentLabel: string };
  decision: { decision: string | null; decisionLabel: string | null };
  assetCoverage: {
    totalAssets: number;
    classified: number;
    managed: number;
    unknown: number;
    shadow: number;
    highRisk: number;
    byClassification: Record<string, number>;
    coverageRatio: number | null;
    managedRatio: number | null;
  };
  evidence: {
    byClass: Record<string, number>;
    independentlyEvidenced: number;
    unverified: number;
    findingCount: number;
  };
  findings: {
    total: number;
    active: number;
    resolved: number;
    activeBySeverity: Record<string, number>;
    worstActiveSeverity: string | null;
  };
  remediation: {
    open: number;
    resolved: number;
    wontFix: number;
    byState: Record<string, number>;
    statesReached: string[];
    eventCount: number;
    resolutionRatio: number | null;
  };
  assessments: {
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
  };
  posture: string;
  assuranceMaturity: string;
}

// Operational / continuous-assurance roll-up (commercial spine): where a deployment
// sits in the continuous-assurance loop, tying the existing signals — evidence
// freshness/staleness, the change backlog needing reassessment, remediation
// velocity, and the six-state decision — under one ordinal readiness band. Every
// value is a real count, a TRUE ratio of real counts (null when there is no basis
// to compute, NEVER a fake 0%), or an ordinal band. The readiness band is weakest-
// wins and never green-by-default; a resolved remediation is a PROCESS claim.
interface OperationalAssurance {
  system: { name: string; uuid: string; environment: string; environmentLabel: string };
  decision: { decision: string | null; decisionLabel: string | null };
  evidenceFreshness: {
    total: number;
    current: number;
    stale: number;
    ttlDays: number | null;
    freshnessRatio: number | null;
  };
  changeBacklog: {
    total: number;
    new: number;
    recurring: number;
    cleared: number;
    byStatus: Record<string, number>;
    needsReassessment: number;
    needsReassessmentRatio: number | null;
  };
  remediation: {
    open: number;
    resolved: number;
    wontFix: number;
    byState: Record<string, number>;
    statesReached: string[];
    eventCount: number;
    resolutionRatio: number | null;
  };
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

// Vertical Assurance Packs (commercial spine): the compliance map read through an
// industry lens. A pack's `frameworks` are computed coverage; its
// `regulatoryRegimes` are CONTEXT, each carrying a note that Athena holds no
// control catalog for it — never scored/passing coverage.
interface Pack {
  key: string;
  name: string;
  vertical: string;
  description: string;
  frameworks: string[];
  frameworkNames: Record<string, string>;
  regulatoryRegimes: string[];
  evidenceExpectations: string[];
}
interface PacksCatalog {
  packs: Pack[];
  summary: { packs: number };
}
interface RegulatoryRegime {
  name: string;
  note: string;
}
interface PackApplied {
  pack: Pack;
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

// ==== Access & Blast Radius (Phase 3.1 + 2.5) ====
interface AccessCapabilitySource {
  assetName: string;
  permission: string;
}
interface AccessCapability {
  key: string;
  label: string;
  category: string;
  risk: string;
  sources: AccessCapabilitySource[];
}
interface AccessReach {
  target: string;
  targetKind: string;
  targetKindLabel: string;
  targetClassification: string | null;
  targetManaged: boolean;
  via: string[];
  capability: string;
  risk: string;
}
interface AccessGap {
  type: string;
  risk: string;
  detail: string;
  capabilities?: string[];
  categories?: string[];
  targets?: string[];
}
interface AccessPrincipal {
  key: string;
  name: string;
  kind: string;
  kindLabel: string;
  classification: string | null;
  classificationLabel: string | null;
  managed: boolean;
  shadow: boolean;
  privilegeLevel: string;
  capabilities: AccessCapability[];
  effectiveReach: AccessReach[];
  gaps: AccessGap[];
  risk: string;
  privileged: boolean;
  overBroad: boolean;
  orphaned: boolean;
}
interface EffectiveAccess {
  principals: AccessPrincipal[];
  unresolved: UnresolvedReference[] | null;
  summary: {
    principals: number;
    privileged: number;
    shadow: number;
    orphaned: number;
    overBroad: number;
    highRiskReach: number;
    unresolvedReferences: number | null;
    worstRisk: string | null;
  };
}
interface RippleFinding {
  uuid: string;
  findingType: string;
  severity: string;
  title: string;
}
interface RippleOrigin {
  key: string;
  origin: string;
  originTypes: string[];
  reasons: string[];
  risk: string;
  findings: RippleFinding[];
  principalKind?: string;
  principalKindLabel?: string;
  privilegeLevel?: string;
  evidencedReach: boolean;
  consequenceCount: number;
  note: string | null;
}
interface RippleConsequence {
  origin: string;
  originKey: string;
  consequence: string;
  category: string;
  categoryLabel: string;
  target: string;
  targets: string[];
  via: string[];
  risk: string;
  potential: boolean;
  evidenceBasis: string[];
}
interface RippleEffect {
  origins: RippleOrigin[];
  consequences: RippleConsequence[];
  summary: {
    origins: number;
    originsWithReach: number;
    consequences: number;
    evidencedConsequences: number;
    bounded: boolean | null;
    byCategory: Record<string, number>;
    worstRisk: string | null;
  };
}

// ==== Posture, credential-gated (Phase 3.2 / 3.3 / 3.4) ====
interface PostureDomainRef {
  name: string;
  label: string;
  configured: boolean;
}
interface PostureCatalog {
  domains: PostureDomainRef[];
}
interface PostureCheckCatalog {
  check: string;
  title: string;
  severity: string;
  category: string;
  resource: string;
  description: string;
}
interface PostureFinding {
  check: string;
  title: string;
  status: string;
  severity: string;
  evidenceClass: string;
  evidenceClassLabel: string;
  detail: string;
  resource: string;
  category: string;
}
interface PostureDomain {
  domain: string;
  domainLabel: string;
  connected: boolean;
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
    weakestEvidence: string | null;
  };
}

// ==== Data & Context (Phase 3.5) ====
interface PersonalReader {
  principal: string;
  principalKind: string;
  principalKindLabel: string;
  privilegeLevel: string;
  shadow: boolean;
  overBroad: boolean;
  risk: string;
  via: string[];
}
interface PersonalGap {
  type: string;
  risk: string;
  detail: string;
  principals?: string[];
  assetName?: string;
}
interface PersonalStore {
  assetName: string;
  kind: string;
  kindLabel: string;
  identifier: string;
  classification: string;
  classificationLabel: string;
  managed: boolean;
  providerName: string | null;
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
interface PersonalContext {
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
interface LifecycleComponent {
  name: string;
  kindLabel: string;
  how: string;
  evidenceClass: string;
  evidenceClassLabel: string;
}
interface LifecycleStage {
  stage: string;
  stageLabel: string;
  controlStage: boolean;
  evidenced: boolean;
  components: LifecycleComponent[];
  weakestEvidence: string | null;
  weakestEvidenceLabel: string | null;
  gap: boolean | null;
  gapDetail: string | null;
  risk: string;
}
interface LifecycleGap {
  stage: string;
  stageLabel: string;
  risk: string;
  detail: string;
}
interface DataLifecycle {
  stages: LifecycleStage[];
  gaps: LifecycleGap[];
  summary: {
    stagesTotal: number | null;
    evidenced: number | null;
    notEvidenced: number;
    controlGaps: number;
    worstRisk: string | null;
  };
}
interface ReusePosture {
  field: string;
  fieldLabel: string;
  concern: string;
  value: string;
  posture: string;
  evidenceClass: string;
  evidenceClassLabel: string;
  source: string;
  sourceLabel: string;
  verified: boolean;
}
interface TrainingDependentAsset {
  assetName: string;
  kind: string;
  kindLabel: string;
  classification: string;
  classificationLabel: string;
  managed: boolean;
}
interface TrainingGap {
  type: string;
  field: string;
  risk: string;
  detail: string;
  providerName?: string;
}
interface TrainingProvider {
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
interface TrainingReuse {
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
interface LogCategory {
  category: string;
  label: string;
  basis: string;
}
interface MetadataGap {
  type: string;
  risk: string;
  detail: string;
  assetName?: string;
}
interface LogSink {
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
interface HandledCategory {
  category: string;
  basis: string;
  label: string;
}
interface MetadataLogging {
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

type ViewMode = "graph" | "list";

const UNKNOWN_STATUSES = ["open", "investigating", "resolved", "accepted"] as const;
function isOpenUnknown(u: Unknown): boolean {
  return u.status === "open" || u.status === "investigating";
}

// The classifications that need attention lead: an unmanaged or high-risk asset
// is the one an operator has to see first, an approved or retired one last. An
// unrecognised classification sorts after the known order rather than vanishing.
const ASSET_CLASS_ORDER = ["high_risk", "unmanaged", "unknown", "known", "approved", "retired"];
function assetRank(classification: string): number {
  const i = ASSET_CLASS_ORDER.indexOf(classification);
  return i === -1 ? ASSET_CLASS_ORDER.length : i;
}

// Deployments lead with the ones that need a decision-maker's attention: a
// not-recommended or remediation-needed system before a clean one. A deployment
// with no decision yet is not hidden at the bottom as if it were fine — it sits
// among the middle, because "not assessed" is a state a reader must notice.
const DECISION_RANK: Record<string, number> = {
  not_recommended: 0,
  needs_remediation: 1,
  needs_more_evidence: 2,
  unassessed: 3,
  ready_restricted: 4,
  paused: 5,
  ready: 6,
};
function decisionRank(decision: string | null): number {
  const key = decision ?? "unassessed";
  return key in DECISION_RANK ? DECISION_RANK[key] : DECISION_RANK.unassessed;
}

const IMPACT_TONE: Record<string, string> = {
  high: "text-sev-high",
  medium: "text-sev-medium",
  low: "text-emerald-400",
};

/** Group rows by a string key; rows whose key is null/empty are dropped (a
 *  finding, asset or unknown with no deployment has no place in the graph). */
function groupBy<T>(rows: T[], keyOf: (row: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const list = m.get(key);
    if (list) list.push(row);
    else m.set(key, [row]);
  }
  return m;
}

// The admin editing vocabularies, kept in lockstep with assurance/models.py and
// the BFF's write schemas so the console never offers a choice the backend
// rejects. [value, label] pairs, strongest evidence first.
const FIELD_OPTIONS: [string, string][] = [
  ["region", "Data region"],
  ["data_retention", "Data retention"],
  ["logging", "Logging"],
  ["trains_on_data", "Trains on customer data"],
  ["subprocessors", "Subprocessors"],
  ["certifications", "Certifications"],
  ["dpa", "Data-processing agreement"],
];
const EVIDENCE_OPTIONS: [string, string][] = [
  ["technically_verified", "Technically verified"],
  ["configuration_verified", "Config verified"],
  ["document_supported", "Document supported"],
  ["contractually_stated", "Contractually stated"],
  ["vendor_asserted", "Vendor asserted"],
  ["partially_verified", "Partially verified"],
  ["unknown", "Unknown"],
  ["not_documented", "Not documented"],
];
const SOURCE_OPTIONS: [string, string][] = [
  ["vendor_doc", "Vendor documentation"],
  ["contract", "Contract / DPA"],
  ["self_declared", "Self-declared"],
  ["measured", "Independently measured"],
];
const PROVIDER_KIND_OPTIONS: [string, string][] = [
  ["model_provider", "Model provider"],
  ["gateway", "AI gateway"],
  ["embedding", "Embedding provider"],
  ["vector_db", "Vector database"],
  ["observability", "Observability / logging"],
  ["cloud", "Cloud"],
  ["other", "Other"],
];

const fieldInput =
  "rounded-md border border-border/60 bg-surface-1/60 px-2 py-1 text-[12px] text-foreground";

/** The values an assertion form collects. `field` is set only when creating. */
interface AssertionFormValue {
  field?: string;
  value: string;
  evidenceClass: string;
  source: string;
}

/**
 * A form for recording or editing one graded provider fact. When `fieldChoices`
 * is given it is a create form (the field is chosen from the ones not yet
 * declared); otherwise it edits an existing fact in place and the field is
 * fixed. Evidence class defaults to `vendor_asserted` — a fact is a claim until
 * something stronger backs it.
 */
function AssertionForm({
  fieldChoices,
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  fieldChoices?: [string, string][];
  initial?: Partial<AssertionFormValue>;
  submitLabel: string;
  pending: boolean;
  onSubmit: (v: AssertionFormValue) => void;
  onCancel: () => void;
}) {
  const [field, setField] = useState(initial?.field ?? fieldChoices?.[0]?.[0] ?? "");
  const [value, setValue] = useState(initial?.value ?? "");
  const [evidenceClass, setEvidenceClass] = useState(initial?.evidenceClass ?? "vendor_asserted");
  const [source, setSource] = useState(initial?.source ?? "self_declared");
  const isCreate = fieldChoices !== undefined;

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-primary/30 bg-surface-1/40 p-3">
      {isCreate && (
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          Fact
          <select className={fieldInput} value={field} onChange={(e) => setField(e.target.value)}>
            {fieldChoices!.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      )}
      <textarea
        className={cn(fieldInput, "w-full")}
        rows={2}
        value={value}
        placeholder="The vendor's stated value — e.g. 'us-east-1', '30 days', 'No — zero-retention endpoint', 'SOC 2 Type II'"
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          Evidence
          <select
            className={fieldInput}
            value={evidenceClass}
            onChange={(e) => setEvidenceClass(e.target.value)}
          >
            {EVIDENCE_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          Source
          <select className={fieldInput} value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCE_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="rounded-md bg-primary/15 px-3 py-1 text-[12px] font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
          disabled={pending || (isCreate && !field)}
          onClick={() => onSubmit({ field: isCreate ? field : undefined, value, evidenceClass, source })}
        >
          {submitLabel}
        </button>
        <button
          className="text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A form for registering a provider a deployment relies on. */
function ProviderForm({
  pending,
  onSubmit,
  onCancel,
  initial,
  submitLabel = "Add provider",
}: {
  pending: boolean;
  onSubmit: (v: { name: string; kind: string }) => void;
  onCancel: () => void;
  initial?: { name: string; kind: string };
  submitLabel?: string;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState(initial?.kind ?? "model_provider");
  return (
    <div className="mb-3 space-y-2 rounded-lg border border-primary/30 bg-surface-1/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={cn(fieldInput, "min-w-[12rem] flex-1")}
          value={name}
          placeholder="Provider name — e.g. Pinecone, Cloudflare AI Gateway"
          onChange={(e) => setName(e.target.value)}
        />
        <select className={fieldInput} value={kind} onChange={(e) => setKind(e.target.value)}>
          {PROVIDER_KIND_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="rounded-md bg-primary/15 px-3 py-1 text-[12px] font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
          disabled={pending || !name.trim()}
          onClick={() => onSubmit({ name: name.trim(), kind })}
        >
          {submitLabel}
        </button>
        <button
          className="text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

interface ProviderMutations {
  createProvider: (v: { name: string; kind: string }) => Promise<unknown>;
  creatingProvider: boolean;
  updateProvider: (uuid: string, patch: { name: string; kind: string }) => Promise<unknown>;
  updatingProviderUuid: string | null;
  createAssertion: (v: {
    provider: string;
    field: string;
    value: string;
    evidenceClass: string;
    source: string;
  }) => Promise<unknown>;
  creatingAssertion: boolean;
  updateAssertion: (
    uuid: string,
    patch: { value: string; evidenceClass: string; source: string },
  ) => Promise<unknown>;
  updatingAssertionUuid: string | null;
  deleteAssertion: (uuid: string) => Promise<unknown>;
  deletingAssertionUuid: string | null;
}

/**
 * The provider registry with its admin editing controls. Reads render for
 * everyone; the create/edit/delete affordances render only for an admin, and
 * even then the control plane is the real gate — a non-admin who forged a
 * request is refused there. Forms close on a resolved write and stay open on a
 * rejected one (the mutation surfaces the backend's reason in a toast), so an
 * operator never loses what they typed to a refusal.
 */
function ProvidersRegistry({
  providers,
  admin,
  m,
}: {
  providers: Provider[];
  admin: boolean;
  m: ProviderMutations;
}) {
  const [addingProvider, setAddingProvider] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [addingAssertionFor, setAddingAssertionFor] = useState<string | null>(null);
  const [editingAssertion, setEditingAssertion] = useState<string | null>(null);

  const submitNewProvider = async (v: { name: string; kind: string }) => {
    try {
      await m.createProvider(v);
      setAddingProvider(false);
    } catch {
      /* the mutation toasts the reason; keep the form open */
    }
  };

  return (
    <GlassCard>
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-primary" />
          <h2 className="text-[15px] font-semibold text-foreground">Providers</h2>
        </div>
        {admin && !addingProvider && (
          <button
            className="inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
            onClick={() => setAddingProvider(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            Add provider
          </button>
        )}
      </div>

      {admin && addingProvider && (
        <ProviderForm
          pending={m.creatingProvider}
          onSubmit={submitNewProvider}
          onCancel={() => setAddingProvider(false)}
        />
      )}

      {providers.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {admin
            ? "No providers recorded yet. Add the vendors this deployment relies on."
            : "No providers recorded yet."}
        </p>
      ) : (
        <ul className="space-y-3">
          {providers.map((p) => {
            const declaredFields = new Set(p.assertions.map((a) => a.field));
            const availableFields = FIELD_OPTIONS.filter(([v]) => !declaredFields.has(v));
            return (
              <li key={p.uuid} className="rounded-lg border border-border/40 bg-surface-0/40 p-3">
                {admin && editingProvider === p.uuid ? (
                  <ProviderForm
                    initial={{ name: p.name, kind: p.kind }}
                    submitLabel="Save"
                    pending={m.updatingProviderUuid === p.uuid}
                    onSubmit={async (v) => {
                      try {
                        await m.updateProvider(p.uuid, v);
                        setEditingProvider(null);
                      } catch {
                        /* keep the form open; the reason is toasted */
                      }
                    }}
                    onCancel={() => setEditingProvider(null)}
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="text-[13px] font-semibold text-foreground">{p.name}</span>
                    <span className="text-[12px] text-muted-foreground">{p.kindLabel}</span>
                    {admin && (
                      <button
                        className="ml-auto text-muted-foreground hover:text-primary disabled:opacity-50"
                        disabled={m.updatingProviderUuid === p.uuid}
                        onClick={() => {
                          setAddingAssertionFor(null);
                          setEditingAssertion(null);
                          setEditingProvider(p.uuid);
                        }}
                        title="Edit this provider"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                  <span>
                    {p.profile.declaredFields} {p.profile.declaredFields === 1 ? "fact" : "facts"}
                  </span>
                  {p.profile.weakestEvidence && (
                    <span className="flex items-center gap-1.5">
                      <span>weakest:</span>
                      <EvidenceClassChip value={p.profile.weakestEvidence} />
                    </span>
                  )}
                </div>

                {p.assertions.length === 0 ? (
                  <p className="mt-2 text-[12px] text-muted-foreground">No profile facts recorded.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {p.assertions.map((a) =>
                      admin && editingAssertion === a.uuid ? (
                        <li key={a.uuid} className="border-t border-border/30 pt-1.5">
                          <span className="text-[11px] text-muted-foreground">{a.fieldLabel}</span>
                          <AssertionForm
                            initial={{ value: a.value, evidenceClass: a.evidenceClass, source: a.source }}
                            submitLabel="Save"
                            pending={m.updatingAssertionUuid === a.uuid}
                            onSubmit={async (v) => {
                              try {
                                await m.updateAssertion(a.uuid, {
                                  value: v.value,
                                  evidenceClass: v.evidenceClass,
                                  source: v.source,
                                });
                                setEditingAssertion(null);
                              } catch {
                                /* keep the form open; the reason is toasted */
                              }
                            }}
                            onCancel={() => setEditingAssertion(null)}
                          />
                        </li>
                      ) : (
                        <li
                          key={a.uuid}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/30 pt-1.5"
                        >
                          <span className="min-w-[9rem] text-[12px] text-muted-foreground">
                            {a.fieldLabel}
                          </span>
                          <span className="flex-1 text-[12px] text-foreground">{a.value}</span>
                          <EvidenceClassChip value={a.evidenceClass} />
                          {admin && (
                            <span className="flex items-center gap-2">
                              <button
                                className="text-muted-foreground hover:text-primary disabled:opacity-50"
                                disabled={m.deletingAssertionUuid === a.uuid}
                                onClick={() => {
                                  setAddingAssertionFor(null);
                                  setEditingAssertion(a.uuid);
                                }}
                                title="Edit this fact"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                className="text-muted-foreground hover:text-sev-high disabled:opacity-50"
                                disabled={m.deletingAssertionUuid === a.uuid}
                                onClick={() => void m.deleteAssertion(a.uuid).catch(() => {})}
                                title="Delete this fact"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </span>
                          )}
                        </li>
                      ),
                    )}
                  </ul>
                )}

                {admin &&
                  (addingAssertionFor === p.uuid ? (
                    <AssertionForm
                      fieldChoices={availableFields}
                      submitLabel="Record fact"
                      pending={m.creatingAssertion}
                      onSubmit={async (v) => {
                        try {
                          await m.createAssertion({
                            provider: p.uuid,
                            field: v.field ?? "",
                            value: v.value,
                            evidenceClass: v.evidenceClass,
                            source: v.source,
                          });
                          setAddingAssertionFor(null);
                        } catch {
                          /* keep the form open; the reason is toasted */
                        }
                      }}
                      onCancel={() => setAddingAssertionFor(null)}
                    />
                  ) : availableFields.length > 0 ? (
                    <button
                      className="mt-2 inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
                      onClick={() => {
                        setEditingAssertion(null);
                        setAddingAssertionFor(p.uuid);
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add fact
                    </button>
                  ) : (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Every profile field is declared. Edit a fact to change it.
                    </p>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </GlassCard>
  );
}

function asSeverity(s: string): Severity {
  // Lowercased first: a backend "Critical"/"HIGH" must not collapse to the Info
  // pill because the case did not match.
  const lower = (s ?? "").toLowerCase();
  return (["critical", "high", "medium", "low", "info"].includes(lower) ? lower : "info") as Severity;
}

/**
 * The banner headline, accurate to why the console is not reading. Configured
 * but unreachable, reachable but the credential was rejected, and reachable but
 * the backend errored are three different facts, and saying "not answering" for
 * all of them is a lie about a backend that answered.
 */
function bannerHeadline(status: AssuranceStatus): string {
  if (!status.configured) return "No control plane is configured.";
  if (status.reachable === false) return "The control plane is not answering.";
  if (status.authorized === false) return "The control plane rejected this console's credential.";
  return "The control plane returned an error.";
}

/* --- shared presentational parts (used by both views) ------------------- */

// Change intelligence tones. "cleared" (no longer reported) reads reassuring but
// is not proof of a fix, so it takes a calm tone, not a triumphant one; a
// recurring finding is the one that has survived a scan and wants attention.
const CHANGE_TONE: Record<string, string> = {
  new: "text-sky-400 border-sky-500/30 bg-sky-500/10",
  recurring: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  cleared: "text-emerald-400/90 border-emerald-500/25 bg-emerald-500/[0.08]",
};
function ChangeBadge({ status, label }: { status: string; label: string }) {
  if (!status) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium",
        CHANGE_TONE[status] ?? "text-muted-foreground border-border/60 bg-surface-1/50",
      )}
      title="Since the deployment's latest scan"
    >
      {label || status}
    </span>
  );
}

/**
 * Tone for a security disposition. Presentation only -- the WORDS come from the
 * backend's `statusLabel`, never from a table here, because two of these states
 * (contained, invalidated) exist precisely because the others were being stretched
 * to cover them, and a console that spelled them itself could drift from the
 * caveat the API serves. An unrecognised disposition takes the muted tone: a state
 * this console has not been taught must never arrive wearing a reassuring colour.
 *
 * `contained` and `invalidated` are deliberately NOT the amber that `remediating`
 * wears. Contained says a path is blocked and the defect is still there with no
 * fix implied; remediating says a fix is under way. Rendering them alike is the
 * exact failure P2.8 names.
 */
const DISPOSITION_TONE: Record<string, string> = {
  open: "text-rose-400 border-rose-500/30 bg-rose-500/10",
  triaged: "text-sky-300/90 border-sky-500/25 bg-sky-500/[0.08]",
  remediating: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  retesting: "text-amber-300/90 border-amber-500/25 bg-amber-500/[0.08]",
  // A limited path, not a lessened defect: a hard, cool outline rather than the
  // in-progress amber, so it does not read as work under way.
  contained: "text-indigo-300 border-indigo-400/40 bg-indigo-500/[0.10]",
  // The ground moved: nothing is asserted about exploitation or a fix, so it
  // reads as a question, not as a clean or a confirmed case.
  invalidated: "text-fuchsia-300 border-fuchsia-400/40 border-dashed bg-fuchsia-500/[0.08]",
  closed: "text-emerald-400/90 border-emerald-500/25 bg-emerald-500/[0.08]",
  accepted: "text-muted-foreground border-dashed border-border/70 bg-surface-1/40",
  false_positive: "text-muted-foreground border-border/60 bg-surface-1/50",
};

/** The finding's security disposition, worn in the backend's own words. */
function DispositionChip({
  status,
  label,
  mustNotImply,
}: {
  status: string;
  label?: string;
  mustNotImply?: string | null;
}) {
  if (!status) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium",
        DISPOSITION_TONE[status] ?? "text-muted-foreground border-border/60 bg-surface-1/50",
      )}
      title={
        mustNotImply
          ? `Security disposition. ${mustNotImply}`
          : "The finding's security disposition — not the remediation workflow state"
      }
    >
      {label || status}
    </span>
  );
}

/**
 * The caveat the backend attaches to a disposition with a wrong reading worth
 * naming. Rendered as its own line, not only as a tooltip: a caveat that needs a
 * hover to find is a caveat a report screenshot does not carry.
 */
function DispositionCaveat({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="mt-1.5 text-[10px] leading-snug text-amber-300/80">
      <span className="font-semibold">Must not be read as:</span> {text}
    </p>
  );
}

// The remediation workflow vocabulary (Phase 2.3), kept in lockstep with
// assurance/models.py and the BFF's transition schema. This is the *human
// process* of getting a finding fixed, distinct from the security disposition:
// `resolved` here means the workflow ticket was closed, never that the finding
// is fixed in the security sense — so it takes a calm tone, not the emerald a
// verified-clean security state would. An unrecognised state degrades to muted.
const REMEDIATION_LABEL: Record<string, string> = {
  new: "New",
  triaged: "Triaged",
  in_progress: "In progress",
  in_review: "In review",
  resolved: "Resolved",
  wont_fix: "Won't fix",
};
const REMEDIATION_TONE: Record<string, string> = {
  new: "text-sky-400 border-sky-500/30 bg-sky-500/10",
  triaged: "text-sky-300/90 border-sky-500/25 bg-sky-500/[0.08]",
  in_progress: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  in_review: "text-amber-300/90 border-amber-500/25 bg-amber-500/[0.08]",
  resolved: "text-teal-300 border-teal-500/30 bg-teal-500/10",
  wont_fix: "text-muted-foreground border-dashed border-border/70 bg-surface-1/40",
};
// The legal next states from each state (the backend's state machine). Offering
// only these keeps the console from showing a move the backend would 400.
const REMEDIATION_TRANSITIONS: Record<string, string[]> = {
  new: ["triaged", "wont_fix"],
  triaged: ["in_progress", "wont_fix"],
  in_progress: ["in_review", "wont_fix"],
  in_review: ["resolved", "in_progress", "wont_fix"],
  resolved: ["in_progress"],
  wont_fix: ["triaged"],
};

/** The finding's remediation workflow state — a workflow chip, never a security
 *  clearance. The title spells that out so "Resolved" is not misread as fixed. */
function RemediationStateChip({ state }: { state: string }) {
  if (!state) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium",
        REMEDIATION_TONE[state] ?? "text-muted-foreground border-border/60 bg-surface-1/50",
      )}
      title="Remediation workflow status — the human process of fixing this, not the finding's security status"
    >
      <Wrench className="h-3 w-3" />
      {REMEDIATION_LABEL[state] || state}
    </span>
  );
}

/**
 * The remediation controls threaded down to a finding row. Reads (the state
 * chip, the assignee) render for everyone; the state <select> and assignee
 * picker render only for an admin, and even then the control plane is the real
 * gate. A move offers only the LEGAL next states, and a 400 from the backend
 * (illegal transition, unknown user) surfaces as a toast, never a crash.
 */
interface RemediationControls {
  admin: boolean;
  assignableUsers: { id: string; username: string }[];
  onTransition: (uuid: string, toState: string) => void;
  onAssign: (uuid: string, assignee: string | null) => void;
  transitionPending: (uuid: string) => boolean;
  assignPending: (uuid: string) => boolean;
}

const remedInput =
  "rounded-md border border-border/60 bg-surface-1/60 px-2 py-1 text-[12px] text-foreground disabled:opacity-50";

function FindingRow({
  f,
  showAsset = true,
  remediation,
}: {
  f: Finding;
  showAsset?: boolean;
  remediation?: RemediationControls;
}) {
  const nextStates = REMEDIATION_TRANSITIONS[f.remediationState] ?? [];
  const [showIncidentPack, setShowIncidentPack] = useState(false);
  const [showRemediation, setShowRemediation] = useState(false);
  return (
    <li className="rounded-lg border border-border/40 bg-surface-0/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-foreground">{f.title}</p>
        <SeverityPill severity={asSeverity(f.severity)} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ChangeBadge status={f.changeStatus} label={f.changeLabel} />
        <EvidenceClassChip value={f.evidenceClass} />
        {f.stale && (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/[0.08] px-2 py-0.5 text-[11px] font-medium text-amber-300/90"
            title="Evidence not re-observed within the retest window"
          >
            <Clock className="h-3 w-3" />
            stale{typeof f.ageDays === "number" ? ` · ${f.ageDays}d` : ""}
          </span>
        )}
        {/* The security disposition of the finding (open/contained/...). Distinct
            from the remediation workflow chip that follows it, and toned so that
            `contained` and `invalidated` cannot be mistaken for `remediating`. */}
        <DispositionChip status={f.status} label={f.statusLabel} mustNotImply={f.statusMustNotImply} />
        {showAsset && f.assetName && (
          <span className="text-[11px] text-muted-foreground">· {f.assetName}</span>
        )}
        {f.location && <span className="text-[11px] text-muted-foreground">· {f.location}</span>}
        {f.receipt?.digest && <FindingReceiptMark receipt={f.receipt} />}
      </div>
      <DispositionCaveat text={f.statusMustNotImply} />
      {/* Remediation workflow (Phase 2.3): the state chip and assignee for
          everyone; the move/assign controls for an admin. Kept on its own row,
          and labelled as workflow, so it never reads as the security verdict. */}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/30 pt-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/80">Remediation</span>
        <RemediationStateChip state={f.remediationState} />
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <User className="h-3 w-3" />
          {f.assignee ? f.assignee : "unassigned"}
        </span>
        <button
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
          onClick={() => setShowRemediation((v) => !v)}
          aria-expanded={showRemediation}
        >
          <History className="h-3 w-3" />
          {showRemediation ? "Hide history" : "History"}
        </button>
        {remediation?.admin && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {nextStates.length > 0 && (
              <select
                className={remedInput}
                value=""
                disabled={remediation.transitionPending(f.uuid)}
                aria-label="Move remediation to"
                onChange={(e) => {
                  if (e.target.value) remediation.onTransition(f.uuid, e.target.value);
                }}
              >
                <option value="" disabled>
                  Move to…
                </option>
                {nextStates.map((s) => (
                  <option key={s} value={s}>
                    {REMEDIATION_LABEL[s] || s}
                  </option>
                ))}
              </select>
            )}
            <select
              className={remedInput}
              value={f.assignee ?? ""}
              disabled={remediation.assignPending(f.uuid)}
              aria-label="Assign remediation to"
              onChange={(e) => remediation.onAssign(f.uuid, e.target.value || null)}
            >
              <option value="">Unassigned</option>
              {remediation.assignableUsers.map((u) => (
                <option key={u.id} value={u.username}>
                  {u.username}
                </option>
              ))}
              {/* A current assignee no longer in the assignable list still shows,
                  so the picker never silently misrepresents who owns it. */}
              {f.assignee && !remediation.assignableUsers.some((u) => u.username === f.assignee) && (
                <option value={f.assignee}>{f.assignee}</option>
              )}
            </select>
          </div>
        )}
      </div>
      {/* The remediation audit trail (Phase 2.3), read from the dedicated
          endpoint on demand: the attributed history of every workflow move. */}
      {showRemediation && <RemediationDetailView findingUuid={f.uuid} />}
      {/* Incident evidence pack (Phase 3.7): a finding IS the incident. A reader
          opens the pack on demand. Its digests identify a recorded state, and
          show a change only against an independent or signature-covered copy;
          never that the incident is resolved or the system secure. */}
      <div className="mt-2 border-t border-border/30 pt-2">
        <button
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
          onClick={() => setShowIncidentPack((v) => !v)}
          aria-expanded={showIncidentPack}
        >
          <FileText className="h-3 w-3" />
          {showIncidentPack ? "Hide incident pack" : "Incident pack"}
        </button>
        {showIncidentPack && <IncidentPackView findingUuid={f.uuid} />}
      </div>
    </li>
  );
}

function UnknownCard({
  u,
  onDisposition,
  pending,
  admin = false,
}: {
  u: Unknown;
  onDisposition: (uuid: string, status: string) => void;
  pending: boolean;
  admin?: boolean;
}) {
  return (
    <li className="rounded-lg border border-border/40 bg-surface-0/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-foreground">{u.question}</p>
        <span className={cn("shrink-0 text-[11px] font-semibold", IMPACT_TONE[u.deploymentImpact])}>
          {u.impactLabel}
        </span>
      </div>
      {u.whyItMatters && <p className="mt-1 text-[12px] text-muted-foreground">{u.whyItMatters}</p>}
      {u.evidenceNeeded && (
        <p className="mt-1 text-[12px] text-muted-foreground">
          <span className="text-foreground/70">To close: </span>
          {u.evidenceNeeded}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <label className="text-[11px] text-muted-foreground" htmlFor={`u-${u.uuid}`}>
          Disposition
        </label>
        {/* Changing a disposition mutates the record → admin-only (the control
            plane enforces it too). A non-admin sees the current status, read-only. */}
        {admin ? (
          <select
            id={`u-${u.uuid}`}
            className="rounded-md border border-border/60 bg-surface-1/60 px-2 py-1 text-[12px] text-foreground"
            value={u.status}
            disabled={pending}
            onChange={(e) => onDisposition(u.uuid, e.target.value)}
          >
            {UNKNOWN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : (
          <span className="rounded-md border border-border/60 bg-surface-1/40 px-2 py-1 text-[12px] text-foreground">
            {u.statusLabel || u.status}
          </span>
        )}
        <span className="text-[11px] text-muted-foreground">{u.source}</span>
      </div>
    </li>
  );
}

/** A compact reference to a provider a deployment depends on, with the weakest
 *  evidence in its declared profile surfaced so a soft claim is visible at a
 *  glance. When the profile could not be resolved (no join key yet), the name
 *  stands alone rather than implying a strength it cannot show. */
function ProviderRef({ name, provider }: { name: string; provider?: Provider }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-surface-1/50 px-2 py-1 text-[11px] text-foreground">
      <Building2 className="h-3 w-3 text-muted-foreground" />
      {name}
      {provider?.profile.weakestEvidence && (
        <EvidenceClassChip value={provider.profile.weakestEvidence} />
      )}
    </span>
  );
}

function AssetNode({
  asset,
  findings,
  remediation,
}: {
  asset: Asset;
  findings: Finding[];
  remediation?: RemediationControls;
}) {
  return (
    <li className="rounded-lg border border-border/40 bg-surface-0/40 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[13px] font-semibold text-foreground">{asset.name}</span>
        <span className="text-[12px] text-muted-foreground">{asset.kindLabel}</span>
        <AssetClassChip value={asset.classification} label={asset.classificationLabel || undefined} />
        {asset.providerName && (
          <span className="text-[11px] text-muted-foreground">· {asset.providerName}</span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {findings.length} {findings.length === 1 ? "finding" : "findings"}
        </span>
      </div>
      {findings.length > 0 && (
        <ul className="mt-2 space-y-2 border-l border-border/40 pl-3">
          {findings.map((f) => (
            <FindingRow key={f.uuid} f={f} showAsset={false} remediation={remediation} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The AI-BOM (Phase 1.7) for one deployment: the AI supply-chain bill of
 * materials — every component and the providers behind it, each provider fact
 * evidence-graded, with the backend's digest over it. Self-fetching (mounted
 * only inside an expanded deployment). It is an exportable artifact
 * (procurement, audit, M&A, security questionnaires). No signature comes with
 * the digest, so it shows a change only against a copy obtained independently;
 * the JSON downloaded here is this page's rendering, not the bytes the backend
 * hashed, so the digest cannot be recomputed from it. Honest by
 * construction — every fact shows how strongly it is known, and shadow supply
 * chain is flagged, never smoothed over.
 */
function AiBomPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useQuery<AiBom>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/ai-bom`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <FileText className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">AI-BOM</h3>
      <span className="text-[11px] text-muted-foreground">supply-chain bill of materials</span>
      {data && data.summary.componentCount > 0 && (
        <button
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
          onClick={() => {
            try {
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `ai-bom-${data.deployment.name || data.deployment.uuid}.json`;
              a.click();
              URL.revokeObjectURL(url);
            } catch {
              toast({ title: "Could not export the AI-BOM", variant: "destructive" });
            }
          }}
        >
          <Download className="h-3 w-3" />
          Export JSON
        </button>
      )}
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the bill of materials…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the AI-BOM{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const { summary } = data;

  return (
    <section>
      {heading}

      {summary.componentCount === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No components discovered for this deployment yet — nothing to inventory.
        </p>
      ) : (
        <>
          {/* The scoreboard, including the honest headline: the softest evidence
              among all the vendor facts in this BOM. */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.componentCount} {summary.componentCount === 1 ? "component" : "components"}
            </span>
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.providerCount} {summary.providerCount === 1 ? "provider" : "providers"}
            </span>
            {summary.shadowComponents > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-sev-high">
                <ShieldAlert className="h-3.5 w-3.5" /> {summary.shadowComponents} shadow
              </span>
            )}
            {summary.weakestEvidence && (
              <span className="inline-flex items-center gap-1">
                <span className="text-muted-foreground">weakest evidence:</span>
                <EvidenceClassChip value={summary.weakestEvidence} />
              </span>
            )}
          </div>

          {/* Components. */}
          <ul className="space-y-1.5">
            {data.components.map((c) => (
              <li
                key={c.uuid}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/40 bg-surface-0/40 p-2"
              >
                <span className="text-[12px] font-semibold text-foreground">{c.name}</span>
                <span className="text-[11px] text-muted-foreground">{c.kindLabel}</span>
                <AssetClassChip value={c.classification} label={c.classificationLabel || undefined} />
                {c.shadow && (
                  <span className="inline-flex items-center rounded-full border border-sev-high/40 bg-sev-high/10 px-2 py-0.5 text-[10px] font-medium text-sev-high">
                    Shadow
                  </span>
                )}
                {c.providerName && (
                  <span className="text-[10px] text-muted-foreground">· {c.providerName}</span>
                )}
                {typeof c.facts.version === "string" && (
                  <span className="text-[10px] text-muted-foreground/80">v{c.facts.version}</span>
                )}
              </li>
            ))}
          </ul>

          {/* The supply chain: each vendor and its declared, evidence-graded facts. */}
          {data.providers.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Supply chain
              </p>
              <ul className="space-y-2">
                {data.providers.map((p) => (
                  <li key={p.uuid} className="rounded-lg border border-border/40 bg-surface-0/40 p-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-[12px] font-semibold text-foreground">{p.name}</span>
                      <span className="text-[11px] text-muted-foreground">{p.kindLabel}</span>
                      {p.region && <span className="text-[10px] text-muted-foreground">· {p.region}</span>}
                    </div>
                    {p.declaredFacts.length > 0 && (
                      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 border-l border-border/40 pl-2.5">
                        {p.declaredFacts.map((f) => (
                          <li key={f.field} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <span className="text-foreground">{f.fieldLabel}:</span>
                            <span>{f.value}</span>
                            <EvidenceClassChip value={f.evidenceClass} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* The backend's digest over the BOM. Unsigned, so it identifies a
              recorded state rather than vouching for one. */}
          <div
            className="mt-3 flex items-center gap-1.5 text-[10px] text-muted-foreground"
            title={`Digest over this AI-BOM as the backend recorded it (${data.receipt.algorithm}). No signature came with it: it shows a change only when compared with a copy obtained independently, and on its own attests nothing.\n${data.receipt.digest}`}
          >
            <Fingerprint className="h-3 w-3" />
            <span className="uppercase tracking-wide">{data.receipt.algorithm}</span>
            <code className="font-mono">{data.receipt.digest.slice(0, 16)}…</code>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The System / Route Map (Phase 1.6) for one deployment: the layered data-flow
 * graph — app → gateway → model → data → tools → logs — reconstructed from the
 * asset graph and its declared edges. Self-fetching (mounted only inside an
 * expanded deployment). It lays components out by pipeline layer, draws each
 * edge honestly (a declared edge the inventory attests vs the inferred reference
 * spine), and surfaces the gaps: a dangling tool reference, a shadow node, and
 * whether anyone can even say where the logs go.
 */
function RouteMapPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<RouteMap>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/route-map`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Waypoints className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Route map</h3>
      <span className="text-[11px] text-muted-foreground">how data flows through the system</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the route map…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the route map{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const nameOf = new Map(data.nodes.map((n) => [n.uuid, n.name]));
  const { summary } = data;
  // Only the layers that actually have nodes, in the pipeline order the backend
  // already sorted them into.
  const populated = data.layers.filter((l) => l.nodes.length > 0);

  return (
    <section>
      {heading}

      {summary.nodeCount === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No components discovered for this deployment yet — nothing to map.
        </p>
      ) : (
        <>
          {/* The scoreboard: how big the map is, how much of it is attested vs
              inferred, and the honest gaps. */}
          <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.nodeCount} {summary.nodeCount === 1 ? "node" : "nodes"}
            </span>
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.declaredEdges} declared · {summary.inferredEdges} inferred{" "}
              {summary.edgeCount === 1 ? "edge" : "edges"}
            </span>
            {summary.shadowNodes > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-sev-high">
                <ShieldAlert className="h-3.5 w-3.5" /> {summary.shadowNodes} shadow
              </span>
            )}
            {summary.unresolvedEdges !== null && summary.unresolvedEdges > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
                <HelpCircle className="h-3.5 w-3.5" /> {summary.unresolvedEdges} unresolved
              </span>
            )}
            <span
              className={cn(
                "rounded-md border px-2 py-1",
                summary.logsObserved
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400"
                  : "border-amber-500/30 bg-amber-500/5 text-amber-400",
              )}
            >
              {summary.logsObserved ? "logs observed" : "no logging discovered"}
            </span>
          </div>

          {/* The pipeline, layer by layer. Only populated layers render; each is
              a band of its component nodes. */}
          <div className="space-y-2">
            {populated.map((layer, i) => (
              <div key={layer.key} className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {i > 0 && <span className="mr-1 text-primary/60">→</span>}
                  {layer.label}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {layer.nodes.map((n) => (
                    <span
                      key={n.uuid}
                      title={n.providerName ? `${n.kindLabel} · ${n.providerName}` : n.kindLabel}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]",
                        n.shadow
                          ? "border-sev-high/40 bg-sev-high/10 text-sev-high"
                          : "border-border/50 bg-surface-0/50 text-foreground",
                      )}
                    >
                      {n.name}
                      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                        {n.kindLabel}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* The edges, each labelled and marked declared (attested) or inferred
              (the reference spine). */}
          {data.edges.length > 0 && (
            <ul className="mt-3 space-y-1">
              {data.edges.map((e, i) => (
                <li key={`${e.source}-${e.target}-${e.kind}-${i}`} className="text-[11px] text-muted-foreground">
                  <span className="text-foreground">{nameOf.get(e.source) ?? "?"}</span>
                  <span className="mx-1 text-primary/60">→</span>
                  <span className="text-foreground">{nameOf.get(e.target) ?? "?"}</span>
                  <span className="ml-1">{e.label}</span>
                  <span
                    className={cn(
                      "ml-1.5 rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wide",
                      e.declared
                        ? "border-emerald-500/30 text-emerald-400"
                        : "border-border/50 text-muted-foreground",
                    )}
                  >
                    {e.declared ? "declared" : "inferred"}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <UnresolvedReferences
            rows={data.unresolved}
            reported={summary.unresolvedEdges}
            what="this map"
          />
        </>
      )}
    </section>
  );
}

// A capability's risk, worn honestly: a high-risk power (code execution, money
// movement, a shadow capability nobody approved) leads in red, an elevated one
// in amber, a baseline one in muted. Anything unrecognised falls back to muted.
// The references the inventory declares and discovery could not place, said
// plainly. This is not decoration: an unresolvable reference means part of the
// graph every assessment on this page is computed over could not be placed, so a
// clean reading of that assessment is a reading of a graph we do not have.
//
// The wording follows the mechanism, because the two are different problems. An
// agent naming a tool it cannot reach is a question about the agent's declared
// toolset; a component naming a backend that is not there is a question about the
// inventory's wiring. Saying "names" for both would flatten them.
// How each declared-reference mechanism reads in a sentence. An agent naming a
// tool it cannot reach is a question about the agent's declared toolset; a
// component naming a backend that is not there is a question about the
// inventory's wiring. A mechanism this console has never been taught gets
// NEITHER phrasing: it is named as itself, because asserting it is one of the two
// we know would send an operator to audit the wrong thing.
const MECHANISM_PHRASING: Record<string, string> = {
  tools: "names",
  server: "is wired to",
  identity: "acts as",
};

// Why the reference could not be placed as one component. These are different
// findings and used to share one sentence -- "which discovery could not place" --
// which is false for two of them: an ambiguous reference WAS placed, twice, and
// the backend followed it to every candidate; a reference naming an agent where
// a tool belongs names something that exists. Each says what to go and fix. A
// reason this console has not been taught is named as itself, and a control
// plane that sent none is not credited with any of the three.
const REASON_PHRASING: Record<string, string> = {
  not_found: "which discovery could not place",
  ambiguous:
    "which more than one component answers to — the inventory does not say which, so every one of them was followed",
  names_a_principal: "which is an agent or a service account, not something this declaration can point at",
  // Placed and followed -- its powers are counted -- but recorded under identity
  // rules the control plane no longer writes, and no scan has recorded it since.
  // "Could not be placed" would send the operator looking for a component that
  // exists; what it needs is a rescan.
  superseded_identity:
    "which was followed, but is recorded under identity rules no scan has re-recorded since — rescan to confirm it",
  // Declared by the one row the old identity rules wrote for every unnamed agent
  // at once. Whether it was followed is the other reasons' to say -- a reference
  // from that row can still name nothing -- so this does not claim it. What it
  // does say is that a rescan does not re-record that row: the current rules
  // record each unnamed agent under a row of its own, keyed by where it is, so
  // "rescan" would send the operator to a scan that never clears it.
  legacy_unnamed_agent:
    "which comes from the row the old identity rules wrote for every unnamed agent at once — a rescan records each unnamed agent under a row of its own, not this one",
};

// From the old unnamed-agent row, an old row at the other end is said as what it
// is and no more: that row's reference is never re-recorded, so "rescan to
// confirm it" -- the superseded phrasing -- would promise the reference a rescan
// that does not touch it.
const SUPERSEDED_FROM_LEGACY_ROW = "which reaches a component also recorded under the old identity rules";

export function unresolvedReason(reason: string | null): string {
  if (reason === null) return "which could not be placed as exactly one component";
  return REASON_PHRASING[reason] ?? `which could not be placed (the control plane says: ${reason})`;
}

// Every reason one reference is reported for, each said. An ambiguous reference
// with a superseded candidate is both, and saying only the first would hide the
// rescan the second asks for. From the old unnamed-agent row, a superseded
// candidate is said without the rescan: none clears it.
export function unresolvedReasons(row: Pick<UnresolvedReference, "reason" | "reasons">): string {
  const reasons = row.reasons.length > 0 ? row.reasons : [row.reason];
  const fromLegacyRow = reasons.includes("legacy_unnamed_agent");
  return reasons
    .map((r) => (fromLegacyRow && r === "superseded_identity" ? SUPERSEDED_FROM_LEGACY_ROW : unresolvedReason(r)))
    .join("; and ");
}

// Followed and counted, and waiting only on a rescan: every reason it is
// reported for is the superseded one. Not a reference that could not be placed.
function awaitsRescanOnly(row: UnresolvedReference): boolean {
  return row.reasons.length > 0 && row.reasons.every((r) => r === "superseded_identity");
}

// Followed and counted, from the old unnamed-agent row: that is the reason, and
// the only other one is an old row at the other end. Neither a reference that
// could not be placed nor one a rescan confirms -- no rescan re-records that row.
function fromLegacyRowOnly(row: UnresolvedReference): boolean {
  return (
    row.reasons.includes("legacy_unnamed_agent") &&
    row.reasons.every((r) => r === "legacy_unnamed_agent" || r === "superseded_identity")
  );
}

// The references the inventory declares and discovery could not place, said
// plainly. This is not decoration: an unresolvable reference means part of the
// graph every assessment on this page is computed over could not be placed, so a
// clean reading of that assessment is a reading of a graph we do not have.
//
// `rows` is null when the control plane has no channel for this question at all
// (it predates the field), and that is said out loud rather than rendered as
// nothing — a console that stays silent about a control plane that cannot answer
// is indistinguishable from one reporting a graph that resolved cleanly.
//
// `reported` is the control plane's own total. When it disagrees with the rows
// this console can name, BOTH numbers are shown. Deriving the sentence from the
// list alone would hide a row the backend counted and did not send; printing the
// backend's total alone would claim to have named rows that are not on screen.
export function UnresolvedReferences({
  rows,
  reported,
  what,
}: {
  rows: UnresolvedReference[] | null;
  reported: number | null;
  what: string;
}) {
  if (rows === null) {
    return (
      <div className="mt-3 rounded-lg border border-border/40 bg-surface-1/30 p-2.5">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          This control plane does not report whether every declared reference could be placed, so
          whether {what} was built over a complete graph is <span className="text-foreground">not
          known from here</span> — it is not a statement that nothing was missing.
        </p>
      </div>
    );
  }
  if (rows.length === 0 && (reported === null || reported === 0)) return null;
  const undercount = reported !== null && reported > rows.length;
  // A reference reported only as superseded was followed and its powers
  // counted; "could not be placed" would send the operator looking for a
  // component that exists, when what it needs is a rescan.
  const rescan = rows.filter(awaitsRescanOnly).length;
  // From the old unnamed-agent row, followed and counted, and not something a
  // rescan confirms: counted apart from both.
  const legacy = rows.filter(fromLegacyRowOnly).length;
  const unplaced = rows.length - rescan - legacy;
  return (
    <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.04] p-2.5">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-400">
        Unresolved references
      </p>
      <p className="mb-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {undercount ? (
          <>
            {reported} declared reference{reported === 1 ? " was" : "s were"} reported unresolved against
            this deployment&apos;s inventory, and{" "}
            <span className="text-foreground">
              {rows.length === 0 ? "none of them" : `only ${rows.length} of them`}
            </span>{" "}
            arrived with a reference this console can name. So {what} was built over an incomplete
            graph.
          </>
        ) : (
          <>
            {unplaced > 0 && (
              <>
                {unplaced} declared reference{unplaced === 1 ? "" : "s"} could not be placed as exactly
                one component against this deployment&apos;s inventory.{" "}
              </>
            )}
            {rescan > 0 && (
              <>
                {rescan} {unplaced > 0 ? "more" : `declared reference${rescan === 1 ? "" : "s"}`}{" "}
                {rescan === 1 ? "was" : "were"} followed to or from a component recorded under identity
                rules no scan has re-recorded since; a rescan is what confirms{" "}
                {rescan === 1 ? "it" : "them"}.{" "}
              </>
            )}
            {legacy > 0 && (
              <>
                {legacy}{" "}
                {unplaced + rescan > 0 ? "more" : `declared reference${legacy === 1 ? "" : "s"}`}{" "}
                {legacy === 1 ? "comes" : "come"} from the row the old identity rules wrote for every
                unnamed agent at once; the reach through {legacy === 1 ? "it" : "them"} is counted as
                the rows {legacy === 1 ? "it names" : "they name"} stand now, and a rescan records
                each unnamed agent under a row of its own, keyed by where it is, not that one.{" "}
              </>
            )}
            So {what} was built over{" "}
            {unplaced > 0
              ? "an incomplete graph"
              : rescan > 0 && legacy > 0
                ? "a graph a rescan has yet to confirm, and that still counts reach through the old unnamed-agent row"
                : rescan > 0
                  ? "a graph a rescan has yet to confirm"
                  : "a graph that still counts reach through the old unnamed-agent row"}
            .
          </>
        )}{" "}
        These are gaps to chase, not components to assume away.
      </p>
      <ul className="space-y-1">
        {rows.map((u, i) => (
          <li key={`${u.source}-${u.mechanism}-${u.reference}-${i}`} className="text-[11px] text-muted-foreground">
            <span className="text-foreground">{u.source || "An unnamed component"}</span>{" "}
            {MECHANISM_PHRASING[u.mechanism] ?? (
              <>
                declares (as{" "}
                <span className="text-foreground">{u.mechanism || "an unnamed mechanism"}</span>)
              </>
            )}{" "}
            <span className="text-amber-400/90">{u.reference}</span>, {unresolvedReasons(u)}.
          </li>
        ))}
      </ul>
    </div>
  );
}

// The risk bands this console has been taught. A band it has NOT been taught is
// not "baseline": the closed three-way ternary this replaces rendered a backend
// `critical` as a muted grey "Baseline" chip, which inverts the severity rather
// than merely losing it. Same treatment as DispositionChip: the tone degrades to
// neutral, and the backend's own word is printed. `null` (the backend declined to
// say) is said as such, because the lowest measured band is a measurement.
const RISK_TONE: Record<string, { cls: string; label: string }> = {
  high: { cls: "border-sev-high/40 bg-sev-high/10 text-sev-high", label: "High risk" },
  elevated: { cls: "border-amber-500/40 bg-amber-500/10 text-amber-400", label: "Elevated" },
  baseline: { cls: "border-border/50 bg-surface-1/40 text-muted-foreground", label: "Baseline" },
};
const RISK_UNKNOWN = "border-violet-400/40 bg-violet-500/[0.08] text-violet-300";

function CapabilityRiskChip({ risk }: { risk: string | null }) {
  const look =
    risk === null || risk === ""
      ? { cls: RISK_UNKNOWN, label: "risk not stated" }
      : (RISK_TONE[risk] ?? { cls: RISK_UNKNOWN, label: risk });
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        look.cls,
      )}
    >
      {look.label}
    </span>
  );
}

/**
 * The AI System Capability Map (Phase 1.3) for one deployment: the ground-truth
 * inventory of what it can *do*, derived from its asset graph and declared tool
 * permissions. Self-fetching (mounted only inside an expanded deployment). It is
 * honest about a shadow capability — a power evidenced only by unmanaged
 * components, which nobody approved — surfacing it with its risk raised, never
 * hiding it.
 */
function CapabilityPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<CapabilityMap>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/capabilities`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Cpu className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Capabilities</h3>
      <span className="text-[11px] text-muted-foreground">what this system can do</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the capability map…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the capability map{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const { summary } = data;

  return (
    <section>
      {heading}

      {/* The scoreboard: how much power, how concerning, and how much of it is
          shadow — a power no approved component accounts for. */}
      <div className="mb-3 flex flex-wrap gap-2">
        <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-[11px] text-sev-high">
          <Zap className="h-3.5 w-3.5" /> {summary.highRisk} high-risk
        </span>
        <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-400">
          {summary.elevated} elevated
        </span>
        <span className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-[11px] text-muted-foreground">
          {summary.baseline} baseline
        </span>
        {summary.shadow > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-[11px] text-sev-high">
            <ShieldAlert className="h-3.5 w-3.5" /> {summary.shadow} shadow
          </span>
        )}
      </div>

      {data.capabilities.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No capabilities derived yet — no components discovered for this deployment.
        </p>
      ) : (
        <ul className="space-y-2">
          {data.capabilities.map((c) => (
            <li key={c.key} className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[12px] font-semibold text-foreground">{c.label}</span>
                <CapabilityRiskChip risk={c.risk} />
                {c.shadow && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-sev-high/40 bg-sev-high/10 px-2 py-0.5 text-[10px] font-medium text-sev-high">
                    Shadow
                  </span>
                )}
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {c.category}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{c.description}</p>
              {/* The components that evidence this power, and how. */}
              <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 border-l border-border/40 pl-2.5">
                {c.sources.map((s, i) => (
                  <li key={`${c.key}-${i}`} className="text-[10px] text-muted-foreground">
                    <span className={s.managed ? "text-foreground" : "text-sev-high"}>
                      {s.assetName}
                    </span>{" "}
                    <span className="text-muted-foreground/80">{s.kindLabel}</span>
                    {s.detail && <span className="text-muted-foreground/70"> · {s.detail}</span>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// A flow's reconciliation verdict, worn honestly: a violation (a declared fact
// breaks a declared rule) leads in red, an unknown (a posture nobody declared —
// a gap, never a pass) in amber, and only a genuinely within-boundary flow in
// green. Anything unrecognised falls back to the neutral unknown look.
function BoundaryStatusChip({ status }: { status: string }) {
  const look =
    status === "violation"
      ? { Icon: ShieldAlert, cls: "border-sev-high/40 bg-sev-high/10 text-sev-high", label: "Violation" }
      : status === "approved"
        ? { Icon: ShieldCheck, cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400", label: "Within boundary" }
        : { Icon: ShieldQuestion, cls: "border-amber-500/40 bg-amber-500/10 text-amber-400", label: "Unknown" };
  const { Icon, cls, label } = look;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        cls,
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

/** The approved boundary an admin declares (the PUT body, camelCase). */
interface BoundaryFormValue {
  allowedRegions: string;
  trainingAllowed: boolean;
  thirdPartySharingAllowed: boolean;
  notes: string;
}

/**
 * The admin form for declaring (or replacing) a deployment's approved data
 * boundary. Regions are entered as a comma-separated list — an empty list means
 * "no region restriction declared", which the backend is careful never to read
 * as "all regions approved". Training / third-party sharing default to forbidden,
 * the conservative posture the assessment reconciles against.
 */
function BoundaryForm({
  initial,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: BoundaryFormValue;
  pending: boolean;
  onSubmit: (v: BoundaryFormValue) => void;
  onCancel: () => void;
}) {
  const [allowedRegions, setAllowedRegions] = useState(initial.allowedRegions);
  const [trainingAllowed, setTrainingAllowed] = useState(initial.trainingAllowed);
  const [thirdPartySharingAllowed, setThirdPartySharingAllowed] = useState(
    initial.thirdPartySharingAllowed,
  );
  const [notes, setNotes] = useState(initial.notes);

  return (
    <div className="mt-3 space-y-2.5 rounded-lg border border-primary/30 bg-surface-1/40 p-3">
      <label className="block text-[11px] text-muted-foreground">
        Approved data regions{" "}
        <span className="text-muted-foreground/70">(comma-separated, e.g. eu, eu-west-1)</span>
        <input
          className={cn(fieldInput, "mt-1 block w-full")}
          value={allowedRegions}
          placeholder="Leave blank for no region restriction"
          onChange={(e) => setAllowedRegions(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-[12px] text-foreground">
        <input
          type="checkbox"
          checked={trainingAllowed}
          onChange={(e) => setTrainingAllowed(e.target.checked)}
        />
        Training on customer data is permitted
      </label>
      <label className="flex items-center gap-2 text-[12px] text-foreground">
        <input
          type="checkbox"
          checked={thirdPartySharingAllowed}
          onChange={(e) => setThirdPartySharingAllowed(e.target.checked)}
        />
        Third-party data sharing is permitted
      </label>
      <label className="block text-[11px] text-muted-foreground">
        Notes
        <textarea
          className={cn(fieldInput, "mt-1 block w-full")}
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          className="rounded-md bg-primary/20 px-3 py-1 text-[12px] font-medium text-primary hover:bg-primary/30 disabled:opacity-50"
          disabled={pending}
          onClick={() =>
            onSubmit({ allowedRegions, trainingAllowed, thirdPartySharingAllowed, notes })
          }
        >
          {pending ? "Saving…" : "Save boundary"}
        </button>
        <button
          className="text-[12px] text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Every per-deployment assurance panel is a read-only view derived from the same
 * assurance graph, keyed by a single-string query key of the shape
 * `/api/assurance/deployments/<uuid>/<panel>`. With staleTime in force a mounted
 * panel only refreshes on explicit invalidation, and one write feeds several
 * panels at once — so an under-scoped invalidation leaves a sibling panel
 * rendering a value that contradicts the one just saved. This refreshes ALL of a
 * deployment's computed panels (and the deployments list, whose decision may
 * have moved), by predicate on the key prefix, so no panel can be missed as new
 * ones are added. Omit `uuid` for a write whose blast radius is not a single
 * deployment — a provider fact feeds every deployment that uses it, a
 * remediation move feeds cross-deployment roll-ups — to refresh every
 * deployment's computed panels.
 *
 * A read of these panels in flight was asked before the change, so it is
 * cancelled first and asked again. Invalidating alone restarts only a read that
 * already has data: React Query keeps a first read in flight, and it could land
 * after the change's reads with the state from before it.
 */
function invalidateAssuranceComputed(uuid?: string): void {
  const prefix = `/api/assurance/deployments/${uuid ? `${uuid}/` : ""}`;
  const computed = (query: Query) => {
    const key = query.queryKey[0];
    return typeof key === "string" && key.startsWith(prefix) && key.length > prefix.length;
  };
  void queryClient.cancelQueries({ predicate: computed });
  queryClient.invalidateQueries({ predicate: computed });
  queryClient.invalidateQueries({ queryKey: ["/api/assurance/deployments"] });
}

/**
 * The AI Data Boundary Assessment (Phase 1.4) for one deployment: the flagship
 * reconciliation of the *approved* boundary a human declared against the
 * deployment's *actual* data destinations. Self-fetching (mounted only inside an
 * expanded deployment), so the assessment loads on demand. It is scrupulous
 * about the difference between a violation (a declared fact breaks a declared
 * rule) and an unknown (a posture nobody declared — a gap, never a pass), and it
 * never lets an undeclared boundary read as permission.
 */
function DataBoundaryPanel({ deploymentUuid, admin }: { deploymentUuid: string; admin: boolean }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);

  const { data, isLoading, isError, error } = useQuery<DataBoundary>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/data-boundary`],
  });

  const declare = useMutation({
    mutationFn: async (v: BoundaryFormValue) =>
      (
        await apiRequest("PUT", `/api/assurance/deployments/${deploymentUuid}/data-boundary`, {
          allowedRegions: v.allowedRegions
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean),
          trainingAllowed: v.trainingAllowed,
          thirdPartySharingAllowed: v.thirdPartySharingAllowed,
          notes: v.notes,
        })
      ).json(),
    onSuccess: () => {
      // The declared boundary feeds this panel and several read-only siblings —
      // assurance-receipt (policy + digest), executive-summary, training-reuse,
      // personal-context — so refresh every computed panel for this deployment,
      // not only this one, or a sibling contradicts the boundary just saved.
      invalidateAssuranceComputed(deploymentUuid);
      setEditing(false);
      toast({ title: "Data boundary saved" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not save boundary", description: e.message, variant: "destructive" }),
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Route className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Data boundary</h3>
      {admin && !editing && (
        <button
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
          onClick={() => setEditing(true)}
        >
          <Pencil className="h-3 w-3" />
          {data?.declared ? "Edit boundary" : "Declare boundary"}
        </button>
      )}
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the data-boundary assessment…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the data-boundary assessment
          {error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const formInitial: BoundaryFormValue = {
    allowedRegions: (data.policy?.allowedRegions ?? []).join(", "),
    trainingAllowed: data.policy?.trainingAllowed ?? false,
    thirdPartySharingAllowed: data.policy?.thirdPartySharingAllowed ?? false,
    notes: data.policy?.notes ?? "",
  };

  const { summary } = data;

  return (
    <section>
      {heading}

      {!data.declared && (
        <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
          No approved data boundary has been declared for this deployment. Until one is, every data
          flow below reads as an <span className="text-amber-400">unknown</span> — a gap to close,
          never a pass.
        </p>
      )}

      {/* The honest scoreboard: what breaks a rule, what nobody has declared, and
          the unmanaged sinks that escape the boundary entirely. */}
      <div className="mb-3 flex flex-wrap gap-2">
        <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-[11px] text-sev-high">
          <ShieldAlert className="h-3.5 w-3.5" /> {summary.violations} violation
          {summary.violations === 1 ? "" : "s"}
        </span>
        <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-400">
          <ShieldQuestion className="h-3.5 w-3.5" /> {summary.unknowns} unknown
          {summary.unknowns === 1 ? "" : "s"}
        </span>
        <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-[11px] text-emerald-400">
          <ShieldCheck className="h-3.5 w-3.5" /> {summary.approved} within boundary
        </span>
        {summary.shadowDestinations > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-[11px] text-sev-high">
            <Network className="h-3.5 w-3.5" /> {summary.shadowDestinations} shadow destination
            {summary.shadowDestinations === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {/* The declared boundary itself, once a human has set one. */}
      {data.declared && data.policy && (
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>
            Approved regions:{" "}
            <span className="text-foreground">
              {data.policy.allowedRegions.length > 0
                ? data.policy.allowedRegions.join(", ")
                : "none declared"}
            </span>
          </span>
          <span>
            Training:{" "}
            <span className={data.policy.trainingAllowed ? "text-foreground" : "text-emerald-400"}>
              {data.policy.trainingAllowed ? "permitted" : "forbidden"}
            </span>
          </span>
          <span>
            Third-party sharing:{" "}
            <span
              className={data.policy.thirdPartySharingAllowed ? "text-foreground" : "text-emerald-400"}
            >
              {data.policy.thirdPartySharingAllowed ? "permitted" : "forbidden"}
            </span>
          </span>
        </div>
      )}

      {admin && editing && (
        <BoundaryForm
          initial={formInitial}
          pending={declare.isPending}
          onSubmit={(v) => declare.mutate(v)}
          onCancel={() => setEditing(false)}
        />
      )}

      {/* Each actual data flow, reconciled against the boundary. */}
      {data.flows.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No third-party data destinations resolved for this deployment yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {data.flows.map((f) => (
            <li
              key={f.providerUuid}
              className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[12px] font-semibold text-foreground">{f.providerName}</span>
                <span className="text-[11px] text-muted-foreground">{f.kindLabel}</span>
                <BoundaryStatusChip status={f.status} />
                {f.assets.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    via {f.assets.join(", ")}
                  </span>
                )}
              </div>
              {(f.violations.length > 0 || f.unknowns.length > 0) && (
                <ul className="mt-1.5 space-y-1 border-l border-border/40 pl-2.5">
                  {f.violations.map((v, i) => (
                    <li key={`v${i}`} className="text-[11px] text-sev-high">
                      {v}
                    </li>
                  ))}
                  {f.unknowns.map((u, i) => (
                    <li key={`u${i}`} className="text-[11px] text-amber-400/90">
                      {u}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Shadow destinations: unmanaged sinks nobody approved — outside the
          boundary by definition. */}
      {data.shadowDestinations.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sev-high">
            Shadow destinations
          </p>
          <ul className="space-y-1.5">
            {data.shadowDestinations.map((s) => (
              <li
                key={s.identifier || s.assetName}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-sev-high/30 bg-sev-high/5 p-2 text-[11px]"
              >
                <span className="font-semibold text-foreground">{s.assetName}</span>
                <span className="text-muted-foreground">{s.kindLabel}</span>
                {s.identifier && (
                  <span className="text-muted-foreground/80">{s.identifier}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * The Compliance Map (Phase 2.1) for one deployment: an HONEST gap map of its
 * findings against the compliance frameworks (NIST 800-53, OWASP 2021, OWASP LLM
 * 2025, DoD Zero Trust, in the backend's fixed order). Self-fetching (mounted
 * only inside an expanded deployment). A "touched" control is a control with an
 * open finding against it — its active-finding count and worst severity are the
 * gap signal, never a claim the control is met or passed. A framework with
 * nothing mapped reads as untouched, never as passing; the finding types no
 * framework claims (unmapped) and the raw engine taxonomy references
 * (CWE/OWASP-by-id) are surfaced, never smoothed over.
 */
function CompliancePanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<Compliance>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/compliance`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Scale className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Compliance map</h3>
      <span className="text-[11px] text-muted-foreground">framework controls with open findings</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the compliance map…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the compliance map{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const { summary } = data;

  return (
    <section>
      {heading}

      {summary.totalFindings === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No findings recorded for this deployment yet — nothing to map to a framework.
        </p>
      ) : (
        <>
          {/* This is a gap map, not a certificate: a touched control is one with
              an open finding, never a control met. */}
          <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
            A touched control is a control with an <span className="text-sev-high">open finding</span>{" "}
            against it — a gap to close, never a control met.
          </p>

          {/* The scoreboard: active vs resolved, the controls carrying open
              findings, and the honest worst severity across the map. */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.activeFindings} active · {summary.resolvedFindings} resolved
            </span>
            {summary.controlsWithActiveFindings > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-sev-high">
                <ShieldAlert className="h-3.5 w-3.5" /> {summary.controlsWithActiveFindings} control
                {summary.controlsWithActiveFindings === 1 ? "" : "s"} with active findings
              </span>
            )}
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.controlsTouched} touched · {summary.mappedFindingTypes} type
              {summary.mappedFindingTypes === 1 ? "" : "s"} mapped
            </span>
            {summary.unmappedFindingTypes > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
                <HelpCircle className="h-3.5 w-3.5" /> {summary.unmappedFindingTypes} unmapped type
                {summary.unmappedFindingTypes === 1 ? "" : "s"}
              </span>
            )}
            {summary.worstSeverity && (
              <span className="inline-flex items-center gap-1">
                <span className="text-muted-foreground">worst:</span>
                <SeverityPill severity={asSeverity(summary.worstSeverity)} />
              </span>
            )}
          </div>

          {/* Each framework, in the backend's fixed order. A framework with no
              touched controls reads as "no findings mapped here", never passing. */}
          <div className="space-y-2.5">
            {data.frameworks.map((fw) => (
              <div key={fw.key} className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[12px] font-semibold text-foreground">{fw.name}</span>
                  {fw.summary.controlsTouched > 0 ? (
                    <span className="text-[11px] text-muted-foreground">
                      {fw.summary.controlsTouched} control{fw.summary.controlsTouched === 1 ? "" : "s"} touched
                      {fw.summary.controlsWithActiveFindings > 0 &&
                        ` · ${fw.summary.controlsWithActiveFindings} with active findings`}
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground/80">no findings mapped here</span>
                  )}
                  {fw.summary.worstSeverity && (
                    <span className="ml-auto">
                      <SeverityPill severity={asSeverity(fw.summary.worstSeverity)} />
                    </span>
                  )}
                </div>
                {fw.controls.length > 0 && (
                  <ul className="mt-2 space-y-1.5 border-l border-border/40 pl-2.5">
                    {fw.controls.map((c) => (
                      <li
                        key={c.controlId}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
                      >
                        <span
                          className="font-mono text-[11px] font-semibold text-foreground"
                          title={c.familyName ? `${c.family ?? ""} · ${c.familyName}` : undefined}
                        >
                          {c.controlId}
                        </span>
                        {c.name && <span className="text-muted-foreground">{c.name}</span>}
                        {!c.catalogued && (
                          <span
                            className="rounded-full border border-border/60 bg-surface-1/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground"
                            title="Referenced by a finding but not present in the control catalogue"
                          >
                            uncatalogued
                          </span>
                        )}
                        {c.activeFindingCount > 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-1.5 py-0.5 text-sev-high">
                            <ShieldAlert className="h-3 w-3" /> {c.activeFindingCount} active
                          </span>
                        ) : (
                          <span className="text-muted-foreground/80">{c.resolvedFindingCount} resolved</span>
                        )}
                        {c.worstSeverity && <SeverityPill severity={asSeverity(c.worstSeverity)} />}
                        {c.findingTypes.length > 0 && (
                          <span className="text-[10px] text-muted-foreground/80">
                            {c.findingTypes.join(", ")}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>

          {/* Unmapped finding types: the engine found these and no framework in
              this set claims them — surfaced as a gap, never dropped. */}
          {data.unmapped.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-400">
                Unmapped finding types
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {data.unmapped.map((u) => (
                  <li
                    key={u.findingType}
                    className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-400"
                  >
                    <span className="text-foreground">{u.findingType}</span>
                    <span>{u.activeFindingCount} active</span>
                    {u.worstSeverity && <SeverityPill severity={asSeverity(u.worstSeverity)} />}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Engine taxonomy references (CWE / OWASP by id): the raw taxonomy the
              engine cited, kept visible beside the framework mapping. */}
          {data.engineReferences.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Engine references
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {data.engineReferences.map((e) => (
                  <li
                    key={`${e.taxonomy}-${e.id}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-surface-0/50 px-2 py-1 text-[11px] text-muted-foreground"
                    title={e.findingTypes.join(", ")}
                  >
                    <span className="text-[9px] uppercase tracking-wide text-muted-foreground/70">
                      {e.taxonomy}
                    </span>
                    <span className="font-mono text-foreground">{e.id}</span>
                    <span>×{e.findingCount}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// A dimension's exposure band, worn honestly as an ORDINAL signal, never a
// quantity: elevated leads in red, moderate in amber, low in muted. A dimension
// with no active findings has no band — it reads as "no active exposure", never
// "safe". Anything unrecognised falls back to muted.
function ExposureBandChip({ band }: { band: string | null }) {
  if (!band) {
    return (
      <span className="inline-flex items-center rounded-full border border-border/50 bg-surface-1/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        No active exposure
      </span>
    );
  }
  const look =
    band === "elevated"
      ? { cls: "border-sev-high/40 bg-sev-high/10 text-sev-high", label: "Elevated" }
      : band === "moderate"
        ? { cls: "border-amber-500/40 bg-amber-500/10 text-amber-400", label: "Moderate" }
        : band === "low"
          ? { cls: "border-sev-medium/40 bg-sev-medium/10 text-sev-medium", label: "Low" }
          : { cls: "border-border/50 bg-surface-1/40 text-muted-foreground", label: band };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        look.cls,
      )}
    >
      {look.label} exposure
    </span>
  );
}

/**
 * The Business-impact Map (Phase 2.4) for one deployment: the business-impact
 * dimensions its findings implicate, strongest-exposure-first. Self-fetching
 * (mounted only inside an expanded deployment). This is inferred *potential*
 * exposure, NEVER a realized loss or a dollar figure — a dimension is implicated
 * only by its ACTIVE findings, and its exposure band is an ORDINAL signal
 * (elevated/moderate/low) of how much is at stake, not a quantity. A dimension
 * with no active findings carries no band and reads as "no active exposure",
 * never "safe"; the finding types no dimension claims (unmapped) are surfaced,
 * never smoothed over.
 */
function BusinessImpactPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<BusinessImpact>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/business-impact`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Briefcase className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Business-impact map</h3>
      <span className="text-[11px] text-muted-foreground">impact dimensions with active findings</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the business-impact map…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the business-impact map{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const { summary } = data;

  return (
    <section>
      {heading}

      {summary.totalFindings === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No findings recorded for this deployment yet — nothing to map to an impact dimension.
        </p>
      ) : (
        <>
          {/* Honest framing: this is inferred potential exposure, never a
              realized loss. The band is an ordinal signal, not a quantity. */}
          <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
            An implicated dimension is one an <span className="text-sev-high">active finding</span>{" "}
            exposes — inferred <span className="text-foreground">potential</span> exposure, never a
            realized loss. The exposure band is an ordinal signal, not a quantity.
          </p>

          {/* The scoreboard: active vs resolved, the dimensions carrying active
              exposure, and the honest worst band and severity across the map. */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.activeFindings} active · {summary.resolvedFindings} resolved
            </span>
            {summary.dimensionsWithActiveExposure > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-sev-high">
                <ShieldAlert className="h-3.5 w-3.5" /> {summary.dimensionsWithActiveExposure} dimension
                {summary.dimensionsWithActiveExposure === 1 ? "" : "s"} with active exposure
              </span>
            )}
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.dimensionsTouched} touched · {summary.mappedFindingTypes} type
              {summary.mappedFindingTypes === 1 ? "" : "s"} mapped
            </span>
            {summary.unmappedFindingTypes > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
                <HelpCircle className="h-3.5 w-3.5" /> {summary.unmappedFindingTypes} unmapped type
                {summary.unmappedFindingTypes === 1 ? "" : "s"}
              </span>
            )}
            {summary.worstExposureBand && (
              <span className="inline-flex items-center gap-1">
                <span className="text-muted-foreground">worst:</span>
                <ExposureBandChip band={summary.worstExposureBand} />
              </span>
            )}
            {summary.worstSeverity && (
              <span className="inline-flex items-center gap-1">
                <SeverityPill severity={asSeverity(summary.worstSeverity)} />
              </span>
            )}
          </div>

          {/* Each implicated dimension, strongest-exposure-first (the backend's
              order). A dimension with no active findings reads as "no active
              exposure", never "safe". */}
          <div className="space-y-2.5">
            {data.dimensions.map((dim) => (
              <div key={dim.key} className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[12px] font-semibold text-foreground">{dim.label}</span>
                  <ExposureBandChip band={dim.exposureBand} />
                  {dim.activeFindingCount > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-1.5 py-0.5 text-[11px] text-sev-high">
                      <ShieldAlert className="h-3 w-3" /> {dim.activeFindingCount} active
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground/80">no active findings</span>
                  )}
                  {dim.resolvedFindingCount > 0 && (
                    <span className="text-[11px] text-muted-foreground/80">
                      {dim.resolvedFindingCount} resolved
                    </span>
                  )}
                  {dim.worstSeverity && (
                    <span className="ml-auto">
                      <SeverityPill severity={asSeverity(dim.worstSeverity)} />
                    </span>
                  )}
                </div>
                {dim.description && (
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {dim.description}
                  </p>
                )}
                {dim.findingTypes.length > 0 && (
                  <p className="mt-1 text-[10px] text-muted-foreground/80">
                    {dim.findingTypes.join(", ")}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Unmapped finding types: the engine found these and no dimension in
              this map claims them — surfaced as a gap, never dropped. */}
          {data.unmapped.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-400">
                Unmapped finding types
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {data.unmapped.map((u) => (
                  <li
                    key={u.findingType}
                    className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-400"
                  >
                    <span className="text-foreground">{u.findingType}</span>
                    <span>{u.activeFindingCount} active</span>
                    {u.worstSeverity && <SeverityPill severity={asSeverity(u.worstSeverity)} />}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * A finding's receipt digest, and what it can show. It used to say it was
 * "attesting [the evidence] is unaltered"; a bare digest attests nothing -- it is
 * a checksum anyone who changes the content can recompute. No signature comes
 * with a finding receipt, so the words say that too.
 */
export function FindingReceiptMark({ receipt }: { receipt: { algorithm: string; digest: string } }) {
  return (
    <span
      className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground"
      data-testid="finding-receipt"
      title={
        `Finding receipt (${receipt.algorithm}): a digest over this finding's identity and evidence hashes. ` +
        "No signature came with it. It shows a change only when compared with a copy obtained " +
        `independently; on its own it attests nothing.\n${receipt.digest}`
      }
    >
      <Fingerprint className="h-3 w-3" />
      {receipt.digest.slice(0, 12)}
    </span>
  );
}

/** The receipt's signing status as the backend reported it, in a word. */
function SignedChip({ signed }: { signed: boolean | null }) {
  const [text, tone] =
    signed === true
      ? ["signed (reported)", "border-sky-500/30 text-sky-300"]
      : signed === false
        ? ["unsigned", "border-amber-500/30 text-amber-300"]
        : ["signing not reported", "border-border/60 text-muted-foreground"];
  return (
    <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide", tone)} data-testid="receipt-signed-chip">
      {text}
    </span>
  );
}

/**
 * Whether this copy is signed, exactly as the backend said: `signed: false`
 * with its reason, `signed: true`, or nothing at all -- and nothing at all is
 * said as nothing, not rounded to either answer.
 */
function SignatureStatus({ signed, reason }: { signed: boolean | null; reason: string | null }) {
  return (
    <div className="mb-3 rounded-lg border border-border/40 bg-surface-0/40 p-2.5 text-[11px] text-muted-foreground" data-testid="receipt-signature">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Signature</p>
      {signed === false ? (
        <>
          <p>
            <span className="text-foreground">Unsigned.</span> The backend reports that this copy
            carries no signature, so its digests vouch for nothing about who produced it.
          </p>
          {reason && <p className="mt-1 text-muted-foreground/80">Backend&apos;s reason: {reason}</p>}
        </>
      ) : signed === true ? (
        <p>
          <span className="text-foreground">Reported signed.</span> The backend reports this copy as
          signed. This page neither shows nor verifies the signature; verify it offline against the
          engine&apos;s published keyring before relying on it.
        </p>
      ) : (
        <p>
          <span className="text-foreground">Not reported.</span> The backend did not say whether this
          copy is signed, and no signature reached this page.
        </p>
      )}
    </div>
  );
}

// A single digest, worn honestly: the full value is the load-bearing content (it
// is what a signature covers and what an auditor compares), but it is long, so
// it is TRUNCATED for display (first 12 + last 8) while the copy button and the
// title carry the value in FULL. A digest shows a change only against a copy
// obtained independently, or one a verified signature covers; on its own it
// attests nothing, and never that anything passed.
function DigestValue({ value }: { value: string }) {
  const { toast } = useToast();
  if (!value) {
    return <span className="text-[11px] text-muted-foreground/70">not computed</span>;
  }
  const shown = value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
  return (
    <span className="inline-flex items-center gap-1">
      <code className="font-mono text-[11px] text-foreground" title={value}>
        {shown}
      </code>
      <button
        type="button"
        aria-label="Copy the full digest"
        className="text-muted-foreground hover:text-primary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            toast({ title: "Digest copied" });
          } catch {
            toast({ title: "Could not copy the digest", variant: "destructive" });
          }
        }}
      >
        <Copy className="h-3 w-3" />
      </button>
    </span>
  );
}

/**
 * The full, versioned Assurance Receipt (spine) for one deployment: the roadmap
 * tuple — system, receipt version, policy, evidence root, result, per-assessment
 * digests — as one deterministic, portable, signable payload. Self-fetching
 * (mounted only inside an expanded deployment, like the other panels).
 *
 * It used to say the receipt "attests that the recorded evidence is unaltered".
 * A digest does no such thing by itself: anyone who can change the content can
 * change the digest beside it. It shows a change only when compared with a copy
 * obtained independently, or with one a verified signature covers -- and the
 * backend serves this route unsigned, saying so in the payload. So the panel
 * says what the digests can and cannot show, and states the signing status the
 * backend reported (signed / unsigned with its reason / not reported), never
 * one it inferred. Never that the system is secure or its conclusions true.
 *
 * The result is shown faithfully at its true strength (a needs-more-evidence
 * decision reads as exactly that), an undeclared policy reads as "no data
 * boundary declared" rather than an invented one, and the digests are truncated
 * for display but copied in full.
 */
export function AssuranceReceiptPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useQuery<AssuranceReceipt>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/assurance-receipt`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <ReceiptText className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Assurance receipt</h3>
      <span className="text-[11px] text-muted-foreground">record of the assessed state</span>
      {data && <SignedChip signed={data.signed} />}
      {data && (
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
                toast({ title: "Receipt JSON copied" });
              } catch {
                toast({ title: "Could not copy the receipt", variant: "destructive" });
              }
            }}
          >
            <Copy className="h-3 w-3" />
            Copy JSON
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
            onClick={() => {
              try {
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `assurance-receipt-${data.system.name || data.system.uuid}.json`;
                a.click();
                URL.revokeObjectURL(url);
              } catch {
                toast({ title: "Could not download the receipt", variant: "destructive" });
              }
            }}
          >
            <Download className="h-3 w-3" />
            Download this view (JSON)
          </button>
        </div>
      )}
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the assurance receipt…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the assurance receipt{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  return (
    <section>
      {heading}

      {/* What the digests can show, and whether anything signed them -- as the
          backend reported it. A digest checked against itself attests nothing. */}
      <p className="mb-2 text-[12px] leading-relaxed text-muted-foreground" data-testid="receipt-digest-meaning">
        The digests below identify this recorded state. They show a change only when compared
        with a copy obtained independently, or with one covered by a signature you have verified;
        checked against themselves they attest nothing. The JSON downloaded here is this page's
        rendering, not the bytes the backend hashed, so the digests cannot be recomputed from it.
        None of this says the system is secure or its conclusions are true, and the result below
        is shown at its true strength.
      </p>
      <SignatureStatus signed={data.signed} reason={data.unsignedReason} />

      {/* Version + result. The six-state decision reuses the page's decision
          chip, carried faithfully (a needs-more-evidence result reads as that). */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
        <span
          className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 font-mono text-muted-foreground"
          title="The version of the Assurance Receipt standard this payload conforms to"
        >
          {data.receiptVersion}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">result:</span>
          <DecisionPill
            decision={data.result.decision as never}
            label={data.result.decisionLabel || undefined}
          />
        </span>
        {data.system.environmentLabel && (
          <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
            {data.system.environmentLabel}
          </span>
        )}
      </div>

      {/* Policy: the declared data boundary, honestly. When none was approved we
          say so plainly — never an invented boundary. */}
      <div className="mb-3 rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Policy
        </p>
        {data.policy.declared ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" /> Data boundary declared
            </span>
            <span>
              regions:{" "}
              <span className="text-foreground">
                {data.policy.allowedRegions.length > 0
                  ? data.policy.allowedRegions.join(", ")
                  : "none listed"}
              </span>
            </span>
            <span>
              training:{" "}
              <span className="text-foreground">
                {data.policy.trainingAllowed ? "allowed" : "not allowed"}
              </span>
            </span>
            <span>
              third-party sharing:{" "}
              <span className="text-foreground">
                {data.policy.thirdPartySharingAllowed ? "allowed" : "not allowed"}
              </span>
            </span>
          </div>
        ) : (
          <p className="inline-flex items-center gap-1.5 text-[11px] text-amber-400">
            <ShieldQuestion className="h-3.5 w-3.5" /> No data boundary declared — an undeclared
            boundary is a gap, never a policy this receipt invents.
          </p>
        )}
      </div>

      {/* Evidence root: the Merkle-style digest over the finding/evidence hashes,
          with the finding count and hash algorithm. */}
      <div className="mb-3 rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Evidence root
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Fingerprint className="h-3 w-3" />
            <span className="uppercase tracking-wide">{data.evidence.algorithm}</span>
          </span>
          <DigestValue value={data.evidence.root} />
          <span>
            {data.evidence.findingCount}{" "}
            {data.evidence.findingCount === 1 ? "finding" : "findings"}
          </span>
        </div>
      </div>

      {/* Per-assessment digests. Each identifies its assessment as recorded —
          never that it passes. */}
      <div className="mb-3 rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Assessment digests
        </p>
        <ul className="space-y-1.5">
          {(
            [
              ["Compliance", data.assessments.compliance],
              ["Capabilities", data.assessments.capabilities],
              ["Boundary", data.assessments.boundary],
              ["AI-BOM", data.assessments.bom],
            ] as const
          ).map(([label, value]) => (
            <li key={label} className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="w-24 text-muted-foreground">{label}</span>
              <DigestValue value={value} />
            </li>
          ))}
        </ul>
      </div>

      {/* The top-level deterministic digest (the value a signature covers) and
          the computed-at metadata that rides OUTSIDE the hash. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Fingerprint className="h-3 w-3" />
          <span className="uppercase tracking-wide">{data.algorithm}</span>
          <span className="font-semibold text-foreground">receipt digest</span>
        </span>
        <DigestValue value={data.digest} />
        {data.computedAt && (
          <span className="inline-flex items-center gap-1 text-muted-foreground/80" title="Metadata only — computed outside the hash">
            <Clock className="h-3 w-3" />
            {data.computedAt}
          </span>
        )}
      </div>
    </section>
  );
}

// A vendor's (or a roll-up's) posture band, worn honestly as an ORDINAL concern
// signal, never a grade or a pass: high leads in red, elevated in amber, baseline
// in muted. A null band (no vendors to roll up) reads as "no vendors", never a
// pass. This never says "secure" — a weaker profile is a higher band.
function PostureBandChip({ band }: { band: string | null }) {
  if (!band) {
    return (
      <span className="inline-flex items-center rounded-full border border-border/50 bg-surface-1/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        No vendors
      </span>
    );
  }
  const look =
    band === "high"
      ? { cls: "border-sev-high/40 bg-sev-high/10 text-sev-high", label: "High concern" }
      : band === "elevated"
        ? { cls: "border-amber-500/40 bg-amber-500/10 text-amber-400", label: "Elevated" }
        : band === "baseline"
          ? { cls: "border-border/50 bg-surface-1/40 text-muted-foreground", label: "Baseline" }
          : { cls: "border-border/50 bg-surface-1/40 text-muted-foreground", label: band };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        look.cls,
      )}
      title="An ordinal posture band derived from the vendor's weakest evidence — a concern signal, never a grade or a claim the vendor is secure"
    >
      {look.label}
    </span>
  );
}

// A ratio the backend reports as a TRUE ratio of two real counts, or null when
// there was no basis to compute it (a zero denominator). Rendered as a percent,
// or an em-dash when null — NEVER a fake 0%, which would read as measured.
function ratioPct(ratio: number | null): string {
  return ratio === null ? "—" : `${Math.round(ratio * 100)}%`;
}

// An ordinal assurance-maturity band, worn honestly: it describes how well-
// evidenced the picture is, NEVER that the system is secure. Best → weakest.
function MaturityChip({ maturity }: { maturity: string }) {
  const look =
    maturity === "well_evidenced"
      ? { cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", label: "Well evidenced" }
      : maturity === "partially_evidenced"
        ? { cls: "border-amber-500/40 bg-amber-500/10 text-amber-400", label: "Partially evidenced" }
        : maturity === "sparsely_evidenced"
          ? { cls: "border-sev-high/40 bg-sev-high/10 text-sev-high", label: "Sparsely evidenced" }
          : { cls: "border-border/50 bg-surface-1/40 text-muted-foreground", label: maturity };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        look.cls,
      )}
      title="How well-evidenced the assurance picture is — a coverage read, never a claim the system is secure"
    >
      {look.label}
    </span>
  );
}

/**
 * Third-Party Vendor Assurance (commercial spine) for one deployment: each vendor
 * its components depend on, what that vendor asserts and at what evidence
 * strength, which components depend on it, an honest gap list, and an ordinal
 * posture band — plus the ungoverned dependencies. Self-fetching (mounted only
 * inside an expanded deployment). HONEST by construction: an assertion is shown as
 * independently evidenced ONLY when it truly is; a vendor_asserted / self-attested
 * claim reads as exactly that and is counted a gap, and the posture band is a
 * concern signal derived from the weakest evidence — never a claim the vendor is
 * secure or compliant.
 */
function VendorAssurancePanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<VendorAssurance>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/vendor-assurance`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Building2 className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Vendor assurance</h3>
      <span className="text-[11px] text-muted-foreground">third-party posture &amp; gaps</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the vendor assurance view…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the vendor assurance view{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const { summary } = data;

  return (
    <section>
      {heading}

      {summary.vendors === 0 && data.ungovernedDependencies.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No vendors resolved for this deployment yet — nothing on record to assess.
        </p>
      ) : (
        <>
          {/* Honest framing: a vendor claim reads as a vendor claim, and the
              posture band is a concern signal, never a grade or "secure". */}
          <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
            A <span className="text-foreground">vendor-asserted</span> claim reads as the vendor&apos;s
            own word — a gap until independently evidenced. The posture band is an ordinal concern
            signal from the weakest evidence, never a claim the vendor is secure.
          </p>

          {/* The scoreboard: vendors, independently-evidenced vs vendor-asserted
              assertions (shown honestly), gaps, and the worst posture band. */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.vendors} vendor{summary.vendors === 1 ? "" : "s"}
            </span>
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.independentlyEvidenced} independently evidenced · {summary.vendorAsserted}{" "}
              vendor-asserted
            </span>
            {summary.gaps > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
                <HelpCircle className="h-3.5 w-3.5" /> {summary.gaps} gap{summary.gaps === 1 ? "" : "s"}
              </span>
            )}
            {(summary.providerLessDependencies > 0 || summary.unmanagedDependencies > 0) && (
              <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-sev-high">
                <ShieldAlert className="h-3.5 w-3.5" /> {summary.providerLessDependencies} provider-less ·{" "}
                {summary.unmanagedDependencies} unmanaged
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <span className="text-muted-foreground">worst:</span>
              <PostureBandChip band={summary.worstPostureBand} />
            </span>
          </div>

          {/* Each vendor, most-concerning-first (the backend's order). */}
          <div className="space-y-2.5">
            {data.vendors.map((v) => (
              <div
                key={v.providerUuid}
                className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[12px] font-semibold text-foreground">{v.providerName}</span>
                  <PostureBandChip band={v.postureBand} />
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {v.kindLabel}
                  </span>
                  {v.region && (
                    <span className="text-[10px] text-muted-foreground/80">{v.region}</span>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {v.summary.independentlyEvidenced}/{v.summary.assertionCount} independently
                    evidenced
                  </span>
                </div>

                {/* The vendor's declared facts, each at its TRUE evidence strength.
                    A vendor-asserted / self-attested claim wears its gap honestly;
                    only a genuinely independent one is marked as such. */}
                {v.assertions.length > 0 && (
                  <ul className="mt-2 space-y-1.5 border-l border-border/40 pl-2.5">
                    {v.assertions.map((a) => (
                      <li
                        key={a.field}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
                      >
                        <span className="font-semibold text-foreground">{a.fieldLabel}</span>
                        {a.value && <span className="text-muted-foreground">{a.value}</span>}
                        <EvidenceClassChip value={a.evidenceClass} />
                        {a.independentlyEvidenced ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-medium text-emerald-300">
                            <ShieldCheck className="h-3 w-3" /> Independently evidenced
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[9px] font-medium text-amber-400"
                            title={`${a.sourceLabel} — the vendor's own word, not independently evidenced`}
                          >
                            <ShieldQuestion className="h-3 w-3" /> Vendor-asserted
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {/* The gaps, spelled out — weak/self-attested claims and unmanaged
                    dependencies, surfaced rather than smoothed. */}
                {v.gaps.length > 0 && (
                  <ul className="mt-2 space-y-1 border-l border-amber-500/30 pl-2.5">
                    {v.gaps.map((g, i) => (
                      <li key={i} className="text-[10px] leading-relaxed text-amber-400">
                        {g}
                      </li>
                    ))}
                  </ul>
                )}

                {/* What depends on this vendor. */}
                {v.dependentAssets.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Depends on it
                    </span>
                    {v.dependentAssets.map((d) => (
                      <span
                        key={d.assetName}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]",
                          d.managed
                            ? "border-border/50 bg-surface-1/40 text-muted-foreground"
                            : "border-sev-high/30 bg-sev-high/5 text-sev-high",
                        )}
                      >
                        <span className={d.managed ? "text-foreground" : "text-sev-high"}>
                          {d.assetName}
                        </span>
                        <span className="text-muted-foreground/80">{d.kindLabel}</span>
                        {!d.managed && <span>· {d.classificationLabel}</span>}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Ungoverned dependencies: components with no vendor behind them and/or
              unmanaged (shadow) — surfaced as first-class gaps, never dropped. */}
          {data.ungovernedDependencies.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sev-high">
                Ungoverned dependencies
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {data.ungovernedDependencies.map((u) => (
                  <li
                    key={`${u.kind}-${u.assetName}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-[11px] text-sev-high"
                    title={u.reason}
                  >
                    <ShieldAlert className="h-3.5 w-3.5" />
                    <span className="text-foreground">{u.assetName}</span>
                    <span className="text-muted-foreground/80">{u.kindLabel}</span>
                    <span>· {u.classificationLabel}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Vertical Assurance Packs (commercial spine) for one deployment: the code-only
 * catalog of industry packs, with a selector; on selecting a pack, the deployment's
 * compliance coverage read through that pack's lens is fetched and shown. Self-
 * fetching (mounted only inside an expanded deployment). HONEST by construction: a
 * pack's FRAMEWORKS are computed coverage (a touched control is an open gap, never
 * "passed"), while its REGULATORY REGIMES are carried as CONTEXT — each with its
 * "not computed coverage" note rendered visibly, never as scored/passing coverage.
 */
function VerticalPacksPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const catalog = useQuery<PacksCatalog>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/assurance-packs`],
  });
  const applied = useQuery<PackApplied>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/assurance-packs/${selected ?? ""}`],
    enabled: selected !== null,
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Boxes className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Vertical assurance packs</h3>
      <span className="text-[11px] text-muted-foreground">compliance through an industry lens</span>
    </div>
  );

  if (catalog.isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the assurance packs…</p>
      </section>
    );
  }
  if (catalog.isError || !catalog.data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the assurance packs
          {catalog.error instanceof Error ? `: ${catalog.error.message}` : "."}
        </p>
      </section>
    );
  }

  const selectedPack = catalog.data.packs.find((p) => p.key === selected) ?? null;

  return (
    <section>
      {heading}

      <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
        A pack narrows the compliance lens to one vertical. Its{" "}
        <span className="text-foreground">frameworks</span> carry real coverage — a touched control is
        a gap, never a control met — while its <span className="text-foreground">regulatory regimes</span>{" "}
        are context Athena does not score.
      </p>

      {/* The pack selector — the four packs as a tab row. */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {catalog.data.packs.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setSelected((cur) => (cur === p.key ? null : p.key))}
            aria-pressed={selected === p.key}
            className={cn(
              "rounded-md border px-2.5 py-1 text-[11px] transition-colors",
              selected === p.key
                ? "border-primary/50 bg-primary/10 text-foreground"
                : "border-border/50 bg-surface-1/40 text-muted-foreground hover:text-foreground",
            )}
          >
            {p.name}
          </button>
        ))}
      </div>

      {selectedPack === null ? (
        <p className="text-[12px] text-muted-foreground">
          Select a pack to read this deployment&apos;s coverage through its lens.
        </p>
      ) : (
        <div className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
          <p className="text-[12px] leading-relaxed text-muted-foreground">{selectedPack.description}</p>

          {/* The evidence a buyer in this vertical expects. */}
          {selectedPack.evidenceExpectations.length > 0 && (
            <div className="mt-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Evidence expectations
              </p>
              <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                {selectedPack.evidenceExpectations.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {/* The applied coverage. */}
          {applied.isLoading && (
            <p className="mt-2 text-[12px] text-muted-foreground">Reading coverage through this pack…</p>
          )}
          {applied.isError && (
            <p className="mt-2 text-[12px] text-muted-foreground">
              Could not read coverage through this pack
              {applied.error instanceof Error ? `: ${applied.error.message}` : "."}
            </p>
          )}
          {applied.data && (
            <>
              {/* Emphasized frameworks — real, honest coverage. */}
              <div className="mt-3">
                <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Framework coverage
                  </span>
                  <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-0.5 text-muted-foreground">
                    {applied.data.summary.activeFindings} active · {applied.data.summary.resolvedFindings}{" "}
                    resolved
                  </span>
                  {applied.data.summary.controlsWithActiveFindings > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-0.5 text-sev-high">
                      <ShieldAlert className="h-3.5 w-3.5" />{" "}
                      {applied.data.summary.controlsWithActiveFindings} control
                      {applied.data.summary.controlsWithActiveFindings === 1 ? "" : "s"} with active
                      findings
                    </span>
                  )}
                  {applied.data.summary.worstSeverity && (
                    <SeverityPill severity={asSeverity(applied.data.summary.worstSeverity)} />
                  )}
                </div>
                <div className="space-y-2">
                  {applied.data.frameworks.map((fw) => (
                    <div key={fw.key} className="rounded-md border border-border/40 bg-surface-1/30 p-2">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[12px] font-semibold text-foreground">{fw.name}</span>
                        {fw.summary.controlsTouched > 0 ? (
                          <span className="text-[11px] text-muted-foreground">
                            {fw.summary.controlsTouched} control
                            {fw.summary.controlsTouched === 1 ? "" : "s"} touched
                            {fw.summary.controlsWithActiveFindings > 0 &&
                              ` · ${fw.summary.controlsWithActiveFindings} with active findings`}
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted-foreground/80">
                            no findings mapped here
                          </span>
                        )}
                        {fw.summary.worstSeverity && (
                          <span className="ml-auto">
                            <SeverityPill severity={asSeverity(fw.summary.worstSeverity)} />
                          </span>
                        )}
                      </div>
                      {fw.controls.length > 0 && (
                        <ul className="mt-1.5 space-y-1 border-l border-border/40 pl-2.5">
                          {fw.controls.map((c) => (
                            <li
                              key={c.controlId}
                              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
                            >
                              <span className="font-mono font-semibold text-foreground">
                                {c.controlId}
                              </span>
                              {c.name && <span className="text-muted-foreground">{c.name}</span>}
                              {c.activeFindingCount > 0 ? (
                                <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-1.5 py-0.5 text-sev-high">
                                  <ShieldAlert className="h-3 w-3" /> {c.activeFindingCount} active
                                </span>
                              ) : (
                                <span className="text-muted-foreground/80">
                                  {c.resolvedFindingCount} resolved
                                </span>
                              )}
                              {c.worstSeverity && <SeverityPill severity={asSeverity(c.worstSeverity)} />}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Regulatory regimes — CONTEXT, never computed coverage. The note is
                  rendered visibly so a reader never mistakes it for a score. */}
              {applied.data.regulatoryRegimes.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                    Regulatory context (not computed coverage)
                  </p>
                  <ul className="space-y-1.5">
                    {applied.data.regulatoryRegimes.map((r) => (
                      <li
                        key={r.name}
                        className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px]"
                      >
                        <span className="inline-flex items-center gap-1 font-semibold text-amber-400">
                          <ShieldQuestion className="h-3.5 w-3.5" /> {r.name}
                        </span>
                        <p className="mt-0.5 leading-relaxed text-muted-foreground">{r.note}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Executive summary (commercial spine) for one deployment: the assurance graph
 * rolled up for a leadership reader — asset coverage, evidence distribution,
 * finding posture by severity, remediation velocity, the six-state decision, an
 * ordinal risk posture and assurance-maturity band, and a headline from each
 * sibling assessment. Self-fetching (mounted only inside an expanded deployment).
 * HONEST by construction: every value is a real count, a TRUE ratio of real counts
 * (shown as "—" when there is no basis to compute, NEVER a fake 0%), or an ordinal
 * band. There is NO invented dollar/ROI figure anywhere — the backend emits none,
 * and none is added here. A resolved remediation is a PROCESS claim, never
 * security closure; nothing here says the system is secure.
 */
function ExecutiveSummaryPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<ExecutiveSummary>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/executive-summary`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <FileText className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Executive summary</h3>
      <span className="text-[11px] text-muted-foreground">posture &amp; coverage, never money</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the executive summary…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the executive summary{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const { assetCoverage, evidence, findings, remediation, assessments } = data;

  return (
    <section>
      {heading}

      {/* Honest framing: value is posture, coverage and counts — never money. */}
      <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
        Value here is <span className="text-foreground">posture, coverage and counts</span> — never a
        dollar figure. A ratio with no basis to compute reads as &quot;—&quot;, never a 0%.
      </p>

      {/* The headline row: the six-state decision, posture, and maturity band. */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">decision:</span>
          <DecisionPill
            decision={data.decision.decision as never}
            label={data.decision.decisionLabel || undefined}
          />
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">posture:</span>
          <PostureBandChip band={data.posture} />
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">maturity:</span>
          <MaturityChip maturity={data.assuranceMaturity} />
        </span>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        {/* Asset coverage: how much of the graph is classified vs unknown/shadow.
            Ratios shown as "—" when null, never a fake 0%. */}
        <div className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Asset coverage
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              <span className="text-foreground">{ratioPct(assetCoverage.coverageRatio)}</span> classified
            </span>
            <span>
              <span className="text-foreground">{ratioPct(assetCoverage.managedRatio)}</span> managed
            </span>
            <span>{assetCoverage.totalAssets} total</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
            {assetCoverage.shadow > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-1.5 py-0.5 text-sev-high">
                <ShieldAlert className="h-3 w-3" /> {assetCoverage.shadow} shadow
              </span>
            )}
            {assetCoverage.unknown > 0 && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/5 px-1.5 py-0.5 text-amber-400">
                {assetCoverage.unknown} unknown
              </span>
            )}
            {assetCoverage.highRisk > 0 && (
              <span className="rounded-md border border-sev-high/30 bg-sev-high/5 px-1.5 py-0.5 text-sev-high">
                {assetCoverage.highRisk} high-risk
              </span>
            )}
          </div>
        </div>

        {/* Evidence distribution: how much of what is found is independently
            evidenced vs unverified. */}
        <div className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Evidence
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              <span className="text-foreground">{evidence.independentlyEvidenced}</span> independently
              evidenced
            </span>
            <span>
              <span className="text-foreground">{evidence.unverified}</span> unverified
            </span>
            <span>{evidence.findingCount} findings</span>
          </div>
        </div>

        {/* Findings by severity — active vs resolved, worst active severity. */}
        <div className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Findings
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              <span className="text-foreground">{findings.active}</span> active ·{" "}
              {findings.resolved} resolved
            </span>
            {findings.worstActiveSeverity && (
              <span className="inline-flex items-center gap-1">
                <span>worst:</span>
                <SeverityPill severity={asSeverity(findings.worstActiveSeverity)} />
              </span>
            )}
          </div>
          {Object.keys(findings.activeBySeverity).length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
              {Object.entries(findings.activeBySeverity).map(([sev, count]) => (
                <span key={sev} className="inline-flex items-center gap-1">
                  <SeverityPill severity={asSeverity(sev)} />
                  <span className="text-muted-foreground">×{count}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Remediation velocity — resolution_ratio is a PROCESS claim, labelled as
            such, never security closure. */}
        <div className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Remediation velocity
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              <span className="text-foreground">{remediation.open}</span> open ·{" "}
              {remediation.resolved} resolved · {remediation.wontFix} won&apos;t-fix
            </span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            <span className="text-foreground">{ratioPct(remediation.resolutionRatio)}</span>{" "}
            resolved-in-workflow{" "}
            <span className="text-muted-foreground/80">
              — a process claim (work called done), not security closure
            </span>
          </p>
        </div>
      </div>

      {/* Sibling assessment headlines, rolled up (each owns its own honest read). */}
      <div className="mt-3 rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Assessment headlines
        </p>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-0.5">
            compliance: {assessments.compliance.controlsWithActiveFindings} control
            {assessments.compliance.controlsWithActiveFindings === 1 ? "" : "s"} with active findings
            {assessments.compliance.worstSeverity && (
              <>
                {" "}
                · <SeverityPill severity={asSeverity(assessments.compliance.worstSeverity)} />
              </>
            )}
          </span>
          <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-0.5">
            impact: {assessments.businessImpact.dimensionsWithActiveExposure} dimension
            {assessments.businessImpact.dimensionsWithActiveExposure === 1 ? "" : "s"} exposed
            {assessments.businessImpact.worstExposureBand && (
              <> · {assessments.businessImpact.worstExposureBand}</>
            )}
          </span>
          <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-0.5">
            capabilities: {assessments.capabilities.highRisk} high-risk · {assessments.capabilities.shadow}{" "}
            shadow
          </span>
          <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-0.5">
            boundary:{" "}
            {assessments.boundary.declared
              ? `${assessments.boundary.violations} violation${assessments.boundary.violations === 1 ? "" : "s"} · ${assessments.boundary.unknowns} unknown${assessments.boundary.unknowns === 1 ? "" : "s"}`
              : "not declared"}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-surface-1/40 px-2 py-0.5">
            vendors: {assessments.vendors.gaps} gap
            {assessments.vendors.gaps === 1 ? "" : "s"} · <PostureBandChip band={assessments.vendors.worstPostureBand} />
          </span>
        </div>
      </div>
    </section>
  );
}

// The ordinal operational-readiness band, worn honestly: a weakest-wins read of how
// well the continuous-assurance loop is being sustained (evidence freshness, change
// backlog, open remediation), where the softest signal sets the floor. It describes
// the state of the loop, never a verdict on the system; `stale` is the honest floor
// for an unassessed or empty deployment — shown plainly, not as an error and never
// rounded up. Best → weakest. `steady` is earned (all three real ratios strong), so
// green never appears by default: an empty deployment reads `stale`.
function ReadinessChip({ readiness }: { readiness: string }) {
  const look =
    readiness === "steady"
      ? { cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", label: "Steady" }
      : readiness === "attention"
        ? { cls: "border-amber-500/40 bg-amber-500/10 text-amber-400", label: "Needs attention" }
        : readiness === "stale"
          ? { cls: "border-sev-high/40 bg-sev-high/10 text-sev-high", label: "Stale" }
          : { cls: "border-border/50 bg-surface-1/40 text-muted-foreground", label: readiness };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        look.cls,
      )}
      title="An ordinal readiness band from real ratios — evidence freshness, change backlog, and open remediation — where the weakest signal sets the floor. It describes how the continuous-assurance loop is being sustained, never a verdict on the system; 'stale' is the honest floor for an unassessed or empty deployment, not an error."
    >
      {look.label}
    </span>
  );
}

/**
 * The Operational / continuous-assurance roll-up (commercial spine) for one
 * deployment: where it sits in the continuous-assurance loop — evidence
 * freshness/staleness, the change backlog needing reassessment, remediation
 * velocity, the six-state decision, and an ordinal readiness band. Self-fetching
 * (mounted only inside an expanded deployment). HONEST by construction and never
 * green-by-default: the readiness band is weakest-wins (an unassessed or empty
 * deployment reads `stale`, shown plainly), every ratio is shown as "—" when there
 * is no basis to compute it (NEVER a fake 0%), the decision is None-safe (null reads
 * "Not assessed", never "ready"), and a resolved remediation is a PROCESS claim
 * (a human marked the work done), never a security closure.
 */
export function OperationalAssurancePanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<OperationalAssurance>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/operational-assurance`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <RefreshCw className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Operational assurance</h3>
      <span className="text-[11px] text-muted-foreground">continuous-assurance readiness, never green-by-default</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the operational roll-up…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the operational roll-up{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const { evidenceFreshness, changeBacklog, remediation } = data;

  return (
    <section>
      {heading}

      {/* Honest framing: the band is weakest-wins, and a ratio with no basis reads
          as "—", never a 0%. An unassessed deployment lands honestly in stale. */}
      <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
        Where this deployment sits in the continuous-assurance loop. The readiness band is{" "}
        <span className="text-foreground">weakest-wins</span> — the softest of evidence freshness,
        change backlog and open remediation sets the floor — and a ratio with no basis to compute
        reads as &quot;—&quot;, never a 0%.
      </p>

      {/* The headline row: the ordinal readiness band and the six-state decision. */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">readiness:</span>
          <ReadinessChip readiness={data.readiness} />
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">decision:</span>
          <DecisionPill
            decision={data.decision.decision as never}
            label={data.decision.decisionLabel || undefined}
          />
        </span>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        {/* Evidence freshness: how much evidence is within its TTL vs stale. The
            ratio is "—" when there are no findings to age, never a fake 100%. The
            stale count is surfaced, never hidden — a stale finding is a retest due. */}
        <div className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Evidence freshness
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              <span className="text-foreground">{ratioPct(evidenceFreshness.freshnessRatio)}</span>{" "}
              {/* "0-day TTL" was a default leaking into a sentence: it claimed this
                  deployment's evidence expires the instant it is written. When the
                  backend reports no TTL the sentence says so and stops. */}
              {evidenceFreshness.ttlDays === null
                ? "within its TTL (length not reported)"
                : `within its ${evidenceFreshness.ttlDays}-day TTL`}
            </span>
            <span>{evidenceFreshness.total} findings</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-1.5 py-0.5 text-muted-foreground">
              {evidenceFreshness.current} within TTL
            </span>
            {evidenceFreshness.stale > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-1.5 py-0.5 text-amber-400">
                <Clock className="h-3 w-3" /> {evidenceFreshness.stale} stale · retest due
              </span>
            )}
          </div>
        </div>

        {/* Change backlog: what changed since the last scan and so needs a fresh
            look. Recurring is steady state, not backlog. Ratio "—" when null. */}
        <div className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Change backlog
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              <span className="text-foreground">{ratioPct(changeBacklog.needsReassessmentRatio)}</span>{" "}
              needs reassessment
            </span>
            <span>
              <span className="text-foreground">{changeBacklog.needsReassessment}</span> of{" "}
              {changeBacklog.total} findings changed
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
            {changeBacklog.new > 0 && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/5 px-1.5 py-0.5 text-amber-400">
                {changeBacklog.new} new
              </span>
            )}
            {changeBacklog.cleared > 0 && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/5 px-1.5 py-0.5 text-amber-400">
                {changeBacklog.cleared} cleared
              </span>
            )}
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-1.5 py-0.5 text-muted-foreground">
              {changeBacklog.recurring} recurring · steady state
            </span>
          </div>
        </div>

        {/* Remediation velocity — resolution_ratio is a PROCESS claim, labelled as
            such, never a security closure. Mirrors the executive summary. */}
        <div className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5 sm:col-span-2">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Remediation velocity
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              <span className="text-foreground">{remediation.open}</span> open ·{" "}
              {remediation.resolved} marked resolved · {remediation.wontFix} won&apos;t-fix
            </span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            <span className="text-foreground">{ratioPct(remediation.resolutionRatio)}</span>{" "}
            resolved-in-workflow{" "}
            <span className="text-muted-foreground/80">
              — a process claim (a human marked the work done), not a security closure
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}

// ==== Access & Blast Radius + Posture + Data & Context (Phase 3 + 2.5) ====

/**
 * A group heading that opens one of the three Phase-3 dashboard sections. It is a
 * visual grouping only — each panel below still owns its own honest read.
 */
function SectionHeading({
  icon: Icon,
  title,
  blurb,
}: {
  icon: typeof Fingerprint;
  title: string;
  blurb: string;
}) {
  return (
    <div className="border-b border-border/40 pb-1.5">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-foreground">{title}</h3>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{blurb}</p>
    </div>
  );
}

/** A declared reach path, rendered hop → hop. Evidenced, never invented — it is the
 *  path the backend attested, shown so a reader can audit the reach. */
function ViaPath({ via }: { via: string[] }) {
  if (via.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
      {via.map((hop, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-muted-foreground/50">→</span>}
          <span className="rounded bg-surface-1/50 px-1 py-0.5 text-foreground/80">{hop}</span>
        </span>
      ))}
    </span>
  );
}

/** A principal's privilege band, worn honestly — derived from the sensitive powers
 *  it holds, never a claim it is least-privileged. */
function PrivilegeChip({ level }: { level: string }) {
  const look =
    level === "high"
      ? { cls: "border-sev-high/40 bg-sev-high/10 text-sev-high", label: "High privilege" }
      : level === "elevated"
        ? { cls: "border-amber-500/40 bg-amber-500/10 text-amber-400", label: "Elevated privilege" }
        : { cls: "border-border/50 bg-surface-1/40 text-muted-foreground", label: "Standard" };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        look.cls,
      )}
      title="Derived from the sensitive powers this identity holds — never a claim it is least-privileged"
    >
      {look.label}
    </span>
  );
}

/**
 * Identity Assurance & Effective Access (Phase 3.1) for one deployment: the
 * principals that can act, each one's privilege, held capabilities, transitive
 * effective reach (with the evidenced via-path), and identity-assurance gaps. Self-
 * fetching (mounted only inside an expanded deployment). Honest by construction: it
 * never claims least privilege is satisfied or an identity is secure — powers,
 * reach, and gaps only, and a shadow (unmanaged) principal reads as shadow.
 */
// A deployment can resolve hundreds of principals, each with nested capability,
// reach, and gap lists; rendering them all at once janks the card. Show the
// attention-first slice and reveal the rest on demand, always with the true
// total in view so nothing reads as hidden or complete.
const PRINCIPAL_RENDER_CAP = 50;

function EffectiveAccessPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<EffectiveAccess>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/effective-access`],
  });
  const [showAllPrincipals, setShowAllPrincipals] = useState(false);

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Fingerprint className="h-4 w-4 text-primary" />
      <h4 className="text-[13px] font-semibold text-foreground">Effective access</h4>
      <span className="text-[11px] text-muted-foreground">who can reach what</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the effective-access view…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the effective-access view{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const { summary } = data;

  return (
    <section>
      {heading}
      {data.principals.length === 0 ? (
        <>
          <p className="text-[12px] text-muted-foreground">
            No principals resolved for this deployment yet — no identity that can act is on record.
          </p>
          {/* An empty inventory and an inventory we could not read are different
              answers. If references went unplaced, "nothing on record" is not the
              honest end of the sentence. */}
          <UnresolvedReferences
            rows={data.unresolved}
            reported={summary.unresolvedReferences}
            what="this assessment"
          />
        </>
      ) : (
        <>
          <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
            Every path is <span className="text-foreground">evidenced</span> — a reach is claimed only
            where a declared edge attests each hop. This never says least privilege is satisfied or an
            identity is secure; it surfaces powers, transitive reach, and gaps.
          </p>

          {/* Sits directly under the evidenced-paths claim because it qualifies
              it: a reach computed over a graph with dangling references is a
              reach over an incomplete graph. */}
          <div className="mb-3">
            <UnresolvedReferences
            rows={data.unresolved}
            reported={summary.unresolvedReferences}
            what="this assessment"
          />
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.principals} principal{summary.principals === 1 ? "" : "s"}
            </span>
            {summary.privileged > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-sev-high">
                <ShieldAlert className="h-3.5 w-3.5" /> {summary.privileged} privileged
              </span>
            )}
            {summary.overBroad > 0 && (
              <span className="rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-sev-high">
                {summary.overBroad} over-broad
              </span>
            )}
            {summary.shadow > 0 && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
                {summary.shadow} shadow
              </span>
            )}
            {summary.orphaned > 0 && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
                {summary.orphaned} orphaned
              </span>
            )}
            {/* The one roll-up that says some identity can transitively reach
                something high-risk. The BFF has always mapped it and this page
                rendered it nowhere -- a fact the control plane states plainly,
                dropped one hop before the operator, while every other field in
                the same summary object has a chip. */}
            {summary.highRiskReach > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-sev-high">
                <ShieldAlert className="h-3.5 w-3.5" /> {summary.highRiskReach} high-risk reach
              </span>
            )}
            {summary.unresolvedReferences !== null && summary.unresolvedReferences > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
                <HelpCircle className="h-3.5 w-3.5" /> {summary.unresolvedReferences} unresolved
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <span className="text-muted-foreground">worst:</span>
              <CapabilityRiskChip risk={summary.worstRisk} />
            </span>
          </div>

          <div className="space-y-2.5">
            {(showAllPrincipals
              ? data.principals
              : data.principals.slice(0, PRINCIPAL_RENDER_CAP)
            ).map((p) => (
              <div key={p.key} className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[12px] font-semibold text-foreground">{p.name}</span>
                  <CapabilityRiskChip risk={p.risk} />
                  <PrivilegeChip level={p.privilegeLevel} />
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {p.kindLabel}
                  </span>
                  {p.shadow && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[9px] font-medium text-amber-400"
                      title="Evidenced only by unmanaged / unknown assets — a power nobody approved"
                    >
                      <ShieldQuestion className="h-3 w-3" /> Shadow
                    </span>
                  )}
                </div>

                {/* Held sensitive capabilities — the powers privilege is derived from. */}
                {p.capabilities.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.capabilities.map((c) => (
                      <span
                        key={c.key}
                        className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-surface-1/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        title={c.sources.map((s) => `${s.assetName}: ${s.permission}`).join(" · ")}
                      >
                        <span className="text-foreground">{c.label}</span>
                        <CapabilityRiskChip risk={c.risk} />
                      </span>
                    ))}
                  </div>
                )}

                {/* Transitive effective reach, each with its evidenced via-path. */}
                {p.effectiveReach.length > 0 && (
                  <div className="mt-2 border-l border-border/40 pl-2.5">
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Effective reach
                    </p>
                    <ul className="space-y-1">
                      {p.effectiveReach.map((r, i) => (
                        <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                          <span
                            className={cn(
                              "font-medium",
                              r.targetKind === "capability"
                                ? "text-amber-300"
                                : r.targetManaged
                                  ? "text-foreground"
                                  : "text-sev-high",
                            )}
                          >
                            {r.target}
                          </span>
                          <span className="text-[10px] text-muted-foreground/80">{r.targetKindLabel}</span>
                          <CapabilityRiskChip risk={r.risk} />
                          <ViaPath via={r.via} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Identity-assurance gaps — surfaced, never smoothed. */}
                {p.gaps.length > 0 && (
                  <ul className="mt-2 space-y-1 border-l border-amber-500/30 pl-2.5">
                    {p.gaps.map((g, i) => (
                      <li key={i} className="text-[10px] leading-relaxed text-amber-400">
                        {g.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>

          {data.principals.length > PRINCIPAL_RENDER_CAP && (
            <button
              onClick={() => setShowAllPrincipals((v) => !v)}
              className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
              aria-expanded={showAllPrincipals}
            >
              {showAllPrincipals
                ? `Show fewer (of ${data.principals.length})`
                : `Show ${data.principals.length - PRINCIPAL_RENDER_CAP} more (${data.principals.length} total)`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Ripple Effect / blast-radius (Phase 2.5) for one deployment: for each origin worth
 * tracing, a few well-supported downstream consequences a compromise of it could
 * have, each tied to the evidenced via-path. Self-fetching (mounted only inside an
 * expanded deployment). Honest by construction: every consequence is potential and
 * evidence-based, the list is bounded to the well-supported core (and the full
 * evidenced count shown so the bounding is visible), and an origin with no evidenced
 * downstream reach reads as exactly that, never as safe or contained.
 */
export function RippleEffectPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<RippleEffect>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/ripple-effect`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Zap className="h-4 w-4 text-primary" />
      <h4 className="text-[13px] font-semibold text-foreground">Ripple effect</h4>
      <span className="text-[11px] text-muted-foreground">bounded blast radius</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the ripple-effect view…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the ripple-effect view{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const { summary } = data;

  return (
    <section>
      {heading}
      {summary.origins === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No origins worth tracing — no active high/critical finding on a component and no privileged
          or high-risk principal on record.
        </p>
      ) : (
        <>
          <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
            Each consequence is a <span className="text-foreground">potential</span>, evidence-based
            downstream effect a compromise <span className="text-foreground">could</span> have — never a
            realized harm or a cascade the graph does not attest. The list is bounded to a{" "}
            <span className="text-foreground">few well-supported</span> consequences per origin.
          </p>

          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.origins} origin{summary.origins === 1 ? "" : "s"} · {summary.originsWithReach} with
              evidenced reach
            </span>
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.consequences} shown
              {summary.bounded === true && (
                <span className="text-amber-400"> · {summary.evidencedConsequences} evidenced (bounded)</span>
              )}
              {/* Absent is not "not bounded". Without this, a backend that said
                  nothing about bounding looked exactly like one that said the
                  list is complete. */}
              {summary.bounded === null && (
                <span className="text-muted-foreground"> · bounding not reported</span>
              )}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="text-muted-foreground">worst:</span>
              <CapabilityRiskChip risk={summary.worstRisk} />
            </span>
          </div>

          {/* The well-supported consequences, ranked most-concerning first. */}
          {data.consequences.length > 0 && (
            <div className="mb-3 space-y-1.5">
              {data.consequences.map((c, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-border/40 bg-surface-0/40 p-2"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                    <CapabilityRiskChip risk={c.risk} />
                    <span className="font-medium text-foreground">{c.consequence}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {c.categoryLabel}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-[10px] text-muted-foreground">from</span>
                    <span className="text-[10px] font-medium text-foreground/80">{c.origin}</span>
                    <ViaPath via={c.via} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Origins, with the honest "no evidenced downstream reach" note where it
              applies — never rounded up to "safe". */}
          <div className="space-y-1.5">
            {data.origins.map((o) => (
              <div key={o.key} className="rounded-lg border border-border/40 bg-surface-0/40 p-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                  <CapabilityRiskChip risk={o.risk} />
                  <span className="font-semibold text-foreground">{o.origin}</span>
                  {o.originTypes.map((t) => (
                    <span
                      key={t}
                      className="rounded border border-border/50 bg-surface-1/40 px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground"
                    >
                      {t}
                    </span>
                  ))}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {o.consequenceCount} evidenced consequence{o.consequenceCount === 1 ? "" : "s"}
                  </span>
                </div>
                {o.reasons.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {o.reasons.map((r, i) => (
                      <li key={i} className="text-[10px] leading-relaxed text-muted-foreground">
                        · {r}
                      </li>
                    ))}
                  </ul>
                )}
                {!o.evidencedReach && o.note && (
                  <p className="mt-1 text-[10px] italic text-muted-foreground/80">{o.note}</p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** One posture finding's status, worn honestly: a "pass" is the observed absence of
 *  ONE gap, never a claim the system is secure; unknown reads unknown. */
function PostureStatusChip({ status }: { status: string }) {
  const look =
    status === "gap"
      ? { cls: "border-sev-high/40 bg-sev-high/10 text-sev-high", label: "Gap", title: "A gap was observed in the data read" }
      : status === "unknown"
        ? { cls: "border-amber-500/40 bg-amber-500/10 text-amber-400", label: "Unknown", title: "No data to judge — never read as a pass" }
        : {
            cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
            label: "No gap observed",
            title: "The observed absence of THIS gap — not a claim the system is secure",
          };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        look.cls,
      )}
      title={look.title}
    >
      {look.label}
    </span>
  );
}

/** One posture domain (cloud / secrets / repo): connected vs honestly not-connected,
 *  and, when connected, its checks/findings. An inert domain reads as "Not connected
 *  — no credentials configured", NEVER "all clear". */
function PostureDomainCard({
  icon: Icon,
  deploymentUuid,
  domain,
  query,
}: {
  icon: typeof Cpu;
  deploymentUuid: string;
  domain: string;
  query: string;
}) {
  const { data, isLoading, isError, error } = useQuery<PostureDomain>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/${query}`],
  });

  const shell = (children: ReactNode, label?: string) => (
    <div className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
      <div className="mb-1 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[12px] font-semibold text-foreground">{label ?? domain}</span>
      </div>
      {children}
    </div>
  );

  if (isLoading) return shell(<p className="text-[11px] text-muted-foreground">Loading…</p>);
  if (isError || !data) {
    return shell(
      <p className="text-[11px] text-muted-foreground">
        Could not load{error instanceof Error ? `: ${error.message}` : "."}
      </p>,
    );
  }

  // The honest inert read: not connected is not "all clear". The catalog of checks
  // it WOULD run is shown so a reader sees what is going unassessed.
  if (!data.connected) {
    return shell(
      <>
        <span
          className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400"
          title="No credentials are configured for this domain, so nothing was read — this is not a clean bill"
        >
          <ShieldQuestion className="h-3 w-3" /> Not connected — no credentials configured
        </span>
        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
          Nothing was read, so nothing is asserted. It would run{" "}
          <span className="text-foreground">{data.summary.planned}</span> check
          {data.summary.planned === 1 ? "" : "s"} once credentials are supplied.
        </p>
        {data.checks.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-1">
            {data.checks.map((c) => (
              <li
                key={c.check}
                className="inline-flex items-center gap-1 rounded border border-border/50 bg-surface-1/40 px-1.5 py-0.5 text-[9px] text-muted-foreground"
                title={c.description}
              >
                <span className="text-foreground/80">{c.title}</span>
              </li>
            ))}
          </ul>
        )}
      </>,
      data.domainLabel,
    );
  }

  // Connected: the checks evaluated against read data, most-actionable first.
  const s = data.summary;
  return shell(
    <>
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-300">
          <ShieldCheck className="h-3 w-3" /> Connected
        </span>
        {s.gap > 0 && (
          <span className="rounded-md border border-sev-high/30 bg-sev-high/5 px-1.5 py-0.5 text-sev-high">
            {s.gap} gap{s.gap === 1 ? "" : "s"}
          </span>
        )}
        {s.unknown > 0 && (
          <span className="rounded-md border border-amber-500/30 bg-amber-500/5 px-1.5 py-0.5 text-amber-400">
            {s.unknown} unknown
          </span>
        )}
        <span className="text-muted-foreground">{s.pass} no-gap</span>
        {s.weakestEvidence && (
          <span className="inline-flex items-center gap-1">
            <span className="text-muted-foreground">weakest:</span>
            <EvidenceClassChip value={s.weakestEvidence} />
          </span>
        )}
      </div>
      {data.findings.length > 0 && (
        <ul className="mt-2 space-y-1 border-l border-border/40 pl-2.5">
          {data.findings.map((f) => (
            <li key={f.check} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
              <PostureStatusChip status={f.status} />
              <CapabilityRiskChip risk={f.severity} />
              <span className="text-foreground/90">{f.title}</span>
              <EvidenceClassChip value={f.evidenceClass} />
            </li>
          ))}
        </ul>
      )}
    </>,
    data.domainLabel,
  );
}

/**
 * The credential-gated posture section (Phase 3.2–3.4) for one deployment: the
 * catalog of posture domains, and per domain (cloud / secrets / repo) whether it is
 * connected — and, honestly, "Not connected — no credentials configured" when it is
 * inert. Self-fetching (mounted only inside an expanded deployment). An inert domain
 * never reads as "all clear": nothing was read, so nothing is asserted.
 */
function PosturePanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<PostureCatalog>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/posture`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <ShieldQuestion className="h-4 w-4 text-primary" />
      <h4 className="text-[13px] font-semibold text-foreground">Posture domains</h4>
      <span className="text-[11px] text-muted-foreground">credential-gated</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the posture catalog…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the posture catalog{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const configured = data.domains.filter((d) => d.configured).length;

  return (
    <section>
      {heading}
      <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
        These domains read a customer&apos;s cloud, secret store, or source-control through granted
        credentials. With none configured a domain is{" "}
        <span className="text-foreground">inert</span> — it reads nothing, so it asserts nothing.{" "}
        <span className="text-foreground">Not connected is never &quot;all clear&quot;.</span>{" "}
        {configured} of {data.domains.length} configured.
      </p>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <PostureDomainCard icon={Cpu} deploymentUuid={deploymentUuid} domain="Cloud" query="cloud-posture" />
        <PostureDomainCard
          icon={ShieldCheck}
          deploymentUuid={deploymentUuid}
          domain="Secrets"
          query="secrets-posture"
        />
        <PostureDomainCard
          icon={GitBranch}
          deploymentUuid={deploymentUuid}
          domain="Repository"
          query="repo-posture"
        />
      </div>
    </section>
  );
}

/**
 * Personal Context Exposure (Phase 3.5) for one deployment: the data-bearing
 * components, what personal data each evidences (or an honest unknown), which
 * principals can reach it, and the gaps. Self-fetching (mounted only inside an
 * expanded deployment). An unclassified store reads as UNKNOWN — personal-data
 * exposure cannot be ruled out, never "no PII" — and no data value is shown.
 */
function PersonalContextPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<PersonalContext>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/personal-context`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <User className="h-4 w-4 text-primary" />
      <h4 className="text-[13px] font-semibold text-foreground">Personal context</h4>
      <span className="text-[11px] text-muted-foreground">personal data &amp; who can reach it</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the personal-context view…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the personal-context view{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const { summary } = data;

  return (
    <section>
      {heading}
      {data.stores.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No data-bearing components discovered for this deployment yet.
        </p>
      ) : (
        <>
          <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
            An <span className="text-foreground">unclassified</span> store reads as{" "}
            <span className="text-foreground">unknown</span> — personal-data exposure cannot be ruled
            out, never &quot;no PII&quot;. No data value is shown, only what the graph evidences.
          </p>

          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.dataBearingComponents} data-bearing · {summary.personalDataComponents} personal ·{" "}
              {summary.unclassifiedComponents} unknown
            </span>
            {summary.crossingBoundary > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-sev-high">
                <ShieldAlert className="h-3.5 w-3.5" /> {summary.crossingBoundary} crossing boundary
              </span>
            )}
            {(summary.reachableByShadow > 0 || summary.reachableByOverBroad > 0) && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
                {summary.reachableByShadow} reachable-by-shadow · {summary.reachableByOverBroad} over-broad
              </span>
            )}
          </div>

          <div className="space-y-2.5">
            {data.stores.map((store) => (
              <div
                key={store.assetName}
                className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[12px] font-semibold text-foreground">{store.assetName}</span>
                  <CapabilityRiskChip risk={store.risk} />
                  {store.personalData ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-sev-high/40 bg-sev-high/10 px-2 py-0.5 text-[9px] font-medium text-sev-high">
                      Personal data
                    </span>
                  ) : store.dataSensitivity === "unknown" ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[9px] font-medium text-amber-400"
                      title="Unclassified — personal-data exposure cannot be ruled out, never 'no PII'"
                    >
                      <ShieldQuestion className="h-3 w-3" /> Sensitivity unknown
                    </span>
                  ) : (
                    <span className="rounded-full border border-border/50 bg-surface-1/40 px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
                      {store.dataSensitivity}
                    </span>
                  )}
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {store.kindLabel}
                  </span>
                  <EvidenceClassChip value={store.evidenceClass} />
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {store.readerCount} principal{store.readerCount === 1 ? "" : "s"} can reach
                  </span>
                </div>

                {store.reachableBy.length > 0 && (
                  <ul className="mt-2 space-y-1 border-l border-border/40 pl-2.5">
                    {store.reachableBy.map((r, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
                        <span
                          className={cn(
                            "font-medium",
                            r.shadow || r.overBroad ? "text-sev-high" : "text-foreground/90",
                          )}
                        >
                          {r.principal}
                        </span>
                        <span className="text-muted-foreground/80">{r.principalKindLabel}</span>
                        <CapabilityRiskChip risk={r.risk} />
                        <ViaPath via={r.via} />
                      </li>
                    ))}
                  </ul>
                )}

                {store.gaps.length > 0 && (
                  <ul className="mt-2 space-y-1 border-l border-amber-500/30 pl-2.5">
                    {store.gaps.map((g, i) => (
                      <li key={i} className="text-[10px] leading-relaxed text-amber-400">
                        {g.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Data Lifecycle Review (Phase 3.5) for one deployment: each lifecycle stage, the
 * components that evidence it and at what strength, and the gaps where a stage has no
 * evidenced control. Self-fetching (mounted only inside an expanded deployment). An
 * unevidenced stage reads "not evidenced", never "compliant"; a weakly-evidenced
 * control is still a gap.
 */
export function DataLifecyclePanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<DataLifecycle>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/data-lifecycle`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Route className="h-4 w-4 text-primary" />
      <h4 className="text-[13px] font-semibold text-foreground">Data lifecycle</h4>
      <span className="text-[11px] text-muted-foreground">stages evidenced &amp; gaps</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the data-lifecycle view…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the data-lifecycle view{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const { summary } = data;

  return (
    <section>
      {heading}
      <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
        An <span className="text-foreground">unevidenced</span> stage reads &quot;not evidenced&quot;,
        never &quot;compliant&quot;; a control evidenced only weakly (vendor-asserted) is still a gap.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
          {/* "0/0 stages evidenced" read as a measurement -- we looked at every
              stage and none was evidenced -- when the backend had sent no
              summary at all. Those are different facts. */}
          {summary.evidenced === null || summary.stagesTotal === null
            ? "stage coverage not reported"
            : `${summary.evidenced}/${summary.stagesTotal} stages evidenced`}
        </span>
        {summary.controlGaps > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
            <HelpCircle className="h-3.5 w-3.5" /> {summary.controlGaps} control gap
            {summary.controlGaps === 1 ? "" : "s"}
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <span className="text-muted-foreground">worst:</span>
          <CapabilityRiskChip risk={summary.worstRisk} />
        </span>
      </div>

      <div className="space-y-1.5">
        {data.stages.map((st) => (
          <div key={st.stage} className="rounded-lg border border-border/40 bg-surface-0/40 p-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
              <span className="font-semibold text-foreground">{st.stageLabel}</span>
              {st.controlStage && (
                <span className="rounded border border-border/50 bg-surface-1/40 px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                  control
                </span>
              )}
              {st.evidenced ? (
                st.weakestEvidence ? (
                  <EvidenceClassChip value={st.weakestEvidence} />
                ) : null
              ) : (
                <span
                  className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[9px] font-medium text-amber-400"
                  title="No component evidences this stage — not evidenced, never 'compliant'"
                >
                  Not evidenced
                </span>
              )}
              {st.gap === true && <CapabilityRiskChip risk={st.risk} />}
              {/* An unreported gap is not a clean stage. `bool()` made the two
                  render identically; this says which one it is. */}
              {st.gap === null && (
                <span className="rounded-md border border-border/50 bg-surface-1/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  gap not reported
                </span>
              )}
            </div>
            {st.components.length > 0 && (
              <ul className="mt-1 flex flex-wrap gap-1">
                {st.components.map((c, i) => (
                  <li
                    key={i}
                    className="inline-flex items-center gap-1 rounded border border-border/50 bg-surface-1/40 px-1.5 py-0.5 text-[9px] text-muted-foreground"
                    title={c.how}
                  >
                    <span className="text-foreground/80">{c.name}</span>
                    <span className="text-muted-foreground/70">{c.kindLabel}</span>
                  </li>
                ))}
              </ul>
            )}
            {st.gap === true && st.gapDetail && (
              <p className="mt-1 text-[10px] leading-relaxed text-amber-400">{st.gapDetail}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** One reuse posture, worn honestly: reused / not reused / unknown, and whether the
 *  claim is independently verified (a vendor claim never upgrades to "verified"). */
function ReusePostureChip({ posture, verified }: { posture: string; verified: boolean }) {
  if (posture === "reused") {
    return (
      <span className="inline-flex items-center rounded-full border border-sev-high/40 bg-sev-high/10 px-2 py-0.5 text-[9px] font-medium text-sev-high">
        Reused{verified ? "" : " (asserted)"}
      </span>
    );
  }
  if (posture === "not_reused") {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-medium",
          verified
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            : "border-amber-500/40 bg-amber-500/10 text-amber-400",
        )}
        title={verified ? "Independently verified" : "The vendor's own word — not independently verified"}
      >
        Not reused{verified ? " (verified)" : " (asserted)"}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[9px] font-medium text-amber-400"
      title="No policy declared — reuse cannot be ruled out, never 'safe'"
    >
      Unknown
    </span>
  );
}

/**
 * Training / Reuse Review (Phase 3.5) for one deployment: per provider, whether
 * customer / internal data is reused for training, sharing or retention — verified vs
 * merely asserted — each posture at its true evidence class. Self-fetching (mounted
 * only inside an expanded deployment). A vendor_asserted "we don't train on your
 * data" reads as vendor-asserted, never verified; an unstated policy is a gap, never
 * "safe".
 */
function TrainingReusePanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<TrainingReuse>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/training-reuse`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <RefreshCw className="h-4 w-4 text-primary" />
      <h4 className="text-[13px] font-semibold text-foreground">Training &amp; reuse</h4>
      <span className="text-[11px] text-muted-foreground">verified vs asserted</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the training/reuse view…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the training/reuse view{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const { summary } = data;

  return (
    <section>
      {heading}
      {data.providers.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No providers resolved for this deployment yet — nothing on record to assess.
        </p>
      ) : (
        <>
          <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
            A <span className="text-foreground">vendor-asserted</span> &quot;we don&apos;t train on your
            data&quot; reads as the vendor&apos;s own word, never verified. An unstated policy is a gap —
            reuse cannot be ruled out, never &quot;safe&quot;.
          </p>

          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.providers} provider{summary.providers === 1 ? "" : "s"} · {summary.reuseDeclared}{" "}
              reuse-declared
            </span>
            {summary.reusePossible > 0 && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
                {summary.reusePossible} where reuse cannot be ruled out
              </span>
            )}
            {summary.verifiedNoReuse > 0 && (
              <span className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-emerald-300">
                {summary.verifiedNoReuse} verified no-reuse
              </span>
            )}
          </div>

          <div className="space-y-2.5">
            {data.providers.map((p) => (
              <div key={p.providerUuid} className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[12px] font-semibold text-foreground">{p.providerName}</span>
                  <CapabilityRiskChip risk={p.risk} />
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {p.kindLabel}
                  </span>
                </div>
                <ul className="mt-2 space-y-1 border-l border-border/40 pl-2.5">
                  {p.postures.map((po) => (
                    <li key={po.field} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
                      <span className="font-medium text-foreground/90">{po.concern}</span>
                      <ReusePostureChip posture={po.posture} verified={po.verified} />
                      {po.value && <span className="text-muted-foreground">{po.value}</span>}
                      <EvidenceClassChip value={po.evidenceClass} />
                    </li>
                  ))}
                </ul>
                {p.gaps.length > 0 && (
                  <ul className="mt-2 space-y-1 border-l border-amber-500/30 pl-2.5">
                    {p.gaps.map((g, i) => (
                      <li key={i} className="text-[10px] leading-relaxed text-amber-400">
                        {g.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Metadata & Logging Risk (Phase 3.5) for one deployment: the evidenced logging
 * sinks, the sensitive categories that could reach each, whether a leak-limiting
 * control is evidenced, and the gaps. Self-fetching (mounted only inside an expanded
 * deployment). No sensitive value is ever shown — only the presence of a category
 * and its lineage; an unknown reads unknown.
 */
function MetadataLoggingPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<MetadataLogging>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/metadata-logging`],
  });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Scale className="h-4 w-4 text-primary" />
      <h4 className="text-[13px] font-semibold text-foreground">Metadata &amp; logging</h4>
      <span className="text-[11px] text-muted-foreground">what lands in logs</span>
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the metadata/logging view…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the metadata/logging view{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  const { summary } = data;

  return (
    <section>
      {heading}
      <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
        Only logging the graph <span className="text-foreground">evidences</span> is flagged, and{" "}
        <span className="text-foreground">no sensitive value is shown</span> — only the presence of a
        category and its lineage. An unknown reads unknown.
      </p>

      {data.sensitiveCategoriesHandled.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Handled</span>
          {data.sensitiveCategoriesHandled.map((c) => (
            <span
              key={c.category}
              className="inline-flex items-center rounded-md border border-border/50 bg-surface-1/40 px-1.5 py-0.5 text-[10px] text-foreground/80"
              title={c.basis}
            >
              {c.label}
            </span>
          ))}
        </div>
      )}

      {data.sinks.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No logging sinks evidenced in the asset graph for this deployment.
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md border border-border/50 bg-surface-1/40 px-2 py-1 text-muted-foreground">
              {summary.sinks} sink{summary.sinks === 1 ? "" : "s"}
            </span>
            {summary.sinksWithoutControl > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-sev-high">
                <ShieldAlert className="h-3.5 w-3.5" /> {summary.sinksWithoutControl} without evidenced
                control
              </span>
            )}
            {summary.shadowSinks > 0 && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
                {summary.shadowSinks} shadow sink{summary.shadowSinks === 1 ? "" : "s"}
              </span>
            )}
          </div>

          <div className="space-y-2.5">
            {data.sinks.map((sink) => (
              <div key={sink.assetName} className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[12px] font-semibold text-foreground">{sink.assetName}</span>
                  <CapabilityRiskChip risk={sink.risk} />
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {sink.kindLabel}
                  </span>
                  {sink.controlEvidenced ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-medium text-emerald-300"
                      title={sink.controlDetail ?? undefined}
                    >
                      <ShieldCheck className="h-3 w-3" /> Control evidenced
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[9px] font-medium text-amber-400">
                      <ShieldQuestion className="h-3 w-3" /> No evidenced control
                    </span>
                  )}
                  <EvidenceClassChip value={sink.evidenceClass} />
                </div>
                {sink.sensitiveCategories.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <span className="text-[10px] text-muted-foreground">could reach:</span>
                    {sink.sensitiveCategories.map((c) => (
                      <span
                        key={c.category}
                        className="inline-flex items-center rounded border border-border/50 bg-surface-1/40 px-1.5 py-0.5 text-[9px] text-foreground/80"
                        title={c.basis}
                      >
                        {c.label}
                      </span>
                    ))}
                  </div>
                )}
                {sink.gaps.length > 0 && (
                  <ul className="mt-2 space-y-1 border-l border-amber-500/30 pl-2.5">
                    {sink.gaps.map((g, i) => (
                      <li key={i} className="text-[10px] leading-relaxed text-amber-400">
                        {g.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ============================================================================
// Continuous-assurance loop (SPINE Phases 1–3): the claims register, BOM drift +
// declared-architecture baseline, decision-support, revalidation, retest
// obligations, the invalidation engine, operational-risk, incident packs, and
// outbound connectors. Each panel is a self-fetching sibling, keyed by the same
// `/api/assurance/...` query-key convention, so opening the page never blocks on
// one slow call. Honest by construction: a null ratio/decision/risk renders "—"
// or "Not assessed", never a fabricated 0; an undeclared baseline reads as a gap,
// never a clean bill; a resolved obligation is a process claim, not a closure.
// ============================================================================

// ---- Assurance claims register (SPINE) ----

interface ClaimEvent {
  uuid: string;
  fromStatus: string | null;
  fromStatusLabel: string | null;
  toStatus: string;
  toStatusLabel: string;
  actor: string | null;
  note: string;
  createdAt: string | null;
}
interface Claim {
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
  confidence: number | null;
  vendorAsserted: boolean;
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

// Mirrors assurance/claims.py `_ALLOWED`; kept in lockstep so the console only
// ever offers a legal claim move. The machine-only targets (stale, superseded)
// are never offered. The backend still enforces the separate evidence gate on
// `verified` and returns a 400 the console surfaces as a toast.
const CLAIM_TRANSITIONS: Record<string, string[]> = {
  draft: ["supported", "partially_verified", "verified", "contradicted", "unknown", "revoked"],
  supported: ["verified", "partially_verified", "contradicted", "unknown", "revoked"],
  partially_verified: ["verified", "supported", "contradicted", "unknown", "revoked"],
  verified: ["supported", "partially_verified", "contradicted", "unknown", "revoked"],
  contradicted: ["supported", "partially_verified", "unknown", "revoked"],
  unknown: ["supported", "partially_verified", "verified", "contradicted", "revoked"],
  stale: ["supported", "partially_verified", "verified", "contradicted", "unknown", "revoked"],
};
const CLAIM_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  supported: "Supported",
  verified: "Verified",
  partially_verified: "Partially verified",
  contradicted: "Contradicted",
  unknown: "Unknown",
  stale: "Stale",
  superseded: "Superseded",
  revoked: "Revoked",
};

/**
 * A claim's strength is the backend's ordinal: 1.00 down to 0.10 by the weakest
 * class of evidence supporting the claim (athena-backend `claims._confidence`,
 * documented once in mythos-core `evidence`). It is not a probability, so it is
 * never printed as a percentage: "conf 52%" read as a 52% chance the claim is true.
 *
 * It is shown only for a claim whose status stands on supporting evidence. The
 * backend grades the machine's reading, and a status a person set keeps that
 * grade: a claim a person moved to contradicted or revoked still carries the
 * strength it had while supported, and one moved up from unknown carries none.
 * Printing that number beside such a status would say the opposite of the status.
 *
 * And it is a read of current evidence, so even under a supporting status it is
 * not shown once that evidence has expired (`isStale`: last observed longer ago
 * than the backend's evidence TTL), nor while a retest is due. A retest is due
 * while the claim has an open retest requirement: a change invalidated it, and a
 * person can move it back to supported before any retest (`CLAIM_TRANSITIONS.stale`).
 * The backend then holds the decision at NEEDS_MORE_EVIDENCE at best (`retest_pending`
 * in `claim_decision_signal`), while the claim still carries the strength it had
 * before the change.
 */
const SUPPORTING_STATUSES = new Set(["supported", "verified", "partially_verified"]);

// A retest is due: what STALE means, whether a system change, a declared condition
// coming true or expiry set it (assurance/invalidation.py), and what an open
// retest requirement means under any status.
const RETEST_DUE_BECAUSE = "a retest is due before this claim can be read as current";

// What each status means in athena-backend, true on every path that sets it --
// never a cause. A person can set contradicted or unknown over evidence that
// supports the claim, or over evidence that contradicts it, and a derived unknown
// can be partly known, so neither reason says anything about the evidence or
// about any other status.
const NO_STRENGTH_BECAUSE: Record<string, string> = {
  contradicted: "this claim is marked contradicted",
  unknown: "this claim is marked unknown",
  revoked: "this claim was withdrawn",
  stale: RETEST_DUE_BECAUSE,
  superseded: "a newer version of this claim replaces it",
  draft: "this claim has not been assessed",
};

// A status athena-backend does not have today. What it means is not known here,
// so the reason says only that.
const UNRECOGNISED_STATUS_BECAUSE = "this console does not recognise this claim's status";

// `isStale` on the backend (AssuranceClaim.is_stale): the claim's evidence was
// last observed longer ago than EVIDENCE_TTL_DAYS.
const EXPIRED_BECAUSE = "the evidence behind this claim has expired";

// The backend's scale: `claims._confidence` is round(max(0.1, 1.0 - 0.12 * rank), 2),
// so every strength it records is in [0.10, 1.00]. A number outside it is not one.
const STRENGTH_FLOOR = 0.1;
const STRENGTH_CEILING = 1;
const OFF_SCALE_BECAUSE = "the recorded value is not on the evidence-strength scale (0.10 to 1.00)";

const RETEST_UNREAD_BECAUSE = "whether a retest is due for this claim could not be read";

export const CLAIM_STRENGTH_BASIS =
  "Ordinal: read from the weakest class of evidence supporting the claim. Not a probability that the claim is true.";

/** A strength that waits only on the retest requirements, while they are being read. */
export const CLAIM_STRENGTH_READING =
  "No strength yet: whether a retest is due for this claim is still being read.";

/** What a claim's strength is read from. */
type ClaimStrengthInput = Pick<Claim, "status" | "confidence" | "isStale"> & {
  /**
   * Whether a retest is due for the claim, from the deployment's open retest
   * requirements: true or false once they are read; null when they could not be.
   */
  retestDue: boolean | null;
};

/**
 * The strength a claim is shown with, or the sentence that says why it has none.
 * Each check is the first thing that withholds the number, so a reason that does
 * not depend on the retest requirements never waits on them.
 */
function strengthOrReason({ status, confidence, isStale, retestDue }: ClaimStrengthInput): number | string {
  if (!SUPPORTING_STATUSES.has(status)) {
    const known = Object.hasOwn(NO_STRENGTH_BECAUSE, status);
    return `No strength: ${known ? NO_STRENGTH_BECAUSE[status] : UNRECOGNISED_STATUS_BECAUSE}.`;
  }
  if (isStale) return `No strength: ${EXPIRED_BECAUSE}.`;
  // NaN is not a number: nothing that is a strength was recorded.
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return "No strength recorded for this claim.";
  if (!(confidence >= STRENGTH_FLOOR && confidence <= STRENGTH_CEILING)) return `No strength: ${OFF_SCALE_BECAUSE}.`;
  if (retestDue === true) return `No strength: ${RETEST_DUE_BECAUSE}.`;
  if (retestDue === null) return `No strength: ${RETEST_UNREAD_BECAUSE}.`;
  return confidence;
}

export function claimStrength(claim: ClaimStrengthInput): string {
  const strength = strengthOrReason(claim);
  return typeof strength === "number" ? `strength ${strength.toFixed(2)}` : "strength —";
}

export function claimStrengthBasis(claim: ClaimStrengthInput): string {
  const strength = strengthOrReason(claim);
  return typeof strength === "number" ? CLAIM_STRENGTH_BASIS : strength;
}

/**
 * A claim row's strength and basis while the retest requirements are still being
 * read: a strength that waits only on them is not shown yet, and every other
 * claim already has its reason, which does not depend on them.
 */
function claimStrengthWhileReading(claim: Pick<Claim, "status" | "confidence" | "isStale">) {
  const settled = strengthOrReason({ ...claim, retestDue: false });
  return { value: "strength —", basis: typeof settled === "number" ? CLAIM_STRENGTH_READING : settled };
}

/**
 * Whether a retest is due for each claim, from the deployment's open retest
 * requirements (athena-backend `RetestRequirement` with `resolved_at` null: the
 * deployment's retest-requirements action returns only those by default, as one
 * list, and names the claim version each is about as `claimUuid`).
 *
 * A requirement names the claim VERSION that was current when it opened: the one
 * that drifted (`invalidation`), or whose declared condition came true
 * (`latent.evaluate_conditions`). The backend binds it to the claim's identity
 * across versions (`invalidation._has_open_requirement`,
 * `revalidation.plan_revalidation`). The requirement does not carry that identity,
 * so one naming a version this list does not hold leaves every claim of its type
 * unread (null), never "no retest due". So does a read that failed or did not
 * come back as a list. A claim an open requirement names is due (true) whatever
 * else is unread: that requirement alone says a retest is due.
 */
function retestDueByClaim(requirements: unknown, claims: Claim[]): (claim: Claim) => boolean | null {
  if (!Array.isArray(requirements)) return () => null;
  const listed = new Set(claims.map((c) => c.uuid));
  const due = new Set<string>();
  const unreadTypes = new Set<string>();
  let allUnread = false;
  for (const r of requirements as Partial<RetestRequirement>[]) {
    if (!r || typeof r !== "object") allUnread = true;
    else if (r.isOpen !== true) continue;
    else if (r.claimUuid && listed.has(r.claimUuid)) due.add(r.claimUuid);
    else if (r.claimType) unreadTypes.add(r.claimType);
    else allUnread = true;
  }
  return (c) => (due.has(c.uuid) ? true : allUnread || unreadTypes.has(c.claimType) ? null : false);
}

/** A claim's status, coloured by how it bears on assurance. A pass reads green
 *  only when actually supported/verified; contradicted is a mark against, and
 *  stale/unknown are honest gaps — never green-by-default. */
function ClaimStatusChip({ status, label }: { status: string; label?: string }) {
  const cls =
    status === "verified" || status === "supported"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
      : status === "partially_verified"
        ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
        : status === "contradicted"
          ? "border-sev-high/40 bg-sev-high/10 text-sev-high"
          : status === "stale" || status === "unknown"
            ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
            : "border-border/50 bg-surface-1/50 text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium", cls)}>
      {label || CLAIM_STATUS_LABEL[status] || status}
    </span>
  );
}

/** One claim's attributed event ledger, self-fetching when the claim is expanded. */
function ClaimEventLedger({ claimUuid }: { claimUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<ClaimEvent[]>({
    queryKey: [`/api/assurance/claims/${claimUuid}/events`],
  });
  if (isLoading) {
    return <p className="pl-3 text-[11px] text-muted-foreground">Loading the claim's lifecycle…</p>;
  }
  if (isError || !data) {
    return (
      <p className="pl-3 text-[11px] text-muted-foreground">
        Could not load the claim's lifecycle{error instanceof Error ? `: ${error.message}` : "."}
      </p>
    );
  }
  if (data.length === 0) {
    return <p className="pl-3 text-[11px] text-muted-foreground">No lifecycle events recorded yet.</p>;
  }
  return (
    <ul className="mt-1.5 space-y-1 border-l border-border/40 pl-3">
      {data.map((e) => (
        <li key={e.uuid} className="text-[11px] text-muted-foreground">
          <span className="text-foreground">
            {e.fromStatusLabel ? `${e.fromStatusLabel} → ` : ""}
            {e.toStatusLabel}
          </span>
          <span className="ml-1">· {e.actor ?? "machine"}</span>
          {e.note && <span className="ml-1 text-muted-foreground/80">— {e.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The assurance claims register (SPINE) for one deployment: the version-bound,
 * falsifiable claims derived from the assessments, each at its honest status and
 * weakest-evidence strength. A reader drills into a claim's attributed event
 * ledger; an admin transitions a claim (the backend enforces the state machine
 * and the verified-evidence gate) or recomputes the whole register. Self-fetching.
 */
export function ClaimsPanel({ deploymentUuid, admin }: { deploymentUuid: string; admin: boolean }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [noteFor, setNoteFor] = useState<Record<string, string>>({});

  const {
    data,
    isLoading,
    isError,
    error,
    dataUpdatedAt: claimsReadAt,
    isFetching: claimsFetching,
  } = useQuery<Claim[]>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/assurance-claims`],
  });
  // The deployment's open retest requirements, read once for every claim: a
  // strength is not shown while a retest is due, or while that is not known. This
  // is the query the retest obligations panel makes when it lists open ones only
  // (its `{ all: undefined }` hashes as `{}`), so the page asks for them once.
  const retests = useQuery<RetestRequirement[]>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/retest-requirements`, {}],
  });
  const retestDue = retestDueByClaim(retests.isError ? undefined : retests.data, data ?? []);
  // Whether a retest is due is still being read while the requirements have never
  // been read, and while either they or the claims are being read again and the
  // read of it in hand is older than the other. A change cancels any read of the
  // two in flight and reads both again (`invalidateAssuranceComputed`), and either
  // can land first. The claims first: a claim a person moved back to supported
  // would otherwise stand beside requirements read before its retest opened. The
  // requirements first: a claim read while its retest was open would stand beside
  // requirements read after a recompute resolved it and replaced the claim. A read
  // that has landed, with none of either in flight, was asked after the last change
  // made here.
  const retestsReading =
    retests.isPending ||
    (retests.isFetching && retests.dataUpdatedAt < claimsReadAt) ||
    (claimsFetching && claimsReadAt < retests.dataUpdatedAt);

  const recompute = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/assurance/deployments/${deploymentUuid}/recompute-claims`, {})).json(),
    onSuccess: (counts: { created: number; updated: number; superseded: number; stale: number }) => {
      invalidateAssuranceComputed(deploymentUuid);
      toast({
        title: "Claims recomputed",
        description: `${counts.created} created · ${counts.updated} updated · ${counts.superseded} superseded · ${counts.stale} stale`,
      });
    },
    onError: (e: Error) =>
      toast({ title: "Could not recompute claims", description: e.message, variant: "destructive" }),
  });

  const transition = useMutation({
    mutationFn: async ({ uuid, toStatus, note }: { uuid: string; toStatus: string; note: string }) =>
      (
        await apiRequest("POST", `/api/assurance/claims/${uuid}/transition`, {
          toStatus,
          ...(note ? { note } : {}),
        })
      ).json(),
    onSuccess: () => {
      invalidateAssuranceComputed(deploymentUuid);
      toast({ title: "Claim transitioned" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not transition claim", description: e.message, variant: "destructive" }),
  });

  const toggle = (uuid: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <ReceiptText className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Assurance claims</h3>
      {admin && (
        <button
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary disabled:opacity-50"
          onClick={() => recompute.mutate()}
          disabled={recompute.isPending}
          title="Re-derive the claims from the deployment's current state"
        >
          <RefreshCw className={cn("h-3 w-3", recompute.isPending && "animate-spin")} />
          Recompute claims
        </button>
      )}
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the assurance claims…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the assurance claims{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  return (
    <section>
      {heading}
      {data.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No assurance claims derived yet. {admin ? "Recompute to derive them from the current state." : "An admin recompute derives them from the current state."}
        </p>
      ) : (
        <ul className="space-y-2">
          {data.map((c) => {
            const isOpen = expanded.has(c.uuid);
            // Own keys only: a status named like an object key ("constructor") has no moves.
            const nextStates = Object.hasOwn(CLAIM_TRANSITIONS, c.status) ? CLAIM_TRANSITIONS[c.status] : [];
            const strengthInput = { ...c, retestDue: retestDue(c) };
            const { value: strength, basis: strengthBasis } = retestsReading
              ? claimStrengthWhileReading(c)
              : { value: claimStrength(strengthInput), basis: claimStrengthBasis(strengthInput) };
            return (
              <li key={c.uuid} className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <button
                    className="inline-flex items-center gap-1 text-left"
                    onClick={() => toggle(c.uuid)}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    <span className="text-[12px] font-semibold text-foreground">{c.claimTypeLabel}</span>
                  </button>
                  <ClaimStatusChip status={c.status} label={c.statusLabel} />
                  <EvidenceClassChip value={c.evidenceClass} />
                  {c.vendorAsserted && (
                    <span className="text-[10px] text-amber-400/90">vendor-asserted</span>
                  )}
                  {c.isStale && <span className="text-[10px] text-amber-400/90">stale</span>}
                  <span
                    className="text-[10px] text-muted-foreground"
                    title={strengthBasis}
                    data-testid="text-claim-strength"
                  >
                    <span data-testid="text-claim-strength-value">{strength}</span>
                    <span className="sr-only" data-testid="text-claim-strength-sr">
                      {` (${strengthBasis})`}
                    </span>
                  </span>
                  {c.assetName && <span className="text-[10px] text-muted-foreground">· {c.assetName}</span>}
                  {c.receiptDigest && (
                    <span
                      className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground"
                      title={c.receiptDigest}
                    >
                      <Fingerprint className="h-3 w-3" />
                      {c.receiptDigest.slice(0, 12)}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{c.statement}</p>
                {c.contradictingSummary && (
                  <p className="mt-1 text-[11px] text-sev-high">{c.contradictingSummary}</p>
                )}
                {isOpen && (
                  <div className="mt-2">
                    <p className="mb-1.5 text-[10px] text-muted-foreground" data-testid="text-claim-strength-basis">
                      {strengthBasis}
                    </p>
                    {c.invalidationConditions.length > 0 && (
                      <div className="mb-1.5 text-[10px] text-muted-foreground">
                        <span className="uppercase tracking-wide">Invalidated when</span>
                        <ul className="mt-0.5 list-disc pl-4">
                          {c.invalidationConditions.map((cond, i) => (
                            <li key={i}>{cond}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <ClaimEventLedger claimUuid={c.uuid} />
                    {admin && nextStates.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/30 pt-2">
                        <input
                          className={cn(fieldInput, "w-40")}
                          placeholder="Note (optional)"
                          value={noteFor[c.uuid] ?? ""}
                          onChange={(e) => setNoteFor((p) => ({ ...p, [c.uuid]: e.target.value }))}
                        />
                        <select
                          className={fieldInput}
                          value=""
                          disabled={transition.isPending}
                          aria-label="Move claim to"
                          onChange={(e) => {
                            if (e.target.value) {
                              transition.mutate({ uuid: c.uuid, toStatus: e.target.value, note: noteFor[c.uuid] ?? "" });
                            }
                          }}
                        >
                          <option value="" disabled>
                            Move to…
                          </option>
                          {nextStates.map((s) => (
                            <option key={s} value={s}>
                              {CLAIM_STATUS_LABEL[s] || s}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---- Decision support (SPINE Stage 1C) ----

interface ClaimBrief {
  uuid: string;
  claimType: string;
  status: string;
  statement: string;
}
interface DecisionSupport {
  decision: string | null;
  decisionLabel: string | null;
  fromFindings: string | null;
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

/**
 * A deployment's six-state decision WITH why (SPINE Stage 1C): the finding-based
 * signal, the claim cap, and exactly which current claims support or undermine
 * it. A READY decision is shown to stand only while its supporting claims stay
 * current; an unassessed deployment reads "Not assessed", never ready. Self-fetching.
 */
function DecisionSupportPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<DecisionSupport>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/decision-support`],
  });
  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Scale className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Decision support</h3>
    </div>
  );
  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the decision rationale…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the decision rationale{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }
  const bucket = (title: string, claims: ClaimBrief[], tone: string) =>
    claims.length === 0 ? null : (
      <div>
        <p className={cn("text-[10px] uppercase tracking-wide", tone)}>{title}</p>
        <ul className="mt-0.5 space-y-0.5">
          {claims.map((c) => (
            <li key={c.uuid} className="text-[11px] text-muted-foreground">
              <span className="text-foreground">{c.claimType}</span> — {c.statement}
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <section>
      {heading}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {data.decision ? (
          <DecisionPill decision={data.decision as never} label={data.decisionLabel || undefined} />
        ) : (
          <span className="inline-flex items-center rounded-full border border-border/50 bg-surface-1/50 px-2 py-0.5 text-[11px] text-muted-foreground">
            Not assessed
          </span>
        )}
        {data.paused && <span className="text-[11px] text-amber-400">operator failsafe paused</span>}
        <span className="text-[11px] text-muted-foreground">
          from findings: <span className="text-foreground">{data.fromFindings ?? "—"}</span>
        </span>
        <span className="text-[11px] text-muted-foreground">
          claim cap: <span className="text-foreground">{data.claimCap ?? "none"}</span>
        </span>
        {data.claims.retestPending && <span className="text-[11px] text-amber-400">retest pending</span>}
      </div>
      <p className="mb-2 text-[12px] leading-relaxed text-muted-foreground">{data.note}</p>
      <div className="space-y-2">
        {bucket("Contradicted (holds at needs remediation)", data.claims.contradicted, "text-sev-high")}
        {bucket("Stale", data.claims.stale, "text-amber-400")}
        {bucket("Unknown", data.claims.unknown, "text-amber-400")}
        {bucket("Supporting", data.claims.supporting, "text-emerald-400")}
        {!data.claims.hasClaims && (
          <p className="text-[11px] text-muted-foreground">
            No current assurance claims bear on this decision; the finding-based signal governs.
          </p>
        )}
      </div>
    </section>
  );
}

// ---- Revalidation plan (SPINE Stage 1D) ----

interface RevalidationWork {
  claimUuid: string;
  claimType: string;
  statement: string;
  status: string;
  reason: string;
  retestRequirementUuid: string | null;
  athenaReassessments: string[];
  achillesCapabilities: string[];
}
interface RevalidationPlan {
  deploymentUuid: string;
  systemFingerprint: string;
  summary: { required: number; stillCurrent: number; outstandingUnknowns: number };
  recomputeAction: string;
  required: RevalidationWork[];
  outstandingUnknowns: { claimUuid: string; claimType: string; statement: string; status: string }[];
  stillCurrent: { claimUuid: string; claimType: string; status: string }[];
  note: string;
}

/**
 * The minimal revalidation plan (SPINE Stage 1D): for each claim a change
 * invalidated, expired, or contradicted, the exact Athena reassessment and
 * Achilles capability areas to re-run — and everything that stays current and
 * need not be re-run. This is "what must re-run because of this change", not "run
 * it all again". Self-fetching.
 */
function RevalidationPlanPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<RevalidationPlan>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/revalidation-plan`],
  });
  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Waypoints className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Revalidation plan</h3>
    </div>
  );
  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the revalidation plan…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the revalidation plan{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }
  return (
    <section>
      {heading}
      <div className="mb-2 flex flex-wrap gap-2 text-[11px]">
        <span className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
          {data.summary.required} need revalidation
        </span>
        <span className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-emerald-400">
          {data.summary.stillCurrent} still current
        </span>
        <span className="rounded-md border border-border/40 bg-surface-1/40 px-2 py-1 text-muted-foreground">
          {data.summary.outstandingUnknowns} outstanding unknowns
        </span>
      </div>
      <p className="mb-2 text-[12px] leading-relaxed text-muted-foreground">{data.note}</p>
      {data.required.length > 0 && (
        <ul className="space-y-2">
          {data.required.map((w) => (
            <li key={w.claimUuid} className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-semibold text-foreground">{w.claimType}</span>
                <ClaimStatusChip status={w.status} />
                <span className="text-[10px] text-muted-foreground">{w.reason}</span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{w.statement}</p>
              {(w.athenaReassessments.length > 0 || w.achillesCapabilities.length > 0) && (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                  {w.athenaReassessments.length > 0 && (
                    <span>Athena: <span className="text-foreground">{w.athenaReassessments.join(", ")}</span></span>
                  )}
                  {w.achillesCapabilities.length > 0 && (
                    <span>Achilles: <span className="text-foreground">{w.achillesCapabilities.join(", ")}</span></span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- Retest obligations (SPINE Phase 2) ----

interface RetestRequirement {
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
}

/**
 * The deployment's retest obligations (SPINE Phase 2): the durable, attributed
 * duties to re-test a claim whose bound system state changed. Open by default;
 * a resolved obligation is a process fact, not a security closure. Self-fetching.
 */
function RetestRequirementsPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, isError, error } = useQuery<RetestRequirement[]>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/retest-requirements`, { all: showAll ? "true" : undefined }],
  });
  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Clock className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Retest obligations</h3>
      <button
        className="ml-auto text-[11px] text-muted-foreground hover:text-primary"
        onClick={() => setShowAll((v) => !v)}
      >
        {showAll ? "Open only" : "Include resolved"}
      </button>
    </div>
  );
  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the retest obligations…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the retest obligations{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }
  return (
    <section>
      {heading}
      {data.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          {showAll ? "No retest obligations recorded." : "No open retest obligations."}
        </p>
      ) : (
        <ul className="space-y-2">
          {data.map((r) => (
            <li key={r.uuid} className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-semibold text-foreground">{r.claimTypeLabel || r.claimType}</span>
                {r.isOpen ? (
                  <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400">
                    Open
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400">
                    Resolved
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground">{r.actor ? `by ${r.actor}` : "machine"}</span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{r.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- Invalidation engine (SPINE Phase 2) ----

/**
 * An admin control that runs the invalidation engine over the deployment and
 * shows what it changed (SPINE Phase 2). Idempotent — a re-run opens no duplicate
 * obligation. It reports counts; it does not, by itself, assert a system is fixed.
 */
export function InvalidationPanel({ deploymentUuid, admin }: { deploymentUuid: string; admin: boolean }) {
  const { toast } = useToast();
  const [last, setLast] = useState<{ invalidated: number; retestsOpened: number; retestsResolved: number } | null>(null);
  const check = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/assurance/deployments/${deploymentUuid}/check-invalidations`, {})).json(),
    onSuccess: (counts: { invalidated: number; retestsOpened: number; retestsResolved: number }) => {
      setLast(counts);
      invalidateAssuranceComputed(deploymentUuid);
      toast({ title: "Invalidation check complete" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not run the invalidation check", description: e.message, variant: "destructive" }),
  });
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <RefreshCw className="h-4 w-4 text-primary" />
        <h3 className="text-[13px] font-semibold text-foreground">Invalidation check</h3>
        {admin && (
          <button
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary disabled:opacity-50"
            onClick={() => check.mutate()}
            disabled={check.isPending}
          >
            <RefreshCw className={cn("h-3 w-3", check.isPending && "animate-spin")} />
            Run check
          </button>
        )}
      </div>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Re-derives which current claims a change has invalidated: it opens an attributed retest obligation for
        each drifted claim and moves it off a pass, and resolves any obligation a rebinding re-derivation has
        satisfied. {admin ? "" : "An admin runs it."}
      </p>
      {last && (
        <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
          <span className="rounded-md border border-sev-high/30 bg-sev-high/5 px-2 py-1 text-sev-high">
            {last.invalidated} invalidated
          </span>
          <span className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
            {last.retestsOpened} retests opened
          </span>
          <span className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-emerald-400">
            {last.retestsResolved} retests resolved
          </span>
        </div>
      )}
    </section>
  );
}

// ---- Operational-risk register (Phase 3.9) ----

interface OperationalRiskSignal {
  source: string;
  reference: string;
  detail: string;
  assetName?: string;
  providerName?: string;
  findingType?: string;
  title?: string;
  severity?: string;
}
interface OperationalRiskClass {
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
interface OperationalRisk {
  system: { name: string; uuid: string; environment: string; environmentLabel: string };
  classes: OperationalRiskClass[];
  summary: {
    totalClasses: number;
    observedClasses: number;
    unmappedClasses: number;
    high: number;
    elevated: number;
    moderate: number;
    worstRisk: string | null;
    unmapped: string[];
  };
  overall: { status: string; risk: string | null; unmappedClasses: number; note: string };
}

/** An operational-risk band, or "unmapped" when there is no basis — never a
 *  fabricated 0. */
function RiskBandChip({ risk }: { risk: string | null }) {
  if (risk === null) {
    return (
      <span className="inline-flex items-center rounded-full border border-border/50 bg-surface-1/50 px-2 py-0.5 text-[10px] text-muted-foreground">
        unmapped
      </span>
    );
  }
  const cls =
    risk === "high"
      ? "border-sev-high/40 bg-sev-high/10 text-sev-high"
      : risk === "elevated"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
        : "border-sky-500/40 bg-sky-500/10 text-sky-300";
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium", cls)}>
      {risk}
    </span>
  );
}

/**
 * The deployment's narrow operational-risk register (Phase 3.9): the four
 * operational-risk classes (retry-storm, denial-of-wallet, token-storm, provider-
 * outage), each an ordinal band with a real basis or honestly `unmapped` (risk
 * null, never a fabricated 0). Distinct from operational-ASSURANCE. Self-fetching.
 */
function OperationalRiskPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<OperationalRisk>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/operational-risk`],
  });
  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Zap className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Operational risk</h3>
    </div>
  );
  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the operational-risk register…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the operational-risk register{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }
  return (
    <section>
      {heading}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Overall:</span>
        <RiskBandChip risk={data.overall.risk} />
        <span className="text-[11px] text-muted-foreground">
          {data.summary.observedClasses}/{data.summary.totalClasses} observed · {data.summary.unmappedClasses} unmapped
        </span>
      </div>
      <p className="mb-2 text-[12px] leading-relaxed text-muted-foreground">{data.overall.note}</p>
      <ul className="space-y-2">
        {data.classes.map((c) => (
          <li key={c.key} className="rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-semibold text-foreground">{c.label}</span>
              <RiskBandChip risk={c.risk} />
              <span className="text-[10px] text-muted-foreground">{c.concernLabel}</span>
              {c.activeFindingCount > 0 && (
                <span className="text-[10px] text-sev-high">{c.activeFindingCount} active finding{c.activeFindingCount === 1 ? "" : "s"}</span>
              )}
            </div>
            {!c.observed ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Unmapped — no basis in the stored graph. {c.runtimeSignal}. Read as a gap, never a clean pass.
              </p>
            ) : (
              c.signals.length > 0 && (
                <ul className="mt-1 space-y-0.5 border-l border-border/40 pl-2.5">
                  {c.signals.map((s, i) => (
                    <li key={i} className="text-[11px] text-muted-foreground">
                      {s.detail}
                    </li>
                  ))}
                </ul>
              )
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- BOM drift + declared architecture (SPINE Stage 3) ----

interface BomDrift {
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
  undeclared: { assetUuid: string; kind: string; kindLabel: string; name: string; identifier: string; providerName: string | null; severity: string }[];
  undeclaredProviders: string[];
  missing: { declaredUuid: string; kind: string; kindLabel: string; name: string; identifier: string; providerName: string | null }[];
  note: string;
}
interface DeclaredComponent {
  uuid: string;
  kind: string;
  kindLabel: string;
  name: string;
  identifier: string;
  providerName: string;
  note: string;
}
interface DeclaredArchitecture {
  declared: DeclaredComponent[];
  drift: BomDrift;
}

const DECLARED_KINDS: { value: string; label: string }[] = [
  { value: "model", label: "Model" },
  { value: "agent", label: "Agent" },
  { value: "tool", label: "Tool" },
  { value: "api", label: "API" },
  { value: "gateway", label: "AI gateway" },
  { value: "vector_db", label: "Vector database" },
  { value: "service_account", label: "Service account" },
  { value: "data_store", label: "Data store" },
  { value: "mcp_server", label: "MCP server" },
  { value: "skill", label: "Agent skill" },
  { value: "other", label: "Other" },
];

function DriftBody({ drift }: { drift: BomDrift }) {
  if (!drift.hasDeclared) {
    return (
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        No declared architecture: drift cannot be computed. Declare the expected components to assess whether the
        observed BOM matches — an absent declaration is <span className="text-amber-400">not</span> a clean bill of
        materials.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 text-[11px]">
        <span className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-emerald-400">
          {drift.summary.matched} matched
        </span>
        <span className={cn("rounded-md border px-2 py-1", drift.summary.undeclared > 0 ? "border-sev-high/30 bg-sev-high/5 text-sev-high" : "border-border/40 bg-surface-1/40 text-muted-foreground")}>
          {drift.summary.undeclared} undeclared
        </span>
        <span className={cn("rounded-md border px-2 py-1", drift.summary.undeclaredProviders > 0 ? "border-sev-high/30 bg-sev-high/5 text-sev-high" : "border-border/40 bg-surface-1/40 text-muted-foreground")}>
          {drift.summary.undeclaredProviders} undeclared providers
        </span>
        <span className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400">
          {drift.summary.missing} declared-not-observed
        </span>
      </div>
      {drift.undeclared.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-sev-high">Undeclared (shadow) components</p>
          <ul className="mt-0.5 space-y-0.5">
            {drift.undeclared.map((c) => (
              <li key={c.assetUuid} className="text-[11px] text-muted-foreground">
                <span className="text-foreground">{c.name}</span> · {c.kindLabel} · {c.severity}
                {c.providerName ? ` · ${c.providerName}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {drift.undeclaredProviders.length > 0 && (
        <p className="text-[11px] text-sev-high">
          Undeclared providers: <span className="text-foreground">{drift.undeclaredProviders.join(", ")}</span>
        </p>
      )}
      {drift.missing.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-amber-400">Declared but not observed</p>
          <ul className="mt-0.5 space-y-0.5">
            {drift.missing.map((c) => (
              <li key={c.declaredUuid} className="text-[11px] text-muted-foreground">
                <span className="text-foreground">{c.name}</span> · {c.kindLabel}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{drift.note}</p>
    </div>
  );
}

/**
 * Declared-vs-observed AI-BOM drift (SPINE Stage 3), shown beside the AI-BOM. An
 * absent declaration reads as a gap, never a clean bill. An admin can record the
 * current drift as managed findings (idempotent, non-destructive). Self-fetching.
 */
/* ==== Coverage Manifest (Phase 2.1 + the check axis) ====================== */

/** One check the engine can run, and what became of it. */
interface CoverageCheckRow {
  check: string;
  team: string;
  state: string;
  reason: string | null;
  detail: string | null;
  probesAttempted: number | null;
  probesFailed: number | null;
}
interface CoverageChecks {
  /** False means no engine said. Distinct in BOTH directions from "all ran",
   *  which is why every count below is nullable. */
  reported: boolean;
  complete: boolean | null;
  total: number | null;
  performed: number | null;
  notPerformed: CoverageCheckRow[];
  degraded: CoverageCheckRow[];
  unmeasured: CoverageCheckRow[];
  limitations: Record<string, string[]>;
  notes: string[];
  reportedAt: string | null;
  summary: string;
}
interface CoverageEntityRow {
  kind: string;
  kindLabel: string;
  name: string;
  identifier: string;
}
interface CoverageManifest {
  expected: number;
  observed: number;
  assessed: number;
  verdict: string;
  complete: boolean;
  criticalGap: boolean;
  hasDeclaredBaseline: boolean;
  checks: CoverageChecks;
  neverObserved: CoverageEntityRow[];
  declaredButUnassessed: CoverageEntityRow[];
  highRiskUnassessed: CoverageEntityRow[];
  unassessed: CoverageEntityRow[];
  summary: string;
}

const COVERAGE_VERDICT: Record<string, { cls: string; label: string }> = {
  complete: { cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400", label: "Complete" },
  incomplete: { cls: "border-amber-500/40 bg-amber-500/10 text-amber-400", label: "Incomplete" },
  undeclared: { cls: "border-slate-500/40 bg-slate-500/10 text-slate-300", label: "Undeclared" },
};

/** Why a check did not run, in the reader's words rather than the enum's. */
const CHECK_REASON: Record<string, string> = {
  disabled: "switched off in configuration",
  failed: "the check errored",
  not_selected: "chaining did not select it",
  not_reached: "the scan ended first",
  interrupted: "the scan was stopped during it",
  precondition: "a precondition was not met",
};

function CheckRows({ rows, tone }: { rows: CoverageCheckRow[]; tone: string }) {
  return (
    <ul className="mt-1 space-y-1">
      {rows.map((row) => (
        <li key={row.check} className="text-[11px] leading-snug">
          <span className={cn("font-medium", tone)}>{row.check}</span>
          {row.reason && (
            <span className="text-muted-foreground"> — {CHECK_REASON[row.reason] ?? row.reason}</span>
          )}
          {row.probesAttempted !== null && row.probesFailed !== null && (
            <span className="text-muted-foreground">
              {" "}
              ({row.probesFailed} of {row.probesAttempted} probes lost)
            </span>
          )}
          {row.detail && <p className="text-muted-foreground">{row.detail}</p>}
        </li>
      ))}
    </ul>
  );
}

/**
 * What was assessed and what was not, on both axes.
 *
 * Breadth over the inventory (expected / observed / assessed) and depth over the
 * question set (which checks the latest scan actually ran). Neither implies the
 * other: an engine can assess every declared component while never running whole
 * checks against them, and the asset counts cannot show that.
 *
 * The one rendering rule that matters: when no engine reported its checks, this
 * says so in words and prints no counts. A zero or a "0/0" there would read as a
 * measurement, and nobody measured anything.
 */
function CoverageManifestPanel({ deploymentUuid }: { deploymentUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<CoverageManifest>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/coverage-manifest`],
  });
  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <ShieldQuestion className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Coverage — what was not checked</h3>
    </div>
  );
  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the coverage manifest…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the coverage manifest{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }
  const verdict = COVERAGE_VERDICT[data.verdict] ?? {
    cls: "border-slate-500/40 bg-slate-500/10 text-slate-300",
    label: data.verdict || "unknown",
  };
  const checks = data.checks;
  return (
    <section>
      {heading}
      <p className="text-[11px] text-muted-foreground">
        A findings list is only as good as the list of questions behind it. This is the second
        list: which components were assessed, and which checks actually ran.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            verdict.cls,
          )}
        >
          {verdict.label}
        </span>
        <span className="text-[11px] text-muted-foreground">
          Expected {data.expected} · Observed {data.observed} · Assessed {data.assessed}
        </span>
        {!data.hasDeclaredBaseline && (
          <span className="text-[11px] text-muted-foreground">
            (no declared architecture, so there is nothing to be short of on this axis)
          </span>
        )}
      </div>

      {/* The check axis. */}
      <div className="mt-3 rounded border border-border/60 p-2">
        {!checks.reported ? (
          // No counts here, deliberately. "0 of 0" would read as a measurement.
          <p className="text-[11px] text-amber-400">
            No engine reported which checks it ran. That is not the same as every check having
            run — this deployment has no coverage statement on the question set at all.
          </p>
        ) : (
          <>
            <p className="text-[11px]">
              <span
                className={cn(
                  "font-semibold",
                  checks.complete ? "text-emerald-400" : "text-amber-400",
                )}
              >
                {checks.performed} of {checks.total} checks performed
              </span>
              {checks.reportedAt && (
                <span className="text-muted-foreground"> · reported {checks.reportedAt}</span>
              )}
            </p>
            {checks.notPerformed.length > 0 && (
              <div className="mt-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                  Never ran
                </p>
                <CheckRows rows={checks.notPerformed} tone="text-amber-400" />
              </div>
            )}
            {checks.degraded.length > 0 && (
              <div className="mt-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                  Ran, lost probes
                </p>
                <CheckRows rows={checks.degraded} tone="text-amber-400" />
              </div>
            )}
            {checks.unmeasured.length > 0 && (
              <div className="mt-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Ran, cannot say what it looked at
                </p>
                <CheckRows rows={checks.unmeasured} tone="text-foreground" />
              </div>
            )}
            {Object.keys(checks.limitations).length > 0 && (
              <div className="mt-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Declared limits of checks that DID run
                </p>
                <ul className="mt-1 space-y-1">
                  {Object.entries(checks.limitations).map(([check, texts]) => (
                    <li key={check} className="text-[11px] leading-snug">
                      <span className="font-medium text-foreground">{check}</span>
                      {texts.map((text) => (
                        <p key={text} className="text-muted-foreground">
                          {text}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {checks.notes.length > 0 && (
              <ul className="mt-2 space-y-1">
                {checks.notes.map((note) => (
                  <li key={note} className="text-[11px] text-muted-foreground">
                    {note}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {data.criticalGap && (
        <p className="mt-2 text-[11px] text-amber-400">
          This gap holds the deployment decision at <span className="font-semibold">audit
          incomplete</span>: it cannot read ready while something was never looked at.
        </p>
      )}
    </section>
  );
}

function BomDriftPanel({ deploymentUuid, admin }: { deploymentUuid: string; admin: boolean }) {
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useQuery<BomDrift>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/bom-drift`],
  });
  const record = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/assurance/deployments/${deploymentUuid}/record-bom-drift`, {})).json(),
    onSuccess: (counts: { created: number; updated: number; reopened: number; resolved: number }) => {
      invalidateAssuranceComputed(deploymentUuid);
      toast({
        title: "BOM drift recorded",
        description: `${counts.created} created · ${counts.updated} updated · ${counts.reopened} reopened · ${counts.resolved} resolved`,
      });
    },
    onError: (e: Error) =>
      toast({ title: "Could not record BOM drift", description: e.message, variant: "destructive" }),
  });
  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <GitBranch className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">BOM drift</h3>
      {admin && (
        <button
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary disabled:opacity-50"
          onClick={() => record.mutate()}
          disabled={record.isPending}
          title="Record the current drift as managed findings"
        >
          <RefreshCw className={cn("h-3 w-3", record.isPending && "animate-spin")} />
          Record drift
        </button>
      )}
    </div>
  );
  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the BOM drift…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the BOM drift{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }
  return (
    <section>
      {heading}
      <DriftBody drift={data} />
    </section>
  );
}

/** A working row in the declared-architecture editor. */
interface DeclaredRow {
  kind: string;
  name: string;
  identifier: string;
  providerName: string;
  note: string;
}

/**
 * The admin-editable declared architecture (SPINE Stage 3): the baseline BOM
 * drift compares against. Mirrors the data-boundary GET+PUT editor. A PUT REPLACES
 * the whole declared set, so the editor loads the current declaration and submits
 * the full list. Self-fetching.
 */
function DeclaredArchitecturePanel({ deploymentUuid, admin }: { deploymentUuid: string; admin: boolean }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<DeclaredRow[]>([]);

  const { data, isLoading, isError, error } = useQuery<DeclaredArchitecture>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/declared-architecture`],
  });

  const save = useMutation({
    mutationFn: async (components: DeclaredRow[]) =>
      (
        await apiRequest("PUT", `/api/assurance/deployments/${deploymentUuid}/declared-architecture`, {
          components: components
            .filter((r) => r.name.trim())
            .map((r) => ({
              kind: r.kind,
              name: r.name.trim(),
              identifier: r.identifier.trim(),
              providerName: r.providerName.trim(),
              note: r.note.trim(),
            })),
        })
      ).json(),
    onSuccess: () => {
      invalidateAssuranceComputed(deploymentUuid);
      setEditing(false);
      toast({ title: "Declared architecture saved" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not save declared architecture", description: e.message, variant: "destructive" }),
  });

  const startEditing = () => {
    setRows(
      (data?.declared ?? []).map((c) => ({
        kind: c.kind || "other",
        name: c.name,
        identifier: c.identifier,
        providerName: c.providerName,
        note: c.note,
      })),
    );
    setEditing(true);
  };

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Wrench className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Declared architecture</h3>
      {admin && !editing && (
        <button
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
          onClick={startEditing}
        >
          <Pencil className="h-3 w-3" />
          {data && data.declared.length > 0 ? "Edit declaration" : "Declare architecture"}
        </button>
      )}
    </div>
  );

  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the declared architecture…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the declared architecture{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  return (
    <section>
      {heading}
      {editing ? (
        <div className="space-y-2 rounded-lg border border-primary/30 bg-surface-1/40 p-3">
          <p className="text-[11px] text-muted-foreground">
            The full declared set is replaced on save. Declaring an architecture is a separate axis from what is
            running — it does not move the system fingerprint.
          </p>
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select
                className={fieldInput}
                value={r.kind}
                onChange={(e) => setRows((p) => p.map((row, j) => (j === i ? { ...row, kind: e.target.value } : row)))}
                aria-label="Component kind"
              >
                {DECLARED_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <input
                className={cn(fieldInput, "w-32")}
                placeholder="Name"
                value={r.name}
                onChange={(e) => setRows((p) => p.map((row, j) => (j === i ? { ...row, name: e.target.value } : row)))}
              />
              <input
                className={cn(fieldInput, "w-36")}
                placeholder="Identifier (optional)"
                value={r.identifier}
                onChange={(e) => setRows((p) => p.map((row, j) => (j === i ? { ...row, identifier: e.target.value } : row)))}
              />
              <input
                className={cn(fieldInput, "w-28")}
                placeholder="Provider (optional)"
                value={r.providerName}
                onChange={(e) => setRows((p) => p.map((row, j) => (j === i ? { ...row, providerName: e.target.value } : row)))}
              />
              <button
                className="text-muted-foreground hover:text-sev-high"
                aria-label="Remove component"
                onClick={() => setRows((p) => p.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
            onClick={() =>
              setRows((p) => [...p, { kind: "model", name: "", identifier: "", providerName: "", note: "" }])
            }
          >
            <Plus className="h-3 w-3" />
            Add component
          </button>
          <div className="flex items-center gap-2 pt-1">
            <button
              className="rounded-md bg-primary/20 px-3 py-1 text-[12px] font-medium text-primary hover:bg-primary/30 disabled:opacity-50"
              disabled={save.isPending}
              onClick={() => save.mutate(rows)}
            >
              {save.isPending ? "Saving…" : "Save declaration"}
            </button>
            <button className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : data.declared.length === 0 ? (
        <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
          No architecture declared. Until one is, BOM drift cannot be computed and the observed supply chain reads
          as an <span className="text-amber-400">unassessed gap</span>, never a clean bill.
        </p>
      ) : (
        <ul className="mb-3 space-y-1">
          {data.declared.map((c) => (
            <li key={c.uuid} className="text-[12px] text-muted-foreground">
              <span className="text-foreground">{c.name}</span> · {c.kindLabel}
              {c.providerName ? ` · ${c.providerName}` : ""}
              {c.identifier ? <span className="ml-1 font-mono text-[10px]">{c.identifier}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- Outbound connectors (commercial spine) ----

interface ConnectorRef {
  name: string;
  configured: boolean;
}
interface ConnectorsView {
  connectors: ConnectorRef[];
}

/**
 * The deployment's outbound connectors and whether each is configured (commercial
 * spine). A connector with no credentials reads as not configured, never as live.
 * An admin can push one of the deployment's findings out to a connector; an inert
 * connector reports not-configured and makes no network call. Self-fetching.
 */
function ConnectorsPanel({
  deploymentUuid,
  admin,
  findings,
}: {
  deploymentUuid: string;
  admin: boolean;
  findings: Finding[];
}) {
  const { toast } = useToast();
  const [findingUuid, setFindingUuid] = useState("");
  const { data, isLoading, isError, error } = useQuery<ConnectorsView>({
    queryKey: [`/api/assurance/deployments/${deploymentUuid}/connectors`],
  });
  const push = useMutation({
    mutationFn: async ({ connector, finding }: { connector: string; finding: string }) =>
      (
        await apiRequest("POST", `/api/assurance/deployments/${deploymentUuid}/connectors/${connector}/push`, {
          finding,
        })
      ).json(),
    onSuccess: (result: { ok: boolean; detail: string; externalRef: string | null }) => {
      toast({
        title: result.ok ? "Pushed to connector" : "Connector did not accept",
        description: result.ok ? (result.externalRef ? `Reference: ${result.externalRef}` : undefined) : result.detail,
        variant: result.ok ? undefined : "destructive",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Could not push to connector", description: e.message, variant: "destructive" }),
  });
  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <Send className="h-4 w-4 text-primary" />
      <h3 className="text-[13px] font-semibold text-foreground">Outbound connectors</h3>
    </div>
  );
  if (isLoading) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">Loading the connectors…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section>
        {heading}
        <p className="text-[12px] text-muted-foreground">
          Could not load the connectors{error instanceof Error ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }
  return (
    <section>
      {heading}
      <p className="mb-2 text-[12px] leading-relaxed text-muted-foreground">
        The integrations this deployment can push evidence to. A connector with no credentials configured is inert —
        it reads as not configured, never as a live integration, and a push against it makes no network call.
      </p>
      <ul className="space-y-1.5">
        {data.connectors.map((c) => (
          <li key={c.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/40 bg-surface-0/40 p-2.5">
            <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[12px] font-semibold text-foreground">{c.name}</span>
            {c.configured ? (
              <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400">
                configured
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-border/50 bg-surface-1/50 px-2 py-0.5 text-[10px] text-muted-foreground">
                not configured
              </span>
            )}
            {admin && (
              <button
                className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary disabled:opacity-50"
                onClick={() => {
                  if (!findingUuid) {
                    toast({ title: "Pick a finding to push", variant: "destructive" });
                    return;
                  }
                  push.mutate({ connector: c.name, finding: findingUuid });
                }}
                disabled={push.isPending}
              >
                <Send className="h-3 w-3" />
                Push finding
              </button>
            )}
          </li>
        ))}
      </ul>
      {admin && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Finding to push:</span>
          <select
            className={cn(fieldInput, "max-w-[18rem]")}
            value={findingUuid}
            onChange={(e) => setFindingUuid(e.target.value)}
            aria-label="Finding to push to a connector"
          >
            <option value="">Select a finding…</option>
            {findings.map((f) => (
              <option key={f.uuid} value={f.uuid}>
                {f.title.length > 60 ? `${f.title.slice(0, 60)}…` : f.title}
              </option>
            ))}
          </select>
        </div>
      )}
    </section>
  );
}

// ---- Incident evidence pack (Phase 3.7) ----

interface IncidentPack {
  packVersion: string;
  attests: string;
  identity: {
    deployment: { name: string; uuid: string; environment: string; environmentLabel: string; owner: string | null };
    finding: {
      uuid: string;
      fingerprint: string;
      category: string;
      title: string;
      severity: string;
      severityLabel: string;
      status: string;
      statusLabel: string;
      statusMustNotImply: string | null;
    };
  };
  surface: {
    asset: { name: string; kindLabel: string; classificationLabel: string } | null;
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
  decision: { decision: string | null; decisionLabel: string | null };
  algorithm: string;
  digest: string;
  computedAt: string | null;
  /** As the backend reported it; absent or null when it said nothing. */
  signed?: boolean | null;
  unsignedReason?: string | null;
}

/**
 * A finding's AI Incident Evidence Pack (Phase 3.7), self-fetching when a reader
 * opens it from the finding. Its digests identify a recorded state; they show a
 * change only against an independently obtained or signature-covered copy, and
 * never that the conclusion is true or the system fixed. The runtime transcript
 * is an explicit gap, a null decision reads "Not assessed", and the download is
 * labelled as what it is: this view, re-serialized by the page.
 */
/** A timestamp rendered in the reader's locale, or an em dash when there is none
 *  or it cannot be parsed — never a fabricated or misleading date. */
function whenLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/**
 * The read side of the remediation workflow (Phase 2.3), self-fetching from
 * `/api/assurance/findings/:uuid/remediation` — the current state, who the work
 * is assigned to, and the full attributed audit trail of moves. Open to any
 * signed-in operator (a read), rendered on demand next to the transition/assign
 * controls. Honest by construction: a workflow `resolved` is labelled as the
 * ticket being closed, never as the finding being securely fixed; a missing
 * actor or timestamp reads as a dash, never an invented value.
 */
function RemediationDetailView({ findingUuid }: { findingUuid: string }) {
  const { data, isLoading, isError, error } = useQuery<RemediationDetail>({
    queryKey: [`/api/assurance/findings/${findingUuid}/remediation`],
  });
  if (isLoading) {
    return <p className="mt-2 text-[11px] text-muted-foreground">Loading the remediation history…</p>;
  }
  if (isError || !data) {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground">
        Could not load the remediation history{error instanceof Error ? `: ${error.message}` : "."}
      </p>
    );
  }
  // Newest first, so the latest move is at the top of the trail.
  const events = data.events.slice().reverse();
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border/40 bg-surface-1/30 p-2.5 text-[11px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <History className="h-3.5 w-3.5 text-primary" />
        <span className="text-[11px] font-semibold text-foreground">Remediation workflow</span>
        <RemediationStateChip state={data.state} />
        <span className="inline-flex items-center gap-1">
          <User className="h-3 w-3" />
          {data.assignee ? data.assignee : "unassigned"}
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground/80">
        The human process of getting this finding fixed — not its security status.
      </p>
      {events.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No workflow history recorded yet.</p>
      ) : (
        <ol className="space-y-1.5">
          {events.map((ev, i) => (
            <li
              key={i}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border/30 pt-1.5 first:border-t-0 first:pt-0"
            >
              <span className="inline-flex items-center gap-1 text-foreground">
                {ev.fromState ? (
                  <>
                    {REMEDIATION_LABEL[ev.fromState] || ev.fromState}
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  </>
                ) : null}
                {REMEDIATION_LABEL[ev.toState] || ev.toState}
              </span>
              <span className="text-muted-foreground">· {ev.actor ? ev.actor : "system"}</span>
              <span className="text-muted-foreground/70">· {whenLabel(ev.createdAt)}</span>
              {ev.note && <span className="w-full text-muted-foreground/90">“{ev.note}”</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function IncidentPackView({ findingUuid }: { findingUuid: string }) {
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useQuery<IncidentPack>({
    queryKey: [`/api/assurance/findings/${findingUuid}/incident-pack`],
  });
  if (isLoading) {
    return <p className="mt-2 text-[11px] text-muted-foreground">Loading the incident pack…</p>;
  }
  if (isError || !data) {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground">
        Could not load the incident pack{error instanceof Error ? `: ${error.message}` : "."}
      </p>
    );
  }
  const download = () => {
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `incident-pack-${data.identity.finding.uuid}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Could not download the incident pack", variant: "destructive" });
    }
  };
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-border/40 bg-surface-1/30 p-2.5 text-[11px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-primary" />
        <span className="text-[11px] font-semibold text-foreground">Incident evidence pack</span>
        <span className="text-[10px] text-muted-foreground">{data.packVersion}</span>
        <button
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
          onClick={download}
          title="This page's copy of the pack, re-serialized as JSON: not the bytes the digests were computed over."
        >
          <Download className="h-3 w-3" />
          Download this view (JSON)
        </button>
      </div>
      {/* It used to say "Attests integrity and provenance ..." beside two
          unsigned digests. A bare digest attests nothing: whoever changes the
          content can recompute it. So the pack says what its digests can show,
          and whether a signature came with it, as the receipt panel does. */}
      <p className="text-[10px] text-muted-foreground/80" data-testid="incident-pack-digest-meaning">
        The digests below identify a recorded state of this pack. They show a change only against a
        copy obtained independently, or one a verified signature covers; on their own they attest
        nothing, and never that the conclusion is true.
      </p>
      <p className="text-[10px] text-muted-foreground/80" data-testid="incident-pack-signature">
        {data.signed === true ? (
          <>
            <span className="text-foreground">Reported signed.</span> The backend reports this pack as
            signed. This page neither shows nor verifies the signature; verify it offline before relying on it.
          </>
        ) : data.signed === false ? (
          <>
            <span className="text-foreground">Unsigned.</span> The backend reports that this pack carries no
            signature.{data.unsignedReason ? ` Backend's reason: ${data.unsignedReason}` : ""}
          </>
        ) : (
          <>No signature came with this pack, and the backend did not say whether it is signed.</>
        )}
      </p>
      {/* The finding's disposition, on the pack itself. A pack headed "Incident
          evidence pack" that shows no disposition reads as a confirmed incident
          whatever the finding's actual state -- which for an INVALIDATED finding
          is exactly the reading that state exists to prevent. */}
      <div className="flex flex-wrap items-center gap-2">
        <DispositionChip
          status={data.identity.finding.status}
          label={data.identity.finding.statusLabel}
          mustNotImply={data.identity.finding.statusMustNotImply}
        />
      </div>
      <DispositionCaveat text={data.identity.finding.statusMustNotImply} />
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        <span>Category: <span className="text-foreground">{data.identity.finding.category}</span></span>
        <span>Evidence: <span className="text-foreground">{data.evidence.evidenceClass || "—"}</span> ({data.evidence.count})</span>
        <span>
          Decision:{" "}
          <span className="text-foreground">{data.decision.decisionLabel ?? data.decision.decision ?? "Not assessed"}</span>
        </span>
      </div>
      {data.surface.asset && (
        <p>
          Surface: <span className="text-foreground">{data.surface.asset.name}</span> · {data.surface.asset.kindLabel}
          {data.surface.location ? ` · ${data.surface.location}` : ""}
        </p>
      )}
      <p className="text-amber-400/90">
        Runtime transcript: not in the assurance record ({data.runtimeTranscript.reason}) — an explicit gap, never
        fabricated. Engine pack {data.runtimeTranscript.enginePackRef.available ? "available for replay" : "not linked"}.
      </p>
      {data.receipt.digest && (
        <p className="font-mono text-[10px]" title={data.receipt.digest}>
          receipt {data.receipt.algorithm}: {data.receipt.digest.slice(0, 24)}…
        </p>
      )}
      <p className="font-mono text-[10px]" title={data.digest}>
        pack {data.algorithm}: {data.digest.slice(0, 24)}…
      </p>
    </div>
  );
}

export default function Assurance({ admin = false }: { admin?: boolean }) {
  const { toast } = useToast();
  const [view, setView] = useState<ViewMode>("graph");
  // List view: the deployment a reader has narrowed the flat tables to.
  const [selected, setSelected] = useState<string | "">("");
  // Graph view: which deployments a reader has collapsed. Each deployment's
  // heavy panels (route map, AI-BOM, capabilities, data boundary) self-fetch
  // only while its card is expanded, so we start every deployment collapsed
  // except the first (attention-first) one — otherwise opening the page fires
  // four computed-assessment requests for *every* deployment at once. Seeded
  // once, when the deployment list first loads (see the effect below).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const collapseSeeded = useRef(false);

  // Polled. React Query keeps the last answer after a poll fails, and read
  // raw that answer went on drawing the control plane as reachable -- the
  // registries and every control under "Could not check the control plane".
  // Read through loaded(), the failed check wins: nothing is drawn from a
  // reachability this page could not confirm.
  const status$ = loaded(useQuery<AssuranceStatus>({
    queryKey: ["/api/assurance/status"],
    refetchInterval: 30_000,
  }));
  const status = status$.state === "ready" ? status$.data : undefined;
  const statusLoading = status$.state === "loading";
  const statusError = status$.state === "error";
  const reachable = status?.configured === true && status?.reachable === true && status?.authorized === true;

  // Everything is fetched whole and grouped in the browser: the graph needs each
  // deployment's children, and grouping client-side means one fetch each rather
  // than a request per deployment. The BFF follows DRF pagination, so these are
  // complete.
  const deploymentsQ = useQuery<Deployment[]>({
    queryKey: ["/api/assurance/deployments"],
    enabled: reachable,
  });
  const findingsQ = useQuery<Finding[]>({
    queryKey: ["/api/assurance/findings"],
    enabled: reachable,
  });
  const unknownsQ = useQuery<Unknown[]>({
    queryKey: ["/api/assurance/unknowns"],
    enabled: reachable,
  });
  const assetsQ = useQuery<Asset[]>({
    queryKey: ["/api/assurance/assets"],
    enabled: reachable,
  });
  const providersQ = useQuery<Provider[]>({
    queryKey: ["/api/assurance/providers"],
    enabled: reachable,
  });
  const deployments = deploymentsQ.data ?? [];
  const findings = findingsQ.data ?? [];
  const unknowns = unknownsQ.data ?? [];
  const assets = assetsQ.data ?? [];
  const providers = providersQ.data ?? [];
  // Every registry, or none. A deployment drawn after its findings or gaps
  // failed to load would show "0 findings" and no open gaps -- a failed read
  // rendered as a clean record. So one failure replaces the views with the
  // reason, and nothing is drawn until all five are in hand.
  const registries = [
    ["deployments", deploymentsQ],
    ["findings", findingsQ],
    ["unknowns", unknownsQ],
    ["assets", assetsQ],
    ["providers", providersQ],
  ] as const;
  const registryFailure = registries.find(([, q]) => q.isError);
  const registriesLoading = registries.some(([, q]) => q.data === undefined);
  // Who a finding's remediation may be assigned to. Only an admin sees the
  // picker, so this is fetched only for an admin; the endpoint returns just an
  // id and username, and the assign write sends the username the backend knows.
  const { data: assignableUsers = [] } = useQuery<{ id: string; username: string }[]>({
    queryKey: ["/api/users/assignable"],
    enabled: reachable && admin,
  });

  const recompute = useMutation({
    mutationFn: async (uuid: string) =>
      // No `paused`: a recompute keeps whatever pause the backend holds now, not
      // the one this page last saw.
      (await apiRequest("POST", `/api/assurance/deployments/${uuid}/recompute`, {})).json(),
    onSuccess: (_data, uuid) => {
      // Recompute moves the decision AND rewrites the derived read-only panels
      // for this deployment (executive-summary, assurance-receipt, and the rest),
      // so refresh every computed key for it — not only the deployments list.
      invalidateAssuranceComputed(uuid);
      toast({ title: "Decision recomputed" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not recompute", description: error.message, variant: "destructive" }),
  });

  const setDisposition = useMutation({
    mutationFn: async ({ uuid, status: next }: { uuid: string; status: string }) =>
      (await apiRequest("PATCH", `/api/assurance/unknowns/${uuid}`, { status: next })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/assurance/unknowns"] });
      toast({ title: "Unknown updated" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not update", description: error.message, variant: "destructive" }),
  });

  const onDisposition = (uuid: string, next: string) => setDisposition.mutate({ uuid, status: next });
  const dispositionPending = (uuid: string) =>
    setDisposition.isPending && setDisposition.variables?.uuid === uuid;

  // ---- Remediation workflow (Phase 2.3; admin-only; the control plane is the
  // gate). A workflow move never changes the finding's security status or the
  // deployment's decision, but it does change the finding record and the
  // executive-summary / operational roll-ups derived over it, so on success we
  // refresh the findings query and every deployment's computed panels (a move is
  // not scoped to one deployment on the client). A backend 400 (illegal
  // transition, unknown user) reaches the operator as a toast.
  const invalidateRemediation = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/assurance/findings"] });
    invalidateAssuranceComputed();
  };

  const transitionRemediation = useMutation({
    mutationFn: async ({ uuid, toState }: { uuid: string; toState: string }) =>
      (
        await apiRequest("POST", `/api/assurance/findings/${uuid}/remediation/transition`, { toState })
      ).json(),
    onSuccess: () => {
      invalidateRemediation();
      toast({ title: "Remediation updated" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not move remediation", description: error.message, variant: "destructive" }),
  });

  const assignRemediation = useMutation({
    mutationFn: async ({ uuid, assignee }: { uuid: string; assignee: string | null }) =>
      (
        await apiRequest("POST", `/api/assurance/findings/${uuid}/remediation/assign`, { assignee })
      ).json(),
    onSuccess: () => {
      invalidateRemediation();
      toast({ title: "Assignee updated" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not assign", description: error.message, variant: "destructive" }),
  });

  const remediationControls: RemediationControls = {
    admin,
    assignableUsers,
    onTransition: (uuid, toState) => transitionRemediation.mutate({ uuid, toState }),
    onAssign: (uuid, assignee) => assignRemediation.mutate({ uuid, assignee }),
    transitionPending: (uuid) =>
      transitionRemediation.isPending && transitionRemediation.variables?.uuid === uuid,
    assignPending: (uuid) => assignRemediation.isPending && assignRemediation.variables?.uuid === uuid,
  };

  // ---- Provider profile editing (admin-only; the control plane is the gate) ----

  // A provider fact feeds every per-deployment computed assessment (data
  // boundary, capabilities, route map, AI-BOM, vendor-assurance, training-reuse,
  // the executive-summary vendor roll-up, and more), so editing one must refresh
  // those panels too — not only the providers list. A fact is not scoped to one
  // deployment on the client (any deployment using the provider is affected), so
  // refresh every deployment's computed panels.
  const invalidateProviders = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/assurance/providers"] });
    invalidateAssuranceComputed();
  };

  const createProvider = useMutation({
    mutationFn: async (input: { name: string; kind: string }) =>
      (await apiRequest("POST", "/api/assurance/providers", input)).json(),
    onSuccess: () => {
      invalidateProviders();
      toast({ title: "Provider added" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not add provider", description: error.message, variant: "destructive" }),
  });

  const updateProvider = useMutation({
    mutationFn: async ({ uuid, patch }: { uuid: string; patch: { name: string; kind: string } }) =>
      (await apiRequest("PATCH", `/api/assurance/providers/${uuid}`, patch)).json(),
    onSuccess: () => {
      invalidateProviders();
      toast({ title: "Provider updated" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not update provider", description: error.message, variant: "destructive" }),
  });

  const createAssertion = useMutation({
    mutationFn: async (input: {
      provider: string;
      field: string;
      value: string;
      evidenceClass: string;
      source: string;
    }) => (await apiRequest("POST", "/api/assurance/provider-assertions", input)).json(),
    onSuccess: () => {
      invalidateProviders();
      toast({ title: "Fact recorded" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not record fact", description: error.message, variant: "destructive" }),
  });

  const updateAssertion = useMutation({
    mutationFn: async ({
      uuid,
      patch,
    }: {
      uuid: string;
      patch: { value: string; evidenceClass: string; source: string };
    }) => (await apiRequest("PATCH", `/api/assurance/provider-assertions/${uuid}`, patch)).json(),
    onSuccess: () => {
      invalidateProviders();
      toast({ title: "Fact updated" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not update fact", description: error.message, variant: "destructive" }),
  });

  const deleteAssertion = useMutation({
    mutationFn: async (uuid: string) => {
      await apiRequest("DELETE", `/api/assurance/provider-assertions/${uuid}`);
    },
    onSuccess: () => {
      invalidateProviders();
      toast({ title: "Fact removed" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not remove fact", description: error.message, variant: "destructive" }),
  });

  const providerMutations: ProviderMutations = {
    createProvider: (v) => createProvider.mutateAsync(v),
    creatingProvider: createProvider.isPending,
    updateProvider: (uuid, patch) => updateProvider.mutateAsync({ uuid, patch }),
    updatingProviderUuid: updateProvider.isPending ? updateProvider.variables?.uuid ?? null : null,
    createAssertion: (v) => createAssertion.mutateAsync(v),
    creatingAssertion: createAssertion.isPending,
    updateAssertion: (uuid, patch) => updateAssertion.mutateAsync({ uuid, patch }),
    updatingAssertionUuid:
      updateAssertion.isPending ? updateAssertion.variables?.uuid ?? null : null,
    deleteAssertion: (uuid) => deleteAssertion.mutateAsync(uuid),
    deletingAssertionUuid: deleteAssertion.isPending ? deleteAssertion.variables ?? null : null,
  };

  // ---- Derivations shared by both views ----

  const providerByUuid = useMemo(() => {
    const m = new Map<string, Provider>();
    for (const p of providers) m.set(p.uuid, p);
    return m;
  }, [providers]);

  const findingsByDeployment = useMemo(() => groupBy(findings, (f) => f.deploymentUuid), [findings]);

  const assetsByDeployment = useMemo(() => {
    const m = groupBy(assets, (a) => a.deploymentUuid);
    // Attention-first within each deployment.
    m.forEach((list) =>
      list.sort((a, b) => {
        const byClass = assetRank(a.classification) - assetRank(b.classification);
        return byClass !== 0 ? byClass : a.name.localeCompare(b.name);
      }),
    );
    return m;
  }, [assets]);

  const unknownsByDeployment = useMemo(() => groupBy(unknowns, (u) => u.deploymentUuid), [unknowns]);

  const orderedDeployments = useMemo(
    () =>
      [...deployments].sort((a, b) => {
        const byDecision = decisionRank(a.decision) - decisionRank(b.decision);
        return byDecision !== 0 ? byDecision : a.name.localeCompare(b.name);
      }),
    [deployments],
  );

  // Seed the collapsed set once the deployments arrive: everything but the
  // first attention-first deployment starts collapsed, so only one card's
  // computed panels fetch on load. A reader expands the rest on demand; their
  // toggles are preserved because this runs a single time.
  useEffect(() => {
    if (collapseSeeded.current || orderedDeployments.length === 0) return;
    collapseSeeded.current = true;
    setCollapsed(new Set(orderedDeployments.slice(1).map((d) => d.uuid)));
  }, [orderedDeployments]);

  const toggleCollapsed = (uuid: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });

  // ---- List-view slices (client-side filter by the selected deployment) ----

  const listFindings = useMemo(
    () => (selected ? findings.filter((f) => f.deploymentUuid === selected) : findings),
    [findings, selected],
  );
  const listUnknowns = useMemo(
    () => (selected ? unknowns.filter((u) => u.deploymentUuid === selected) : unknowns),
    [unknowns, selected],
  );
  const listAssets = useMemo(() => {
    const slice = selected ? assets.filter((a) => a.deploymentUuid === selected) : assets;
    return [...slice].sort((a, b) => {
      const byClass = assetRank(a.classification) - assetRank(b.classification);
      return byClass !== 0 ? byClass : a.name.localeCompare(b.name);
    });
  }, [assets, selected]);
  const listOpenUnknowns = useMemo(() => listUnknowns.filter(isOpenUnknown), [listUnknowns]);

  const ViewToggle = (
    <div className="inline-flex overflow-hidden rounded-lg border border-border/60">
      {(
        [
          { key: "graph", label: "Graph", icon: GitBranch },
          { key: "list", label: "List", icon: LayoutList },
        ] as const
      ).map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          onClick={() => setView(key)}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium transition-colors",
            view === key
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-surface-1/50 hover:text-foreground",
          )}
          aria-pressed={view === key}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHero
        title="Assurance"
        subtitle="The system of record: decisions, evidence, and the gaps we have not closed."
        background="astrolabe"
        verbs={["Scan", "Analyze", "Evidence", "Deploy"]}
      />

      {/* Still checking: never a bare hero with no explanation. */}
      {statusLoading && !statusError && (
        <GlassCard bodyClassName="flex items-center gap-3">
          <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">Checking the control plane…</p>
        </GlassCard>
      )}

      {/* The status query itself failed (this server unreachable, not the backend). */}
      {statusError && (
        <GlassCard bodyClassName="flex items-start gap-3">
          <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-sev-high" />
          <div className="text-[13px] leading-relaxed">
            <p className="font-medium text-foreground">Could not check the control plane.</p>
            <p className="mt-1 text-muted-foreground">
              {status$.state === "error" ? status$.message : "The status request failed."}
            </p>
          </div>
        </GlassCard>
      )}

      {/* Control-plane honesty banner, accurate to why it is not reading. */}
      {status && !reachable && (
        <GlassCard bodyClassName="flex items-start gap-3">
          <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
          <div className="text-[13px] leading-relaxed">
            <p className="font-medium text-foreground">{bannerHeadline(status)}</p>
            <p className="mt-1 text-muted-foreground">{status.detail}</p>
          </div>
        </GlassCard>
      )}

      {reachable && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-[12px] text-muted-foreground">
              {view === "graph"
                ? "Each deployment, the assets it is built from, and the findings, gaps and providers attached to them."
                : "The flat registries: every deployment, asset, provider, finding and gap."}
            </p>
            {ViewToggle}
          </div>

          {registryFailure ? (
            <GlassCard>
              <p className="text-[13px] text-muted-foreground" data-testid="assurance-registry-failed">
                Could not load the {registryFailure[0]}:{" "}
                {registryFailure[1].error instanceof Error ? registryFailure[1].error.message : "request failed"}.
                Nothing is drawn below, since a deployment shown without its {registryFailure[0]} would look complete.
              </p>
            </GlassCard>
          ) : registriesLoading ? (
            <GlassCard>
              <p className="text-[13px] text-muted-foreground">Loading…</p>
            </GlassCard>
          ) : deployments.length === 0 ? (
            <GlassCard>
              <p className="text-[13px] text-muted-foreground">
                No deployments recorded yet. A completed scan populates the system of record.
              </p>
            </GlassCard>
          ) : view === "graph" ? (
            /* ===================== GRAPH VIEW ===================== */
            <div className="space-y-4">
              {orderedDeployments.map((d) => {
                const isCollapsed = collapsed.has(d.uuid);
                const depAssets = assetsByDeployment.get(d.uuid) ?? [];
                const depAssetUuids = new Set(depAssets.map((a) => a.uuid));
                const depFindings = findingsByDeployment.get(d.uuid) ?? [];
                const depUnknowns = unknownsByDeployment.get(d.uuid) ?? [];
                const depOpenUnknowns = depUnknowns.filter(isOpenUnknown);

                const findingsForAsset = (assetUuid: string) =>
                  depFindings.filter((f) => f.assetUuid === assetUuid);
                // A finding the graph could not hang off an asset (no attribution,
                // or its asset is not in this deployment's set) is shown plainly
                // rather than dropped — an unplaced finding is still a finding.
                const unattributed = depFindings.filter(
                  (f) => !f.assetUuid || !depAssetUuids.has(f.assetUuid),
                );

                // The providers this deployment depends on, distinct by their join
                // key (uuid when the backend supplies it, else the name).
                const providerRefs: { key: string; name: string; provider?: Provider }[] = [];
                const seenProviders = new Set<string>();
                for (const a of depAssets) {
                  if (!a.providerUuid && !a.providerName) continue;
                  const key = a.providerUuid ?? `name:${a.providerName}`;
                  if (seenProviders.has(key)) continue;
                  seenProviders.add(key);
                  providerRefs.push({
                    key,
                    name: a.providerName || "Provider",
                    provider: a.providerUuid ? providerByUuid.get(a.providerUuid) : undefined,
                  });
                }

                return (
                  <GlassCard key={d.uuid}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <button
                        className="inline-flex items-center gap-2 text-left"
                        onClick={() => toggleCollapsed(d.uuid)}
                        aria-expanded={!isCollapsed}
                      >
                        {isCollapsed ? (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="text-[15px] font-semibold text-foreground">{d.name}</span>
                      </button>
                      <span className="text-[12px] text-muted-foreground">{d.environment}</span>
                      <DecisionPill decision={d.decision as never} label={d.decisionLabel || undefined} />
                      <span className="text-[11px] text-muted-foreground">
                        {depAssets.length} {depAssets.length === 1 ? "asset" : "assets"} ·{" "}
                        {depFindings.length} {depFindings.length === 1 ? "finding" : "findings"} ·{" "}
                        {depOpenUnknowns.length} open{" "}
                        {depOpenUnknowns.length === 1 ? "gap" : "gaps"}
                      </span>
                      {/* Recompute mutates the decision → admin-only. Disabled
                          while the deployment is paused by the operator failsafe,
                          so a routine recompute never lifts a pause. */}
                      {admin && (
                        <button
                          className="ml-auto inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-primary disabled:opacity-50"
                          onClick={() => recompute.mutate(d.uuid)}
                          disabled={
                            d.decision === "paused" ||
                            (recompute.isPending && recompute.variables === d.uuid)
                          }
                          title={
                            d.decision === "paused"
                              ? "Deployment is paused by the operator failsafe — lift the pause before recomputing"
                              : "Recompute the decision from current findings"
                          }
                        >
                          <RefreshCw
                            className={cn(
                              "h-3.5 w-3.5",
                              recompute.isPending && recompute.variables === d.uuid && "animate-spin",
                            )}
                          />
                          Recompute
                        </button>
                      )}
                    </div>

                    {!isCollapsed && (
                      <div className="mt-4 space-y-5">
                        {/* Providers this deployment depends on. */}
                        {providerRefs.length > 0 && (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              Depends on
                            </span>
                            {providerRefs.map((r) => (
                              <ProviderRef key={r.key} name={r.name} provider={r.provider} />
                            ))}
                          </div>
                        )}

                        {/* System / route map (Phase 1.6): how data flows through
                            the deployment. Self-fetches, so it loads only for an
                            expanded deployment. */}
                        <RouteMapPanel deploymentUuid={d.uuid} />

                        {/* AI-BOM (Phase 1.7): the exportable supply-chain bill of
                            materials. Self-fetches, so it loads only for an
                            expanded deployment. */}
                        <AiBomPanel deploymentUuid={d.uuid} />

                        {/* Declared architecture + BOM drift (SPINE Stage 3): the
                            admin-declared baseline and where the observed supply
                            chain diverges from it. Placed beside the AI-BOM they
                            compare against; an absent declaration reads as a gap,
                            never a clean bill. Self-fetch. */}
                        <DeclaredArchitecturePanel deploymentUuid={d.uuid} admin={admin} />
                        <BomDriftPanel deploymentUuid={d.uuid} admin={admin} />

                        {/* Coverage manifest: what was assessed and what was not,
                            on both axes. Placed beside BOM drift because both
                            answer "what is missing from this picture" — drift on
                            the inventory, this on the inventory AND the question
                            set. An unreported check axis says so in words and
                            prints no counts. Self-fetch. */}
                        <CoverageManifestPanel deploymentUuid={d.uuid} />

                        {/* AI system capability map (Phase 1.3): what this
                            deployment can do. Self-fetches, so it loads only for
                            an expanded deployment. */}
                        <CapabilityPanel deploymentUuid={d.uuid} />

                        {/* AI data boundary (Phase 1.4): approved data flows vs.
                            actual ones. Self-fetches, so it loads only for an
                            expanded deployment. */}
                        <DataBoundaryPanel deploymentUuid={d.uuid} admin={admin} />

                        {/* Compliance map (Phase 2.1): an honest gap map of this
                            deployment's findings against the frameworks. Self-
                            fetches, so it loads only for an expanded deployment. */}
                        <CompliancePanel deploymentUuid={d.uuid} />

                        {/* Business-impact map (Phase 2.4): the impact dimensions
                            this deployment's active findings implicate — inferred
                            potential exposure, never a realized loss. Self-fetches,
                            so it loads only for an expanded deployment. */}
                        <BusinessImpactPanel deploymentUuid={d.uuid} />

                        {/* Executive summary (commercial spine): the assurance
                            graph rolled up for a leadership reader — coverage,
                            evidence, findings, remediation, decision, posture and
                            maturity. No dollar/ROI figure. Self-fetches, so it
                            loads only for an expanded deployment. */}
                        <ExecutiveSummaryPanel deploymentUuid={d.uuid} />

                        {/* Operational assurance (commercial spine): where the
                            deployment sits in the continuous-assurance loop —
                            evidence freshness, the change backlog needing
                            reassessment, remediation velocity, the decision, and an
                            ordinal readiness band (weakest-wins, never green-by-
                            default). Self-fetches, so it loads only for an expanded
                            deployment. */}
                        <OperationalAssurancePanel deploymentUuid={d.uuid} />

                        {/* ---- Continuous assurance (SPINE Phases 1–3) ----
                            The falsifiable claims register and how it caps the
                            six-state decision, the minimal revalidation plan a
                            change forces, the outstanding retest obligations, the
                            invalidation engine, and the narrow operational-risk
                            register. Honest by construction: an unassessed decision
                            reads "Not assessed", an unmapped risk class reads
                            "unmapped" (never a fabricated 0), and a resolved
                            obligation is a process fact, never a security closure.
                            Self-fetch, so they load only for an expanded deployment. */}
                        <div className="space-y-5">
                          <SectionHeading
                            icon={ReceiptText}
                            title="Continuous assurance"
                            blurb="The version-bound assurance claims, the decision they cap and why, the minimal revalidation a change forces, the outstanding retest obligations, the invalidation engine, and the narrow operational-risk register. A pass stands only while its claims stay current; an unassessed or unmapped state reads honestly, never green-by-default."
                          />
                          <ClaimsPanel deploymentUuid={d.uuid} admin={admin} />
                          <DecisionSupportPanel deploymentUuid={d.uuid} />
                          <RevalidationPlanPanel deploymentUuid={d.uuid} />
                          <RetestRequirementsPanel deploymentUuid={d.uuid} />
                          <InvalidationPanel deploymentUuid={d.uuid} admin={admin} />
                          <OperationalRiskPanel deploymentUuid={d.uuid} />
                        </div>

                        {/* Vendor assurance (commercial spine): the third-party
                            posture — each vendor's assertions at their true
                            evidence strength, gaps, and ungoverned dependencies.
                            Self-fetches, so it loads only for an expanded
                            deployment. */}
                        <VendorAssurancePanel deploymentUuid={d.uuid} />

                        {/* Vertical assurance packs (commercial spine): compliance
                            coverage read through an industry lens, with regulatory
                            regimes carried as context, never scored coverage. Self-
                            fetches, so it loads only for an expanded deployment. */}
                        <VerticalPacksPanel deploymentUuid={d.uuid} />

                        {/* Assurance receipt (spine): the full, versioned, signable
                            integrity/provenance record — system, policy, evidence
                            root, result, per-assessment digests. Self-fetches, so
                            it loads only for an expanded deployment. */}
                        <AssuranceReceiptPanel deploymentUuid={d.uuid} />

                        {/* ---- Access & Blast Radius (Phase 3.1 + 2.5) ----
                            Who can reach what, and — bounded and evidence-based —
                            how far a compromise could ripple. Self-fetch, so they
                            load only for an expanded deployment. */}
                        <div className="space-y-5">
                          <SectionHeading
                            icon={Fingerprint}
                            title="Access & blast radius"
                            blurb="The identities that can act and what each can effectively reach, then the bounded, evidence-based ripple a compromise could have. Powers, reach and gaps — never a claim of least privilege or safety."
                          />
                          <EffectiveAccessPanel deploymentUuid={d.uuid} />
                          <RippleEffectPanel deploymentUuid={d.uuid} />
                        </div>

                        {/* ---- Posture, credential-gated (Phase 3.2 / 3.3 / 3.4) ----
                            The three posture domains, honest about which are inert
                            for lack of credentials. Self-fetch. */}
                        <div className="space-y-5">
                          <SectionHeading
                            icon={ShieldQuestion}
                            title="Posture (credential-gated)"
                            blurb="Cloud, secrets and repository posture read through granted credentials. A domain with none configured is inert — it reads nothing, so it asserts nothing. Not connected is never 'all clear'."
                          />
                          <PosturePanel deploymentUuid={d.uuid} />
                        </div>

                        {/* ---- Data & Context (Phase 3.5) ----
                            Personal data, its lifecycle, training/reuse, and what
                            lands in logs — each honest per its own read. Self-fetch. */}
                        <div className="space-y-5">
                          <SectionHeading
                            icon={User}
                            title="Data & context"
                            blurb="Personal data and who can reach it, the lifecycle stages evidenced, training / reuse posture (verified vs asserted), and what sensitive data could land in logs. Unknown is never 'no PII'; unevidenced is never 'compliant'; no sensitive value is shown."
                          />
                          <PersonalContextPanel deploymentUuid={d.uuid} />
                          <DataLifecyclePanel deploymentUuid={d.uuid} />
                          <TrainingReusePanel deploymentUuid={d.uuid} />
                          <MetadataLoggingPanel deploymentUuid={d.uuid} />
                        </div>

                        {/* Outbound connectors (commercial spine): the integrations
                            this deployment can push evidence to, honest about which
                            are inert for lack of credentials. An admin pushes one of
                            the deployment's findings out. Self-fetch. */}
                        <ConnectorsPanel deploymentUuid={d.uuid} admin={admin} findings={depFindings} />

                        {/* Assets, each with the findings attributed to it. */}
                        <section>
                          <div className="mb-2 flex items-center gap-2">
                            <Network className="h-4 w-4 text-primary" />
                            <h3 className="text-[13px] font-semibold text-foreground">Assets</h3>
                          </div>
                          {depAssets.length === 0 ? (
                            <p className="text-[12px] text-muted-foreground">
                              No assets discovered for this deployment yet.
                            </p>
                          ) : (
                            <ul className="space-y-2.5">
                              {depAssets.map((a) => (
                                <AssetNode
                                  key={a.uuid}
                                  asset={a}
                                  findings={findingsForAsset(a.uuid)}
                                  remediation={remediationControls}
                                />
                              ))}
                            </ul>
                          )}
                        </section>

                        {/* Findings the graph could not place on an asset. */}
                        {unattributed.length > 0 && (
                          <section>
                            <h3 className="mb-2 text-[13px] font-semibold text-foreground">
                              Unattributed findings
                            </h3>
                            <ul className="space-y-2.5">
                              {unattributed.map((f) => (
                                <FindingRow key={f.uuid} f={f} remediation={remediationControls} />
                              ))}
                            </ul>
                          </section>
                        )}

                        {/* This deployment's Unknowns Register. */}
                        <section>
                          <div className="mb-2 flex items-center gap-2">
                            <HelpCircle className="h-4 w-4 text-amber-400" />
                            <h3 className="text-[13px] font-semibold text-foreground">Unknowns</h3>
                            <span className="text-[11px] text-muted-foreground">
                              {depOpenUnknowns.length} open
                            </span>
                          </div>
                          {depUnknowns.length === 0 ? (
                            <p className="text-[12px] text-muted-foreground">
                              No open gaps. Every finding here is verified or resolved.
                            </p>
                          ) : (
                            <ul className="space-y-2.5">
                              {depUnknowns.map((u) => (
                                <UnknownCard
                                  key={u.uuid}
                                  u={u}
                                  onDisposition={onDisposition}
                                  pending={dispositionPending(u.uuid)}
                                  admin={admin}
                                />
                              ))}
                            </ul>
                          )}
                        </section>
                      </div>
                    )}
                  </GlassCard>
                );
              })}
            </div>
          ) : (
            /* ===================== LIST VIEW ===================== */
            <>
              {/* Deployments + six-state decision. */}
              <GlassCard>
                <div className="mb-4 flex items-center gap-2">
                  <Boxes className="h-4 w-4 text-primary" />
                  <h2 className="text-[15px] font-semibold text-foreground">Deployments under assurance</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[13px]">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="pb-2 pr-4 font-medium">System</th>
                        <th className="pb-2 pr-4 font-medium">Environment</th>
                        <th className="pb-2 pr-4 font-medium">Decision</th>
                        <th className="pb-2 pr-4 font-medium">Findings</th>
                        <th className="pb-2 pr-4 font-medium" />
                      </tr>
                    </thead>
                    <tbody>
                      {orderedDeployments.map((d) => (
                        <tr
                          key={d.uuid}
                          className={cn(
                            "border-t border-border/40 hover:bg-surface-1/40",
                            selected === d.uuid && "bg-surface-1/60",
                          )}
                        >
                          <td className="py-2.5 pr-4">
                            <button
                              className="text-left font-medium text-foreground hover:text-primary"
                              onClick={() => setSelected(selected === d.uuid ? "" : d.uuid)}
                            >
                              {d.name}
                            </button>
                          </td>
                          <td className="py-2.5 pr-4 text-muted-foreground">{d.environment}</td>
                          <td className="py-2.5 pr-4">
                            <DecisionPill decision={d.decision as never} label={d.decisionLabel || undefined} />
                          </td>
                          <td className="py-2.5 pr-4 text-muted-foreground">{d.findingCount}</td>
                          <td className="py-2.5 pr-4">
                            {admin && (
                              <button
                                className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-primary disabled:opacity-50"
                                onClick={() => recompute.mutate(d.uuid)}
                                disabled={
                                  d.decision === "paused" ||
                                  (recompute.isPending && recompute.variables === d.uuid)
                                }
                                title={
                                  d.decision === "paused"
                                    ? "Deployment is paused by the operator failsafe — lift the pause before recomputing"
                                    : "Recompute the decision from current findings"
                                }
                              >
                                <RefreshCw
                                  className={cn(
                                    "h-3.5 w-3.5",
                                    recompute.isPending && recompute.variables === d.uuid && "animate-spin",
                                  )}
                                />
                                Recompute
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {selected && (
                  <p className="mt-3 text-[12px] text-muted-foreground">
                    Showing assets, findings and unknowns for one deployment.{" "}
                    <button className="text-primary hover:underline" onClick={() => setSelected("")}>
                      Show all
                    </button>
                  </p>
                )}
              </GlassCard>

              {/* The asset graph: what is deployed, and how each thing is governed. */}
              <GlassCard>
                <div className="mb-4 flex items-center gap-2">
                  <Network className="h-4 w-4 text-primary" />
                  <h2 className="text-[15px] font-semibold text-foreground">Assets</h2>
                </div>
                {listAssets.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">No assets discovered yet.</p>
                ) : (
                  <ul className="space-y-2.5">
                    {listAssets.map((a) => (
                      <li
                        key={a.uuid}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/40 bg-surface-0/40 p-3"
                      >
                        <span className="text-[13px] font-semibold text-foreground">{a.name}</span>
                        <span className="text-[12px] text-muted-foreground">{a.kindLabel}</span>
                        <AssetClassChip value={a.classification} label={a.classificationLabel || undefined} />
                        <span className="text-[11px] text-muted-foreground">
                          {a.findingCount} {a.findingCount === 1 ? "finding" : "findings"}
                        </span>
                        {a.providerName && (
                          <span className="text-[11px] text-muted-foreground">· {a.providerName}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </GlassCard>

              {/* The provider registry and each vendor's declared profile (Phase 1.5),
                  with the admin create/edit/delete controls for those declared
                  facts (Phase 1.7). Reads render for everyone; writes are
                  admin-only here and on the control plane. */}
              <ProvidersRegistry providers={providers} admin={admin} m={providerMutations} />

              <div className="grid gap-6 lg:grid-cols-2">
                {/* Findings, with the evidence class surfaced. */}
                <GlassCard>
                  <h2 className="mb-4 text-[15px] font-semibold text-foreground">Findings</h2>
                  {listFindings.length === 0 ? (
                    <p className="text-[13px] text-muted-foreground">No findings in scope.</p>
                  ) : (
                    <ul className="space-y-3">
                      {listFindings.map((f) => (
                        <FindingRow key={f.uuid} f={f} remediation={remediationControls} />
                      ))}
                    </ul>
                  )}
                </GlassCard>

                {/* The Unknowns Register. */}
                <GlassCard>
                  <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <HelpCircle className="h-4 w-4 text-amber-400" />
                      <h2 className="text-[15px] font-semibold text-foreground">Unknowns Register</h2>
                    </div>
                    <span className="text-[12px] text-muted-foreground">{listOpenUnknowns.length} open</span>
                  </div>
                  {listUnknowns.length === 0 ? (
                    <p className="text-[13px] text-muted-foreground">
                      No open gaps. Every finding in scope is verified or resolved.
                    </p>
                  ) : (
                    <ul className="space-y-3">
                      {listUnknowns.map((u) => (
                        <UnknownCard
                          key={u.uuid}
                          u={u}
                          onDisposition={onDisposition}
                          pending={dispositionPending(u.uuid)}
                          admin={admin}
                        />
                      ))}
                    </ul>
                  )}
                </GlassCard>
              </div>
            </>
          )}

          <Divider />
        </>
      )}
    </div>
  );
}
