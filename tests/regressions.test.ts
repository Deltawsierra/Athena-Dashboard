import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { makeApp, signIn } from "./helpers";
import { verifyPassword, hashPassword } from "../server/password";
import { resetLoginThrottle } from "../server/routes";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

/**
 * Regressions found by an adversarial audit of the Phase 0 branch itself.
 * Each test names the defect it exists for.
 */

describe("password verification refuses anything that is not a real hash", () => {
  /**
   * The key length was derived from the stored value, so a truncated or
   * corrupted hash column authenticated any password: "scrypt$abcd$" decodes to
   * zero bytes, scrypt with a length of zero returns zero bytes, and comparing
   * two empty buffers succeeds.
   */
  it.each([
    ["empty digest", "scrypt$abcd$"],
    ["empty salt and digest", "scrypt$$"],
    ["non-hex digest", "scrypt$abcd$zz"],
    ["one-character digest", "scrypt$abcd$g"],
    ["digest truncated to one byte", "scrypt$aabbccddaabbccddaabbccddaabbccdd$ab"],
    ["digest of the wrong length", "scrypt$aabbccddaabbccddaabbccddaabbccdd$" + "ab".repeat(16)],
    ["salt of the wrong length", "scrypt$aa$" + "ab".repeat(64)],
  ])("rejects a stored hash with %s", async (_name, stored) => {
    expect((await verifyPassword("any password at all", stored)).ok).toBe(false);
  });

  it("still accepts a hash it produced itself", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect((await verifyPassword("correct horse battery staple", stored)).ok).toBe(true);
    expect((await verifyPassword("wrong", stored)).ok).toBe(false);
  });
});

describe("a privilege change takes effect on sessions that already exist", () => {
  let app: Express;

  beforeAll(async () => {
    app = await makeApp();
  });

  /**
   * The guards read the role written into the session at login. That snapshot
   * outlived the account for the seven-day life of the cookie: a demoted admin
   * kept admin access and could re-promote themselves and reset the real
   * admin's password.
   */
  it("refuses admin routes to an admin who has since been demoted", async () => {
    const admin = await signIn(app);
    const created = await admin.post("/api/users").send({
      username: `demoted-${Date.now()}`,
      password: "initial-password",
      role: "admin",
      email: null,
    });
    expect(created.status).toBe(201);

    const victim = request.agent(app);
    const signedIn = await victim
      .post("/api/auth/login")
      .send({ username: created.body.username, password: "initial-password" });
    expect(signedIn.status).toBe(200);
    expect((await victim.get("/api/users")).status).toBe(200);

    const demoted = await admin.patch(`/api/users/${created.body.id}`).send({ role: "user" });
    expect(demoted.status).toBe(200);

    // The existing session must lose admin access immediately.
    expect((await victim.get("/api/users")).status).toBe(403);
    const escalation = await victim
      .patch(`/api/users/${created.body.id}`)
      .send({ role: "admin" });
    expect(escalation.status).toBe(403);
  });

  it("refuses every route to a user who has since been deactivated", async () => {
    const admin = await signIn(app);
    const created = await admin.post("/api/users").send({
      username: `deactivated-${Date.now()}`,
      password: "initial-password",
      role: "user",
      email: null,
    });

    const victim = request.agent(app);
    await victim
      .post("/api/auth/login")
      .send({ username: created.body.username, password: "initial-password" });
    expect((await victim.get("/api/clients")).status).toBe(200);

    await admin.patch(`/api/users/${created.body.id}`).send({ isActive: false });

    expect((await victim.get("/api/clients")).status).toBe(401);
    expect(
      (await victim.post("/api/clients").send({ name: "x", company: "y", email: "x@example.com" })).status,
    ).toBe(401);
  });

  it("refuses every route to a user who has since been deleted", async () => {
    const admin = await signIn(app);
    const created = await admin.post("/api/users").send({
      username: `deleted-${Date.now()}`,
      password: "initial-password",
      role: "user",
      email: null,
    });

    const victim = request.agent(app);
    await victim
      .post("/api/auth/login")
      .send({ username: created.body.username, password: "initial-password" });
    expect((await victim.get("/api/clients")).status).toBe(200);

    await admin.delete(`/api/users/${created.body.id}`);

    expect((await victim.get("/api/clients")).status).toBe(401);
  });
});

