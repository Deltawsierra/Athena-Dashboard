import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import type { Express } from "express";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

/**
 * A retest verdict is never lost because the dashboard restarted, and never
 * filed twice because two dashboards share a database.
 *
 * A retest the engine answered 202 for is watched until it ends
 * (server/retests.ts), and each watch is a row in the dashboard's storage. A
 * dashboard starting up resumes every watch still running, in the background.
 * Ending a watch and filing its verdict are one storage step that succeeds only
 * while the watch is still running, and a unique index allows one check per
 * engine run -- so of two dashboards that collect the same verdict, one files
 * it. Neither the resume nor the watch stands in front of a stop.
 *
 * Driven on both backends: memory (two app instances on the one in-memory
 * store) and SQLite (app instances on one database file, each with its own
 * modules and connection, as two processes would be). The engine answers from
 * tests/fixtures/engine-retest, recorded from athena-engine at 143279e.
 */

type Exchange = { request: { method: string; path: string }; status: number; body: any; headers?: Record<string, string> };
type Fixture = { exchanges: Exchange[] };
const load = (name: string): Fixture =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "fixtures", "engine-retest", "pr71-143279e", `${name}.json`), "utf8"));
const pick = (fx: Fixture, method: string, test: (p: string) => boolean) =>
  fx.exchanges.filter((one) => one.request.method === method && test(one.request.path));
const retestOf = (fx: Fixture) => pick(fx, "POST", (p) => p === "/api/remediation/retest")[0];
const statusReadsOf = (fx: Fixture) => pick(fx, "GET", (p) => /^\/api\/scans\/[^/]+$/.test(p) && p !== "/api/scans/active");
const abortOf = (fx: Fixture) => pick(fx, "POST", (p) => /\/abort$/.test(p))[0];

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const state: { fixture: Fixture | null; statusReads: Exchange[]; hold: Promise<void> | null; abort: Exchange | null } =
  { fixture: null, statusReads: [], hold: null, abort: null };
const calls: Array<{ line: string; at: number }> = [];
let engine: Server;

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", async () => {
      const url = req.url ?? "";
      calls.push({ line: `${req.method} ${url}`, at: performance.now() });
      const fx = state.fixture;
      const reply = (one: Exchange) => json(res, one.status, one.body);
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") return json(res, 200, { active: [] });
      if (!fx) return json(res, 500, { detail: "no fixture" });
      if (req.method === "POST" && url === "/api/scan") return reply(fx.exchanges[0]);
      if (req.method === "GET" && url.startsWith("/api/decisions?")) return reply(fx.exchanges[1]);
      if (req.method === "POST" && url === "/api/remediation/retest") return reply(retestOf(fx));
      if (req.method === "POST" && url.endsWith("/abort")) return state.abort ? reply(state.abort) : json(res, 404, {});
      if (req.method === "GET" && /^\/api\/scans\/[^/]+$/.test(url)) {
        if (state.hold) await state.hold;
        const next = state.statusReads.length > 1 ? state.statusReads.shift()! : state.statusReads[0];
        return next ? reply(next) : json(res, 404, { detail: "No such scan run" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  process.env.ATHENA_STORAGE = "memory";
  delete process.env.ATHENA_DB_PATH;
  engine.closeAllConnections?.();
  await new Promise<void>((r) => engine.close(() => r()));
});

type Instance = {
  app: Express;
  agent: ReturnType<typeof request.agent>;
  watcher: import("../server/retests").RetestWatcher;
  storage: import("../server/storage").IStorage;
  retests: typeof import("../server/retests");
};

/**
 * One dashboard. `fresh` loads its modules anew -- a new process, on SQLite a
 * new connection to the same file. Without it, a second app on the modules
 * already loaded: another dashboard on the same in-memory store.
 */
async function boot(fresh: boolean): Promise<Instance> {
  if (fresh) vi.resetModules();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  const app = createApp();
  await initializeDefaultData();
  const agent = request.agent(app);
  const login = await agent.post("/api/auth/login").send({ username: "admin", password: "admin123" });
  expect(login.status).toBe(200);
  const retests = await import("../server/retests");
  retests.retestWatch.intervalMs = 25;
  return {
    app, agent, retests,
    watcher: app.locals.retestWatcher,
    storage: (await import("../server/storage-unified")).storage,
  };
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 4_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    last = await read();
  }
  return last;
}

