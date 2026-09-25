import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * Only engaging the kill switch sends stops, and an ordinary settings change
 * whose audit log could not be written is not reported as saved cleanly.
 *
 * The suite only ever sent {killSwitchEnabled: false} besides engaging, so
 * sending stops on anything but an explicit `true` passed: every other change
 * on the AI Control page (a system switch, Max Concurrent Tests) would have
 * aborted every running scan. And the handler's rule -- only a response that
 * carries stop outcomes survives a failed log write -- was unpinned on the
 * ordinary path.
 *
 * (Pins mutants R34 and R35 of the round-5 mutation run, which survived the
 * suite. The bodies are the settings this build still accepts: Override Mode
 * and Auto-Shutdown Threshold are refused, see
 * ai-control-enforces-what-it-offers.test.ts.)
 */
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
let engine: Server;
const calls: string[] = [];
let admin: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    calls.push(`${req.method} ${url}`);
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url.endsWith("/abort")) return json(res, 200, {});
    if (req.method === "GET") return json(res, 200, { state: "running", result: { results: [] } });
    return json(res, 202, { run_id: "run-1", state: "running" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "k";
  vi.resetModules();
  admin = await signIn(await makeApp());
  const clientId = (await admin.post("/api/clients").send({ name: "S", company: "S", email: "s@s.test" })).body.id;
  await admin.post("/api/sites").send({ clientId, name: "S", url: "https://s.example" });
  expect((await admin.post("/api/scans").send({ clientId, target: "https://s.example/" })).status).toBe(201);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});

describe("only engaging the kill switch sends stops", () => {
  for (const body of [
    { maxConcurrentTests: 3 },
    { activeSystems: ["penetration-testing", "vulnerability-scanner"] },
    { systemStatus: "active" },
    { killSwitchEnabled: false },
  ]) {
    it(`a change of ${Object.keys(body)[0]} stops nothing`, async () => {
      calls.length = 0;
      const saved = await admin.patch("/api/ai-control").send(body);
      expect(saved.status).toBe(200);
      expect(saved.body.stops).toBeUndefined();
      expect(calls.filter((one) => one.endsWith("/abort"))).toEqual([]);
    });
  }

  it("a settings change whose audit log could not be written is not reported as saved cleanly", async () => {
    const { storage } = await import("../server/storage-unified");
    vi.spyOn(storage, "createActivityLog").mockRejectedValue(new Error("disk full"));
    const saved = await admin.patch("/api/ai-control").send({ maxConcurrentTests: 4 });
    expect(saved.status).toBe(500);
  });
});
