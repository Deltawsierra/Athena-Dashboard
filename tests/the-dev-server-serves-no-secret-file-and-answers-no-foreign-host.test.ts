import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";

/**
 * The dev server (`npm run dev`: server/vite.ts setupVite) serves no file a
 * dev start keeps beside the database, and answers no Host it does not know
 * (#65 review round 1, F5).
 *
 * A dev start writes the database and, on first run, the admin's generated
 * password into the working directory -- the repository. Vite serves any file
 * under it at /@fs/<its absolute path>, and setupVite replaced the config's
 * `server` block, file rules and all, and answered every Host: so the password
 * file was one unauthenticated GET away, from any page, through DNS rebinding.
 *
 * And a refused request is logged, never the end of the process: setupVite's
 * logger exited on every error, and Vite logs a file it refuses to serve as
 * one -- so one request for `.env` took the dev server, and the kill switch
 * and every Stop it serves, down.
 *
 * The files here are stand-ins, holding random bytes, in a directory this test
 * makes and removes: a harmless file beside them is served, so a refusal is the
 * rule's, not the path's.
 */

const root = path.resolve(import.meta.dirname, "..");
let dir: string;
let server: http.Server;
let base: string;
let exits: ReturnType<typeof vi.spyOn>;

function get(url: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${url}`, { headers: host ? { Host: host } : {} }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
  });
}

const SECRET_FILES = [
  "initial-admin-password.txt",
  "athena.db",
  "athena.db-wal",
  "session-secret",
  ".env",
];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(root, "tests", "dev-server-fixture-"));
  for (const name of [...SECRET_FILES, "harmless.txt"]) {
    fs.writeFileSync(path.join(dir, name), crypto.randomBytes(16).toString("hex"));
  }
  delete process.env.ATHENA_DEV_ALLOWED_HOSTS;
  const { setupVite } = await import("../server/vite");
  const app = express();
  server = http.createServer(app);
  await setupVite(app, server);
  exits = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  exits?.mockRestore();
  server?.closeAllConnections?.();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the dev server", () => {
  it("serves an ordinary file under the repository (the control)", async () => {
    const harmless = fs.readFileSync(path.join(dir, "harmless.txt"), "utf8");
    const res = await get(`/@fs${path.join(dir, "harmless.txt")}?raw`);
    expect(res.status).toBe(200);
    expect(res.body).toContain(harmless);
  });

  it.each(SECRET_FILES)("never serves %s, in any of the forms Vite takes", async (name) => {
    const content = fs.readFileSync(path.join(dir, name), "utf8");
    for (const suffix of ["", "?raw", "?import&raw", "?url"]) {
      const res = await get(`/@fs${path.join(dir, name)}${suffix}`);
      expect(res.body, `${name}${suffix}`).not.toContain(content);
      expect(res.status, `${name}${suffix}`).toBe(403);
    }
  });

  it("is still up after every refusal: a refused request never ends the process", async () => {
    expect(exits).not.toHaveBeenCalled();
    expect((await get(`/@fs${path.join(dir, "harmless.txt")}?raw`)).status).toBe(200);
  });

  it("answers no Host it does not know: a page on another site cannot reach it by rebinding a name", async () => {
    expect((await get("/", "attacker.example")).status).toBe(403);
    expect((await get(`/@fs${path.join(dir, "harmless.txt")}?raw`, "attacker.example")).status).toBe(403);
    expect((await get("/", `localhost:${new URL(base).port}`)).status).toBe(200);
  });
});
