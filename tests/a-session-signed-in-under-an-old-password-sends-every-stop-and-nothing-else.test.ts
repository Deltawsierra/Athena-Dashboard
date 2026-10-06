import { afterEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import request from "supertest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { controlPlaneStandIn, type ControlPlaneStandIn, type Seen } from "./helpers/control-plane-stand-in";
import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";

/**
 * A session signed in under a password its account no longer has -- the
 * password changed on another dashboard on the same database, or an admin
 * reset it -- holds nothing but its stops (auth.ts asTheSessionHoldsIt). It
 * still sends EVERY stop, with the same answer and relaying the same requests
 * as a session that holds its account: the failsafe reads a second operator
 * stops from, withdrawing a resume or a release, pausing a deployment and
 * taking a claim down were authorised from the account, read now, and answered
 * such a session 401 (#65 review round 3, F4). Everything else it asks is
 * refused, and relays nothing.
 *
 * Which requests are stops is not taken from the guards' own lists: the
 * server's full route table (Express's own) is walked, each route in its stop
 * and non-stop forms, once from a session that holds its account and once
 * from one that does not.
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
async function boot(p: ControlPlaneStandIn, engineUrl: string, passwordSet: boolean, stale = false) {
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
  if (stale) {
    // Another dashboard on the same database (or an admin reset) changed this account's password.
    const me = (await storage.getUserByUsername("admin"))!;
    await storage.updateUser(me.id, { password: "changed-elsewhere-long-password" }); // pragma: allowlist secret
    expect((await admin.get("/api/auth/check")).body.authenticated).toBe(false);
  }
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


describe("a session signed in under an old password", () => {
  it("sends every stop a session that holds its account sends, and nothing else", async () => {
    const runs: Record<string, Answer[]> = {};
    for (const mode of ["set", "stale"] as const) {
      plane = await controlPlaneStandIn();
      const eng = await engineStandIn();
      const { app, admin, runningTestId } = await boot(plane, eng.url, true, mode === "stale");
      runs[mode] = await walk(app, admin, plane, runningTestId);
      await plane.close();
      plane = null;
      engine!.closeAllConnections?.();
      await new Promise<void>((done) => engine!.close(() => done()));
      engine = null;
    }
    const stops = runs.stale.filter(isStop);
    const lines = stops.map((a) => {
      const b = runs.set.find((one) => one.request === a.request)!;
      return `${a.status === b.status && JSON.stringify(a.relayed) === JSON.stringify(b.relayed) ? "SAME" : "DIFF"} ${a.request}: stale ${a.status} relayed ${JSON.stringify(a.relayed)} | set ${b.status} relayed ${JSON.stringify(b.relayed)}`;
    });
    expect(lines.filter((l) => l.startsWith("DIFF"))).toEqual([]);
    expect(stops.length).toBeGreaterThan(20);

    // Everything else was refused, and relayed nothing -- but what anyone may
    // ask, signed in or not: the health check, and a CORS preflight.
    const PUBLIC = ["GET /health", "OPTIONS * {}"];
    const others = runs.stale.filter((a) => !isStop(a) && !PUBLIC.includes(a.request));
    expect(others.length).toBeGreaterThan(50);
    for (const a of others) {
      expect([401, 403, 404], a.request).toContain(a.status);
      expect(a.relayed, a.request).toEqual([]);
    }
    // Withdrawing a pause, a stand-down or a terminate takes a stop away: refused.
    for (const action of ["pause", "stand_down", "terminate"]) {
      const withdrawal = runs.stale.find((a) => a.request.startsWith(`POST /api/failsafe/commands/:uuid/cancel [${action}]`))!;
      expect(withdrawal.status, action).toBe(401);
    }
  }, 120_000);
});
