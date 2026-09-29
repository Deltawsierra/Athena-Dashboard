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
 * for a short-lived access token, caches it, and renews it on expiry -- by the
 * refresh token its sign-in issued, and by the password only when that fails.
 * The credential decides who may read and draft against the backend and nothing
 * more — every consequential failsafe command still needs out-of-band operator
 * signatures the engine verifies (see server/failsafe.ts, which predates this
 * and keeps its own copy of the same dance; new code shares this one).
 *
 * A stop sent through here (a deployment paused, a claim revoked or
 * contradicted: `stop` on call) presents the failsafe service token as well,
 * when one is configured, and waits on no sign-in
 * (server/failsafe-service-token.ts).
 *
 * Configured from the environment (ATHENA_FAILSAFE_*), not the in-app settings
 * row: the backend address and its service credential are a property of the
 * deployment, set once by whoever stands the backend up. The assurance API and
 * the failsafe API are the same Django backend, so they share one address and
 * one service account rather than duplicating the configuration.
 */

import { SERVICE_TOKEN_HEADER, serviceToken, withoutServiceToken } from "./failsafe-service-token";

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

/**
 * The request itself was sent and no answer came back (the connection failed
 * or was cut): it may have reached the backend, and may have been acted on.
 * Unlike every other ControlPlaneUnavailable -- no address, no credential, no
 * token -- which is raised before the request is sent.
 */
export class ControlPlaneUnanswered extends ControlPlaneUnavailable {}

/** The configured backend base URL with any trailing slash removed, or null. */
export function baseUrl(): string | null {
  const raw = (process.env[URL_ENV] ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function isConfigured(): boolean {
  return baseUrl() !== null;
}

let cachedAccess: string | null = null;
/**
 * The refresh token the last sign-in or refresh answered with, or null. The
 * backend rotates it on every refresh and blacklists the one spent, so the one
 * each refresh answers with is the one kept and used next. A refresh that
 * fails is not tried again: the password is.
 */
let cachedRefresh: string | null = null;
/**
 * The renewal in flight, shared by every call that needs a token: two
 * refreshes with one refresh token would spend it twice, and the backend
 * answers only the first.
 */
let tokenInFlight: Promise<string> | null = null;
/** Bumped by _resetForTests: a token obtained for an earlier generation is not cached. */
let generation = 0;

/** Quote at most the first `MAX_ERROR_BODY` bytes of a response body. */
export async function body(response: Response): Promise<string> {
  try {
    return withoutServiceToken(await response.text()).slice(0, MAX_ERROR_BODY);
  } catch {
    return "";
  }
}

/** An access token, and the refresh token that renews it (null when the answer carried none). */
interface Tokens {
  access: string;
  refresh: string | null;
}

/** The access token in hand, or the one being obtained now for every caller. */
function accessToken(base: string): Promise<string> {
  if (cachedAccess !== null) return Promise.resolve(cachedAccess);
  if (tokenInFlight === null) {
    const mine = generation;
    const refresh = cachedRefresh;
    const obtained = renewTokens(base, refresh).then(
      (tokens) => {
        if (mine === generation) {
          cachedAccess = tokens.access;
          cachedRefresh = tokens.refresh;
        }
        return tokens.access;
      },
      (cause: unknown) => {
        // The refresh token was refused (and the password after it): it is not tried again.
        if (mine === generation && refresh !== null && cachedRefresh === refresh) cachedRefresh = null;
        throw cause;
      },
    );
    tokenInFlight = obtained;
    const clear = () => { if (tokenInFlight === obtained) tokenInFlight = null; };
    obtained.then(clear, clear);
  }
  return tokenInFlight;
}

/** A new access token: by the refresh token when one is held, and by the password only when there is none or the refresh fails. */
async function renewTokens(base: string, refresh: string | null): Promise<Tokens> {
  if (refresh !== null) {
    try {
      return await refreshTokens(base, refresh);
    } catch (cause) {
      console.warn(`[control-plane] the service account's token could not be refreshed (${cause instanceof Error ? cause.message : String(cause)}); ` +
        "signing in with its password instead");
    }
  }
  return signIn(base);
}

/**
 * Renew by the refresh token (SimpleJWT /api/token/refresh/). The rotated
 * refresh token in the answer is the one returned; an answer without one
 * leaves the one sent in use. Headers and body within TIMEOUT_MS.
 */
async function refreshTokens(base: string, refresh: string): Promise<Tokens> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${base}/api/token/refresh/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh }),
        signal: controller.signal,
      });
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      throw new ControlPlaneUnavailable(`could not reach the Athena control plane at ${base}: ${why}`);
    }
    if (!response.ok) {
      throw new ControlPlaneUnavailable(`the Athena control plane answered ${response.status} to the refresh: ${await body(response)}`);
    }
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const access = payload && typeof payload.access === "string" && payload.access ? payload.access : null;
    if (!access) {
      throw new ControlPlaneUnavailable("the Athena control plane's refresh returned no access token");
    }
    return { access, refresh: typeof payload?.refresh === "string" && payload.refresh ? payload.refresh : refresh };
  } finally {
    clearTimeout(timer);
  }
}

