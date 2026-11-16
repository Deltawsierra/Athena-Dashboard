import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import type { Express } from "express";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { performance } from "node:perf_hooks";

import { makeApp, signIn, signInToBackend } from "./helpers";

/**
 * SAFETY (DASH-FAILSAFE-3): no failsafe command is lost past the first page,
 * and every stop draft can be opened, or is said with why not.
 *
 *   1. The control plane's two stop-lane reads -- the state and the command
 *      list -- are bounded by row and byte limits (athena-backend
 *      failsafe/views.py `_Page`), and say when they left a command out: the
 *      state's `more` field, and both reads' X-Failsafe-More header. The
 *      dashboard read neither, so a cut list read as whole: a stand-down past
 *      the page was never learnt, never shown, and nothing said it existed.
 *      The reads take no cursor or offset, so there is no next page to
 *      follow. So the cut is said: the state carries `more` (true, or null
 *      when the control plane did not say), the list's route carries
 *      X-Failsafe-More, and the kill switch's read logs that more commands
 *      exist than were read. What was listed is learnt and relayed as before.
 *   2. Nothing about a page delays a stop: a pressed stop goes first, and a
 *      stop past the page (not known here) is relayed as a possible stop,
 *      within the existing bound, while every page read is slow.
 *   3. A stop drafted with no uuid answered 201 with `uuid ""`, and nothing
 *      said it could not be opened. Now its answer says why (`unopenable`),
 *      keeps the nonce it can be found by, and the activity log records both.
 */

const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The existing bound from a stop's press to its arrival (a-stop-presents-the-service-token-and-waits-on-no-sign-in.test.ts). */
const STOP_BOUND_MS = 300;
/** Longer than the bound: a stop that waited on a page read made this slow would miss it. */
const SLOW_MS = 800;

/** A command row as the control plane serves it. */
const cmd = (uuid: string, action: string, status = "awaiting_signatures", extra: Record<string, unknown> = {}) => ({
  uuid, action, engine_id: "athena-1", nonce: `nonce-${uuid}`, issued_at: "2026-11-03T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
  reason: "r", signers: [], required_signatures: action === "pause" || action === "resume" ? 1 : 2, status, ...extra,
});

/** What the stand-in control plane serves; a case sets it. `*More` is the X-Failsafe-More header, or none when undefined. */
const served: {
  state: unknown; stateMore: string | undefined; commands: unknown; commandsMore: string | undefined;
  pageDelayMs: number; draft: Record<string, unknown> | null;
} = { state: {}, stateMore: undefined, commands: [], commandsMore: undefined, pageDelayMs: 0, draft: null };
/** Every request the control plane received, with when it arrived (performance.now()). */
const seen: Array<{ line: string; at: number }> = [];
const arrivedAt = (line: string, after = 0) => seen.find((one) => one.line === line && one.at >= after)?.at ?? null;
const more = (value: string | undefined): Record<string, string> => (value === undefined ? {} : { "X-Failsafe-More": value });

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
        if (served.pageDelayMs) await sleep(served.pageDelayMs);
        return json(res, 200, served.state, more(served.stateMore));
      }
      if (req.method === "GET" && path === "/api/failsafe/commands/") {
        if (served.pageDelayMs) await sleep(served.pageDelayMs);
        return json(res, 200, served.commands, more(served.commandsMore));
      }
      if (req.method === "GET" && path === "/api/failsafe/audit/") return json(res, 200, []);
      if (req.method === "POST" && path === "/api/failsafe/commands/") {
        drafted += 1;
        const action = (JSON.parse(raw) as { action: string }).action;
        return json(res, 201, { ...(served.draft ?? cmd(`drafted-${action}-${drafted}`, action)), signing_bytes: "00" });
      }
      const sig = /^\/api\/failsafe\/commands\/([^/]+)\/signatures\/$/.exec(path);
      if (req.method === "POST" && sig) return json(res, 200, cmd(sig[1], "stand_down", "awaiting_signatures", { signers: ["k1"] }));
      // The read of one command fails at once: a command past the page is not learnt by it either.
      if (req.method === "GET" && /^\/api\/failsafe\/commands\/[^/]+\/$/.test(path)) return json(res, 500, { detail: "down" });
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
  Object.assign(served, { state: {}, stateMore: undefined, commands: [], commandsMore: undefined, pageDelayMs: 0, draft: null });
  seen.length = 0;
  aborts.length = 0;
  vi.restoreAllMocks();
  await storage.updateAIControlSettings({ killSwitchEnabled: false, systemStatus: "active" });
  await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
});

