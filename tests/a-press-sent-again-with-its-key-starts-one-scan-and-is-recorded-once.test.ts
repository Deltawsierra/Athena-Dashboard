import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import type { IStorage } from "../server/storage";
import { makeApp, recordLegacyScan, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";

/**
 * A press sent again with its Idempotency-Key starts one scan, files one
 * ticket, and is recorded here once (roadmap Phase 4, wave 2).
 *
 * A person who presses Start scan and never sees the answer presses again.
 * Without a key that was a second scan of the same customer. The page now
 * makes one key per press (shared/idempotency.ts) and sends it with every send
 * of that press; this server passes it on, scoped to the account
 * (server/idempotency.ts), and the engine (athena-engine #77) answers a start
 * it has already answered from its record -- the same run. This server reads
 * that answer as the first scan's: one run, one row, one Stop.
 *
 * Every engine answer to a keyed `POST /api/scan` below is one the engine app
 * sent at 79ba4af (tests/fixtures/engine-idempotency/generate.py); the retest
 * answers are #58's recordings (tests/fixtures/engine-retest). The backend's
 * connector push is stood in by the contract athena-backend #113 gives it
 * (idempotency/layer.py): no recording of it exists.
 *
 * Since every scan starts through Athena-Backend (decision 11), the press's key
 * goes to the backend, whose idempotency layer (#113, the same one the push
 * meets) answers a press it has already answered from its record, marked
 * `Idempotent-Replayed`, and launches nothing: one run at the engine, one row
 * here, one Stop. The backend is stood in by tests/helpers/hybrid-backend-stand-in.ts;
 * the engine's recorded answers are what the backend's launch meets at the engine.
 */

type Exchange = {
  note: string;
  request: { method: string; path: string; body?: Record<string, unknown>; headers?: Record<string, string> };
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

let hybrid: HybridBackendStandIn | null = null;
const KEYED = path.resolve(__dirname, "fixtures", "engine-idempotency", "main-79ba4af");
const RETEST = path.resolve(__dirname, "fixtures", "engine-retest");
const KEYED_SHA = "79ba4af99bfa22822c0de2e03f27b11a5231b296";
const load = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8")) as Fixture;
const keyed = (name: string) => load(KEYED, name);

const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const keyOf = (req: IncomingMessage) => {
  const key = req.headers["idempotency-key"];
  return typeof key === "string" ? key : null;
};

/**
 * The stand-in engine. `POST /api/scan` is answered with `launches`' next
 * exchange, in order, as the engine answered that scenario; `hold`, when set,
 * holds the next launch's answer until released. The retest routes answer
 * from #58's recordings. Every request's Idempotency-Key is kept.
 */
const engineState = {
  launches: [] as Exchange[],
  hold: null as Promise<void> | null,
  retest: null as Fixture | null,
  /**
   * The engine's key layer, modelled on a recording (in place of `launches`):
   * a launch with no key, or a key not seen before, starts a run -- the
   * recording's first answer with a run id of its own -- and a key seen before
   * is given that key's first answer again, marked replayed, as #77 answers.
   */
  model: null as Fixture | null,
  firstAnswers: new Map<string, Exchange>(),
  started: 0,
};
const sentLaunches: Array<{ key: string | null; body: Record<string, unknown> }> = [];
const sentStops: Array<{ url: string; key: string | null }> = [];
const sentRetests: Array<{ key: string | null; body: Record<string, unknown> }> = [];

/**
 * The backend's connector push under athena-backend #113's key layer: the
 * first push with a key is recorded before it runs and answered with what it
 * got; the same key and request again is that answer, replayed; the same key
 * while the first has no answer is 409 unknown; the same key with another
 * request is 422. `lose` drops the next answer after the ticket is filed.
 */
const backend = {
  records: new Map<string, { request: string; answer: { status: number; body: unknown } | null }>(),
  tickets: 0,
  keys: [] as Array<string | null>,
  lose: false,
};

let engine: Server;
let controlPlane: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let theApp: Awaited<ReturnType<typeof makeApp>>;
let locals: Record<string, any>;

beforeAll(async () => {
  engine = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      const url = req.url ?? "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const reply = (one: Exchange) => json(res, one.status, one.body, one.headers ?? {});
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") return json(res, 200, { active: [] });
      const retest = engineState.retest;
      if (req.method === "POST" && url === "/api/scan") {
        // The retest cases' own scan (sent with no key) is their recording's setup scan.
        if (retest) return reply(retest.exchanges.find((one) => one.note.startsWith("setup") && one.request.path === "/api/scan")!);
        sentLaunches.push({ key: keyOf(req), body });
        if (engineState.model) {
          const key = keyOf(req);
          const earlier = key === null ? undefined : engineState.firstAnswers.get(key);
          if (earlier) return reply({ ...earlier, headers: { ...(earlier.headers ?? {}), "Idempotent-Replayed": "true" } });
          engineState.started += 1;
          const recorded = engineState.model.exchanges[0];
          const runId = `${recorded.body.run_id}-${engineState.started}`;
          const first = { ...recorded, body: { ...recorded.body, run_id: runId, status_url: `/api/scans/${runId}` } };
          if (key !== null) engineState.firstAnswers.set(key, first);
          if (engineState.hold) {
            const held = engineState.hold;
            engineState.hold = null;
            await held;
          }
          return reply(first);
        }
        const next = engineState.launches.shift();
        if (!next) return json(res, 500, { detail: "the test gave this launch no answer" });
        if (engineState.hold) {
          const held = engineState.hold;
          engineState.hold = null;
          await held;
        }
        return reply(next);
      }
      if (req.method === "GET" && /^\/api\/scans\/[^/]+$/.test(url)) {
        // The run the backend launched is still going: the backend's one read at launch, and the dashboard's polls, read it so.
        return json(res, 200, { run_id: decodeURIComponent(url.split("/")[3]), state: "running", result: null });
      }
      if (req.method === "POST" && /^\/api\/scans\/[^/]+\/abort$/.test(url)) {
        sentStops.push({ url, key: keyOf(req) });
        return json(res, 200, { run_id: decodeURIComponent(url.split("/")[3]), state: "aborting", reason: "stopped by an operator", recorded: true });
      }
      if (retest && req.method === "GET" && url.startsWith("/api/decisions?")) {
        return reply(retest.exchanges.find((one) => one.note.startsWith("setup") && one.request.path.startsWith("/api/decisions?"))!);
      }
      if (retest && req.method === "POST" && url === "/api/remediation/retest") {
        sentRetests.push({ key: keyOf(req), body });
        const asked = retest.exchanges.filter((one) => !one.note.startsWith("setup") && one.request.path === "/api/remediation/retest");
        // Engine main refuses `wait_seconds` (its recorded 422), and is asked again without it.
        if (retest.engine.contract === "main" && body.wait_seconds !== undefined) {
          return reply(load(path.join(RETEST, "main-5779e99"), "wait-seconds-refused").exchanges.find((one) => one.request.path === "/api/remediation/retest")!);
        }
        return reply(asked[0]);
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));

  controlPlane = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = (req.url ?? "").split("?")[0];
      if (url === "/api/token/" && req.method === "POST") return json(res, 200, { access: "svc-access-token", refresh: "r" });
      if (url === "/api/assurance/deployments/dep-1/connectors/jira/push/" && req.method === "POST") {
        const key = keyOf(req);
        backend.keys.push(key);
        const earlier = key === null ? undefined : backend.records.get(key);
        if (earlier && earlier.request !== raw) {
          return json(res, 422, { detail: "This Idempotency-Key was already used on this route for a different request.", idempotency: { state: "done", since: "2026-09-29T00:00:00+00:00" } });
        }
        if (earlier && earlier.answer === null) {
          return json(res, 409, { detail: "The first request with this Idempotency-Key has not recorded an answer.", idempotency: { state: "in_flight", since: "2026-09-29T00:00:00+00:00" } });
        }
        if (earlier && earlier.answer !== null) {
          return json(res, earlier.answer.status, earlier.answer.body, { "Idempotent-Replayed": "true" });
        }
        if (key !== null) backend.records.set(key, { request: raw, answer: null });
        backend.tickets += 1;
        const answer = { status: 200, body: { ok: true, external_ref: `ATH-${backend.tickets}`, detail: "", connector: "jira" } };
        if (key !== null) backend.records.set(key, { request: raw, answer });
        if (backend.lose) {
          backend.lose = false;
          return void req.socket.destroy();
        }
        return json(res, answer.status, answer.body);
      }
      return json(res, 404, { detail: `no route ${req.method} ${url}` });
    });
  });
  await new Promise<void>((r) => controlPlane.listen(0, "127.0.0.1", r));

  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  hybrid = await hybridBackendStandIn({ engine: { url: process.env.ATHENA_ENGINE_URL!, key: process.env.ATHENA_ENGINE_KEY }, upstream: `http://127.0.0.1:${(controlPlane.address() as AddressInfo).port}` });
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  process.env.ATHENA_FAILSAFE_USER = "svc-operator";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc-secret";
  vi.resetModules();
  theApp = await makeApp();
  locals = theApp.locals;
  agent = await signIn(theApp);
  await signInToBackend(agent);
  storage = (await import("../server/storage-unified")).storage;
});

