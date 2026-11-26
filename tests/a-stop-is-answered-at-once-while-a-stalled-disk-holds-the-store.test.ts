import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import dc from "diagnostics_channel";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server, IncomingMessage } from "http";
import type { AddressInfo } from "net";
import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";
import { noteDatabase, releaseAndRemove } from "./helpers/databases-in-use";
import { aStoreThatCanBeHeld, type HeldStore } from "./helpers/held-store";

/**
 * SAFETY: a retest's Stop reaches the engine at once, and is answered at
 * once, while a slow or stalled disk holds the SQLite store.
 *
 * better-sqlite3 runs each statement on the event loop, for as long as the
 * disk takes. The retest Stop (POST /api/retests/:runId/abort) went to the
 * engine before any store work, but then wrote the engine's acceptance onto
 * the watch's row (RetestWatcher.stopAccepted, or stopSentUnread for a 2xx
 * whose answer was not read) BEFORE it answered: the person's Stop was
 * answered only once the disk had taken that write. With the store held for
 * 3 s from the Stop's arrival, its answer came after 3039 ms -- the bound in
 * tests/a-retest-verdict-survives-a-restart-and-is-filed-once.test.ts
 * ("resuming never delays a stop") is 500 ms. Now the note is in memory at
 * once and on the record after the answer.
 *
 * The store is held as a stalled disk holds it (tests/helpers/held-store.ts):
 * from the moment the Stop arrives, every statement on this process's loop
 * waits until 3 s have passed. The engine (tests/helpers/
 * engine-in-its-own-process.cjs) and the person (tests/helpers/
 * a-person-in-their-own-process.cjs) are each in a process of their own, so
 * each times by its own clock when the Stop reached it and when the answer
 * came, whatever this process's loop is doing. Both bounds are the ones that
 * test holds: the engine within 250 ms of the press, the answer within 500 ms.
 */

const HELD_MS = 3_000;

const madeDirs: string[] = [];
let store: HeldStore;
let engine: ChildProcess;
let person: ChildProcess;
let enginePort = 0;
const engineCalls: Array<{ line: string; at: number }> = [];
const answers: Array<{ id: string; sentAt: number; answeredAt?: number; status?: number; body?: any; error?: string }> = [];

/** A child process's JSON lines, each handed to `each`. */
function lines(child: ChildProcess, each: (one: any) => void): void {
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const one = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      each(one);
    }
  });
}

