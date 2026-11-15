import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import type { Express } from "express";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { performance } from "node:perf_hooks";

import { makeApp, signIn, signInToBackend } from "./helpers";

/**
 * SAFETY (DASH-FAILSAFE-2): no missing or odd field makes the failsafe less
 * strict, and none delays a stop.
 *
 *   1. A command whose `required_signatures` is missing (or not a whole number
 *      of at least one) read as needing 1: a stand-down needing two showed
 *      "1/1 signed" after one signature. Now the count is null -- unknown,
 *      never fewer -- and the stop is still signed and relayed, from memory,
 *      within the bound.
 *   2. A command row with no uuid was drawn as a command nobody can open, and
 *      counted nowhere. Now it is counted with its list's unreadable rows, and
 *      when it may be a stop (its action is a stop's, or none a start can be
 *      told from) it is said as one (`possibleStops`), so the console never
 *      reads the stop awaiting a signature as nothing.
 *   3. A stored kill-switch flag that is not exactly `false` -- "true", 1,
 *      null, a record, "false", 0, or missing from the row -- read as off at
 *      one site or another: a resume's signature went out, or an ordinary
 *      write went through. Now each reads as engaged everywhere; and every
 *      stop -- a failsafe pause's draft and signature, a scan's Stop -- still
 *      reaches its target within the existing bound.
 */

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The existing bound from a stop's press to its arrival (a-stop-presents-the-service-token-and-waits-on-no-sign-in.test.ts). */
const STOP_BOUND_MS = 300;

/** A command row as the control plane serves it; `drop` names fields it leaves out. */
const cmd = (uuid: string, action: string, status = "awaiting_signatures", extra: Record<string, unknown> = {}, drop: string[] = []) => {
  const row: Record<string, unknown> = {
    uuid, action, engine_id: "athena-1", nonce: "n", issued_at: "2026-11-03T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
    reason: "r", signers: [], required_signatures: action === "pause" || action === "resume" ? 1 : 2, status, ...extra,
  };
  for (const field of drop) delete row[field];
  return row;
};

