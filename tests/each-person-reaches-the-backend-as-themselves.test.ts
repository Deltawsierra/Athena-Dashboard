import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { Express } from "express";

import { makeApp, signIn } from "./helpers";
import { TEST_ADMIN_PASSWORD } from "./test-admin";
import { newServiceToken } from "./helpers/control-plane-stand-in";
import { tenantBackendStandIn, type TenantBackendStandIn, type TenantSeen } from "./helpers/tenant-backend-stand-in";

/**
 * T6 (the owner's decision 8): the dashboard reaches Athena-Backend as each
 * signed-in person, not as one shared service account.
 *
 * The finding: every read went as ONE service account (analyst or admin, which
 * sees every tenant), and any deployment uuid a signed-in person named was
 * forwarded -- so one dashboard user read another tenant's reports, events and
 * ROI by uuid. Here the backend is a stand-in that scopes by WHO asks, as the
 * backend's `visible_deployments` does (tests/helpers/tenant-backend-stand-in.ts):
 * alice owns deployment A, bob owns B, both are viewers there; the admin is an
 * admin; svc-failsafe is the stop credential.
 *
 *   - A cross-tenant read through the dashboard is refused (the backend's 404,
 *     shown), and the same read as the right person is served.
 *   - No request leaves the dashboard with the service account on a read path,
 *     and none falls back to it when a person has no backend sign-in (nor for an
 *     API key: nothing is sent for one at all).
 *   - SAFETY: a person's stop still lands while their own sign-in is stale,
 *     refused or hung: every stop goes as the stop credential, exactly as before.
 *   - A person's token is renewed by their refresh token, once for every request
 *     refused together; a refused refresh ends their sign-in (no password, no
 *     service account), and they sign in to the backend again.
 *   - Signing out revokes their refresh token at the backend, as do signing in
 *     again and an admin deactivating the account; signing out never waits on it.
 *   - No token ever reaches the browser: it holds only the httpOnly session cookie.
 */

const ALICE_PASSWORD = "tenant-one-secret-7"; // pragma: allowlist secret
const BOB_PASSWORD = "tenant-two-secret-8"; // pragma: allowlist secret
const CAROL_PASSWORD = "tenant-three-secret-9"; // pragma: allowlist secret
const CAROL_BACKEND_PASSWORD = "carols-other-password-0"; // pragma: allowlist secret
const SERVICE = "svc-failsafe";
const SERVICE_PASSWORD = "svc-password-for-stops"; // pragma: allowlist secret
const ENV = ["ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD", "ATHENA_FAILSAFE_SERVICE_TOKEN"];

let backend: TenantBackendStandIn | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await (await import("../server/person-credential"))._revocationsSettled();
  await backend?.close();
  backend = null;
  for (const name of ENV) delete process.env[name];
});

type Agent = ReturnType<typeof request.agent>;

interface World {
  app: Express;
  backend: TenantBackendStandIn;
  admin: Agent;
  alice: Agent;
  bob: Agent;
  /** Signed in to this console; refused by the backend (its password there is another). */
  carol: Agent;
  ids: Record<"alice" | "bob" | "carol", string>;
  A: string;
  B: string;
}

/**
 * The dashboard and a backend that scopes by who asks, every person signed in to the dashboard.
 * `serviceToken` is the dashboard's ATHENA_FAILSAFE_SERVICE_TOKEN; `backendServiceToken` the
 * backend's own (the same unless a test says otherwise).
 */
