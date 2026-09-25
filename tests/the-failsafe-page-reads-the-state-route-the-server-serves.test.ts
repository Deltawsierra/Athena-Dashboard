import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * The Failsafe page read the engine state with
 *   queryKey: ["/api/failsafe/state", effectiveEngineId]
 * and the app's default queryFn turns a string segment into a PATH segment:
 *   GET /api/failsafe/state/athena-1
 * The server only serves GET /api/failsafe/state?engineId=..., and the unknown
 * /api path answers 404 {"message":"Not found"}. So in a real build the state
 * read ALWAYS failed whenever an engine was named: the in-flight list (the only
 * way a second operator reaches a stand-down/terminate to co-sign it) never
 * listed anything and the governor never read. Every Failsafe render test
 * passed, because each supplied its own queryFn keyed on the key.
 *
 * This runs the key the page builds -- imported from the page, not copied --
 * through the app's own default queryFn, and asks the real app for that URL.
 * (tests/every-page-query-key-reaches-a-route.test.ts sweeps every other key.)
 */
describe("the Failsafe state read the page actually makes", () => {
  let app: Express;
  let admin: Awaited<ReturnType<typeof signIn>>;
  let server: Server;

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0];
      const json = (code: number, payload: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (path === "/api/token/") return json(200, { access: "t", refresh: "r" });
      if (path === "/api/failsafe/state/") {
        const now = new Date();
        return json(200, {
          engine_id: "athena-1", engine_state: "running", engine_state_available: true,
          awaiting_signatures: [{
            uuid: "sd-1", engine_id: "athena-1", action: "stand_down", nonce: "n",
            issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 600_000).toISOString(),
            reason: "r", signers: ["alice"], required_signatures: 2, status: "awaiting_signatures",
            created_at: now.toISOString(), updated_at: now.toISOString(),
          }],
          ready: [], recent: [],
        });
      }
      if (path === "/api/failsafe/commands/sd-1/") {
        const now = new Date();
        return json(200, {
          uuid: "sd-1", engine_id: "athena-1", action: "stand_down", nonce: "n",
          issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 600_000).toISOString(),
          reason: "r", signers: ["alice"], required_signatures: 2, status: "awaiting_signatures",
          created_at: now.toISOString(), updated_at: now.toISOString(), signing_bytes: "beef",
        });
      }
      return json(404, { detail: "no route" });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_FAILSAFE_USER = "svc";
    process.env.ATHENA_FAILSAFE_PASSWORD = "svc";
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
    vi.unstubAllGlobals();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("the URL the default queryFn builds for the page's state key reaches the state route", async () => {
    // The exact key Failsafe.tsx uses, through the app's own default queryFn.
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const { getQueryFn } = await import("../client/src/lib/queryClient");
    const { failsafeStateKey, failsafeCommandKey } = await import("../client/src/pages/Failsafe");
    await getQueryFn({ on401: "throw" })({
      queryKey: failsafeStateKey("athena-1"), meta: undefined, signal: new AbortController().signal,
    } as never);
    await getQueryFn({ on401: "throw" })({
      queryKey: failsafeCommandKey("sd-1"), meta: undefined, signal: new AbortController().signal,
    } as never);
    vi.unstubAllGlobals();
    const [stateUrl, commandUrl] = urls;
    expect(stateUrl).toBe("/api/failsafe/state?engineId=athena-1");

    const res = await admin.get(stateUrl);
    // What the page needs: the state, with the in-flight stand-down in it.
    expect(res.status).toBe(200);
    expect(res.body.awaitingSignatures?.[0]?.uuid).toBe("sd-1");
    // ...and the console opens that stand-down at the path the server serves.
    const command = await admin.get(commandUrl);
    expect(command.status).toBe(200);
    expect(command.body.command.uuid).toBe("sd-1");
  });

  it("control: the route itself works when asked with ?engineId=", async () => {
    const res = await admin.get("/api/failsafe/state?engineId=athena-1");
    expect(res.status).toBe(200);
    expect(res.body.awaitingSignatures[0].uuid).toBe("sd-1");
  });
});
