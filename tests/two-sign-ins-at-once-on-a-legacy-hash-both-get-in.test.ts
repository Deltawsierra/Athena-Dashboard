import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { adminHasSetPassword } from "./test-admin";

const OLD = "the-old-legacy-hashed-pw"; // pragma: allowlist secret
const legacy = (pw: string) => crypto.createHash("sha256").update(pw).digest("hex");

/**
 * The rehash of a legacy hash writes only over the hash it verified (round 3,
 * F1), and that write cannot tell a password changed under it from another
 * sign-in that already rehashed the same password. Refused on either, the
 * second of two correct sign-ins at once answered 401 with the right password,
 * and its counted failure stood. The hash in force decides now: a sign-in whose
 * password still verifies against it is let in (#65 review round 4, F3).
 */
describe("two sign-ins at once on a legacy hash", () => {

  it("in the memory backend: two concurrent correct sign-ins on a legacy hash both succeed", async () => {
  const { MemStorage } = await import("../server/storage");
  const mem = new MemStorage();
  const u = await mem.createUser({ username: "c", password: "placeholder-password-1", role: "admin", isActive: true }); // pragma: allowlist secret
  (mem as unknown as { users: Map<string, { password: string }> }).users.get(u.id)!.password = legacy(OLD);
  const [a, b] = await Promise.all([mem.validateUser("c", OLD), mem.validateUser("c", OLD)]);
  expect([!!a, !!b]).toEqual([true, true]);
});

  it("sqlite over the API: two concurrent correct sign-ins on a legacy hash both succeed", async () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rehash-c-")), "athena.db");
  process.env.ATHENA_STORAGE = "sqlite";
  process.env.ATHENA_DB_PATH = dbFile;
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
  db.update(schema.users).set({ password: legacy(OLD) }).where(eq(schema.users.id, ops.id)).run();
  const rs = await Promise.all([1, 2, 3].map(() => request(app).post("/api/auth/login").send({ username: "ops", password: OLD })));
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
  expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
}, 60000);
});
