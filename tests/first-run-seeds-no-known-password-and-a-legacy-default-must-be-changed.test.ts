import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";
import Database from "better-sqlite3";
import request from "supertest";

import { TEST_ADMIN_PASSWORD } from "./test-admin";
import { makeApp } from "./helpers";
import { LEGACY_DEFAULT_PASSWORDS } from "../server/password";

/**
 * No install is seeded with a password anyone can read.
 *
 * Earlier releases created `admin` and `testadmin` on first run with fixed
 * passwords, written in the code, its log line and the docs of a public
 * repository, and nothing made anyone change them. Now first run creates one
 * admin, with ATHENA_INITIAL_ADMIN_PASSWORD (12 characters or more) or a
 * random password written once to a 0600 file beside the database, whose path
 * -- never the password -- is logged; the admin must change it at first sign-in.
 * An install that kept a legacy default is found after the server is
 * listening, at most two key derivations per account, and made to change it.
 */

let dir: string;
let logs: string[];

function captureLogs(): string[] {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(format(...args)); });
  }
  return lines;
}

/** The modules, fresh: the in-memory backend, with its data directory `dir` (where the database file would be). */
async function fresh() {
  vi.resetModules();
  const init = await import("../server/init-data");
  const { storage } = await import("../server/storage-unified");
  const { verifyPassword } = await import("../server/password");
  return { ...init, storage, verifyPassword };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-first-run-"));
  process.env.ATHENA_STORAGE = "memory";
  process.env.ATHENA_DB_PATH = path.join(dir, "athena.db");
  delete process.env.ATHENA_INITIAL_ADMIN_PASSWORD;
  logs = captureLogs();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.ATHENA_INITIAL_ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
  process.env.ATHENA_STORAGE = "memory";
  delete process.env.ATHENA_DB_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("first run", () => {
  it("creates exactly one admin, flagged to change its password, from a generated password in a 0600 file whose path alone is logged", async () => {
    const { initializeDefaultData, storage, verifyPassword, INITIAL_ADMIN_PASSWORD_FILE } = await fresh();
    await initializeDefaultData();

    const users = await storage.getAllUsers();
    expect(users.map((u) => [u.username, u.role, u.mustChangePassword])).toEqual([["admin", "admin", true]]);
    const [admin] = users;
    for (const legacy of LEGACY_DEFAULT_PASSWORDS) expect((await verifyPassword(legacy, admin.password)).ok).toBe(false);

    const file = path.join(dir, INITIAL_ADMIN_PASSWORD_FILE);
    expect(file).toBe(path.join(dir, "initial-admin-password.txt"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const password = fs.readFileSync(file, "utf8").trim();
    expect(password).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect((await verifyPassword(password, admin.password)).ok).toBe(true);

    expect(logs.some((line) => line.includes(file))).toBe(true);
    expect(logs.filter((line) => line.includes(password))).toEqual([]);
  });

  it("no longer creates testadmin", async () => {
    const { initializeDefaultData, storage } = await fresh();
    await initializeDefaultData();
    expect(await storage.getUserByUsername("testadmin")).toBeUndefined();
    expect((await storage.getAllUsers()).length).toBe(1);
  });

  it("takes ATHENA_INITIAL_ADMIN_PASSWORD of 12 characters or more, writes no file, logs no password, and still flags the admin", async () => {
    const chosen = "an-operator-chosen-password";
    process.env.ATHENA_INITIAL_ADMIN_PASSWORD = chosen;
    const { initializeDefaultData, storage, verifyPassword, INITIAL_ADMIN_PASSWORD_FILE } = await fresh();
    await initializeDefaultData();

    const users = await storage.getAllUsers();
    expect(users.length).toBe(1);
    expect(users[0].mustChangePassword).toBe(true);
    expect((await verifyPassword(chosen, users[0].password)).ok).toBe(true);
    expect(fs.existsSync(path.join(dir, INITIAL_ADMIN_PASSWORD_FILE))).toBe(false);
    expect(logs.filter((line) => line.includes(chosen))).toEqual([]);
    expect(logs.some((line) => line.includes("ATHENA_INITIAL_ADMIN_PASSWORD"))).toBe(true);
  });

  it("falls back to a generated password when ATHENA_INITIAL_ADMIN_PASSWORD is shorter than 12 characters", async () => {
    const short = "eleven-char";
    expect(short.length).toBe(11);
    process.env.ATHENA_INITIAL_ADMIN_PASSWORD = short;
    const { initializeDefaultData, storage, verifyPassword, INITIAL_ADMIN_PASSWORD_FILE } = await fresh();
    await initializeDefaultData();

    const [admin] = await storage.getAllUsers();
    expect(admin.mustChangePassword).toBe(true);
    expect((await verifyPassword(short, admin.password)).ok).toBe(false);
    const file = path.join(dir, INITIAL_ADMIN_PASSWORD_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const generated = fs.readFileSync(file, "utf8").trim();
    expect(generated.length).toBeGreaterThanOrEqual(24);
    expect((await verifyPassword(generated, admin.password)).ok).toBe(true);
    expect(logs.filter((line) => line.includes(short) || line.includes(generated))).toEqual([]);
    expect(logs.some((line) => line.includes(file))).toBe(true);
  });

  it("never throws when the password file cannot be written: no admin is created, the reason is logged, and the next start tries again", async () => {
    const blocker = path.join(dir, "not-a-directory");
    fs.writeFileSync(blocker, "");
    process.env.ATHENA_DB_PATH = path.join(blocker, "athena.db");
    const { initializeDefaultData, storage } = await fresh();
    await expect(initializeDefaultData()).resolves.toBeUndefined();
    expect(await storage.getAllUsers()).toEqual([]);
    expect(logs.some((line) => line.includes("the admin account was not created"))).toBe(true);
  });
});

describe("an install that kept a legacy default", () => {
  /** crypto.scrypt, counted: spied before the password module is loaded, which binds it at load. */
  function countScrypt(): { calls: number } {
    const count = { calls: 0 };
    const real = crypto.scrypt;
    vi.spyOn(crypto, "scrypt").mockImplementation(((...args: unknown[]) => {
      count.calls += 1;
      return (real as (...a: unknown[]) => void)(...args);
    }) as typeof crypto.scrypt);
    return count;
  }

  it("is flagged, at most two key derivations an account, and the warning names the account and never the password", async () => {
    const scrypt = countScrypt();
    const { flagLegacyDefaultPasswords, storage } = await fresh();
    const [first, second] = LEGACY_DEFAULT_PASSWORDS;
    await storage.createUser({ username: "admin", password: first, role: "admin", email: null, isActive: true });
    await storage.createUser({ username: "testadmin", password: second, role: "admin", email: null, isActive: true });

    scrypt.calls = 0;
    expect(await flagLegacyDefaultPasswords()).toEqual(["admin", "testadmin"]);
    expect(scrypt.calls).toBeGreaterThan(0);
    expect(scrypt.calls).toBeLessThanOrEqual(4);
    expect((await storage.getUserByUsername("admin"))?.mustChangePassword).toBe(true);
    expect((await storage.getUserByUsername("testadmin"))?.mustChangePassword).toBe(true);

    const warnings = logs.filter((line) => line.includes("legacy") || line.includes("default password"));
    expect(warnings.some((line) => line.includes('"admin"'))).toBe(true);
    expect(warnings.some((line) => line.includes('"testadmin"'))).toBe(true);
    expect(logs.filter((line) => LEGACY_DEFAULT_PASSWORDS.some((legacy) => line.includes(legacy)))).toEqual([]);

    // Flagged once: a second start spends nothing on it.
    scrypt.calls = 0;
    expect(await flagLegacyDefaultPasswords()).toEqual([]);
    expect(scrypt.calls).toBe(0);
  });

  it("is not flagged when its password was changed: exactly two key derivations, and nothing logged as legacy", async () => {
    const scrypt = countScrypt();
    const { flagLegacyDefaultPasswords, storage } = await fresh();
    await storage.createUser({ username: "admin", password: "a-password-changed-long-ago", role: "admin", email: null, isActive: true });

    scrypt.calls = 0;
    expect(await flagLegacyDefaultPasswords()).toEqual([]);
    expect(scrypt.calls).toBe(2);
    expect((await storage.getUserByUsername("admin"))?.mustChangePassword).toBe(false);
    expect(logs.filter((line) => line.includes("default password"))).toEqual([]);
  });

  it("an existing SQLite database gains users.must_change_password, and its legacy-hashed admin is flagged and stays flagged", async () => {
    const file = path.join(dir, "athena.db");
    const old = new Database(file);
    old.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user', email TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      );
    `);
    // The oldest installs stored an unsalted SHA-256 of the seeded password.
    const sha = crypto.createHash("sha256").update(LEGACY_DEFAULT_PASSWORDS[0]).digest("hex");
    old.prepare("INSERT INTO users (id, username, password, role, created_at) VALUES ('u1', 'admin', ?, 'admin', 1000)").run(sha);
    old.close();

    process.env.ATHENA_STORAGE = "sqlite";
    process.env.ATHENA_DB_PATH = file;
    const { flagLegacyDefaultPasswords, storage } = await fresh();
    expect((await storage.getUserByUsername("admin"))?.mustChangePassword).toBe(false);
    expect(await flagLegacyDefaultPasswords()).toEqual(["admin"]);

    const reopened = new Database(file, { readonly: true });
    try {
      const row = reopened.prepare("SELECT must_change_password AS flag FROM users WHERE username = 'admin'").get() as { flag: number };
      expect(row.flag).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it("a sign-in with a legacy default flags the account at once, whatever its name", async () => {
    delete process.env.ATHENA_DB_PATH;
    process.env.ATHENA_INITIAL_ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
    vi.resetModules();
    const app = await makeApp();
    const { storage } = await import("../server/storage-unified");
    await storage.createUser({ username: "operator", password: LEGACY_DEFAULT_PASSWORDS[1], role: "admin", email: null, isActive: true });

    const agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send({ username: "operator", password: LEGACY_DEFAULT_PASSWORDS[1] });
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
    expect((await agent.get("/api/clients")).body).toEqual({ error: "password change required" });
    expect(logs.filter((line) => LEGACY_DEFAULT_PASSWORDS.some((legacy) => line.includes(legacy)))).toEqual([]);
  });
});
