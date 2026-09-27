import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import Database from "better-sqlite3";

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
 * SAFETY, round five of PR #56 (the round-four review's findings), on the
 * real SQLite backend on a file, with the write lock held by a second
 * connection -- a backup, the sqlite3 shell, another dashboard mid-transaction:
 *
 *   - An API key's usage stamp is a write, and no request waits on it: sent
 *     once per request, in the write line, while the request goes on. An API
 *     key's scan Stop reaches the engine within 50 ms under a held lock, and
 *     its kill switch's first stop within 50 ms. A stamp that fails is
 *     logged and counted, and fails nothing.
 *   - While the checkpointer thread runs, a commit does not sync the log
 *     (synchronous NORMAL), and the write-ahead log is synced and moved into
 *     the database by that thread; the one sync left on the loop is the log's
 *     header, when the first commit after a checkpoint starts the log over.
 *     If the thread fails, every commit is synced when it is made again
 *     (FULL). The line of writes waiting on a held lock takes its
 *     head, and adds a call, in constant time, and a drain of thousands of
 *     writes keeps its order.
 *   - The kill switch holds from the instant it is pressed, while its flag's
 *     write waits for the lock: a scan started after the press is refused at
 *     once and never reaches the engine, and so is every other write; once
 *     the lock is let go the flag is stored, and reads engaged.
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

/** A dashboard on a fresh SQLite file, signed in, with one engine scan recorded as running. */
async function boot(runId: string) {
  process.env.ATHENA_STORAGE = "sqlite";
  const dbPath = path.join(tempDir(path.join(os.tmpdir(), "athena-r5-lock-")), "athena.db");
  process.env.ATHENA_DB_PATH = dbPath;
  vi.resetModules();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  const app = createApp();
  await initializeDefaultData();
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ username: "admin", password: "admin123" })).status).toBe(200);
  const storage = (await import("../server/storage-unified")).storage;
  const auth = await import("../server/auth");
  const client = await storage.createClient({ name: "Locked", company: "Locked", email: "l@l.test" });
  const site = await storage.createSite({ clientId: client.id, name: "Main", url: "https://offline.invalid" });
  const test = await storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "running",
    findings: { runId, target: "https://offline.invalid/", results: [] },
  });
  const watcher = app.locals.retestWatcher as import("../server/retests").RetestWatcher;
  await sleep(100);
  // Every test read into memory, as the dashboard does in the background at start-up.
  await storage.getAllTests();
  return { app, agent, watcher, dbPath, testId: test.id, clientId: client.id, siteId: site.id, storage, auth };
}

function holdTheWriteLock(dbPath: string) {
  const lock = new Database(dbPath);
  lock.pragma("busy_timeout = 0");
  lock.exec("BEGIN IMMEDIATE");
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    lock.exec("ROLLBACK");
    lock.close();
  };
}

