/**
 * The client for the failsafe control plane (Athena-Backend).
 *
 * The three failsafes -- pause, stand-down, terminate -- are the end-all to the
 * engine, so the console that drives them earns the same honesty the engine
 * client (server/engine.ts) is built on: when no control plane is configured,
 * every call says so in words, and nothing here pretends an engine was paused
 * that was not.
 *
 * The trust model this file lives inside (docs/adr/0001-failsafe-controls.md):
 *
 *   - This server NEVER holds a signing key. It drafts commands and relays
 *     operator signatures; the private ed25519 keys stay on operators' own
 *     machines and sign OUT OF BAND via the `mythos-failsafe` CLI. So a
 *     compromise of this server, or the browser, cannot mint a command the
 *     engine will obey. Guard (a).
 *
 *   - The engine is the sole authoritative verifier. This plane's job is to
 *     collect enough distinct operator signatures (two, for stand-down and
 *     terminate -- the two-person rule, guard (b)) and let the engine poll for
 *     the finished, signed command. Nothing this file does can shortcut that.
 *
 * Because the real gate is the signatures, the credential this uses to reach
 * the control plane is a service account, not the root of trust: it decides who
 * may DRAFT and SUBMIT, which is inert without out-of-band operator signatures.
 *
 * Configured from the environment (ATHENA_FAILSAFE_*), not the in-app settings
 * row: the control-plane address and its service credential are a property of
 * the deployment, set once by whoever stands the backend up, not a field an
 * operator retunes from a screen.
 */

const FAILSAFE_URL_ENV = "ATHENA_FAILSAFE_URL";
const FAILSAFE_USER_ENV = "ATHENA_FAILSAFE_USER";
const FAILSAFE_PASSWORD_ENV = "ATHENA_FAILSAFE_PASSWORD";
const FAILSAFE_ENGINE_ID_ENV = "ATHENA_FAILSAFE_ENGINE_ID";

/** How long any single call to the control plane may take. */
const TIMEOUT_MS = 15_000;

/** The most of the control plane's error body we will quote back. */
const MAX_ERROR_BODY = 500;

export class FailsafeUnavailable extends Error {}

function baseUrl(): string | null {
  const raw = (process.env[FAILSAFE_URL_ENV] ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function isConfigured(): boolean {
  return baseUrl() !== null;
}

/** The engine id a fresh draft defaults to, when the deployment names one. */
export function defaultEngineId(): string {
  return (process.env[FAILSAFE_ENGINE_ID_ENV] ?? "").trim();
}

// ==== Service-account auth ====
//
// The control plane authenticates operators with SimpleJWT. This server holds a
// service account -- analyst-role to draft pause/stand-down, admin-role if it
// is to draft terminate -- and exchanges its credential for a short-lived
// access token, cached and re-obtained on expiry. It is NOT an operator key:
// every consequential command still needs out-of-band ed25519 signatures the
// engine verifies. The credential decides who may draft, nothing more.

let cachedAccess: string | null = null;

async function obtainAccessToken(base: string): Promise<string> {
  const username = (process.env[FAILSAFE_USER_ENV] ?? "").trim();
  const password = process.env[FAILSAFE_PASSWORD_ENV] ?? "";
  if (!username || !password) {
    throw new FailsafeUnavailable(
      `the failsafe control plane is configured at ${base}, but no service ` +
        `credential is set; set ${FAILSAFE_USER_ENV} and ${FAILSAFE_PASSWORD_ENV} ` +
        `to an operator account the backend knows`,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}/api/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    });
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new FailsafeUnavailable(`could not reach the failsafe control plane at ${base}: ${why}`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401) {
    throw new FailsafeUnavailable(
      `the failsafe control plane rejected the service credential; check ` +
        `${FAILSAFE_USER_ENV} and ${FAILSAFE_PASSWORD_ENV}`,
    );
  }
  if (!response.ok) {
    throw new FailsafeUnavailable(
      `the failsafe control plane answered ${response.status} when obtaining a token: ${await body(response)}`,
    );
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const access = payload && typeof payload.access === "string" ? payload.access : null;
  if (!access) {
    throw new FailsafeUnavailable("the failsafe control plane returned no access token");
  }
  cachedAccess = access;
  return access;
}

async function body(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_ERROR_BODY);
  } catch {
    return "";
  }
}

/**
 * Call an operator route, authenticated by the cached service token.
 *
 * A 401 means the token expired (SimpleJWT access tokens are short-lived), so
 * this obtains a fresh one and retries exactly once. Any other non-ok answer is
 * the caller's to interpret -- a 403 from the backend is a real "you may not do
 * this", not something to retry.
 */
