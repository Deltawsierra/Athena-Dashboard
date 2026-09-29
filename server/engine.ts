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

import http from "http";
import https from "https";
import * as settings from "./settings";
import * as dnsCache from "./dns-cache";
import { runIdFrom, stopIdFrom } from "@shared/engine-record";

/**
 * Node loads its HTTP client (fetch, undici) the first time it is used, and
 * synchronously: 90-150 ms on this machine, on the event loop; and its first
 * request runs code that has never run before. That first use was the first
 * Stop after start-up -- the loop held while the stop was being sent. Both
 * are done here instead, when the server starts, before any request is
 * served.
 */
try {
  new Response("");
  // And its request path, once, with nothing sent anywhere (a data: URL):
  // the first stop is not the first request this client ever makes.
  void fetch("data:,").then((answer) => answer.arrayBuffer()).catch(() => undefined);
} catch {
  // A runtime without fetch has nothing to load; the calls say so themselves.
}

const ENGINE_URL = settings.FIELDS.engineUrl.env;
const ENGINE_KEY = settings.FIELDS.engineKey.env;

/**
 * How long the engine is waited for. `callMs`: for its answer's headers, on
 * any call. `bodyMs`: for the rest of an answer once its headers are in -- a
 * body that stalls (an engine, or a proxy in front of it, that sent headers
 * and nothing more) is given up on then, and never holds a request, a slot
 * or a Stop. `abortBodyMs`: the same for a stop's answer, which is answered
 * from its headers and only read further to tell "not running" from
 * "stopping" (abortRun). Tests shorten these.
 */
export const engineTimeouts = { callMs: 20_000, bodyMs: 20_000, abortBodyMs: 2_000 };

/** The most of the engine's error body we will quote back: what is shown, and what is stored. */
const MAX_ERROR_BODY = 500;

/**
 * The most of an error answer that is read to be parsed: an answer this
 * reader takes (a 500 or 429 `answer: "status"`, a 422 that refuses
 * `wait_seconds`) is read by its whole body up to here, never by the part of
 * it that is quoted back. Cut at MAX_ERROR_BODY, a real 500 whose `error`
 * ran past about 330 characters no longer parsed, and a run the engine was
 * scanning was refused as an unread shape and stopped. Past this the rest is
 * never read, and the answer is let go: a body this long is not one either
 * engine sends, and it is read as the shape it then is (not JSON).
 */
const MAX_PARSE_BODY = 64 * 1024;

/** Engine text as it is quoted back: its first MAX_ERROR_BODY characters. */
function quoted(text: string): string {
  return text.slice(0, MAX_ERROR_BODY);
}

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
  /**
   * The run's results as the engine sent them. An empty list when it sent none
   * (a run still going has no `result`); null when it sent a `results` that is
   * not a list, which could not be read and is never read as none.
   */
  findings: unknown[] | null;
  detail: string;
  /** The engine's own refusal, when it refused. Shown verbatim. */
  refused?: string;
  /**
   * The id a stop can address this run by exactly (shared/engine-record.ts
   * stopIdFrom): `runId`, or a non-empty id that is blank after trimming, which
   * the screens treat as none but a stop still reaches. Set by startScan only.
   */
  stopId?: string | null;
  /**
   * Set by startScan only: whether this answer is the run's end -- a 200, which
   * carries the finished run (its results under `result`). A 202
   * never is, whatever `state` it names: the engine reads the state after it
   * hands the run over, so a scan that ended in between is answered 202
   * `completed` with no results in it, and those are collected from
   * `/api/scans/{run_id}`. Neither is a 500 that names a run.
   */
  final?: boolean;
  /** Set by startScan only: what the engine said went wrong around a run it started all the same. */
  warning?: string;
}

export class EngineUnavailable extends Error {}

/**
 * The engine did not answer within engineTimeouts.callMs. Unlike a refused
 * connection, the request may have reached it, and it may still be doing what
 * was asked (a retest on engine main runs to its end whoever is waiting).
 */
export class EngineTimedOut extends EngineUnavailable {}

/**
 * The engine answered, and its answer was a refusal (a 4xx): it did not take
 * the request, and is doing nothing about it. A definite answer, unlike a
 * reset, a 5xx, a timeout or an answer that could not be read.
 */
export class EngineRefused extends EngineUnavailable {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** No engine is configured, or its address could not be read: nothing was sent anywhere. */
export class EngineNotConfigured extends EngineUnavailable {}

/**
 * The engine's address refused the connection, or could not be found, before
 * a byte of the request was sent: nothing reached the engine, so nothing was
 * started. A definite answer, unlike a reset or a timeout after sending.
 */
export class EngineConnectionRefused extends EngineUnavailable {}

/**
 * The engine answered a scan start 500 naming the run it registered, recorded
 * FAILED before its work started (`state: "failed"`): nothing was sent to the
 * target, and the run is not live. A definite answer.
 */
export class EngineStartFailed extends EngineUnavailable {}

/**
 * Whether a failed start may have left a run live: every failure but one
 * where nothing reached the engine (no engine configured, its address
 * unreadable, the connection refused before a byte was sent), the engine
 * refused the start (a 4xx), or it said the run failed before its work
 * started. A timeout, a reset after sending, a 5xx, an answer whose body never
 * came or could not be read: the engine may have started it, and a start it
 * took may be running.
 */
export function mayHaveStarted(cause: EngineUnavailable): boolean {
  return !(cause instanceof EngineNotConfigured || cause instanceof EngineConnectionRefused
    || cause instanceof EngineRefused || cause instanceof EngineStartFailed);
}

/**
 * The most runs one answer may name and still have each sent a stop from
 * here. An answer naming more (an X-Run-Id header joined from hundreds) is
 * refused, and none of them is sent a stop automatically: the kill switch on
 * the AI Control page, or a failsafe pause, stops what the engine runs.
 */
export const MAX_NAMED_RUNS = 8;

/** The runs an unread answer named, capped (MAX_NAMED_RUNS): past the cap, none is taken, and how many were named is kept. */
function cappedRuns(ids: string[], namedBy: Record<string, RunNamedBy>) {
  const over = ids.length > MAX_NAMED_RUNS;
  return { ids: over ? [] : ids, namedBy: over ? {} : namedBy, beyondCap: over ? ids.length : 0 };
}

/**
 * A scan start the engine answered in a shape this dashboard does not read --
 * a 2xx, or a 500 that names a run -- : nothing is recorded from it, and no
 * state or result is made up for it. `stopId` is the run id it carried, if
 * any (its body's `run_id`, else its `X-Run-Id` header), and `moreStopIds`
 * any other it named (a header that disagrees with the body): the engine may
 * be scanning under each, so the caller stops every one (routes.ts) rather
 * than leave a run going that nothing here recorded. An answer naming more
 * than MAX_NAMED_RUNS names none a stop is sent to (`beyondCap`).
 */
export class UnrecognisedScanAnswer extends EngineUnavailable {
  readonly stopId: string | null;
  readonly moreStopIds: string[];
  /**
   * `namedBy`: where the answer named each run -- "body", "X-Run-Id header",
   * or "body and X-Run-Id header" -- so the record of each stop says which.
   */
  readonly namedBy: Record<string, RunNamedBy>;
  /** How many runs the answer named when that was more than MAX_NAMED_RUNS (none is sent a stop); 0 otherwise. */
  readonly beyondCap: number;
  constructor(message: string, stopId: string | null, moreStopIds: string[] = [], namedBy: Record<string, RunNamedBy> = {}) {
    super(message);
    const capped = cappedRuns(stopId === null ? [...moreStopIds] : [stopId, ...moreStopIds], namedBy);
    this.stopId = capped.ids[0] ?? null;
    this.moreStopIds = capped.ids.slice(1);
    this.namedBy = capped.namedBy;
    this.beyondCap = capped.beyondCap;
  }

