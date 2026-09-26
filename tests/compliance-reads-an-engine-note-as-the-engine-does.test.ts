/**
 * The compliance map reads the engine's own notes by the engine's rule
 * (shared/engine-internal.ts): any truthy `internal` marks a note, as
 * athena-engine's `if item.get("internal"):` reads it, not only `true`.
 *
 * The map read `internal === true`, so a missing-header row the engine marked
 * `internal: "yes"` -- a note it scores 0 and "info" -- failed a requirement,
 * while the counts, the filed findings and both scan screens called it a note.
 *
 * These run the real routes against a fake engine that finishes each scan inline.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** A missing Content-Security-Policy row, as the engine sends one; `internal` as each test marks it. */
const HEADER_ROW = { type: "missing_security_header", header: "Content-Security-Policy", severity: "high", message: "No CSP" };

let results: unknown[] = [];
let runs = 0;
/** Each test scans a client of its own, so no other test's scan is in its map. */
let clients = 0;
let engine: Server;
let agent: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active") return json(res, 200, { active: [] });
    if (url.startsWith("/api/scanners")) return json(res, 200, { scanners: [] });
    if (req.method === "POST" && url === "/api/scan") {
      runs += 1;
      return json(res, 200, { run_id: `run-${runs}`, state: "completed", result: { results } });
    }
    return json(res, 404, { detail: "not here" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  agent = await signIn(await makeApp());
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});

/** The compliance summary of a fresh client scanned once, with the engine returning `rows`. */
async function mappedAfterScanning(name: string, rows: unknown[]) {
  const clientId = (await agent.post("/api/clients").send({ name, company: name, email: `${name}@c.test` })).body.id;
  const host = `${name.toLowerCase()}.example`;
  await agent.post("/api/sites").send({ clientId, name: `${name} shop`, url: `https://${host}` });
  results = rows;
  const started = await agent.post("/api/scans").send({ clientId, target: `https://${host}/` });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const map = await agent.get(`/api/compliance/${clientId}`);
  expect(map.status, JSON.stringify(map.body)).toBe(200);
  return map.body.summary as { failing: number };
}

describe("the compliance map and the engine's notes", () => {
  it("fails a requirement on the missing header when the row is a finding", async () => {
    expect((await mappedAfterScanning("Finding", [HEADER_ROW])).failing).toBeGreaterThan(0);
  });

  for (const [label, internal] of [["true", true], ['"yes"', "yes"], ["1", 1], ['["why"]', ["why"]]] as const) {
    it(`fails nothing on it when the engine marked it internal: ${label}`, async () => {
      expect((await mappedAfterScanning(`Note${++clients}`, [{ ...HEADER_ROW, internal }])).failing).toBe(0);
    });
  }

  for (const [label, internal] of [["0", 0], ["[]", []], ["{}", {}]] as const) {
    it(`fails a requirement when the mark is falsy to the engine: ${label}`, async () => {
      expect((await mappedAfterScanning(`Falsy${++clients}`, [{ ...HEADER_ROW, internal }])).failing).toBeGreaterThan(0);
    });
  }
});
