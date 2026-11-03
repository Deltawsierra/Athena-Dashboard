import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { makeApp, signIn } from "./helpers";

/**
 * The console shows Athena-Backend's own health (`GET /api/health/`, Athena-Backend
 * #217) through its server's `GET /api/backend-health`, read strictly:
 *
 *   - "ok" only when the backend said "ok" and reported every count, each zero;
 *   - "degraded" with every count it named, by name;
 *   - "unknown" for the backend's own "unknown", a missing field, a count that is
 *     not a whole number, an HTTP 500, or a body that is not JSON;
 *   - "unreachable" for a backend that refuses the connection or does not answer
 *     within the read's timeout;
 *   - "not-reported" for a backend that says its plain status and no counts (one
 *     from before #217, and #217's own "ok"): never read as all-zero.
 *
 * Fields the console does not recognise, a `workers` list and acknowledgement
 * fields (AB-HEALTH-SHARED) are shown as sent. The route answers from memory --
 * it never waits on the backend -- and the read sends no credential.
 *
 * This file reaches the server only over HTTP, so it runs against a server that
 * has no such route as well (where it fails: no reading is ever served).
 */

const KNOWN = ["stderr_lines_lost", "log_records_dropped", "unrecorded_dispatches_refused"];
const ZEROS = { stderr_lines_lost: 0, log_records_dropped: 0, unrecorded_dispatches_refused: 0 };

interface Health {
  url: string;
  asked: () => number;
  headers: http.IncomingHttpHeaders[];
  close: () => Promise<void>;
}

type Answer = (res: http.ServerResponse) => void;

const json = (status: number, body: unknown): Answer => (res) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let open: Health | null = null;
const savedUrl = process.env.ATHENA_FAILSAFE_URL;

/** A backend whose /api/health/ answers with `answer`; anything else 404. */
async function healthBackend(answer: Answer): Promise<Health> {
  let asked = 0;
  const headers: http.IncomingHttpHeaders[] = [];
  const held: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    if ((req.url ?? "").split("?")[0] === "/api/health/") {
      asked += 1;
      headers.push(req.headers);
      held.push(res);
      return answer(res);
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  open = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked: () => asked,
    headers,
    close: async () => {
      for (const res of held) res.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
  return open;
}

/** A port nothing listens on. */
async function closedPort(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done) => server.close(() => done()));
  return `http://127.0.0.1:${port}`;
}

/** The background reader of the server under test, where there is one (none on a server without the strip). */
async function reader(): Promise<{
  backendHealthTimings: { timeoutMs: number };
  startBackendHealthReads: () => void;
  _resetBackendHealthForTests: () => void;
} | null> {
  return import("../server/backend-health").catch(() => null);
}

afterEach(async () => {
  (await reader())?._resetBackendHealthForTests();
  await open?.close();
  open = null;
  if (savedUrl === undefined) delete process.env.ATHENA_FAILSAFE_URL;
  else process.env.ATHENA_FAILSAFE_URL = savedUrl;
});

/**
 * A fresh console, signed in, pointed at `url` (none when null), with the
 * background reader started as the server's entry points start it (unless
 * `started` is false).
 */
