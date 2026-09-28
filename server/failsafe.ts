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

import http from "node:http";
import https from "node:https";
import * as dnsCache from "./dns-cache";

const FAILSAFE_URL_ENV = "ATHENA_FAILSAFE_URL";
const FAILSAFE_USER_ENV = "ATHENA_FAILSAFE_USER";
const FAILSAFE_PASSWORD_ENV = "ATHENA_FAILSAFE_PASSWORD";
const FAILSAFE_ENGINE_ID_ENV = "ATHENA_FAILSAFE_ENGINE_ID";

/**
 * The control plane is reached over node:http (https for an https address),
 * not global fetch (undici), for one reason: SAFETY.
 *
 * A stop's own call here -- drafting a pause/stand-down/terminate, relaying an
 * operator signature -- must never depend on a live libuv-threadpool
 * getaddrinfo. undici resolves DNS on a cold connection with no seam to pin
 * the address, so a sign-in flood's scrypt jobs (also on the threadpool) could
 * delay a failsafe stop exactly as they delayed the engine's when the failsafe
 * URL is a HOSTNAME and the socket is cold. node:http takes a `lookup`, which
 * reads the DNS cache (server/dns-cache.ts): the host is resolved once, off
 * the stop path, and every call connects to the cached address. The hostname
 * on the request is unchanged, so TLS SNI and certificate validation are
 * untouched, and the address the cache holds is exactly the one getaddrinfo
 * returned -- no host or allowlist check is weakened.
 *
 * Only the small surface the rest of this file uses is provided: `status`,
 * `ok`, `text()` (read once, within a deadline) and `body.cancel()` (let the
 * answer go -- its request is destroyed, so nothing holds a socket).
 */
interface ControlPlaneResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
  readonly body: { cancel(): Promise<void> };
}

/** What an authenticated call sends: its method, an optional JSON body, and any extra headers. */
type CallInit = { method?: string; headers?: Record<string, string>; body?: string };

