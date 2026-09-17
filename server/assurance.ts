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
}

export interface AssuranceReceipt {
  algorithm: string;
  digest: string;
  /** Present on a finding receipt; a deployment receipt reports findingCount. */
  evidenceCount?: number;
  findingCount?: number;
  computedAt: string | null;
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
