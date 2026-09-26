import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import type { IStorage } from "../server/storage";
import { makeApp, signIn } from "./helpers";

/**
 * athena-engine #71 changes what `/api/remediation/retest` answers, and this
 * dashboard reads both what it answers there and what engine main answers.
 *
 * On #71 an answer is a VERDICT (`answer: "verdict"`, 201: `run_id` the
 * abort-registry id, `scan_record_id` the record) or a STATUS (`answer:
 * "status"`: 202 while it runs, 200 stopped / failed / no verdict, 429 queue
 * full) -- and a status is never a verdict. On main (no `answer`) the verdict
 * comes back synchronously with the record id under `run_id`.
 *
 * Every engine answer here is one the real engine app sent: the JSON files in
 * tests/fixtures/engine-retest were recorded by driving athena-engine at
 * 143279e (#71's head) and at 5779e99 (main) through TestClient, and
 * tests/fixtures/engine-retest/generate.py records them again. Ids are read
 * from the files, never assumed.
 *
 * What this holds the dashboard to:
 *   - a check is filed, a finding changed, and a fix claimed only from a verdict;
 *   - the fix and the check name the scan record (`scan_record_id` on #71,
 *     `run_id` on main), never the registry id a stop names;
 *   - a 202 is shown running, with a Stop that aborts the engine's run by its
 *     `run_id`, and is watched until it ends: a verdict is then filed once, a
 *     stop or a failure files nothing;
 *   - no status read -- in flight, slow or failed -- delays that Stop;
 *   - the kill switch reaches a running retest, by the engine's list and
 *     without it; "Scans running now" reads it from the engine's list;
 *   - on main, the retest is read and filed exactly as it always was, and
 *     `wait_seconds` (which main refuses) is never sent.
 */

type Exchange = {
  note: string;
  request: { method: string; path: string; body?: Record<string, unknown> };
  status: number;
  body: any;
  headers?: Record<string, string>;
};
type Fixture = { engine: { sha: string; contract: string }; scenario: string; exchanges: Exchange[] };

const FIXTURES = path.resolve(__dirname, "fixtures", "engine-retest");
const PR71 = "pr71-143279e";
const MAIN = "main-5779e99";

function load(dir: string, name: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, `${name}.json`), "utf8")) as Fixture;
}

/** The exchanges of a fixture whose request matches, in order. */
function all(fx: Fixture, method: string, test: (p: string) => boolean): Exchange[] {
  return fx.exchanges.filter((one) => one.request.method === method && test(one.request.path));
}
const retestOf = (fx: Fixture) => all(fx, "POST", (p) => p === "/api/remediation/retest")[0];
const statusReadsOf = (fx: Fixture) =>
  all(fx, "GET", (p) => /^\/api\/scans\/[^/]+$/.test(p) && p !== "/api/scans/active");
const abortsOf = (fx: Fixture) => all(fx, "POST", (p) => /^\/api\/scans\/[^/]+\/abort$/.test(p));
const activeOf = (fx: Fixture) => all(fx, "GET", (p) => p === "/api/scans/active")[0];

const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** What the stand-in engine answers: each from a fixture the real engine sent. */
const engineState: {
  fixture: Fixture | null;
  statusReads: Exchange[];
  /** While set, a status read is held open until it is released. */
  holdStatus: Promise<void> | null;
  active: Exchange | { status: number; body: unknown };
  abort: Exchange | null;
} = { fixture: null, statusReads: [], holdStatus: null, active: { status: 200, body: { active: [] } }, abort: null };

const calls: Array<{ line: string; body: Record<string, unknown>; at: number }> = [];

