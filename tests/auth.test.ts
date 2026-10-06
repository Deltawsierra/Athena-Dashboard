import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { makeApp, signIn } from "./helpers";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

describe("authentication", () => {
  let app: Express;
  beforeAll(async () => {
    app = await makeApp();
  });

  it("rejects a wrong password", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "admin", password: "nope" });
    expect(res.status).toBe(401);
  });

  it("accepts the seeded admin and returns the user without a password", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("admin");
    expect(res.body.user.role).toBe("admin");
    expect(res.body.user).not.toHaveProperty("password");
  });

  it("reports anonymous callers as not authenticated", async () => {
    const res = await request(app).get("/api/auth/check");
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
  });

  it("reports a signed-in session as authenticated", async () => {
    const agent = await signIn(app);
    const res = await agent.get("/api/auth/check");
    expect(res.body.authenticated).toBe(true);
    expect(res.body.user.username).toBe("admin");
  });

  it("ends the session on logout", async () => {
    const agent = await signIn(app);
    await agent.post("/api/auth/logout").expect(200);
    const res = await agent.get("/api/auth/check");
    expect(res.body.authenticated).toBe(false);
  });
});

describe("route protection", () => {
  let app: Express;
  beforeAll(async () => {
    app = await makeApp();
  });

  const protectedRoutes: Array<[string, string]> = [
    ["get", "/api/clients"],
    ["get", "/api/tests"],
    ["get", "/api/documents"],
    ["get", "/api/sites"],
    ["get", "/api/logs"],
    ["get", "/api/users"],
    ["get", "/api/ai-control"],
    ["get", "/api/classifiers"],
    ["get", "/api/chat"],
    ["get", "/api/ai-health"],
  ];

  it.each(protectedRoutes)("rejects anonymous %s %s with 401", async (method, path) => {
    const res = await (request(app) as never as Record<string, (p: string) => request.Test>)[method](path);
    expect(res.status).toBe(401);
  });

  it("rejects anonymous writes", async () => {
    await request(app).post("/api/clients").send({ name: "x", company: "y", email: "a@b.co" }).expect(401);
    await request(app).delete("/api/clients/anything").expect(401);
  });

  it("returns 404 for unknown API paths instead of falling through to the SPA", async () => {
    const agent = await signIn(app);
    const res = await agent.get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/json/);
  });
});
