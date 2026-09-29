import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import type { IStorage } from "../server/storage";
import { makeApp, signIn } from "./helpers";

/**
 * athena-engine #71 (head f4610ae) changes what every launch answers. This
 * dashboard calls two of the launching routes -- `POST /api/scan` and
 * `POST /api/remediation/retest` -- and reads them by one explicit field,
 * `answer`, never by guessing from a shape:
 *
 *   - a 202 is never "done", whatever `state` it names. The engine reads the
 *     state after it hands the run to its pool, so a run that ended in between
 *     is answered 202 `state: "completed"` with no result in it (on engine main
 *     as well: `scan-finished-before-the-answer` is recorded at both commits).
 *     A scan read that way was recorded completed with no findings, and the
 *     status route never read it again;
 *   - `run_id` is the id a Stop names; a retest's record is `scan_record_id`;
 *   - a 500 `answer: "status"` that names a run whose work started
 *     (`state: null`) is a run that may be scanning: it is recorded running,
 *     with its Stop, and collected from `/api/scans/{run_id}`. One whose work
 *     never started (`state: "failed"`) records nothing;
 *   - a retest stopped while its check was being filed is answered with that
 *     verdict and `state: "aborted"`; its status read carries the verdict and
 *     the check it filed. That verdict is filed here too;
 *   - a scan answer whose `answer` is not one either engine sends is not read:
 *     nothing is recorded from it, and the run it names is stopped.
 *
 * Every engine answer is one the real engine app sent: tests/fixtures/
 * engine-retest/generate.py drove athena-engine at f4610ae and at 5779e99
 * (main) in process, through FastAPI's TestClient, with the mythos-core
 * installed locally ("unpinned local core": see each file's `mythos_core`).
 * The one exception is marked "derived": a recorded answer with one field
 * changed, for the shape no engine sends.
 */

type Exchange = {
  note: string;
  request: { method: string; path: string; body?: Record<string, unknown> };
  status: number;
  body: any;
  /** A header sent more than once is a list (round 2, derived). */
  headers?: Record<string, string | string[]>;
};
type Fixture = {
  engine: { repository: string; sha: string; contract: string };
  mythos_core: { imported_commit: string | null; pinned_by_requirements: string | null; label: string };
  scenario: string;
  exchanges: Exchange[];
};

const FIXTURES = path.resolve(__dirname, "fixtures", "engine-retest");
const PR71 = "pr71-f4610ae";
const MAIN = "main-5779e99";
const PR71_SHA = "f4610ae03b6abacf4108990c953462fbf1880950";
const MAIN_SHA = "5779e99eae1085f96e6c27ce28dbd950d8200aba";

function load(dir: string, name: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, `${name}.json`), "utf8")) as Fixture;
}
const scenarioOf = (fx: Fixture) => fx.exchanges.filter((one) => !one.note.startsWith("setup"));
const setupScanOf = (fx: Fixture) => fx.exchanges.find((one) => one.note.startsWith("setup") && one.request.path === "/api/scan")!;
const setupDecisionsOf = (fx: Fixture) => fx.exchanges.find((one) => one.note.startsWith("setup") && one.request.path.startsWith("/api/decisions?"))!;
const launchOf = (fx: Fixture, p: string) => scenarioOf(fx).find((one) => one.request.method === "POST" && one.request.path === p)!;
const statusReadsOf = (fx: Fixture) =>
  scenarioOf(fx).filter((one) => one.request.method === "GET" && /^\/api\/scans\/[^/]+$/.test(one.request.path) && one.request.path !== "/api/scans/active");
const abortsOf = (fx: Fixture) => scenarioOf(fx).filter((one) => one.request.method === "POST" && /^\/api\/scans\/[^/]+\/abort$/.test(one.request.path));
const keys = (value: Record<string, unknown>) => Object.keys(value).sort();

const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

/**
 * The stand-in engine: every answer from a fixture. `scan` is what
 * `POST /api/scan` answers -- the fixture's setup scan (200, finished, the
 * finding a retest is about) unless a case launches the scenario's own.
 */
const engineState: {
  fixture: Fixture | null;
  scan: Exchange | null;
  statusReads: Exchange[];
  aborts: Exchange[];
  /** What `POST /api/remediation/retest` answers in place of the fixture's own (a derived case). */
  retest: Exchange | null;
  /** Held until released: every stop's answer waits on it. */
  abortHold: Promise<void> | null;
  /**
   * What a stop to one run id is answered (round 2): an exchange; "destroy",
   * the connection closed with no answer; or "stall", a 200 whose body never
   * ends. In place of `aborts` when set.
   */
  abortFor: ((runId: string) => Exchange | "destroy" | "stall") | null;
  /** The engine's list of live runs (`/api/scans/active`). */
  active: unknown[];
  /** Round 3: answers a request itself (a stalled body, no answer at all) when it returns true. */
  custom: ((req: IncomingMessage, res: ServerResponse, url: string) => boolean) | null;
} = { fixture: null, scan: null, statusReads: [], aborts: [], retest: null, abortHold: null, abortFor: null, active: [], custom: null };

const calls: string[] = [];

let engine: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let watcher: import("../server/retests").RetestWatcher;
/** The app's locals: its retest watcher, and (round 2) its held slots and unread-run handles, read and cleared by tests. */
let locals: Record<string, any>;
/** The app itself (round 3: other accounts sign in to it). */
let theApp: Awaited<ReturnType<typeof makeApp>>;

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      const url = req.url ?? "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      calls.push(`${req.method} ${url}`);
      if (engineState.custom?.(req, res, url)) return;
      const fx = engineState.fixture;
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") return json(res, 200, { active: engineState.active });
      if (!fx) return json(res, 500, { detail: "no fixture" });
      const reply = (one: Exchange) => json(res, one.status, one.body, one.headers ?? {});
      if (req.method === "POST" && url === "/api/scan") return reply(engineState.scan ?? setupScanOf(fx));
      if (req.method === "GET" && url.startsWith("/api/decisions?")) return reply(setupDecisionsOf(fx));
      if (req.method === "POST" && url === "/api/remediation/retest") {
        if (fx.engine.contract === "main" && body.wait_seconds !== undefined) {
          return reply(launchOf(load(MAIN, "wait-seconds-refused"), "/api/remediation/retest"));
        }
        return reply(engineState.retest ?? launchOf(fx, "/api/remediation/retest"));
      }
      if (req.method === "POST" && /^\/api\/scans\/[^/]+\/abort$/.test(url)) {
        if (engineState.abortHold) await engineState.abortHold;
        if (engineState.abortFor) {
          const answer = engineState.abortFor(decodeURIComponent(url.split("/")[3]));
          if (answer === "destroy") return void req.socket.destroy();
          if (answer === "stall") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return void res.write("{");
          }
          return reply(answer);
        }
        const next = engineState.aborts.length > 1 ? engineState.aborts.shift() : engineState.aborts[0];
        return next ? reply(next) : json(res, 404, { detail: "No such scan run" });
      }
      if (req.method === "GET" && /^\/api\/scans\/[^/]+$/.test(url)) {
        const next = engineState.statusReads.length > 1 ? engineState.statusReads.shift() : engineState.statusReads[0];
        return next ? reply(next) : json(res, 404, { detail: "No such scan run" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  const app = await makeApp();
  theApp = app;
  watcher = app.locals.retestWatcher;
  locals = app.locals;
  agent = await signIn(app);
  storage = (await import("../server/storage-unified")).storage;
  const retests = await import("../server/retests");
  retests.retestWatch.intervalMs = 25;
  retests.retestWatch.totalMs = 4_000;
});

afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  engine.closeAllConnections?.();
  await new Promise<void>((r) => engine.close(() => r()));
});

beforeEach(() => {
  engineState.fixture = null;
  engineState.scan = null;
  engineState.statusReads = [];
  engineState.aborts = [];
  engineState.retest = null;
  engineState.abortHold = null;
  engineState.abortFor = null;
  engineState.active = [];
  engineState.custom = null;
  calls.length = 0;
  watcher.reset();
  (storage as unknown as { retestWatches: Map<string, unknown> }).retestWatches.clear();
  // The fixtures' run ids are reused across cases: no case inherits another's held slot or kept Stop.
  (locals.retestsHeld as Map<string, unknown> | undefined)?.clear();
  (locals.unreadRunHandles as Map<string, unknown> | undefined)?.clear();
});

let clientCount = 0;

async function aClientAndSite() {
  clientCount += 1;
  const client = await agent.post("/api/clients")
    .send({ name: `Launched ${clientCount}`, company: "Launched Ltd", email: `l${clientCount}@example.test` });
  const site = await agent.post("/api/sites")
    .send({ clientId: client.body.id, name: "Main", url: "https://offline.invalid" });
  return { clientId: client.body.id as string, siteId: site.body.id as string };
}

/** Start a scan whose engine answer is the scenario's own `POST /api/scan`. */
async function startScan(fx: Fixture) {
  engineState.fixture = fx;
  engineState.scan = launchOf(fx, "/api/scan");
  engineState.statusReads = statusReadsOf(fx);
  engineState.aborts = abortsOf(fx);
  const { clientId, siteId } = await aClientAndSite();
  const before = (await storage.getAllTests()).length;
  const res = await agent.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
  const after = (await storage.getAllTests()).length;
  return { res, clientId, rowsWritten: after - before };
}

/** The scan that found the finding (the fixture's setup), then Retest on it. */
async function retest(fx: Fixture) {
  engineState.fixture = fx;
  engineState.statusReads = statusReadsOf(fx);
  engineState.aborts = abortsOf(fx);
  const { clientId, siteId } = await aClientAndSite();
  const started = await agent.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const decisions = setupDecisionsOf(fx).body.decisions;
  const twin = decisions[0];
  const findings = await storage.getFindingsByClient(clientId);
  expect(findings, "the scan filed the finding the twin is about").toHaveLength(1);
  const res = await agent.post(`/api/tests/${started.body.test.id}/retest`).send({ twinId: twin.id });
  return { res, finding: findings[0], testId: started.body.test.id as string };
}

/** Read again until `ok`, a bounded number of times (no clock is read). */
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, tries = 200): Promise<T> {
  let last = await read();
  for (let i = 0; i < tries && !ok(last); i += 1) {
    await new Promise((r) => setTimeout(r, 15));
    last = await read();
  }
  return last;
}

