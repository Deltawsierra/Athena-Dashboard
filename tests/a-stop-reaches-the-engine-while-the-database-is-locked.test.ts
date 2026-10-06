import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import Database from "better-sqlite3";
import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";

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
 * SAFETY: a Stop reaches the engine at once while another connection holds the
 * database's write lock -- a backup, the sqlite3 shell, or a second dashboard
 * mid-transaction -- however many retests are being watched.
 *
 * better-sqlite3 is synchronous. With the 5 s busy timeout the dashboard used
 * to open with, every write attempted under a held lock froze the event loop
 * for 5 s, and the retest watch wrote on every read: with three watches a
 * retest's Stop reached the engine after 20 s, or never. Now a statement waits
 * at most 10 ms for a lock and the storage layer waits the rest off the loop;
 * a Stop is authorised from the session and finds its run in memory; and every
 * record of a stop is written after the stops are sent.
 *
 * The real SQLite backend, on a file; the lock held by a second connection;
 * the stand-in engine in a process of its own (tests/helpers/
 * engine-in-its-own-process.cjs) so that it times each request's arrival
 * whatever the dashboard's loop is doing.
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
    await sleep(20);
  }
}
async function setActive(body: unknown) {
  await fetch(`http://127.0.0.1:${port}/__active`, { method: "POST", body: JSON.stringify(body) });
}

/** A dashboard on a fresh SQLite file: signed in, one engine scan recorded as running, and `watches` retests watched. */
async function boot(watches: number) {
  process.env.ATHENA_STORAGE = "sqlite";
  const dbPath = path.join(tempDir(path.join(os.tmpdir(), "athena-stop-lock-")), "athena.db");
  process.env.ATHENA_DB_PATH = dbPath;
  vi.resetModules();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  const app = createApp();
  await initializeDefaultData();
  await adminHasSetPassword();
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD })).status).toBe(200);
  const retests = await import("../server/retests");
  retests.retestWatch.intervalMs = 25;
  const storage = (await import("../server/storage-unified")).storage;
  const client = await storage.createClient({ name: "Locked", company: "Locked", email: "l@l.test" });
  const test = await storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "running",
    findings: { runId: `scan-run-${watches}`, target: "https://offline.invalid/", results: [] },
  });
  const now = new Date();
  for (let i = 0; i < watches; i += 1) {
    await storage.createRetestWatch({
      engineRunId: `watched-${watches}-${i}`, testId: test.id, clientId: client.id, twinId: 1, findingId: null,
      engagementRef: null, requestedBy: null, requestedFrom: null, startedAt: now,
      deadlineAt: new Date(now.getTime() + 3_600_000), state: "running", engineState: "running", reason: null,
      error: null, lastReadAt: null, lastReadError: null, stopAcceptedAt: null, endedAt: null, result: null,
    });
  }
  const watcher = app.locals.retestWatcher as import("../server/retests").RetestWatcher;
  // Resumed as a dashboard starting up on this record would.
  watcher.resume();
  await sleep(300);
  return { agent, watcher, dbPath, testId: test.id };
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

for (const watches of [3, 20]) {
  describe(`with the write lock held elsewhere and ${watches} retests watched`, () => {
    it("a retest's Stop and a scan's Stop each reach the engine in under 250 ms, and are answered promptly", async () => {
      const { agent, watcher, dbPath, testId } = await boot(watches);
      const release = holdTheWriteLock(dbPath);
      try {
        // Let the watches read, and try to write, under the lock.
        await sleep(300);
        for (const [what, url, line] of [
          ["retest Stop", `/api/retests/watched-${watches}-0/abort`, `POST /api/scans/watched-${watches}-0/abort`],
          ["scan Stop", `/api/scans/${testId}/abort`, `POST /api/scans/scan-run-${watches}/abort`],
        ] as const) {
          const pressed = Date.now();
          const answer = await agent.post(url);
          const answeredAfter = Date.now() - pressed;
          const got = await arrived(line);
          expect(answer.status, what).toBe(200);
          expect(got, what).toBeDefined();
          expect(got!.at - pressed, what).toBeLessThan(250);
          expect(answeredAfter, what).toBeLessThan(1_000);
        }
      } finally {
        watcher.halt();
        release();
      }
    }, 60_000);

    it("the kill switch sends every stop -- the watched retests, the recorded scan, a run only the engine lists -- in under 250 ms", async () => {
      const { agent, watcher, dbPath } = await boot(watches);
      await setActive({ active: [{ run_id: "other-dashboards-scan", target: "https://x.invalid/", kind: "scan", state: "running" }] });
      const release = holdTheWriteLock(dbPath);
      try {
        await sleep(300);
        calls.length = 0;
        const pressed = Date.now();
        const engaged = await agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
        const expected = [
          ...Array.from({ length: watches }, (_unused, i) => `POST /api/scans/watched-${watches}-${i}/abort`),
          `POST /api/scans/scan-run-${watches}/abort`,
          "POST /api/scans/other-dashboards-scan/abort",
        ];
        for (const line of expected) {
          const got = await arrived(line);
          expect(got, line).toBeDefined();
          expect(got!.at - pressed, line).toBeLessThan(250);
        }
        // The flag could not be stored under the held lock; that is said, with every stop --
        // and the press is held engaged in this dashboard's memory all the same.
        expect(engaged.status).toBe(500);
        expect(engaged.body.engaged).toBe(true);
        expect(engaged.body.stored).toBe(false);
        expect(engaged.body.message).toMatch(/Every stop was sent all the same/);
      } finally {
        watcher.halt();
        release();
        await setActive({ active: [] });
      }
    }, 60_000);
  });
}