let n = 0;
/** A scanned test, then Retest pressed: the engine answers 202 and the first dashboard starts watching. */
async function aRetestAnswered202(first: Instance, fx: Fixture) {
  state.fixture = fx;
  n += 1;
  const client = await first.agent.post("/api/clients").send({ name: `Restart ${n}`, company: "R", email: `r${n}@r.test` });
  const site = await first.agent.post("/api/sites").send({ clientId: client.body.id, name: "Main", url: "https://offline.invalid" });
  const started = await first.agent.post("/api/scans")
    .send({ clientId: client.body.id, siteId: site.body.id, target: fx.exchanges[0].body.target });
  expect(started.status).toBe(201);
  const twinId = fx.exchanges[1].body.decisions[0].id as number;
  const res = await first.agent.post(`/api/tests/${started.body.test.id}/retest`).send({ twinId });
  expect(res.status).toBe(202);
  const me = await first.agent.get("/api/auth/check");
  return { clientId: client.body.id as string, testId: started.body.test.id as string, runId: res.body.engineRunId as string,
    requester: me.body.user?.id as string };
}

/** The finding's checks, read from the shared store. */
async function checksOfClient(instance: Instance, clientId: string) {
  const findings = await instance.storage.getFindingsByClient(clientId);
  expect(findings).toHaveLength(1);
  return { finding: findings[0], checks: await instance.storage.getChecks(findings[0].id) };
}

const BACKENDS = [
  { name: "memory", setUp: () => { process.env.ATHENA_STORAGE = "memory"; delete process.env.ATHENA_DB_PATH; }, restartLoadsAnew: false },
  {
    name: "SQLite",
    setUp: () => {
      process.env.ATHENA_STORAGE = "sqlite";
      process.env.ATHENA_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "athena-retest-watch-")), "athena.db");
    },
    restartLoadsAnew: true,
  },
] as const;

