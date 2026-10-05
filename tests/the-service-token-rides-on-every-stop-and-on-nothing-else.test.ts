import { afterEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { format } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { makeApp, signIn } from "./helpers";
import { controlPlaneStandIn, newServiceToken, type ControlPlaneStandIn, type Seen } from "./helpers/control-plane-stand-in";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

/**
 * The failsafe service token (#337): on every stop this server relays to the
 * control plane, and on nothing else.
 *
 * The backend takes ATHENA_FAILSAFE_SERVICE_TOKEN's value (its
 * FAILSAFE_SERVICE_TOKEN) only on a stop, and a stolen one can only stop
 * things -- by the backend's design the token is stop-only
 * (athena-backend safety/service_token.py SERVICE_ROUTES, safety/stops.py).
 * So this server sends it on exactly the requests the backend judges stops,
 * and the stand-in here judges every request the way the backend does
 * (tests/helpers/control-plane-stand-in.ts). The stop timings under a failing
 * sign-in are in a-stop-presents-the-service-token-and-waits-on-no-sign-in.test.ts.
 *
 *   - Over the server's FULL route list (Express's own table, every route and
 *     method), each stop route in its stop and its non-stop forms: every
 *     request that reached the control plane carried the token exactly when
 *     it was a stop, and every backend route the server's code names was
 *     reached -- none is left out.
 *   - The token is in no log line, no answer, and cannot be in the client
 *     bundle, even from a control plane that quotes a request's headers back.
 *   - Without the variable, nothing changes: no request carries the header,
 *     and a stop waits for the service account's token as before. A value the
 *     backend would ignore, or one no header can carry, is not sent at all.
 *   - The service account's token is renewed by its refresh token, and the
 *     rotated refresh token is the one sent next; the password only when the
 *     refresh is refused.
 */

const ROOT = path.resolve(__dirname, "..");
const TOKEN = newServiceToken();
const ENV = ["ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD", "ATHENA_FAILSAFE_SERVICE_TOKEN"];
const ACTIONS = ["pause", "stand_down", "terminate", "resume", "release"];

let plane: ControlPlaneStandIn | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await plane?.close();
  plane = null;
  for (const name of ENV) delete process.env[name];
});

/** The dashboard, reaching `p` as its control plane, with `serviceToken` set in its environment (or not). */
async function boot(p: ControlPlaneStandIn, serviceToken: string | null) {
  process.env.ATHENA_FAILSAFE_URL = p.url;
  process.env.ATHENA_FAILSAFE_USER = "svc-failsafe";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc-password";
  if (serviceToken !== null) process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = serviceToken;
  vi.resetModules();
  const app = await makeApp();
  return { app, admin: await signIn(app) };
}

/** Everything the dashboard logs from here on, as one string per call. */
function captureLogs(): string[] {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(format(...args)); });
  }
  return lines;
}

/**
 * Every backend route the server's code can call: each /api/assurance/ and
 * /api/failsafe/ path it names (server/assurance.ts reaches the backend
 * through server/control-plane.ts, server/failsafe.ts through its own
 * client; nothing else in server/ does), as a pattern for the path sent.
 */
function backendRoutesNamedInSource(): Array<{ literal: string; pattern: RegExp }> {
  const found = new Set<string>();
  for (const file of ["server/assurance.ts", "server/failsafe.ts"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const match of source.matchAll(/[`"](\/api\/(?:assurance|failsafe)\/[^`"\s]*)[`"]/g)) found.add(match[1]);
  }
  return [...found].map((literal) => {
    const parts = literal.replace(/\$\{query\}$/, "").split(/\$\{[^}]*\}/);
    const pattern = new RegExp(`^${parts.map((part) => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join("[^/]+")}$`);
    return { literal, pattern };
  });
}

/** What a request that reached the control plane was, in words. */
function what(one: Seen, actionOf: (uuid: string) => string | undefined): string {
  const body = (() => { try { return JSON.parse(one.body || "{}") as Record<string, unknown>; } catch { return {}; } })();
  const command = /^\/api\/failsafe\/commands\/([^/]+)\/(signatures\/|cancel\/)?$/.exec(one.path);
  if (/\/recompute\/$/.test(one.path)) return `deployment recompute ${one.body || "{}"}`;
  if (/^\/api\/assurance\/claims\/[^/]+\/transition\/$/.test(one.path)) return `claim ${String(body.to_status)}`;
  if (one.path === "/api/failsafe/state/") return "stop lane: failsafe state";
  if (one.path === "/api/failsafe/commands/" && one.method === "GET") return "stop lane: failsafe commands";
  if (one.path === "/api/failsafe/commands/" && one.method === "POST") return `failsafe ${String(body.action)} drafted`;
  if (command && command[2] === "signatures/") return `signature on a ${actionOf(command[1])}`;
  if (command && command[2] === "cancel/") return `withdrawal of a ${actionOf(command[1])}`;
  if (command) return "stop lane: failsafe command";
  return `${one.method} ${one.path}`;
}

