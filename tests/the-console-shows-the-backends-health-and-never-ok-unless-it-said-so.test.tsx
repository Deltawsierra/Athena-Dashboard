// @vitest-environment jsdom
/**
 * DASH-HEALTH-PANEL: the console shows Athena-Backend's health -- its state,
 * every non-zero count by name, and each worker it reports (athena-backend #217,
 * #226) -- and never "ok" unless the backend said "ok" with every count
 * reported and zero.
 *
 *   - the reading (shared/backend-health.ts): each body #217 and #226 send, an
 *     explicit "ok" with its zeros, a backend from before #217, and every odd
 *     answer -- "unknown", a missing field, a count that is not a number, an
 *     HTTP 500, a body that is not JSON, a status this console does not know --
 *     none of which reads "ok";
 *   - the route (server/backend-health.ts), against a stand-in backend over HTTP:
 *     the same answers, a backend that never answers (the deadline) and one that
 *     cannot be reached; the route answering at once while the backend hangs;
 *     no credential sent; back-off after a failure;
 *   - the strip (client/src/components/BackendHealthStrip.tsx), in the console's
 *     shell, drawn from the real route: the counts by name, the workers, the
 *     fields this console does not know, acknowledgement read only; a failed
 *     read of the route, or an answer of the wrong shape, never "ok".
 *
 * On main the console read none of this: no route, no strip.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import request from "supertest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

import { makeApp, signIn } from "./helpers";
import { healthStandIn, json, type HealthStandIn } from "./helpers/health-stand-in";
import { interpretHealth, type BackendHealthView } from "@shared/backend-health";
import { SERVICE_TOKEN_HEADER } from "../server/failsafe-service-token";
import AppShell from "@/components/AppShell";
import BackendHealthStrip, { STRIP_TIMING } from "@/components/BackendHealthStrip";

// ---- What athena-backend #217 and #226 answer (config/api_views.py at each PR's head) ----

const OK_217 = { status: "ok", message: "Django backend is alive." };
const DEGRADED_217 = {
  status: "degraded",
  message: "Django backend is alive, and lost or refused what an operator must act on: stderr_lines_lost=3, unrecorded_dispatches_refused=1",
  degraded: { stderr_lines_lost: 3, unrecorded_dispatches_refused: 1 },
};
const DEGRADED_226 = {
  status: "degraded",
  message: "Django backend is alive, and lost or refused what an operator must act on: log_records_dropped=5, worker_reports_unpublished=2; and 1 worker report(s) read unknown: 9f2c not rewritten within 60 s",
  degraded: { log_records_dropped: 5, worker_reports_unpublished: 2 },
  workers: {
    "a1b2c3d4": { state: "this worker", log_records_dropped: 5 },
    "e5f6a7b8": { state: "exited", worker_reports_unpublished: 2 },
  },
  unknown: { "9f2c": "not rewritten within 60 s" },
};
const UNKNOWN_226 = {
  status: "unknown",
  message: "Django backend is alive, and 1 worker report(s) read unknown: 9f2c could not be read",
  unknown: { "9f2c": "could not be read" },
};
const UNKNOWN_217 = { status: "unknown", message: "the degraded counts could not be read: RuntimeError" };
/** An "ok" that names every count it read, each zero: the only answer that reads "ok". */
const OK_COUNTED = { status: "ok", message: "Django backend is alive.", counts: { stderr_lines_lost: 0, log_records_dropped: 0, unrecorded_dispatches_refused: 0 } };

