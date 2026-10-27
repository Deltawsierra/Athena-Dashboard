'use strict';

// A stand-in for what `npm run dev` is during development: a process that
// starts a long-running child of its own (the server) and keeps running.
//
//   node process-tree-parent.cjs <pid-file> <forward|plain>
//
// It writes { parent, grandchild } (process ids) to <pid-file> once both are
// running. With `forward`, a SIGTERM is passed on to the child before this
// process exits, which is what npm does on POSIX; with `plain` it is not,
// which is what Windows leaves: there `kill()` is an unconditional
// termination, so nothing gets the chance to pass anything on.
//
// Both end on their own after two minutes, so a test that dies midway cannot
// leave either running for long.

const { spawn } = require('child_process');
const fs = require('fs');

const [pidFile, mode] = process.argv.slice(2);

const grandchild = spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 120000);'],
  { stdio: 'ignore' },
);

// Written whole, then renamed into place, so a reader never sees half of it.
fs.writeFileSync(`${pidFile}.tmp`, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
fs.renameSync(`${pidFile}.tmp`, pidFile);

if (mode === 'forward') {
  process.on('SIGTERM', () => {
    grandchild.once('exit', () => process.exit(0));
    grandchild.kill('SIGTERM');
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 120000);