describe("the fixtures are what the engine sent, at the commits they name, in the shapes the dashboard reads", () => {
  const pr71Files = fs.readdirSync(path.join(FIXTURES, PR71)).filter((one) => one.endsWith(".json"));
  const mainFiles = fs.readdirSync(path.join(FIXTURES, MAIN)).filter((one) => one.endsWith(".json"));

  it("every file names its engine commit and the mythos-core it ran on, labelled", () => {
    expect(pr71Files.length).toBeGreaterThan(0);
    for (const [dir, files, sha, contract] of [[PR71, pr71Files, PR71_SHA, "pr71"], [MAIN, mainFiles, MAIN_SHA, "main"]] as const) {
      for (const file of files) {
        const fx = load(dir, file.replace(/\.json$/, ""));
        expect(fx.engine, file).toEqual({ repository: "athena-engine", sha, contract });
        const pinned = fx.mythos_core.imported_commit !== null && fx.mythos_core.imported_commit === fx.mythos_core.pinned_by_requirements;
        expect(fx.mythos_core.label, file).toBe(pinned ? "pinned core" : "unpinned local core");
      }
    }
  });

  it("#71's launch answers carry exactly the keys the dashboard reads (key sets, as recorded)", () => {
    const STATUS = ["answer", "error", "reason", "run_id", "state", "status_url"];
    // Retest: 202 status (asked with wait_seconds: 0), 500 status, 429 status, 201 verdict.
    expect(keys(launchOf(load(PR71, "at-once-then-verdict"), "/api/remediation/retest").body)).toEqual([...STATUS, "detail"].sort());
    for (const name of ["at-once-failed-after-registration", "at-once-failed-before-start"]) {
      const one = launchOf(load(PR71, name), "/api/remediation/retest");
      expect(one.status, name).toBe(500);
      expect(keys(one.body), name).toEqual(STATUS);
      expect(one.headers?.["x-run-id"], name).toBe(one.body.run_id);
    }
    expect(launchOf(load(PR71, "at-once-failed-after-registration"), "/api/remediation/retest").body.state).toBeNull();
    expect(launchOf(load(PR71, "at-once-failed-before-start"), "/api/remediation/retest").body.state).toBe("failed");
    expect(keys(launchOf(load(PR71, "queue-full"), "/api/remediation/retest").body)).toEqual(STATUS);
    const verdict = launchOf(load(PR71, "verdict-closed"), "/api/remediation/retest").body;
    for (const key of ["answer", "run_id", "scan_record_id", "state", "status_url", "verdict", "check"]) expect(verdict).toHaveProperty(key);
    expect(verdict).not.toHaveProperty("stopped_after_recording");
    const late = launchOf(load(PR71, "stopped-after-recording"), "/api/remediation/retest");
    expect(late.status).toBe(201);
    expect(late.body).toMatchObject({ answer: "verdict", state: "aborted", stopped_after_recording: "customer called" });
    // Scan: 202 status, 500 status (both kinds), 429 status; 503 names no run.
    expect(keys(launchOf(load(PR71, "scan-at-once-then-completed"), "/api/scan").body)).toEqual([...STATUS, "detail"].sort());
    for (const name of ["scan-failed-after-registration", "scan-failed-before-start", "scan-queue-full"]) {
      const one = launchOf(load(PR71, name), "/api/scan");
      expect(keys(one.body), name).toEqual(STATUS);
      expect(one.headers?.["x-run-id"], name).toBe(one.body.run_id);
    }
    for (const name of ["scan-not-admitted", "not-admitted"]) {
      const one = scenarioOf(load(PR71, name))[0];
      expect(one.status, name).toBe(503);
      expect(keys(one.body), name).toEqual(["detail"]);
    }
    // Abort by id: recorded, unrecorded (202), not running.
    expect(keys(abortsOf(load(PR71, "running-then-stopped"))[0].body)).toEqual(["reason", "recorded", "run_id", "state"]);
    const unrecorded = abortsOf(load(PR71, "scan-abort-unrecorded"))[0];
    expect(unrecorded.status).toBe(202);
    expect(keys(unrecorded.body)).toEqual(["detail", "reason", "recorded", "run_id", "state"]);
    expect(unrecorded.body.recorded).toBe(false);
    expect(keys(abortsOf(load(PR71, "running-then-stopped"))[1].body)).toEqual(["detail", "run_id", "state"]);
  });

  it("main's scan answer has no `answer` field, and its 202 can already read completed too", () => {
    const main = launchOf(load(MAIN, "scan-at-once-then-completed"), "/api/scan");
    expect(main.status).toBe(202);
    expect(keys(main.body)).toEqual(["detail", "run_id", "state", "status_url"]);
    for (const dir of [PR71, MAIN]) {
      const early = launchOf(load(dir, "scan-finished-before-the-answer"), "/api/scan");
      expect(early.status, dir).toBe(202);
      expect(early.body.state, dir).toBe("completed");
      expect(early.body, dir).not.toHaveProperty("result");
    }
    const retest = launchOf(load(PR71, "at-once-finished-before-the-answer"), "/api/remediation/retest");
    expect([retest.status, retest.body.state]).toEqual([202, "completed"]);
  });
});

describe("a scan's 202 is never done", () => {
  for (const dir of [PR71, MAIN]) {
    it(`${dir}: a 202 that already reads completed is recorded running, and its findings are collected from the run`, async () => {
      const fx = load(dir, "scan-finished-before-the-answer");
      const { res, clientId } = await startScan(fx);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.runId).toBe(launchOf(fx, "/api/scan").body.run_id);
      // Not written as a finished scan with no findings.
      expect(res.body.test.status).toBe("running");
      expect(res.body.test.completedAt).toBeNull();

      const read = await agent.get(`/api/scans/${res.body.test.id}`);
      expect(read.status).toBe(200);
      expect(read.body.state).toBe("completed");
      expect(read.body.test.highCount).toBe(1);
      expect(calls).toContain(`GET /api/scans/${res.body.runId}`);
      expect(await storage.getFindingsByClient(clientId)).toHaveLength(1);
    });

    it(`${dir}: a 202 still running is recorded running, and read until it ends`, async () => {
      const fx = load(dir, "scan-at-once-then-completed");
      const { res, clientId } = await startScan(fx);
      expect(res.status).toBe(201);
      expect(res.body.test.status).toBe("running");
      const first = await agent.get(`/api/scans/${res.body.test.id}`);
      expect(first.body.state).toBe("running");
      expect(await storage.getFindingsByClient(clientId)).toHaveLength(0);
      const second = await agent.get(`/api/scans/${res.body.test.id}`);
      expect(second.body.state).toBe("completed");
      expect(second.body.test.highCount).toBe(1);
      expect(await storage.getFindingsByClient(clientId)).toHaveLength(1);
    });
  }
});

describe("a scan launch that failed after its run was registered", () => {
  it("state null (its work started): recorded running with its Stop, which aborts the engine's run by its run_id", async () => {
    const fx = load(PR71, "scan-failed-after-registration");
    const named = launchOf(fx, "/api/scan").body;
    const { res, rowsWritten } = await startScan(fx);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(rowsWritten).toBe(1);
    expect(res.body.runId).toBe(named.run_id);
    expect(res.body.test.status).toBe("running");
    expect((res.body.test.findings as { runId: string }).runId).toBe(named.run_id);
    expect(res.body.warning).toContain(named.run_id);
    expect(res.body.warning).toContain("database is locked");

    const stop = await agent.post(`/api/scans/${res.body.test.id}/abort`);
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    expect(stop.body.stopped).toBe(true);
    expect(calls).toContain(`POST /api/scans/${named.run_id}/abort`);
  });

  it("state failed (its work never started): nothing is recorded, no stop is sent, and the engine's error is said", async () => {
    const fx = load(PR71, "scan-failed-before-start");
    const named = launchOf(fx, "/api/scan").body;
    const { res, rowsWritten } = await startScan(fx);
    expect(res.status).toBe(503);
    expect(rowsWritten).toBe(0);
    expect(res.body.error).toContain(named.run_id);
    expect(res.body.error).toContain("the pool is misconfigured");
    expect(calls.filter((one) => one.endsWith("/abort"))).toEqual([]);
  });

  for (const name of ["scan-queue-full", "scan-not-admitted"]) {
    it(`${name}: nothing started, so nothing is recorded and no stop is sent`, async () => {
      const { res, rowsWritten } = await startScan(load(PR71, name));
      expect(res.status).toBe(503);
      expect(rowsWritten).toBe(0);
      expect(calls.filter((one) => one.endsWith("/abort"))).toEqual([]);
    });
  }
});

describe("a scan answer in a shape this dashboard does not read", () => {
  it("(derived: a recorded 202 with `answer` changed) records nothing, and the run it names is stopped", async () => {
    const fx = load(PR71, "scan-at-once-then-completed");
    const recorded = launchOf(fx, "/api/scan");
    const derived: Fixture = {
      ...fx,
      exchanges: fx.exchanges.map((one) => (one === recorded ? { ...one, body: { ...one.body, answer: "verdict" } } : one)),
    };
    engineState.aborts = abortsOf(load(PR71, "running-then-stopped")).slice(0, 1);
    engineState.fixture = derived;
    engineState.scan = launchOf(derived, "/api/scan");
    const { clientId, siteId } = await aClientAndSite();
    const before = (await storage.getAllTests()).length;
    const res = await agent.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.reason).toBe("unrecognised_engine_answer");
    expect(res.body.error).toContain("a shape this dashboard does not read");
    expect((await storage.getAllTests()).length).toBe(before);
    expect(res.body.runId).toBe(recorded.body.run_id);
    expect(calls).toContain(`POST /api/scans/${recorded.body.run_id}/abort`);
  });
});

describe("a Stop the engine answered 202, not yet in its registry", () => {
  it("is a stop the engine took: in effect in its process, said as sent and accepted", async () => {
    const fx = load(PR71, "scan-abort-unrecorded");
    const { res } = await startScan(fx);
    expect(res.status).toBe(201);
    const stop = await agent.post(`/api/scans/${res.body.test.id}/abort`);
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    expect(stop.body.stopped).toBe(true);
    expect(stop.body.alreadyFinished).toBeFalsy();
  });
});

describe("a retest launch that failed after its run was registered", () => {
  it("state null (its work started): watched with its Stop, and its verdict filed once against scan_record_id", async () => {
    const fx = load(PR71, "at-once-failed-after-registration");
    const named = launchOf(fx, "/api/remediation/retest").body;
    const [, finished] = statusReadsOf(fx);
    const { res, finding } = await retest(fx);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ answer: "status", phase: "running", engineRunId: named.run_id, stoppable: true });
    const watched = await until(() => agent.get(`/api/retests/${named.run_id}`).then((r) => r.body), (body) => body.phase !== "running");
    expect(watched.phase).toBe("verdict");
    const checks = await storage.getChecks(finding.id);
    expect(checks.map((one) => [one.verdict, one.runId])).toEqual([["closed", String(finished.body.result.scan_record_id)]]);
  });

  it("state failed (its work never started): a failed retest, nothing filed, no Stop offered", async () => {
    const fx = load(PR71, "at-once-failed-before-start");
    const { res, finding } = await retest(fx);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ answer: "status", phase: "failed", stoppable: false });
    expect(res.body.detail).toContain("the pool is misconfigured");
    expect(await storage.getChecks(finding.id)).toEqual([]);
  });
});

describe("a retest stopped while its check was being filed", () => {
  it("asked at once (202): its status read is the verdict the engine filed, filed here once, marked as stopped after recording", async () => {
    const fx = load(PR71, "at-once-then-stopped-after-recording");
    const accepted = launchOf(fx, "/api/remediation/retest").body;
    const [ended] = statusReadsOf(fx);
    expect(ended.body).toMatchObject({ state: "aborted", reason: "customer called" });
    expect(ended.body.result.check).toBeTruthy();
    const { res, finding } = await retest(fx);
    expect(res.status).toBe(202);
    const watched = await until(() => agent.get(`/api/retests/${accepted.run_id}`).then((r) => r.body), (body) => body.phase !== "running");
    expect(watched).toMatchObject({ phase: "verdict", state: "aborted", reason: "customer called" });
    expect(watched.detail).toContain("customer called");
    const checks = await storage.getChecks(finding.id);
    expect(checks.map((one) => [one.verdict, one.runId])).toEqual([["closed", String(ended.body.result.scan_record_id)]]);
  });

  it("answered inline (201, state aborted): the verdict is filed, and the answer says the stop came after it was recorded", async () => {
    const fx = load(PR71, "stopped-after-recording");
    const answered = launchOf(fx, "/api/remediation/retest").body;
    const { res, finding } = await retest(fx);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ answer: "verdict", verdict: "closed", runId: String(answered.scan_record_id), engineRunId: answered.run_id });
    expect(res.body.stoppedAfterRecording).toBe("customer called");
    const checks = await storage.getChecks(finding.id);
    expect(checks.map((one) => one.runId)).toEqual([String(answered.scan_record_id)]);
  });

  it("a run stopped before it filed anything is still a stop: nothing filed", async () => {
    const fx = load(PR71, "at-once-then-stopped");
    const accepted = launchOf(fx, "/api/remediation/retest").body;
    expect(statusReadsOf(fx).at(-1)!.body.result).not.toHaveProperty("check");
    const { res, finding } = await retest(fx);
    expect(res.status).toBe(202);
    const watched = await until(() => agent.get(`/api/retests/${accepted.run_id}`).then((r) => r.body), (body) => body.phase !== "running");
    expect(watched.phase).toBe("stopped");
    expect(await storage.getChecks(finding.id)).toEqual([]);
  });
});

