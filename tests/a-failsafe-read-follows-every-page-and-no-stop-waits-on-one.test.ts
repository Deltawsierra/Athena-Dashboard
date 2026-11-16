import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import type { Express } from "express";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { performance } from "node:perf_hooks";

import { makeApp, signIn, signInToBackend } from "./helpers";

/**
 * SAFETY (DASH-FAILSAFE-PAGES): the dashboard follows the control plane's
 * failsafe pages to the end, and no stop waits on a page.
 *
 * The control plane (athena-backend #218) gives the next page of its two
 * stop-lane reads -- the state and the command list -- when it cuts one: its
 * cursor in X-Failsafe-Next (and the state's `next`), sent back as `?cursor=`.
 * In-flight rows come first, stops first; past 500 awaiting stops a later page
 * relists every awaiting stop, so readers dedupe by uuid; a row too large for
 * any page is named in X-Failsafe-Too-Large; a bad cursor gets 400.
 *
 *   1. A read follows every page, deduped by uuid, within FAILSAFE_PAGES (a
 *      page bound and a time bound, both constants). Every command of every
 *      page is learnt -- and so relayed -- exactly as one on page 1 is: a
 *      signature for a stand-down on page 3 goes as a stop from memory, and a
 *      resume on page 3 is refused from memory while the kill switch is
 *      engaged.
 *   2. A list is shown as complete only when its last page said no more. A
 *      walk cut by either bound, by a page that fails, or by a cursor that
 *      cannot be followed keeps what it read and says more exist. A control
 *      plane that gives no next page reads exactly as before.
 *   3. A command too large for any page is said by its id, counted as
 *      unreadable, and counted as a possible stop unless it is known to be a
 *      resume or a release.
 *   4. Stops always go: with every page slow, a pressed stop -- the kill
 *      switch's, a pause's draft, a stand-down's signature -- arrives within the
 *      existing bound while the pages are still being read.
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
const cmd = (uuid: string, action: string, status = "awaiting_signatures") => ({
  uuid, action, engine_id: "athena-1", nonce: `nonce-${uuid}`, issued_at: "2026-11-03T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
  reason: "r", signers: [], required_signatures: action === "pause" || action === "resume" ? 1 : 2, status,
});
/** The cursor of page `i` (0-based), shaped as the control plane makes one (URL-safe base64). */
const cursorOf = (i: number) => `eyJ2IjoxfQ-page${i}`;

/**
 * One page as the stand-in control plane serves it: its body, its headers
 * (X-Failsafe-More, X-Failsafe-Next, X-Failsafe-Too-Large; none when
 * undefined), an answer other than 200, a body that is not JSON (`raw`), or
 * none at all (`hang`).
 */
interface Page {
  body: unknown; more?: string; next?: string; tooLarge?: string; status?: number; raw?: string; hang?: boolean;
}
const served: { state: Page[]; commands: Page[]; pageDelayMs: number } = { state: [], commands: [], pageDelayMs: 0 };
/** Every request the control plane received: its method and path, its query, and when it arrived (performance.now()). */
const seen: Array<{ line: string; query: URLSearchParams; at: number }> = [];
const arrivedAt = (line: string, after = 0) => seen.find((one) => one.line === line && one.at >= after)?.at ?? null;
const pageReads = (path: string) => seen.filter((one) => one.line === `GET ${path}`);

function servePage(res: ServerResponse, pages: Page[], query: URLSearchParams): void {
  const cursor = query.get("cursor");
  const index = cursor === null ? 0 : pages.findIndex((_, i) => cursorOf(i) === cursor);
  // A cursor the control plane did not make: 400, as #218 answers it.
  if (index < 0 || index >= pages.length) return json(res, 400, { detail: "the cursor is not valid for this read" });
  const page = pages[index];
  if (page.hang) return; // Never answered: the walk's time bound must end it.
  const headers: Record<string, string> = {};
  if (page.more !== undefined) headers["X-Failsafe-More"] = page.more;
  if (page.next !== undefined) headers["X-Failsafe-Next"] = page.next;
  if (page.tooLarge !== undefined) headers["X-Failsafe-Too-Large"] = page.tooLarge;
  if (page.raw !== undefined) {
    res.writeHead(page.status ?? 200, { "Content-Type": "application/json", ...headers });
    return void res.end(page.raw);
  }
  json(res, page.status ?? 200, page.body, headers);
}