beforeAll(async () => {
  store = aStoreThatCanBeHeld();
  engine = spawn(process.execPath, [path.join(__dirname, "helpers", "engine-in-its-own-process.cjs")], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((ready) => lines(engine, (one) => {
    if (one.port) { enginePort = one.port; ready(); } else engineCalls.push(one);
  }));
  person = spawn(process.execPath, [path.join(__dirname, "helpers", "a-person-in-their-own-process.cjs")], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((ready) => lines(person, (one) => {
    if (one.ready) ready(); else answers.push(one);
  }));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${enginePort}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
});
afterAll(async () => {
  store.release();
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  engine.kill();
  person.kill();
  // Every database this file loaded is closed (Windows will not remove an open file), then the directories are removed.
  await releaseAndRemove(madeDirs);
  process.env.ATHENA_STORAGE = "memory";
  delete process.env.ATHENA_DB_PATH;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(20);
    last = await read();
  }
  return last;
}
async function knob(name: string, body: unknown) {
  await fetch(`http://127.0.0.1:${enginePort}/${name}`, { method: "POST", body: JSON.stringify(body) });
}

/** A dashboard on a fresh SQLite file, listening, its admin signed in, and one retest the engine is running watched. */
async function aDashboardWatchingARetest(runId: string) {
  process.env.ATHENA_STORAGE = "sqlite";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-held-store-"));
  madeDirs.push(dir);
  process.env.ATHENA_DB_PATH = path.join(dir, "athena.db");
  vi.resetModules();
  await noteDatabase();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  const app = createApp();
  await initializeDefaultData();
  await adminHasSetPassword();
  const server: Server = await new Promise((up) => { const one = app.listen(0, "127.0.0.1", () => up(one)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: TEST_ADMIN_PASSWORD }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const storage = (await import("../server/storage-unified")).storage;
  const engineModule = await import("../server/engine");
  const client = await storage.createClient({ name: "Held", company: "Held", email: "h@h.test" });
  const test = await storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "completed",
    findings: { runId: `scan-of-${runId}`, target: "https://offline.invalid/", results: [] },
  });
  const now = new Date();
  await storage.createRetestWatch({
    engineRunId: runId, testId: test.id, clientId: client.id, twinId: 1, findingId: null, engagementRef: null,
    requestedBy: null, requestedFrom: null, startedAt: now, deadlineAt: new Date(now.getTime() + 3_600_000),
    state: "running", engineState: "running", reason: null, error: null, lastReadAt: null, lastReadError: null,
    stopAcceptedAt: null, stopUnreadAt: null, endedAt: null, result: null,
  });
  const watcher = app.locals.retestWatcher as import("../server/retests").RetestWatcher;
  watcher.resume();
  await until(() => watcher.peek(runId), (row) => row !== undefined, 5_000);
  expect(watcher.peek(runId)).toBeDefined();
  return { server, base, cookie, storage, watcher, engineModule, testId: test.id };
}

/**
 * The person presses a Stop (`stopPath`, which sends the engine a stop for
 * `runId`); the store is held for HELD_MS from the moment the Stop reaches the
 * dashboard. What the memory said of the watch when the first statement was
 * held is kept.
 */
async function pressWhileTheStoreIsHeld(
  base: string, cookie: string, stopPath: string, runId: string, watcher: import("../server/retests").RetestWatcher,
) {
  let memoryWhenHeld: ReturnType<typeof watcher.peek> | null = null;
  const arrived = (message: unknown) => {
    const req = (message as { request: IncomingMessage }).request;
    if (req.method !== "POST" || req.url !== stopPath) return;
    store.onHeld = () => { memoryWhenHeld = watcher.peek(runId) ?? null; };
    store.holdFor(HELD_MS);
  };
  dc.subscribe("http.server.request.start", arrived);
  const heldBefore = store.held.length;
  try {
    const id = `${runId}-${Date.now()}`;
    person.stdin!.write(JSON.stringify({ id, method: "POST", url: `${base}${stopPath}`, cookie }) + "\n");
    const answer = await until(() => answers.find((one) => one.id === id), (one) => one !== undefined, HELD_MS + 10_000);
    const reached = await until(() => engineCalls.find((one) => one.line === `POST /api/scans/${runId}/abort`),
      (one) => one !== undefined, 5_000);
    // The hold is over once every statement it held has run.
    await until(() => Date.now(), () => store.held.length > heldBefore, HELD_MS + 5_000);
    return { answer: answer!, reached, heldNow: store.held.slice(heldBefore), memoryWhenHeld: memoryWhenHeld as ReturnType<typeof watcher.peek> | null };
  } finally {
    dc.unsubscribe("http.server.request.start", arrived);
    store.holdFor(0);
    store.onHeld = null;
  }
}

describe("a Stop while a stalled disk holds the SQLite store for 3 s", () => {
  it("a retest's Stop the engine takes: it reaches the engine within 250 ms and is answered within 500 ms; its note is in memory at once and on the record after", async () => {
    const runId = "held-store-accepted";
    const { server, base, cookie, storage, watcher } = await aDashboardWatchingARetest(runId);
    try {
      const { answer, reached, heldNow, memoryWhenHeld } = await pressWhileTheStoreIsHeld(base, cookie, `/api/retests/${runId}/abort`, runId, watcher);
      expect(answer.error).toBeUndefined();
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ stopped: true, runId });
      expect(answer.body.answerUnread).toBeUndefined();
      expect(reached, "the Stop reached the engine").toBeDefined();
      expect(reached!.at - answer.sentAt).toBeLessThan(250);
      expect(answer.answeredAt! - answer.sentAt).toBeLessThan(500);
      // The store was held after the Stop arrived: a statement waited out (nearly) the whole hold.
      expect(Math.max(...heldNow.map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      // While the record waited on the disk, memory already said the engine had taken the stop.
      expect(memoryWhenHeld?.stopAcceptedAt).toBeInstanceOf(Date);
      expect(memoryWhenHeld?.stopUnreadAt ?? null).toBeNull();
      // And the record follows: the note on the watch's row, and the stop in the log.
      const row = await until(() => storage.getRetestWatch(runId), (one) => one?.stopAcceptedAt != null, 5_000);
      expect(row!.stopAcceptedAt).toBeInstanceOf(Date);
      expect(row!.stopUnreadAt ?? null).toBeNull();
      const logs = await (await fetch(`${base}/api/logs`, { headers: { cookie } })).json();
      expect(logs.filter((one: { action: string; details: { runId?: string; via?: string } }) =>
        one.details?.runId === runId && one.details?.via === "retest_stop").map((one: { action: string }) => one.action)).toEqual(["aborted"]);
    } finally {
      watcher.halt();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r(null)));
    }
  }, 60_000);

  it("a retest's Stop the engine answers 2xx and the rest never comes: answered within 500 ms as a stop sent, its answer unread, and noted as that, never as accepted", async () => {
    const runId = "held-store-unread";
    const { server, base, cookie, storage, watcher, engineModule } = await aDashboardWatchingARetest(runId);
    const abortBodyMs = engineModule.engineTimeouts.abortBodyMs;
    engineModule.engineTimeouts.abortBodyMs = 100;
    await knob("__abortBodyHang", { hang: true });
    try {
      const { answer, reached, heldNow, memoryWhenHeld } = await pressWhileTheStoreIsHeld(base, cookie, `/api/retests/${runId}/abort`, runId, watcher);
      expect(answer.error).toBeUndefined();
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ stopped: true, runId, answerUnread: true });
      expect(reached, "the Stop reached the engine").toBeDefined();
      expect(reached!.at - answer.sentAt).toBeLessThan(250);
      expect(answer.answeredAt! - answer.sentAt).toBeLessThan(500);
      expect(Math.max(...heldNow.map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      expect(memoryWhenHeld?.stopUnreadAt).toBeInstanceOf(Date);
      expect(memoryWhenHeld?.stopAcceptedAt ?? null).toBeNull();
      const row = await until(() => storage.getRetestWatch(runId), (one) => one?.stopUnreadAt != null, 5_000);
      expect(row!.stopUnreadAt).toBeInstanceOf(Date);
      expect(row!.stopAcceptedAt ?? null).toBeNull();
      const logs = await (await fetch(`${base}/api/logs`, { headers: { cookie } })).json();
      expect(logs.filter((one: { action: string; details: { runId?: string; via?: string } }) =>
        one.details?.runId === runId && one.details?.via === "retest_stop").map((one: { action: string }) => one.action))
        .toEqual(["abort_sent_answer_unread"]);
    } finally {
      await knob("__abortBodyHang", { hang: false });
      engineModule.engineTimeouts.abortBodyMs = abortBodyMs;
      watcher.halt();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r(null)));
    }
  }, 60_000);
  it("a scan's Stop: it reaches the engine within 250 ms and is answered within 500 ms; its record follows", async () => {
    const runId = "held-store-scan";
    const { server, base, cookie, watcher, testId } = await aDashboardWatchingARetest(runId);
    try {
      const { answer, reached, heldNow } = await pressWhileTheStoreIsHeld(base, cookie, `/api/scans/${testId}/abort`, `scan-of-${runId}`, watcher);
      expect(answer.error).toBeUndefined();
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ stopped: true, runId: `scan-of-${runId}` });
      expect(reached, "the Stop reached the engine").toBeDefined();
      expect(reached!.at - answer.sentAt).toBeLessThan(250);
      expect(answer.answeredAt! - answer.sentAt).toBeLessThan(500);
      expect(Math.max(...heldNow.map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      const logs = await (await fetch(`${base}/api/logs`, { headers: { cookie } })).json();
      expect(logs.filter((one: { action: string; details: { runId?: string; via?: string } }) =>
        one.details?.runId === `scan-of-${runId}` && one.details?.via === "stop").map((one: { action: string }) => one.action)).toEqual(["aborted"]);
    } finally {
      watcher.halt();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r(null)));
    }
  }, 60_000);
});
