import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { Express } from "express";
import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";

/**
 * The penetration-testing screen counted a progress bar to a hundred over five
 * seconds and printed two findings that were written into the source. These
 * cover the route that replaced it: an engagement it will not scan without, an
 * engine it will not pretend to have, and counts taken from what came back.
 */
let hybrid: HybridBackendStandIn | null = null;
describe("dispatching a scan", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;
  let clientId: string;
  let otherClientId: string;
  let siteId: string;
  let foreignSiteId: string;

  beforeAll(async () => {
    app = await makeApp();
    agent = await signIn(app);

    const client = await agent
      .post("/api/clients")
      .send({ name: "Acme", company: "Acme Corp", email: "sec@acme.test" });
    clientId = client.body.id;

    const other = await agent
      .post("/api/clients")
      .send({ name: "Globex", company: "Globex", email: "sec@globex.test" });
    otherClientId = other.body.id;

    const site = await agent
      .post("/api/sites")
      .send({ clientId, name: "Storefront", url: "https://shop.acme.test" });
    siteId = site.body.id;

    const foreign = await agent
      .post("/api/sites")
      .send({ clientId: otherClientId, name: "Portal", url: "https://globex.test" });
    foreignSiteId = foreign.body.id;
  });

  afterEach(() => {
    delete process.env.ATHENA_ENGINE_URL;
  });

  it("says plainly that no engine is configured rather than reporting a failure", async () => {
    const status = await agent.get("/api/engine/status");
    expect(status.status).toBe(200);
    expect(status.body.configured).toBe(false);
    expect(status.body.reachable).toBe(false);
    // A sentence an operator can act on, naming the variable to set.
    expect(status.body.detail).toContain("ATHENA_ENGINE_URL");
  });

  it("answers 503 for a scan with no engine, because nothing is broken", async () => {
    const response = await agent
      .post("/api/scans")
      .send({ consent: true, clientId, target: "https://shop.acme.test" });

    expect(response.status).toBe(503);
    expect(response.body.error).toContain("no engine is configured");
  });

  it("refuses a scan against a client that does not exist", async () => {
    const response = await agent
      .post("/api/scans")
      .send({ consent: true, clientId: "nope", target: "https://shop.acme.test" });
    expect(response.status).toBe(404);
  });

  it("refuses a site that belongs to a different client", async () => {
    // The engagement is the client and the site together. A site from
    // somebody else's engagement is not a narrower scope, it is a different
    // customer.
    const response = await agent
      .post("/api/scans")
      .send({ consent: true, clientId, siteId: foreignSiteId, target: "https://shop.acme.test" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("different client");
  });

  it("refuses a scan with no target at all", async () => {
    const response = await agent.post("/api/scans").send({ consent: true, clientId });
    expect(response.status).toBe(400);
  });

  it("reports an engine that is configured and not answering as unreachable", async () => {
    // A port nothing is listening on: configured, and not there.
    process.env.ATHENA_ENGINE_URL = "http://127.0.0.1:9";
    const status = await agent.get("/api/engine/status");

    expect(status.body.configured).toBe(true);
    expect(status.body.reachable).toBe(false);
    // Two different claims, and they used to share an answer.
    expect(status.body.detail.length).toBeGreaterThan(0);
  });

  it("keeps the site chosen for the engagement", async () => {
    process.env.ATHENA_ENGINE_URL = "http://127.0.0.1:9";
    const response = await agent
      .post("/api/scans")
      .send({ consent: true, clientId, siteId, target: "https://shop.acme.test" });

    // The engine is unreachable and no Athena-Backend is configured to launch
    // through, so this is a 503 -- but it got past the engagement checks,
    // which is what this asserts.
    expect(response.status).toBe(503);
  });
});

/**
 * The engagement's scope.
 *
 * Every scan starts through Athena-Backend (decision 11), under the client's
 * backend engagement: its scope is the client's recorded site hosts, created on
 * the first start and widened when a site was added since, never narrowed
 * (decision 2). The backend asks the engine with that scope; this dashboard asks
 * the engine for nothing at launch. The engine's fallback, given no scope, is the
 * target's own host -- so its check can only ever refuse the thing it derived
 * the scope from, which is not a check. Athena holds the client's site list, so
 * the engagement is where it means something.
 */
describe("what authorises a scan", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;
  let server: import("http").Server;
  let sent: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ status: "ok" }));
        }
        if (req.url === "/api/scan") sent.push(JSON.parse(raw || "{}"));
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: "run-1", state: "running" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("net").AddressInfo).port;
    process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_ENGINE_KEY = "ce_op_test";
    hybrid = await hybridBackendStandIn({ engine: { url: process.env.ATHENA_ENGINE_URL!, key: process.env.ATHENA_ENGINE_KEY } });
    process.env.ATHENA_FAILSAFE_URL = hybrid.url;
    vi.resetModules();
    app = await makeApp();
    agent = await signIn(app);
    await signInToBackend(agent);
  });

  afterEach(async () => {
    // Every scan started here is recorded as ended, so none counts against the next (Max Concurrent Tests).
    const { storage } = await import("../server/storage-unified");
    for (const test of await storage.getAllTests()) {
      if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
    }
  });

  afterAll(async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    await hybrid?.close();
    hybrid = null;
    delete process.env.ATHENA_ENGINE_URL;
    delete process.env.ATHENA_ENGINE_KEY;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** The backend engagement a start ran under, as the stand-in backend holds it. */
  const engagementOf = (started: { body: { backend: { engagementId: number } } }) =>
    hybrid!.engagements.get(started.body.backend.engagementId)!;
  /** The launches this dashboard sent the backend since `from`, by their bodies. */
  const launchesSince = (from: number) => hybrid!.launches().slice(from).map((one) => one.json as Record<string, unknown>);

  it("the client's recorded sites are its engagement's scope: the backend is asked under it, and asks the engine with that scope", async () => {
    sent = [];
    const from = hybrid!.launches().length;
    const client = await agent.post("/api/clients")
      .send({ name: "Scoped", company: "Scoped Ltd", email: "s@example.test" });
    await agent.post("/api/sites")
      .send({ clientId: client.body.id, name: "One", url: "https://one.example" });
    await agent.post("/api/sites")
      .send({ clientId: client.body.id, name: "Two", url: "https://two.example" });

    const started = await agent.post("/api/scans")
      .send({ consent: true, clientId: client.body.id, target: "https://one.example/login" });
    expect(started.status, JSON.stringify(started.body)).toBe(201);

    const engagement = engagementOf(started);
    expect(engagement.scope_hosts).toEqual(["one.example", "two.example"]);
    expect(engagement.client_name).toBe("Scoped Ltd");
    expect(engagement.status).toBe("running");
    expect(started.body.backend.engagementCreated).toBe(true);
    // This dashboard's launch names the engagement, the target and the consent -- and no scope of its own.
    expect(launchesSince(from)).toHaveLength(1);
    expect(launchesSince(from)[0]).toMatchObject({ engagement_id: engagement.id, url: "https://one.example/login", consent: true });
    expect(launchesSince(from)[0].scope).toBeUndefined();
    // The engine is asked once, by the backend, with the engagement's scope and reference.
    expect(sent).toHaveLength(1);
    expect(sent[0].scope).toEqual(["one.example", "two.example"]);
    expect(sent[0].engagement_ref).toBe(`athena-backend:engagement:${engagement.id}`);
  });

  it("a chosen site is kept on the record; the engagement's scope stays the client's whole site list, never narrowed to it", async () => {
    sent = [];
    const client = await agent.post("/api/clients")
      .send({ name: "Narrow", company: "Narrow Ltd", email: "n@example.test" });
    const site = await agent.post("/api/sites")
      .send({ clientId: client.body.id, name: "Only", url: "https://only.example" });
    await agent.post("/api/sites")
      .send({ clientId: client.body.id, name: "Other", url: "https://other.example" });

    const started = await agent.post("/api/scans").send({ consent: true,
      clientId: client.body.id, siteId: site.body.id, target: "https://only.example/",
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.test.siteId).toBe(site.body.id);

    // Choosing a site narrows what this dashboard records the scan against, not
    // what the engagement authorises: the backend holds the client's whole list.
    expect(engagementOf(started).scope_hosts).toEqual(["only.example", "other.example"]);
    expect(sent[0].scope).toEqual(["only.example", "other.example"]);
  });

  it("a start that asks for authenticated scanning is refused in so many words: the backend's launch carries no login block", async () => {
    sent = [];
    const from = hybrid!.launches().length;
    const client = await agent.post("/api/clients")
      .send({ name: "Auth", company: "Auth Ltd", email: "a@example.test" });
    await agent.post("/api/sites")
      .send({ clientId: client.body.id, name: "App", url: "https://app.example" });

    const refused = await agent.post("/api/scans").send({ consent: true,
      clientId: client.body.id,
      target: "https://app.example/",
      auth: {
        enabled: true,
        login_url: "/login",
        identities: [
          { name: "alice", login_fields: { username: "alice" } },
          { name: "bob", cookies: { session: "x" } },
        ],
      },
    });

    // Sent on, the identities would be dropped and the scan run anonymously while the page said otherwise.
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.reason).toBe("auth_not_carried_by_backend");
    expect(refused.body.error).toContain("no login block");
    expect(launchesSince(from)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("no auth block reaches the backend or the engine when authenticated scanning is not requested", async () => {
    sent = [];
    const from = hybrid!.launches().length;
    const client = await agent.post("/api/clients")
      .send({ name: "Anon", company: "Anon Ltd", email: "an@example.test" });
    await agent.post("/api/sites")
      .send({ clientId: client.body.id, name: "App", url: "https://anon.example" });

    await agent.post("/api/scans")
      .send({ consent: true, clientId: client.body.id, target: "https://anon.example/" })
      .expect(201);

    expect(launchesSince(from)[0].auth).toBeUndefined();
    expect(sent[0].auth).toBeUndefined();
  });

  it("refuses to scan for a client with no site on record, before anything is sent to the backend", async () => {
    sent = [];
    const from = hybrid!.launches().length;
    const engagements = hybrid!.engagements.size;
    const client = await agent.post("/api/clients")
      .send({ name: "Bare", company: "Bare Ltd", email: "b@example.test" });

    const started = await agent.post("/api/scans")
      .send({ consent: true, clientId: client.body.id, target: "https://anything.example/" });

    // Nothing on record authorises any host, and scanning on the strength of
    // the target somebody just typed is the unfalsifiable check one layer up.
    expect(started.status).toBe(400);
    expect(started.body.error).toContain("no site is recorded");
    expect(launchesSince(from)).toEqual([]);
    expect(hybrid!.engagements.size).toBe(engagements);
    expect(sent).toEqual([]);
  });

  it("reads a host out of a site recorded without a scheme", async () => {
    sent = [];
    const client = await agent.post("/api/clients")
      .send({ name: "Bare URL", company: "Bare Ltd", email: "bu@example.test" });
    await agent.post("/api/sites")
      .send({ clientId: client.body.id, name: "Typed", url: "shop.example.test" });

    const started = await agent.post("/api/scans")
      .send({ consent: true, clientId: client.body.id, target: "https://shop.example.test/" });
    expect(started.status, JSON.stringify(started.body)).toBe(201);

    expect(engagementOf(started).scope_hosts).toEqual(["shop.example.test"]);
    expect(sent[0].scope).toEqual(["shop.example.test"]);
  });

  it("a second start for the same client runs under the same engagement; a site added since widens its scope, and nothing narrows it", async () => {
    sent = [];
    const client = await agent.post("/api/clients")
      .send({ name: "Growing", company: "Growing Ltd", email: "g@example.test" });
    await agent.post("/api/sites")
      .send({ clientId: client.body.id, name: "First", url: "https://first.example" });

    const first = await agent.post("/api/scans").send({ consent: true, clientId: client.body.id, target: "https://first.example/" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const engagements = hybrid!.engagements.size;

    await agent.post("/api/sites").send({ clientId: client.body.id, name: "Second", url: "https://second.example" });
    const second = await agent.post("/api/scans").send({ consent: true, clientId: client.body.id, target: "https://second.example/" });
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    expect(second.body.backend.engagementId).toBe(first.body.backend.engagementId);
    expect(second.body.backend.engagementCreated).toBeUndefined();
    expect(second.body.backend.engagementWidenedBy).toEqual(["second.example"]);
    expect(hybrid!.engagements.size).toBe(engagements);
    expect(engagementOf(second).scope_hosts).toEqual(["first.example", "second.example"]);
    expect(sent[1].scope).toEqual(["first.example", "second.example"]);
  });
});

/**
 * Stopping a scan from the app.
 *
 * The engine has had a stop button since the abort registry and the client
 * here has had `abort` since the engine was wired up. Nothing called it --
 * there was no route, so there was no button, and an operator watching a scan
 * they wanted to halt could revoke the whole API key or nothing.
 */
describe("stopping a scan", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;
  let server: import("http").Server;
  let aborts: string[] = [];
  let accept = true;

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const url = req.url ?? "";
        if (url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ status: "ok" }));
        }
        if (url.endsWith("/abort")) {
          aborts.push(url);
          res.writeHead(accept ? 200 : 500, { "Content-Type": "application/json" });
          return res.end("{}");
        }
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: "run-stop", state: "running" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as import("net").AddressInfo).port;
    process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_ENGINE_KEY = "ce_op_test";
    hybrid = await hybridBackendStandIn({ engine: { url: process.env.ATHENA_ENGINE_URL!, key: process.env.ATHENA_ENGINE_KEY } });
    process.env.ATHENA_FAILSAFE_URL = hybrid.url;
    vi.resetModules();
    app = await makeApp();
    agent = await signIn(app);
    await signInToBackend(agent);
  });

  afterAll(async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    await hybrid?.close();
    hybrid = null;
    delete process.env.ATHENA_ENGINE_URL;
    delete process.env.ATHENA_ENGINE_KEY;
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function startOne() {
    const client = await agent.post("/api/clients")
      .send({ name: "Stoppable", company: "Stop Ltd", email: "s@stop.test" });
    await agent.post("/api/sites")
      .send({ clientId: client.body.id, name: "S", url: "https://stop.example" });
    const started = await agent.post("/api/scans")
      .send({ consent: true, clientId: client.body.id, target: "https://stop.example/" });
    return started.body.test.id as string;
  }

  it("sends the engine's own run id, and records who stopped it", async () => {
    aborts = []; accept = true;
    const testId = await startOne();

    const stopped = await agent.post(`/api/scans/${testId}/abort`);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ stopped: true, runId: "run-stop" });
    expect(aborts).toEqual(["/api/scans/run-stop/abort"]);

    const logs = await agent.get("/api/logs");
    expect(logs.body.some(
      (one: { action: string; entityType: string }) =>
        one.action === "aborted" && one.entityType === "test",
    )).toBe(true);
  });

  it("does not report a scan stopped when the engine did not accept it", async () => {
    aborts = []; accept = false;
    const testId = await startOne();

    const stopped = await agent.post(`/api/scans/${testId}/abort`);
    // Recording "aborted" here would be the record saying a scan halted while
    // it is still running against somebody's system.
    expect(stopped.status).toBe(502);
    expect(stopped.body.error).toContain("may still be running");
  });

  it("refuses to stop a test with no engine run behind it", async () => {
    const client = await agent.post("/api/clients")
      .send({ name: "Manual", company: "Manual Ltd", email: "m@stop.test" });
    const test = await agent.post("/api/tests")
      .send({ clientId: client.body.id, testType: "manual" });

    const stopped = await agent.post(`/api/scans/${test.body.id}/abort`);
    expect(stopped.status).toBe(409);
    expect(stopped.body.error).toContain("nothing to stop");
  });
});
