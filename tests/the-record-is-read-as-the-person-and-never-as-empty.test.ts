import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

/**
 * Athena-Backend is the RECORD of every scan started through it -- from this
 * dashboard or from anywhere else -- and of the findings and deployments its
 * ingest made of them (the Option 1 hybrid, owner decisions 1 and 4). This
 * dashboard reads that record as the signed-in person, bounded, on no stop's
 * path, and never answers an unreadable record as an empty one:
 *
 *   - GET /api/record/engagements: the engagements the person can see, each with
 *     the dashboard client whose `backendEngagementId` names it (or none); every
 *     scan the backend lists for them, its list read WHOLE by following each
 *     page's `next` (never a first page read as the whole), each row carrying the
 *     record's pinned fields and the row here that names it, when one does; and
 *     the deployments with the engagement each was ingested under;
 *   - a part that could not be read is said to be unread, with the reason, beside
 *     the parts that were; engagements that cannot be read are 503 "could not be
 *     read"; a person with no backend sign-in is told so (503, never 401);
 *   - GET /api/record/clients/:id/findings: the backend findings of the client's
 *     engagement's deployments, each with the scan it came from (`scanUuid`,
 *     `engineRunId`) and the row here for that scan; a client with no engagement
 *     at the backend reads nothing there, and is answered as having no record
 *     there -- never as "no findings";
 *   - GET /api/record/scans/:uuid/pdf: the backend's report, relayed as the
 *     person, for a scan no row here need name; the backend's refusal in its words.
 *
 * The stand-in backend (tests/helpers/hybrid-backend-stand-in.ts) serves the
 * record's shapes after athena-backend #188, paged two rows at a time here.
 */

const TOKEN = "f".repeat(64);

/** An engine whose runs stay running until stopped; `completeNext` finishes the next launch inline. */
function stubEngine() {
  const running = new Map<string, string>();
  const control = { completeNext: false };
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
        return json(res, 200, { run_id: id, state: running.has(id) ? "running" : "aborted", done: !running.has(id), result: { results: [] } });
      }
      if (req.method === "POST" && url === "/api/scan") {
        next += 1;
        const id = `run-${next}`;
        if (control.completeNext) {
          control.completeNext = false;
          return json(res, 200, { run_id: id, state: "completed", result: { results: [{ type: "x", severity: "low" }], coverage: { complete: true, checks: [] } } });
        }
        running.set(id, String((JSON.parse(raw || "{}") as { target?: string }).target ?? ""));
        return json(res, 202, { run_id: id, state: "running" });
      }
      return json(res, 404, { detail: "Not Found" });
    });
  });
  return { server, running, control };
}

let engine: ReturnType<typeof stubEngine>;
let hybrid: HybridBackendStandIn;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let storage: typeof import("../server/storage-unified").storage;
let persons: typeof import("../server/person-credential");
let clientCount = 0;

beforeAll(async () => {
  engine = stubEngine();
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  const engineUrl = `http://127.0.0.1:${(engine.server.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_URL = engineUrl;
  process.env.ATHENA_ENGINE_KEY = "dashboard-key";
  hybrid = await hybridBackendStandIn({ engine: { url: engineUrl, key: "backend-key" }, serviceToken: TOKEN, assurance: true, pageSize: 2 });
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = TOKEN;
  vi.resetModules();
  app = await makeApp();
  admin = await signIn(app);
  await signInToBackend(admin);
  storage = (await import("../server/storage-unified")).storage;
  persons = await import("../server/person-credential");
});

afterEach(() => {
  // Every run of a case ends with it, so Max Concurrent Tests (counted from the engine's live list) never refuses the next.
  engine.running.clear();
  hybrid.seen.length = 0;
  hybrid.controls.failNextAssurance = null;
  hybrid.controls.failNextScansList = null;
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
});

afterAll(async () => {
  for (const name of ["ATHENA_ENGINE_URL", "ATHENA_ENGINE_KEY", "ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_SERVICE_TOKEN"]) delete process.env[name];
  (app.locals.collectWatcher as { halt(): void }).halt();
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
  await hybrid.close();
  engine.server.closeAllConnections?.();
  await new Promise<void>((r) => engine.server.close(() => r()));
});

async function aClient(host = "acme.example") {
  clientCount += 1;
  const client = await admin.post("/api/clients").send({ name: `Client ${clientCount}`, company: `Company ${clientCount}`, email: `c${clientCount}@x.test` });
  await admin.post("/api/sites").send({ clientId: client.body.id, name: host, url: `https://${host}` });
  return client.body.id as string;
}

/** The admin's own bearer at the stand-in: a launch made there is one this dashboard did not make. */
async function aBearer(): Promise<string> {
  const signedIn = await fetch(`${hybrid.url}/api/token/`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: TEST_ADMIN_PASSWORD }),
  });
  return ((await signedIn.json()) as { access: string }).access;
}

