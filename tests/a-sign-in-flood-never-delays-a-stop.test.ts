import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";

/**
 * SAFETY: password verification (server/password.ts) derives a key with
 * scrypt, which is CPU-bound and runs on libuv's threadpool. A flood of
 * concurrent failed sign-ins -- one bad password sent at once from twenty
 * places, say -- fills those workers, and anything else queued behind them is
 * delayed: a scan's Stop included.
 *
 * Two things had to be true for a Stop to stay prompt under such a flood, and
 * this file measures BOTH:
 *
 *   1. scrypt off the event loop. A synchronous scrypt call held the loop, so
 *      the Stop queued behind every hash there (over 1,100 ms at 20). scrypt
 *      now runs on the threadpool, so the loop is free -- measured with an
 *      IP-literal engine URL, which never resolves DNS.
 *
 *   2. the Stop off the threadpool too. A cold outbound connection to a
 *      HOSTNAME engine URL runs getaddrinfo, which ALSO uses the threadpool --
 *      so the flood's scrypt jobs starved it and the Stop was delayed all over
 *      again (localhost, cold socket: ~0.4-0.6 s at 20, ~1.3 s at 48 here; a
 *      distributed flood, unbounded by the per-address sign-in cap, scaled to
 *      seconds). The fix pins the engine's address in a cache resolved off the
 *      stop path (server/dns-cache.ts), so a Stop connects without a live
 *      getaddrinfo. This case measures the HOSTNAME path on a cold socket --
 *      the one the old test, hardcoded to 127.0.0.1, could not see.
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
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
});
afterAll(() => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  process.env.ATHENA_STORAGE = "memory";
  child.kill();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function arrived(line: string, ms = 8_000) {
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

/** Boot a fresh in-memory app whose engine URL is `engineUrl`, signed in as admin, with one running scan per round to stop. */
async function bootApp(engineUrl: string): Promise<{ client: { id: string } }> {
  process.env.ATHENA_STORAGE = "memory";
  process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-characters";
  process.env.NODE_ENV = "test";
  process.env.ATHENA_ENGINE_URL = engineUrl;
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
  return { client };
}

/** One round: 20 concurrent failed sign-ins in flight, a scan's Stop sent right behind; returns the Stop's latency to the engine. */
async function floodAndStop(clientId: string, tag: string): Promise<number> {
  const storage = (await import("../server/storage-unified")).storage;
  const { resetLoginThrottle } = await import("../server/routes");
  const test = await storage.createTest({
    clientId, testType: "vulnerability-scan", status: "running",
    findings: { runId: `victim-${tag}`, target: "https://victim.example.test/", results: [] },
  });
  resetLoginThrottle();
  calls.length = 0;

  // 20 concurrent failed sign-ins, distinct usernames so neither the
  // per-username nor the per-address throttle blocks any of them before its
  // hash begins -- every one actually reaches scrypt.
  const flood = Array.from({ length: 20 }, (_, i) =>
    call("POST", "/api/auth/login", { username: `flood-${tag}-${i}`, password: "wrong-password" }).catch(() => undefined));

  // The Stop, sent right behind the flood -- no `await` in between, so it is
  // in flight while the flood's hashes are too, not after them.
  const pressed = Date.now();
  const stop = call("POST", `/api/scans/${test.id}/abort`, undefined, sessionCookie);
  const answer = await stop;
  expect(answer.status).toBe(200);
  const got = await arrived(`POST /api/scans/victim-${tag}/abort`, 8_000);
  expect(got).toBeDefined();
  await Promise.all(flood);
  return got!.at - pressed;
}

describe("a flood of failed sign-ins", () => {
  it("delays no Stop with an IP-literal engine URL (scrypt is off the loop)", async () => {
    // The engine at 127.0.0.1 -- an IP literal, so no getaddrinfo is ever
    // done: this isolates the event-loop cost of scrypt. A synchronous scrypt
    // call put this over 1,100 ms every round, measured the same way on this
    // machine.
    const { client } = await bootApp(`http://127.0.0.1:${enginePort}`);
    const latencies: number[] = [];
    for (let round = 0; round < 5; round += 1) latencies.push(await floodAndStop(client.id, `ip-${round}`));
    console.log(`[flood] IP-literal engine: a scan's Stop reached the engine after ${latencies.join(", ")} ms`);
    // Off the loop it is a two-digit number of milliseconds most rounds,
    // occasionally more on a loaded machine (twenty brand-new connections
    // arriving together cost something on their own, before scrypt is ever
    // reached) -- generous next to that 1,100 ms+ failure mode, and still an
    // order of magnitude under it.
    expect(Math.max(...latencies)).toBeLessThanOrEqual(400);
  }, 60_000);

  it("delays no Stop with a HOSTNAME engine URL on a cold socket (the Stop is off the threadpool)", async () => {
    // The engine at `localhost` -- a name, so a cold connection resolves it
    // with getaddrinfo, on the same threadpool the flood's scrypt jobs fill.
    // Before the address was pinned (server/dns-cache.ts), the Stop queued
    // behind that starved getaddrinfo: ~385-570 ms at 20 concurrent here on
    // the unfixed head, ~1.3 s at 48 -- and a distributed flood, which the
    // per-address sign-in cap does not bound, drove it into seconds. With the
    // address served from the cache, the Stop connects without a live
    // getaddrinfo and behaves like the IP-literal path above (~50 ms here).
    const { client } = await bootApp(`http://localhost:${enginePort}`);
    const latencies: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      // A COLD socket each round: the engine's keep-alive connection closes
      // after IDLE_SOCKET_MS (4 s), so waiting past it guarantees the Stop
      // must open a fresh connection -- the case that resolves DNS. Without
      // this, rounds after the first would reuse a warm socket and never
      // resolve, hiding the regression this measures.
      await sleep(4_500);
      latencies.push(await floodAndStop(client.id, `host-${round}`));
    }
    console.log(`[flood] HOSTNAME engine (cold socket): a scan's Stop reached the engine after ${latencies.join(", ")} ms`);
    // Bound at 200 ms: the pinned-address path measures ~50-60 ms here (up to
    // ~140 ms on a loaded machine, the cost of twenty fresh connections
    // arriving together -- the same noise the IP case absorbs), while the
    // unfixed head's starved getaddrinfo put every cold round at 385 ms or
    // more. 200 ms clears the fix with room and fails the regression outright
    // -- unlike the IP case's 400 ms, which the 385 ms hostname delay slipped
    // under. It is deliberately tighter than that 400 ms and never raises it.
    expect(Math.max(...latencies)).toBeLessThanOrEqual(200);
  }, 60_000);
});
