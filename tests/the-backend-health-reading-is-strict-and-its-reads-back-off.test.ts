import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { classifyHealth, guardReading, KNOWN_COUNT_NAMES, type HealthOutcome } from "@shared/backend-health";
import { lintMicrocopy } from "@shared/persona-lint";
import {
  _resetBackendHealthForTests, backendHealth, backendHealthNextReadInMs, backendHealthReading, backendHealthTimings, nextReadDelay,
  readBackendHealthNow, startBackendHealthReads, MAX_HEALTH_BODY_BYTES,
} from "../server/backend-health";

/**
 * The reading (shared/backend-health.ts) and the background reader
 * (server/backend-health.ts), each on its own:
 *
 *   - "ok" only from an explicit "ok" with every known count reported and zero;
 *   - nothing unreadable, missing, odd or unanswered is ever "ok";
 *   - a reading too old is not served as "ok";
 *   - the reader reads one at a time, waits longer after each read that did not
 *     answer 200 (up to a cap), stops when no one has asked for a while, and
 *     takes no more than a bounded body.
 */

const ZEROS = { stderr_lines_lost: 0, log_records_dropped: 0, unrecorded_dispatches_refused: 0 };
const answered = (body: unknown, httpStatus = 200): HealthOutcome => ({ kind: "answered", httpStatus, body });
const defaults = { ...backendHealthTimings };
const savedUrl = process.env.ATHENA_FAILSAFE_URL;
let server: http.Server | null = null;

afterEach(async () => {
  _resetBackendHealthForTests();
  Object.assign(backendHealthTimings, defaults);
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
  }
  if (savedUrl === undefined) delete process.env.ATHENA_FAILSAFE_URL;
  else process.env.ATHENA_FAILSAFE_URL = savedUrl;
});