describe("an API key's stop waits on no write", () => {
  it("lock held: an API key's scan Stop reaches the engine within 50 ms, its kill switch's first stop within 50 ms; one usage stamp per request, written once the lock is let go", async () => {
    const { app, agent, watcher, dbPath, testId, storage, auth } = await boot("api-key-run-r5");
    const made = await agent.post("/api/api-keys").send({ name: "automation" });
    expect(made.status).toBe(201);
    const secret = made.body.secret as string;
    const keyId = made.body.key.id as string;
    // A request before the lock: its stamp, written.
    expect((await request(app).get("/api/clients").set("X-API-Key", secret)).status).toBe(200);
    await sleep(50);
    const before = { ...auth.apiKeyTouches };
    const release = holdTheWriteLock(dbPath);
    calls.length = 0;
    try {
      let pressed = Date.now();
      const stop = await request(app).post(`/api/scans/${testId}/abort`).set("X-API-Key", secret);
      const scanStop = await arrived("POST /api/scans/api-key-run-r5/abort", 1_000);
      expect(stop.status).toBe(200);
      expect(scanStop).toBeDefined();
      expect(scanStop!.at - pressed).toBeLessThanOrEqual(50);
      calls.length = 0;
      pressed = Date.now();
      const kill = request(app).patch("/api/ai-control").set("X-API-Key", secret).send({ killSwitchEnabled: true }).then((r) => r);
      const killStop = await arrived("POST /api/scans/api-key-run-r5/abort", 1_000);
      expect(killStop).toBeDefined();
      expect(killStop!.at - pressed).toBeLessThanOrEqual(50);
      // One stamp per request, though the kill switch passed two guards that authenticate it.
      expect(auth.apiKeyTouches.sent - before.sent).toBe(2);
      release();
      expect((await kill).status).toBe(200);
      const stamped = async () => (await storage.getAllApiKeys()).find((one) => one.id === keyId)?.lastUsedAt ?? null;
      const deadline = Date.now() + 3_000;
      let at = await stamped();
      while ((at === null || at.getTime() < pressed - 1_000) && Date.now() < deadline) { await sleep(20); at = await stamped(); }
      expect(at).toBeInstanceOf(Date);
      expect(auth.apiKeyTouches.failed - before.failed).toBe(0);
    } finally {
      release();
      await agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
      watcher.halt();
    }
  }, 60_000);

  it("a usage stamp that fails is logged and counted, and fails nothing: the Stop is answered 200", async () => {
    const { app, agent, watcher, testId, storage, auth } = await boot("api-key-stamp-fails");
    const made = await agent.post("/api/api-keys").send({ name: "automation" });
    const secret = made.body.secret as string;
    const before = auth.apiKeyTouches.failed;
    vi.spyOn(storage, "touchApiKey").mockRejectedValue(new Error("SQLITE_FULL: database or disk is full"));
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const stop = await request(app).post(`/api/scans/${testId}/abort`).set("X-API-Key", secret);
      expect(stop.status).toBe(200);
      await sleep(20);
      expect(auth.apiKeyTouches.failed - before).toBe(1);
      expect(said.mock.calls.some((one) => /usage stamp of API key .* could not be written \(the request went on\): SQLITE_FULL/.test(String(one[0])))).toBe(true);
    } finally {
      vi.restoreAllMocks();
      watcher.halt();
    }
  }, 30_000);
});

