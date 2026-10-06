import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { hashPassword, verifyPassword } from "../server/password";

describe("password hashing", () => {
  it("produces a salted scrypt hash, not a bare digest", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash.split("$")).toHaveLength(3);
  });

  it("salts, so the same password hashes differently each time", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("s3cret-password");
    expect((await verifyPassword("s3cret-password", hash)).ok).toBe(true);
    expect((await verifyPassword("wrong", hash)).ok).toBe(false);
  });

  it("accepts a legacy unsalted SHA-256 hash and asks for a rehash", async () => {
    const legacy = crypto.createHash("sha256").update("a-legacy-sha256-password").digest("hex");
    const result = await verifyPassword("a-legacy-sha256-password", legacy);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(true);
  });

  it("rejects a wrong password against a legacy hash", async () => {
    const legacy = crypto.createHash("sha256").update("a-legacy-sha256-password").digest("hex");
    expect((await verifyPassword("nope", legacy)).ok).toBe(false);
  });

  it("handles missing or malformed stored hashes without throwing", async () => {
    expect((await verifyPassword("x", null)).ok).toBe(false);
    expect((await verifyPassword("x", "")).ok).toBe(false);
    expect((await verifyPassword("x", "scrypt$only-two-parts")).ok).toBe(false);
    expect((await verifyPassword("x", "not-a-hash")).ok).toBe(false);
  });
});
