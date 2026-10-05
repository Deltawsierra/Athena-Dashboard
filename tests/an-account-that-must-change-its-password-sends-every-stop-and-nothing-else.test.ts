import { afterEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import request from "supertest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { controlPlaneStandIn, type ControlPlaneStandIn, type Seen } from "./helpers/control-plane-stand-in";
import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";
import { LEGACY_DEFAULT_PASSWORDS } from "../server/password";

/**
 * An account that must change its password -- the first-run admin, or one
 * found on a legacy default -- may change it, sign out, read itself, and send
 * EVERY stop. Everything else answers 403 {"error":"password change required"}.
 *
 * Which requests are stops is not taken from the guard's own list. The
 * server's full route table (Express's own) is walked twice, each route in
 * its stop and non-stop forms: once as an admin who has set a password, once
 * as the first-run admin who has not. Every stop the first walk sent to the
 * control plane or the engine, the second sent too, with the same answer --
 * so a stop route added later, and gated by mistake, fails here. Every other
 * request of the second walk was refused, and nothing it sent the control
 * plane was anything but a stop.
 */

const ENV = ["ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD", "ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY"];
const ACTIONS = ["pause", "stand_down", "terminate", "resume", "release"];
const REFUSAL = { error: "password change required" };

let plane: ControlPlaneStandIn | null = null;
let engine: http.Server | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await plane?.close();
  plane = null;
  if (engine) {
    engine.closeAllConnections?.();
    await new Promise<void>((done) => engine!.close(() => done()));
    engine = null;
  }
  for (const name of ENV) delete process.env[name];
});

/** An engine that answers every stop, and records each request it got. */
async function engineStandIn(): Promise<{ url: string; calls: string[] }> {
  const calls: string[] = [];
  engine = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url === "/api/scans/active" ? { active: [] } : req.url === "/health" ? { status: "ok" } : {}));
    });
  });
  await new Promise<void>((ready) => engine!.listen(0, "127.0.0.1", ready));
  return { url: `http://127.0.0.1:${(engine.address() as AddressInfo).port}`, calls };
}

/** The dashboard after its first run, reaching `p` and `engineUrl`; the admin has set a password only when `passwordSet`. */
async function boot(p: ControlPlaneStandIn, engineUrl: string, passwordSet: boolean) {
  process.env.ATHENA_FAILSAFE_URL = p.url;
  process.env.ATHENA_FAILSAFE_USER = "svc-failsafe";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc-password"; // pragma: allowlist secret
  process.env.ATHENA_ENGINE_URL = engineUrl;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  const { storage } = await import("../server/storage-unified");
  const app = createApp();
  await initializeDefaultData();
  if (passwordSet) await adminHasSetPassword();
  const admin = request.agent(app);
  const login = await admin.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  expect(login.body.user.mustChangePassword).toBe(!passwordSet);
  // A scan running under an engine run, for its Stop to reach the engine.
  const client = await storage.createClient({ name: "Running", company: "R", email: "running@r.test" });
  const running = await storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "running",
    findings: { runId: "run-walk-1", target: "https://offline.invalid/", results: [] },
  });
  return { app, admin, runningTestId: running.id };
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

/** One request of the walk, its answer, and the stops it relayed to the control plane (what()). */
interface Answer { request: string; route: string; status: number; body: unknown; relayed: string[] }