describe("no start passes a pressed kill switch", () => {
  it("lock held: the switch pressed, its flag waiting; a scan started 100 ms later is refused at once and never reaches the engine, as is any write; the lock let go, the flag is stored", async () => {
    const { agent, watcher, dbPath, clientId, siteId, storage } = await boot("mine-run-r5");
    const release = holdTheWriteLock(dbPath);
    calls.length = 0;
    try {
      const kill = agent.patch("/api/ai-control").send({ killSwitchEnabled: true }).then((r) => r);
      expect(await arrived("POST /api/scans/mine-run-r5/abort", 3_000)).toBeDefined();
      await sleep(100);
      const began = Date.now();
      const start = await agent.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
      expect(Date.now() - began).toBeLessThan(250);
      expect(start.status).toBe(503);
      expect(start.body.message).toMatch(/kill switch is engaged/i);
      const write = await agent.post("/api/clients").send({ name: "Refused", company: "R", email: "refused@r.test" });
      expect(write.status).toBe(503);
      // Held in memory while the row still says off.
      expect((await storage.getAIControlSettings())!.killSwitchEnabled).toBe(false);
      expect((await agent.get("/api/ai-control")).body.killSwitchEnabled).toBe(true);
      await sleep(700);
      release();
      const engaged = await kill;
      expect(engaged.status).toBe(200);
      expect(engaged.body.killSwitchEnabled).toBe(true);
      expect((await storage.getAIControlSettings())!.killSwitchEnabled).toBe(true);
      expect(calls.some((c) => c.line === "POST /api/scan")).toBe(false);
      // Switched off, and stored: a start goes again.
      expect((await agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" })).status).toBe(200);
      const again = await agent.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
      expect(again.status).toBe(201);
      expect(calls.some((c) => c.line === "POST /api/scan")).toBe(true);
    } finally {
      release();
      watcher.halt();
    }
  }, 60_000);
});

describe("while the checkpointer runs, commits do not sync the log and checkpoints are made off the event loop", () => {
  it("a commit does not sync the log (NORMAL), SQLite checkpoints nothing on the loop, and the checkpointer thread moves the log into the database", async () => {
    const { storage, dbPath, watcher } = await boot("ckpt-run");
    try {
      const dbm = await import("../server/db-sqlite");
      const deadline = Date.now() + 3_000;
      while (dbm.checkpointer.state === "off" && Date.now() < deadline) await sleep(20);
      expect(dbm.checkpointer.state).toBe("on");
      expect(dbm.sqlite.pragma("synchronous", { simple: true })).toBe(1); // NORMAL
      expect(dbm.sqlite.pragma("wal_autocheckpoint", { simple: true })).toBe(0);
      for (let i = 0; i < 500; i += 1) {
        await storage.createActivityLog({ action: "ckpt", entityType: "test", entityId: String(i), details: null });
      }
      const probe = new Database(dbPath);
      try {
        let state = probe.pragma("wal_checkpoint(NOOP)") as Array<{ log: number; checkpointed: number }>;
        const until = Date.now() + 5_000;
        while (state[0].checkpointed < state[0].log && Date.now() < until) {
          await sleep(100);
          state = probe.pragma("wal_checkpoint(NOOP)") as Array<{ log: number; checkpointed: number }>;
        }
        expect(state[0].log).toBeGreaterThan(0);
        expect(state[0].checkpointed).toBe(state[0].log);
      } finally {
        probe.close();
      }
    } finally {
      watcher.halt();
    }
  }, 30_000);

  it("a checkpointer that cannot start leaves SQLite's own checkpoints on, syncs every commit when it is made again (FULL), and says why", async () => {
    const dbm = await import("../server/db-sqlite");
    const dir = tempDir(path.join(os.tmpdir(), "athena-r5-ckpt-"));
    const file = path.join(dir, "other.db");
    const handle = new Database(file);
    handle.pragma("journal_mode = WAL");
    handle.pragma("wal_autocheckpoint = 0");
    handle.pragma("synchronous = NORMAL");
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      dbm.startCheckpointer(handle, file, path.join(dir, "no-such-module.js"));
      const deadline = Date.now() + 3_000;
      while (dbm.checkpointer.state !== "failed" && Date.now() < deadline) await sleep(20);
      expect(dbm.checkpointer.state).toBe("failed");
      expect(dbm.checkpointer.detail).toMatch(/no-such-module/);
      expect(handle.pragma("wal_autocheckpoint", { simple: true })).toBe(1000);
      expect(handle.pragma("synchronous", { simple: true })).toBe(2); // FULL
      expect(said.mock.calls.some((one) => /checkpointer thread is not running/.test(String(one[0])))).toBe(true);
    } finally {
      said.mockRestore();
      handle.close();
    }
  }, 30_000);

  it("3000 writes refused busy and waiting in one line go in once each, in the order they were made", async () => {
    const { withBusyRetry, BusyLine } = await import("../server/storage-sqlite");
    const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    let lockedUntil = Date.now() + 200;
    const order: number[] = [];
    const target = {
      async createThing(i: number) {
        if (Date.now() < lockedUntil) throw busy();
        // Now and then the lock is taken again for a moment: the head goes back to its place.
        if (i % 700 === 0 && !order.includes(-i - 1)) { order.push(-i - 1); lockedUntil = Date.now() + 30; throw busy(); }
        order.push(i);
        return i;
      },
    };
    const line = new BusyLine();
    const store = withBusyRetry(target, 20_000, line);
    const calls = Array.from({ length: 3000 }, (_unused, i) => store.createThing(i));
    const done = await Promise.all(calls);
    expect(done).toEqual(Array.from({ length: 3000 }, (_unused, i) => i));
    const written = order.filter((one) => one >= 0);
    expect(written).toEqual(Array.from({ length: 3000 }, (_unused, i) => i));
    expect(line.length).toBe(0);
  }, 60_000);
});