/** One request to the control plane, answered with its headers. Rejects the way fetch did (a network error), and aborts on `signal`. */
function send(target: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<ControlPlaneResponse> {
  const url = new URL(target);
  const secure = url.protocol === "https:";
  return new Promise<ControlPlaneResponse>((resolve, reject) => {
    const req = (secure ? https : http).request(url, {
      method: init.method ?? "GET",
      headers: {
        ...(init.headers ?? {}),
        ...(init.body !== undefined ? { "Content-Length": Buffer.byteLength(init.body) } : {}),
      },
      signal: init.signal,
      // SAFETY: the cached address, so a stop's call never runs a live
      // threadpool getaddrinfo. See the note above and server/dns-cache.ts.
      lookup: dnsCache.lookup,
    }, (res) => {
      res.on("error", () => undefined);
      let reading: Promise<string> | null = null;
      const status = res.statusCode ?? 0;
      resolve({
        status,
        ok: status >= 200 && status < 300,
        text(): Promise<string> {
          if (reading === null) {
            reading = new Promise<string>((resolveText, rejectText) => {
              let raw = "";
              let ended = false;
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => { raw += chunk; });
              res.on("end", () => { ended = true; resolveText(raw); });
              res.on("close", () => { if (!ended) rejectText(new Error("the connection closed before the answer ended")); });
            });
          }
          return reading;
        },
        body: { cancel: async () => { req.destroy(); } },
      });
    });
    req.on("error", (cause) => reject(cause));
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/**
 * How long the control plane is waited for. `callMs`: for an answer's
 * headers (and for a token). `bodyMs`: for the rest of an answer once its
 * headers are in -- a body that stalls is given up on then, and its request
 * aborted, so it holds no request and no socket. `stopBodyMs`: the same for
 * the answer to a stop's own call (drafting a pause, stand-down or terminate;
 * relaying a signature), which has already been sent by then. `commandReadMs`:
 * the whole of the read a signature relay makes to learn its command's action
 * (connect, headers and body together) when the action is not already known
 * here -- a relay never waits on that read longer (readActionWithin). Tests
 * shorten these.
 */
export const failsafeTimeouts = { callMs: 15_000, bodyMs: 15_000, stopBodyMs: 2_000, commandReadMs: 250 };

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

/**
 * The service token is kept warm, so that a signature relay does not have to
 * obtain one first. Obtaining one is slow on the real control plane (Django's
 * PBKDF2 hasher, 1,000,000 iterations: 275 ms measured), and a relay's read of
 * its command is given 250 ms in all (readActionWithin): a read that had to
 * obtain a token first could not finish in time, so the first relay after
 * start-up, and after every expiry, was a "possible stop".
 *
 *   - One token is obtained at a time, whoever asks (tokenInFlight), and it is
 *     obtained for the cache, not for the caller: a caller that stops waiting
 *     (a read cut off at its deadline) leaves it running, and it is cached
 *     when it arrives -- the relay that follows uses it rather than asking
 *     again.
 *   - It is obtained again ahead of its expiry (the `exp` its JWT carries):
 *     a fifth of its lifetime early, at most a minute (tokenRefresh). A token
 *     that names no expiry is obtained again every tokenRefresh.unknownMs.
 *     A refresh that fails is tried again tokenRefresh.retryMs later; the
 *     token in hand is kept meanwhile. A token that already reads as expired
 *     (this clock ahead of the control plane's) is obtained again only
 *     tokenRefresh.retryMs later, never in a loop.
 *   - warmUp() obtains one at start-up.
 */
export const tokenRefresh = { maxEarlyMs: 60_000, unknownMs: 4 * 60_000, retryMs: 30_000, minMs: 1_000 };
let tokenInFlight: Promise<string> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by _resetForTests: a token obtained for an earlier generation is not cached. */
let generation = 0;

/** A token for the cache: the one being obtained now, or a new request for one. */
function freshToken(base: string): Promise<string> {
  if (tokenInFlight === null) {
    const mine = generation;
    const obtained = obtainAccessToken(base).then((access) => {
      if (mine === generation) {
        cachedAccess = access;
        scheduleRefresh(access);
      }
      return access;
    });
    tokenInFlight = obtained;
    const clear = () => { if (tokenInFlight === obtained) tokenInFlight = null; };
    obtained.then(clear, clear);
  }
  return tokenInFlight;
}

/** The cached token, or one being obtained; a caller's `signal` stops only its own wait, never the request. */
function accessToken(base: string, signal?: AbortSignal): Promise<string> {
  if (cachedAccess !== null) return Promise.resolve(cachedAccess);
  const token = freshToken(base);
  if (!signal) return token;
  if (signal.aborted) return Promise.reject(new FailsafeUnavailable("the wait for a service token was cut off"));
  return new Promise<string>((resolve, reject) => {
    const stop = () => reject(new FailsafeUnavailable("the wait for a service token was cut off"));
    signal.addEventListener("abort", stop, { once: true });
    token.then(
      (access) => { signal.removeEventListener("abort", stop); resolve(access); },
      (cause) => { signal.removeEventListener("abort", stop); reject(cause); },
    );
  });
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

function scheduleRefresh(access: string): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  const expires = expiryOf(access);
  const now = Date.now();
  const early = expires === null
    ? tokenRefresh.unknownMs
    : (expires - now) - Math.min(tokenRefresh.maxEarlyMs, (expires - now) / 5);
  // A token that reads as expired, or all but, when it arrives (this clock ahead of the control
  // plane's) is not asked for again at once, over and over: tokenRefresh.retryMs later instead.
  const inMs = early < tokenRefresh.minMs ? tokenRefresh.retryMs : early;
  refreshTimer = setTimeout(() => refreshNow(), inMs);
  refreshTimer.unref?.();
}

function refreshNow(): void {
  refreshTimer = null;
  const base = baseUrl();
  if (!base) return;
  // The token in hand stays in use until a new one arrives.
  freshToken(base).catch((cause) => {
    console.warn(`[failsafe] the service token could not be obtained again ahead of its expiry ` +
      `(${cause instanceof Error ? cause.message : String(cause)}); trying again in ${Math.round(tokenRefresh.retryMs / 1000)} s`);
    if (refreshTimer === null) {
      refreshTimer = setTimeout(() => refreshNow(), tokenRefresh.retryMs);
      refreshTimer.unref?.();
    }
  });
}

/**
 * Obtain the service token now, and the actions of the commands the control
 * plane lists (remember): called at start-up, so that neither the first
 * relay's read nor its token waits on the control plane. Never throws; a
 * failure is logged, and the next call tries again.
 */
export function warmUp(): void {
  const base = baseUrl();
  if (!base) return;
  // SAFETY: resolve the control plane's address now and keep it warm in the
  // DNS cache, off the stop path, so a failsafe stop's cold connection never
  // runs a live threadpool getaddrinfo behind a sign-in flood. The URL is a
  // deployment property (the environment, not a live-editable settings row),
  // but it is re-read each tick anyway, and the timer is a single unref'd one.
  primeFailsafeHost();
  if (warmTimer === null) {
    warmTimer = setInterval(primeFailsafeHost, dnsCache.TTL_MS);
    warmTimer.unref?.();
  }
  freshToken(base)
    .then(() => listCommands())
    .catch((cause) => {
      console.warn(`[failsafe] the control plane could not be reached at start-up (${cause instanceof Error ? cause.message : String(cause)}); ` +
        "the first call will try again");
    });
}

let warmTimer: ReturnType<typeof setInterval> | null = null;

function primeFailsafeHost(): void {
  void primeNow();
}

/**
 * Prime the control plane's address now, AWAITABLY -- for the boot race. An
 * entry point awaits this before the server accepts requests, so the very
 * first failsafe Stop reads a cached address and never runs a live threadpool
 * getaddrinfo behind a sign-in flood. Resolves when the prime settles; never
 * rejects. An unparseable URL is surfaced when a call is actually made.
 */
export function primeNow(): Promise<void> {
  const base = baseUrl();
  if (!base) return Promise.resolve();
  try {
    const host = new URL(base).hostname;
    return host ? dnsCache.prime(host) : Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}

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
  const timer = setTimeout(() => controller.abort(), failsafeTimeouts.callMs);
  let response: ControlPlaneResponse;
  try {
    response = await send(`${base}/api/token/`, {
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
  requestOf.set(response, controller);
  const payload = (await jsonWithin(response, failsafeTimeouts.bodyMs, "a token").catch(() => null)) as Record<string, unknown> | null;
  const access = payload && typeof payload.access === "string" ? payload.access : null;
  if (!access) {
    throw new FailsafeUnavailable("the failsafe control plane returned no access token");
  }
  return access;
}

/** A controller that is aborted when `outer` is: a call's own, tied to its caller's deadline. */
function linked(outer?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller;
}

/**
 * The request behind each answer: aborting it after the headers are in ends
 * the body's stream and closes its connection, so a stalled answer holds no
 * socket and no read.
 */
const requestOf = new WeakMap<ControlPlaneResponse, AbortController>();

/** The rest of an answer whose headers are in, or null when it did not arrive within `ms` (its request is then aborted). */
async function textWithin(response: ControlPlaneResponse, ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    const read = response.text().catch(() => null);
    const got = await Promise.race([read, late]);
    if (got === null) requestOf.get(response)?.abort();
    return got;
  } finally {
    clearTimeout(timer);
  }
}

/** An answer's JSON, read within `ms`: FailsafeUnavailable when it did not arrive, or did not parse. */
async function jsonWithin(response: ControlPlaneResponse, ms: number, what: string): Promise<unknown> {
  const raw = await textWithin(response, ms);
  if (raw === null) {
    throw new FailsafeUnavailable(
      `the control plane sent the headers of its answer to ${what} (${response.status}) but not the rest within ` +
      `${ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`}, so it could not be read`,
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new FailsafeUnavailable(`the control plane's answer to ${what} (${response.status}) could not be read`);
  }
}

async function body(response: ControlPlaneResponse): Promise<string> {
  return ((await textWithin(response, failsafeTimeouts.bodyMs)) ?? "").slice(0, MAX_ERROR_BODY);
}

/**
 * Call an operator route, authenticated by the cached service token.
 *
 * A 401 means the token expired (SimpleJWT access tokens are short-lived), so
 * this obtains a fresh one and retries exactly once. Any other non-ok answer is
 * the caller's to interpret -- a 403 from the backend is a real "you may not do
 * this", not something to retry.
 */
async function call(path: string, init: CallInit = {}, retryAuth = true, signal?: AbortSignal): Promise<ControlPlaneResponse> {
  const base = baseUrl();
  if (!base) {
    throw new FailsafeUnavailable(
      `no failsafe control plane is configured; set ${FAILSAFE_URL_ENV} to the backend's address`,
    );
  }
  const access = await accessToken(base, signal);
  const controller = linked(signal);
  const timer = setTimeout(() => controller.abort(), failsafeTimeouts.callMs);
  let response: ControlPlaneResponse;
  try {
    response = await send(`${base}${path}`, {
      method: init.method,
      body: init.body,
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
  requestOf.set(response, controller);
  if (response.status === 401 && retryAuth) {
    // Token expired mid-session; get a new one and try once more.
    void response.body?.cancel().catch(() => undefined);
    if (cachedAccess === access) cachedAccess = null;
    await accessToken(base, signal);
    return call(path, init, false, signal);
  }
  return response;
}

// ==== The actions of the commands this dashboard has proxied ====
//
// A command's action is fixed when it is drafted: it is part of the bytes its
// signers sign. So every command a draft, a list or a detail answer carries
// through here is remembered by its uuid with its action, and a signature relay for a command known here is
// decided from memory, with no read (routes.ts, POST .../signatures).

/** The failsafe actions that stop an engine. */
const STOP_ACTIONS = new Set(["pause", "stand_down", "terminate"]);
/** At most this many commands are remembered; the oldest is forgotten first. */
const KNOWN_ACTIONS_MAX = 10_000;
const knownActions = new Map<string, string>();

function remember(one: FailsafeCommand): FailsafeCommand {
  if (one.uuid && one.action) {
    knownActions.delete(one.uuid);
    knownActions.set(one.uuid, one.action);
    if (knownActions.size > KNOWN_ACTIONS_MAX) {
      const oldest = knownActions.keys().next().value;
      if (oldest !== undefined) knownActions.delete(oldest);
    }
  }
  return one;
}

/** The action of a command this dashboard has proxied, by its exact uuid; undefined when none has. */
export function knownActionOf(uuid: string): string | undefined {
  return knownActions.get(uuid);
}

/** A command's action as a signature relay learnt it (readActionWithin). */
export interface ActionRead {
  /** The action; null when it could not be learnt in time (`unread` says why). */
  action: string | null;
  from: "memory" | "read";
  unread?: string;
  /**
   * When the read ran past its deadline: the read itself, which is not cut
   * off but goes on to its own limits (failsafeTimeouts.callMs, bodyMs) and
   * settles with the action it learnt, or null with why not. The relay acts
   * on it once it settles (routes.ts, a possible stop that turns out to be a
   * resume or a release is withdrawn).
   */
  later?: Promise<{ action: string | null; unread?: string }>;
}

/**
 * A command's action as a signature relay needs it: from memory when this
 * dashboard has proxied the command (no read), otherwise read from the
 * control plane, waited for at most `ms` in all -- connect, token, headers
 * and body. `action` is null when it could not be learnt in time (`unread`
 * says why); the relay is never held longer. A read still going at `ms` is
 * not cut off: it goes on in the background (`later`), and whatever it
 * learns is remembered -- and its token, if it was obtaining one, cached.
 */
export async function readActionWithin(uuid: string, ms: number = failsafeTimeouts.commandReadMs): Promise<ActionRead> {
  const known = knownActions.get(uuid);
  if (known !== undefined) return { action: known, from: "memory" };
  const read = getCommand(uuid).then(
    (drafted) => drafted
      ? { action: drafted.command.action || null, ...(drafted.command.action ? {} : { unread: "the control plane's answer named no action" }) }
      : { action: null, unread: `the control plane has no command ${uuid}` },
    (cause) => ({ action: null, unread: cause instanceof Error ? cause.message : String(cause) }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    const got = await Promise.race([read, late]);
    if (got !== null) return { ...got, from: "read" };
    return {
      action: null, from: "read", later: read,
      unread: `the control plane did not answer the read of command ${uuid} within ${ms} ms`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
  const payload = asRecord(await jsonWithin(response, failsafeTimeouts.bodyMs, "the failsafe state"));
  const list = (key: string): FailsafeCommand[] =>
    Array.isArray(payload[key]) ? (payload[key] as Record<string, unknown>[]).map(command).map(remember) : [];
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
  const payload = await jsonWithin(response, failsafeTimeouts.bodyMs, "the list of commands");
  return Array.isArray(payload) ? (payload as Record<string, unknown>[]).map(command).map(remember) : [];
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
  // A stop's draft has been made by now: its answer is waited for no longer than a stop's.
  const bodyMs = STOP_ACTIONS.has(input.action) ? failsafeTimeouts.stopBodyMs : failsafeTimeouts.bodyMs;
  const payload = asRecord(await jsonWithin(response, bodyMs, "the draft"));
  return {
    ok: true,
    drafted: {
      command: remember(command(payload)),
      signingBytes: typeof payload.signing_bytes === "string" ? payload.signing_bytes : "",
      draft: draftFrom(payload),
    },
  };
}

export async function getCommand(uuid: string, signal?: AbortSignal): Promise<DraftedCommand | null> {
  const response = await call(`/api/failsafe/commands/${encodeURIComponent(uuid)}/`, {}, true, signal);
  if (response.status === 404) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.ok) {
    throw new FailsafeUnavailable(
      `the control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = asRecord(await jsonWithin(response, failsafeTimeouts.bodyMs, "the command"));
  return {
    command: remember(command(payload)),
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
  // The signature has been taken by now (2xx): its answer is waited for no longer than a stop's.
  let payload: Record<string, unknown>;
  try {
    payload = asRecord(await jsonWithin(response, failsafeTimeouts.stopBodyMs, "the signature"));
  } catch (cause) {
    throw new FailsafeUnavailable(
      `${cause instanceof Error ? cause.message : String(cause)}. The control plane answered ${response.status}: it took ` +
      "the signature; read the command again to see where it stands",
    );
  }
  return { ok: true, command: remember(command(payload)) };
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
  return { ok: true, command: remember(command(asRecord(await jsonWithin(response, failsafeTimeouts.bodyMs, "the withdrawal")))) };
}

export async function audit(opts: { command?: string } = {}): Promise<FailsafeAuditEvent[]> {
  const query = opts.command ? `?command=${encodeURIComponent(opts.command)}` : "";
  const response = await call(`/api/failsafe/audit/${query}`);
  if (!response.ok) {
    throw new FailsafeUnavailable(
      `the control plane answered ${response.status}: ${await body(response)}`,
    );
  }
  const payload = await jsonWithin(response, failsafeTimeouts.bodyMs, "the audit trail");
  return Array.isArray(payload) ? (payload as Record<string, unknown>[]).map(auditEvent) : [];
}

/** Test seam: forget any cached access token, and every command action known here. */
export function _resetForTests(): void {
  cachedAccess = null;
  tokenInFlight = null;
  generation += 1;
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = null;
  knownActions.clear();
}
