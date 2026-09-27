import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/**
 * A test that bounds wall-clock time -- how soon a stop reaches the engine,
 * how long the loop is held -- fails for no fault of the app when it shares
 * the runner's cores with every other test file. `npm test` runs those files
 * afterwards, on their own, one at a time (vitest.config.ts, `--mode
 * timing`), and only the files named in tests/wall-clock.json. The list was
 * kept by hand and by a comment: six files with bounds of 250 ms to 1 s were
 * missing from it in the round-five review, one of them under a held SQLite
 * lock. This fails when a test file bounds elapsed time and is not listed.
 *
 * A file bounds elapsed time when it reads a clock to measure an interval
 * (performance.now(), process.hrtime, or Date.now() other than as a
 * timestamp offset like `Date.now() - 60_000`) and asserts an upper bound
 * (toBeLessThan, toBeLessThanOrEqual); or when it races a call against a
 * timer (Promise.race with sleep or setTimeout).
 */

const ROOT = path.resolve(__dirname, "..");
const LISTED: string[] = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "wall-clock.json"), "utf8"));
/** This file: its examples of the rule are not bounds. */
const SELF = "tests/every-test-that-bounds-wall-clock-time-runs-on-its-own.test.ts";

function boundsWallClock(source: string): boolean {
  const readsAClock = /performance\.now\(\)|process\.hrtime|Date\.now\(\)(?!\s*[-+]\s*[\d(])/.test(source);
  const assertsABound = /\.toBeLessThan(OrEqual)?\(/.test(source);
  const racesATimer = /Promise\.race\(/.test(source) && /\bsleep\(|setTimeout\(/.test(source);
  return (readsAClock && assertsABound) || racesATimer;
}

function testFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testFiles(full);
    return /\.test\.tsx?$/.test(entry.name) ? [path.relative(ROOT, full).split(path.sep).join("/")] : [];
  });
}

describe("every test file that bounds wall-clock time runs on its own", () => {
  it("the rule tells a measured bound or a race against a timer from a timestamp", () => {
    expect(boundsWallClock("const t0 = performance.now(); expect(performance.now() - t0).toBeLessThan(250);")).toBe(true);
    expect(boundsWallClock("const pressed = Date.now(); expect(Date.now() - pressed).toBeLessThan(300);")).toBe(true);
    expect(boundsWallClock("const got = await Promise.race([p, sleep(5_000)]);")).toBe(true);
    expect(boundsWallClock("completedAt: new Date(Date.now() - 60_000); expect(count).toBeLessThan(3);")).toBe(false);
    expect(boundsWallClock("expect(within(li).getByText('x')).toBeTruthy();")).toBe(false);
  });

  it("each file on the list exists", () => {
    for (const file of LISTED) expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
  });

  it("each test file that bounds elapsed time is on the list", () => {
    const unlisted = testFiles(path.join(ROOT, "tests"))
      .filter((file) => file !== SELF)
      .filter((file) => boundsWallClock(fs.readFileSync(path.join(ROOT, file), "utf8")))
      .filter((file) => !LISTED.includes(file));
    expect(unlisted, "add these to tests/wall-clock.json").toEqual([]);
  });
});