async function call(path: string, init: RequestInit = {}, retryAuth = true): Promise<Response> {
  const base = baseUrl();
  if (!base) {
    throw new FailsafeUnavailable(
      `no failsafe control plane is configured; set ${FAILSAFE_URL_ENV} to the backend's address`,
    );
  }
  const access = cachedAccess ?? (await obtainAccessToken(base));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access}`,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new FailsafeUnavailable(`could not reach the failsafe control plane at ${base}: ${why}`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 && retryAuth) {
    // Token expired mid-session; get a new one and try once more.
    cachedAccess = null;
    await obtainAccessToken(base);
    return call(path, init, false);
  }
  return response;
}

// ==== Typed views of the control plane ====

/** A failsafe command as the console shows it. snake_case from the backend is
 *  mapped to camelCase here so the client never has to know two spellings. */
export interface FailsafeCommand {
  uuid: string;
  engineId: string;
  action: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  reason: string;
  signers: string[];
  requiredSignatures: number;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The exact fields an operator feeds to `mythos-failsafe sign --draft`. These
 *  are snake_case ON PURPOSE: the CLI reconstructs the signed bytes from this
 *  document, so a renamed key would silently produce a signature the engine
 *  rejects. */
export interface CommandDraft {
  action: string;
  engine_id: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
  reason: string;
}

export interface DraftedCommand {
  command: FailsafeCommand;
  /** Hex the operator's CLI will reproduce; shown for cross-checking. */
  signingBytes: string;
  /** The document to sign, ready to paste into `mythos-failsafe sign --draft -`. */
  draft: CommandDraft;
}

export interface FailsafeAuditEvent {
  uuid: string;
  timestamp: string;
  event: string;
  commandUuid: string | null;
  actor: string | null;
  detail: Record<string, unknown>;
}

export interface FailsafeStateView {
  engineId: string | null;
  /** The engine's live governor state, once the engine exposes it and the
   *  backend proxies it. Null means "the engine has not reported", which is a
   *  fact, not "running". */
  engineState: string | null;
  engineStateAvailable: boolean;
  awaitingSignatures: FailsafeCommand[];
  ready: FailsafeCommand[];
  recent: FailsafeCommand[];
}

export interface FailsafeStatus {
  configured: boolean;
  reachable: boolean;
  /** Whether the backend accepted the service credential. null = could not tell. */
  authorized: boolean | null;
  url: string | null;
  detail: string;
}

function command(raw: Record<string, unknown>): FailsafeCommand {
  return {
    uuid: String(raw.uuid ?? ""),
    engineId: String(raw.engine_id ?? ""),
    action: String(raw.action ?? ""),
    nonce: String(raw.nonce ?? ""),
    issuedAt: String(raw.issued_at ?? ""),
    expiresAt: String(raw.expires_at ?? ""),
    reason: typeof raw.reason === "string" ? raw.reason : "",
    signers: Array.isArray(raw.signers) ? raw.signers.map((s) => String(s)) : [],
    requiredSignatures: typeof raw.required_signatures === "number" ? raw.required_signatures : 1,
    status: String(raw.status ?? "unknown"),
    createdAt: typeof raw.created_at === "string" ? raw.created_at : null,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : null,
  };
}

function draftFrom(raw: Record<string, unknown>): CommandDraft {
  return {
    action: String(raw.action ?? ""),
    engine_id: String(raw.engine_id ?? ""),
    nonce: String(raw.nonce ?? ""),
    issued_at: String(raw.issued_at ?? ""),
    expires_at: String(raw.expires_at ?? ""),
    reason: typeof raw.reason === "string" ? raw.reason : "",
  };
}

function auditEvent(raw: Record<string, unknown>): FailsafeAuditEvent {
  return {
    uuid: String(raw.uuid ?? ""),
    timestamp: String(raw.timestamp ?? ""),
    event: String(raw.event ?? ""),
    commandUuid: typeof raw.command_uuid === "string" ? raw.command_uuid : null,
    actor: typeof raw.actor_username === "string" ? raw.actor_username : null,
    detail: raw.detail && typeof raw.detail === "object" ? (raw.detail as Record<string, unknown>) : {},
  };
}

/** Is the control plane there, and does it accept our service credential? */
export async function status(): Promise<FailsafeStatus> {
  const url = baseUrl();
  if (!url) {
    return {
      configured: false,
      reachable: false,
      authorized: false,
      url: null,
      detail:
        `no failsafe control plane is configured, so this console cannot draft ` +
        `or relay a failsafe command. Set ${FAILSAFE_URL_ENV} (and a service ` +
        `credential, ${FAILSAFE_USER_ENV}/${FAILSAFE_PASSWORD_ENV}) on the backend.`,
    };
  }
  try {
    // /state authenticates and is cheap; reaching it 200 proves both reachable
    // and authorized in one call.
    const response = await call("/api/failsafe/state/");
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
    if (cause instanceof FailsafeUnavailable) {
      return { configured: true, reachable: false, authorized: false, url, detail: cause.message };
    }
    throw cause;
  }
}

export async function state(engineId?: string): Promise<FailsafeStateView> {
  const query = engineId ? `?engine_id=${encodeURIComponent(engineId)}` : "";
  const response = await call(`/api/failsafe/state/${query}`);
  if (!response.ok) {
    throw new FailsafeUnavailable(
      `the control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const list = (key: string): FailsafeCommand[] =>
    Array.isArray(payload[key]) ? (payload[key] as Record<string, unknown>[]).map(command) : [];
  return {
    engineId: typeof payload.engine_id === "string" ? payload.engine_id : null,
    engineState: typeof payload.engine_state === "string" ? payload.engine_state : null,
    engineStateAvailable: payload.engine_state_available === true,
    awaitingSignatures: list("awaiting_signatures"),
    ready: list("ready"),
    recent: list("recent"),
  };
}

