import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { closeDatabases, noteDatabase, openFilesUnder } from "./helpers/databases-in-use";

/**
 * closeDatabase (server/db-sqlite.ts) is what lets a test remove the SQLite
 * file it used. Windows will not remove or rename a file while a handle on it
 * is open, and the server leaves two: its own connection, and the connection
 * of the checkpointer thread. These tests check that closing ends the thread
 * without that being read as the thread failing, that no handle is left (the
 * file can be renamed; on Linux the process's open files are listed too), and
 * that the next query opens the database again.
 *
 * The real worker threads are recorded rather than replaced: a Worker's
 * threadId is -1 once its thread has exited.
 */

const made = vi.hoisted(() => ({ workers: [] as Array<{ threadId: number }> }));
vi.mock("worker_threads", async (importOriginal) => {
  const real = await importOriginal<typeof import("worker_threads")>();
  class RecordedWorker extends real.Worker {
    constructor(...args: ConstructorParameters<typeof real.Worker>) {
      super(...args);
      made.workers.push(this);
    }
  }
  return { ...real, default: { ...real, Worker: RecordedWorker }, Worker: RecordedWorker };
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ok: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await sleep(20);
}

const madeDirs: string[] = [];
function aDatabaseFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-close-"));
  madeDirs.push(dir);
  const file = path.join(dir, "athena.db");
  process.env.ATHENA_DB_PATH = file;
  return { dir, file };
}

type Copy = typeof import("../server/db-sqlite");
/** A fresh copy of the module, as `vi.resetModules()` makes for a test file that boots the server more than once. */
async function aCopy(): Promise<Copy> {
  vi.resetModules();
  await noteDatabase();
  return await import("../server/db-sqlite");
}

beforeEach(() => {
  made.workers.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  await closeDatabases();
  vi.restoreAllMocks();
});
afterAll(() => {
  delete process.env.ATHENA_DB_PATH;
  // Plain removal: a handle left open by anything above fails it on Windows (EBUSY).
  for (const dir of madeDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("closeDatabase", () => {
  it("ends the checkpointer thread, and an exit it caused is not read as a failure", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    aDatabaseFile();
    const dbm = await aCopy();
    dbm.openDatabase();
    await until(() => dbm.checkpointer.state === "on");
    expect(dbm.checkpointer.state).toBe("on");
    expect(made.workers).toHaveLength(1);
    expect(made.workers[0].threadId).toBeGreaterThan(0); // running

    await dbm.closeDatabase();

    expect(made.workers[0].threadId).toBe(-1); // ended
    expect(dbm.checkpointer).toEqual({ state: "off", detail: "" });
    await sleep(200); // a thread exit read as a failure would have set "failed" by now
    expect(dbm.checkpointer).toEqual({ state: "off", detail: "" });
    expect(said.mock.calls.filter((one) => /checkpointer thread is not running/.test(String(one[0])))).toEqual([]);
  }, 30_000);

  it("does the same when the thread has not yet reported that it is running", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    aDatabaseFile();
    const dbm = await aCopy();
    dbm.openDatabase();
    expect(dbm.checkpointer.state).toBe("off");

    await dbm.closeDatabase();

    expect(made.workers[0].threadId).toBe(-1);
    await sleep(200); // its "running" message, if one was on the way, is not acted on
    expect(dbm.checkpointer).toEqual({ state: "off", detail: "" });
    expect(said).not.toHaveBeenCalled();
  }, 30_000);

  it("leaves no handle on the file: it can be renamed, and on Linux no open file is left under its directory", async () => {
    const { dir, file } = aDatabaseFile();
    const dbm = await aCopy();
    dbm.openDatabase();
    dbm.sqlite.exec("CREATE TABLE probe (n INTEGER); INSERT INTO probe VALUES (7);");
    await until(() => dbm.checkpointer.state === "on");
    // The premise, where the process's open files can be listed: before closing there are some.
    if (process.platform === "linux") expect(openFilesUnder([dir]).length).toBeGreaterThan(0);

    await dbm.closeDatabase();

    expect(openFilesUnder([dir])).toEqual([]);
    const moved = `${file}.moved`;
    fs.renameSync(file, moved); // on Windows this is EBUSY while any connection, the thread's included, is open
    expect(fs.existsSync(moved)).toBe(true);
    fs.renameSync(moved, file);
  }, 30_000);

  it("is followed by a database that opens again on the next query, with its rows, and a thread that reports running again", async () => {
    aDatabaseFile();
    const dbm = await aCopy();
    dbm.sqlite.exec("CREATE TABLE probe (n INTEGER); INSERT INTO probe VALUES (7);");
    await until(() => dbm.checkpointer.state === "on");
    await dbm.closeDatabase();
    expect(dbm.checkpointer.state).toBe("off");

    expect(dbm.sqlite.prepare("SELECT n FROM probe").get()).toEqual({ n: 7 });

    await until(() => dbm.checkpointer.state === "on");
    expect(dbm.checkpointer.state).toBe("on");
    expect(made.workers).toHaveLength(2);
    expect(made.workers[0].threadId).toBe(-1);
    expect(made.workers[1].threadId).toBeGreaterThan(0);
  }, 30_000);

  it("does not throw when nothing is open, twice over, or when the connection was already closed", async () => {
    aDatabaseFile();
    const dbm = await aCopy();
    await expect(dbm.closeDatabase()).resolves.toBeUndefined();
    await expect(dbm.closeDatabase()).resolves.toBeUndefined();
    dbm.openDatabase();
    dbm.sqlite.close(); // closed behind its back
    await expect(dbm.closeDatabase()).resolves.toBeUndefined();
    expect(dbm.sqlite.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
  }, 30_000);
});

describe("closeDatabases (the test helper) closes every copy of the module a file loaded", () => {
  it("both copies, each with a connection and a thread of its own, release their files", async () => {
    const first = aDatabaseFile();
    const a = await aCopy();
    a.openDatabase();
    await until(() => a.checkpointer.state === "on");
    const second = aDatabaseFile();
    const b = await aCopy();
    b.openDatabase();
    await until(() => b.checkpointer.state === "on");
    expect(a).not.toBe(b);
    expect(made.workers).toHaveLength(2);
    if (process.platform === "linux") {
      expect(openFilesUnder([first.dir]).length).toBeGreaterThan(0);
      expect(openFilesUnder([second.dir]).length).toBeGreaterThan(0);
    }

    await closeDatabases();

    expect(made.workers.map((one) => one.threadId)).toEqual([-1, -1]);
    expect(openFilesUnder([first.dir, second.dir])).toEqual([]);
    for (const { file } of [first, second]) {
      fs.renameSync(file, `${file}.moved`);
      expect(fs.existsSync(`${file}.moved`)).toBe(true);
    }
  }, 30_000);
});
