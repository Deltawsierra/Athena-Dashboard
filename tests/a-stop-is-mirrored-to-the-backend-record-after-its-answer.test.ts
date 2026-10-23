import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import request from "supertest";

import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";

/**
 * A Stop this dashboard sends the engine is MIRRORED into Athena-Backend's
 * record of the scan (`POST /api/pentest/scans/<uuid>/stop/`) -- after the
 * stop's answer, never on its path (owner decision 6):
 *
 *   - the scan's own Stop (POST /api/scans/:testId/abort) is sent to the engine
 *     and answered BEFORE anything reaches the backend: with the backend
 *     holding every stop unanswered, the Stop still answers at once;
 *   - the mirror presents the failsafe service token (`stop: true`, judged a
 *     stop by the backend) and waits on no sign-in; only when that attempt
 *     fails is it sent once more as the person;
 *   - what it came to is written on the row (`findings.backendMirror`), read
 *     in the status answer (`backend.mirror`) and logged (`abort_mirrored` /
 *     `abort_mirror_failed`); a mirror the backend refused twice changes
 *     nothing about the Stop's answer and is shown as not mirrored;
 *   - the kill switch and a delete mirror each stopped hybrid scan the same
 *     way, after their own answers; a scan this dashboard dispatched itself
 *     (no backend record) is never mirrored; a run the engine said had
 *     already ended is not either (nothing was stopped).
 *
 * The stops themselves are unchanged, and their own tests are the gate
 * (tests/only-engaging-the-kill-switch-sends-stops.test.ts,
 * tests/deleting-a-running-scan-stops-it-first.test.ts, and the rest).
 */

const TOKEN = "a1".repeat(32);

/** An engine whose runs stay running until aborted; `abortAnswer` is what its abort route answers. */
function stubEngine() {
  const calls: Array<{ method: string; url: string }> = [];
  const runs = new Map<string, { state: string }>();
  const control = { abortAnswer: null as null | { status: number; body: unknown }, tenantBound: false };
  let next = 0;
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = req.url ?? "";
      calls.push({ method: req.method ?? "GET", url });
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") {
        return json(res, 200, { active: Array.from(runs).filter(([, run]) => run.state === "running").map(([run_id]) => ({ run_id, target: "", kind: "scan", state: "running" })) });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        if (control.abortAnswer) return json(res, control.abortAnswer.status, control.abortAnswer.body);
        const run = runs.get(abort[1]);
        // The engine scopes a run to the key that started it: the dashboard's key sees neither the run nor its abort.
        if (!run || (control.tenantBound && req.headers["x-api-key"] === "dashboard-key")) return json(res, 404, { detail: "No such scan run" });
        // Both engines answer a run that has ended 2xx `{state, detail: "not running"}` (server/engine.ts abortRun).
        if (run.state !== "running") return json(res, 200, { run_id: abort[1], state: run.state, detail: "not running" });
        run.state = "aborted";
        return json(res, 200, { run_id: abort[1], state: "aborting" });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = decodeURIComponent(url.slice("/api/scans/".length));
        const run = runs.get(id);
        if (!run || (control.tenantBound && req.headers["x-api-key"] === "dashboard-key")) return json(res, 404, { detail: "No such scan run" });
        return json(res, 200, { run_id: id, state: run.state, done: run.state !== "running", result: run.state === "running" ? null : { results: [] } });
      }
      if (req.method === "POST" && url === "/api/scan") {
        next += 1;
        const id = `run-${next}`;
        runs.set(id, { state: "running" });
        return json(res, 202, { run_id: id, state: "running" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  return {
    server, calls, runs, control,
    aborts: () => calls.filter((one) => one.url.endsWith("/abort")),
  };
}

let engine: ReturnType<typeof stubEngine>;
let hybrid: HybridBackendStandIn;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let storage: typeof import("../server/storage-unified").storage;
let clientCount = 0;

const KILL = { killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] };
const REACTIVATE = { killSwitchEnabled: false, systemStatus: "active", activeSystems: ["penetration-testing", "vulnerability-scanner"] };

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
  (await import("../server/collect-watch")).collectWatch.intervalMs = 25;
  admin = await signIn(app);
  await signInToBackend(admin);
  storage = (await import("../server/storage-unified")).storage;
});

afterEach(async () => {
  hybrid.releaseStops();
  hybrid.controls.stopAnswers.length = 0;
  hybrid.seen.length = 0;
  engine.calls.length = 0;
  engine.control.abortAnswer = null;
  engine.control.tenantBound = false;
});

