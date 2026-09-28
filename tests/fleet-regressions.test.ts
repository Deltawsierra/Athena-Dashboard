import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { makeApp, signIn } from "./helpers";
import { verifyPassword } from "../server/password";
import { resetLoginThrottle } from "../server/routes";

// The throttle counts per address, and supertest presents one address for the
// whole file, so a test that deliberately trips it would block the sign-ins of
// every test after it.
beforeEach(() => {
  resetLoginThrottle();
});

/**
 * Defects found by an adversarial fleet run against the Phase 0 branch. The
 * suite was green while every one of these was live, which is why each has a
 * test naming it.
 */

describe("attribution cannot be forged", () => {
  let app: Express;

  beforeAll(async () => {
    resetLoginThrottle();
    app = await makeApp();
  });

  async function plainUser() {
    const admin = await signIn(app);
    const username = `plain-${Math.random().toString(36).slice(2, 10)}`;
    await admin.post("/api/users").send({ username, password: "plain-password", role: "user", email: null });
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ username, password: "plain-password" });
    return agent;
  }

  it("refuses executedBy on update, not only on create", async () => {
    // Create stripped it and update did not, so any authenticated user could
    // rewrite "who ran this test" to anyone at all.
    const admin = await signIn(app);
    const user = await plainUser();
    const me = (await user.get("/api/auth/check")).body.user;

    const client = await admin
      .post("/api/clients")
      .send({ name: "Attribution", company: "A", email: "a@example.com" });
    const test = await user
      .post("/api/tests")
      .send({ clientId: client.body.id, testType: "scan", status: "pending" });
    expect(test.body.executedBy).toBe(me.id);

    const forged = await user
      .patch(`/api/tests/${test.body.id}`)
      .send({ executedBy: "someone-else-entirely" });

    expect(forged.status).toBe(400);
    const after = await user.get(`/api/tests/${test.body.id}`);
    expect(after.body.executedBy).toBe(me.id);
  });

  it("refuses createdBy on a document update", async () => {
    const admin = await signIn(app);
    const client = await admin
      .post("/api/clients")
      .send({ name: "Doc", company: "D", email: "d@example.com" });
    const doc = await admin
      .post("/api/documents")
      .send({ clientId: client.body.id, title: "T", documentType: "Report" });

    const forged = await admin
      .patch(`/api/documents/${doc.body.id}`)
      .send({ createdBy: "someone-else" });

    expect(forged.status).toBe(400);
  });
});

describe("the kill switch stops writes", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;

  beforeEach(async () => {
    app = await makeApp();
    agent = await signIn(app);
    await agent.patch("/api/ai-control").send({ killSwitchEnabled: false });
  });

  it("refuses a write while engaged, and allows it again afterwards", async () => {
    // It was persisted, shown in the UI, and enforced nowhere: every write
    // still succeeded with the switch on and the status set to shutdown.
    const body = { name: "During", company: "C", email: "c@example.com" };
    expect((await agent.post("/api/clients").send(body)).status).toBe(201);

    await agent.patch("/api/ai-control").send({ killSwitchEnabled: true, systemStatus: "shutdown" });

    const blocked = await agent.post("/api/clients").send(body);
    expect(blocked.status).toBe(503);
    expect(blocked.body.message).toMatch(/kill switch/i);

    // Reads still work: this is a stop on changes, not an outage.
    expect((await agent.get("/api/clients")).status).toBe(200);

    // And the switch can be turned back off, or it would be a one-way door.
    expect((await agent.patch("/api/ai-control").send({ killSwitchEnabled: false })).status).toBe(200);
    expect((await agent.post("/api/clients").send(body)).status).toBe(201);
  });
});

