import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

/**
 * A database that already holds two checks for one engine run still opens.
 *
 * One check per engine run is held by a unique index on
 * finding_checks(engine_run_id). Creating that index over rows that break it
 * throws, and a dashboard whose database will not open stops nothing. So the
 * duplicates are found first and reported, the index is left off, and the
 * dashboard opens.
 */
afterAll(() => {
  process.env.ATHENA_STORAGE = "memory";
  delete process.env.ATHENA_DB_PATH;
});

describe("opening a database with duplicate engine run ids on its checks", () => {
  it("opens, reports the duplicates, and leaves the unique index off", async () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "athena-dup-checks-")), "athena.db");
    const seed = new Database(dbPath);
    seed.exec(`CREATE TABLE finding_checks (
      id TEXT PRIMARY KEY, finding_id TEXT NOT NULL, verdict TEXT NOT NULL, detail TEXT, run_id TEXT,
      inventory_digest TEXT, checked_by TEXT, checked_at INTEGER NOT NULL,
      engine_run_id TEXT, filed_via TEXT, requested_at INTEGER)`);
    const insert = seed.prepare("INSERT INTO finding_checks (id, finding_id, verdict, checked_at, engine_run_id) VALUES (?, 'f', 'closed', 1, ?)");
    insert.run("c1", "run-twice");
    insert.run("c2", "run-twice");
    insert.run("c3", "run-once");
    seed.close();

    process.env.ATHENA_STORAGE = "sqlite";
    process.env.ATHENA_DB_PATH = dbPath;
    vi.resetModules();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = await import("../server/db-sqlite");
    db.openDatabase();
    const storage = (await import("../server/storage-sqlite")).storage;
    expect(await storage.getChecks("f")).toHaveLength(3);
    expect(db.openReport.duplicateEngineRunIds).toEqual(["run-twice"]);
    expect(logged.mock.calls.flat().join(" ")).toMatch(/more than one check for engine run\(s\) run-twice/);
    const index = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_checks_engine_run'").get();
    expect(index).toBeUndefined();
    logged.mockRestore();
  });

  it("without duplicates, the unique index is created", async () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "athena-dup-checks-")), "athena.db");
    process.env.ATHENA_STORAGE = "sqlite";
    process.env.ATHENA_DB_PATH = dbPath;
    vi.resetModules();
    const db = await import("../server/db-sqlite");
    db.openDatabase();
    expect(db.openReport.duplicateEngineRunIds).toEqual([]);
    const index = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_checks_engine_run'").get();
    expect(index).toEqual({ name: "idx_checks_engine_run" });
  });
});