describe("authorization gaps", () => {
  let app: Express;

  beforeAll(async () => {
    app = await makeApp();
  });

  async function plainUser(): Promise<ReturnType<typeof request.agent>> {
    const admin = await signIn(app);
    const username = `plain-${Math.random().toString(36).slice(2, 10)}`;
    await admin.post("/api/users").send({ username, password: "plain-password", role: "user", email: null });
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ username, password: "plain-password" });
    return agent;
  }

  it("keeps the audit log out of reach of a non-admin", async () => {
    // It carries every user's id, IP address and sign-in times.
    const user = await plainUser();
    expect((await user.get("/api/logs")).status).toBe(403);
  });

  it("will not let one user delete another user's chat message", async () => {
    const owner = await plainUser();
    const other = await plainUser();

    // POST answers { message, reply } now: the assistant's turn is produced
    // server-side, so the caller needs both back.
    const created = await owner.post("/api/chat").send({ message: "mine" });
    expect(created.status).toBe(201);
    const id = created.body.message.id;

    // GET was scoped to the session; DELETE took any id at all.
    expect((await other.delete(`/api/chat/${id}`)).status).toBe(404);
    expect((await owner.get("/api/chat")).body).toHaveLength(1);

    expect((await owner.delete(`/api/chat/${id}`)).status).toBe(200);
  });

  it("attributes a record to the session, not to whoever the client names", async () => {
    const admin = await signIn(app);
    const user = await plainUser();
    const me = (await user.get("/api/auth/check")).body.user;

    const client = await admin
      .post("/api/clients")
      .send({ name: "Attribution", company: "A", email: "attribution@example.com" });
    expect(client.status).toBe(201);
    // Naming somebody else is refused outright. It used to be accepted and
    // stripped, which kept the record honest but answered 201, so the caller
    // had no way to tell a rejected forgery from an accepted one.
    const forged = await user.post("/api/tests").send({
      clientId: client.body.id,
      testType: "scan",
      status: "pending",
      executedBy: "someone-else-entirely",
    });
    expect(forged.status).toBe(400);

    const test = await user.post("/api/tests").send({
      clientId: client.body.id,
      testType: "scan",
      status: "pending",
    });

    expect(test.status).toBe(201);
    expect(test.body.executedBy).toBe(me.id);
  });
});

describe("login throttling", () => {
  let app: Express;

  beforeEach(async () => {
    app = await makeApp();
    resetLoginThrottle();
  });

  it("stops answering after repeated failures, and a correct password still works before that", async () => {
    // There was no limit at all: 200 failures in seven seconds, all answered 401.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await request(app).post("/api/auth/login").send({ username: "admin", password: "wrong" });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app).post("/api/auth/login").send({ username: "admin", password: "wrong" });
    expect(blocked.status).toBe(429);

    // Even the right password is refused while the block stands.
    const correct = await request(app).post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
    expect(correct.status).toBe(429);
  });

  it("clears the count once a sign-in succeeds", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app).post("/api/auth/login").send({ username: "admin", password: "wrong" });
    }
    expect((await request(app).post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD })).status).toBe(200);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await request(app).post("/api/auth/login").send({ username: "admin", password: "wrong" });
      expect(res.status).toBe(401);
    }
  });
});

describe("request handling", () => {
  let app: Express;

  beforeAll(async () => {
    app = await makeApp();
  });

  it.each(["//api/clients", "/api%2fclients"])(
    "answers %s with JSON rather than the single-page app",
    async (path) => {
      // These spellings matched no handler, skipped the guard, and fell through
      // to the SPA catch-all with a 200 and a page of HTML.
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ message: "Not found" });
    },
  );

  it("does not echo the body parser's own message", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send("{oops");
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Malformed JSON body");
  });
});

describe("session secret", () => {
  it("refuses a short SESSION_SECRET instead of accepting any length", async () => {
    const original = process.env.SESSION_SECRET;
    const { resolveSessionSecret } = await import("../server/app");
    process.env.SESSION_SECRET = "x";
    try {
      expect(() => resolveSessionSecret()).toThrow(/at least 32/);
    } finally {
      process.env.SESSION_SECRET = original;
    }
  });
});
