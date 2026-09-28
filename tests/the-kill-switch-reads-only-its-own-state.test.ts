import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * #325(e): the kill switch's own decisions -- whether it is engaged, and the
 * system status shown beside a refusal -- read only those two fields, not the
 * whole settings row. `activeSystems`, the concurrency and shutdown
 * thresholds, and who last changed the row are the settings screen's
 * business; a Stop-safety decision does not need them, and reading them on
 * every write this dashboard did not itself press the switch for costs
 * something (parsing a JSON column among them) that decision has no use for.
 *
 * Both call sites are covered: an ordinary write refused because another
 * dashboard engaged the switch (enforceKillSwitch's read of the stored row),
 * and a resume's signature refused while it is engaged
 * (killSwitchRefusesCommand / killSwitchEngagedNow).
 */
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

it("an ordinary write refused by another dashboard's engaged switch reads only the switch's own state", async () => {
  vi.resetModules();
  const app = await makeApp();
  const admin = await signIn(app);
  const storage = (await import("../server/storage-unified")).storage;

  // Engaged by "another dashboard": written straight to storage, never
  // through this process's own PATCH /api/ai-control, so killSwitchMemory
  // here stays false and the read this measures is the only thing standing
  // between the write and its refusal.
  await storage.updateAIControlSettings({ killSwitchEnabled: true, systemStatus: "shutdown" });

  const fullReads = vi.spyOn(storage, "getAIControlSettings");
  const narrowReads = vi.spyOn(storage, "getKillSwitchState");
  fullReads.mockClear();
  narrowReads.mockClear();

  const blocked = await admin.post("/api/clients").send({ name: "Elsewhere", company: "Elsewhere", email: "e@e.test" });
  expect(blocked.status).toBe(503);

  expect(narrowReads).toHaveBeenCalled();
  expect(fullReads).not.toHaveBeenCalled();

  fullReads.mockRestore();
  narrowReads.mockRestore();
  await storage.updateAIControlSettings({ killSwitchEnabled: false, systemStatus: "active" });
});

let cp: Server;
const cpCalls: string[] = [];

it("a resume's signature refused while the switch is engaged reads only the switch's own state", async () => {
  cp = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const path = decodeURIComponent((req.url ?? "").split("?")[0]);
      cpCalls.push(`${req.method} ${path}`);
      if (path === "/api/token/") return json(res, 200, { access: "t" });
      if (path === "/api/failsafe/commands/resume-1/") {
        return json(res, 200, {
          uuid: "resume-1", engine_id: "athena-1", action: "resume", status: "awaiting_signatures",
          signers: [], required_signatures: 1, signing_bytes: "beef",
        });
      }
      return json(res, 404, { detail: "not found" });
    });
  });
  await new Promise<void>((r) => cp.listen(0, "127.0.0.1", r));
  process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${(cp.address() as AddressInfo).port}`;
  process.env.ATHENA_FAILSAFE_USER = "svc";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc";
  vi.resetModules();
  const app = await makeApp();
  const admin = await signIn(app);
  const storage = (await import("../server/storage-unified")).storage;

  await storage.updateAIControlSettings({ killSwitchEnabled: true, systemStatus: "shutdown" });

  const fullReads = vi.spyOn(storage, "getAIControlSettings");
  const narrowReads = vi.spyOn(storage, "getKillSwitchState");
  fullReads.mockClear();
  narrowReads.mockClear();
  cpCalls.length = 0;

  const sig = await admin.post("/api/failsafe/commands/resume-1/signatures").send({ keyId: "bob", sig: "abcd" });
  expect(sig.status).toBe(503);
  expect(cpCalls.some((one) => one.startsWith("GET"))).toBe(true);

  expect(narrowReads).toHaveBeenCalled();
  expect(fullReads).not.toHaveBeenCalled();

  fullReads.mockRestore();
  narrowReads.mockRestore();
  await storage.updateAIControlSettings({ killSwitchEnabled: false, systemStatus: "active" });
});
afterEach(async () => { if (cp) await new Promise<void>((r) => cp.close(() => r())); });
afterAll(() => {
  for (const k of ["ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD"]) delete process.env[k];
});
