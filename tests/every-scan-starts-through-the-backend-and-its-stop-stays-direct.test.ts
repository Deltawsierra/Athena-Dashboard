import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import request from "supertest";

import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

/**
 * Every person-initiated scan starts through Athena-Backend (the Option 1
 * hybrid, owner decisions 2, 3, 7, 10 and 11), and its live view and its Stop
 * stay direct to the engine:
 *
 *   - POST /api/scans sends the engine NO launch of its own: the backend does,
 *     under the client's engagement, and this dashboard records the backend's
 *     scan id beside the run the backend named. The press's key goes to the
 *     backend as Idempotency-Key; a press sent again replays the backend's
 *     answer -- one backend scan, one engine run, one row;
 *   - the client's engagement is created as the person on the first launch,
 *     running, with every host of the client's sites and the client's testing
 *     window (90 days from then when none was set, recorded on the client);
 *     widened by PATCH when a site was added; never narrowed; and a deleted
 *     client's engagement is marked completed, never DELETEd;
 *   - consent absent is refused before anything reaches the backend, in the
 *     backend's own words; the recipient's e-mail goes only when the person
 *     opted in;
 *   - a person whose backend account is not an admin's is refused, and no
 *     backend scan is created;
 *   - the first direct read, at once: a 404 marks the row `stop: "backend"` --
 *     this dashboard's engine key cannot see the run -- so no direct Stop is
 *     offered and the page names the backend's Stop and the failsafes;
 *   - a launch the backend did not answer in time is said to be of unknown
 *     outcome, and the row the backend made is adopted from its list when the
 *     backend already named the run; a press re-sent with its key replays;
 *   - with no engine configured here, nothing is sent anywhere: refused as before.
 *
 * The stand-in backend (tests/helpers/hybrid-backend-stand-in.ts) launches on
 * this test's own engine stub, as the real one launches with its own key, so
 * every Stop below still reaches that stub -- with the backend's key, never the
 * dashboard's.
 */

const TOKEN = "d".repeat(64);

/** An engine whose runs stay running until stopped; `tenantBound` makes every run read 404, as a run another tenant's key started does. */
function stubEngine() {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown>; key: string | null }> = [];
  const running = new Map<string, string>();
  const control = { tenantBound: false, launchDelayMs: 0, readFails: false };
  let next = 0;
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = req.url ?? "";
      const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null;
      calls.push({ method: req.method ?? "GET", url, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, key });
      if (url === "/health") return json(res, 200, { status: "ok" });
      if (url === "/api/scans/active") {
        return json(res, 200, { active: Array.from(running, ([run_id, target]) => ({ run_id, target, kind: "scan", state: "running" })) });
      }
      const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
      if (abort) {
        running.delete(abort[1]);
        return json(res, 200, { run_id: abort[1], state: "aborting" });
      }
      if (req.method === "GET" && url.startsWith("/api/scans/")) {
        const id = url.split("/")[3];
        // The engine scopes a run's read to the key that asks: the backend's key sees its run; the dashboard's does not.
        if (control.tenantBound && req.headers["x-api-key"] === "dashboard-key") return json(res, 404, { detail: "No such scan run" });
        if (control.readFails && req.headers["x-api-key"] === "dashboard-key") return json(res, 500, { detail: "database is locked" });
        return json(res, 200, { run_id: id, state: running.has(id) ? "running" : "aborted", done: !running.has(id), result: { results: [] } });
      }
      if (req.method === "POST" && url === "/api/scan") {
        next += 1;
        const id = `run-${next}`;
        running.set(id, String((JSON.parse(raw || "{}") as { target?: string }).target ?? ""));
        const reply = () => json(res, 202, { run_id: id, state: "running" });
        if (control.launchDelayMs > 0) setTimeout(reply, control.launchDelayMs);
        else reply();
        return;
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  return {
    server, calls, running, control,
    launches: () => calls.filter((one) => one.method === "POST" && one.url === "/api/scan"),
    reads: () => calls.filter((one) => one.method === "GET" && /^\/api\/scans\/[^/]+$/.test(one.url) && one.url !== "/api/scans/active"),
    aborts: () => calls.filter((one) => one.url.endsWith("/abort")),
  };
}

