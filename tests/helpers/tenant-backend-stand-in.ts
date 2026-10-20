/**
 * A stand-in Athena-Backend that answers by WHO asks, as the backend does (T6).
 *
 *   - Accounts sign in with their own username and password (SimpleJWT
 *     /api/token/), and each token is issued to that account. A refresh
 *     (/api/token/refresh/) rotates the refresh token and blacklists the one
 *     spent; a revocation (/api/token/revoke/, athena-backend safety/revoke.py)
 *     blacklists the one sent. An inactive account signs in and refreshes nothing.
 *   - Authentication in the backend's order: the failsafe service token, only
 *     on a stop (judged as safety/stops.py judges it: control-plane-stand-in.ts
 *     judgeStop), as the service user; then a bearer this stand-in issued; else 401.
 *   - Tenancy as `visible_deployments` scopes it: an admin or an analyst sees
 *     every deployment, anyone else only those they own. A deployment the account
 *     cannot see is 404 on every route under it -- the economics reads included --
 *     exactly as one that does not exist. The deployment list holds only the
 *     visible ones.
 *   - Roles: a viewer is refused (403) the business-impact read and the failsafe
 *     audit, and may not recompute.
 *
 * Every request is recorded, in the order it arrived, with the account it was
 * made as and the status it was answered.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { judgeStop } from "./control-plane-stand-in";

export type BackendRole = "admin" | "analyst" | "viewer";

export interface BackendAccount {
  password: string;
  role: BackendRole;
  active?: boolean;
}

export interface TenantSeen {
  n: number;
  method: string;
  path: string;
  query: string;
  body: string;
  /** The account the request was made as; for the token routes, the account signing in or whose token was sent. */
  account: string | null;
  by: "service token" | "bearer" | null;
  stop: boolean;
  bearer: string | undefined;
  serviceToken: string | undefined;
  status: number;
}

export interface TenantStandInOptions {
  accounts: Record<string, BackendAccount>;
  /** Each deployment's uuid, and the username that owns it. */
  deployments: Record<string, string>;
  /** FAILSAFE_SERVICE_TOKEN; null or absent for none. */
  serviceToken?: string | null;
  /** FAILSAFE_SERVICE_USER: the account the service token authenticates as. */
  serviceUser?: string;
}