let engine: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let retests: typeof import("../server/retests");
let lifecycle: typeof import("../server/findings");

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      const url = req.url ?? "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      calls.push({ line: `${req.method} ${url}`, body, at: performance.now() });
      const fx = engineState.fixture;
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") return json(res, engineState.active.status, engineState.active.body);
      if (!fx) return json(res, 500, { detail: "no fixture" });
      const reply = (one: Exchange) => json(res, one.status, one.body, one.headers ?? {});
      if (req.method === "POST" && url === "/api/scan") return reply(fx.exchanges[0]);
      if (req.method === "GET" && url.startsWith("/api/decisions?")) return reply(fx.exchanges[1]);
      if (req.method === "POST" && url === "/api/remediation/retest") return reply(retestOf(fx));
      if (req.method === "POST" && /^\/api\/scans\/[^/]+\/abort$/.test(url)) {
        return engineState.abort ? reply(engineState.abort) : json(res, 404, { detail: "No such scan run" });
      }
      if (req.method === "GET" && /^\/api\/scans\/[^/]+$/.test(url)) {
        if (engineState.holdStatus) await engineState.holdStatus;
        const next = engineState.statusReads.length > 1 ? engineState.statusReads.shift()! : engineState.statusReads[0];
        return next ? reply(next) : json(res, 404, { detail: "No such scan run" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  agent = await signIn(await makeApp());
  storage = (await import("../server/storage-unified")).storage;
  retests = await import("../server/retests");
  lifecycle = await import("../server/findings");
  // Read fast, and give up soon: the bound is what is under test, not its size.
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
  engineState.statusReads = [];
  engineState.holdStatus = null;
  engineState.active = { status: 200, body: { active: [] } };
  engineState.abort = null;
  calls.length = 0;
  // Several cases retest the same recorded run id; each starts with no watch.
  retests.reset();
});

let clientCount = 0;

/** A client and site at the fixture's target, the scan that found the finding, and the finding it filed. */
async function aScannedFinding(fx: Fixture) {
  engineState.fixture = fx;
  clientCount += 1;
  const client = await agent.post("/api/clients")
    .send({ name: `Retested ${clientCount}`, company: "Retested Ltd", email: `r${clientCount}@example.test` });
  const site = await agent.post("/api/sites")
    .send({ clientId: client.body.id, name: "Main", url: "https://offline.invalid" });
  const target = fx.exchanges[0].body.target as string;
  const started = await agent.post("/api/scans").send({ clientId: client.body.id, siteId: site.body.id, target });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const twin = fx.exchanges[1].body.decisions[0];
  const key = lifecycle.fingerprint(client.body.id, {
    type: twin.finding_type, severity: null, message: null, target: twin.target, endpoint: twin.inputs.endpoint, header: null,
  });
  const finding = await storage.findFindingByFingerprint(client.body.id, key);
  expect(finding, "the scan filed the finding the twin is about").toBeDefined();
  return { testId: started.body.test.id as string, twinId: twin.id as number, finding: finding!, clientId: client.body.id as string };
}

async function retest(fx: Fixture) {
  const scanned = await aScannedFinding(fx);
  const res = await agent.post(`/api/tests/${scanned.testId}/retest`).send({ twinId: scanned.twinId });
  return { ...scanned, res };
}

async function checksOf(findingId: string) {
  return storage.getChecks(findingId);
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    last = await read();
  }
  return last;
}

describe("the fixtures are what the engine sent, at the commits they name", () => {
  it("each file names its engine commit, and the two contracts differ where #71 says they do", () => {
    const pr = load(PR71, "verdict-closed");
    const main = load(MAIN, "verdict-closed");
    expect(pr.engine).toEqual({ repository: "athena-engine", sha: "143279e5e9d680fecf48ddd7a926cd565dfb56a8", contract: "pr71" });
    expect(main.engine).toEqual({ repository: "athena-engine", sha: "5779e99eae1085f96e6c27ce28dbd950d8200aba", contract: "main" });
    expect(retestOf(pr).body.answer).toBe("verdict");
    expect(typeof retestOf(pr).body.run_id).toBe("string");
    expect(typeof retestOf(pr).body.scan_record_id).toBe("number");
    expect("answer" in retestOf(main).body).toBe(false);
    expect(typeof retestOf(main).body.run_id).toBe("number");
    // Main refuses the one field #71 added, so it is never sent.
    const refused = retestOf(load(MAIN, "wait-seconds-refused"));
    expect(refused.status).toBe(422);
    expect(refused.body.detail[0]).toMatchObject({ type: "extra_forbidden", loc: ["body", "wait_seconds"] });
  });
});

