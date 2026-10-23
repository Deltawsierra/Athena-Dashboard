import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * A database that already exists, and a column added after it did.
 *
 * The schema is created with CREATE TABLE IF NOT EXISTS, which does exactly
 * nothing to a table that is already there. So a column added to the schema
 * reaches new installs and no others: on every database anybody is actually
 * using, the first query naming it answers "no such column" and the screen
 * behind it returns 500. connection_settings got away with it by being a whole
 * new table; is_sample is a column on four existing ones and would not have.
 *
 * These run against a real file rather than :memory:, because the whole
 * failure is about a database that outlived the code that created it.
 */
describe("adding a column to a database that already exists", () => {
  function oldShapedDatabase(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-migration-"));
    const file = path.join(dir, "athena.db");
    const handle = new Database(file);
    // The clients/sites/tests/documents tables exactly as they were before
    // is_sample existed. Rows in them, so this is not an empty-table shortcut.
    handle.exec(`
      CREATE TABLE clients (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT NOT NULL,
        email TEXT NOT NULL, phone TEXT, status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL, last_test_date INTEGER, notes TEXT
      );
      CREATE TABLE sites (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, url TEXT NOT NULL,
        name TEXT NOT NULL, environment TEXT NOT NULL DEFAULT 'production',
        status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
      );
      CREATE TABLE tests (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, site_id TEXT,
        test_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        severity TEXT, started_at INTEGER NOT NULL, completed_at INTEGER,
        summary TEXT, findings TEXT,
        vulnerabilities_found INTEGER NOT NULL DEFAULT 0,
        critical_count INTEGER NOT NULL DEFAULT 0,
        high_count INTEGER NOT NULL DEFAULT 0,
        medium_count INTEGER NOT NULL DEFAULT 0,
        low_count INTEGER NOT NULL DEFAULT 0, executed_by TEXT
      );
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT, document_type TEXT NOT NULL, file_url TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT
      );
      INSERT INTO clients (id, name, company, email, created_at)
        VALUES ('c1', 'Existing Client', 'Existing Ltd', 'e@example.test', 1000);
      INSERT INTO tests (id, client_id, test_type, started_at, critical_count)
        VALUES ('t1', 'c1', 'penetration-test', 1000, 2);
    `);
    handle.close();
    return file;
  }

  it("adds the column, keeps the rows, and defaults them to not-sample", async () => {
    process.env.ATHENA_DB_PATH = oldShapedDatabase();
    const { storage } = await import("../server/storage-sqlite");

    // Reaching the row at all is the assertion: without the ALTER TABLE this
    // is where drizzle asks for clients.is_sample and SQLite refuses.
    const client = await storage.getClient("c1");
    expect(client?.name).toBe("Existing Client");
    expect(client?.isSample).toBe(false);

    const test = await storage.getTest("t1");
    expect(test?.criticalCount).toBe(2);
    expect(test?.isSample).toBe(false);

    // A record that predates the column is a real one, so it is not swept.
    const counts = await storage.countSampleData();
    expect(counts).toEqual({ clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 });

    const removed = await storage.removeSampleData();
    expect(removed.clients).toBe(0);
    expect((await storage.getClient("c1"))?.name).toBe("Existing Client");
  });

  it("relaxes tests.client_id so a scan adopted from the backend record can name no client, keeps the rows, and records one row per backend scan", async () => {
    process.env.ATHENA_DB_PATH = oldShapedDatabase();
    vi.resetModules();
    const { storage } = await import("../server/storage-sqlite");
    const { openReport } = await import("../server/db-sqlite");

    // The old row came through the rebuild, is_sample and all.
    const kept = await storage.getTest("t1");
    expect(kept?.criticalCount).toBe(2);
    expect(kept?.clientId).toBe("c1");
    expect(kept?.isSample).toBe(false);
    expect((await storage.getTestsByClient("c1")).map((one) => one.id)).toEqual(["t1"]);

    // A row with no client, which the old shape refused outright.
    const adopted = await storage.createTest({
      clientId: null, testType: "penetration_test", status: "running",
      findings: { runId: "run-9", target: "https://x.example/", results: [], backendScanId: "scan-9", backendEngagementId: 9, source: "backend" },
    });
    expect(adopted.clientId).toBeNull();
    expect((await storage.getTest(adopted.id))?.clientId).toBeNull();

    // One row per backend scan: the index was created, and refuses a second.
    expect(openReport.duplicateBackendScanIds).toEqual([]);
    expect(openReport.backendScanIndexNotCreated).toBeNull();
    await expect(storage.createTest({
      clientId: "c1", testType: "penetration_test", status: "running",
      findings: { runId: "run-10", target: "https://x.example/", results: [], backendScanId: "scan-9" },
    })).rejects.toThrow("a test already names backend scan scan-9");
    // A person's test names no backend scan, and is not refused by it.
    expect((await storage.createTest({ clientId: "c1", testType: "manual", status: "pending", findings: { details: "by hand" } })).id).toBeTruthy();
  });

  it("leaves the backend-scan index off, and says so, when a database already holds two rows for one backend scan", async () => {
    const file = oldShapedDatabase();
    const handle = new Database(file);
    handle.exec(`
      INSERT INTO tests (id, client_id, test_type, started_at, findings)
        VALUES ('d1', 'c1', 'penetration_test', 1000, '{"runId":"run-1","backendScanId":"scan-twice"}'),
               ('d2', 'c1', 'penetration_test', 1001, '{"runId":"run-2","backendScanId":"scan-twice"}');
    `);
    handle.close();
    process.env.ATHENA_DB_PATH = file;
    vi.resetModules();
    const { storage } = await import("../server/storage-sqlite");
    const { openReport } = await import("../server/db-sqlite");
    // The database opens, both rows stand, and the duplicate is reported rather than the open failing.
    expect((await storage.getTestsByClient("c1")).map((one) => one.id).sort()).toEqual(["d1", "d2", "t1"]);
    expect(openReport.duplicateBackendScanIds).toEqual(["scan-twice"]);
  });

  it("labels every finding and sighting written before the source column existed as this dashboard's own, directly from the engine", async () => {
    const file = oldShapedDatabase();
    const handle = new Database(file);
    // findings and finding_sightings exactly as they were before `source` existed, with a row each.
    handle.exec(`
      CREATE TABLE findings (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, client_id TEXT NOT NULL, site_id TEXT, engagement_ref TEXT NOT NULL,
        type TEXT NOT NULL, severity TEXT, message TEXT, target TEXT, endpoint TEXT, header TEXT,
        status TEXT NOT NULL DEFAULT 'open', owner_id TEXT, status_note TEXT, status_changed_by TEXT, status_changed_at INTEGER,
        first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, times_seen INTEGER NOT NULL DEFAULT 1,
        last_test_id TEXT, last_run_id TEXT, fixed_at INTEGER, fixed_by_run_id TEXT, fixed_verdict TEXT, reopened_at INTEGER,
        is_sample INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE finding_sightings (
        id TEXT PRIMARY KEY, finding_id TEXT NOT NULL, run_id TEXT, test_id TEXT, seen INTEGER NOT NULL, observed_at INTEGER NOT NULL
      );
      INSERT INTO findings (id, fingerprint, client_id, engagement_ref, type, severity, first_seen_at, last_seen_at)
        VALUES ('f-old', 'fp-old', 'c1', 'existing.example', 'sql_injection', 'high', 1000, 1000);
      INSERT INTO finding_sightings (id, finding_id, run_id, test_id, seen, observed_at) VALUES ('s-old', 'f-old', 'run-old', 't1', 1, 1000);
    `);
    handle.close();
    process.env.ATHENA_DB_PATH = file;
    vi.resetModules();
    const { storage } = await import("../server/storage-sqlite");
    // The old rows read as what they are: filed by this dashboard directly from the engine, before the label existed.
    expect((await storage.getFindingsByClient("c1")).map((one) => [one.id, one.source])).toEqual([["f-old", "dashboard-direct"]]);
    expect((await storage.getSightings("f-old")).map((one) => one.source)).toEqual(["dashboard-direct"]);
    // And a new row carries the label without being told to.
    const made = await storage.createFinding({ fingerprint: "fp-new", clientId: "c1", engagementRef: "existing.example", type: "xss", status: "open" });
    expect(made.source).toBe("dashboard-direct");
    await storage.recordSighting(made.id, "run-new", "t1", true);
    expect((await storage.getSightings(made.id)).map((one) => one.source)).toEqual(["dashboard-direct"]);
  });

  it("relaxes the health columns that have no source, keeping the rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-health-"));
    const file = path.join(dir, "athena.db");
    const handle = new Database(file);
    // ai_health_metrics exactly as it was: four columns NOT NULL, which is
    // what obliged the installer to invent a detection accuracy -- the column
    // would not accept the truth, which was that nobody had measured one.
    handle.exec(`
      CREATE TABLE ai_health_metrics (
        id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL,
        cpu_usage INTEGER NOT NULL, memory_usage INTEGER NOT NULL,
        active_scans INTEGER NOT NULL DEFAULT 0,
        total_scans_today INTEGER NOT NULL DEFAULT 0,
        success_rate INTEGER NOT NULL,
        average_response_time INTEGER NOT NULL,
        models_loaded TEXT, last_training_date INTEGER,
        detection_accuracy INTEGER NOT NULL,
        false_positive_rate INTEGER NOT NULL
      );
      INSERT INTO ai_health_metrics
        (id, timestamp, cpu_usage, memory_usage, success_rate,
         average_response_time, detection_accuracy, false_positive_rate)
        VALUES ('m1', 1000, 24, 41, 98, 220, 94, 3);
    `);
    handle.close();

    process.env.ATHENA_DB_PATH = file;
    // The connection is a module singleton, so without this the previous case's
    // database answers this one's questions.
    vi.resetModules();
    const { storage } = await import("../server/storage-sqlite");

    // The old row survives the rebuild, fabricated figures and all. Removing
    // somebody's data at startup is not this migration's business; what it
    // does is make it possible to write the truth from now on.
    const kept = await storage.getLatestAIHealthMetric();
    expect(kept?.cpuUsage).toBe(24);
    expect(kept?.detectionAccuracy).toBe(94);

    // And a new reading can leave those columns empty, which the old shape
    // rejected outright.
    const written = await storage.createAIHealthMetric({
      cpuUsage: 7, memoryUsage: 8, detectionAccuracy: null, falsePositiveRate: null,
      successRate: null, averageResponseTime: null,
    });
    expect(written.detectionAccuracy).toBeNull();
    expect(written.successRate).toBeNull();
  });
});
