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
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Boxes,
  Briefcase,
  Building2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Download,
  FileText,
  Fingerprint,
  GitBranch,
  HelpCircle,
  LayoutList,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Scale,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
  Waypoints,
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
  status: string;
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
  receipt: { algorithm: string; digest: string; evidenceCount?: number };
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
interface RouteMap {
  layers: { key: string; label: string; nodes: RouteNode[] }[];
  nodes: RouteNode[];
  edges: RouteEdge[];
  unresolved: { agent: string; toolIdentifier: string }[];
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
}: {
  pending: boolean;
  onSubmit: (v: { name: string; kind: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("model_provider");
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
          Add provider
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
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="text-[13px] font-semibold text-foreground">{p.name}</span>
                  <span className="text-[12px] text-muted-foreground">{p.kindLabel}</span>
                </div>
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

function FindingRow({ f, showAsset = true }: { f: Finding; showAsset?: boolean }) {
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
        <span className="text-[11px] text-muted-foreground">{f.status}</span>
        {showAsset && f.assetName && (
          <span className="text-[11px] text-muted-foreground">· {f.assetName}</span>
        )}
        {f.location && <span className="text-[11px] text-muted-foreground">· {f.location}</span>}
        {f.receipt?.digest && (
          <span
            className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground"
            title={`Assurance receipt (${f.receipt.algorithm}) — recomputable digest over this finding's evidence, attesting it is unaltered:\n${f.receipt.digest}`}
          >
            <Fingerprint className="h-3 w-3" />
            {f.receipt.digest.slice(0, 12)}
          </span>
        )}
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

function AssetNode({ asset, findings }: { asset: Asset; findings: Finding[] }) {
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
            <FindingRow key={f.uuid} f={f} showAsset={false} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The AI-BOM (Phase 1.7) for one deployment: the AI supply-chain bill of
 * materials — every component and the providers behind it, each provider fact
 * evidence-graded, with a tamper-evident digest. Self-fetching (mounted only
 * inside an expanded deployment). It is an exportable artifact (procurement,
 * audit, M&A, security questionnaires): a reader can download the JSON and a
 * recipient can recompute the digest to confirm nothing was altered. Honest by
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

          {/* The tamper-evident digest: a recipient recomputes it to verify the
              exported BOM is unaltered. */}
          <div className="mt-3 flex items-center gap-1.5 text-[10px] text-muted-foreground">
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
            {summary.unresolvedEdges > 0 && (
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

          {/* Dangling tool references: an agent names a tool discovery could not
              place — a gap to chase, not a silent drop. */}
          {data.unresolved.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-400">
                Unresolved references
              </p>
              <ul className="space-y-1">
                {data.unresolved.map((u, i) => (
                  <li key={i} className="text-[11px] text-muted-foreground">
                    <span className="text-foreground">{u.agent}</span> names{" "}
                    <span className="text-amber-400/90">{u.toolIdentifier}</span>, which discovery could
                    not place.
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

// A capability's risk, worn honestly: a high-risk power (code execution, money
// movement, a shadow capability nobody approved) leads in red, an elevated one
// in amber, a baseline one in muted. Anything unrecognised falls back to muted.
function CapabilityRiskChip({ risk }: { risk: string }) {
  const look =
    risk === "high"
      ? { cls: "border-sev-high/40 bg-sev-high/10 text-sev-high", label: "High risk" }
      : risk === "elevated"
        ? { cls: "border-amber-500/40 bg-amber-500/10 text-amber-400", label: "Elevated" }
        : { cls: "border-border/50 bg-surface-1/40 text-muted-foreground", label: "Baseline" };
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
      queryClient.invalidateQueries({
        queryKey: [`/api/assurance/deployments/${deploymentUuid}/data-boundary`],
      });
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

  const {
    data: status,
    isLoading: statusLoading,
    isError: statusError,
    error: statusErr,
  } = useQuery<AssuranceStatus>({
    queryKey: ["/api/assurance/status"],
    refetchInterval: 30_000,
  });
  const reachable = status?.configured === true && status?.reachable === true && status?.authorized === true;

  // Everything is fetched whole and grouped in the browser: the graph needs each
  // deployment's children, and grouping client-side means one fetch each rather
  // than a request per deployment. The BFF follows DRF pagination, so these are
  // complete.
  const { data: deployments = [], isLoading: depLoading } = useQuery<Deployment[]>({
    queryKey: ["/api/assurance/deployments"],
    enabled: reachable,
  });
  const { data: findings = [] } = useQuery<Finding[]>({
    queryKey: ["/api/assurance/findings"],
    enabled: reachable,
  });
  const { data: unknowns = [] } = useQuery<Unknown[]>({
    queryKey: ["/api/assurance/unknowns"],
    enabled: reachable,
  });
  const { data: assets = [] } = useQuery<Asset[]>({
    queryKey: ["/api/assurance/assets"],
    enabled: reachable,
  });
  const { data: providers = [] } = useQuery<Provider[]>({
    queryKey: ["/api/assurance/providers"],
    enabled: reachable,
  });

  const recompute = useMutation({
    mutationFn: async (uuid: string) =>
      (await apiRequest("POST", `/api/assurance/deployments/${uuid}/recompute`, { paused: false })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/assurance/deployments"] });
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

  // ---- Provider profile editing (admin-only; the control plane is the gate) ----

  // A provider fact feeds every per-deployment computed assessment (data
  // boundary, capabilities, route map, AI-BOM), so editing one must refresh
  // those panels too — not only the providers list. Their query keys are
  // per-deployment single-string arrays, so a prefix match can't reach them;
  // a predicate on the key suffix does.
  const COMPUTED_PANEL_SUFFIXES = ["/data-boundary", "/capabilities", "/route-map", "/ai-bom"];
  const invalidateProviders = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/assurance/providers"] });
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey[0];
        return (
          typeof key === "string" && COMPUTED_PANEL_SUFFIXES.some((s) => key.endsWith(s))
        );
      },
    });
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
              {statusErr instanceof Error ? statusErr.message : "The status request failed."}
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

          {depLoading ? (
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
                                <AssetNode key={a.uuid} asset={a} findings={findingsForAsset(a.uuid)} />
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
                                <FindingRow key={f.uuid} f={f} />
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
                        <FindingRow key={f.uuid} f={f} />
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
