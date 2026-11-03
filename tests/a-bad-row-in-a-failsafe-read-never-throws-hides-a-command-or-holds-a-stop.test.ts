import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import type { Express } from "express";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { performance } from "node:perf_hooks";

import { makeApp, signIn, signInToBackend } from "./helpers";

/**
 * SAFETY (DASH-FAILSAFE-ROWS): a row the failsafe control plane serves that
 * cannot be read never fails the failsafe's own reads, never hides a command,
 * and never holds a stop.
 *
 * The stop lane's reads -- the state (where a second operator finds the stop
 * awaiting their signature), the command list (which the kill switch reads,
 * once its stops are on their way, to learn the actions of the commands in
 * flight) -- and the audit trail mapped each row with command() / auditEvent(),
 * which read `raw.uuid` with no check: one null row threw, the read answered
 * 500, and every good row went with it. A stand-down awaiting its second
 * signature vanished from the console; a resume listed beside the bad row was
 * not learnt, so with the kill switch engaged its signature could go out as a
 * "possible stop". A list served as something that is not a list read as none.
 *
 * Now each list is read through rowsOf (server/unreadable-rows.ts): every good
 * row is shown and acted on, every bad row is counted -- on the state's
 * `unreadable`, and in the X-Athena-Unreadable-Rows header of the bare-list
 * answers (the command list and the audit trail, whose bodies stay arrays) --
 * and a list that is not one is "not a list", never none. A command whose row
 * could not be read is not known here, so its signature is relayed as a
 * possible stop: never "no command". And no stop waits on any of these reads.
 */

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The existing bound from a stop's press to its arrival (a-stop-presents-the-service-token-and-waits-on-no-sign-in.test.ts). */
const STOP_BOUND_MS = 300;

/** Rows a backend can serve that are not a command: none of them may throw, and each is counted. */
const BAD_ROWS: Array<[string, unknown]> = [["null", null], ["a string", "garbage"], ["a number", 7], ["a list", ["x"]], ["true", true]];

const cmd = (uuid: string, action: string, status = "awaiting_signatures") => ({
  uuid, action, engine_id: "athena-1", nonce: "n", issued_at: "2026-11-03T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
  reason: "r", signers: [], required_signatures: action === "pause" || action === "resume" ? 1 : 2, status,
});
const event = (uuid: string) => ({ uuid, timestamp: "2026-11-03T00:00:00Z", event: "command_drafted", command_uuid: null, actor_username: "alice", detail: {} });

/** What the stand-in control plane serves for each read; a case sets them. */
const served: { state: unknown; commands: unknown; audit: unknown; readDelayMs: number; detailFails: boolean } = {
  state: {}, commands: [], audit: [], readDelayMs: 0, detailFails: true,
};
/** Every request the control plane received, with when it had arrived (performance.now()). */
const seen: Array<{ line: string; at: number }> = [];
const arrivedAt = (line: string) => seen.find((one) => one.line === line)?.at ?? null;

function controlPlane() {
  let drafted = 0;
  return http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      const path = (req.url ?? "").split("?")[0];
      const line = `${req.method} ${path}`;
      seen.push({ line, at: performance.now() });
      if (path === "/api/token/" || path === "/api/token/refresh/") return json(res, 200, { access: "t", refresh: "r" });
      if (req.method === "GET" && path === "/api/failsafe/state/") {
        if (served.readDelayMs) await sleep(served.readDelayMs);
        return json(res, 200, served.state);
      }
      if (req.method === "GET" && path === "/api/failsafe/commands/") {
        if (served.readDelayMs) await sleep(served.readDelayMs);
        return json(res, 200, served.commands);
      }
      if (req.method === "GET" && path === "/api/failsafe/audit/") {
        if (served.readDelayMs) await sleep(served.readDelayMs);
        return json(res, 200, served.audit);
      }
      if (req.method === "POST" && path === "/api/failsafe/commands/") {
        drafted += 1;
        const action = (JSON.parse(raw) as { action: string }).action;
        return json(res, 201, { ...cmd(`drafted-${action}-${drafted}`, action), signing_bytes: "00" });
      }
      const sig = /^\/api\/failsafe\/commands\/([^/]+)\/signatures\/$/.exec(path);
      if (req.method === "POST" && sig) {
        const action = sig[1].includes("resume") ? "resume" : "pause";
        return json(res, 200, { ...cmd(sig[1], action, "ready"), signers: ["k1"] });
      }
      const cancel = /^\/api\/failsafe\/commands\/([^/]+)\/cancel\/$/.exec(path);
      if (req.method === "POST" && cancel) return json(res, 200, { ...cmd(cancel[1], "resume", "canceled") });
      const one = /^\/api\/failsafe\/commands\/([^/]+)\/$/.exec(path);
      if (req.method === "GET" && one) {
        // The read of one command fails: a command not known here cannot be learnt in time.
        if (served.detailFails) return json(res, 500, { detail: "the control plane's read replica is down" });
        return json(res, 200, { ...cmd(one[1], one[1].includes("resume") ? "resume" : "pause"), signing_bytes: "00" });
      }
      return json(res, 404, { detail: `no route ${line}` });
    });
  });
}

