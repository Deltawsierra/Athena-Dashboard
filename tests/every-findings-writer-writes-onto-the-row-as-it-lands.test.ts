import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import type { Test } from "@shared/schema";
import { NOT_KNOWN_STATUS } from "@shared/engine-record";
import type { IStorage } from "../server/storage";
import type { AdoptionDeps } from "../server/backend-adoption";
import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";

/**
 * A scan row's `findings` has more writers than the three
 * tests/two-writes-to-a-scan-row-never-drop-each-others-findings.test.ts holds
 * to the rule. Each of these five read the row, awaited, and wrote the WHOLE
 * `findings` back from that read, so a key another writer set in between was
 * gone:
 *
 *   1. the not-known reading of a legacy row (server/routes.ts markRunNotKnown);
 *   2. the start's `stop: "backend"` mark, after the first direct read 404s;
 *   3. a person's act, Record as not known to the engine (record-not-known);
 *   4. the adoption's first direct read, which clears that mark
 *      (server/backend-adoption.ts firstDirectReads);
 *   5. a person's edit of an engine scan (PATCH /api/tests/:id), which also
 *      wrote back the status and counts it had read.
 *
 * Now each writes onto the row as it is when the write lands (updateTestWith).
 * The order is forced, not hoped for: the writer's write -- by whatever
 * storage call it makes -- is held, another writer's key lands on the row
 * while it is held, and then the write is let go. Both must stand.
 *
 * While a write is held, every other write of that row through the storage
 * waits behind it, as a held lock would. A Stop writes nothing before its
 * answer, so a Stop sent then is answered: case 1 checks it is.
 */

const TOKEN = "f".repeat(64);
const NOTE = "checked by hand: the login form is behind a WAF";

/**
 * One engine for both kinds of row. Runs it started (a hybrid scan's) stay
 * running until stopped; any other run id -- a legacy row's lost run -- is
 * answered 404 "No such scan run" to a read and to a stop. `tenantBound`
 * makes every run read 404 to the dashboard's key, as a run another tenant's
 * key started does.
 */
function stubEngine() {
  const calls: string[] = [];
  const runs = new Map<string, string>();
  const control = { tenantBound: false };
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
        const active = Array.from(runs).filter(([, state]) => state === "running").map(([run_id]) => ({ run_id, target: "", kind: "scan", state: "running" }));
        return json(res, 200, { active });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        const id = decodeURIComponent(abort[1]);
        if (!runs.has(id)) return json(res, 404, { detail: "No such scan run" });
        runs.set(id, "aborted");
        return json(res, 200, { run_id: id, state: "aborting" });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = decodeURIComponent(url.slice("/api/scans/".length));
        if (control.tenantBound && req.headers["x-api-key"] === "dashboard-key") return json(res, 404, { detail: "No such scan run" });
        const state = runs.get(id);
        if (state === undefined) return json(res, 404, { detail: "No such scan run" });
        return json(res, 200, { run_id: id, state, done: state !== "running", result: { results: [] } });
      }
      if (req.method === "POST" && url === "/api/scan") {
        next += 1;
        const id = `run-${next}`;
        runs.set(id, "running");
        return json(res, 202, { run_id: id, state: "running" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  return { server, calls, runs, control, aborts: (runId: string) => calls.filter((one) => one === `POST /api/scans/${runId}/abort`) };
}

let engine: ReturnType<typeof stubEngine>;
let hybrid: HybridBackendStandIn;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let notKnown: { reads: number; floorMs: number; persistEveryMs: number };
let clientId = "";
let rows = 0;

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
  notKnown = (await import("../server/routes")).notKnown;
  admin = await signIn(app);
  await signInToBackend(admin);
  storage = (await import("../server/storage-unified")).storage;
  clientId = (await admin.post("/api/clients").send({ name: "Rows", company: "Rows Co", email: "rows@x.test" })).body.id;
  await admin.post("/api/sites").send({ clientId, name: "acme.example", url: "https://acme.example" });
});