afterAll(async () => {
  for (const name of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_SERVICE_TOKEN"]) delete process.env[name];
  (app.locals.collectWatcher as { halt(): void }).halt();
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
  await hybrid.close();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
});

async function aClient() {
  clientCount += 1;
  const client = await admin.post("/api/clients").send({ name: `Client ${clientCount}`, company: `Company ${clientCount}`, email: `c${clientCount}@x.test` });
  await admin.post("/api/sites").send({ clientId: client.body.id, name: "acme", url: "https://acme.example" });
  return client.body.id as string;
}

/** A scan started through the backend, running on the stub. */
async function aRunningScan(clientId?: string) {
  const client = clientId ?? await aClient();
  const started = await admin.post("/api/scans").send({ clientId: client, target: "https://acme.example/login", consent: true });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return { clientId: client, testId: started.body.test.id as string, runId: started.body.runId as string, scanId: started.body.test.findings.backendScanId as string };
}

/** `read()` once `ok` holds, asked up to `tries` times, a short pause apart. */
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, tries = 200): Promise<T> {
  let last = await read();
  for (let i = 0; i < tries && !ok(last); i++) {
    await new Promise((r) => setTimeout(r, 20));
    last = await read();
  }
  return last;
}

const mirrorsOf = (scanId: string) => hybrid.stops().filter((one) => one.path === `/api/pentest/scans/${scanId}/stop/`);
const mirrorReading = async (testId: string) => ((await storage.getTest(testId))?.findings as { backendMirror?: unknown } | undefined)?.backendMirror as
  { at: string; mirrored: boolean; via: string | null; detail: string } | undefined;
const mirrorLogs = async (scanId: string) =>
  (await admin.get("/api/logs")).body.filter((one: { action: string; details: { backendScanId?: string } }) =>
    (one.action === "abort_mirrored" || one.action === "abort_mirror_failed") && one.details.backendScanId === scanId);

