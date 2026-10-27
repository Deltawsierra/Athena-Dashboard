import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import path from "path";

const { endProcessTree, TASKKILL_TIMEOUT_MS } = createRequire(import.meta.url)("../end-process-tree.cjs") as {
  endProcessTree: (child: unknown, options?: Record<string, unknown>) => "taskkill" | "kill";
  TASKKILL_TIMEOUT_MS: number;
};

/**
 * end-process-tree.cjs ends a dev server's whole tree on Windows with
 * `taskkill /PID <pid> /T /F`. A bare `taskkill` is looked up on PATH, so a
 * `taskkill.exe` earlier on it -- a checkout's, a tool's -- would be what a
 * quit ran. It runs `<SystemRoot>\System32\taskkill.exe` instead, with
 * `SystemRoot` read from the environment (Windows sets it for every process;
 * the two spellings are one variable there), else `SYSTEMROOT`, else
 * `C:\Windows`.
 *
 * The platform, the environment and the spawner are injected, as in
 * the-dev-server-and-everything-it-started-end-when-the-app-quits.test.ts, so
 * the Windows branch runs on any machine. Nothing else about the call changes:
 * its arguments, its hidden window, its timeout, and the fall-back to kill()
 * when taskkill does not end the tree.
 */

/** A stand-in for what `spawn` returns. */
function fakeChild(pid = 4242) {
  return { pid, kill: vi.fn(() => true) };
}

const WINDOWS_DEFAULT = "C:\\Windows\\System32\\taskkill.exe";

