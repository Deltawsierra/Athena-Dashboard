/**
 * Each signed-in person's own Athena-Backend sign-in (T6, the owner's decision 8).
 *
 * This server used to reach the backend for every read and every write as ONE
 * service account (analyst or admin, which sees every tenant), and passed on
 * any deployment uuid a signed-in person named: one dashboard user could read
 * another tenant's reports, events and ROI by uuid. Now everything that is not
 * a stop goes to the backend as the person who asked, with their own token, so
 * the backend's own tenant scoping (`visible_deployments`: an owner sees only
 * their own deployments) and its role checks apply to them, and every action is
 * attributed to them (a reviewer and an approver are two people, not the
 * service account twice: Athena-Backend #169).
 *
 * How a person gets a credential:
 *
 *   - At sign-in to this console (POST /api/auth/login), once the password has
 *     been verified here, the same username and password are sent to the
 *     backend's sign-in (SimpleJWT /api/token/) IN THE BACKGROUND: the sign-in
 *     here is answered at once and never waits on the backend, so a backend
 *     that is slow, throttling or down never keeps a person from the kill
 *     switch or a Stop. The password is held only by that request, for as long
 *     as it takes, and never stored.
 *   - Or with POST /api/auth/backend-sign-in and the person's password on the
 *     backend, when it is not the one they use here, or the backend could not
 *     be reached when they signed in.
 *
 * Where it is kept: in this server's memory, keyed by the session's id -- the
 * session store is this server's memory too (app.ts) -- never in the session
 * cookie, never in an answer, never in a URL, and never in the browser. The
 * browser holds only the httpOnly session cookie it held before.
 *
 * Renewal: an access token the backend refuses (401) is renewed with the
 * person's refresh token, once, shared by every request of the session at that
 * moment (the backend rotates the refresh token and blacklists the one spent:
 * two refreshes with one token would sign the person out). A refresh the backend
 * refuses ends the credential: the person signs in to the backend again. There
 * is no password to fall back on, and never the service account.
 *
 * Revocation: when a session ends -- signing out, signing in again, an admin
 * deactivating or removing the account, a password change ending the other
 * sessions (every one of them destroys the session in the store: app.ts) -- its
 * refresh token is revoked at the backend (POST /api/token/revoke/), in the
 * background, so signing out never waits on the backend either.
 *
 * SAFETY: none of this is on a stop's path. A stop -- a failsafe pause,
 * stand-down or terminate, a signature on one, a resume or release withdrawn,
 * the stop lane's reads, a deployment paused, a claim revoked or contradicted --
 * goes exactly as before, with the failsafe service token and the service
 * account (server/control-plane.ts and server/failsafe.ts `call`, `stop`), and
 * never reads, waits for or renews a person's credential. A person whose
 * backend sign-in is stale, refused, or still in flight sends every stop as
 * before. Establishing the person on a request (`asThePerson`) is synchronous
 * and reads nothing.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

/** The backend's address: the same variable the control-plane clients read (server/control-plane.ts). */
const URL_ENV = "ATHENA_FAILSAFE_URL";

/** How long one sign-in, refresh or revocation may take, headers and body together. */
const TIMEOUT_MS = 15_000;

/** The most of a backend refusal quoted into a reason. */
const MAX_QUOTE = 300;

/** The code every answer carries when a request needs the person's backend sign-in and there is none. */
export const SIGN_IN_REQUIRED = "backend_sign_in_required";

/** The backend's route that revokes a refresh token (athena-backend safety/revoke.py). */
export const REVOKE_PATH = "/api/token/revoke/";

/**
 * A request that goes to the backend as the person, who has no credential the
 * backend takes: why, in words. Never a 401 to the browser -- that would send
 * the person back to this console's sign-in screen, away from the kill switch --
 * but an answer with SIGN_IN_REQUIRED, which the views show as it is.
 */
export class PersonSignInRequired extends Error {
  readonly code = SIGN_IN_REQUIRED;
}

/** The backend could not be reached to sign the person in or renew their token: unavailability, not a refusal. */
export class PersonCredentialUnavailable extends Error {}

/** A person's credential, as this server holds it. */
interface Held {
  /** The username the backend signed in. */
  username: string;
  access: string | null;
  refresh: string | null;
  /** When the refresh token expires (its JWT `exp`), in ms since the epoch; null when it names none. */
  until: number | null;
  /** The sign-in or the refresh in flight, shared by every request of this session. */
  pending: Promise<void> | null;
  /** Why there is no credential the backend takes, in words; null while there is one or one is coming. */
  missing: string | null;
  /** Whether the backend answered the last sign-in with a refusal (4xx), rather than not at all. */
  refused: boolean;
}

