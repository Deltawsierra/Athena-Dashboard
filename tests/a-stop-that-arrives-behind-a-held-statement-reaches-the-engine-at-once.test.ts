import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  aDashboard, answerOf, aroundAHeldStore, close, holdFromTheArrivalOf, reachOf, sleep, until,
  type Around, type Dashboard, type Press,
} from "./helpers/a-dashboard-on-a-held-store";

/**
 * SAFETY: a Stop that arrives while a stalled disk holds ANOTHER piece of
 * work's store statement reaches the engine at once.
 *
 * better-sqlite3 runs each statement synchronously, for as long as the disk
 * takes. On the event loop, a statement a stalled disk held -- the account
 * read of the console's poll of /api/tests, a write, the scan page's poll, a
 * background note -- held every request behind it: a retest's Stop, a scan's
 * Stop and the kill switch, each pressed 100 ms after a statement held 3 s
 * reached the engine, reached it after 2908-2934 ms (DASH-STORE-OFF-THE-LOOP,
 * fact 1.2). The store now runs on a worker thread of its own
 * (server/store-client.ts): the disk holds that thread, and the loop sends
 * the Stop.
 *
 * And two Stops that need what the loop holds of the store: a scan's Stop for
 * a test another dashboard wrote before this one started, which this one
 * never read -- found in memory from the read of every test made when the
 * store's thread starts -- and a Stop pressed while the kill switch's own read
 * of the tests table is held.
 *
 * The store is held as a stalled disk holds it, on the store's thread and on
 * this one (tests/helpers/held-store.ts). The engine and the person are each
 * in a process of their own, and time by their own clocks. The bounds are the
 * ones a Stop is held to elsewhere (tests/a-stop-is-answered-at-once-while-a-
 * stalled-disk-holds-the-store.test.ts): the engine within 250 ms of the
 * press, the answer within 500 ms.
 */

const HELD_MS = 3_000;
const REACH_MS = 250;
const ANSWER_MS = 500;

let around: Around;
beforeAll(async () => {
  around = await aroundAHeldStore();
});
afterAll(async () => {
  await around.end();
});

type Behind = { request: Press } | { background: true };

/**
 * `first` is sent (or a background write made), and the store held for
 * HELD_MS from its arrival; the Stop `stop` is sent 100 ms after it, by the
 * person's clock. Answers when the Stop reached the engine for each of
 * `runIds`, its answer, and the statements held.
 */
async function behind(dash: Dashboard, first: Behind, stop: Press, runIds: string[]) {
  const { store } = around;
  const heldBefore = store.held.length;
  const callsBefore = around.engineCalls.length;
  const stopWatching = "request" in first ? holdFromTheArrivalOf(store, first.request.method, first.request.path, HELD_MS) : () => undefined;
  try {
    let firstId: string | null = null;
    if ("request" in first) firstId = around.send(dash.base, dash.cookie, first.request);
    const stopId = around.send(dash.base, dash.cookie, { ...stop, afterMs: 100 });
    if (!("request" in first)) {
      // A background write -- a health sample, a watcher's note -- with no request behind it, held by the disk.
      await sleep(30);
      store.holdFor(HELD_MS);
      void dash.storage.createActivityLog({ action: "probe", entityType: "probe", entityId: "probe", details: null, userId: null }).catch(() => undefined);
    }
    const answer = await answerOf(around, stopId, HELD_MS + 15_000);
    const reach = await reachOf(around, callsBefore, answer.sentAt, runIds);
    if (firstId !== null) await answerOf(around, firstId, HELD_MS + 15_000);
    await until(() => Date.now(), () => store.held.length > heldBefore, HELD_MS + 5_000);
    const held = store.held.slice(heldBefore);
    console.log(`[behind a held statement] ${stop.method} ${stop.path.replace(/[0-9a-f-]{36}/g, ":id")} behind ` +
      `${"request" in first ? `${first.request.method} ${first.request.path.replace(/[0-9a-f-]{36}/g, ":id")}` : "a background write"}: ` +
      `reached the engine after ${reach.join(", ")} ms, answered after ${answer.answeredAt! - answer.sentAt} ms; held ${held[0]?.sql ?? "nothing"}`);
    return { answer, reach, held };
  } finally {
    stopWatching();
    store.holdFor(0);
    store.onHeld = null;
  }
}