describe("the scan's own Stop", () => {
  it("is sent to the engine and answered before anything reaches the backend; the mirror follows, with the stop credential", async () => {
    const { testId, runId, scanId } = await aRunningScan();
    hybrid.seen.length = 0;
    // The backend answers no stop: the Stop's answer cannot be waiting on it.
    hybrid.holdStops();
    const stopped = await admin.post(`/api/scans/${testId}/abort`);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ stopped: true, runId });
    expect(engine.aborts().map((one) => one.url)).toEqual([`/api/scans/${runId}/abort`]);
    expect(await mirrorReading(testId), "nothing is recorded as mirrored while the backend has not answered").toBeUndefined();

    // The mirror arrives at the backend after the answer, as a stop: the service token, judged a stop, no person's sign-in.
    const mirror = await hybrid.waitFor((one) => one.method === "POST" && one.path === `/api/pentest/scans/${scanId}/stop/`);
    expect(mirror).toMatchObject({ stop: true, by: "service token", status: 0 });
    expect(mirror.json).toEqual({ reason: "the scan's own Stop on the Athena dashboard: the engine accepted the stop" });
    hybrid.releaseStops();

    const reading = await until(() => mirrorReading(testId), (one) => one !== undefined);
    expect(reading).toMatchObject({ mirrored: true, via: "stop credential", detail: "" });
    expect(Date.parse(reading!.at)).not.toBeNaN();
    expect(mirrorsOf(scanId)).toHaveLength(1);
    expect(hybrid.scans.get(scanId)!.stop_requested_at).not.toBeNull();
    const logs = await mirrorLogs(scanId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: "abort_mirrored", entityType: "test", entityId: testId, details: { via: "stop", credential: "stop credential", mirrored: true } });

    // Read on the status answer: the live poll keeps the reading, and the record, once collected, says the run was stopped.
    const read = await until(() => admin.get(`/api/scans/${testId}`).then((res) => res.body), (body) => body.backend?.collected === true);
    expect(read.backend.mirror).toMatchObject({ mirrored: true, via: "stop credential" });
    expect(read.backend).toMatchObject({ status: "stopped", verdict: null });
    expect(read.test.findings.backendMirror).toMatchObject({ mirrored: true });
  });

  it("falls back to the person's credential only after the stop credential was refused", async () => {
    const { testId, scanId } = await aRunningScan();
    hybrid.seen.length = 0;
    hybrid.controls.stopAnswers.push({ status: 503, body: { detail: "the record store is unavailable" } });
    const stopped = await admin.post(`/api/scans/${testId}/abort`);
    expect(stopped.status).toBe(200);
    const reading = await until(() => mirrorReading(testId), (one) => one !== undefined);
    expect(reading).toMatchObject({ mirrored: true, via: "person" });
    expect(reading!.detail).toContain("answered 503 to the stop mirror");
    expect(reading!.detail).toContain("it was then taken as the person");
    expect(mirrorsOf(scanId).map((one) => [one.by, one.stop, one.status])).toEqual([["service token", true, 503], ["bearer", true, 200]]);
    expect((await mirrorLogs(scanId))[0]).toMatchObject({ action: "abort_mirrored", details: { credential: "person" } });
  });

  it("a mirror the backend refused twice changes nothing about the Stop's answer, and is shown as not mirrored", async () => {
    const { testId, runId, scanId } = await aRunningScan();
    hybrid.seen.length = 0;
    hybrid.controls.stopAnswers.push({ status: 503, body: { detail: "down" } }, { status: 503, body: { detail: "still down" } });
    const stopped = await admin.post(`/api/scans/${testId}/abort`);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ stopped: true, runId });
    const reading = await until(() => mirrorReading(testId), (one) => one !== undefined);
    expect(reading).toMatchObject({ mirrored: false, via: null });
    expect(reading!.detail).toContain("503");
    expect(mirrorsOf(scanId)).toHaveLength(2);
    expect((await mirrorLogs(scanId))[0]).toMatchObject({ action: "abort_mirror_failed", details: { mirrored: false, credential: null } });
    const read = await admin.get(`/api/scans/${testId}`);
    expect(read.body.backend.mirror).toMatchObject({ mirrored: false });
  });

  it("a stop the engine refused is mirrored all the same -- the backend's own stop may reach the run -- and says so", async () => {
    const { testId, scanId } = await aRunningScan();
    hybrid.seen.length = 0;
    engine.control.abortAnswer = { status: 500, body: { detail: "abort registry locked" } };
    const stopped = await admin.post(`/api/scans/${testId}/abort`);
    expect(stopped.status).toBe(502);
    const mirror = await hybrid.waitFor((one) => one.method === "POST" && one.path === `/api/pentest/scans/${scanId}/stop/`);
    expect(mirror.json).toMatchObject({ reason: expect.stringContaining("the engine did not accept the stop") });
    await until(() => mirrorReading(testId), (one) => one !== undefined);
    engine.control.abortAnswer = null;
    expect((await admin.post(`/api/scans/${testId}/abort`)).status).toBe(200);
  });

  it("a run this dashboard's engine key cannot read (marked stop: backend): the engine's 404 to its stop is no end, and the stop is mirrored", async () => {
    engine.control.tenantBound = true;
    const { testId, scanId } = await aRunningScan();
    expect((await storage.getTest(testId))!.findings).toMatchObject({ stop: "backend" });
    hybrid.seen.length = 0;
    const stopped = await admin.post(`/api/scans/${testId}/abort`);
    expect(stopped.status).toBe(502);
    const mirror = await hybrid.waitFor((one) => one.method === "POST" && one.path === `/api/pentest/scans/${scanId}/stop/`);
    expect(mirror).toMatchObject({ stop: true, by: "service token" });
    expect(mirror.json).toMatchObject({ reason: expect.stringContaining("the engine did not accept the stop") });
    await until(() => mirrorReading(testId), (one) => one !== undefined);
    expect((await mirrorLogs(scanId))[0]).toMatchObject({ action: "abort_mirrored", details: { via: "stop" } });
    engine.control.tenantBound = false;
    expect((await admin.post(`/api/scans/${testId}/abort`)).status).toBe(200);
  });

  it("a run the engine said had already ended is not mirrored: nothing was stopped", async () => {
    const { testId, runId, scanId } = await aRunningScan();
    engine.runs.get(runId)!.state = "aborted";
    hybrid.seen.length = 0;
    const stopped = await admin.post(`/api/scans/${testId}/abort`);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ stopped: false, alreadyFinished: true });
    await new Promise((r) => setTimeout(r, 150));
    expect(mirrorsOf(scanId)).toEqual([]);
    expect(await mirrorReading(testId)).toBeUndefined();
  });

  it("a scan this dashboard dispatched itself has no backend record, and nothing is sent for it", async () => {
    const clientId = await aClient();
    engine.runs.set("legacy-9", { state: "running" });
    const legacy = await storage.createTest({
      clientId, name: "Legacy scan", testType: "vulnerability-scan", status: "running",
      findings: { runId: "legacy-9", target: "https://acme.example/", results: [] },
    } as any);
    hybrid.seen.length = 0;
    const stopped = await admin.post(`/api/scans/${legacy.id}/abort`);
    expect(stopped.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect(hybrid.seen).toEqual([]);
  });
});

