import { beforeAll, describe, expect, it } from "vitest";

import type { IStorage } from "../server/storage";
import type { CollectWatch } from "../shared/schema";

/**
 * A collect watch -- a scan started through Athena-Backend whose run has ended,
 * kept on the record until the backend has collected it (the Option 1 hybrid,
 * server/collect-watch.ts) -- behaves the same on both storage backends:
 *
 *   - a new watch is on the record, found by its backend scan id and by its
 *     test, and listed among the open ones while it is `running`;
 *   - a second watch of the same scan is refused (one watch per scan);
 *   - a running watch takes a change; an ended one takes none;
 *   - ENDING it is a claim: the first end answers true and the second false,
 *     so two dashboards that collected the same record file it into the row
 *     once; the record it ended with reads back whole;
 *   - and a client's backend engagement and testing window round-trip, so the
 *     engagement is created once per client and the window a person set is
 *     the one the next launch sends.
 */

const SCAN = "11111111-2222-4333-8444-555555555555";
const RECORD = {
  uuid: SCAN, status: "completed", verdict: "READY", verdict_label: "Ready for deployment",
  engine_response: { results: [{ type: "x", severity: "low" }], coverage: { complete: true, checks: [] } },
};

function watchOf(testId: string, backendScanId = SCAN): CollectWatch {
  const now = new Date();
  return {
    backendScanId, testId, engineRunId: "run-1", startedAt: now, deadlineAt: new Date(now.getTime() + 60_000),
    state: "running", lastAnswer: null, lastReadAt: null, lastReadError: null, endedAt: null, record: null,
  };
}

const BACKENDS: Array<{ name: string; open: () => Promise<IStorage> }> = [
  {
    name: "memory",
    open: async () => {
      const { MemStorage } = await import("../server/storage");
      return new MemStorage();
    },
  },
  {
    name: "sqlite",
    open: async () => {
      process.env.ATHENA_DB_PATH = ":memory:";
      return (await import("../server/storage-sqlite")).storage;
    },
  },
];

describe.each(BACKENDS)("collect watches on the $name backend", ({ open }) => {
  let storage: IStorage;
  let testId = "";

  beforeAll(async () => {
    storage = await open();
    const client = await storage.createClient({ name: "Watched", company: "Watched Co", email: "w@w.test" });
    const test = await storage.createTest({ clientId: client.id, testType: "penetration_test", status: "completed", findings: { runId: "run-1" } });
    testId = test.id;
  });

  it("records a watch, finds it by scan and by test, and lists it open while running", async () => {
    const created = await storage.createCollectWatch(watchOf(testId));
    expect(created.state).toBe("running");
    const byScan = await storage.getCollectWatch(SCAN);
    expect(byScan?.testId).toBe(testId);
    expect(byScan?.engineRunId).toBe("run-1");
    expect(byScan?.startedAt).toBeInstanceOf(Date);
    expect(byScan?.deadlineAt.getTime()).toBeGreaterThan(byScan!.startedAt.getTime());
    expect((await storage.getCollectWatchByTest(testId))?.backendScanId).toBe(SCAN);
    expect((await storage.getOpenCollectWatches()).map((one) => one.backendScanId)).toContain(SCAN);
  });

  it("refuses a second watch of the same scan", async () => {
    await expect(storage.createCollectWatch(watchOf(testId))).rejects.toThrow();
  });

  it("takes a change while running, and ends exactly once", async () => {
    const at = new Date();
    expect(await storage.updateRunningCollectWatch(SCAN, { lastAnswer: "pending", lastReadAt: at, lastReadError: null })).toBe(true);
    expect((await storage.getCollectWatch(SCAN))?.lastAnswer).toBe("pending");

    const ended = await storage.endCollectWatch(SCAN, { state: "collected", endedAt: new Date(), record: RECORD, lastAnswer: "collected", lastReadAt: new Date() });
    expect(ended, "the first end is the claim").toBe(true);
    const again = await storage.endCollectWatch(SCAN, { state: "collected", endedAt: new Date(), record: { uuid: SCAN, status: "failed" } });
    expect(again, "a second end of an ended watch files nothing").toBe(false);

    const after = await storage.getCollectWatch(SCAN);
    expect(after?.state).toBe("collected");
    expect(after?.record).toEqual(RECORD);
    expect(after?.endedAt).toBeInstanceOf(Date);
    expect(await storage.updateRunningCollectWatch(SCAN, { lastAnswer: "conflict" }), "an ended watch takes no change").toBe(false);
    expect((await storage.getOpenCollectWatches()).map((one) => one.backendScanId)).not.toContain(SCAN);
  });

  it("round-trips a client's backend engagement and testing window", async () => {
    const client = await storage.createClient({ name: "Windowed", company: "Windowed Co", email: "win@w.test" });
    expect(client.backendEngagementId).toBeNull();
    expect(client.testingWindowStart).toBeNull();
    expect(client.testingWindowEnd).toBeNull();
    const start = new Date("2026-10-22T09:00:00.000Z");
    const end = new Date("2027-01-20T09:00:00.000Z");
    const updated = await storage.updateClient(client.id, { backendEngagementId: 42, testingWindowStart: start, testingWindowEnd: end });
    expect(updated?.backendEngagementId).toBe(42);
    const read = await storage.getClient(client.id);
    expect(read?.backendEngagementId).toBe(42);
    expect(read?.testingWindowStart).toBeInstanceOf(Date);
    expect(read?.testingWindowStart?.getTime()).toBe(start.getTime());
    expect(read?.testingWindowEnd?.getTime()).toBe(end.getTime());
  });
});
