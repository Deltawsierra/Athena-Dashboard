import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "http";
import type { Express } from "express";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * SAFETY: engaging the AI Control kill switch blocked every other stop.
 *
 * enforceKillSwitch answered 503 to every non-GET /api request but its own and
 * sign-in/out. So once an admin pressed "Activate Kill Switch":
 *   - a running engine scan kept running -- PATCH /api/ai-control stored a
 *     flag and told the engine nothing -- and its Stop,
 *     POST /api/scans/:testId/abort, was refused with 503;
 *   - the failsafe console could not draft a pause, stand-down or terminate,
 *     nor relay the second signature a stand-down was waiting for: 503;
 * while the AI Control page said "All AI operations have been terminated".
 *
 * Now: engaging the switch sends the engine a stop for every engine scan that
 * may still be running and answers with what each came to -- an engine that
 * refused or could not be reached is reported, not folded into a success --
 * and every stop stays reachable while it is engaged. Resume and release, and
 * every ordinary write, stay refused.
 *
 * (The adversary's reproducer pinned "engaging it did not stop the running
 * scan: the engine was never told" as the observed behaviour. That assertion
 * is inverted here: the engine is told.)
 */

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const ENV = ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER",
  "ATHENA_FAILSAFE_PASSWORD", "ATHENA_FAILSAFE_ENGINE_ID"];

/** A stub engine: scans run until told otherwise; `refuse` and `drop` decide how an abort goes. */
function stubEngine() {
  const calls: string[] = [];
  const refuse = new Set<string>();
  const drop = new Set<string>();
  let next = 0;
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    calls.push(`${req.method} ${url}`);
    if (url === "/health") return json(res, 200, { status: "ok" });
    const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
    if (abort) {
      if (drop.has(abort[1])) return void req.socket.destroy();
      return refuse.has(abort[1]) ? json(res, 500, { detail: "no" }) : json(res, 200, {});
    }
    if (req.method === "GET" && url.startsWith("/api/scans/")) {
      return json(res, 200, { run_id: url.split("/")[3], state: "running", findings: [] });
    }
    next += 1;
    return json(res, 202, { run_id: `run-${next}`, state: "running" });
  });
  return { server, calls, refuse, drop };
}

/**
 * A stub failsafe control plane. A command's action is the first word of its
 * uuid ("standdown-1" is a stand-down); an "unreadable-*" command cannot be read.
 */
function stubControlPlane() {
  const calls: string[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      calls.push(`${req.method} ${path}`);
      const now = new Date();
      const cmd = (uuid: string, action: string) => ({
        uuid, engine_id: "athena-1", action, nonce: "n", issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 600_000).toISOString(), reason: "", signers: [],
        required_signatures: 2, status: "awaiting_signatures", created_at: now.toISOString(), updated_at: now.toISOString(),
      });
      const actionOf = (uuid: string) => uuid.split("-")[0].replace("standdown", "stand_down");
      if (path === "/api/token/") return json(res, 200, { access: "t", refresh: "r" });
      if (path === "/api/failsafe/commands/" && req.method === "POST") {
        const action = JSON.parse(raw).action as string;
        return json(res, 201, { ...cmd(`${action.replace("_", "")}-new`, action), signing_bytes: "beef" });
      }
      const one = /^\/api\/failsafe\/commands\/([^/]+)\/(signatures\/|cancel\/)?$/.exec(path);
      if (one) {
        const [, uuid, tail] = one;
        if (!tail && uuid.startsWith("unreadable")) return json(res, 500, { detail: "database is locked" });
        const body = cmd(uuid, uuid.startsWith("unreadable") ? "resume" : actionOf(uuid));
        if (tail === "signatures/") return json(res, 200, { ...body, signers: ["bob"] });
        if (tail === "cancel/") return json(res, 200, { ...body, status: "canceled" });
        return json(res, 200, { ...body, signing_bytes: "beef" });
      }
      return json(res, 404, { detail: "no" });
    });
  });
  return { server, calls };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function bootWith(engineUrl: string, cpUrl: string) {
  process.env.ATHENA_ENGINE_URL = engineUrl;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  process.env.ATHENA_FAILSAFE_URL = cpUrl;
  process.env.ATHENA_FAILSAFE_USER = "svc";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc";
  process.env.ATHENA_FAILSAFE_ENGINE_ID = "athena-1";
  vi.resetModules();
  const app: Express = await makeApp();
  return { app, admin: await signIn(app) };
}