describe("login throttling", () => {
  let app: Express;

  beforeEach(async () => {
    app = await makeApp();
    resetLoginThrottle();
  });

  it("does not let a different casing lock out the real account", async () => {
    // The throttle key was lowercased while the account lookup was not, so ten
    // failures against a casing that does not exist locked the real account.
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await request(app).post("/api/auth/login").send({ username: "ADMIN", password: "wrong" });
    }

    const real = await request(app)
      .post("/api/auth/login")
      .send({ username: "admin", password: "admin123" });
    expect(real.status).toBe(200);
  });

  it("counts failures per address as well, so a spray across usernames is bounded", async () => {
    for (let attempt = 0; attempt < 51; attempt += 1) {
      await request(app)
        .post("/api/auth/login")
        .send({ username: `sprayed-${attempt}`, password: "wrong" });
    }

    const next = await request(app)
      .post("/api/auth/login")
      .send({ username: "sprayed-fresh", password: "wrong" });
    expect(next.status).toBe(429);
  });
});

describe("robustness", () => {
  let app: Express;

  beforeAll(async () => {
    resetLoginThrottle();
    app = await makeApp();
  });

  it("treats a stored password that is not a string as a failed check", async () => {
    // A BLOB in that column came back as a Buffer, and calling startsWith on
    // it threw, so every sign-in for that account answered 500 for good.
    for (const stored of [Buffer.from("x"), 42, true, {}, [], null, undefined]) {
      // A rejection here would fail this await, same as a thrown error would
      // have against the old, synchronous verifyPassword.
      const result = await verifyPassword("anything", stored as unknown);
      expect(result.ok).toBe(false);
    }
  });

  it.each([
    "/./api/clients",
    "/x/../api/clients",
    "/%61pi/clients",
    "/%41PI/clients",
    "//api/clients",
    "/api%2fclients",
  ])("answers %s with JSON rather than the single-page app", async (path) => {
    // The defect was the catch-all serving index.html for anything that missed
    // a route, so a mis-spelled API path answered 200 with HTML and the client
    // parsed the app shell as data. Express normalises some of these spellings
    // back to /api/clients before routing, which reaches the auth guard and is
    // answered 401; the rest miss every route and fall through to the JSON 404.
    // Either is correct. HTML, or a 200, is not.
    const res = await request(app).get(path);
    expect([401, 404]).toContain(res.status);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("refuses a query parameter supplied more than once", async () => {
    // An array-valued parameter failed the string test and was dropped, so the
    // filter silently disappeared and the endpoint returned everything.
    const admin = await signIn(app);
    const res = await admin.get("/api/logs?entityType[]=x&entityId=y");
    expect(res.status).toBe(400);
  });

  it("refuses a child record whose parent does not exist", async () => {
    const admin = await signIn(app);
    const res = await admin
      .post("/api/tests")
      .send({ clientId: "no-such-client", testType: "scan", status: "pending" });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("No such client");
  });
});

describe("the audit log records what happened, and only that", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;

  beforeEach(async () => {
    app = await makeApp();
    agent = await signIn(app);
  });

  it("does not record an update that changed nothing", async () => {
    const client = await agent
      .post("/api/clients")
      .send({ name: "NoOp", company: "N", email: "n@example.com" });

    const before = (await agent.get(`/api/logs?entityType=client&entityId=${client.body.id}`)).body.length;
    expect((await agent.patch(`/api/clients/${client.body.id}`).send({})).status).toBe(200);
    const after = (await agent.get(`/api/logs?entityType=client&entityId=${client.body.id}`)).body.length;

    expect(after).toBe(before);
  });

  it("records the children a client deletion took with it", async () => {
    // Ten child rows could vanish with the client and leave no trace at all.
    const client = await agent
      .post("/api/clients")
      .send({ name: "Cascade", company: "C", email: "cascade@example.com" });
    await agent.post("/api/tests").send({ clientId: client.body.id, testType: "scan", status: "pending" });
    await agent.post("/api/documents").send({ clientId: client.body.id, title: "D", documentType: "Report" });

    expect((await agent.delete(`/api/clients/${client.body.id}`)).status).toBe(200);

    const entry = (await agent.get(`/api/logs?entityType=client&entityId=${client.body.id}`)).body
      .find((row: { action: string }) => row.action === "deleted");
    expect(entry.details.cascaded.tests).toHaveLength(1);
    expect(entry.details.cascaded.documents).toHaveLength(1);
  });
});
