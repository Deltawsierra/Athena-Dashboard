import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import type { Test } from "@shared/schema";
import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";

/**
 * A hybrid scan's row has three writers of `findings` that run beside each
 * other once its run is stopped from here, and none of them may drop a field
 * another wrote:
 *
 *   - the Stop's mirror (server/routes.ts mirrorStopToBackend), after the
 *     stop's answer went out, writes `findings.backendMirror`;
 *   - the collect watch (fileRecordIntoRow) writes `findings.backend` -- the
 *     backend's record -- with the record's results and coverage;
 *   - the status route's live poll writes the run's status and the engine's
 *     `results` and `coverage`, and clears its own marks.
 *
 * Each used to write the WHOLE `findings` object from a read of the row taken
 * before an await, so the last one to land wrote back the row as it was
 * before the other's write, and that field was gone. The first status read
 * after a stop could then answer a collected record with no
 * `findings.backend` on its row (tests/a-finished-hybrid-scan-is-collected-
 * into-its-backend-record.test.ts "stopped from here", seen once in a full
 * run).
 *
 * Here the order is forced, not hoped for: every write of the row, by
 * whatever storage call makes it, is recognised by what it writes and held
 * until the other writer's field has landed. Whatever a writer read before,
 * its write lands after the other's, and both fields must stand.
 *
 * Nothing here is on a stop's path: the Stop is answered before the mirror
 * runs, and these cases check it is answered while the mirror is held.
 */

const TOKEN = "e".repeat(64);

type Run = { state: string; result: Record<string, unknown> | null; reason: string | null };