  /** Every run the answer named, each to be sent its stop. */
  get stopIds(): string[] {
    return this.stopId === null ? [...this.moreStopIds] : [this.stopId, ...this.moreStopIds];
  }
}

/** Where an answer named a run: its body's `run_id`, its X-Run-Id header, or both. */
export type RunNamedBy = "body" | "X-Run-Id header" | "body and X-Run-Id header";

/** The runs an answer names (runsNamed). */
interface RunsNamed {
  /** Its body's top-level `run_id`, as a stop can address it; null when it names none. */
  bodyId: string | null;
  /** Every run its X-Run-Id header names (headerRunIds): none, one, or -- sent more than once, or joined -- several. */
  headerIds: string[];
  /** Every run named, each once, the body's first. */
  ids: string[];
}

/**
 * Every run the X-Run-Id header names. Sent more than once, node joins the
 * values with ", " -- and a proxy may have joined them already -- so each
 * value, and each comma-separated part of one, names a run of its own: a
 * stop is never sent to "A, B", which names no run. Each id once, as a stop
 * can address it (stopIdFrom); a part that names none is left out.
 */
function headerRunIds(response: EngineAnswer): string[] {
  const ids = response.headerValues("x-run-id")
    .flatMap((value) => value.split(","))
    .map((part) => headerId(part.replace(/^[ \t]+|[ \t]+$/g, "")))
    .filter((one): one is string => one !== null);
  return ids.filter((one, at) => ids.indexOf(one) === at);
}

/**
 * One X-Run-Id part as a stop can address it. A quoted string (`"abc"`, as a
 * proxy or a structured-field writer may send it) is the id inside the
 * quotes; any other part carrying a quote or a backslash names no run -- a
 * stop is never sent to `"abc"` with its quotes, which names no run.
 */
function headerId(part: string): string | null {
  const quoted = /^"([^"\\]*)"$/.exec(part);
  const id = quoted ? quoted[1] : part;
  return id.includes("\"") ? null : stopIdFrom(id);
}

/**
 * The runs an answer names wherever they can be read without guessing at its
 * shape: `run_id` at the top of a JSON object body, and the `X-Run-Id` header
 * (athena-engine #71 sends it on every answer that registered a run). Each id
 * once, the body's first. Never an id from inside an array or a nested object.
 */
function runsNamed(raw: string | null, response: EngineAnswer): RunsNamed {
  let bodyId: string | null = null;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        bodyId = stopIdFrom((parsed as Record<string, unknown>).run_id);
      }
    } catch {
      // Not JSON: its body names no run.
    }
  }
  const headerIds = headerRunIds(response);
  const ids = [bodyId, ...headerIds].filter((one, at, all): one is string => one !== null && all.indexOf(one) === at);
  return { bodyId, headerIds, ids };
}

/**
 * Whether the X-Run-Id header takes `id` as the run: it names no run, or
 * only that one. A header naming another run, or several, does not.
 */
function headerAgrees(named: { headerIds: string[] }, id: string | null): boolean {
  return named.headerIds.every((one) => one === id);
}

/** Where the answer named each of its runs. */
function namedByOf(named: { bodyId: string | null; headerIds: string[] }): Record<string, RunNamedBy> {
  const out: Record<string, RunNamedBy> = {};
  if (named.bodyId !== null) out[named.bodyId] = "body";
  for (const id of named.headerIds) out[id] = out[id] === "body" ? "body and X-Run-Id header" : "X-Run-Id header";
  return out;
}

/** What an answer's ids were, said: which named which, and that they differ when they do. */
function namedSentence(named: { bodyId: string | null; headerIds: string[] }): string {
  const header = named.headerIds;
  const runs = (ids: string[]) => (ids.length === 1 ? `run ${ids[0]}` : `runs ${ids.join(" and ")}`);
  const all = [named.bodyId, ...header].filter((one, at, list): one is string => one !== null && list.indexOf(one) === at);
  if (all.length > MAX_NAMED_RUNS) {
    return `It names ${all.length} runs, more than the ${MAX_NAMED_RUNS} one answer may name, so none is taken as the run and ` +
      "none is sent a stop from here: a run it started may be live, and the kill switch on the AI Control page, or a " +
      "failsafe pause, stops it.";
  }
  if (named.bodyId !== null && !headerAgrees(named, named.bodyId)) {
    return `Its body names run ${named.bodyId} and its X-Run-Id header names ${runs(header)}: they differ, ` +
      "so none is taken as the run, and each is sent a stop.";
  }
  if (named.bodyId !== null) return `It names run ${named.bodyId}, which is sent a stop.`;
  if (header.length > 1) {
    return `Its X-Run-Id header names ${header.length} runs, ${runs(header)} (sent more than once, or joined): none is ` +
      "taken as the run, and each is sent a stop.";
  }
  if (header.length === 1) return `Its X-Run-Id header names run ${header[0]}, which is sent a stop.`;
  return "It names no run anywhere this dashboard can read, so no stop could be sent to it: a run it started may be " +
    "live, and the kill switch on the AI Control page, or a failsafe pause, stops it.";
}

/** The connect-phase failures: no connection was made, so nothing was sent. */
const NOTHING_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
function refusedBeforeSending(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const errors = (cause as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.every((one) => one && typeof one === "object" && NOTHING_SENT.has(String((one as { code?: unknown }).code)));
  }
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" && NOTHING_SENT.has(code);
}

/**
 * An answer from the engine: its status, and the rest read on demand.
 *
 * The engine is asked over node:http (https for an https address), not
 * fetch. fetch's answers cost the loop several times as much each (a WHATWG
 * Response, its headers and a web stream per answer): the kill switch's 100
 * stops answered at once held the loop 14 ms here (up to 51 ms on a loaded
 * machine), against 3 ms. Only what this client reads is kept: `ok`,
 * `status`, the text of the body, and a way to let the answer go.
 */
