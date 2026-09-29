import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import type { IStorage } from "../server/storage";
import type { AIHealthMetric, BenchmarkReading } from "@shared/schema";
import { makeApp, signIn } from "./helpers";

/**
 * The engine's detection benchmark reaches the health reading as two numbers
 * together -- attacks caught and legitimate work let through -- with the run,
 * commit and time they came from, and with the different measurement before
 * them.
 *
 * Detection accuracy and the false-positive rate were null on every reading,
 * truthfully: the benchmark ran only in the engine's CI and no route reported
 * it. The engine's /health now carries its own run of that benchmark
 * (athena-engine benchmark/live.py), and this is the dashboard reading it.
 * No number reaches a reading that the engine did not send, or that came in a
 * report this cannot read, and none can be typed in through the API.
 */

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** One pair as the engine's /health sends it: rates rounded to four places, and their counts. */
const pair = (caught: number, attacks: number, flagged: number, legitimate: number) => ({
  security_retained: Math.round((caught / attacks) * 10_000) / 10_000,
  utility_retained: Math.round((1 - flagged / legitimate) * 10_000) / 10_000,
  attacks, caught, legitimate, flagged,
});

/** A run at one commit. */
const RUN_A = {
  measured: true,
  run: "a".repeat(32),
  measured_at: "2026-09-26T10:00:00Z",
  commit: "1".repeat(40),
  commit_modified: false,
  commit_unknown: null,
  tuned: pair(165, 183, 0, 83),
  holdout: pair(24, 27, 0, 15),
  holdout_unmeasured: null,
};

/** The next commit: a remediation that catches every attack by flagging legitimate work. */
const RUN_B = {
  ...RUN_A,
  run: "b".repeat(32),
  measured_at: "2026-09-29T05:00:00Z",
  commit: "2".repeat(40),
  tuned: pair(183, 183, 5, 83),
  holdout: pair(27, 27, 2, 15),
};

/** What the stand-in engine's /health carries under `benchmark`. `undefined` leaves the key out. */
let benchmark: unknown = RUN_A;
/** When set, /health answers this status and nothing else. */
let healthStatus: number | null = null;
let engine: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let measure: () => Promise<unknown>;

/** What the sampler does once a minute. */
async function sample(): Promise<AIHealthMetric> {
  return storage.createAIHealthMetric((await measure()) as Parameters<IStorage["createAIHealthMetric"]>[0]);
}

