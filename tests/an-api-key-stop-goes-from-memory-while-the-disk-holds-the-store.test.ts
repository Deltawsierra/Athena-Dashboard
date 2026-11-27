import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  aDashboard, answerOf, aroundAHeldStore, close, holdFromTheArrivalOf, reachOf, sleep, until, type Around, type Dashboard,
} from "./helpers/a-dashboard-on-a-held-store";

/**
 * SAFETY: a Stop presented with an API key reaches the engine at once while a
 * stalled disk holds the store.
 *
 * It was authorised as any request is: the key looked up, then its account --
 * two reads before the send, 3008 ms under a store held 3 s
 * (DASH-STORE-OFF-THE-LOOP, fact 1.3; the store's own thread does not remove
 * them). It is now authorised from memory (server/auth.ts apiKeyStopHolder):
 * every live key, by its secret's hash, and the account behind it, learnt as
 * the app starts and kept by the key routes. Only a stop: an entry another
 * dashboard's revoke left stale gains a stop, never a start or a read; a key
 * revoked here is forgotten at once.
 *
 * The store is held as a stalled disk holds it (tests/helpers/held-store.ts),
 * from the Stop's own arrival. The engine and the person are each in a
 * process of their own. The bounds are a Stop's: the engine within 250 ms, the
 * answer within 500 ms.
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

async function aKey(dash: { base: string }, cookie: string): Promise<{ id: string; secret: string }> {
  const made = await fetch(`${dash.base}/api/api-keys`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "automation" }),
  });
  expect(made.status).toBe(201);
  const body = await made.json();
  return { id: body.key.id as string, secret: body.secret as string };
}

/** Press `method path` with the key, no session, the store held HELD_MS from its arrival; when it reached the engine for `runIds`. */
async function pressHeld(dash: Dashboard, secret: string, method: string, path: string, body: unknown, runIds: string[]) {
  const { store } = around;
  const heldBefore = store.held.length;
  const callsBefore = around.engineCalls.length;
  const stopWatching = holdFromTheArrivalOf(store, method, path, HELD_MS);
  try {
    const id = around.send(dash.base, null, { method, path, body, cookie: null, extra: { "x-api-key": secret } });
    const answer = await answerOf(around, id, HELD_MS + 15_000);
    const reach = await reachOf(around, callsBefore, answer.sentAt, runIds);
    await until(() => Date.now(), () => store.held.length > heldBefore, HELD_MS + 5_000);
    console.log(`[api key] ${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")} reached the engine after ${reach.join(", ")} ms, ` +
      `answered ${answer.status} after ${answer.answeredAt! - answer.sentAt} ms`);
    return { answer, reach, held: store.held.slice(heldBefore) };
  } finally {
    stopWatching();
    store.holdFor(0);
  }
}

