import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { IStorage } from "../server/storage";
import { noteDatabase, releaseAndRemove } from "./helpers/databases-in-use";

/**
 * `updateTestWith` -- how a scan row's findings are written by the writers
 * that run beside each other (the live poll, a Stop's mirror, the collect
 * watch; tests/two-writes-to-a-scan-row-never-drop-each-others-findings.test.ts)
 * -- behaves the same on both storage backends:
 *
 *   - the change is handed the row as it is when the write lands, so two
 *     writers that each set their own field, started together, both stand;
 *   - a change that answers null writes nothing and answers the row as it is;
 *   - a row that is not there is answered undefined, and nothing is asked;
 *   - the row held in memory for a Stop (peekTest) is the row written;
 *   - and on SQLite, a write another connection -- another dashboard on the
 *     file -- holds the lock for is waited out off the event loop, and is in
 *     the row the change is handed once it commits.
 */

/** The temporary directories this file made, each removed when the file is done -- passed or failed. Only these. */
const madeDirs: string[] = [];
afterAll(async () => {
  await releaseAndRemove(madeDirs);
});

const BACKENDS: Array<{ name: string; open: () => Promise<{ storage: IStorage; dbPath: string | null }> }> = [
  {
    name: "memory",
    open: async () => {
      const { MemStorage } = await import("../server/storage");
      return { storage: new MemStorage(), dbPath: null };
    },
  },
  {
    name: "sqlite",
    open: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-row-change-"));
      madeDirs.push(dir);
      const dbPath = path.join(dir, "athena.db");
      process.env.ATHENA_DB_PATH = dbPath;
      vi.resetModules();
      await noteDatabase();
      return { storage: (await import("../server/storage-sqlite")).storage, dbPath };
    },
  },
];

const findingsOf = (row: { findings: unknown } | undefined) => (row?.findings ?? {}) as Record<string, unknown>;

describe.each(BACKENDS)("a test row changed from the row as it lands, on the $name backend", ({ open }) => {
  let storage: IStorage;
  let clientId = "";

  beforeAll(async () => {
    ({ storage } = await open());
    clientId = (await storage.createClient({ name: "Rows", company: "Rows Co", email: "r@r.test" })).id;
  });

  const aRow = () => storage.createTest({ clientId, testType: "penetration_test", status: "running", findings: { runId: "run-1" } });

  it("hands the change the row as it is when it lands: two writers started together each keep their field", async () => {
    const { id } = await aRow();
    const [first, second] = await Promise.all([
      storage.updateTestWith(id, (row) => ({ findings: { ...findingsOf(row), backendMirror: { mirrored: true } } })),
      storage.updateTestWith(id, (row) => ({ findings: { ...findingsOf(row), backend: { status: "stopped" } }, status: "aborted" })),
    ]);
    expect(findingsOf(first)).toEqual({ runId: "run-1", backendMirror: { mirrored: true } });
    expect(findingsOf(second)).toEqual({ runId: "run-1", backendMirror: { mirrored: true }, backend: { status: "stopped" } });
    const row = await storage.getTest(id);
    expect(row?.status).toBe("aborted");
    expect(findingsOf(row)).toEqual({ runId: "run-1", backendMirror: { mirrored: true }, backend: { status: "stopped" } });
  });

  it("hands the change a write made after the caller's own read", async () => {
    const { id } = await aRow();
    const read = await storage.getTest(id);
    await storage.updateTest(id, { findings: { ...findingsOf(read), backend: { status: "completed" } } });
    const seen: unknown[] = [];
    await storage.updateTestWith(id, (row) => {
      seen.push(row.findings);
      return { findings: { ...findingsOf(row), backendMirror: { mirrored: false } } };
    });
    expect(seen).toEqual([{ runId: "run-1", backend: { status: "completed" } }]);
    expect(findingsOf(await storage.getTest(id))).toEqual({ runId: "run-1", backend: { status: "completed" }, backendMirror: { mirrored: false } });
  });

  it("writes nothing for a change that answers null, and answers the row as it is", async () => {
    const { id } = await aRow();
    const answered = await storage.updateTestWith(id, () => null);
    expect(answered?.id).toBe(id);
    expect(answered?.status).toBe("running");
    expect(findingsOf(answered)).toEqual({ runId: "run-1" });
    expect(findingsOf(await storage.getTest(id))).toEqual({ runId: "run-1" });
  });

  it("answers undefined for a row that is not there, and asks nothing", async () => {
    const change = vi.fn(() => ({ status: "aborted" }));
    expect(await storage.updateTestWith("no-such-test", change)).toBeUndefined();
    expect(change).not.toHaveBeenCalled();
  });

  it("leaves the row a Stop finds from memory (peekTest) as written", async () => {
    const { id } = await aRow();
    await storage.updateTestWith(id, (row) => ({ status: "aborted", findings: { ...findingsOf(row), backendMirror: { mirrored: true } } }));
    expect(storage.peekTest(id)?.status).toBe("aborted");
    expect(findingsOf(storage.peekTest(id))).toEqual({ runId: "run-1", backendMirror: { mirrored: true } });
  });
});

describe("a test row changed from the row as it lands, with another dashboard on the SQLite file", () => {
  let storage: IStorage;
  let dbPath = "";
  let clientId = "";

  beforeAll(async () => {
    const opened = await BACKENDS[1].open();
    storage = opened.storage;
    dbPath = opened.dbPath!;
    clientId = (await storage.createClient({ name: "Shared", company: "Shared Co", email: "s@s.test" })).id;
  });

  const aRow = () => storage.createTest({ clientId, testType: "penetration_test", status: "running", findings: { runId: "run-1" } });

  it("waits out another connection's write lock off the event loop, and hands the change the row that connection committed", async () => {
    const { id } = await aRow();
    const other = new Database(dbPath);
    try {
      other.pragma("busy_timeout = 0");
      // Another dashboard on the file writes the row's record and holds the lock.
      other.exec("BEGIN IMMEDIATE");
      other.prepare("UPDATE tests SET findings = ? WHERE id = ?").run(JSON.stringify({ runId: "run-1", backend: { status: "stopped" } }), id);
      let settled = false;
      const pending = storage.updateTestWith(id, (row) => ({ findings: { ...findingsOf(row), backendMirror: { mirrored: true } } }))
        .finally(() => { settled = true; });
      // The loop turns while the lock is held -- a timer fires -- and the write waits: nothing here waits on the lock on the loop.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(settled, "the write landed while another connection held the lock").toBe(false);
      other.exec("COMMIT");
      const written = await pending;
      expect(findingsOf(written)).toEqual({ runId: "run-1", backend: { status: "stopped" }, backendMirror: { mirrored: true } });
      expect(findingsOf(await storage.getTest(id))).toEqual({ runId: "run-1", backend: { status: "stopped" }, backendMirror: { mirrored: true } });
    } finally {
      if (other.inTransaction) other.exec("ROLLBACK");
      other.close();
    }
  });
});