async function close(...servers: Server[]) {
  for (const k of ENV) delete process.env[k];
  for (const server of servers) await new Promise<void>((r) => server.close(() => r()));
}

type Agent = Awaited<ReturnType<typeof signIn>>;
type Log = { action: string; entityType: string; entityId: string; details: any };

async function engagement(admin: Agent, name: string): Promise<string> {
  const client = await admin.post("/api/clients").send({ name, company: name, email: `${name}@acme.test` });
  await admin.post("/api/sites").send({ clientId: client.body.id, name: "S", url: "https://acme.example" });
  return client.body.id as string;
}

async function startScan(admin: Agent, clientId: string): Promise<{ testId: string; runId: string }> {
  const started = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/" });
  expect(started.status).toBe(201);
  return { testId: started.body.test.id, runId: started.body.runId };
}

// Exactly what the AI Control page sends.
const KILL = { killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] };

describe("engaging the kill switch stops what is running, and says what it stopped", () => {
  const engine = stubEngine();
  const cp = stubControlPlane();
  let admin: Agent;
  let running: Array<{ testId: string; runId: string }> = [];
  let finishedTest = "";
  let manualTest = "";
  let kill: { status: number; body: any };

  beforeAll(async () => {
    ({ admin } = await bootWith(await listen(engine.server), await listen(cp.server)));
    const clientId = await engagement(admin, "Acme");
    running = [await startScan(admin, clientId), await startScan(admin, clientId)];
    // A finished engine scan, and a person's record that says "running" with
    // no engine run behind it: neither is sent a stop.
    const done = await startScan(admin, clientId);
    const { storage } = await import("../server/storage-unified");
    await storage.updateTest(done.testId, { status: "completed" });
    finishedTest = done.testId;
    manualTest = (await admin.post("/api/tests").send({ clientId, testType: "manual", status: "running" })).body.id;
    engine.calls.length = 0;

    kill = await admin.patch("/api/ai-control").send(KILL);
  });
  afterAll(() => close(engine.server, cp.server));

  it("sends the engine a stop for every engine scan that may still be running, and nothing else", () => {
    expect(kill.status).toBe(200);
    expect(kill.body.killSwitchEnabled).toBe(true);
    const aborts = engine.calls.filter((one) => one.endsWith("/abort")).sort();
    expect(aborts).toEqual(running.map((one) => `POST /api/scans/${one.runId}/abort`).sort());
  });

  it("answers with each stop's outcome, as the engine gave it", () => {
    expect(kill.body.stops.listed).toBe(true);
    const scans = kill.body.stops.scans as Array<{ testId: string; stopped: boolean; detail: string; target: string }>;
    expect(scans.map((one) => one.testId).sort()).toEqual(running.map((one) => one.testId).sort());
    expect(scans.every((one) => one.stopped && one.detail === "" && one.target === "https://acme.example/")).toBe(true);
    expect(scans.map((one) => one.testId)).not.toContain(finishedTest);
    expect(scans.map((one) => one.testId)).not.toContain(manualTest);
  });

  it("records each stop against its test", async () => {
    const logs = (await admin.get("/api/logs")).body as Log[];
    for (const one of running) {
      expect(logs.some((log) => log.action === "aborted" && log.entityId === one.testId
        && log.details?.via === "kill_switch" && log.details?.runId === one.runId)).toBe(true);
    }
  });

  describe("while it is engaged", () => {
    it("a running scan's Stop still reaches the engine", async () => {
      engine.calls.length = 0;
      const stop = await admin.post(`/api/scans/${running[0].testId}/abort`);
      expect(stop.status).toBe(200);
      expect(engine.calls).toContain(`POST /api/scans/${running[0].runId}/abort`);
    });

    it("the Stop is reached by any spelling Express routes to it", async () => {
      const stop = await admin.post(`/API/Scans/${running[1].testId}/ABORT/`);
      expect(stop.status).toBe(200);
    });

    for (const action of ["pause", "stand_down", "terminate"]) {
      it(`a failsafe ${action} can still be drafted`, async () => {
        const draft = await admin.post("/api/failsafe/commands").send({ action, engineId: "athena-1", reason: "r" });
        expect(draft.status).toBe(201);
        expect(draft.body.command.action).toBe(action);
      });
    }

    for (const action of ["resume", "release"]) {
      it(`a failsafe ${action} cannot be drafted`, async () => {
        cp.calls.length = 0;
        const draft = await admin.post("/api/failsafe/commands").send({ action, engineId: "athena-1", reason: "r" });
        expect(draft.status).toBe(503);
        expect(draft.body.message).toMatch(/kill switch is engaged/);
        expect(cp.calls.filter((one) => one.startsWith("POST"))).toEqual([]);
      });
    }

    it("a stop's signature can still be relayed", async () => {
      for (const uuid of ["standdown-1", "terminate-1", "pause-1"]) {
        const sig = await admin.post(`/api/failsafe/commands/${uuid}/signatures`).send({ keyId: "bob", sig: "abcd" });
        expect(sig.status, uuid).toBe(200);
      }
    });

    it("a resume's or a release's signature is not relayed", async () => {
      for (const uuid of ["resume-1", "release-1"]) {
        cp.calls.length = 0;
        const sig = await admin.post(`/api/failsafe/commands/${uuid}/signatures`).send({ keyId: "bob", sig: "abcd" });
        expect(sig.status, uuid).toBe(503);
        expect(cp.calls.some((one) => one.includes("/signatures/")), uuid).toBe(false);
      }
    });

    it("a signature whose command cannot be read is relayed: it might be a stop's", async () => {
      cp.calls.length = 0;
      const sig = await admin.post("/api/failsafe/commands/unreadable-1/signatures").send({ keyId: "bob", sig: "abcd" });
      expect(sig.status).toBe(200);
      expect(cp.calls).toContain("POST /api/failsafe/commands/unreadable-1/signatures/");
    });

    it("a resume or a release can be withdrawn; a stop, or a command that cannot be read, cannot", async () => {
      expect((await admin.post("/api/failsafe/commands/resume-1/cancel").send({})).status).toBe(200);
      expect((await admin.post("/api/failsafe/commands/release-1/cancel").send({})).status).toBe(200);
      expect((await admin.post("/api/failsafe/commands/standdown-1/cancel").send({})).status).toBe(503);
      expect((await admin.post("/api/failsafe/commands/unreadable-1/cancel").send({})).status).toBe(503);
    });

    it("an API key can still be revoked, but not minted", async () => {
      const { storage } = await import("../server/storage-unified");
      const { key } = await storage.createApiKey({ name: "leaked", createdBy: null });
      expect((await admin.delete(`/api/api-keys/${key.id}`)).status).toBe(200);
      expect((await admin.post("/api/api-keys").send({ name: "new" })).status).toBe(503);
    });

    it("an ordinary write, or a new scan, is still refused", async () => {
      expect((await admin.post("/api/clients").send({ name: "N", company: "N", email: "n@n.test" })).status).toBe(503);
      const clientId = (await admin.get("/api/clients")).body[0].id;
      expect((await admin.post("/api/scans").send({ clientId, target: "https://acme.example/" })).status).toBe(503);
    });
  });
});