const state = (lists: { awaiting?: unknown[]; ready?: unknown[] }, extra: Record<string, unknown> = {}) => ({
  engine_id: "athena-1", engine_state: "running", engine_state_available: true,
  awaiting_signatures: lists.awaiting ?? [], ready: lists.ready ?? [], recent: [], ...extra,
});

/** Wait until the kill switch's read of the list has been learnt from, then for its log line about the list. */
async function killSwitchSaid(warn: ReturnType<typeof vi.spyOn>, learnt: string): Promise<string[]> {
  const deadline = Date.now() + 3_000;
  while (failsafe.knownActionOf(learnt) === undefined && Date.now() < deadline) await sleep(20);
  await sleep(20);
  return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("the kill switch's read of the failsafe commands"));
}

describe("1. a stand-down past the first page: what was listed is learnt, and the rest is said, never read as none", () => {
  it("the state: the control plane cut the list (more, and X-Failsafe-More: true) -- the page's commands are drawn and learnt, and `more` is true", async () => {
    // The stand-down 'standdown-page2' awaits its second signature on the control plane, past the page.
    served.state = state({ awaiting: [cmd("pause-page1", "pause")] }, { more: true });
    served.stateMore = "true";
    const res = await admin.get("/api/failsafe/state");
    expect(res.status).toBe(200);
    expect(res.body.awaitingSignatures.map((c: { uuid: string }) => c.uuid)).toEqual(["pause-page1"]);
    expect(failsafe.knownActionOf("pause-page1")).toBe("pause");
    expect(res.body.more, "a list cut at the control plane's page is said to be cut, never read as whole").toBe(true);
    // It is not known here: nothing was read that names it.
    expect(failsafe.knownActionOf("standdown-page2")).toBeUndefined();

    // Its signature is still relayed, as a possible stop, within the bound -- waiting on no page.
    const pressed = performance.now();
    const sig = await admin.post("/api/failsafe/commands/standdown-page2/signatures").send({ keyId: "k1", sig: "abcd" });
    expect(sig.status).toBe(200);
    const at = arrivedAt("POST /api/failsafe/commands/standdown-page2/signatures/", pressed);
    expect(at, "the stop past the page was relayed").not.toBeNull();
    expect(at! - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
  });

  const CASES: Array<[string, unknown, string | undefined, true | null | "whole"]> = [
    ["the header alone says true (the body says nothing)", undefined, "true", true],
    ["the body alone says true (no header)", true, undefined, true],
    ["the body says false but the header says true", false, "true", true],
    ["neither says anything", undefined, undefined, null],
    ["the body's more is odd (\"yes\")", "yes", undefined, null],
    ["the body's more is odd (1), the header false", 1, "false", null],
    ["the header is odd (\"maybe\")", false, "maybe", null],
    ["control: both say false", false, "false", "whole"],
    ["control: the body says false (no header)", false, undefined, "whole"],
    ["control: the header says false (the body says nothing)", undefined, "false", "whole"],
  ];
  for (const [name, body, header, expected] of CASES) {
    it(`the state, when ${name}: ${expected === "whole" ? "whole, no `more`" : `more is ${expected}`}`, async () => {
      served.state = state({ awaiting: [cmd("standdown-listed", "stand_down")] }, body === undefined ? {} : { more: body });
      served.stateMore = header;
      const res = await admin.get("/api/failsafe/state");
      expect(res.status).toBe(200);
      expect(res.body.awaitingSignatures).toHaveLength(1);
      if (expected === "whole") expect(res.body).not.toHaveProperty("more");
      else expect(res.body.more).toBe(expected);
    });
  }

  it("the command list's route says whether the control plane cut it, in X-Failsafe-More, and keeps its bare-array body", async () => {
    served.commands = [cmd("pause-listed", "pause")];
    for (const [header, said] of [["true", "true"], ["false", "false"], [undefined, "unknown"], ["perhaps", "unknown"]] as const) {
      served.commandsMore = header;
      const res = await admin.get("/api/failsafe/commands");
      expect(res.status).toBe(200);
      expect(res.body.map((c: { uuid: string }) => c.uuid)).toEqual(["pause-listed"]);
      expect(res.headers["x-failsafe-more"], `the control plane's header ${String(header)}`).toBe(said);
    }
  });

  it("the kill switch's read of a cut list learns what was listed, and says more commands exist than were read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    served.commands = [cmd("resume-page1", "resume"), cmd("pause-page1-ks", "pause")];
    served.commandsMore = "true";
    try {
      expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
      const said = await killSwitchSaid(warn, "resume-page1");
      expect(failsafe.knownActionOf("pause-page1-ks")).toBe("pause");
      expect(said.some((line) => /learnt 2, but the control plane left more out past its page/.test(line) &&
        /more commands exist than were read/.test(line)), JSON.stringify(said)).toBe(true);
      // A resume it listed is refused from memory while the switch is engaged.
      const resume = await admin.post("/api/failsafe/commands/resume-page1/signatures").send({ keyId: "k1", sig: "abcd" });
      expect(resume.status).toBe(503);
      expect(arrivedAt("POST /api/failsafe/commands/resume-page1/signatures/")).toBeNull();
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
    }
  }, 20_000);

  it("the kill switch's read of a list whose control plane did not say: more commands may exist than were read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    served.commands = [cmd("pause-unsaid", "pause")];
    try {
      expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
      const said = await killSwitchSaid(warn, "pause-unsaid");
      expect(said.some((line) => /did not say whether it left any out/.test(line) && /more commands may exist than were read/.test(line)),
        JSON.stringify(said)).toBe(true);
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
    }
  }, 20_000);

  it("control: the kill switch's read of a whole list says nothing about more", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    served.commands = [cmd("pause-whole", "pause")];
    served.commandsMore = "false";
    try {
      expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
      expect(await killSwitchSaid(warn, "pause-whole")).toEqual([]);
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
    }
  }, 20_000);
});