/** Each answer that must never read "ok", with what it must read instead. */
const ODD: Array<{ name: string; status: number; body: string; reads: "unknown" | "unreachable" }> = [
  { name: "the backend says unknown (#217)", status: 200, body: JSON.stringify(UNKNOWN_217), reads: "unknown" },
  { name: "the backend says unknown (#226)", status: 200, body: JSON.stringify(UNKNOWN_226), reads: "unknown" },
  { name: "a missing status field", status: 200, body: JSON.stringify({ message: "alive", counts: OK_COUNTED.counts }), reads: "unknown" },
  { name: "degraded with its counts field missing", status: 200, body: JSON.stringify({ status: "degraded", message: "x" }), reads: "unknown" },
  { name: "an ok missing one count", status: 200, body: JSON.stringify({ status: "ok", counts: { stderr_lines_lost: 0, log_records_dropped: 0 } }), reads: "unknown" },
  { name: "a count that is a string", status: 200, body: JSON.stringify({ ...DEGRADED_217, degraded: { stderr_lines_lost: "3" } }), reads: "unknown" },
  { name: "a count that is null, in an ok", status: 200, body: JSON.stringify({ status: "ok", counts: { ...OK_COUNTED.counts, log_records_dropped: null } }), reads: "unknown" },
  { name: "a count that is negative", status: 200, body: JSON.stringify({ status: "ok", counts: { ...OK_COUNTED.counts, stderr_lines_lost: -1 } }), reads: "unknown" },
  { name: "a count that is a fraction", status: 200, body: JSON.stringify({ ...DEGRADED_217, degraded: { stderr_lines_lost: 1.5 } }), reads: "unknown" },
  { name: "a worker's count that is not a number", status: 200, body: JSON.stringify({ ...DEGRADED_226, workers: { w: { state: "live", log_records_dropped: "5" } } }), reads: "unknown" },
  { name: "an ok with a count above zero", status: 200, body: JSON.stringify({ status: "ok", counts: { ...OK_COUNTED.counts, stderr_lines_lost: 2 } }), reads: "unknown" },
  { name: "degraded with every count zero", status: 200, body: JSON.stringify({ status: "degraded", degraded: { stderr_lines_lost: 0 } }), reads: "unknown" },
  { name: "a status this console does not know", status: 200, body: JSON.stringify({ status: "error", message: "database down" }), reads: "unknown" },
  { name: "a status that is not a string", status: 200, body: JSON.stringify({ status: true }), reads: "unknown" },
  { name: "an HTTP 500", status: 500, body: JSON.stringify(OK_COUNTED), reads: "unknown" },
  { name: "an HTTP 503 with an HTML page", status: 503, body: "<html>Service Unavailable</html>", reads: "unknown" },
  { name: "a body that is not JSON", status: 200, body: "ok", reads: "unknown" },
  { name: "a body that is a JSON list", status: 200, body: JSON.stringify([OK_COUNTED]), reads: "unknown" },
];

describe("the reading: ok only when the backend said ok with every count reported and zero", () => {
  it("an explicit ok naming each count, each zero, reads ok", () => {
    const reading = interpretHealth(200, JSON.stringify(OK_COUNTED));
    expect(reading.state).toBe("ok");
    expect(reading.counts).toEqual([]);
    expect(reading.countsReported).toBe(true);
  });

  it("#217's degraded reads degraded, with each non-zero count by name", () => {
    const reading = interpretHealth(200, JSON.stringify(DEGRADED_217));
    expect(reading.state).toBe("degraded");
    expect(reading.counts).toEqual([
      { name: "stderr_lines_lost", label: "stderr lines lost", value: 3 },
      { name: "unrecorded_dispatches_refused", label: "unrecorded dispatches refused", value: 1 },
    ]);
  });

  it("#226's degraded reads degraded, with every worker, its state and counts, and every worker report it could not read", () => {
    const reading = interpretHealth(200, JSON.stringify(DEGRADED_226));
    expect(reading.state).toBe("degraded");
    expect(reading.counts.map((one) => [one.label, one.value])).toEqual([["log records dropped", 5], ["worker reports not published", 2]]);
    expect(reading.workers.map((one) => [one.id, one.state, one.counts.map((c) => [c.name, c.value])])).toEqual([
      ["a1b2c3d4", "this worker", [["log_records_dropped", 5]]],
      ["e5f6a7b8", "exited", [["worker_reports_unpublished", 2]]],
    ]);
    expect(reading.unknownWorkers).toEqual([{ id: "9f2c", why: "not rewritten within 60 s" }]);
  });

  it("a backend from before #217 (and #217's own ok, which names no count) reads as its plain status, counts not reported, never as all-zero", () => {
    const reading = interpretHealth(200, JSON.stringify(OK_217));
    expect(reading.state).toBe("uncounted");
    expect(reading.state).not.toBe("ok");
    expect(reading.backendStatus).toBe("ok");
    expect(reading.countsReported).toBe(false);
    expect(reading.counts).toEqual([]);
    expect(reading.reasons).toContain("counts not reported by this backend");
  });

  it.each(ODD)("$name: reads $reads, never ok", ({ status, body, reads }) => {
    const reading = interpretHealth(status, body);
    expect(reading.state).toBe(reads);
    expect(reading.reasons.length).toBeGreaterThan(0);
  });

  it("a field this console does not know is kept, as it came, never dropped", () => {
    const reading = interpretHealth(200, JSON.stringify({ ...DEGRADED_226, host_clock_skew_s: 4, workers: { w: { state: "stale", log_records_dropped: 1, pid: 77, acknowledged_by: "ops-1" } } }));
    expect(reading.unrecognized).toEqual([{ name: "host_clock_skew_s", raw: "4" }]);
    expect(reading.workers[0].unrecognized).toEqual([{ name: "pid", raw: "77" }]);
    expect(reading.workers[0].acknowledgement).toEqual([{ name: "acknowledged_by", raw: "\"ops-1\"" }]);
  });
});