export class EngineAnswer {
  private reading: Promise<string> | null = null;
  constructor(readonly status: number, private readonly res: http.IncomingMessage, private readonly req: http.ClientRequest) {
    // A connection closed mid-answer is an answer that could not be read: said by text(), never thrown here.
    res.on("error", () => undefined);
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  /** One header of the answer, as sent; null when it was not sent, or was sent more than once (headerValues has each). */
  header(name: string): string | null {
    const values = this.headerValues(name);
    return values.length === 1 ? values[0] : null;
  }

  /** Every value a header was sent with, each as sent, never joined; none when it was not sent. */
  headerValues(name: string): string[] {
    const values = this.res.headersDistinct[name.toLowerCase()];
    return Array.isArray(values) ? [...values] : [];
  }

  /** Where a redirect (301, 302, 303, 307, 308) sends the request; null for any other answer, or one with no location. */
  get redirect(): string | null {
    if (![301, 302, 303, 307, 308].includes(this.status)) return null;
    const location = this.res.headers.location;
    return typeof location === "string" && location !== "" ? location : null;
  }

  /**
   * The rest of the answer; rejects when the connection closed before it
   * ended. `limit`: at most this many characters are read -- past it, the
   * first `limit` are the answer, and the rest is never read (the answer is
   * let go). Read once: a second call has what the first read.
   */
  text(limit = Number.POSITIVE_INFINITY): Promise<string> {
    if (this.reading === null) {
      this.reading = new Promise<string>((resolve, reject) => {
        let raw = "";
        let ended = false;
        this.res.setEncoding("utf8");
        this.res.on("data", (chunk: string) => {
          if (ended) return;
          raw += chunk;
          if (raw.length > limit) {
            ended = true;
            resolve(raw.slice(0, limit));
            this.release();
          }
        });
        this.res.on("end", () => { if (!ended) { ended = true; resolve(raw); } });
        this.res.on("close", () => { if (!ended) reject(new Error("the connection closed before the answer ended")); });
      });
    }
    return this.reading;
  }

  /** Let the answer go: its connection is closed, so nothing of it holds a socket or a read. */
  release(): void {
    this.req.destroy();
  }

  /** The body, as a stream a caller may cancel: cancelling it lets the answer go. */
  get body(): { cancel(): Promise<void> } {
    return { cancel: async () => this.release() };
  }
}

/**
 * How long a connection to the engine is kept open unused. Below the
 * engine's own limit: athena-engine runs under uvicorn, which closes a
 * kept-alive connection after 5 s idle and says nothing of it beforehand (no
 * Keep-Alive header). A request written onto a connection the engine is
 * closing is reset before it is read ("socket hang up"): a Stop sent then was
 * lost. So a connection is closed from this side after 4 s unused -- as
 * fetch (undici) did -- and never offered for reuse in the engine's last
 * second. It applies only to a connection with no request on it: a call
 * waiting on the engine's answer is bounded by engineTimeouts.callMs alone.
 */
export const IDLE_SOCKET_MS = 4_000;

/** Connections to the engine, kept open between calls (IDLE_SOCKET_MS). */
const agents = {
  http: new http.Agent({ keepAlive: true, timeout: IDLE_SOCKET_MS }),
  https: new https.Agent({ keepAlive: true, timeout: IDLE_SOCKET_MS }),
};

/**
 * A request on a connection kept from an earlier call that failed before any
 * answer, in the way a connection the far end had already closed fails: reset,
 * or hung up. It is sent once more, on a new connection -- as Node's
 * documentation advises, and only when sending it twice does no harm
 * (resendable): a read, or a stop. A reset before any answer does not say
 * whether the engine read the request: engine main keeps running a retest
 * whose connection was reset, so a start sent again could start a second run.
 * A start is kept off a connection the engine is closing by IDLE_SOCKET_MS
 * instead, and one reset anyway is an answer that could not be read (its
 * retest's slot is held). Never for a request on a new connection, and never
 * after any of an answer arrived.
 */
const STALE_CONNECTION = new Set(["ECONNRESET", "EPIPE"]);

/** Whether a request may be sent twice (STALE_CONNECTION): a read, or a stop -- never a start, or anything else that makes something. */
function resendable(method: string, path: string): boolean {
  return method === "GET" || method === "HEAD" || (method === "POST" && /^\/api\/scans\/[^/]+\/abort$/.test(path));
}

/** Redirects are followed as fetch followed them: at most this many, then refused. */
const MAX_REDIRECTS = 20;

/**
 * The rest of an answer whose headers are in, or null when it did not arrive
 * within `ms` -- then the answer is let go: its connection is closed, so a
 * stalled answer holds no socket and no read.
 */
async function bodyWithin(response: EngineAnswer, ms: number, limit?: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    const read = response.text(limit).catch(() => null);
    const got = await Promise.race([read, late]);
    if (got === null) response.release();
    return got;
  } finally {
    clearTimeout(timer);
  }
}

/** An answer's JSON, read within engineTimeouts.bodyMs; throws when it did not arrive, or did not parse. */
async function jsonWithin(response: EngineAnswer, what: string): Promise<unknown> {
  const raw = await bodyWithin(response, engineTimeouts.bodyMs);
  if (raw === null) {
    throw new EngineUnavailable(
      `the engine sent the headers of its answer to ${what} (${response.status}) but not the rest within ` +
      `${Math.round(engineTimeouts.bodyMs / 1000)} s, so it could not be read`,
    );
  }
  return JSON.parse(raw) as unknown;
}

/** A JSON answer as an object: a body that is not one is read as an empty object (every field then reads as absent). */
function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A JSON answer that must be an object to be read at all: any other body is an answer that could not be read, never an empty one. */
function objectOrUnread(value: unknown, what: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new EngineUnavailable(`the engine's answer to ${what} was not an object, so it could not be read`);
}

/**
 * The engine's `results`, read. Absent is none sent. Present and not a list is
 * an answer that could not be read: null, never an empty list. It was `[]`, so
 * a garbled answer was recorded, counted and shown as a scan that returned no
 * findings.
 */
function resultsOf(results: unknown): unknown[] | null {
  if (results === undefined) return [];
  return Array.isArray(results) ? results : null;
}

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

/** The engine's hostname now, for priming its address off the stop path; null when none, or an IP literal (nothing to resolve). */
function engineHost(): string | null {
  const base = baseUrl();
  if (!base) return null;
  try {
    return new URL(base).hostname || null;
  } catch {
    return null;
  }
}

let warmTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Keep the engine's address warm in the DNS cache, OFF the stop path: resolve
 * it now and re-resolve it in the background (the operator may retune the URL
 * from the settings screen, so the current host is read each time). A Stop's
 * connection then reads a cached address and never runs a live threadpool
 * getaddrinfo -- see server/dns-cache.ts. Safe to call more than once; the
 * timer is a single unref'd one.
 */
export function warmUp(): void {
  const host = engineHost();
  if (host) void dnsCache.prime(host);
  if (warmTimer === null) {
    warmTimer = setInterval(() => {
      const h = engineHost();
      if (h) void dnsCache.prime(h);
    }, dnsCache.TTL_MS);
    warmTimer.unref?.();
  }
}

/**
 * Prime the engine's address now, AWAITABLY -- for the boot race. warmUp()
 * primes fire-and-forget, so a Stop arriving before that first prime lands
 * still ran a live threadpool getaddrinfo. An entry point awaits this (after
 * settings are loaded) before the server accepts requests, so the very first
 * Stop reads a cached address. Resolves when the prime settles; never rejects.
 */
export function primeNow(): Promise<void> {
  const host = engineHost();
  return host ? dnsCache.prime(host) : Promise.resolve();
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

/** What a call sends: its method and its body. */
type CallInit = { method?: string; body?: string };

/**
 * Ask the engine. Within `timeoutMs` for the headers of its answer, over the
 * whole call: a read or a stop sent again (STALE_CONNECTION) and every
 * redirect followed share that one deadline.
 *
 * Redirects are followed as fetch followed them before this client used
 * node:http (an engine behind a proxy that moves it, such as an HTTP-to-HTTPS
 * redirect): 307 and 308 with the same method and body; 301 and 302 as a GET
 * when the request was a POST, and 303 always as a GET (HEAD stays HEAD),
 * without a body; to http or https only, and at most MAX_REDIRECTS times.
 */
function call(path: string, init?: CallInit, timeoutMs: number = engineTimeouts.callMs): Promise<EngineAnswer> {
  const base = baseUrl();
  if (!base) {
    return Promise.reject(new EngineNotConfigured(
      `no engine is configured; set ${ENGINE_URL} to the engine's address`,
    ));
  }
  let url: URL;
  try {
    url = new URL(`${base}${path}`);
  } catch (cause) {
    // An address that cannot be read: nothing was sent anywhere.
    return Promise.reject(new EngineNotConfigured(
      `could not reach the engine at ${base}: ${cause instanceof Error ? cause.message : String(cause)}`,
    ));
  }
  const deadline = Date.now() + timeoutMs;
  const timedOut = () => new EngineTimedOut(`the engine at ${base} did not answer within ${Math.round(timeoutMs / 1000)} s`);
  return (async () => {
    let method = init?.method ?? "GET";
    let payload = init?.body;
    for (let hops = 0; ; hops += 1) {
      let answer: EngineAnswer;
      try {
        answer = await send(url, method, payload, deadline, true);
      } catch (cause) {
        if (cause instanceof StaleConnection && resendable(method, url.pathname)) {
          // Reset on a kept connection before any answer: sent once more, on a new one.
          try {
            answer = await send(url, method, payload, deadline, false);
          } catch (again) {
            throw failure(again, base, timedOut);
          }
        } else {
          throw failure(cause, base, timedOut);
        }
      }
      const location = answer.redirect;
      if (location === null) return answer;
      answer.release();
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new EngineUnavailable(`the engine at ${base} answered ${answer.status} with a location that could not be read: ${location}`);
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new EngineUnavailable(`the engine at ${base} answered ${answer.status} to ${next.protocol} -- not followed`);
      }
      if (hops + 1 > MAX_REDIRECTS) {
        throw new EngineUnavailable(`the engine at ${base} redirected more than ${MAX_REDIRECTS} times`);
      }
      if (answer.status === 303 ? method !== "HEAD" : (answer.status === 301 || answer.status === 302) && method === "POST") {
        method = "GET";
        payload = undefined;
      }
      url = next;
    }
  })();
}

