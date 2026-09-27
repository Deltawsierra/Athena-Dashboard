import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import request from "supertest";
import Database from "better-sqlite3";
import type { AddressInfo } from "net";
import { PerformanceObserver } from "perf_hooks";

/** The temporary directories this file made, each removed when the file is done -- passed or failed. Only these. */
const madeDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(prefix);
  madeDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of madeDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * SAFETY, round four of PR #56 (the round-three review's findings), on the
 * real SQLite backend on a file, with the write lock held by a second
 * connection -- a backup, the sqlite3 shell, another dashboard mid-transaction:
 *
 *   - No statement on the event loop waits on the lock. A burst of writes
 *     started in one turn of the loop -- 200, or 1000 -- together with a Stop
 *     in that same turn: the loop is held at most 50 ms in all, the Stop
 *     reaches the engine within 100 ms, and every write goes in once the lock
 *     is let go. The kill switch's records over 100 runs, met by a lock taken
 *     after its flag was stored, hold the loop no longer.
 *   - The kill switch sends its stop to another dashboard's scan, recorded
 *     only on the shared database, as soon as the database is read -- never
 *     after waiting for the engine's list to fail.
 *   - An admin deleted or demoted by another process on the shared database
 *     gains nothing but stops here: a resume's signature is refused and never
 *     relayed, another admin's key is not revoked; a pause's signature, and
 *     its own key, still go.
 *
 * The stand-in engine runs in a process of its own (tests/helpers/
 * engine-in-its-own-process.cjs), so it times each request's arrival
 * whatever this process's event loop is doing.
 */

const calls: Array<{ line: string; at: number }> = [];
let child: ChildProcess;
let port = 0;