describe("the kill switch", () => {
  it("mirrors every stopped hybrid scan after its own answer, with the stop credential", async () => {
    const first = await aRunningScan();
    const second = await aRunningScan(first.clientId);
    hybrid.seen.length = 0;
    hybrid.holdStops();
    try {
      const pressed = await admin.patch("/api/ai-control").send(KILL);
      expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
      const stops = pressed.body.stops.scans as Array<{ testId: string; stopped: boolean }>;
      expect(stops.filter((one) => [first.testId, second.testId].includes(one.testId)).map((one) => one.stopped)).toEqual([true, true]);
      const ours = [`/api/scans/${first.runId}/abort`, `/api/scans/${second.runId}/abort`];
      expect(engine.aborts().map((one) => one.url).filter((url) => ours.includes(url)).sort()).toEqual(ours.sort());
      // Answered with the backend holding every stop: the mirrors were not waited on.
      expect(await mirrorReading(first.testId)).toBeUndefined();
      await hybrid.waitFor((one) => one.path === `/api/pentest/scans/${first.scanId}/stop/`);
      await hybrid.waitFor((one) => one.path === `/api/pentest/scans/${second.scanId}/stop/`);
      hybrid.releaseStops();
      for (const scan of [first, second]) {
        const reading = await until(() => mirrorReading(scan.testId), (one) => one !== undefined);
        expect(reading).toMatchObject({ mirrored: true, via: "stop credential" });
        expect(mirrorsOf(scan.scanId)).toHaveLength(1);
        expect(mirrorsOf(scan.scanId)[0]).toMatchObject({ stop: true, by: "service token", json: { reason: "the Athena dashboard's kill switch: the engine accepted the stop" } });
        expect((await mirrorLogs(scan.scanId))[0]).toMatchObject({ action: "abort_mirrored", details: { via: "kill_switch" } });
      }
    } finally {
      hybrid.releaseStops();
      expect((await admin.patch("/api/ai-control").send(REACTIVATE)).status).toBe(200);
    }
  });
});

describe("deleting a running scan", () => {
  it("stops it first, answers, and then mirrors the stop -- the row is gone, the log and the backend's record remain", async () => {
    const { testId, runId, scanId } = await aRunningScan();
    hybrid.seen.length = 0;
    hybrid.holdStops();
    const deleted = await admin.delete(`/api/tests/${testId}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.stops).toMatchObject([{ testId, runId, stopped: true }]);
    expect(await storage.getTest(testId)).toBeUndefined();
    const mirror = await hybrid.waitFor((one) => one.method === "POST" && one.path === `/api/pentest/scans/${scanId}/stop/`);
    expect(mirror).toMatchObject({ stop: true, by: "service token" });
    expect(mirror.json).toEqual({ reason: "the scan's deletion on the Athena dashboard, which stops its run first: the engine accepted the stop" });
    hybrid.releaseStops();
    const logs = await until(() => mirrorLogs(scanId), (list) => list.length > 0);
    expect(logs[0]).toMatchObject({ action: "abort_mirrored", entityId: testId, details: { via: "delete", mirrored: true } });
    expect(hybrid.scans.get(scanId)!.stop_requested_at).not.toBeNull();
  });

  it("deleting the client stops and mirrors each of its running scans the same way", async () => {
    const { clientId, testId, scanId } = await aRunningScan();
    hybrid.seen.length = 0;
    const deleted = await admin.delete(`/api/clients/${clientId}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.stops).toMatchObject([{ testId, stopped: true }]);
    const logs = await until(() => mirrorLogs(scanId), (list) => list.length > 0);
    expect(logs[0]).toMatchObject({ action: "abort_mirrored", details: { via: "delete" } });
    expect(mirrorsOf(scanId)[0]).toMatchObject({ stop: true, by: "service token" });
  });
});
