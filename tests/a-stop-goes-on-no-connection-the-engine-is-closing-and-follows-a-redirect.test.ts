import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import net from "net";
import type { AddressInfo } from "net";

/**
 * The engine client (server/engine.ts) asks the engine over node:http with
 * connections kept open between calls. athena-engine runs under uvicorn,
 * which closes a kept connection after 5 s unused and says nothing of it
 * beforehand (no Keep-Alive header). A Stop written onto a connection the
 * engine was closing was reset before the engine read it -- "socket hang up",
 * the stop lost: 6 of 21 at 20 ms each way, 7 of 21 on one machine, in the
 * round-five review. And the client no longer followed redirects, where
 * fetch had: a Stop through a 308 was never delivered.
 *
 *   - A connection is closed from this side after 4 s unused (IDLE_SOCKET_MS),
 *     below the engine's 5 s, as fetch (undici) did; a call waiting on the
 *     engine is not cut off by it.
 *   - A read or a stop on a kept connection that is reset before any of an
 *     answer is sent once more, on a new connection -- once, and never one on
 *     a new connection. A start is not: the engine may have read it.
 *   - Redirects are followed as fetch followed them: 307 and 308 with the
 *     method and the body, 301, 302 (a POST) and 303 as a GET, at most 20.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let engineModule: typeof import("../server/engine");

/** Point the client at `port`, and load it afresh (its connections are its own). */
async function engineAt(port: number) {
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  engineModule = await import("../server/engine");
}

afterAll(() => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
});

/**
 * An engine that speaks HTTP/1.1 as uvicorn does: it keeps a connection open
 * after an answer, sends no Keep-Alive header, and closes the connection
 * itself after `idleMs` unused. `holdMs`: how long it takes to answer a path.
 */
async function uvicornLike(idleMs: number, holdMs: Record<string, number> = {}) {
  const closedByClient: number[] = [];
  const closedByServer: number[] = [];
  let connections = 0;
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections += 1;
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    const id = connections;
    let buffered = "";
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { closedByServer.push(id); socket.end(); }, idleMs);
    };
    arm();
    socket.on("end", () => { if (!closedByServer.includes(id)) closedByClient.push(id); });
    socket.on("error", () => undefined);
    socket.on("close", () => clearTimeout(idle));
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffered.slice(0, end);
      const length = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? "0");
      if (buffered.length < end + 4 + length) return;
      buffered = buffered.slice(end + 4 + length);
      clearTimeout(idle);
      const path = head.split(" ")[1];
      const body = path === "/api/scans/active" ? JSON.stringify({ active: [] }) : JSON.stringify({ run_id: "r", state: "aborting" });
      setTimeout(() => {
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        arm();
      }, holdMs[path] ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    closedByClient, closedByServer, connections: () => connections,
    close: () => new Promise<void>((r) => { open.forEach((one) => one.destroy()); server.close(() => r()); }),
  };
}

describe("no request goes on a connection the engine is closing", () => {
  let engine: Awaited<ReturnType<typeof uvicornLike>>;
  afterEach(async () => { await engine?.close(); });

  it("a connection left unused is closed from this side within 4 s -- before the engine's 5 s -- and the Stop after it goes on a new one", async () => {
    engine = await uvicornLike(5_000);
    await engineAt(engine.port);
    expect(engineModule.IDLE_SOCKET_MS).toBeLessThanOrEqual(4_000);
    // The Running Scans page's poll, then a Stop 4.5 s later: past this side's limit, inside the engine's.
    expect(await engineModule.activeRuns()).toEqual([]);
    await sleep(4_500);
    expect(engine.closedByClient).toEqual([1]);
    expect(engine.closedByServer).toEqual([]);
    const outcome = await engineModule.abortRun("run-after-idle");
    expect(outcome.accepted).toBe(true);
    expect(engine.connections()).toBe(2);
  }, 20_000);

  it("a retest's start after the poll and 4.5 s unused goes on a new connection too: never one the engine is closing", async () => {
    engine = await uvicornLike(5_000);
    await engineAt(engine.port);
    expect(await engineModule.activeRuns()).toEqual([]);
    await sleep(4_500);
    // Its answer is not a retest's; only where it was sent matters here.
    await engineModule.retest({ twinId: 1, engagementRef: "e", scope: [] }).catch(() => undefined);
    expect(engine.closedByClient).toEqual([1]);
    expect(engine.closedByServer).toEqual([]);
    expect(engine.connections()).toBe(2);
  }, 20_000);

  it("the limit is on a connection left unused, not on a call: an answer that takes 5 s is waited for", async () => {
    engine = await uvicornLike(10_000, { "/api/scans/active": 5_000 });
    await engineAt(engine.port);
    expect(await engineModule.activeRuns()).toEqual([]);
    expect(engine.connections()).toBe(1);
  }, 20_000);
});