/** Every person's credential, by the id of the session it belongs to. */
const held = new Map<string, Held>();

/** The session whose person a request is served for: null for a request with no signed-in session (an API key). */
const persons = new AsyncLocalStorage<{ sessionId: string | null }>();

function baseUrl(): string | null {
  const raw = (process.env[URL_ENV] ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

const NO_SESSION =
  "this request carries no signed-in session (an API key has no Athena-Backend sign-in of its own), so nothing is " +
  "read from or sent to Athena-Backend for it: sign in to this console";
const NOT_SIGNED_IN =
  "you are not signed in to Athena-Backend on this console: sign in to Athena-Backend with your password there, " +
  "or sign out of this console and in again";
const ENDED =
  "your sign-in to Athena-Backend has ended (it no longer renews it): sign in to Athena-Backend again with your " +
  "password there, or sign out of this console and in again";

/**
 * Middleware: serve the rest of the request as its person -- the signed-in
 * session's -- so every backend call it makes that is not a stop goes with
 * their credential. Synchronous, and reads nothing: a stop passes through it
 * at once.
 */
export const asThePerson: RequestHandler = (req, _res, next) => {
  const sessionId = req.session?.userId ? req.sessionID : null;
  persons.run({ sessionId }, () => next());
};

/** Run `fn` as the person of session `sessionId` (null: no person). For a caller outside a request, and tests. */
export function runAsPerson<T>(sessionId: string | null, fn: () => T): T {
  return persons.run({ sessionId }, fn);
}

function currentSession(): string | null {
  return persons.getStore()?.sessionId ?? null;
}

/** When a JWT expires, from its `exp` claim, in ms since the epoch; null when it names none. */
function expiryOf(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Credentials whose refresh token has expired renew nothing: forgotten (nothing to revoke). */
function prune(now = Date.now()): void {
  const lapsed: string[] = [];
  held.forEach((one, sessionId) => {
    if (one.pending === null && one.until !== null && one.until <= now) lapsed.push(sessionId);
  });
  for (const sessionId of lapsed) held.delete(sessionId);
}

/** A POST of JSON to the backend, headers and body read within TIMEOUT_MS. */
async function post(base: string, path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> | null; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body, text };
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new PersonCredentialUnavailable(`Athena-Backend could not be reached at ${base}: ${why}`);
  } finally {
    clearTimeout(timer);
  }
}

/** A refusal's own words (its `detail`), bounded; never a token, which no refusal of these routes carries. */
function quoted(answer: { body: Record<string, unknown> | null }): string {
  const detail = answer.body && typeof answer.body.detail === "string" ? answer.body.detail : "";
  return detail.slice(0, MAX_QUOTE);
}

/** The two tokens in a sign-in's or a refresh's answer, or null when it carries no access token. */
function tokensOf(answer: { body: Record<string, unknown> | null }, refreshSent: string | null): { access: string; refresh: string | null } | null {
  const access = answer.body && typeof answer.body.access === "string" && answer.body.access ? answer.body.access : null;
  if (access === null) return null;
  const refresh = answer.body && typeof answer.body.refresh === "string" && answer.body.refresh ? answer.body.refresh : refreshSent;
  return { access, refresh };
}

/**
 * Revoke a refresh token at the backend. Never throws, and nothing waits on
 * it: a session that ends is ended here whether or not the backend answers.
 * A backend without the route (an older one) is said in the log: the token
 * then lapses at its own expiry, held by nobody.
 */
async function revoke(refresh: string): Promise<void> {
  const base = baseUrl();
  if (!base) return;
  try {
    const answer = await post(base, REVOKE_PATH, { refresh });
    if (answer.status === 404) {
      console.warn(`[person] Athena-Backend has no ${REVOKE_PATH} route: a signed-out person's refresh token lapses at its own expiry, held by nobody`);
    } else if (answer.status >= 300) {
      console.warn(`[person] Athena-Backend answered ${answer.status} to revoking a signed-out person's refresh token${quoted(answer) ? `: ${quoted(answer)}` : ""}`);
    }
  } catch (cause) {
    console.warn(`[person] a signed-out person's refresh token could not be revoked: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** Revocations sent and not yet answered (tests wait on them). */
const revocations = new Set<Promise<void>>();

function revokeInBackground(refresh: string | null): void {
  if (refresh === null) return;
  const sent = revoke(refresh);
  revocations.add(sent);
  void sent.finally(() => revocations.delete(sent));
}

/** Why the backend's sign-in refused, in words for the person. */
function signInRefusal(answer: { status: number; body: Record<string, unknown> | null }): string {
  if (answer.status === 401 || answer.status === 400) {
    return "Athena-Backend did not accept your username and password: an account of the same username is needed there. " +
      "If its password is not the one you use here, sign in to Athena-Backend with that password";
  }
  if (answer.status === 429) {
    return `Athena-Backend refused the sign-in for now (too many sign-ins${quoted(answer) ? `: ${quoted(answer)}` : ""}): try again shortly`;
  }
  return `Athena-Backend answered ${answer.status} to the sign-in${quoted(answer) ? ` (${quoted(answer)})` : ""}: try again shortly`;
}

/**
 * Sign session `sessionId`'s person in to the backend with `username` and
 * `password`, replacing any credential it held (that one is revoked). Resolves
 * when the backend has answered, or could not be reached, with the person's
 * state; never rejects. Nothing is done when no backend is configured.
 */
export function signInPerson(sessionId: string, username: string, password: string): Promise<PersonState & { refused: boolean }> {
  const base = baseUrl();
  if (!base) return Promise.resolve({ ...personState(sessionId), refused: false });
  prune();
  const previous = held.get(sessionId);
  const one: Held = { username, access: null, refresh: null, until: null, pending: null, missing: null, refused: false };
  held.set(sessionId, one);
  if (previous) {
    // A session signing in again: the credential it held is revoked (or, still being got, revoked on arrival).
    if (previous.pending === null) revokeInBackground(previous.refresh);
  }
  const attached = () => held.get(sessionId) === one;
  one.pending = post(base, "/api/token/", { username, password }).then(
    (answer) => {
      const tokens = answer.status === 200 ? tokensOf(answer, null) : null;
      if (!attached()) {
        // The session ended while the sign-in was in flight: what it got is revoked at once.
        revokeInBackground(tokens?.refresh ?? null);
        return;
      }
      if (tokens === null) {
        one.missing = answer.status === 200 ? "Athena-Backend's sign-in answered with no access token" : signInRefusal(answer);
        one.refused = answer.status >= 400 && answer.status < 500;
        return;
      }
      one.access = tokens.access;
      one.refresh = tokens.refresh;
      one.until = tokens.refresh ? expiryOf(tokens.refresh) : null;
    },
    (cause: unknown) => {
      if (attached()) one.missing = `${cause instanceof Error ? cause.message : String(cause)}: you are not signed in to it`;
    },
  ).finally(() => {
    one.pending = null;
  });
  return one.pending.then(() => ({ ...personState(sessionId), refused: one.refused }));
}

/** The credential of session `sessionId` once nothing is in flight for it, or undefined. */
async function settled(sessionId: string): Promise<Held | undefined> {
  for (;;) {
    const one = held.get(sessionId);
    if (!one || one.pending === null) return one;
    await one.pending.catch(() => undefined);
  }
}

/**
 * The access token the person being served presents to the backend.
 * PersonSignInRequired when there is no person (no signed-in session) or the
 * person holds no credential the backend takes; it waits for a sign-in or a
 * refresh in flight. Never the service account's.
 */
export async function personAccessToken(): Promise<string> {
  const sessionId = currentSession();
  if (sessionId === null) throw new PersonSignInRequired(NO_SESSION);
  if (baseUrl() === null) throw new PersonCredentialUnavailable("no Athena control plane is configured");
  const one = await settled(sessionId);
  if (!one) throw new PersonSignInRequired(NOT_SIGNED_IN);
  if (one.access === null) throw new PersonSignInRequired(one.missing ?? NOT_SIGNED_IN);
  return one.access;
}

/**
 * The backend refused `rejected` (401): a new access token for the person,
 * by their refresh token -- once for the session, however many of its requests
 * were refused together. A refresh the backend refuses ends the credential
 * (PersonSignInRequired); one that cannot reach the backend keeps the refresh
 * token for the next try (PersonCredentialUnavailable).
 */
export async function renewPersonToken(rejected: string | null): Promise<string> {
  const sessionId = currentSession();
  if (sessionId === null) throw new PersonSignInRequired(NO_SESSION);
  const base = baseUrl();
  if (base === null) throw new PersonCredentialUnavailable("no Athena control plane is configured");
  // Wait out whatever is in flight, and decide in the SAME turn that finds nothing
  // in flight: from that check to `one.pending` being set below there is no await,
  // so two renewals asked for together cannot both start a refresh (the second
  // would spend a token the first already spent, and end the person's sign-in).
  let one: Held | undefined;
  for (;;) {
    one = held.get(sessionId);
    if (!one || one.pending === null) break;
    await one.pending.catch(() => undefined);
  }
  if (!one) throw new PersonSignInRequired(NOT_SIGNED_IN);
  if (one.access !== null && one.access !== rejected) return one.access; // renewed by another request already
  if (one.refresh === null) {
    one.access = null;
    one.missing = one.missing ?? ENDED;
    throw new PersonSignInRequired(one.missing);
  }
  const spent = one.refresh;
  const attached = () => held.get(sessionId) === one;
  let unreachable: PersonCredentialUnavailable | null = null;
  one.pending = post(base, "/api/token/refresh/", { refresh: spent }).then(
    (answer) => {
      const tokens = answer.status === 200 ? tokensOf(answer, spent) : null;
      if (!attached()) {
        revokeInBackground(tokens?.refresh ?? null);
        return;
      }
      if (tokens === null) {
        one.access = null;
        one.refresh = null;
        one.missing = `${ENDED}${answer.status !== 200 ? ` (Athena-Backend answered ${answer.status} to the renewal${quoted(answer) ? `: ${quoted(answer)}` : ""})` : ""}`;
        return;
      }
      one.access = tokens.access;
      one.refresh = tokens.refresh;
      one.until = tokens.refresh ? expiryOf(tokens.refresh) : null;
    },
    (cause: unknown) => {
      unreachable = cause instanceof PersonCredentialUnavailable ? cause : new PersonCredentialUnavailable(String(cause));
      // Not reached, or no answer: the refresh token may be unspent; it is kept for the next try.
      if (!attached()) revokeInBackground(spent);
    },
  ).finally(() => {
    one.pending = null;
  });
  await one.pending;
  if (unreachable !== null) throw unreachable;
  // The session ended while the renewal was in flight: nothing is sent for it.
  if (!attached()) throw new PersonSignInRequired(NOT_SIGNED_IN);
  if (one.access === null) throw new PersonSignInRequired(one.missing ?? ENDED);
  return one.access;
}

/**
 * Session `sessionId` has ended: its person's credential is forgotten here at
 * once and its refresh token revoked at the backend in the background (one
 * still being got is revoked when it arrives). Called for every session the
 * store destroys (app.ts).
 */
export function forgetPerson(sessionId: string): void {
  const one = held.get(sessionId);
  if (!one) return;
  held.delete(sessionId);
  // In flight: its own completion sees the session gone and revokes what it got (or the token it held).
  if (one.pending === null) revokeInBackground(one.refresh);
}

/** Where a person stands with the backend, for the views (GET /api/auth/check, the assurance status). */
export interface PersonState {
  state: "not_configured" | "not_signed_in" | "signing_in" | "signed_in" | "sign_in_required";
  /** The username the backend signed in, while there is one. */
  username: string | null;
  detail: string;
}

export function personState(sessionId: string | null): PersonState {
  if (baseUrl() === null) {
    return { state: "not_configured", username: null, detail: "no Athena control plane is configured" };
  }
  if (sessionId === null) return { state: "sign_in_required", username: null, detail: NO_SESSION };
  const one = held.get(sessionId);
  if (!one) return { state: "not_signed_in", username: null, detail: NOT_SIGNED_IN };
  if (one.pending !== null && one.access === null) {
    return { state: "signing_in", username: one.username, detail: "signing you in to Athena-Backend" };
  }
  if (one.access !== null) {
    return { state: "signed_in", username: one.username, detail: `signed in to Athena-Backend as ${one.username}` };
  }
  return { state: "sign_in_required", username: one.username, detail: one.missing ?? NOT_SIGNED_IN };
}

/** The person being served now: their session's state with the backend. */
export function currentPersonState(): PersonState {
  return personState(currentSession());
}

/** Test seam: forget every credential (nothing is revoked). */
export function _resetPersonsForTests(): void {
  held.clear();
}

/** Test seam: resolves once every revocation sent so far has been answered or given up. */
export async function _revocationsSettled(): Promise<void> {
  while (revocations.size > 0) await Promise.allSettled(Array.from(revocations));
}

/** Test seam: how many credentials are held. */
export function _heldForTests(): number {
  return held.size;
}
