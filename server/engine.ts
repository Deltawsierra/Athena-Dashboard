/**
 * The client for the Mythos engine.
 *
 * Athena records what was tested; the engine does the testing. Until now the
 * two had never been introduced, so the penetration-testing screen counted a
 * progress bar to a hundred over five seconds and printed two findings that
 * were written into the source. That is the single worst thing in the app to
 * put in front of somebody: it is a lie, it is the first screen a technical
 * visitor asks about, and the question they ask is "what did it actually
 * scan?"
 *
 * So this is small and it is honest about its own absence. When no engine is
 * configured, every call answers `configured: false` with a reason, the UI
 * says so in words, and nothing invents a finding. An engine that is not
 * there is a fact about the deployment, not an excuse for fiction.
 */

import * as settings from "./settings";

const ENGINE_URL = settings.FIELDS.engineUrl.env;
const ENGINE_KEY = settings.FIELDS.engineKey.env;

/** How long any single call to the engine may take. */
const TIMEOUT_MS = 20_000;

/** The most of the engine's error body we will quote back. */
const MAX_ERROR_BODY = 500;

export interface EngineStatus {
  configured: boolean;
  reachable: boolean;
  /**
   * Whether the engine accepted the operator key.
   *
   * Separate from `reachable`, because the engine's /health takes no
   * credential at all: it answers "ok" to anybody who can open a socket to
   * it. Reporting that as connected meant an address with a wrong key, or no
   * key, showed a green light and lit the Start button, and the operator
   * found out at dispatch when the scan came back 401.
   *
   * `null` means nobody could tell -- the engine is too old to have the route
   * this asks on. Not knowing is a third state and it is not "yes".
   */
  authorized: boolean | null;
  url: string | null;
  detail: string;
  /** What the engine says about itself, when it answered. */
  health?: unknown;
}

export interface EngineScan {
  runId: string | null;
  state: string;
  findings: unknown[];
  detail: string;
  /** The engine's own refusal, when it refused. Shown verbatim. */
  refused?: string;
}

export class EngineUnavailable extends Error {}

function baseUrl(): string | null {
  // From the settings row if an operator saved one, else from the
  // environment. Read through settings rather than process.env so a change
  // made in the app takes effect without a restart -- a desktop build has no
  // shell to set a variable in, and a settings screen whose changes need one
  // is a settings screen that does not work.
  const raw = settings.get("engineUrl");
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function isConfigured(): boolean {
  return baseUrl() !== null;
}

function headers(): Record<string, string> {
  const key = settings.get("engineKey");
  const out: Record<string, string> = { "Content-Type": "application/json" };
  // The engine's operator routes want this; the scan route wants it too. An
  // unset key is not an error here -- the engine will say so itself, and its
  // refusal is more accurate than a guess made from this side.
  if (key) out["X-API-Key"] = key;
  return out;
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const base = baseUrl();
  if (!base) {
    throw new EngineUnavailable(
      `no engine is configured; set ${ENGINE_URL} to the engine's address`,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers(), ...(init?.headers ?? {}) },
      signal: controller.signal,
    });
  } catch (cause) {
    // A hostname, a port and a refusal are all the operator needs; the stack
    // is not, and this string reaches a browser.
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new EngineUnavailable(`could not reach the engine at ${base}: ${why}`);
  } finally {
    clearTimeout(timer);
  }
}

async function body(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_ERROR_BODY);
  } catch {
    return "";
  }
}

/**
 * The cheapest thing on the engine that requires an operator key.
 *
 * It has to cost the engine nothing, because this runs on a poll: /health
 * /guards re-runs the whole boot canary and verify walks the record chain,
 * so neither belongs on a timer. This one reaps stale rows and lists what is
 * running, which the engine does anyway.
 */
const CREDENTIAL_PROBE = "/api/scans/active";

/**
 * Does the engine accept our key?
 *
 * Returns what is true, including "could not tell". A 404 here means the
 * engine predates this route, not that the key is bad, and answering "bad
 * key" to that would send an operator to re-issue a credential that was
 * fine.
 */