function controlPlane() {
  let drafted = 0;
  return http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://plane");
      const path = url.pathname;
      const line = `${req.method} ${path}`;
      seen.push({ line, query: url.searchParams, at: performance.now() });
      if (path === "/api/token/" || path === "/api/token/refresh/") return json(res, 200, { access: "t", refresh: "r" });
      if (req.method === "GET" && path === "/api/failsafe/state/") {
        if (served.pageDelayMs) await sleep(served.pageDelayMs);
        return servePage(res, served.state, url.searchParams);
      }
      if (req.method === "GET" && path === "/api/failsafe/commands/") {
        if (served.pageDelayMs) await sleep(served.pageDelayMs);
        return servePage(res, served.commands, url.searchParams);
      }
      if (req.method === "GET" && path === "/api/failsafe/audit/") return json(res, 200, []);
      if (req.method === "POST" && path === "/api/failsafe/commands/") {
        drafted += 1;
        const action = (JSON.parse(raw) as { action: string }).action;
        return json(res, 201, { ...cmd(`drafted-${action}-${drafted}`, action), signing_bytes: "00" });
      }
      const sig = /^\/api\/failsafe\/commands\/([^/]+)\/signatures\/$/.exec(path);
      if (req.method === "POST" && sig) return json(res, 200, { ...cmd(sig[1], "stand_down"), signers: ["k1"] });
      // The read of one command fails at once: a command is learnt here only from a page.
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
  Object.assign(served, { state: [], commands: [], pageDelayMs: 0 });
  seen.length = 0;
  aborts.length = 0;
  vi.restoreAllMocks();
  await storage.updateAIControlSettings({ killSwitchEnabled: false, systemStatus: "active" });
  await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
});

const stateBody = (lists: { awaiting?: unknown[]; ready?: unknown[] }, more: boolean, next: string | null) => ({
  engine_id: "athena-1", engine_state: "running", engine_state_available: true,
  awaiting_signatures: lists.awaiting ?? [], ready: lists.ready ?? [], recent: [], more, next,
});

/**
 * The brief's three pages, as #218 serves them, with every uuid under `p`:
 * page 1 lists an awaiting pause ("dup") that pages 2 and 3 relist (past 500
 * awaiting stops a later page relists them), page 2 passes over a command too
 * large for any page, and page 3 holds a stand-down awaiting its signatures
 * and a ready resume. Only page 3 says no more.
 */
function threeStatePages(p: string): void {
  served.state = [
    { body: stateBody({ awaiting: [cmd(`${p}-dup`, "pause"), cmd(`${p}-resume-p1`, "resume")], ready: [cmd(`${p}-ready-p1`, "pause", "ready")] }, true, cursorOf(1)),
      more: "true", next: cursorOf(1) },
    { body: stateBody({ awaiting: [cmd(`${p}-dup`, "pause"), cmd(`${p}-pause-p2`, "pause")] }, true, cursorOf(2)),
      more: "true", next: cursorOf(2), tooLarge: `${p}-toolarge-p2` },
    { body: stateBody({ awaiting: [cmd(`${p}-dup`, "pause"), cmd(`${p}-standdown-p3`, "stand_down")], ready: [cmd(`${p}-resume-p3`, "resume", "ready")] }, false, null),
      more: "false" },
  ];
}
function threeListPages(p: string): void {
  served.commands = [
    { body: [cmd(`${p}-dup`, "pause"), cmd(`${p}-resume-p1`, "resume")], more: "true", next: cursorOf(1) },
    { body: [cmd(`${p}-dup`, "pause"), cmd(`${p}-pause-p2`, "pause")], more: "true", next: cursorOf(2), tooLarge: `${p}-toolarge-p2` },
    { body: [cmd(`${p}-dup`, "pause"), cmd(`${p}-standdown-p3`, "stand_down"), cmd(`${p}-resume-p3`, "resume", "ready")], more: "false" },
  ];
}

