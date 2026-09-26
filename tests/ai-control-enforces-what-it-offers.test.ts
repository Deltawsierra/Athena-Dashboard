import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * R5-H. The AI Control page offered, beside the kill switch, "Active Systems"
 * switches (Penetration Testing / Vulnerability Scanner / Threat Detection),
 * "Max Concurrent Tests", an "Auto-Shutdown Threshold" ("system load
 * threshold for automatic safety shutdown") and "Override Mode" ("bypass
 * safety protocols"), and answered every change with "updated successfully".
 * Nothing on the server read any of them: an operator who switched scanning
 * off, or set the limit to 1, had stopped nothing -- new scans started and
 * ran. The installer also seeded ids the page does not use, so a fresh
 * install showed every system off while the record said three were on.
 *
 * (The adversary's reproducer pinned the seeded ids and three scans starting
 * with every system off and a limit of 1. Its assertions are inverted here.)
 *
 * Now what can be enforced is, at a scan's START (never at a stop):
 * POST /api/scans refuses (409, a named reason) a scan whose system is
 * switched off, and one that would exceed Max Concurrent Tests. The seeded ids
 * are the page's, and an install's untouched legacy seed becomes today's
 * default. The threshold and override mode cannot be honoured -- no load is
 * measured, there is no protocol to bypass -- so they are no longer offered
 * and a write that sets one is refused. The kill switch and every Stop stay
 * ungated by all of it.
 */
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let engine: Server;
const started: string[] = [];
const calls: string[] = [];
const running = new Set<string>();
let listFails = false;
let admin: Awaited<ReturnType<typeof signIn>>;
let clientId = "";

beforeAll(async () => {
  let next = 0;
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    calls.push(`${req.method} ${url}`);
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active" && listFails) return json(res, 500, { error: "list unavailable" });
    if (url === "/api/scans/active") return json(res, 200, { active: Array.from(running, (run_id) => ({ run_id, target: null, state: "running" })) });
    const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
    if (abort) { running.delete(abort[1]); return json(res, 200, {}); }
    if (req.method === "POST" && url === "/api/scan") {
      next += 1;
      started.push(`run-${next}`);
      running.add(`run-${next}`);
      return json(res, 202, { run_id: `run-${next}`, state: "running" });
    }
    const id = url.split("/")[3];
    return json(res, 200, { state: running.has(id) ? "running" : "aborted", result: { results: [] } });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "k";
  vi.resetModules();
  admin = await signIn(await makeApp());
  clientId = (await admin.post("/api/clients").send({ name: "H", company: "H", email: "h@h.test" })).body.id;
  await admin.post("/api/sites").send({ clientId, name: "H", url: "https://h.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});

const ALL = ["penetration-testing", "vulnerability-scanner"];
const scan = (testType?: string) =>
  admin.post("/api/scans").send({ clientId, target: "https://h.example/", ...(testType ? { testType } : {}) });
const set = async (body: Record<string, unknown>) => expect((await admin.patch("/api/ai-control").send(body)).status).toBe(200);
/** Stop a scan, and let the status route record that it stopped. */
async function stopped(testId: string) {
  expect((await admin.post(`/api/scans/${testId}/abort`)).status).toBe(200);
  await admin.get(`/api/scans/${testId}`);
}

describe("a fresh install's record names the systems the page switches", () => {
  it("both on", async () => {
    const settings = (await admin.get("/api/ai-control")).body;
    expect(settings.activeSystems).toEqual(ALL);
  });
});

describe("a switched-off system's scans are refused when they would start", () => {
  it("Penetration Testing off: a penetration test, the scan screens' default and any other type are refused, and nothing starts", async () => {
    await set({ activeSystems: ["vulnerability-scanner"] });
    const before = started.length;
    for (const testType of ["penetration-test", undefined, "compliance-audit"]) {
      const refused = await scan(testType);
      expect(refused.status, String(testType)).toBe(409);
      expect(refused.body).toMatchObject({ reason: "system_off", system: "penetration-testing" });
      expect(refused.body.error).toBe(
        "Penetration Testing is switched off on the AI Control page, so this scan was not started. Switch it on there to start it.",
      );
    }
    expect(started.length).toBe(before);
    // The other system's scans still start.
    const vuln = await scan("vulnerability-scan");
    expect(vuln.status).toBe(201);
    await stopped(vuln.body.test.id);
    await set({ activeSystems: ALL });
  });

  it("Vulnerability Scanner off: a vulnerability scan is refused; a penetration test starts", async () => {
    await set({ activeSystems: ["penetration-testing"] });
    const refused = await scan("vulnerability-scan");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ reason: "system_off", system: "vulnerability-scanner" });
    const pen = await scan("penetration-test");
    expect(pen.status).toBe(201);
    await stopped(pen.body.test.id);
    await set({ activeSystems: ALL });
  });

  it("with every system off and a limit of 1, the scans the adversary started are refused", async () => {
    await set({ activeSystems: [] });
    await set({ maxConcurrentTests: 1 });
    const before = started.length;
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await scan("penetration-test")).status);
    expect(statuses, `engine runs started: ${started.slice(before).join(", ")}`).toEqual([409, 409, 409]);
    expect(started.length).toBe(before);
    await set({ activeSystems: ALL, maxConcurrentTests: 5 });
  });
});

describe("Max Concurrent Tests is a limit", () => {
  it("refuses a scan while that many engine scans are running, and starts one once a slot is free", async () => {
    await set({ maxConcurrentTests: 2 });
    const one = await scan();
    const two = await scan();
    expect([one.status, two.status]).toEqual([201, 201]);
    const before = started.length;
    const third = await scan();
    expect(third.status).toBe(409);
    expect(third.body).toMatchObject({ reason: "concurrency_limit", running: 2, counted: "engine", limit: 2 });
    expect(third.body.error).toBe(
      "2 engine scans are running, and Max Concurrent Tests on the AI Control page is 2, so this scan was " +
      "not started. Stop one -- with its Stop where this app recorded it, or with the kill switch on the AI Control " +
      "page -- or raise the limit, to start another.",
    );
    expect(started.length).toBe(before);
    await stopped(one.body.test.id);
    const after = await scan();
    expect(after.status).toBe(201);
    await stopped(two.body.test.id);
    await stopped(after.body.test.id);
    await set({ maxConcurrentTests: 5 });
  });

  it("counts the runs the engine lists as live: not a row whose run has ended, and a live run that has no row", async () => {
    await set({ maxConcurrentTests: 1 });
    const one = await scan();
    expect(one.status).toBe(201);
    // The run ends on the engine; nobody has polled its row, which still reads "running".
    running.delete(one.body.runId);
    expect((await admin.get("/api/tests")).body.find((t: { id: string }) => t.id === one.body.test.id).status).toBe("running");
    const next = await scan();
    expect(next.status).toBe(201);
    await stopped(next.body.test.id);
    await admin.get(`/api/scans/${one.body.test.id}`);
    // A live run nothing here records still holds its slot.
    running.add("run-elsewhere");
    const before = started.length;
    const refused = await scan();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ reason: "concurrency_limit", running: 1, counted: "engine", limit: 1 });
    expect(started.length).toBe(before);
    running.delete("run-elsewhere");
    await set({ maxConcurrentTests: 5 });
  });

  it("counts the rows recorded as running, and says so, when the engine's list cannot be read", async () => {
    await set({ maxConcurrentTests: 1 });
    const one = await scan();
    expect(one.status).toBe(201);
    listFails = true;
    try {
      const refused = await scan();
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ reason: "concurrency_limit", running: 1, counted: "recorded", limit: 1 });
      expect(refused.body.error).toMatch(
        /^1 engine scan is recorded as running \(the engine's list of live runs could not be read: the engine answered 500 .*\), and Max Concurrent Tests on the AI Control page is 1, so this scan was not started\./,
      );
    } finally {
      listFails = false;
    }
    await stopped(one.body.test.id);
    await set({ maxConcurrentTests: 5 });
  });

  it("is at least one", async () => {
    expect((await admin.patch("/api/ai-control").send({ maxConcurrentTests: 0 })).status).toBe(400);
  });
});

