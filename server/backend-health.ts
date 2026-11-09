/**
 * Athena-Backend's health, for the console (DASH-HEALTH-PANEL).
 *
 * `GET /api/backend-health` answers AT ONCE with the last reading of
 * Athena-Backend's `GET /api/health/` (athena-backend #217, #226), read strictly
 * (shared/backend-health.ts): "ok" only when the backend said "ok" with every
 * count reported and zero.
 *
 * SAFETY: the health read is on no stop's path.
 *
 *   - It is polled in the background (startBackendHealthPolling, started by the
 *     two entry points beside the AI Health sampler), never by a request. The
 *     route only answers with what was last read, so a browser connection is held
 *     for no longer than it takes to write a small JSON answer, and a stalled
 *     backend can never fill the browser's few connections ahead of a stop, the
 *     kill switch or a failsafe action.
 *   - The read is its own request on its own socket (`agent: false`), with no
 *     credential at all (the backend's health check is AllowAny and takes none),
 *     so it shares no token, no sign-in and no connection with a stop. It resolves
 *     the address through the DNS cache (server/dns-cache.ts), like every
 *     control-plane call.
 *   - It has ONE total deadline, connect, headers and body together
 *     (`backendHealthTiming.deadlineMs`), and a cap on the body it reads; past
 *     either the request is destroyed.
 *   - It backs off on failure: after a read that got no readable answer, the next
 *     is `everyMs` doubled per failure in a row, up to `maxBackoffMs`.
 *   - Its timer is unref'd: it never keeps the process up.
 *
 * A reading is never shown older than it is: an "ok", "degraded" or uncounted
 * reading taken more than `staleAfterMs` ago is answered as "unknown", with its
 * age.
 */
import http from "node:http";
import https from "node:https";
import type { Express } from "express";
import * as dnsCache from "./dns-cache";
import {
  interpretHealth,
  notConfigured,
  unreachable,
  type BackendHealthReading,
  type BackendHealthView,
} from "@shared/backend-health";

const FAILSAFE_URL_ENV = "ATHENA_FAILSAFE_URL";

/** How the health check is read. Tests shorten these. */
export const backendHealthTiming = {
  /** Connect, headers and body together. */
  deadlineMs: 5_000,
  /** Between two reads, after one that was answered. */
  everyMs: 15_000,
  /** The most time between two reads, backing off after failures. */
  maxBackoffMs: 300_000,
  /** An "ok" or "degraded" older than this is answered as unknown. */
  staleAfterMs: 60_000,
  /** The most of the answer read; more is not read. */
  maxBodyBytes: 64 * 1024,
};

function baseUrl(): string | null {
  const raw = (process.env[FAILSAFE_URL_ENV] ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

interface Taken {
  reading: BackendHealthReading;
  at: number;
  /** The base URL it was read from: a reading of another backend is not shown. */
  from: string;
}

let last: Taken | null = null;
let inFlight: Promise<void> | null = null;
let failuresInARow = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
/** Bumped on every stop or reset: a read started before it is not kept. */
let generation = 0;

/** Test seam: stop polling, forget every reading, and keep no read started before. */
export function _resetBackendHealthForTests(): void {
  stopBackendHealthPolling();
  last = null;
  inFlight = null;
  failuresInARow = 0;
}

/** The wait before the next read, after `failures` in a row (none: `everyMs`). */
export function backoffMs(failures: number): number {
  if (failures <= 0) return backendHealthTiming.everyMs;
  return Math.min(backendHealthTiming.maxBackoffMs, backendHealthTiming.everyMs * 2 ** Math.min(failures, 30));
}

/** How long until the next read, as now scheduled (null: none is). For tests and the log. */
let nextInMs: number | null = null;
export function nextReadInMs(): number | null {
  return nextInMs;
}

/**
 * One read of `${base}/api/health/`, bounded by the deadline. Never throws:
 * every outcome is a reading, and whether it counts as a failure for back-off.
 */
export function readOnce(base: string): Promise<{ reading: BackendHealthReading; failed: boolean }> {
  return new Promise((settle) => {
    let target: URL;
    try {
      target = new URL(`${base}/api/health/`);
    } catch {
      settle({ reading: unreachable(`the Athena-Backend address could not be read as a URL`), failed: true });
      return;
    }
    let done = false;
    const finish = (reading: BackendHealthReading, failed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      settle({ reading, failed });
    };
    const seconds = backendHealthTiming.deadlineMs < 1000
      ? `${backendHealthTiming.deadlineMs} ms`
      : `${Math.round(backendHealthTiming.deadlineMs / 1000)} s`;
    const timer = setTimeout(
      () => finish(unreachable(`Athena-Backend's health check did not answer within ${seconds}`), true),
      backendHealthTiming.deadlineMs,
    );
    timer.unref?.();
    const req = (target.protocol === "https:" ? https : http).request(target, {
      method: "GET",
      headers: { Accept: "application/json" },
      // Its own socket: nothing a stop uses is shared or held.
      agent: false,
      lookup: dnsCache.lookup,
    }, (res) => {
      const status = res.statusCode ?? 0;
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > backendHealthTiming.maxBodyBytes) {
          finish({
            ...interpretHealth(status, null),
            reasons: [`Athena-Backend's health answer is larger than ${backendHealthTiming.maxBodyBytes} bytes, so it was not read`],
          }, true);
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const reading = interpretHealth(status, Buffer.concat(chunks).toString("utf8"));
        // An HTTP error, or an answer with no status that can be read, is a failure to read: back off.
        finish(reading, status < 200 || status > 299 || reading.backendStatus === null);
      });
      res.on("error", () => finish(unreachable("Athena-Backend's health answer was cut off before it ended"), true));
      res.on("aborted", () => finish(unreachable("Athena-Backend's health answer was cut off before it ended"), true));
    });
    req.on("error", (cause) => {
      const code = (cause as NodeJS.ErrnoException).code;
      finish(unreachable(`Athena-Backend could not be reached for its health check${code ? ` (${code})` : ""}`), true);
    });
    req.end();
  });
}

