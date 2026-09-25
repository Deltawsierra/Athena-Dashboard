import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * Every field the engine or the scan route decided is refused as an edit of an
 * engine scan (ENGINE_OWNED_TEST_FIELDS, server/routes.ts) -- each one, not
 * only the handful the round-4 test changed (status, highCount, severity,
 * clientId, findings.runId, findings.target).
 *
 * Re-dating an engine scan's completion (completedAt) changes which scan is
 * "the latest" per site (shared/latest-scans.ts); moving it to another site
 * (siteId) moves its results into that site's scope; and each count is what a
 * report reads. And the other side of the rule: a person's own free-form
 * findings may say `runId: null` -- no run is being supplied.
 *
 * (Pins mutants R11-R16 of the round-5 mutation run, each of which survived
 * the whole suite: a field dropped from the list, or null read as a run.)
 */
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let engine: Server;
let admin: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  let next = 0;
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (req.method === "GET") return json(res, 200, { state: "running", result: { results: [] } });
    next += 1;
    return json(res, 202, { run_id: `run-${next}`, state: "running" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "k";
  vi.resetModules();
  admin = await signIn(await makeApp());
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});

describe("every field the engine or the scan route decided is refused as an edit", () => {
  it("siteId, completedAt and each count", async () => {
    const clientId = (await admin.post("/api/clients").send({ name: "O", company: "O", email: "o@o.test" })).body.id;
    const siteA = (await admin.post("/api/sites").send({ clientId, name: "A", url: "https://a.example" })).body.id;
    const siteB = (await admin.post("/api/sites").send({ clientId, name: "B", url: "https://b.example" })).body.id;
    const started = await admin.post("/api/scans").send({ clientId, siteId: siteA, target: "https://a.example/" });
    expect(started.status).toBe(201);
    const id = started.body.test.id;
    for (const [body, named] of [
      [{ siteId: siteB }, "siteId"],
      [{ completedAt: "2020-01-01T00:00:00.000Z" }, "completedAt"],
      [{ vulnerabilitiesFound: 7 }, "vulnerabilitiesFound"],
      [{ criticalCount: 1 }, "criticalCount"],
      [{ mediumCount: 1 }, "mediumCount"],
      [{ lowCount: 1 }, "lowCount"],
    ] as Array<[Record<string, unknown>, string]>) {
      const refused = await admin.patch(`/api/tests/${id}`).send(body);
      expect(refused.status, JSON.stringify(body)).toBe(409);
      expect(refused.body.message, JSON.stringify(body)).toContain(named);
    }
    const after = (await admin.get(`/api/tests/${id}`)).body;
    expect(after).toMatchObject({ siteId: siteA, completedAt: null, vulnerabilitiesFound: 0, criticalCount: 0, mediumCount: 0, lowCount: 0 });
  });

  it("a person's own free-form findings may say runId: null (no run is being supplied)", async () => {
    const clientId = (await admin.post("/api/clients").send({ name: "P", company: "P", email: "p@p.test" })).body.id;
    const created = await admin.post("/api/tests").send({ clientId, testType: "penetration-test", status: "pending" });
    const edited = await admin.patch(`/api/tests/${created.body.id}`).send({ findings: { runId: null, details: "manual" } });
    expect(edited.status).toBe(200);
  });
});
