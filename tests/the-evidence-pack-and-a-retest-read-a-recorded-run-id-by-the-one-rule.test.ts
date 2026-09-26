/**
 * The evidence pack and a retest read the run a test records by the one rule
 * every other route reads it by (shared/engine-record.ts): text as recorded,
 * and a whole number as its digits.
 *
 * A run id the engine sent as a number was recorded, before that rule, as the
 * number. Read by text alone, such a test's evidence pack was built for the
 * whole engagement rather than the run it was asked about, and a retest's
 * verdict was never carried into the finding it was about: the run's decisions
 * were never asked for. Both now read the shared rule; nothing tested either.
 *
 * These run the real routes against a fake engine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import type { IStorage } from "../server/storage";
import { makeApp, signIn } from "./helpers";

const TARGET = "https://pack.example/";
const XSS = { type: "reflected_xss", severity: "high", message: "Reflected input on /search", endpoint: "/search" };

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let startBody: Record<string, unknown> = {};
const calls: Array<{ line: string; body: Record<string, unknown> }> = [];
let engine: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let clientId: string;

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = req.url ?? "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      calls.push({ line: `${req.method} ${url}`, body });
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") return json(res, 200, { active: [] });
      if (url.startsWith("/api/scanners")) return json(res, 200, { scanners: [] });
      if (req.method === "POST" && url === "/api/scan") return json(res, 200, startBody);
      if (req.method === "POST" && url === "/api/evidence/pack") {
        return json(res, 200, { manifest: { format: "mythos-evidence-pack-v1", sources: [] }, signed: false });
      }
      if (req.method === "GET" && url.startsWith("/api/decisions?")) {
        return json(res, 200, { decisions: [{
          id: 1, run_id: 48, target: TARGET, finding_type: XSS.type, decision: { severity: "high" }, inputs: { endpoint: "/search" },
        }] });
      }
      if (req.method === "POST" && url === "/api/remediation/retest") {
        return json(res, 201, { twin_id: 1, verdict: "closed", detail: "no longer reflected", target: TARGET, finding_type: XSS.type, run_id: 90 });
      }
      return json(res, 404, { detail: "not here" });
    });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  agent = await signIn(await makeApp());
  storage = (await import("../server/storage-unified")).storage;
  clientId = (await agent.post("/api/clients").send({ name: "Pack", company: "Pack", email: "p@p.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://pack.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});

/** A finished scan whose run id is recorded as the number the engine sent, as it was before the shared rule. */
async function scanRecordedByNumber(runId: number) {
  startBody = { run_id: runId, state: "completed", result: { results: [XSS] } };
  const started = await agent.post("/api/scans").send({ clientId, target: TARGET });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const id = started.body.test.id as string;
  const recorded = (await storage.getTest(id))!.findings as Record<string, unknown>;
  await storage.updateTest(id, { findings: { ...recorded, runId } });
  return id;
}

describe("a test whose run id is recorded as a number", () => {
  it("has its evidence pack built for that run, named by its digits", async () => {
    const testId = await scanRecordedByNumber(47);
    const before = calls.length;
    const pack = await agent.post("/api/evidence-pack").send({ clientId, testId, reason: "the client asked for this run" });
    expect(pack.status, JSON.stringify(pack.body)).toBe(200);
    const sent = calls.slice(before).find((one) => one.line === "POST /api/evidence/pack");
    expect(sent?.body.run_id).toBe("47");
  });

  it("has a retest's verdict carried into the finding it is about: the run's decisions are asked for by its digits", async () => {
    const testId = await scanRecordedByNumber(48);
    const before = calls.length;
    const retested = await agent.post(`/api/tests/${testId}/retest`).send({ twinId: 1 });
    expect(retested.status, JSON.stringify(retested.body)).toBe(200);
    expect(calls.slice(before).map((one) => one.line)).toContain("GET /api/decisions?run_id=48&limit=101");
    expect(retested.body.applied).toMatchObject({ status: expect.any(String) });
  });
});