/** A scan started at the backend by someone other than this dashboard, under `engagementId`. */
async function aScanStartedElsewhere(engagementId: number, url: string): Promise<{ uuid: string; runId: string | number | null }> {
  const answer = await fetch(`${hybrid.url}/api/pentest/scan/`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await aBearer()}` },
    body: JSON.stringify({ url, consent: true, engagement_id: engagementId, wait_seconds: 0 }),
  });
  expect([200, 202]).toContain(answer.status);
  const body = (await answer.json()) as { scan_id: string };
  return { uuid: body.scan_id, runId: hybrid.scans.get(body.scan_id)!.engine_run_id };
}

const recordReads = () => hybrid.seen.filter((one) => one.method === "GET" && (one.path === "/api/pentest/scans/" || one.path.startsWith("/api/assurance/")));

describe("GET /api/record/engagements", () => {
  it("reads the engagements, every page of the scans, and the deployments as the person, and names the row here each scan has", async () => {
    const clientId = await aClient();
    const started = await admin.post("/api/scans").send({ clientId, target: "https://acme.example/", consent: true });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const engagementId = started.body.backend.engagementId as number;
    const ownScan = started.body.test.findings.backendScanId as string;
    // Three more scans the backend lists that this dashboard never started: one of them under an engagement no client here names.
    const outside = hybrid.addEngagement({ name: "Outside engagement", client_name: "Outside Co", scope_hosts: ["outside.example"] });
    const elsewhere = [
      await aScanStartedElsewhere(engagementId, "https://acme.example/login"),
      await aScanStartedElsewhere(outside.id, "https://outside.example/"),
      await aScanStartedElsewhere(outside.id, "https://outside.example/api"),
    ];
    hybrid.addDeployment({ uuid: "dep-acme", name: "Outside engagement · acme.example", engagement_id: engagementId, decision: "needs_remediation", decision_label: "Requires remediation" });
    hybrid.addDeployment({ uuid: "dep-outside", name: "Outside engagement · outside.example", engagement_id: outside.id });
    hybrid.seen.length = 0;

    const read = await admin.get("/api/record/engagements");
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.scansUnread).toBeNull();
    expect(read.body.deploymentsUnread).toBeNull();

    // The engagements, each with the client here that names it, or none.
    const engagements = read.body.engagements as Array<{ id: number; name: string; status: string; scopeHosts: string[]; client: { id: string; name: string } | null }>;
    expect(engagements.map((one) => one.id).sort()).toEqual([engagementId, outside.id].sort());
    expect(engagements.find((one) => one.id === engagementId)).toMatchObject({ status: "running", scopeHosts: ["acme.example"], client: { id: clientId, name: `Client ${clientCount}` } });
    expect(engagements.find((one) => one.id === outside.id)).toMatchObject({ name: "Outside engagement", client: null });

    // The scans: four rows, read whole across two pages, each with the record's fields.
    const scans = read.body.scans as Array<Record<string, unknown>>;
    expect(scans).toHaveLength(4);
    const pages = hybrid.seen.filter((one) => one.method === "GET" && one.path === "/api/pentest/scans/");
    expect(pages.map((one) => one.query)).toEqual(["", "?page=2"]);
    expect(pages.every((one) => one.account === "admin" && one.by === "bearer" && one.stop === false)).toBe(true);
    const own = scans.find((one) => one.uuid === ownScan)!;
    expect(own).toMatchObject({
      targetUrl: "https://acme.example/", status: "pending", verdict: null, verdictLabel: null, collectedAt: null,
      engineRunId: started.body.runId, pdfUrl: null, emailSent: false, errorMessage: null,
      engagement: { id: engagementId, status: "running" },
      test: { id: started.body.test.id, status: "running", clientId, stop: null },
    });
    expect(own.stop).toEqual({ state: "none", detail: null });
    for (const one of elsewhere) {
      const row = scans.find((scan) => scan.uuid === one.uuid)!;
      expect(row, one.uuid).toMatchObject({ status: "pending", engineRunId: String(one.runId), test: null });
    }
    // The deployments, each with the engagement it was ingested under.
    const deployments = read.body.deployments as Array<{ uuid: string; engagementId: number | null; decision: string | null }>;
    expect(deployments.map((one) => one.uuid).sort()).toEqual(["dep-acme", "dep-outside"]);
    expect(deployments.find((one) => one.uuid === "dep-acme")).toMatchObject({ engagementId, decision: "needs_remediation" });
    expect(deployments.find((one) => one.uuid === "dep-outside")).toMatchObject({ engagementId: outside.id, decision: null });
    // Every read went as the person; none as a stop.
    expect(recordReads().every((one) => one.account === "admin" && one.stop === false)).toBe(true);
  });

  it("says a part that could not be read is unread, with the reason, and never answers it as none", async () => {
    hybrid.controls.failNextAssurance = { status: 500, body: { detail: "the deployments table is locked" } };
    const read = await admin.get("/api/record/engagements");
    expect(read.status).toBe(200);
    expect(read.body.deployments).toBeNull();
    expect(read.body.deploymentsUnread).toMatch(/^could not be read: .*500.*the deployments table is locked/);
    expect(Array.isArray(read.body.scans), "the scans were read all the same").toBe(true);
    expect(read.body.scansUnread).toBeNull();

    hybrid.controls.failNextScansList = { status: 502, body: { detail: "the scans table is away" } };
    const again = await admin.get("/api/record/engagements");
    expect(again.status).toBe(200);
    expect(again.body.scans).toBeNull();
    expect(again.body.scansUnread).toMatch(/^could not be read: .*502.*the scans table is away/);
    expect(Array.isArray(again.body.deployments)).toBe(true);
  });

  it("answers 503 'could not be read' when the backend cannot be reached, and names the sign-in a person has not got", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${port}`;
    const unreachable = await admin.get("/api/record/engagements");
    expect(unreachable.status).toBe(503);
    expect(unreachable.body).toMatchObject({ reason: "backend_unavailable", couldNotBeRead: true });
    expect(unreachable.body.error).toMatch(/^The engagements could not be read: /);
    process.env.ATHENA_FAILSAFE_URL = hybrid.url;

    persons._resetPersonsForTests();
    try {
      const unsigned = await admin.get("/api/record/engagements");
      expect(unsigned.status).toBe(503);
      expect(unsigned.body).toMatchObject({ reason: "backend_sign_in_required", code: "backend_sign_in_required", couldNotBeRead: true });
      expect(unsigned.body.error).toMatch(/could not be read: it needs your Athena-Backend sign-in/);
      expect(hybrid.seen, "nothing was sent without a credential").toEqual([]);
    } finally {
      await signInToBackend(admin);
    }
  });
});

