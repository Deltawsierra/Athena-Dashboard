import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import type { IStorage } from "../server/storage";
import { makeApp, signIn } from "./helpers";

/**
 * A scan recorded as completed answers the findings it recorded, as the engine
 * sent them, `confidence_basis` included.
 *
 * `GET /api/scans/:testId` stops asking the engine once a run is recorded as
 * completed. It answered `engine: null` from then on, though the record holds
 * the run's findings (`test.findings.results`) and the counts counted from them.
 * The scan screens read that as "The scan finished and returned no findings"
 * beside those counts: at once for a run the engine finished inline, and for any
 * finished run read again. Now the route answers the recorded findings in the
 * shape the engine's own have, so the engine's `confidence_basis` for each
 * reaches the screens on every path. Findings the record holds that cannot be
 * read are said to be unread, never answered as none.
 */

/** mythos-core `evidence.BASIS`, as the engine sends it on every finding it scores. */
const BASIS =
  "ordinal: derived from the number of independent signals in the evidence. " +
  "Not a probability that this finding is real.";
const FINDING = {
  type: "reflected_xss", severity: "high", message: "Reflected input", endpoint: "/search",
  confidence: 0.65, confidence_basis: BASIS, evidence_strength: 0.65, evidence_signals: 3,
};

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** The engine: finishes a scan inline or leaves it running, as the test says. */
let finishInline = false;
let pollState = "running";
let runs = 0;
const polls: string[] = [];
let engine: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let clientId: string;

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active") return json(res, 200, { active: [] });
    if (req.method === "POST" && url === "/api/scan") {
      runs += 1;
      const runId = `run-${runs}`;
      return finishInline
        ? json(res, 200, { run_id: runId, state: "completed", result: { results: [FINDING] } })
        : json(res, 202, { run_id: runId, state: "running" });
    }
    if (req.method === "GET" && url.startsWith("/api/scans/run-")) {
      polls.push(url);
      return json(res, 200, { state: pollState, result: { results: [FINDING] } });
    }
    return json(res, 404, { detail: "not here" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  agent = await signIn(await makeApp());
  storage = (await import("../server/storage-unified")).storage;
  clientId = (await agent.post("/api/clients").send({ name: "Recorded", company: "Recorded", email: "r@r.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://recorded.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});

async function start(): Promise<{ id: string; runId: string }> {
  const started = await agent.post("/api/scans").send({ clientId, target: "https://recorded.example/" });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return { id: started.body.test.id, runId: started.body.runId };
}

describe("a scan recorded as completed", () => {
  it("carries the engine's confidence_basis through, while the run is polled and once it is recorded as completed", async () => {
    finishInline = false;
    pollState = "running";
    const { id, runId } = await start();

    const running = await agent.get(`/api/scans/${id}`);
    expect(running.body.state).toBe("running");
    expect(running.body.engine.findings).toEqual([FINDING]);

    pollState = "completed";
    const completing = await agent.get(`/api/scans/${id}`);
    expect(completing.body.state).toBe("completed");
    expect(completing.body.engine.findings).toEqual([FINDING]);
    expect(completing.body.test.status).toBe("completed");

    // Read again: the engine is not asked, and the findings it recorded are answered.
    const asked = polls.length;
    const again = await agent.get(`/api/scans/${id}`);
    expect(again.status).toBe(200);
    expect(polls).toHaveLength(asked);
    expect(again.body.state).toBe("completed");
    expect(again.body.engine).not.toBeNull();
    expect(again.body.engine.findings).toEqual([FINDING]);
    expect(again.body.engine.findings[0].confidence_basis).toBe(BASIS);
    expect(again.body.engine.runId).toBe(runId);
    expect(again.body.test.highCount).toBe(1);
  });

  it("answers a run the engine finished inline with the findings recorded when it started", async () => {
    finishInline = true;
    const asked = polls.length;
    const { id } = await start();

    const read = await agent.get(`/api/scans/${id}`);
    expect(read.status).toBe(200);
    expect(polls).toHaveLength(asked);
    expect(read.body.state).toBe("completed");
    expect(read.body.test.highCount).toBe(1);
    expect(read.body.engine?.findings).toEqual([FINDING]);
    expect(read.body.engine.findings[0].confidence_basis).toBe(BASIS);
  });

  it("says the findings it recorded could not be read, never answering none, when they are not a list of records", async () => {
    finishInline = true;
    for (const results of ["garbled", undefined, null, { 0: FINDING }, [null], [FINDING, [FINDING]], [FINDING, "x"]]) {
      const { id, runId } = await start();
      await storage.updateTest(id, {
        findings: { runId, target: "https://recorded.example/", ...(results === undefined ? {} : { results }) },
      });

      const read = await agent.get(`/api/scans/${id}`);
      const label = JSON.stringify(results) ?? "no results";
      expect(read.status, label).toBe(200);
      expect(read.body.state, label).toBe("completed");
      expect(read.body.engine, label).toBeNull();
      expect(read.body.detail, label).toBe("the findings recorded for this scan could not be read");
      // The counts stand, and nothing says there were none.
      expect(read.body.test.highCount, label).toBe(1);
    }
  });
});
