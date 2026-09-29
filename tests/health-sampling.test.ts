import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Express } from "express";

import { makeApp, signIn } from "./helpers";

/**
 * A health screen has to measure, or say it did not.
 *
 * The installer used to write one row -- 24% CPU, 41% memory, 98% success,
 * 94% detection accuracy, a 3% false-positive rate -- and nothing ever wrote
 * a second. The screen graded itself "excellent" off three of those
 * constants, on every machine, forever. On a page where detection accuracy
 * and the false-positive rate are the two figures anybody would most want to
 * trust.
 */
describe("measuring this deployment", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    vi.resetModules();
    app = await makeApp();
    agent = await signIn(app);
  });

  it("seeds no health metric at all", async () => {
    // The sampler is started by the server entrypoint, not by createApp, so a
    // freshly seeded app has taken no reading. That is a real state and the
    // route says so rather than answering 404, which made the screen render
    // its error fallback on every fresh install.
    const latest = await agent.get("/api/ai-health/latest");
    expect(latest.status).toBe(200);
    expect(latest.body).toBeNull();

    const list = await agent.get("/api/ai-health");
    expect(list.body).toEqual([]);
  });

  it("measures the machine and counts the record", async () => {
    const { measure } = await import("../server/health");
    const reading = await measure();

    // Measured, so a number in range rather than a constant. 24 and 41 were
    // the constants; asserting "not 24" would pass for the next constant, so
    // this asserts the shape a measurement has.
    expect(reading.cpuUsage).toBeGreaterThanOrEqual(0);
    expect(reading.cpuUsage).toBeLessThanOrEqual(100);
    expect(reading.memoryUsage).toBeGreaterThan(0);
    expect(reading.memoryUsage).toBeLessThanOrEqual(100);

    // Counted from the record, and the installer's rows are not part of it.
    // The seed has one in-progress test; counting it would put "1 scan
    // running" on a machine that has scanned nothing.
    expect(reading.activeScans).toBe(0);
    expect(reading.totalScansToday).toBe(0);
  });

  it("never reports a detection accuracy or a false-positive rate", async () => {
    const { measure } = await import("../server/health");
    const reading = await measure();

    // Null, not zero. Neither single figure has a run or a commit behind it,
    // and a zero would read as a measured zero. What the engine measured is
    // on `benchmark`, with where it came from
    // (the-engine-s-measured-pair-reaches-the-reading-with-the-one-before-it).
    expect(reading.detectionAccuracy).toBeNull();
    expect(reading.falsePositiveRate).toBeNull();
  });

  it("leaves the success rate absent until a scan has finished", async () => {
    const { measure } = await import("../server/health");

    const own = await makeApp();
    const admin = await signIn(own);

    const client = await admin.post("/api/clients").send({
      name: "Rate", company: "Rate Ltd", email: "rate@example.test",
    });

    // Nothing has finished: 100% of nothing is not a success rate.
    expect((await measure()).successRate).toBeNull();

    await admin.post("/api/tests").send({
      clientId: client.body.id, testType: "scan", status: "completed",
    });
    await admin.post("/api/tests").send({
      clientId: client.body.id, testType: "scan", status: "failed",
    });

    // One of two finished scans completed.
    expect((await measure()).successRate).toBe(50);
  });

  it("leaves the guard count absent when no engine answered", async () => {
    const { measure } = await import("../server/health");
    const reading = await measure();
    // No engine is configured in this suite, so there is nothing to report
    // and the reading says so rather than carrying a zero.
    expect(reading.guardsChecked).toBeNull();
    expect(reading.guardsFailing).toBeNull();
    // Nor a detection benchmark: no number, and why.
    expect(reading.benchmark).toBeNull();
    expect(reading.benchmarkUnmeasured).toBe("no engine is configured, so nothing has measured its detection");
  });

  it("stores a reading with its unmeasured columns null", async () => {
    const { measure } = await import("../server/health");
    const { storage } = await import("../server/storage-unified");

    const stored = await storage.createAIHealthMetric(await measure());
    expect(stored.detectionAccuracy).toBeNull();
    expect(stored.falsePositiveRate).toBeNull();
    expect(typeof stored.cpuUsage).toBe("number");
  });
});
