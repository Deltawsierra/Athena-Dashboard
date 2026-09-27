import type { Request, RequestHandler } from "express";
import "express-session";
import { storage } from "./storage-unified";
import type { User } from "@shared/schema";
import { hashApiKey, API_KEY_PREFIX } from "./api-keys";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    username?: string;
    role?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The account behind the session, re-read on every guarded request. */
      currentUser?: User;
      /** Set when requireAdmin authorised a stop from the session in memory, without reading the account. */
      authorisedFromSession?: boolean;
      /** Set when a signature relay was authorised though its command's action could not be learnt in time: it may be a stop's. */
      relayedAsPossibleStop?: boolean;
    }
  }
}

/**
 * Load the account the session belongs to.
 *
 * The guards used to trust the userId and role written into the session at
 * login. That snapshot outlived the account: demoting, deactivating or even
 * deleting a user had no effect on any session they already held, for the
 * seven-day life of the cookie. A demoted admin could re-promote themselves
 * and reset the real admin's password.
 */
async function loadSessionUser(req: Request): Promise<User | undefined> {
  const id = req.session?.userId;
  if (!id) return loadApiKeyUser(req);

  const user = await storage.getUser(id);
  // What the record says now is what the directory holds from now on.
  if (user) noteAccount(user);
  else noteAccountDeleted(id);
  if (!user || !user.isActive) return undefined;

  req.currentUser = user;
  return user;
}

/**
 * The presented API key, from `X-API-Key` or an `Authorization: Bearer` header.
 * Only a value carrying this server's key marker is treated as a key, so an
 * ordinary bearer token (a session, a third party's token) is never mistaken for
 * one.
 */
function presentedApiKey(req: Request): string | undefined {
  const header = req.headers["x-api-key"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === "string" && fromHeader.startsWith(API_KEY_PREFIX)) {
    return fromHeader.trim();
  }
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token.startsWith(API_KEY_PREFIX)) return token;
  }
  return undefined;
}

/**
 * Authenticate a request by API key when there is no session behind it.
 *
 * The key is hashed and matched against the stored hashes; a revoked key never
 * matches (the lookup excludes them). A match authenticates as the account that
 * created the key — with its current role and active state, re-read every time,
 * so revoking or demoting that account takes effect at once. The plaintext is
 * never compared or stored; only its hash is looked up.
 */
async function loadApiKeyUser(req: Request): Promise<User | undefined> {
  const presented = presentedApiKey(req);
  if (!presented) return undefined;

  const record = await storage.findActiveApiKeyByHash(hashApiKey(presented));
  if (!record || !record.createdBy) return undefined;

  const user = await storage.getUser(record.createdBy);
  if (user) noteAccount(user);
  if (!user || !user.isActive) return undefined;

  touchOnce(req, record.id);
  req.currentUser = user;
  return user;
}

/** The requests whose key's usage stamp has been sent: one stamp per request, however many guards authenticate it. */
const touched = new WeakSet<Request>();

/**
 * The key's usage stamp, a write, for a request: sent once, and never waited
 * on. It used to be awaited, by every guard -- twice for an admin's stop -- so
 * a database held locked by another connection held an API key's Stop, and
 * its kill switch, for the whole of the write's wait (5 s, then 10 s). It now
 * takes its place in the write line (storage-sqlite.ts withBusyRetry) while
 * the request goes on; a stamp that fails is logged and counted
 * (apiKeyTouches.failed), and fails nothing.
 */
function touchOnce(req: Request, keyId: string): void {
  if (touched.has(req)) return;
  touched.add(req);
  apiKeyTouches.sent += 1;
  let pending: Promise<void>;
  try {
    pending = Promise.resolve(storage.touchApiKey(keyId));
  } catch (cause) {
    pending = Promise.reject(cause);
  }
  pending.catch((cause: unknown) => {
    apiKeyTouches.failed += 1;
    console.error(`[auth] the usage stamp of API key ${keyId} could not be written (the request went on): ` +
      `${cause instanceof Error ? cause.message : String(cause)}`);
  });
}

/** How many API-key usage stamps were sent, and how many of them failed. */
export const apiKeyTouches = { sent: 0, failed: 0 };

/**
 * Every account this process has signed in, or changed, as it is now: its role
 * and whether it may still sign in (null once deleted). A stop is authorised
 * from the session -- from memory, never from a read -- and the session's
 * role is taken from here, so it follows the account the moment an admin
 * changes it: a demoted admin's live session is refused the kill switch at
 * once, a deactivated or deleted account's live sessions stop authorising
 * anything, and a user promoted while signed in may engage it straight away.
 * Kept current by sign-in, by every guard that reads the account, and by the
 * user routes when they change or delete one (noteAccount / noteAccountDeleted).
 */
const accounts = new Map<string, { role: string; isActive: boolean } | null>();