async function backend(handler: http.RequestListener): Promise<{ asked: () => number }> {
  let asked = 0;
  server = http.createServer((req, res) => { asked += 1; handler(req, res); });
  await new Promise<void>((ready) => server!.listen(0, "127.0.0.1", ready));
  process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { asked: () => asked };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the reading", () => {
  it("is ok for an explicit ok with every known count zero, and for nothing less", () => {
    expect(classifyHealth(answered({ status: "ok", counts: ZEROS })).verdict).toBe("ok");
    // The same counts under #217's own field name.
    expect(classifyHealth(answered({ status: "ok", degraded: ZEROS })).verdict).toBe("ok");
    for (const name of KNOWN_COUNT_NAMES) {
      const counts: Record<string, number> = { ...ZEROS };
      delete counts[name];
      expect(classifyHealth(answered({ status: "ok", counts })).verdict, name).toBe("unknown");
    }
    expect(classifyHealth(answered({ status: "ok", counts: {} })).verdict).toBe("unknown");
    expect(classifyHealth(answered({ status: "ok", counts: "none" })).verdict).toBe("unknown");
    expect(classifyHealth(answered({ status: "ok", counts: ZEROS, workers: "all" })).verdict).toBe("unknown");
    expect(classifyHealth(answered({ status: "OK", counts: ZEROS })).verdict).toBe("unknown");
    expect(classifyHealth(answered({ status: ["ok"], counts: ZEROS })).verdict).toBe("unknown");
    expect(classifyHealth(answered({ status: "ok", counts: ZEROS }, 204)).verdict).toBe("unknown");
    expect(classifyHealth(answered({ status: "ok", counts: ZEROS }, 503)).verdict).toBe("unknown");
    expect(classifyHealth(answered(null)).verdict).toBe("unknown");
    expect(classifyHealth(answered("ok")).verdict).toBe("unknown");
    expect(classifyHealth(answered([{ status: "ok" }])).verdict).toBe("unknown");
    expect(classifyHealth({ kind: "unreadable", httpStatus: 200, why: "it is not JSON" }).verdict).toBe("unknown");
    expect(classifyHealth({ kind: "unreachable", why: "ECONNREFUSED" }).verdict).toBe("unreachable");
    expect(classifyHealth({ kind: "timeout", ms: 5_000 }).verdict).toBe("unreachable");
  });

  it("reads #217's ok, which names no count, as not reported -- and a degraded answer as degraded", () => {
    const plain = classifyHealth(answered({ status: "ok", message: "Django backend is alive." }));
    expect(plain.verdict).toBe("not-reported");
    expect(plain.counts).toEqual([]);
    const degraded = classifyHealth(answered({ status: "degraded", degraded: { stderr_lines_lost: 2 } }));
    expect(degraded.verdict).toBe("degraded");
    expect(degraded.counts).toEqual([{ name: "stderr_lines_lost", label: "stderr lines lost", value: 2, known: true }]);
    expect(classifyHealth(answered({ status: "error", message: "x" })).verdict).toBe("error");
  });

  it("says a degraded answer that names no count, rather than showing nothing", () => {
    const reading = classifyHealth(answered({ status: "degraded" }));
    expect(reading.verdict).toBe("degraded");
    expect(reading.problems.join("\n")).toMatch(/names no non-zero count/);
  });

  it("cuts a long value and lists at most fifty unrecognised fields, saying how many more", () => {
    const many: Record<string, unknown> = { status: "ok", counts: ZEROS, long: "x".repeat(1_000) };
    for (let i = 0; i < 60; i += 1) many[`extra_${i}`] = i;
    const reading = classifyHealth(answered(many));
    expect(reading.unrecognised).toHaveLength(50);
    expect(reading.unrecognised[0].value).toBe(`"${"x".repeat(199)}…`);
    expect(reading.problems.join("\n")).toMatch(/11 more unrecognised fields are not listed here/);
    // Fields left off the list are not shown, so this is not "ok" though every count is zero.
    expect(reading.verdict).toBe("unknown");
  });

  it("guards what the page is served: anything that is not a reading is unknown, never ok", () => {
    expect(guardReading(undefined).verdict).toBe("unknown");
    expect(guardReading({ verdict: "ok" }).verdict).toBe("unknown");
    expect(guardReading({ verdict: "fine", headline: "x", counts: [], problems: [], unrecognised: [], acknowledgement: [], workers: null }).verdict).toBe("unknown");
    const good = classifyHealth(answered({ status: "ok", counts: ZEROS }));
    expect(guardReading(JSON.parse(JSON.stringify(good))).verdict).toBe("ok");
  });

  it("puts no verdict word about a target on the screen (the persona fence)", () => {
    const outcomes: HealthOutcome[] = [
      answered({ status: "ok", counts: ZEROS }), answered({ status: "ok" }), answered({ status: "degraded", degraded: { a: 1 } }),
      answered({ status: "degraded" }), answered({ status: "unknown" }), answered({ status: "error" }), answered({ status: "zzz" }),
      answered({}), answered(null), answered({ status: "ok", counts: { ...ZEROS, a: "b" } }), answered({ status: "ok", counts: ZEROS }, 500),
      answered({ status: "ok", counts: { stderr_lines_lost: 1 } }),
      { kind: "unreadable", httpStatus: 200, why: "it is not JSON" }, { kind: "unreachable", why: "ECONNREFUSED" }, { kind: "timeout", ms: 5_000 },
    ];
    for (const outcome of outcomes) {
      const reading = classifyHealth(outcome);
      for (const text of [reading.headline, ...reading.problems]) expect(lintMicrocopy(text), text).toEqual([]);
    }
  });
});

