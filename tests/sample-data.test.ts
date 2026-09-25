import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Express } from "express";
import request from "supertest";

import { makeApp, signIn } from "./helpers";

/**
 * An app with its own storage.
 *
 * makeApp() alone does not give one: the in-memory backend is a module-level
 * singleton, so a second app shares the first one's rows and seeds nothing
 * (initializeDefaultData returns early once a user exists). Half these tests
 * empty the seed, and without this they would pass or fail on their order.
 */
async function freshApp(): Promise<Express> {
  vi.resetModules();
  // The seed is opt-in (a default install writes none of it; see
  // seeded-sample-rows-are-opt-in.test.ts), and these tests are about the
  // seeded rows, so they ask for them the way a demo install does.
  process.env.ATHENA_SEED_SAMPLE_DATA = "1";
  try {
    return await makeApp();
  } finally {
    delete process.env.ATHENA_SEED_SAMPLE_DATA;
  }
}

/**
 * The installer's rows, and the fact that they say so.
 *
 * A demo install (ATHENA_SEED_SAMPLE_DATA=1) seeds three clients, four sites,
 * three tests and three documents. Two of those tests carry severity counts adding to twenty-three,
 * and the dashboard sums exactly those columns -- so out of the box the app
 * reported twenty-three findings and three criticals against an estate nobody
 * had scanned. Every figure came from a real database row, which is what made
 * it convincing.
 *
 * These assert the three things that make that safe: the rows are marked, no
 * caller can move the mark, and one request removes them.
 */
describe("sample data", () => {
  let app: Express;

  beforeAll(async () => {
    app = await freshApp();
  });

  it("counts what the installer wrote, and the findings the dashboard adds up", async () => {
    const agent = await signIn(app);
    const res = await agent.get("/api/sample-data");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      clients: 3,
      sites: 4,
      tests: 3,
      documents: 3,
      // 3+5+4+3 on the first seeded test and 0+2+4+2 on the second. The number
      // the dashboard's "Findings" figure showed on a fresh install.
      findings: 23,
    });
  });

  it("marks every seeded row and no other", async () => {
    const agent = await signIn(app);

    for (const path of ["/api/clients", "/api/sites", "/api/tests", "/api/documents"]) {
      const res = await agent.get(path);
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      for (const row of res.body) expect(row.isSample).toBe(true);
    }

    const created = await agent.post("/api/clients").send({
      name: "Real Client", company: "Real", email: "real@example.test",
    });
    expect(created.status).toBe(201);
    expect(created.body.isSample).toBe(false);
  });

  it("refuses to let a caller claim a row is sample data", async () => {
    const agent = await signIn(app);

    // Both directions matter. Marking a real record as sample hides it behind
    // a label that says "not real" and puts it one click from deletion; the
    // reverse dresses an invented finding up as a measured one.
    const client = await agent.post("/api/clients").send({
      name: "Not A Sample", company: "Real", email: "notsample@example.test",
      isSample: true,
    });
    expect(client.status).toBe(201);
    expect(client.body.isSample).toBe(false);

    const test = await agent.post("/api/tests").send({
      clientId: client.body.id, testType: "penetration-test",
      criticalCount: 9, isSample: true,
    });
    expect(test.status).toBe(201);
    expect(test.body.isSample).toBe(false);

    const patched = await agent.patch(`/api/clients/${client.body.id}`).send({ isSample: true });
    expect(patched.status).toBe(200);
    expect(patched.body.isSample).toBe(false);
  });

  it("removes the seeded rows and leaves real ones alone", async () => {
    // Its own app, because this one empties the seed.
    const own = await freshApp();
    const agent = await signIn(own);

    const keep = await agent.post("/api/clients").send({
      name: "Survivor", company: "Survivor Ltd", email: "survivor@example.test",
    });
    const keptTest = await agent.post("/api/tests").send({
      clientId: keep.body.id, testType: "vulnerability-scan", criticalCount: 1,
    });

    const removed = await agent.delete("/api/sample-data");
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toEqual({
      clients: 3, sites: 4, tests: 3, documents: 3, findings: 23,
    });

    const after = await agent.get("/api/sample-data");
    expect(after.body).toEqual({
      clients: 0, sites: 0, tests: 0, documents: 0, findings: 0,
    });

    const clients = await agent.get("/api/clients");
    expect(clients.body.map((one: { id: string }) => one.id)).toEqual([keep.body.id]);

    const tests = await agent.get("/api/tests");
    expect(tests.body.map((one: { id: string }) => one.id)).toEqual([keptTest.body.id]);
  });

  it("records the removal in the audit log", async () => {
    const own = await freshApp();
    const agent = await signIn(own);
    await agent.delete("/api/sample-data");

    const logs = await agent.get("/api/logs");
    const entry = logs.body.find(
      (one: { entityType: string }) => one.entityType === "sample_data",
    );
    expect(entry).toBeDefined();
    expect(entry.action).toBe("deleted");
    expect(entry.details).toMatchObject({ clients: 3, tests: 3, findings: 23 });
  });

  it("lets anyone signed in read the counts but only an admin remove them", async () => {
    const own = await freshApp();
    const admin = await signIn(own);

    await admin.post("/api/users").send({
      username: "plain", password: "a-password-long-enough", role: "user", isActive: true,
    });
    const user = await signIn(own, "plain", "a-password-long-enough");

    // Reading has to be open: every screen that counts these rows says so, and
    // a notice that only admins can see is a notice most people never get.
    expect((await user.get("/api/sample-data")).status).toBe(200);
    expect((await user.delete("/api/sample-data")).status).toBe(403);

    // And nothing was removed by the attempt.
    expect((await admin.get("/api/sample-data")).body.tests).toBe(3);
  });

  it("says nothing at all once there is nothing seeded", async () => {
    const own = await freshApp();
    const agent = await signIn(own);
    await agent.delete("/api/sample-data");

    // The notice renders from these counts, so all-zero is what makes it
    // disappear rather than sitting there claiming zero sample rows.
    const res = await agent.get("/api/sample-data");
    expect(Object.values(res.body).every((count) => count === 0)).toBe(true);
  });
});
