import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import { makeApp, signIn } from "./helpers";
import { controlPlaneStandIn, newServiceToken, type ControlPlaneStandIn, type Seen, type TokenFault } from "./helpers/control-plane-stand-in";

/**
 * SAFETY (#337): a stop never waits on, or fails with, a password sign-in.
 *
 * Every stop this server relays to the control plane went as the service
 * account, and needed its token first: obtained by signing in with a password
 * (/api/token/) on first use, after every restart, and every hour when it
 * expired. The backend throttles that sign-in (429), a changed password or a
 * locked account refuses it (401), a fault in the account table fails it
 * (500), and it can hang. Each held back or dropped the stop behind it: a
 * pause, a stand-down, a signature on one, a deployment paused.
 *
 * The backend takes a pre-shared failsafe service token on a stop instead
 * (athena-backend safety/service_token.py). With ATHENA_FAILSAFE_SERVICE_TOKEN
 * set, this server presents it on every stop and sends the stop AT ONCE. This
 * file presses each stop while the sign-in -- and the refresh, when there is a
 * token to refresh -- is refused with each of those answers, or hung, and
 * measures on the monotonic clock how soon the stop reached the control
 * plane's stop route, carrying the token:
 *
 *   - no token in hand: the first stops after start-up;
 *   - a token in hand the control plane has expired: every hour after that.
 *
 * The bound is STOP_BOUND_MS from the press to the stop's arrival. Before the
 * token, each of these stops ended in a 503 ("could not reach", "answered
 * 429") or waited out the sign-in's own deadline, and none reached the stop
 * route.
 */

/** A stop reaches the control plane's stop route within this many ms of the press. */
const STOP_BOUND_MS = 300;

const TOKEN = newServiceToken();
const FAULTS: TokenFault[] = [429, 500, 401, "hang"];

interface Timing {
  fault: string;
  tokenInHand: string;
  stop: string;
  ms: number | null;
  status: number;
}
const timings: Timing[] = [];

let plane: ControlPlaneStandIn | null = null;
let pending: Array<Promise<unknown>> = [];

afterEach(async () => {
  await plane?.close();
  await Promise.allSettled(pending);
  plane = null;
  pending = [];
  for (const name of ["ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD", "ATHENA_FAILSAFE_SERVICE_TOKEN"]) {
    delete process.env[name];
  }
});

afterAll(() => {
  // The measurements, for the record: every stop, under every fault.
  console.log("[stop timings] press -> arrival at the control plane's stop route, bound " + STOP_BOUND_MS + " ms\n" +
    timings.map((t) => `  sign-in ${String(t.fault).padEnd(4)} token in hand: ${t.tokenInHand.padEnd(7)} ${t.stop.padEnd(24)} ` +
      `${t.ms === null ? "never arrived" : `${t.ms.toFixed(1)} ms`} (answered ${t.status})`).join("\n"));
});

/**
 * The dashboard, its control plane, and a sign-in under way that is refused
 * with `fault` -- or hangs -- when the stops are pressed.
 */
async function boot(fault: TokenFault, tokenInHand: "none" | "expired") {
  plane = await controlPlaneStandIn({ serviceToken: TOKEN });
  process.env.ATHENA_FAILSAFE_URL = plane.url;
  process.env.ATHENA_FAILSAFE_USER = "svc-failsafe";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc-password";
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = TOKEN;
  vi.resetModules();
  const app = await makeApp();
  const failsafe = await import("../server/failsafe");
  // A sign-in that hangs is given up on after this long; the stops are measured long before.
  failsafe.failsafeTimeouts.callMs = 2_000;
  const admin = await signIn(app);
  if (tokenInHand === "expired") {
    // A token in hand in each client, obtained while the sign-in worked, which the control plane has since expired.
    expect((await admin.get("/api/failsafe/audit")).status).toBe(200);
    expect((await admin.get("/api/assurance/deployments")).status).toBe(200);
    plane.expireAccess();
  }
  plane.settings.signIn = fault;
  plane.settings.refresh = fault;
  const from = plane.seen.length;
  // Calls that are not stops need a token, so a renewal is under way when the stops are pressed.
  pending = [admin.get("/api/failsafe/audit").then((r) => r.status), admin.get("/api/assurance/deployments").then((r) => r.status)];
  const renewal = (one: Seen) => one.n > from && (one.path === "/api/token/" || one.path === "/api/token/refresh/");
  await plane.waitFor(renewal);
  return { admin, plane };
}