/** Remember an account as it is now: at sign-in, on every read of it, and when an admin changes it. */
export function noteAccount(user: Pick<User, "id" | "role" | "isActive">): void {
  accounts.set(user.id, { role: user.role, isActive: user.isActive !== false });
}

/** Remember that an account is gone: its live sessions authorise nothing from now on. */
export function noteAccountDeleted(id: string): void {
  accounts.set(id, null);
}

/**
 * Bring the live sessions of one account in line with it, in the session
 * store (memory): its sessions take its new role, and are ended when it was
 * deactivated or deleted. Best-effort and in the background -- the account
 * directory above already decides every stop -- so a store that cannot be
 * walked holds nothing up.
 */
export function reviseLiveSessions(
  store: import("express-session").Store | undefined,
  id: string,
  now: Pick<User, "role" | "isActive"> | null,
): void {
  if (!store || typeof store.all !== "function") return;
  try {
    store.all((error, sessions) => {
      if (error || !sessions) return;
      const entries: Array<[string, import("express-session").SessionData]> = Array.isArray(sessions)
        ? []
        : Object.entries(sessions as Record<string, import("express-session").SessionData>);
      for (const [sid, data] of entries) {
        if (data?.userId !== id) continue;
        if (now === null || now.isActive === false) store.destroy(sid, () => undefined);
        else if (data.role !== now.role) store.set(sid, { ...data, role: now.role } as import("express-session").SessionData, () => undefined);
      }
    });
  } catch {
    // The directory decides; the store is only kept tidy.
  }
}

/**
 * Whether a request is a stop, authorised from the signed-in session alone --
 * held in memory -- and never waiting on the database: an account lookup that
 * is slow, or a database that is locked or failing, must not stand between a
 * stop and what it stops.
 *
 *   - a scan's Stop, and a retest's Stop;
 *   - engaging the kill switch (a PATCH whose body sets `killSwitchEnabled:
 *     true`). Only the switch itself is authorised from memory: any other
 *     field sent with it is authorised from the account, after the stops are
 *     sent (routes.ts, PATCH /api/ai-control);
 *   - drafting a failsafe pause, stand-down or terminate;
 *   - revoking an API key: it only takes access away. From memory only for a
 *     key of the session's own account; revoking another account's key reads
 *     the account first (routes.ts, DELETE /api/api-keys/:id).
 *
 * Relaying a signature to a failsafe command is NOT one of these by its path:
 * whether it is a stop depends on the command's action, which only the
 * control plane knows. It is decided by requireAdminUnlessStop, from that
 * action: a pause's, a stand-down's or a terminate's -- or one whose action
 * could not be learnt within its deadline, which may be a stop's -- is
 * authorised from memory; a resume's or a release's from the account, read
 * now.
 *
 * The session's role is the account's as this process knows it now
 * (sessionUser), not as it was at sign-in. What this process knows can be
 * stale -- another dashboard on the same database may have demoted or
 * deleted the account -- and that is why only stops are ever decided from it:
 * a stale account may gain nothing but a stop. The one exception is a relay
 * whose command's action could not be learnt in time: it is relayed as a
 * possible stop, so a resume's signature from such a session goes through
 * only when the control plane's own read of that command also fails -- and
 * the control plane still verifies the keyholders' signatures on it.
 */
export function isStopRequest(req: Request): boolean {
  const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, "");
  if (req.method === "POST" && /^\/api\/(scans|retests)\/[^/]+\/abort$/i.test(path)) return true;
  if (req.method === "PATCH" && /^\/api\/ai-control$/i.test(path)) {
    const body = req.body && typeof req.body === "object" ? (req.body as { killSwitchEnabled?: unknown }) : {};
    return body.killSwitchEnabled === true;
  }
  if (req.method === "POST" && /^\/api\/failsafe\/commands$/i.test(path)) {
    const action = req.body && typeof req.body === "object" ? (req.body as { action?: unknown }).action : undefined;
    return action === "pause" || action === "stand_down" || action === "terminate";
  }
  if (req.method === "DELETE" && /^\/api\/api-keys\/[^/]+$/i.test(path)) return true;
  return false;
}

/**
 * The signed-in session's user id and role, from memory; null when there is
 * no session, or when its account has since been deactivated or deleted. The
 * role is the account's now (the directory above), falling back to the one
 * the session signed in with only for an account this process has never
 * noted -- which a session held in this process's memory store always has.
 */
export function sessionUser(req: Request): { id: string; role: string | null } | null {
  const id = req.session?.userId;
  if (!id) return null;
  const known = accounts.get(id);
  if (known === null) return null;
  if (known !== undefined) return known.isActive ? { id, role: known.role } : null;
  return { id, role: typeof req.session?.role === "string" ? req.session.role : null };
}

/**
 * A relay of a signature to a failsafe command: a stop only when the command's
 * action is one (requireAdminUnlessStop decides, with the route's own uuid).
 */
function isSignatureRelay(req: Request): boolean {
  const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, "");
  return req.method === "POST" && /^\/api\/failsafe\/commands\/[^/]+\/signatures$/i.test(path);
}

