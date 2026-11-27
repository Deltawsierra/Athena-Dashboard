import { afterAll, beforeAll, describe, expect, it } from "vitest";
import dc from "diagnostics_channel";
import type { IncomingMessage } from "http";
import {
  aDashboard, answerOf, aroundAHeldStore, close, until, type Around,
} from "./helpers/a-dashboard-on-a-held-store";

/**
 * SAFETY: a store whose worker thread ends refuses every call it held at once
 * -- a read as not known, a write as not known to be written -- and the next
 * call is answered by a new thread. Nothing waits on a thread that is gone,
 * nothing is sent again, and nothing in between reads as an answer: the AI
 * control settings, asked meanwhile, are not read as the switch off, and a
 * start made meanwhile is refused, and never reaches the engine.
 *
 * The store's thread is held as a stalled disk holds it, with calls in flight,
 * and is then ended as a crash would end it (tests/helpers/held-store.ts
 * endTheStoreThread). The person is in a process of their own.
 */

const HELD_MS = 30_000;
/** How soon after the thread said it was exiting each call held is refused. */
const REFUSED_WITHIN_MS = 100;

let around: Around;
beforeAll(async () => {
  around = await aroundAHeldStore();
});
afterAll(async () => {
  await around.end();
});

describe("the store's worker thread ends with calls in flight", () => {
  it("each call it held is refused within 100 ms -- a write as not known to be written --, the AI control settings asked meanwhile are never the switch off, and the next call is answered by a new thread", async () => {
    const dash = await aDashboard("the-thread-ends");
    const { store, answers } = around;
    const callsBefore = around.engineCalls.length;
    const arrived = new Set<string>();
    const arrival = (message: unknown) => {
      const req = (message as { request: IncomingMessage }).request;
      arrived.add(`${req.method} ${req.url}`);
    };
    dc.subscribe("http.server.request.start", arrival);
    try {
      const marker = `thread-ends-${Date.now()}`;
      let holding = false;
      store.onHeld = () => { holding = true; };
      store.holdFor(HELD_MS);
      const settled = (call: Promise<unknown>) => call.then(
        (value) => ({ ok: true as const, at: Date.now(), value }), (cause: unknown) => ({ ok: false as const, at: Date.now(), cause }));
      const inFlight = {
        read: settled(dash.storage.getAllClients()),
        killSwitch: settled(dash.storage.getKillSwitchState()),
        write: settled(dash.storage.createActivityLog({ action: marker, entityType: "test", entityId: "ends", details: null, userId: null })),
        tests: settled(dash.storage.getAllTests()),
      };
      const settings = around.send(dash.base, dash.cookie, { method: "GET", path: "/api/ai-control" });
      const start = around.send(dash.base, dash.cookie, {
        method: "POST", path: "/api/scans", body: { consent: true, clientId: dash.clientId, target: "https://offline.invalid/" },
      });
      await until(() => holding && arrived.has("GET /api/ai-control") && arrived.has("POST /api/scans"), (one) => one, 5_000);
      expect(holding, "the store's thread was held").toBe(true);
      // Every call is still waiting on the held thread.
      expect(answers.some((one) => one.id === settings || one.id === start)).toBe(false);

      const exited = await store.endTheStoreThread();
      const outcomes = {
        read: await inFlight.read, killSwitch: await inFlight.killSwitch, write: await inFlight.write, tests: await inFlight.tests,
      };
      const settingsAnswer = await answerOf(around, settings, 10_000);
      const startAnswer = await answerOf(around, start, 10_000);
      console.log(`[the thread ends] refused after ${Object.entries(outcomes).map(([name, one]) => `${name} ${one.at - exited} ms`).join(", ")}; ` +
        `the settings answered ${settingsAnswer.status} after the thread said it was exiting by ${settingsAnswer.answeredAt! - exited} ms`);
      for (const [name, one] of Object.entries(outcomes)) {
        expect(one.ok, `${name} was not answered`).toBe(false);
        expect(one.at - exited, name).toBeLessThan(REFUSED_WITHIN_MS);
      }
      expect(String((outcomes.write as { cause: Error }).cause.message)).toMatch(/not known to be written/);
      expect(String((outcomes.killSwitch as { cause: Error }).cause.message)).toMatch(/not known/);
      // Asked while the thread was held and then ended: not read, never the switch off.
      expect(settingsAnswer.body?.killSwitchEnabled).not.toBe(false);
      expect(settingsAnswer.status).toBe(503);
      expect(settingsAnswer.body).toEqual({ message: "the store did not answer; nothing was read" });
      expect(settingsAnswer.answeredAt! - exited).toBeLessThan(REFUSED_WITHIN_MS + 400);
      // A start made meanwhile: refused, and never sent.
      expect(startAnswer.status).toBe(503);
      expect(around.engineCalls.slice(callsBefore).some((one) => one.line === "POST /api/scan")).toBe(false);

      // The next call: a new thread, on the same file.
      store.holdFor(0);
      expect((await dash.storage.getAllClients()).length).toBeGreaterThan(0);
      expect((await dash.storage.getKillSwitchState())?.killSwitchEnabled ?? false).toBe(false);
      const after = await fetch(`${dash.base}/api/ai-control`, { headers: { cookie: dash.cookie } });
      expect(after.status).toBe(200);
      expect((await after.json()).killSwitchEnabled).toBe(false);
      // The write that was in flight was never sent again: it was made once, or not at all.
      expect((await dash.storage.getAllActivityLogs()).filter((one) => one.action === marker).length).toBeLessThanOrEqual(1);
    } finally {
      dc.unsubscribe("http.server.request.start", arrival);
      store.holdFor(0);
      store.onHeld = null;
      await close(dash);
    }
  }, 60_000);
});