/** Every route and method in Express's table, as `admin`; a stop route in its stop and its non-stop forms. */
async function walk(app: Express, admin: ReturnType<typeof request.agent>, p: ControlPlaneStandIn, runningTestId: string): Promise<Answer[]> {
  const deployment = randomUUID();
  const commandOf = Object.fromEntries(ACTIONS.map((action) => [action, p.command(action)]));
  const param: Record<string, string> = {
    uuid: deployment, id: "999999", testId: "999999", runId: "run-999999", clientId: "999999", pack: "pack-1", connector: "jira",
  };
  const forms: Record<string, Array<{ params?: Record<string, string>; body?: unknown; name?: string }>> = {
    "POST /api/scans/:testId/abort": [{ params: { testId: runningTestId }, name: "running" }, { name: "no such scan" }],
    "POST /api/failsafe/commands": ACTIONS.map((action) => ({ body: { action, engineId: "engine-1", reason: "the walk" } })),
    "GET /api/failsafe/commands/:uuid": ACTIONS.map((action) => ({ params: { uuid: commandOf[action] }, name: action })),
    "POST /api/failsafe/commands/:uuid/signatures": ACTIONS.map((action) => ({
      params: { uuid: commandOf[action] }, body: { keyId: "k1", sig: "abcd" }, name: action,
    })),
    "POST /api/failsafe/commands/:uuid/cancel": ACTIONS.map((action) => ({ params: { uuid: commandOf[action] }, body: {}, name: action })),
    "POST /api/assurance/deployments/:uuid/recompute": [{ body: { paused: true } }, { body: { paused: false } }, { body: {} }],
    "POST /api/assurance/claims/:uuid/transition": [
      { body: { toStatus: "revoked" } }, { body: { toStatus: "contradicted", note: "its evidence was forged" } },
      { body: { toStatus: "verified" } }, { body: { toStatus: "stale" } },
    ],
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
  const answers: Answer[] = [];
  const send = async (route: string, url: string, body: unknown, name?: string) => {
    const method = route.split(" ")[0];
    if (method === "QUERY" || method === "CONNECT") return;
    let req = (admin as unknown as Record<string, (u: string) => request.Test>)[method.toLowerCase()](url);
    if (body !== undefined) req = req.send(body as object);
    const label = `${route}${name ? ` [${name}]` : ""}${body !== undefined ? ` ${JSON.stringify(body)}` : ""}`;
    const before = p.seen.length;
    const relayed = () => p.seen.slice(before)
      .filter((one) => one.stop && !one.path.startsWith("/api/token/"))
      .map((one) => what(one, p.actionOf));
    try {
      const res = await req.timeout({ response: 20_000, deadline: 30_000 });
      answers.push({ request: label, route, status: res.status, body: res.body, relayed: relayed() });
    } catch (cause) {
      answers.push({ request: label, route, status: -1, body: String(cause), relayed: relayed() });
    }
  };
  for (const route of routes) {
    const [method, routePath] = route.split(" ");
    // Signing in, out and changing the password are this account's own, and tested below; the kill switch goes last.
    if (routePath.startsWith("/api/auth/") || route === "PATCH /api/ai-control") continue;
    if (routePath === "*") {
      await send(route, "/api/no-such-route", method === "GET" || method === "HEAD" ? undefined : {});
      continue;
    }
    for (const form of forms[route] ?? [{}]) {
      const url = routePath.replace(/:([A-Za-z]+)/g, (_m, name: string) => (form.params ?? {})[name] ?? param[name] ?? "999999");
      const body = form.body ?? (method === "GET" || method === "DELETE" ? undefined : {});
      await send(route, url, body, form.name);
    }
  }
  // A setting that is not the switch, then the switch: engaged (it sends a stop to every running scan).
  await send("PATCH /api/ai-control", "/api/ai-control", { maxConcurrentTests: 7 });
  await send("PATCH /api/ai-control", "/api/ai-control", { killSwitchEnabled: true });
  return answers;
}

/** The stops this server takes, by what the walk sent (the code's own: server/auth.ts isStopForPasswordGuard and the handlers it defers to). */
function isStop(a: Answer): boolean {
  const label = a.request;
  if (/^POST \/api\/(scans|retests)\/:[A-Za-z]+\/abort/.test(label)) return true;
  if (/^DELETE \/api\/api-keys\/:id/.test(label)) return true;
  if (label === `PATCH /api/ai-control ${JSON.stringify({ killSwitchEnabled: true })}`) return true;
  if (/^POST \/api\/failsafe\/commands \{"action":"(pause|stand_down|terminate)"/.test(label)) return true;
  if (/^POST \/api\/failsafe\/commands\/:uuid\/signatures \[(pause|stand_down|terminate)\]/.test(label)) return true;
  if (/^POST \/api\/failsafe\/commands\/:uuid\/cancel \[(resume|release)\]/.test(label)) return true;
  if (/^GET \/api\/failsafe\/(status|state|commands|commands\/:uuid)( |$)/.test(label)) return true;
  if (label === `POST /api/assurance/deployments/:uuid/recompute ${JSON.stringify({ paused: true })}`) return true;
  if (/^POST \/api\/assurance\/claims\/:uuid\/transition \{"toStatus":"(revoked|contradicted)"/.test(label)) return true;
  return false;
}

describe("an account that must change its password sends every stop, and nothing else", () => {
  it("over the full route table: every stop goes as it goes for an admin who has set a password; everything else is refused", async () => {
    const runs: Record<"set" | "required", { answers: Answer[]; plane: Seen[]; actionOf: (u: string) => string | undefined; engine: string[] }> =
      {} as never;
    for (const mode of ["set", "required"] as const) {
      plane = await controlPlaneStandIn();
      const eng = await engineStandIn();
      const { app, admin, runningTestId } = await boot(plane, eng.url, mode === "set");
      const answers = await walk(app, admin, plane, runningTestId);
      runs[mode] = {
        answers, plane: plane.seen.filter((one) => !one.path.startsWith("/api/token/")), actionOf: plane.actionOf,
        engine: eng.calls.filter((line) => line.endsWith("/abort")),
      };
      await plane.close();
      plane = null;
      engine!.closeAllConnections?.();
      await new Promise<void>((done) => engine!.close(() => done()));
      engine = null;
    }
    const { set, required } = runs;
    expect(required.answers.map((a) => a.request)).toEqual(set.answers.map((a) => a.request));
    expect(required.answers.length).toBeGreaterThan(150);
    expect(required.answers.filter((a) => a.status === -1).map((a) => a.request), "nothing hung").toEqual([]);

    // Every stop: answered as it is for the admin who has set a password, and never refused.
    const stops = required.answers.filter(isStop);
    expect(stops.length).toBeGreaterThanOrEqual(20);
    const differs = stops
      .map((a) => ({ a, b: set.answers.find((one) => one.request === a.request)! }))
      .filter(({ a, b }) => a.status !== b.status || JSON.stringify(a.body) === JSON.stringify(REFUSAL))
      .map(({ a, b }) => `${a.request}: ${a.status} ${JSON.stringify(a.body)} (with a password set: ${b.status})`);
    expect(differs, "stops answered differently, or refused").toEqual([]);

    // Everything else under /api: refused, exactly.
    const notRefused = required.answers
      .filter((a) => !isStop(a) && a.route.split(" ")[1].startsWith("/api"))
      .filter((a) => !(a.status === 403 && JSON.stringify(a.body) === JSON.stringify(REFUSAL)))
      .map((a) => `${a.request}: ${a.status} ${JSON.stringify(a.body).slice(0, 160)}`);
    expect(notRefused, "requests that were not stops and were not refused").toEqual([]);

    // The control plane, request by request: every stop a request of the
    // first walk relayed, the same request (route and form) of the second
    // relayed too. Not by kind alone: a route that relays a stop for one
    // account and is refused to the other would hide behind another route
    // sending the same kind.
    const unrelayed = set.answers
      .map((a) => ({ a, b: required.answers.find((one) => one.request === a.request)! }))
      .filter(({ a, b }) => JSON.stringify(a.relayed) !== JSON.stringify(b.relayed))
      .map(({ a, b }) => `${a.request}: relayed ${JSON.stringify(a.relayed)} with a password set, ${JSON.stringify(b.relayed)} without`);
    expect(unrelayed, "requests whose relayed stops differ").toEqual([]);
    // ...and, by kind, the whole of them -- and nothing but stops.
    const stopKinds = (run: typeof set) => [...new Set(run.plane.filter((one) => one.stop).map((one) => what(one, run.actionOf)))].sort();
    expect(stopKinds(set).length).toBeGreaterThanOrEqual(14);
    expect(stopKinds(required)).toEqual(stopKinds(set));
    expect(required.plane.filter((one) => !one.stop).map((one) => what(one, required.actionOf)), "not stops, relayed").toEqual([]);

    // The engine: the same stops.
    expect(set.engine.length).toBeGreaterThan(0);
    expect(required.engine).toEqual(set.engine);
  }, 120_000);

  it("reads itself, signs out, and is refused an ordinary route with exactly the answer", async () => {
    vi.resetModules();
    const { createApp } = await import("../server/app");
    const { initializeDefaultData } = await import("../server/init-data");
    const app = createApp();
    await initializeDefaultData();
    const admin = request.agent(app);
    const login = await admin.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);

    const clients = await admin.get("/api/clients");
    expect(clients.status).toBe(403);
    expect(clients.body).toEqual(REFUSAL);
    expect((await admin.post("/api/clients").send({ name: "x", company: "x", email: "x@x.test" })).body).toEqual(REFUSAL);

    const check = await admin.get("/api/auth/check");
    expect(check.status).toBe(200);
    expect(check.body.user.username).toBe("admin");
    expect(check.body.user.mustChangePassword).toBe(true);
    expect(check.body.user.password).toBeUndefined();

    expect((await admin.post("/api/auth/logout")).status).toBe(200);
    expect((await admin.get("/api/clients")).status).toBe(401);
  });
});

describe("a withdrawal whose command's action was not read", () => {
  /** The flagged first-run admin, and a command `action` drafted by a second operator. */
  async function flagged() {
    plane = await controlPlaneStandIn();
    process.env.ATHENA_FAILSAFE_URL = plane.url;
    process.env.ATHENA_FAILSAFE_USER = "svc-failsafe";
    process.env.ATHENA_FAILSAFE_PASSWORD = "svc-password"; // pragma: allowlist secret
    vi.resetModules();
    const { createApp } = await import("../server/app");
    const { initializeDefaultData } = await import("../server/init-data");
    const failsafe = await import("../server/failsafe");
    const app = createApp();
    await initializeDefaultData();
    const admin = request.agent(app);
    const login = await admin.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
    expect(login.body.user.mustChangePassword).toBe(true);
    failsafe.failsafeTimeouts.commandReadMs = 100;
    return { admin, p: plane };
  }

  const ways: Array<[string, (p: ControlPlaneStandIn, action: string) => string]> = [
    // In life: a slow control plane. The read is held unanswered past the bound.
    ["read stalls", (p, action) => { const uuid = p.command(action); p.stallReadsOf(uuid); return uuid; }],
    // The read answers, and names no command this control plane holds.
    ["command is not found", () => randomUUID()],
  ];

  it.each(ACTIONS.filter((one) => one !== "resume" && one !== "release").flatMap((action) => ways.map(([how, make]) => [action, how, make] as const)))(
    "is refused to an account that must change its password: a %s whose %s is never withdrawn by it",
    async (action, _how, make) => {
      const { admin, p } = await flagged();
      const uuid = make(p, action);

      const res = await admin.post(`/api/failsafe/commands/${uuid}/cancel`).send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("password change required");
      expect(res.body.detail).toMatch(/could not be read in time.*Nothing was withdrawn/);
      expect(p.seen.filter((one) => one.path === `/api/failsafe/commands/${uuid}/cancel/` && one.method === "POST")).toEqual([]);
    },
    30_000,
  );

  it("refuses it no stop: the account's own pause still goes while a command's read stalls", async () => {
    const { admin, p } = await flagged();
    p.stallReadsOf(p.command("resume"));

    const paused = await admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "engine-1", reason: "flagged and stopping" });

    expect(paused.status).toBeLessThan(300);
    expect(p.seen.some((one) => one.path === "/api/failsafe/commands/" && one.method === "POST" && one.stop)).toBe(true);
  }, 30_000);
});