describe("a retest's 202 is never done", () => {
  it("a 202 that already reads completed is watched, and its verdict collected from the run", async () => {
    const fx = load(PR71, "at-once-finished-before-the-answer");
    const accepted = launchOf(fx, "/api/remediation/retest").body;
    const [finished] = statusReadsOf(fx);
    const { res, finding } = await retest(fx);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ phase: "running", engineRunId: accepted.run_id });
    const watched = await until(() => agent.get(`/api/retests/${accepted.run_id}`).then((r) => r.body), (body) => body.phase !== "running");
    expect(watched.phase).toBe("verdict");
    expect((await storage.getChecks(finding.id)).map((one) => one.runId)).toEqual([String(finished.body.result.scan_record_id)]);
  });

  it("a retest not admitted (503, nothing registered) files nothing and offers no Stop", async () => {
    const { res, finding } = await retest(load(PR71, "not-admitted"));
    expect(res.status).toBe(503);
    expect(res.body.engineRunId).toBeUndefined();
    expect(await storage.getChecks(finding.id)).toEqual([]);
  });
});

// ==== Round 1 (adversary findings on #58) ====================================
//
// Every case below that is not a recorded exchange as the engine sent it is
// labelled "derived" where it is built: a recorded answer with the named
// fields changed, for a shape no engine sends (or an order of events the
// generator does not record).

/** derived: a recorded exchange with its body (and headers) changed. */
function derive(one: Exchange, body: unknown, headers?: Record<string, string>): Exchange {
  return { ...one, note: `derived: ${one.note}`, body, headers: headers ?? one.headers };
}

const STOPPED_MARK = (reason: string) => `Stopped after its check was recorded (${reason})`;
const TAKEN_HERE = "The stop sent from this dashboard was taken";

/**
 * The fixtures' run ids are reused across cases, which a real engine never
 * does; the record keeps one check per engine run, so each case here starts
 * with none on record.
 */
function clearChecks() {
  (storage as unknown as { checks: unknown[] }).checks.length = 0;
}

async function logsFor(testId: string, action: string) {
  return (await storage.getAllActivityLogs())
    .filter((one) => one.entityId === testId && one.action === action)
    .map((one) => one.details as Record<string, unknown>);
}

describe("round 1: a verdict the engine filed before a stop landed is never a clean run, and never 'finished anyway'", () => {
  beforeEach(clearChecks);
  it("#2 a stop from elsewhere (202, then read aborted with its check): panel, check, statusNote and log all say stopped after recording", async () => {
    const fx = load(PR71, "at-once-then-stopped-after-recording");
    const accepted = launchOf(fx, "/api/remediation/retest").body;
    const [ended] = statusReadsOf(fx);
    const { finding, testId } = await retest(fx);
    const watched = await until(() => agent.get(`/api/retests/${accepted.run_id}`).then((r) => r.body), (body) => body.phase !== "running");
    expect(watched).toMatchObject({ phase: "verdict", state: "aborted", reason: "customer called" });
    const [check] = await storage.getChecks(finding.id);
    expect(check.detail).toContain(STOPPED_MARK("customer called"));
    expect(check.detail).not.toContain("Completed despite");
    // Never byte-identical to a clean run's: the engine's sentence alone is what a clean run files.
    expect(check.detail).not.toBe(ended.body.result.detail);
    const note = (await storage.getFinding(finding.id))!.statusNote ?? "";
    expect(note).toContain(STOPPED_MARK("customer called"));
    expect(note).not.toContain("Completed despite");
    expect(watched.result).toMatchObject({ stoppedAfterRecording: "customer called", completedDespiteStop: false, stopTakenHere: false });
    expect(watched.detail).toContain("a stop (customer called) landed while that check was being written");
    expect(watched.detail).not.toContain(TAKEN_HERE);
    const [logged] = await until(() => logsFor(testId, "retest_collected"), (rows) => rows.length > 0);
    expect(logged).toMatchObject({ state: "aborted", stoppedAfterRecording: "customer called", completedDespiteStop: false, stopTakenHere: false });
  });

  it("#1 this operator's stop accepted, then the run ended aborted after recording: 'stop taken', never 'completed despite a stop'", async () => {
    const fx = load(PR71, "at-once-then-stopped-after-recording");
    const runId = launchOf(fx, "/api/remediation/retest").body.run_id as string;
    const [ended] = statusReadsOf(fx);
    // derived: at-once-then-stopped's recorded running read and its accepted Stop, run_id set to this run.
    const recordedRunning = statusReadsOf(load(PR71, "at-once-then-stopped"))[0];
    const recordedStop = abortsOf(load(PR71, "at-once-then-stopped"))[0];
    const { finding, testId, res } = await retest(fx);
    expect(res.status).toBe(202);
    // The watch has read the run as running before the Stop.
    engineState.statusReads = [derive(recordedRunning, { ...recordedRunning.body, run_id: runId })];
    engineState.aborts = [derive(recordedStop, { ...recordedStop.body, run_id: runId })];
    const stop = await agent.post(`/api/retests/${runId}/abort`);
    expect(stop.body).toMatchObject({ stopped: true, runId });
    await until(async () => watcher.peek(runId)?.stopAcceptedAt ?? null, (at) => at != null);
    engineState.statusReads = [ended];
    const watched = await until(() => agent.get(`/api/retests/${runId}`).then((r) => r.body), (body) => body.phase !== "running");
    expect(watched).toMatchObject({ phase: "verdict", state: "aborted" });
    expect(watched.result).toMatchObject({ stoppedAfterRecording: "customer called", completedDespiteStop: false, stopTakenHere: true });
    expect(watched.detail).toContain("a stop (customer called) landed while that check was being written");
    expect(watched.detail).toContain(TAKEN_HERE);
    expect(watched.detail).not.toContain("completed anyway");

    const [check] = await storage.getChecks(finding.id);
    expect(check.detail).toContain(STOPPED_MARK("customer called"));
    expect(check.detail).toContain(TAKEN_HERE);
    expect(check.detail).not.toContain("Completed despite");
    const note = (await storage.getFinding(finding.id))!.statusNote ?? "";
    expect(note).toContain(STOPPED_MARK("customer called"));
    expect(note).toContain(TAKEN_HERE);
    expect(note).not.toContain("Completed despite");
    const [logged] = await until(() => logsFor(testId, "retest_collected"), (rows) => rows.length > 0);
    expect(logged).toMatchObject({ state: "aborted", stoppedAfterRecording: "customer called", completedDespiteStop: false, stopTakenHere: true });
  });

  it("#7 answered inline (201, state aborted): the check, the statusNote and the 'retested' log carry the marking", async () => {
    const fx = load(PR71, "stopped-after-recording");
    const { res, finding, testId } = await retest(fx);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stoppedAfterRecording).toBe("customer called");
    const [check] = await storage.getChecks(finding.id);
    expect(check.detail).toContain(STOPPED_MARK("customer called"));
    expect((await storage.getFinding(finding.id))!.statusNote ?? "").toContain(STOPPED_MARK("customer called"));
    const [logged] = await logsFor(testId, "retested");
    expect(logged).toMatchObject({ verdict: "closed", stoppedAfterRecording: "customer called" });
  });

  it("#7 (derived: the recorded 201 without `stopped_after_recording`) state aborted is still marked stopped after recording", async () => {
    const fx = load(PR71, "stopped-after-recording");
    const recorded = launchOf(fx, "/api/remediation/retest");
    const { stopped_after_recording: _dropped, ...rest } = recorded.body;
    engineState.retest = derive(recorded, rest);
    const { res, finding } = await retest(fx);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stoppedAfterRecording).toBe("aborted");
    const [check] = await storage.getChecks(finding.id);
    expect(check.detail).toContain(STOPPED_MARK("aborted"));
  });

  it("(derived: the recorded 201 with a `reason` beside `stopped_after_recording`) the engine's stopped_after_recording is the reason read", async () => {
    const fx = load(PR71, "stopped-after-recording");
    const recorded = launchOf(fx, "/api/remediation/retest");
    engineState.retest = derive(recorded, { ...recorded.body, reason: "a different reason" });
    const { res } = await retest(fx);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stoppedAfterRecording).toBe("customer called");
  });

  it("a clean verdict carries no stop marking at all", async () => {
    const fx = load(PR71, "at-once-then-verdict");
    const accepted = launchOf(fx, "/api/remediation/retest").body;
    const { finding } = await retest(fx);
    const watched = await until(() => agent.get(`/api/retests/${accepted.run_id}`).then((r) => r.body), (body) => body.phase !== "running");
    expect(watched.phase).toBe("verdict");
    expect(watched.result.stoppedAfterRecording).toBeNull();
    expect(watched.detail).toBe("The retest finished with a verdict.");
    const [check] = await storage.getChecks(finding.id);
    expect(check.detail).not.toMatch(/stop/i);
  });
});

describe("round 1: a scan answer's `answer` is read by its exact spelling (pins M1, M2)", () => {
  for (const [label, value] of [["null", null], ['""', ""], ['"Status"', "Status"], ['" status"', " status"], ['"status "', "status "]] as const) {
    it(`(derived: the recorded 202 with answer ${label}) is refused, nothing recorded, its run stopped`, async () => {
      const fx = load(PR71, "scan-at-once-then-completed");
      const recorded = launchOf(fx, "/api/scan");
      engineState.fixture = fx;
      engineState.scan = derive(recorded, { ...recorded.body, answer: value });
      engineState.aborts = abortsOf(load(PR71, "running-then-stopped")).slice(0, 1);
      const { clientId, siteId } = await aClientAndSite();
      const before = (await storage.getAllTests()).length;
      const res = await agent.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body.reason).toBe("unrecognised_engine_answer");
      expect((await storage.getAllTests()).length).toBe(before);
      expect(calls).toContain(`POST /api/scans/${recorded.body.run_id}/abort`);
    });
  }
});

/** A scan start whose engine answer is `answer` (derived), with the recorded Stop answer. */
async function startWith(answer: Exchange) {
  engineState.fixture = load(PR71, "scan-at-once-then-completed");
  engineState.scan = answer;
  engineState.aborts = abortsOf(load(PR71, "running-then-stopped")).slice(0, 1);
  const { clientId, siteId } = await aClientAndSite();
  const before = (await storage.getAllTests()).length;
  const res = await agent.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
  return { res, rowsWritten: (await storage.getAllTests()).length - before };
}