beforeAll(async () => {
  child = spawn(process.execPath, [path.join(__dirname, "helpers", "engine-in-its-own-process.cjs")], { stdio: ["ignore", "pipe", "inherit"] });
  let buffer = "";
  await new Promise<void>((ready) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const one = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (one.port) { port = one.port; ready(); } else calls.push(one);
      }
    });
  });
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
});
afterAll(() => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  process.env.ATHENA_STORAGE = "memory";
  delete process.env.ATHENA_DB_PATH;
  child.kill();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The child's lines arrive through this process's loop: wait for them. */
async function arrived(line: string, ms = 3_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const one = calls.find((c) => c.line === line);
    if (one || Date.now() > deadline) return one;
    await sleep(10);
  }
}
const knob = (name: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/${name}`, { method: "POST", body: JSON.stringify(body) });

/** A dashboard on a fresh SQLite file, signed in, with one engine scan recorded as running. */
async function boot(runId: string) {
  process.env.ATHENA_STORAGE = "sqlite";
  const dbPath = path.join(tempDir(path.join(os.tmpdir(), "athena-r4-lock-")), "athena.db");
  process.env.ATHENA_DB_PATH = dbPath;
  vi.resetModules();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  const app = createApp();
  await initializeDefaultData();
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ username: "admin", password: "admin123" })).status).toBe(200);
  const storage = (await import("../server/storage-unified")).storage;
  const client = await storage.createClient({ name: "Locked", company: "Locked", email: "l@l.test" });
  const test = await storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "running",
    findings: { runId, target: "https://offline.invalid/", results: [] },
  });
  const watcher = app.locals.retestWatcher as import("../server/retests").RetestWatcher;
  await sleep(100);
  // Every test read into memory, as the dashboard does in the background at start-up.
  await storage.getAllTests();
  return { app, agent, watcher, dbPath, testId: test.id, clientId: client.id, storage };
}

function holdTheWriteLock(dbPath: string) {
  const lock = new Database(dbPath);
  lock.pragma("busy_timeout = 0");
  lock.exec("BEGIN IMMEDIATE");
  return () => {
    lock.exec("ROLLBACK");
    lock.close();
  };
}

/**
 * Diagnostics only (no assertion reads them): for each loop gap over 20 ms,
 * printed once the test is done -- its start and end, the CPU this process
 * used across it (all threads), the context switches it made, the GC pauses
 * overlapping it, and what the test and the app were doing (`phase`).
 */
let phase = "idle";
const gcSeen: Array<{ start: number; end: number; kind: number }> = [];
new PerformanceObserver((list) => {
  for (const one of list.getEntries()) {
    gcSeen.push({ start: one.startTime, end: one.startTime + one.duration, kind: (one as unknown as { detail?: { kind?: number } }).detail?.kind ?? -1 });
    if (gcSeen.length > 2_000) gcSeen.splice(0, 1_000);
  }
}).observe({ entryTypes: ["gc"] });
console.log(`[lag-diag] runner: ${os.availableParallelism()} cores available, loadavg ${os.loadavg().map((n) => n.toFixed(2)).join(" ")}`);

/** The longest the event loop went without running a 5 ms timer, less the 5 ms, while it runs. */
function loopLag(label = "") {
  let max = 0;
  let last = performance.now();
  const began = last;
  let cpu = process.cpuUsage();
  let ru = process.resourceUsage();
  let phaseAt = phase;
  const gaps: string[] = [];
  const timer = setInterval(() => {
    const now = performance.now();
    const cpuNow = process.cpuUsage();
    const ruNow = process.resourceUsage();
    if (now - last - 5 > 20) {
      const gcs = gcSeen.filter((g) => g.end > last && g.start < now)
        .map((g) => `kind ${g.kind} ${(g.end - g.start).toFixed(1)} ms`);
      gaps.push(`[lag-diag] ${label} gap ${(now - last - 5).toFixed(1)} ms, from ${(last - began).toFixed(1)} to ${(now - began).toFixed(1)} ms; ` +
        `cpu ${((cpuNow.user - cpu.user + cpuNow.system - cpu.system) / 1000).toFixed(1)} ms (user ${((cpuNow.user - cpu.user) / 1000).toFixed(1)}, sys ${((cpuNow.system - cpu.system) / 1000).toFixed(1)}); ` +
        `ctx switches voluntary ${ruNow.voluntaryContextSwitches - ru.voluntaryContextSwitches}, involuntary ${ruNow.involuntaryContextSwitches - ru.involuntaryContextSwitches}; ` +
        `gc [${gcs.join(", ") || "none"}]; phase ${phaseAt} -> ${phase}`);
    }
    max = Math.max(max, now - last - 5);
    last = now;
    cpu = cpuNow;
    ru = ruNow;
    phaseAt = phase;
  }, 5);
  return {
    max: () => max,
    stop: () => {
      clearInterval(timer);
      for (const one of gaps.splice(0)) console.log(one);
    },
  };
}

describe("a burst of writes started in one turn of the loop, under a held lock", () => {
  for (const n of [200, 1000]) {
    it(`${n} writes and a Stop started in the same turn: the loop is held at most 50 ms, the Stop reaches the engine within 100 ms, and every write goes in once`, async () => {
      const { agent, watcher, dbPath, testId, storage } = await boot(`burst-${n}`);
      const release = holdTheWriteLock(dbPath);
      const lag = loopLag(`${n}w`);
      let released = false;
      const pending: Array<Promise<true | Error>> = [];
      let done = 0;
      const where = (what: string) => { phase = `${what} (${done}/${n} writes settled)`; };
      try {
        calls.length = 0;
        const pressed = Date.now();
        const t0 = performance.now();
        where("starting the burst");
        for (let i = 0; i < n; i += 1) {
          pending.push(storage.createActivityLog({ action: `burst${n}`, entityType: "test", entityId: String(i), details: null })
            .then(() => true as const, (cause: Error) => cause).finally(() => { done += 1; }));
        }
        // The Stop, in the very turn the burst was started in.
        const stop = agent.post(`/api/scans/${testId}/abort`).then((r) => r);
        const burstHeld = performance.now() - t0;
        where("writes queued, Stop in flight");
        const reached = await arrived(`POST /api/scans/burst-${n}/abort`, 10_000);
        expect(reached).toBeDefined();
        const stopAfter = reached!.at - pressed;
        where("Stop reached the engine, awaiting its answer");
        expect((await stop).status).toBe(200);
        // A retest's Stop while the writes are still waiting.
        const retestPressed = Date.now();
        where("retest Stop in flight");
        expect((await agent.post(`/api/retests/rt-burst-${n}/abort`)).status).toBe(200);
        const retestReached = await arrived(`POST /api/scans/rt-burst-${n}/abort`, 10_000);
        const retestAfter = retestReached!.at - retestPressed;
        where("writes waiting on the lock");
        await sleep(Math.max(0, 1_000 - (Date.now() - pressed)));
        release(); released = true;
        where("lock released, writes draining");
        const settled = await Promise.all(pending);
        where("all settled");
        lag.stop();
        phase = "idle";
        console.log(`[burst] ${n} writes started in one turn: ${Math.round(burstHeld)} ms to start them; ` +
          `Stop reached the engine after ${stopAfter} ms, a retest's Stop after ${retestAfter} ms; ` +
          `longest loop lag ${Math.round(lag.max())} ms`);
        expect(burstHeld).toBeLessThanOrEqual(50);
        expect(stopAfter).toBeLessThanOrEqual(100);
        expect(retestAfter).toBeLessThanOrEqual(100);
        expect(lag.max()).toBeLessThanOrEqual(50);
        // No write lost within its 5 s: every one went in, once.
        expect(settled.filter((one) => one !== true)).toEqual([]);
        const rows = (await storage.getAllActivityLogs()).filter((one) => one.action === `burst${n}`);
        expect(rows).toHaveLength(n);
        expect(new Set(rows.map((one) => one.entityId)).size).toBe(n);
      } finally {
        lag.stop();
        if (!released) release();
        await Promise.all(pending);
        watcher.halt();
      }
    }, 60_000);
  }

  it("the kill switch over 100 runs, the lock taken after its flag was stored: its records hold the loop at most 50 ms, a Stop pressed meanwhile reaches the engine within 100 ms, and every record goes in", async () => {
    const { agent, watcher, dbPath, storage, clientId } = await boot("ks-own-run");
    for (let i = 0; i < 100; i += 1) {
      await storage.createTest({ clientId, testType: "vulnerability-scan", status: "running", findings: { runId: `ks-run-${i}`, target: "https://offline.invalid/", results: [] } });
    }
    await storage.getAllTests();
    await knob("__abortDelay", { ms: 1_500 });
    let release: (() => void) | null = null;
    let lag: ReturnType<typeof loopLag> | null = null;
    try {
      calls.length = 0;
      const pressed = Date.now();
      const kill = agent.patch("/api/ai-control").send({ killSwitchEnabled: true }).then((r) => r);
      expect(await arrived("POST /api/scans/ks-run-99/abort", 5_000)).toBeDefined();
      // The flag is stored by now; a backup takes the write lock while the engine answers the stops.
      expect((await storage.getAIControlSettings())!.killSwitchEnabled).toBe(true);
      release = holdTheWriteLock(dbPath);
      phase = "kill switch: lock held, stops awaiting the engine";
      lag = loopLag("kill100");
      // The stops are answered at ~1.5 s: every record then meets the lock, all in one turn.
      await sleep(Math.max(0, 1_700 - (Date.now() - pressed)));
      const stopPressed = Date.now();
      phase = "kill switch: records waiting, retest Stop in flight";
      expect((await agent.post("/api/retests/victim-rt/abort")).status).toBe(200);
      const reached = await arrived("POST /api/scans/victim-rt/abort", 5_000);
      const stopAfter = reached!.at - stopPressed;
      phase = "kill switch: records waiting";
      await sleep(800);
      lag.stop();
      phase = "idle";
      const held = lag.max();
      release(); release = null;
      const answer = await kill;
      console.log(`[burst] kill switch over 100 runs, records under a held lock: longest loop lag ${Math.round(held)} ms; ` +
        `a Stop pressed meanwhile reached the engine after ${stopAfter} ms; answered ${answer.status} after ${Date.now() - pressed} ms`);
      expect(held).toBeLessThanOrEqual(50);
      expect(stopAfter).toBeLessThanOrEqual(100);
      expect(answer.status).toBe(200);
      expect(answer.body.writeFailures).toBeUndefined();
      const records = (await storage.getAllActivityLogs())
        .filter((one) => (one.details as { via?: string } | null)?.via === "kill_switch");
      expect(records).toHaveLength(101);
    } finally {
      lag?.stop();
      release?.();
      await knob("__abortDelay", { ms: 0 });
      await agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
      watcher.halt();
    }
  }, 60_000);
});

