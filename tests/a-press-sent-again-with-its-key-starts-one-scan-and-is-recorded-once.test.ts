import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import type { IStorage } from "../server/storage";
import { makeApp, signIn } from "./helpers";

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
        if (retest && keyOf(req) === null) return reply(retest.exchanges.find((one) => one.note.startsWith("setup") && one.request.path === "/api/scan")!);
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
  process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${(controlPlane.address() as AddressInfo).port}`;
  process.env.ATHENA_FAILSAFE_USER = "svc-operator";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc-secret";
  vi.resetModules();
  theApp = await makeApp();
  locals = theApp.locals;
  agent = await signIn(theApp);
  storage = (await import("../server/storage-unified")).storage;
});

afterAll(async () => {
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
  it("a press whose answer was lost, pressed again, starts one scan and is recorded once", async () => {
    engineState.model = keyed("launch-then-repeat");
    const { clientId, siteId } = await aClientAndSite();
    const press = { clientId, siteId, target: "https://offline.invalid/" };

    // The first send: the engine's answer is held, the page stops waiting (its
    // answer is lost), and this server goes on recording the scan all the same.
    let release!: () => void;
    engineState.hold = new Promise<void>((r) => { release = r; });
    const lost = agent.post("/api/scans").set("Idempotency-Key", "press-1").send(press).timeout(300);
    await expect(lost).rejects.toThrow(/timeout/i);
    release();
    const clientRows = async () => (await storage.getAllTests()).filter((one) => one.clientId === clientId);
    const recorded = await until(clientRows, (rows) => rows.length > 0);
    expect(recorded, "the first send recorded its scan after the page stopped waiting").toHaveLength(1);
    const runId = (recorded[0].findings as { runId: string }).runId;

    // The same press again, with its key.
    const again = await agent.post("/api/scans").set("Idempotency-Key", "press-1").send(press);

    expect(engineState.started, `one press sent twice started ${engineState.started} scans at the engine`).toBe(1);
    const rows = await clientRows();
    expect(rows.length, `one press sent twice made ${rows.length} rows`).toBe(1);
    expect(sentLaunches, "the engine was asked twice, with one key").toHaveLength(2);
    expect(sentLaunches[0].key).not.toBeNull();
    expect(sentLaunches[1].key, "the second send carried the first's key").toBe(sentLaunches[0].key);
    expect(sentLaunches[0].key, "the page's key is passed on scoped to its account, never as sent").not.toBe("press-1");
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.replayed).toBe(true);
    expect(again.body.test.id).toBe(rows[0].id);
    expect(again.body.runId).toBe(runId);
    expect(await startedLogsFor(rows[0].id), "one start logged, not two").toHaveLength(1);
  });

  it("the same press while its first send is still being answered here sends nothing, and is told so", async () => {
    const fx = keyed("launch-then-repeat");
    engineState.launches = [fx.exchanges[0]];
    const runId = fx.exchanges[0].body.run_id as string;
    const { clientId, siteId } = await aClientAndSite();
    const press = { clientId, siteId, target: "https://offline.invalid/" };
    let release!: () => void;
    engineState.hold = new Promise<void>((r) => { release = r; });

    const first = agent.post("/api/scans").set("Idempotency-Key", "press-2").send(press).then((one) => one);
    await until(async () => sentLaunches.length, (n) => n === 1);
    const meanwhile = await agent.post("/api/scans").set("Idempotency-Key", "press-2").send(press);
    release();
    const answered = await first;

    expect(meanwhile.status, JSON.stringify(meanwhile.body)).toBe(409);
    expect(meanwhile.body.reason).toBe("idempotency_in_flight");
    expect(meanwhile.body.idempotency).toEqual({ state: "in_flight" });
    expect(meanwhile.body.error).toMatch(/not known yet/);
    expect(sentLaunches, "the second send reached the engine").toHaveLength(1);
    expect(answered.status).toBe(201);
    expect(await rowsFor(runId, clientId)).toHaveLength(1);

    // Once the first has answered, its key is free: the same press is read from the engine's record.
    engineState.launches = [fx.exchanges[1]];
    const later = await agent.post("/api/scans").set("Idempotency-Key", "press-2").send(press);
    expect(later.status).toBe(201);
    expect(later.body.test.id).toBe(answered.body.test.id);
    expect(await rowsFor(runId, clientId)).toHaveLength(1);
  });

  it("a first send the engine has no answer for is said to be unknown: never refused, never recorded, never re-keyed", async () => {
    const fx = keyed("raised-then-repeat");
    engineState.launches = [...fx.exchanges];
    const { clientId, siteId } = await aClientAndSite();
    const press = { clientId, siteId, target: "https://offline.invalid/" };
    const before = (await storage.getAllTests()).length;

    const first = await agent.post("/api/scans").set("Idempotency-Key", "press-3").send(press);
    const again = await agent.post("/api/scans").set("Idempotency-Key", "press-3").send(press);

    // The engine's 500 that names no run: may have started (as it always was).
    expect(first.status).toBe(503);
    expect(first.body.mayStillBeRunning).toBe(true);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.reason).toBe("scan_outcome_unknown");
    expect(again.body.idempotency).toEqual({ state: "unknown" });
    expect(again.body.mayStillBeRunning).toBe(true);
    expect(again.body.error).toMatch(/^We don't know whether this scan started/);
    expect(again.body.error).not.toMatch(/refused/);
    expect(sentLaunches.map((one) => one.key)).toEqual([sentLaunches[0].key, sentLaunches[0].key]);
    expect((await storage.getAllTests()).length - before, "nothing recorded from either").toBe(0);
  });

  it("while the first start is still answering at the engine, the same press is unknown and starts nothing", async () => {
    const fx = keyed("in-flight");
    engineState.launches = [fx.exchanges[0]];
    const { clientId, siteId } = await aClientAndSite();
    const before = (await storage.getAllTests()).length;
    const res = await agent.post("/api/scans").set("Idempotency-Key", "press-4")
      .send({ clientId, siteId, target: "https://offline.invalid/" });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.reason).toBe("scan_outcome_unknown");
    expect(res.body.idempotency).toEqual({ state: "in_flight" });
    expect((await storage.getAllTests()).length - before).toBe(0);
  });

  it("a stood-down engine's refusal of the same press is its refusal, not an unknown and not a replay", async () => {
    const fx = keyed("stood-down-repeat");
    engineState.launches = [...fx.exchanges];
    const runId = fx.exchanges[0].body.run_id as string;
    const { clientId, siteId } = await aClientAndSite();
    const press = { clientId, siteId, target: "https://offline.invalid/" };

    const first = await agent.post("/api/scans").set("Idempotency-Key", "press-5").send(press);
    const refused = await agent.post("/api/scans").set("Idempotency-Key", "press-5").send(press);
    const resumed = await agent.post("/api/scans").set("Idempotency-Key", "press-5").send(press);

    expect(first.status).toBe(201);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("the engine refused this scan");
    expect(refused.body.detail).toContain("stood_down");
    expect(refused.body.reason).toBeUndefined();
    expect(refused.body.replayed).toBeUndefined();
    expect(resumed.status).toBe(201);
    expect(resumed.body.replayed).toBe(true);
    expect(resumed.body.test.id).toBe(first.body.test.id);
    expect(await rowsFor(runId, clientId)).toHaveLength(1);
  });

  it("the same key with another request is a bug here, said as one, and starts nothing", async () => {
    const fx = keyed("other-request");
    engineState.launches = [...fx.exchanges];
    const { clientId, siteId } = await aClientAndSite();
    await agent.post("/api/scans").set("Idempotency-Key", "press-6").send({ clientId, siteId, target: "https://offline.invalid/" });
    const other = await agent.post("/api/scans").set("Idempotency-Key", "press-6")
      .send({ clientId, siteId, target: "https://offline.invalid/other" });
    expect(other.status, JSON.stringify(other.body)).toBe(500);
    expect(other.body.reason).toBe("idempotency_bug");
    expect(other.body.error).toMatch(/a bug in this dashboard/);
  });

  it("a key that is not one is refused here, and nothing is sent", async () => {
    const { clientId, siteId } = await aClientAndSite();
    for (const bad of ["", "x".repeat(256), "café"]) {
      const res = await agent.post("/api/scans").set("Idempotency-Key", bad).send({ clientId, siteId, target: "https://offline.invalid/" });
      expect(res.status, JSON.stringify({ bad, body: res.body })).toBe(400);
      expect(res.body.reason).toBe("idempotency_key_invalid");
    }
    expect(sentLaunches).toHaveLength(0);
  });

  it("without a key nothing changes: the same start sent again starts again", async () => {
    const fx = keyed("without-a-key");
    engineState.launches = [...fx.exchanges];
    const { clientId, siteId } = await aClientAndSite();
    const press = { clientId, siteId, target: "https://offline.invalid/" };
    const one = await agent.post("/api/scans").send(press);
    const two = await agent.post("/api/scans").send(press);
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.body.test.id).not.toBe(one.body.test.id);
    expect(sentLaunches.map((sent) => sent.key)).toEqual([null, null]);
  });

  it("one page key from two accounts is two keys at the engine", async () => {
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
    const started = await agent.post("/api/scans").send({ clientId, siteId, target: "https://offline.invalid/" });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const twin = fx.exchanges.find((one) => one.note.startsWith("setup") && one.request.path.startsWith("/api/decisions?"))!.body.decisions[0];
    return agent.post(`/api/tests/${started.body.test.id}/retest`).set("Idempotency-Key", key).send({ twinId: twin.id });
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
    const started = await agent.post("/api/scans").set("Idempotency-Key", "press-7").send({ clientId, siteId, target: "https://offline.invalid/" });
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
  });
});