/** The stops this server relays, in the backend's own terms: each must be seen, and each must carry the token. */
const STOPS_RELAYED = [
  "deployment recompute {\"paused\":true}",
  "claim revoked",
  "claim contradicted",
  "stop lane: failsafe state",
  "stop lane: failsafe commands",
  "stop lane: failsafe command",
  "failsafe pause drafted",
  "failsafe stand_down drafted",
  "failsafe terminate drafted",
  "signature on a pause",
  "signature on a stand_down",
  "signature on a terminate",
  "withdrawal of a resume",
  "withdrawal of a release",
];

/** The same routes' requests that are NOT stops: each must be seen, and none may carry the token. */
const NOT_STOPS_ON_STOP_ROUTES = [
  "deployment recompute {\"paused\":false}",
  "deployment recompute {}",
  "claim verified",
  "claim stale",
  "failsafe resume drafted",
  "failsafe release drafted",
  "signature on a resume",
  "signature on a release",
  "withdrawal of a pause",
  "withdrawal of a stand_down",
  "withdrawal of a terminate",
];

interface Walked {
  routes: string[];
  answers: Array<{ route: string; status: number; text: string }>;
}

/**
 * Walk the server's full route list -- every route and method in Express's
 * own table -- as a signed-in admin. A route whose request to the control
 * plane is a stop in one form and not in another is sent in each form.
 */
async function walkEveryRoute(app: Express, admin: ReturnType<typeof request.agent>, p: ControlPlaneStandIn): Promise<Walked> {
  const deployment = randomUUID();
  const commandOf = Object.fromEntries(ACTIONS.map((action) => [action, p.command(action)]));
  const param: Record<string, string> = {
    uuid: deployment, id: "999999", testId: "999999", runId: "run-999999", clientId: "999999", pack: "pack-1", connector: "jira",
  };
  // What each route is sent: one request per entry. A route not named here is sent once, with {}.
  const forms: Record<string, Array<{ params?: Record<string, string>; body?: unknown }>> = {
    "POST /api/failsafe/commands": ACTIONS.map((action) => ({ body: { action, engineId: "engine-1", reason: "the route walk" } })),
    "GET /api/failsafe/commands/:uuid": ACTIONS.map((action) => ({ params: { uuid: commandOf[action] } })),
    "POST /api/failsafe/commands/:uuid/signatures": ACTIONS.map((action) => ({ params: { uuid: commandOf[action] }, body: { keyId: "k1", sig: "abcd" } })),
    "POST /api/failsafe/commands/:uuid/cancel": ACTIONS.map((action) => ({ params: { uuid: commandOf[action] }, body: {} })),
    "POST /api/assurance/deployments/:uuid/recompute": [{ body: { paused: true } }, { body: { paused: false } }, { body: {} }],
    "POST /api/assurance/claims/:uuid/transition": [
      { body: { toStatus: "revoked" } }, { body: { toStatus: "contradicted", note: "its evidence was forged" } },
      { body: { toStatus: "verified" } }, { body: { toStatus: "stale" } },
    ],
    "PATCH /api/assurance/unknowns/:uuid": [{ body: { status: "investigating" } }],
    "POST /api/assurance/findings/:uuid/remediation/transition": [{ body: { toState: "triaged" } }],
    "POST /api/assurance/findings/:uuid/remediation/assign": [{ body: { assignee: "alice" } }],
    "POST /api/assurance/providers": [{ body: { name: "gateway-1", kind: "gateway" } }],
    "PATCH /api/assurance/providers/:uuid": [{ body: { name: "gateway-2" } }],
    "POST /api/assurance/provider-assertions": [{ body: { provider: deployment, field: "region" } }],
    "PATCH /api/assurance/provider-assertions/:uuid": [{ body: { value: "eu-west-1" } }],
    "PUT /api/assurance/deployments/:uuid/declared-architecture": [{ body: { components: [] } }],
    "POST /api/assurance/deployments/:uuid/connectors/:connector/push": [{ body: { finding: deployment } }],
  };

  const table = (app as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })._router.stack;
  const routes: string[] = [];
  for (const layer of table) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      const route = `${method.toUpperCase()} ${layer.route.path}`;
      if (!routes.includes(route)) routes.push(route);
    }
  }

  // The admin's session, for a method the agent has no function for: its `query` sets a query string,
  // so an HTTP QUERY (which Express routes, on a Node that knows it) goes as a bare request with the cookie.
  const login = await request(app).post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
  const cookie = login.headers["set-cookie"] as unknown as string[];
  const answers: Walked["answers"] = [];
  const send = async (agent: ReturnType<typeof request.agent>, route: string, url: string, body: unknown) => {
    const method = route.split(" ")[0];
    let req = method === "QUERY"
      ? new request.Test(app, method, url).set("Cookie", cookie)
      : (agent as unknown as Record<string, (u: string) => request.Test>)[method.toLowerCase()](url);
    if (body !== undefined) req = req.send(body as object);
    try {
      const res = await req.timeout({ response: 20_000, deadline: 30_000 });
      answers.push({ route, status: res.status, text: `${res.text ?? ""} ${JSON.stringify(res.headers)}` });
    } catch (cause) {
      answers.push({ route, status: -1, text: String(cause) });
    }
  };
  let killSwitch: string | null = null;
  for (const route of routes) {
    const [method, routePath] = route.split(" ");
    if (routePath === "*") {
      // The unknown-API catch-all, in every method a client sends as a request (CONNECT opens a tunnel instead).
      if (method !== "CONNECT") await send(admin, route, "/api/no-such-route", method === "GET" || method === "HEAD" ? undefined : {});
      continue;
    }
    if (route === "PATCH /api/ai-control") { killSwitch = route; continue; }
    // Signing in and out as someone else, so the admin's session is kept.
    const agent = routePath.startsWith("/api/auth/") ? request.agent(app) : admin;
    for (const form of forms[route] ?? [{}]) {
      const url = routePath.replace(/:([A-Za-z]+)/g, (_m, name: string) => (form.params ?? {})[name] ?? param[name] ?? "999999");
      const body = form.body ?? (method === "GET" || method === "DELETE" ? undefined : {});
      await send(agent, route, url, body);
    }
  }
  // Last, the kill switch: engaged (it reads the failsafe commands in flight, a stop-lane read), then released.
  if (killSwitch !== null) {
    const from = p.seen.length;
    await send(admin, killSwitch, "/api/ai-control", { killSwitchEnabled: true });
    await p.waitFor((one) => one.n > from && one.method === "GET" && one.path === "/api/failsafe/commands/");
    await send(admin, killSwitch, "/api/ai-control", { killSwitchEnabled: false, systemStatus: "active" });
  }
  return { routes, answers };
}

