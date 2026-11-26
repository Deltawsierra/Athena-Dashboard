import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BroadcastChannel } from "node:worker_threads";
import type { IStorage } from "../server/storage";
import { noteDatabase, releaseAndRemove } from "./helpers/databases-in-use";
import { prelude, storeInATestWorker } from "./helpers/store-in-a-test-worker";

/**
 * The store runs on a worker thread of its own, and the event loop reads each
 * of its answers as a message (server/store-client.ts). A message is read
 * whole, in one turn of the loop: 60,000 tests in one held the loop 169-180
 * ms (DASH-STORE-OFF-THE-LOOP, option A). So no message carries more than a
 * page of rows (STORE_PAGE_ROWS, 1000): the tests table is read a page a call,
 * and any other list longer than a page comes a page a message -- and is
 * still answered whole. What the loop holds of the tests is what the read
 * found (peekAllTests).
 *
 * And what an error is crosses the thread with it: a second row for one
 * backend scan is refused as DuplicateBackendScan (callers tell it apart by
 * class: backend-adoption.ts), a constraint by its SQLite code (app.ts).
 */

const madeDirs: string[] = [];
const channelName = `athena-rows-a-message-${process.pid}-${Math.random()}`;
const sizes: number[] = [];
let channel: BroadcastChannel;
let storage: IStorage;
let dbPath = "";
let putBack: () => void = () => undefined;

beforeAll(async () => {
  channel = new BroadcastChannel(channelName);
  channel.unref();
  channel.onmessage = (event) => sizes.push(((event as MessageEvent).data as { rows: number }).rows);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-a-page-a-message-"));
  madeDirs.push(dir);
  dbPath = path.join(dir, "athena.db");
  process.env.ATHENA_STORAGE = "sqlite";
  process.env.ATHENA_DB_PATH = dbPath;
  putBack = storeInATestWorker({ preludes: [prelude("count-rows-a-message.mjs")], workerData: { countRows: channelName } });
  vi.resetModules();
  await noteDatabase();
  storage = (await import("../server/storage-sqlite")).storage;
  await storage.getAllClients();
});
afterAll(async () => {
  putBack();
  channel.close();
  await releaseAndRemove(madeDirs);
  process.env.ATHENA_STORAGE = "memory";
  delete process.env.ATHENA_DB_PATH;
});

const ROWS = 2_500;
/** When the rows were written: any fixed time. */
const AT = 1_767_225_600_000;

describe("no message from the store's thread carries more than a page of rows", () => {
  it(`${ROWS} tests and ${ROWS} log lines on file: each read is answered whole, and no message carries more than 1000 rows`, async () => {
    const raw = new Database(dbPath);
    try {
      raw.transaction(() => {
        const test = raw.prepare(`INSERT INTO tests (id, client_id, test_type, status, started_at, findings, vulnerabilities_found,
          critical_count, high_count, medium_count, low_count, is_sample) VALUES (?, NULL, 'vulnerability-scan', 'completed', ?, ?, 0, 0, 0, 0, 0, 0)`);
        const log = raw.prepare("INSERT INTO activity_logs (id, action, entity_type, entity_id, timestamp) VALUES (?, 'paged', 'test', ?, ?)");
        for (let i = 0; i < ROWS; i += 1) {
          test.run(`paged-${i}`, AT, JSON.stringify({ runId: `paged-run-${i}`, results: [] }));
          log.run(`paged-log-${i}`, String(i), AT);
        }
      })();
    } finally {
      raw.close();
    }
    sizes.length = 0;
    const tests = await storage.getAllTests();
    expect(tests.filter((one) => one.id.startsWith("paged-"))).toHaveLength(ROWS);
    expect(storage.peekAllTests()?.filter((one) => one.id.startsWith("paged-"))).toHaveLength(ROWS);
    expect(storage.peekTest(`paged-${ROWS - 1}`)?.findings).toEqual({ runId: `paged-run-${ROWS - 1}`, results: [] });
    const logs = await storage.getAllActivityLogs();
    expect(logs.filter((one) => one.action === "paged")).toHaveLength(ROWS);
    await new Promise((resolve) => setTimeout(resolve, 100));
    console.log(`[a page a message] ${sizes.length} messages carried rows; the most in one: ${Math.max(...sizes)}`);
    expect(sizes.reduce((all, one) => all + one, 0)).toBeGreaterThanOrEqual(2 * ROWS);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
  }, 60_000);
});

describe("an error crosses the store's thread as what it is", () => {
  it("a second row for one backend scan is refused as DuplicateBackendScan; a username taken, by its SQLite code", async () => {
    const { DuplicateBackendScan } = await import("../server/storage");
    const scan = { runId: "dup-run", backendScanId: "11111111-2222-3333-4444-555555555555", target: "https://offline.invalid/", results: [] };
    await storage.createTest({ clientId: null, testType: "vulnerability-scan", status: "running", findings: scan } as never);
    const again = storage.createTest({ clientId: null, testType: "vulnerability-scan", status: "running", findings: { ...scan, runId: "dup-run-2" } } as never);
    await expect(again).rejects.toBeInstanceOf(DuplicateBackendScan);
    await storage.createUser({ username: "taken", password: "a-long-enough-password-1" }); // pragma: allowlist secret
    const taken = await storage.createUser({ username: "taken", password: "a-long-enough-password-2" }).catch((cause: unknown) => cause); // pragma: allowlist secret
    expect((taken as { code?: string }).code).toMatch(/^SQLITE_CONSTRAINT/);
  });
});
