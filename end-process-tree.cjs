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
// Nothing in here may throw or wait long: it runs while the app is quitting.
// A failed or timed-out `taskkill` falls back to `child.kill()`, and a failed
// `child.kill()` is swallowed.
//
// Plain CommonJS and free of Electron imports so that the tests can load it
// directly. `electron-main.cjs` requires it only on the development path, so
// the packaged app (which ships only the files named in electron-builder.json)
// never loads it.

const { spawnSync } = require('child_process');

/** How long the quit waits for `taskkill` before falling back to `kill()`. */
const TASKKILL_TIMEOUT_MS = 3000;

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
 * @param {{ platform?: string, spawnSync?: typeof spawnSync, timeoutMs?: number }} [options]
 *   `platform` and `spawnSync` are injectable for tests.
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
      const result = spawner('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
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
