import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";

/**
 * SAFETY: password verification (server/password.ts) derives a key with
 * scrypt, which is CPU-bound. A synchronous scrypt call ran on the event
 * loop, so a flood of concurrent failed sign-ins -- one bad password sent at
 * once from twenty places, say -- queued behind one another there, and every
 * other request queued behind them: a scan's Stop included. scrypt now runs
 * off the loop (libuv's threadpool), so a Stop sent while such a flood is in
 * flight still reaches the engine on schedule.
 *
 * The per-address and per-username throttles (server/routes.ts) still count
 * each failure before the hash begins, not after, so the flood is still
 * bounded even though many attempts can now be mid-hash together.
 *
 * Requests are made with plain `http.request` against one already-listening
 * server, not a fresh one per call (a bare `supertest`/`superagent` call
 * against an Express app, rather than a `Server`, opens a brand new
 * `http.Server` for that one call -- fine for one request at a time, but
 * twenty of them each pay to bind and listen on their own ephemeral port,
 * which swamps the very delay this measures). The stand-in engine runs in a
 * process of its own, so when the Stop arrives is measured by a clock this
 * process's own event loop cannot hold up.
 */

const calls: Array<{ line: string; at: number }> = [];
let child: ChildProcess;
let enginePort = 0;

beforeAll(async () => {
  child = spawn(process.execPath, [path.join(__dirname, "helpers", "engine-in-its-own-process.cjs")], { stdio: ["ignore", "pipe", "inherit"] });
  let buffer = "";
  await new Promise<void>((ready) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const one = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (one.port) { enginePort = one.port; ready(); } else calls.push(one);
      }
    });
  });
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${enginePort}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
});
afterAll(() => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  process.env.ATHENA_STORAGE = "memory";
  child.kill();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function arrived(line: string, ms = 5_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const one = calls.find((c) => c.line === line);
    if (one || Date.now() > deadline) return one;
    await sleep(5);
  }
}

let server: http.Server;
let appPort = 0;
let sessionCookie = "";
afterEach(() => { server?.close(); });

/** One request against the shared server, on its own connection. */
function call(method: string, reqPath: string, body?: unknown, cookie = ""): Promise<{ status: number; body: string; setCookie?: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port: appPort, path: reqPath, method,
      headers: {
        ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
        ...(cookie ? { cookie } : {}),
      },
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => { chunks += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: chunks, setCookie: res.headers["set-cookie"]?.[0] }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("a flood of failed sign-ins", () => {
  it("delays no Stop: with 20 concurrent failed sign-ins in flight, a scan's Stop reaches the engine promptly", async () => {
    process.env.ATHENA_STORAGE = "memory";
    process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-characters";
    process.env.NODE_ENV = "test";
    const { createApp } = await import("../server/app");
    const { initializeDefaultData } = await import("../server/init-data");
    const { resetLoginThrottle } = await import("../server/routes");
    const app = createApp();
    await initializeDefaultData();
    resetLoginThrottle();

    server = http.createServer(app);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    appPort = (server.address() as AddressInfo).port;

    const login = await call("POST", "/api/auth/login", { username: "admin", password: "admin123" });
    expect(login.status).toBe(200);
    sessionCookie = login.setCookie!.split(";")[0];

    const storage = (await import("../server/storage-unified")).storage;
    const client = await storage.createClient({ name: "Flooded", company: "Flooded", email: "f@f.test" });

    const latencies: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const test = await storage.createTest({
        clientId: client.id, testType: "vulnerability-scan", status: "running",
        findings: { runId: `victim-${round}`, target: "https://victim.example.test/", results: [] },
      });
      resetLoginThrottle();
      calls.length = 0;

      // 20 concurrent failed sign-ins, distinct usernames so neither the
      // per-username nor the per-address throttle blocks any of them before
      // its hash begins -- every one actually reaches scrypt.
      const flood = Array.from({ length: 20 }, (_, i) =>
        call("POST", "/api/auth/login", { username: `flood-${round}-${i}`, password: "wrong-password" }).catch(() => undefined));

      // The Stop, sent right behind the flood -- no `await` in between, so it
      // is in flight while the flood's hashes are too, not after them.
      const pressed = Date.now();
      const stop = call("POST", `/api/scans/${test.id}/abort`, undefined, sessionCookie);

      const answer = await stop;
      expect(answer.status).toBe(200);
      const got = await arrived(`POST /api/scans/victim-${round}/abort`, 5_000);
      expect(got).toBeDefined();
      latencies.push(got!.at - pressed);
      await Promise.all(flood);
    }
    console.log(`[flood] a scan's Stop reached the engine after ${latencies.join(", ")} ms with 20 concurrent failed sign-ins each round`);
    // A synchronous scrypt call put this over 1,100 ms every round, measured
    // the same way on this machine. Off the loop it is a two-digit number of
    // milliseconds most rounds, occasionally more on a loaded machine (twenty
    // brand-new connections arriving together cost something on their own,
    // before scrypt is ever reached) -- generous next to that 1,100 ms+
    // failure mode, and still an order of magnitude under it.
    expect(Math.max(...latencies)).toBeLessThanOrEqual(400);
  }, 60_000);
});