/** A stub engine: every run it is asked to stop is stopped, and when the stop arrived is recorded. */
const aborts: Array<{ runId: string; at: number }> = [];
function engine() {
  return http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active") return json(res, 200, { active: [] });
    const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
    if (abort) {
      aborts.push({ runId: decodeURIComponent(abort[1]), at: performance.now() });
      return json(res, 200, {});
    }
    if (req.method === "GET" && url.startsWith("/api/scans/")) return json(res, 200, { run_id: url.split("/")[3], state: "running", findings: [] });
    return json(res, 404, { detail: "no" });
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const ENV = ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD", "ATHENA_FAILSAFE_ENGINE_ID"];
let plane: Server;
let eng: Server;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let failsafe: typeof import("../server/failsafe");
let storage: import("../server/storage").IStorage;

beforeAll(async () => {
  plane = controlPlane();
  eng = engine();
  process.env.ATHENA_FAILSAFE_URL = await listen(plane);
  process.env.ATHENA_ENGINE_URL = await listen(eng);
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  process.env.ATHENA_FAILSAFE_USER = "svc";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc"; // pragma: allowlist secret
  process.env.ATHENA_FAILSAFE_ENGINE_ID = "athena-1";
  vi.resetModules();
  app = await makeApp();
  admin = await signIn(app);
  await signInToBackend(admin);
  failsafe = await import("../server/failsafe");
  storage = (await import("../server/storage-unified")).storage;
}, 60_000);

afterAll(async () => {
  for (const k of ENV) delete process.env[k];
  for (const server of [plane, eng]) {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

beforeEach(async () => {
  Object.assign(served, { state: {}, commands: [], audit: [], readDelayMs: 0, detailFails: true });
  seen.length = 0;
  aborts.length = 0;
  vi.restoreAllMocks();
  await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
});

/** The count the bare-list answer carried in its header, parsed; undefined when it carried none. */
function unreadableHeader(res: { headers: Record<string, string | undefined> }): unknown {
  const raw = res.headers["x-athena-unreadable-rows"];
  return raw === undefined ? undefined : JSON.parse(raw);
}

describe("the failsafe state: a bad row is counted by its list, every good row is shown and learnt", () => {
  for (const [name, bad] of BAD_ROWS) {
    it(`a row that is ${name}: the state answers 200 with every good command, and the bad rows counted`, async () => {
      const tag = name.replace(/\W/g, "");
      served.state = {
        engine_id: "athena-1", engine_state: "running", engine_state_available: true,
        awaiting_signatures: [bad, cmd(`standdown-state-${tag}`, "stand_down")],
        ready: [cmd(`pause-state-${tag}`, "pause", "ready"), bad],
        recent: [bad, bad, cmd(`resume-state-${tag}`, "resume", "executed")],
      };
      const res = await admin.get("/api/failsafe/state");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.awaitingSignatures.map((c: { uuid: string }) => c.uuid)).toEqual([`standdown-state-${tag}`]);
      expect(res.body.ready.map((c: { uuid: string }) => c.uuid)).toEqual([`pause-state-${tag}`]);
      expect(res.body.recent.map((c: { uuid: string }) => c.uuid)).toEqual([`resume-state-${tag}`]);
      expect(res.body.unreadable).toEqual({ awaitingSignatures: 1, ready: 1, recent: 2 });
      expect(res.body.engineState).toBe("running");
      // Every good row is learnt: a relay of its signature is decided from memory, with no read.
      expect(failsafe.knownActionOf(`standdown-state-${tag}`)).toBe("stand_down");
      expect(failsafe.knownActionOf(`resume-state-${tag}`)).toBe("resume");
    });
  }

  it("a list served as something that is not a list is 'not a list', never none", async () => {
    served.state = { engine_id: "athena-1", awaiting_signatures: { uuid: "standdown-hidden" }, ready: "garbage", recent: [] };
    const res = await admin.get("/api/failsafe/state");
    expect(res.status).toBe(200);
    expect(res.body.awaitingSignatures).toEqual([]);
    expect(res.body.unreadable).toEqual({ awaitingSignatures: "not a list", ready: "not a list" });
  });

  it("a clean state carries no count: its answer is as it was", async () => {
    served.state = { engine_id: "athena-1", awaiting_signatures: [cmd("standdown-clean", "stand_down")], ready: [], recent: [] };
    const res = await admin.get("/api/failsafe/state");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("unreadable");
    expect(res.body.awaitingSignatures).toHaveLength(1);
  });

  it("a row missing its fields is a record: shown as served, never dropped, and never learnt without an action", async () => {
    served.state = { engine_id: "athena-1", awaiting_signatures: [{}, { uuid: "noaction-state" }], ready: [], recent: [] };
    const res = await admin.get("/api/failsafe/state");
    expect(res.status).toBe(200);
    expect(res.body.awaitingSignatures.map((c: { uuid: string; action: string }) => [c.uuid, c.action])).toEqual([["", ""], ["noaction-state", ""]]);
    expect(res.body).not.toHaveProperty("unreadable");
    // Its action is not known here, so its signature is relayed as a possible stop (below), never refused from memory.
    expect(failsafe.knownActionOf("noaction-state")).toBeUndefined();
  });
});

describe("the command list: a bad row is counted, every good row is learnt", () => {
  for (const [name, bad] of BAD_ROWS) {
    it(`a row that is ${name}: the list answers 200 with every good command, the bad rows counted in its header`, async () => {
      const tag = name.replace(/\W/g, "");
      served.commands = [bad, cmd(`resume-list-${tag}`, "resume"), bad, cmd(`pause-list-${tag}`, "pause")];
      const res = await admin.get("/api/failsafe/commands");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.map((c: { uuid: string }) => c.uuid)).toEqual([`resume-list-${tag}`, `pause-list-${tag}`]);
      expect(unreadableHeader(res)).toEqual({ commands: 2 });
      expect(failsafe.knownActionOf(`resume-list-${tag}`)).toBe("resume");
      expect(failsafe.knownActionOf(`pause-list-${tag}`)).toBe("pause");
    });
  }

  it("a list that is not a list is 'not a list' in the header, never an empty list said as none", async () => {
    served.commands = { results: [cmd("pause-paged", "pause")] };
    const res = await admin.get("/api/failsafe/commands");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(unreadableHeader(res)).toEqual({ commands: "not a list" });
  });

  it("a clean list carries no header", async () => {
    served.commands = [cmd("pause-clean-list", "pause")];
    const res = await admin.get("/api/failsafe/commands");
    expect(res.status).toBe(200);
    expect(unreadableHeader(res)).toBeUndefined();
  });
});

describe("the audit trail: a bad row is counted and the read never fails", () => {
  for (const [name, bad] of BAD_ROWS) {
    it(`a row that is ${name}: the trail answers 200 with every good event, the bad rows counted in its header`, async () => {
      served.audit = [event("e1"), bad, event("e2"), bad];
      const res = await admin.get("/api/failsafe/audit");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.map((e: { uuid: string }) => e.uuid)).toEqual(["e1", "e2"]);
      expect(unreadableHeader(res)).toEqual({ events: 2 });
    });
  }

  it("a trail that is not a list is 'not a list', never 'no activity'", async () => {
    served.audit = "garbage";
    const res = await admin.get("/api/failsafe/audit");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(unreadableHeader(res)).toEqual({ events: "not a list" });
  });
});

describe("the kill switch's read of the commands: a bad row lets no resume through and holds no stop", () => {
  it("a RESUME listed beside a null row is learnt by the press, and refused from memory while the switch is engaged; a PAUSE beside it is relayed from memory", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    served.commands = [null, cmd("resume-sweep-1", "resume"), "garbage", cmd("pause-sweep-1", "pause")];
    served.detailFails = true;
    try {
      expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
      const deadline = Date.now() + 3_000;
      while (failsafe.knownActionOf("resume-sweep-1") === undefined && Date.now() < deadline) await sleep(20);
      expect(failsafe.knownActionOf("resume-sweep-1"), "the good rows beside the bad ones were learnt").toBe("resume");

      const resume = await admin.post("/api/failsafe/commands/resume-sweep-1/signatures").send({ keyId: "k1", sig: "abcd" });
      expect(resume.status, "a resume is refused while the switch is engaged").toBe(503);
      expect(arrivedAt("POST /api/failsafe/commands/resume-sweep-1/signatures/"), "the resume's signature never went out").toBeNull();

      const pressed = performance.now();
      const pause = await admin.post("/api/failsafe/commands/pause-sweep-1/signatures").send({ keyId: "k1", sig: "abcd" });
      expect(pause.status).toBe(200);
      const at = arrivedAt("POST /api/failsafe/commands/pause-sweep-1/signatures/");
      expect(at).not.toBeNull();
      expect(at! - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      expect(arrivedAt("GET /api/failsafe/commands/pause-sweep-1/"), "relayed from memory, with no read").toBeNull();
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
    }
  }, 20_000);

  it("a command whose row could not be read is never 'no command': its signature is relayed as a possible stop", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    served.commands = [null, cmd("resume-sweep-2", "resume")];
    try {
      expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
      const deadline = Date.now() + 3_000;
      while (failsafe.knownActionOf("resume-sweep-2") === undefined && Date.now() < deadline) await sleep(20);
      // The null row's command is not known here; its read fails: relayed as a possible stop, never refused as absent.
      expect(failsafe.knownActionOf("pause-unlisted-2")).toBeUndefined();
      const res = await admin.post("/api/failsafe/commands/pause-unlisted-2/signatures").send({ keyId: "k1", sig: "abcd" });
      expect(res.status).toBe(200);
      expect(arrivedAt("POST /api/failsafe/commands/pause-unlisted-2/signatures/")).not.toBeNull();
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
    }
  }, 20_000);
});

