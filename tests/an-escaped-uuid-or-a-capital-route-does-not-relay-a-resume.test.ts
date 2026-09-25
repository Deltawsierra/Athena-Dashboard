import { it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * With the kill switch engaged, a resume's signature is never relayed by
 * spelling its path another way.
 *
 * Express decodes a route param and routes case-insensitively, so
 *   POST /api/failsafe/commands/resume%2D1/signatures
 *   POST /api/failsafe/commands/resume-1/SIGNATURES
 * both reach the signature relay for command "resume-1". The kill switch's
 * middleware used to re-parse the path and decode the uuid itself: without
 * that decode it looked up "resume%2D1" -- which the control plane, encoding
 * it again, could not find, an "unreadable" command the switch lets through
 * as a possible stop -- and read a capitalised SIGNATURES as a withdrawal,
 * which is let through for a resume. Either way the resume's signature was
 * relayed past the switch. The check is now made in the relay's own handler,
 * from req.params.uuid: the one reading of the uuid, the one relayed.
 *
 * The other direction holds too: a stop's signature is relayed whatever
 * spelling reaches its handler.
 *
 * (Pins mutants R27 and R28 of the round-5 mutation run, which survived the
 * suite; the code they mutated -- the middleware's own parse -- is gone.)
 */
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
let cp: Server;
const calls: string[] = [];
let admin: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  // A control plane that, like any real one, decodes its path.
  cp = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const path = decodeURIComponent((req.url ?? "").split("?")[0]);
      calls.push(`${req.method} ${path}`);
      if (path === "/api/token/") return json(res, 200, { access: "t" });
      const one = /^\/api\/failsafe\/commands\/([^/]+)\/(signatures\/)?$/.exec(path);
      if (one && (one[1] === "resume-1" || one[1] === "pause-1")) {
        const action = one[1].split("-")[0];
        const body = { uuid: one[1], engine_id: "athena-1", action, status: "awaiting_signatures",
          signers: one[2] ? ["bob"] : [], required_signatures: 1, signing_bytes: "beef" };
        return json(res, 200, body);
      }
      return json(res, 404, { detail: "not found" });
    });
  });
  await new Promise<void>((r) => cp.listen(0, "127.0.0.1", r));
  process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${(cp.address() as AddressInfo).port}`;
  process.env.ATHENA_FAILSAFE_USER = "svc";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc";
  vi.resetModules();
  admin = await signIn(await makeApp());
});
afterAll(async () => {
  for (const k of ["ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD"]) delete process.env[k];
  await new Promise<void>((r) => cp.close(() => r()));
});

it("with the kill switch engaged, a resume's signature is not relayed by escaping a character of its uuid", async () => {
  expect((await admin.patch("/api/ai-control").send({ killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] })).status).toBe(200);
  for (const path of ["resume-1", "resume%2D1", "%72esume-1"]) {
    calls.length = 0;
    const sig = await admin.post(`/api/failsafe/commands/${path}/signatures`).send({ keyId: "bob", sig: "abcd" });
    expect(sig.status, path).toBe(503);
    expect(calls.some((one) => one.startsWith("POST") && one.includes("/signatures/")), path).toBe(false);
  }
});

it("with the kill switch engaged, a resume's signature is not relayed by spelling the route in capitals", async () => {
  calls.length = 0;
  const sig = await admin.post("/api/failsafe/commands/resume-1/SIGNATURES").send({ keyId: "bob", sig: "abcd" });
  expect(sig.status).toBe(503);
  expect(calls.some((one) => one.startsWith("POST") && one.includes("/signatures/"))).toBe(false);
});

it("with the kill switch engaged, a stop's signature is relayed by any spelling that reaches the relay", async () => {
  for (const path of ["pause-1/signatures", "pause%2D1/signatures", "pause-1/SIGNATURES", "%70ause-1/Signatures"]) {
    calls.length = 0;
    const sig = await admin.post(`/api/failsafe/commands/${path}`).send({ keyId: "bob", sig: "abcd" });
    expect(sig.status, path).toBe(200);
    expect(calls, path).toContain("POST /api/failsafe/commands/pause-1/signatures/");
  }
});