export async function tenantBackendStandIn(opts: TenantStandInOptions) {
  const seen: TenantSeen[] = [];
  const held: http.ServerResponse[] = [];
  const accounts = new Map(Object.entries(opts.accounts).map(([name, one]) => [name, { ...one, active: one.active !== false }]));
  const owners = new Map(Object.entries(opts.deployments));
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();
  const blacklisted = new Set<string>();
  const revoked: string[] = [];
  const hangSignInOf = new Set<string>();
  const issuedLog: Array<{ account: string; access: string; refresh: string }> = [];
  const commands = new Map<string, string>();
  let issued = 0;
  let waiters: Array<{ match: (one: TenantSeen) => boolean; resolve: (one: TenantSeen) => void }> = [];

  const issue = (account: string) => {
    issued += 1;
    const pair = { access: `access-${account}-${issued}`, refresh: `refresh-${account}-${issued}` };
    access.set(pair.access, account);
    refresh.set(pair.refresh, account);
    issuedLog.push({ account, ...pair });
    return pair;
  };
  const sees = (account: string, deployment: string): boolean => {
    const role = accounts.get(account)?.role;
    return role === "admin" || role === "analyst" || owners.get(deployment) === account;
  };
  const parse = (raw: string): Record<string, unknown> => {
    try {
      const data = JSON.parse(raw || "{}") as unknown;
      return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stand-in");
      const method = req.method ?? "GET";
      const path = url.pathname;
      const header = (name: string): string | undefined => {
        const value = req.headers[name];
        return Array.isArray(value) ? value.join(", ") : value;
      };
      const presented = header("x-failsafe-service-token");
      const authorization = header("authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
      const stop = judgeStop(method, path, raw, (uuid) => commands.get(uuid));
      const entry: TenantSeen = {
        n: seen.length + 1, method, path, query: url.search, body: raw, account: null, by: null, stop,
        bearer, serviceToken: presented, status: 0,
      };
      const note = () => {
        seen.push(entry);
        const ready = waiters.filter((w) => w.match(entry));
        waiters = waiters.filter((w) => !w.match(entry));
        for (const w of ready) w.resolve(entry);
      };
      const answer = (status: number, payload: unknown) => {
        entry.status = status;
        note();
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      const body = parse(raw);

      if (path === "/api/token/" && method === "POST") {
        const username = typeof body.username === "string" ? body.username : "";
        entry.account = username || null;
        if (hangSignInOf.has(username)) {
          // Held unanswered: recorded with status 0.
          note();
          held.push(res);
          return;
        }
        const one = accounts.get(username);
        if (!one || !one.active || one.password !== body.password) {
          return answer(401, { detail: "No active account found with the given credentials" });
        }
        return answer(200, issue(username));
      }
      if (path === "/api/token/refresh/" && method === "POST") {
        const sent = typeof body.refresh === "string" ? body.refresh : "";
        const account = refresh.get(sent) ?? null;
        entry.account = account;
        if (account === null || blacklisted.has(sent)) return answer(401, { detail: "Token is blacklisted", code: "token_not_valid" });
        if (!accounts.get(account)?.active) return answer(401, { detail: "No active account found", code: "no_active_account" });
        blacklisted.add(sent);
        return answer(200, issue(account));
      }
      if (path === "/api/token/revoke/" && method === "POST") {
        const sent = typeof body.refresh === "string" ? body.refresh : "";
        const account = refresh.get(sent) ?? null;
        entry.account = account;
        if (account === null) return answer(401, { detail: "the refresh token does not verify: nothing was revoked", code: "token_not_valid" });
        blacklisted.add(sent);
        revoked.push(sent);
        return answer(200, { revoked: true });
      }

      // Authentication, in the backend's order.
      if (presented !== undefined && stop && opts.serviceToken && presented === opts.serviceToken) {
        entry.by = "service token";
        entry.account = opts.serviceUser ?? "svc-failsafe";
      } else if (bearer !== undefined && access.has(bearer) && accounts.get(access.get(bearer)!)?.active) {
        entry.by = "bearer";
        entry.account = access.get(bearer)!;
      } else {
        return answer(401, { detail: "Authentication credentials were not provided." });
      }
      const who = entry.account!;
      const role = accounts.get(who)?.role ?? "viewer";

      if (path === "/api/assurance/deployments/" && method === "GET") {
        const visible = Array.from(owners.keys()).filter((uuid) => sees(who, uuid));
        return answer(200, visible.map((uuid) => ({ uuid, name: `deployment of ${owners.get(uuid)}`, environment: "production" })));
      }
      const deployment = /^\/api\/assurance\/deployments\/([^/]+)\/(.*)$/.exec(path);
      if (deployment) {
        const [, uuid, rest] = deployment;
        if (!owners.has(uuid) || !sees(who, uuid)) return answer(404, { detail: "No Deployment matches the given query." });
        if (rest === "recompute/" && method === "POST") {
          if (!stop && role === "viewer") return answer(403, { detail: "You do not have permission to perform this action." });
          return answer(200, { decision: stop ? "paused" : "proceed", decision_label: stop ? "Paused" : "Proceed" });
        }
        if (rest === "business-impact/" && role === "viewer") {
          return answer(403, { detail: "You do not have permission to perform this action." });
        }
        if (/^economics\/scenarios\/[^/]+\/results\/$/.test(rest)) {
          return answer(200, { schema: "mythos.economics.report/v2", deployment: uuid, read_by: who });
        }
        if (rest === "economics/scenarios/") return answer(200, { count: 0, next: null, previous: null, results: [] });
        return answer(200, {});
      }
      if (/^\/api\/assurance\/claims\/[^/]+\/transition\/$/.test(path)) return answer(200, {});
      if (path === "/api/failsafe/state/") {
        return answer(200, { engine_id: "engine-1", engine_state: null, engine_state_available: false, awaiting_signatures: [], ready: [], recent: [] });
      }
      if (path === "/api/failsafe/audit/") {
        if (role === "viewer") return answer(403, { detail: "You do not have permission to perform this action." });
        return answer(200, []);
      }
      if (path === "/api/failsafe/commands/" && method === "POST") {
        const action = typeof body.action === "string" ? body.action : "";
        const uuid = randomUUID();
        commands.set(uuid, action);
        return answer(201, {
          uuid, engine_id: "engine-1", action, nonce: `n-${uuid}`, issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 600_000).toISOString(), reason: "", signers: [], required_signatures: 1,
          status: "pending", created_at: null, updated_at: null, signing_bytes: "00",
        });
      }
      if (path === "/api/failsafe/commands/" && method === "GET") return answer(200, []);
      if (method === "GET" && /\/$/.test(path) && /(findings|unknowns|assets|providers|claims|provider-assertions|retest-requirements)\/$/.test(path)) {
        return answer(200, []);
      }
      return answer(200, {});
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    /** The refresh tokens revoked, in the order they were. */
    revoked,
    /** The access tokens issued to `account`, in the order they were. */
    accessIssuedTo: (account: string): string[] => issuedLog.filter((one) => one.account === account).map((one) => one.access),
    /** The refresh tokens issued to `account`, in the order they were. */
    refreshIssuedTo: (account: string): string[] => issuedLog.filter((one) => one.account === account).map((one) => one.refresh),
    /** Whether a refresh token would still be taken by a refresh. */
    refreshTaken: (token: string): boolean => refresh.has(token) && !blacklisted.has(token),
    /** Every access token issued to `account` is refused from now on. */
    expireAccessOf(account: string): void {
      for (const [token, owner] of Array.from(access)) if (owner === account) access.delete(token);
    },
    /** Every refresh token issued to `account` is refused from now on. */
    refuseRefreshOf(account: string): void {
      for (const [token, owner] of Array.from(refresh)) if (owner === account) blacklisted.add(token);
    },
    /** `account`'s sign-ins are held unanswered from now on (a backend hung on its password hash). */
    hangSignInOf(account: string): void { hangSignInOf.add(account); },
    /** Whether a sign-in is being held unanswered now. */
    holding: () => held.some((res) => !res.writableEnded && !res.destroyed),
    waitFor(match: (one: TenantSeen) => boolean): Promise<TenantSeen> {
      const already = seen.find(match);
      if (already) return Promise.resolve(already);
      return new Promise((resolve) => { waiters.push({ match, resolve }); });
    },
    close: async () => {
      waiters = [];
      for (const res of held) res.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export type TenantBackendStandIn = Awaited<ReturnType<typeof tenantBackendStandIn>>;
