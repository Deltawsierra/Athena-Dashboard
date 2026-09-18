import { describe, it, expect, beforeAll } from "vitest";
import type { IStorage } from "../server/storage";

/**
 * Exercises the real SQLite backend, not the in-memory one.
 *
 * The audit found that the PostgreSQL schema executed against better-sqlite3
 * could not bind booleans, wrote timestamps that read back as Invalid Date,
 * double-encoded JSON, and mangled arrays. Every one of those field types is
 * asserted here against an on-disk-equivalent database.
 */
describe("SQLite storage", () => {
  let storage: IStorage;

  beforeAll(async () => {
    process.env.ATHENA_DB_PATH = ":memory:";
    const mod = await import("../server/storage-sqlite");
    storage = mod.storage;
  });

  it("stores and returns booleans as booleans", async () => {
    const user = await storage.createUser({
      username: "bool-user",
      password: "a-password-long-enough",
      role: "admin",
      email: "bool@example.test",
      isActive: true,
    });
    expect(user.isActive).toBe(true);

    const fetched = await storage.getUser(user.id);
    expect(fetched?.isActive).toBe(true);
    expect(typeof fetched?.isActive).toBe("boolean");

    const deactivated = await storage.updateUser(user.id, { isActive: false });
    expect(deactivated?.isActive).toBe(false);
  });

  it("hashes passwords on write and validates them on read", async () => {
    const user = await storage.createUser({ username: "hash-user", password: "another-password" });
    expect(user.password).not.toBe("another-password");
    expect(user.password.startsWith("scrypt$")).toBe(true);

    expect(await storage.validateUser("hash-user", "another-password")).toBeTruthy();
    expect(await storage.validateUser("hash-user", "wrong")).toBeUndefined();
  });

  it("round-trips timestamps as valid Dates", async () => {
    const client = await storage.createClient({
      name: "Time Co",
      company: "Time Co",
      email: "t@time.test",
    });
    expect(client.createdAt).toBeInstanceOf(Date);
    expect(client.createdAt.toString()).not.toBe("Invalid Date");

    const fetched = await storage.getClient(client.id);
    expect(fetched?.createdAt).toBeInstanceOf(Date);
    expect(fetched?.createdAt.toString()).not.toBe("Invalid Date");
    expect(fetched?.createdAt.getTime()).toBe(client.createdAt.getTime());
  });

  it("accepts a nullable date and reads it back", async () => {
    const client = await storage.createClient({ name: "D", company: "D", email: "d@d.test" });
    const when = new Date("2026-03-01T12:00:00.000Z");
    const updated = await storage.updateClient(client.id, { lastTestDate: when });
    expect(updated?.lastTestDate?.getTime()).toBe(when.getTime());

    const cleared = await storage.updateClient(client.id, { lastTestDate: null });
    expect(cleared?.lastTestDate).toBeNull();
  });

  it("round-trips JSON as an object, encoded exactly once", async () => {
    const client = await storage.createClient({ name: "J", company: "J", email: "j@j.test" });
    const findings = { details: "SQLi in login", severity: "high", refs: ["CWE-89"] };

    const test = await storage.createTest({
      clientId: client.id,
      testType: "penetration-test",
      findings,
    });

    const fetched = await storage.getTest(test.id);
    expect(fetched?.findings).toEqual(findings);
    expect(typeof fetched?.findings).toBe("object");
  });

  it("round-trips string arrays", async () => {
    const settings = await storage.updateAIControlSettings({
      activeSystems: ["scanner", "classifier", "monitor"],
    });
    expect(settings.activeSystems).toEqual(["scanner", "classifier", "monitor"]);

    const readBack = await storage.getAIControlSettings();
    expect(readBack?.activeSystems).toEqual(["scanner", "classifier", "monitor"]);
    // The PostgreSQL array parser used to append a stray "]" element.
    expect(readBack?.activeSystems).toHaveLength(3);
  });

  it("creates the control-settings row on first update and updates it thereafter", async () => {
    const first = await storage.updateAIControlSettings({ killSwitchEnabled: true });
    expect(first.killSwitchEnabled).toBe(true);

    const second = await storage.updateAIControlSettings({ killSwitchEnabled: false });
    expect(second.id).toBe(first.id);
    expect(second.killSwitchEnabled).toBe(false);
  });

  it("writes and reads activity logs, newest first", async () => {
    await storage.createActivityLog({ action: "first", entityType: "test", entityId: "1" });
    await new Promise((r) => setTimeout(r, 5));
    await storage.createActivityLog({ action: "second", entityType: "test", entityId: "2" });

    const logs = await storage.getAllActivityLogs();
    expect(logs[0].action).toBe("second");
    expect(logs[0].timestamp).toBeInstanceOf(Date);

    const scoped = await storage.getActivityLogsByEntity("test", "1");
    expect(scoped).toHaveLength(1);
    expect(scoped[0].action).toBe("first");
  });

  it("returns AI health metrics newest first and honours the limit", async () => {
    const base = {
      cpuUsage: 1, memoryUsage: 2, successRate: 99,
      averageResponseTime: 100, detectionAccuracy: 95, falsePositiveRate: 1,
    };
    await storage.createAIHealthMetric({ ...base, cpuUsage: 10 });
    await new Promise((r) => setTimeout(r, 5));
    await storage.createAIHealthMetric({ ...base, cpuUsage: 20 });

    const latest = await storage.getLatestAIHealthMetric();
    expect(latest?.cpuUsage).toBe(20);

    const limited = await storage.getAIHealthMetrics(1);
    expect(limited).toHaveLength(1);
    expect(limited[0].cpuUsage).toBe(20);
  });

  it("supports sites, which had no working implementation at all", async () => {
    const client = await storage.createClient({ name: "S", company: "S", email: "s@s.test" });
    const site = await storage.createSite({
      clientId: client.id,
      url: "https://prod.example.test",
      name: "Production",
    });
    expect(site.id).toBeTruthy();
    expect(site.environment).toBe("production");

    const byClient = await storage.getSitesByClient(client.id);
    expect(byClient).toHaveLength(1);

    expect(await storage.deleteSite(site.id)).toBe(true);
    expect(await storage.deleteSite(site.id)).toBe(false);
  });

  it("reports deletion of a missing row as false rather than throwing", async () => {
    expect(await storage.deleteClient("no-such-id")).toBe(false);
    expect(await storage.deleteTest("no-such-id")).toBe(false);
    expect(await storage.deleteDocument("no-such-id")).toBe(false);
    expect(await storage.deleteClassifier("no-such-id")).toBe(false);
  });

  /**
   * The settings row, against the real backend.
   *
   * The whole suite above this one runs on in-memory storage, which is why it
   * could not catch that `connection_settings` was in the Drizzle schema and
   * not in the hand-written DDL that actually creates the tables. Saving a
   * setting answered 500 with `no such table` on a real database while every
   * test passed.
   */
  it("creates the connection settings row and reads it back", async () => {
    expect(await storage.getConnectionSettings()).toBeUndefined();

    const saved = await storage.updateConnectionSettings(
      { engineUrl: "https://engine.internal:8099", engineKey: "a-key" },
      "admin-id",
    );
    expect(saved.engineUrl).toBe("https://engine.internal:8099");
    expect(saved.engineKey).toBe("a-key");
    expect(saved.updatedBy).toBe("admin-id");
    // A timestamp column that reads back as Invalid Date is the defect this
    // whole file exists for.
    expect(saved.updatedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(saved.updatedAt.getTime())).toBe(false);

    const again = await storage.getConnectionSettings();
    expect(again?.engineUrl).toBe("https://engine.internal:8099");
  });

  it("leaves fields it was not given alone, and clears the ones set to null", async () => {
    await storage.updateConnectionSettings({ assistantModel: "a-model" }, null);
    expect((await storage.getConnectionSettings())?.engineUrl)
      .toBe("https://engine.internal:8099");

    await storage.updateConnectionSettings({ engineKey: null }, null);
    const row = await storage.getConnectionSettings();
    expect(row?.engineKey).toBeNull();
    expect(row?.assistantModel).toBe("a-model");
  });

  it("mints an API key hash-only, finds it by hash, and revokes it durably", async () => {
    const { key, secret } = await storage.createApiKey({ name: "sqlite-key", createdBy: "admin-id" });
    expect(secret.startsWith("athena_")).toBe(true);
    // The stored record carries the display prefix and a hash — never the secret.
    expect(key.prefix.startsWith("athena_")).toBe(true);
    expect(key.keyHash).not.toBe(secret);
    expect(key.revokedAt).toBeNull();
    expect(key.createdAt).toBeInstanceOf(Date);

    // Re-hashing the plaintext locates the live record (what auth does).
    const { hashApiKey } = await import("../server/api-keys");
    const found = await storage.findActiveApiKeyByHash(hashApiKey(secret));
    expect(found?.id).toBe(key.id);

    await storage.touchApiKey(key.id);
    const touched = (await storage.getAllApiKeys()).find((k) => k.id === key.id);
    expect(touched?.lastUsedAt).toBeInstanceOf(Date);

    const revoked = await storage.revokeApiKey(key.id);
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    // A revoked key is no longer found by the live-key lookup.
    expect(await storage.findActiveApiKeyByHash(hashApiKey(secret))).toBeUndefined();
  });
});
