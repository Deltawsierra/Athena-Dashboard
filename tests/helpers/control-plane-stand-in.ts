/**
 * A stand-in Athena-Backend (the failsafe control plane and the assurance API)
 * that judges stops and the failsafe service token the way the backend does.
 *
 * Authentication, in the backend's order (athena-backend safety/service_token.py,
 * FailsafeServiceTokenAuthentication first in DEFAULT_AUTHENTICATION_CLASSES):
 * the `X-Failsafe-Service-Token` header is taken ONLY on a request that is a
 * stop on a service route and only when it matches the configured token; then
 * a Bearer this stand-in issued and has not expired; anything else is 401.
 *
 * What is a stop is judged per request, as safety/stops.py judges it, for every
 * route in the backend's SERVICE_ROUTES (STOP_ROUTES less failsafe:pending and
 * the two account routes):
 *
 *   deployment-recompute         POST  body {paused: true} (a lift or a routine recompute is not)
 *   claim-transition             POST  body {to_status: revoked | contradicted}
 *   failsafe:state               GET   always
 *   failsafe:commands            GET   always; POST a pause, stand-down or terminate draft
 *   failsafe:command-detail      GET   always
 *   failsafe:submit-signature    POST  when the command is a pause, stand-down or terminate
 *   failsafe:cancel-command      POST  when the command is a resume or a release
 *   deployment-dispatch-policy   PUT   body {enabled: false}
 *   pentest:engagement_detail    PATCH a scan's authority withdrawn
 *
 * A body is a stop only in canonical form: an object carrying the predicate's
 * fields and nothing else but a text `note` or `reason` (stops.py `_fields`).
 *
 * Every request is recorded with the moment it had arrived, on the monotonic
 * clock (performance.now()), in the order it arrived.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { randomBytes, randomUUID } from "node:crypto";

/** A token of the shape `openssl rand -hex 32` makes, new for each run. */
export function newServiceToken(): string {
  return randomBytes(32).toString("hex");
}

/** How the sign-in (/api/token/) or the refresh (/api/token/refresh/) answers: an error status, or never. */
export type TokenFault = 429 | 500 | 401 | "hang";

export interface Seen {
  /** Its place in the order requests arrived. */
  n: number;
  method: string;
  /** The path, without its query. */
  path: string;
  query: string;
  body: string;
  /** The `X-Failsafe-Service-Token` header, when one was sent. */
  serviceToken: string | undefined;
  bearer: string | undefined;
  /** Whether the backend judges this request a stop on a route the service token is accepted on. */
  stop: boolean;
  /** What authenticated it; null when nothing did (answered 401), or for the token endpoints. */
  by: "service token" | "bearer" | null;
  /** performance.now() when the whole request had arrived. */
  at: number;
}

const STOP_ACTIONS = new Set(["pause", "stand_down", "terminate"]);
const START_ACTIONS = new Set(["resume", "release"]);
const TRUE_STRINGS = new Set(["true", "1", "yes", "on"]);
const FALSE_STRINGS = new Set(["false", "0", "no", "off", ""]);

function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(token)) return true;
    if (FALSE_STRINGS.has(token)) return false;
  }
  return null;
}