/** An engine whose runs stay running until aborted by the test. */
function stubEngine() {
  const calls: string[] = [];
  const runs = new Map<string, Run>();
  let next = 0;
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      calls.push(`${req.method} ${url}`);
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") {
        const active = Array.from(runs).filter(([, run]) => run.state === "running").map(([run_id]) => ({ run_id, target: "", kind: "scan", state: "running" }));
        return json(res, 200, { active });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        const run = runs.get(abort[1]);
        if (!run) return json(res, 404, { detail: "No such scan run" });
        if (run.state === "running") Object.assign(run, { state: "aborted", reason: "aborted by operator", result: { results: [], detail: "aborted by operator" } });
        return json(res, 200, { run_id: abort[1], state: "aborting" });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = decodeURIComponent(url.slice("/api/scans/".length));
        const run = runs.get(id);
        if (!run) return json(res, 404, { detail: "No such scan run" });
        return json(res, 200, { run_id: id, state: run.state, done: run.state !== "running", result: run.result ?? {}, ...(run.reason ? { reason: run.reason } : {}) });
      }
      if (req.method === "POST" && url === "/api/scan") {
        next += 1;
        const id = `run-${next}`;
        runs.set(id, { state: "running", result: null, reason: null });
        return json(res, 202, { run_id: id, state: "running" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  return { server, calls, runs, aborts: () => calls.filter((one) => one.endsWith("/abort")) };
}

let engine: ReturnType<typeof stubEngine>;
let hybrid: HybridBackendStandIn;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let storage: typeof import("../server/storage-unified").storage;
let clientCount = 0;

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  const engineUrl = `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_URL = engineUrl;
  process.env.ATHENA_ENGINE_KEY = "dashboard-key";
  hybrid = await hybridBackendStandIn({ engine: { url: engineUrl, key: "backend-key" }, serviceToken: TOKEN });
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = TOKEN;
  vi.resetModules();
  app = await makeApp();
  // The backend is asked often, so a case waits little; nothing else is shortened.
  (await import("../server/collect-watch")).collectWatch.intervalMs = 25;
  admin = await signIn(app);
  await signInToBackend(admin);
  storage = (await import("../server/storage-unified")).storage;
});

afterEach(() => {
  vi.restoreAllMocks();
  gates.clear();
  held.clear();
  landed.length = 0;
  after.length = 0;
  failNext.clear();
  refused.length = 0;
  watched = "";
  hybrid.releaseCollects();
  hybrid.releaseStops();
});

afterAll(async () => {
  for (const name of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_SERVICE_TOKEN"]) delete process.env[name];
  (app.locals.collectWatcher as { halt(): void }).halt();
  await hybrid.close();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
});

/** A scan started through the backend, running on the stub. */
async function aRunningScan() {
  clientCount += 1;
  const client = await admin.post("/api/clients").send({ name: `Client ${clientCount}`, company: `Company ${clientCount}`, email: `c${clientCount}@x.test` });
  await admin.post("/api/sites").send({ clientId: client.body.id, name: "acme.example", url: "https://acme.example" });
  const started = await admin.post("/api/scans").send({ clientId: client.body.id, target: "https://acme.example/login", consent: true });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return { testId: started.body.test.id as string, runId: started.body.runId as string, scanId: started.body.test.findings.backendScanId as string };
}

const read = async (testId: string) => (await admin.get(`/api/scans/${testId}`)).body;
const findingsOf = (row: Test | undefined) => ((row?.findings ?? {}) as Record<string, unknown>);
const hasRecord = (row: Test | undefined) => typeof (findingsOf(row).backend as { status?: unknown } | undefined)?.status === "string";
const hasMirror = (row: Test | undefined) => typeof (findingsOf(row).backendMirror as { mirrored?: unknown } | undefined)?.mirrored === "boolean";

async function until(ok: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

// ---- The gate: every write of the watched row, recognised by what it writes ----

type Writer = "mirror" | "file" | "poll";
/** A writer's write is held until this holds of the row. */
const gates = new Map<Writer, (row: Test | undefined) => boolean>();
/** The writers whose write is being held now. */
const held = new Set<Writer>();
/** The writers whose write has landed, in the order they landed. */
const landed: Writer[] = [];
/** The row as each landed write left it. */
const after: Array<{ writer: Writer; row: Test | undefined }> = [];
/** Writers whose next write is refused, as a full disk would refuse it; and those refused so far. */
const failNext = new Set<Writer>();
const refused: Writer[] = [];
let watched = "";

/**
 * Which writer a write of `row` is, by what it writes: the mirror writes
 * findings alone and adds `backendMirror`; the collect watch adds the record
 * (`backend`); the poll writes the run's status with the engine's results.
 */
function writerOf(row: Test, patch: unknown): Writer | null {
  if (!patch || typeof patch !== "object") return null;
  const change = patch as Record<string, unknown>;
  const findings = change.findings as Record<string, unknown> | undefined;
  if (!findings || typeof findings !== "object") return null;
  if (Object.keys(change).join() === "findings" && findings.backendMirror !== undefined && !hasMirror(row)) return "mirror";
  if (typeof (findings.backend as { status?: unknown } | undefined)?.status === "string" && !hasRecord(row)) return "file";
  if ("status" in change && "results" in findings) return "poll";
  return null;
}

/**
 * Hold the watched row's writes by the gates. Every storage call that writes a
 * test row (`updateTest...`) is gated, whether it is handed the change itself
 * or a function of the row as it is when it lands -- which is then asked,
 * on a copy, what it would write.
 */
function gateRowWrites(testId: string): void {
  watched = testId;
  const target = storage as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const names = Object.getOwnPropertyNames(Object.getPrototypeOf(storage)).filter((name) => /^updateTest/.test(name));
  expect(names).toContain("updateTest");
  for (const name of names) {
    const real = target[name].bind(storage);
    vi.spyOn(target, name).mockImplementation(async (id: unknown, arg: unknown) => {
      const row = storage.peekTest(String(id));
      const writer = id === watched && row
        ? writerOf(row, typeof arg === "function" ? (arg as (one: Test) => unknown)(structuredClone(row)) : arg)
        : null;
      const gate = writer ? gates.get(writer) : undefined;
      if (writer && gate) {
        held.add(writer);
        await until(() => gate(storage.peekTest(String(id))));
        held.delete(writer);
      }
      if (writer && failNext.delete(writer)) {
        refused.push(writer);
        throw new Error("SQLITE_FULL: database or disk is full");
      }
      const out = await real(id, arg);
      if (writer) {
        landed.push(writer);
        after.push({ writer, row: storage.peekTest(String(id)) });
      }
      return out;
    });
  }
}

describe("two writes to a stopped scan's row never drop each other's findings", () => {
  it("the Stop's mirror lands after the collect watch filed the record: the record stays, and the first status read after carries findings.backend", async () => {
    const { testId, runId } = await aRunningScan();
    hybrid.holdCollects();
    gateRowWrites(testId);
    // The mirror's write waits for the record to be on the row.
    gates.set("mirror", hasRecord);

    const stopped = await admin.post(`/api/scans/${testId}/abort`);
    expect(stopped.status).toBe(200);
    expect(engine.aborts()).toContain(`POST /api/scans/${runId}/abort`);
    expect(await until(() => held.has("mirror")), "the mirror's write was not made").toBe(true);

    // The run's end is read; the watch starts and its collect is held.
    expect((await read(testId)).state).toBe("aborted");
    // The record is collected and filed while the mirror's write is held.
    hybrid.releaseCollects();
    expect(await until(() => landed.includes("mirror")), "the mirror's write did not land").toBe(true);
    expect(landed.filter((one) => one !== "poll"), "the order was not forced").toEqual(["file", "mirror"]);

    const row = await storage.getTest(testId);
    expect(findingsOf(row).backend, "the mirror's write dropped the record").toMatchObject({ status: "stopped" });
    expect(findingsOf(row).backendMirror).toMatchObject({ mirrored: true });

    const after = await read(testId);
    expect(after.backend).toMatchObject({ collected: true, status: "stopped" });
    expect(after.backend.mirror).toMatchObject({ mirrored: true });
    expect(after.test.findings.backend).toMatchObject({ status: "stopped", verdict: null });
  });

  it("the collect watch's filing lands after the Stop's mirror wrote: the mirror's reading stays beside the record", async () => {
    const { testId, runId, scanId } = await aRunningScan();
    hybrid.holdStops();
    gateRowWrites(testId);
    // The watch's filing waits for the mirror's reading to be on the row.
    gates.set("file", hasMirror);

    // Answered while the mirror is held at the backend: no write stands before a Stop.
    let answered = false;
    const stopping = admin.post(`/api/scans/${testId}/abort`).then((res) => { answered = true; return res; });
    await hybrid.waitFor((one) => one.method === "POST" && one.path === `/api/pentest/scans/${scanId}/stop/`);
    await new Promise((r) => setTimeout(r, 50));
    expect(answered, "the Stop waited on its mirror").toBe(true);
    const stopped = await stopping;
    expect(stopped.status).toBe(200);
    expect(engine.aborts()).toContain(`POST /api/scans/${runId}/abort`);

    expect((await read(testId)).state).toBe("aborted");
    expect(await until(() => held.has("file")), "the watch's filing was not made").toBe(true);
    // The mirror is answered, and its reading lands while the filing is held.
    hybrid.releaseStops();
    expect(await until(() => landed.includes("file")), "the watch's filing did not land").toBe(true);
    expect(landed.filter((one) => one !== "poll"), "the order was not forced").toEqual(["mirror", "file"]);

    const row = await storage.getTest(testId);
    expect(findingsOf(row).backendMirror, "the filing dropped the mirror's reading").toMatchObject({ mirrored: true });
    expect(findingsOf(row).backend).toMatchObject({ status: "stopped" });

    const after = await read(testId);
    expect(after.backend).toMatchObject({ collected: true, status: "stopped" });
    expect(after.backend.mirror).toMatchObject({ mirrored: true });
    expect(after.test.findings.backend).toMatchObject({ status: "stopped" });
  });

  it("the live poll's write lands after the collect watch filed the record: the record stays, and that very read answers with it", async () => {
    const { testId } = await aRunningScan();
    hybrid.holdCollects();
    const stopped = await admin.post(`/api/scans/${testId}/abort`);
    expect(stopped.status).toBe(200);
    expect(await until(() => hasMirror(storage.peekTest(testId))), "the mirror's reading did not land").toBe(true);

    // The first read sees the end and starts the watch; its collect is held.
    expect((await read(testId)).state).toBe("aborted");
    gateRowWrites(testId);
    // The next read's poll waits for the record to be on the row.
    gates.set("poll", hasRecord);
    const next = read(testId);
    expect(await until(() => held.has("poll")), "the poll's write was not made").toBe(true);
    hybrid.releaseCollects();
    const answered = await next;
    expect(landed.slice(0, 2), "the order was not forced").toEqual(["file", "poll"]);

    expect(answered.state).toBe("aborted");
    expect(answered.backend).toMatchObject({ collected: true, status: "stopped" });
    expect(answered.test.findings.backend, "the poll's write dropped the record").toMatchObject({ status: "stopped" });
    expect(answered.test.findings.backendMirror).toMatchObject({ mirrored: true });
    // The poll wrote nothing over the record: the row is as the filing left it.
    const filed = after.find((one) => one.writer === "file")!.row;
    const row = await storage.getTest(testId);
    expect(row?.status).toBe(filed?.status);
    expect(row?.completedAt).toEqual(filed?.completedAt);
    expect(row?.findings).toEqual(filed?.findings);
    expect(findingsOf(row).backend).toMatchObject({ status: "stopped" });
    expect(findingsOf(row).backendMirror).toMatchObject({ mirrored: true });
  });

  it("the collect watch's own filing did not land: the status read that files it answers with the record on its row", async () => {
    const { testId } = await aRunningScan();
    gateRowWrites(testId);
    // The watch's write of the record is refused once; the record stays on the watch.
    failNext.add("file");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const stopped = await admin.post(`/api/scans/${testId}/abort`);
    expect(stopped.status).toBe(200);
    expect((await read(testId)).state).toBe("aborted");
    expect(await until(() => refused.includes("file")), "the watch's filing was not made").toBe(true);
    await vi.waitFor(() => expect(errors.mock.calls.some(([line]) => String(line).includes("could not be filed into test"))).toBe(true));
    expect(hasRecord(storage.peekTest(testId)), "the refused filing landed").toBe(false);

    // This read finds the watch collected and no record on the row, files it, and answers with it.
    const answered = await read(testId);
    expect(landed.filter((one) => one === "file"), "the read did not file the record").toEqual(["file"]);
    expect(answered.backend).toMatchObject({ collected: true, status: "stopped" });
    expect(answered.state).toBe("aborted");
    expect(answered.test.findings.backend, "the read answered with the row it took before its own filing").toMatchObject({ status: "stopped", verdict: null });
    expect(findingsOf(await storage.getTest(testId)).backend).toMatchObject({ status: "stopped" });
  });
});