describe("the kill switch and another dashboard's scan, when the engine's list does not answer", () => {
  it("the scan recorded only on the shared database is sent its stop as soon as the database is read, not after the list read gives up", async () => {
    const { agent, watcher, dbPath, testId } = await boot("mine-run-r4");
    const engineModule = await import("../server/engine");
    engineModule.engineTimeouts.callMs = 3_000;
    const other = new Database(dbPath);
    const row = other.prepare("SELECT * FROM tests LIMIT 1").get() as Record<string, unknown>;
    other.prepare("INSERT INTO tests (id, client_id, test_type, status, started_at, findings, vulnerabilities_found, critical_count, high_count, medium_count, low_count, is_sample) VALUES (?, ?, 'vulnerability-scan', 'running', ?, ?, 0,0,0,0,0,0)")
      .run("other-dash-test-r4", row.client_id, row.started_at, JSON.stringify({ runId: "other-dash-run-r4", target: "https://b.invalid/", results: [] }));
    other.close();
    await knob("__hang", { hang: true });
    calls.length = 0;
    try {
      const pressed = Date.now();
      const kill = agent.patch("/api/ai-control").send({ killSwitchEnabled: true }).then((r) => r);
      const mine = await arrived("POST /api/scans/mine-run-r4/abort", 3_000);
      const theirs = await arrived("POST /api/scans/other-dash-run-r4/abort", 3_000);
      expect(mine).toBeDefined();
      expect(theirs).toBeDefined();
      console.log(`[burst] engine list hanging: this dashboard's scan stopped after ${mine!.at - pressed} ms, ` +
        `the other dashboard's after ${theirs!.at - pressed} ms`);
      expect(mine!.at - pressed).toBeLessThan(500);
      expect(theirs!.at - pressed).toBeLessThan(500);
      const answer = await kill;
      expect(answer.status).toBe(200);
      expect(answer.body.engineRuns.listed).toBe(false);
      expect(answer.body.stops.listed).toBe(true);
      expect(answer.body.stops.scans.map((one: { testId: string }) => one.testId).sort()).toEqual([testId, "other-dash-test-r4"].sort());
      // One stop per run.
      expect(calls.filter((c) => c.line === "POST /api/scans/other-dash-run-r4/abort")).toHaveLength(1);
      expect(calls.filter((c) => c.line === "POST /api/scans/mine-run-r4/abort")).toHaveLength(1);
    } finally {
      await knob("__hang", { hang: false });
      engineModule.engineTimeouts.callMs = 20_000;
      await agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
      watcher.halt();
    }
  }, 60_000);
});

