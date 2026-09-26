/**
 * A result's severity is read as its rating everywhere, whatever its case or
 * surrounding space (shared/latest-scans.ts ratingOf): " high" is high.
 *
 * The scan route counted a result by lower-casing its severity alone, so a
 * result the engine sent as " high" was counted in no band and the record's
 * severity was left null -- "Findings were recorded with no severity" -- while
 * readScan, which trims, read the same result as rated high and not unrated.
 * The finding it filed kept " high", which the findings summary read as info.
 * One result, three readings. Now the counts, the record's reading, the filed
 * finding and the summary all read it as high.
 *
 * These run the real routes against a fake engine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { readScan } from "@shared/latest-scans";
import { severityOf } from "../server/findings-summary";
import type { IStorage } from "../server/storage";
import { makeApp, signIn } from "./helpers";

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let startBody: Record<string, unknown> = {};
let pollBody: Record<string, unknown> = {};
let engine: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active") return json(res, 200, { active: [] });
    if (url.startsWith("/api/scanners")) return json(res, 200, { scanners: [] });
    if (req.method === "POST" && url === "/api/scan") return json(res, 200, startBody);
    if (req.method === "GET" && url.startsWith("/api/scans/")) return json(res, 200, pollBody);
    return json(res, 404, { detail: "not here" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  agent = await signIn(await makeApp());
  storage = (await import("../server/storage-unified")).storage;
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});

async function engagement(name: string) {
  const clientId = (await agent.post("/api/clients").send({ name, company: name, email: `${name}@s.test` })).body.id as string;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: `https://${name}.example` });
  return { clientId, target: `https://${name}.example/` };
}

describe("a result the engine rated ' high', padded", () => {
  it("is counted high, rated high on the record, filed as a high finding and summarised as one", async () => {
    const { clientId, target } = await engagement("padded");
    startBody = {
      run_id: "run-padded", state: "completed",
      result: { results: [
        { type: "sqli", severity: " high", message: "Injectable id", endpoint: "/item" },
        { type: "banner", severity: "INFO ", message: "Server header", endpoint: "/" },
      ] },
    };
    const started = await agent.post("/api/scans").send({ clientId, target });
    expect(started.status, JSON.stringify(started.body)).toBe(201);

    const recorded = (await storage.getTest(started.body.test.id))!;
    expect({ total: recorded.vulnerabilitiesFound, high: recorded.highCount, severity: recorded.severity })
      .toEqual({ total: 2, high: 1, severity: "high" });
    const read = readScan(recorded);
    expect({ severity: read.severity, unrated: read.unrated }).toEqual({ severity: "high", unrated: 0 });

    const filed = await agent.get(`/api/findings?clientId=${clientId}`);
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    const severities = (filed.body.findings as Array<{ type: string; severity: string | null }>)
      .map((one) => [one.type, one.severity]).sort();
    expect(severities).toEqual([["banner", "info"], ["sqli", "high"]]);

    const summary = await agent.get("/api/findings/summary");
    const mine = (summary.body.byClient as Array<{ clientId: string; high: number; untrackedScan: unknown }>)
      .find((one) => one.clientId === clientId);
    expect(mine).toMatchObject({ high: 1, untrackedScan: null });
  });

  it("is counted as its rating when a poll finishes the run, as when it finishes inline", async () => {
    const { clientId, target } = await engagement("polled");
    startBody = { run_id: "run-polled", state: "running" };
    pollBody = { state: "completed", result: { results: [{ type: "rce", severity: " Critical ", message: "Shell" }] } };
    const started = await agent.post("/api/scans").send({ clientId, target });
    expect(started.status).toBe(201);
    const polled = await agent.get(`/api/scans/${started.body.test.id}`);
    expect(polled.status, JSON.stringify(polled.body)).toBe(200);
    const recorded = (await storage.getTest(started.body.test.id))!;
    expect({ critical: recorded.criticalCount, severity: recorded.severity }).toEqual({ critical: 1, severity: "critical" });
  });

  it("filed before this, as the engine sent it, is still summarised as its rating", () => {
    // Findings filed before round 4 hold the engine's spelling; the summary reads them as every other reader does.
    expect([" high", "HIGH", "Critical ", " low", "Info"].map((one) => severityOf(one)))
      .toEqual(["high", "high", "critical", "low", "info"]);
  });

  it("a word that is no rating is still counted in the total and in no band, and filed as the engine sent it", async () => {
    const { clientId, target } = await engagement("unknown");
    startBody = { run_id: "run-unknown", state: "completed", result: { results: [{ type: "odd", severity: "severe", message: "?" }] } };
    const started = await agent.post("/api/scans").send({ clientId, target });
    const recorded = (await storage.getTest(started.body.test.id))!;
    expect({ total: recorded.vulnerabilitiesFound, severity: recorded.severity }).toEqual({ total: 1, severity: null });
    expect(readScan(recorded).unrated).toBe(1);
    const filed = await agent.get(`/api/findings?clientId=${clientId}`);
    expect((filed.body.findings as Array<{ severity: string | null }>).map((one) => one.severity)).toEqual(["severe"]);
  });
});
