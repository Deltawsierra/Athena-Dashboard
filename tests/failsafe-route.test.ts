import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";

import { makeApp, signIn } from "./helpers";

/**
 * The failsafe console's BFF, against a stubbed control plane.
 *
 * What matters here is the trust boundary and the contract, not cryptography
 * (the engine and mythos-core own the ed25519 verification and its tests). So
 * this proves: the console is admin-only; the server obtains a service token
 * and forwards it as a Bearer; it maps the browser's camelCase to the
 * backend's snake_case and back; the two-person rule's signature collection is
 * relayed faithfully; and a backend refusal reaches the operator with its
 * reason instead of a generic error.
 */

interface FakeCommand {
  uuid: string;
  engine_id: string;
  action: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
  reason: string;
  signers: string[];
  required_signatures: number;
  status: string;
  created_at: string;
  updated_at: string;
}

const THRESHOLD: Record<string, number> = { pause: 1, resume: 1, stand_down: 2, release: 2, terminate: 2 };

describe("failsafe console BFF", () => {
  let app: Express;
  let admin: Awaited<ReturnType<typeof signIn>>;
  let server: Server;

  const commands = new Map<string, FakeCommand>();
  // Set true to make the stub refuse to initiate terminate, as a non-admin
  // service account would -- to prove the refusal is passed through.
  let refuseTerminate = false;
  let sawBearer = false;

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const method = req.method ?? "GET";
        const path = (req.url ?? "").split("?")[0];
        const json = (code: number, payload: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const bodyObj = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

        // SimpleJWT token exchange.
        if (path === "/api/token/" && method === "POST") {
          if (!bodyObj.username || !bodyObj.password) return json(400, { detail: "no credential" });
          return json(200, { access: "test-access-token", refresh: "test-refresh" });
        }

        // Every operator route must carry the Bearer we just issued.
        if ((req.headers["authorization"] ?? "") !== "Bearer test-access-token") {
          return json(401, { detail: "auth required" });
        }
        sawBearer = true;

        if (path === "/api/failsafe/state/" && method === "GET") {
          const all = [...commands.values()];
          return json(200, {
            engine_id: "athena-1",
            engine_state: null,
            engine_state_available: false,
            awaiting_signatures: all.filter((c) => c.status === "awaiting_signatures"),
            ready: all.filter((c) => c.status === "ready"),
            recent: all,
          });
        }

        if (path === "/api/failsafe/commands/" && method === "GET") {
          return json(200, [...commands.values()]);
        }

        if (path === "/api/failsafe/commands/" && method === "POST") {
          const action = String(bodyObj.action);
          if (action === "terminate" && refuseTerminate) {
            return json(403, { detail: "terminate may only be initiated by an admin" });
          }
          const uuid = `cmd-${commands.size + 1}`;
          const now = new Date();
          const cmd: FakeCommand = {
            uuid,
            engine_id: String(bodyObj.engine_id ?? ""),
            action,
            nonce: `nonce-${uuid}`,
            issued_at: now.toISOString(),
            expires_at: new Date(now.getTime() + 600_000).toISOString(),
            reason: String(bodyObj.reason ?? ""),
            signers: [],
            required_signatures: THRESHOLD[action] ?? 1,
            status: "awaiting_signatures",
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
          };
          commands.set(uuid, cmd);
          return json(201, { ...cmd, signing_bytes: "deadbeef" });
        }

        const detail = path.match(/^\/api\/failsafe\/commands\/([^/]+)\/$/);
        if (detail && method === "GET") {
          const cmd = commands.get(detail[1]);
          if (!cmd) return json(404, { detail: "not found" });
          return json(200, { ...cmd, signing_bytes: "deadbeef" });
        }

        const sig = path.match(/^\/api\/failsafe\/commands\/([^/]+)\/signatures\/$/);
        if (sig && method === "POST") {
          const cmd = commands.get(sig[1]);
          if (!cmd) return json(404, { detail: "not found" });
          const keyId = String(bodyObj.key_id ?? "");
          if (!keyId || !bodyObj.sig) return json(400, { detail: "no signature" });
          if (cmd.signers.includes(keyId)) return json(409, { detail: `${keyId} already signed` });
          cmd.signers.push(keyId);
          if (cmd.signers.length >= cmd.required_signatures) cmd.status = "ready";
          return json(200, cmd);
        }

        const cancel = path.match(/^\/api\/failsafe\/commands\/([^/]+)\/cancel\/$/);
        if (cancel && method === "POST") {
          const cmd = commands.get(cancel[1]);
          if (!cmd) return json(404, { detail: "not found" });
          cmd.status = "canceled";
          return json(200, cmd);
        }

        if (path === "/api/failsafe/audit/" && method === "GET") {
          return json(200, []);
        }

        return json(404, { detail: `no route ${method} ${path}` });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_FAILSAFE_USER = "svc-operator";
    process.env.ATHENA_FAILSAFE_PASSWORD = "svc-secret";
    process.env.ATHENA_FAILSAFE_ENGINE_ID = "athena-1";
    vi.resetModules();
    app = await makeApp();
    admin = await signIn(app);
  });

  afterAll(async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    delete process.env.ATHENA_FAILSAFE_USER;
    delete process.env.ATHENA_FAILSAFE_PASSWORD;
    delete process.env.ATHENA_FAILSAFE_ENGINE_ID;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("refuses the console to anyone not signed in", async () => {
    const anon = await request(app).get("/api/failsafe/status");
    expect(anon.status).toBe(401);
  });

  it("refuses the console to a non-admin operator", async () => {
    await admin.post("/api/users").send({
      username: "analyst", password: "analyst-pass", role: "user", isActive: true,
    });
    const analyst = await signIn(app, "analyst", "analyst-pass");
    const denied = await analyst.get("/api/failsafe/status");
    expect(denied.status).toBe(403);
  });

  it("reports the control plane reachable and the service credential accepted", async () => {
    const status = await admin.get("/api/failsafe/status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ configured: true, reachable: true, authorized: true });
    expect(status.body.defaultEngineId).toBe("athena-1");
    expect(sawBearer).toBe(true); // the service token was obtained and forwarded
  });

  it("drafts a pause and hands back the exact draft the CLI signs", async () => {
    const drafted = await admin.post("/api/failsafe/commands").send({
      action: "pause", engineId: "athena-1", reason: "runaway crawl",
    });
    expect(drafted.status).toBe(201);
    expect(drafted.body.command.action).toBe("pause");
    expect(drafted.body.command.requiredSignatures).toBe(1);
    expect(drafted.body.signingBytes).toBe("deadbeef");
    // The draft is snake_case, because the CLI reconstructs the signed bytes
    // from these exact keys.
    expect(drafted.body.draft).toMatchObject({
      action: "pause", engine_id: "athena-1", reason: "runaway crawl",
    });
    expect(drafted.body.draft.nonce).toBeTruthy();
  });

  it("relays two distinct signatures for stand-down and marks it ready only then", async () => {
    const drafted = await admin.post("/api/failsafe/commands").send({
      action: "stand_down", engineId: "athena-1", reason: "compromise suspected",
    });
    const uuid = drafted.body.command.uuid as string;
    expect(drafted.body.command.requiredSignatures).toBe(2);

    const one = await admin.post(`/api/failsafe/commands/${uuid}/signatures`)
      .send({ keyId: "alice", sig: "aa11" });
    expect(one.status).toBe(200);
    expect(one.body.status).toBe("awaiting_signatures");
    expect(one.body.signers).toEqual(["alice"]);

    const two = await admin.post(`/api/failsafe/commands/${uuid}/signatures`)
      .send({ keyId: "bob", sig: "bb22" });
    expect(two.status).toBe(200);
    expect(two.body.status).toBe("ready");
    expect(two.body.signers).toEqual(["alice", "bob"]);
  });

  it("passes a backend refusal (terminate by a non-admin service account) through with its reason", async () => {
    refuseTerminate = true;
    const denied = await admin.post("/api/failsafe/commands").send({
      action: "terminate", engineId: "athena-1", reason: "unrecoverable",
    });
    expect(denied.status).toBe(403);
    expect(String(denied.body.error)).toContain("admin");
    refuseTerminate = false;
  });

  it("rejects a body the console schema will not accept", async () => {
    const bad = await admin.post("/api/failsafe/commands").send({
      action: "obliterate", engineId: "athena-1",
    });
    expect(bad.status).toBe(400);
  });
});

describe("failsafe console without a control plane", () => {
  let app: Express;
  let admin: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    vi.resetModules();
    app = await makeApp();
    admin = await signIn(app);
  });

  it("says so in words rather than failing, when nothing is configured", async () => {
    const status = await admin.get("/api/failsafe/status");
    expect(status.status).toBe(200);
    expect(status.body.configured).toBe(false);
    expect(String(status.body.detail)).toMatch(/no failsafe control plane/i);
  });

  it("answers 503 for a live call when the control plane is absent", async () => {
    const state = await admin.get("/api/failsafe/state");
    expect(state.status).toBe(503);
  });
});