describe("POST /api/auth/change-password", () => {
  async function flaggedAdmin() {
    vi.resetModules();
    const { createApp } = await import("../server/app");
    const { initializeDefaultData } = await import("../server/init-data");
    const { resetLoginThrottle } = await import("../server/routes");
    resetLoginThrottle();
    const app = createApp();
    await initializeDefaultData();
    const admin = request.agent(app);
    expect((await admin.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD })).status).toBe(200);
    return { app, admin };
  }

  it("refuses a wrong current password, and a new one that is short, unchanged, a legacy default or the username", async () => {
    const { admin } = await flaggedAdmin();
    const change = (currentPassword: string, newPassword: string) =>
      admin.post("/api/auth/change-password").send({ currentPassword, newPassword });

    const wrong = await change("not-the-password-at-all", "a-perfectly-good-new-password");
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toMatch(/current password is incorrect/);
    expect((await change(TEST_ADMIN_PASSWORD, "short-pw-11")).body.message).toMatch(/at least 12 characters/);
    expect((await change(TEST_ADMIN_PASSWORD, TEST_ADMIN_PASSWORD)).body.message).toMatch(/differ from the current/);
    for (const legacy of LEGACY_DEFAULT_PASSWORDS) {
      const refused = await change(TEST_ADMIN_PASSWORD, legacy);
      expect(refused.status).toBe(400);
      expect(refused.body.message).toMatch(/The password was not changed/);
    }
    // The username, in any case ("admin" is too short to reach this rule over the route).
    const { newPasswordRefusal } = await import("../server/password");
    expect(newPasswordRefusal("Administrator1", "x", "administrator1")).toMatch(/username/);
    expect(newPasswordRefusal("a-perfectly-good-new-password", "x", "administrator1")).toBeNull();

    // None of these changed anything: the flag stands and ordinary routes are still refused.
    expect((await admin.get("/api/auth/check")).body.user.mustChangePassword).toBe(true);
    expect((await admin.get("/api/clients")).body).toEqual(REFUSAL);
  });

  it("a good new password clears the flag, opens the app, and ends the account's other sessions", async () => {
    const { app, admin } = await flaggedAdmin();
    const other = request.agent(app);
    expect((await other.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD })).status).toBe(200);

    const next = "a-new-and-long-admin-password";
    const changed = await admin.post("/api/auth/change-password").send({ currentPassword: TEST_ADMIN_PASSWORD, newPassword: next });
    expect(changed.status).toBe(200);
    expect(changed.body.user.mustChangePassword).toBe(false);
    expect(changed.body.user.password).toBeUndefined();

    expect((await admin.get("/api/auth/check")).body.user.mustChangePassword).toBe(false);
    expect((await admin.get("/api/clients")).status).toBe(200);
    // The session signed in with the old password holds nothing now.
    await vi.waitFor(async () => expect((await other.get("/api/clients")).status).toBe(401));
    // The old password signs in no more; the new one does.
    expect((await request(app).post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ username: "admin", password: next })).status).toBe(200);
  });

  it("goes while the kill switch is engaged", async () => {
    const { admin } = await flaggedAdmin();
    expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
    const changed = await admin.post("/api/auth/change-password")
      .send({ currentPassword: TEST_ADMIN_PASSWORD, newPassword: "a-new-and-long-admin-password" }); // pragma: allowlist secret
    expect(changed.status).toBe(200);
  });
});