// ---- The route, against a stand-in backend over HTTP ----

const ENV = ["ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD", "ATHENA_FAILSAFE_SERVICE_TOKEN"] as const;
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
const TIMING_DEFAULTS = { deadlineMs: 0, everyMs: 0, maxBackoffMs: 0, staleAfterMs: 0, maxBodyBytes: 0 };

let app: Express;
let agent: ReturnType<typeof request.agent>;
let stand: HealthStandIn;
let health: typeof import("../server/backend-health");
let server: http.Server;
let base = "";
let session = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The background poll, started as the entry points start it, against the backend each case set up. */
function begin(): void {
  health.startBackendHealthPolling();
}

/** The route's answer once a reading has been taken (asks again until one has; bounds nothing). */
async function settled(): Promise<BackendHealthView> {
  begin();
  for (let tries = 0; tries < 500; tries += 1) {
    const res = await agent.get("/api/backend-health");
    expect(res.status).toBe(200);
    const view = res.body as BackendHealthView;
    if (view.readAt !== null && !view.reading) return view;
    await sleep(10);
  }
  throw new Error("no reading was taken");
}

beforeAll(async () => {
  stand = await healthStandIn();
  process.env.ATHENA_FAILSAFE_URL = stand.url;
  delete process.env.ATHENA_FAILSAFE_USER;
  delete process.env.ATHENA_FAILSAFE_PASSWORD;
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = "a-service-token-that-must-never-ride-on-a-health-read"; // pragma: allowlist secret
  app = await makeApp();
  agent = await signIn(app);
  health = await import("../server/backend-health");
  Object.assign(TIMING_DEFAULTS, health.backendHealthTiming);
  server = http.createServer(app);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await request(app).post("/api/auth/login").send({ username: "admin", password: (await import("./test-admin")).TEST_ADMIN_PASSWORD });
  session = (login.headers["set-cookie"] as unknown as string[]).map((one) => one.split(";")[0]).join("; ");
});