describe("athena-engine #71: a verdict is filed, a status never is", () => {
  it("201 verdict: filed against scan_record_id, and the registry id is kept only as the id a stop names", async () => {
    const fx = load(PR71, "verdict-closed");
    const answered = retestOf(fx).body;
    const { res, finding } = await retest(fx);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ answer: "verdict", verdict: "closed" });
    expect(res.body.runId).toBe(String(answered.scan_record_id));
    expect(res.body.engineRunId).toBe(answered.run_id);
    const after = await storage.getFinding(finding.id);
    expect(after!.fixedByRunId).toBe(String(answered.scan_record_id));
    expect(after!.fixedVerdict).toBe("closed");
    const checks = await checksOf(finding.id);
    expect(checks.map((one) => [one.verdict, one.runId])).toEqual([["closed", String(answered.scan_record_id)]]);
    // Only the engine's own request body: no wait_seconds, which main refuses.
    const sent = calls.find((one) => one.line === "POST /api/remediation/retest")!;
    expect(Object.keys(sent.body).sort()).toEqual(["engagement_ref", "scope", "twin_id"]);
  });

  it("201 still_open: its check names the record, and nothing is marked fixed", async () => {
    const fx = load(PR71, "verdict-still-open");
    const answered = retestOf(fx).body;
    const { res, finding } = await retest(fx);
    expect(res.body).toMatchObject({ answer: "verdict", verdict: "still_open", runId: String(answered.scan_record_id) });
    const checks = await checksOf(finding.id);
    expect(checks.map((one) => [one.verdict, one.runId])).toEqual([["still_open", String(answered.scan_record_id)]]);
    expect((await storage.getFinding(finding.id))!.fixedByRunId).toBeNull();
  });

  it("202, then the watch reads it to its verdict, which is filed once", async () => {
    const fx = load(PR71, "running-then-verdict");
    const accepted = retestOf(fx).body;
    const [running, finished] = statusReadsOf(fx);
    expect(running.body.done).toBe(false);
    // Held until the answer is checked, so the 202 is seen before the verdict.
    let release!: () => void;
    engineState.holdStatus = new Promise<void>((r) => { release = r; });
    engineState.statusReads = [running, finished];
    const { res, finding } = await retest(fx);

    expect(retestOf(fx).status).toBe(202);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ answer: "status", phase: "running", engineRunId: accepted.run_id, stoppable: true });
    expect(res.body.verdict).toBeUndefined();
    // A status files nothing and changes nothing.
    expect(await checksOf(finding.id)).toEqual([]);
    expect((await storage.getFinding(finding.id))!.status).toBe(finding.status);

    release();
    engineState.holdStatus = null;
    const watched = await until(
      () => agent.get(`/api/retests/${accepted.run_id}`).then((r) => r.body),
      (body) => body.phase !== "running",
    );
    expect(watched).toMatchObject({ answer: "verdict", phase: "verdict" });
    expect(watched.result).toMatchObject({ verdict: "closed", runId: String(finished.body.result.scan_record_id) });
    const checks = await checksOf(finding.id);
    expect(checks.map((one) => [one.verdict, one.runId])).toEqual([["closed", String(finished.body.result.scan_record_id)]]);
    expect((await storage.getFinding(finding.id))!.fixedByRunId).toBe(String(finished.body.result.scan_record_id));

    // The watch ended with the run: no more reads, and no second filing.
    const reads = calls.filter((one) => one.line === `GET /api/scans/${accepted.run_id}`).length;
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.filter((one) => one.line === `GET /api/scans/${accepted.run_id}`).length).toBe(reads);
    expect(await checksOf(finding.id)).toHaveLength(1);
  });

  it("202, then its Stop: the engine's run is aborted by its run_id, and the stopped run files nothing", async () => {
    const fx = load(PR71, "running-then-stopped");
    const accepted = retestOf(fx).body;
    const [aborting] = abortsOf(fx);
    const [stopped] = statusReadsOf(fx);
    // The stopped run's stored result is the runner's inconclusive verdict.
    // It is not a verdict on the finding, and it is not filed.
    expect(stopped.body.state).toBe("aborted");
    expect(stopped.body.result.verdict).toBe("inconclusive");

    // The watcher's first read is held until the Stop has been sent; it then
    // reads the run as the engine recorded it once stopped.
    let release!: () => void;
    engineState.holdStatus = new Promise<void>((r) => { release = r; });
    engineState.statusReads = [stopped];
    const { res, finding } = await retest(fx);
    expect(res.status).toBe(202);
    expect(res.body.engineRunId).toBe(accepted.run_id);

    engineState.abort = aborting;
    const stop = await agent.post(`/api/retests/${res.body.engineRunId}/abort`);
    expect(stop.status).toBe(200);
    expect(stop.body).toEqual({ stopped: true, runId: accepted.run_id });
    expect(calls.map((one) => one.line)).toContain(`POST /api/scans/${accepted.run_id}/abort`);

    expect(await checksOf(finding.id)).toEqual([]);
    release();
    engineState.holdStatus = null;
    const watched = await until(
      () => agent.get(`/api/retests/${accepted.run_id}`).then((r) => r.body),
      (body) => body.phase !== "running",
    );
    expect(watched).toMatchObject({ answer: "status", phase: "stopped", state: "aborted", reason: stopped.body.reason });
    expect(watched.result).toBeUndefined();
    expect(watched.detail).toMatch(/^Stopped \(stopped by an operator\) before it reached a verdict\. Nothing was filed/);
    expect(await checksOf(finding.id)).toEqual([]);
    const after = await storage.getFinding(finding.id);
    expect([after!.status, after!.fixedByRunId]).toEqual([finding.status, null]);
  });

  it("200 stopped during the inline wait: shown stopped, nothing filed, nothing watched", async () => {
    const fx = load(PR71, "stopped-while-waiting");
    const answered = retestOf(fx).body;
    expect(answered).toMatchObject({ answer: "status", state: "aborted" });
    const { res, finding } = await retest(fx);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ answer: "status", phase: "stopped", engineRunId: answered.run_id, stoppable: false });
    expect(res.body.verdict).toBeUndefined();
    expect(await checksOf(finding.id)).toEqual([]);
    expect((await agent.get(`/api/retests/${answered.run_id}`)).status).toBe(404);
  });

  it("200 failed: the engine's error is shown as it is, and nothing is filed", async () => {
    const fx = load(PR71, "failed");
    const answered = retestOf(fx).body;
    const { res, finding } = await retest(fx);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ answer: "status", phase: "failed", error: answered.error });
    expect(res.body.detail).toContain(answered.error);
    expect(await checksOf(finding.id)).toEqual([]);
  });

  it("202, then a failed run: the watch says failed with the engine's words, and files nothing", async () => {
    const fx = load(PR71, "running-then-failed");
    const accepted = retestOf(fx).body;
    const [running, failed] = statusReadsOf(fx);
    expect(failed.body.state).toBe("failed");
    engineState.statusReads = [running, failed];
    const { res, finding } = await retest(fx);
    expect(res.status).toBe(202);
    const watched = await until(
      () => agent.get(`/api/retests/${accepted.run_id}`).then((r) => r.body),
      (body) => body.phase !== "running",
    );
    expect(watched).toMatchObject({ phase: "failed", state: "failed" });
    expect(watched.detail).toContain("RuntimeError: scanner exploded");
    expect(await checksOf(finding.id)).toEqual([]);
  });

  it("429 queue full: refused with the engine's reason and the run it named; nothing filed or watched", async () => {
    const fx = load(PR71, "queue-full");
    const answered = retestOf(fx);
    expect(answered.status).toBe(429);
    const { res, finding } = await retest(fx);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ answer: "status", phase: "failed", engineRunId: answered.body.run_id });
    expect(res.body.error).toContain(answered.body.error);
    expect(await checksOf(finding.id)).toEqual([]);
    expect((await agent.get(`/api/retests/${answered.body.run_id}`)).status).toBe(404);
  });
});