afterEach(() => {
  vi.restoreAllMocks();
  // Every run of a case ends with it, so Max Concurrent Tests (counted from the engine's live list) never refuses the next.
  engine.runs.clear();
  engine.control.tenantBound = false;
  Object.assign(notKnown, { reads: 5, floorMs: 30_000, persistEveryMs: 60_000 });
});

afterAll(async () => {
  for (const name of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_SERVICE_TOKEN"]) delete process.env[name];
  (app.locals.collectWatcher as { halt(): void } | undefined)?.halt();
  await hybrid.close();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
});

/** A scan this dashboard dispatched to the engine itself, recorded running, whose run the engine does not know. */
async function aLegacyScan() {
  rows += 1;
  const runId = `lost-${rows}`;
  const test = await storage.createTest({
    clientId, testType: "vulnerability-scan", status: "running",
    findings: { runId, target: "https://acme.example/", results: [] },
  } as never);
  return { testId: test.id, runId };
}

const findingsOf = (row: { findings: unknown } | undefined) => (row?.findings ?? {}) as Record<string, unknown>;

async function until(ok: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

// ---- The gate ----

type Patch = Record<string, unknown>;
interface Gate {
  /** The row whose write is held; null until the writer's write was made. */
  id: string | null;
  held: boolean;
  landed: boolean;
  release(): void;
  /** The storage's own writes, past the gate: what "another writer" lands with. */
  real: Pick<IStorage, "updateTestWith">;
}

/**
 * Hold the first write, of any row, that `isTheWrite` recognises by what it
 * writes, until `release()`. Every storage call that writes a test row
 * (`updateTest...`) is gated, whether it is handed the change itself or a
 * function of the row as it is when it lands -- which is asked, on a copy,
 * what it would write. While it is held, every other gated write of that row
 * waits behind it.
 */
function gateTheWrite(store: IStorage, isTheWrite: (row: Test, patch: Patch) => boolean): Gate {
  const target = store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const names = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter((name) => /^updateTest/.test(name));
  expect(names).toEqual(expect.arrayContaining(["updateTest", "updateTestWith"]));
  const real = Object.fromEntries(names.map((name) => [name, target[name].bind(store)]));
  let open!: () => void;
  const released = new Promise<void>((r) => { open = r; });
  let armed = true;
  const gate: Gate = {
    id: null, held: false, landed: false, release: () => open(),
    real: { updateTestWith: real.updateTestWith as IStorage["updateTestWith"] },
  };
  for (const name of names) {
    vi.spyOn(target, name).mockImplementation(async (id: unknown, arg: unknown) => {
      const key = String(id);
      if (armed) {
        const row = store.peekTest(key) ?? (await store.getTest(key));
        const patch = row && (typeof arg === "function" ? (arg as (one: Test) => unknown)(structuredClone(row)) : arg);
        if (row && armed && patch && typeof patch === "object" && isTheWrite(row, patch as Patch)) {
          armed = false;
          gate.id = key;
          gate.held = true;
          await released;
          gate.held = false;
          const out = await real[name](id, arg);
          gate.landed = true;
          return out;
        }
      }
      if (gate.held && key === gate.id) await released;
      return real[name](id, arg);
    });
  }
  return gate;
}

/** Another writer's key, landed on the row as it is now, past the gate. */
const land = (gate: Gate, keys: Patch, fields: Patch = {}) =>
  gate.real.updateTestWith(gate.id!, (row) => ({ ...fields, findings: { ...findingsOf(row), ...keys } }));

describe("every writer of a scan row's findings writes onto the row as it lands", () => {
  it("1. the not-known reading of a legacy row: a person's note written while it is held stays -- and a Stop sent then is answered", async () => {
    Object.assign(notKnown, { reads: 2, floorMs: 0 });
    const { testId, runId } = await aLegacyScan();
    const gate = gateTheWrite(storage, (row, patch) =>
      findingsOf(patch).notKnown !== undefined && findingsOf(row).notKnown === undefined && !("status" in patch));

    await admin.get(`/api/scans/${testId}`);
    expect((await admin.get(`/api/scans/${testId}`)).body.engineKnowsRun).toBe(false);
    expect(await until(() => gate.held), "the reading's write was not made").toBe(true);
    expect(gate.id).toBe(testId);

    // A Stop sent while the reading's write is held is answered: no write stands before it.
    let answered: number | null = null;
    void admin.post(`/api/scans/${testId}/abort`).then((res) => { answered = res.status; });
    expect(await until(() => answered !== null, 2_000), "the Stop waited on the row's write").toBe(true);
    expect(engine.aborts(runId)).toHaveLength(1);
    expect(gate.held).toBe(true);

    await land(gate, { details: NOTE });
    gate.release();
    expect(await until(() => gate.landed), "the reading's write did not land").toBe(true);

    const row = await storage.getTest(testId);
    expect(findingsOf(row).details, "the reading's write dropped the note").toBe(NOTE);
    expect(findingsOf(row).notKnown).toMatchObject({ reads: 2, said: expect.stringContaining("No such scan run") });
    expect(row?.status).toBe("running");
  });

  it("2. the start's stop: \"backend\" mark: a Stop's mirror reading written while it is held stays, on the row and in the start's answer", async () => {
    engine.control.tenantBound = true;
    const gate = gateTheWrite(storage, (row, patch) =>
      findingsOf(patch).stop === "backend" && findingsOf(row).stop !== "backend");

    const starting = admin.post("/api/scans").send({ clientId, target: "https://acme.example/login", consent: true });
    const answer = starting.then((res) => res);
    expect(await until(() => gate.held), "the mark's write was not made").toBe(true);
    await land(gate, { backendMirror: { mirrored: true, at: new Date().toISOString() } });
    gate.release();

    const started = await answer;
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(gate.landed).toBe(true);
    expect(started.body.test.id).toBe(gate.id);
    expect(started.body.stop).toBe("backend");
    expect(started.body.test.findings.stop).toBe("backend");
    expect(started.body.test.findings.backendMirror, "the mark's write dropped the mirror's reading").toMatchObject({ mirrored: true });
    const row = await storage.getTest(gate.id!);
    expect(findingsOf(row).stop).toBe("backend");
    expect(findingsOf(row).backendMirror).toMatchObject({ mirrored: true });
    expect(findingsOf(row).backendScanId).toEqual(expect.any(String));
  });

  it("3. a person's act, Record as not known: the reading and a note written while it is held stay beside the act's record", async () => {
    const { testId, runId } = await aLegacyScan();
    const gate = gateTheWrite(storage, (_row, patch) => patch.status === NOT_KNOWN_STATUS);

    const recording = admin.post(`/api/scans/${testId}/record-not-known`).send({}).then((res) => res);
    expect(await until(() => gate.held), "the act's write was not made").toBe(true);
    // The stop was sent before anything was written.
    expect(engine.aborts(runId)).toHaveLength(1);
    const reading = { since: new Date().toISOString(), reads: 5, lastReadAt: new Date().toISOString(), said: "No such scan run" };
    await land(gate, { details: NOTE, notKnown: reading });
    gate.release();

    const recorded = await recording;
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    expect(recorded.body.recorded).toBe(true);
    const row = await storage.getTest(testId);
    expect(row?.status).toBe(NOT_KNOWN_STATUS);
    expect(findingsOf(row).details, "the act's write dropped the note").toBe(NOTE);
    expect(findingsOf(row).notKnown, "the act's write dropped the reading").toMatchObject({ ...reading, recorded: { by: expect.any(String) } });
    expect(recorded.body.test.findings.details).toBe(NOTE);
  });

  it("5. a person's edit of an engine scan: the run's end written while it is held stays -- its status, its results and its counts", async () => {
    const { testId } = await aLegacyScan();
    const gate = gateTheWrite(storage, (_row, patch) => patch.summary === "edited");

    // The Edit dialog sends every field back: the status unchanged, and the notes.
    const editing = admin.patch(`/api/tests/${testId}`).send({ summary: "edited", status: "running", findings: { details: NOTE } }).then((res) => res);
    expect(await until(() => gate.held), "the edit's write was not made").toBe(true);
    // The live poll reads the run's end meanwhile.
    const results = [{ type: "xss", severity: "high", endpoint: "/search", title: "Reflected XSS" }];
    await land(gate, { results }, { status: "completed", completedAt: new Date(), vulnerabilitiesFound: 1, highCount: 1, severity: "high" });
    gate.release();

    const edited = await editing;
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const row = await storage.getTest(testId);
    expect(row?.summary).toBe("edited");
    expect(findingsOf(row).details).toBe(NOTE);
    expect(row?.status, "the edit wrote back the status it had read").toBe("completed");
    expect(findingsOf(row).results, "the edit dropped the run's results").toEqual(results);
    expect(row?.highCount).toBe(1);
    expect(row?.completedAt).not.toBeNull();
    expect(edited.body.status).toBe("completed");
    expect(edited.body.findings.results).toEqual(results);
  });
});

describe("two people's edits of one test, at once", () => {
  it("6. both complete it: the first to land stamps completedAt, the second keeps that time and neither drops the other's field", async () => {
    // A person's test: no engine run stands behind it, so an edit writes its status and completedAt.
    const test = await storage.createTest({ clientId, testType: "manual-review", status: "pending", findings: null } as never);
    const gate = gateTheWrite(storage, (_row, patch) => patch.summary === "first");
    const writes = () => vi.mocked(storage.updateTestWith).mock.calls.length;

    const first = admin.patch(`/api/tests/${test.id}`).send({ status: "completed", summary: "first" }).then((res) => res);
    expect(await until(() => gate.held), "the first edit's write was not made").toBe(true);
    // The second edit is read and stamped while the first is held: its read sees the test still pending.
    await new Promise((r) => setTimeout(r, 25));
    const second = admin.patch(`/api/tests/${test.id}`).send({ status: "completed", severity: "high" }).then((res) => res);
    expect(await until(() => writes() >= 2), "the second edit's write was not made").toBe(true);
    await new Promise((r) => setTimeout(r, 25));
    gate.release();

    const [one, two] = [await first, await second];
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(two.status, JSON.stringify(two.body)).toBe(200);
    expect(one.body.completedAt).toEqual(expect.any(String));
    const row = await storage.getTest(test.id);
    expect(row?.status).toBe("completed");
    expect(row?.completedAt?.toISOString(), "the second edit stamped a completion over the first's").toBe(one.body.completedAt);
    expect(two.body.completedAt).toBe(one.body.completedAt);
    expect(row?.summary, "the second edit dropped the first's summary").toBe("first");
    expect(row?.severity, "the second edit's severity was not written").toBe("high");
  });
});

describe("the adoption's first direct read of an adopted run", () => {
  it("4. clears the stop: \"backend\" mark onto the row as it lands: a Stop's mirror reading written while it is held stays", async () => {
    const { MemStorage } = await import("../server/storage");
    const { firstDirectReads } = await import("../server/backend-adoption");
    const store = new MemStorage();
    const owner = await store.createClient({ name: "Adopted", company: "Adopted Co", email: "a@x.test" });
    const test = await store.createTest({
      clientId: owner.id, testType: "vulnerability-scan", status: "running",
      findings: { runId: "run-adopted", target: "https://acme.example/", backendScanId: "scan-adopted", stop: "backend" },
    } as never);
    const gate = gateTheWrite(store, (row, patch) => findingsOf(row).stop === "backend" && findingsOf(patch).stop === undefined);
    const deps = { storage: store, readRun: async () => "read" as const } as unknown as AdoptionDeps;

    const reading = firstDirectReads(deps, [{ testId: test.id, backendScanId: "scan-adopted", engineRunId: "run-adopted", status: "running", clientId: owner.id }]);
    expect(await until(() => gate.held), "the mark's clearing was not made").toBe(true);
    await land(gate, { backendMirror: { mirrored: true } });
    gate.release();
    await reading;

    expect(gate.landed).toBe(true);
    const row = await store.getTest(test.id);
    expect(findingsOf(row).stop, "the mark was not cleared").toBeUndefined();
    expect(findingsOf(row).backendMirror, "the clearing dropped the mirror's reading").toEqual({ mirrored: true });
    expect(findingsOf(row).backendScanId).toBe("scan-adopted");
  });
});