describe("the service token rides on every stop the server relays, and on nothing else", () => {
  it("over the server's full route list: each request to the control plane carries it exactly when the control plane judges it a stop; every backend route the code names is reached; it is in no answer and no log", async () => {
    plane = await controlPlaneStandIn({ serviceToken: TOKEN });
    const p = plane;
    const { app, admin } = await boot(p, TOKEN);
    const logs = captureLogs();
    const walked = await walkEveryRoute(app, admin, p);

    // The walk covered the whole route list (Express's own table), and nothing hung.
    expect(walked.routes.length).toBeGreaterThan(130);
    expect(walked.answers.filter((a) => a.status === -1)).toEqual([]);

    const operator = p.seen.filter((one) => !one.path.startsWith("/api/token/"));
    const said = (one: Seen) => `${what(one, p.actionOf)} (${one.method} ${one.path})`;
    // Exactly the stops carry it: none is missing it, and nothing else carries it.
    expect(operator.filter((one) => one.stop && one.serviceToken === undefined).map(said), "stops sent without the token").toEqual([]);
    expect(operator.filter((one) => !one.stop && one.serviceToken !== undefined).map(said), "the token sent on what is not a stop").toEqual([]);
    // The configured token, and the control plane took it on every stop.
    expect(operator.filter((one) => one.serviceToken !== undefined && one.serviceToken !== TOKEN).map(said)).toEqual([]);
    expect(operator.filter((one) => one.stop && one.by !== "service token").map(said)).toEqual([]);
    // Every stop this server relays was among them, and so was every non-stop form of the same routes.
    const kinds = new Set(operator.map((one) => what(one, p.actionOf)));
    expect(STOPS_RELAYED.filter((kind) => !kinds.has(kind)), "stops the walk did not reach").toEqual([]);
    expect(NOT_STOPS_ON_STOP_ROUTES.filter((kind) => !kinds.has(kind)), "non-stop forms the walk did not reach").toEqual([]);
    expect(STOPS_RELAYED.every((kind) => operator.some((one) => one.stop && what(one, p.actionOf) === kind))).toBe(true);
    expect(NOT_STOPS_ON_STOP_ROUTES.every((kind) => operator.every((one) => what(one, p.actionOf) !== kind || !one.stop))).toBe(true);

    // Every backend route the server's code names was reached -- and no route it does not name.
    const named = backendRoutesNamedInSource();
    expect(named.length).toBeGreaterThan(50);
    expect(named.filter((one) => !operator.some((sent) => one.pattern.test(sent.path))).map((one) => one.literal), "backend routes never reached").toEqual([]);
    expect(operator.filter((sent) => !named.some((one) => one.pattern.test(sent.path))).map(said), "backend routes the code does not name").toEqual([]);

    // Never in an answer, nor in a log line.
    expect(walked.answers.filter((a) => a.text.includes(TOKEN)).map((a) => a.route)).toEqual([]);
    expect(logs.filter((line) => line.includes(TOKEN))).toEqual([]);

    vi.restoreAllMocks();
    console.log(`[route walk] ${walked.routes.length} routes (method and path) in Express's table, ${walked.answers.length} requests sent; ` +
      `the control plane got ${operator.length}: ${operator.filter((one) => one.stop).length} stops, every one with the token, ` +
      `${operator.filter((one) => !one.stop).length} others, none with it; ${named.length} backend routes named in server/, every one reached.\n` +
      `  stops seen: ${[...new Set(operator.filter((one) => one.stop).map((one) => what(one, p.actionOf)))].join("; ")}`);
  }, 120_000);
});

