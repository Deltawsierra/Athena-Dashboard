import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { releaseAndRemove } from "./helpers/databases-in-use";

/**
 * tests/helpers/databases-in-use.ts is what a test file calls, in its
 * `afterAll`, to close its databases and remove their directories. Windows
 * refuses to remove a file while a handle on it is open (EBUSY), and that
 * refusal is the signal: a test file that left a database open must FAIL
 * there, not pass quietly with a directory left behind. So the removal is
 * plain -- not retried, not wrapped, nothing caught -- and these tests hold it
 * to that:
 *
 *   - an EBUSY from the removal reaches the caller as it was, once, with no
 *     retry options;
 *   - a database the test opened itself and did not close fails the helper:
 *     on Linux because it lists the process's open files, on Windows because
 *     the removal is refused.
 */

const made: string[] = [];
const open: Array<{ close: () => unknown }> = [];

function aDirectory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-held-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const one of open.splice(0)) {
    try {
      one.close();
    } catch {
      // Already closed.
    }
  }
  // Whatever a test left (a directory the helper could not remove, one it never reached) is removed here, once nothing is open.
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("releaseAndRemove", () => {
  it("removes the directories it is given, and empties the list", async () => {
    const dirs = [aDirectory(), aDirectory()];
    fs.writeFileSync(path.join(dirs[0], "athena.db"), "x");
    const given = [...dirs];

    await expect(releaseAndRemove(dirs)).resolves.toBeUndefined();

    expect(dirs).toEqual([]);
    expect(given.filter((dir) => fs.existsSync(dir))).toEqual([]);
  });

  it("fails with the removal's EBUSY as it was, after one plain removal: no retry, nothing caught", async () => {
    const dir = aDirectory();
    const busy = Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path.join(dir, "athena.db")}'`), { code: "EBUSY" });
    const removal = vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw busy;
    });

    const failure = await releaseAndRemove([dir]).then(() => undefined, (cause: unknown) => cause);

    expect(failure).toBe(busy);
    expect(removal).toHaveBeenCalledTimes(1);
    const [removed, options] = removal.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(removed).toBe(dir);
    expect(options).toEqual({ recursive: true, force: true });
    expect(options).not.toHaveProperty("maxRetries");
    expect(options).not.toHaveProperty("retryDelay");
  });

  it("fails on any other error from the removal as well", async () => {
    const dir = aDirectory();
    const denied = Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
    vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw denied;
    });

    await expect(releaseAndRemove([dir])).rejects.toBe(denied);
  });

  it("fails when a database the test opened itself and did not close is under a directory it removes", async () => {
    const dir = aDirectory();
    const file = path.join(dir, "athena.db");
    const held = new Database(file);
    open.push(held);
    held.exec("CREATE TABLE probe (n INTEGER)");

    const failure = await releaseAndRemove([dir]).then(() => undefined, (cause: unknown) => cause);

    // Only these two can say: Linux lists the open files of the process, and Windows refuses the removal.
    if (process.platform === "linux") {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/files were still open when their directory was removed: .*athena\.db/);
    } else if (process.platform === "win32") {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as NodeJS.ErrnoException).code).toMatch(/^(EBUSY|EPERM)$/);
    }
  });

  it("does not fail for a database that was closed first", async () => {
    const dir = aDirectory();
    const file = path.join(dir, "athena.db");
    const closed = new Database(file);
    closed.exec("CREATE TABLE probe (n INTEGER)");
    closed.close();

    await expect(releaseAndRemove([dir])).resolves.toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
  });
});
