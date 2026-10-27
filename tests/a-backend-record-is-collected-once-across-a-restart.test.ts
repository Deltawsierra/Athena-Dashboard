import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import request from "supertest";

import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";
import { signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";
import { noteDatabase, releaseAndRemove } from "./helpers/databases-in-use";

/** The temporary directories this file made, each removed when the file is done -- passed or failed. Only these. */
const madeDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(prefix);
  madeDirs.push(dir);
  return dir;
}
afterAll(async () => {
  // Every database this file loaded is closed first (the server's connection and the checkpointer thread's connection hold
  // the files open, and Windows will not remove an open file), then the directories are removed.
  await releaseAndRemove(madeDirs);
});

/**
 * A hybrid scan's backend record is never lost because the dashboard restarted,
 * and never filed twice because two dashboards share a database.
 *
 * When the live poll first sees a run finished, the dashboard starts a collect
 * watch (server/collect-watch.ts): a row in storage, resumed by a dashboard
 * starting up, that asks Athena-Backend to collect the run -- as a PERSON,
 * never the service account -- until the record stands. Ending a watch is one
 * storage step that succeeds only while it is still running, so of two
 * dashboards that have the record, one files it. A resumed watch holds no
 * person until someone reads the scan on that dashboard, and says so.
 *
 * Driven on both backends: memory (two app instances on the one in-memory
 * store) and SQLite (app instances on one database file, each with its own
 * modules and connection, as two processes would be).
 */

const TOKEN = "f".repeat(64);
const RESULTS = [{ type: "sql_injection", severity: "high", url: "https://acme.example/login", message: "a quoted parameter reached the query", details: null }];
const COVERAGE = { complete: true, checks: [{ check: "sql_injection", team: "web", state: "performed" }], not_performed: [], degraded: [], unmeasured: [], limitations: {}, notes: [] };

type Run = { state: string; result: Record<string, unknown> | null };

