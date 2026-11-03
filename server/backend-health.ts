/**
 * Athena-Backend's health, read in the background for the console's health strip.
 *
 * The backend's `GET /api/health/` (Athena-Backend #217) says whether the process
 * that answers lost or refused anything an operator must act on, with the counts
 * (shared/backend-health.ts reads the answer, strictly). An operator who never
 * opens that URL never saw any of it; the console now shows it on every screen.
 *
 * OFF EVERY STOP PATH (SAFETY RULE). Nothing a stop, the kill switch or a
 * failsafe action does waits on, or calls, anything in this file:
 *
 *   - The route (`GET /api/backend-health`) answers from memory, at once: the
 *     reading taken last. It never reads the backend itself, so it holds none
 *     of the browser's few connections to this server while the backend is slow.
 *   - The read is a timer's, one at a time, each bounded (headers and body
 *     together) by `backendHealthTimings.timeoutMs`; one that does not answer,
 *     or answers anything but 200, is retried later and later (doubling, up to
 *     `maxBackoffMs`), so a backend in trouble is not asked over and over.
 *   - It is plain `fetch` to a route the backend serves to anyone (AllowAny):
 *     no person's sign-in, no service token, no refresh -- nothing a stop's
 *     credential or a person's sign-in waits on is touched.
 *   - It reads only once the server's entry point has started it
 *     (startBackendHealthReads, beside the AI Health sampler in server/index.ts
 *     and server/index-electron.ts), and then only while someone is looking: it
 *     reads when the console asks, and stops `idleMs` after the last ask.
 *
 * A reading older than `staleMs` (the backend not asked for that long) is never
 * served as "ok".
 */

import { baseUrl } from "./control-plane";
import { classifyHealth, type BackendHealthReading, type HealthOutcome } from "@shared/backend-health";

export const backendHealthTimings = {
  /** Between two reads while each answers 200. */
  pollMs: 15_000,
  /** One read, headers and body together. */
  timeoutMs: 5_000,
  /** The longest wait between two reads after reads that did not answer 200. */
  maxBackoffMs: 120_000,
  /** Reading stops this long after the console last asked. */
  idleMs: 120_000,
  /** A reading older than this is not served as "ok". */
  staleMs: 180_000,
};

/** The most of the backend's answer read. A health answer is a few hundred bytes. */
export const MAX_HEALTH_BODY_BYTES = 64 * 1024;

/** What the console's route answers. */
export type BackendHealthView =
  | { configured: false }
  | {
      configured: true;
      reading: BackendHealthReading;
      /** When the reading was taken (ISO), or null when none has been yet. */
      checkedAt: string | null;
      /** How old the reading was when served, in ms; null when none has been taken. */
      ageMs: number | null;
    };

interface Taken {
  base: string;
  reading: BackendHealthReading;
  checkedAt: number;
}

let taken: Taken | null = null;
let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** The wait the pending timer was set for, or null when none is pending. */
let timerDelayMs: number | null = null;
/** Reads in a row that did not answer 200: the next one waits longer for each. */
let misses = 0;
let lastAskedAt = 0;
/** Bumped by _resetBackendHealthForTests: a read begun before it is not kept. */
let generation = 0;
/** Set by the entry point (startBackendHealthReads): until then the console's asks read nothing. */
let started = false;

/**
 * Let the console's asks read the backend's health. Called once by each entry
 * point, as the AI Health sampler is started there: an app made for a test
 * reads nothing unless the test starts it.
 */
export function startBackendHealthReads(): void {
  started = true;
}

function why(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause;
    const detail = inner instanceof Error && inner.message ? ` (${inner.message})` : "";
    return `${cause.message}${detail}`;
  }
  return String(cause);
}