/** Press one stop; when, after the press, it reached the control plane's stop route, and with what. */
async function press(
  p: ControlPlaneStandIn, send: () => PromiseLike<{ status: number }>, reached: (one: Seen) => boolean,
): Promise<{ status: number; stop: Seen | undefined; ms: number | null }> {
  const from = p.seen.length;
  const pressed = performance.now();
  const answer = await send();
  const stop = p.seen.slice(from).find(reached);
  return { status: answer.status, stop, ms: stop ? stop.at - pressed : null };
}

describe.each([
  { label: "no token in hand (the first stops after start-up)", tokenInHand: "none" as const },
  { label: "a token in hand that the control plane has expired (every hour after)", tokenInHand: "expired" as const },
])("$label", ({ tokenInHand }) => {
  it.each(FAULTS)("the sign-in answering %s: a relayed pause, stand-down, a pause's signature and a deployment pause each reach the stop route with the service token at once", async (fault) => {
    const { admin, plane: p } = await boot(fault, tokenInHand);
    const deployment = randomUUID();
    const pauseToSign = p.command("pause");

    const stops = [
      {
        name: "pause (failsafe draft)", ok: 201,
        send: () => admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "engine-1", reason: "runaway" }),
        reached: (one: Seen) => one.method === "POST" && one.path === "/api/failsafe/commands/" && one.body.includes('"pause"'),
      },
      {
        name: "stand-down (failsafe)", ok: 201,
        send: () => admin.post("/api/failsafe/commands").send({ action: "stand_down", engineId: "engine-1", reason: "runaway" }),
        reached: (one: Seen) => one.method === "POST" && one.path === "/api/failsafe/commands/" && one.body.includes('"stand_down"'),
      },
      {
        name: "a pause's signature", ok: 200,
        send: () => admin.post(`/api/failsafe/commands/${pauseToSign}/signatures`).send({ keyId: "k1", sig: "abcd" }),
        reached: (one: Seen) => one.method === "POST" && one.path === `/api/failsafe/commands/${pauseToSign}/signatures/`,
      },
      {
        name: "deployment paused", ok: 200,
        send: () => admin.post(`/api/assurance/deployments/${deployment}/recompute`).send({ paused: true }),
        reached: (one: Seen) => one.method === "POST" && one.path === `/api/assurance/deployments/${deployment}/recompute/`,
      },
    ];

    // Every stop is pressed, and measured, before any is judged: one held back says nothing of the next.
    const pressed = [];
    for (const stop of stops) {
      const got = await press(p, stop.send, stop.reached);
      timings.push({ fault: String(fault), tokenInHand, stop: stop.name, ms: got.ms, status: got.status });
      pressed.push({ stop, got });
    }
    for (const { stop, got } of pressed) {
      expect(got.stop, `${stop.name} never reached the control plane's stop route (answered ${got.status})`).toBeDefined();
      expect(got.stop!.serviceToken).toBe(TOKEN);
      expect(got.stop!.by).toBe("service token");
      expect(got.ms!).toBeLessThanOrEqual(STOP_BOUND_MS);
      expect(got.status).toBe(stop.ok);
    }
    // The renewal the stops did not wait for is hanging still -- or was refused, and the
    // calls that are not stops, which do need it, answered 503 for want of a token.
    if (fault === "hang") expect(p.holding()).toBe(true);
    else expect(await Promise.all(pending)).toEqual([503, 503]);
  }, 60_000);
});