async function credentialCheck(): Promise<{ authorized: boolean | null; detail: string }> {
  if (!settings.get("engineKey")) {
    return {
      authorized: false,
      detail:
        `the engine answered, but no operator key is set, so it will refuse ` +
        `to scan. Issue one on the engine (tools/start_engine.py prints one) ` +
        `and set it on the Settings screen, or as ${ENGINE_KEY}.`,
    };
  }
  let response: Response;
  try {
    response = await call(CREDENTIAL_PROBE);
  } catch (cause) {
    // Reached /health a moment ago and cannot reach this: report the fact,
    // do not convert it into a verdict about the key.
    return {
      authorized: null,
      detail: `the engine answered, but the key could not be checked: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      authorized: false,
      detail: `the engine rejected the operator key (${response.status}): ${await body(response)}`,
    };
  }
  if (response.status === 404) {
    return {
      authorized: null,
      detail:
        `the engine answered, but it has no ${CREDENTIAL_PROBE} route, so the ` +
        `operator key could not be checked from here. A scan will be the ` +
        `first thing to find out whether it works.`,
    };
  }
  if (!response.ok) {
    return {
      authorized: null,
      detail: `the engine answered ${response.status} when the key was checked: ${await body(response)}`,
    };
  }
  return { authorized: true, detail: "the engine answered and accepted the operator key" };
}

export async function status(): Promise<EngineStatus> {
  const url = baseUrl();
  if (!url) {
    return {
      configured: false,
      reachable: false,
      authorized: false,
      url: null,
      detail:
        `no engine is configured, so nothing on this screen can scan anything. ` +
        `Set its address and an operator key on the Settings screen, or ` +
        `${ENGINE_URL} and ${ENGINE_KEY} in the environment.`,
    };
  }
  try {
    const response = await call("/health");
    if (!response.ok) {
      return {
        configured: true,
        reachable: false,
        authorized: false,
        url,
        detail: `the engine answered ${response.status}: ${await body(response)}`,
      };
    }
    const health = await response.json().catch(() => null);
    const credential = await credentialCheck();
    return {
      configured: true,
      reachable: true,
      authorized: credential.authorized,
      url,
      detail: credential.detail,
      health,
    };
  } catch (cause) {
    return {
      configured: true,
      reachable: false,
      authorized: false,
      url,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Authenticated scanning, in the exact shape the engine's TargetAuthConfig
 * accepts (snake_case, so it passes straight through to `/api/scan`). One
 * identity drives an authenticated crawl; two disjoint identities are what the
 * IDOR scanner needs. Credentials are forwarded to the engine for the duration
 * of the scan and are never persisted by Athena.
 */
export interface EngineAuthIdentity {
  name: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  login_fields?: Record<string, string>;
}

export interface EngineAuthConfig {
  enabled: boolean;
  login_url?: string | null;
  login_method?: string;
  authenticated_marker?: string | null;
  identities: EngineAuthIdentity[];
}

export interface ScanRequest {
  target: string;
  /** The engagement this scan is being run under. The engine records it. */
  engagementRef: string;
  /** Optional authenticated-scanning config, forwarded to the engine as-is. */
  auth?: EngineAuthConfig;
  /**
   * The hosts this engagement authorises.
   *
   * Sent because the engine's fallback, given none, is the target's own host
   * -- which makes its scope check unfalsifiable, since the only host it can
   * refuse is the one it derived the scope from. Athena is the side that
   * holds the client's site list, so Athena is the side that can make that
   * check mean something.
   */
  scope: string[];
}

/**
 * Ask the engine to scan a target.
 *
 * A refusal is a result, not an exception: the engine refuses a target its
 * egress policy will not reach, and that refusal -- with its reason -- is
 * exactly what an operator needs to see. Swallowing it into "scan failed"
 * would throw away the only useful sentence.
 */
export async function startScan(request: ScanRequest): Promise<EngineScan> {
  const response = await call("/api/scan", {
    method: "POST",
    // No tenant is sent. The engine binds a credential to a tenant and
    // resolves it from the key, and Athena's client id is not that tenant --
    // sending it got "this credential is bound to a different tenant", which
    // was the engine being right. What Athena knows is the engagement, and
    // that is what it says.
    body: JSON.stringify({
      target: request.target,
      engagement_ref: request.engagementRef,
      scope: request.scope,
      // Forwarded only when authenticated scanning was configured; the engine
      // validates it against TargetAuthConfig and refuses a malformed block.
      ...(request.auth ? { auth: request.auth } : {}),
    }),
  });

  if (response.status === 403 || response.status === 409) {
    return {
      runId: null,
      state: "refused",
      findings: [],
      detail: "the engine refused this scan",
      refused: await body(response),
    };
  }
  if (!response.ok) {
    throw new EngineUnavailable(
      `the engine answered ${response.status}: ${await body(response)}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  // Measured against a live engine: results come back under `result.results`,
  // never at the top level. This read `payload.results` -- a key the engine
  // does not send -- so a scan that completed inline had its findings silently
  // dropped, and only the polling route ever saw them. Harmless while nothing
  // asks the engine to wait, and a silent loss the moment anything does.
  // `runState` has always read the nested form; both agree now.
  const inline = (payload.result ?? {}) as Record<string, unknown>;
  return {
    runId: (payload.run_id as string) ?? null,
    state: (payload.state as string) ?? "running",
    findings: Array.isArray(inline.results)
      ? inline.results
      : Array.isArray(payload.results) ? payload.results : [],
    detail: "the engine accepted the scan",
  };
}

/**
 * What the engine's CVE classifier made of a piece of text.
 *
 * `informative` is the field that matters. The model knows five classes, so
 * an input it has no signal for comes back at exactly the floor -- one fifth
 * -- carrying whichever label wins the tie-break, which is always `rce`.
 * Measured: an empty string, "zzzz", "csrf token missing" and "xxe external
 * entity" all answer `rce` at 0.200, because CSRF and XXE are not among the
 * five. Rendering that as a classification would replace the constant this
 * screen used to print with a different untruth.
 */
export interface CveClassification {
  label: string | null;
  /**
   * Null when the engine did not send one. NOT zero.
   *
   * Zero is a measurement -- "the model scored this class at nothing" -- and
   * printing it for a field the engine never sent states a result nobody
   * reached. It is the same defect as the 92% this screen used to invent,
   * with a more modest number.
   */
  confidence: number | null;
  /**
   * True when the model separated this input from its alternatives, false when
   * it scored every class equally and the label is a tie-break -- and **null
   * when the engine did not send the field at all**.
   *
   * Three states rather than two, because the page renders each differently and
   * the two-state version turned an absent field into an affirmative sentence.
   * `false` here licences the words "the model scored every one of its classes
   * equally, so it has expressed no preference" -- a specific claim ABOUT THE
   * MODEL. An engine that omitted the field has made no such claim, and reading
   * absent as false published it anyway: with a measured 0.9 against a 0.2
   * floor in the same response, the page told the reader every class scored
   * 20.0%. A number nobody computed is bad; a sentence nobody said is worse,
   * and this one contradicted the data beside it.
   *
   * Null is still fail-safe, which was the whole point of the old default: the
   * null branch does not present the answer as a finding either. It declines to
   * characterise it in both directions instead of guessing one.
   */
  informative: boolean | null;
  /** The no-information floor, 1/classes, as the engine computed it. */
  baseline: number | null;
  /** Every label this model can return, so a caller can say what it cannot. */
  classes: string[];
  engineVersion: string | null;
  /** The engine's own words when the model is not loaded at all. */
  unavailable: string | null;
}

/**
 * Ask the engine to classify a vulnerability description.
 *
 * This screen once answered "SQL Injection, 92% confident" to every input,
 * both constants. It then said no classification route existed, which was
 * wrong -- `/api/classify-cve` has been there all along. This calls it.
 */
export async function classifyCve(text: string): Promise<CveClassification> {
  const response = await call("/api/classify-cve", {
    method: "POST",
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new EngineUnavailable(
      `the engine answered ${response.status}: ${await body(response)}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const classes = Array.isArray(payload.classes)
    ? payload.classes.filter((one): one is string => typeof one === "string")
    : [];

  return {
    label: typeof payload.label === "string" ? payload.label : null,
    confidence: typeof payload.confidence === "number" ? payload.confidence : null,
    // Absent means NULL, not false. An older engine that does not send this
    // field has told us nothing: not that the answer was informative (assuming
    // that is how the floor case gets rendered as a finding) and not that it
    // was uninformative either (assuming THAT is how "the model expressed no
    // preference" gets asserted about a model that said no such thing).
    informative:
      typeof payload.informative === "boolean" ? payload.informative : null,
    baseline: typeof payload.baseline === "number" ? payload.baseline : null,
    classes,
    engineVersion:
      typeof payload.engine_version === "string" ? payload.engine_version : null,
    unavailable: typeof payload.error === "string" ? payload.error : null,
  };
}

/**
 * One source inside an evidence pack, and whether it is actually in there.
 *
 * `status` is the field that decides whether the pack means anything. A source
 * can be `excluded` -- the scan record has no tenant column, so an unscoped
 * pack leaves scans out entirely -- or `truncated`. A pack that showed only
 * its record counts would read as complete while missing the thing somebody
 * asked for.
 */
export interface EvidenceSource {
  source: string;
  status: string;
  reason: string | null;
  /**
   * Null when the engine did not report a count. NOT zero.
   *
   * A source carrying `status: "included"` and `records: 0` says the pack
   * looked and found nothing there -- a claim about the customer's data. An
   * absent count says only that the engine did not tell us. A pack handed to a
   * third party must not turn the second into the first.
   */
  records: number | null;
  chainOk: boolean;
  chainDetail: string;
  chainPartial: boolean;
  chainAnchored: boolean;
  chainHeadRecorded: boolean;
  chainHeadAuthentic: boolean;
}

/**
 * A signed, verifiable record of what this deployment did.
 *
 * `signed` is not decoration. The engine signs with Ed25519 over a manifest
 * committing to a Merkle root, and when no key is configured it returns the
 * pack anyway with `signed: false` and a reason -- deliberately, so that an
 * unsigned pack says so rather than looking like a signed one nobody checked.
 * Anything rendering this has to preserve that distinction: an unsigned pack
 * is a record, not proof.
 */
/**
 * The engine's signature block. Not a bare string: it names the algorithm and
 * the key that signed, because a signature is only checkable against a key the
 * verifier already holds.
 *
 * `publicKey` is carried for convenience and MUST NOT be trusted from here.
 * Anyone who re-signs a doctored pack with their own key also replaces this
 * copy, so verifying against it establishes only that the file is internally
 * consistent. `keyId` is the useful field: it says which published key to ask
 * for. Anything rendering this has to say so.
 */
export interface EvidenceSignature {
  algorithm: string;
  keyId: string | null;
  publicKey: string | null;
  signature: string;
}

export interface EvidencePack {
  format: string;
  generatedAt: string | null;
  tenant: string | null;
  reason: string | null;
  merkleRoot: string | null;
  /**
   * Null when the manifest did not carry one. NOT zero.
   *
   * `merkleRoot` is already nullable, so defaulting this to 0 produced the one
   * combination that cannot be true: a root over an empty tree. A pack is
   * proof of what it commits to, and a leaf count nobody sent is not a count
   * of zero leaves -- it is a pack whose extent is unknown, which is what the
   * reader and the activity log both need to be told.
   */
  leafCount: number | null;
  signed: boolean;
  signature: EvidenceSignature | null;
  unsignedReason: string | null;
  sources: EvidenceSource[];
  /** The whole document, as the engine produced it, for saving to disk. */
  document: unknown;
}

/**
 * Read the engine's signature block.
 *
 * Measured against a running engine with ENGINE_EVIDENCE_KEY set: the field is
 * an object -- {algorithm, public_key, key_id, signature} -- not a string. An
 * earlier version of this function tested `typeof payload.signature ===
 * "string"` and so returned null for every pack the engine actually signed,
 * which rendered as "Signed" with nothing to check.
 */
function evidenceSignature(raw: unknown): EvidenceSignature | null {
  if (!raw || typeof raw !== "object") return null;
  const block = raw as Record<string, unknown>;
  // No signature string is no signature. The other fields are identification.
  if (typeof block.signature !== "string" || block.signature.length === 0) return null;
  return {
    algorithm: typeof block.algorithm === "string" ? block.algorithm : "unknown",
    keyId: typeof block.key_id === "string" ? block.key_id : null,
    publicKey: typeof block.public_key === "string" ? block.public_key : null,
    signature: block.signature,
  };
}

function evidenceSource(raw: Record<string, unknown>): EvidenceSource {
  return {
    source: String(raw.source ?? "unknown"),
    status: String(raw.status ?? "unknown"),
    reason: typeof raw.reason === "string" ? raw.reason : null,
    records: typeof raw.records === "number" ? raw.records : null,
    chainOk: raw.chain_ok === true,
    chainDetail: typeof raw.chain_detail === "string" ? raw.chain_detail : "",
    chainPartial: raw.chain_partial === true,
    chainAnchored: raw.chain_anchored === true,
    chainHeadRecorded: raw.chain_head_recorded === true,
    chainHeadAuthentic: raw.chain_head_authentic === true,
  };
}

/**
 * Why a pack is not signed, in words a reader can act on.
 *
 * The engine sends `unsigned_reason` when it knows it could not sign. The
 * other case -- `signed: true` with a signature block this cannot read -- has
 * no reason from the engine, so one is written here rather than leaving the
 * page to say "the engine did not sign this pack", which would be false.
 */
function unsignedReason(
  payload: Record<string, unknown>,
  signature: EvidenceSignature | null,
): string | null {
  if (signature !== null) return null;
  if (typeof payload.unsigned_reason === "string") return payload.unsigned_reason;
  if (payload.signed === true) {
    return "the engine reported this pack as signed but sent no signature that could be read";
  }
  return null;
}

export interface EvidenceRequest {
  /** Required. Without it the engine excludes the scan record entirely. */
  engagementRef: string;
  reason: string;
  runId?: string;
  target?: string;
  since?: string;
  until?: string;
}

/**
 * Ask the engine for an evidence pack.
 *
 * `engagement_ref` is always sent. Measured against a running engine: an
 * unscoped pack reports `scans: excluded` with the reason "the scan record has
 * no tenant column, so it cannot be scoped to one customer; name a run,
 * engagement or target to include it". A pack built for a customer that
 * silently contains none of their scans is worse than no pack.
 */
export async function buildEvidencePack(request: EvidenceRequest): Promise<EvidencePack> {
  const response = await call("/api/evidence/pack", {
    method: "POST",
    body: JSON.stringify({
      engagement_ref: request.engagementRef,
      reason: request.reason,
      ...(request.runId ? { run_id: request.runId } : {}),
      ...(request.target ? { target: request.target } : {}),
      ...(request.since ? { since: request.since } : {}),
      ...(request.until ? { until: request.until } : {}),
    }),
  });

  if (!response.ok) {
    throw new EngineUnavailable(
      `the engine answered ${response.status}: ${await body(response)}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const manifest = (payload.manifest ?? {}) as Record<string, unknown>;
  const rawSources = Array.isArray(manifest.sources) ? manifest.sources : [];
  const signature = evidenceSignature(payload.signature);

  return {
    format: typeof manifest.format === "string" ? manifest.format : "unknown",
    generatedAt: typeof manifest.generated_at === "string" ? manifest.generated_at : null,
    tenant: typeof manifest.tenant === "string" ? manifest.tenant : null,
    reason: typeof manifest.reason === "string" ? manifest.reason : null,
    merkleRoot: typeof manifest.merkle_root === "string" ? manifest.merkle_root : null,
    leafCount: typeof manifest.leaf_count === "number" ? manifest.leaf_count : null,
    // Absent means unsigned. An engine that does not say it signed the pack
    // has not signed it, and defaulting the other way is how an unsigned pack
    // gets handed to a customer as proof.
    // Both halves must hold. `signed: true` with no readable signature block
    // is an engine claiming a signature it did not send, and rendering that as
    // proof is the failure this whole page exists to prevent.
    signed: payload.signed === true && signature !== null,
    signature,
    unsignedReason: unsignedReason(payload, signature),
    sources: rawSources.map((one) => evidenceSource(one as Record<string, unknown>)),
    document: payload,
  };
}

/** Where a run has got to. */
export async function runState(runId: string): Promise<EngineScan> {
  const response = await call(`/api/scans/${encodeURIComponent(runId)}`);
  if (!response.ok) {
    throw new EngineUnavailable(
      `the engine answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const result = (payload.result ?? {}) as Record<string, unknown>;
  return {
    runId,
    state: (payload.state as string) ?? "unknown",
    findings: Array.isArray(result.results) ? result.results : [],
    detail: (payload.reason as string) ?? "",
  };
}

/** Ask a running scan to stop. */
export async function abort(runId: string): Promise<boolean> {
  const response = await call(`/api/scans/${encodeURIComponent(runId)}/abort`, {
    method: "POST",
  });
  return response.ok;
}

// ==== RETEST ====
//
// "Did the fix work?" is a different question from "is this still a finding?",
// and the engine keeps them apart. `/api/decisions/{id}/replay` re-runs today's
// detectors over the recorded input -- a question about the engine, touching
// nobody's system. `/api/remediation/retest` goes back to the customer's target
// and looks again. Only the second one can answer whether something was fixed,
// and only the second one needs an authority to run, which is why the engine
// requires `engagement_ref` on it and Athena composes that here rather than
// letting the engine derive a scope from the twin the caller picked.

/**
 * A decision the engine kept so it could be made again.
 *
 * Captured per real finding at the time of the scan, with the inputs that
 * produced it and the verdict it produced, so a retest compares like with
 * like instead of comparing today's scan to a remembered summary.
 */
export interface DecisionTwin {
  id: number;
  runId: string | null;
  target: string;
  findingType: string;
  severity: string | null;
  tier: string | null;
  confidence: number | null;
  /** Where the finding was, when the twin recorded one. */
  endpoint: string | null;
  detail: string | null;
  capturedAt: string | null;
}

function decisionTwin(raw: Record<string, unknown>): DecisionTwin {
  const decision = (raw.decision ?? {}) as Record<string, unknown>;
  const inputs = (raw.inputs ?? {}) as Record<string, unknown>;
  return {
    id: Number(raw.id),
    runId: typeof raw.run_id === "string" ? raw.run_id : null,
    target: String(raw.target ?? ""),
    findingType: String(raw.finding_type ?? "unknown"),
    severity: typeof decision.severity === "string" ? decision.severity : null,
    tier: typeof decision.tier === "string" ? decision.tier : null,
    confidence: typeof decision.confidence === "number" ? decision.confidence : null,
    endpoint: typeof inputs.endpoint === "string" ? inputs.endpoint : null,
    detail: typeof inputs.details === "string" ? inputs.details : null,
    capturedAt: typeof raw.captured_at === "string" ? raw.captured_at : null,
  };
}

/**
 * The twins captured during one run, newest first.
 *
 * `truncated` is not decoration either. Measured: a single scan of one small
 * host captured 81 twins, so a run that fills the limit is an ordinary run,
 * not a pathological one. A list that silently stops at the limit looks
 * exactly like a complete one, and the operator concludes there is nothing
 * else to retest. One more than the limit is asked for so the difference can
 * be told.
 */
export interface DecisionList {
  decisions: DecisionTwin[];
  truncated: boolean;
}

export async function listDecisions(runId: string, limit = 100): Promise<DecisionList> {
  const response = await call(
    `/api/decisions?run_id=${encodeURIComponent(runId)}&limit=${limit + 1}`,
  );
  if (!response.ok) {
    throw new EngineUnavailable(
      `the engine answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const raw = Array.isArray(payload.decisions) ? payload.decisions : [];
  return {
    decisions: raw.slice(0, limit).map((one) => decisionTwin(one as Record<string, unknown>)),
    truncated: raw.length > limit,
  };
}

/**
 * What a retest concluded.
 *
 * `verdict` is passed through as the engine's own string. There are three of
 * them and they are not two: `closed`, `still_open`, and `inconclusive`. The
 * engine says `inconclusive` rather than `closed` whenever the absence of the
 * finding is explainable by something other than the finding being gone -- a
 * scan that did not complete, or a detector set that is no longer the approved
 * one. Measured: with the target simply switched off, the verdict is
 * `inconclusive` with the connection error as its detail, not `closed`. A UI
 * that collapses this to fixed/not-fixed reports a host that went down as a
 * vulnerability remediated, which is the worst thing this feature could say.
 */
export interface RetestResult {
  twinId: number | null;
  verdict: string;
  detail: string;
  target: string | null;
  findingType: string | null;
  /** The detector set the retest ran with, for comparing against the twin's. */
  inventoryDigest: string | null;
  runId: string | null;
  checkedAt: string | null;
}

export interface RetestRequest {
  twinId: number;
  /** Required by the engine. Composed from the engagement, never from the twin. */
  engagementRef: string;
  scope: string[];
}

export async function retest(request: RetestRequest): Promise<RetestResult> {
  const response = await call("/api/remediation/retest", {
    method: "POST",
    body: JSON.stringify({
      twin_id: request.twinId,
      engagement_ref: request.engagementRef,
      scope: request.scope,
    }),
  });
  if (!response.ok) {
    throw new EngineUnavailable(
      `the engine answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const check = (payload.check ?? {}) as Record<string, unknown>;
  return {
    twinId: typeof payload.twin_id === "number" ? payload.twin_id : null,
    // No verdict is not a pass. An engine that answered without one has not
    // said the finding is gone.
    verdict: typeof payload.verdict === "string" ? payload.verdict : "inconclusive",
    detail: typeof payload.detail === "string" ? payload.detail : "",
    target: typeof payload.target === "string" ? payload.target : null,
    findingType: typeof payload.finding_type === "string" ? payload.finding_type : null,
    inventoryDigest:
      typeof payload.inventory_digest === "string" ? payload.inventory_digest : null,
    // Measured: the engine sends this as a number at the top level and as a
    // string inside `check`. Both are the same run.
    runId: payload.run_id === null || payload.run_id === undefined
      ? null
      : String(payload.run_id),
    checkedAt: typeof check.checked_at === "string" ? check.checked_at : null,
  };
}

/**
 * Which scanners this engine has loaded.
 *
 * Measured by the engine from the artifacts on disk rather than read back from
 * a table, and it is the difference between "a scanner looked and found
 * nothing" and "nothing looked". The compliance map needs that difference:
 * without it a requirement nobody tested renders identically to one that
 * passed.
 *
 * Returns null when the engine could not be asked. Null is not an empty list:
 * an empty list says the engine has no scanners, and null says we do not know,
 * and the map treats them differently on purpose.
 */
export async function loadedScanners(): Promise<string[] | null> {
  let response;
  try {
    response = await call("/api/extensions");
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const payload = (await response.json()) as Record<string, unknown>;
  const listed = Array.isArray(payload.extensions) ? payload.extensions : [];
  return listed
    .map((one) => one as Record<string, unknown>)
    // `kind` separates scanners from detectors, adapters and the rest; only a
    // scanner produces the findings a requirement is judged on. `enabled`
    // matters as much: a scanner present on disk but switched off did not run.
    .filter((one) => one.kind === "scanner" && one.enabled === true)
    .map((one) => String(one.name))
    .sort();
}