describe("a Stop presented with an API key, the store held 3 s by the disk from its arrival", () => {
  it("a key made here: the scan's Stop reaches the engine within 250 ms and is answered within 500 ms", async () => {
    const runId = "api-key-made-here";
    const dash = await aDashboard(runId);
    try {
      const { secret } = await aKey(dash, dash.cookie);
      const { answer, reach, held } = await pressHeld(dash, secret, "POST", `/api/scans/${dash.testId}/abort`, undefined, [`scan-of-${runId}`]);
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ stopped: true, runId: `scan-of-${runId}` });
      expect(Math.max(...held.map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      expect(reach[0], "the stop reached the engine").not.toBeNull();
      expect(reach[0]!).toBeLessThan(REACH_MS);
      expect(answer.answeredAt! - answer.sentAt).toBeLessThan(ANSWER_MS);
    } finally {
      await close(dash);
    }
  }, 60_000);

  it("a key another dashboard made before this one started, its account never signed in here: the kill switch pressed with it sends each stop it knows of in memory within 250 ms", async () => {
    // Another dashboard: an admin account for automation, signed in there, makes the key.
    const other = await aDashboard(null);
    await other.storage.createUser({ username: "automation", password: "Automation-password-1234!", role: "admin", mustChangePassword: false } as never); // pragma: allowlist secret
    const login = await fetch(`${other.base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "automation", password: "Automation-password-1234!" }), // pragma: allowlist secret
    });
    expect(login.status).toBe(200);
    const { secret } = await aKey(other, login.headers.get("set-cookie")!.split(";")[0]);
    await close(other);
    // This dashboard starts on that file.
    const runId = "api-key-learnt-at-start";
    const dash = await aDashboard(runId, other.dbPath);
    try {
      const { answer, reach, held } = await pressHeld(dash, secret, "PATCH", "/api/ai-control", { killSwitchEnabled: true }, [runId, `ks-${runId}`]);
      expect(answer.status).toBe(200);
      expect(Math.max(...held.map((one) => one.heldMs))).toBeGreaterThan(HELD_MS - 500);
      for (const ms of reach) {
        expect(ms, "the stop reached the engine").not.toBeNull();
        expect(ms!).toBeLessThan(REACH_MS);
      }
    } finally {
      await fetch(`${dash.base}/api/ai-control`, {
        method: "PATCH", headers: { cookie: dash.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ killSwitchEnabled: false, systemStatus: "operational" }),
      });
      await close(dash);
    }
  }, 60_000);
});

describe("only a live key, and only a stop", () => {
  it("a key revoked here: a Stop presented with it is refused at once, and never sent", async () => {
    const runId = "api-key-revoked-here";
    const dash = await aDashboard(runId);
    try {
      const { id, secret } = await aKey(dash, dash.cookie);
      const revoked = await fetch(`${dash.base}/api/api-keys/${id}`, { method: "DELETE", headers: { cookie: dash.cookie } });
      expect(revoked.status).toBe(200);
      const callsBefore = around.engineCalls.length;
      const stop = await fetch(`${dash.base}/api/scans/${dash.testId}/abort`, { method: "POST", headers: { "x-api-key": secret } });
      expect(stop.status).toBe(401);
      await sleep(200);
      expect(around.engineCalls.slice(callsBefore).some((one) => one.line === `POST /api/scans/scan-of-${runId}/abort`)).toBe(false);
    } finally {
      await close(dash);
    }
  }, 60_000);

  it("a key revoked on another dashboard, still held here: a Stop presented with it goes; a read and a start with it are refused, and the start never reaches the engine", async () => {
    const runId = "api-key-revoked-elsewhere";
    const dash = await aDashboard(runId);
    try {
      const { id, secret } = await aKey(dash, dash.cookie);
      const raw = new Database(dash.dbPath);
      try {
        raw.pragma("busy_timeout = 5000");
        raw.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
      } finally {
        raw.close();
      }
      const callsBefore = around.engineCalls.length;
      const stop = await fetch(`${dash.base}/api/scans/${dash.testId}/abort`, { method: "POST", headers: { "x-api-key": secret } });
      expect(stop.status).toBe(200);
      expect(await until(() => around.engineCalls.slice(callsBefore).some((one) => one.line === `POST /api/scans/scan-of-${runId}/abort`),
        (sent) => sent, 5_000), "the stale key's stop was sent").toBe(true);
      const read = await fetch(`${dash.base}/api/tests`, { headers: { "x-api-key": secret } });
      expect(read.status).toBe(401);
      const start = await fetch(`${dash.base}/api/scans`, {
        method: "POST", headers: { "x-api-key": secret, "content-type": "application/json" },
        body: JSON.stringify({ consent: true, clientId: dash.clientId, target: "https://offline.invalid/" }),
      });
      expect(start.status).toBe(401);
      await sleep(200);
      expect(around.engineCalls.slice(callsBefore).some((one) => one.line === "POST /api/scan")).toBe(false);
    } finally {
      await close(dash);
    }
  }, 60_000);
});
