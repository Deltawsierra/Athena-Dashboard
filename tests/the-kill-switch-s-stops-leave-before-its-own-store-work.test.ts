import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import dc from "diagnostics_channel";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import http, { type Server, type IncomingMessage } from "http";
import { Duplex } from "stream";
import type { AddressInfo } from "net";
import Database from "better-sqlite3";
import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";
import { noteDatabase, releaseAndRemove } from "./helpers/databases-in-use";
import { aStoreThatCanBeHeld, type HeldStore } from "./helpers/held-store";
import { NOT_KNOWN_STATUS } from "../shared/engine-record";

/**
 * SAFETY: the kill switch's stops leave this process before any store work of
 * its own -- its read of the tests table, and the write of its flag.
 *
 * better-sqlite3 runs each statement on the event loop, for as long as the
 * disk takes. Node opens a request's connection, and writes its bytes, only
 * once the turn that made the request is over. The kill switch made every stop
 * it knew of from memory, and then, in the same turn, read the tests table
 * (its first page is a statement run in the call), and wrote its flag a few
 * microtasks later. A disk that stalled as it was pressed held that turn, and
 * every stop in it: with the store held 3 s from the press, its stops reached
 * the engine after 3001 and 3003 ms (DASH-STORE-OFF-THE-LOOP, fact 1.3). Now
 * the read and the write wait until every stop the press has sent has been
 * written (each request's `finish`), and the flag also until the stops of the
 * scans the read found have been. Whom it stops is unchanged.
 *
 * The store is held as a stalled disk holds it (tests/helpers/held-store.ts).
 * The engine (tests/helpers/engine-in-its-own-process.cjs) and the person
 * (tests/helpers/a-person-in-their-own-process.cjs) are each in a process of
 * their own, so each times by its own clock when a stop reached it and when the
 * answer came, whatever this process's loop is doing. The bound is the one a
 * stop is held to elsewhere ("resuming never delays a stop",
 * tests/a-retest-verdict-survives-a-restart-and-is-filed-once.test.ts): the
 * engine within 250 ms of the press.
 */

const HELD_MS = 3_000;
const REACH_MS = 250;

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

/**
 * A dashboard on a fresh SQLite file, listening, its admin signed in, with what
 * may be running: a retest it watches (`runId`); a scan it holds in memory as
 * running, and one it holds as not known to the engine; and a scan only the
 * database records as running -- another dashboard's, written on its own
 * connection after this one last read the table. And a scan that has ended,
 * which nothing stops.
 */
async function aDashboard(runId: string, alsoRunning: string[] = []) {
  process.env.ATHENA_STORAGE = "sqlite";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-ks-first-"));
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
  const client = await storage.createClient({ name: "Held", company: "Held", email: "h@h.test" });
  const scan = (status: string, run: string) => storage.createTest({
    clientId: client.id, testType: "vulnerability-scan", status,
    findings: { runId: run, target: "https://offline.invalid/", results: [] },
  });
  const ended = await scan("completed", `scan-of-${runId}`);
  const inMemory = await scan("running", `ks-mem-${runId}`);
  const notKnown = await scan(NOT_KNOWN_STATUS, `ks-notknown-${runId}`);
  for (const run of alsoRunning) await scan("running", run);
  // As the console's poll of /api/tests has done: the tests are in memory.
  await storage.getAllTests();
  const elsewhere = `elsewhere-${runId}`;
  const raw = new Database(process.env.ATHENA_DB_PATH!);
  raw.prepare(`INSERT INTO tests (id, client_id, test_type, status, started_at, completed_at, summary, findings,
    vulnerabilities_found, critical_count, high_count, medium_count, low_count, executed_by, is_sample)
    VALUES (@id, @clientId, 'vulnerability-scan', 'running', @now, NULL, 'elsewhere', @findings, 0, 0, 0, 0, 0, NULL, 0)`)
    .run({ id: elsewhere, clientId: client.id, now: Date.now(), findings: JSON.stringify({ runId: `ks-elsewhere-${runId}`, target: "https://offline.invalid/", results: [] }) });
  raw.close();
  expect(storage.peekTest(elsewhere)).toBeUndefined();
  const now = new Date();
  await storage.createRetestWatch({
    engineRunId: runId, testId: ended.id, clientId: client.id, twinId: 1, findingId: null, engagementRef: null,
    requestedBy: null, requestedFrom: null, startedAt: now, deadlineAt: new Date(now.getTime() + 3_600_000),
    state: "running", engineState: "running", reason: null, error: null, lastReadAt: null, lastReadError: null,
    stopAcceptedAt: null, stopUnreadAt: null, endedAt: null, result: null,
  });
  const watcher = app.locals.retestWatcher as import("../server/retests").RetestWatcher;
  watcher.resume();
  await until(() => watcher.peek(runId), (row) => row !== undefined, 5_000);
  expect(watcher.peek(runId)).toBeDefined();
  expect(storage.peekTest(elsewhere)).toBeUndefined();
  const runs = {
    retest: runId, inMemory: `ks-mem-${runId}`, notKnown: `ks-notknown-${runId}`, elsewhere: `ks-elsewhere-${runId}`,
    ended: `scan-of-${runId}`, listed: `ks-listed-${runId}`,
  };
  const tests = { ended: ended.id, inMemory: inMemory.id, notKnown: notKnown.id, elsewhere };
  const engineModule = await import("../server/engine");
  return { server, base, cookie, storage, watcher, runs, tests, engineModule };
}
type Dashboard = Awaited<ReturnType<typeof aDashboard>>;

