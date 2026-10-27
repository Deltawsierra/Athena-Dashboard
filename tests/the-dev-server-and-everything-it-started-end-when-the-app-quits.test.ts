import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const { endProcessTree, TASKKILL_TIMEOUT_MS } = createRequire(import.meta.url)("../end-process-tree.cjs") as {
  endProcessTree: (child: unknown, options?: Record<string, unknown>) => "taskkill" | "kill";
  TASKKILL_TIMEOUT_MS: number;
};

/**
 * In development the desktop shell starts the API with
 * `spawn("npm", ["run", "dev"], { shell: true })` and ends it when the app
 * quits. With a shell in between, the child it holds is the shell: on Windows
 * `child.kill()` ends that wrapper alone, and the server it started goes on
 * running, still holding its port and the SQLite file. end-process-tree.cjs
 * ends the whole tree there (`taskkill /PID <pid> /T /F`); on POSIX it is
 * still `child.kill()`.
 *
 * Two kinds of test. The first injects the platform and the spawner, so the
 * Windows branch runs on any machine: which command, which arguments, and
 * that a `taskkill` that fails still ends in `kill()` and never throws. The
 * second starts a real `shell: true` child that starts a long-running
 * grandchild, ends it through the helper, and asks the operating system
 * whether the shell, the process under it and the grandchild are gone. Run on
 * Linux it exercises the POSIX path; run on Windows it is the real tree kill.
 */

/** A stand-in for what `spawn` returns. `null` is a child with no pid, as when the spawn itself failed. */
function fakeChild(pid: number | null = 4242, killThrows = false) {
  return {
    pid: pid === null ? undefined : pid,
    kill: vi.fn(() => {
      if (killThrows) throw new Error("kill failed");
      return true;
    }),
  };
}