afterAll(async () => {
  delete process.env.ATHENA_FAILSAFE_URL;
  await hybrid?.close();
  hybrid = null;
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  delete process.env.ATHENA_FAILSAFE_URL;
  delete process.env.ATHENA_FAILSAFE_USER;
  delete process.env.ATHENA_FAILSAFE_PASSWORD;
  engine.closeAllConnections?.();
  controlPlane.closeAllConnections?.();
  await new Promise<void>((r) => engine.close(() => r()));
  await new Promise<void>((r) => controlPlane.close(() => r()));
});

beforeEach(() => {
  engineState.launches = [];
  engineState.hold = null;
  engineState.retest = null;
  engineState.model = null;
  engineState.firstAnswers.clear();
  engineState.started = 0;
  sentLaunches.length = 0;
  sentStops.length = 0;
  sentRetests.length = 0;
  backend.records.clear();
  backend.tickets = 0;
  backend.keys.length = 0;
  backend.lose = false;
  locals.retestWatcher?.reset();
  (locals.retestsHeld as Map<string, unknown> | undefined)?.clear();
  hybrid!.releaseLaunches();
  hybrid!.controls.failNextLaunch = null;
});

let clientCount = 0;

async function aClientAndSite() {
  clientCount += 1;
  const client = await agent.post("/api/clients")
    .send({ name: `Pressed ${clientCount}`, company: "Pressed Ltd", email: `p${clientCount}@example.test` });
  const site = await agent.post("/api/sites")
    .send({ clientId: client.body.id, name: "Main", url: "https://offline.invalid" });
  return { clientId: client.body.id as string, siteId: site.body.id as string };
}

