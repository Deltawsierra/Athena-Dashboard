/**
 * A minimal service-account client for the Athena control plane (Athena-Backend).
 *
 * The dashboard's own Express+SQLite server is what the browser talks to; the
 * control plane is the separate Django backend that is the *system of record*
 * for assurance — deployments, findings, evidence, the six-state decision, and
 * the Unknowns Register. This module is the one place that reaches it, so a
 * caller (see server/assurance.ts) never has to know two origins or two auth
 * schemes: it hands this a backend path and gets a `fetch` Response back.
 *
 * Trust model: this holds a *service account*, not an operator's key. The
 * backend authenticates with SimpleJWT; this exchanges a configured credential
 * for a short-lived access token, caches it, and re-obtains it on expiry. The
 * credential decides who may read and draft against the backend and nothing
 * more — every consequential failsafe command still needs out-of-band operator
 * signatures the engine verifies (see server/failsafe.ts, which predates this
 * and keeps its own copy of the same dance; new code shares this one).
 *
 * Configured from the environment (ATHENA_FAILSAFE_*), not the in-app settings
 * row: the backend address and its service credential are a property of the
 * deployment, set once by whoever stands the backend up. The assurance API and
 * the failsafe API are the same Django backend, so they share one address and
 * one service account rather than duplicating the configuration.
 */

const URL_ENV = "ATHENA_FAILSAFE_URL";
const USER_ENV = "ATHENA_FAILSAFE_USER";
const PASSWORD_ENV = "ATHENA_FAILSAFE_PASSWORD";

/** How long any single call to the control plane may take. */
const TIMEOUT_MS = 15_000;

/** The most of the control plane's error body we will quote back. */
const MAX_ERROR_BODY = 500;

/**
 * The control plane is not there, not answering, or has no service credential.
 * A 503, not a 500: a fact about the deployment, not a bug in this server.
 */
export class ControlPlaneUnavailable extends Error {}

/** The configured backend base URL with any trailing slash removed, or null. */
export function baseUrl(): string | null {
  const raw = (process.env[URL_ENV] ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function isConfigured(): boolean {
  return baseUrl() !== null;
}

let cachedAccess: string | null = null;

/** Quote at most the first `MAX_ERROR_BODY` bytes of a response body. */
export async function body(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_ERROR_BODY);
  } catch {
    return "";
  }
}

async function obtainAccessToken(base: string): Promise<string> {
  const username = (process.env[USER_ENV] ?? "").trim();
  const password = process.env[PASSWORD_ENV] ?? "";
  if (!username || !password) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane is configured at ${base}, but no service ` +
        `credential is set; set ${USER_ENV} and ${PASSWORD_ENV} to an ` +
        `operator account the backend knows`,
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
    throw new ControlPlaneUnavailable(`could not reach the Athena control plane at ${base}: ${why}`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane rejected the service credential; check ${USER_ENV} and ${PASSWORD_ENV}`,
    );
  }
  if (!response.ok) {
    throw new ControlPlaneUnavailable(
      `the Athena control plane answered ${response.status} when obtaining a token: ${await body(response)}`,
    );
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const access = payload && typeof payload.access === "string" ? payload.access : null;
  if (!access) {
    throw new ControlPlaneUnavailable("the Athena control plane returned no access token");
  }
  cachedAccess = access;
  return access;
}

/**
 * Call a backend route, authenticated by the cached service token.
 *
 * A 401 means the short-lived token expired, so this obtains a fresh one and
 * retries exactly once. Any other non-ok answer is the caller's to interpret —
 * a 403 is a real "you may not do this", not something to retry.
 */
export async function call(path: string, init: RequestInit = {}, retryAuth = true): Promise<Response> {
  const base = baseUrl();
  if (!base) {
    throw new ControlPlaneUnavailable(
      `no Athena control plane is configured; set ${URL_ENV} to the backend's address`,
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
    throw new ControlPlaneUnavailable(`could not reach the Athena control plane at ${base}: ${why}`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 && retryAuth) {
    cachedAccess = null;
    await obtainAccessToken(base);
    return call(path, init, false);
  }
  return response;
}

/** Test seam: forget any cached access token. */
export function _resetForTests(): void {
  cachedAccess = null;
}