describe("2. stops always go: no page read delays one", () => {
  it("every page read slow and cut: the kill switch's stop, a pause's draft, and a stand-down past the page's signature each arrive within the bound", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    served.pageDelayMs = SLOW_MS;
    served.state = state({ awaiting: [cmd("pause-slow-page", "pause")] }, { more: true });
    served.stateMore = "true";
    served.commands = [cmd("pause-slow-page", "pause")];
    served.commandsMore = "true";
    const client = await storage.createClient({ name: "Slow pages", company: "S", email: "slow@s.test" });
    await storage.createTest({
      clientId: client.id, testType: "vulnerability-scan", status: "running",
      findings: { runId: "run-slow-pages", target: "https://offline.invalid/", results: [] },
    });
    try {
      // The pages are being read, slowly, when every stop is pressed. A request is sent only once it is awaited or
      // `then`ed: `then` here, so both are on their way now -- and both have reached the control plane, and are being
      // answered slowly, before any stop is pressed.
      const reads = [admin.get("/api/failsafe/state"), admin.get("/api/failsafe/commands")].map((read) => read.then((answer) => answer));
      const sent = performance.now();
      while (arrivedAt("GET /api/failsafe/state/") === null || arrivedAt("GET /api/failsafe/commands/") === null) {
        expect(performance.now() - sent, "both page reads reached the control plane before any stop was pressed").toBeLessThan(SLOW_MS);
        await sleep(10);
      }

      const switchPressed = performance.now();
      const pressed = admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
      const draftPressed = performance.now();
      const draft = admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "athena-1", reason: "slow pages" });
      const sigPressed = performance.now();
      const sig = admin.post("/api/failsafe/commands/standdown-past-the-page/signatures").send({ keyId: "k1", sig: "abcd" });
      const [p, d, s] = await Promise.all([pressed, draft, sig]);
      expect(p.status).toBe(200);
      expect(d.status).toBe(201);
      expect(s.status).toBe(200);

      const abortAt = aborts.find((one) => one.runId === "run-slow-pages")?.at;
      expect(abortAt, "the kill switch's stop reached the engine").toBeDefined();
      expect(abortAt! - switchPressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      const draftAt = arrivedAt("POST /api/failsafe/commands/", draftPressed);
      expect(draftAt).not.toBeNull();
      expect(draftAt! - draftPressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      const sigAt = arrivedAt("POST /api/failsafe/commands/standdown-past-the-page/signatures/", sigPressed);
      expect(sigAt, "the stop past the page was relayed").not.toBeNull();
      expect(sigAt! - sigPressed).toBeLessThanOrEqual(STOP_BOUND_MS);

      // The pages answer afterwards, cut, and say so.
      const [st, list] = await Promise.all(reads);
      expect(st.body.more).toBe(true);
      expect(list.headers["x-failsafe-more"]).toBe("true");
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
    }
  }, 20_000);
});