describe("the helper, with the platform and the spawner injected", () => {
  it("on Windows it runs taskkill for the child's pid with /T and /F, hidden and bounded, and nothing else", () => {
    const spawner = vi.fn(() => ({ status: 0 }));
    const child = fakeChild(4242);
    expect(endProcessTree(child, { platform: "win32", spawnSync: spawner })).toBe("taskkill");
    expect(spawner).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawner.mock.calls[0] as unknown as [string, string[], { windowsHide?: boolean; timeout?: number }];
    // By its full path under System32, never by a name that PATH would resolve (the paths themselves are pinned in
    // taskkill-is-run-by-its-full-path-under-the-system-root.test.ts).
    expect(path.win32.isAbsolute(command)).toBe(true);
    expect(path.win32.basename(command)).toBe("taskkill.exe");
    expect(args).toEqual(["/PID", "4242", "/T", "/F"]);
    expect(options.windowsHide).toBe(true);
    expect(options.timeout).toBe(TASKKILL_TIMEOUT_MS);
    expect(TASKKILL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TASKKILL_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    // taskkill ended the tree: the wrapper is not signalled a second time.
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    ["exits 1 (could not end it)", { status: 1 }],
    ["exits 128 (no such process)", { status: 128 }],
    ["is ended by a signal", { status: null, signal: "SIGTERM" }],
    ["is not found", { status: null, error: Object.assign(new Error("spawnSync taskkill ENOENT"), { code: "ENOENT" }) }],
    ["times out", { status: null, error: Object.assign(new Error("spawnSync taskkill ETIMEDOUT"), { code: "ETIMEDOUT" }) }],
    ["reports an error beside a zero status", { status: 0, error: new Error("odd") }],
    ["returns nothing", undefined],
  ])("on Windows a taskkill that %s still ends the child with kill(), and does not throw", (_what, result) => {
    const child = fakeChild(4242);
    const spawner = vi.fn(() => result);
    expect(endProcessTree(child, { platform: "win32", spawnSync: spawner })).toBe("kill");
    expect(spawner).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith();
  });

  it("on Windows a spawner that throws still ends the child with kill(), and does not throw", () => {
    const child = fakeChild(4242);
    const spawner = vi.fn(() => {
      throw new Error("spawn EPERM");
    });
    expect(() => endProcessTree(child, { platform: "win32", spawnSync: spawner })).not.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("on Windows a kill() that also throws is swallowed", () => {
    const child = fakeChild(4242, true);
    const failing = vi.fn(() => ({ status: 1 }));
    const throwing = vi.fn(() => {
      throw new Error("spawn EPERM");
    });
    expect(() => endProcessTree(child, { platform: "win32", spawnSync: failing })).not.toThrow();
    expect(() => endProcessTree(child, { platform: "win32", spawnSync: throwing })).not.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it("on Windows a child with no pid (the spawn itself failed) is ended with kill() and no taskkill", () => {
    const child = fakeChild(null);
    const spawner = vi.fn(() => ({ status: 0 }));
    expect(endProcessTree(child, { platform: "win32", spawnSync: spawner })).toBe("kill");
    expect(spawner).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it.each(["linux", "darwin", "freebsd"])("on %s it is child.kill() exactly as before: once, no arguments, no taskkill", (platform) => {
    const child = fakeChild(4242);
    const spawner = vi.fn(() => ({ status: 0 }));
    expect(endProcessTree(child, { platform, spawnSync: spawner })).toBe("kill");
    expect(spawner).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith();
  });

  it("on POSIX a kill() that throws is swallowed", () => {
    const child = fakeChild(4242, true);
    expect(() => endProcessTree(child, { platform: "linux" })).not.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("no child is not an error", () => {
    expect(() => endProcessTree(undefined, { platform: "win32" })).not.toThrow();
    expect(() => endProcessTree(null, { platform: "linux" })).not.toThrow();
  });
});

describe("the desktop shell reaches the helper on its quit path", () => {
  const source = fs.readFileSync(path.join(ROOT, "electron-main.cjs"), "utf8");

  it("ends the dev server through the helper and no longer calls kill() on it directly", () => {
    expect(source).not.toMatch(/devServerProcess\.kill\(/);
    const quit = source.slice(source.indexOf("app.on('before-quit'"));
    expect(quit).toMatch(/endDevServerTree\(devServerProcess\)/);
  });

  it("loads the helper on the development path only, so the packaged app never needs the file", () => {
    const requires = source.split("require('./end-process-tree.cjs')").length - 1;
    expect(requires).toBe(1);
    const start = source.indexOf("async function startExpressServer()");
    const developmentBranch = source.slice(source.indexOf("} else {", start), source.indexOf("await waitForServer();", start));
    expect(developmentBranch).toContain("require('./end-process-tree.cjs')");
    expect(developmentBranch.indexOf("require('./end-process-tree.cjs')")).toBeLessThan(developmentBranch.indexOf("devServerProcess = spawn("));
    const builder = JSON.parse(fs.readFileSync(path.join(ROOT, "electron-builder.json"), "utf8")) as { files: string[] };
    expect(builder.files).not.toContain("end-process-tree.cjs");
  });
});

// ---- the real tree ---------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the operating system still runs this process. A zombie awaiting its parent's wait() is not running. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
    } catch {
      return false;
    }
  }
  return true;
}

/** The ids still running when `ms` have passed (none, when all of them ended in time). */
async function stillRunningAfter(ids: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = ids.filter(running);
    if (left.length === 0 || Date.now() > deadline) return left;
    await sleep(50);
  }
}

const madeDirs: string[] = [];
const startedChildren: ChildProcess[] = [];
const startedIds = new Set<number>();

/** Whatever a failed test left running is ended here, so a failure never leaves a server behind. */
afterEach(() => {
  for (const child of startedChildren.splice(0)) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  for (const pid of startedIds) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  startedIds.clear();
});
afterAll(() => {
  // maxRetries: a process that has only just ended can still hold its working directory for a moment on Windows.
  for (const dir of madeDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/**
 * `shell: true`, as the desktop shell spawns the dev server: the shell runs
 * the stand-in (tests/helpers/process-tree-parent.cjs), which starts a
 * long-running child of its own and writes both process ids to a file.
 */
async function startTree(mode: "forward" | "plain") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-process-tree-"));
  madeDirs.push(dir);
  const pidFile = path.join(dir, "ids.json");
  const stand = path.join(__dirname, "helpers", "process-tree-parent.cjs");
  const launch = `"${process.execPath}" "${stand}" "${pidFile}" ${mode}`;
  // On POSIX the shell is told to replace itself with the stand-in (`exec`), as
  // bash does for a lone command. dash does not, and there child.kill() reaches
  // the shell alone, which is the POSIX behaviour this change leaves as it was.
  // On Windows cmd.exe stays in between whatever is typed, which is the case
  // the helper is for.
  const command = process.platform === "win32" ? launch : `exec ${launch}`;
  const child = spawn(command, { shell: true, stdio: "ignore" });
  startedChildren.push(child);
  if (typeof child.pid !== "number") throw new Error("the shell did not start");
  startedIds.add(child.pid);

  const deadline = Date.now() + 20_000;
  let ids: { parent: number; grandchild: number } | undefined;
  while (!ids) {
    try {
      ids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    } catch {
      if (Date.now() > deadline) throw new Error("the stand-in never wrote its process ids");
      await sleep(50);
    }
  }
  startedIds.add(ids.parent);
  startedIds.add(ids.grandchild);
  return { child, shell: child.pid, parent: ids.parent, grandchild: ids.grandchild };
}

describe("a real shell: true child that has started a long-running grandchild", () => {
  it("ends the shell, the process under it and the grandchild", async () => {
    const tree = await startTree("forward");
    expect(running(tree.shell)).toBe(true);
    expect(running(tree.parent)).toBe(true);
    expect(running(tree.grandchild)).toBe(true);

    endProcessTree(tree.child);

    expect(await stillRunningAfter([tree.shell, tree.parent, tree.grandchild], 15_000)).toEqual([]);
  }, 60_000);

  it("is a premise worth testing: a plain kill() of the shell leaves a grandchild that nothing passes the signal to running", async () => {
    const tree = await startTree("plain");
    tree.child.kill();
    expect(await stillRunningAfter([tree.shell], 15_000)).toEqual([]);
    await sleep(500);
    // This is the fault on Windows, where a shell's kill() passes nothing on.
    expect(running(tree.grandchild)).toBe(true);
    // Ended here so that nothing is left running.
    process.kill(tree.grandchild);
    expect(await stillRunningAfter([tree.grandchild], 15_000)).toEqual([]);
  }, 60_000);
});
