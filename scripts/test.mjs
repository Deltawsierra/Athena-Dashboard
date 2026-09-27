#!/usr/bin/env node
// `npm test [-- <vitest arguments>]`: the suite in its two phases.
//
//   1. `vitest run`: every test file but the wall-clock ones, in parallel.
//   2. `vitest run --mode timing`: the files that bound wall-clock time
//      (tests/wall-clock.json), on their own, one at a time.
//
// With no file named, both phases run, the second after the first, and the
// suite fails when either does. A file named (`npm test -- tests/x.test.ts`,
// or any part of a path, as vitest reads a filter) runs only in the phase it
// belongs to: `vitest run <file>` found no file when it was a wall-clock one
// (they are excluded there), and ran the whole suite first when it was not.
// Every other argument (-t, --reporter, ...) goes to each phase that runs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wallClock = JSON.parse(fs.readFileSync(path.join(root, "tests", "wall-clock.json"), "utf8"));

function testFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testFiles(full);
    return /\.test\.tsx?$/.test(entry.name) ? [path.relative(root, full).split(path.sep).join("/")] : [];
  });
}

const files = testFiles(path.join(root, "tests"));
const timed = files.filter((file) => wallClock.includes(file));
const untimed = files.filter((file) => !wallClock.includes(file));
const matches = (list, filter) => {
  const wanted = filter.replace(/^\.\//, "").split(path.sep).join("/");
  return list.some((file) => file.includes(wanted) || path.join(root, file).includes(filter));
};

// vitest's flags that take the next argument as their value (`-t stop` names a test, not a file).
const VALUE_FLAGS = new Set([
  "-t", "--testNamePattern", "--reporter", "--outputFile", "-c", "--config", "-r", "--root", "--dir", "--mode",
  "--environment", "--pool", "--maxWorkers", "--minWorkers", "--shard", "--project", "--bail", "--retry",
  "--testTimeout", "--hookTimeout", "--teardownTimeout", "--sequence.seed", "--exclude", "--include",
]);
const args = process.argv.slice(2);
// A file filter is an argument that is not a flag, nor a flag's value, and names a test file; anything else goes to each phase as it is.
const filters = [];
const rest = [];
for (let i = 0; i < args.length; i += 1) {
  const one = args[i];
  if (VALUE_FLAGS.has(one) && i + 1 < args.length) {
    rest.push(one, args[i + 1]);
    i += 1;
  } else if (!one.startsWith("-") && files.some((file) => matches([file], one))) {
    filters.push(one);
  } else {
    rest.push(one);
  }
}

const phases = filters.length === 0
  ? [{ mode: [], filters: [] }, { mode: ["--mode", "timing"], filters: [] }]
  : [
    { mode: [], filters: filters.filter((one) => matches(untimed, one)) },
    { mode: ["--mode", "timing"], filters: filters.filter((one) => matches(timed, one)) },
  ].filter((phase) => phase.filters.length > 0);

const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
let failed = false;
for (const phase of phases) {
  const argv = [vitest, "run", ...phase.mode, ...phase.filters, ...rest];
  console.log(`\n> vitest ${argv.slice(1).join(" ")}\n`);
  const run = spawnSync(process.execPath, argv, { stdio: "inherit", cwd: root });
  if (run.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