describe("no switch and no limit ever holds back a stop", () => {
  it("with every system off and the limit reached, a running scan's Stop and the kill switch still stop it", async () => {
    await set({ maxConcurrentTests: 2 });
    const a = await scan();
    const b = await scan();
    await set({ activeSystems: [], maxConcurrentTests: 1 });
    calls.length = 0;
    expect((await admin.post(`/api/scans/${a.body.test.id}/abort`)).status).toBe(200);
    const kill = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] });
    expect(kill.status).toBe(200);
    expect(kill.body.stops.scans.map((one: { testId: string; stopped: boolean }) => [one.testId, one.stopped]))
      .toContainEqual([b.body.test.id, true]);
    expect(calls).toContain(`POST /api/scans/${b.body.runId}/abort`);
    await set({ killSwitchEnabled: false, systemStatus: "active", activeSystems: ALL, maxConcurrentTests: 5 });
    await admin.get(`/api/scans/${a.body.test.id}`);
    await admin.get(`/api/scans/${b.body.test.id}`);
  });
});

describe("what cannot be enforced is not offered", () => {
  for (const [body, named] of [
    [{ autoShutdownThreshold: 80 }, "autoShutdownThreshold"],
    [{ overrideMode: true }, "overrideMode"],
    [{ maxConcurrentTests: 3, overrideMode: false, autoShutdownThreshold: 90 }, "overrideMode and autoShutdownThreshold"],
  ] as Array<[Record<string, unknown>, string]>) {
    it(`a change that sets ${named} is refused, named, and changes nothing`, async () => {
      const before = (await admin.get("/api/ai-control")).body;
      calls.length = 0;
      const refused = await admin.patch("/api/ai-control").send(body);
      expect(refused.status).toBe(400);
      expect(refused.body.message).toMatch(new RegExp(`^${named} (is|are) not enforced by this build`));
      expect(calls.filter((one) => one.endsWith("/abort"))).toEqual([]);
      const after = (await admin.get("/api/ai-control")).body;
      expect(after.maxConcurrentTests).toBe(before.maxConcurrentTests);
      expect(after.overrideMode).toBe(before.overrideMode);
      expect(after.autoShutdownThreshold).toBe(before.autoShutdownThreshold);
    });
  }
});