/** What the stand-in control plane serves; a case sets it. */
const served: { state: unknown; commands: unknown; draft: Record<string, unknown> | null; detailDelayMs: number } = {
  state: {}, commands: [], draft: null, detailDelayMs: 0,
};
/** Longer than the bound: a stop that waited on a read made this slow would miss it. */
const SLOW_MS = 700;
/** Every request the control plane received, with when it arrived (performance.now()). */
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
      if (req.method === "GET" && path === "/api/failsafe/state/") return json(res, 200, served.state);
      if (req.method === "GET" && path === "/api/failsafe/commands/") return json(res, 200, served.commands);
      if (req.method === "GET" && path === "/api/failsafe/audit/") return json(res, 200, []);
      if (req.method === "POST" && path === "/api/failsafe/commands/") {
        drafted += 1;
        const action = (JSON.parse(raw) as { action: string }).action;
        return json(res, 201, { ...(served.draft ?? cmd(`drafted-${action}-${drafted}`, action)), signing_bytes: "00" });
      }
      const sig = /^\/api\/failsafe\/commands\/([^/]+)\/signatures\/$/.exec(path);
      if (req.method === "POST" && sig) {
        // The answer leaves out the count, as the rows above do.
        return json(res, 200, cmd(sig[1], sig[1].includes("resume") ? "resume" : "stand_down", "awaiting_signatures", { signers: ["k1"] }, ["required_signatures"]));
      }
      const one = /^\/api\/failsafe\/commands\/([^/]+)\/$/.exec(path);
      // The read of one command fails (slowly, when a case says so): a command not known here cannot be learnt in time,
      // and a stop that waited on it -- for a count, say -- would miss the bound.
      if (req.method === "GET" && one) {
        if (served.detailDelayMs) await sleep(served.detailDelayMs);
        return json(res, 500, { detail: "the control plane's read replica is down" });
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

/** The stored flag put back to exactly false, through storage (the route would refuse nothing). */
async function flagOff(): Promise<void> {
  await storage.updateAIControlSettings({ killSwitchEnabled: false, systemStatus: "active" });
}

beforeEach(async () => {
  Object.assign(served, { state: {}, commands: [], draft: null, detailDelayMs: 0 });
  seen.length = 0;
  aborts.length = 0;
  vi.restoreAllMocks();
  await flagOff();
  await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
});

const state = (lists: { awaiting?: unknown[]; ready?: unknown[]; recent?: unknown[] }) => ({
  engine_id: "athena-1", engine_state: "running", engine_state_available: true,
  awaiting_signatures: lists.awaiting ?? [], ready: lists.ready ?? [], recent: lists.recent ?? [],
});

describe("1. a missing required-signature count is unknown, never 1", () => {
  const ODD: Array<[string, Record<string, unknown>, string[]]> = [
    ["missing", {}, ["required_signatures"]],
    ["null", { required_signatures: null }, []],
    ["the string \"2\"", { required_signatures: "2" }, []],
    ["0", { required_signatures: 0 }, []],
    ["-1", { required_signatures: -1 }, []],
    ["1.5", { required_signatures: 1.5 }, []],
    ["true", { required_signatures: true }, []],
  ];
  for (const [name, extra, drop] of ODD) {
    it(`a stand-down whose count is ${name}: drawn, learnt, and its count null -- never 1`, async () => {
      const uuid = `standdown-count-${name.replace(/\W/g, "")}`;
      served.state = state({ awaiting: [cmd(uuid, "stand_down", "awaiting_signatures", { signers: ["alice"], ...extra }, drop)] });
      const res = await admin.get("/api/failsafe/state");
      expect(res.status).toBe(200);
      expect(res.body.awaitingSignatures).toHaveLength(1);
      expect(res.body.awaitingSignatures[0].uuid).toBe(uuid);
      expect(res.body.awaitingSignatures[0].requiredSignatures, "an unknown count is null, never read as fewer").toBeNull();
      expect(failsafe.knownActionOf(uuid)).toBe("stand_down");
    });
  }

  it("controls: a count the control plane gave is kept as it is (1 and 2)", async () => {
    served.state = state({ awaiting: [cmd("standdown-two", "stand_down"), cmd("pause-one", "pause")] });
    const res = await admin.get("/api/failsafe/state");
    expect(res.body.awaitingSignatures.map((c: { requiredSignatures: unknown }) => c.requiredSignatures)).toEqual([2, 1]);
  });

  it("a draft and a signature answer that leave the count out say it is unknown, and the stop's signature goes out within the bound, from memory -- waiting on no read for the count", async () => {
    served.detailDelayMs = SLOW_MS;
    served.draft = cmd("standdown-drafted-nocount", "stand_down", "awaiting_signatures", {}, ["required_signatures"]);
    const draft = await admin.post("/api/failsafe/commands").send({ action: "stand_down", engineId: "athena-1", reason: "r" });
    expect(draft.status).toBe(201);
    expect(draft.body.command.requiredSignatures).toBeNull();

    const pressed = performance.now();
    const sig = await admin.post("/api/failsafe/commands/standdown-drafted-nocount/signatures").send({ keyId: "k1", sig: "abcd" });
    expect(sig.status).toBe(200);
    expect(sig.body.requiredSignatures, "one signature on a count nobody gave is never 'fully signed'").toBeNull();
    const at = arrivedAt("POST /api/failsafe/commands/standdown-drafted-nocount/signatures/");
    expect(at).not.toBeNull();
    expect(at! - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
    expect(arrivedAt("GET /api/failsafe/commands/standdown-drafted-nocount/"), "relayed from memory, with no read").toBeNull();
  });
});

describe("2. a command row with no uuid is counted, and said as a possible stop when it may be one", () => {
  it("the state: rows with no uuid (or an empty or non-string one) are counted under their list; those that may be a stop are said as such", async () => {
    served.state = state({
      awaiting: [
        cmd("x", "stand_down", "awaiting_signatures", {}, ["uuid"]),
        cmd("", "pause"),
        cmd("x", "terminate", "awaiting_signatures", { uuid: 7 }),
        cmd("x", "resume", "awaiting_signatures", {}, ["uuid"]),
        cmd("x", "x", "awaiting_signatures", {}, ["uuid", "action"]),
        cmd("standdown-good", "stand_down"),
      ],
      ready: [cmd("x", "pause", "ready", {}, ["uuid"]), null],
      recent: [cmd("x", "terminate", "executed", {}, ["uuid"])],
    });
    const res = await admin.get("/api/failsafe/state");
    expect(res.status).toBe(200);
    // Only a row that can be opened is drawn.
    expect(res.body.awaitingSignatures.map((c: { uuid: string }) => c.uuid)).toEqual(["standdown-good"]);
    expect(res.body.ready).toEqual([]);
    expect(res.body.recent).toEqual([]);
    expect(res.body.unreadable).toEqual({ awaitingSignatures: 5, ready: 2, recent: 1 });
    // The stand-down, the pause, the terminate and the row with no action may each be a stop; the resume is not;
    // the null row's action cannot be read. The history (recent) is counted, not said as stops.
    expect(res.body.possibleStops).toEqual({ awaitingSignatures: 4, ready: 2 });
  });

  it("a row with no uuid whose action is a start is counted, but not said as a stop", async () => {
    served.state = state({ awaiting: [cmd("x", "release", "awaiting_signatures", {}, ["uuid"])] });
    const res = await admin.get("/api/failsafe/state");
    expect(res.body.unreadable).toEqual({ awaitingSignatures: 1 });
    expect(res.body).not.toHaveProperty("possibleStops");
  });

  it("a clean state carries no count and no possible stop", async () => {
    served.state = state({ awaiting: [cmd("standdown-clean", "stand_down")] });
    const res = await admin.get("/api/failsafe/state");
    expect(res.body).not.toHaveProperty("unreadable");
    expect(res.body).not.toHaveProperty("possibleStops");
  });

  it("the command list: a row with no uuid is counted in its header, never dropped unsaid", async () => {
    served.commands = [cmd("x", "stand_down", "awaiting_signatures", {}, ["uuid"]), cmd("pause-listed", "pause")];
    const res = await admin.get("/api/failsafe/commands");
    expect(res.status).toBe(200);
    expect(res.body.map((c: { uuid: string }) => c.uuid)).toEqual(["pause-listed"]);
    expect(JSON.parse(res.headers["x-athena-unreadable-rows"] ?? "null")).toEqual({ commands: 1 });
  });

  it("the kill switch's read says a row with no uuid as a possible stop, and a stop's signature still goes out within the bound", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    served.commands = [cmd("x", "stand_down", "awaiting_signatures", {}, ["uuid"]), cmd("resume-swept", "resume")];
    try {
      expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
      const deadline = Date.now() + 3_000;
      while (failsafe.knownActionOf("resume-swept") === undefined && Date.now() < deadline) await sleep(20);
      await sleep(20);
      const said = warn.mock.calls.map((call) => String(call[0])).find((line) => line.includes("the kill switch's read of the failsafe commands"));
      expect(said, "the row was said, never dropped").toBeDefined();
      expect(said).toMatch(/\{"commands":1\}/);
      expect(said).toMatch(/1 of them possibly a stop/);

      // A stop not known here (it may be the row with no uuid) is relayed as a possible stop.
      const pressed = performance.now();
      const res = await admin.post("/api/failsafe/commands/standdown-unlisted/signatures").send({ keyId: "k1", sig: "abcd" });
      expect(res.status).toBe(200);
      const at = arrivedAt("POST /api/failsafe/commands/standdown-unlisted/signatures/");
      expect(at).not.toBeNull();
      expect(at! - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
    }
  }, 20_000);
});

describe("3. a stored kill-switch flag that is not exactly false reads as engaged; every stop still goes", () => {
  const MISSING = Symbol("missing");
  const FLAGS: Array<[string, unknown]> = [
    ["the string \"true\"", "true"], ["1", 1], ["null", null], ["a record", { on: true }],
    ["the string \"false\"", "false"], ["0", 0], ["missing from the row", MISSING],
  ];

  /** Store `flag` as the row's kill-switch flag, as data the type does not promise. */
  async function storeFlag(flag: unknown): Promise<void> {
    const row = (await storage.getAIControlSettings()) as unknown as Record<string, unknown>;
    if (flag === MISSING) delete row.killSwitchEnabled;
    else row.killSwitchEnabled = flag;
  }

  for (const [name, flag] of FLAGS) {
    it(`a flag stored as ${name}: an ordinary write is held, a resume refused, the page told engaged -- and a pause and a scan's Stop each arrive within the bound`, async () => {
      const tag = name.replace(/\W/g, "");
      // A resume known here (learnt from the state), and a scan running on the engine.
      served.state = state({ awaiting: [cmd(`resume-flag-${tag}`, "resume")] });
      expect((await admin.get("/api/failsafe/state")).status).toBe(200);
      const client = await storage.createClient({ name: `Flag ${tag}`, company: "F", email: `f-${tag}@f.test` });
      const test = await storage.createTest({
        clientId: client.id, testType: "vulnerability-scan", status: "running",
        findings: { runId: `run-flag-${tag}`, target: "https://offline.invalid/", results: [] },
      });
      await storeFlag(flag);
      // Every read of the stored flag is slow: a stop that waited on it would miss the bound.
      const read = storage.getKillSwitchState.bind(storage);
      vi.spyOn(storage, "getKillSwitchState").mockImplementation(async () => { await sleep(SLOW_MS); return read(); });
      try {
        // Ordinary write: held (enforceKillSwitch).
        const write = await admin.post("/api/clients").send({ name: "held", company: "held", email: "held@h.test" });
        expect(write.status, "an ordinary write is held").toBe(503);
        // A resume's signature: refused, never sent (killSwitchEngagedNow).
        const resume = await admin.post(`/api/failsafe/commands/resume-flag-${tag}/signatures`).send({ keyId: "k1", sig: "abcd" });
        expect(resume.status, "a resume is refused").toBe(503);
        expect(arrivedAt(`POST /api/failsafe/commands/resume-flag-${tag}/signatures/`), "the resume's signature never went out").toBeNull();
        // The page is told the switch is engaged.
        expect((await admin.get("/api/ai-control")).body.killSwitchEnabled).toBe(true);

        // Every stop goes, within the bound.
        const draftPressed = performance.now();
        const draft = await admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "athena-1", reason: "flag" });
        expect(draft.status).toBe(201);
        const draftAt = seen.filter((one) => one.line === "POST /api/failsafe/commands/").map((one) => one.at).find((at) => at >= draftPressed);
        expect(draftAt).toBeDefined();
        expect(draftAt! - draftPressed).toBeLessThanOrEqual(STOP_BOUND_MS);

        const stopPressed = performance.now();
        const stop = await admin.post(`/api/scans/${test.id}/abort`);
        expect(stop.status, JSON.stringify(stop.body)).toBeLessThan(300);
        const abortAt = aborts.find((one) => one.runId === `run-flag-${tag}`)?.at;
        expect(abortAt, "the scan's Stop reached the engine").toBeDefined();
        expect(abortAt! - stopPressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      } finally {
        await flagOff();
      }
    }, 30_000);
  }

  it("control: a flag stored as exactly false holds nothing", async () => {
    await flagOff();
    const write = await admin.post("/api/clients").send({ name: "free", company: "free", email: "free@f.test" });
    expect(write.status).toBe(201);
    expect((await admin.get("/api/ai-control")).body.killSwitchEnabled).toBe(false);
  });
});

describe("every odd field at once: a stop pressed reaches its target within the bound", () => {
  it("a stand-down with no count, rows with no uuid, and a flag stored as \"true\": a pause's draft and a scan's Stop each arrive within the bound", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    served.state = state({
      awaiting: [cmd("standdown-all", "stand_down", "awaiting_signatures", {}, ["required_signatures"]), cmd("x", "terminate", "awaiting_signatures", {}, ["uuid"])],
    });
    served.commands = [cmd("x", "pause", "awaiting_signatures", {}, ["uuid"])];
    const client = await storage.createClient({ name: "All odd", company: "A", email: "all@a.test" });
    const test = await storage.createTest({
      clientId: client.id, testType: "vulnerability-scan", status: "running",
      findings: { runId: "run-all-odd", target: "https://offline.invalid/", results: [] },
    });
    const row = (await storage.getAIControlSettings()) as unknown as Record<string, unknown>;
    row.killSwitchEnabled = "true";
    try {
      const reads = [admin.get("/api/failsafe/state"), admin.get("/api/failsafe/commands")];
      const draftPressed = performance.now();
      const draft = admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "athena-1", reason: "all" });
      const stopPressed = performance.now();
      const stop = admin.post(`/api/scans/${test.id}/abort`);
      const [d, s] = await Promise.all([draft, stop]);
      expect(d.status).toBe(201);
      expect(s.status).toBeLessThan(300);
      const draftAt = seen.filter((one) => one.line === "POST /api/failsafe/commands/").map((one) => one.at).find((at) => at >= draftPressed);
      expect(draftAt! - draftPressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      const abortAt = aborts.find((one) => one.runId === "run-all-odd")?.at;
      expect(abortAt).toBeDefined();
      expect(abortAt! - stopPressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      const [st, list] = await Promise.all(reads);
      expect(st.body.awaitingSignatures[0].requiredSignatures).toBeNull();
      expect(st.body.possibleStops).toEqual({ awaitingSignatures: 1 });
      expect(JSON.parse(list.headers["x-athena-unreadable-rows"] ?? "null")).toEqual({ commands: 1 });
    } finally {
      await flagOff();
    }
  }, 20_000);
});