describe("3. a stop drafted with no uuid is said, with the nonce it can be found by", () => {
  const NO_ID: Array<[string, Record<string, unknown>]> = [
    ["no uuid", { uuid: undefined }],
    ["an empty uuid", { uuid: "" }],
    ["a number for a uuid", { uuid: 7 }],
  ];
  for (const [name, extra] of NO_ID) {
    it(`a stand-down drafted with ${name}: answered 201 at once, never opened as "${String(extra.uuid ?? "")}", and said with why and its nonce`, async () => {
      const row: Record<string, unknown> = { ...cmd("ignored", "stand_down"), nonce: "nonce-of-the-orphan", ...extra };
      if (extra.uuid === undefined) delete row.uuid;
      served.draft = row;
      const pressed = performance.now();
      const res = await admin.post("/api/failsafe/commands").send({ action: "stand_down", engineId: "athena-1", reason: "orphan" });
      expect(res.status).toBe(201);
      const at = arrivedAt("POST /api/failsafe/commands/", pressed);
      expect(at! - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      expect(res.body.command.uuid, "no id the control plane finds a command by").toBe("");
      expect(res.body.unopenable).toMatch(/named no command id \(uuid\), so this console cannot read the command, relay a signature to it or withdraw it by its id/);
      // What it can be found and signed by is all there.
      expect(res.body.draft).toMatchObject({ action: "stand_down", engine_id: "athena-1", nonce: "nonce-of-the-orphan" });
      expect(res.body.signingBytes).toBe("00");
      // Recorded under the id it has (none): with the nonce it can be found by, and why it cannot be opened.
      const logs = await storage.getActivityLogsByEntity("failsafe_command", "");
      const drafted = logs.find((one) => one.action === "drafted" && (one.details as Record<string, unknown> | null)?.reason === "orphan" &&
        (one.details as Record<string, unknown>).nonce === "nonce-of-the-orphan");
      expect(drafted, "the draft is recorded with the nonce it can be found by").toBeDefined();
      expect((drafted!.details as Record<string, unknown>).unopenable).toMatch(/named no command id/);
    });
  }

  it("control: a stop drafted with its uuid is opened by it, with no reason given", async () => {
    served.draft = cmd("standdown-with-id", "stand_down");
    const res = await admin.post("/api/failsafe/commands").send({ action: "stand_down", engineId: "athena-1", reason: "with id" });
    expect(res.status).toBe(201);
    expect(res.body.command.uuid).toBe("standdown-with-id");
    expect(res.body).not.toHaveProperty("unopenable");
  });
});