let engine: ReturnType<typeof stubEngine>;
let hybrid: HybridBackendStandIn;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let launchTimeouts: typeof import("../server/backend-scans").launchTimeouts;
let storage: typeof import("../server/storage-unified").storage;
let clientCount = 0;

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  const engineUrl = `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_URL = engineUrl;
  process.env.ATHENA_ENGINE_KEY = "dashboard-key";
  hybrid = await hybridBackendStandIn({ engine: { url: engineUrl, key: "backend-key" }, serviceToken: TOKEN });
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = TOKEN;
  vi.resetModules();
  app = await makeApp();
  admin = await signIn(app);
  await signInToBackend(admin);
  launchTimeouts = (await import("../server/backend-scans")).launchTimeouts;
  storage = (await import("../server/storage-unified")).storage;
});

afterEach(() => {
  engine.calls.length = 0;
  // Every run of a case ends with it, so Max Concurrent Tests (counted from the engine's live list) never refuses the next.
  engine.running.clear();
  engine.control.tenantBound = false;
  engine.control.readFails = false;
  engine.control.launchDelayMs = 0;
  hybrid.seen.length = 0;
  hybrid.controls.answerDelayMs = 0;
  hybrid.releaseLaunches();
  hybrid.setRole("admin", "admin");
  launchTimeouts.launchMs = 25_000;
});

afterAll(async () => {
  for (const name of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_SERVICE_TOKEN"]) delete process.env[name];
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
  await hybrid.close();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
});

async function aClient(hosts: string[] = ["acme.example"]) {
  clientCount += 1;
  const client = await admin.post("/api/clients").send({ name: `Client ${clientCount}`, company: `Company ${clientCount}`, email: `c${clientCount}@x.test` });
  const sites: string[] = [];
  for (const host of hosts) {
    sites.push((await admin.post("/api/sites").send({ clientId: client.body.id, name: host, url: `https://${host}` })).body.id);
  }
  return { clientId: client.body.id as string, sites };
}

const start = (body: Record<string, unknown>, key?: string) => {
  const request = admin.post("/api/scans");
  return (key ? request.set("Idempotency-Key", key) : request).send(body);
};

