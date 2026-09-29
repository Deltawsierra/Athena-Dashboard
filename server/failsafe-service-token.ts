/**
 * The failsafe service token: how this server's stops reach the control plane
 * without a password sign-in.
 *
 * Every stop this server relays to Athena-Backend -- a failsafe pause,
 * stand-down or terminate, a signature on one, a deployment paused, a claim
 * revoked or contradicted, and the reads a second operator stops from -- went
 * as the service account, whose token was got by signing in with a password
 * (/api/token/). Sign-in is not a stop: the backend throttles it, guesses at
 * the service username lock it, a changed password or a fault in the account
 * table refuses it, and it can hang. Each of those held back, or dropped,
 * every stop that needed a token first.
 *
 * The backend accepts a pre-shared secret instead: FAILSAFE_SERVICE_TOKEN, in
 * the `X-Failsafe-Service-Token` header (athena-backend safety/service_token.py).
 * It authenticates it before any other credential, as its FAILSAFE_SERVICE_USER,
 * and ONLY on a request that is a stop on a route a stop client relays stops
 * on (SERVICE_ROUTES, judged by safety/stops.py is_stop). Anywhere else, and
 * when it does not match, the header is ignored and the request takes the
 * normal path. So this server sends it on the stops and on nothing else (the
 * calls marked `stop` in server/failsafe.ts and server/assurance.ts), and a
 * stop that carries it waits on no sign-in (server/failsafe.ts `call`).
 *
 * Configured from the environment like the rest of the control-plane
 * connection, and read once, at start-up (the entry points; on first use when
 * nothing read it before, as in the tests). It is a secret: it is never
 * logged, never put in an answer and never sent to the browser. A value the
 * backend would treat as unset (shorter than its MIN_TOKEN_LENGTH), or one no
 * HTTP header can carry, is not sent at all -- sending it would fail every
 * stop -- and start-up says so, without the value.
 */

export const SERVICE_TOKEN_ENV = "ATHENA_FAILSAFE_SERVICE_TOKEN";
export const SERVICE_TOKEN_HEADER = "X-Failsafe-Service-Token";

/** The backend treats a shorter token as unset (athena-backend safety/service_token.py MIN_TOKEN_LENGTH). */
export const MIN_SERVICE_TOKEN_LENGTH = 32;

/** What an HTTP header value can carry: printable ASCII. */
const HEADER_SAFE = /^[\x20-\x7e]+$/;

let loaded = false;
let token: string | null = null;

/**
 * Read the token from the environment. Called at start-up by the entry
 * points, before the server takes a request. Says whether one is in use, and
 * why not when one is set but cannot be -- never what it is.
 */
export function loadServiceToken(): void {
  loaded = true;
  token = null;
  const raw = (process.env[SERVICE_TOKEN_ENV] ?? "").trim();
  if (!raw) return;
  if (raw.length < MIN_SERVICE_TOKEN_LENGTH || !HEADER_SAFE.test(raw)) {
    console.warn(
      `[failsafe] ${SERVICE_TOKEN_ENV} is set but is not used: ` +
        (raw.length < MIN_SERVICE_TOKEN_LENGTH
          ? `it is shorter than the ${MIN_SERVICE_TOKEN_LENGTH} characters the control plane requires, so the control plane would ignore it`
          : "it holds a character an HTTP header cannot carry") +
        ". Stops sign in with the service account, as they do without it.",
    );
    return;
  }
  token = raw;
  console.log(`[failsafe] stops sent to the control plane present the failsafe service token (${SERVICE_TOKEN_ENV}) and wait on no sign-in`);
}

/** The token a stop presents, or null when none is configured. */
export function serviceToken(): string | null {
  if (!loaded) loadServiceToken();
  return token;
}

/**
 * Text quoted from the control plane -- an error body passed on to the page
 * or the log -- with the token taken out, should anything between here and
 * the backend echo the request's headers back.
 */
export function withoutServiceToken(text: string): string {
  const secret = serviceToken();
  return secret ? text.split(secret).join("[the failsafe service token]") : text;
}