describe("round 1 #5: a 2xx scan body that is not a JSON object is refused, never read as main's no-`answer` shape", () => {
  const recorded = launchOf(load(PR71, "scan-at-once-then-completed"), "/api/scan");
  const id = recorded.body.run_id as string;
  for (const [label, body] of [["[]", "[]"], ["null", "null"], ['"ok"', '"ok"'], ["[{run_id}]", JSON.stringify([{ run_id: id }])], ["not JSON", "accepted"]] as const) {
    it(`(derived: the recorded 202's body replaced by ${label}) no header: refused, nothing recorded, no stop it could name`, async () => {
      const { res, rowsWritten } = await startWith(derive(recorded, body, {}));
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body.reason).toBe("unrecognised_engine_answer");
      expect(res.body.error).toContain("not a JSON object");
      expect(res.body.error).toContain("kill switch");
      expect(rowsWritten).toBe(0);
      expect(calls.filter((one) => one.endsWith("/abort"))).toEqual([]);
    });
    it(`(derived: the recorded 202's body replaced by ${label}) with X-Run-Id: refused, nothing recorded, the header's run stopped`, async () => {
      const { res, rowsWritten } = await startWith(derive(recorded, body, { "X-Run-Id": id }));
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body.reason).toBe("unrecognised_engine_answer");
      expect(res.body.runId).toBe(id);
      expect(res.body.stopped).toBe(true);
      expect(rowsWritten).toBe(0);
      expect(calls).toContain(`POST /api/scans/${id}/abort`);
    });
  }

  it("(derived: the recorded 202's body replaced by {}, its run named by X-Run-Id alone) refused, nothing recorded, the header's run stopped", async () => {
    const { res, rowsWritten } = await startWith(derive(recorded, {}, { "X-Run-Id": id }));
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.reason).toBe("unrecognised_engine_answer");
    expect(res.body.runId).toBe(id);
    expect(rowsWritten).toBe(0);
    expect(calls).toContain(`POST /api/scans/${id}/abort`);
  });

  it("(derived: the recorded 202 with an X-Run-Id header naming another run) neither is guessed: refused, both stopped", async () => {
    const other = "33333333-3333-4333-8333-333333333333";
    const { res, rowsWritten } = await startWith(derive(recorded, recorded.body, { "X-Run-Id": other }));
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.runIds).toEqual([id, other]);
    expect(res.body.error).toContain("differ");
    expect(rowsWritten).toBe(0);
    expect(calls).toContain(`POST /api/scans/${id}/abort`);
    expect(calls).toContain(`POST /api/scans/${other}/abort`);
  });

  it("(derived: the recorded 202's body replaced by {}) keeps the no-run-id handling, and says why", async () => {
    const { res, rowsWritten } = await startWith(derive(recorded, {}, {}));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(rowsWritten).toBe(1);
    expect(res.body.stop).toBe("failsafe");
    expect(res.body.warning).toContain("named no run id");
  });
});

describe("round 1 #3: a 500 that names a run in a shape the reader does not take", () => {
  beforeEach(clearChecks);
  const fx = load(PR71, "scan-failed-after-registration");
  const recorded = launchOf(fx, "/api/scan");
  const A = recorded.body.run_id as string;
  const B = "22222222-2222-4222-8222-222222222222";
  for (const [label, body, headers] of [
    ["answer \"Status\"", { ...recorded.body, answer: "Status" }, { "X-Run-Id": A }],
    ["no `answer` (main-like)", (({ answer: _a, ...rest }) => rest)(recorded.body), { "X-Run-Id": A }],
    ["a body that is not JSON, the run named by X-Run-Id alone", "Internal Server Error", { "X-Run-Id": A }],
    ["answer status with no run_id, the run named by X-Run-Id alone", (({ run_id: _r, ...rest }) => rest)(recorded.body), { "X-Run-Id": A }],
    ["answer \"Status\" naming the run in the body alone", { ...recorded.body, answer: "Status" }, {}],
  ] as const) {
    it(`(derived: the recorded 500 with ${label}) the named run is sent a stop, why is recorded, nothing is recorded as started`, async () => {
      const { res, rowsWritten } = await startWith(derive(recorded, body, headers as Record<string, string>));
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body.reason).toBe("unrecognised_engine_answer");
      expect(res.body.runId).toBe(A);
      expect(res.body.stopped).toBe(true);
      expect(rowsWritten).toBe(0);
      expect(calls).toContain(`POST /api/scans/${A}/abort`);
      const stops = (await storage.getAllActivityLogs()).filter((one) => one.entityId === A && one.action === "aborted");
      expect(stops.length).toBeGreaterThan(0);
      expect(String((stops.at(-1)!.details as Record<string, unknown>).note)).toContain("500");
    });
  }

  for (const state of [null, "failed"] as const) {
    it(`(derived: the recorded 500, state ${state}, body naming A and X-Run-Id naming B) both are stopped, and it says so`, async () => {
      const { res, rowsWritten } = await startWith(derive(recorded, { ...recorded.body, state }, { "X-Run-Id": B }));
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body.reason).toBe("unrecognised_engine_answer");
      expect(res.body.runIds).toEqual([A, B]);
      expect(res.body.error).toContain(A);
      expect(res.body.error).toContain(B);
      expect(res.body.error).toContain("differ");
      expect(rowsWritten).toBe(0);
      expect(calls).toContain(`POST /api/scans/${A}/abort`);
      expect(calls).toContain(`POST /api/scans/${B}/abort`);
    });
  }

  it("(derived: the recorded 500 with a body that is not JSON and no X-Run-Id) names no run: nothing to stop, the engine's words as before", async () => {
    const { res, rowsWritten } = await startWith(derive(recorded, "Internal Server Error", {}));
    expect(res.status).toBe(503);
    expect(rowsWritten).toBe(0);
    expect(calls.filter((one) => one.endsWith("/abort"))).toEqual([]);
  });

  it("(derived: the recorded retest 500 with answer \"Status\") the named retest run is sent a stop, and nothing is filed", async () => {
    const rfx = load(PR71, "at-once-failed-after-registration");
    const launch = launchOf(rfx, "/api/remediation/retest");
    engineState.retest = derive(launch, { ...launch.body, answer: "Status" });
    const { res, finding } = await retestWithStop(rfx);
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.reason).toBe("unrecognised_engine_answer");
    expect(res.body.runId).toBe(launch.body.run_id);
    expect(res.body.stopped).toBe(true);
    expect(calls).toContain(`POST /api/scans/${launch.body.run_id}/abort`);
    expect(await storage.getChecks(finding.id)).toEqual([]);
  });
});

/** Retest, with the recorded accepted Stop answer set for any stop sent. */
async function retestWithStop(fx: Fixture) {
  const stopFx = load(PR71, "running-then-stopped");
  const r = retest(fx);
  // Set after retest() set the fixture's own: the recorded accepted Stop.
  engineState.aborts = abortsOf(stopFx).slice(0, 1);
  return r;
}

describe("round 1 #4: a retest 2xx with an unread `answer` that names a run", () => {
  beforeEach(clearChecks);
  const fx = load(PR71, "at-once-then-verdict");
  const launch = launchOf(fx, "/api/remediation/retest");
  const id = launch.body.run_id as string;
  for (const [label, status, answer] of [["202 answer null", 202, null], ['202 answer "Status"', 202, "Status"], ["202 answer 7", 202, 7],
    ['202 answer "verdict"', 202, "verdict"], ["200 answer 7", 200, 7]] as const) {
    it(`(derived: the recorded ${label}) refused (502), the named run sent a stop, and the finding unchanged`, async () => {
      engineState.retest = { ...derive(launch, { ...launch.body, answer }), status };
      const { res, finding } = await retestWithStop(fx);
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body.reason).toBe("unrecognised_engine_answer");
      expect(res.body.runId).toBe(id);
      expect(res.body.stopped).toBe(true);
      expect(calls).toContain(`POST /api/scans/${id}/abort`);
      expect(await storage.getChecks(finding.id)).toEqual([]);
    });
  }

  it("(derived: the recorded 202 with answer \"Status\") its slot stays held until the stop is answered", async () => {
    engineState.retest = derive(launch, { ...launch.body, answer: "Status" });
    let release!: () => void;
    engineState.abortHold = new Promise<void>((r) => { release = r; });
    engineState.fixture = fx;
    engineState.statusReads = statusReadsOf(fx);
    const { clientId, siteId } = await aClientAndSite();
    const started = await agent.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
    engineState.aborts = abortsOf(load(PR71, "running-then-stopped")).slice(0, 1);
    const twinId = setupDecisionsOf(fx).body.decisions[0].id;
    const first = agent.post(`/api/tests/${started.body.test.id}/retest`).send({ twinId }).then((r) => r);
    await until(async () => calls.includes(`POST /api/scans/${id}/abort`), (sent) => sent);
    const second = await agent.post(`/api/tests/${started.body.test.id}/retest`).send({ twinId });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.reason).toBe("retest_running");
    release();
    engineState.abortHold = null;
    const answered = await first;
    expect(answered.status).toBe(502);
    expect(answered.body.stopped).toBe(true);
    // The stop was answered, and taken: the slot is free.
    engineState.retest = null;
    const third = await agent.post(`/api/tests/${started.body.test.id}/retest`).send({ twinId });
    expect(third.status, JSON.stringify(third.body)).not.toBe(409);
  });
});

describe("round 1 #6: the 500 state:null warning reaches the record", () => {
  it("the 'started' log entry carries the engine's warning", async () => {
    const fx = load(PR71, "scan-failed-after-registration");
    const { res } = await startScan(fx);
    expect(res.status).toBe(201);
    const [logged] = await logsFor(res.body.test.id, "started");
    expect(String(logged.warning)).toContain("database is locked");
  });
});

// ---- Round 2 ----
// Every answer below is a recorded one, "derived" where a field, a header or
// the stop's answer was changed (the change is named in each case's title).

const R2_B = "22222222-2222-4222-8222-222222222222";
const r2Verdict = load(PR71, "at-once-then-verdict");
const r2Launch = launchOf(r2Verdict, "/api/remediation/retest");
const R2_A = r2Launch.body.run_id as string;
const r2Twin = setupDecisionsOf(r2Verdict).body.decisions[0].id as number;
/** derived: the recorded accepted Stop (running-then-stopped), its run_id set to this run. */
const acceptedStopOf = (runId: string) => {
  const one = abortsOf(load(PR71, "running-then-stopped"))[0];
  return derive(one, { ...one.body, run_id: runId });
};
/** derived: the recorded 503 "not admitted" answer (not-admitted), as a stop's answer. */
const refusedStop = () => derive(launchOf(load(PR71, "not-admitted"), "/api/remediation/retest"),
  launchOf(load(PR71, "not-admitted"), "/api/remediation/retest").body);
const abortCalls = () => calls.filter((one) => one.endsWith("/abort"));
const retestCalls = () => calls.filter((one) => one === "POST /api/remediation/retest");

