import { expect, vi } from "vitest";
import dc from "diagnostics_channel";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server, IncomingMessage } from "http";
import type { AddressInfo } from "net";
import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "../test-admin";
import { noteDatabase, releaseAndRemove } from "./databases-in-use";
import { aStoreThatCanBeHeld, type HeldStore } from "./held-store";

/**
 * A dashboard on a SQLite store a stalled disk can hold (held-store.ts), with
 * the engine (engine-in-its-own-process.cjs) and the person
 * (a-person-in-their-own-process.cjs) each in a process of their own, so each
 * times by its own clock when a stop reached it and when the answer came,
 * whatever this process is doing. For the files that press a Stop while the
 * store is held (tests/a-stop-that-arrives-behind-a-held-statement-...,
 * tests/a-timer-fires-and-an-account-read-is-bounded-..., and the like).
 */

export type Answer = { id: string; sentAt: number; answeredAt?: number; status?: number; body?: any; error?: string };
export type Press = { method: string; path: string; body?: unknown; extra?: Record<string, string>; cookie?: string | null; afterMs?: number };

export interface Around {
  store: HeldStore;
  engineCalls: Array<{ line: string; at: number }>;
  answers: Answer[];
  enginePort: number;
  /** Send `press` from the person's process; answers its id. */
  send(base: string, cookie: string | null, press: Press): string;
  /** Close every dashboard made, the engine and the person, and remove the files. */
  end(): Promise<void>;
}

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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(20);
    last = await read();
  }
  return last;
}

const madeDirs: string[] = [];

/** For a file's beforeAll: the held store, the engine and the person. */
export async function aroundAHeldStore(): Promise<Around> {
  const store = aStoreThatCanBeHeld();
  const engineCalls: Around["engineCalls"] = [];
  const answers: Answer[] = [];
  const engine = spawn(process.execPath, [path.join(__dirname, "engine-in-its-own-process.cjs")], { stdio: ["ignore", "pipe", "inherit"] });
  let enginePort = 0;
  await new Promise<void>((ready) => lines(engine, (one) => {
    if (one.port) { enginePort = one.port; ready(); } else engineCalls.push(one);
  }));
  const person = spawn(process.execPath, [path.join(__dirname, "a-person-in-their-own-process.cjs")], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((ready) => lines(person, (one) => {
    if (one.ready) ready(); else answers.push(one);
  }));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${enginePort}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  let n = 0;
  return {
    store, engineCalls, answers, enginePort,
    send(base, cookie, press) {
      n += 1;
      const id = `${press.method} ${press.path} ${Date.now()} ${n}`;
      person.stdin!.write(JSON.stringify({
        id, method: press.method, url: `${base}${press.path}`, cookie: press.cookie === undefined ? cookie : press.cookie,
        body: press.body, extra: press.extra, afterMs: press.afterMs,
      }) + "\n");
      return id;
    },
    async end() {
      store.release();
      delete process.env.ATHENA_ENGINE_URL;
      delete process.env.ATHENA_ENGINE_KEY;
      engine.kill();
      person.kill();
      // Every database this file loaded is closed (Windows will not remove an open file), then the directories are removed.
      await releaseAndRemove(madeDirs);
      process.env.ATHENA_STORAGE = "memory";
      delete process.env.ATHENA_DB_PATH;
    },
  };
}

/**
 * A dashboard on a SQLite file (a fresh one, or `file` when given: another
 * dashboard's), listening, its admin signed in. When `runId` is given: a
 * client, a scan that has ended whose run is `scan-of-<runId>` (a scan's Stop
 * names it), a scan it holds in memory as running (`ks-<runId>`, the kill
 * switch's), every test read into memory as the console's poll does, and a
 * retest it watches (`runId`).
 */
export async function aDashboard(runId: string | null, file?: string) {
  process.env.ATHENA_STORAGE = "sqlite";
  if (file === undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-held-"));
    madeDirs.push(dir);
    process.env.ATHENA_DB_PATH = path.join(dir, "athena.db");
  } else {
    process.env.ATHENA_DB_PATH = file;
  }
  vi.resetModules();
  await noteDatabase();
  const { createApp } = await import("../../server/app");
  const { initializeDefaultData } = await import("../../server/init-data");
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
  const storage = (await import("../../server/storage-unified")).storage;
  const watcher = app.locals.retestWatcher as import("../../server/retests").RetestWatcher;
  const dbPath = process.env.ATHENA_DB_PATH!;
  if (runId === null) return { app, server, base, cookie, storage, watcher, dbPath, testId: "", clientId: "" };
  const client = await storage.createClient({ name: "Held", company: "Held", email: "h@h.test" });
  const test = await storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "completed",
    findings: { runId: `scan-of-${runId}`, target: "https://offline.invalid/", results: [] },
  });
  await storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status: "running",
    findings: { runId: `ks-${runId}`, target: "https://offline.invalid/", results: [] },
  });
  await storage.getAllTests();
  const now = new Date();
  await storage.createRetestWatch({
    engineRunId: runId, testId: test.id, clientId: client.id, twinId: 1, findingId: null, engagementRef: null,
    requestedBy: null, requestedFrom: null, startedAt: now, deadlineAt: new Date(now.getTime() + 3_600_000),
    state: "running", engineState: "running", reason: null, error: null, lastReadAt: null, lastReadError: null,
    stopAcceptedAt: null, stopUnreadAt: null, endedAt: null, result: null,
  });
  watcher.resume();
  await until(() => watcher.peek(runId), (row) => row !== undefined, 5_000);
  expect(watcher.peek(runId)).toBeDefined();
  return { app, server, base, cookie, storage, watcher, dbPath, testId: test.id, clientId: client.id };
}
export type Dashboard = Awaited<ReturnType<typeof aDashboard>>;

export async function close(dash: Dashboard): Promise<void> {
  dash.watcher.halt();
  dash.server.closeAllConnections?.();
  await new Promise((r) => dash.server.close(() => r(null)));
}

/** Hold the store for `ms` from the moment a request `method path` reaches this process (its request.start); the answer stops watching. */
export function holdFromTheArrivalOf(store: HeldStore, method: string, path: string, ms: number): () => void {
  const arrived = (message: unknown) => {
    const req = (message as { request: IncomingMessage }).request;
    if (req.method === method && req.url === path) store.holdFor(ms);
  };
  dc.subscribe("http.server.request.start", arrived);
  return () => dc.unsubscribe("http.server.request.start", arrived);
}

/** When each of `runIds` reached the engine after `sentAt` (the engine's clock), from `callsBefore` on; null for one it never reached. */
export async function reachOf(around: Around, callsBefore: number, sentAt: number, runIds: string[]): Promise<Array<number | null>> {
  const reached = await until(
    () => runIds.map((runId) => around.engineCalls.slice(callsBefore).find((one) => one.line === `POST /api/scans/${runId}/abort`)),
    (all) => all.every((one) => one !== undefined), 6_000);
  return reached.map((one) => (one ? one.at - sentAt : null));
}

export async function answerOf(around: Around, id: string, ms: number): Promise<Answer> {
  const answer = await until(() => around.answers.find((one) => one.id === id), (one) => one !== undefined, ms);
  expect(answer, `an answer to ${id}`).toBeDefined();
  return answer!;
}