describe("a stop the engine refused, or could not be reached for, is reported -- not hidden", () => {
  const engine = stubEngine();
  const cp = stubControlPlane();
  let admin: Agent;

  beforeAll(async () => {
    ({ admin } = await bootWith(await listen(engine.server), await listen(cp.server)));
  });
  afterAll(() => close(engine.server, cp.server));

  it("each scan's own outcome, in the engine's or the network's words", async () => {
    const clientId = await engagement(admin, "Mixed");
    const accepted = await startScan(admin, clientId);
    const refused = await startScan(admin, clientId);
    const unreachable = await startScan(admin, clientId);
    engine.refuse.add(refused.runId);
    engine.drop.add(unreachable.runId);

    const kill = await admin.patch("/api/ai-control").send(KILL);
    expect(kill.status).toBe(200);
    expect(kill.body.killSwitchEnabled).toBe(true);
    const byTest = new Map((kill.body.stops.scans as any[]).map((one) => [one.testId, one]));
    expect(byTest.size).toBe(3);
    expect(byTest.get(accepted.testId)).toMatchObject({ stopped: true, detail: "" });
    expect(byTest.get(refused.testId)).toMatchObject({ stopped: false });
    expect(byTest.get(refused.testId).detail).toMatch(/did not accept the stop/);
    expect(byTest.get(unreachable.testId)).toMatchObject({ stopped: false });
    expect(byTest.get(unreachable.testId).detail).toMatch(/could not reach the engine/);

    const logs = (await admin.get("/api/logs")).body as Log[];
    expect(logs.some((l) => l.action === "aborted" && l.entityId === accepted.testId)).toBe(true);
    expect(logs.some((l) => l.action === "abort_failed" && l.entityId === refused.testId
      && /did not accept/.test(l.details?.detail))).toBe(true);
    expect(logs.some((l) => l.action === "abort_failed" && l.entityId === unreachable.testId)).toBe(true);
    const switchLog = logs.find((l) => l.entityType === "ai_control");
    expect(switchLog?.details?.stops).toEqual({ sent: 3, accepted: 1 });
  });

  it("sending the switch on again sends the stops again, so the ones that failed can be retried", async () => {
    engine.refuse.clear();
    engine.drop.clear();
    engine.calls.length = 0;
    const again = await admin.patch("/api/ai-control").send(KILL);
    expect(again.status).toBe(200);
    expect((again.body.stops.scans as any[]).every((one) => one.stopped)).toBe(true);
    expect(engine.calls.filter((one) => one.endsWith("/abort"))).toHaveLength(3);
  });

  it("turning it off sends no stop, and writes work again", async () => {
    engine.calls.length = 0;
    const off = await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
    expect(off.status).toBe(200);
    expect(off.body.stops).toBeUndefined();
    expect(engine.calls.filter((one) => one.endsWith("/abort"))).toEqual([]);
    expect((await admin.post("/api/clients").send({ name: "After", company: "A", email: "a@a.test" })).status).toBe(201);
  });
});