describe("a scan starts through the backend", () => {
  it("creates a backend scan, records its id beside the run the backend named, forwards the press key, and sends the engine no launch of its own", async () => {
    const { clientId } = await aClient();
    const started = await start({ clientId, target: "https://acme.example/", consent: true }, "press-1");
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.runId).toMatch(/^run-/);
    expect(started.body.test.status).toBe("running");
    expect(started.body.test.findings).toMatchObject({ runId: started.body.runId, target: "https://acme.example/", results: [] });
    const scanId = started.body.test.findings.backendScanId as string;
    expect(hybrid.scans.has(scanId), "the backend holds the scan").toBe(true);
    expect(started.body.test.findings.backendEngagementId).toBe(hybrid.scans.get(scanId)!.engagement);
    expect(started.body.backend).toMatchObject({ scanId, engagementId: hybrid.scans.get(scanId)!.engagement, directRead: { ok: true, state: "running" } });
    expect(started.body.stop).toBeUndefined();

    // The backend was asked as the person, with the press's key and consent; the engine was asked by the backend alone.
    const [launch] = hybrid.launches();
    expect(launch.account).toBe("admin");
    expect(launch.idempotencyKey).toMatch(/^athena-dashboard:[0-9a-f]{64}$/);
    expect(launch.json).toMatchObject({ url: "https://acme.example/", consent: true, wait_seconds: 0, engagement_id: hybrid.scans.get(scanId)!.engagement });
    expect(launch.json).not.toHaveProperty("recipient_email");
    const engineLaunches = engine.launches();
    expect(engineLaunches).toHaveLength(1);
    // The backend's launch carries the scan's own key and the engagement's scope; a launch
    // from this dashboard would carry its press key and the client id as engagement_ref.
    expect(engineLaunches[0].key).toBe(scanId);
    expect(engineLaunches[0].body.engagement_ref).toBe(`athena-backend:engagement:${hybrid.scans.get(scanId)!.engagement}`);
    expect(engineLaunches.some((one) => one.body.engagement_ref === clientId || String(one.key ?? "").startsWith("athena-dashboard:")),
      "the dashboard sent the engine a launch of its own").toBe(false);
    // The first direct read, by the dashboard's own key, happened at once.
    expect(engine.reads().map((one) => one.url)).toContain(`/api/scans/${started.body.runId}`);

    // The Stop stays direct: the engine's abort, answered before anything else.
    const stopped = await admin.post(`/api/scans/${started.body.test.id}/abort`);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ stopped: true, runId: started.body.runId });
    expect(engine.aborts().map((one) => one.url)).toEqual([`/api/scans/${started.body.runId}/abort`]);
  });

  it("a press sent again with its key replays the backend's answer: one backend scan, one engine run, one row", async () => {
    const { clientId } = await aClient();
    const first = await start({ clientId, target: "https://acme.example/", consent: true }, "press-2");
    expect(first.status).toBe(201);
    const again = await start({ clientId, target: "https://acme.example/", consent: true }, "press-2");
    expect(again.status).toBe(201);
    expect(again.body.replayed).toBe(true);
    expect(again.body.test.id).toBe(first.body.test.id);
    expect(again.body.runId).toBe(first.body.runId);
    expect(hybrid.launches().map((one) => one.replayed)).toEqual([false, true]);
    expect(engine.launches()).toHaveLength(1);
    expect((await admin.get(`/api/tests?clientId=${clientId}`)).body).toHaveLength(1);
  });

  it("creates the client's engagement once, as the person, running, with every site's host and a 90-day window recorded on the client; a new site widens it; a removed one never narrows it", async () => {
    const { clientId, sites } = await aClient(["one.example", "two.example"]);
    const before = Date.now();
    const started = await start({ clientId, siteId: sites[0], target: "https://one.example/login", consent: true });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.backend.engagementCreated).toBe(true);
    const made = hybrid.seen.find((one) => one.method === "POST" && one.path === "/api/pentest/engagements/")!;
    expect(made.account).toBe("admin");
    expect(made.json).toMatchObject({ client_name: `Company ${clientCount}`, scope_hosts: ["one.example", "two.example"], status: "running" });
    expect(made.json!.name).toBe(`Company ${clientCount} — Client ${clientCount} [dashboard client ${clientId}]`);
    const start_ = Date.parse(made.json!.testing_window_start as string);
    const end = Date.parse(made.json!.testing_window_end as string);
    expect(start_).toBeGreaterThanOrEqual(before - 1000);
    expect(end - start_).toBe(90 * 24 * 60 * 60_000);

    const client = (await admin.get(`/api/clients/${clientId}`)).body;
    expect(client.backendEngagementId).toBe(started.body.backend.engagementId);
    expect(Date.parse(client.testingWindowStart)).toBe(start_);
    expect(Date.parse(client.testingWindowEnd)).toBe(end);

    // A second launch creates nothing and widens nothing.
    hybrid.seen.length = 0;
    expect((await start({ clientId, target: "https://two.example/", consent: true })).status).toBe(201);
    expect(hybrid.seen.filter((one) => one.path.startsWith("/api/pentest/engagements/") && one.method !== "GET")).toEqual([]);

    // A site added since widens the scope by PATCH, as the person.
    await admin.post("/api/sites").send({ clientId, name: "three", url: "https://three.example" });
    hybrid.seen.length = 0;
    const widened = await start({ clientId, target: "https://three.example/", consent: true });
    expect(widened.status, JSON.stringify(widened.body)).toBe(201);
    expect(widened.body.backend.engagementWidenedBy).toEqual(["three.example"]);
    const patch = hybrid.seen.find((one) => one.method === "PATCH")!;
    expect(patch.json).toEqual({ scope_hosts: ["one.example", "two.example", "three.example"] });
    expect(patch.account).toBe("admin");
    expect(patch.stop, "a widening is not a stop").toBe(false);

    // A site removed since narrows nothing: narrowing is a person's act.
    await admin.delete(`/api/sites/${sites[1]}`);
    hybrid.seen.length = 0;
    expect((await start({ clientId, target: "https://one.example/", consent: true })).status).toBe(201);
    expect(hybrid.seen.filter((one) => one.method === "PATCH")).toEqual([]);
    expect(hybrid.engagements.get(client.backendEngagementId)!.scope_hosts).toEqual(["one.example", "two.example", "three.example"]);
  });

  it("marks a deleted client's engagement completed as a stop, and never sends a DELETE", async () => {
    const { clientId } = await aClient(["gone.example"]);
    const started = await start({ clientId, target: "https://gone.example/", consent: true });
    expect(started.status).toBe(201);
    const engagementId = started.body.backend.engagementId as number;
    await admin.post(`/api/scans/${started.body.test.id}/abort`);
    hybrid.seen.length = 0;
    expect((await admin.delete(`/api/clients/${clientId}`)).status).toBe(200);
    const withdrawn = await hybrid.waitFor((one) => one.method === "PATCH" && one.path === `/api/pentest/engagements/${engagementId}/`);
    expect(withdrawn.json).toEqual({ status: "completed" });
    expect(withdrawn.by).toBe("service token");
    expect(withdrawn.stop).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(hybrid.deletes()).toEqual([]);
    expect(hybrid.engagements.get(engagementId)!.status).toBe("completed");
  });

  it("refuses a launch without consent before anything reaches the backend, in the backend's own words", async () => {
    const { clientId } = await aClient();
    for (const body of [{ clientId, target: "https://acme.example/" }, { clientId, target: "https://acme.example/", consent: false }]) {
      const refused = await start(body);
      expect(refused.status).toBe(400);
      expect(refused.body.reason).toBe("consent_required");
      expect(refused.body.error).toContain("User consent required. Include 'consent': true.");
    }
    expect(hybrid.seen, "nothing was sent to the backend").toEqual([]);
    expect(engine.launches()).toEqual([]);
  });

  it("sends the recipient's e-mail only when the person opted in", async () => {
    const { clientId } = await aClient();
    const opted = await start({ clientId, target: "https://acme.example/", consent: true, recipientEmail: "reports@acme.example" });
    expect(opted.status).toBe(201);
    expect(hybrid.launches()[0].json).toMatchObject({ recipient_email: "reports@acme.example" });
    expect(hybrid.scans.get(opted.body.test.findings.backendScanId)!.recipient_email).toBe("reports@acme.example");
    hybrid.seen.length = 0;
    const plain = await start({ clientId, target: "https://acme.example/", consent: true, recipientEmail: "" });
    expect(plain.status).toBe(201);
    expect(hybrid.launches()[0].json).not.toHaveProperty("recipient_email");
    expect(hybrid.scans.get(plain.body.test.findings.backendScanId)!.recipient_email).toBeNull();
  });

  it("refuses a person whose backend account is not an admin's, and creates no backend scan", async () => {
    const { clientId } = await aClient();
    hybrid.setRole("admin", "analyst");
    const refused = await start({ clientId, target: "https://acme.example/", consent: true });
    expect(refused.status).toBe(403);
    expect(refused.body.reason).toBe("backend_role_not_admin");
    expect(refused.body.role).toBe("analyst");
    expect(refused.body.error).toContain("only an admin's account may start a scan from this dashboard");
    expect(hybrid.launches()).toEqual([]);
    expect(hybrid.seen.map((one) => one.path)).toEqual(["/api/accounts/users/me/"]);
    expect(engine.launches()).toEqual([]);
    expect((await admin.get(`/api/tests?clientId=${clientId}`)).body).toEqual([]);
  });

  it("refuses a launch by a caller with no backend sign-in -- an API key has none -- and sends nothing", async () => {
    const made = await admin.post("/api/api-keys").send({ name: "automation" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const { clientId } = await aClient();
    hybrid.seen.length = 0;
    const refused = await request(app).post("/api/scans").set("X-API-Key", made.body.secret as string)
      .send({ clientId, target: "https://acme.example/", consent: true });
    expect(refused.status).toBe(503);
    expect(refused.body.reason).toBe("backend_sign_in_required");
    expect(refused.body.code).toBe("backend_sign_in_required");
    expect(hybrid.seen, "nothing reached the backend").toEqual([]);
    expect(engine.launches()).toEqual([]);
    expect((await admin.get(`/api/tests?clientId=${clientId}`)).body).toEqual([]);
  });
});

