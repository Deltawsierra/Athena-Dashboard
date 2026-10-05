import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import request from "supertest";
import { makeApp } from "./helpers";
import { resetLoginThrottle } from "../server/routes";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

/**
 * A real listening socket, not supertest's per-request ephemeral one.
 *
 * supertest starts and stops a server for each request, which is fine one at
 * a time and resets the connection under fifty at once. The point of this
 * file is what happens under fifty at once.
 */
async function listen(): Promise<Server> {
  const app = await makeApp();
  return await new Promise<Server>((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function signInTo(server: Server) {
  const agent = request.agent(server);
  const res = await agent.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
  if (res.status !== 200) {
    throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return agent;
}

/**
 * Failures under load, and then several at once.
 *
 * Each guard in this server was tested on its own. This file asks the
 * different question: whether they interfere. A guard that is correct alone
 * and wrong in company is the failure mode that shipped the kill switch
 * exemption bug, where a path comparison that worked in isolation matched
 * nothing once the routes were mounted under a prefix.
 */

beforeEach(() => {
  resetLoginThrottle();
});

describe("many at once", () => {
  let app: Server;

  beforeAll(async () => {
    resetLoginThrottle();
    app = await listen();
  });

  afterAll(() => {
    app.close();
  });

  it("serves fifty concurrent writes without losing or duplicating one", async () => {
    const admin = await signInTo(app);
    // Counted by a marker rather than by the total, so the seeded demo rows
    // and anything else in the process cannot make this test lie either way.
    const marker = `Concurrent-${Math.random().toString(36).slice(2, 8)}`;

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        admin.post("/api/clients").send({
          name: `${marker} ${index}`,
          company: "C",
          email: `${marker.toLowerCase()}-${index}@example.com`,
        }),
      ),
    );

    expect(responses.every((res) => res.status === 201)).toBe(true);
    const ids = new Set(responses.map((res) => res.body.id));
    expect(ids.size).toBe(50);

    const clients = (await admin.get("/api/clients")).body as Array<{ name: string }>;
    expect(clients.filter((c) => c.name.startsWith(marker))).toHaveLength(50);
  });

  it("keeps a cascade delete consistent while writes race it", async () => {
    const admin = await signInTo(app);
    const client = await admin
      .post("/api/clients")
      .send({ name: "Racing", company: "R", email: "racing@example.com" });

    await Promise.all(
      Array.from({ length: 10 }, () =>
        admin
          .post("/api/tests")
          .send({ clientId: client.body.id, testType: "scan", status: "pending" }),
      ),
    );

    const [deletion, ...creates] = await Promise.all([
      admin.delete(`/api/clients/${client.body.id}`),
      ...Array.from({ length: 10 }, () =>
        admin
          .post("/api/tests")
          .send({ clientId: client.body.id, testType: "scan", status: "pending" }),
      ),
    ]);

    expect(deletion.status).toBe(200);
    // A create either lands before the delete and is cascaded away, or lands
    // after and is refused for a parent that no longer exists. What must not
    // happen is a 500, or a surviving orphan.
    expect(creates.every((res) => res.status === 201 || res.status === 400)).toBe(true);

    const tests = (await admin.get("/api/tests")).body as Array<{ clientId: string }>;
    expect(tests.filter((t) => t.clientId === client.body.id)).toEqual([]);
  });
});

describe("all at once", () => {
  let app: Server;

  beforeAll(async () => {
    resetLoginThrottle();
    app = await listen();
  });

  afterAll(() => {
    app.close();
  });

  it("answers every arm of a mixed hostile burst the way it would alone", async () => {
    const admin = await signInTo(app);
    const client = await admin
      .post("/api/clients")
      .send({ name: "Burst", company: "B", email: "burst@example.com" });

    const anonymous = request(app);

    const arms: Array<[string, Promise<request.Response>, number[]]> = [];

    // Sign-in failures, enough to trip the per-address throttle.
    for (let i = 0; i < 12; i += 1) {
      arms.push([
        "bad sign-in",
        anonymous.post("/api/auth/login").send({ username: `ghost-${i}`, password: "wrong" }),
        [401, 429],
      ]);
    }

    // Unauthenticated reads.
    for (let i = 0; i < 6; i += 1) {
      arms.push(["unauthenticated", anonymous.get("/api/clients"), [401]]);
    }

    // Bodies of the wrong shape. Sent as raw JSON text, because the client
    // library refuses to serialise a bare number for us.
    for (const body of ["[]", '"hello"', "42", "true", '{"name": 5}']) {
      arms.push([
        "malformed body",
        admin.post("/api/clients").type("application/json").send(body),
        [400],
      ]);
    }

    // Forged attribution.
    for (let i = 0; i < 4; i += 1) {
      arms.push([
        "forged attribution",
        admin
          .post("/api/tests")
          .send({
            clientId: client.body.id,
            testType: "scan",
            status: "pending",
            executedBy: "someone-else",
          }),
        [400],
      ]);
    }

    // A parent that does not exist.
    for (let i = 0; i < 4; i += 1) {
      arms.push([
        "missing parent",
        admin
          .post("/api/tests")
          .send({ clientId: "no-such-client", testType: "scan", status: "pending" }),
        [400],
      ]);
    }

    // A duplicated query parameter.
    for (let i = 0; i < 4; i += 1) {
      arms.push([
        "duplicated parameter",
        admin.get("/api/logs?entityType[]=x&entityId=y"),
        [400],
      ]);
    }

    // Paths that must never be answered with the single-page app.
    for (const path of ["/%61pi/clients", "/api%2fclients", "/x/../api/clients"]) {
      arms.push(["odd path", anonymous.get(path), [401, 404]]);
    }

    // And the happy path, mixed in with all of it.
    const happy: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      arms.push([
        "happy path",
        admin
          .post("/api/tests")
          .send({ clientId: client.body.id, testType: "scan", status: "pending" })
          .then((res) => {
            happy.push(res.status);
            return res;
          }) as never,
        [201],
      ]);
    }

    const settled = await Promise.all(arms.map(([, promise]) => promise));

    const unexpected = settled
      .map((res, index) => ({ arm: arms[index][0], status: res.status, allowed: arms[index][2] }))
      .filter((row) => !row.allowed.includes(row.status));

    expect(unexpected).toEqual([]);
    expect(settled.some((res) => res.status >= 500)).toBe(false);

    // The successful writes are all there, and nothing else is.
    const tests = (await admin.get("/api/tests")).body as Array<{ clientId: string }>;
    expect(tests.filter((t) => t.clientId === client.body.id)).toHaveLength(
      happy.filter((status) => status === 201).length,
    );
  });

  it("still refuses writes when the kill switch is thrown mid-burst", async () => {
    const admin = await signInTo(app);
    const client = await admin
      .post("/api/clients")
      .send({ name: "Switch", company: "S", email: "switch@example.com" });

    await admin.patch("/api/ai-control").send({ killSwitchEnabled: true });

    const during = await Promise.all(
      Array.from({ length: 20 }, () =>
        admin
          .post("/api/tests")
          .send({ clientId: client.body.id, testType: "scan", status: "pending" }),
      ),
    );

    expect(during.every((res) => res.status === 503)).toBe(true);

    // Reads still work, and the switch can be turned off again.
    expect((await admin.get("/api/clients")).status).toBe(200);
    const released = await admin.patch("/api/ai-control").send({ killSwitchEnabled: false });
    expect(released.status).toBe(200);

    const after = await admin
      .post("/api/tests")
      .send({ clientId: client.body.id, testType: "scan", status: "pending" });
    expect(after.status).toBe(201);
  });
});
