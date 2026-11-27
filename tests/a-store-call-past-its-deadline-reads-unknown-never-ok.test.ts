import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aDashboard, answerOf, aroundAHeldStore, close, sleep, until, type Around,
} from "./helpers/a-dashboard-on-a-held-store";

/**
 * SAFETY: a store call the store does not answer in time is never read as an
 * answer. Every call has a time on the event loop (server/store-client.ts):
 * a read 2 s, a write 10 s (the lead's ruling D3, DASH-STORE-WORKER).
 *
 *   - A read past its time is refused, and read as not known: the AI control
 *     settings are answered as not read -- never as the switch off -- and a
 *     start, whose account and kill-switch reads cannot be made, is refused,
 *     never let through to the engine.
 *   - A write past its time is refused as not known to be written, and never
 *     sent again: once the disk answers it lands, once.
 *
 * On the event loop a held statement held every call, and the answers came
 * only after the hold. The store is held here as a stalled disk holds it, on
 * the store's own thread (tests/helpers/held-store.ts), for 12 s: past both
 * times. The person is in a process of their own.
 */

const HELD_MS = 12_000;
/** The times of D3: a read, a write. */
const READ_MS = 2_000;
const WRITE_MS = 10_000;
/** What a loaded runner may add to a refusal's own time. */
const SLACK_MS = 1_000;

let around: Around;
beforeAll(async () => {
  around = await aroundAHeldStore();
});
afterAll(async () => {
  await around.end();
});

describe("a store held 12 s by the disk", () => {
  it("the AI control settings are answered within 2 s as not read, never as the switch off; a start is refused within 2 s and never reaches the engine; a write is refused within 10 s as not known to be written, and lands once when the disk answers", async () => {
    const dash = await aDashboard("past-its-deadline");
    const { store } = around;
    const callsBefore = around.engineCalls.length;
    const heldBefore = store.held.length;
    try {
      const marker = `past-its-deadline-${Date.now()}`;
      store.holdFor(HELD_MS);
      const settings = around.send(dash.base, dash.cookie, { method: "GET", path: "/api/ai-control" });
      const start = around.send(dash.base, dash.cookie, {
        method: "POST", path: "/api/scans", body: { consent: true, clientId: dash.clientId, target: "https://offline.invalid/" },
      });
      await sleep(50);
      // And a write, made while the disk is stalled.
      const heldFrom = Date.now();
      const written = dash.storage.createActivityLog({ action: marker, entityType: "test", entityId: "deadline", details: null, userId: null })
        .then(() => ({ ok: true as const, at: Date.now() }), (cause: unknown) => ({ ok: false as const, at: Date.now(), cause }));

      const read = await answerOf(around, settings, HELD_MS + 10_000);
      console.log(`[past its deadline] the settings were answered ${read.status} after ${read.answeredAt! - read.sentAt} ms: ${JSON.stringify(read.body).slice(0, 160)}`);
      expect(read.answeredAt! - read.sentAt).toBeLessThan(READ_MS + SLACK_MS);
      // Not read: never the switch off, and said so in a plain sentence.
      expect(read.status).toBe(503);
      expect(read.body).toEqual({ message: "the store did not answer in time; nothing was read" });
      expect(read.body?.killSwitchEnabled).not.toBe(false);

      const started = await answerOf(around, start, HELD_MS + 10_000);
      console.log(`[past its deadline] the start was answered ${started.status} after ${started.answeredAt! - started.sentAt} ms`);
      expect(started.answeredAt! - started.sentAt).toBeLessThan(READ_MS + SLACK_MS);
      expect(started.status).not.toBe(201);
      expect(started.status).toBe(503);
      expect(started.body).toEqual({ message: "the store did not answer in time; nothing was read" });

      const write = await written;
      console.log(`[past its deadline] the write was refused after ${write.at - heldFrom} ms: ${write.ok ? "(answered)" : String((write.cause as Error).message)}`);
      expect(write.ok, "the write was not answered as written").toBe(false);
      expect(write.at - heldFrom).toBeLessThan(WRITE_MS + SLACK_MS);
      expect(String((write as { cause: Error }).cause.message)).toMatch(/not known to be written/);

      // The disk answers: the write lands, once -- it was never sent again.
      await until(() => Date.now(), () => Date.now() - heldFrom > HELD_MS, HELD_MS + 1_000);
      await until(() => Date.now(), () => store.held.length > heldBefore, 5_000);
      await sleep(200);
      const landed = (await dash.storage.getAllActivityLogs()).filter((one) => one.action === marker);
      expect(landed).toHaveLength(1);
      expect(around.engineCalls.slice(callsBefore).some((one) => one.line === "POST /api/scan")).toBe(false);
    } finally {
      store.holdFor(0);
      await close(dash);
    }
  }, 60_000);
});
