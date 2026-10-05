import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import request from "supertest";

import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";

/**
 * A password others could know leaves nothing behind once it is changed, and
 * every password written meets the same rules (#65 review round 1).
 *
 *   - A forced change (the account was marked) revokes the API keys the
 *     account minted: a key authenticates as its account, so one minted under
 *     the known password was a standing grant of the same takeover.
 *   - A sign-in with a legacy default whose mark cannot be written is refused,
 *     never let in unmarked.
 *   - An admin sets a password only for another account, under the rules, and
 *     that account must set its own at its next sign-in; one's own is changed
 *     with the current one. A new account's password meets the rules too.
 *   - The rules refuse whitespace at either end and too few different
 *     characters, as well as the short, the legacy defaults and the username.
 *   - The first-run password file is ignored by git.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

async function fresh() {
  vi.resetModules();
  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");
  const { resetLoginThrottle } = await import("../server/routes");
  resetLoginThrottle();
  const { storage } = await import("../server/storage-unified");
  const app = createApp();
  await initializeDefaultData();
  return { app, storage };
}

async function signedInAdmin(app: Parameters<typeof request.agent>[0]) {
  const admin = request.agent(app);
  expect((await admin.post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD })).status).toBe(200);
  return admin;
}

const NEXT = "a-new-and-long-admin-password";

describe("a forced password change revokes the account's API keys", () => {
  it("a key minted before the account was marked works no more once the password is changed; another account's key stands", async () => {
    const { app, storage } = await fresh();
    await adminHasSetPassword();
    const admin = await signedInAdmin(app);
    const minted = await admin.post("/api/api-keys").send({ name: "left behind" });
    expect(minted.status).toBe(201);
    const secret = minted.body.secret as string;
    const other = await storage.createUser({ username: "second-admin", password: "second-admin-password", role: "admin", isActive: true }); // pragma: allowlist secret
    const { secret: othersSecret } = await storage.createApiKey({ name: "the other admin's", createdBy: other.id });
    // The account is found on a password others could know (flagLegacyDefaultPasswords, or a sign-in with one).
    const me = (await storage.getUserByUsername("admin"))!;
    await storage.updateUser(me.id, { mustChangePassword: true });
    expect((await request(app).get("/api/clients").set("X-API-Key", secret)).status).toBe(403);

    const changed = await admin.post("/api/auth/change-password").send({ currentPassword: TEST_ADMIN_PASSWORD, newPassword: NEXT });
    expect(changed.status).toBe(200);

    expect((await request(app).get("/api/clients").set("X-API-Key", secret)).status).toBe(401);
    expect((await request(app).get("/api/clients").set("X-API-Key", othersSecret)).status).toBe(200);
    const logged = await storage.getAllActivityLogs();
    const entry = logged.find((one: { action: string }) => one.action === "password_changed") as
      { details: { required: boolean; apiKeysRevoked: string[] } } | undefined;
    expect(entry?.details.required).toBe(true);
    expect(entry?.details.apiKeysRevoked).toEqual([expect.stringContaining("left behind")]);
    expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it("a change the account was not made to make keeps its keys", async () => {
    const { app, storage } = await fresh();
    await adminHasSetPassword();
    const admin = await signedInAdmin(app);
    const secret = (await admin.post("/api/api-keys").send({ name: "kept" })).body.secret as string;

    expect((await admin.post("/api/auth/change-password").send({ currentPassword: TEST_ADMIN_PASSWORD, newPassword: NEXT })).status).toBe(200);

    expect((await request(app).get("/api/clients").set("X-API-Key", secret)).status).toBe(200);
    expect((await storage.getUserByUsername("admin"))!.mustChangePassword).toBe(false);
  });

  it("when a key cannot be revoked, nothing is changed: the password stands, and so does the mark", async () => {
    const { app, storage } = await fresh();
    await adminHasSetPassword();
    const admin = await signedInAdmin(app);
    const secret = (await admin.post("/api/api-keys").send({ name: "stuck" })).body.secret as string;
    const me = (await storage.getUserByUsername("admin"))!;
    await storage.updateUser(me.id, { mustChangePassword: true });
    vi.spyOn(storage, "revokeApiKey").mockRejectedValue(new Error("SQLITE_BUSY: database is locked"));

    const refused = await admin.post("/api/auth/change-password").send({ currentPassword: TEST_ADMIN_PASSWORD, newPassword: NEXT });

    expect(refused.status).toBe(503);
    expect(refused.body.message).toMatch(/not changed.*API keys could not be revoked/);
    expect((await storage.getUserByUsername("admin"))!.mustChangePassword).toBe(true);
    vi.restoreAllMocks();
    expect((await request(app).post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD })).status).toBe(200);
    expect((await request(app).get("/api/clients").set("X-API-Key", secret)).status).toBe(403);
  });
});

describe("a sign-in with a legacy default", () => {
  async function renamedAdminOnALegacyDefault() {
    const { app, storage } = await fresh();
    await adminHasSetPassword();
    // An admin renamed from "admin": the startup check looks only at the legacy usernames.
    await storage.createUser({ username: "root", password: "admin123", role: "admin", isActive: true }); // pragma: allowlist secret
    return { app, storage };
  }

  it("is refused when the account cannot be marked to change it: never let in unmarked", async () => {
    const { app, storage } = await renamedAdminOnALegacyDefault();
    const real = storage.updateUser.bind(storage);
    vi.spyOn(storage, "updateUser").mockImplementation(async (id, patch) => {
      if ((patch as { mustChangePassword?: boolean }).mustChangePassword === true) throw new Error("SQLITE_BUSY: database is locked");
      return real(id, patch);
    });
    const agent = request.agent(app);

    const login = await agent.post("/api/auth/login").send({ username: "root", password: "admin123" }); // pragma: allowlist secret

    expect(login.status).toBe(503);
    expect(login.body.message).toMatch(/could not be marked.*not signed in/);
    expect((await agent.get("/api/users")).status).toBe(401);
  });

  it("is let in marked when the mark is written (the control)", async () => {
    const { app } = await renamedAdminOnALegacyDefault();
    const agent = request.agent(app);

    const login = await agent.post("/api/auth/login").send({ username: "root", password: "admin123" }); // pragma: allowlist secret

    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
    expect((await agent.get("/api/users")).body).toEqual({ error: "password change required" });
  });
});

describe("a password an admin sets", () => {
  it("is never one's own, through PATCH: that is changed with the current password", async () => {
    const { app, storage } = await fresh();
    await adminHasSetPassword();
    const admin = await signedInAdmin(app);
    const me = (await storage.getUserByUsername("admin"))!;

    const refused = await admin.patch(`/api/users/${me.id}`).send({ password: "a-perfectly-good-new-password" }); // pragma: allowlist secret

    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/change-password/);
    expect((await request(app).post("/api/auth/login").send({ username: "admin", password: TEST_ADMIN_PASSWORD })).status).toBe(200);
  });

  it.each([
    ["a legacy default", "admin123"], // pragma: allowlist secret
    ["eight characters", "short-12"],
    ["twelve spaces", " ".repeat(12)],
    ["one character twelve times", "z".repeat(12)],
    ["the account's username", "analyst-of-record"],
  ])("for another account is refused when it is %s", async (_name, password) => {
    const { app, storage } = await fresh();
    await adminHasSetPassword();
    const admin = await signedInAdmin(app);
    const target = await storage.createUser({ username: "analyst-of-record", password: "the-analyst-password", role: "user", isActive: true }); // pragma: allowlist secret

    const refused = await admin.patch(`/api/users/${target.id}`).send({ password });

    expect(refused.status).toBe(400);
    expect((await request(app).post("/api/auth/login").send({ username: "analyst-of-record", password: "the-analyst-password" })).status).toBe(200); // pragma: allowlist secret
  });

  it("for another account is a reset: that account must set its own at its next sign-in", async () => {
    const { app, storage } = await fresh();
    await adminHasSetPassword();
    const admin = await signedInAdmin(app);
    const target = await storage.createUser({ username: "analyst", password: "the-analyst-password", role: "user", isActive: true }); // pragma: allowlist secret

    expect((await admin.patch(`/api/users/${target.id}`).send({ password: "a-reset-by-the-admin" })).status).toBe(200); // pragma: allowlist secret

    const login = await request(app).post("/api/auth/login").send({ username: "analyst", password: "a-reset-by-the-admin" }); // pragma: allowlist secret
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
  });

  it("for a new account meets the rules", async () => {
    const { app } = await fresh();
    await adminHasSetPassword();
    const admin = await signedInAdmin(app);

    for (const weak of ["x".repeat(12), "short-pw-11", " padded-password ", "new-member"]) {
      expect((await admin.post("/api/users").send({ username: "new-member", password: weak, role: "user" })).status).toBe(400);
    }
    const made = await admin.post("/api/users").send({ username: "new-member", password: "a-first-password", role: "user" }); // pragma: allowlist secret
    expect(made.status).toBe(201);
    expect((await request(app).post("/api/auth/login").send({ username: "new-member", password: "a-first-password" })).status).toBe(200); // pragma: allowlist secret
  });
});

describe("the rules every password meets", () => {
  it("refuse whitespace at either end and too few different characters, and take a good one", async () => {
    const { newPasswordRefusal } = await import("../server/password");
    expect(newPasswordRefusal(" ".repeat(12), null, "admin")).toMatch(/whitespace/);
    expect(newPasswordRefusal("a-good-long-password\n", null, "admin")).toMatch(/whitespace/);
    expect(newPasswordRefusal(" a-good-long-password", null, "admin")).toMatch(/whitespace/);
    expect(newPasswordRefusal("aaaaaaaaaaaa", null, "admin")).toMatch(/different characters/);
    expect(newPasswordRefusal("abababababab", null, "admin")).toMatch(/different characters/);
    expect(newPasswordRefusal("a good long pass phrase", null, "admin")).toBeNull();
    expect(newPasswordRefusal("a-good-long-password", "a-good-long-password", "admin")).toMatch(/differ/);
    expect(newPasswordRefusal("a-good-long-password", null, "admin")).toBeNull();
  });
});

describe("the first-run password file", () => {
  it("is ignored by git wherever a dev start writes it", () => {
    const root = path.resolve(import.meta.dirname, "..");
    for (const where of ["initial-admin-password.txt", "data/initial-admin-password.txt"]) {
      // Exits non-zero, and throws, when the path is not ignored.
      execFileSync("git", ["check-ignore", "-q", "--no-index", where], { cwd: root });
    }
  });
});