export async function listCommands(opts: { engineId?: string; status?: string } = {}): Promise<FailsafeCommand[]> {
  const params = new URLSearchParams();
  if (opts.engineId) params.set("engine_id", opts.engineId);
  if (opts.status) params.set("status", opts.status);
  const query = params.toString() ? `?${params.toString()}` : "";
  const response = await call(`/api/failsafe/commands/${query}`);
  if (!response.ok) {
    throw new FailsafeUnavailable(
      `the control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>[];
  return Array.isArray(payload) ? payload.map(command) : [];
}

/**
 * Draft a command. A refusal (a 403 for terminate from a non-admin service
 * account, say) is returned to the caller with its reason so the console can
 * show exactly why, rather than swallowing it into a generic failure.
 */
export async function draftCommand(input: {
  action: string;
  engineId: string;
  reason: string;
}): Promise<{ ok: true; drafted: DraftedCommand } | { ok: false; status: number; detail: string }> {
  const response = await call("/api/failsafe/commands/", {
    method: "POST",
    body: JSON.stringify({ action: input.action, engine_id: input.engineId, reason: input.reason }),
  });
  if (response.status === 403 || response.status === 400) {
    return { ok: false, status: response.status, detail: await body(response) };
  }
  if (!response.ok) {
    throw new FailsafeUnavailable(
      `the control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  return {
    ok: true,
    drafted: {
      command: command(payload),
      signingBytes: typeof payload.signing_bytes === "string" ? payload.signing_bytes : "",
      draft: draftFrom(payload),
    },
  };
}

export async function getCommand(uuid: string): Promise<DraftedCommand | null> {
  const response = await call(`/api/failsafe/commands/${encodeURIComponent(uuid)}/`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new FailsafeUnavailable(
      `the control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  return {
    command: command(payload),
    signingBytes: typeof payload.signing_bytes === "string" ? payload.signing_bytes : "",
    draft: draftFrom(payload),
  };
}

/**
 * Relay one out-of-band operator signature. A rejected signature (bad key,
 * forged, already signed) is a result the operator needs verbatim, so a 400/409
 * is returned rather than thrown.
 */
export async function submitSignature(
  uuid: string,
  signature: { keyId: string; sig: string },
): Promise<{ ok: true; command: FailsafeCommand } | { ok: false; status: number; detail: string }> {
  const response = await call(`/api/failsafe/commands/${encodeURIComponent(uuid)}/signatures/`, {
    method: "POST",
    body: JSON.stringify({ key_id: signature.keyId, sig: signature.sig }),
  });
  if (response.status === 400 || response.status === 409) {
    return { ok: false, status: response.status, detail: await body(response) };
  }
  if (!response.ok) {
    throw new FailsafeUnavailable(
      `the control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return { ok: true, command: command((await response.json()) as Record<string, unknown>) };
}

export async function cancelCommand(
  uuid: string,
): Promise<{ ok: true; command: FailsafeCommand } | { ok: false; status: number; detail: string }> {
  const response = await call(`/api/failsafe/commands/${encodeURIComponent(uuid)}/cancel/`, {
    method: "POST",
  });
  if (response.status === 403 || response.status === 409) {
    return { ok: false, status: response.status, detail: await body(response) };
  }
  if (!response.ok) {
    throw new FailsafeUnavailable(
      `the control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  return { ok: true, command: command((await response.json()) as Record<string, unknown>) };
}

export async function audit(opts: { command?: string } = {}): Promise<FailsafeAuditEvent[]> {
  const query = opts.command ? `?command=${encodeURIComponent(opts.command)}` : "";
  const response = await call(`/api/failsafe/audit/${query}`);
  if (!response.ok) {
    throw new FailsafeUnavailable(
      `the control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>[];
  return Array.isArray(payload) ? payload.map(auditEvent) : [];
}

/** Test seam: forget any cached access token. */
export function _resetForTests(): void {
  cachedAccess = null;
}
