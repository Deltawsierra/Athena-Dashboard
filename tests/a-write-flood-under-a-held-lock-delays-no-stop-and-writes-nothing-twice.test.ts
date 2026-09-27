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
 * SAFETY, round three of PR #56, on the real SQLite backend: a database that
 * another connection holds locked -- a backup, the sqlite3 shell, a second
 * dashboard mid-transaction -- delays no Stop, however many writes are
 * waiting for it; nothing is written twice by waiting; the kill switch's flag
 * is stored as the last press set it; a Stop never waits for the tests to be
 * read again; and the kill switch still stops another dashboard's scan when
 * the engine's list cannot be read.
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
async function setActive(body: unknown) {
  await fetch(`http://127.0.0.1:${port}/__active`, { method: "POST", body: JSON.stringify(body) });
}

/** A dashboard on a fresh SQLite file, signed in, with one engine scan recorded as running. */
async function boot(runId: string) {
  process.env.ATHENA_STORAGE = "sqlite";
  const dbPath = path.join(tempDir(path.join(os.tmpdir(), "athena-r3-lock-")), "athena.db");
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
  return { agent, watcher, dbPath, testId: test.id, clientId: client.id, storage };
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

describe("a flood of writes waiting on a held lock", () => {
  it("delays no Stop: with 200 writes waiting, a scan's Stop reaches the engine within 100 ms", async () => {
    const { agent, watcher, dbPath, testId, storage } = await boot("flood-run");
    const release = holdTheWriteLock(dbPath);
    const pending: Array<Promise<unknown>> = [];
    try {
      for (let i = 0; i < 200; i += 1) {
        pending.push(storage.createActivityLog({ action: "flood", entityType: "test", entityId: String(i), details: null }).catch(() => undefined));
      }
      await sleep(200);
      const latencies: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        calls.length = 0;
        const pressed = Date.now();
        const answer = await agent.post(`/api/scans/${testId}/abort`);
        expect(answer.status).toBe(200);
        const got = await arrived("POST /api/scans/flood-run/abort", 10_000);
        expect(got).toBeDefined();
        latencies.push(got!.at - pressed);
      }
      console.log(`[flood] a scan's Stop reached the engine after ${latencies.join(", ")} ms with 200 writes waiting`);
      // Every round, while all 200 are still waiting (each waits up to 5 s in all).
      expect(Math.max(...latencies)).toBeLessThanOrEqual(100);
    } finally {
      watcher.halt();
      release();
      await Promise.all(pending);
    }
    // And every write went in, once, when the lock was let go.
    const rows = (await storage.getAllActivityLogs()).filter((one) => one.action === "flood");
    expect(rows).toHaveLength(200);
    expect(new Set(rows.map((one) => one.entityId)).size).toBe(200);
  }, 60_000);

  it("a write made while the lock is held goes in once the lock is let go", async () => {
    const { watcher, dbPath, storage } = await boot("wait-run");
    const release = holdTheWriteLock(dbPath);
    let settled = false;
    const write = storage.createActivityLog({ action: "waited", entityType: "test", entityId: "w", details: null })
      .finally(() => { settled = true; });
    await sleep(300);
    expect(settled).toBe(false);
    release();
    const row = await write;
    expect(row.action).toBe("waited");
    expect((await storage.getAllActivityLogs()).filter((one) => one.action === "waited")).toHaveLength(1);
    watcher.halt();
  }, 30_000);
});

describe("a busy database never makes a write twice", () => {
  it("a write whose read-back meets SQLITE_BUSY is read back again, not written again: one row", async () => {
    process.env.ATHENA_STORAGE = "sqlite";
    process.env.ATHENA_DB_PATH = path.join(tempDir(path.join(os.tmpdir(), "athena-r3-dbl-")), "athena.db");
    vi.resetModules();
    const { storage } = await import("../server/storage-sqlite");
    await storage.getAllActivityLogs();
    const proto = (Database as unknown as { prototype: { prepare: (sql: string) => unknown } }).prototype;
    const realPrepare = proto.prepare;
    let armed = false; let inserts = 0; let throws = 0;
    proto.prepare = function (this: unknown, sql: string) {
      const text = String(sql).toLowerCase();
      if (text.startsWith('insert into "activity_logs"')) { inserts += 1; if (inserts === 1) armed = true; }
      else if (armed && text.startsWith("select") && text.includes('"activity_logs"')) {
        armed = false; throws += 1;
        const busy = new Error("database is locked") as Error & { code: string };
        busy.code = "SQLITE_BUSY";
        throw busy;
      }
      return realPrepare.call(this, sql);
    };
    try {
      const row = await storage.createActivityLog({ action: "x1", entityType: "test", entityId: "once", details: null });
      expect(row.action).toBe("x1");
    } finally {
      proto.prepare = realPrepare;
    }
    expect(throws).toBe(1);
    expect(inserts).toBe(1);
    expect((await storage.getAllActivityLogs()).filter((one) => one.action === "x1")).toHaveLength(1);
  });
});