describe("GET /api/record/clients/:id/findings", () => {
  it("lists the backend findings of the client's engagement's deployments, each with the scan it came from and the row here for that scan", async () => {
    const clientId = await aClient("shop.example");
    const started = await admin.post("/api/scans").send({ clientId, target: "https://shop.example/", consent: true });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const engagementId = started.body.backend.engagementId as number;
    const scanId = started.body.test.findings.backendScanId as string;
    hybrid.addDeployment({ uuid: "dep-shop", name: "shop", engagement_id: engagementId, decision: "ready", decision_label: "Ready" });
    hybrid.addDeployment({ uuid: "dep-other", name: "another client's", engagement_id: 9_999 });
    hybrid.addFinding({ uuid: "f-shop-1", deployment_uuid: "dep-shop", severity: "high", title: "a quoted parameter reached the query", scan_uuid: scanId, engine_run_id: started.body.runId, retest_checks: [{ verdict: "still_open" }] });
    hybrid.addFinding({ uuid: "f-shop-2", deployment_uuid: "dep-shop", severity: "low", title: "filed another way", scan_uuid: null, engine_run_id: null });
    hybrid.addFinding({ uuid: "f-other", deployment_uuid: "dep-other", severity: "critical", title: "not this client's" });
    hybrid.seen.length = 0;

    const read = await admin.get(`/api/record/clients/${clientId}/findings`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.engagementId).toBe(engagementId);
    expect(read.body.deployments.map((one: { uuid: string }) => one.uuid)).toEqual(["dep-shop"]);
    const findings = read.body.findings as Array<Record<string, unknown>>;
    expect(findings.map((one) => one.uuid).sort()).toEqual(["f-shop-1", "f-shop-2"]);
    expect(findings.find((one) => one.uuid === "f-shop-1")).toMatchObject({
      severity: "high", title: "a quoted parameter reached the query", scanUuid: scanId, engineRunId: started.body.runId,
      test: { id: started.body.test.id, status: "running", clientId },
    });
    expect(findings.find((one) => one.uuid === "f-shop-2")).toMatchObject({ scanUuid: null, engineRunId: null, test: null });
    // Only this engagement's deployments were asked about, as the person.
    const findingReads = hybrid.seen.filter((one) => one.path === "/api/assurance/findings/");
    expect(findingReads.map((one) => one.query)).toEqual(["?deployment=dep-shop"]);
    expect(findingReads[0]).toMatchObject({ account: "admin", by: "bearer", stop: false });
  });

  it("a client with no engagement at the backend has nothing in that record: nothing is read, and it is said as that, never as no findings", async () => {
    const clientId = await aClient("plain.example");
    hybrid.seen.length = 0;
    const read = await admin.get(`/api/record/clients/${clientId}/findings`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ clientId, engagementId: null, deployments: [], findings: [] });
    expect(recordReads(), "nothing was read from the backend").toEqual([]);
    expect((await admin.get("/api/record/clients/no-such-client/findings")).status).toBe(404);
  });

  it("answers 'could not be read' when the backend fails, never an empty list", async () => {
    const clientId = await aClient("fails.example");
    const started = await admin.post("/api/scans").send({ clientId, target: "https://fails.example/", consent: true });
    expect(started.status).toBe(201);
    hybrid.controls.failNextAssurance = { status: 503, body: { detail: "the record is being rebuilt" } };
    const read = await admin.get(`/api/record/clients/${clientId}/findings`);
    expect(read.status).toBe(503);
    expect(read.body.couldNotBeRead).toBe(true);
    expect(read.body.error).toMatch(/could not be read: .*503.*the record is being rebuilt/);
    expect(read.body.findings).toBeUndefined();
  });
});

