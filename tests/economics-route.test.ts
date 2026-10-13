import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";

import { makeApp, signIn } from "./helpers";
import { economicsStandIn, type EconomicsStandIn } from "./helpers/economics-stand-in";
import { MASTER, PR160, exchange, fixture, idsOf } from "./helpers/economics-fixtures";

/**
 * The economics reads (server/economics.ts): three documents of ONE scenario
 * version, each the backend's bytes streamed through unmodified, behind the
 * session, forwarding only the uuids a request names and caching nothing. And
 * none of them is on a stop's path: an economics read the backend holds open
 * never holds back a pause.
 *
 * The backend here is a stand-in that answers with what Athena-Backend's own
 * routes answered (tests/fixtures/economics, SYNTHETIC).
 */

const graded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
const vetoed = fixture(PR160, "roi-vetoed");
const { deployment, scenario } = idsOf(graded);
const query = (extra = "") => `?deployment=${deployment}&scenario=${scenario}${extra}`;

let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let backend: EconomicsStandIn;
const saved = { url: process.env.ATHENA_FAILSAFE_URL, user: process.env.ATHENA_FAILSAFE_USER, password: process.env.ATHENA_FAILSAFE_PASSWORD };

/** A response body as its raw bytes, however it is typed. */
function raw(res: request.Response): string {
  return Buffer.isBuffer(res.body) ? res.body.toString("utf8") : res.text;
}
const asBytes = (res: request.Request) => res.buffer(true).parse((stream, done) => {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => done(null, Buffer.concat(chunks)));
});

beforeAll(async () => {
  app = await makeApp();
  admin = await signIn(app);
});

beforeEach(async () => {
  backend = await economicsStandIn([...graded.exchanges!, ...vetoed.exchanges!]);
  process.env.ATHENA_FAILSAFE_URL = backend.url;
  process.env.ATHENA_FAILSAFE_USER = "svc-dashboard";
  process.env.ATHENA_FAILSAFE_PASSWORD = "stand-in-only"; // pragma: allowlist secret
  (await import("../server/control-plane"))._resetForTests();
});

afterEach(async () => {
  await backend.close();
  for (const [key, value] of [["ATHENA_FAILSAFE_URL", saved.url], ["ATHENA_FAILSAFE_USER", saved.user], ["ATHENA_FAILSAFE_PASSWORD", saved.password]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the economics reads", () => {
  it("are behind the session: a request with none is refused and nothing reaches the backend", async () => {
    for (const document of ["report", "events", "roi"]) {
      const res = await request(app).get(`/api/economics/${document}${query()}`);
      expect(res.status, document).toBe(401);
    }
    expect(backend.economicsReads()).toEqual([]);
  });

  it("stream the report's bytes exactly as the backend sent them, and cache nothing", async () => {
    const sent = exchange(graded, "report").body;
    const res = await asBytes(admin.get(`/api/economics/report${query()}`));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    // Byte for byte: never parsed, never re-encoded, so the digest it carries is the digest of what arrives.
    expect(raw(res)).toBe(sent);
    expect(JSON.parse(raw(res)).digest).toBe(JSON.parse(sent).digest);
    // A second read is a second backend read: nothing was kept.
    await asBytes(admin.get(`/api/economics/report${query()}`));
    expect(backend.economicsReads().filter((one) => one.path.endsWith("/results/"))).toHaveLength(2);
  });

  it("read the scenario's events and its ROI document as served", async () => {
    const events = await asBytes(admin.get(`/api/economics/events${query()}`));
    expect(events.status).toBe(200);
    expect(raw(events)).toBe(exchange(graded, "events").body);
    const ids = idsOf(vetoed);
    const roi = await asBytes(admin.get(`/api/economics/roi?deployment=${ids.deployment}&scenario=${ids.scenario}`));
    expect(roi.status).toBe(200);
    expect(raw(roi)).toBe(exchange(vetoed, "roi").body);
  });

  it("forward only the uuids a request names: any other parameter is dropped, never passed on", async () => {
    const simulation = (JSON.parse(exchange(graded, "report").body).simulation as { uuid: string }).uuid;
    await asBytes(admin.get(`/api/economics/report${query(`&simulation=${simulation}&tenant=all&deployment__in=*&page_size=100000`)}`));
    const [read] = backend.economicsReads();
    expect(read.path).toBe(`/api/assurance/deployments/${deployment}/economics/scenarios/${scenario}/results/`);
    expect(read.query).toBe(`?simulation=${simulation}`);
    expect(read.bearer).toMatch(/^access-/);
  });

  it("refuse a request that names anything but one deployment and one scenario by uuid, and forward none of them", async () => {
    const bad = [
      `?deployment=${deployment}`,
      `?scenario=${scenario}`,
      `?deployment=..&scenario=${scenario}`,
      `?deployment=${deployment}&scenario=../../../failsafe/commands`,
      `?deployment=${deployment.toUpperCase()}&scenario=${scenario}`,
      `?deployment=${deployment}&deployment=${deployment}&scenario=${scenario}`,
      `?deployment=${deployment}&scenario=${scenario},${scenario}`,
      query("&simulation=latest"),
    ];
    for (const one of bad) {
      const res = await admin.get(`/api/economics/report${one}`);
      expect(res.status, one).toBe(400);
      expect(res.body.code).toBe("field_malformed");
    }
    // The events and ROI documents are the scenario's: a named result is refused, not passed on.
    expect((await admin.get(`/api/economics/roi${query(`&simulation=${deployment}`)}`)).status).toBe(400);
    expect(backend.economicsReads()).toEqual([]);
  });

  it("say a document the backend does not serve is not served: the ROI route this backend version has not got", async () => {
    // Athena-Backend master answers its own 404 page for the ROI route (#160 adds it).
    const res = await admin.get(`/api/economics/roi${query()}`);
    expect(res.status).toBe(404);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.error).toMatch(/^not served: Athena-Backend answered 404/);
    expect(res.body.error).not.toMatch(/<html|<h1/);
  });

  it("answer 503 when no backend is configured, before reading the request", async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    const res = await admin.get(`/api/economics/report?deployment=x1&scenario=x1`);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/no Athena control plane is configured/);
  });

  it("never hold back a stop: a pause goes and is answered while an economics read is held open mid-answer", async () => {
    const reportPath = exchange(graded, "report").path;
    backend.hold(reportPath);
    // A read the backend has started to answer and then stalls on.
    const reading = asBytes(admin.get(`/api/economics/report${query()}`)).then((res) => res);
    await backend.waitFor((one) => one.path === reportPath);
    // The pause of the same deployment: a stop (athena-backend safety/stops.py).
    const paused = await admin.post(`/api/assurance/deployments/${deployment}/recompute`).send({ paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.decision).toBe("paused");
    const pause = backend.seen.find((one) => one.method === "POST" && one.path.endsWith("/recompute/"));
    expect(pause?.body).toBe(JSON.stringify({ paused: true }));
    // ...answered while the economics read was still held open.
    expect(backend.holdingOpen()).toBe(true);
    backend.release();
    const res = await reading;
    expect(raw(res)).toBe(exchange(graded, "report").body);
  });
});
