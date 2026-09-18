import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { makeApp, signIn } from "./helpers";

/**
 * API keys: programmatic credentials for the dashboard's own API, owned by the
 * server that owns auth. Minting/listing/revoking are admin-only; the plaintext
 * secret is shown exactly once and only its hash is stored; and a live key
 * authenticates as the account that created it, until it is revoked.
 */
describe("API keys", () => {
  let app: Express;
  let admin: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    app = await makeApp();
    admin = await signIn(app);
  });

  it("refuses key management to anyone not signed in", async () => {
    expect((await request(app).get("/api/api-keys")).status).toBe(401);
    expect((await request(app).post("/api/api-keys").send({ name: "x" })).status).toBe(401);
    expect((await request(app).delete("/api/api-keys/anything")).status).toBe(401);
  });

  it("gates key management to admins: a non-admin gets 403", async () => {
    await admin.post("/api/users").send({
      username: "keys-analyst", password: "analyst-password", role: "user",
    });
    const analyst = await signIn(app, "keys-analyst", "analyst-password");
    expect((await analyst.get("/api/api-keys")).status).toBe(403);
    expect((await analyst.post("/api/api-keys").send({ name: "x" })).status).toBe(403);
  });

  it("mints a key, returns the plaintext exactly once, and never stores or lists it", async () => {
    const created = await admin.post("/api/api-keys").send({ name: "CI pipeline" });
    expect(created.status).toBe(201);
    // The secret is returned once, marked, and high-entropy.
    expect(typeof created.body.secret).toBe("string");
    expect(created.body.secret.startsWith("athena_")).toBe(true);
    expect(created.body.secret.length).toBeGreaterThan(30);
    // The stored record carries a display prefix but never the hash or secret.
    expect(created.body.key).toMatchObject({ name: "CI pipeline" });
    expect(created.body.key).not.toHaveProperty("keyHash");
    expect(created.body.key.prefix.startsWith("athena_")).toBe(true);

    const list = await admin.get("/api/api-keys");
    expect(list.status).toBe(200);
    const row = list.body.find((k: { id: string }) => k.id === created.body.key.id);
    expect(row).toBeTruthy();
    // The list holds metadata only — never the hash, never the plaintext.
    expect(row).not.toHaveProperty("keyHash");
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);
  });

  it("rejects a key with no name", async () => {
    expect((await admin.post("/api/api-keys").send({})).status).toBe(400);
  });

  it("authenticates a request with a live key, as the account that created it", async () => {
    const created = await admin.post("/api/api-keys").send({ name: "reader" });
    const secret = created.body.secret as string;

    // The admin created it, so the key reaches an admin-only route — via the
    // dedicated header and via the Authorization bearer form.
    expect((await request(app).get("/api/api-keys").set("x-api-key", secret)).status).toBe(200);
    expect(
      (await request(app).get("/api/api-keys").set("authorization", `Bearer ${secret}`)).status,
    ).toBe(200);

    // Using the key stamps its last-used time.
    const list = await admin.get("/api/api-keys");
    const row = list.body.find((k: { id: string }) => k.id === created.body.key.id);
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("stops authenticating once the key is revoked", async () => {
    const created = await admin.post("/api/api-keys").send({ name: "to-revoke" });
    const secret = created.body.secret as string;
    expect((await request(app).get("/api/api-keys").set("x-api-key", secret)).status).toBe(200);

    const revoked = await admin.delete(`/api/api-keys/${created.body.key.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).not.toBeNull();

    // A revoked key is dead: it authenticates nothing.
    expect((await request(app).get("/api/api-keys").set("x-api-key", secret)).status).toBe(401);
  });

  it("ignores a garbage or non-key bearer token", async () => {
    expect((await request(app).get("/api/api-keys").set("x-api-key", "athena_not-a-real-key")).status).toBe(401);
    expect(
      (await request(app).get("/api/api-keys").set("authorization", "Bearer some-other-token")).status,
    ).toBe(401);
  });

  it("404s when revoking a key that does not exist", async () => {
    expect((await admin.delete("/api/api-keys/nope")).status).toBe(404);
  });
});