async function close(dash: Dashboard) {
  vi.restoreAllMocks();
  store.holdFor(0);
  await fetch(`${dash.base}/api/ai-control`, {
    method: "PATCH", headers: { cookie: dash.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ killSwitchEnabled: false, systemStatus: "operational" }),
  });
  dash.watcher.halt();
  dash.server.closeAllConnections?.();
  await new Promise((r) => dash.server.close(() => r(null)));
}

/**
 * The person presses the kill switch, and the store is held for HELD_MS: from
 * the moment the press reaches the dashboard (`arrival`), or from the moment
 * the flag's write starts (`flag`), or not at all. Each run in `runIds` is
 * waited for at the engine; how long after the press each reached it is
 * returned, with every abort the engine got from this press.
 */
async function press(dash: Dashboard, hold: "arrival" | "flag" | null, runIds: string[]) {
  const arrived = (message: unknown) => {
    const req = (message as { request: IncomingMessage }).request;
    if (hold === "arrival" && req.method === "PATCH" && req.url === "/api/ai-control") store.holdFor(HELD_MS);
  };
  dc.subscribe("http.server.request.start", arrived);
  let flagWritten: number | null = null;
  if (hold === "flag") {
    // On the store's own class, under its busy-retry wrapper (storage-sqlite.ts withBusyRetry), so the write
    // runs when and as the app runs it: held from the moment the flag's write starts.
    const own = Object.getPrototypeOf(dash.storage) as { updateAIControlSettings: (fields: Record<string, unknown>) => Promise<unknown> };
    const write = own.updateAIControlSettings;
    vi.spyOn(own, "updateAIControlSettings").mockImplementation(function (this: unknown, fields: Record<string, unknown>) {
      if (fields.killSwitchEnabled === true && flagWritten === null) {
        flagWritten = Date.now();
        store.holdFor(HELD_MS);
      }
      return write.call(this, fields);
    });
  }
  const heldBefore = store.held.length;
  const callsBefore = engineCalls.length;
  try {
    const id = `press-${Date.now()}-${Math.random()}`;
    person.stdin!.write(JSON.stringify({
      id, method: "PATCH", url: `${dash.base}/api/ai-control`, cookie: dash.cookie, body: { killSwitchEnabled: true },
    }) + "\n");
    const answer = (await until(() => answers.find((one) => one.id === id), (one) => one !== undefined, HELD_MS + 15_000))!;
    const aborts = () => engineCalls.slice(callsBefore).filter((one) => /^POST \/api\/scans\/[^/]+\/abort$/.test(one.line));
    await until(() => aborts(), (all) => runIds.every((runId) => all.some((one) => one.line === `POST /api/scans/${runId}/abort`)), 5_000);
    if (hold !== null) await until(() => Date.now(), () => store.held.length > heldBefore, HELD_MS + 5_000);
    const reach = new Map<string, number>();
    for (const one of aborts()) {
      const runId = decodeURIComponent(/^POST \/api\/scans\/([^/]+)\/abort$/.exec(one.line)![1]);
      if (!reach.has(runId)) reach.set(runId, one.at - answer.sentAt);
    }
    const sentTo = aborts().map((one) => decodeURIComponent(/^POST \/api\/scans\/([^/]+)\/abort$/.exec(one.line)![1]));
    console.log(`[kill switch, held: ${hold ?? "nothing"}] reached the engine after ` +
      `${[...reach].map(([runId, ms]) => `${runId} ${ms} ms`).join(", ")}; answered after ${answer.answeredAt! - answer.sentAt} ms`);
    return { answer, reach, sentTo, heldNow: store.held.slice(heldBefore), flagWritten };
  } finally {
    dc.unsubscribe("http.server.request.start", arrived);
    store.holdFor(0);
  }
}