describe("the kill switch's flag under a held lock", () => {
  it("disengage then engage, both waiting on the lock: the flag stored is the last press's, and each answer matches it", async () => {
    const { agent, watcher, dbPath, storage } = await boot("flag-run");
    const outcomes: string[] = [];
    try {
      for (let trial = 0; trial < 8; trial += 1) {
        expect((await agent.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
        const release = holdTheWriteLock(dbPath);
        const off = agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" }).then((r) => r);
        await sleep(40);
        const on = agent.patch("/api/ai-control").send({ killSwitchEnabled: true }).then((r) => r);
        await sleep(300);
        release();
        const [a, b] = await Promise.all([off, on]);
        const stored = (await storage.getAIControlSettings())!.killSwitchEnabled;
        outcomes.push(`off:${a.status}/${a.body.killSwitchEnabled} on:${b.status}/${b.body.killSwitchEnabled} stored:${stored}`);
        expect(b.status).toBe(200);
        expect(b.body.killSwitchEnabled).toBe(true);
        expect(stored).toBe(true);
        // The earlier press's answer says a later change followed it.
        if (a.status === 200) expect(a.body.superseded).toMatch(/later change/);
      }
    } finally {
      watcher.halt();
    }
  }, 120_000);
});

describe("the tests held in memory", () => {
  it("deleting a client forgets its tests alone: a Stop, and the kill switch, never wait on reading the tests again", async () => {
    const { agent, watcher, testId, storage } = await boot("kept-run");
    // A client with a test of its own, deleted.
    const other = await agent.post("/api/clients").send({ name: "Tidy", company: "Tidy", email: "t@t.test" });
    const otherTest = await storage.createTest({ clientId: other.body.id, testType: "pentest", status: "completed", findings: null });
    expect(storage.peekTest(otherTest.id)).toBeDefined();
    expect((await agent.delete(`/api/clients/${other.body.id}`)).status).toBe(200);
    expect(storage.peekTest(otherTest.id)).toBeUndefined();
    expect(storage.peekAllTests()?.some((one) => one.id === otherTest.id)).toBe(false);
    expect(storage.peekTest(testId)).toBeDefined();
    expect(storage.peekAllTests()).not.toBeNull();

    // Every read of the tests is slow from here on.
    const target = storage as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const realGet = target.getTest; const realAll = target.getAllTests;
    target.getTest = async (...a: unknown[]) => { await sleep(2_000); return realGet(...a); };
    target.getAllTests = async (...a: unknown[]) => { await sleep(2_000); return realAll(...a); };
    try {
      calls.length = 0;
      let pressed = Date.now();
      expect((await agent.post(`/api/scans/${testId}/abort`)).status).toBe(200);
      let got = await arrived("POST /api/scans/kept-run/abort", 5_000);
      expect(got!.at - pressed).toBeLessThan(500);

      await setActive({ active: [{ run_id: "listed-only", target: "https://x.invalid/", kind: "scan", state: "running" }] });
      calls.length = 0;
      pressed = Date.now();
      const kill = agent.patch("/api/ai-control").send({ killSwitchEnabled: true }).then((r) => r);
      got = await arrived("POST /api/scans/kept-run/abort", 5_000);
      const listed = await arrived("POST /api/scans/listed-only/abort", 5_000);
      // The recorded scan's stop from memory, the listed run's as soon as the list is in.
      expect(got!.at - pressed).toBeLessThan(500);
      expect(listed!.at - pressed).toBeLessThan(500);
      expect((await kill).status).toBe(200);
    } finally {
      target.getTest = realGet; target.getAllTests = realAll;
      await setActive({ active: [] });
      await agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
      watcher.halt();
    }
  }, 60_000);

  it("another dashboard's scan on the shared database is sent a stop when the engine's list cannot be read", async () => {
    const { agent, watcher, dbPath, testId } = await boot("mine-run");
    const other = new Database(dbPath);
    const row = other.prepare("SELECT * FROM tests LIMIT 1").get() as Record<string, unknown>;
    other.prepare("INSERT INTO tests (id, client_id, test_type, status, started_at, findings, vulnerabilities_found, critical_count, high_count, medium_count, low_count, is_sample) VALUES (?, ?, 'vulnerability-scan', 'running', ?, ?, 0,0,0,0,0,0)")
      .run("other-dash-test", row.client_id, row.started_at, JSON.stringify({ runId: "other-dash-run", target: "https://b.invalid/", results: [] }));
    other.close();
    await setActive({ not_a_list: true });
    calls.length = 0;
    try {
      const engaged = await agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
      expect(engaged.status).toBe(200);
      expect(await arrived("POST /api/scans/other-dash-run/abort", 3_000)).toBeDefined();
      expect(await arrived("POST /api/scans/mine-run/abort", 3_000)).toBeDefined();
      expect(engaged.body.engineRuns.listed).toBe(false);
      expect(engaged.body.stops.listed).toBe(true);
      expect(engaged.body.stops.scans.map((one: { testId: string }) => one.testId).sort()).toEqual([testId, "other-dash-test"].sort());
      // Each run was sent one stop.
      expect(calls.filter((c) => c.line.endsWith("/abort"))).toHaveLength(2);
    } finally {
      await setActive({ active: [] });
      await agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
      watcher.halt();
    }
  }, 60_000);
});