describe("the background reader", () => {
  // Started as the server's entry points start it.
  beforeEach(() => startBackendHealthReads());

  it("waits pollMs between reads that answer, and longer after each that does not, up to a cap", () => {
    backendHealthTimings.pollMs = 15_000;
    backendHealthTimings.maxBackoffMs = 120_000;
    expect([0, 1, 2, 3, 4, 10, 100].map(nextReadDelay)).toEqual([15_000, 30_000, 60_000, 120_000, 120_000, 120_000, 120_000]);
  });

  it("reads one at a time", async () => {
    const held: http.ServerResponse[] = [];
    const seen = await backend((_req, res) => { held.push(res); });
    backendHealthTimings.timeoutMs = 200;
    const first = readBackendHealthNow();
    const second = readBackendHealthNow();
    expect(second).toBe(first);
    await first;
    expect(seen.asked()).toBe(1);
    for (const res of held) res.destroy();
  });

  it("backs off after a read that does not answer 200, and reads again at pollMs once one does", async () => {
    let status = 500;
    await backend((_req, res) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "ok", counts: ZEROS })); });
    backendHealthTimings.pollMs = 60_000;
    backendHealthTimings.maxBackoffMs = 300_000;
    backendHealth();
    await readBackendHealthNow();
    expect(backendHealthNextReadInMs()).toBe(120_000);
    await readBackendHealthNow();
    expect(backendHealthNextReadInMs()).toBe(240_000);
    await readBackendHealthNow();
    expect(backendHealthNextReadInMs()).toBe(300_000);
    expect(backendHealth().reading.verdict).toBe("unknown");
    status = 200;
    await readBackendHealthNow();
    expect(backendHealthNextReadInMs()).toBe(60_000);
    expect(backendHealth().reading.verdict).toBe("ok");
  });

  it.each([
    ["refused", "unreachable"],
    ["timed out", "timeout"],
  ])("backs off after a read that was %s", async (_what, how) => {
    if (how === "unreachable") {
      await backend(() => undefined);
      const url = process.env.ATHENA_FAILSAFE_URL!;
      server!.closeAllConnections?.();
      await new Promise<void>((done) => server!.close(() => done()));
      server = null;
      process.env.ATHENA_FAILSAFE_URL = url;
    } else {
      await backend(() => undefined);
      backendHealthTimings.timeoutMs = 100;
    }
    backendHealthTimings.pollMs = 60_000;
    backendHealthTimings.maxBackoffMs = 300_000;
    backendHealth();
    await readBackendHealthNow();
    expect(backendHealth().reading.verdict).toBe("unreachable");
    expect(backendHealthNextReadInMs()).toBe(120_000);
  });

  it("stops reading once no one has asked for idleMs, and starts again when asked", async () => {
    const seen = await backend((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "ok", counts: ZEROS })); });
    backendHealthTimings.pollMs = 20;
    backendHealthTimings.idleMs = 100;
    backendHealth();
    for (let i = 0; i < 250 && backendHealthReading(); i += 1) await sleep(20);
    expect(backendHealthReading()).toBe(false);
    const stopped = seen.asked();
    expect(stopped).toBeGreaterThan(0);
    await sleep(150);
    expect(seen.asked()).toBe(stopped);
    // Asked again: a read is under way at once.
    backendHealth();
    expect(backendHealthReading()).toBe(true);
  });

  it("serves a reading older than staleMs as unknown, never ok", async () => {
    await backend((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "ok", counts: ZEROS })); });
    await readBackendHealthNow();
    const now = Date.now();
    const fresh = backendHealth(now);
    expect(fresh.configured && fresh.reading.verdict).toBe("ok");
    const old = backendHealth(now + backendHealthTimings.staleMs + 1_000);
    expect(old.configured && old.reading.verdict).toBe("unknown");
    expect(old.configured && old.reading.headline).toMatch(/not current/);
  });

  it("takes no more than a bounded body", async () => {
    await backend((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", counts: ZEROS, padding: "x".repeat(MAX_HEALTH_BODY_BYTES) }));
    });
    await readBackendHealthNow();
    const view = backendHealth();
    expect(view.configured && view.reading.verdict).toBe("unknown");
    expect(view.configured && view.reading.headline).toMatch(/larger than 64 KB/);
  });
});