describe("no failed read stands between an operator and a stop", () => {
  const engine = stubEngine();
  const cp = stubControlPlane();
  let admin: Agent;
  let scan: { testId: string; runId: string };

  beforeAll(async () => {
    ({ admin } = await bootWith(await listen(engine.server), await listen(cp.server)));
    scan = await startScan(admin, await engagement(admin, "Reads"));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => close(engine.server, cp.server));

  it("when the running scans cannot be listed, the switch is engaged and the page is told so -- not that none ran", async () => {
    const { storage } = await import("../server/storage-unified");
    vi.spyOn(storage, "getAllTests").mockRejectedValueOnce(new Error("database is locked"));
    const kill = await admin.patch("/api/ai-control").send(KILL);
    expect(kill.status).toBe(200);
    expect(kill.body.killSwitchEnabled).toBe(true);
    expect(kill.body.stops).toEqual({ listed: false, detail: "database is locked" });
  });

  it("when the kill switch setting cannot be read, a stop still goes through, and an ordinary write does not", async () => {
    const { storage } = await import("../server/storage-unified");
    vi.spyOn(storage, "getAIControlSettings").mockRejectedValue(new Error("database is locked"));
    expect((await admin.post(`/api/scans/${scan.testId}/abort`)).status).toBe(200);
    expect((await admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "athena-1" })).status).toBe(201);
    expect((await admin.post("/api/failsafe/commands/standdown-9/signatures").send({ keyId: "b", sig: "ab" })).status).toBe(200);
    expect((await admin.post("/api/clients").send({ name: "N", company: "N", email: "n@n.test" })).status).toBe(500);
  });
});