async function world({
  serviceToken = newServiceToken() as string | null,
  backendServiceToken = undefined as string | null | undefined,
} = {}): Promise<World> {
  const A = randomUUID();
  const B = randomUUID();
  backend = await tenantBackendStandIn({
    accounts: {
      admin: { password: TEST_ADMIN_PASSWORD, role: "admin" },
      alice: { password: ALICE_PASSWORD, role: "viewer" },
      bob: { password: BOB_PASSWORD, role: "viewer" },
      carol: { password: CAROL_BACKEND_PASSWORD, role: "viewer" },
      [SERVICE]: { password: SERVICE_PASSWORD, role: "admin" },
    },
    deployments: { [A]: "alice", [B]: "bob" },
    serviceToken: backendServiceToken === undefined ? serviceToken : backendServiceToken,
    serviceUser: SERVICE,
  });
  process.env.ATHENA_FAILSAFE_URL = backend.url;
  process.env.ATHENA_FAILSAFE_USER = SERVICE;
  process.env.ATHENA_FAILSAFE_PASSWORD = SERVICE_PASSWORD;
  if (serviceToken !== null) process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = serviceToken;
  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const app = await makeApp();
  const admin = await signIn(app);
  const ids = {} as World["ids"];
  for (const [username, password] of [["alice", ALICE_PASSWORD], ["bob", BOB_PASSWORD], ["carol", CAROL_PASSWORD]] as const) {
    const made = await admin.post("/api/users").send({ username, password, role: "user", email: `${username}@tenant.test` });
    expect(made.status).toBe(201);
    ids[username] = made.body.id as string;
  }
  return {
    app, backend, admin, ids, A, B,
    alice: await signIn(app, "alice", ALICE_PASSWORD),
    bob: await signIn(app, "bob", BOB_PASSWORD),
    carol: await signIn(app, "carol", CAROL_PASSWORD),
  };
}

/** What the backend received, other than sign-ins, refreshes and revocations. */
function operatorRequests(seen: TenantSeen[]): TenantSeen[] {
  return seen.filter((one) => !one.path.startsWith("/api/token/"));
}

const said = (one: TenantSeen) => `${one.method} ${one.path} as ${one.account ?? "nobody"} (${one.by ?? "unauthenticated"}) -> ${one.status}`;

/** The reads the views make of one deployment: an assurance read and the economics reads. */
function readsOf(deployment: string, scenario: string): string[] {
  return [
    `/api/assurance/deployments/${deployment}/capabilities`,
    `/api/assurance/deployments/${deployment}/receipt`,
    `/api/economics/report?deployment=${deployment}&scenario=${scenario}`,
    `/api/economics/events?deployment=${deployment}&scenario=${scenario}`,
    `/api/economics/roi?deployment=${deployment}&scenario=${scenario}`,
    `/api/economics/scenarios?deployment=${deployment}`,
  ];
}

