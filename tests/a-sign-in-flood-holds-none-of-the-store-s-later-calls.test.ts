import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import dc from "diagnostics_channel";
import type { IncomingMessage } from "http";
import { aDashboard, aroundAHeldStore, close, until, type Around } from "./helpers/a-dashboard-on-a-held-store";

/**
 * SAFETY: a sign-in waiting on its key derivation holds none of the store's
 * later calls.
 *
 * A sign-in's password check (SqliteStorage.validateUser: scrypt, about
 * 35 ms a key) runs in the store's worker thread (server/store-worker.ts).
 * The thread starts each call as it arrives and does not wait for one to
 * end before the next: a call awaiting scrypt awaits libuv's pool, not the
 * thread. So 20 sign-ins at once -- 20 derivations queued on the pool --
 * hold nothing the store answers after them: the kill switch's read of the
 * tests table, a read its stops wait out (server/store-protocol.ts
 * patiently), is answered within 100 ms of being sent, while the sign-ins are
 * still deriving. A thread that took calls one at a time would answer it only
 * once every derivation before it had ended.
 */

let around: Around;
beforeAll(async () => {
  around = await aroundAHeldStore();
});
afterAll(async () => {
  await around.end();
});

describe("20 sign-ins at once", () => {
  it("the kill switch's read of the tests table, sent while they are deriving, is answered within 100 ms", async () => {
    const runId = "a-sign-in-flood";
    const dash = await aDashboard(runId);
    let arrived = 0;
    const arrival = (message: unknown) => {
      const req = (message as { request: IncomingMessage }).request;
      if (req.method === "POST" && req.url === "/api/auth/login") arrived += 1;
    };
    dc.subscribe("http.server.request.start", arrival);
    // The kill switch's read as the app calls it: on the store client's prototype.
    const own = Object.getPrototypeOf(dash.storage) as { getAllTests: () => Promise<unknown> };
    const read = own.getAllTests;
    let sentAt: number | null = null;
    let answeredAt: number | null = null;
    try {
      // 20 names no account has: each check still derives a key (a dummy derivation, as a real one costs).
      const signIns = Array.from({ length: 20 }, (_unused, i) => fetch(`${dash.base}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: `nobody-${i}`, password: "not-anybody's-password-1" }), // pragma: allowlist secret
      }).then(() => Date.now()));
      await until(() => arrived, (n) => n >= 20, 5_000);
      expect(arrived).toBe(20);
      vi.spyOn(own, "getAllTests").mockImplementation(function (this: unknown) {
        const at = Date.now();
        sentAt ??= at;
        return (read.call(this) as Promise<unknown>).then((rows) => {
          if (at === sentAt) answeredAt = Date.now();
          return rows;
        });
      });
      const pressed = await fetch(`${dash.base}/api/ai-control`, {
        method: "PATCH", headers: { cookie: dash.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ killSwitchEnabled: true }),
      });
      expect(pressed.status).toBe(200);
      await until(() => answeredAt, (at) => at !== null, 10_000);
      const signedInAt = await Promise.all(signIns);
      const lastSignIn = Math.max(...signedInAt);
      console.log(`[a sign-in flood] the kill switch's tests read was answered ${answeredAt! - sentAt!} ms after it was sent; ` +
        `the last of the 20 sign-ins was answered ${lastSignIn - answeredAt!} ms after that`);
      expect(sentAt, "the kill switch read the tests table").not.toBeNull();
      // The flood was still deriving when the read was answered: the read did not wait for it.
      expect(lastSignIn, "the read was answered while the sign-ins were still deriving").toBeGreaterThan(answeredAt!);
      expect(answeredAt! - sentAt!).toBeLessThan(100);
    } finally {
      vi.restoreAllMocks();
      dc.unsubscribe("http.server.request.start", arrival);
      await fetch(`${dash.base}/api/ai-control`, {
        method: "PATCH", headers: { cookie: dash.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ killSwitchEnabled: false, systemStatus: "operational" }),
      });
      await close(dash);
    }
  }, 60_000);
});
