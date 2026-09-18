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
  if (!user || !user.isActive) return undefined;

  // Best-effort usage stamp; a failure here must not fail the request.
  await storage.touchApiKey(record.id).catch(() => {});
  req.currentUser = user;
  return user;
}

/** Rejects the request with 401 unless a live, active account is behind it. */
export const requireAuth: RequestHandler = (req, res, next) => {
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
