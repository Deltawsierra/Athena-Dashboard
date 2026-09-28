import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import Database from "better-sqlite3";

/**
 * SAFETY: `GET /api/tests` reads the whole table with one unbounded,
 * synchronous scan (better-sqlite3). At estate scale that scan held the event
 * loop -- and every request behind it, a scan's Stop included -- for over
 * 600 ms on ordinary hardware. A Stop that arrives while that scan is running
 * must still reach the engine on schedule: it is answered from a page-sized
 * read, not the whole table.
 *
 * The stand-in engine runs in a process of its own, so when the Stop arrives
 * is measured by a clock this process's own event loop cannot hold up.
 */

const madeDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(prefix);
  madeDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of madeDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const calls: Array<{ line: string; at: number }> = [];
let child: ChildProcess;
let port = 0;

beforeAll(async () => {
  child = spawn(process.execPath, [path.join(__dirname, "helpers", "engine-in-its-own-process.cjs")], { stdio: ["ignore", "pipe", "inherit"] });
  let buffer = "";
  await new Promise<void>((ready) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const one = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (one.port) { port = one.port; ready(); } else calls.push(one);
      }
    });
  });
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
});
afterAll(() => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  process.env.ATHENA_STORAGE = "memory";
  delete process.env.ATHENA_DB_PATH;
  child.kill();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function arrived(line: string, ms = 5_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const one = calls.find((c) => c.line === line);
    if (one || Date.now() > deadline) return one;
    await sleep(5);
  }
}

/** A row shaped like a real one: a JSON findings blob with some bulk to it, not an empty object. */
function findingsBlobFor(i: number): string {
  return JSON.stringify({
    runId: `bg-${i}`,
    target: `https://target-${i}.example.test/`,
    results: [{ id: `f${i}`, severity: "high", message: "x".repeat(200), target: `https://target-${i}.example.test/` }],
  });
}

describe("a tests table at estate scale", () => {
  it("still answers a scan's Stop within 200 ms while GET /api/tests is reading it", async () => {
    process.env.ATHENA_STORAGE = "sqlite";
    const dbPath = path.join(tempDir(path.join(os.tmpdir(), "athena-d325-scale-")), "athena.db");
    process.env.ATHENA_DB_PATH = dbPath;
    const { createApp } = await import("../server/app");
    const { initializeDefaultData } = await import("../server/init-data");
    const app = createApp();
    await initializeDefaultData();
    const agent = request.agent(app);
    expect((await agent.post("/api/auth/login").send({ username: "admin", password: "admin123" })).status).toBe(200);
    const storage = (await import("../server/storage-unified")).storage;

    const client = await storage.createClient({ name: "Estate", company: "Estate", email: "e@e.test" });

    // The target of the Stop: a real row, through the storage layer.
    const target = await storage.createTest({
      clientId: client.id, testType: "vulnerability-scan", status: "running",
      findings: { runId: "victim-run", target: "https://victim.example.test/", results: [] },
    });

    // 60,000 more rows, inserted directly (bypassing the app layer, which
    // would take far longer than the read this measures) so the table is at
    // the scale a real estate reaches over time.
    const raw = new Database(dbPath);
    const now = Date.now();
    const insert = raw.prepare(
      `INSERT INTO tests (id, client_id, test_type, status, started_at, completed_at, summary, findings,
        vulnerabilities_found, critical_count, high_count, medium_count, low_count, executed_by, is_sample)
       VALUES (@id, @clientId, 'vulnerability-scan', 'completed', @now, @now, @summary, @findings, 3, 1, 1, 1, 0, NULL, 0)`,
    );
    const N = 60_000;
    raw.transaction(() => {
      for (let i = 0; i < N; i += 1) {
        insert.run({ id: `bulk-${i}`, clientId: client.id, now, summary: `Scan of target-${i}.example.test`, findings: findingsBlobFor(i) });
      }
    })();
    raw.close();

    try {
      calls.length = 0;
      // GET /api/tests, then the Stop right behind it, both sent with .end()
      // (not .then(): a supertest/superagent request is not actually written
      // to the socket until .end() or .then() is called) and with no `await`
      // between them. A tick of `setTimeout`/`sleep` in between would be no
      // guarantee at all here: if the read ahead of it holds the loop, that
      // very timer is held with it and fires late, only once the read is
      // already done -- which is exactly the failure this test would then
      // fail to see. Sent back to back instead, the Stop's request reaches
      // the server while the read ahead of it, if it blocks the loop, is
      // still running.
      const bigRead = new Promise<request.Response>((resolve, reject) => {
        agent.get("/api/tests").end((err, res) => (err ? reject(err) : resolve(res)));
      });
      const pressed = Date.now();
      const stop = new Promise<request.Response>((resolve, reject) => {
        agent.post(`/api/scans/${target.id}/abort`).end((err, res) => (err ? reject(err) : resolve(res)));
      });
      const answer = await stop;
      expect(answer.status).toBe(200);
      const got = await arrived("POST /api/scans/victim-run/abort", 5_000);
      expect(got).toBeDefined();
      const latency = got!.at - pressed;
      console.log(`[estate] a scan's Stop reached the engine after ${latency} ms while GET /api/tests was reading ${N + 1} rows`);
      expect(latency).toBeLessThanOrEqual(200);

      // The big read still finishes, and still answers the whole table.
      const big = await bigRead;
      expect(big.status).toBe(200);
      expect(big.body).toHaveLength(N + 1);
    } finally {
      process.env.ATHENA_STORAGE = "memory";
      delete process.env.ATHENA_DB_PATH;
    }
  }, 60_000);
});
