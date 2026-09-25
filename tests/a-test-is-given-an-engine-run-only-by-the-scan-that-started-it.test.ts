import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * R5-A. Round 4 stated the rule "a run id is recorded by the scan route that
 * started the run, never supplied" -- and enforced it only on PATCH
 * /api/tests/:id. POST /api/tests took `findings` as free JSON, so any
 * signed-in user could CREATE a test whose findings named another
 * engagement's run id. From then on that row was an engine scan to every part
 * of the app: the Tests screen called it "recorded by the engine", GET
 * /api/scans/:testId asked the engine for that run and filed client A's
 * results as client B's findings, and the run keys were engine-owned, so the
 * forgery could not be edited away (409).
 *
 * (The adversary's reproducer pinned that contamination as observed
 * behaviour. Its assertions are inverted here: the create is refused, and
 * nothing is polled or filed.)
 *
 * Now a person's test -- created or edited -- whose findings carry any of the
 * run's keys (runId, target, results) is refused with 400, naming the keys.
 * Only the scan route writes them. A key sent as null supplies nothing.
 */

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

function stubEngine() {
  const calls: string[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    calls.push(`${req.method} ${url}`);
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (req.method === "GET" && url.startsWith("/api/scans/")) {
      return json(res, 200, {
        run_id: url.split("/")[3], state: "completed",
        result: { results: [{ type: "sql_injection", severity: "critical", target: "https://a.example/",
          evidence: { endpoint: "https://a.example/login" }, message: "SQLi in login" }] },
      });
    }
    return json(res, 202, { run_id: "run-1", state: "running" });
  });
  return { server, calls };
}

let engine: ReturnType<typeof stubEngine>;
let admin: Awaited<ReturnType<typeof signIn>>;
let clientA = "";
let clientB = "";

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "k";
  vi.resetModules();
  admin = await signIn(await makeApp());
  clientA = (await admin.post("/api/clients").send({ name: "A", company: "A", email: "a@a.test" })).body.id;
  await admin.post("/api/sites").send({ clientId: clientA, name: "A", url: "https://a.example" });
  clientB = (await admin.post("/api/clients").send({ name: "B", company: "B", email: "b@b.test" })).body.id;
  await admin.post("/api/sites").send({ clientId: clientB, name: "B", url: "https://b.example" });
  const started = await admin.post("/api/scans").send({ clientId: clientA, target: "https://a.example/" });
  expect(started.body.runId).toBe("run-1");
});

afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => (engine.server as Server).close(() => r()));
});

describe("a person's test is never given an engine run", () => {
  it("PATCH refuses a supplied run id (the round-4 rule)", async () => {
    const plain = await admin.post("/api/tests").send({ clientId: clientB, testType: "manual", status: "pending" });
    const patched = await admin.patch(`/api/tests/${plain.body.id}`).send({ findings: { runId: "run-1" } });
    expect(patched.status).toBe(400);
    expect(patched.body.message).toContain("findings.runId");
  });

  it("POST refuses it too, and writes nothing", async () => {
    const before = (await admin.get("/api/tests")).body.length;
    const forged = await admin.post("/api/tests").send({
      clientId: clientB, testType: "vulnerability-scan", status: "running", findings: { runId: "run-1" },
    });
    expect(forged.status, "POST /api/tests accepted a supplied engine run id").toBe(400);
    expect(forged.body.message).toContain("findings.runId");
    expect((await admin.get("/api/tests")).body.length).toBe(before);
  });

  for (const [findings, named] of [
    [{ target: "https://a.example/" }, "findings.target"],
    [{ results: [{ type: "sql_injection", severity: "critical" }] }, "findings.results"],
    [{ runId: "run-1", target: "https://a.example/", results: [], details: "mine" }, "findings.runId, findings.target, findings.results"],
  ] as Array<[Record<string, unknown>, string]>) {
    it(`create and edit each refuse ${named}`, async () => {
      const created = await admin.post("/api/tests").send({ clientId: clientB, testType: "manual", status: "pending", findings });
      expect(created.status).toBe(400);
      expect(created.body.message).toContain(named);
      const plain = await admin.post("/api/tests").send({ clientId: clientB, testType: "manual", status: "pending" });
      const edited = await admin.patch(`/api/tests/${plain.body.id}`).send({ findings });
      expect(edited.status).toBe(400);
      expect(edited.body.message).toContain(named);
      expect((await admin.get(`/api/tests/${plain.body.id}`)).body.findings).toBeNull();
    });
  }

  it("no forged row is polled as another client's run, and nothing is filed under client B", async () => {
    await admin.post("/api/tests").send({
      clientId: clientB, testType: "vulnerability-scan", status: "running", findings: { runId: "run-1" },
    });
    const bTests = (await admin.get(`/api/tests?clientId=${clientB}`)).body as Array<{ id: string; findings: unknown }>;
    engine.calls.length = 0;
    for (const one of bTests) await admin.get(`/api/scans/${one.id}`);
    expect(engine.calls.filter((one) => one.startsWith("GET /api/scans/"))).toEqual([]);
    const bFindings = (await admin.get(`/api/findings?clientId=${clientB}`)).body.findings as Array<{ type: string }>;
    expect(bFindings.some((one) => one.type === "sql_injection")).toBe(false);
  });

  it("a person's own notes, and keys sent as null, are still accepted", async () => {
    const created = await admin.post("/api/tests").send({
      clientId: clientB, testType: "manual", status: "pending", findings: { details: "by hand", runId: null, target: null },
    });
    expect(created.status).toBe(201);
    expect(created.body.findings).toMatchObject({ details: "by hand" });
  });
});