/**
 * An engine behind a connection that is reset: each request named in
 * `resetOnReuse` that arrives on a connection which has already carried a
 * request is met by the connection being destroyed, once -- the engine never
 * reads it. `resetOnNew` does the same to the first request on a connection.
 */
async function resettingEngine() {
  const seen: string[] = [];
  const resetOnReuse = new Set<string>();
  const resetOnNew = new Set<string>();
  const served = new WeakMap<net.Socket, number>();
  const server = http.createServer((req, res) => {
    const line = `${req.method} ${req.url}`;
    const before = served.get(req.socket) ?? 0;
    served.set(req.socket, before + 1);
    if ((before > 0 && resetOnReuse.delete(line)) || (before === 0 && resetOnNew.delete(line))) {
      seen.push(`RESET ${line}`);
      req.socket.destroy();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      seen.push(`${line}${raw ? ` ${raw}` : ""}`);
      res.writeHead(req.url === "/api/remediation/retest" ? 202 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(
        req.url === "/api/scans/active" ? { active: [{ run_id: "live-1", target: "https://t/", state: "running" }] }
          : req.url === "/api/remediation/retest" ? { answer: "status", run_id: "retest-run-1", state: "running" }
            : { run_id: "r", state: "aborting" },
      ));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port, seen, resetOnReuse, resetOnNew,
    close: async () => { server.closeAllConnections?.(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

describe("a read or a stop reset on a kept connection before any answer is sent once more, on a new connection", () => {
  let engine: Awaited<ReturnType<typeof resettingEngine>>;
  beforeAll(async () => {
    engine = await resettingEngine();
    await engineAt(engine.port);
  });
  afterAll(async () => { await engine.close(); });

  it("a Stop: accepted, sent twice -- the first never read", async () => {
    await engineModule.activeRuns();
    engine.resetOnReuse.add("POST /api/scans/run-reset/abort");
    const outcome = await engineModule.abortRun("run-reset");
    expect(outcome.accepted).toBe(true);
    expect(engine.seen.filter((one) => one.includes("/api/scans/run-reset/abort"))).toEqual([
      "RESET POST /api/scans/run-reset/abort", "POST /api/scans/run-reset/abort",
    ]);
  });

  it("the kill switch's read of the engine's list: read", async () => {
    await engineModule.activeRuns();
    engine.resetOnReuse.add("GET /api/scans/active");
    const listed = await engineModule.activeRuns();
    expect(listed.map((one) => one.runId)).toEqual(["live-1"]);
  });

  it("never a start: a retest reset on a kept connection may have been read (engine main runs it to its end), so it is not sent twice", async () => {
    await engineModule.activeRuns();
    engine.resetOnReuse.add("POST /api/remediation/retest");
    await expect(engineModule.retest({ twinId: 7, engagementRef: "eng-1", scope: ["https://t/"] })).rejects.toThrow(/could not reach the engine/);
    expect(engine.seen.filter((one) => one.includes("/api/remediation/retest"))).toEqual(["RESET POST /api/remediation/retest"]);
  });

  it("only once: a request reset on a new connection is not sent again, and says the connection was lost", async () => {
    // A fresh client: no kept connection, so the Stop goes on a new one.
    await engineAt(engine.port);
    engine.resetOnNew.add("POST /api/scans/run-new-reset/abort");
    await expect(engineModule.abortRun("run-new-reset")).rejects.toThrow(/could not reach the engine .*socket hang up|ECONNRESET/);
    expect(engine.seen.filter((one) => one.includes("run-new-reset"))).toEqual(["RESET POST /api/scans/run-new-reset/abort"]);
  });
});

describe("redirects are followed as fetch followed them", () => {
  const hits: string[] = [];
  let back: http.Server;
  let front: http.Server;
  /** What the front answers, by path prefix: a status, and where to. */
  const redirects = new Map<string, { status: number; to: (backPort: number, url: string) => string }>();
  beforeAll(async () => {
    back = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        hits.push(`${req.method} ${req.url} key=${req.headers["x-api-key"] ?? "-"} body=${raw || "-"}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(req.url === "/api/scans/active" ? { active: [] } : { run_id: "r", state: "aborting" }));
      });
    });
    await new Promise<void>((r) => back.listen(0, "127.0.0.1", r));
    const backPort = (back.address() as AddressInfo).port;
    front = http.createServer((req, res) => {
      req.resume();
      const rule = Array.from(redirects.entries()).find(([prefix]) => (req.url ?? "").startsWith(prefix))?.[1];
      const rules = rule ?? { status: req.method === "POST" ? 308 : 307, to: (port: number, url: string) => `http://127.0.0.1:${port}${url}` };
      res.writeHead(rules.status, { Location: rules.to(backPort, req.url ?? "/") });
      res.end();
    });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    await engineAt((front.address() as AddressInfo).port);
  });
  afterAll(async () => {
    front.closeAllConnections?.(); back.closeAllConnections?.();
    await new Promise<void>((r) => front.close(() => r()));
    await new Promise<void>((r) => back.close(() => r()));
  });

  it("a Stop through a 308 reaches the engine, a POST still, with its key; the engine's list through a 307 is read", async () => {
    hits.length = 0;
    const outcome = await engineModule.abortRun("run-redirected");
    expect(outcome).toMatchObject({ accepted: true, state: "aborting" });
    expect(await engineModule.activeRuns()).toEqual([]);
    expect(hits).toEqual([
      "POST /api/scans/run-redirected/abort key=ce_op_test body=-",
      "GET /api/scans/active key=ce_op_test body=-",
    ]);
  });

  it("a 307 keeps the method and the body; a 303 asks with a GET and no body, as does a 301 or a 302 to a POST", async () => {
    hits.length = 0;
    redirects.set("/api/remediation/retest", { status: 307, to: (port, url) => `http://127.0.0.1:${port}${url}` });
    await engineModule.retest({ twinId: 3, engagementRef: "e", scope: [] }).catch(() => undefined);
    expect(hits[0]).toMatch(/^POST \/api\/remediation\/retest key=ce_op_test body=\{"twin_id":3/);
    for (const status of [301, 302, 303]) {
      hits.length = 0;
      redirects.set("/api/scans/", { status, to: (port) => `http://127.0.0.1:${port}/api/scans/active` });
      await engineModule.abortRun(`run-${status}`).catch(() => undefined);
      expect(hits, String(status)).toEqual(["GET /api/scans/active key=ce_op_test body=-"]);
    }
    redirects.clear();
  });

  it("a redirect that never ends is given up after 20, and said", async () => {
    redirects.set("/api/scans/active", { status: 307, to: (_port, url) => `http://127.0.0.1:${(front.address() as AddressInfo).port}${url}` });
    try {
      await expect(engineModule.activeRuns()).rejects.toThrow(/redirected more than 20 times/);
    } finally {
      redirects.clear();
    }
  });

  it("a redirect to another scheme than http or https is not followed", async () => {
    redirects.set("/api/scans/active", { status: 307, to: () => "file:///etc/passwd" });
    try {
      await expect(engineModule.activeRuns()).rejects.toThrow(/answered 307 to file: -- not followed/);
    } finally {
      redirects.clear();
    }
  });
});