describe("the kill switch's stops leave before its own store work", () => {
  it("the store held 3 s from the press: every stop it knows of in memory reaches the engine within 250 ms; a scan only the database records is stopped once the read is in, as before", async () => {
    const dash = await aDashboard("ks-first-held");
    const { runs, tests } = dash;
    try {
      await knob("__active", { active: [] });
      const { answer, reach, sentTo, heldNow } = await press(dash, "arrival", [runs.retest, runs.inMemory, runs.notKnown, runs.elsewhere]);
      expect(answer.error).toBeUndefined();
      expect(answer.status).toBe(200);
      // The disk held the store after the press arrived: a statement waited out (nearly) the whole hold.
      expect(Math.max(...heldNow.map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      for (const runId of [runs.retest, runs.inMemory, runs.notKnown]) {
        expect(reach.get(runId), `the stop of ${runId} reached the engine`).toBeDefined();
        expect(reach.get(runId)!, `the stop of ${runId}`).toBeLessThan(REACH_MS);
      }
      // Not known in memory: it can only be found by the read, and is stopped once that is in.
      expect(reach.get(runs.elsewhere), "the database's scan was sent its stop").toBeDefined();
      expect([...sentTo].sort()).toEqual([runs.retest, runs.inMemory, runs.notKnown, runs.elsewhere].sort());
      expect(answer.body.stops.listed).toBe(true);
      expect((answer.body.stops.scans as Array<{ testId: string }>).map((one) => one.testId).sort())
        .toEqual([tests.inMemory, tests.notKnown, tests.elsewhere].sort());
    } finally {
      await close(dash);
    }
  }, 60_000);

  it("the flag's write held 3 s: every stop -- the scan only the database records too -- reaches the engine within 250 ms", async () => {
    const dash = await aDashboard("ks-first-flag");
    const { runs } = dash;
    try {
      await knob("__active", { active: [] });
      const { answer, reach, sentTo, heldNow, flagWritten } = await press(dash, "flag", [runs.retest, runs.inMemory, runs.notKnown, runs.elsewhere]);
      expect(answer.error).toBeUndefined();
      expect(flagWritten, "the flag was written").not.toBeNull();
      expect(Math.max(...heldNow.map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      for (const runId of [runs.retest, runs.inMemory, runs.notKnown, runs.elsewhere]) {
        expect(reach.get(runId), `the stop of ${runId} reached the engine`).toBeDefined();
        expect(reach.get(runId)!, `the stop of ${runId}`).toBeLessThan(REACH_MS);
      }
      expect([...sentTo].sort()).toEqual([runs.retest, runs.inMemory, runs.notKnown, runs.elsewhere].sort());
      // The flag is stored, and the switch reads engaged.
      expect((await dash.storage.getAIControlSettings())!.killSwitchEnabled).toBe(true);
    } finally {
      await close(dash);
    }
  }, 60_000);

  for (const held of [false, true]) {
    it(`whom it stops is unchanged${held ? ", the store held 3 s from the press" : ""}: one stop to each run that may be running -- from memory, the database and the engine's list -- and none to one that ended${held ? "" : "; its flag is stored once its stops have left, not once they are answered"}`, async () => {
      const dash = await aDashboard(held ? "ks-who-held" : "ks-who");
      const { runs, tests } = dash;
      try {
        // The engine lists a run nothing here records, and the scan held in memory.
        await knob("__active", { active: [
          { run_id: runs.listed, target: "https://listed.invalid/", state: "running" },
          { run_id: runs.inMemory, target: "https://offline.invalid/", state: "running" },
        ] });
        // Each stop is answered 1.5 s after it arrives.
        await knob("__abortDelay", { ms: 1_500 });
        const pressedAt = Date.now();
        let flagStoredAfter: number | null = null;
        let answeredBeforeTheFlag = false;
        const watching = held ? Promise.resolve() : (async () => {
          const stored = await until(() => dash.storage.getAIControlSettings(), (one) => one?.killSwitchEnabled === true, 5_000);
          if (stored?.killSwitchEnabled === true) flagStoredAfter = Date.now() - pressedAt;
          answeredBeforeTheFlag = answers.some((one) => one.sentAt >= pressedAt - 50 && one.answeredAt !== undefined);
        })();
        const everyRun = [runs.retest, runs.inMemory, runs.notKnown, runs.elsewhere, runs.listed];
        const { answer, sentTo } = await press(dash, held ? "arrival" : null, everyRun);
        await watching;
        expect(answer.error).toBeUndefined();
        expect(answer.status).toBe(200);
        // One stop each, to exactly these: never the scan that ended.
        expect([...sentTo].sort()).toEqual([...everyRun].sort());
        expect(sentTo).not.toContain(runs.ended);
        // Said as before: the recorded scans as scans, the engine's run and the retest as the engine's runs.
        expect(answer.body.stops.listed).toBe(true);
        expect((answer.body.stops.scans as Array<{ testId: string }>).map((one) => one.testId).sort())
          .toEqual([tests.inMemory, tests.notKnown, tests.elsewhere].sort());
        expect(answer.body.engineRuns.listed).toBe(true);
        expect((answer.body.engineRuns.runs as Array<{ runId: string }>).map((one) => one.runId).sort())
          .toEqual([runs.listed, runs.retest].sort());
        if (!held) {
          // The flag waits for the stops to leave, never for the engine to answer them (1.5 s).
          expect(flagStoredAfter, "the flag was stored").not.toBeNull();
          expect(flagStoredAfter!).toBeLessThan(1_000);
          expect(answeredBeforeTheFlag, "the flag was stored before the stops were answered").toBe(false);
        }
      } finally {
        await knob("__abortDelay", { ms: 0 });
        await knob("__active", { active: [] });
        await close(dash);
      }
    }, 60_000);
  }
});

/**
 * The kill switch's own store work waits for its stops to leave for at most
 * STOPS_LEAVE_WAIT_MS after the press (server/routes.ts): a stop whose
 * connection never opens -- here, its request is given a socket that never
 * takes its bytes, as a connect no answer ever comes to -- held the database's
 * read and the flag's write until its call deadline (engineTimeouts.callMs; 5 s
 * here, 20 s in the app), and the database-only scans' stops with them.
 */
const STOPS_LEAVE_WAIT_MS = 1_000;

/** Every request this process sends to `path` from now on goes out on a socket that never takes a byte. Returns the undo. */
function aConnectionThatNeverOpens(path: string): () => void {
  const request = http.request;
  const patched = function (this: unknown, ...args: unknown[]) {
    const [url, options] = args as [unknown, Record<string, unknown> | undefined];
    const target = url instanceof URL ? url.pathname : typeof url === "string" ? new URL(url).pathname : null;
    if (target === path && options && typeof options === "object") {
      const never = new Duplex({ read() { /* nothing ever arrives */ }, write() { /* the bytes never leave */ } });
      // No agent: only then does the request take its socket from createConnection (node:http ClientRequest).
      args[1] = { ...options, agent: undefined, createConnection: () => never };
    }
    return (request as (...a: unknown[]) => http.ClientRequest).apply(this, args);
  };
  (http as { request: unknown }).request = patched;
  return () => { (http as { request: unknown }).request = request; };
}

describe("a stop whose connection never opens holds the kill switch's own store work at most 1 s", () => {
  for (const held of [false, true]) {
    it(held
      ? "the store held 3 s from the press: its read of the tests table starts within 1 s of the press, and every other stop still reaches the engine within 250 ms"
      : "its read of the tests table and the write of its flag both start within 1 s of the press, and the scan only the database records is sent its stop", async () => {
      const stuck = held ? "ks-stuck-held" : "ks-stuck";
      const dash = await aDashboard(held ? "ks-cap-held" : "ks-cap", [stuck]);
      const { runs, engineModule } = dash;
      const callMs = engineModule.engineTimeouts.callMs;
      engineModule.engineTimeouts.callMs = 5_000;
      const undo = aConnectionThatNeverOpens(`/api/scans/${stuck}/abort`);
      // When the kill switch's read and its flag's write start: on the store's own class, under its busy-retry
      // wrapper, as the app calls them -- before any statement of theirs is held.
      const own = Object.getPrototypeOf(dash.storage) as {
        getAllTests: () => Promise<unknown>; updateAIControlSettings: (fields: Record<string, unknown>) => Promise<unknown>;
      };
      const read = own.getAllTests;
      const write = own.updateAIControlSettings;
      let readAt: number | null = null;
      let flagAt: number | null = null;
      vi.spyOn(own, "getAllTests").mockImplementation(function (this: unknown) {
        readAt ??= Date.now();
        return read.call(this);
      });
      vi.spyOn(own, "updateAIControlSettings").mockImplementation(function (this: unknown, fields: Record<string, unknown>) {
        if (fields.killSwitchEnabled === true) flagAt ??= Date.now();
        return write.call(this, fields);
      });
      try {
        await knob("__active", { active: [] });
        const { answer, reach, sentTo } = await press(dash, held ? "arrival" : null, [runs.retest, runs.inMemory, runs.notKnown, runs.elsewhere]);
        console.log(`[kill switch, a stop that never leaves${held ? ", store held" : ""}] the tests read started after ` +
          `${readAt === null ? "never" : readAt - answer.sentAt} ms, the flag's write after ${flagAt === null ? "never" : flagAt - answer.sentAt} ms`);
        expect(answer.error).toBeUndefined();
        expect(sentTo, "the stop whose connection never opens never reached the engine").not.toContain(stuck);
        expect(readAt, "the tests table was read").not.toBeNull();
        expect(readAt! - answer.sentAt, "the tests read started").toBeLessThan(STOPS_LEAVE_WAIT_MS + REACH_MS);
        for (const runId of [runs.retest, runs.inMemory, runs.notKnown]) {
          expect(reach.get(runId), `the stop of ${runId} reached the engine`).toBeDefined();
          expect(reach.get(runId)!, `the stop of ${runId}`).toBeLessThan(REACH_MS);
        }
        expect(reach.get(runs.elsewhere), "the database's scan was sent its stop").toBeDefined();
        if (!held) {
          expect(flagAt, "the flag was written").not.toBeNull();
          expect(flagAt! - answer.sentAt, "the flag's write started").toBeLessThan(STOPS_LEAVE_WAIT_MS + REACH_MS);
          expect(reach.get(runs.elsewhere)!, "the database's scan's stop").toBeLessThan(STOPS_LEAVE_WAIT_MS + REACH_MS);
        }
        // The stop that never left is said as not taken, never as stopped.
        const scans = answer.body.stops.scans as Array<{ runId: string; stopped: boolean }>;
        expect(scans.find((one) => one.runId === stuck)).toMatchObject({ stopped: false });
      } finally {
        undo();
        engineModule.engineTimeouts.callMs = callMs;
        await close(dash);
      }
    }, 60_000);
  }
});