describe("the first direct read", () => {
  it("marks a run this dashboard's engine key cannot read `stop: backend`: no direct Stop is offered until a read succeeds", async () => {
    const { clientId } = await aClient();
    engine.control.tenantBound = true;
    const started = await start({ clientId, target: "https://acme.example/", consent: true });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.stop).toBe("backend");
    expect(started.body.backend.directRead).toMatchObject({ ok: false, notFound: true });
    expect(started.body.test.findings.stop).toBe("backend");
    expect((await admin.get(`/api/tests/${started.body.test.id}`)).body.findings.stop).toBe("backend");
    // The row and its run are recorded all the same; the backend holds the scan.
    expect(started.body.runId).toMatch(/^run-/);
    expect(hybrid.scans.get(started.body.test.findings.backendScanId)!.engine_run_id).toBe(started.body.runId);
  });

  it("a read that fails for any other reason marks nothing: the Stop stays", async () => {
    const { clientId } = await aClient();
    engine.control.readFails = true;
    const started = await start({ clientId, target: "https://acme.example/", consent: true });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.stop).toBeUndefined();
    expect(started.body.backend.directRead).toMatchObject({ ok: false, notFound: false });
    expect(started.body.test.findings).not.toHaveProperty("stop");
    engine.control.readFails = false;
    const stopped = await admin.post(`/api/scans/${started.body.test.id}/abort`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.stopped).toBe(true);
  });
});

