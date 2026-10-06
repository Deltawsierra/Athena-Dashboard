import { describe, it, expect, beforeAll } from "vitest";
import type { Express } from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";

/**
 * The suite ran almost entirely against the in-memory backend while production
 * runs SQLite, so assertions like "isActive is a boolean" were tautological:
 * no serialization happened. These tests drive the real backend over HTTP, and
 * compare the two backends field by field.
 */

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "athena-parity-")), "athena.db");

async function makeSqliteApp(): Promise<Express> {
  process.env.ATHENA_STORAGE = "sqlite";
  process.env.ATHENA_DB_PATH = dbFile;
  process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-characters";
  process.env.NODE_ENV = "test";

  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");

  const app = createApp();
  await initializeDefaultData();
  await adminHasSetPassword();
  return app;
}

describe("the SQLite backend over HTTP", () => {
  let app: Express;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    app = await makeSqliteApp();
    agent = request.agent(app);
    const res = await agent.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD });
    expect(res.status).toBe(200);
  });

  it("round-trips booleans, dates, JSON and arrays through the real driver", async () => {
    const client = await agent.post("/api/clients").send({
      name: "Parity", company: "Parity Ltd", email: "parity@example.com", phone: "", notes: null,
    });
    expect(client.status).toBe(201);
    expect(client.body.id).toBeTruthy();

    const test = await agent.post("/api/tests").send({
      clientId: client.body.id,
      testType: "penetration-test",
      status: "completed",
      findings: { scanner: "nmap", ports: [80, 443], nested: { ok: false } },
      completedAt: new Date("2024-05-01T00:00:00.000Z").toISOString(),
      vulnerabilitiesFound: 0,
    });
    expect(test.status).toBe(201);

    const readBack = await agent.get(`/api/tests/${test.body.id}`);
    expect(readBack.status).toBe(200);
    // Parsed JSON, not a string, and not double-encoded.
    expect(readBack.body.findings).toEqual({ scanner: "nmap", ports: [80, 443], nested: { ok: false } });
    expect(new Date(readBack.body.completedAt).toISOString()).toBe("2024-05-01T00:00:00.000Z");
    expect(readBack.body.vulnerabilitiesFound).toBe(0);

    // An array column used to gain a stray element on read. Written here
    // rather than read off a seeded row, because the installer no longer
    // writes a health metric -- it used to invent one, including a detection
    // accuracy nobody had measured.
    await agent.post("/api/ai-health").send({
      cpuUsage: 3, memoryUsage: 4,
      modelsLoaded: ["threat-classifier", "cve-classifier"],
    }).expect(201);
    const health = await agent.get("/api/ai-health/latest");
    expect(health.status).toBe(200);
    expect(health.body.modelsLoaded).toEqual(["threat-classifier", "cve-classifier"]);
    // And the figures with no source come back absent, not as zero.
    expect(health.body.detectionAccuracy).toBeNull();
    expect(health.body.falsePositiveRate).toBeNull();
  });

  it("returns a user whose isActive is a real boolean, both ways", async () => {
    const username = `parity-${Date.now()}`;
    const created = await agent.post("/api/users").send({
      username, password: "a-long-enough-password", role: "user", email: null,
    });
    expect(created.status).toBe(201);
    expect(created.body.isActive).toBe(true);
    expect(created.body).not.toHaveProperty("password");

    const off = await agent.patch(`/api/users/${created.body.id}`).send({ isActive: false });
    expect(off.body.isActive).toBe(false);

    const listed = (await agent.get("/api/users")).body.find(
      (u: { id: string }) => u.id === created.body.id,
    );
    expect(listed.isActive).toBe(false);
  });

  it("persists the kill switch as a boolean rather than losing it", async () => {
    const on = await agent.patch("/api/ai-control").send({ killSwitchEnabled: true, systemStatus: "shutdown" });
    expect(on.status).toBe(200);
    expect(on.body.killSwitchEnabled).toBe(true);

    const fresh = await agent.get("/api/ai-control");
    expect(fresh.body.killSwitchEnabled).toBe(true);
    expect(fresh.body.systemStatus).toBe("shutdown");

    const off = await agent.patch("/api/ai-control").send({ killSwitchEnabled: false });
    expect(off.body.killSwitchEnabled).toBe(false);
  });

  it("removes a client's tests, sites and documents with it", async () => {
    const client = await agent.post("/api/clients").send({
      name: "Cascade", company: "Cascade Ltd", email: "cascade@example.com",
    });
    const test = await agent.post("/api/tests").send({
      clientId: client.body.id, testType: "scan", status: "pending",
    });
    const doc = await agent.post("/api/documents").send({
      clientId: client.body.id, title: "Doc", documentType: "Report",
    });

    expect((await agent.delete(`/api/clients/${client.body.id}`)).status).toBe(200);

    // Orphans used to be left behind, pointing at an id that no longer existed.
    expect((await agent.get(`/api/tests/${test.body.id}`)).status).toBe(404);
    const documents = (await agent.get("/api/documents")).body as Array<{ id: string }>;
    expect(documents.some((d) => d.id === doc.body.id)).toBe(false);
  });

  it("refuses a duplicate username with a conflict, not a crash", async () => {
    const username = `dupe-${Date.now()}`;
    const first = await agent.post("/api/users").send({
      username, password: "a-long-enough-password", role: "user", email: null,
    });
    expect(first.status).toBe(201);

    const second = await agent.post("/api/users").send({
      username, password: "a-long-enough-password", role: "user", email: null,
    });
    expect([400, 409]).toContain(second.status);
  });

  it("survives a JSON column that was not written by this schema", async () => {
    // One malformed cell used to make every request touching the table 500,
    // with no way back short of editing the database by hand.
    const { sqlite } = await import("../server/db-sqlite");
    sqlite
      .prepare(
        "INSERT INTO tests (id, client_id, test_type, status, started_at, findings, " +
          "vulnerabilities_found, critical_count, high_count, medium_count, low_count) " +
          "VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0)",
      )
      .run("broken-row", "no-such-client", "scan", "pending", Date.now(), "{scanner,classifier}");

    const listed = await agent.get("/api/tests");
    expect(listed.status).toBe(200);
    const broken = (listed.body as Array<{ id: string; findings: unknown }>).find(
      (t) => t.id === "broken-row",
    );
    expect(broken).toBeTruthy();
    expect(broken!.findings).toBeNull();
  });
});
