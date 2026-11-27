import path from "path";
import fs from "fs";
import os from "os";

/**
 * What the event loop knows of the database, without loading its driver.
 *
 * The store runs on a worker thread of its own (store-client.ts): better-sqlite3, and every statement, are loaded
 * and run there (db-sqlite.ts, store-worker.ts), and never on the event loop -- a statement there held every
 * request, a Stop included, for as long as a stalled disk held it. What the loop still reads of the database lives
 * here: where it is, what opening it found (openReport, said on the Settings screen) and what its checkpointer
 * thread is doing, mirrored from the store's thread; and the store threads to end before its files are removed.
 * db-sqlite.ts re-exports all of it, for the store's thread and the tests.
 */

/**
 * Database location, in priority order:
 *   1. ATHENA_DB_PATH         explicit file path, or ":memory:" for tests
 *   2. ATHENA_USER_DATA       directory supplied by the Electron main process
 *   3. ~/.athena-ai/athena.db when running inside Electron without (2)
 *   4. ./athena.db            project root for local development
 */
export function resolveDbPath(): string {
  if (process.env.ATHENA_DB_PATH) return process.env.ATHENA_DB_PATH;

  const userData = process.env.ATHENA_USER_DATA;
  if (userData) {
    fs.mkdirSync(userData, { recursive: true });
    return path.join(userData, "athena.db");
  }

  if (process.versions?.electron) {
    const dir = path.join(os.homedir(), ".athena-ai");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "athena.db");
  }

  return path.resolve(process.cwd(), "athena.db");
}

/**
 * What opening the database found and could not do, said rather than thrown:
 * a database that cannot open takes every Stop down with it.
 */
export const openReport: {
  duplicateEngineRunIds: string[];
  /** Backend scan uuids more than one test row names, which kept idx_tests_backend_scan from being created (createBackendScanIndex). */
  duplicateBackendScanIds: string[];
  /** Why idx_tests_backend_scan could not be created, when it could not for another reason (a findings cell that is not JSON); null when it was. */
  backendScanIndexNotCreated: string | null;
} = { duplicateEngineRunIds: [], duplicateBackendScanIds: [], backendScanIndexNotCreated: null };

/**
 * What the checkpointer is doing: `off` until its thread reports it is
 * running (SQLite checkpoints on the loop meanwhile, as by default), `on`
 * once it runs, and `failed` (with why) if it could not start or stopped --
 * then every commit is synced when it is made again (FULL), and SQLite's own
 * checkpoints on the loop are switched back on: no commit waits on the
 * thread for its sync, and the log never grows without bound.
 */
export const checkpointer: { state: "off" | "on" | "failed"; detail: string } = { state: "off", detail: "" };

/**
 * What the checkpointer thread's turns came to, by outcome (CHECKPOINTER_SOURCE):
 * `skipped: busy` (another connection held the write lock: the turn ended at
 * once), `checkpointed part of the log`, `checkpointed`, `restarted` (the log
 * started over by the thread's own write). An idle turn is not counted.
 * `last` is the latest, with how long the thread's ask for the write lock took
 * (`lockMs`): it never waits on the lock, so that is the time a refusal takes.
 */
export const checkpointerTurns: { counts: Record<string, number>; last: { outcome: string; lockMs: number } | null } = { counts: {}, last: null };

/** Told whenever `checkpointer` or `checkpointerTurns` changes: the store's worker thread says so to the event loop (store-worker.ts). */
const checkpointerWatchers = new Set<() => void>();

/** Be told of every change of the checkpointer's state and turns; the answer stops it. */
export function watchCheckpointer(changed: () => void): () => void {
  checkpointerWatchers.add(changed);
  return () => {
    checkpointerWatchers.delete(changed);
  };
}

/** Tell every watcher the checkpointer's state or turns changed (db-sqlite.ts, where they change). */
export function checkpointerChanged(): void {
  for (const changed of Array.from(checkpointerWatchers)) {
    try {
      changed();
    } catch {
      // A watcher's failure is its own.
    }
  }
}

/**
 * The store worker threads (store-client.ts) started by the modules loaded
 * with this copy of the module, each with how to end it: a thread holds the
 * database's connection and its checkpointer thread's (store-worker.ts).
 */
const storeThreads = new Set<() => Promise<void>>();

/** Note a store worker thread for closeDatabase to end; the answer forgets it again (once it has ended). */
export function noteStoreThread(end: () => Promise<void>): () => void {
  storeThreads.add(end);
  return () => {
    storeThreads.delete(end);
  };
}

/** End every store thread noted (closeDatabase, db-sqlite.ts); each is forgotten. Never throws. */
export async function endStoreThreads(): Promise<void> {
  const ending: Array<Promise<unknown>> = [];
  for (const end of Array.from(storeThreads)) {
    storeThreads.delete(end);
    ending.push(end().catch(() => undefined));
  }
  await Promise.all(ending);
}
