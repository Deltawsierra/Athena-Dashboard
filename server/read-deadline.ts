/**
 * One total deadline for a relay read: the most a read this server passes on from
 * a backend may hold the browser's connection, from its arrival to its last byte,
 * headers and body together. Extracted from the economics relay (#67, review
 * round 1, MEDIUM-3) so every non-stop relay read keeps the same bound.
 *
 * Why (the SAFETY rule): a browser keeps few connections to one origin --
 * Chromium, so Electron, six over HTTP/1.1 -- and every request past them waits
 * for one to free, a pause or the kill switch included. A relay read the backend
 * stalls, mid-answer or before it, would hold one of them for as long as the
 * backend let it. Past the deadline the browser is answered 504 (or, when the
 * answer had begun, its connection is cut) and the backend read is cancelled, so
 * stalled reads can never fill the browser's connections ahead of a stop. The
 * views also cancel a read they no longer show (lib/queryClient.ts).
 *
 * What is never bounded here: a stop, pause, stand-down, terminate or revoke. The
 * deadline is laid on GET (and HEAD) requests only, by `boundedRelayRead`, and a
 * dashboard stop is never a GET. Its relay call is also refused the read's signal
 * (`readSignalFor` in server/control-plane.ts answers nothing for `stop`), so a
 * stop made while a read is being served is still never cut by that read's
 * deadline. The failsafe console's reads, which the control plane judges stops
 * (failsafe:state, failsafe:commands, failsafe:command-detail), are not mounted
 * here at all: server/failsafe.ts bounds each of them itself (failsafeTimeouts).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler, Response } from "express";

/** The deadline: 20 s for headers and body together. */
export const READ_DEADLINE_MS = 20_000;
let deadlineMs = READ_DEADLINE_MS;

/** The deadline in force (tests shorten it). */
export function readDeadlineMs(): number {
  return deadlineMs;
}

/** Test seam: a shorter deadline, or back to the default with null. */
export function _setReadDeadlineForTests(ms: number | null): void {
  deadlineMs = ms ?? READ_DEADLINE_MS;
}

/** Who did not answer, and what: the 504's sentence, fixed (no address, no detail). */
export interface ReadSubject {
  /** "Athena-Backend", "the engine", "the assistant". */
  who: string;
  /** "the report of a stored result", "this assurance read". */
  what: string;
}

/**
 * Start a read's total deadline on `res`. Past it -- unless the answer has
 * finished -- `cancel` is called (cancelling the backend read) and the browser is
 * answered 504 `backend_timeout`, or, when the answer had begun, its connection is
 * cut. A browser that goes away cancels the backend read too. `passed()` says
 * whether the deadline has fired.
 */
export function startReadDeadline(res: Response, subject: ReadSubject, cancel: () => void): { passed: () => boolean } {
  let passed = false;
  const timer = setTimeout(() => {
    if (res.writableFinished) return;
    console.warn(`[read-deadline] the read of ${subject.what} passed its ${deadlineMs} ms deadline: cut`);
    // The browser first, then the mark (so the handler's own answer, when it comes,
    // is dropped), then the backend read: its cancellation only fails the handler later.
    if (!res.headersSent) {
      res.status(504).json({ error: `${subject.who} did not answer ${subject.what} in time`, code: "backend_timeout" });
    } else {
      res.destroy();
    }
    passed = true;
    cancel();
  }, deadlineMs);
  (timer as { unref?: () => void }).unref?.();
  res.on("close", () => {
    clearTimeout(timer);
    if (!res.writableFinished) cancel();
  });
  res.on("finish", () => clearTimeout(timer));
  return { passed: () => passed };
}

/** The read deadline's signal of the request being served, if it is a bounded read. */
const reads = new AsyncLocalStorage<{ signal: AbortSignal }>();

/**
 * The abort signal of the bounded read being served, or undefined outside one. A
 * relay client lays it on its backend request so the deadline, or a browser that
 * went away, cancels the backend read too. Never for a stop: the caller asks for
 * it only for a read (server/control-plane.ts `readSignalFor`).
 */
export function currentReadSignal(): AbortSignal | undefined {
  return reads.getStore()?.signal;
}

/**
 * Middleware: bound every GET (or HEAD) it sees by the read deadline. Any other
 * method passes untouched -- a stop is never a GET. Once the deadline has
 * answered, the handler's own answer, when it comes, is dropped (the browser has
 * had its 504), so a late answer never meets "headers already sent".
 */
export function boundedRelayRead(subject: ReadSubject): RequestHandler {
  // Named, so a test can find every route this layer stands in front of.
  return function boundedRelayReadLayer(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    const controller = new AbortController();
    const deadline = startReadDeadline(res, subject, () => controller.abort());
    for (const name of ["status", "json", "send", "end", "set", "setHeader", "type"] as const) {
      const original = (res[name] as (...args: unknown[]) => unknown).bind(res);
      (res as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => (deadline.passed() ? res : original(...args));
    }
    reads.run({ signal: controller.signal }, () => next());
  };
}
