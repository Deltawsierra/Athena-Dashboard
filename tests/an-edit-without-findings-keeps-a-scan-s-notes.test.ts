import { it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";

/**
 * An edit of an engine scan that does not send `findings` -- a summary-only
 * PATCH -- leaves its findings as they are, the notes a person wrote on it
 * included. engineRecordEdited rewrites findings (the run's keys kept, the
 * notes taken from the body) only when the body sends findings; rewriting
 * them on every edit silently deleted the notes.
 *
 * (Pins mutant R21 of the round-5 mutation run, which survived the suite.)
 */
let hybrid: HybridBackendStandIn | null = null;
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
let engine: Server;
let admin: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") return json(res, 200, { status: "ok" });
    if (req.method === "GET") return json(res, 200, { state: "running", result: { results: [] } });
    return json(res, 202, { run_id: "run-1", state: "running" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "k";
  hybrid = await hybridBackendStandIn({ engine: { url: process.env.ATHENA_ENGINE_URL!, key: process.env.ATHENA_ENGINE_KEY } });
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  vi.resetModules();
  admin = await signIn(await makeApp());
  await signInToBackend(admin);
});
afterAll(async () => {
  delete process.env.ATHENA_FAILSAFE_URL;
  await hybrid?.close();
  hybrid = null;
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});

it("a summary-only edit of an engine scan keeps the notes a person wrote", async () => {
  const clientId = (await admin.post("/api/clients").send({ name: "N", company: "N", email: "n@n.test" })).body.id;
  await admin.post("/api/sites").send({ clientId, name: "N", url: "https://n.example" });
  const id = (await admin.post("/api/scans").send({ consent: true, clientId, target: "https://n.example/" })).body.test.id;
  expect((await admin.patch(`/api/tests/${id}`).send({ findings: { details: "seen by Ann" } })).status).toBe(200);
  const edited = await admin.patch(`/api/tests/${id}`).send({ summary: "typo fixed" });
  expect(edited.status).toBe(200);
  expect(edited.body.findings.details).toBe("seen by Ann");
});