/** Everything the helper handed the spawner, from a Windows stop with this environment. */
function runWith(env: Record<string, unknown> | undefined) {
  const spawner = vi.fn(() => ({ status: 0 }));
  const child = fakeChild();
  const options: Record<string, unknown> = { platform: "win32", spawnSync: spawner };
  if (env) options.env = env;
  const how = endProcessTree(child, options);
  expect(spawner).toHaveBeenCalledTimes(1);
  const [command, args, spawnOptions] = spawner.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
  return { how, command, args, spawnOptions, child };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("on Windows, taskkill is run by its full path under SystemRoot", () => {
  it.each([
    { what: "SystemRoot", env: { SystemRoot: "D:\\Windows" }, expected: "D:\\Windows\\System32\\taskkill.exe" },
    { what: "SYSTEMROOT alone", env: { SYSTEMROOT: "E:\\WINNT" }, expected: "E:\\WINNT\\System32\\taskkill.exe" },
    { what: "both spellings (SystemRoot first)", env: { SystemRoot: "D:\\Windows", SYSTEMROOT: "E:\\WINNT" }, expected: "D:\\Windows\\System32\\taskkill.exe" },
    { what: "neither", env: {}, expected: WINDOWS_DEFAULT },
    { what: "an empty SystemRoot, with SYSTEMROOT set", env: { SystemRoot: "", SYSTEMROOT: "E:\\WINNT" }, expected: "E:\\WINNT\\System32\\taskkill.exe" },
    { what: "an empty SystemRoot alone", env: { SystemRoot: "" }, expected: WINDOWS_DEFAULT },
    { what: "a SystemRoot with a trailing separator", env: { SystemRoot: "D:\\Windows\\" }, expected: "D:\\Windows\\System32\\taskkill.exe" },
    { what: "a SystemRoot spelled with forward slashes", env: { SystemRoot: "D:/Windows" }, expected: "D:\\Windows\\System32\\taskkill.exe" },
  ])("with $what it runs $expected, with the arguments, the hidden window and the timeout it always had", ({ env, expected }) => {
    const { how, command, args, spawnOptions, child } = runWith(env);
    expect(command).toBe(expected);
    expect(args).toEqual(["/PID", "4242", "/T", "/F"]);
    expect(spawnOptions).toEqual({ windowsHide: true, timeout: TASKKILL_TIMEOUT_MS, stdio: "ignore" });
    expect(how).toBe("taskkill");
    // taskkill ended the tree: the wrapper is not signalled a second time.
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    { what: "a relative SystemRoot", env: { SystemRoot: "Windows" } },
    { what: "a SystemRoot of '.'", env: { SystemRoot: "." } },
    { what: "a drive-relative SystemRoot", env: { SystemRoot: "C:Windows" } },
    { what: "a relative SystemRoot with a relative SYSTEMROOT", env: { SystemRoot: "..\\elsewhere", SYSTEMROOT: "tools" } },
    { what: "a SystemRoot that is not text", env: { SystemRoot: 7 } },
  ])("$what is not used: a relative path would be looked for under the working directory, so the default is run", ({ env }) => {
    expect(runWith(env).command).toBe(WINDOWS_DEFAULT);
  });

  it("a relative SystemRoot does not stand in the way of a usable SYSTEMROOT", () => {
    expect(runWith({ SystemRoot: "Windows", SYSTEMROOT: "E:\\WINNT" }).command).toBe("E:\\WINNT\\System32\\taskkill.exe");
  });

  it("is never the bare name, whatever PATH holds: the command is absolute and PATH is not consulted", () => {
    const hostile = { SystemRoot: "C:\\Windows", PATH: "C:\\checkout\\node_modules\\.bin;C:\\tools", Path: "C:\\checkout\\node_modules\\.bin;C:\\tools" };
    const { command } = runWith(hostile);
    expect(command).not.toBe("taskkill");
    expect(command).not.toBe("taskkill.exe");
    expect(path.win32.isAbsolute(command)).toBe(true);
    expect(path.win32.dirname(command)).toBe("C:\\Windows\\System32");
    expect(path.win32.basename(command)).toBe("taskkill.exe");
  });

  it("reads the process's own environment when none is given", () => {
    vi.stubEnv("SystemRoot", "F:\\Windows");
    const spawner = vi.fn(() => ({ status: 0 }));
    expect(endProcessTree(fakeChild(), { platform: "win32", spawnSync: spawner })).toBe("taskkill");
    expect((spawner.mock.calls[0] as unknown as [string])[0]).toBe("F:\\Windows\\System32\\taskkill.exe");
  });

  it("on this machine's own environment, names a taskkill.exe under a System32 directory by an absolute path, and on Windows that file is there", () => {
    const spawner = vi.fn(() => ({ status: 0 }));
    endProcessTree(fakeChild(), { platform: "win32", spawnSync: spawner });
    const command = (spawner.mock.calls[0] as unknown as [string])[0];
    expect(path.win32.isAbsolute(command)).toBe(true);
    expect(path.win32.basename(command)).toBe("taskkill.exe");
    expect(path.win32.basename(path.win32.dirname(command)).toLowerCase()).toBe("system32");
    // Only Windows can say whether the file is there.
    if (process.platform === "win32") expect(fs.existsSync(command)).toBe(true);
  });
});

describe("a stop never fails on the way out, whatever the full path does", () => {
  it("a taskkill missing at its full path (real spawn, nothing there) still ends the child with kill() and does not throw", () => {
    const child = fakeChild();
    let how: string | undefined;
    expect(() => {
      how = endProcessTree(child, { platform: "win32", env: { SystemRoot: "Z:\\a-directory-that-is-not-there" } });
    }).not.toThrow();
    expect(how).toBe("kill");
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith();
  });

  it("an environment that throws when read still ends the child with kill(), runs no taskkill and does not throw", () => {
    const hostileEnv = new Proxy({}, {
      get() {
        throw new Error("the environment cannot be read");
      },
    });
    const child = fakeChild();
    const spawner = vi.fn(() => ({ status: 0 }));
    let how: string | undefined;
    expect(() => {
      how = endProcessTree(child, { platform: "win32", env: hostileEnv, spawnSync: spawner });
    }).not.toThrow();
    expect(how).toBe("kill");
    expect(spawner).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("a taskkill that fails at its full path still ends the child with kill()", () => {
    const child = fakeChild();
    const spawner = vi.fn(() => ({ status: 1 }));
    expect(endProcessTree(child, { platform: "win32", env: { SystemRoot: "D:\\Windows" }, spawnSync: spawner })).toBe("kill");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it.each(["linux", "darwin"])("on %s no taskkill is run and the environment is not read: child.kill() once, as before", (platform) => {
    const unreadable = new Proxy({}, {
      get() {
        throw new Error("read on a platform that has no taskkill");
      },
    });
    const child = fakeChild();
    const spawner = vi.fn(() => ({ status: 0 }));
    expect(endProcessTree(child, { platform, env: unreadable, spawnSync: spawner })).toBe("kill");
    expect(spawner).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith();
  });
});