function expectReachedAtOnce(reach: Array<number | null>): void {
  for (const ms of reach) {
    expect(ms, "the stop reached the engine").not.toBeNull();
    expect(ms!).toBeLessThan(REACH_MS);
  }
}

describe("a Stop that arrives behind another piece of work's statement, held 3 s by the disk", () => {
  it("a retest's Stop behind the console's poll of /api/tests reaches the engine within 250 ms and is answered within 500 ms", async () => {
    const runId = "behind-tests-poll";
    const dash = await aDashboard(runId);
    try {
      const { answer, reach, held } = await behind(dash, { request: { method: "GET", path: "/api/tests" } },
        { method: "POST", path: `/api/retests/${runId}/abort` }, [runId]);
      expect(answer.status).toBe(200);
      expect(Math.max(...held.map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      expectReachedAtOnce(reach);
      expect(answer.answeredAt! - answer.sentAt).toBeLessThan(ANSWER_MS);
    } finally {
      await close(dash);
    }
  }, 60_000);

  it("a scan's Stop behind a write (a new client) reaches the engine within 250 ms and is answered within 500 ms", async () => {
    const runId = "behind-a-write";
    const dash = await aDashboard(runId);
    try {
      const { answer, reach, held } = await behind(dash,
        { request: { method: "POST", path: "/api/clients", body: { name: "W", company: "W", email: "w@w.test" } } },
        { method: "POST", path: `/api/scans/${dash.testId}/abort` }, [`scan-of-${runId}`]);
      expect(answer.status).toBe(200);
      expect(Math.max(...held.map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      expectReachedAtOnce(reach);
      expect(answer.answeredAt! - answer.sentAt).toBeLessThan(ANSWER_MS);
    } finally {
      await close(dash);
    }
  }, 60_000);

  it("a scan's Stop behind the scan page's poll reaches the engine within 250 ms and is answered within 500 ms", async () => {
    const runId = "behind-scan-poll";
    const dash = await aDashboard(runId);
    try {
      const { answer, reach, held } = await behind(dash, { request: { method: "GET", path: `/api/scans/${dash.testId}` } },
        { method: "POST", path: `/api/scans/${dash.testId}/abort` }, [`scan-of-${runId}`]);
      expect(answer.status).toBe(200);
      expect(Math.max(...held.map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      expectReachedAtOnce(reach);
      expect(answer.answeredAt! - answer.sentAt).toBeLessThan(ANSWER_MS);
    } finally {
      await close(dash);
    }
  }, 60_000);

  it("a retest's Stop behind a background write, with no request behind it, reaches the engine within 250 ms and is answered within 500 ms", async () => {
    const runId = "behind-background";
    const dash = await aDashboard(runId);
    try {
      const { answer, reach, held } = await behind(dash, { background: true },
        { method: "POST", path: `/api/retests/${runId}/abort` }, [runId]);
      expect(answer.status).toBe(200);
      expect(Math.max(...held.map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      expectReachedAtOnce(reach);
      expect(answer.answeredAt! - answer.sentAt).toBeLessThan(ANSWER_MS);
    } finally {
      await close(dash);
    }
  }, 60_000);

  it("the kill switch behind the console's poll of /api/tests: each stop it knows of in memory reaches the engine within 250 ms", async () => {
    const runId = "ks-behind-tests-poll";
    const dash = await aDashboard(runId);
    try {
      const { answer, reach, held } = await behind(dash, { request: { method: "GET", path: "/api/tests" } },
        { method: "PATCH", path: "/api/ai-control", body: { killSwitchEnabled: true } }, [runId, `ks-${runId}`]);
      expect(answer.status).toBe(200);
      expect(Math.max(...held.map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      expectReachedAtOnce(reach);
    } finally {
      await fetch(`${dash.base}/api/ai-control`, {
        method: "PATCH", headers: { cookie: dash.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ killSwitchEnabled: false, systemStatus: "operational" }),
      });
      await close(dash);
    }
  }, 60_000);
});

describe("a Stop that needs what this process holds of the store, while the disk holds it 3 s", () => {
  it("a scan's Stop for a test another dashboard wrote before this one started, never read here: found in memory, it reaches the engine within 250 ms and is answered within 500 ms", async () => {
    // Another dashboard made the file; a scan of its is on it.
    const other = await aDashboard(null);
    const file = other.dbPath;
    await close(other);
    const raw = new Database(file);
    raw.prepare(`INSERT INTO tests (id, client_id, test_type, status, started_at, completed_at, summary, findings,
      vulnerabilities_found, critical_count, high_count, medium_count, low_count, executed_by, is_sample)
      VALUES ('written-elsewhere', NULL, 'vulnerability-scan', 'running', @now, NULL, 'elsewhere', @findings, 0, 0, 0, 0, 0, NULL, 0)`)
      .run({ now: Date.now(), findings: JSON.stringify({ runId: "run-written-elsewhere", target: "https://offline.invalid/", results: [] }) });
    raw.close();
    // This dashboard starts on that file, and reads no test list.
    const dash = await aDashboard(null, file);
    try {
      expect(await until(() => dash.storage.peekTest("written-elsewhere"), (one) => one !== undefined, 5_000), "held in memory from the start").toBeDefined();
      const { store } = around;
      const heldBefore = store.held.length;
      const callsBefore = around.engineCalls.length;
      const stopWatching = holdFromTheArrivalOf(store, "POST", "/api/scans/written-elsewhere/abort", HELD_MS);
      try {
        const id = around.send(dash.base, dash.cookie, { method: "POST", path: "/api/scans/written-elsewhere/abort" });
        const answer = await answerOf(around, id, HELD_MS + 15_000);
        const reach = await reachOf(around, callsBefore, answer.sentAt, ["run-written-elsewhere"]);
        await until(() => Date.now(), () => store.held.length > heldBefore, HELD_MS + 5_000);
        console.log(`[never read here] the scan's Stop reached the engine after ${reach[0]} ms, answered after ${answer.answeredAt! - answer.sentAt} ms`);
        expect(answer.status).toBe(200);
        expect(Math.max(...store.held.slice(heldBefore).map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
        expectReachedAtOnce(reach);
        expect(answer.answeredAt! - answer.sentAt).toBeLessThan(ANSWER_MS);
      } finally {
        stopWatching();
        store.holdFor(0);
      }
    } finally {
      await close(dash);
    }
  }, 60_000);

  it("a scan's Stop pressed 100 ms after the kill switch, the store held from the kill switch's arrival -- its own read of the tests table among what is held: it reaches the engine within 250 ms and is answered within 500 ms", async () => {
    const runId = "behind-the-kill-switch";
    const dash = await aDashboard(runId);
    try {
      const { answer, reach, held } = await behind(dash,
        { request: { method: "PATCH", path: "/api/ai-control", body: { killSwitchEnabled: true } } },
        { method: "POST", path: `/api/scans/${dash.testId}/abort` }, [`scan-of-${runId}`]);
      expect(answer.status).toBe(200);
      expect(Math.max(...held.map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      expectReachedAtOnce(reach);
      expect(answer.answeredAt! - answer.sentAt).toBeLessThan(ANSWER_MS);
    } finally {
      await fetch(`${dash.base}/api/ai-control`, {
        method: "PATCH", headers: { cookie: dash.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ killSwitchEnabled: false, systemStatus: "operational" }),
      });
      await close(dash);
    }
  }, 60_000);
});