describe("a retest's Stop waits on nothing", () => {
  it("a status read held open does not delay the Stop: measured", async () => {
    const fx = load(PR71, "running-then-verdict");
    const accepted = retestOf(fx).body;
    const [running] = statusReadsOf(fx);
    engineState.statusReads = [running];
    let release!: () => void;
    engineState.holdStatus = new Promise<void>((r) => { release = r; });
    const { res } = await retest(fx);
    expect(res.status).toBe(202);

    // The watcher's read is in flight, and held.
    await until(async () => calls.some((one) => one.line === `GET /api/scans/${accepted.run_id}`), (seen) => seen);
    engineState.abort = abortsOf(load(PR71, "running-then-stopped"))[0];
    const pressed = performance.now();
    const stop = await agent.post(`/api/retests/${accepted.run_id}/abort`);
    const answered = performance.now();
    const reached = calls.find((one) => one.line === `POST /api/scans/${accepted.run_id}/abort`);

    expect(stop.status).toBe(200);
    expect(reached).toBeDefined();
    // The read is still held while the stop reached the engine and came back.
    expect(calls.filter((one) => one.line === `GET /api/scans/${accepted.run_id}`)).toHaveLength(1);
    expect(reached!.at - pressed).toBeLessThan(250);
    expect(answered - pressed).toBeLessThan(500);
    release();
  });

  it("a status read that failed does not take the Stop away, and is said", async () => {
    const fx = load(PR71, "running-then-verdict");
    const accepted = retestOf(fx).body;
    engineState.statusReads = [];
    const { res } = await retest(fx);
    expect(res.status).toBe(202);
    const watched = await until(
      () => agent.get(`/api/retests/${accepted.run_id}`).then((r) => r.body),
      (body) => body.lastReadError !== null,
    );
    expect(watched).toMatchObject({ phase: "running", stoppable: true });
    expect(watched.lastReadError).toMatch(/the engine answered 404/);
    engineState.abort = abortsOf(load(PR71, "running-then-stopped"))[0];
    expect((await agent.post(`/api/retests/${accepted.run_id}/abort`)).status).toBe(200);
  });

  it("the Stop goes through while the kill switch is engaged", async () => {
    const fx = load(PR71, "running-then-verdict");
    const accepted = retestOf(fx).body;
    engineState.statusReads = [statusReadsOf(fx)[0]];
    const { res } = await retest(fx);
    expect(res.status).toBe(202);
    engineState.abort = abortsOf(load(PR71, "running-then-stopped"))[0];
    const engaged = await agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
    expect(engaged.status).toBe(200);
    try {
      const stop = await agent.post(`/api/retests/${accepted.run_id}/abort`);
      expect(stop.status).toBe(200);
    } finally {
      await agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "operational" });
    }
  });

  it("the watch is bounded: past its total time it says it stopped watching, and the Stop stays", async () => {
    const fx = load(PR71, "running-then-verdict");
    const accepted = retestOf(fx).body;
    engineState.statusReads = [statusReadsOf(fx)[0]];
    const total = retests.retestWatch.totalMs;
    retests.retestWatch.totalMs = 200;
    try {
      await retest(fx);
      const watched = await until(
        () => agent.get(`/api/retests/${accepted.run_id}`).then((r) => r.body),
        (body) => body.phase !== "running",
      );
      expect(watched).toMatchObject({ phase: "unwatched", stoppable: true });
      const reads = calls.filter((one) => one.line === `GET /api/scans/${accepted.run_id}`).length;
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThanOrEqual(Math.ceil(200 / retests.retestWatch.intervalMs) + 1);
    } finally {
      retests.retestWatch.totalMs = total;
    }
  });
});

