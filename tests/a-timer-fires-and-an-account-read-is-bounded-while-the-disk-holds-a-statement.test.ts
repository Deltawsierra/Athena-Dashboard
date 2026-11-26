import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aDashboard, answerOf, aroundAHeldStore, close, holdFromTheArrivalOf, until, type Around,
} from "./helpers/a-dashboard-on-a-held-store";

/**
 * SAFETY: while a stalled disk holds a store statement, this process's timers
 * still fire, so every bound a timer keeps holds -- the account read before a
 * retest's Stop is refused (auth.ts refreshAccount, ACCOUNT_REFRESH_MS = 250)
 * among them.
 *
 * On the event loop, a held statement held the loop: a 250 ms timer fired
 * after 3022 ms, and a non-admin's Stop of a retest it does not own, which
 * reads the account for at most 250 ms before it is refused from memory, was
 * refused after 3005 ms (DASH-STORE-OFF-THE-LOOP, fact 1.3 and option E). With
 * the store on its own thread (server/store-client.ts), the timer fires on
 * time, and memory decides at 250 ms.
 *
 * The store is held as a stalled disk holds it (tests/helpers/held-store.ts),
 * from the Stop's own arrival; the person is in a process of their own.
 */

const HELD_MS = 3_000;

let around: Around;
beforeAll(async () => {
  around = await aroundAHeldStore();
});
afterAll(async () => {
  await around.end();
});

describe("a statement held 3 s by the disk", () => {
  it("a 10 ms timer armed as the statement is held fires within 100 ms, and a non-admin's Stop of a retest it does not own is refused within 500 ms", async () => {
    const runId = "a-timer-fires";
    const dash = await aDashboard(runId);
    await dash.storage.createUser({ username: "operator1", password: "Operator-password-1234!", role: "user", mustChangePassword: false } as never); // pragma: allowlist secret
    const login = await fetch(`${dash.base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "operator1", password: "Operator-password-1234!" }), // pragma: allowlist secret
    });
    expect(login.status).toBe(200);
    const userCookie = login.headers.get("set-cookie")!.split(";")[0];
    const { store } = around;
    const heldBefore = store.held.length;
    const callsBefore = around.engineCalls.length;
    let firedAfter: number | null = null;
    store.onHeld = () => {
      const armed = Date.now();
      setTimeout(() => { firedAfter = Date.now() - armed; }, 10);
    };
    const stopWatching = holdFromTheArrivalOf(store, "POST", `/api/retests/${runId}/abort`, HELD_MS);
    try {
      const id = around.send(dash.base, userCookie, { method: "POST", path: `/api/retests/${runId}/abort` });
      const answer = await answerOf(around, id, HELD_MS + 15_000);
      await until(() => Date.now(), () => store.held.length > heldBefore, HELD_MS + 5_000);
      console.log(`[a timer while held] the 10 ms timer fired after ${firedAfter} ms; the non-admin's Stop was answered ${answer.status} after ${answer.answeredAt! - answer.sentAt} ms`);
      // The account read was held: a statement waited out (nearly) the whole hold.
      expect(Math.max(...store.held.slice(heldBefore).map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      expect(firedAfter, "the timer fired").not.toBeNull();
      expect(firedAfter!).toBeLessThan(100);
      // Refused from memory once the read ran out of its time: not an admin, not the retest's owner. Nothing was sent.
      expect(answer.status).toBe(403);
      expect(answer.answeredAt! - answer.sentAt).toBeLessThan(500);
      expect(around.engineCalls.slice(callsBefore).some((one) => one.line === `POST /api/scans/${runId}/abort`)).toBe(false);
    } finally {
      stopWatching();
      store.holdFor(0);
      store.onHeld = null;
      await close(dash);
    }
  }, 60_000);
});
