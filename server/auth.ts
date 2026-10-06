import crypto from "crypto";
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
    /** The password this session signed in under (passwordStamp): it holds nothing once that changes. */
    passwordStamp?: string;
    /** Marked at sign-in to change its password when the mark could not be written to the account. */
    mustChangePassword?: boolean;
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
  const account = asTheSessionHoldsIt(req, user);
  if (!account) return undefined;
  req.currentUser = account;
  return account;
}

/**
 * The account ``user`` as the request's session may act for it, or undefined
 * when the session holds nothing for it:
 *
 *   - signed in under a password the account no longer has -- a sign-in that
 *     verified the old password while it was being changed, or a session an
 *     admin's reset left behind -- it holds nothing but its stops, which are
 *     authorised from memory (sessionUser), never here. Ending the other
 *     sessions at a change is a sweep, and a sign-in still in flight was saved
 *     after it (#65 review round 2, N1);
 *   - a mark its sign-in could not write to the account is held in the session,
 *     and read as the account's own (N4).
 *
 * Every reader of the session's account goes through this: the guards, and
 * GET /api/auth/check.
 */
export function asTheSessionHoldsIt(req: Request, user: User): User | undefined {
  if (req.session?.passwordStamp !== passwordStamp(user.password)) return undefined;
  return req.session.mustChangePassword === true && !user.mustChangePassword
    ? { ...user, mustChangePassword: true }
    : user;
}

/**
 * A short digest of a stored password hash, kept in the session at sign-in. A
 * session whose stamp is not the account's current one signed in under a password
 * the account no longer has. Never the hash itself: the session store holds only
 * this.
 */