describe("the service token never leaves this server but toward the control plane's stops", () => {
  it("a control plane that quotes a request's headers back in its refusals: the quote reaches the page and the log without the token", async () => {
    plane = await controlPlaneStandIn({ serviceToken: TOKEN, echoHeaders: true });
    const p = plane;
    const { admin } = await boot(p, TOKEN);
    const logs = captureLogs();
    const pause = p.command("pause");
    const resume = p.command("resume");
    const deployment = randomUUID();
    const answers = [];
    for (const send of [
      () => admin.get("/api/failsafe/status"),
      () => admin.get("/api/failsafe/state"),
      () => admin.get("/api/failsafe/commands"),
      () => admin.get(`/api/failsafe/commands/${pause}`),
      () => admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "engine-1", reason: "x" }),
      () => admin.post("/api/failsafe/commands").send({ action: "stand_down", engineId: "engine-1", reason: "x" }),
      () => admin.post(`/api/failsafe/commands/${pause}/signatures`).send({ keyId: "k1", sig: "abcd" }),
      () => admin.post(`/api/failsafe/commands/${resume}/cancel`).send({}),
      () => admin.post(`/api/assurance/deployments/${deployment}/recompute`).send({ paused: true }),
      () => admin.post(`/api/assurance/claims/${deployment}/transition`).send({ toStatus: "revoked" }),
    ]) answers.push(await send());
    // The token went out, and came back in the control plane's refusals...
    expect(p.seen.filter((one) => one.serviceToken === TOKEN).length).toBeGreaterThan(5);
    // ...which reached the page, with the token taken out.
    const texts = answers.map((a) => `${a.text} ${JSON.stringify(a.headers)}`);
    expect(texts.some((text) => text.includes("[the failsafe service token]"))).toBe(true);
    expect(texts.filter((text) => text.includes(TOKEN))).toEqual([]);
    expect(logs.filter((line) => line.includes(TOKEN))).toEqual([]);
  }, 60_000);

  it("the client bundle cannot carry it: Vite puts into the bundle only what `define` names and the environment's VITE_ variables, and there is neither", () => {
    const config = fs.readFileSync(path.join(ROOT, "vite.config.ts"), "utf8");
    expect(config).not.toMatch(/\bdefine\s*:/);
    expect(config).not.toMatch(/\benvPrefix\s*:/);
    expect(config).not.toMatch(/\bloadEnv\b/);
    expect("ATHENA_FAILSAFE_SERVICE_TOKEN".startsWith("VITE_")).toBe(false);
  });
});

