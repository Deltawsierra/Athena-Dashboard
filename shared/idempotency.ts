/**
 * An Idempotency-Key per user action (roadmap Phase 4).
 *
 * A person who presses Start scan, Retest or Push and never sees the answer --
 * the connection dropped, the page was reloaded, the wait gave up -- presses
 * again. Without a key, that second press started a second scan of the same
 * customer, or filed a second ticket in their tracker. With one, the engine
 * (athena-engine #77, `POST /api/scan`) and the backend (athena-backend #113,
 * the connector push) answer the second press from their record of the first,
 * and start nothing.
 *
 * One press is one action and gets one key, made by the page
 * (crypto.randomUUID). The key goes with every send of THAT action -- the
 * press sent again because its outcome is unknown -- and never with another
 * action, which gets its own. It is never sent with a stop.
 *
 * What an answer under a key says (the engine's and the backend's alike):
 *   2xx `Idempotent-Replayed: true`  the answer the FIRST send got: the
 *                                    original answer, not a new start.
 *   409 with `idempotency`           the first send has no answer recorded:
 *                                    whether it started is unknown. Never sent
 *                                    again with a new key.
 *   422 with `idempotency`           the same key with a different request: a bug.
 *   400 "Idempotency-Key ..."        a key that is not one: a bug.
 */

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
/** Set on an answer that is the one the first send with its key was given. */
export const REPLAYED_HEADER = "Idempotent-Replayed";
export const MAX_KEY_LENGTH = 255;

/** A key as the engine and the backend accept one: 1 to 255 printable ASCII characters, trimmed. Anything else is null. */
export function readableKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  return key.length > 0 && key.length <= MAX_KEY_LENGTH && /^[\x20-\x7e]+$/.test(key) ? key : null;
}

/**
 * What an answer says about the record its key was given, `idempotency`: its
 * state (`in_flight`, `unknown`, `done`), or null when the answer says nothing
 * of a key -- then it is the route's own answer (a stood-down engine's 409, a
 * refused scope's 403), never one about the key.
 */
export function keyRecordOf(body: unknown): { state: string | null } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = (body as Record<string, unknown>).idempotency;
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const state = (record as Record<string, unknown>).state;
  return { state: typeof state === "string" ? state : null };
}

/** Whether a 400 is the one a key that is not one gets. */
export function refusesTheKey(status: number, body: unknown): boolean {
  if (status !== 400 || !body || typeof body !== "object" || Array.isArray(body)) return false;
  const detail = (body as Record<string, unknown>).detail;
  return typeof detail === "string" && detail.startsWith(IDEMPOTENCY_HEADER);
}

/** One user action: the key it is sent with, and the request it is. */
export interface KeyedAction {
  key: string;
  request: string;
}

/** A new key: crypto.randomUUID where it exists (a secure context), else a UUID v4 from crypto.getRandomValues. */
export function newKey(
  source: { getRandomValues(array: Uint8Array): Uint8Array; randomUUID?: () => string } = globalThis.crypto,
): string {
  if (typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The action a press sends. While an earlier action's outcome is unknown, a
 * press asking for exactly its request again is that action sent again, with
 * its key. Anything else -- another request, or any press once the earlier one
 * was answered -- is a new action, with a new key.
 */
export function actionFor(
  pending: KeyedAction | null,
  request: unknown,
  makeKey: () => string = () => newKey(),
): KeyedAction {
  const text = JSON.stringify(request);
  if (pending !== null && pending.request === text) return pending;
  return { key: makeKey(), request: text };
}
