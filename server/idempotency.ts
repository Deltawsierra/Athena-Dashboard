/**
 * The Idempotency-Key a page sends with a scan start, a retest or a connector
 * push (shared/idempotency.ts), as this server passes it on.
 *
 * The page makes one key per press and sends it with every send of that press.
 * This server reads it, refuses one that is not a key (400: a bug in the page,
 * and nothing is sent anywhere), and passes it on to the engine or the backend
 * scoped to the account that sent it: this server calls both with one
 * credential of its own, so a key is made per account here, as each of them
 * makes one per credential. The same account and key always pass on the same
 * value, in any process; two accounts never share one.
 *
 * A key is never read on a stop: the abort routes, the kill switch and the
 * failsafe relays take none, and pass none on.
 */
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { IDEMPOTENCY_HEADER, readableKey } from "@shared/idempotency";

/** The key a request carries: none (null), a key, or a refusal of one that is not a key. */
export function keyOf(req: Request): { key: string } | { refused: string } | null {
  const raw = req.get(IDEMPOTENCY_HEADER);
  if (raw === undefined) return null;
  const key = readableKey(raw);
  return key === null
    ? { refused: `${IDEMPOTENCY_HEADER} must be 1 to 255 printable ASCII characters: this page sent one that is not, which is a bug in the page. Nothing was sent.` }
    : { key };
}

/** The key passed on for `account`'s `key` (above). */
export function forwardedKey(account: string, key: string): string {
  return `athena-dashboard:${crypto.createHash("sha256").update(`${account}\u0000${key}`).digest("hex")}`;
}

/**
 * Keys this process is sending on now. A second request with one while the
 * first is still being answered is told so, and sends nothing: two sends of
 * one press must not both record what they started.
 */
const sending = new Set<string>();

/**
 * Take `key` for this request, until its handler ends (releasing): false when
 * another request holds it. Never let go when the connection closes -- a
 * connection that closed early is the lost answer a second press follows, and
 * the first send's handler is still recording what it started.
 */
export function hold(res: Response, key: string): boolean {
  if (sending.has(key)) return false;
  sending.add(key);
  ((res.locals.heldKeys ??= []) as string[]).push(key);
  return true;
}

/** A route handler whose held keys are let go when it ends, however it ends. */
export function releasing(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => Promise<unknown> {
  return async (req, res, next) => {
    try {
      return await fn(req, res, next);
    } finally {
      for (const key of (res.locals.heldKeys ?? []) as string[]) sending.delete(key);
    }
  };
}

/** Said when a press is sent again while its first send is still being answered here. */
export function stillBeingAnswered(whereToLook: string): string {
  return "The first press of this action is still being answered, so whether it started is not known yet, and " +
    `this one sent nothing. Check ${whereToLook}, or wait for the first to answer.`;
}