beforeEach(() => {
  health._resetBackendHealthForTests();
  // One read per case: the next is an hour away.
  Object.assign(health.backendHealthTiming, TIMING_DEFAULTS, { everyMs: 3_600_000 });
  process.env.ATHENA_FAILSAFE_URL = stand.url;
  stand.answer = json(OK_COUNTED);
  stand.seen.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  Object.assign(health.backendHealthTiming, TIMING_DEFAULTS);
  health._resetBackendHealthForTests();
  await stand.close();
  server.closeAllConnections?.();
  await new Promise<void>((done) => server.close(() => done()));
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("the route: GET /api/backend-health", () => {
  it("is behind sign-in", async () => {
    expect((await request(app).get("/api/backend-health")).status).toBe(401);
  });

  it("#226's degraded: degraded, with the counts by name and the workers", async () => {
    stand.answer = json(DEGRADED_226);
    const view = await settled();
    expect(view.state).toBe("degraded");
    expect(view.counts.map((one) => [one.label, one.value])).toEqual([["log records dropped", 5], ["worker reports not published", 2]]);
    expect(view.workers.map((one) => one.id)).toEqual(["a1b2c3d4", "e5f6a7b8"]);
    expect(view.unknownWorkers.map((one) => one.id)).toEqual(["9f2c"]);
    expect(view.httpStatus).toBe(200);
  });

  it("an explicit ok with every count zero: ok", async () => {
    expect((await settled()).state).toBe("ok");
  });

  it("a backend from before #217: its plain status, counts not reported", async () => {
    stand.answer = json(OK_217);
    const view = await settled();
    expect(view.state).toBe("uncounted");
    expect(view.countsReported).toBe(false);
  });

  it.each(ODD)("$name: $reads, never ok", async ({ status, body, reads }) => {
    stand.answer = { kind: "answer", status, body };
    const view = await settled();
    expect(view.state).toBe(reads);
    expect(view.state).not.toBe("ok");
  });

  it("a backend that never answers: unreachable once the deadline passes, and the route answered at once meanwhile", async () => {
    health.backendHealthTiming.deadlineMs = 200;
    stand.answer = { kind: "hang" };
    begin();
    const first = await agent.get("/api/backend-health");
    expect(first.status).toBe(200);
    expect(first.body.state).toBe("unknown");
    expect(first.body.reading).toBe(true);
    // The route answered while the backend held the read open.
    await stand.waitFor(() => stand.holding() === 1);
    expect((await agent.get("/api/backend-health")).body.state).toBe("unknown");
    const view = await settled();
    expect(view.state).toBe("unreachable");
    expect(view.reasons.join(" ")).toContain("did not answer within 200 ms");
    // The held read was given up: its connection closed.
    await stand.waitFor(() => stand.holding() === 0);
  });

  it("a backend whose connection is cut: unreachable", async () => {
    stand.answer = { kind: "destroy" };
    expect((await settled()).state).toBe("unreachable");
  });

  it("a backend that cannot be reached at all: unreachable", async () => {
    // Port 1 on the loopback: nothing listens there, so the connection is refused.
    process.env.ATHENA_FAILSAFE_URL = "http://127.0.0.1:1";
    const view = await settled();
    expect(view.state).toBe("unreachable");
    expect(view.reasons.join(" ")).toContain("could not be reached");
  });

  it("no backend configured: not configured, and nothing is read", async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    begin();
    const res = await agent.get("/api/backend-health");
    expect(res.body.state).toBe("not_configured");
    expect(stand.seen).toEqual([]);
  });

  it("the health read sends no credential: no Authorization, no service token, no cookie", async () => {
    await settled();
    const reads = stand.seen.filter((one) => one.path === "/api/health/");
    expect(reads.length).toBeGreaterThan(0);
    for (const one of reads) {
      expect(one.headers.authorization).toBeUndefined();
      expect(one.headers[SERVICE_TOKEN_HEADER.toLowerCase()]).toBeUndefined();
      expect(one.headers.cookie).toBeUndefined();
    }
    // Only the health check is read, nothing else.
    expect(stand.seen.every((one) => one.path === "/api/health/")).toBe(true);
  });

  it("backs off after a failure: the next read waits the back-off, doubling per failure in a row; after an answer, everyMs", async () => {
    health.backendHealthTiming.everyMs = 60_000;
    health.backendHealthTiming.maxBackoffMs = 300_000;
    stand.answer = json(OK_COUNTED, 500);
    await settled();
    await stand.waitFor(() => health.nextReadInMs() !== null);
    expect(stand.seen.length).toBe(1);
    expect(health.nextReadInMs()).toBe(120_000);
    for (let i = 0; i < 5; i += 1) await agent.get("/api/backend-health");
    // The route starts no read of its own.
    expect(stand.seen.length).toBe(1);
    expect(health.backoffMs(2)).toBe(240_000);
    expect(health.backoffMs(30)).toBe(300_000);
    expect(health.backoffMs(0)).toBe(60_000);
  });

  it("the route starts no read: with no poll running, it answers not read yet and the backend sees nothing", async () => {
    const res = await agent.get("/api/backend-health");
    expect(res.body.state).toBe("unknown");
    expect(res.body.readAt).toBeNull();
    expect(stand.seen).toEqual([]);
  });

  it("an ok or degraded reading older than the staleness bound is answered unknown, never ok", async () => {
    await settled();
    health.backendHealthTiming.staleAfterMs = 0;
    await sleep(5);
    const res = await agent.get("/api/backend-health");
    expect(res.body.state).toBe("unknown");
    expect(res.body.reasons[0]).toContain("is not shown as current");
  });
});

// ---- The strip, in the console, drawn from the real route ----

/** The page's fetch, sent to the real routes as the signed-in admin. */
function realRoutes(): void {
  const outbound = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/")) return outbound(url, init);
    return outbound(`${base}${url}`, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), Cookie: session } });
  });
}

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function strip(): Promise<HTMLElement> {
  const one = await screen.findByTestId("backend-health-strip");
  return one;
}

