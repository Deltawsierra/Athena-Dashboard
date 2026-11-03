import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import Database from "better-sqlite3";
import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";
import { noteDatabase, releaseAndRemove } from "./helpers/databases-in-use";

/** The temporary directories this file made, each removed when the file is done -- passed or failed. Only these. */
const madeDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(prefix);
  madeDirs.push(dir);
  return dir;
}
afterAll(async () => {
  // Every database this file loaded is closed first (the server's connection and the checkpointer threads' connections
  // hold the files open, and Windows will not remove an open file), then the directories are removed.
  await releaseAndRemove(madeDirs);
});

/**
 * No commit on the event loop starts the write-ahead log over (server/
 * db-sqlite.ts, connect() and CHECKPOINTER_SOURCE).
 *
 * The first commit after a checkpoint that moved the whole log into the
 * database starts the log over, and SQLite syncs the log's new header then,
 * on the committing connection, whatever `synchronous` says. On Windows that
 * sync (FlushFileBuffers) held the loop 54-73 ms at the start of a burst of
 * writes draining after a lock was let go. So the checkpointer thread starts
 * the log over itself, with a one-row write of its own, and the loop's
 * commits only append.
 *
 * Whether a commit started the log over is read from the log file's header:
 * starting it over writes new salts there (and syncs it). A commit that
 * appends leaves the header as it was.
 *
 *   - After the thread's checkpoint, and after a lock held elsewhere is let
 *     go, a commit on the loop leaves the header as it was.
 *   - Idle, the thread writes nothing -- nor do two dashboards' threads on one
 *     file write to each other.
 *   - The thread never waits on the lock: with the lock held elsewhere,
 *     closing the database ends it at once.
 *   - A Stop pressed while the thread holds the write lock for its write
 *     reaches the engine within the bound a Stop under a held lock has
 *     (tests/a-stop-reaches-the-engine-while-the-database-is-locked.test.ts).
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
    await sleep(5);
  }
}

/** A dashboard on a fresh SQLite file, signed in, with one engine scan recorded as running, and its checkpointer thread running. */
async function boot(runId: string) {
  process.env.ATHENA_STORAGE = "sqlite";
  const dbPath = path.join(tempDir(path.join(os.tmpdir(), "athena-log-restart-")), "athena.db");
  process.env.ATHENA_DB_PATH = dbPath;
  vi.resetModules();
  await noteDatabase();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  const app = createApp();
  await initializeDefaultData();
  await adminHasSetPassword();
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD })).status).toBe(200);
  const storage = (await import("../server/storage-unified")).storage;
  const client = await storage.createClient({ name: "Log", company: "Log", email: "l@l.test" });
  const test = await storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "running",
    findings: { runId, target: "https://offline.invalid/", results: [] },
  });
  await storage.getAllTests();
  const dbm = await import("../server/db-sqlite");
  const deadline = Date.now() + 3_000;
  while (dbm.checkpointer.state !== "on" && Date.now() < deadline) await sleep(20);
  expect(dbm.checkpointer.state).toBe("on");
  const watcher = app.locals.retestWatcher as import("../server/retests").RetestWatcher;
  return { agent, watcher, dbPath, dbm, storage, testId: test.id };
}

/** The log header's checkpoint sequence number and salts: starting the log over writes new ones. */
function logHeader(dbPath: string): string {
  const fd = fs.openSync(`${dbPath}-wal`, "r");
  try {
    const header = Buffer.alloc(32);
    fs.readSync(fd, header, 0, 32, 0);
    return header.subarray(12, 24).toString("hex");
  } finally {
    fs.closeSync(fd);
  }
}

async function someWrites(storage: Awaited<ReturnType<typeof boot>>["storage"], what: string, n = 20) {
  for (let i = 0; i < n; i += 1) {
    await storage.createActivityLog({ action: what, entityType: "test", entityId: String(i), details: null });
  }
}

/** Another connection's `PRAGMA data_version`: it changes whenever any other connection commits. */
function commitsSeenBy(probe: Database.Database): number {
  return probe.pragma("data_version", { simple: true }) as number;
}

