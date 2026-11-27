import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { build } from "esbuild";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

/**
 * SAFETY: the server's event loop never loads the SQLite driver.
 *
 * better-sqlite3 runs each statement synchronously, for as long as the disk
 * takes, on the thread that runs it. The store runs on a worker thread of its
 * own (server/store-client.ts), so a stalled disk holds that thread and never
 * a Stop. A module that loaded the driver on the main thread could open a
 * connection there and put a statement back on the loop -- one this suite's
 * held store would catch only on the paths it presses. So this boots the
 * server as the desktop app does: both bundles built as `npm run build`
 * builds them (build-electron-server.cjs), the server's required in a process
 * of its own (tests/helpers/boot-the-bundle-and-say-what-its-loop-loaded.cjs)
 * -- every module the server loads at start-up, the settings among them, run;
 * none read here. Its admin signs in and pages are read, so the store
 * answers from its thread; then that process's main thread says what it
 * loaded of the driver: nothing. Paths only, never a file's contents.
 */

const ROOT = path.resolve(__dirname, "..");
const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the server's event loop never loads the SQLite driver", () => {
  it("booted as the desktop app boots it, signed in and read from: its main thread has loaded no better-sqlite3 file, and the store answered", async () => {
    const { options } = createRequire(__filename)(path.join(ROOT, "build-electron-server.cjs")) as { options: Record<string, unknown> };
    // Under node_modules, so the bundles find better-sqlite3 there, as dist/ does; outside the working tree's files.
    const out = fs.mkdtempSync(path.join(ROOT, "node_modules", ".athena-boot-"));
    made.push(out);
    await build({ ...options, absWorkingDir: ROOT, logLevel: "silent", entryPoints: ["server/index-electron.ts"], outfile: path.join(out, "server-electron.cjs") });
    await build({ ...options, absWorkingDir: ROOT, logLevel: "silent", entryPoints: ["server/store-worker-main.ts"], outfile: path.join(out, "store-worker.cjs") });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "athena-boot-"));
    made.push(data);
    const port = String(20_000 + Math.floor(Math.random() * 20_000));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: data, USERPROFILE: data,
      NODE_ENV: "production", PORT: port, HOST: "127.0.0.1",
      ATHENA_DB_PATH: path.join(data, "athena.db"),
      // The session secret every test runs with (tests/setup.ts).
      SESSION_SECRET: process.env.SESSION_SECRET,
      ATHENA_INITIAL_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    };
    const booted = spawnSync(process.execPath, [path.join(__dirname, "helpers", "boot-the-bundle-and-say-what-its-loop-loaded.cjs"),
      path.join(out, "server-electron.cjs"), port, TEST_ADMIN_PASSWORD], { cwd: data, env, encoding: "utf8", timeout: 90_000 });
    const said = booted.stdout.split("\n").filter((line) => line.startsWith("{")).pop();
    expect(said, `the booted server said nothing (exit ${booted.status}): ${booted.stderr.slice(-2000)}`).toBeDefined();
    const seen = JSON.parse(said!) as { health: number; login: number; reads: number[]; loaded: string[]; askedBy: Array<{ request: string; by: string | null }>; failed?: string };
    console.log(`[the loop's driver] health ${seen.health}, sign-in ${seen.login}, reads ${JSON.stringify(seen.reads)}; ` +
      `better-sqlite3 loaded on the main thread: ${JSON.stringify(seen.loaded)}, asked for by: ${JSON.stringify(seen.askedBy)}`);
    expect(seen.failed).toBeUndefined();
    expect(seen.health).toBe(200);
    // The store answered (from its own thread): the admin signed in, and every read was answered, none failed.
    expect(seen.login).toBe(200);
    for (const status of seen.reads) expect(status).toBeLessThan(500);
    expect(seen.askedBy).toEqual([]);
    expect(seen.loaded).toEqual([]);
  }, 120_000);
});
