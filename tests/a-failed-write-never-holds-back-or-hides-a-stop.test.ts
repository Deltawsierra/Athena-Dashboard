import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * R5-C. The round-4 test "when the audit log cannot be written, the stops
 * are still sent" failed ONLY createActivityLog. On a real full disk (or any
 * write failure: SQLITE_FULL, SQLITE_READONLY, a busy lock) the other writes
 * fail too, and:
 *   - PATCH /api/ai-control wrote the flag first and sent the stops only after
 *     it succeeded: the kill switch answered 500 and sent the engine NO stop,
 *     although the running scans could be read and the engine reached;
 *   - a scan's own Stop, and a failsafe draft, signature or withdrawal, went
 *     through -- then answered 500 on the audit-log write: a stop the engine
 *     accepted reported as a failure, and a drafted pause's uuid lost, so the
 *     console could not open it to sign;
 *   - POST /api/scans asked the engine to start BEFORE writing the row, and
 *     when the row could not be written answered 500 ("the start failed")
 *     while the engine scanned on with no row: no Stop, nothing the kill
 *     switch could find, and the run was never stopped.
 *
 * (The adversary's reproducer pinned each of those as observed. Its
 * assertions are inverted here.)
 *
 * Now every stop goes out whatever a write does, the answer says what it came
 * to, and the writes after a stop are best-effort.
 */

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

function stubEngine() {
  const calls: string[] = [];
  const running = new Set<string>();
  const refuse = new Set<string>();
  let next = 0;
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    calls.push(`${req.method} ${url}`);
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active") return json(res, 200, { active: Array.from(running, (run_id) => ({ run_id, target: null, state: "running" })) });
    const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
    if (abort) {
      if (refuse.has(abort[1])) return json(res, 500, { detail: "no" });
      running.delete(abort[1]);
      return json(res, 200, {});
    }
    if (req.method === "GET" && url.startsWith("/api/scans/")) {
      return json(res, 200, { state: running.has(url.split("/")[3]) ? "running" : "aborted", result: { results: [] } });
    }
    next += 1;
    running.add(`run-${next}`);
    return json(res, 202, { run_id: `run-${next}`, state: "running" });
  });
  return { server, calls, running, refuse, nextRun: () => `run-${next + 1}` };
}

function stubControlPlane() {
  const calls: string[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      calls.push(`${req.method} ${path}`);
      const now = new Date().toISOString();
      const cmd = (action: string, status = "awaiting_signatures") => ({
        uuid: "pause-new", engine_id: "athena-1", action, nonce: "n", issued_at: now, expires_at: now, reason: "r",
        signers: [], required_signatures: 2, status, created_at: now, updated_at: now,
      });
      if (path === "/api/token/") return json(res, 200, { access: "t" });
      if (path === "/api/failsafe/commands/" && req.method === "POST") {
        return json(res, 201, { ...cmd(JSON.parse(raw).action), signing_bytes: "beef" });
      }
      if (path === "/api/failsafe/commands/pause-new/") return json(res, 200, { ...cmd("pause"), signing_bytes: "beef" });
      if (path === "/api/failsafe/commands/pause-new/signatures/") return json(res, 200, { ...cmd("pause"), signers: ["bob"] });
      if (path === "/api/failsafe/commands/pause-new/cancel/") return json(res, 200, cmd("pause", "canceled"));
      return json(res, 404, {});
    });
  });
  return { server, calls };
}

const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

let engine: ReturnType<typeof stubEngine>;
let cp: ReturnType<typeof stubControlPlane>;
let admin: Awaited<ReturnType<typeof signIn>>;
let clientId = "";

beforeAll(async () => {
  engine = stubEngine();
  cp = stubControlPlane();
  process.env.ATHENA_ENGINE_URL = await listen(engine.server);
  process.env.ATHENA_ENGINE_KEY = "k";
  process.env.ATHENA_FAILSAFE_URL = await listen(cp.server);
  process.env.ATHENA_FAILSAFE_USER = "svc";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc";
  vi.resetModules();
  admin = await signIn(await makeApp());
  clientId = (await admin.post("/api/clients").send({ name: "W", company: "W", email: "w@w.test" })).body.id;
  await admin.post("/api/sites").send({ clientId, name: "W", url: "https://acme.example" });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  for (const k of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD"]) delete process.env[k];
  await new Promise<void>((r) => engine.server.close(() => r()));
  await new Promise<void>((r) => cp.server.close(() => r()));
});

async function runningScan() {
  const started = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/" });
  expect(started.status).toBe(201);
  return { testId: started.body.test.id as string, runId: started.body.runId as string };
}

/** A disk that is full: every write fails, reads work. */
async function diskFull() {
  const { storage } = await import("../server/storage-unified");
  const full = () => Promise.reject(new Error("SQLITE_FULL: database or disk is full"));
  for (const write of ["updateAIControlSettings", "createActivityLog", "updateTest", "createTest", "deleteTest", "deleteClient"] as const) {
    vi.spyOn(storage, write).mockImplementation(full as never);
  }
}

/** Let the status route record what the engine says of each run now (aborted, once stopped). */
async function recordState(...testIds: string[]) {
  for (const id of testIds) await admin.get(`/api/scans/${id}`);
}

const aborts = () => engine.calls.filter((one) => one.endsWith("/abort"));
const KILL = { killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] };

