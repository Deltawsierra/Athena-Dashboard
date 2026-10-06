import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { adminHasSetPassword } from "./test-admin";

/**
 * A sign-in that verified a legacy (sha256) hash rehashes the password it was
 * given, and the rehash is slow. The write used to be unconditional: a password
 * changed while it ran was overwritten with a hash of the OLD one, so the old
 * password stood again, and that sign-in's session held the account's current
 * stamp (auth.ts passwordStamp) -- a full session the change was meant to end.
 * The rehash now writes only over the hash the sign-in verified, and a sign-in
 * whose hash was replaced under it is refused. (#65 review round 3, F1.)
 */

const OLD = "the-old-legacy-hashed-pw"; // pragma: allowlist secret
const NEW = "the-new-password-after-change"; // pragma: allowlist secret

const hold = { next: false, release: () => {}, entered: () => {} };

vi.mock("../server/password", async (orig) => {
  const real = await orig<typeof import("../server/password")>();
  return {
    ...real,
    hashPassword: async (pw: string) => {
      if (hold.next && pw === OLD) {
        hold.next = false;
        const released = new Promise<void>((resolve) => { hold.release = resolve; });
        hold.entered();
        await released;
      }
      return real.hashPassword(pw);
    },
  };
});

function holdTheNextRehash(): Promise<void> {
  hold.next = true;
  return new Promise<void>((resolve) => { hold.entered = resolve; });
}

const legacy = (pw: string) => crypto.createHash("sha256").update(pw).digest("hex");

describe("a sign-in on an old hash never writes over a changed password", () => {
  it("over the API: the change stands, the old password is refused, and the in-flight sign-in holds nothing", async () => {
    const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rehash-")), "athena.db");
    process.env.ATHENA_STORAGE = "sqlite";
    process.env.ATHENA_DB_PATH = dbFile;
    try {
      const { createApp } = await import("../server/app");
      const { initializeDefaultData } = await import("../server/init-data");
      const { storage } = await import("../server/storage-unified");
      const { db } = await import("../server/db-sqlite");
      const schema = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const app = createApp();
      await initializeDefaultData();
      await adminHasSetPassword();

      const ops = await storage.createUser({ username: "ops", password: "placeholder-password-1", role: "admin", isActive: true }); // pragma: allowlist secret
      // An account from an early release: its hash is the legacy sha256.
      db.update(schema.users).set({ password: legacy(OLD) }).where(eq(schema.users.id, ops.id)).run();

      const rehashing = holdTheNextRehash();
      const inFlight = request.agent(app);
      const signingIn = inFlight.post("/api/auth/login").send({ username: "ops", password: OLD }).then((r) => r);
      await rehashing;

      const owner = request.agent(app);
      expect((await owner.post("/api/auth/login").send({ username: "ops", password: OLD })).status).toBe(200);
      expect((await owner.post("/api/auth/change-password").send({ currentPassword: OLD, newPassword: NEW })).status).toBe(200);

      hold.release();
      expect((await signingIn).status).toBe(401);

      expect((await inFlight.get("/api/users")).status).toBe(401);
      expect((await request(app).post("/api/auth/login").send({ username: "ops", password: OLD })).status).toBe(401);
      expect((await request(app).post("/api/auth/login").send({ username: "ops", password: NEW })).status).toBe(200);
    } finally {
      fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
    }
  }, 60_000);

  it("in the memory backend: a password changed during the rehash is the account's", async () => {
    const { MemStorage } = await import("../server/storage");
    const { verifyPassword } = await import("../server/password");
    const mem = new MemStorage();
    const ops = await mem.createUser({ username: "ops-mem", password: "placeholder-password-1", role: "admin", isActive: true }); // pragma: allowlist secret
    (mem as unknown as { users: Map<string, { password: string }> }).users.get(ops.id)!.password = legacy(OLD);

    const rehashing = holdTheNextRehash();
    const signingIn = mem.validateUser("ops-mem", OLD);
    await rehashing;
    await mem.updateUser(ops.id, { password: NEW });
    hold.release();

    expect(await signingIn).toBeUndefined();
    const stored = (await mem.getUser(ops.id))!.password;
    expect((await verifyPassword(NEW, stored)).ok).toBe(true);
    expect((await verifyPassword(OLD, stored)).ok).toBe(false);
  });

  it("with nothing changed, a legacy hash is still upgraded on sign-in", async () => {
    const { MemStorage } = await import("../server/storage");
    const mem = new MemStorage();
    const ops = await mem.createUser({ username: "ops-up", password: "placeholder-password-1", role: "admin", isActive: true }); // pragma: allowlist secret
    (mem as unknown as { users: Map<string, { password: string }> }).users.get(ops.id)!.password = legacy(OLD);

    const signedIn = await mem.validateUser("ops-up", OLD);

    expect(signedIn).toBeDefined();
    expect(signedIn!.password).not.toBe(legacy(OLD));
    expect((await mem.getUser(ops.id))!.password).toBe(signedIn!.password);
  });
});
