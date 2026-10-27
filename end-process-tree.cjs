'use strict';

// Ends a spawned process together with everything it started.
//
// The development shell starts the API with `spawn('npm', ['run', 'dev'],
// { shell: true })`. On Windows that is `cmd.exe` -> `npm` -> `cmd.exe` ->
// `tsx` -> `node`, and `child.kill()` ends only the first `cmd.exe`: the
// server below it keeps running, holding its port and the SQLite file, and
// the next start finds both taken. `taskkill /PID <pid> /T /F` ends the whole
// tree. On POSIX the call stays what it always was: `child.kill()`.
//
// `taskkill` is run by its full path, `%SystemRoot%\System32\taskkill.exe`,
// never by name: a name is looked up on PATH, and a `taskkill.exe` earlier on
// it (a checkout's, a tool's) would be what a quit ran.
//
// Nothing in here may throw or wait long: it runs while the app is quitting.
// A failed, missing or timed-out `taskkill` falls back to `child.kill()`, and
// a failed `child.kill()` is swallowed.
//
// Plain CommonJS and free of Electron imports so that the tests can load it
// directly. `electron-main.cjs` requires it only on the development path, so
// the packaged app (which ships only the files named in electron-builder.json)
// never loads it.

const { spawnSync } = require('child_process');
const path = require('path');

/** How long the quit waits for `taskkill` before falling back to `kill()`. */
const TASKKILL_TIMEOUT_MS = 3000;

/** Where Windows is, when the environment does not say. */
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows';

/**
 * `taskkill.exe` by its full path: `<SystemRoot>\System32\taskkill.exe`.
 *
 * `SystemRoot` is what Windows sets for every process (the two spellings are
 * one variable there, whatever its case; both are read so that an environment
 * handed in as a plain object works too). A value that is not an absolute
 * Windows path is not used: a relative one would be looked up against the
 * working directory, which is what a full path is here to avoid. Without a
 * usable value, the default Windows directory.
 *
 * @param {Record<string, string | undefined>} env
 */
function taskkillPath(env) {
  const root = [env.SystemRoot, env.SYSTEMROOT].find((one) => typeof one === 'string' && path.win32.isAbsolute(one));
  return path.win32.join(root || DEFAULT_SYSTEM_ROOT, 'System32', 'taskkill.exe');
}

function killQuietly(child) {
  try {
    child.kill();
  } catch {
    // Already gone, or not ours to signal. There is nothing more to do.
  }
}

/**
 * @param {{ pid?: number, kill: () => unknown } | null | undefined} child
 *   The process `spawn` returned.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, spawnSync?: typeof spawnSync, timeoutMs?: number }} [options]
 *   `platform`, `env` (where `SystemRoot` is read) and `spawnSync` are
 *   injectable for tests.
 * @returns {'taskkill' | 'kill'} How the end was requested: `taskkill` when it
 *   reported success, otherwise `kill` (POSIX, or Windows after a fallback).
 */
function endProcessTree(child, options = {}) {
  try {
    if (!child) return 'kill';
    const platform = options.platform || process.platform;
    if (platform !== 'win32') {
      killQuietly(child);
      return 'kill';
    }

    const spawner = options.spawnSync || spawnSync;
    const timeout = options.timeoutMs || TASKKILL_TIMEOUT_MS;
    // No pid means the spawn itself failed: there is no tree to end.
    if (typeof child.pid === 'number') {
      const result = spawner(taskkillPath(options.env || process.env), ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout,
        stdio: 'ignore',
      });
      if (result && !result.error && result.status === 0) return 'taskkill';
    }
    killQuietly(child);
    return 'kill';
  } catch {
    // The spawner threw. Fall back, and never let a quit fail on this.
    if (child) killQuietly(child);
    return 'kill';
  }
}

module.exports = { endProcessTree, TASKKILL_TIMEOUT_MS };