describe("a failed write never holds back or hides a stop", () => {
  it("engaging the kill switch on a full disk still sends every stop, and says the switch is not engaged", async () => {
    const scan = await runningScan();
    await diskFull();
    engine.calls.length = 0;
    const kill = await admin.patch("/api/ai-control").send(KILL);
    expect(aborts(), "the kill switch sent no stop because its flag write failed").toEqual([`POST /api/scans/${scan.runId}/abort`]);
    expect(kill.status).toBe(500);
    expect(kill.body.engaged).toBe(false);
    expect(kill.body.message).toMatch(/^The kill switch could not be engaged: SQLITE_FULL: database or disk is full\. Every stop was sent all the same/);
    expect(kill.body.stops).toEqual({
      listed: true,
      scans: [{ testId: scan.testId, runId: scan.runId, target: "https://acme.example/", stopped: true, detail: "" }],
    });
    expect(kill.body.engineRuns).toEqual({ listed: true, runs: [] });
    vi.restoreAllMocks();
    // Not engaged: the flag was never stored.
    expect((await admin.get("/api/ai-control")).body.killSwitchEnabled).toBe(false);
    await recordState(scan.testId);
  });

  it("an ordinary settings change whose write failed is still a failure, and sends no stop", async () => {
    await runningScan();
    await diskFull();
    engine.calls.length = 0;
    const saved = await admin.patch("/api/ai-control").send({ maxConcurrentTests: 4 });
    expect(saved.status).toBe(500);
    expect(aborts()).toEqual([]);
  });

  it("a scan's own Stop the engine accepted is reported as stopped", async () => {
    const scan = await runningScan();
    await diskFull();
    engine.calls.length = 0;
    const stop = await admin.post(`/api/scans/${scan.testId}/abort`);
    expect(engine.calls).toContain(`POST /api/scans/${scan.runId}/abort`);
    expect(stop.status, `body: ${JSON.stringify(stop.body)}`).toBe(200);
    expect(stop.body).toEqual({ stopped: true, runId: scan.runId });
    vi.restoreAllMocks();
    await recordState(scan.testId);
  });

  it("a scan the engine started but could not be recorded here is stopped at once, and the answer says so", async () => {
    const { storage } = await import("../server/storage-unified");
    vi.spyOn(storage, "createTest").mockRejectedValue(new Error("SQLITE_FULL: database or disk is full"));
    const runId = engine.nextRun();
    engine.calls.length = 0;
    const start = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/" });
    expect(engine.calls).toContain("POST /api/scan"); // the engine is scanning
    expect(start.status).toBe(500);
    expect(start.body).toMatchObject({ runId, stopped: true });
    expect(start.body.error).toBe(
      `the engine started run ${runId} but it could not be recorded here (SQLITE_FULL: database or disk is full); ` +
      "the run was sent a stop, and the engine accepted it",
    );
    expect(aborts(), "the unrecorded run was never stopped").toEqual([`POST /api/scans/${runId}/abort`]);
    expect(engine.running.has(runId)).toBe(false);
  });

  it("...and when that stop does not take, it says the run may still be running", async () => {
    const { storage } = await import("../server/storage-unified");
    vi.spyOn(storage, "createTest").mockRejectedValue(new Error("SQLITE_FULL: database or disk is full"));
    const nextRun = engine.nextRun();
    engine.refuse.add(nextRun);
    const start = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/" });
    engine.refuse.clear();
    expect(start.status).toBe(500);
    expect(start.body).toMatchObject({ runId: nextRun, stopped: false });
    expect(start.body.error).toMatch(/it may still be running -- stop it with the kill switch or a failsafe pause$/);
    // The kill switch reaches it through the engine's own list, row or none.
    const kill = await admin.patch("/api/ai-control").send(KILL);
    expect(kill.body.engineRuns.runs).toContainEqual({ runId: nextRun, target: null, testId: null, stopped: true, detail: "" });
    await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active", activeSystems: ["penetration-testing", "vulnerability-scanner"] });
  });

  it("once the row is written, a log write that failed does not answer 'the start failed'", async () => {
    const { storage } = await import("../server/storage-unified");
    vi.spyOn(storage, "createActivityLog").mockRejectedValue(new Error("SQLITE_FULL: database or disk is full"));
    const start = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/" });
    expect(start.status).toBe(201);
    expect(typeof start.body.test.id).toBe("string");
    vi.restoreAllMocks();
    expect((await admin.post(`/api/scans/${start.body.test.id}/abort`)).status).toBe(200);
    await recordState(start.body.test.id);
  });

  it("deleting a running scan whose stop was accepted, when the delete then fails, says the run was stopped", async () => {
    const scan = await runningScan();
    await diskFull();
    const del = await admin.delete(`/api/tests/${scan.testId}`);
    expect(del.status).toBe(500);
    expect(del.body.message).toBe(
      `Engine run ${scan.runId} was stopped (the engine accepted the stop), but the test could not be deleted: ` +
      "SQLITE_FULL: database or disk is full",
    );
    expect(del.body.stops).toMatchObject([{ runId: scan.runId, stopped: true }]);
  });

  it("a failsafe pause drafted on the control plane is answered with its uuid", async () => {
    await diskFull();
    cp.calls.length = 0;
    const draft = await admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "athena-1", reason: "r" });
    expect(cp.calls).toContain("POST /api/failsafe/commands/");
    expect(draft.status, `body: ${JSON.stringify(draft.body)}`).toBe(201);
    expect(draft.body.command.uuid).toBe("pause-new");
  });

  it("a signature relayed, and a withdrawal the control plane took, are answered as done", async () => {
    await diskFull();
    const sig = await admin.post("/api/failsafe/commands/pause-new/signatures").send({ keyId: "bob", sig: "abcd" });
    expect(sig.status, `body: ${JSON.stringify(sig.body)}`).toBe(200);
    expect(sig.body.signers).toEqual(["bob"]);
    const cancel = await admin.post("/api/failsafe/commands/pause-new/cancel").send({});
    expect(cancel.status, `body: ${JSON.stringify(cancel.body)}`).toBe(200);
    expect(cancel.body.status).toBe("canceled");
  });
});