export function passwordStamp(hash: string): string {
  return crypto.createHash("sha256").update(`athena-session-password:${hash}`).digest("hex").slice(0, 32);
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

/** How long a guard waits on a fresh read of the account before it decides from memory (refreshAccount). */
export const ACCOUNT_REFRESH_MS = 250;

/**
 * Read the session's account now, into the directory above (noteAccount /
 * noteAccountDeleted), waiting for it at most `waitMs`; a read still running
 * then finishes in the background. Never throws: a read that fails or runs out
 * of time leaves the directory as it was, and the caller decides from it.
 *
 * Memory only learns of a change made on another dashboard on the same
 * database when something reads the account. A guard about to refuse a stop
 * from memory, or to serve a failsafe read, asks first, for a bounded time
 * (#65 review round 4, F1 and F2). A stop memory authorises never reads the
 * account, here or in the background: a session whose account was deleted
 * elsewhere keeps its stops, and a read that taught memory the deletion would
 * refuse its next one.
 */
export function refreshAccount(req: Request, waitMs: number): Promise<void> {
  const id = req.session?.userId;
  if (!id) return Promise.resolve();
  const read = Promise.resolve()
    .then(() => storage.getUser(id))
    .then(
      (user) => {
        if (user) noteAccount(user);
        else noteAccountDeleted(id);
      },
      () => undefined,
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((done) => {
    timer = setTimeout(done, waitMs);
  });
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
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
 * End every live session of one account but the one named (the session that
 * just changed its password), in the session store (memory). Best-effort and
 * in the background, as reviseLiveSessions is.
 */
export function endOtherSessions(
  store: import("express-session").Store | undefined,
  id: string,
  keep: string,
): void {
  if (!store || typeof store.all !== "function") return;
  try {
    store.all((error, sessions) => {
      if (error || !sessions || Array.isArray(sessions)) return;
      for (const [sid, data] of Object.entries(sessions as Record<string, import("express-session").SessionData>)) {
        if (sid !== keep && data?.userId === id) store.destroy(sid, () => undefined);
      }
    });
  } catch {
    // Nothing to hold up: the password has changed either way.
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
 * whose command's action could not be learnt in time (250 ms): it is relayed
 * as a possible stop -- never held to find out -- and the control plane still
 * verifies the keyholders' signatures on it. Once its action is learnt (its
 * read finishing later, or the relay's own answer naming it), a resume or a
 * release that this account, or an engaged kill switch, would have refused
 * is withdrawn at once (routes.ts withdrawPossibleStop). What is left: the
 * time between the control plane taking the signature and taking the
 * withdrawal, and a command whose action is never learnt at all.
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

/**
 * A command's withdrawal: a stop only when its command is a resume or a
 * release, which only the control plane knows (the cancel route decides, with
 * requireAdminUnlessStop).
 */
function isWithdrawal(req: Request): boolean {
  const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, "");
  return req.method === "POST" && /^\/api\/failsafe\/commands\/[^/]+\/cancel$/i.test(path);
}

/** A claim transition that takes a claim down: a stop (server/assurance.ts CLAIM_TAKE_DOWN). */
const CLAIM_TAKE_DOWN = new Set(["revoked", "contradicted"]);

/**
 * Every stop decided from the request alone (method, path, body), each
 * authorised from the session in memory (sessionUser), never from the account
 * read now:
 *
 *   - isStopRequest: a scan's or a retest's Stop; engaging the kill switch;
 *     drafting a failsafe pause, stand-down or terminate; revoking an API key;
 *   - the stops relayed to the control plane with the failsafe service token
 *     (`stop:` in server/failsafe.ts and server/assurance.ts): pausing a
 *     deployment (recompute with `paused: true`); revoking or contradicting
 *     a claim; and the reads a second operator stops from -- the failsafe
 *     state, its commands, one command, and the console's status (a read of
 *     the state with the service token, which the console reads before it
 *     lists the commands a second operator signs).
 *
 * The second group was authorised from the account, read now: so a session
 * the account no longer holds (signed in under a password it no longer has:
 * asTheSessionHoldsIt) could not read the state it stops from, pause a
 * deployment or take a claim down, and a failed account read refused them
 * (#65 review round 3, F4). Like every stop, they go from a session this
 * process holds as an active admin's; a stale account gains nothing else.
 */
export function isStopFromTheRequest(req: Request): boolean {
  if (isStopRequest(req)) return true;
  const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, "");
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  if (req.method === "GET" && /^\/api\/failsafe\/(status|state|commands|commands\/[^/]+)$/i.test(path)) return true;
  if (req.method === "POST" && /^\/api\/assurance\/deployments\/[^/]+\/recompute$/i.test(path)) return body.paused === true;
  if (req.method === "POST" && /^\/api\/assurance\/claims\/[^/]+\/transition$/i.test(path)) {
    return typeof body.toStatus === "string" && CLAIM_TAKE_DOWN.has(body.toStatus.trim());
  }
  return false;
}

/** What every route but the few allowedBeforePasswordChange names answers an account that must change its password. */
export const PASSWORD_CHANGE_REQUIRED = "password change required"; // pragma: allowlist secret

/** The answer, exactly: `{"error":"password change required"}`, with 403. */
export function refusePasswordChangeRequired(res: import("express").Response): void {
  res.status(403).json({ error: PASSWORD_CHANGE_REQUIRED });
}

/**
 * What an account that must change its password may call besides a stop:
 * changing it, signing out, and reading itself. (Sign-out and reading itself
 * are mounted before requireAuth, so they never reach the guard; they are
 * named here so the list is the whole of it.)
 */
function allowedBeforePasswordChange(req: Request): boolean {
  const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, "");
  if (req.method === "POST" && /^\/api\/auth\/(change-password|logout)$/i.test(path)) return true;
  if (req.method === "GET" && /^\/api\/auth\/check$/i.test(path)) return true;
  return false;
}

/**
 * Every stop this server takes, from the request alone (method, path, body),
 * for the guard below. Each is one the code treats as a stop elsewhere:
 *
 *   - isStopFromTheRequest: every stop the request alone says is one;
 *   - a signature relay and a command's withdrawal, which are stops or not by
 *     the command's action, which only the control plane knows: they pass
 *     here, and their own handlers refuse this account once the action is
 *     known not to be a stop's (requireAdminUnlessStop; the cancel route,
 *     where withdrawing a resume or a release is the stop).
 */
export function isStopForPasswordGuard(req: Request): boolean {
  return isStopFromTheRequest(req) || isSignatureRelay(req) || isWithdrawal(req);
}

/**
 * Refuses every request from an account that must change its password
 * (users.mustChangePassword) with 403 `{"error":"password change required"}`,
 * except: changing the password, signing out, reading itself -- and EVERY
 * stop (isStopForPasswordGuard), decided before anything else and from the
 * request alone, so a stop waits on nothing here and is never refused by it.
 *
 * Mounted after requireAuth, which has read the account (req.currentUser)
 * for every request that is not a stop; this reads nothing.
 */
export const requirePasswordChanged: RequestHandler = (req, res, next) => {
  if (isStopForPasswordGuard(req) || allowedBeforePasswordChange(req)) {
    next();
    return;
  }
  if (req.currentUser?.mustChangePassword === true) {
    refusePasswordChangeRequired(res);
    return;
  }
  next();
};

/** Rejects the request with 401 unless a live, active account is behind it. */
export const requireAuth: RequestHandler = (req, res, next) => {
  // A stop with a session is authorised from it. One presented with an API key
  // instead is authorised as any request is: the key has to be looked up (two
  // reads; its usage stamp, a write, is never waited on -- touchOnce). A
  // signature relay or a withdrawal with a session is left to its route's guard
  // (requireAdminUnlessStop), which reads the account unless it is a stop's.
  if ((isStopFromTheRequest(req) || isSignatureRelay(req) || isWithdrawal(req)) && sessionUser(req)) {
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
  if (!isStopFromTheRequest(req)) {
    adminFromAccount(req, res, next);
    return;
  }
  const remembered = sessionUser(req);
  if (remembered?.role === "admin" && req.method !== "GET") {
    // A stop, by an admin as this process knows the account now: authorised from
    // memory, waiting on nothing.
    req.authorisedFromSession = true;
    next();
    return;
  }
  // Memory would refuse it -- or it is one of the failsafe reads, which serve
  // what the control plane holds and so are not served on memory alone: the
  // account is read first, for at most ACCOUNT_REFRESH_MS. Memory learns of a
  // promotion, a demotion or a deletion made on another dashboard only from a
  // read, and refusing a stop on what memory last knew refused an admin promoted
  // elsewhere, while an account deleted elsewhere read every command (#65 review
  // round 4, F1 and F2). A read that cannot answer in time leaves it to memory:
  // an admin's read is served, and anything else is decided from the account.
  void refreshAccount(req, ACCOUNT_REFRESH_MS)
    .then(() => {
      const user = sessionUser(req);
      if (user?.role === "admin") {
        req.authorisedFromSession = true;
        next();
        return;
      }
      adminFromAccount(req, res, next);
    })
    .catch(next);
};

/** The admin guard from the account, read now (loadSessionUser): every request that is not a stop. */
const adminFromAccount: RequestHandler = (req, res, next) => {
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
 * deadline, so it may be a stop's) -- or, for a request that must never be
 * taken for a stop it may not be (a withdrawal, which cannot be taken back),
 * not known in time ("unread": authorised from the account, and left to its
 * route to refuse or not).
 */
export type StopKind = "stop" | "possible_stop" | "not_stop" | "unread";

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
      if (me !== null && me.role === "admin" && (kind === "stop" || kind === "possible_stop")) {
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
      // Known not to be a stop's: an account that must change its password is refused it.
      if (kind === "not_stop" && user.mustChangePassword === true) {
        refusePasswordChangeRequired(res);
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