describe("no commit on the event loop starts the write-ahead log over", () => {
  it("after the checkpointer thread has moved the whole log into the database, and then sat idle, a commit on the loop appends to the log", async () => {
    const { dbPath, storage, watcher } = await boot("restart-after-checkpoint");
    try {
      for (let round = 0; round < 3; round += 1) {
        await someWrites(storage, `round${round}`);
        // A checkpoint within the next second, then at least one idle second.
        await sleep(2_300);
        const before = logHeader(dbPath);
        await storage.createActivityLog({ action: `after${round}`, entityType: "test", entityId: "x", details: null });
        expect(logHeader(dbPath), `round ${round}`).toBe(before);
      }
    } finally {
      watcher.halt();
    }
  }, 30_000);

  it("after another connection held the write lock across the thread's turns, the first commit on the loop once it is let go appends to the log", async () => {
    const { dbPath, storage, watcher } = await boot("restart-after-lock");
    try {
      for (let round = 0; round < 2; round += 1) {
        await someWrites(storage, `locked${round}`);
        const lock = new Database(dbPath);
        let before: string;
        try {
          lock.pragma("busy_timeout = 0");
          lock.exec("BEGIN IMMEDIATE");
          // At least one of the thread's turns falls while the lock is held.
          await sleep(1_300);
          before = logHeader(dbPath);
          lock.exec("ROLLBACK");
        } finally {
          lock.close();
        }
        await storage.createActivityLog({ action: `released${round}`, entityType: "test", entityId: "x", details: null });
        expect(logHeader(dbPath), `round ${round}`).toBe(before);
      }
    } finally {
      watcher.halt();
    }
  }, 30_000);
});

describe("the checkpointer thread writes nothing while the database is idle, and never waits on the lock", () => {
  it("idle -- with one dashboard's thread, and with two dashboards' threads on one file -- nothing is committed", async () => {
    const { dbPath, dbm, storage, watcher } = await boot("idle");
    const second = new Database(dbPath);
    const probe = new Database(dbPath);
    try {
      await someWrites(storage, "before-idle");
      // The thread's checkpoint and its write, then nothing.
      await sleep(1_500);
      let seen = commitsSeenBy(probe);
      await sleep(2_500);
      expect(commitsSeenBy(probe)).toBe(seen);

      // A second dashboard's thread on the same file.
      dbm.startCheckpointer(second, dbPath);
      await someWrites(storage, "two-threads");
      await sleep(2_500);
      seen = commitsSeenBy(probe);
      await sleep(3_000);
      expect(commitsSeenBy(probe)).toBe(seen);
    } finally {
      probe.close();
      watcher.halt();
      await dbm.closeDatabase();
      second.close();
    }
  }, 30_000);

  it("with the write lock held elsewhere, the thread skips its turn: closing the database ends it at once", async () => {
    const { dbPath, dbm, storage, watcher } = await boot("busy");
    const lock = new Database(dbPath);
    try {
      await someWrites(storage, "before-lock");
      lock.pragma("busy_timeout = 0");
      lock.exec("BEGIN IMMEDIATE");
      // At least one of the thread's turns meets the lock.
      await sleep(1_300);
      watcher.halt();
      const began = Date.now();
      await dbm.closeDatabase();
      expect(Date.now() - began).toBeLessThan(1_000);
    } finally {
      if (lock.inTransaction) lock.exec("ROLLBACK");
      lock.close();
      watcher.halt();
    }
  }, 30_000);
});

describe("a Stop while the checkpointer thread holds the write lock", () => {
  it("reaches the engine in under 250 ms", async () => {
    const { agent, dbPath, dbm, storage, watcher, testId } = await boot("held-by-the-thread");
    // A thread that holds the write lock 1.5 s before each of its writes.
    const holder = new Database(dbPath);
    const probe = new Database(dbPath);
    probe.pragma("busy_timeout = 0");
    let writing = true;
    const writes = (async () => {
      let i = 0;
      while (writing) {
        await storage.createActivityLog({ action: "steady", entityType: "test", entityId: String(i), details: null }).catch(() => undefined);
        i += 1;
        await sleep(20);
      }
    })();
    const lockedNow = () => {
      try {
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
        return false;
      } catch {
        return true;
      }
    };
    try {
      dbm.startCheckpointer(holder, dbPath, undefined, 1_500);
      // Held for 300 ms and more: the holding thread, not a commit or a checkpointer's write of a few ms.
      const deadline = Date.now() + 8_000;
      let heldSince = 0;
      while (Date.now() < deadline) {
        if (!lockedNow()) heldSince = 0;
        else if (heldSince === 0) heldSince = Date.now();
        else if (Date.now() - heldSince >= 300) break;
        await sleep(10);
      }
      expect(heldSince > 0 && Date.now() - heldSince >= 300).toBe(true);
      calls.length = 0;
      const pressed = Date.now();
      const stop = agent.post(`/api/scans/${testId}/abort`).then((r) => r);
      const reached = await arrived("POST /api/scans/held-by-the-thread/abort", 5_000);
      const stillHeld = lockedNow();
      expect(reached).toBeDefined();
      console.log(`[log-restart] a Stop pressed while the checkpointer thread held the write lock reached the engine after ${reached!.at - pressed} ms`);
      expect(reached!.at - pressed).toBeLessThan(250);
      // And the thread held the lock all the while.
      expect(stillHeld).toBe(true);
      expect((await stop).status).toBe(200);
    } finally {
      writing = false;
      await writes;
      probe.close();
      watcher.halt();
      await dbm.closeDatabase();
      holder.close();
    }
  }, 30_000);
});