for (const backend of BACKENDS) {
  describe(`${backend.name}: a retest watch outlives the dashboard that started it`, () => {
    // A new store for every case: the fixtures' run ids repeat across cases,
    // which a real engine's never do.
    beforeEach(() => {
      backend.setUp();
      state.fixture = null;
      state.abort = null;
    });

    it("restarted mid-retest, the next dashboard resumes the watch and files the verdict exactly once, as the requester's", async () => {
      const fx = load("running-then-verdict");
      const [running, finished] = statusReadsOf(fx);
      let release!: () => void;
      state.hold = new Promise<void>((r) => { release = r; });
      state.statusReads = [running];
      const first = await boot(true);
      const { clientId, testId, runId, requester } = await aRetestAnswered202(first, fx);

      // On the record before anything else happens.
      const recorded = await first.storage.getRetestWatch(runId);
      expect(recorded).toMatchObject({ engineRunId: runId, testId, clientId, state: "running", requestedBy: requester });
      await until(() => first.storage.getRetestWatch(runId), (row) => row?.findingId != null);

      // The dashboard goes away with the retest still running.
      first.watcher.halt();
      state.statusReads = [finished];
      const second = await boot(backend.restartLoadsAnew);
      release();
      state.hold = null;

      const ended = await until(() => second.storage.getRetestWatch(runId), (row) => row?.state !== "running");
      expect(ended!.state).toBe("verdict");
      const { finding, checks } = await checksOfClient(second, clientId);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({
        verdict: "closed",
        runId: String(finished.body.result.scan_record_id),
        engineRunId: runId,
        checkedBy: requester,
        filedVia: "retest_watch",
      });
      expect(new Date(checks[0].requestedAt!).getTime()).toBe(new Date(recorded!.startedAt).getTime());
      expect(finding).toMatchObject({ status: "fixed", statusChangedBy: requester });
      expect(finding.statusNote).toMatch(/Filed by the dashboard when the engine finished the retest requested at /);
      // Logged as collected on the requester's behalf, never as their act now.
      const logs = await second.agent.get("/api/logs");
      const collected = logs.body.filter((one: { action: string; details: { engineRunId?: string } }) =>
        one.action === "retest_collected" && one.details.engineRunId === runId);
      expect(collected).toHaveLength(1);
      expect(collected[0].details).toMatchObject({ filedBy: "retest_watch", requestedBy: requester, verdict: "closed" });

      // The watch is over: nothing is read or filed again.
      await new Promise((r) => setTimeout(r, 150));
      expect((await checksOfClient(second, clientId)).checks).toHaveLength(1);
      second.watcher.halt();
    });

    it("two dashboards on one store both watch it, and the verdict is filed once, never twice", async () => {
      const fx = load("running-then-verdict");
      const [running, finished] = statusReadsOf(fx);
      let release!: () => void;
      state.hold = new Promise<void>((r) => { release = r; });
      state.statusReads = [running];
      const first = await boot(true);
      const { clientId, runId } = await aRetestAnswered202(first, fx);
      // A second dashboard on the same record resumes the same watch.
      const second = await boot(backend.restartLoadsAnew);
      await until(async () => calls.filter((one) => one.line === `GET /api/scans/${runId}`).length, (count) => count >= 2);
      state.statusReads = [finished];
      release();
      state.hold = null;

      await until(() => first.storage.getRetestWatch(runId), (row) => row?.state === "verdict");
      await new Promise((r) => setTimeout(r, 200));
      // Both collected it; one filed it.
      const { checks } = await checksOfClient(second, clientId);
      expect(checks).toHaveLength(1);
      const logs = await first.agent.get("/api/logs");
      expect(logs.body.filter((one: { action: string; details: { engineRunId?: string } }) =>
        one.action === "retest_collected" && one.details.engineRunId === runId)).toHaveLength(1);
      first.watcher.halt();
      second.watcher.halt();
    });

    it("resuming never delays a stop: with the resumed read held open, the Stop reaches the engine at once", async () => {
      const fx = load("running-then-stopped");
      state.statusReads = [statusReadsOf(load("running-then-verdict"))[0]];
      let release!: () => void;
      state.hold = new Promise<void>((r) => { release = r; });
      const first = await boot(true);
      const { runId } = await aRetestAnswered202(first, fx);
      first.watcher.halt();
      calls.length = 0;

      const second = await boot(backend.restartLoadsAnew);
      // The resumed watch's read is in flight, and held.
      await until(async () => calls.some((one) => one.line === `GET /api/scans/${runId}`), (seen) => seen);
      state.abort = abortOf(fx);
      const pressed = performance.now();
      const stop = await second.agent.post(`/api/retests/${runId}/abort`);
      const answered = performance.now();
      const reached = calls.find((one) => one.line === `POST /api/scans/${runId}/abort`);
      expect(stop.status).toBe(200);
      expect(reached!.at - pressed).toBeLessThan(250);
      expect(answered - pressed).toBeLessThan(500);
      release();
      state.hold = null;
      second.watcher.halt();
    });

    it("a watch past its hour while the dashboard was down is resumed as no longer watched, and still stopped by the kill switch", async () => {
      const fx = load("running-then-verdict");
      state.statusReads = [statusReadsOf(fx)[0]];
      const first = await boot(true);
      first.retests.retestWatch.totalMs = 150;
      try {
        const { runId } = await aRetestAnswered202(first, fx);
        first.watcher.halt();
        await new Promise((r) => setTimeout(r, 250));
        const second = await boot(backend.restartLoadsAnew);
        second.retests.retestWatch.totalMs = 150;
        const view = await until(() => second.agent.get(`/api/retests/${runId}`).then((r) => r.body), (body) => body.phase !== "running");
        expect(view).toMatchObject({ phase: "unwatched", stoppable: true });
        expect(view.detail).toMatch(/stopped waiting for the retest before the engine finished it/);

        state.abort = abortOf(load("running-then-stopped"));
        calls.length = 0;
        const engaged = await second.agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
        try {
          expect(calls.map((one) => one.line)).toContain(`POST /api/scans/${runId}/abort`);
        } finally {
          await second.agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "operational" });
        }
        expect(engaged.status).toBe(200);
        second.watcher.halt();
      } finally {
        first.retests.retestWatch.totalMs = 60 * 60_000;
      }
    });
  });
}