/** The body as stops.py `_body` reads it: {} when empty, an object, or null (not canonical). */
function canonical(raw: string): Record<string, unknown> | null {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** stops.py `_fields`: carrying at least one of `fields`, and nothing else but a text note or reason. */
function fieldsOnly(data: Record<string, unknown> | null, fields: string[]): data is Record<string, unknown> {
  if (data === null || !fields.some((name) => name in data)) return false;
  return Object.entries(data).every(([name, value]) =>
    fields.includes(name) || ((name === "note" || name === "reason") && typeof value === "string"));
}

/** Whether the backend judges this request a stop on a service route (see the header). */
export function judgeStop(method: string, path: string, raw: string, actionOf: (uuid: string) => string | undefined): boolean {
  const verb = method === "HEAD" ? "GET" : method;
  const command = /^\/api\/failsafe\/commands\/([^/]+)\/(signatures\/|cancel\/)?$/.exec(path);
  if (/^\/api\/assurance\/deployments\/[^/]+\/recompute\/$/.test(path)) {
    const data = canonical(raw);
    return verb === "POST" && fieldsOnly(data, ["paused"]) && asBool(data.paused) === true;
  }
  if (/^\/api\/assurance\/claims\/[^/]+\/transition\/$/.test(path)) {
    const data = canonical(raw);
    return verb === "POST" && fieldsOnly(data, ["to_status"]) &&
      (data.to_status === "revoked" || data.to_status === "contradicted");
  }
  if (/^\/api\/assurance\/deployments\/[^/]+\/dispatch-policy\/$/.test(path)) {
    const data = canonical(raw);
    return verb === "PUT" && fieldsOnly(data, ["enabled"]) && "enabled" in data && asBool(data.enabled) === false;
  }
  if (/^\/api\/pentest\/engagements\/\d+\/$/.test(path)) {
    const data = canonical(raw);
    if (verb !== "PATCH" || !fieldsOnly(data, ["status", "scope_hosts", "testing_window_end"])) return false;
    if ("status" in data && (typeof data.status !== "string" || data.status === "running")) return false;
    if ("scope_hosts" in data && !(Array.isArray(data.scope_hosts) && data.scope_hosts.length === 0)) return false;
    if ("testing_window_end" in data && data.testing_window_end !== null &&
      !(typeof data.testing_window_end === "string" && Date.parse(data.testing_window_end) <= Date.now())) return false;
    return true;
  }
  if (path === "/api/failsafe/state/") return verb === "GET";
  if (path === "/api/failsafe/commands/") {
    if (verb === "GET") return true;
    const data = canonical(raw);
    return verb === "POST" && fieldsOnly(data, ["action", "engine_id"]) &&
      typeof data.action === "string" && STOP_ACTIONS.has(data.action);
  }
  if (command) {
    if (command[2] === undefined) return verb === "GET";
    const action = actionOf(command[1]);
    if (command[2] === "signatures/") return verb === "POST" && action !== undefined && STOP_ACTIONS.has(action);
    return verb === "POST" && action !== undefined && START_ACTIONS.has(action);
  }
  return false;
}

/** Answers that are a list on the backend: the dashboard reads each as one. */
const LIST_PATHS = [
  /^\/api\/assurance\/(deployments|findings|assets|claims|unknowns|providers|provider-assertions|retest-requirements)\/$/,
  /^\/api\/assurance\/deployments\/[^/]+\/(retest-requirements|assurance-claims)\/$/,
  /^\/api\/assurance\/claims\/[^/]+\/events\/$/,
  /^\/api\/failsafe\/audit\/$/,
];

export interface StandInOptions {
  /** The FAILSAFE_SERVICE_TOKEN the backend is configured with; null for none. */
  serviceToken?: string | null;
  /** How the sign-in answers: null (the default) issues an access and a refresh token. */
  signIn?: TokenFault | null;
  /** How the refresh answers: null (the default) rotates the refresh token and blacklists the one spent. */
  refresh?: TokenFault | null;
  /** Every authenticated operator request is refused 400, with a body quoting the request's own headers back. */
  echoHeaders?: boolean;
}

export async function controlPlaneStandIn(opts: StandInOptions = {}) {
  const seen: Seen[] = [];
  const held: http.ServerResponse[] = [];
  const commands = new Map<string, { uuid: string; action: string; status: string; signers: string[] }>();
  const validAccess = new Set<string>();
  const validRefresh = new Set<string>();
  const spentRefresh: string[] = [];
  let issued = 0;
  let waiters: Array<{ match: (one: Seen) => boolean; resolve: (one: Seen) => void }> = [];
  const settings = { signIn: opts.signIn ?? null, refresh: opts.refresh ?? null };
  /** Commands whose read (GET of the command) is held unanswered. */
  const stalledReads = new Set<string>();

  const issue = () => {
    issued += 1;
    const tokens = { access: `access-${issued}`, refresh: `refresh-${issued}` };
    validAccess.add(tokens.access);
    validRefresh.add(tokens.refresh);
    return tokens;
  };
  const commandJson = (one: { uuid: string; action: string; status: string; signers: string[] }) => ({
    uuid: one.uuid, engine_id: "engine-1", action: one.action, nonce: `n-${one.uuid}`,
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(),
    reason: "", signers: one.signers, required_signatures: 1, status: one.status,
    created_at: null, updated_at: null, signing_bytes: "00",
  });

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { raw += chunk; });
    req.on("end", () => {
      const at = performance.now();
      const url = new URL(req.url ?? "/", "http://stand-in");
      const method = req.method ?? "GET";
      const path = url.pathname;
      const one = (name: string): string | undefined => {
        const value = req.headers[name];
        return Array.isArray(value) ? value.join(", ") : value;
      };
      const presented = one("x-failsafe-service-token");
      const authorization = one("authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
      const stop = judgeStop(method, path, raw, (uuid) => commands.get(uuid)?.action);
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      const record = (by: Seen["by"]) => {
        const entry: Seen = {
          n: seen.length + 1, method, path, query: url.search, body: raw,
          serviceToken: presented, bearer, stop, by, at,
        };
        seen.push(entry);
        const ready = waiters.filter((w) => w.match(entry));
        waiters = waiters.filter((w) => !w.match(entry));
        for (const w of ready) w.resolve(entry);
      };
      const fault = (how: TokenFault) => {
        if (how === "hang") { held.push(res); return; }
        json(how, { detail: how === 429 ? "Request was throttled." : how === 401 ? "No active account found with the given credentials" : "Server Error" });
      };

      if (path === "/api/token/" && method === "POST") {
        record(null);
        if (settings.signIn !== null) return fault(settings.signIn);
        return json(200, issue());
      }
      if (path === "/api/token/refresh/" && method === "POST") {
        record(null);
        if (settings.refresh !== null) return fault(settings.refresh);
        const sent = (canonical(raw) ?? {}).refresh;
        if (typeof sent !== "string" || !validRefresh.has(sent)) {
          return json(401, { detail: "Token is blacklisted", code: "token_not_valid" });
        }
        validRefresh.delete(sent);
        spentRefresh.push(sent);
        return json(200, issue());
      }

      // Authentication, in the backend's order.
      const by: Seen["by"] = presented !== undefined && stop && opts.serviceToken && presented === opts.serviceToken
        ? "service token"
        : bearer !== undefined && validAccess.has(bearer) ? "bearer" : null;
      record(by);
      if (by === null) return json(401, { detail: "Authentication credentials were not provided." });
      if (opts.echoHeaders) return json(400, { detail: "refused", headers: req.headers });

      if (path === "/api/failsafe/state/") {
        const inFlight = [...commands.values()].filter((c) => c.status === "pending").map(commandJson);
        return json(200, { engine_id: "engine-1", engine_state: null, engine_state_available: false, awaiting_signatures: inFlight, ready: [], recent: [] });
      }
      if (path === "/api/failsafe/commands/" && method === "GET") return json(200, [...commands.values()].map(commandJson));
      if (path === "/api/failsafe/commands/" && method === "POST") {
        const action = String((canonical(raw) ?? {}).action ?? "");
        const made = { uuid: randomUUID(), action, status: "pending", signers: [] as string[] };
        commands.set(made.uuid, made);
        return json(201, commandJson(made));
      }
      const command = /^\/api\/failsafe\/commands\/([^/]+)\/(signatures\/|cancel\/)?$/.exec(path);
      if (command) {
        if (!command[2] && method === "GET" && stalledReads.has(command[1])) { held.push(res); return; }
        const known = commands.get(command[1]);
        if (!known) return json(404, { detail: "Not found." });
        if (command[2] === "signatures/" && method === "POST") { known.status = "ready"; known.signers.push("k1"); }
        if (command[2] === "cancel/" && method === "POST") known.status = "canceled";
        return json(200, commandJson(known));
      }
      if (method === "DELETE") return json(204, undefined);
      if (method === "GET" && LIST_PATHS.some((list) => list.test(path))) return json(200, []);
      return json(200, {});
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    seen,
    settings,
    /** The refresh tokens spent, in the order they were: each refresh blacklists the one it was sent. */
    spentRefresh,
    /** A command this control plane holds, of the given action. */
    command(action: string): string {
      const uuid = randomUUID();
      commands.set(uuid, { uuid, action, status: "pending", signers: [] });
      return uuid;
    },
    /** Every read of this command from now on is held unanswered (a stalled control plane). */
    stallReadsOf(uuid: string): void { stalledReads.add(uuid); },
    /** The action of a command this control plane holds. */
    actionOf: (uuid: string): string | undefined => commands.get(uuid)?.action,
    /** Every access token issued so far is expired from now on. */
    expireAccess(): void { validAccess.clear(); },
    /** The first request, arrived or yet to arrive, that matches. */
    waitFor(match: (one: Seen) => boolean): Promise<Seen> {
      const already = seen.find(match);
      if (already) return Promise.resolve(already);
      return new Promise<Seen>((resolve) => { waiters.push({ match, resolve }); });
    },
    /** Sign-ins (/api/token/) received so far, answered or held. */
    signIns: () => seen.filter((one) => one.path === "/api/token/").length,
    /** Whether a sign-in or a refresh is being held unanswered now. */
    holding: () => held.some((res) => !res.writableEnded),
    close: async () => {
      waiters = [];
      for (const res of held) res.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export type ControlPlaneStandIn = Awaited<ReturnType<typeof controlPlaneStandIn>>;