describe("each person reads Athena-Backend as themselves: tenancy is the backend's, applied to them", () => {
  it("a cross-tenant read through the dashboard is refused -- the backend's 404, shown -- and the same read as the right person is served", async () => {
    const w = await world();
    const scenario = randomUUID();

    // Bob names Alice's deployment, by every read the views make: each is refused.
    for (const url of readsOf(w.A, scenario)) {
      const res = await w.bob.get(url);
      expect(res.status, url).toBe(404);
      expect(["not_found", "not_served"], url).toContain(res.body.code);
      expect(res.text, url).toMatch(/No Deployment matches the given query/);
      expect(res.text, url).not.toMatch(/read_by|mythos\.economics/);
    }
    // Alice reads her own: every one served, and read as her.
    for (const url of readsOf(w.A, scenario)) {
      expect((await w.alice.get(url)).status, url).toBe(200);
    }
    const report = await w.alice.get(`/api/economics/report?deployment=${w.A}&scenario=${scenario}`);
    expect(JSON.parse(report.text)).toMatchObject({ deployment: w.A, read_by: "alice" });

    // At the backend: each of Bob's reads of A was made as Bob and answered 404; each of Alice's, as Alice.
    const ofA = operatorRequests(w.backend.seen).filter((one) => one.path.includes(w.A));
    expect(ofA.filter((one) => one.account === "bob").length).toBe(6);
    expect(ofA.filter((one) => one.account === "bob" && one.status !== 404).map(said)).toEqual([]);
    expect(ofA.filter((one) => one.account === "alice" && one.status !== 200).map(said)).toEqual([]);
    expect(ofA.filter((one) => one.account !== "alice" && one.account !== "bob").map(said)).toEqual([]);

    // The deployment list each sees is their own; the admin, an admin there, sees both.
    expect(((await w.bob.get("/api/assurance/deployments")).body as Array<{ uuid: string }>).map((d) => d.uuid)).toEqual([w.B]);
    expect(((await w.alice.get("/api/assurance/deployments")).body as Array<{ uuid: string }>).map((d) => d.uuid)).toEqual([w.A]);
    expect(((await w.admin.get("/api/assurance/deployments")).body as Array<{ uuid: string }>).map((d) => d.uuid).sort())
      .toEqual([w.A, w.B].sort());
    // And Bob reads his own.
    expect((await w.bob.get(`/api/assurance/deployments/${w.B}/capabilities`)).status).toBe(200);
  }, 60_000);

  it("a read the backend refuses the person's role is the backend's 403, shown; the admin's is served", async () => {
    const w = await world();
    const refused = await w.alice.get(`/api/assurance/deployments/${w.A}/business-impact`);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("backend_refused");
    expect(refused.body.error).toMatch(/You do not have permission/);
    expect((await w.admin.get(`/api/assurance/deployments/${w.A}/business-impact`)).status).toBe(200);
  }, 60_000);

  it("no request leaves the dashboard with the service account on a read path, and none falls back to it: not for a person the backend refused, not for an API key", async () => {
    const w = await world();
    const scenario = randomUUID();
    const reads = [
      "/api/assurance/status", "/api/assurance/deployments", "/api/assurance/findings", "/api/assurance/unknowns",
      ...readsOf(w.A, scenario), ...readsOf(w.B, scenario),
    ];
    for (const agent of [w.admin, w.alice, w.bob]) {
      for (const url of reads) await agent.get(url);
    }
    // The failsafe console's audit trail (an admin's read here; not a stop).
    expect((await w.admin.get("/api/failsafe/audit")).status).toBe(200);
    const operator = operatorRequests(w.backend.seen);
    expect(operator.length).toBeGreaterThan(3 * reads.length - 3);
    // Every one went as the person who asked: never the service account, never its token.
    expect(operator.filter((one) => one.account === SERVICE || one.serviceToken !== undefined || one.by !== "bearer").map(said)).toEqual([]);
    expect(new Set(operator.map((one) => one.account))).toEqual(new Set(["admin", "alice", "bob"]));
    // The service account never even signed in: nothing on a read path needed it.
    expect(w.backend.seen.filter((one) => one.account === SERVICE).map(said)).toEqual([]);

    // Carol's password at the backend is another: her sign-in there was refused, so
    // nothing is sent for her -- not as the service account, not at all -- and she is told.
    await w.backend.waitFor((one) => one.path === "/api/token/" && one.account === "carol");
    const before = w.backend.seen.length;
    const status = await w.carol.get("/api/assurance/status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ authorized: false, code: "backend_sign_in_required" });
    expect(status.body.detail).toMatch(/did not accept your username and password/);
    for (const url of readsOf(w.A, scenario).concat(readsOf(w.B, scenario), ["/api/assurance/deployments"])) {
      const res = await w.carol.get(url);
      expect(res.status, url).toBe(503);
      expect(res.body.code, url).toBe("backend_sign_in_required");
    }
    // An API key carries no person's sign-in: nothing is sent for it either.
    const key = await w.admin.post("/api/api-keys").send({ name: "automation" });
    expect(key.status).toBe(201);
    const byKey = await request(w.app).get("/api/assurance/deployments").set("X-API-Key", key.body.secret as string);
    expect(byKey.status).toBe(503);
    expect(byKey.body.code).toBe("backend_sign_in_required");
    const byKeyEconomics = await request(w.app).get(`/api/economics/scenarios?deployment=${w.A}`).set("X-API-Key", key.body.secret as string);
    expect(byKeyEconomics.status).toBe(503);
    expect(byKeyEconomics.body.code).toBe("backend_sign_in_required");
    expect(w.backend.seen.slice(before).map(said)).toEqual([]);
  }, 60_000);

  it("a person signs in to the backend with their password there: a wrong one is refused and nothing is held; the right one is taken; never from an API key", async () => {
    const w = await world();
    await w.backend.waitFor((one) => one.path === "/api/token/" && one.account === "carol");
    const wrong = await w.carol.post("/api/auth/backend-sign-in").send({ password: "not-the-password-1" }); // pragma: allowlist secret
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("backend_sign_in_required");
    expect((await w.carol.get(`/api/assurance/deployments/${w.A}/capabilities`)).status).toBe(503);
    const right = await w.carol.post("/api/auth/backend-sign-in").send({ password: CAROL_BACKEND_PASSWORD });
    expect(right.status).toBe(200);
    expect(right.body.backend).toMatchObject({ state: "signed_in", username: "carol" });
    // Carol owns nothing: as herself she is refused A, and the list is empty.
    expect((await w.carol.get(`/api/assurance/deployments/${w.A}/capabilities`)).status).toBe(404);
    expect((await w.carol.get("/api/assurance/deployments")).body).toEqual([]);
    expect(JSON.stringify(right.body)).not.toMatch(/access-|refresh-/);
    const key = await w.admin.post("/api/api-keys").send({ name: "automation" });
    const byKey = await request(w.app).post("/api/auth/backend-sign-in").set("X-API-Key", key.body.secret as string)
      .send({ password: TEST_ADMIN_PASSWORD });
    expect(byKey.status).toBe(403);
  }, 60_000);
});

describe("SAFETY: a person's stop lands whatever state their own sign-in is in", () => {
  it.each([
    ["with the failsafe service token", "taken"],
    ["without it (the stops go on the service account's own sign-in, as before)", "none"],
    ["with a service token the backend does not take (each stop is refused once, then goes on the service account's sign-in, as before)", "refused"],
  ] as const)("%s: their sign-in stale and its refresh refused, every stop still goes, as the stop credential", async (_how, token) => {
    const w = await world({
      serviceToken: token === "none" ? null : newServiceToken(),
      backendServiceToken: token === "refused" ? newServiceToken() : undefined,
    });
    const withToken = token === "taken";
    expect((await w.admin.get(`/api/assurance/deployments/${w.A}/capabilities`)).status).toBe(200);
    // The admin's own sign-in goes stale: its access token refused, its refresh refused.
    w.backend.expireAccessOf("admin");
    w.backend.refuseRefreshOf("admin");
    const read = await w.admin.get(`/api/assurance/deployments/${w.A}/capabilities`);
    expect(read.status).toBe(503);
    expect(read.body.code).toBe("backend_sign_in_required");

    const from = w.backend.seen.length;
    expect((await w.admin.post(`/api/assurance/deployments/${w.A}/recompute`).send({ paused: true })).status).toBe(200);
    expect((await w.admin.post(`/api/assurance/claims/${randomUUID()}/transition`).send({ toStatus: "revoked" })).status).toBe(200);
    expect((await w.admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "engine-1", reason: "a stale session's stop" })).status).toBe(201);
    expect((await w.admin.get("/api/failsafe/state")).status).toBe(200);

    const sent = operatorRequests(w.backend.seen.slice(from));
    // A token the backend does not take: each stop is refused once (401), then sent again on the service account's token.
    const stops = token === "refused" ? sent.filter((one) => one.status !== 401) : sent;
    if (token === "refused") expect(sent.filter((one) => one.status === 401).length).toBeGreaterThanOrEqual(1);
    expect(stops.length).toBe(4);
    expect(stops.filter((one) => !one.stop || one.status >= 300 || one.account !== SERVICE).map(said)).toEqual([]);
    expect(stops.filter((one) => one.by !== (withToken ? "service token" : "bearer")).map(said)).toEqual([]);
    // Nothing on the stops' path asked for the person's sign-in.
    expect(w.backend.seen.slice(from).filter((one) => one.account === "admin").map(said)).toEqual([]);
  }, 60_000);

  it("while the backend holds the person's own sign-in unanswered, the sign-in here is answered and a stop goes and is answered", async () => {
    const w = await world();
    w.backend.hangSignInOf("admin");
    // A new session for the admin: its backend sign-in is held, and this sign-in is answered regardless.
    const again = await signIn(w.app);
    await w.backend.waitFor((one) => one.path === "/api/token/" && one.account === "admin" && one.status === 0);
    const pause = await again.post(`/api/assurance/deployments/${w.A}/recompute`).send({ paused: true });
    expect(pause.status).toBe(200);
    const draft = await again.post("/api/failsafe/commands").send({ action: "stand_down", engineId: "engine-1", reason: "held sign-in" });
    expect(draft.status).toBe(201);
    // The person's sign-in is still held: neither stop waited on it.
    expect(w.backend.holding()).toBe(true);
  }, 60_000);
});