describe("an account changed by another process on the shared database", () => {
  /** Another process -- another dashboard, or the sqlite3 shell -- runs one statement on the database file. */
  function elsewhere(dbPath: string, statement: string, ...args: string[]) {
    execFileSync(process.execPath, ["-e", `
      const Database = require("better-sqlite3");
      const db = new Database(process.argv[1]);
      db.pragma("busy_timeout = 5000");
      db.prepare(process.argv[2]).run(...process.argv.slice(3));
      db.close();
    `, dbPath, statement, ...args], { cwd: path.join(__dirname, "..") });
  }

  async function controlPlane() {
    const relayed: string[] = [];
    const actionOf = (uuid: string) => (uuid.includes("resume") ? "resume" : uuid.includes("release") ? "release" : "pause");
    const json = (res: http.ServerResponse, code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const plane = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        relayed.push(`${req.method} ${req.url}`);
        if (req.url === "/api/token/") return json(res, 200, { access: "tok" });
        const sig = /^\/api\/failsafe\/commands\/([^/]+)\/signatures\/$/.exec(req.url ?? "");
        if (sig) return json(res, 200, { uuid: sig[1], action: actionOf(sig[1]), engine_id: "engine-1", status: "ready", signers: ["k1"], required_signatures: 1 });
        const one = /^\/api\/failsafe\/commands\/([^/]+)\/$/.exec(req.url ?? "");
        if (one) return json(res, 200, { uuid: one[1], action: actionOf(one[1]), engine_id: "engine-1", status: "pending", signing_bytes: "00" });
        return json(res, 200, []);
      });
    });
    await new Promise<void>((r) => plane.listen(0, "127.0.0.1", r));
    process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${(plane.address() as AddressInfo).port}`;
    process.env.ATHENA_FAILSAFE_USER = "svc";
    process.env.ATHENA_FAILSAFE_PASSWORD = "pw";
    return {
      signed: (uuid: string) => relayed.includes(`POST /api/failsafe/commands/${uuid}/signatures/`),
      close: async () => {
        delete process.env.ATHENA_FAILSAFE_URL;
        delete process.env.ATHENA_FAILSAFE_USER;
        delete process.env.ATHENA_FAILSAFE_PASSWORD;
        await new Promise<void>((r) => plane.close(() => r()));
      },
    };
  }

  async function secondAdmin(app: import("express").Express, agent: ReturnType<typeof request.agent>, username: string) {
    const made = await agent.post("/api/users").send({ username, password: "second-admin-pw", role: "admin", email: `${username}@a.test` });
    expect(made.status).toBe(201);
    const session = request.agent(app);
    expect((await session.post("/api/auth/login").send({ username, password: "second-admin-pw" })).status).toBe(200);
    return { session, id: made.body.id as string };
  }

  it("deleted there: a pause's signature and its own key's revoke still go; a resume's signature is refused and never relayed, another admin's key is not revoked", async () => {
    const { app, agent, watcher, dbPath, storage } = await boot("oob-run");
    const plane = await controlPlane();
    try {
      const ex = await secondAdmin(app, agent, "r4-oob-deleted");
      const own = await ex.session.post("/api/api-keys").send({ name: "ex-admin's own" });
      const others = await agent.post("/api/api-keys").send({ name: "the real admin's automation" });
      expect([own.status, others.status]).toEqual([201, 201]);
      elsewhere(dbPath, "DELETE FROM users WHERE id = ?", ex.id);

      expect((await ex.session.post("/api/failsafe/commands/cmd-pause-oob/signatures").send({ keyId: "k1", sig: "abcd" })).status).toBe(200);
      expect(plane.signed("cmd-pause-oob")).toBe(true);
      expect((await ex.session.delete(`/api/api-keys/${own.body.key.id}`)).status).toBe(200);

      const resume = await ex.session.post("/api/failsafe/commands/cmd-resume-oob/signatures").send({ keyId: "k1", sig: "abcd" });
      expect(resume.status).toBe(401);
      expect(plane.signed("cmd-resume-oob")).toBe(false);
      const theirs = await ex.session.delete(`/api/api-keys/${others.body.key.id}`);
      expect(theirs.status).toBe(401);
      expect((await storage.getAllApiKeys()).find((one) => one.id === others.body.key.id)?.revokedAt ?? null).toBeNull();
    } finally {
      await plane.close();
      watcher.halt();
    }
  }, 60_000);

  it("demoted there: a resume's or a release's signature is refused (403) and never relayed, and another admin's key is not revoked", async () => {
    const { app, agent, watcher, dbPath, storage } = await boot("oob-demoted-run");
    const plane = await controlPlane();
    try {
      const ex = await secondAdmin(app, agent, "r4-oob-demoted");
      const others = await agent.post("/api/api-keys").send({ name: "the real admin's automation" });
      expect(others.status).toBe(201);
      elsewhere(dbPath, "UPDATE users SET role = 'user' WHERE id = ?", ex.id);
      for (const uuid of ["cmd-resume-dem", "cmd-release-dem"]) {
        expect((await ex.session.post(`/api/failsafe/commands/${uuid}/signatures`).send({ keyId: "k1", sig: "abcd" })).status, uuid).toBe(403);
        expect(plane.signed(uuid), uuid).toBe(false);
      }
      expect((await ex.session.delete(`/api/api-keys/${others.body.key.id}`)).status).toBe(403);
      expect((await storage.getAllApiKeys()).find((one) => one.id === others.body.key.id)?.revokedAt ?? null).toBeNull();
    } finally {
      await plane.close();
      watcher.halt();
    }
  }, 60_000);
});