async function consoleAt(url: string | null, started = true) {
  delete process.env.ATHENA_FAILSAFE_URL;
  vi.resetModules();
  const app = await makeApp();
  const agent = await signIn(app);
  if (started) (await reader())?.startBackendHealthReads();
  if (url !== null) process.env.ATHENA_FAILSAFE_URL = url;
  return agent;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask the console until it serves a reading the backend was read for (at most `tries` asks, 50 ms apart). */
async function servedReading(agent: Awaited<ReturnType<typeof consoleAt>>, tries = 200) {
  let last: { status: number; body: any } = { status: 0, body: null };
  for (let i = 0; i < tries; i += 1) {
    const res = await agent.get("/api/backend-health");
    last = { status: res.status, body: res.body };
    if (res.status === 200 && res.body?.configured === true && res.body.checkedAt !== null) return res.body;
    await sleep(50);
  }
  throw new Error(`the console never served a reading of the backend's health: last answer ${last.status} ${JSON.stringify(last.body)}`);
}

async function readingOf(answer: Answer) {
  const backend = await healthBackend(answer);
  const agent = await consoleAt(backend.url);
  const view = await servedReading(agent);
  return { view, reading: view.reading, backend, agent };
}

describe("a degraded backend is shown degraded, with every count by name", () => {
  it("#217's degraded answer: the state and each named count", async () => {
    const { reading } = await readingOf(json(200, {
      status: "degraded",
      message: "Django backend is alive, and lost or refused what an operator must act on: stderr_lines_lost=3, log_records_dropped=12, unrecorded_dispatches_refused=1",
      degraded: { stderr_lines_lost: 3, log_records_dropped: 12, unrecorded_dispatches_refused: 1 },
    }));
    expect(reading.verdict).toBe("degraded");
    expect(reading.reportedStatus).toBe("degraded");
    expect(reading.counts).toEqual([
      { name: "stderr_lines_lost", label: "stderr lines lost", value: 3, known: true },
      { name: "log_records_dropped", label: "log records dropped", value: 12, known: true },
      { name: "unrecorded_dispatches_refused", label: "unrecorded dispatches refused", value: 1, known: true },
    ]);
  });

  it("a degraded answer naming one count: that count, and no zero for the two it did not name", async () => {
    const { reading } = await readingOf(json(200, { status: "degraded", message: "m", degraded: { log_records_dropped: 7 } }));
    expect(reading.verdict).toBe("degraded");
    expect(reading.counts).toEqual([{ name: "log_records_dropped", label: "log records dropped", value: 7, known: true }]);
  });

  it("a degraded answer with a count that is not a number: still degraded, and the count is said, never read as a number", async () => {
    const { reading } = await readingOf(json(200, { status: "degraded", degraded: { stderr_lines_lost: "many", log_records_dropped: 2 } }));
    expect(reading.verdict).toBe("degraded");
    expect(reading.counts.map((one: { name: string }) => one.name)).toEqual(["log_records_dropped"]);
    expect(reading.problems.join("\n")).toMatch(/"stderr_lines_lost" is not a whole number: "many"/);
  });
});

describe("only an explicit ok with every count zero is ok", () => {
  it("ok with every count reported and zero: ok", async () => {
    const { reading } = await readingOf(json(200, { status: "ok", message: "Django backend is alive.", counts: ZEROS }));
    expect(reading.verdict).toBe("ok");
    expect(reading.counts).toEqual([]);
    expect(reading.problems).toEqual([]);
  });

  it("#217's ok, which names no count: its plain status, counts not reported by this backend -- never ok", async () => {
    const { reading } = await readingOf(json(200, { status: "ok", message: "Django backend is alive." }));
    expect(reading.verdict).toBe("not-reported");
    expect(reading.reportedStatus).toBe("ok");
    expect(reading.countsReported).toBe(false);
    expect(reading.headline).toMatch(/counts not reported by this backend/);
  });

  it("an old backend's plain answer ({status: ok}): counts not reported, never all-zero", async () => {
    const { reading } = await readingOf(json(200, { status: "ok" }));
    expect(reading.verdict).toBe("not-reported");
    expect(reading.counts).toEqual([]);
    expect(reading.countsReported).toBe(false);
  });
});

describe("every odd answer reads unknown or unreachable, never ok", () => {
  it("the backend's own unknown", async () => {
    const { reading } = await readingOf(json(200, { status: "unknown", message: "the degraded counts could not be read: ImportError" }));
    expect(reading.verdict).toBe("unknown");
    expect(reading.message).toMatch(/could not be read/);
  });

  it("a missing status", async () => {
    const { reading } = await readingOf(json(200, { message: "alive", counts: ZEROS }));
    expect(reading.verdict).toBe("unknown");
  });

  it.each(KNOWN)("ok with the count %s missing: unknown, and the missing count is said -- never read as 0", async (missing) => {
    const counts: Record<string, number> = { ...ZEROS };
    delete counts[missing];
    const { reading } = await readingOf(json(200, { status: "ok", counts }));
    expect(reading.verdict).toBe("unknown");
    expect(reading.problems.join("\n")).toContain(`"${missing}"`);
    expect(reading.counts).toEqual([]);
  });

  it.each([["a string", "0"], ["a negative number", -1], ["a fraction", 0.5], ["null", null], ["a list", [0]]])(
    "ok with a count that is %s: unknown",
    async (_what, value) => {
      const { reading } = await readingOf(json(200, { status: "ok", counts: { ...ZEROS, log_records_dropped: value } }));
      expect(reading.verdict).toBe("unknown");
      expect(reading.problems.join("\n")).toMatch(/"log_records_dropped" is not a whole number/);
    },
  );

  it("ok with a non-zero count: degraded, never ok", async () => {
    const { reading } = await readingOf(json(200, { status: "ok", counts: { ...ZEROS, stderr_lines_lost: 4 } }));
    expect(reading.verdict).toBe("degraded");
    expect(reading.counts).toEqual([{ name: "stderr_lines_lost", label: "stderr lines lost", value: 4, known: true }]);
  });

  it("an HTTP 500: unknown", async () => {
    const { reading } = await readingOf(json(500, { status: "ok", counts: ZEROS }));
    expect(reading.verdict).toBe("unknown");
    expect(reading.httpStatus).toBe(500);
  });

  it("a body that is not JSON: unknown", async () => {
    const { reading } = await readingOf((res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html>ok</html>"); });
    expect(reading.verdict).toBe("unknown");
  });

  it("a status this console does not know: unknown, with the status shown", async () => {
    const { reading } = await readingOf(json(200, { status: "fine", counts: ZEROS }));
    expect(reading.verdict).toBe("unknown");
    expect(reading.headline).toContain('"fine"');
  });

  it("a backend that does not answer within the read's timeout: unreachable", async () => {
    const backend = await healthBackend(() => undefined);
    const agent = await consoleAt(backend.url);
    // This server's read timeout, shortened before the first read (it is 5 s otherwise).
    const timings = (await reader())?.backendHealthTimings;
    if (timings) timings.timeoutMs = 300;
    const view = await servedReading(agent);
    expect(view.reading.verdict).toBe("unreachable");
    expect(view.reading.headline).toMatch(/did not answer/);
  }, 20_000);

  it("a backend that refuses the connection: unreachable", async () => {
    const agent = await consoleAt(await closedPort());
    const view = await servedReading(agent);
    expect(view.reading.verdict).toBe("unreachable");
    expect(view.reading.headline).toMatch(/could not be reached/);
  });
});

describe("what the console does not recognise is shown, not dropped", () => {
  it("unrecognised fields beside an ok", async () => {
    const { reading } = await readingOf(json(200, { status: "ok", counts: { ...ZEROS }, build: "abc123", uptime_s: 42 }));
    expect(reading.verdict).toBe("ok");
    expect(reading.unrecognised).toEqual([{ name: "build", value: '"abc123"' }, { name: "uptime_s", value: "42" }]);
  });

  it("an unrecognised count: shown under its own name", async () => {
    const { reading } = await readingOf(json(200, { status: "degraded", degraded: { stderr_lines_lost: 1, sockets_leaked: 2 } }));
    expect(reading.counts).toContainEqual({ name: "sockets_leaked", label: "sockets_leaked", value: 2, known: false });
  });

  it("AB-HEALTH-SHARED's workers and acknowledgement fields: shown as sent", async () => {
    const { reading } = await readingOf(json(200, {
      status: "degraded",
      degraded: { log_records_dropped: 3 },
      workers: [
        { pid: 101, status: "ok", counts: ZEROS },
        { pid: 102, status: "unknown", stale_s: 400 },
        { pid: 103, status: "degraded", exited: true, counts: { ...ZEROS, log_records_dropped: 3 } },
      ],
      acknowledged_by: "operator-1",
      acknowledged_at: "2026-11-03T10:00:00Z",
    }));
    expect(reading.verdict).toBe("degraded");
    expect(reading.workers).toHaveLength(3);
    expect(reading.workers[1].fields).toContainEqual({ name: "stale_s", value: "400" });
    expect(reading.acknowledgement).toEqual([
      { name: "acknowledged_by", value: '"operator-1"' },
      { name: "acknowledged_at", value: '"2026-11-03T10:00:00Z"' },
    ]);
    expect(reading.problems.join("\n")).toMatch(/worker 2: status "unknown"/);
  });

  it("ok at the top with a worker that is not: never ok", async () => {
    const { reading } = await readingOf(json(200, {
      status: "ok", counts: ZEROS,
      workers: [{ pid: 1, status: "ok", counts: ZEROS }, { pid: 2, status: "unknown" }],
    }));
    expect(reading.verdict).not.toBe("ok");
  });
});

describe("the read is off the request's path and sends no credential", () => {
  it("the route answers from memory while the backend's health read hangs", async () => {
    const backend = await healthBackend(() => undefined);
    const agent = await consoleAt(backend.url);
    const first = await agent.get("/api/backend-health");
    expect(first.status).toBe(200);
    for (let i = 0; i < 100 && backend.asked() === 0; i += 1) await sleep(20);
    expect(backend.asked()).toBe(1);
    // The backend still holds the read; the console answers anyway, and says it has no reading.
    const again = await agent.get("/api/backend-health");
    expect(again.status).toBe(200);
    expect(again.body.reading.verdict).toBe("unknown");
    expect(again.body.checkedAt).toBeNull();
    // One read at a time: asking again did not start a second.
    expect(backend.asked()).toBe(1);
  });

  it("no Authorization header and no service token go with the read", async () => {
    const { backend } = await readingOf(json(200, { status: "ok", counts: ZEROS }));
    expect(backend.headers.length).toBeGreaterThan(0);
    for (const sent of backend.headers) {
      expect(sent.authorization).toBeUndefined();
      expect(sent["x-failsafe-service-token"]).toBeUndefined();
    }
  });

  it("an app whose entry point did not start the reader reads nothing (an app made for a test)", async () => {
    const backend = await healthBackend(json(200, { status: "ok", counts: ZEROS }));
    const agent = await consoleAt(backend.url, false);
    const res = await agent.get("/api/backend-health");
    expect(res.status).toBe(200);
    expect(res.body.checkedAt).toBeNull();
    expect(res.body.reading.verdict).toBe("unknown");
    await sleep(200);
    expect(backend.asked()).toBe(0);
  });

  it("no backend configured: nothing to show, and nothing read", async () => {
    const agent = await consoleAt(null);
    const res = await agent.get("/api/backend-health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false });
  });

  it("the route is behind sign-in, as every other read", async () => {
    vi.resetModules();
    const app = await makeApp();
    const { default: request } = await import("supertest");
    expect((await request(app).get("/api/backend-health")).status).toBe(401);
  });
});