describe("round 2 #1: an unread retest answer's slot is freed only by stops that were each taken (pins N1, N2, N10)", () => {
  beforeEach(clearChecks);

  it("(derived: the recorded 202 with answer \"Status\"; its stop refused, the recorded 503) the slot is held, counted against the cap (N10)", async () => {
    engineState.retest = derive(r2Launch, { ...r2Launch.body, answer: "Status" });
    engineState.abortFor = () => refusedStop();
    const { res, testId } = await retest(r2Verdict);
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.stops).toEqual([expect.objectContaining({ runId: R2_A, stopped: false })]);
    expect(res.body.held).toContain("may still be running");
    expect(res.body.mayStillBeRunning).toBe(true);
    expect((locals.retestsHeld as Map<string, unknown>).has(`${testId}:${r2Twin}`)).toBe(true);
    // Counted against the cap: with room for one, another finding's retest is refused before it reaches the engine.
    process.env.ATHENA_MAX_INFLIGHT_RETESTS = "1";
    try {
      engineState.retest = null;
      engineState.abortFor = null;
      const sent = retestCalls().length;
      const other = await retest(r2Verdict);
      expect(other.res.status, JSON.stringify(other.res.body)).toBe(429);
      expect(other.res.body.reason).toBe("retests_busy");
      expect(other.res.body.error).toContain("1 of them the engine did not answer in time and may still be running");
      expect(retestCalls().length).toBe(sent);
    } finally {
      delete process.env.ATHENA_MAX_INFLIGHT_RETESTS;
    }
  });

  it("(derived: the recorded 202 with answer \"Status\"; its stop answered 200 and the rest of that answer never sent) held: a stop whose answer was not read frees nothing (N1)", async () => {
    const eng = await import("../server/engine");
    const was = eng.engineTimeouts.abortBodyMs;
    eng.engineTimeouts.abortBodyMs = 150;
    try {
      engineState.retest = derive(r2Launch, { ...r2Launch.body, answer: "Status" });
      engineState.abortFor = () => "stall";
      const { res, testId } = await retest(r2Verdict);
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body.stops).toEqual([expect.objectContaining({ runId: R2_A, stopped: true, answerUnread: true })]);
      expect(res.body.held).toContain("may still be running");
      expect(res.body.mayStillBeRunning).toBe(true);
      expect((locals.retestsHeld as Map<string, unknown>).has(`${testId}:${r2Twin}`)).toBe(true);
    } finally {
      eng.engineTimeouts.abortBodyMs = was;
    }
  });

  it("(derived: the recorded 202 status naming A, an X-Run-Id naming B; A's stop taken, B's refused 503) held: one stop taken frees nothing (N2)", async () => {
    engineState.retest = derive(r2Launch, { ...r2Launch.body, answer: "status" }, { "X-Run-Id": R2_B });
    engineState.abortFor = (runId) => (runId === R2_A ? acceptedStopOf(R2_A) : refusedStop());
    const { res, testId } = await retest(r2Verdict);
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.runIds).toEqual([R2_A, R2_B]);
    expect(res.body.stops).toEqual([
      expect.objectContaining({ runId: R2_A, stopped: true }),
      expect.objectContaining({ runId: R2_B, stopped: false }),
    ]);
    expect(res.body.held).toContain("may still be running");
    expect((locals.retestsHeld as Map<string, unknown>).has(`${testId}:${r2Twin}`)).toBe(true);
    // Only the run whose stop did not take keeps a Stop.
    expect(res.body.stoppable).toEqual([R2_B]);
  });
});

describe("round 2 #1: a retest 500 whose X-Run-Id names another run is never read as its body's status (pins N3)", () => {
  beforeEach(clearChecks);
  it("(derived: the recorded 500, state null, its X-Run-Id naming B) refused, both runs stopped, no watch started", async () => {
    const fx = load(PR71, "at-once-failed-after-registration");
    const launch = launchOf(fx, "/api/remediation/retest");
    const ran = launch.body.run_id as string;
    engineState.retest = derive(launch, launch.body, { "X-Run-Id": R2_B });
    engineState.abortFor = (runId) => acceptedStopOf(runId);
    const { res, finding } = await retest(fx);
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.reason).toBe("unrecognised_engine_answer");
    expect(res.body.runIds).toEqual([ran, R2_B]);
    expect(res.body.error).toContain("differ");
    expect(abortCalls().sort()).toEqual([`POST /api/scans/${ran}/abort`, `POST /api/scans/${R2_B}/abort`].sort());
    expect((await agent.get(`/api/retests/${ran}`)).status).toBe(404);
    expect(await storage.getChecks(finding.id)).toEqual([]);
  });
});

describe("round 2 #1: an aborted verdict whose reason the engine emptied is still marked stopped after recording (pins N7)", () => {
  beforeEach(clearChecks);
  it("watched (derived: the recorded aborted read with its `reason` \"\", as the engine's strip() leaves it) marked \"aborted\"", async () => {
    const fx = load(PR71, "at-once-then-stopped-after-recording");
    const [ended] = statusReadsOf(fx);
    const emptied = derive(ended, { ...ended.body, reason: "" });
    const derived: Fixture = { ...fx, exchanges: fx.exchanges.map((one) => (one === ended ? emptied : one)) };
    const accepted = launchOf(fx, "/api/remediation/retest").body;
    const { finding } = await retest(derived);
    const watched = await until(() => agent.get(`/api/retests/${accepted.run_id}`).then((r) => r.body), (body) => body.phase !== "running");
    expect(watched.phase).toBe("verdict");
    expect(watched.result.stoppedAfterRecording).toBe("aborted");
    const [check] = await storage.getChecks(finding.id);
    expect(check.detail).toContain(STOPPED_MARK("aborted"));
  });

  it("inline (derived: the recorded 201 with `stopped_after_recording` \"\") marked \"aborted\"", async () => {
    const fx = load(PR71, "stopped-after-recording");
    const recorded = launchOf(fx, "/api/remediation/retest");
    engineState.retest = derive(recorded, { ...recorded.body, stopped_after_recording: "" });
    const { res, finding } = await retest(fx);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stoppedAfterRecording).toBe("aborted");
    const [check] = await storage.getChecks(finding.id);
    expect(check.detail).toContain(STOPPED_MARK("aborted"));
  });
});

describe("round 2 #2 (L1): a 500 is read by its whole body, and quoted by its first 500 characters", () => {
  beforeEach(clearChecks);
  const errorOf = (length: number) => ("OperationalError: database is locked; " + "x".repeat(length)).slice(0, length);
  const scanFx = load(PR71, "scan-failed-after-registration");
  const scan500 = launchOf(scanFx, "/api/scan");
  for (const length of [332, 333, 10_000]) {
    it(`scan (derived: the recorded 500, state null, its error ${length} characters) recorded running with its Stop, nothing stopped`, async () => {
      const { res, rowsWritten } = await startWith(derive(scan500, { ...scan500.body, error: errorOf(length) }));
      expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);
      expect(rowsWritten).toBe(1);
      expect(res.body.runId).toBe(scan500.body.run_id);
      expect(abortCalls()).toEqual([]);
      expect(res.body.warning).toContain("OperationalError: database is locked");
      // What is shown and stored is bounded as every error body is.
      expect(res.body.warning.length).toBeLessThan(500 + 300);
    });
  }
  it("scan (derived: the recorded 500 with an error past the 64 KiB read ceiling) not read: refused, the X-Run-Id's run stopped, the error quoted short", async () => {
    const { res, rowsWritten } = await startWith(derive(scan500, { ...scan500.body, error: errorOf(70_000) }));
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("unrecognised_engine_answer");
    expect(res.body.runId).toBe(scan500.body.run_id);
    expect(rowsWritten).toBe(0);
    expect(abortCalls()).toEqual([`POST /api/scans/${scan500.body.run_id}/abort`]);
    expect(res.body.error.length).toBeLessThan(2_000);
  });

  const retestFx = load(PR71, "at-once-failed-after-registration");
  const retest500 = launchOf(retestFx, "/api/remediation/retest");
  for (const length of [332, 333, 10_000]) {
    it(`retest (derived: the recorded 500, state null, its error ${length} characters) watched with its Stop, nothing stopped`, async () => {
      engineState.retest = derive(retest500, { ...retest500.body, error: errorOf(length) });
      const { res } = await retest(retestFx);
      expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(202);
      expect(res.body).toMatchObject({ answer: "status", phase: "running", stoppable: true, engineRunId: retest500.body.run_id });
      expect(abortCalls()).toEqual([]);
      expect(res.body.error.length).toBeLessThanOrEqual(500);
      expect(res.body.error).toContain("OperationalError: database is locked");
    });
  }
});

describe("round 2 #4: a scan 2xx with an unread `answer` that names no run a stop can address says a run may be live", () => {
  const recorded = launchOf(load(PR71, "scan-at-once-then-completed"), "/api/scan");
  for (const [label, body] of [
    ["no run_id", (({ run_id: _r, ...rest }) => ({ ...rest, answer: "Status" }))(recorded.body)],
    ["run_id \"a/b\"", { ...recorded.body, answer: "Status", run_id: "a/b" }],
  ] as const) {
    it(`(derived: the recorded 202 with answer "Status" and ${label}, no X-Run-Id) refused, and names the kill switch and a failsafe pause`, async () => {
      const { res, rowsWritten } = await startWith(derive(recorded, body, {}));
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body.reason).toBe("unrecognised_engine_answer");
      expect(res.body.error).toContain("may be live");
      expect(res.body.error).toContain("kill switch");
      expect(res.body.error).toContain("failsafe pause");
      expect(res.body.mayStillBeRunning).toBe(true);
      expect(rowsWritten).toBe(0);
      expect(abortCalls()).toEqual([]);
    });
  }
});

describe("round 2 #5: an X-Run-Id sent more than once, or joined, names each run -- never \"A, B\"", () => {
  beforeEach(clearChecks);
  const scanFx = load(PR71, "scan-failed-after-registration");
  const scan500 = launchOf(scanFx, "/api/scan");
  const A = scan500.body.run_id as string;
  const recorded202 = launchOf(load(PR71, "scan-at-once-then-completed"), "/api/scan");
  const C = recorded202.body.run_id as string;
  for (const [label, headers] of [["sent twice", { "X-Run-Id": [A, R2_B] }], ["joined by a proxy", { "X-Run-Id": `${A}, ${R2_B}` }]] as const) {
    it(`scan 500 (derived: a body that is not JSON, the X-Run-Id ${label}) each run is stopped by its own id`, async () => {
      const { res, rowsWritten } = await startWith(derive(scan500, "Internal Server Error", headers as Record<string, string | string[]>));
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body.runIds).toEqual([A, R2_B]);
      expect(abortCalls().sort()).toEqual([`POST /api/scans/${A}/abort`, `POST /api/scans/${R2_B}/abort`].sort());
      expect(calls.some((one) => one.includes("%2C"))).toBe(false);
      expect(rowsWritten).toBe(0);
    });
    it(`scan 500 (derived: the recorded 500, state null, the X-Run-Id ${label}) not read as its body's run: refused, each stopped`, async () => {
      const { res, rowsWritten } = await startWith(derive(scan500, scan500.body, headers as Record<string, string | string[]>));
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body.runIds).toEqual([A, R2_B]);
      expect(calls.some((one) => one.includes("%2C"))).toBe(false);
      expect(rowsWritten).toBe(0);
    });
  }
  it("scan 202 (derived: the recorded 202, its X-Run-Id sent twice naming its run and another) refused, both stopped", async () => {
    const { res, rowsWritten } = await startWith(derive(recorded202, recorded202.body, { "X-Run-Id": [C, R2_B] }));
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.runIds).toEqual([C, R2_B]);
    expect(abortCalls().sort()).toEqual([`POST /api/scans/${C}/abort`, `POST /api/scans/${R2_B}/abort`].sort());
    expect(rowsWritten).toBe(0);
  });
  it("scan 202 (derived: the recorded 202, its X-Run-Id sent twice naming its own run both times) read as that one run", async () => {
    const { res, rowsWritten } = await startWith(derive(recorded202, recorded202.body, { "X-Run-Id": [C, C] }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.runId).toBe(C);
    expect(rowsWritten).toBe(1);
    expect(abortCalls()).toEqual([]);
  });
  it("retest 202 (derived: the recorded 202 status, its X-Run-Id sent twice naming its run and another) refused, both stopped, no watch", async () => {
    engineState.retest = derive(r2Launch, r2Launch.body, { "X-Run-Id": [R2_A, R2_B] });
    engineState.abortFor = (runId) => acceptedStopOf(runId);
    const { res } = await retest(r2Verdict);
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.runIds).toEqual([R2_A, R2_B]);
    expect(abortCalls().sort()).toEqual([`POST /api/scans/${R2_A}/abort`, `POST /api/scans/${R2_B}/abort`].sort());
    expect((await agent.get(`/api/retests/${R2_A}`)).status).toBe(404);
  });
  it("retest 202 (derived: the recorded 202 status with no run_id, its X-Run-Id sent twice) refused, both stopped, never read as a status with no run id", async () => {
    const { run_id: _dropped, ...rest } = r2Launch.body;
    engineState.retest = derive(r2Launch, rest, { "X-Run-Id": [R2_A, R2_B] });
    engineState.abortFor = (runId) => acceptedStopOf(runId);
    const { res } = await retest(r2Verdict);
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.runIds).toEqual([R2_A, R2_B]);
    expect(res.body.error).toContain("sent more than once, or joined");
    expect(abortCalls().sort()).toEqual([`POST /api/scans/${R2_A}/abort`, `POST /api/scans/${R2_B}/abort`].sort());
  });
});