describe("nothing refused in a change holds back the kill switch", () => {
  it("engaging with a field this build refuses engages, sends every stop, and names what it left out", async () => {
    const running1 = await scan();
    expect(running1.status).toBe(201);
    const before = (await admin.get("/api/ai-control")).body;
    calls.length = 0;
    const kill = await admin.patch("/api/ai-control").send({
      killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [],
      overrideMode: true, autoShutdownThreshold: 5, maxConcurrentTests: 0,
    });
    expect(kill.status).toBe(200);
    expect(kill.body).toMatchObject({ killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] });
    expect(kill.body.ignored).toEqual(["overrideMode", "autoShutdownThreshold", "maxConcurrentTests"]);
    expect(calls).toContain(`POST /api/scans/${running1.body.runId}/abort`);
    expect(kill.body.stops.scans.map((one: { testId: string; stopped: boolean }) => [one.testId, one.stopped]))
      .toContainEqual([running1.body.test.id, true]);
    const after = (await admin.get("/api/ai-control")).body;
    expect(after.maxConcurrentTests).toBe(before.maxConcurrentTests);
    expect(after.overrideMode).toBe(before.overrideMode);
    expect(after.autoShutdownThreshold).toBe(before.autoShutdownThreshold);
    await set({ killSwitchEnabled: false, systemStatus: "active", activeSystems: ALL });
    await admin.get(`/api/scans/${running1.body.test.id}`);
  });

  it("an engaging change that sets only valid fields names nothing left out", async () => {
    const kill = await admin.patch("/api/ai-control").send({ killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] });
    expect(kill.status).toBe(200);
    expect(kill.body.ignored).toBeUndefined();
    await set({ killSwitchEnabled: false, systemStatus: "active", activeSystems: ALL });
  });
});

describe("an install's untouched legacy seed becomes today's default; any other list is left as it is", () => {
  it("exactly the old installer list is read as the installer's default", async () => {
    const { storage } = await import("../server/storage-unified");
    const { migrateLegacyActiveSystems } = await import("../server/init-data");
    await storage.updateAIControlSettings({ activeSystems: ["threat_detection", "vulnerability_scanner", "log_analyzer"] });
    await migrateLegacyActiveSystems();
    expect((await storage.getAIControlSettings())?.activeSystems).toEqual(ALL);
  });

  it("a write that fails does not stop the server starting: the legacy list stays, and switches nothing on", async () => {
    const { storage } = await import("../server/storage-unified");
    const { migrateLegacyActiveSystems } = await import("../server/init-data");
    const legacy = ["threat_detection", "vulnerability_scanner", "log_analyzer"];
    await storage.updateAIControlSettings({ activeSystems: legacy });
    const failing = vi.spyOn(storage, "updateAIControlSettings").mockRejectedValue(new Error("SQLITE_FULL: database or disk is full"));
    try {
      await expect(migrateLegacyActiveSystems()).resolves.toBeUndefined();
      expect(failing).toHaveBeenCalledTimes(1);
    } finally {
      failing.mockRestore();
    }
    expect((await storage.getAIControlSettings())?.activeSystems).toEqual(legacy);
    expect((await scan("penetration-test")).status).toBe(409);
    await set({ activeSystems: ALL });
  });

  it("a list someone changed is not reinterpreted: its unknown ids stay, and switch nothing on", async () => {
    const { storage } = await import("../server/storage-unified");
    const { migrateLegacyActiveSystems } = await import("../server/init-data");
    // Same length as the installer's list, and one id changed: not the installer's default either.
    const swapped = ["threat_detection", "vulnerability_scanner", "penetration-testing"];
    await storage.updateAIControlSettings({ activeSystems: swapped });
    await migrateLegacyActiveSystems();
    expect((await storage.getAIControlSettings())?.activeSystems).toEqual(swapped);
    const changed = ["threat_detection", "vulnerability_scanner", "log_analyzer", "penetration-testing"];
    await storage.updateAIControlSettings({ activeSystems: changed });
    await migrateLegacyActiveSystems();
    expect((await storage.getAIControlSettings())?.activeSystems).toEqual(changed);
    // vulnerability_scanner is not the page's vulnerability-scanner: a vulnerability scan is refused.
    expect((await scan("vulnerability-scan")).status).toBe(409);
    await set({ activeSystems: ALL });
  });
});
