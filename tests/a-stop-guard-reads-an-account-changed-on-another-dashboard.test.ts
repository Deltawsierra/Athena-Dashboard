import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { controlPlaneStandIn, type ControlPlaneStandIn } from "./helpers/control-plane-stand-in";
import { adminHasSetPassword } from "./test-admin";

let plane: ControlPlaneStandIn | null = null;
afterEach(async () => { await plane?.close(); plane = null; });

/**
 * This process learns of a change to an account made on another dashboard on
 * the same database only by reading it. Two stop guards decided on what memory
 * last knew (#65 review round 4):
 *
 *   - F1: an account promoted to admin elsewhere was refused a deployment's
 *     pause, a claim's take-down and the failsafe state its stops read, while
 *     a request that is not a stop read the account and was served;
 *   - F2: an account deleted elsewhere read every failsafe command, again and
 *     again, for as long as it sent only those reads.
 *
 * A guard about to refuse a stop from memory, or to serve a failsafe read,
 * reads the account first, for a bounded time; a stop memory authorises waits
 * on nothing, and starts the read for the next request.
 */
async function boot() {
  plane = await controlPlaneStandIn();
  process.env.ATHENA_FAILSAFE_URL = plane.url;
  process.env.ATHENA_FAILSAFE_USER = "svc-failsafe";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc-password"; // pragma: allowlist secret
  vi.resetModules();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  const { storage } = await import("../server/storage-unified");
  const app = createApp();
  await initializeDefaultData();
  await adminHasSetPassword();
  return { app, storage };
}

it("an account promoted to admin on another dashboard pauses a deployment, takes a claim down and reads the failsafe state", async () => {
  const { app, storage } = await boot();
  const pw = "a-long-viewer-password-1"; // pragma: allowlist secret
  const u = await storage.createUser({ username: "op2", password: pw, role: "viewer", isActive: true });
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ username: "op2", password: pw })).status).toBe(200);
  // Another dashboard on the same database promotes it (this process is not told).
  await storage.updateUser(u.id, { role: "admin" });
  const r1 = await agent.post(`/api/assurance/deployments/${randomUUID()}/recompute`).send({ paused: true });
  const r2 = await agent.post(`/api/assurance/claims/${randomUUID()}/transition`).send({ toStatus: "revoked" });
  const r3 = await agent.get(`/api/failsafe/state`);
  const r4 = await agent.get(`/api/failsafe/audit`); // control: not a stop, reads the account
  expect(r4.status).toBe(200);
  expect([r1.status, r2.status, r3.status]).toEqual([200, 200, 200]);
}, 60000);

it("an account deleted on another dashboard reads no failsafe command, list or state", async () => {
  const { app, storage } = await boot();
  const pw = "a-long-admin-password-22"; // pragma: allowlist secret
  const u = await storage.createUser({ username: "op3", password: pw, role: "admin", isActive: true });
  const cmd = plane!.command("resume");
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ username: "op3", password: pw })).status).toBe(200);
  await storage.deleteUser(u.id); // another dashboard, same database
  const list = await agent.get("/api/failsafe/commands");
  const one = await agent.get(`/api/failsafe/commands/${cmd}`);
  const state = await agent.get(`/api/failsafe/state`);
  expect([list.status, one.status, state.status]).toEqual([401, 401, 401]);
  expect(JSON.stringify(list.body)).not.toContain(cmd);
}, 60000);