describe("without ATHENA_FAILSAFE_SERVICE_TOKEN nothing changes", () => {
  it("over the full route list, no request carries the header, and every one -- the stops too -- goes on the service account's token", async () => {
    plane = await controlPlaneStandIn({ serviceToken: TOKEN });
    const p = plane;
    const { app, admin } = await boot(p, null);
    captureLogs();
    const walked = await walkEveryRoute(app, admin, p);
    expect(walked.answers.filter((a) => a.status === -1)).toEqual([]);
    const operator = p.seen.filter((one) => !one.path.startsWith("/api/token/"));
    expect(operator.filter((one) => one.stop).length).toBeGreaterThan(STOPS_RELAYED.length);
    expect(operator.filter((one) => one.serviceToken !== undefined)).toEqual([]);
    expect(operator.filter((one) => one.by !== "bearer").map((one) => `${one.method} ${one.path}`)).toEqual([]);
    // A stop waited for the sign-in, as before: the first one went after it.
    const firstStop = operator.find((one) => one.stop)!;
    expect(p.seen.findIndex((one) => one.path === "/api/token/")).toBeLessThan(p.seen.indexOf(firstStop));
  }, 120_000);

  it.each([
    ["shorter than the 32 characters the control plane requires", "a".repeat(31)],
    ["holding a character no HTTP header can carry", `${"b".repeat(20)}\n${"c".repeat(20)}`],
  ])("a token %s is not sent: stops go on the service account's token, and start-up says why without the value", async (_why, value) => {
    plane = await controlPlaneStandIn({ serviceToken: value });
    const p = plane;
    const { admin } = await boot(p, value);
    const logs = captureLogs();
    expect((await admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "engine-1", reason: "x" })).status).toBe(201);
    expect((await admin.post(`/api/assurance/deployments/${randomUUID()}/recompute`).send({ paused: true })).status).toBe(200);
    const stops = p.seen.filter((one) => one.stop);
    expect(stops.length).toBe(2);
    expect(stops.filter((one) => one.serviceToken !== undefined || one.by !== "bearer")).toEqual([]);
    expect(logs.some((line) => line.includes("ATHENA_FAILSAFE_SERVICE_TOKEN is set but is not used"))).toBe(true);
    expect(logs.filter((line) => line.includes(value) || line.includes(value.trim()))).toEqual([]);
  }, 60_000);
});

describe("the service account's token is renewed by its refresh token before its password", () => {
  it.each([
    ["the failsafe console (server/failsafe.ts)", "/api/failsafe/audit"],
    ["the assurance screens (server/control-plane.ts)", "/api/assurance/deployments"],
  ])("%s: an expired token is renewed by refresh; the rotated refresh token is the one sent next; the password only once the refresh is refused", async (_client, route) => {
    plane = await controlPlaneStandIn({ serviceToken: null });
    const p = plane;
    const { admin } = await boot(p, null);
    captureLogs();
    const renewals = () => p.seen.filter((one) => one.path.startsWith("/api/token/"))
      .map((one) => (one.path === "/api/token/" ? "sign-in" : `refresh ${JSON.parse(one.body).refresh}`));

    expect((await admin.get(route)).status).toBe(200);
    p.expireAccess();
    expect((await admin.get(route)).status).toBe(200);
    p.expireAccess();
    expect((await admin.get(route)).status).toBe(200);
    expect(renewals()).toEqual(["sign-in", "refresh refresh-1", "refresh refresh-2"]);
    expect(p.spentRefresh).toEqual(["refresh-1", "refresh-2"]);

    // The control plane refuses the refresh: then, and only then, the password.
    p.settings.refresh = 401;
    p.expireAccess();
    expect((await admin.get(route)).status).toBe(200);
    expect(renewals()).toEqual(["sign-in", "refresh refresh-1", "refresh refresh-2", "refresh refresh-3", "sign-in"]);
  }, 60_000);

  it("the failsafe token kept warm ahead of its expiry is renewed by refresh, each time with the refresh token the last one answered with", async () => {
    plane = await controlPlaneStandIn({ serviceToken: null });
    const p = plane;
    const { admin } = await boot(p, null);
    captureLogs();
    const failsafe = await import("../server/failsafe");
    // Every token reads as close to its expiry, so it is renewed 25 ms after it arrives.
    failsafe.tokenRefresh.minMs = 3_600_000;
    failsafe.tokenRefresh.retryMs = 25;
    try {
      expect((await admin.get("/api/failsafe/audit")).status).toBe(200);
      const first = await p.waitFor((one) => one.path === "/api/token/refresh/");
      const second = await p.waitFor((one) => one.path === "/api/token/refresh/" && one.n > first.n);
      expect(JSON.parse(first.body)).toEqual({ refresh: "refresh-1" });
      expect(JSON.parse(second.body)).toEqual({ refresh: "refresh-2" });
      expect(p.signIns()).toBe(1);
    } finally {
      failsafe._resetForTests();
    }
  }, 30_000);
});