/** One read, its reading kept, and the next one scheduled: sooner after an answer, later after each failure. */
function tick(): void {
  timer = null;
  if (!polling || inFlight) return;
  const mine = generation;
  const base = baseUrl();
  if (!base) {
    schedule(backendHealthTiming.everyMs);
    return;
  }
  const read = readOnce(base).then(({ reading, failed }) => {
    if (mine !== generation) return; // stopped or reset meanwhile
    last = { reading, at: Date.now(), from: base };
    failuresInARow = failed ? failuresInARow + 1 : 0;
  }).finally(() => {
    if (inFlight === read) inFlight = null;
    if (mine === generation) schedule(backoffMs(failuresInARow));
  });
  inFlight = read;
}

function schedule(ms: number): void {
  if (!polling) return;
  if (timer !== null) clearTimeout(timer);
  nextInMs = ms;
  timer = setTimeout(tick, ms);
  timer.unref?.();
}

/**
 * Start reading the backend's health in the background: now, then every
 * `everyMs`, backing off after failures. Called by the entry points; never on a
 * request, and never awaited.
 */
export function startBackendHealthPolling(): void {
  if (polling) return;
  polling = true;
  tick();
}

/** Stop the polling (a read under way is left to its deadline, and not kept). */
export function stopBackendHealthPolling(): void {
  polling = false;
  generation += 1;
  nextInMs = null;
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

/** The reading to answer with now. Synchronous: it reads nothing and never waits. */
export function currentView(now = Date.now()): BackendHealthView {
  const base = baseUrl();
  if (!base) return { ...notConfigured(), readAt: null, reading: false };
  const reading = inFlight !== null;
  if (!last || last.from !== base) {
    return {
      ...unreachable("Athena-Backend's health has not been read yet"),
      state: "unknown",
      readAt: null,
      reading,
    };
  }
  const readAt = new Date(last.at).toISOString();
  const age = now - last.at;
  if ((last.reading.state === "ok" || last.reading.state === "degraded" || last.reading.state === "uncounted")
    && age > backendHealthTiming.staleAfterMs) {
    return {
      ...last.reading,
      state: "unknown",
      reasons: [`the last reading of Athena-Backend's health is ${Math.round(age / 1000)} s old, so it is not shown as current`, ...last.reading.reasons],
      readAt,
      reading,
    };
  }
  return { ...last.reading, readAt, reading };
}

/**
 * `GET /api/backend-health`: behind requireAuth like every /api read (mounted
 * after it in server/routes.ts). Answers at once with the last reading; it
 * starts no read and never waits on the backend.
 */
export function registerBackendHealthRoutes(app: Express): void {
  app.get("/api/backend-health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(currentView());
  });
}
