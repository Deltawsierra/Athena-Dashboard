import { describe, expect, it } from "vitest";

import type { IStorage } from "../server/storage";
import { flagEngaged, flagFromColumn, rowEngaged } from "../shared/kill-switch-flag";

/**
 * SAFETY (DASH-FAILSAFE-2): a stored kill-switch flag that is not exactly
 * `false` reads as engaged on both storage backends, never as off.
 *
 * The flag is typed boolean, but the row is data. On SQLite the boolean column
 * read `Number(value) === 1`, so the text "true" and the integer 2 read as off;
 * in memory a "true", a 1 or a null was handed on as it was, and the routes read
 * `=== true` in one place and `!flag` in another. Now SQLite reads the stored
 * value itself -- only an integer 0, what `false` is written as, is off -- and
 * the routes read `!== false` (shared/kill-switch-flag.ts). Stops pass the
 * switch before it is read either way (server/routes.ts enforceKillSwitch,
 * proven in no-missing-or-odd-field-makes-the-failsafe-less-strict.test.ts).
 */

describe("a stored flag value: only exactly false is off", () => {
  it("anything else -- \"true\", 1, null, undefined, a record, \"false\", 0 -- holds the switch engaged", () => {
    for (const flag of ["true", 1, null, undefined, { on: true }, "false", 0, ""]) {
      expect(flagEngaged(flag), JSON.stringify(flag) ?? "undefined").toBe(true);
    }
    expect(flagEngaged(false)).toBe(false);
    expect(flagEngaged(true)).toBe(true);
  });

  it("a row missing the flag holds it engaged; no row at all reads as it always did, off", () => {
    expect(rowEngaged({})).toBe(true);
    expect(rowEngaged({ killSwitchEnabled: false })).toBe(false);
    expect(rowEngaged(undefined)).toBe(false);
    expect(rowEngaged(null)).toBe(false);
  });

  it("a value SQLite stored: only the integer 0 is off", () => {
    for (const raw of [1, 2, -1, "true", "false", "0", null, Buffer.from([0])]) {
      expect(flagFromColumn(raw), String(raw)).toBe(true);
    }
    expect(flagFromColumn(0)).toBe(false);
    expect(flagFromColumn(BigInt(0))).toBe(false);
  });
});

describe("the SQLite backend reads the flag as stored", () => {
  it("\"true\", 2, -1 and \"false\" stored in the column each read as engaged, in the kill switch's read and the settings' read; 0 and 1 read as written", async () => {
    process.env.ATHENA_DB_PATH = ":memory:";
    const storage: IStorage = (await import("../server/storage-sqlite")).storage;
    const { sqlite } = await import("../server/db-sqlite");
    await storage.updateAIControlSettings({ killSwitchEnabled: false });
    const store = (raw: unknown) => sqlite.prepare("UPDATE ai_control_settings SET kill_switch_enabled = ?").run(raw);

    for (const raw of ["true", 2, -1, "false"]) {
      store(raw);
      expect((await storage.getKillSwitchState())?.killSwitchEnabled, `stored ${JSON.stringify(raw)}`).toBe(true);
      expect((await storage.getAIControlSettings())?.killSwitchEnabled, `stored ${JSON.stringify(raw)}`).toBe(true);
    }
    store(0);
    expect((await storage.getKillSwitchState())?.killSwitchEnabled).toBe(false);
    expect((await storage.getAIControlSettings())?.killSwitchEnabled).toBe(false);
    store(1);
    expect((await storage.getKillSwitchState())?.killSwitchEnabled).toBe(true);
    // The rest of the settings row reads as it did.
    const settings = await storage.getAIControlSettings();
    expect(settings?.systemStatus).toBe("active");
    expect(settings?.maxConcurrentTests).toBe(5);
    expect(settings?.lastModifiedAt).toBeInstanceOf(Date);
    // A write of false is stored as 0, and reads as off.
    await storage.updateAIControlSettings({ killSwitchEnabled: false });
    expect((await storage.getKillSwitchState())?.killSwitchEnabled).toBe(false);
  });
});

describe("the memory backend hands the stored value on, and the routes read it with rowEngaged", () => {
  it("a flag stored as \"true\", 1 or null is engaged as the routes read it", async () => {
    const { MemStorage } = await import("../server/storage");
    const storage = new MemStorage();
    for (const flag of ["true", 1, null]) {
      await storage.updateAIControlSettings({ killSwitchEnabled: flag as unknown as boolean });
      expect(rowEngaged(await storage.getKillSwitchState()), JSON.stringify(flag)).toBe(true);
    }
    await storage.updateAIControlSettings({ killSwitchEnabled: false });
    expect(rowEngaged(await storage.getKillSwitchState())).toBe(false);
  });
});