describe("the person's sign-in: renewed by their refresh token, revoked when the session ends, never in the browser", () => {
  it("an expired token is renewed once for every request refused together, with the refresh token the last renewal answered; a refused refresh ends the sign-in -- no password, no service account -- and the person signs in again", async () => {
    const w = await world();
    const read = `/api/assurance/deployments/${w.A}/capabilities`;
    expect((await w.alice.get(read)).status).toBe(200);
    const refreshes = () => w.backend.seen.filter((one) => one.path === "/api/token/refresh/" && one.account === "alice");

    w.backend.expireAccessOf("alice");
    const together = await Promise.all([1, 2, 3, 4].map(() => w.alice.get(read)));
    expect(together.map((one) => one.status)).toEqual([200, 200, 200, 200]);
    expect(refreshes().length).toBe(1);
    expect(JSON.parse(refreshes()[0].body)).toEqual({ refresh: w.backend.refreshIssuedTo("alice")[0] });

    w.backend.expireAccessOf("alice");
    expect((await w.alice.get(read)).status).toBe(200);
    expect(refreshes().length).toBe(2);
    expect(JSON.parse(refreshes()[1].body)).toEqual({ refresh: w.backend.refreshIssuedTo("alice")[1] });

    // The refresh is refused: the sign-in has ended.
    w.backend.expireAccessOf("alice");
    w.backend.refuseRefreshOf("alice");
    const ended = await w.alice.get(read);
    expect(ended.status).toBe(503);
    expect(ended.body.code).toBe("backend_sign_in_required");
    expect(ended.body.error).toMatch(/sign in to (it|Athena-Backend) again/);
    // No password was sent again (only the one sign-in), and nothing went as the service account.
    expect(w.backend.seen.filter((one) => one.path === "/api/token/" && one.account === "alice").length).toBe(1);
    expect(w.backend.seen.filter((one) => one.account === SERVICE).map(said)).toEqual([]);
    // Alice signs in to the backend again, and reads.
    expect((await w.alice.post("/api/auth/backend-sign-in").send({ password: ALICE_PASSWORD })).status).toBe(200);
    expect((await w.alice.get(read)).status).toBe(200);
  }, 60_000);

  it("two renewals asked for in the same moment spend the refresh token once, and both get the new access token", async () => {
    const w = await world();
    const persons = await import("../server/person-credential");
    // A session of Alice's held by the module itself, so both renewals start in the same tick.
    const signedIn = await persons.signInPerson("t6-same-moment", "alice", ALICE_PASSWORD);
    expect(signedIn.state).toBe("signed_in");
    const stale = await persons.runAsPerson("t6-same-moment", () => persons.personAccessToken());
    w.backend.expireAccessOf("alice");
    const renewed = await persons.runAsPerson("t6-same-moment", () =>
      Promise.all([persons.renewPersonToken(stale), persons.renewPersonToken(stale), persons.renewPersonToken(stale)]));
    const refreshes = w.backend.seen.filter((one) => one.path === "/api/token/refresh/" && one.account === "alice");
    expect(refreshes.length).toBe(1);
    expect(refreshes[0].status).toBe(200);
    expect(new Set(renewed).size).toBe(1);
    expect(renewed[0]).not.toBe(stale);
    persons.forgetPerson("t6-same-moment");
  }, 60_000);

  it("signing out revokes the person's refresh token at the backend; so do signing in again and an admin deactivating the account", async () => {
    const w = await world();
    const persons = await import("../server/person-credential");
    for (const agent of [w.alice, w.bob]) expect((await agent.get("/api/assurance/deployments")).status).toBe(200);

    // Signing out.
    const alices = w.backend.refreshIssuedTo("alice")[0];
    expect(w.backend.refreshTaken(alices)).toBe(true);
    expect((await w.alice.post("/api/auth/logout")).status).toBe(200);
    await persons._revocationsSettled();
    expect(w.backend.revoked).toContain(alices);
    expect(w.backend.refreshTaken(alices)).toBe(false);
    expect((await w.alice.get("/api/assurance/deployments")).status).toBe(401);

    // Signing in again on the same browser: the session it replaced is revoked, and the new one reads.
    const bobs = w.backend.refreshIssuedTo("bob")[0];
    expect((await w.bob.post("/api/auth/login").send({ username: "bob", password: BOB_PASSWORD })).status).toBe(200);
    await persons._revocationsSettled();
    expect(w.backend.revoked).toContain(bobs);
    expect((await w.bob.get("/api/assurance/deployments")).status).toBe(200);

    // An admin deactivates Bob: his live session ends, and its token is revoked.
    await persons._revocationsSettled();
    const bobsNow = w.backend.refreshIssuedTo("bob").at(-1)!;
    expect(w.backend.refreshTaken(bobsNow)).toBe(true);
    expect((await w.admin.patch(`/api/users/${w.ids.bob}`).send({ isActive: false })).status).toBe(200);
    await w.backend.waitFor((one) => one.path === "/api/token/revoke/" && JSON.parse(one.body).refresh === bobsNow);
    expect(w.backend.refreshTaken(bobsNow)).toBe(false);
  }, 60_000);

  it("signing out never waits on the backend: with the backend gone, it is answered, and the session is ended", async () => {
    const w = await world();
    expect((await w.alice.get("/api/assurance/deployments")).status).toBe(200);
    await w.backend.close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await w.alice.post("/api/auth/logout")).status).toBe(200);
    expect((await w.alice.get("/api/auth/check")).body).toEqual({ authenticated: false });
    await (await import("../server/person-credential"))._revocationsSettled();
    expect(warn.mock.calls.some((one) => /could not be revoked/.test(String(one[0])))).toBe(true);
  }, 60_000);

  it("no token reaches the browser: the only thing it holds is the httpOnly session cookie", async () => {
    const w = await world();
    const login = await request(w.app).post("/api/auth/login").send({ username: "alice", password: ALICE_PASSWORD });
    expect(login.status).toBe(200);
    const cookies = login.headers["set-cookie"] as unknown as string[];
    expect(cookies.length).toBe(1);
    expect(cookies[0]).toMatch(/^athena\.sid=/);
    expect(cookies[0]).toMatch(/HttpOnly/i);
    const cookie = cookies[0].split(";")[0];
    const answers = [login];
    for (const url of ["/api/auth/check", "/api/assurance/status", "/api/assurance/deployments", ...readsOf(w.A, randomUUID())]) {
      answers.push(await request(w.app).get(url).set("Cookie", cookie));
    }
    answers.push(await request(w.app).post("/api/auth/backend-sign-in").set("Cookie", cookie).send({ password: ALICE_PASSWORD }));
    answers.push(await request(w.app).post("/api/auth/logout").set("Cookie", cookie));
    const tokens = [
      ...w.backend.accessIssuedTo("alice"), ...w.backend.refreshIssuedTo("alice"),
      ...w.backend.accessIssuedTo("admin"), ...w.backend.refreshIssuedTo("admin"),
    ];
    expect(w.backend.accessIssuedTo("alice").length).toBeGreaterThanOrEqual(2);
    const texts = answers.map((one) => `${one.text ?? ""} ${JSON.stringify(one.headers)}`);
    expect(texts.filter((text) => tokens.some((token) => text.includes(token)))).toEqual([]);
    expect(cookies.filter((one) => tokens.some((token) => one.includes(token)))).toEqual([]);
  }, 60_000);
});