/** The rows recorded for engine run `runId` for this client (the recordings' run ids recur across cases). */
async function rowsFor(runId: string, clientId: string) {
  return (await storage.getAllTests()).filter((one) =>
    one.clientId === clientId && (one.findings as { runId?: unknown } | null)?.runId === runId);
}

async function startedLogsFor(testId: string) {
  return (await storage.getAllActivityLogs()).filter((one) => one.action === "started" && one.entityId === testId);
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

describe("the recordings are what the engine sent under a key, at the commit they name", () => {
  it("every file names athena-engine 79ba4af, and the pinned mythos-core it ran on", () => {
    const files = fs.readdirSync(KEYED).filter((one) => one.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      const fx = keyed(file.replace(/\.json$/, ""));
      expect(fx.engine, file).toEqual({ repository: "athena-engine", sha: KEYED_SHA, contract: "idempotency-key" });
      expect(fx.mythos_core.label, file).toBe("pinned core");
      expect(fx.mythos_core.imported_commit, file).toBe(fx.mythos_core.pinned_by_requirements);
    }
  });

  it("the engine answers the same start again from its record, and a key's own answers name the key", () => {
    const [first, again] = keyed("launch-then-repeat").exchanges;
    expect(again.body.run_id).toBe(first.body.run_id);
    expect(again.headers?.["Idempotent-Replayed"]).toBe("true");
    expect(keyed("in-flight").exchanges[0].body.idempotency.state).toBe("in_flight");
    expect(keyed("raised-then-repeat").exchanges[1].body.idempotency.state).toBe("unknown");
    expect(keyed("other-request").exchanges[1].status).toBe(422);
    // A stood-down engine refuses the same start again as it refuses a new one: nothing about the key.
    expect(keyed("stood-down-repeat").exchanges[1].body).toEqual({ detail: "the engine is stood_down; not accepting new work" });
  });
});

describe("a scan start sent again with its key", () => {
  /** This dashboard's launches at the backend, by arrival. */
  const launches = () => hybrid!.launches();
  const clientRowsOf = (clientId: string) => async () => (await storage.getAllTests()).filter((one) => one.clientId === clientId);

  it("a press whose answer was lost, pressed again, starts one scan and is recorded once: the backend answers the second send from its record", async () => {
    engineState.launches = [keyed("launch-then-repeat").exchanges[0]];
    const { clientId, siteId } = await aClientAndSite();
    const press = { consent: true, clientId, siteId, target: "https://offline.invalid/" };
    const from = launches().length;

    // The first send: the backend's answer is held, the page stops waiting (its
    // answer is lost), and this server goes on recording the scan all the same.
    hybrid!.holdLaunches();
    const lost = agent.post("/api/scans").set("Idempotency-Key", "press-1").send(press).timeout(300);
    await expect(lost).rejects.toThrow(/timeout/i);
    hybrid!.releaseLaunches();
    const clientRows = clientRowsOf(clientId);
    const recorded = await until(clientRows, (rows) => rows.length > 0);
    expect(recorded, "the first send recorded its scan after the page stopped waiting").toHaveLength(1);
    const runId = (recorded[0].findings as { runId: string }).runId;

    // The same press again, with its key.
    const again = await agent.post("/api/scans").set("Idempotency-Key", "press-1").send(press);

    expect(sentLaunches, `one press sent twice started ${sentLaunches.length} scans at the engine`).toHaveLength(1);
    const rows = await clientRows();
    expect(rows.length, `one press sent twice made ${rows.length} rows`).toBe(1);
    const sent = launches().slice(from);
    expect(sent, "the backend was asked twice, with one key").toHaveLength(2);
    expect(sent[0].idempotencyKey).not.toBeNull();
    expect(sent[1].idempotencyKey, "the second send carried the first's key").toBe(sent[0].idempotencyKey);
    expect(sent[0].idempotencyKey, "the page's key is passed on scoped to its account, never as sent").not.toBe("press-1");
    expect(sent[1].replayed, "the backend answered the second send from its record of the first").toBe(true);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.replayed).toBe(true);
    expect(again.body.test.id).toBe(rows[0].id);
    expect(again.body.runId).toBe(runId);
    expect(await startedLogsFor(rows[0].id), "one start logged, not two").toHaveLength(1);
  });

  it("the same press while its first send is still being answered here sends nothing, and is told so", async () => {
    engineState.launches = [keyed("launch-then-repeat").exchanges[0]];
    const { clientId, siteId } = await aClientAndSite();
    const press = { consent: true, clientId, siteId, target: "https://offline.invalid/" };
    const from = launches().length;
    hybrid!.holdLaunches();

    const first = agent.post("/api/scans").set("Idempotency-Key", "press-2").send(press).then((one) => one);
    await until(async () => launches().length, (n) => n === from + 1);
    const meanwhile = await agent.post("/api/scans").set("Idempotency-Key", "press-2").send(press);
    hybrid!.releaseLaunches();
    const answered = await first;

    expect(meanwhile.status, JSON.stringify(meanwhile.body)).toBe(409);
    expect(meanwhile.body.reason).toBe("idempotency_in_flight");
    expect(meanwhile.body.idempotency).toEqual({ state: "in_flight" });
    expect(meanwhile.body.error).toMatch(/not known yet/);
    expect(launches().slice(from), "the second send reached the backend").toHaveLength(1);
    expect(answered.status, JSON.stringify(answered.body)).toBe(201);
    expect(await clientRowsOf(clientId)()).toHaveLength(1);

    // Once the first has answered, its key is free: the same press is read from the backend's record.
    const later = await agent.post("/api/scans").set("Idempotency-Key", "press-2").send(press);
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    expect(later.body.replayed).toBe(true);
    expect(later.body.test.id).toBe(answered.body.test.id);
    expect(launches().slice(from).map((one) => one.replayed)).toEqual([false, true]);
    expect(sentLaunches, "the engine was asked once").toHaveLength(1);
    expect(await clientRowsOf(clientId)()).toHaveLength(1);
  });

  it("a first send the backend answered 500 to is unknown: never refused, never recorded, never re-keyed -- and the same press again is that answer replayed, never a new scan", async () => {
    hybrid!.controls.failNextLaunch = { status: 500, body: { detail: "the backend raised before it recorded an answer" } };
    const { clientId, siteId } = await aClientAndSite();
    const press = { consent: true, clientId, siteId, target: "https://offline.invalid/" };
    const from = launches().length;
    const before = (await storage.getAllTests()).length;

    const first = await agent.post("/api/scans").set("Idempotency-Key", "press-3").send(press);
    const again = await agent.post("/api/scans").set("Idempotency-Key", "press-3").send(press);

    for (const [label, res] of [["first", first], ["again", again]] as const) {
      expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(409);
      expect(res.body.reason, label).toBe("scan_outcome_unknown");
      expect(res.body.mayStillBeRunning, label).toBe(true);
      expect(res.body.error, label).toMatch(/^We don't know whether this scan started/);
      expect(res.body.error, label).not.toMatch(/refused/);
    }
    const sent = launches().slice(from);
    expect(sent.map((one) => one.idempotencyKey)).toEqual([sent[0].idempotencyKey, sent[0].idempotencyKey]);
    expect(sent.map((one) => [one.status, one.replayed])).toEqual([[500, false], [500, true]]);
    expect(sentLaunches, "the engine was never asked").toEqual([]);
    expect((await storage.getAllTests()).length - before, "nothing recorded from either").toBe(0);
  });

  it("while the first send is still being answered at the backend, the same press is unknown and starts nothing; once answered, it is that scan, recorded once", async () => {
    const backendScans = await import("../server/backend-scans");
    const was = backendScans.launchTimeouts.launchMs;
    backendScans.launchTimeouts.launchMs = 300;
    engineState.launches = [keyed("launch-then-repeat").exchanges[0]];
    const { clientId, siteId } = await aClientAndSite();
    const press = { consent: true, clientId, siteId, target: "https://offline.invalid/" };
    const from = launches().length;
    try {
      // The backend holds the first send past this dashboard's launch deadline: its outcome is not known here.
      hybrid!.holdLaunches();
      const first = await agent.post("/api/scans").set("Idempotency-Key", "press-4").send(press);
      expect(first.status, JSON.stringify(first.body)).toBe(409);
      expect(first.body.reason).toBe("scan_outcome_unknown");
      expect(first.body.mayStillBeRunning).toBe(true);
      // The same press, while the backend is still answering the first: the backend says so, and this dashboard passes it on.
      const meanwhile = await agent.post("/api/scans").set("Idempotency-Key", "press-4").send(press);
      expect(meanwhile.status, JSON.stringify(meanwhile.body)).toBe(409);
      expect(meanwhile.body.reason).toBe("scan_outcome_unknown");
      expect(meanwhile.body.idempotency).toEqual({ state: "in_flight" });
      expect(await clientRowsOf(clientId)()).toEqual([]);
      expect(sentLaunches, "nothing started a second time at the engine").toHaveLength(0);
      // The backend finishes answering the first send -- to nobody, and records that answer for the key.
      hybrid!.releaseLaunches();
      await until(async () => launches()[from].status, (status) => status === 202);
      expect(sentLaunches, "the first send started one scan at the engine").toHaveLength(1);
      // The same press once more: the first send's answer, replayed, recorded here now, once.
      const later = await agent.post("/api/scans").set("Idempotency-Key", "press-4").send(press);
      expect(later.status, JSON.stringify(later.body)).toBe(201);
      expect(later.body.replayed).toBe(true);
      expect(later.body.runId).toBe(keyed("launch-then-repeat").exchanges[0].body.run_id);
      expect(await clientRowsOf(clientId)()).toHaveLength(1);
      expect(sentLaunches).toHaveLength(1);
    } finally {
      backendScans.launchTimeouts.launchMs = was;
    }
  });

  it("a stood-down engine's refusal is the backend's record of a failed scan, in the engine's words; the same press again is that record, not a new scan", async () => {
    // The engine's recorded refusal (stood-down-repeat): what the backend's launch meets at a stood-down engine.
    engineState.launches = [keyed("stood-down-repeat").exchanges[1]];
    const { clientId, siteId } = await aClientAndSite();
    const press = { consent: true, clientId, siteId, target: "https://offline.invalid/" };
    const from = launches().length;
    const before = (await storage.getAllTests()).length;

    const refused = await agent.post("/api/scans").set("Idempotency-Key", "press-5").send(press);
    const again = await agent.post("/api/scans").set("Idempotency-Key", "press-5").send(press);

    for (const [label, res] of [["refused", refused], ["again", again]] as const) {
      expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(409);
      expect(res.body.reason, label).toBe("launch_failed");
      expect(res.body.detail, label).toBe("Engine error: the engine is stood_down; not accepting new work");
      expect(res.body.error, label).toContain("stood_down");
      expect(res.body.error, label).toContain("Athena-Backend recorded this scan as failed");
      expect(res.body.mayStillBeRunning, label).toBeUndefined();
      expect(res.body.backendScanId, label).toEqual(expect.any(String));
    }
    expect(again.body.backendScanId, "the same record, not a second failed scan").toBe(refused.body.backendScanId);
    expect(launches().slice(from).map((one) => [one.status, one.replayed])).toEqual([[502, false], [502, true]]);
    expect(sentLaunches, "the engine was asked once").toHaveLength(1);
    expect(sentLaunches[0].key, "the backend's own key to the engine, never the page's").not.toBeNull();
    expect((await storage.getAllTests()).length - before, "nothing recorded from either").toBe(0);
  });

  it("the same key with another request is a bug here, said as one, and starts nothing", async () => {
    engineState.launches = [keyed("other-request").exchanges[0]];
    const { clientId, siteId } = await aClientAndSite();
    const from = launches().length;
    const first = await agent.post("/api/scans").set("Idempotency-Key", "press-6").send({ consent: true, clientId, siteId, target: "https://offline.invalid/" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const other = await agent.post("/api/scans").set("Idempotency-Key", "press-6")
      .send({ consent: true, clientId, siteId, target: "https://offline.invalid/other" });
    expect(other.status, JSON.stringify(other.body)).toBe(500);
    expect(other.body.reason).toBe("idempotency_bug");
    expect(other.body.error).toMatch(/a bug in this dashboard/);
    expect(launches().slice(from).map((one) => one.status)).toEqual([202, 422]);
    expect(sentLaunches, "the engine was asked once").toHaveLength(1);
  });

  it("a key that is not one is refused here, and nothing is sent", async () => {
    const { clientId, siteId } = await aClientAndSite();
    const from = launches().length;
    for (const bad of ["", "x".repeat(256), "café"]) {
      const res = await agent.post("/api/scans").set("Idempotency-Key", bad).send({ consent: true, clientId, siteId, target: "https://offline.invalid/" });
      expect(res.status, JSON.stringify({ bad, body: res.body })).toBe(400);
      expect(res.body.reason).toBe("idempotency_key_invalid");
    }
    expect(launches().slice(from)).toEqual([]);
    expect(sentLaunches).toHaveLength(0);
  });

  it("without a key nothing changes: the same start sent again starts again", async () => {
    const fx = keyed("without-a-key");
    engineState.launches = [...fx.exchanges];
    const { clientId, siteId } = await aClientAndSite();
    const press = { consent: true, clientId, siteId, target: "https://offline.invalid/" };
    const from = launches().length;
    const one = await agent.post("/api/scans").send(press);
    const two = await agent.post("/api/scans").send(press);
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect(two.status, JSON.stringify(two.body)).toBe(201);
    expect(two.body.test.id).not.toBe(one.body.test.id);
    expect(launches().slice(from).map((sent) => sent.idempotencyKey)).toEqual([null, null]);
    expect(sentLaunches, "two scans at the engine").toHaveLength(2);
  });

  it("one page key from two accounts is two keys at the backend", async () => {
    const { forwardedKey } = await import("../server/idempotency");
    expect(forwardedKey("account-1", "press")).toBe(forwardedKey("account-1", "press"));
    expect(forwardedKey("account-1", "press")).not.toBe(forwardedKey("account-2", "press"));
    expect(forwardedKey("account-1", "press")).toMatch(/^[\x20-\x7e]{1,255}$/);
  });
});

describe("a retest press carries its key, and its held slot is unchanged", () => {
  async function retestOnce(fx: Fixture, key: string) {
    engineState.retest = fx;
    const { clientId, siteId } = await aClientAndSite();
    // The scan that found the finding (the recording's setup scan), recorded and filed as this dashboard's own
    // (tests/helpers.ts recordLegacyScan): a scan started through Athena-Backend is recorded there, never filed here.
    const setup = fx.exchanges.find((one) => one.note.startsWith("setup") && one.request.path === "/api/scan")!.body as
      { run_id: string; target: string; result: { results: unknown[] } };
    const { test } = await recordLegacyScan(storage, { clientId, siteId, target: setup.target, runId: setup.run_id, results: setup.result.results });
    const twin = fx.exchanges.find((one) => one.note.startsWith("setup") && one.request.path.startsWith("/api/decisions?"))!.body.decisions[0];
    return agent.post(`/api/tests/${test.id}/retest`).set("Idempotency-Key", key).send({ twinId: twin.id });
  }

  it("the retest is asked with the press's key, scoped to the account", async () => {
    const res = await retestOnce(load(path.join(RETEST, "pr71-f4610ae"), "at-once-then-verdict"), "retest-press");
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(sentRetests).toHaveLength(1);
    expect(sentRetests[0].key).toMatch(/^athena-dashboard:[0-9a-f]{64}$/);
  });

  it("an engine that refuses wait_seconds is asked again without it, and without the key", async () => {
    const res = await retestOnce(load(path.join(RETEST, "main-5779e99"), "verdict-closed"), "retest-press-2");
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(sentRetests.map((one) => [one.body.wait_seconds, one.key === null])).toEqual([[0, false], [undefined, true]]);
  });
});

describe("a connector push sent again with its key files one ticket", () => {
  const PUSH = "/api/assurance/deployments/dep-1/connectors/jira/push";

  it("a push whose answer was lost, pushed again, files one ticket and is told it is the first's answer", async () => {
    backend.lose = true;
    const first = await agent.post(PUSH).set("Idempotency-Key", "push-1").send({ finding: "f-1" });
    const again = await agent.post(PUSH).set("Idempotency-Key", "push-1").send({ finding: "f-1" });

    expect(first.status, JSON.stringify(first.body)).toBe(503);
    expect(first.body.reason).toBe("push_outcome_unknown");
    expect(first.body.error).toMatch(/^We don't know whether this finding was pushed/);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ ok: true, externalRef: "ATH-1", replayed: true });
    expect(backend.tickets, `one push sent twice filed ${backend.tickets} tickets`).toBe(1);
    expect(backend.keys).toEqual([backend.keys[0], backend.keys[0]]);
    expect(backend.keys[0]).not.toBeNull();
    const logs = (await storage.getAllActivityLogs()).filter((one) => one.action === "connector_pushed");
    expect(logs, "the replay is not logged as a second push").toHaveLength(0);
  });

  it("the same push while the first has no answer is unknown; with another finding, a bug", async () => {
    const { forwardedKey } = await import("../server/idempotency");
    const me = await agent.get("/api/auth/check");
    const account = String(me.body.user.id);
    backend.records.set(forwardedKey(account, "push-2"), { request: JSON.stringify({ finding: "f-2" }), answer: null });
    const unknown = await agent.post(PUSH).set("Idempotency-Key", "push-2").send({ finding: "f-2" });
    backend.records.set(forwardedKey(account, "push-3"), { request: JSON.stringify({ finding: "f-3" }), answer: { status: 200, body: {} } });
    const other = await agent.post(PUSH).set("Idempotency-Key", "push-3").send({ finding: "f-4" });

    expect(unknown.status, JSON.stringify(unknown.body)).toBe(409);
    expect(unknown.body.reason).toBe("push_outcome_unknown");
    expect(unknown.body.idempotency).toEqual({ state: "in_flight" });
    expect(other.status, JSON.stringify(other.body)).toBe(500);
    expect(other.body.reason).toBe("idempotency_bug");
    expect(backend.tickets).toBe(0);
  });
});

describe("a stop never carries a key", () => {
  it("a Stop pressed with a key sends the engine none", async () => {
    const fx = keyed("launch-then-repeat");
    engineState.launches = [fx.exchanges[0]];
    const { clientId, siteId } = await aClientAndSite();
    const started = await agent.post("/api/scans").set("Idempotency-Key", "press-7").send({ consent: true, clientId, siteId, target: "https://offline.invalid/" });
    expect(started.status).toBe(201);
    const stop = await agent.post(`/api/scans/${started.body.test.id}/abort`).set("Idempotency-Key", "stop-press").send();
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    expect(sentStops).toHaveLength(1);
    expect(sentStops[0].key, "a stop reached the engine with a key").toBeNull();
  });

  it("only the scan start, the retest and the connector push read or send a key", () => {
    const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
    // server/engine.ts: the header is sent by startScan and retest, and by no stop.
    const engineSource = read("server/engine.ts");
    const functions = engineSource.split(/\nexport async function /).slice(1);
    const sending = functions.filter((one) => one.includes("[IDEMPOTENCY_HEADER]")).map((one) => one.slice(0, one.indexOf("(")));
    expect(sending.sort()).toEqual(["retest", "startScan"]);
    // server/routes.ts: a key is read on the three routes, and on no other.
    const routes = read("server/routes.ts").split(/\n {2}app\.(?=get|post|put|patch|delete)/).slice(1);
    const reading = routes.filter((one) => one.includes("idempotency.keyOf(")).map((one) => one.slice(0, one.indexOf(",")).replace(/\s+/g, " "));
    expect(reading).toEqual([
      'post("/api/scans"',
      'post("/api/tests/:testId/retest"',
      'post( "/api/assurance/deployments/:uuid/connectors/:connector/push"',
    ]);
    // server/assurance.ts: the header is sent by the push alone.
    const assurance = read("server/assurance.ts").split(/\nexport async function /).slice(1);
    expect(assurance.filter((one) => one.includes("[IDEMPOTENCY_HEADER]")).map((one) => one.slice(0, one.indexOf("(")))).toEqual(["pushConnector"]);
    // server/backend-scans.ts: the header is sent by the launch alone -- never by a stop's mirror, a collect or a read.
    const backendScans = read("server/backend-scans.ts").split(/\nexport async function /).slice(1);
    expect(backendScans.filter((one) => one.includes("[IDEMPOTENCY_HEADER]")).map((one) => one.slice(0, one.indexOf("(")))).toEqual(["launchScan"]);
  });
});