/** Sign in with the service account's password (SimpleJWT /api/token/). Headers and body within TIMEOUT_MS. */
async function signIn(base: string): Promise<Tokens> {
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
  try {
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
    return { access, refresh: typeof payload?.refresh === "string" && payload.refresh ? payload.refresh : null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a call sends: fetch's own options, and `stop` -- the request is a stop
 * by the backend's own judgement (athena-backend safety/stops.py: a
 * deployment's recompute with `paused` true, a claim's transition to revoked
 * or contradicted), so it presents the failsafe service token, when one is
 * configured, and waits on no sign-in. Never set on anything else.
 */
export type CallInit = RequestInit & { stop?: boolean };

/**
 * Call a backend route, authenticated by the cached service token.
 *
 * A stop (`init.stop`) presents the failsafe service token as well, when one is
 * configured, and is sent AT ONCE: it waits for no token. A token already in
 * hand rides along, so a service token the backend does not take still leaves
 * the stop the path every other call has.
 *
 * A 401 means no credential sent was taken -- the short-lived token expired, or
 * a stop's service token was refused with no token in hand -- so this obtains
 * a fresh one and retries exactly once. Any other non-ok answer is the
 * caller's to interpret — a 403 is a real "you may not do this", not
 * something to retry.
 */
export async function call(path: string, init: CallInit = {}, retryAuth = true): Promise<Response> {
  const base = baseUrl();
  if (!base) {
    throw new ControlPlaneUnavailable(
      `no Athena control plane is configured; set ${URL_ENV} to the backend's address`,
    );
  }
  const { stop, ...request } = init;
  // SAFETY: a stop with the service token waits on no sign-in and no refresh --
  // failing, throttled, locked or hung -- so none of them holds it back or drops it.
  const presented = stop ? serviceToken() : null;
  const access = presented !== null ? cachedAccess : await accessToken(base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...request,
      headers: {
        "Content-Type": "application/json",
        ...(access !== null ? { Authorization: `Bearer ${access}` } : {}),
        ...(request.headers ?? {}),
        ...(presented !== null ? { [SERVICE_TOKEN_HEADER]: presented } : {}),
      },
      signal: controller.signal,
    });
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new ControlPlaneUnanswered(`could not reach the Athena control plane at ${base}: ${why}`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 && retryAuth) {
    if (access !== null && cachedAccess === access) cachedAccess = null;
    await accessToken(base);
    return call(path, init, false);
  }
  return response;
}

/** Test seam: forget any cached token. */
export function _resetForTests(): void {
  cachedAccess = null;
  cachedRefresh = null;
  tokenInFlight = null;
  generation += 1;
}