const uuids = (rows: Array<{ uuid: string }>) => rows.map((one) => one.uuid);

/** Wait until the kill switch's read of the list has learnt `learnt`, then for its log lines about the list. */
async function killSwitchSaid(warn: ReturnType<typeof vi.spyOn>, learnt: string): Promise<string[]> {
  const deadline = Date.now() + 8_000;
  while (failsafe.knownActionOf(learnt) === undefined && Date.now() < deadline) await sleep(20);
  await sleep(50);
  return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("the kill switch's read of the failsafe commands"));
}

describe("1. every page is followed, deduped by uuid, and every command on it is learnt and relayed as one on page 1 is", () => {
  it("the state: three pages, the relisted pause once, the page-3 stand-down learnt, the too-large row counted, and whole only after the last page", async () => {
    threeStatePages("st");
    const res = await admin.get("/api/failsafe/state").query({ engineId: "athena-1" });
    expect(res.status).toBe(200);
    expect(uuids(res.body.awaitingSignatures), "every awaiting command of every page, each once").toEqual(
      ["st-dup", "st-resume-p1", "st-pause-p2", "st-standdown-p3"]);
    expect(uuids(res.body.ready)).toEqual(["st-ready-p1", "st-resume-p3"]);
    expect(failsafe.knownActionOf("st-standdown-p3"), "the page-3 stand-down is learnt").toBe("stand_down");
    expect(failsafe.knownActionOf("st-resume-p3")).toBe("resume");
    // The command too large for any page: said by its id, counted as unreadable, and as a possible stop.
    expect(res.body.tooLarge).toEqual(["st-toolarge-p2"]);
    expect(res.body.unreadable).toEqual({ tooLarge: 1 });
    expect(res.body.possibleStops).toEqual({ tooLarge: 1 });
    // The last page said no more: whole.
    expect(res.body, "whole only when the last page said no more").not.toHaveProperty("more");
    expect(res.body.pages).toEqual({ read: 3 });
    // The pages were asked for by the cursor each gave, with the same engine.
    const reads = pageReads("/api/failsafe/state/");
    expect(reads.map((one) => one.query.get("cursor"))).toEqual([null, cursorOf(1), cursorOf(2)]);
    expect(reads.map((one) => one.query.get("engine_id"))).toEqual(["athena-1", "athena-1", "athena-1"]);
  });

  it("the command list's route: every page's commands once, X-Failsafe-More false, and the too-large command named and counted", async () => {
    threeListPages("ls");
    const res = await admin.get("/api/failsafe/commands");
    expect(res.status).toBe(200);
    expect(uuids(res.body)).toEqual(["ls-dup", "ls-resume-p1", "ls-pause-p2", "ls-standdown-p3", "ls-resume-p3"]);
    expect(res.headers["x-failsafe-more"]).toBe("false");
    expect(res.headers["x-failsafe-too-large"]).toBe("ls-toolarge-p2");
    expect(JSON.parse(res.headers["x-athena-unreadable-rows"])).toEqual({ tooLarge: 1 });
    expect(pageReads("/api/failsafe/commands/").map((one) => one.query.get("cursor"))).toEqual([null, cursorOf(1), cursorOf(2)]);
  });

  it("a signature for the page-3 stand-down is relayed as a stop from memory, with no read, within the bound -- as one on page 1 is", async () => {
    threeStatePages("rl");
    expect((await admin.get("/api/failsafe/state").query({ engineId: "athena-1" })).status).toBe(200);
    for (const uuid of ["rl-dup", "rl-standdown-p3"]) {
      const pressed = performance.now();
      const sig = await admin.post(`/api/failsafe/commands/${uuid}/signatures`).send({ keyId: "k1", sig: "abcd" });
      expect(sig.status).toBe(200);
      const at = arrivedAt(`POST /api/failsafe/commands/${uuid}/signatures/`, pressed);
      expect(at, `${uuid} was relayed`).not.toBeNull();
      expect(at! - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      expect(arrivedAt(`GET /api/failsafe/commands/${uuid}/`), `${uuid}'s action came from memory: no read`).toBeNull();
    }
    // The command too large to read is not known here: its signature goes as a possible stop, within the bound.
    const pressed = performance.now();
    const big = await admin.post("/api/failsafe/commands/rl-toolarge-p2/signatures").send({ keyId: "k1", sig: "abcd" });
    expect(big.status).toBe(200);
    const at = arrivedAt("POST /api/failsafe/commands/rl-toolarge-p2/signatures/", pressed);
    expect(at, "the too-large command's signature was relayed").not.toBeNull();
    expect(at! - pressed).toBeLessThanOrEqual(STOP_BOUND_MS);
  });

  it("the kill switch's read follows every page: a resume on page 3 is refused from memory, and nothing says the list was cut", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    threeListPages("ks");
    try {
      expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true })).status).toBe(200);
      const said = await killSwitchSaid(warn, "ks-resume-p3");
      expect(failsafe.knownActionOf("ks-standdown-p3")).toBe("stand_down");
      expect(said.some((line) => /left more out|may exist than were read/.test(line)), JSON.stringify(said)).toBe(false);
      // The too-large command is said by its id, as a possible stop.
      expect(said.some((line) => /too large to read: ks-toolarge-p2, 1 of them possibly a stop/.test(line)), JSON.stringify(said)).toBe(true);
      // A resume listed on page 3 is refused from memory while the switch is engaged, as one on page 1 is.
      for (const uuid of ["ks-resume-p1", "ks-resume-p3"]) {
        const resume = await admin.post(`/api/failsafe/commands/${uuid}/signatures`).send({ keyId: "k1", sig: "abcd" });
        expect(resume.status, uuid).toBe(503);
        expect(arrivedAt(`POST /api/failsafe/commands/${uuid}/signatures/`), uuid).toBeNull();
      }
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
    }
  }, 20_000);
});

