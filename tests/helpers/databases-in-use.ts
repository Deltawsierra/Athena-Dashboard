import fs from "fs";
import path from "path";
import type * as DbSqlite from "../../server/db-sqlite";

/**
 * Releasing the SQLite files a test file used, so that its directories can be
 * removed when it is done.
 *
 * Windows will not remove a file while a handle on it is open (EBUSY). A test
 * file that boots the server on a SQLite file leaves two handles on it: the
 * server's connection, and the connection of the checkpointer thread
 * (server/db-sqlite.ts). And every `vi.resetModules()` makes the next import
 * load a NEW copy of server/db-sqlite, with a connection and a thread of its
 * own, so one file can hold several. `noteDatabase()` remembers each copy;
 * `releaseAndRemove()` closes them all, and only then removes the directories.
 */

const copies = new Set<typeof DbSqlite>();

/**
 * Remember the copy of server/db-sqlite the modules loaded from now on will
 * use. Call it after each `vi.resetModules()`, and once before the first
 * import of the server in a file that never resets. Importing it opens no
 * database: the connection is made on the first query.
 */
export async function noteDatabase(): Promise<void> {
  copies.add(await import("../../server/db-sqlite"));
}

/** Close every copy noted. The copies are forgotten; a later `noteDatabase()` starts the list again. */
export async function closeDatabases(): Promise<void> {
  for (const copy of [...copies]) await copy.closeDatabase();
  copies.clear();
}

/**
 * The files this process still has open under `dirs`. Only Linux can say (the
 * process's own descriptors are listed under /proc/self/fd); elsewhere the
 * answer is an empty list, and the removal that follows is what finds a
 * handle left open.
 */
export function openFilesUnder(dirs: string[]): string[] {
  if (process.platform !== "linux") return [];
  const roots = dirs.flatMap((dir) => {
    try {
      return [dir, fs.realpathSync(dir)];
    } catch {
      return [dir];
    }
  });
  const found: string[] = [];
  for (const fd of fs.readdirSync("/proc/self/fd")) {
    let target: string;
    try {
      target = fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      continue; // closed since it was listed (the listing's own descriptor, for one)
    }
    if (roots.some((root) => target === root || target.startsWith(root + path.sep))) found.push(target);
  }
  return found;
}

/**
 * For a test file's `afterAll`: close every database noted, say so on Linux if
 * a file under `dirs` is still open (a handle the test opened itself and did
 * not close), then remove `dirs`. The removal is plain: a handle left open
 * fails it, on Windows with EBUSY, rather than being retried or ignored.
 * `dirs` is emptied.
 */
export async function releaseAndRemove(dirs: string[]): Promise<void> {
  await closeDatabases();
  const open = openFilesUnder(dirs);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (open.length > 0) throw new Error(`files were still open when their directory was removed: ${open.join(", ")}`);
}