/** A request on a kept connection was reset before any answer (STALE_CONNECTION): the caller sends it once more. */
class StaleConnection extends Error {
  constructor(readonly error: Error) {
    super(error.message);
  }
}

/** Why a call failed, in words a browser may be shown: a hostname, a port and a refusal, never a stack. */
function failure(cause: unknown, base: string, timedOut: () => EngineTimedOut): Error {
  if (cause instanceof EngineUnavailable) return cause;
  if (cause === TIMED_OUT) return timedOut();
  const error = (cause instanceof StaleConnection ? cause.error : cause) as Error & { code?: string };
  const message = error instanceof Error ? error.message : String(error);
  if (refusedBeforeSending(error)) {
    return new EngineConnectionRefused(`could not reach the engine at ${base}: ${message}` +
      (typeof error.code === "string" && !message.includes(error.code) ? ` (${error.code})` : ""));
  }
  return new EngineUnavailable(`could not reach the engine at ${base}: ${message}`);
}

const TIMED_OUT = Symbol("timed out");

/**
 * One request, answered with its headers by `deadline`. `mayReuse`: whether
 * it may go on a kept connection -- a request sent once more never does
 * (a fresh connection, closed after its answer).
 */
function send(url: URL, method: string, payload: string | undefined, deadline: number, mayReuse: boolean): Promise<EngineAnswer> {
  const secure = url.protocol === "https:";
  return new Promise<EngineAnswer>((resolve, reject) => {
    let timedOut = false;
    const req = (secure ? https : http).request(url, {
      method,
      headers: {
        ...headers(),
        ...(payload !== undefined ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
      agent: mayReuse ? (secure ? agents.https : agents.http) : false,
      // SAFETY: resolve the host from the cache (server/dns-cache.ts), so a
      // Stop on a cold connection never runs a live threadpool getaddrinfo
      // behind a sign-in flood's scrypt jobs. An IP literal is passed straight
      // through; the hostname on `url` is unchanged, so TLS SNI and cert
      // validation are untouched.
      lookup: dnsCache.lookup,
    }, (res) => {
      clearTimeout(timer);
      resolve(new EngineAnswer(res.statusCode ?? 0, res, req));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
    }, Math.max(0, deadline - Date.now()));
    req.on("error", (cause: Error & { code?: string }) => {
      clearTimeout(timer);
      if (timedOut) reject(TIMED_OUT);
      else if (mayReuse && req.reusedSocket && typeof cause.code === "string" && STALE_CONNECTION.has(cause.code)) reject(new StaleConnection(cause));
      else reject(cause);
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function body(response: EngineAnswer): Promise<string> {
  return quoted((await bodyWithin(response, engineTimeouts.bodyMs)) ?? "");
}

/**
 * An error answer read to be parsed: its whole body up to MAX_PARSE_BODY
 * (within engineTimeouts.bodyMs), with `shown` -- its first MAX_ERROR_BODY
 * characters -- for what is said and stored. The answer is read by `whole`,
 * never by `shown`.
 */
async function errorBody(response: EngineAnswer): Promise<{ whole: string; shown: string }> {
  const whole = (await bodyWithin(response, engineTimeouts.bodyMs, MAX_PARSE_BODY)) ?? "";
  return { whole, shown: quoted(whole) };
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
  let response: EngineAnswer;
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
    const health = await jsonWithin(response, "the health check").catch(() => null);
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
  if (response.status === 500) {
    // athena-engine #71: a launch that failed after its run was registered is
    // a 500 `answer: "status"` that still names the run. `state: "failed"`:
    // its work never started, and the run is recorded FAILED. `state: null`:
    // its work did start -- it is scanning, stoppable by this id, and records
    // its own end -- so it is recorded here as running, with its Stop, and
    // collected from `/api/scans/{run_id}` like any other. Any other 500 is
    // the engine's words, as it always was. Read by its whole body (up to
    // MAX_PARSE_BODY), and quoted by its first MAX_ERROR_BODY characters.
    const { whole, shown: raw } = await errorBody(response);
    const named = statusAnswerOf(whole);
    const stopId = named ? stopIdFrom(named.run_id) : null;
    const said = runsNamed(whole, response);
    if (stopId !== null && !headerAgrees(said, stopId)) {
      // The body and the X-Run-Id header name different runs (or the header
      // names several): which one is this start's is not guessed. Nothing is
      // recorded; every one is stopped.
      throw new UnrecognisedScanAnswer(
        `the engine answered 500 to a scan start naming different runs. ${namedSentence(said)} Nothing was recorded from it.`,
        stopId, said.ids.filter((one) => one !== stopId), namedByOf(said),
      );
    }
    if (named && stopId !== null && named.state !== "failed") {
      const error = typeof named.error === "string" ? quoted(named.error) : "no error given";
      return {
        runId: runIdFrom(named.run_id),
        stopId,
        state: typeof named.state === "string" ? named.state : "unknown",
        findings: [],
        detail: "the engine started the scan, and failed after it registered it",
        warning: `the engine failed after it registered run ${stopId} (${error}), and its work may be running: ` +
          "it is recorded as running, with its Stop, and read from the engine until it ends",
        final: false,
      };
    }
    if (named && stopId !== null) {
      throw new EngineStartFailed(
        `the engine answered 500: run ${stopId} failed before its work started (${quoted(String(named.error ?? "no error given"))}); ` +
        "nothing was sent to the target",
      );
    }
    // A 500 in a shape this reader does not take (not an `answer: "status"`
    // naming its run in `run_id`) that still names a run -- in its body or
    // its X-Run-Id header: that run may be live. It is never guessed as
    // started work (nothing is recorded); it is sent a stop.
    if (said.ids.length > 0) {
      throw new UnrecognisedScanAnswer(
        `the engine answered 500 to a scan start in a shape this dashboard does not read: ${raw || "(no body)"}. ` +
        `${namedSentence(said)} Nothing was recorded from it.`,
        said.ids[0], said.ids.slice(1), namedByOf(said),
      );
    }
    throw new EngineUnavailable(`the engine answered 500: ${raw}`);
  }
  if (!response.ok) {
    const said = `the engine answered ${response.status}: ${await body(response)}`;
    // A 4xx is the engine refusing the start: nothing was started. Any other
    // answer (a 5xx) says nothing about whether it started one: a run its
    // X-Run-Id header names is sent a stop (routes.ts), and one it names none
    // of may be live all the same (mayHaveStarted).
    if (response.status >= 400 && response.status < 500) throw new EngineRefused(said, response.status);
    const named = { bodyId: null, headerIds: headerRunIds(response) };
    if (named.headerIds.length > 0) {
      throw new UnrecognisedScanAnswer(`${said}. ${namedSentence(named)} Nothing was recorded from it.`,
        named.headerIds[0], named.headerIds.slice(1), namedByOf(named));
    }
    throw new EngineUnavailable(said);
  }

  // Read as a JSON object, or refused: a body that is not one (`[]`, `null`,
  // `"ok"`, not JSON at all) is a shape this dashboard does not read, never
  // engine main's no-`answer` shape read with every field absent. A run its
  // X-Run-Id header names is stopped (routes.ts); none is looked for inside it.
  const rawScan = await bodyWithin(response, engineTimeouts.bodyMs);
  if (rawScan === null) {
    const stalled = `the engine sent the headers of its answer to the scan (${response.status}) but not the rest within ` +
      `${Math.round(engineTimeouts.bodyMs / 1000)} s, so it could not be read`;
    // The engine took the start (its 2xx headers came): a run its X-Run-Id
    // header names is sent a stop, as any unread answer's is (routes.ts).
    // Naming none, the run it started may be live all the same.
    const named = { bodyId: null, headerIds: headerRunIds(response) };
    if (named.headerIds.length > 0) {
      throw new UnrecognisedScanAnswer(`${stalled}. ${namedSentence(named)} Nothing was recorded from it.`,
        named.headerIds[0], named.headerIds.slice(1), namedByOf(named));
    }
    throw new EngineUnavailable(stalled);
  }
  let readScan: unknown = undefined;
  let scanIsJson = true;
  try {
    readScan = JSON.parse(rawScan) as unknown;
  } catch {
    scanIsJson = false;
  }
  if (!scanIsJson || !readScan || typeof readScan !== "object" || Array.isArray(readScan)) {
    const named = { bodyId: null, headerIds: headerRunIds(response) };
    throw new UnrecognisedScanAnswer(
      `the engine answered HTTP ${response.status} to a scan start with a body that is not a JSON object ` +
      `(${rawScan.slice(0, 200) || "no body"}), a shape this dashboard does not read. ${namedSentence(named)} ` +
      "Nothing was recorded from it.",
      named.headerIds[0] ?? null, named.headerIds.slice(1), namedByOf(named),
    );
  }
  const payload = objectOf(readScan);
  // Which contract answered is read from one explicit field, `answer`, never
  // guessed from a shape: athena-engine #71 marks every scan answer
  // `answer: "status"`; engine main sends no `answer`. Both name the run by
  // `run_id`, the id its Stop is sent by, and neither sends a scan record id
  // here (a finished run's record is `result.scan_id`). Anything else is a
  // shape this dashboard does not read: nothing is recorded from it, and no
  // state or result is made up for it.
  const named2xx = runsNamed(rawScan, response);
  if ("answer" in payload && payload.answer !== "status") {
    // Said like every other unread answer (namedSentence): the run it named
    // is sent a stop -- or, when it named none a stop can address, that a
    // run it started may be live, and what stops it.
    throw new UnrecognisedScanAnswer(
      `the engine answered a shape this dashboard does not read: HTTP ${response.status} with answer ` +
      `${JSON.stringify(payload.answer)} to a scan start. ${namedSentence(named2xx)} Nothing was recorded from it.`,
      named2xx.ids[0] ?? null, named2xx.ids.slice(1), namedByOf(named2xx),
    );
  }
  // Only a 200 -- the finished run, which the engine answers only when the
  // run ended inside the wait it was asked for -- is the run's end. A 202 is
  // never "done", whatever `state` it names (EngineScan.final): its results
  // are not in it, and read as they were, a scan that ended between the
  // engine's hand-over and its answer was recorded completed with none.
  const final = response.status === 200;
  // A run named only by its X-Run-Id header, by a header and a body that
  // disagree, or by a header naming several: which run this start is is not
  // guessed. Nothing is recorded, and every run named is stopped.
  if (named2xx.headerIds.length > 0 && (named2xx.bodyId === null || !headerAgrees(named2xx, named2xx.bodyId))) {
    throw new UnrecognisedScanAnswer(
      `the engine answered HTTP ${response.status} to a scan start ` +
      (named2xx.bodyId === null ? "whose body names no run id. " : "naming different runs. ") +
      `${namedSentence(named2xx)} Nothing was recorded from it.`,
      named2xx.ids[0], named2xx.ids.slice(1), namedByOf(named2xx),
    );
  }
  // Measured against a live engine: results come back under `result.results`,
  // never at the top level. This read `payload.results` -- a key the engine
  // does not send -- so a scan that completed inline had its findings silently
  // dropped, and only the polling route ever saw them. Harmless while nothing
  // asks the engine to wait, and a silent loss the moment anything does.
  // `runState` has always read the nested form; both agree now.
  const inline = (payload.result ?? {}) as Record<string, unknown>;
  return {
    // Read as every run id is (shared/engine-record.ts runIdFrom): a number is
    // its digits. Cast as a string, `run_id: 42` was recorded as the number and
    // then read as no run id at all, so nothing could name the run to stop it.
    runId: runIdFrom(payload.run_id),
    stopId: stopIdFrom(payload.run_id),
    state: (payload.state as string) ?? "running",
    findings: !final ? [] : inline.results !== undefined ? resultsOf(inline.results) : resultsOf(payload.results),
    detail: "the engine accepted the scan",
    final,
    // A run it may still be running with no id a stop can name: kept as it
    // always was (recorded running, the Failsafe console in place of a Stop),
    // and said why.
    ...(runIdFrom(payload.run_id) === null && !(final && payload.state === "completed")
      ? {
        warning: `the engine answered HTTP ${response.status} to this scan start but named no run id a stop can address ` +
          `(run_id: ${JSON.stringify(payload.run_id ?? null)}), so no Stop here can reach it: it is recorded as running, ` +
          "and the kill switch on the AI Control page, or a failsafe pause, stops it",
      }
      : {}),
  };
}

/** A body that is an `answer: "status"` object (athena-engine #71), or null. */
function statusAnswerOf(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).answer === "status") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON: not a status.
  }
  return null;
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

  const payload = objectOrUnread(await jsonWithin(response, "the classification"), "the classification");
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

  const payload = objectOrUnread(await jsonWithin(response, "the evidence pack"), "the evidence pack");
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
  const payload = objectOrUnread(await jsonWithin(response, `run ${runId}`), `run ${runId}`);
  const result = (payload.result ?? {}) as Record<string, unknown>;
  return {
    runId,
    state: (payload.state as string) ?? "unknown",
    findings: resultsOf(result.results),
    detail: (payload.reason as string) ?? "",
  };
}

/** One run the engine lists as still live: queued, running or aborting. */
export interface ActiveRun {
  /**
   * The run's id (shared/engine-record.ts runIdFrom), or null when the engine
   * listed it with none a stop can name. Such a run is still live, and still
   * listed: it counts toward the concurrency limit, and the kill switch says it
   * could not be stopped from here.
   */
  runId: string | null;
  /**
   * The id the kill switch sends its stop by (shared/engine-record.ts
   * stopIdFrom): `runId`, or a non-empty id blank after trimming, which a stop
   * still reaches exactly. null only when no stop can address the run.
   */
  stopId: string | null;
  target: string | null;
  state: string;
  /**
   * What the engine says the run is -- `scan`, `retest`, `attestation` -- or
   * null when it did not say. A retest is a registered run like any scan: it
   * is on this list, the kill switch stops it, and "Scans running now" lists
   * it by this.
   */
  kind: string | null;
}

/**
 * Every run the engine says is still touching a customer: one per entry on its
 * list, of whatever shape.
 *
 * The engine's own list, not this app's rows: a run whose row was deleted, or
 * never written, is on it all the same. An answer that cannot be read throws
 * -- a list nobody could read is not an empty one.
 */
export async function activeRuns(): Promise<ActiveRun[]> {
  const response = await call("/api/scans/active");
  if (!response.ok) {
    throw new EngineUnavailable(
      `the engine answered ${response.status} when asked for its active runs: ${await body(response)}`,
    );
  }
  const payload = (await jsonWithin(response, "the list of active runs").catch(() => null)) as Record<string, unknown> | null;
  const listed = payload && typeof payload === "object" ? payload.active : undefined;
  if (!Array.isArray(listed)) {
    throw new EngineUnavailable("the engine's answer did not carry a list of active runs");
  }
  // Every entry listed is a live run, whatever its shape: none is dropped. A
  // run listed with no id was dropped here, so the kill switch said nothing of
  // a run it could not stop -- and so was any entry that was not an object: a
  // list of bare ids (`["run-7", 77]`) was sent no stop, counted toward no
  // limit, and read on the AI Control page as "no other live run". An entry
  // that is a run id (text, or a whole number) is that run; any other entry
  // is a live run with no id a stop can name.
  return listed.map((one): ActiveRun => {
    if (one === null || typeof one !== "object" || Array.isArray(one)) {
      return { runId: runIdFrom(one), stopId: stopIdFrom(one), target: null, state: "unknown", kind: null };
    }
    const run = one as Record<string, unknown>;
    return {
      runId: runIdFrom(run.run_id),
      stopId: stopIdFrom(run.run_id),
      target: typeof run.target === "string" ? run.target : null,
      state: typeof run.state === "string" ? run.state : "unknown",
      kind: typeof run.kind === "string" ? run.kind : null,
    };
  });
}

/** Ask a running scan to stop. */
/**
 * What a stop came to. `accepted`: the engine took it and is stopping the run.
 * `alreadyFinished`: the engine answered that the run is not running -- it had
 * ended before the stop arrived, and nothing was stopped by it. Neither: the
 * engine did not take it (the run may still be going).
 */
export interface AbortOutcome {
  accepted: boolean;
  alreadyFinished: boolean;
  /** The run's state as the engine answered it, when it did. */
  state: string | null;
  /**
   * The engine answered 2xx, but the rest of its answer did not arrive within
   * engineTimeouts.abortBodyMs: "stop sent, answer unread". `accepted` is
   * true only in that the 2xx was read; whether the run was stopping or had
   * already ended was not, and every record of it says so -- never that the
   * stop was accepted (routes.ts outcomeOf).
   */
  answerUnread?: boolean;
  /**
   * The engine answered 404 "No such scan run": it has no run under this id --
   * it has ended and been forgotten, or never ran. Nothing was stopped, and
   * nothing is running under this id there. Definite about the run only when
   * the engine itself issued the id in an answer that was read (or listed it
   * live): an id an unread answer named proves only that it is not the
   * engine's run -- the run that start began may be live under another id
   * (routes.ts namedByUnreadAnswer).
   */
  unknownRun?: boolean;
}

/** What both engines answer a stop to a run id they have no record of (api/server.py: HTTPException(404, "No such scan run")). */
const NO_SUCH_RUN = "No such scan run";

/** Ask a running scan to stop. */
export async function abortRun(runId: string): Promise<AbortOutcome> {
  const response = await call(`/api/scans/${encodeURIComponent(runId)}/abort`, {
    method: "POST",
  });
  if (!response.ok) {
    // A 404 is read -- as a 2xx is, for at most engineTimeouts.abortBodyMs
    // and a few bytes -- for the engine's own "No such scan run". Every other
    // refusal's answer is let go at once, unread: its connection is closed
    // (EngineAnswer.release), so nothing of it holds a socket or a read.
    if (response.status === 404) {
      const raw = await bodyWithin(response, engineTimeouts.abortBodyMs, 1024);
      response.release();
      let detail: unknown = null;
      try {
        detail = (JSON.parse(raw ?? "") as { detail?: unknown } | null)?.detail ?? null;
      } catch {
        detail = null;
      }
      if (detail === NO_SUCH_RUN) return { accepted: false, alreadyFinished: false, state: null, unknownRun: true };
      return { accepted: false, alreadyFinished: false, state: null };
    }
    response.release();
    return { accepted: false, alreadyFinished: false, state: null };
  }
  // Answered from the headers: the body is read only to tell a run that had
  // ended ("not running") from one that is stopping, and for at most
  // engineTimeouts.abortBodyMs. A body that stalls never holds a Stop, or the
  // kill switch, which waits on every stop's answer: it is answered as a stop
  // sent whose answer was not read, and its request is aborted so its socket
  // is let go (bodyWithin).
  const raw = await bodyWithin(response, engineTimeouts.abortBodyMs);
  if (raw === null) return { accepted: true, alreadyFinished: false, state: null, answerUnread: true };
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }
  const state = payload && typeof payload.state === "string" ? payload.state : null;
  // Both engines answer a run that has ended `{state, detail: "not running"}`.
  if (payload && payload.detail === "not running") return { accepted: false, alreadyFinished: true, state };
  return { accepted: true, alreadyFinished: false, state };
}

/** Ask a running scan to stop: true when the engine took the stop, or the run had already ended. */
export async function abort(runId: string): Promise<boolean> {
  const outcome = await abortRun(runId);
  return outcome.accepted || outcome.alreadyFinished;
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
    runId: runIdFrom(raw.run_id),
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
  const payload = objectOrUnread(await jsonWithin(response, "the list of decisions"), "the list of decisions");
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
  /**
   * The id of the scan record the retest produced: what a check and a fix are
   * filed against. The engine's `scan_record_id` on the contract that sends
   * `answer` (athena-engine #71); its top-level `run_id` on the one that does
   * not, where that key was the record id. Null when no scan ran.
   */
  runId: string | null;
  /**
   * The abort-registry id the retest ran under: the id a stop names. The
   * engine's top-level `run_id` on the contract that sends `answer`; null on
   * the one that does not, which answers only once the retest is over.
   */
  engineRunId: string | null;
  checkedAt: string | null;
  /**
   * athena-engine #71 (f4610ae): a stop landed while the retest's remediation
   * check was being filed, after the last point that could prevent it. The
   * check is on the engine's chain and the verdict stands; the run itself
   * ended ABORTED. The stop's reason (the engine's `stopped_after_recording`,
   * or the run's `reason` on a status read); null for a run that completed.
   */
  stoppedAfterRecording: string | null;
}

/**
 * A retest the engine answered with where its run is, never with a verdict:
 * still queued or running (202), stopped, failed or finished without a verdict
 * (200), or refused by a full worker queue (429). Nothing may be filed, marked
 * fixed or called inconclusive from this: the engine has not said whether the
 * finding is there.
 */
export interface RetestStatus {
  /** The abort-registry id a stop names (stopIdFrom), or null when none can. */
  engineRunId: string | null;
  /** The engine's run state: queued, running, aborting, aborted, failed, completed -- or "unknown". */
  state: string;
  reason: string | null;
  error: string | null;
  /**
   * The HTTP status the engine answered with: 202, 200 or 429; 500 when the
   * engine failed after it registered the run (athena-engine #71); 200 for a
   * status read.
   */
  httpStatus: number;
}

/**
 * Whether a retest status may still be doing something to the target, so it
 * is watched, with its Stop: a 202 (whatever state it names -- the run may
 * have ended between the engine's hand-over and its answer, and is then read
 * at once), a live state, or a 500 that names a run whose work started
 * (athena-engine #71 answers such a run `state: null`; `failed` is one whose
 * work never started).
 */
export function retestMayBeRunning(status: RetestStatus): boolean {
  if (status.httpStatus === 202 || ["queued", "running", "aborting"].includes(status.state)) return true;
  return status.httpStatus === 500 && status.engineRunId !== null && !RETEST_DONE_STATES.has(status.state);
}

/** Which of the two things a retest answer is. Read from `answer` before `verdict`. */
export type RetestAnswer =
  | { answer: "verdict"; result: RetestResult }
  | { answer: "status"; status: RetestStatus };

/** Run states after which the engine does nothing more to the target. */
export const RETEST_DONE_STATES = new Set(["completed", "aborted", "failed"]);

export interface RetestRequest {
  twinId: number;
  /** Required by the engine. Composed from the engagement, never from the twin. */
  engagementRef: string;
  scope: string[];
}

/**
 * An engine answer to a retest that is neither contract's: nothing is filed
 * from it, and no id in it is read as a scan record.
 */
export class UnrecognisedRetestAnswer extends EngineUnavailable {
  /** Every run the answer named, each to be sent its stop: none when it named more than MAX_NAMED_RUNS (`beyondCap`). */
  readonly stopIds: string[];
  /** Where the answer named each run (UnrecognisedScanAnswer.namedBy). */
  readonly namedBy: Record<string, RunNamedBy>;
  /** How many runs the answer named when that was more than MAX_NAMED_RUNS; 0 otherwise. */
  readonly beyondCap: number;
  /**
   * `answered`: the engine answered 2xx with a body that carries a run id.
   * Said, never decisive: an answer that carries one no stop can address
   * frees no slot -- the retest it started may be running (routes.ts).
   */
  constructor(
    message: string,
    readonly answered = false,
    stopIds: string[] = [],
    namedBy: Record<string, RunNamedBy> = {},
  ) {
    super(message);
    const capped = cappedRuns(stopIds, namedBy);
    this.stopIds = capped.ids;
    this.namedBy = capped.namedBy;
    this.beyondCap = capped.beyondCap;
  }
}

/**
 * Whether a 422 is the engine refusing `wait_seconds` as a field it does not
 * know -- engine main does (the fixture main-5779e99/wait-seconds-refused.json)
 * -- which it does before anything is started.
 */
function refusesWaitSeconds(status: number, raw: string): boolean {
  if (status !== 422) return false;
  try {
    const detail = (JSON.parse(raw) as { detail?: unknown }).detail;
    return Array.isArray(detail) && detail.some((one) =>
      one && typeof one === "object" && Array.isArray((one as { loc?: unknown }).loc)
      && ((one as { loc: unknown[] }).loc).includes("wait_seconds"));
  } catch {
    return false;
  }
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * A verdict, read. `recordId` is the scan record id and `engineRunId` the
 * registry id, each already read by the caller for its contract.
 */
function verdictOf(
  payload: Record<string, unknown>,
  recordId: unknown,
  engineRunId: string | null,
): RetestResult {
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
    // Measured: the engine sends the record id as a number at the top level
    // and as a string inside `check`. Both are the same run.
    runId: runIdFrom(recordId),
    engineRunId,
    checkedAt: typeof check.checked_at === "string" ? check.checked_at : null,
    stoppedAfterRecording: text(payload.stopped_after_recording),
  };
}

/** A status read from an error answer, its `error` quoted as every error body is (MAX_ERROR_BODY). */
function quotedStatus(status: RetestStatus): RetestStatus {
  return status.error === null ? status : { ...status, error: quoted(status.error) };
}

/** A status answer, read. */
function statusOf(payload: Record<string, unknown>, httpStatus: number): RetestStatus {
  return {
    engineRunId: stopIdFrom(payload.run_id),
    state: text(payload.state) ?? "unknown",
    reason: text(payload.reason),
    error: text(payload.error),
    httpStatus,
  };
}

/**
 * Ask the engine to retest one decision.
 *
 * Two contracts are read, told apart by whether the answer carries `answer`:
 *
 *  - athena-engine #71: `answer: "verdict"` (201) is a verdict, its `run_id`
 *    the registry id and its record id `scan_record_id` -- `state: "aborted"`
 *    with `stopped_after_recording` when a stop landed while its check was
 *    being filed; `answer: "status"` (202 running, 200 stopped / failed / no
 *    verdict, 429 queue full, 500 failed after the run was registered) is
 *    where the run is and never a verdict.
 *  - engine main before #71 (no `answer`): the OLD contract. Any 2xx is the
 *    verdict, answered once the retest is over, and its `run_id` is the scan
 *    record id (no stop can name it: the run is over). Read exactly as it
 *    always was, and only while the answer carries no `answer` and no
 *    `scan_record_id`.
 *
 * Which contract answered is decided by that one explicit field, never
 * guessed from the rest of the shape; an answer that fits neither is refused
 * (below), never read with a made-up value.
 *
 * `wait_seconds: 0` is sent first, so #71 answers 202 at once rather than
 * holding an engine thread for up to 30 s; main refuses the field (422,
 * before it starts anything) and is asked again without it.
 *
 * Any other answer throws UnrecognisedRetestAnswer: a 202 that is not a
 * status, an answer without `answer` that main would never send (a 202, or
 * one carrying `scan_record_id`), and an `answer` this cannot read. None is a
 * verdict, and nothing is filed from one.
 */
export async function retest(request: RetestRequest): Promise<RetestAnswer> {
  const fields = { twin_id: request.twinId, engagement_ref: request.engagementRef, scope: request.scope };
  // `wait_seconds: 0` first: athena-engine #71 then answers 202 with the run's
  // id at once, holds no engine thread waiting for the verdict, and the watch
  // collects it. Engine main refuses the field with a 422 before it starts
  // anything, and is asked again without it -- the request it always had.
  let response = await call("/api/remediation/retest", {
    method: "POST",
    body: JSON.stringify({ ...fields, wait_seconds: 0 }),
  });
  if (response.status === 422) {
    const { whole, shown } = await errorBody(response);
    if (!refusesWaitSeconds(422, whole)) {
      throw new EngineRefused(`the engine answered 422: ${shown}`, 422);
    }
    response = await call("/api/remediation/retest", { method: "POST", body: JSON.stringify(fields) });
  }

  if (response.status === 429) {
    // #71 refuses a full queue with a status that names the run it recorded
    // FAILED. Anything else on a 429 is the engine's words, as any refusal is.
    const { whole, shown } = await errorBody(response);
    let payload: unknown = null;
    try { payload = JSON.parse(whole); } catch { payload = null; }
    if (payload && typeof payload === "object" && (payload as Record<string, unknown>).answer === "status") {
      return { answer: "status", status: quotedStatus(statusOf(payload as Record<string, unknown>, 429)) };
    }
    throw new EngineRefused(`the engine answered 429: ${shown}`, 429);
  }
  if (response.status === 500) {
    // #71: a failure after the run was registered is a 500 status that still
    // names the run -- `state: null` when its work started (it is running, and
    // stoppable by this id), `failed` when it never did. Read as the status it
    // is (retestMayBeRunning). A 500 that names no run says nothing about
    // whether a retest started, as before. Read by its whole body (up to
    // MAX_PARSE_BODY), and quoted by its first MAX_ERROR_BODY characters.
    const { whole, shown: raw } = await errorBody(response);
    const named = statusAnswerOf(whole);
    const said = runsNamed(whole, response);
    const bodyId = named ? stopIdFrom(named.run_id) : null;
    if (named && bodyId !== null && headerAgrees(said, bodyId)) {
      return { answer: "status", status: quotedStatus(statusOf(named, 500)) };
    }
    // A 500 in a shape this reader does not take that still names a run, in
    // its body or its X-Run-Id header (or names two that differ): that run may
    // be live, so it is sent a stop (routes.ts), and nothing is filed.
    if (said.ids.length > 0) {
      throw new UnrecognisedRetestAnswer(
        `Unrecognised engine answer: HTTP 500 in a shape this dashboard does not read: ${raw || "(no body)"}. ` +
        `${namedSentence(said)} Nothing was filed.`,
        false, said.ids, namedByOf(said),
      );
    }
    throw new EngineUnavailable(`the engine answered 500: ${raw}`);
  }
  if (!response.ok) {
    const said = `the engine answered ${response.status}: ${await body(response)}`;
    // A 4xx is the engine refusing the retest; a 5xx says nothing about
    // whether it started one: a run its X-Run-Id header names is sent a stop
    // and keeps a Stop while that stop has not taken (routes.ts), as a scan
    // start's is; one it names none of holds its slot (mayHaveStarted).
    if (response.status >= 400 && response.status < 500) throw new EngineRefused(said, response.status);
    const named = { bodyId: null, headerIds: headerRunIds(response) };
    if (named.headerIds.length > 0) {
      throw new UnrecognisedRetestAnswer(`Unrecognised engine answer: ${said}. ${namedSentence(named)} Nothing was filed.`,
        false, named.headerIds, namedByOf(named));
    }
    throw new EngineUnavailable(said);
  }
  const rawRetest = await bodyWithin(response, engineTimeouts.bodyMs);
  if (rawRetest === null) {
    const stalled = `the engine sent the headers of its answer to a retest (${response.status}) but not the rest within ` +
      `${Math.round(engineTimeouts.bodyMs / 1000)} s, so it could not be read`;
    // A run its X-Run-Id header names is sent a stop, as any unread answer's
    // is (routes.ts); naming none, its slot is held (mayHaveStarted).
    const named = { bodyId: null, headerIds: headerRunIds(response) };
    if (named.headerIds.length > 0) {
      throw new UnrecognisedRetestAnswer(`Unrecognised engine answer: ${stalled}. ${namedSentence(named)} Nothing was filed.`,
        false, named.headerIds, namedByOf(named));
    }
    throw new EngineUnavailable(stalled);
  }
  let read: unknown = undefined;
  let retestIsJson = true;
  try {
    read = JSON.parse(rawRetest) as unknown;
  } catch {
    retestIsJson = false;
  }
  const named = runsNamed(rawRetest, response);
  if (!retestIsJson || !read || typeof read !== "object" || Array.isArray(read)) {
    // Only the X-Run-Id header can name a run here (runsNamed reads no id
    // from anything but an object's top level).
    throw new UnrecognisedRetestAnswer(
      `Unrecognised engine answer: HTTP ${response.status} whose body is not an object. ${namedSentence(named)} Nothing was filed.`,
      false, named.ids, namedByOf(named),
    );
  }
  const payload = read as Record<string, unknown>;
  const carriesRunId = payload.run_id !== undefined && payload.run_id !== null && payload.run_id !== "";
  // Every answer below that is refused sends a stop to each run it names
  // (routes.ts): a 202 is a live run, and an unread answer is never taken
  // as one that ended.
  const unread = (message: string) =>
    new UnrecognisedRetestAnswer(`${message} ${namedSentence(named)} Nothing was filed.`, carriesRunId, named.ids, namedByOf(named));
  // A body and an X-Run-Id header that name different runs, or a header that
  // names several: which run this retest is is not guessed.
  if (named.headerIds.length > 1 || (named.bodyId !== null && !headerAgrees(named, named.bodyId))) {
    throw unread(`Unrecognised engine answer: HTTP ${response.status} naming different runs.`);
  }

  if (!("answer" in payload)) {
    // Neither contract answers like this: main never answers 202, and never
    // sends `scan_record_id`. Read as main's verdict it would file a check
    // against an id that may be a registry uuid, so it is not read at all.
    if (response.status === 202 || "scan_record_id" in payload) {
      throw unread(
        `Unrecognised engine answer: HTTP ${response.status} with no \`answer\`` +
        ("scan_record_id" in payload ? " and a `scan_record_id`" : "") + ".",
      );
    }
    // Engine main: the verdict, with the record id under `run_id` and no id a
    // stop could name (the retest is over by the time it answers).
    return { answer: "verdict", result: verdictOf(payload, payload.run_id, null) };
  }
  // A 202 is a run still going, whatever else it says: never a verdict.
  if (response.status === 202 && payload.answer !== "status") {
    throw unread(`Unrecognised engine answer: HTTP 202 with answer ${JSON.stringify(payload.answer)}.`);
  }
  if (payload.answer === "verdict") {
    const verdict = verdictOf(payload, payload.scan_record_id, stopIdFrom(payload.run_id));
    // A verdict whose run ended ABORTED -- a stop landed while its check was
    // being filed -- is marked stopped after recording, with the engine's
    // `stopped_after_recording`, else its `reason`, else "aborted": never
    // read as a run that completed.
    return {
      answer: "verdict",
      result: payload.state === "aborted"
        ? { ...verdict, stoppedAfterRecording: verdict.stoppedAfterRecording || text(payload.reason) || "aborted" }
        : verdict,
    };
  }
  if (payload.answer === "status") {
    return { answer: "status", status: statusOf(payload, response.status) };
  }
  throw unread(`Unrecognised engine answer: answer ${JSON.stringify(payload.answer)} is neither a verdict nor a status.`);
}

/**
 * Where a retest run is now, read from the engine's `/api/scans/{run_id}` --
 * the `status_url` #71 answers with, built here from the run id rather than
 * followed, so a status read can only ever reach that route.
 *
 * A verdict only by the rule the engine answers a waiting caller by: the run
 * COMPLETED and its stored result carries one, or it was ABORTED after its
 * check was filed (the result carries the verdict and that check). A run that
 * failed keeps the runner's inconclusive verdict as its stored result, and one
 * stopped before it filed anything carries none; neither is a verdict on the
 * finding, and each is read as the status it is.
 */
export async function retestRun(engineRunId: string): Promise<RetestAnswer> {
  const response = await call(`/api/scans/${encodeURIComponent(engineRunId)}`);
  if (!response.ok) {
    throw new EngineUnavailable(
      `the engine answered ${response.status} when asked about retest run ${engineRunId}: ${await body(response)}`,
    );
  }
  const payload = (await jsonWithin(response, `retest run ${engineRunId}`).catch(() => null)) as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") {
    throw new EngineUnavailable(`the engine's answer about retest run ${engineRunId} could not be read`);
  }
  const state = text(payload.state) ?? "unknown";
  const result = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
    ? (payload.result as Record<string, unknown>)
    : null;
  if (payload.done === true && state === "completed" && result && typeof result.verdict === "string") {
    return {
      answer: "verdict",
      result: verdictOf(result, result.scan_record_id, stopIdFrom(result.run_id) ?? engineRunId),
    };
  }
  // athena-engine #71 (f4610ae): a stop that landed while the check was being
  // filed leaves the run ABORTED with the verdict and the check it filed as
  // its result -- the rule the engine answers a waiting caller 201 by. That
  // verdict is on the engine's chain: it is filed here too, marked as stopped
  // after it was recorded. A stopped run whose result filed no check (its
  // `{stopped, scan_incomplete}`) is a status, as before.
  if (payload.done === true && state === "aborted" && result && typeof result.verdict === "string"
    && result.check !== null && typeof result.check === "object" && !Array.isArray(result.check)) {
    const read = verdictOf(result, result.scan_record_id, stopIdFrom(result.run_id) ?? engineRunId);
    return {
      answer: "verdict",
      result: { ...read, stoppedAfterRecording: read.stoppedAfterRecording || text(payload.reason) || "aborted" },
    };
  }
  const error = state === "failed"
    ? text(result?.error) ?? text(result?.detail) ?? text(payload.reason)
    : null;
  return {
    answer: "status",
    status: {
      engineRunId,
      state,
      reason: text(payload.reason),
      error,
      httpStatus: response.status,
    },
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

  // Not known is null, never an empty list: a body that stalls or is not an object is not known.
  let payload: Record<string, unknown>;
  try {
    payload = objectOrUnread(await jsonWithin(response, "the list of extensions"), "the list of extensions");
  } catch {
    return null;
  }
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