describe("2. a list is complete only when its last page said no more; a walk cut short says more exist", () => {
  const listed = async () => {
    const res = await admin.get("/api/failsafe/state").query({ engineId: "athena-1" });
    expect(res.status).toBe(200);
    return res.body;
  };

  it("the last page reached still says more, and gives no next page: more is true", async () => {
    served.state = [
      { body: stateBody({ awaiting: [cmd("lm-1", "pause")] }, true, cursorOf(1)), more: "true", next: cursorOf(1) },
      { body: stateBody({ awaiting: [cmd("lm-2", "stand_down")] }, true, null), more: "true" },
    ];
    const body = await listed();
    expect(uuids(body.awaitingSignatures)).toEqual(["lm-1", "lm-2"]);
    expect(body.more).toBe(true);
    expect(body.pages).toEqual({ read: 2 });
  });

  it(`the page bound: a walk that never ends is cut after ${10} pages, keeps what it read, and says more exist`, async () => {
    expect(failsafe.FAILSAFE_PAGES.maxPages).toBe(10);
    served.state = Array.from({ length: 15 }, (_, i) => ({
      body: stateBody({ awaiting: [cmd(`pb-${i}`, "pause")] }, true, cursorOf(i + 1)), more: "true", next: cursorOf(i + 1),
    }));
    const body = await listed();
    expect(pageReads("/api/failsafe/state/")).toHaveLength(10);
    expect(uuids(body.awaitingSignatures)).toEqual(Array.from({ length: 10 }, (_, i) => `pb-${i}`));
    expect(failsafe.knownActionOf("pb-9")).toBe("pause");
    expect(body.more, "a walk cut by its page bound is never shown as complete").toBe(true);
    expect(body.pages.read).toBe(10);
    expect(body.pages.unfinished).toMatch(/the page bound \(10 pages\) was reached/);
  });

  it("the time bound: a page that never answers ends the walk at the bound; what was read is relayed, and more is true", async () => {
    expect(failsafe.FAILSAFE_PAGES.totalMs).toBe(4_000);
    served.commands = [
      { body: [cmd("tb-1", "stand_down")], more: "true", next: cursorOf(1) },
      { body: [], hang: true },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    served.state = [
      { body: stateBody({ awaiting: [cmd("tb-st-1", "pause")] }, true, cursorOf(1)), more: "true", next: cursorOf(1) },
      { body: {}, hang: true },
    ];
    const started = performance.now();
    const body = await listed();
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(failsafe.FAILSAFE_PAGES.totalMs - 50);
    expect(took).toBeLessThan(failsafe.FAILSAFE_PAGES.totalMs + 2_000);
    expect(uuids(body.awaitingSignatures)).toEqual(["tb-st-1"]);
    expect(body.more, "a walk cut by its time bound is never shown as complete").toBe(true);
    expect(body.pages).toEqual({ read: 1, unfinished: expect.stringMatching(/the time bound \(4000 ms for the pages after the first\) was reached/) });
    // The list's route too: what was read is listed and learnt, and the cut is said.
    const list = await admin.get("/api/failsafe/commands");
    expect(uuids(list.body)).toEqual(["tb-1"]);
    expect(failsafe.knownActionOf("tb-1")).toBe("stand_down");
    expect(list.headers["x-failsafe-more"]).toBe("true");
    warn.mockRestore();
  }, 20_000);

  const CUT: Array<[string, Page, RegExp]> = [
    ["a page answered 500", { body: { detail: "down" }, status: 500 }, /page 2 was answered 500/],
    ["a page answered 400 (a cursor the control plane would not take)", { body: { detail: "bad cursor" }, status: 400 }, /page 2 was answered 400/],
    ["a page that is not JSON", { body: undefined, raw: "<html>" }, /page 2 could not be read \(the control plane's answer to a page of the failsafe state \(200\) could not be read\)/],
  ];
  CUT.forEach(([name, page, why], i) => {
    it(`${name}: the walk stops there, keeps the first page, and says more exist`, async () => {
      served.state = [
        { body: stateBody({ awaiting: [cmd(`cut-${i}-1`, "pause")] }, true, cursorOf(1)), more: "true", next: cursorOf(1) },
        page,
      ];
      const body = await listed();
      expect(uuids(body.awaitingSignatures)).toEqual([`cut-${i}-1`]);
      expect(body.more, "a walk cut by a page that failed is never shown as complete").toBe(true);
      expect(body.pages).toEqual({ read: 1, unfinished: expect.stringMatching(why) });
    });
  });

  const ODD: Array<[string, Partial<Page>, Record<string, unknown>, RegExp]> = [
    ["a next cursor that is not one the control plane makes", { next: "not a cursor!" }, { next: "not a cursor!" }, /not one the control plane makes/],
    ["a header and a body that give different cursors", { next: cursorOf(1) }, { next: "eyJ2IjoxfQ-other" }, /differed/],
    ["a body whose next is not a string", {}, { next: 7 }, /was not a string/],
    ["an empty next cursor", { next: "" }, { next: "" }, /not one the control plane makes/],
  ];
  for (const [name, headers, bodyNext, why] of ODD) {
    it(`${name}: not followed, and more is true`, async () => {
      served.state = [
        { body: { ...stateBody({ awaiting: [cmd("odd-1", "pause")] }, true, null), ...bodyNext }, more: "true", ...headers },
        { body: stateBody({ awaiting: [cmd("odd-2", "pause")] }, false, null), more: "false" },
      ];
      const body = await listed();
      expect(pageReads("/api/failsafe/state/"), "no page was asked for by a cursor that cannot be followed").toHaveLength(1);
      expect(uuids(body.awaitingSignatures)).toEqual(["odd-1"]);
      expect(body.more).toBe(true);
      expect(body.pages.unfinished).toMatch(why);
    });
  }

  it("a next cursor given again: the walk does not go round, and more is true", async () => {
    served.state = [
      { body: stateBody({ awaiting: [cmd("loop-1", "pause")] }, true, cursorOf(1)), more: "true", next: cursorOf(1) },
      { body: stateBody({ awaiting: [cmd("loop-2", "pause")] }, true, cursorOf(1)), more: "true", next: cursorOf(1) },
    ];
    const body = await listed();
    expect(pageReads("/api/failsafe/state/")).toHaveLength(2);
    expect(uuids(body.awaitingSignatures)).toEqual(["loop-1", "loop-2"]);
    expect(body.more).toBe(true);
    expect(body.pages.unfinished).toMatch(/a next cursor it had given before/);
  });

  it("an older control plane that gives no next page reads exactly as before: one read, more as it said, no pages", async () => {
    served.state = [{ body: { engine_id: "athena-1", engine_state: "running", engine_state_available: true,
      awaiting_signatures: [cmd("old-1", "pause")], ready: [], recent: [], more: true }, more: "true" }];
    const cut = await listed();
    expect(cut).toEqual({
      engineId: "athena-1", engineState: "running", engineStateAvailable: true,
      awaitingSignatures: [expect.objectContaining({ uuid: "old-1" })], ready: [], recent: [], more: true,
    });
    expect(pageReads("/api/failsafe/state/")).toHaveLength(1);
    served.state = [{ body: { engine_id: "athena-1", engine_state: "running", engine_state_available: true,
      awaiting_signatures: [cmd("old-2", "pause")], ready: [], recent: [], more: false }, more: "false" }];
    const whole = await listed();
    expect(whole).not.toHaveProperty("more");
    expect(whole).not.toHaveProperty("pages");
    served.commands = [{ body: [cmd("old-3", "pause")], more: "true" }];
    const list = await admin.get("/api/failsafe/commands");
    expect(uuids(list.body)).toEqual(["old-3"]);
    expect(list.headers["x-failsafe-more"]).toBe("true");
    expect(list.headers).not.toHaveProperty("x-failsafe-too-large");
  });
});

describe("3. a command too large for any page is said by its id, counted as unreadable, and as a possible stop unless known to be a start", () => {
  it("one not known here, one known to be a resume, and one known to be a pause", async () => {
    // Learn a resume and a pause first, from an earlier read.
    served.commands = [{ body: [cmd("big-resume", "resume"), cmd("big-pause", "pause")], more: "false" }];
    expect((await admin.get("/api/failsafe/commands")).status).toBe(200);
    served.state = [
      { body: stateBody({ awaiting: [cmd("tl-1", "pause")] }, true, cursorOf(1)), more: "true", next: cursorOf(1), tooLarge: "big-unknown" },
      { body: stateBody({}, true, cursorOf(2)), more: "true", next: cursorOf(2), tooLarge: "big-resume" },
      { body: stateBody({}, false, null), more: "false", tooLarge: "big-pause" },
    ];
    const res = await admin.get("/api/failsafe/state").query({ engineId: "athena-1" });
    expect(res.body.tooLarge).toEqual(["big-unknown", "big-resume", "big-pause"]);
    expect(res.body.unreadable).toEqual({ tooLarge: 3 });
    expect(res.body.possibleStops, "the resume is not a possible stop; the unknown one and the pause are").toEqual({ tooLarge: 2 });
    expect(res.body).not.toHaveProperty("more");
  });

  it("named twice across pages: counted once", async () => {
    served.state = [
      { body: stateBody({}, true, cursorOf(1)), more: "true", next: cursorOf(1), tooLarge: "big-twice" },
      { body: stateBody({}, false, null), more: "false", tooLarge: "big-twice" },
    ];
    const res = await admin.get("/api/failsafe/state").query({ engineId: "athena-1" });
    expect(res.body.tooLarge).toEqual(["big-twice"]);
    expect(res.body.unreadable).toEqual({ tooLarge: 1 });
  });
});

describe("4. stops always go: with every page slow, no stop waits on one", () => {
  it(`every page ${SLOW_MS} ms slow: the kill switch's stop, a pause's draft, and a stand-down's signature each arrive within the bound while the pages are read`, async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    served.pageDelayMs = SLOW_MS;
    threeStatePages("slow");
    threeListPages("slow");
    const client = await storage.createClient({ name: "Slow pages", company: "S", email: "slow-pages@s.test" });
    await storage.createTest({
      clientId: client.id, testType: "vulnerability-scan", status: "running",
      findings: { runId: "run-slow-follow", target: "https://offline.invalid/", results: [] },
    });
    try {
      // Both reads are walking their pages -- the first answered, the second on its way -- when every stop is pressed.
      // (A request is sent only once it is awaited or `then`ed: `then` here, so both are on their way now.)
      const reads = [admin.get("/api/failsafe/state").query({ engineId: "athena-1" }), admin.get("/api/failsafe/commands")]
        .map((read) => read.then((answer) => answer));
      const walking = performance.now();
      while (pageReads("/api/failsafe/state/").length < 2 || pageReads("/api/failsafe/commands/").length < 2) {
        expect(performance.now() - walking).toBeLessThan(5_000);
        await sleep(10);
      }

      const switchPressed = performance.now();
      const pressed = admin.patch("/api/ai-control").send({ killSwitchEnabled: true });
      const draftPressed = performance.now();
      const draft = admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "athena-1", reason: "slow pages" });
      const sigPressed = performance.now();
      // The page-3 stand-down: not learnt yet (its page has not been read), so relayed as a possible stop.
      const sig = admin.post("/api/failsafe/commands/slow-standdown-p3/signatures").send({ keyId: "k1", sig: "abcd" });
      const [p, d, s] = await Promise.all([pressed, draft, sig]);
      expect(p.status).toBe(200);
      expect(d.status).toBe(201);
      expect(s.status).toBe(200);

      const abortAt = aborts.find((one) => one.runId === "run-slow-follow")?.at;
      expect(abortAt, "the kill switch's stop reached the engine").toBeDefined();
      expect(abortAt! - switchPressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      const draftAt = arrivedAt("POST /api/failsafe/commands/", draftPressed);
      expect(draftAt).not.toBeNull();
      expect(draftAt! - draftPressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      const sigAt = arrivedAt("POST /api/failsafe/commands/slow-standdown-p3/signatures/", sigPressed);
      expect(sigAt, "the stand-down on a page not yet read was relayed").not.toBeNull();
      expect(sigAt! - sigPressed).toBeLessThanOrEqual(STOP_BOUND_MS);
      console.info(`[stop bound] with every page ${SLOW_MS} ms slow: kill switch ${(abortAt! - switchPressed).toFixed(1)} ms, ` +
        `pause draft ${(draftAt! - draftPressed).toFixed(1)} ms, stand-down signature ${(sigAt! - sigPressed).toFixed(1)} ms ` +
        `(bound ${STOP_BOUND_MS} ms)`);
      // Every stop arrived before the walks reached their last page.
      const lastPageAt = (path: string) => seen.find((one) => one.line === `GET ${path}` && one.query.get("cursor") === cursorOf(2))?.at ?? Infinity;
      for (const at of [abortAt!, draftAt!, sigAt!]) {
        expect(at).toBeLessThan(lastPageAt("/api/failsafe/state/"));
        expect(at).toBeLessThan(lastPageAt("/api/failsafe/commands/"));
      }

      // The walks then finish: every page read, each command once, whole.
      const [st, list] = await Promise.all(reads);
      expect(uuids(st.body.awaitingSignatures)).toEqual(["slow-dup", "slow-resume-p1", "slow-pause-p2", "slow-standdown-p3"]);
      expect(st.body).not.toHaveProperty("more");
      expect(list.headers["x-failsafe-more"]).toBe("false");
      expect(uuids(list.body)).toHaveLength(5);
    } finally {
      await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
    }
  }, 30_000);
});
