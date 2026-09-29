/**
 * One Idempotency-Key per press of Start scan, Retest or Push (shared/idempotency.ts).
 *
 * A press gets its own key, made here. While its outcome is unknown -- no
 * answer arrived, or the server said whether it started is not known -- a
 * press asking for exactly the same thing again is that press sent again, and
 * carries its key: the engine or the backend answers it from its record of
 * the first, and starts nothing. Any answer that says what happened lets the
 * key go, so the next press is a new action with a new key. Nothing here is
 * ever sent again on its own, and no stop is ever sent with a key.
 */
import { useRef } from "react";

import { IDEMPOTENCY_HEADER, actionFor, type KeyedAction } from "@shared/idempotency";
import { ApiError, UnauthorizedError } from "./queryClient";

/** The answers that say whether a press started is not known (server/routes.ts). */
const UNKNOWN_REASONS = new Set(["idempotency_in_flight", "scan_outcome_unknown", "push_outcome_unknown"]);

/** The answers that say this page sent a key wrongly: a bug, never the engine's or the backend's refusal. */
const BUG_REASONS = new Set(["idempotency_bug", "idempotency_key_invalid"]);

/**
 * Whether a failed press leaves its outcome unknown, so the same press sent
 * again goes with the same key: no answer arrived (the request threw, or a
 * gateway answered in the server's place), the server said so, or it said
 * what was asked may have started. False for every answer that says what
 * happened, and for one saying the first press raised before it was answered
 * (its key would be told "unknown" until it expires).
 */
export function outcomeUnknown(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return false;
  if (!(error instanceof ApiError)) return true;
  const body = error.body;
  if (body === null) return error.status >= 500;
  const reason = typeof body.reason === "string" ? body.reason : null;
  if (reason !== null && UNKNOWN_REASONS.has(reason)) {
    const record = body.idempotency;
    const state = record && typeof record === "object" ? (record as Record<string, unknown>).state : null;
    return state !== "unknown";
  }
  return body.mayStillBeRunning === true;
}

/** Whether a failure is this page sending a key wrongly: a bug, said as one. */
export function isKeyBug(error: unknown): boolean {
  return error instanceof ApiError && typeof error.body?.reason === "string" && BUG_REASONS.has(error.body.reason);
}

/** Whether the server said whether a press started is not known. */
export function saysOutcomeUnknown(error: unknown): boolean {
  return error instanceof ApiError && typeof error.body?.reason === "string" && UNKNOWN_REASONS.has(error.body.reason);
}

/** The press state of one button: the key its next send goes with, and how a send ended. */
export interface KeyedPress {
  /** The headers to send `request` with: this press's key (see above). */
  headersFor(request: unknown): Record<string, string>;
  /** A send answered: its key is let go. */
  answered(): void;
  /** A send failed: its key is kept only while its outcome is unknown. */
  failed(error: unknown): void;
}

/** A press state outside React (a component holds one in useKeyedPress). */
export function keyedPress(makeKey?: () => string): KeyedPress {
  let pending: KeyedAction | null = null;
  return {
    headersFor(request) {
      pending = actionFor(pending, request, makeKey);
      return { [IDEMPOTENCY_HEADER]: pending.key };
    },
    answered() {
      pending = null;
    },
    failed(error) {
      if (!outcomeUnknown(error)) pending = null;
    },
  };
}

/** One button's press state, kept across renders. */
export function useKeyedPress(): KeyedPress {
  const press = useRef<KeyedPress | null>(null);
  press.current ??= keyedPress();
  return press.current;
}