describe("the kill switch and Scans running now include a running retest", () => {
  it("the engine lists it, the kill switch stops it by its run_id, and /api/engine/runs lists it as a retest", async () => {
    const fx = load(PR71, "running-then-verdict");
    const listed = activeOf(fx);
    const run = listed.body.active[0];
    expect(run.kind).toBe("retest");
    engineState.fixture = fx;
    engineState.active = listed;
    engineState.abort = abortsOf(load(PR71, "running-then-stopped"))[0];

    const runs = await agent.get("/api/engine/runs");
    expect(runs.body.runs).toEqual([
      { runId: run.run_id, stopId: run.run_id, target: run.target, state: run.state, kind: "retest" },
    ]);

    const engaged = await agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
    try {
      expect(calls.map((one) => one.line)).toContain(`POST /api/scans/${run.run_id}/abort`);
      expect(engaged.body.engineRuns.runs.find((one: { runId: string }) => one.runId === run.run_id))
        .toMatchObject({ stopped: true });
    } finally {
      await agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "operational" });
    }
  });

  it("with the engine's list unreadable, a watched retest is still sent its stop, and the stop does not wait on that read", async () => {
    const fx = load(PR71, "running-then-verdict");
    const accepted = retestOf(fx).body;
    engineState.statusReads = [statusReadsOf(fx)[0]];
    const { res } = await retest(fx);
    expect(res.status).toBe(202);
    engineState.active = { status: 500, body: { detail: "list unavailable" } };
    engineState.abort = abortsOf(load(PR71, "running-then-stopped"))[0];
    calls.length = 0;

    const engaged = await agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
    try {
      const lines = calls.map((one) => one.line);
      expect(lines).toContain(`POST /api/scans/${accepted.run_id}/abort`);
      // Sent before the list was asked for.
      expect(lines.indexOf(`POST /api/scans/${accepted.run_id}/abort`)).toBeLessThan(lines.indexOf("GET /api/scans/active"));
      expect(engaged.body.engineRuns).toMatchObject({ listed: false });
      expect(engaged.body.engineRuns.retests.find((one: { runId: string }) => one.runId === accepted.run_id))
        .toMatchObject({ stopped: true });
    } finally {
      await agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "operational" });
    }
  });

  it("on engine main a retest in flight is on the live list too, and the kill switch stops it", async () => {
    const fx = load(MAIN, "stopped");
    const listed = activeOf(fx);
    engineState.fixture = fx;
    engineState.active = listed;
    engineState.abort = abortsOf(fx)[0];
    const engaged = await agent.patch("/api/ai-control").send({ killSwitchEnabled: true });
    try {
      expect(calls.map((one) => one.line)).toContain(`POST /api/scans/${listed.body.active[0].run_id}/abort`);
      expect(engaged.body.engineRuns.listed).toBe(true);
    } finally {
      await agent.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "operational" });
    }
  });
});