describe("a stop pressed while every failsafe read serves bad rows, slowly, reaches its target within the bound", () => {
  it("a pause drafted, a pause's signature and the kill switch's stop each arrive within the bound while the state, list and audit reads are in flight", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    served.readDelayMs = 800;
    served.state = { engine_id: "athena-1", awaiting_signatures: [null, cmd("standdown-slow", "stand_down")], ready: ["x"], recent: [7] };
    served.commands = [null, cmd("pause-slow-known", "pause"), true];
    served.audit = [null, event("e-slow")];
    // A pause this dashboard drafted is known here: its signature is relayed from memory.
    const draftedFirst = await admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "athena-1", reason: "known" });
    expect(draftedFirst.status).toBe(201);
    const known = draftedFirst.body.command.uuid as string;
    const client = await storage.createClient({ name: "Slow reads", company: "S", email: "slow@s.test" });
    await storage.createTest({
      clientId: client.id, testType: "vulnerability-scan", status: "running",
      findings: { runId: "run-slow-reads", target: "https://offline.invalid/", results: [] },
    });
    try {
      // The reads go first, and are in flight (each answered 800 ms later) when the stops are pressed.
      const reads = [admin.get("/api/failsafe/state"), admin.get("/api/failsafe/commands"), admin.get("/api/failsafe/audit")];
      await sleep(50);

      const draftPressed = performance.now();
      const draft = admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "athena-1", reason: "slow reads" });
      const sigPressed = performance.now();
      const sig = admin.post(`/api/failsafe/commands/${known}/signatures`).send({ keyId: "k1", sig: "abcd" });
      const killPressed = performance.now();
      const kill = admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
      const [d, s, k] = await Promise.all([draft, sig, kill]);
      expect([d.status, s.status, k.status]).toEqual([201, 200, 200]);

      const draftAt = seen.filter((one) => one.line === "POST /api/failsafe/commands/").map((one) => one.at).find((at) => at >= draftPressed);
      expect(draftAt, "the pause's draft reached the control plane").toBeDefined();
      expect(draftAt! - draftPressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      const sigAt = arrivedAt(`POST /api/failsafe/commands/${known}/signatures/`);
      expect(sigAt).not.toBeNull();
      expect(sigAt! - sigPressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      const abortAt = aborts.find((one) => one.runId === "run-slow-reads")?.at;
      expect(abortAt, "the kill switch's stop reached the engine").toBeDefined();
      expect(abortAt! - killPressed).toBeLessThanOrEqual(STOP_BOUND_MS);

      // And the reads, once answered, are whole: good rows shown, bad rows counted.
      const [state, list, audit] = await Promise.all(reads);
      expect([state.status, list.status, audit.status]).toEqual([200, 200, 200]);
      expect(state.body.unreadable).toEqual({ awaitingSignatures: 1, ready: 1, recent: 1 });
      expect(unreadableHeader(list)).toEqual({ commands: 2 });
      expect(unreadableHeader(audit)).toEqual({ events: 1 });
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
    }
  }, 30_000);
});