describe("GET /api/record/scans/:uuid/pdf", () => {
  it("relays the backend's report as the person for a completed scan the record lists, and the backend's refusal for one with no report", async () => {
    const clientId = await aClient("report.example");
    const started = await admin.post("/api/scans").send({ clientId, target: "https://report.example/", consent: true });
    expect(started.status).toBe(201);
    const engagementId = started.body.backend.engagementId as number;
    engine.control.completeNext = true;
    const completed = await aScanStartedElsewhere(engagementId, "https://report.example/done");
    expect(hybrid.scans.get(completed.uuid)!.status).toBe("completed");
    hybrid.seen.length = 0;

    const pdf = await admin.get(`/api/record/scans/${completed.uuid}/pdf`).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((pdf.body as Buffer).toString("utf8")).toBe(`%PDF-1.4 stand-in report for ${completed.uuid}`);
    expect(hybrid.seen.filter((one) => one.path.endsWith("/pdf/"))).toHaveLength(1);
    expect(hybrid.seen.filter((one) => one.path.endsWith("/pdf/"))[0]).toMatchObject({ account: "admin", by: "bearer", stop: false });

    const pending = await admin.get(`/api/record/scans/${started.body.test.findings.backendScanId}/pdf`);
    expect(pending.status).toBe(409);
    expect(pending.body).toMatchObject({ reason: "backend_refused", backendStatus: 409 });
    expect(pending.body.error).toContain("This scan is pending, so there is no report to render.");
  });
});