/** Waits until the strip shows a reading taken from the backend. */
async function shown(): Promise<HTMLElement> {
  await waitFor(async () => expect((await strip()).querySelector("[data-testid=backend-health-read-at]")).not.toBeNull(), { timeout: 5_000 });
  return strip();
}

describe("the strip in the console", () => {
  beforeEach(() => {
    Object.assign(STRIP_TIMING, { soonMs: 20 });
    realRoutes();
  });

  /** The strip, with the server's poll started once the case has set its backend up. */
  function renderStrip(): void {
    begin();
    render(<QueryClientProvider client={client()}><BackendHealthStrip /></QueryClientProvider>);
  }

  it("is in the console's shell, on every screen: a degraded backend shows degraded, its counts by name, and each worker", async () => {
    stand.answer = json(DEGRADED_226);
    begin();
    render(
      <QueryClientProvider client={client()}>
        <AppShell onLogout={() => {}} isAdmin username="admin"><div /></AppShell>
      </QueryClientProvider>,
    );
    const one = await shown();
    expect(one.getAttribute("data-state")).toBe("degraded");
    expect(within(one).getByTestId("backend-health-state").textContent).toBe("degraded");
    expect(within(one).getByTestId("backend-health-count-log_records_dropped").textContent).toBe("log records dropped: 5");
    expect(within(one).getByTestId("backend-health-count-worker_reports_unpublished").textContent).toBe("worker reports not published: 2");
    const workers = within(one).getByTestId("backend-health-workers");
    expect(within(workers).getByTestId("backend-health-worker-a1b2c3d4").textContent).toContain("(this worker)");
    expect(within(workers).getByTestId("backend-health-worker-a1b2c3d4").textContent).toContain("log records dropped: 5");
    expect(within(workers).getByTestId("backend-health-worker-e5f6a7b8").textContent).toContain("(exited)");
    expect(within(workers).getByTestId("backend-health-worker-e5f6a7b8").textContent).toContain("worker reports not published: 2");
    expect(within(one).getByTestId("backend-health-unknown-worker-9f2c").textContent).toContain("not rewritten within 60 s");
  });

  it("#217's degraded: degraded with stderr lines lost and unrecorded dispatches refused by name", async () => {
    stand.answer = json(DEGRADED_217);
    renderStrip();
    const one = await shown();
    expect(one.getAttribute("data-state")).toBe("degraded");
    expect(within(one).getByTestId("backend-health-count-stderr_lines_lost").textContent).toBe("stderr lines lost: 3");
    expect(within(one).getByTestId("backend-health-count-unrecorded_dispatches_refused").textContent).toBe("unrecorded dispatches refused: 1");
  });

  it("an explicit ok with every count zero shows ok", async () => {
    renderStrip();
    const one = await shown();
    expect(one.getAttribute("data-state")).toBe("ok");
    expect(within(one).getByTestId("backend-health-state").textContent).toBe("ok");
  });

  it("a backend from before #217 shows its plain status, labelled counts not reported by this backend, and no count as zero", async () => {
    stand.answer = json(OK_217);
    renderStrip();
    const one = await shown();
    expect(one.getAttribute("data-state")).toBe("uncounted");
    expect(within(one).getByTestId("backend-health-state").textContent).not.toBe("ok");
    expect(one.textContent).toContain("counts not reported by this backend");
    expect(within(one).queryByTestId("backend-health-count")).toBeNull();
    expect(one.textContent).not.toMatch(/:\s*0\b/);
  });

  it.each(ODD)("$name: the strip shows $reads, never ok", async ({ status, body, reads }) => {
    stand.answer = { kind: "answer", status, body };
    renderStrip();
    const one = await shown();
    expect(one.getAttribute("data-state")).toBe(reads);
    expect(within(one).getByTestId("backend-health-state").textContent).toBe(reads);
    expect(within(one).getAllByTestId("backend-health-reason").length).toBeGreaterThan(0);
  });

  it("a backend that never answers shows unreachable, never ok", async () => {
    health.backendHealthTiming.deadlineMs = 100;
    stand.answer = { kind: "hang" };
    renderStrip();
    const one = await shown();
    expect(one.getAttribute("data-state")).toBe("unreachable");
    expect(one.textContent).toContain("did not answer within 100 ms");
  });

  it("a field this console does not know is shown as it came; acknowledgement is read only, with no button", async () => {
    stand.answer = json({
      ...DEGRADED_226,
      host_clock_skew_s: 4,
      workers: { "e5f6a7b8": { state: "exited", worker_reports_unpublished: 2, acknowledged_by: "ops-1", acknowledged_at: "2026-11-09T10:00:00+00:00" } },
    });
    renderStrip();
    const one = await shown();
    expect(within(one).getByTestId("backend-health-unrecognized").textContent).toContain("host_clock_skew_s = 4");
    const ack = within(one).getByTestId("backend-health-worker-e5f6a7b8-acknowledgement");
    expect(ack.textContent).toContain("acknowledged_by = \"ops-1\"");
    expect(ack.textContent).toContain("acknowledged_at = \"2026-11-09T10:00:00+00:00\"");
    expect(one.querySelector("button")).toBeNull();
  });

  it("this server's route failing after an ok shows unreachable, never the ok before it", async () => {
    let fail = false;
    const outbound = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (fail && url === "/api/backend-health") return new Response("Internal", { status: 500 });
      return outbound(url, init);
    });
    Object.assign(STRIP_TIMING, { everyMs: 30 });
    try {
      renderStrip();
      expect((await shown()).getAttribute("data-state")).toBe("ok");
      fail = true;
      await waitFor(async () => expect((await strip()).getAttribute("data-state")).toBe("unreachable"), { timeout: 5_000 });
      expect((await strip()).textContent).toContain("this server answered HTTP 500");
      expect(within(await strip()).getByTestId("backend-health-state").textContent).toBe("unreachable");
    } finally {
      Object.assign(STRIP_TIMING, { everyMs: 15_000 });
    }
  });

  it("an answer from this server of the wrong shape reads unknown, never ok", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ state: "ok", counts: [{ name: "stderr_lines_lost", value: 2 }] }), { status: 200 }));
    renderStrip();
    await waitFor(async () => expect((await strip()).querySelector("[data-testid=backend-health-problem]")).not.toBeNull());
    expect((await strip()).getAttribute("data-state")).toBe("unknown");
  });
});