describe("engine main: read and filed exactly as before", () => {
  it("201 verdict: the record id is its run_id, filed as before, and no stop id is claimed", async () => {
    const fx = load(MAIN, "verdict-closed");
    const answered = retestOf(fx).body;
    const { res, finding } = await retest(fx);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ answer: "verdict", verdict: "closed", runId: String(answered.run_id), engineRunId: null });
    expect((await storage.getFinding(finding.id))!.fixedByRunId).toBe(String(answered.run_id));
    const checks = await checksOf(finding.id);
    expect(checks.map((one) => [one.verdict, one.runId])).toEqual([["closed", String(answered.run_id)]]);
    const sent = calls.find((one) => one.line === "POST /api/remediation/retest")!;
    expect(Object.keys(sent.body).sort()).toEqual(["engagement_ref", "scope", "twin_id"]);
  });

  it("201 still_open, and the synchronous answer of a stopped or failed retest, are verdicts as main says", async () => {
    for (const [name, verdict] of [["verdict-still-open", "still_open"], ["stopped", "inconclusive"], ["failed", "inconclusive"]] as const) {
      const fx = load(MAIN, name);
      const answered = retestOf(fx).body;
      const { res, finding } = await retest(fx);
      expect(res.body, name).toMatchObject({ answer: "verdict", verdict, runId: answered.run_id === null ? null : String(answered.run_id) });
      const checks = await checksOf(finding.id);
      expect(checks.map((one) => [one.verdict, one.runId]), name)
        .toEqual([[verdict, answered.run_id === null ? null : String(answered.run_id)]]);
    }
  });
});