/** Rejects the request with 401 unless a live, active account is behind it. */
export const requireAuth: RequestHandler = (req, res, next) => {
  // A stop with a session is authorised from it. One presented with an API key
  // instead is authorised as any request is: the key has to be looked up (two
  // reads; its usage stamp, a write, is never waited on -- touchOnce). A
  // signature relay with a session is left to its route's guard
  // (requireAdminUnlessStop), which reads the account unless it may be a stop's.
  if ((isStopRequest(req) || isSignatureRelay(req)) && sessionUser(req)) {
    next();
    return;
  }
  loadSessionUser(req)
    .then((user) => {
      if (!user) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }
      next();
    })
    .catch(next);
};

/** Rejects with 401 when anonymous and 403 when the account is not an admin. */
export const requireAdmin: RequestHandler = (req, res, next) => {
  const user = isStopRequest(req) ? sessionUser(req) : null;
  if (user) {
    // A stop: the account's role as this process knows it now, from memory.
    if (user.role !== "admin") {
      res.status(403).json({ message: "Admin role required" });
      return;
    }
    req.authorisedFromSession = true;
    next();
    return;
  }
  loadSessionUser(req)
    .then((user) => {
      if (!user) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }
      // The role comes from the account as it is now, not as it was at login.
      if (user.role !== "admin") {
        res.status(403).json({ message: "Admin role required" });
        return;
      }
      next();
    })
    .catch(next);
};

/**
 * What a request whose route is a stop or not depending on what it names --
 * a signature relay, whose command's action only the control plane knows --
 * turned out to be: a stop's ("stop"), not a stop's ("not_stop"), or not
 * known in time ("possible_stop": the action could not be learnt within its
 * deadline, so it may be a stop's).
 */
export type StopKind = "stop" | "possible_stop" | "not_stop";

/**
 * An admin's guard for a route whose request is a stop or not depending on
 * what it names. `kindOf` says which this one is, within its own deadline
 * (routes.ts: from memory for a command this dashboard has proxied, otherwise
 * one read of at most failsafeTimeouts.commandReadMs).
 *
 *   - A stop, or a possible stop, from a session whose account this process
 *     holds as an active admin's, is authorised from the session in memory:
 *     the account is not read, and no failed or slow read stands in its way.
 *     A possible stop is marked (req.relayedAsPossibleStop) for its route to
 *     log. The control plane checks the keyholders' signatures on every
 *     command whatever this guard decides: that is the authority, and this is
 *     not.
 *   - Anything else -- not a stop, or no admin session in memory -- needs the
 *     account read now (once per request), and an active admin behind it: a
 *     session this process still holds as an admin's, whose account another
 *     dashboard demoted or deleted, gains nothing but stops. A read that fails
 *     answers 503, and nothing is done.
 */
export function requireAdminUnlessStop(kindOf: (req: Request) => Promise<StopKind>): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const me = sessionUser(req);
      const kind: StopKind = await kindOf(req).catch(() => "possible_stop" as const);
      if (me !== null && me.role === "admin" && kind !== "not_stop") {
        req.authorisedFromSession = true;
        if (kind === "possible_stop") req.relayedAsPossibleStop = true;
        next();
        return;
      }
      let user: User | undefined;
      try {
        user = req.currentUser ?? (await loadSessionUser(req));
      } catch (cause) {
        res.status(503).json({
          message: "The account behind this session could not be read " +
            `(${cause instanceof Error ? cause.message : String(cause)}), and only a stop is authorised without it. ` +
            "Nothing was done; try again.",
        });
        return;
      }
      if (!user) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }
      if (user.role !== "admin") {
        res.status(403).json({ message: "Admin role required" });
        return;
      }
      if (kind === "possible_stop") req.relayedAsPossibleStop = true;
      next();
    })().catch(next);
  };
}

/**
 * The account behind a request, read from storage now -- for what a request
 * authorised from memory also asks that only the account may authorise (the
 * other fields of a kill-switch request). Undefined when there is none, or it
 * is not active.
 */
export function accountNow(req: Request): Promise<User | undefined> {
  return req.currentUser ? Promise.resolve(req.currentUser) : loadSessionUser(req);
}

/** Who is acting, for activity-log attribution. Prefers the account a guard
 *  loaded (which covers API-key requests, where there is no session) and falls
 *  back to the session's own id. */
export function actor(req: Request): { userId: string | null; ipAddress: string | null } {
  return {
    userId: req.currentUser?.id ?? req.session?.userId ?? null,
    ipAddress: req.ip ?? null,
  };
}

type AsyncHandler = (req: Request, res: import("express").Response, next: import("express").NextFunction) => Promise<unknown>;

/**
 * Express 4 does not forward rejected promises to the error handler; an
 * unhandled rejection in a route would crash the process. Wrap every async
 * handler so failures reach the central error middleware instead.
 */
export function asyncHandler(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