/**
 * The two guards that keep a verdict to one filing, each held on its own and
 * on both backends: ending a watch is a claim that succeeds once, and one
 * engine run has at most one check.
 */
for (const backend of BACKENDS) {
  describe(`${backend.name}: one retest, one filing`, () => {
    beforeEach(() => backend.setUp());

    async function aStore() {
      vi.resetModules();
      const storage = (await import("../server/storage-unified")).storage;
      const { DuplicateRetestCheck } = await import("../server/storage");
      const client = await storage.createClient({ name: "Guard", company: "Guard", email: "g@g.test" });
      const finding = await storage.createFinding({
        clientId: client.id, engagementRef: client.id, fingerprint: "guard", type: "xss", severity: "high", message: "m", target: "https://offline.invalid/",
        endpoint: null, header: null,
      } as never);
      const now = new Date();
      const watch = {
        engineRunId: "run-guard", testId: "t", clientId: client.id, twinId: 1, findingId: finding.id, engagementRef: null,
        requestedBy: "u1", requestedFrom: null, startedAt: now, deadlineAt: new Date(now.getTime() + 60_000), state: "running",
        engineState: "running", reason: null, error: null, lastReadAt: null, lastReadError: null, stopAcceptedAt: null,
        endedAt: null, result: null,
      };
      await storage.createRetestWatch(watch);
      const check = {
        findingId: finding.id, verdict: "closed", detail: "d", runId: "7", inventoryDigest: null, checkedBy: "u1",
        engineRunId: "run-guard", filedVia: "retest_watch", requestedAt: now,
      };
      const end = { state: "verdict", engineState: "completed", reason: null, error: null, endedAt: new Date(), result: null };
      return { storage, finding, check, end, DuplicateRetestCheck };
    }

    it("a watch is ended, and its verdict filed, by the first claim only", async () => {
      const { storage, finding, check, end } = await aStore();
      const filing = { findingId: finding.id, findingPatch: { status: "fixed" }, check };
      expect(await storage.endRetestWatch("run-guard", end, filing)).toBe(true);
      expect(await storage.endRetestWatch("run-guard", end, { ...filing, check: { ...check, engineRunId: "run-other" } })).toBe(false);
      expect(await storage.getChecks(finding.id)).toHaveLength(1);
      expect((await storage.getRetestWatch("run-guard"))!.state).toBe("verdict");
      expect(await storage.updateRunningRetestWatch("run-guard", { lastReadError: "late" })).toBe(false);
    });

    it("a second check for one engine run is refused", async () => {
      const { storage, finding, check, DuplicateRetestCheck } = await aStore();
      await storage.recordCheck(check);
      let refused: unknown = null;
      try {
        await storage.recordCheck(check);
      } catch (cause) {
        refused = cause;
      }
      expect(refused).not.toBeNull();
      if (backend.name === "memory") expect(refused).toBeInstanceOf(DuplicateRetestCheck);
      else expect(String(refused)).toMatch(/UNIQUE/);
      expect(await storage.getChecks(finding.id)).toHaveLength(1);
      // Checks from engines that give no run id are never held to it.
      await storage.recordCheck({ ...check, engineRunId: null });
      await storage.recordCheck({ ...check, engineRunId: null });
      expect(await storage.getChecks(finding.id)).toHaveLength(3);
    });
  });
}