/** The body as text, or null when it is larger than MAX_HEALTH_BODY_BYTES (the rest is not read). */
async function cappedText(response: Response): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_HEALTH_BODY_BYTES) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** One read of `${base}/api/health/`, bounded by timeoutMs, headers and body together. Never throws. */
async function readOnce(base: string): Promise<HealthOutcome> {
  const ms = backendHealthTimings.timeoutMs;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), ms);
  (deadline as { unref?: () => void }).unref?.();
  try {
    let response: Response;
    try {
      response = await fetch(`${base}/api/health/`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (cause) {
      if (controller.signal.aborted) return { kind: "timeout", ms };
      return { kind: "unreachable", why: why(cause) };
    }
    let text: string | null;
    try {
      text = await cappedText(response);
    } catch (cause) {
      if (controller.signal.aborted) return { kind: "timeout", ms };
      return { kind: "unreadable", httpStatus: response.status, why: `its body was cut: ${why(cause)}` };
    }
    if (text === null) {
      return { kind: "unreadable", httpStatus: response.status, why: `it is larger than ${MAX_HEALTH_BODY_BYTES / 1024} KB` };
    }
    try {
      return { kind: "answered", httpStatus: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { kind: "unreadable", httpStatus: response.status, why: "it is not JSON" };
    }
  } catch (cause) {
    return { kind: "unreachable", why: why(cause) };
  } finally {
    clearTimeout(deadline);
  }
}

function missed(outcome: HealthOutcome): boolean {
  return outcome.kind !== "answered" || outcome.httpStatus !== 200;
}

/** The wait before the next read: pollMs, doubled for each read in a row that did not answer 200, up to maxBackoffMs. */
export function nextReadDelay(missesInARow: number): number {
  const { pollMs, maxBackoffMs } = backendHealthTimings;
  if (missesInARow <= 0) return pollMs;
  return Math.min(maxBackoffMs, pollMs * 2 ** Math.min(missesInARow, 20));
}

/** Read the backend's health now (unless a read is under way), and keep the reading. Never throws. */
export function readBackendHealthNow(): Promise<void> {
  if (inFlight) return inFlight;
  const base = baseUrl();
  if (!base) return Promise.resolve();
  // A read now replaces the one the timer would have made; the next is scheduled after it.
  if (timer !== null) clearTimeout(timer);
  timer = null;
  timerDelayMs = null;
  const mine = generation;
  const read = (async () => {
    const outcome = await readOnce(base);
    if (mine !== generation) return;
    misses = missed(outcome) ? misses + 1 : 0;
    taken = { base, reading: classifyHealth(outcome), checkedAt: Date.now() };
  })().catch((cause) => {
    console.warn(`[backend-health] the reading could not be kept: ${why(cause)}`);
  }).finally(() => {
    if (inFlight === read) inFlight = null;
    if (mine === generation) schedule();
  });
  inFlight = read;
  return read;
}

/** The next read, after nextReadDelay -- unless no one has asked for idleMs, or no backend is configured. */
function schedule(): void {
  if (timer !== null || inFlight !== null) return;
  if (!started || !baseUrl() || Date.now() - lastAskedAt > backendHealthTimings.idleMs) return;
  const delay = nextReadDelay(misses);
  timerDelayMs = delay;
  timer = setTimeout(() => {
    timer = null;
    timerDelayMs = null;
    void readBackendHealthNow();
  }, delay);
  (timer as { unref?: () => void }).unref?.();
}

/** How long the pending timer waits before the next read, or null when no read is scheduled. */
export function backendHealthNextReadInMs(): number | null {
  return timerDelayMs;
}

/** Whether a read is under way or waiting on its timer. */
export function backendHealthReading(): boolean {
  return inFlight !== null || timer !== null;
}

/**
 * What the console's route serves: the last reading, from memory. Never reads
 * the backend itself; it starts the background reads when none are going.
 */
export function backendHealth(now: number = Date.now()): BackendHealthView {
  const base = baseUrl();
  if (!base) return { configured: false };
  lastAskedAt = now;
  if (started && inFlight === null && timer === null) void readBackendHealthNow();
  if (taken === null || taken.base !== base) {
    return {
      configured: true,
      checkedAt: null,
      ageMs: null,
      reading: classifyNotYet(),
    };
  }
  const ageMs = Math.max(0, now - taken.checkedAt);
  return { configured: true, checkedAt: new Date(taken.checkedAt).toISOString(), ageMs, reading: stale(taken.reading, ageMs) };
}

function classifyNotYet(): BackendHealthReading {
  return {
    ...classifyHealth({ kind: "answered", httpStatus: 200, body: {} }),
    verdict: "unknown",
    headline: "Athena-Backend's health has not been read yet",
    problems: [],
  };
}

/** A reading older than staleMs is said to be, and is never "ok" or "not-reported". */
function stale(reading: BackendHealthReading, ageMs: number): BackendHealthReading {
  if (ageMs <= backendHealthTimings.staleMs) return reading;
  const old = `the last reading is ${Math.round(ageMs / 1000)} s old`;
  if (reading.verdict === "ok" || reading.verdict === "not-reported") {
    return { ...reading, verdict: "unknown", headline: `Athena-Backend's health is not current: ${old}`, problems: [...reading.problems, old] };
  }
  return { ...reading, problems: [...reading.problems, old] };
}

/** Test seam: forget every reading and stop reading. */
export function _resetBackendHealthForTests(): void {
  generation += 1;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  timerDelayMs = null;
  inFlight = null;
  taken = null;
  misses = 0;
  lastAskedAt = 0;
  started = false;
}