beforeAll(async () => {
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") {
      if (healthStatus !== null) return json(res, healthStatus, { detail: "unavailable" });
      const body: Record<string, unknown> = { status: "ok", guards: { checked: 40, failing: 0, skipped: [] } };
      if (benchmark !== undefined) body.benchmark = benchmark;
      return json(res, 200, body);
    }
    if (url === "/api/scans/active") return json(res, 200, { active: [] });
    return json(res, 404, { detail: "not here" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  agent = await signIn(await makeApp());
  storage = (await import("../server/storage-unified")).storage;
  measure = (await import("../server/health")).measure;
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
});

describe("the engine's measured pair on a health reading", () => {
  it("reaches the reading, and the route the screen reads, with its run, commit and time", async () => {
    benchmark = RUN_A;
    const reading = await sample();

    expect(reading.benchmarkUnmeasured).toBeNull();
    expect(reading.benchmark).toEqual({
      current: {
        run: RUN_A.run,
        measuredAt: RUN_A.measured_at,
        commit: RUN_A.commit,
        commitModified: false,
        commitUnknown: null,
        tuned: { securityRetained: 0.9016, utilityRetained: 1, attacks: 183, caught: 165, legitimate: 83, flagged: 0 },
        holdout: { securityRetained: 0.8889, utilityRetained: 1, attacks: 27, caught: 24, legitimate: 15, flagged: 0 },
        holdoutUnmeasured: null,
      },
      // The first measurement on record here: nothing to compare it with.
      previous: null,
    });
    // The two single figures stay null: they have no run and no commit.
    expect(reading.detectionAccuracy).toBeNull();
    expect(reading.falsePositiveRate).toBeNull();

    const latest = await agent.get("/api/ai-health/latest");
    expect(latest.body.benchmark).toEqual(reading.benchmark);
  });

  it("carries the measurement before it when a remediation raised security and dropped utility", async () => {
    benchmark = RUN_B;
    const reading = await sample();
    const { current, previous } = reading.benchmark as BenchmarkReading;

    expect(current.commit).toBe(RUN_B.commit);
    expect(previous?.run).toBe(RUN_A.run);
    expect(previous?.commit).toBe(RUN_A.commit);
    // Both halves of the trade are on the reading, beside what they were.
    expect(current.tuned.securityRetained).toBeGreaterThan(previous!.tuned.securityRetained);
    expect(current.tuned.utilityRetained).toBeLessThan(previous!.tuned.utilityRetained);
    expect(current.tuned.flagged).toBe(5);
  });

  it("keeps that change in view when the engine restarts and measures the same code again", async () => {
    benchmark = { ...RUN_B, run: "c".repeat(32), measured_at: "2026-09-29T06:00:00Z" };
    const reading = await sample();
    const { current, previous } = reading.benchmark as BenchmarkReading;

    expect(current.run).toBe("c".repeat(32));
    // Not the start before (the same code, the same numbers), which would
    // read "no change" and hide what the remediation did.
    expect(previous?.run).toBe(RUN_A.run);
  });

  it("holds no number while the engine has none, and loses nothing it had before", async () => {
    benchmark = {
      measured: false,
      reason: "the engine started its benchmark run at 2026-09-29T07:00:00Z and it has not finished",
    };
    const waiting = await sample();
    expect(waiting.benchmark).toBeNull();
    expect(waiting.benchmarkUnmeasured).toBe(
      "the engine has no measurement to report: the engine started its benchmark run at " +
      "2026-09-29T07:00:00Z and it has not finished",
    );

    healthStatus = 503;
    const away = await sample();
    healthStatus = null;
    expect(away.benchmark).toBeNull();
    expect(away.benchmarkUnmeasured).toBe("the engine's health report could not be had when this reading was taken");

    // The engine is back, on the same code: still compared with the commit before.
    benchmark = { ...RUN_B, run: "d".repeat(32), measured_at: "2026-09-29T07:01:00Z" };
    const back = await sample();
    expect((back.benchmark as BenchmarkReading).previous?.run).toBe(RUN_A.run);
  });

  it("says so when the engine predates the report", async () => {
    benchmark = undefined;
    const reading = await sample();
    expect(reading.benchmark).toBeNull();
    expect(reading.benchmarkUnmeasured).toMatch(/carries no benchmark measurement: the engine predates it/);
  });

  const UNREADABLE: Array<[string, unknown]> = [
    ["not an object", "measured"],
    ["neither measured nor not", { ...RUN_B, measured: "yes" }],
    ["no tuned pair", { ...RUN_B, tuned: undefined }],
    ["a rate above one", { ...RUN_B, tuned: { ...RUN_B.tuned, security_retained: 1.5 } }],
    ["a negative count", { ...RUN_B, tuned: { ...RUN_B.tuned, attacks: -1 } }],
    ["more caught than attacks", { ...RUN_B, tuned: { ...RUN_B.tuned, caught: 200 } }],
    ["a rate that is not its counts'", { ...RUN_B, tuned: { ...RUN_B.tuned, utility_retained: 1 } }],
    ["a rate over no cases", { ...RUN_B, holdout: pair(0, 0, 0, 15) }],
    ["rates without counts", { ...RUN_B, tuned: { security_retained: 1, utility_retained: 1 } }],
    ["a commit that is not a commit id", { ...RUN_B, commit: "main" }],
    ["no commit and no reason", { ...RUN_B, commit: null, commit_modified: null, commit_unknown: null }],
    ["no holdout and no reason", { ...RUN_B, holdout: null, holdout_unmeasured: null }],
    ["no time", { ...RUN_B, measured_at: "yesterday" }],
    ["no run", { ...RUN_B, run: "" }],
  ];
  for (const [what, block] of UNREADABLE) {
    it(`reads no number from a report with ${what}`, async () => {
      benchmark = block;
      const reading = await sample();
      expect(reading.benchmark).toBeNull();
      expect(reading.benchmarkUnmeasured).toMatch(/^the engine reported a benchmark measurement this dashboard could not read \(/);
    });
  }

  it("reads a measurement with no commit or no holdout, and keeps the engine's reason", async () => {
    benchmark = {
      ...RUN_B, run: "e".repeat(32), commit: null, commit_modified: null,
      commit_unknown: "the engine's source is not a git checkout, so its commit cannot be read",
      holdout: null, holdout_unmeasured: "the benchmark measured no holdout set",
    };
    const { current } = (await sample()).benchmark as BenchmarkReading;
    expect(current.commit).toBeNull();
    expect(current.commitUnknown).toBe("the engine's source is not a git checkout, so its commit cannot be read");
    expect(current.holdout).toBeNull();
    expect(current.holdoutUnmeasured).toBe("the benchmark measured no holdout set");
  });

  it("takes no benchmark typed in through the API", async () => {
    const before = await storage.getLatestBenchmarkReading();
    const typed: BenchmarkReading = {
      current: { ...(before as BenchmarkReading).current, run: "typed", commit: "f".repeat(40) },
      previous: null,
    };
    const posted = await agent.post("/api/ai-health").send({
      cpuUsage: 1, memoryUsage: 2, benchmark: typed, benchmarkUnmeasured: "typed",
    });
    expect(posted.status).toBe(201);
    expect(posted.body.benchmark).toBeNull();
    expect(posted.body.benchmarkUnmeasured).toBeNull();
    // And the next measurement is still compared with what the engine sent.
    expect(await storage.getLatestBenchmarkReading()).toEqual(before);
  });
});

describe("the SQLite backend", () => {
  it("keeps the benchmark on a database from before it, rebuilt or not, and finds the latest one held", async () => {
    // ai_health_metrics exactly as the oldest shape was: the one the rebuild
    // in db-sqlite.ts rewrites. A rebuild that left out the new columns would
    // drop them right after they were added.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-benchmark-"));
    const file = path.join(dir, "athena.db");
    const handle = new Database(file);
    handle.exec(`
      CREATE TABLE ai_health_metrics (
        id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL,
        cpu_usage INTEGER NOT NULL, memory_usage INTEGER NOT NULL,
        active_scans INTEGER NOT NULL DEFAULT 0,
        total_scans_today INTEGER NOT NULL DEFAULT 0,
        success_rate INTEGER NOT NULL, average_response_time INTEGER NOT NULL,
        models_loaded TEXT, last_training_date INTEGER,
        detection_accuracy INTEGER NOT NULL, false_positive_rate INTEGER NOT NULL
      );
    `);
    handle.close();
    const previousPath = process.env.ATHENA_DB_PATH;
    process.env.ATHENA_DB_PATH = file;
    vi.resetModules();
    try {
      const { storage: sqlite } = await import("../server/storage-sqlite");
      expect(await sqlite.getLatestBenchmarkReading()).toBeNull();

      const held: BenchmarkReading = {
        current: {
          run: "a".repeat(32), measuredAt: "2026-09-26T10:00:00Z", commit: "1".repeat(40),
          commitModified: false, commitUnknown: null,
          tuned: { securityRetained: 0.9016, utilityRetained: 1, attacks: 183, caught: 165, legitimate: 83, flagged: 0 },
          holdout: null, holdoutUnmeasured: "the benchmark measured no holdout set",
        },
        previous: null,
      };
      const written = await sqlite.createAIHealthMetric({ cpuUsage: 1, memoryUsage: 2, benchmark: held });
      expect(written.benchmark).toEqual(held);
      // A later reading with none does not hide the one held before it.
      await sqlite.createAIHealthMetric({ cpuUsage: 1, memoryUsage: 2, benchmarkUnmeasured: "no engine answered" });
      expect(await sqlite.getLatestBenchmarkReading()).toEqual(held);
    } finally {
      if (previousPath === undefined) delete process.env.ATHENA_DB_PATH;
      else process.env.ATHENA_DB_PATH = previousPath;
    }
  });
});