describe("a launch the backend did not answer in time", () => {
  it("is said to be of unknown outcome when the backend has no row to adopt; the press re-sent with its key replays once the backend answered", async () => {
    const { clientId } = await aClient();
    launchTimeouts.launchMs = 250;
    engine.control.launchDelayMs = 700;
    const lost = await start({ clientId, target: "https://acme.example/", consent: true }, "press-lost");
    expect(lost.status).toBe(409);
    expect(lost.body.reason).toBe("scan_outcome_unknown");
    expect(lost.body.error).toContain("We don't know whether this scan started");
    expect(lost.body.mayStillBeRunning).toBe(true);
    expect((await admin.get(`/api/tests?clientId=${clientId}`)).body, "nothing was recorded for it").toEqual([]);
    // The backend answers in its own time, and records the answer under the key.
    await hybrid.waitFor((one) => one.path === "/api/pentest/scan/" && one.status === 202);
    launchTimeouts.launchMs = 25_000;
    engine.control.launchDelayMs = 0;
    const again = await start({ clientId, target: "https://acme.example/", consent: true }, "press-lost");
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.replayed).toBe(true);
    expect(engine.launches(), "one engine run for the two sends").toHaveLength(1);
    expect((await admin.get(`/api/tests?clientId=${clientId}`)).body).toHaveLength(1);
  });

  it("adopts the row the backend made when it already named the run", async () => {
    const { clientId } = await aClient();
    launchTimeouts.launchMs = 250;
    hybrid.controls.answerDelayMs = 700;
    const adopted = await start({ clientId, target: "https://acme.example/", consent: true }, "press-adopt");
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    expect(adopted.body.adopted).toBe(true);
    expect(adopted.body.runId).toMatch(/^run-/);
    expect(adopted.body.test.findings.backendScanId).toBe(hybrid.launches()[0].json && Array.from(hybrid.scans.values()).at(-1)!.uuid);
    expect(engine.launches()).toHaveLength(1);
    expect(hybrid.seen.some((one) => one.method === "GET" && one.path === "/api/pentest/scans/")).toBe(true);
  });
});
