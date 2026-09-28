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
  headers?: Record<string, string>;
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

const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
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
} = { fixture: null, scan: null, statusReads: [], aborts: [], retest: null, abortHold: null };

const calls: string[] = [];

let engine: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let watcher: import("../server/retests").RetestWatcher;

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      const url = req.url ?? "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      calls.push(`${req.method} ${url}`);
      const fx = engineState.fixture;
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") return json(res, 200, { active: [] });
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
  watcher = app.locals.retestWatcher;
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
  calls.length = 0;
  watcher.reset();
  (storage as unknown as { retestWatches: Map<string, unknown> }).retestWatches.clear();
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
