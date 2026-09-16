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
  firstSeen: string | null;
  lastSeen: string | null;
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
    firstSeen: strOrNull(raw.first_seen),
    lastSeen: strOrNull(raw.last_seen),
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

async function ok<T>(response: Response, map: (raw: Record<string, unknown>) => T): Promise<T[]> {
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return rows(await response.json()).map(map);
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
  return ok(await call("/api/assurance/deployments/"), deployment);
}

export async function listFindings(
  opts: { deployment?: string; severity?: string; status?: string } = {},
): Promise<AssuranceFinding[]> {
  const query = queryString({
    deployment: opts.deployment,
    severity: opts.severity,
    status: opts.status,
  });
  return ok(await call(`/api/assurance/findings/${query}`), finding);
}

export async function listUnknowns(
  opts: { deployment?: string; status?: string; impact?: string } = {},
): Promise<AssuranceUnknown[]> {
  const query = queryString({
    deployment: opts.deployment,
    status: opts.status,
    impact: opts.impact,
  });
  return ok(await call(`/api/assurance/unknowns/${query}`), unknown);
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
): Promise<{ decision: string | null; decisionLabel: string }> {
  const response = await call(`/api/assurance/deployments/${encodeURIComponent(uuid)}/recompute/`, {
    method: "POST",
    body: JSON.stringify({ paused }),
  });
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  return { decision: strOrNull(payload.decision), decisionLabel: str(payload.decision_label) };
}

/** The disposition fields a human may set on an Unknown. */
export interface UnknownPatch {
  status?: string;
  deploymentImpact?: string;
  notes?: string;
  reviewBy?: string | null;
}

/**
 * Update the human disposition of an Unknown. A backend refusal (400/404) is
 * returned to the caller with its reason rather than thrown, so the console can
 * show exactly why an edit did not take.
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
  if (response.status === 400 || response.status === 404) {
    return { ok: false, status: response.status, detail: await body(response) };
  }
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return { ok: true, unknown: unknown((await response.json()) as Record<string, unknown>) };
}