function stubEngine() {
  const runs = new Map<string, Run>();
  let next = 0;
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = req.url ?? "";
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") {
        return json(res, 200, { active: Array.from(runs).filter(([, run]) => run.state === "running").map(([run_id]) => ({ run_id, target: "", kind: "scan", state: "running" })) });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        const run = runs.get(abort[1]);
        if (run && run.state === "running") Object.assign(run, { state: "aborted", result: { results: [], detail: "aborted by operator" } });
        return json(res, 200, { run_id: abort[1], state: "aborting" });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = decodeURIComponent(url.slice("/api/scans/".length));
        const run = runs.get(id);
        if (!run) return json(res, 404, { detail: "No such scan run" });
        return json(res, 200, { run_id: id, state: run.state, done: run.state !== "running", result: run.result ?? {} });
      }
      if (req.method === "POST" && url === "/api/scan") {
        next += 1;
        const id = `run-${next}`;
        runs.set(id, { state: "running", result: null });
        return json(res, 202, { run_id: id, state: "running" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  return {
    server, runs,
    finish(id: string, end: { state: string; result: Record<string, unknown> }): void {
      runs.set(id, { state: end.state, result: end.result });
    },
  };
}

let engine: ReturnType<typeof stubEngine>;
let hybrid: HybridBackendStandIn;

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  const engineUrl = `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_URL = engineUrl;
  process.env.ATHENA_ENGINE_KEY = "dashboard-key";
  hybrid = await hybridBackendStandIn({ engine: { url: engineUrl, key: "backend-key" }, serviceToken: TOKEN });
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = TOKEN;
});
afterAll(async () => {
  for (const name of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_SERVICE_TOKEN"]) delete process.env[name];
  process.env.ATHENA_STORAGE = "memory";
  delete process.env.ATHENA_DB_PATH;
  await hybrid.close();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
});

type Instance = {
  app: Express;
  agent: ReturnType<typeof request.agent>;
  watcher: import("../server/collect-watch").CollectWatcher;
  storage: import("../server/storage").IStorage;
};

/**
 * One dashboard, its admin signed in here and at the backend. `fresh` loads its
 * modules anew -- a new process, on SQLite a new connection to the same file.
 * Without it, a second app on the modules already loaded: another dashboard on
 * the same in-memory store.
 */
async function boot(fresh: boolean): Promise<Instance> {
  if (fresh) vi.resetModules();
  await noteDatabase();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  const app = createApp();
  await initializeDefaultData();
  await adminHasSetPassword();
  const agent = request.agent(app);
  const login = await agent.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  await signInToBackend(agent);
  (await import("../server/collect-watch")).collectWatch.intervalMs = 25;
  return {
    app, agent,
    watcher: app.locals.collectWatcher,
    storage: (await import("../server/storage-unified")).storage,
  };
}

/** `read()` once `ok` holds, asked up to `tries` times, a short pause apart. */
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, tries = 200): Promise<T> {
  let last = await read();
  for (let i = 0; i < tries && !ok(last); i++) {
    await new Promise((r) => setTimeout(r, 20));
    last = await read();
  }
  return last;
}

let n = 0;
/** A scan started through the backend on `first`, whose run has ended on the engine; not read since. */
async function aFinishedHybridScan(first: Instance) {
  n += 1;
  const client = await first.agent.post("/api/clients").send({ name: `Restart ${n}`, company: "R", email: `r${n}@r.test` });
  await first.agent.post("/api/sites").send({ clientId: client.body.id, name: "Main", url: "https://acme.example" });
  const started = await first.agent.post("/api/scans").send({ clientId: client.body.id, target: "https://acme.example/", consent: true });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const runId = started.body.runId as string;
  engine.finish(runId, { state: "completed", result: { results: RESULTS, coverage: COVERAGE } });
  return { clientId: client.body.id as string, testId: started.body.test.id as string, runId, scanId: started.body.test.findings.backendScanId as string };
}

const collectsOf = (scanId: string) => hybrid.collects().filter((one) => one.path === `/api/pentest/scans/${scanId}/collect/`);

const collectedLogs = async (instance: Instance, scanId: string) =>
  (await instance.agent.get("/api/logs")).body.filter((one: { action: string; details: { backendScanId?: string } }) =>
    one.action === "backend_record_collected" && one.details.backendScanId === scanId);

const BACKENDS = [
  { name: "memory", setUp: () => { process.env.ATHENA_STORAGE = "memory"; delete process.env.ATHENA_DB_PATH; }, restartLoadsAnew: false },
  {
    name: "SQLite",
    setUp: () => {
      process.env.ATHENA_STORAGE = "sqlite";
      process.env.ATHENA_DB_PATH = path.join(tempDir(path.join(os.tmpdir(), "athena-collect-watch-")), "athena.db");
    },
    restartLoadsAnew: true,
  },
] as const;

for (const backend of BACKENDS) {
  describe(`${backend.name}: a collect watch outlives the dashboard that started it`, () => {
    beforeEach(() => {
      backend.setUp();
      hybrid.seen.length = 0;
      hybrid.releaseCollects();
    });

    it("restarted mid-collect, the next dashboard resumes the watch, asks as nobody until a person reads the scan, and files the record exactly once", async () => {
      const first = await boot(true);
      const { testId, runId, scanId } = await aFinishedHybridScan(first);
      hybrid.holdCollects();

      // The first finished read starts the watch: on the record before anything else, its collect in flight.
      const finished = await first.agent.get(`/api/scans/${testId}`);
      expect(finished.body.backend).toMatchObject({ collected: false, watch: "running", status: "pending", verdict: null });
      const recorded = await until(() => first.storage.getCollectWatch(scanId), (row) => row !== undefined);
      expect(recorded).toMatchObject({ testId, engineRunId: runId, state: "running" });
      await hybrid.waitFor((one) => one.method === "POST" && one.path === `/api/pentest/scans/${scanId}/collect/`);

      // The dashboard goes away with the collect unanswered.
      first.watcher.halt();
      const second = await boot(backend.restartLoadsAnew);

      // Resumed, with nobody to ask as: said so on the record, and nothing is sent for it.
      const waiting = await until(() => second.storage.getCollectWatch(scanId), (row) => row?.lastAnswer === "sign_in_required");
      expect(waiting).toMatchObject({ state: "running", lastAnswer: "sign_in_required" });
      expect(waiting!.lastReadError).toContain("no signed-in session");
      expect(collectsOf(scanId)).toHaveLength(1);

      // The backend answers the first dashboard's collect -- to a dashboard that has gone: it files nothing.
      hybrid.releaseCollects();
      await until(() => Promise.resolve(collectsOf(scanId)[0].status), (status) => status === 200);
      await new Promise((r) => setTimeout(r, 100));
      expect((await second.storage.getTest(testId))!.findings).not.toHaveProperty("backend");

      // A person reads the scan on the new dashboard: the watch asks as them, the record stands (409), is read, and is filed once.
      const lent = await second.agent.get(`/api/scans/${testId}`);
      expect(lent.status).toBe(200);
      const ended = await until(() => second.storage.getCollectWatch(scanId), (row) => row?.state !== "running");
      expect(ended).toMatchObject({ state: "collected", lastAnswer: "conflict" });
      expect(collectsOf(scanId).map((one) => [one.account, one.by, one.status])).toEqual([["admin", "bearer", 200], ["admin", "bearer", 409]]);
      const row = await second.storage.getTest(testId);
      expect(row!.findings).toMatchObject({ backendScanId: scanId, backend: { status: "completed", verdict: hybrid.scans.get(scanId)!.verdict } });
      expect(JSON.stringify((row!.findings as { results: unknown }).results)).toBe(JSON.stringify(RESULTS));
      const answered = await second.agent.get(`/api/scans/${testId}`);
      expect(answered.body.backend).toMatchObject({ collected: true, status: "completed", engineRunId: runId });
      expect(await collectedLogs(second, scanId)).toHaveLength(1);

      // The watch is over: nothing is asked or filed again.
      await new Promise((r) => setTimeout(r, 150));
      expect(collectsOf(scanId)).toHaveLength(2);
      expect(await collectedLogs(second, scanId)).toHaveLength(1);
      second.watcher.halt();
    });

    it("two dashboards on one store both watch it, and the record is filed once, never twice", async () => {
      const first = await boot(true);
      const { testId, scanId } = await aFinishedHybridScan(first);
      hybrid.holdCollects();
      expect((await first.agent.get(`/api/scans/${testId}`)).body.backend.watch).toBe("running");
      await until(() => first.storage.getCollectWatch(scanId), (row) => row !== undefined);

      // The second dashboard resumes the same watch; a person's read lends it their sign-in; both collects are held.
      const second = await boot(backend.restartLoadsAnew);
      await until(() => second.agent.get(`/api/scans/${testId}`).then((res) => res.body.backend.watch), (watch) => watch === "running");
      await until(() => Promise.resolve(collectsOf(scanId).length), (count) => count === 2);
      expect(collectsOf(scanId).map((one) => one.status)).toEqual([0, 0]);

      hybrid.releaseCollects();
      const ended = await until(() => second.storage.getCollectWatch(scanId), (row) => row?.state !== "running");
      expect(ended!.state).toBe("collected");
      await new Promise((r) => setTimeout(r, 150));
      // One collected the record (200); the other was told it was claimed, then that it stands (409), and read it; one filed it.
      const statuses = collectsOf(scanId).map((one) => one.status);
      expect(statuses.filter((one) => one === 200)).toHaveLength(1);
      expect(statuses.filter((one) => one === 409).length).toBeGreaterThanOrEqual(1);
      expect(statuses.every((one) => one === 200 || one === 409), statuses.join(",")).toBe(true);
      expect((await second.storage.getTest(testId))!.findings).toMatchObject({ backend: { status: "completed" } });
      expect(await collectedLogs(second, scanId)).toHaveLength(1);
      first.watcher.halt();
      second.watcher.halt();
    });
  });
}