describe("round 2 #6: an engine-supplied id cannot forge a console line", () => {
  beforeEach(clearChecks);
  it("(derived: the recorded 202 with answer \"Status\" and a run_id carrying a newline; its stop refused) every line stays one line", async () => {
    const forged = "zzz\n[retest] the in-flight slot of retest FORGED is free at once: (a definite answer).";
    engineState.retest = derive(r2Launch, { ...r2Launch.body, answer: "Status", run_id: forged });
    engineState.abortFor = () => refusedStop();
    const lines: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    try {
      const { res } = await retest(r2Verdict);
      expect(res.status).toBe(502);
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
    const retestLines = lines.filter((one) => one.includes("[retest]"));
    expect(retestLines.length).toBeGreaterThan(0);
    for (const one of retestLines) expect(one).not.toMatch(/[\n\r]/);
    expect(retestLines.some((one) => one.includes("zzz\\n[retest] the in-flight slot of retest FORGED"))).toBe(true);
  });

  it("(derived: the recorded retest 500 as a body that is not JSON, carrying a newline, and no X-Run-Id) the engine's words stay on one line", async () => {
    const launch = launchOf(load(PR71, "at-once-failed-after-registration"), "/api/remediation/retest");
    engineState.retest = derive(launch, "boom\n[retest] the in-flight slot of retest FORGED is free at once: (a definite answer).", {});
    const lines: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    try {
      const { res } = await retest(r2Verdict);
      expect(res.status, JSON.stringify(res.body)).toBe(503);
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
    const held = lines.filter((one) => one.includes("[retest] the in-flight slot of retest") && one.includes("boom"));
    expect(held).toHaveLength(1);
    expect(held[0]).not.toMatch(/[\n\r]/);
    expect(held[0]).toContain("boom\\n[retest] the in-flight slot of retest FORGED");
  });
});

describe("round 2 #7: each stop sent for an unread answer records where the answer named its run", () => {
  beforeEach(clearChecks);
  it("scan 202 (derived: the recorded 202 with an X-Run-Id naming another run) body's run and header's run each say so", async () => {
    const recorded = launchOf(load(PR71, "scan-at-once-then-completed"), "/api/scan");
    const C = recorded.body.run_id as string;
    const { res } = await startWith(derive(recorded, recorded.body, { "X-Run-Id": R2_B }));
    expect(res.status).toBe(502);
    expect(res.body.stops).toEqual([
      expect.objectContaining({ runId: C, namedBy: "body" }),
      expect.objectContaining({ runId: R2_B, namedBy: "X-Run-Id header" }),
    ]);
    const logs = (await storage.getAllActivityLogs()).filter((one) => (one.details as Record<string, unknown> | null)?.via === "start_not_recorded");
    const byRun = (id: string) => logs.filter((one) => one.entityId === id).at(-1)!.details as Record<string, unknown>;
    expect(byRun(C).namedBy).toBe("body");
    expect(String(byRun(C).note)).toContain("named by the answer's body");
    expect(byRun(R2_B).namedBy).toBe("X-Run-Id header");
    expect(String(byRun(R2_B).note)).toContain("named by the answer's X-Run-Id header");
  });
  it("scan 500 (derived: the recorded 500 with answer \"Status\", its recorded X-Run-Id naming the same run) named by both", async () => {
    const recorded = launchOf(load(PR71, "scan-failed-after-registration"), "/api/scan");
    const { res } = await startWith(derive(recorded, { ...recorded.body, answer: "Status" }));
    expect(res.status).toBe(502);
    expect(res.body.stops).toEqual([expect.objectContaining({ runId: recorded.body.run_id, namedBy: "body and X-Run-Id header" })]);
  });
  it("retest (derived: the recorded 202 status naming A, an X-Run-Id naming B) the stops and their records say which", async () => {
    engineState.retest = derive(r2Launch, r2Launch.body, { "X-Run-Id": R2_B });
    engineState.abortFor = (runId) => acceptedStopOf(runId);
    const { res, testId } = await retest(r2Verdict);
    expect(res.status).toBe(502);
    expect(res.body.stops).toEqual([
      expect.objectContaining({ runId: R2_A, namedBy: "body" }),
      expect.objectContaining({ runId: R2_B, namedBy: "X-Run-Id header" }),
    ]);
    const logs = (await storage.getAllActivityLogs())
      .filter((one) => one.entityId === testId && (one.details as Record<string, unknown> | null)?.via === "start_not_recorded")
      .map((one) => one.details as Record<string, unknown>);
    expect(logs.find((one) => one.runId === R2_A)?.namedBy).toBe("body");
    expect(logs.find((one) => one.runId === R2_B)?.namedBy).toBe("X-Run-Id header");
  });
});

describe("round 2 #3: a run an unread retest answer named, whose stop did not take, keeps its Stop", () => {
  beforeEach(clearChecks);
  async function refusedRun() {
    engineState.retest = derive(r2Launch, { ...r2Launch.body, answer: "Status" });
    engineState.abortFor = () => refusedStop();
    const done = await retest(r2Verdict);
    expect(done.res.status, JSON.stringify(done.res.body)).toBe(502);
    expect(done.res.body.stoppable).toEqual([R2_A]);
    expect(done.res.body.error).toContain("keeps its Stop");
    return done;
  }

  it("(derived: the recorded 202 with answer \"Status\"; its stop refused, the recorded 503) listed on the finding's retests with a Stop that stops it", async () => {
    const { testId, finding } = await refusedRun();
    const open = await agent.get(`/api/tests/${testId}/retests`);
    const kept = (open.body.retests as Array<Record<string, unknown>>).find((one) => one.engineRunId === R2_A);
    expect(kept).toMatchObject({ answer: "status", phase: "running", stoppable: true, twinId: r2Twin, unreadAnswer: true });
    expect(String(kept!.detail)).toContain("may still be running");
    expect(String(kept!.detail)).toContain("kill switch");
    const view = await agent.get(`/api/retests/${R2_A}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ phase: "running", stoppable: true });
    // One retest of a finding at a time: its run may still be going.
    engineState.retest = null;
    const again = await agent.post(`/api/tests/${testId}/retest`).send({ twinId: r2Twin });
    expect(again.status).toBe(409);
    // Its Stop, pressed: sent again, and taken this time.
    engineState.abortFor = (runId) => acceptedStopOf(runId);
    const before = abortCalls().length;
    const stop = await agent.post(`/api/retests/${R2_A}/abort`);
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    expect(stop.body).toMatchObject({ stopped: true, runId: R2_A });
    expect(abortCalls().length).toBe(before + 1);
    const after = await agent.get(`/api/retests/${R2_A}`);
    expect(after.body).toMatchObject({ phase: "stopped", stoppable: false });
    const reopened = await agent.get(`/api/tests/${testId}/retests`);
    expect((reopened.body.retests as Array<Record<string, unknown>>).some((one) => one.engineRunId === R2_A)).toBe(false);
    // Nothing is read or filed from it.
    expect(await storage.getChecks(finding.id)).toEqual([]);
    expect(calls.filter((one) => one === `GET /api/scans/${R2_A}`)).toEqual([]);
  });

  it("(derived: as above) once its held slot is freed, the kept Stop still refuses a second retest of the finding", async () => {
    const { testId } = await refusedRun();
    const held = locals.retestsHeld as Map<string, unknown>;
    expect(held.has(`${testId}:${r2Twin}`)).toBe(true);
    // Freed as the status poll frees it once the engine lists no live retest on the target (or at the ceiling).
    held.clear();
    engineState.retest = null;
    const sent = retestCalls().length;
    const again = await agent.post(`/api/tests/${testId}/retest`).send({ twinId: r2Twin });
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.reason).toBe("retest_running");
    expect(retestCalls().length).toBe(sent);
  });

  it("(derived: as above) the kill switch sends it a stop, though the engine lists nothing", async () => {
    await refusedRun();
    engineState.abortFor = (runId) => acceptedStopOf(runId);
    const before = abortCalls().filter((one) => one === `POST /api/scans/${R2_A}/abort`).length;
    const engaged = await agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
    try {
      expect(engaged.status, JSON.stringify(engaged.body)).toBe(200);
      expect(abortCalls().filter((one) => one === `POST /api/scans/${R2_A}/abort`).length).toBe(before + 1);
      expect((await agent.get(`/api/retests/${R2_A}`)).body).toMatchObject({ phase: "stopped", stoppable: false });
    } finally {
      await agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "operational" });
    }
  });
});

// ---- Round 3 ----
// Recorded answers as before; "derived" where a field, a header or how the
// answer arrived (a body that never ends, no answer at all) was changed. The
// engine's 404 to a stop by a run id it has no record of is recorded
// (pr71-f4610ae/abort-unknown-run.json).

const unknownRunStop = () => abortsOf(load(PR71, "abort-unknown-run"))[0];
/** derived: the recorded "not running" Stop answer (running-then-stopped's second stop), its run_id set to this run. */
const notRunningStopOf = (runId: string) => {
  const one = abortsOf(load(PR71, "running-then-stopped"))[1];
  return derive(one, { ...one.body, run_id: runId });
};
const heldSlots = () => locals.retestsHeld as Map<string, unknown>;
const handleStore = () => locals.unreadRunHandles as Map<string, { runId: string; testId: string; since: Date }>;
const listed = async (testId: string) =>
  ((await agent.get(`/api/tests/${testId}/retests`)).body.retests as Array<Record<string, unknown>>).map((one) => one.engineRunId);

/** A retest whose answer (the recorded 202 with answer "Status") names R2_A, whose stop the engine refused (the recorded 503): a kept Stop. */
async function keptStop() {
  engineState.retest = derive(r2Launch, { ...r2Launch.body, answer: "Status" });
  engineState.abortFor = () => refusedStop();
  const done = await retest(r2Verdict);
  expect(done.res.status, JSON.stringify(done.res.body)).toBe(502);
  expect(done.res.body.stoppable).toEqual([R2_A]);
  expect(await listed(done.testId)).toContain(R2_A);
  return done;
}

async function anAccount(name: string) {
  const made = await agent.post("/api/users").send({ username: name, password: "a-long-enough-password", role: "user", email: `${name}@r3.test` });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return signIn(theApp, name, "a-long-enough-password");
}

describe("round 3 #1 (M1): a scan start that may have reached the engine is never \"did not start\"", () => {
  beforeEach(clearChecks);
  const recorded202 = launchOf(load(PR71, "scan-at-once-then-completed"), "/api/scan");
  const C = recorded202.body.run_id as string;
  const mayRun = (res: { status: number; body: Record<string, unknown> }, reason: string) => {
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body.mayStillBeRunning).toBe(true);
    expect(res.body.reason).toBe(reason);
    expect(String(res.body.error)).toContain("may still be running");
    expect(String(res.body.error)).toContain("kill switch");
    expect(String(res.body.error)).toContain("failsafe pause");
  };

  it("(derived: the engine never answers the start within the call's time) the scan may still be running", async () => {
    const eng = await import("../server/engine");
    const was = eng.engineTimeouts.callMs;
    eng.engineTimeouts.callMs = 300;
    engineState.custom = (req, _res, url) => req.method === "POST" && url === "/api/scan";
    try {
      const { res, rowsWritten } = await startWith(recorded202);
      mayRun(res, "scan_unanswered");
      expect(rowsWritten).toBe(0);
    } finally {
      eng.engineTimeouts.callMs = was;
    }
  });

  it("(derived: engine main's unhandled 500, Starlette's text body, no X-Run-Id) the scan may still be running", async () => {
    const { res, rowsWritten } = await startWith({ ...derive(recorded202, "Internal Server Error", {}), status: 500 });
    mayRun(res, "scan_unconfirmed");
    expect(rowsWritten).toBe(0);
    expect(abortCalls()).toEqual([]);
  });

  it("(derived: the recorded 503 not-admitted, as a 5xx that names no run) the scan may still be running -- as a retest's 503 is", async () => {
    const { res } = await startWith(scenarioOf(load(PR71, "scan-not-admitted"))[0]);
    mayRun(res, "scan_unconfirmed");
  });

  it("(derived: the recorded 202's headers, its body never finished, no X-Run-Id) the scan may still be running", async () => {
    const eng = await import("../server/engine");
    const was = eng.engineTimeouts.bodyMs;
    eng.engineTimeouts.bodyMs = 300;
    engineState.custom = (req, res, url) => {
      if (!(req.method === "POST" && url === "/api/scan")) return false;
      res.writeHead(202, { "Content-Type": "application/json" });
      res.write(JSON.stringify(recorded202.body).slice(0, 20));
      return true;
    };
    try {
      const { res, rowsWritten } = await startWith(recorded202);
      mayRun(res, "scan_unconfirmed");
      expect(rowsWritten).toBe(0);
    } finally {
      eng.engineTimeouts.bodyMs = was;
    }
  });

  it("(derived: the recorded 202's headers with an X-Run-Id naming its run, its body never finished) that run is sent a stop", async () => {
    const eng = await import("../server/engine");
    const was = eng.engineTimeouts.bodyMs;
    eng.engineTimeouts.bodyMs = 300;
    engineState.custom = (req, res, url) => {
      if (!(req.method === "POST" && url === "/api/scan")) return false;
      res.writeHead(202, { "Content-Type": "application/json", "X-Run-Id": C });
      res.write(JSON.stringify(recorded202.body).slice(0, 20));
      return true;
    };
    engineState.abortFor = () => refusedStop();
    try {
      const { res, rowsWritten } = await startWith(recorded202);
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body.runIds).toEqual([C]);
      expect(res.body.stops).toEqual([expect.objectContaining({ runId: C, stopped: false, namedBy: "X-Run-Id header" })]);
      expect(res.body.mayStillBeRunning).toBe(true);
      expect(abortCalls()).toEqual([`POST /api/scans/${C}/abort`]);
      expect(rowsWritten).toBe(0);
    } finally {
      eng.engineTimeouts.bodyMs = was;
    }
  });

  it("the recorded 500 whose run failed before its work started, and the recorded 429: did not start, and never said to be running", async () => {
    for (const name of ["scan-failed-before-start", "scan-queue-full"]) {
      const { res } = await startScan(load(PR71, name));
      expect(res.status, name).toBe(503);
      expect(res.body.mayStillBeRunning, name).toBeUndefined();
      expect(res.body.reason, name).toBeUndefined();
    }
  });

  it("(derived: the recorded 202 naming A, its X-Run-Id naming B; A's stop taken, B's refused) the scan may still be running (pins R13)", async () => {
    engineState.abortFor = (runId) => (runId === C ? acceptedStopOf(C) : refusedStop());
    const { res } = await startWith(derive(recorded202, recorded202.body, { "X-Run-Id": R2_B }));
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.stops).toEqual([
      expect.objectContaining({ runId: C, stopped: true }),
      expect.objectContaining({ runId: R2_B, stopped: false }),
    ]);
    expect(res.body.mayStillBeRunning).toBe(true);
  });

  it("(derived: as above, both stops taken) nothing may still be running: not said", async () => {
    engineState.abortFor = (runId) => acceptedStopOf(runId);
    const { res } = await startWith(derive(recorded202, recorded202.body, { "X-Run-Id": R2_B }));
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.mayStillBeRunning).toBeUndefined();
    expect(res.body.runIds).toEqual([C, R2_B]);
  });
});

describe("round 3 #3: a retest 2xx unread answer whose run_id no stop can address holds its slot", () => {
  beforeEach(clearChecks);
  for (const [label, runId] of [['run_id "a/b"', "a/b"], ["run_id 1.5", 1.5]] as const) {
    it(`(derived: the recorded 202 with answer "Status" and ${label}) may still be running, its slot held, a second Retest refused`, async () => {
      engineState.retest = derive(r2Launch, { ...r2Launch.body, answer: "Status", run_id: runId });
      const { res, testId } = await retest(r2Verdict);
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body.mayStillBeRunning).toBe(true);
      expect(res.body.held).toContain("may still be running");
      expect(res.body.error).toContain("kill switch");
      expect(abortCalls()).toEqual([]);
      expect(heldSlots().has(`${testId}:${r2Twin}`)).toBe(true);
      engineState.retest = null;
      const sent = retestCalls().length;
      const again = await agent.post(`/api/tests/${testId}/retest`).send({ twinId: r2Twin });
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      expect(retestCalls().length).toBe(sent);
    });
  }

  it("(derived: the engine never answers the retest within the call's time) 503 retest_unanswered, may still be running (pins R19)", async () => {
    const eng = await import("../server/engine");
    const was = eng.engineTimeouts.callMs;
    engineState.custom = (req, _res, url) => req.method === "POST" && url === "/api/remediation/retest" && eng.engineTimeouts.callMs === 300;
    try {
      engineState.fixture = r2Verdict;
      const { clientId, siteId } = await aClientAndSite();
      const started = await agent.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
      expect(started.status).toBe(201);
      eng.engineTimeouts.callMs = 300;
      const res = await agent.post(`/api/tests/${started.body.test.id}/retest`).send({ twinId: r2Twin });
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.reason).toBe("retest_unanswered");
      expect(res.body.mayStillBeRunning).toBe(true);
    } finally {
      eng.engineTimeouts.callMs = was;
    }
  });
});

describe("round 3 #4: a kept Stop the engine answers \"No such scan run\" ends, said as that", () => {
  beforeEach(clearChecks);

  it("the recorded 404 to a stop: the handle ends (not known to the engine), and the finding can be retested again", async () => {
    const { testId, finding } = await keptStop();
    engineState.abortFor = () => unknownRunStop();
    const stop = await agent.post(`/api/retests/${R2_A}/abort`);
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    expect(stop.body).toMatchObject({ stopped: false, unknownRun: true, runId: R2_A });
    expect(stop.body.detail).toContain("does not know this run");
    const view = (await agent.get(`/api/retests/${R2_A}`)).body;
    expect(view).toMatchObject({ phase: "not_known", stoppable: false, stopAcceptedAt: null });
    expect(view.detail).toContain("does not know");
    expect(view.detail).not.toMatch(/accepted the stop/);
    expect(await listed(testId)).not.toContain(R2_A);
    // Every run the unread answer named has ended here: its slot is free, and Retest is sent.
    expect(heldSlots().has(`${testId}:${r2Twin}`)).toBe(false);
    engineState.retest = null;
    engineState.abortFor = null;
    const sent = retestCalls().length;
    const again = await agent.post(`/api/tests/${testId}/retest`).send({ twinId: r2Twin });
    expect(again.status, JSON.stringify(again.body)).not.toBe(409);
    expect(retestCalls().length).toBe(sent + 1);
    const logged = (await storage.getAllActivityLogs()).filter((one) => one.action === "abort_run_unknown");
    expect(logged.length).toBeGreaterThan(0);
    expect(await storage.getChecks(finding.id)).toEqual([]);
  });

  it("the kill switch's stop answered the recorded 404: the handle ends too", async () => {
    await keptStop();
    engineState.abortFor = () => unknownRunStop();
    const engaged = await agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
    try {
      expect(engaged.status, JSON.stringify(engaged.body)).toBe(200);
      expect((await agent.get(`/api/retests/${R2_A}`)).body).toMatchObject({ phase: "not_known", stoppable: false });
    } finally {
      await agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "operational" });
    }
  });

  it("an admin can clear a kept Stop (nothing is sent), anyone else cannot; the finding can then be retested", async () => {
    const { testId } = await keptStop();
    const other = await anAccount("r3-clearer");
    const refused = await other.post(`/api/retests/${R2_A}/clear`);
    expect(refused.status).toBe(403);
    expect((await agent.get(`/api/retests/${R2_A}`)).body.phase).toBe("running");
    const sent = abortCalls().length;
    const cleared = await agent.post(`/api/retests/${R2_A}/clear`);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.cleared).toBe(1);
    expect(abortCalls().length).toBe(sent);
    expect((await agent.get(`/api/retests/${R2_A}`)).body).toMatchObject({ phase: "cleared", stoppable: false });
    expect(await listed(testId)).not.toContain(R2_A);
    expect(heldSlots().has(`${testId}:${r2Twin}`)).toBe(false);
    engineState.retest = null;
    engineState.abortFor = null;
    const again = await agent.post(`/api/tests/${testId}/retest`).send({ twinId: r2Twin });
    expect(again.status, JSON.stringify(again.body)).not.toBe(409);
    expect((await agent.post(`/api/retests/${R2_A}/clear`)).status).toBe(404);
    expect((await storage.getAllActivityLogs()).some((one) => one.action === "retest_stop_cleared" && one.entityId === testId)).toBe(true);
  });
});

describe("round 3 #5: a kept Stop for a run that ended on its own reads \"Already finished\", never \"Stopped\" (pins R4)", () => {
  beforeEach(clearChecks);
  it("(derived: the recorded 'not running' stop answer) already finished: not stopped, not accepted, no longer blocking", async () => {
    const { testId } = await keptStop();
    engineState.abortFor = (runId) => notRunningStopOf(runId);
    const stop = await agent.post(`/api/retests/${R2_A}/abort`);
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ stopped: false, alreadyFinished: true });
    const view = (await agent.get(`/api/retests/${R2_A}`)).body;
    expect(view).toMatchObject({ phase: "already_finished", stoppable: false, stopAcceptedAt: null });
    expect(view.detail).toMatch(/^Already finished/);
    expect(view.detail).not.toMatch(/accepted the stop/);
    expect(await listed(testId)).not.toContain(R2_A);
    expect(heldSlots().has(`${testId}:${r2Twin}`)).toBe(false);
  });
});

describe("round 3 #6: the kept Stop's rules, each pinned", () => {
  beforeEach(clearChecks);

  it("its requester, not an admin, can press it; another account cannot (pins R3)", async () => {
    const requester = await anAccount("r3-requester");
    const stranger = await anAccount("r3-stranger");
    engineState.fixture = r2Verdict;
    engineState.statusReads = statusReadsOf(r2Verdict);
    const { clientId, siteId } = await aClientAndSite();
    const started = await agent.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
    expect(started.status).toBe(201);
    engineState.retest = derive(r2Launch, { ...r2Launch.body, answer: "Status" });
    engineState.abortFor = () => refusedStop();
    const res = await requester.post(`/api/tests/${started.body.test.id}/retest`).send({ twinId: r2Twin });
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.stoppable).toEqual([R2_A]);
    const sent = abortCalls().length;
    expect((await stranger.post(`/api/retests/${R2_A}/abort`)).status).toBe(403);
    expect(abortCalls().length).toBe(sent);
    engineState.abortFor = (runId) => acceptedStopOf(runId);
    const own = await requester.post(`/api/retests/${R2_A}/abort`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.stopped).toBe(true);
    expect(abortCalls().length).toBe(sent + 1);
  });

  it("it is listed on its own test's retests only (pins R5)", async () => {
    const { testId } = await keptStop();
    engineState.retest = null;
    engineState.abortFor = null;
    // Another test, which no retest was run from.
    const { clientId, siteId } = await aClientAndSite();
    const other = await agent.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
    expect(other.status).toBe(201);
    expect(await listed(other.body.test.id)).toEqual([]);
    expect(await listed(testId)).toContain(R2_A);
  });

  it("it blocks a second retest of its own finding only, not another finding of the test (derived: a second twin id) (pins R6)", async () => {
    const { testId } = await keptStop();
    engineState.retest = null;
    engineState.abortFor = null;
    const sent = retestCalls().length;
    const otherTwin = await agent.post(`/api/tests/${testId}/retest`).send({ twinId: r2Twin + 1 });
    expect(otherTwin.status, JSON.stringify(otherTwin.body)).not.toBe(409);
    expect(retestCalls().length).toBe(sent + 1);
  });

  it("(derived: its stop answered 200, the rest of that answer never sent) a stop whose answer was not read keeps the Stop (pins R7)", async () => {
    const eng = await import("../server/engine");
    const was = eng.engineTimeouts.abortBodyMs;
    eng.engineTimeouts.abortBodyMs = 150;
    try {
      engineState.retest = derive(r2Launch, { ...r2Launch.body, answer: "Status" });
      engineState.abortFor = () => "stall";
      const { res, testId } = await retest(r2Verdict);
      expect(res.status).toBe(502);
      expect(res.body.stoppable).toEqual([R2_A]);
      expect(await listed(testId)).toContain(R2_A);
    } finally {
      eng.engineTimeouts.abortBodyMs = was;
    }
  });

  it("it is forgotten after the time a watch is kept, and blocks nothing after (pins R8)", async () => {
    const { testId } = await keptStop();
    // Kept since the epoch: far longer ago than a watch is kept (retestWatch.keepUnwatchedMs).
    for (const one of handleStore().values()) one.since = new Date(0);
    heldSlots().clear();
    expect(await listed(testId)).not.toContain(R2_A);
    expect(handleStore().size).toBe(0);
    expect((await agent.get(`/api/retests/${R2_A}`)).status).toBe(404);
    engineState.retest = null;
    engineState.abortFor = null;
    const again = await agent.post(`/api/tests/${testId}/retest`).send({ twinId: r2Twin });
    expect(again.status, JSON.stringify(again.body)).not.toBe(409);
  });

  it("(derived: the recorded 202 with answer \"Status\" and a run_id carrying U+2028 and U+2029; its stop refused) each is escaped on the console (pins R10)", async () => {
    const forged = "zzz\u2028[retest] FORGED\u2029line";
    engineState.retest = derive(r2Launch, { ...r2Launch.body, answer: "Status", run_id: forged });
    engineState.abortFor = () => refusedStop();
    const lines: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    try {
      const { res } = await retest(r2Verdict);
      expect(res.status).toBe(502);
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
    const retestLines = lines.filter((one) => one.includes("[retest]") && one.includes("zzz"));
    expect(retestLines.length).toBeGreaterThan(0);
    for (const one of retestLines) {
      expect(one).not.toMatch(/[\u2028\u2029]/);
      expect(one).toContain("zzz\\u2028[retest] FORGED\\u2029line");
    }
  });
});

describe("round 3 #7: an answer's runs are capped, keyed per test, and a quoted X-Run-Id is its id", () => {
  beforeEach(clearChecks);
  const nine = Array.from({ length: 9 }, (_v, i) => `r3-run-${i}`);

  it("(derived: the recorded 202 status, its X-Run-Id joined from 9 runs; stops refused) refused, no stop sent, no Stop kept, the kill switch named", async () => {
    engineState.retest = derive(r2Launch, { ...r2Launch.body, answer: "Status" }, { "X-Run-Id": nine.join(", ") });
    engineState.abortFor = () => refusedStop();
    const { res, testId } = await retest(r2Verdict);
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(abortCalls()).toEqual([]);
    expect(handleStore().size).toBe(0);
    expect(res.body.error).toContain("more than the 8 one answer may name");
    expect(res.body.error).toContain("kill switch");
    expect(res.body.mayStillBeRunning).toBe(true);
    expect(heldSlots().has(`${testId}:${r2Twin}`)).toBe(true);
    expect(String(res.body.error).length).toBeLessThan(2_000);
  });

  it("(derived: the recorded 202 status, its X-Run-Id naming 7 more runs: 8 in all) each of the 8 is sent its stop", async () => {
    engineState.retest = derive(r2Launch, { ...r2Launch.body, answer: "Status" }, { "X-Run-Id": [R2_A, ...nine.slice(0, 7)].join(", ") });
    engineState.abortFor = (runId) => acceptedStopOf(runId);
    const { res } = await retest(r2Verdict);
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(abortCalls()).toHaveLength(8);
  });

  it("(derived: the recorded scan 202, its X-Run-Id joined from 9 runs) refused, nothing recorded, no stop sent, may still be running", async () => {
    const recorded = launchOf(load(PR71, "scan-at-once-then-completed"), "/api/scan");
    const { res, rowsWritten } = await startWith(derive(recorded, recorded.body, { "X-Run-Id": nine.join(",") }));
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.mayStillBeRunning).toBe(true);
    expect(res.body.error).toContain("more than the 8");
    expect(abortCalls()).toEqual([]);
    expect(rowsWritten).toBe(0);
  });

  it("two tests' answers naming the same run each keep their own Stop: one never overwrites the other", async () => {
    const first = await keptStop();
    const second = await keptStop();
    expect(second.testId).not.toBe(first.testId);
    expect(await listed(first.testId)).toContain(R2_A);
    expect(await listed(second.testId)).toContain(R2_A);
    engineState.retest = null;
    const again = await agent.post(`/api/tests/${first.testId}/retest`).send({ twinId: r2Twin });
    expect(again.status).toBe(409);
    // One Stop ends both: the stop is the run's.
    engineState.abortFor = (runId) => acceptedStopOf(runId);
    expect((await agent.post(`/api/retests/${R2_A}/abort`)).status).toBe(200);
    expect(await listed(first.testId)).not.toContain(R2_A);
    expect(await listed(second.testId)).not.toContain(R2_A);
  });

  it("(derived: the recorded 500, state null, its X-Run-Id the same id in quotes) read as that run: recorded running, no stop to the quoted id", async () => {
    const scan500 = launchOf(load(PR71, "scan-failed-after-registration"), "/api/scan");
    const id = scan500.body.run_id as string;
    const { res, rowsWritten } = await startWith(derive(scan500, scan500.body, { "x-run-id": `"${id}"` }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.runId).toBe(id);
    expect(rowsWritten).toBe(1);
    expect(calls.some((one) => one.includes("%22"))).toBe(false);
  });

  it("(derived: the recorded 202's body replaced by [], its X-Run-Id its run's id in quotes) that run is sent a stop by its id, unquoted", async () => {
    const recorded = launchOf(load(PR71, "scan-at-once-then-completed"), "/api/scan");
    const C = recorded.body.run_id as string;
    const { res, rowsWritten } = await startWith(derive(recorded, "[]", { "x-run-id": `"${C}"` }));
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.runIds).toEqual([C]);
    expect(abortCalls()).toEqual([`POST /api/scans/${C}/abort`]);
    expect(rowsWritten).toBe(0);
  });

  it("(derived: the recorded 202's body replaced by {}, its X-Run-Id a quoted id with a quote inside) names no run: no stop is sent to it", async () => {
    const recorded = launchOf(load(PR71, "scan-at-once-then-completed"), "/api/scan");
    const { res } = await startWith(derive(recorded, {}, { "x-run-id": "\"a\"b\"" }));
    // As a 202 {} naming no run: recorded running with no Stop, pointed at the kill switch and a failsafe pause.
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.runId).toBeNull();
    expect(res.body.stop).toBe("failsafe");
    expect(abortCalls()).toEqual([]);
    expect(calls.some((one) => one.includes("%22"))).toBe(false);
  });
});

describe("round 3 #9: a stop the engine refuses lets its answer go", () => {
  it("(derived: a 503 to a stop whose body never ends) the connection is closed from this side, not left holding a socket", async () => {
    let closed = false;
    engineState.custom = (req, res, url) => {
      if (!(req.method === "POST" && url === "/api/scans/r3-refused/abort")) return false;
      req.socket.on("close", () => { closed = true; });
      res.writeHead(503, { "Content-Type": "application/json" });
      res.write("{\"detail\": \"the registry is ");
      return true;
    };
    const stop = await agent.post("/api/retests/r3-refused/abort");
    expect(stop.status, JSON.stringify(stop.body)).toBe(502);
    expect(await until(async () => closed, (done) => done)).toBe(true);
  });

  it("(derived: a 404 to a stop whose body never ends) read no longer than a stop's answer is, refused, and let go", async () => {
    const eng = await import("../server/engine");
    const was = eng.engineTimeouts.abortBodyMs;
    eng.engineTimeouts.abortBodyMs = 150;
    let closed = false;
    engineState.custom = (req, res, url) => {
      if (!(req.method === "POST" && url === "/api/scans/r3-proxy/abort")) return false;
      req.socket.on("close", () => { closed = true; });
      res.writeHead(404, { "Content-Type": "application/json" });
      res.write("{\"detail\": \"No such");
      return true;
    };
    try {
      const stop = await agent.post("/api/retests/r3-proxy/abort");
      expect(stop.status, JSON.stringify(stop.body)).toBe(502);
      expect(await until(async () => closed, (done) => done)).toBe(true);
    } finally {
      eng.engineTimeouts.abortBodyMs = was;
    }
  });
});
