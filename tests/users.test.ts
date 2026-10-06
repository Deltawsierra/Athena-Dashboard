import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { makeApp, signIn } from "./helpers";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

describe("user administration", () => {
  let app: Express;
  let admin: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    app = await makeApp();
    admin = await signIn(app);
  });

  it("creates a user and never echoes the password", async () => {
    const res = await admin
      .post("/api/users")
      .send({ username: "analyst", password: "analyst-password", role: "user", email: "a@example.com" });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("password");
    expect(res.body.role).toBe("user");
  });

  it("rejects a short password", async () => {
    const res = await admin.post("/api/users").send({ username: "weak", password: "short", role: "user" });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate username", async () => {
    const res = await admin.post("/api/users").send({ username: "admin", password: "another-password" });
    expect(res.status).toBe(409);
  });

  // The audit found that PATCH /api/users/:id accepted role and password from
  // an unauthenticated caller. Both halves of that are covered here.
  it("refuses privilege changes from a non-admin session", async () => {
    const analyst = await signIn(app, "analyst", "analyst-password");
    const users = await admin.get("/api/users");
    const target = users.body.find((u: { username: string }) => u.username === "admin");

    const res = await analyst.patch(`/api/users/${target.id}`).send({ role: "user", password: "pwned123" });
    expect(res.status).toBe(403);

    // The admin password still works.
    await request(app).post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD }).expect(200);
  });

  it("refuses unknown fields on update", async () => {
    const users = await admin.get("/api/users");
    const target = users.body.find((u: { username: string }) => u.username === "analyst");
    const res = await admin.patch(`/api/users/${target.id}`).send({ username: "renamed" });
    expect(res.status).toBe(400);
  });

  it("stops an admin from demoting or deleting themselves", async () => {
    const check = await admin.get("/api/auth/check");
    const selfId = check.body.user.id;
    await admin.patch(`/api/users/${selfId}`).send({ role: "user" }).expect(400);
    await admin.delete(`/api/users/${selfId}`).expect(400);
  });

  it("lets an admin change another user's password, and the new one works", async () => {
    const users = await admin.get("/api/users");
    const target = users.body.find((u: { username: string }) => u.username === "analyst");
    await admin.patch(`/api/users/${target.id}`).send({ password: "rotated-password" }).expect(200);
    await request(app).post("/api/auth/login").send({ username: "analyst", password: "rotated-password" }).expect(200);
    await request(app).post("/api/auth/login").send({ username: "analyst", password: "analyst-password" }).expect(401);
  });
});
