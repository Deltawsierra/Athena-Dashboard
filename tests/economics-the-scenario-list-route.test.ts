import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";

import { makeApp, signIn } from "./helpers";
import { economicsStandIn, type EconomicsStandIn } from "./helpers/economics-stand-in";
import { MASTER, exchange, fixture } from "./helpers/economics-fixtures";
import { SCENARIO_PAGE_SIZE, SCENARIO_PAGE_SIZE_MAX } from "../server/economics";

/**
 * A deployment's scenario versions (Athena-Backend #163,
 * `GET deployments/<uuid>/economics/scenarios/?page=&page_size=`), through
 * `/api/economics/scenarios` (server/economics.ts): the list's bytes passed on as
 * served, a page at a time, forwarding only the deployment's uuid and the page
 * and page size a request names -- each read as the backend reads it, so a value
 * it would refuse is refused here and never sent.
 *
 * The backend here is a stand-in that answers what Athena-Backend's own route
 * answered (tests/fixtures/economics, SYNTHETIC: five versions, read two a page).
 */

const list = fixture(MASTER, "scenario-list");
const first = exchange(list, "list-page-1");
const base = first.path.split("?")[0];
const deployment = /deployments\/([0-9a-f-]{36})\//.exec(base)![1];
const url = (query = "") => `/api/economics/scenarios?deployment=${deployment}${query}`;

let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let backend: EconomicsStandIn;
const saved = { url: process.env.ATHENA_FAILSAFE_URL, user: process.env.ATHENA_FAILSAFE_USER, password: process.env.ATHENA_FAILSAFE_PASSWORD };

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
  backend = await economicsStandIn([...list.exchanges!]);
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

describe("the scenario list", () => {
  it("is the backend's page size and cap", () => {
    expect([SCENARIO_PAGE_SIZE, SCENARIO_PAGE_SIZE_MAX]).toEqual([25, 100]);
    const whole = JSON.parse(exchange(list, "list-default").body);
    expect(whole.page_size).toBe(SCENARIO_PAGE_SIZE);
  });

  it("passes each page on exactly as served: JSON, nosniff, inline, no-store", async () => {
    for (const n of [1, 2, 3]) {
      const sent = exchange(list, `list-page-${n}`);
      const res = await asBytes(admin.get(url(`&page=${n}&page_size=2`)));
      expect(res.status, String(n)).toBe(200);
      expect(raw(res)).toBe(sent.body);
      expect(res.headers["content-type"]).toMatch(/^application\/json/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-disposition"]).toBe("inline");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    const whole = await asBytes(admin.get(url()));
    expect(raw(whole)).toBe(exchange(list, "list-default").body);
  });

  it("forwards only the deployment's uuid, and the page and page size a request names, in that order", async () => {
    await asBytes(admin.get(url(`&page_size=2&scenario=${deployment}&tenant=all&page=2&deployment__in=*`)));
    await asBytes(admin.get(url()));
    await asBytes(admin.get(url("&page=3")));
    await asBytes(admin.get(url(`&page_size=${SCENARIO_PAGE_SIZE_MAX}`)));
    expect(backend.economicsReads().map((one) => one.path + one.query)).toEqual([
      `${base}?page=2&page_size=2`,
      base,
      `${base}?page=3`,
      `${base}?page_size=${SCENARIO_PAGE_SIZE_MAX}`,
    ]);
    for (const read of backend.economicsReads()) expect(read.bearer).toMatch(/^access-/);
  });

  it("refuses a page or a page size the backend would refuse, and forwards none", async () => {
    const bad = [
      "&page=0", "&page=-1", "&page=+1", "&page=01", "&page=1.0", "&page=", "&page=one", "&page=%EF%BC%91",
      `&page=${"9".repeat(10)}`, `&page=${"9".repeat(4301)}`, "&page=1&page=2", "&page_size=0",
      `&page_size=${SCENARIO_PAGE_SIZE_MAX + 1}`, "&page_size=2&page_size=2", "&page_size=1e2",
    ];
    for (const query of bad) {
      const res = await admin.get(url(query));
      expect(res.status, query).toBe(400);
      expect(res.body.code, query).toBe("field_malformed");
    }
    for (const query of [`?deployment=${deployment.toUpperCase()}`, "?deployment=..", "", `?deployment=${deployment}&deployment=${deployment}`]) {
      const res = await admin.get(`/api/economics/scenarios${query}`);
      expect(res.status, query).toBe(400);
    }
    expect(backend.economicsReads()).toEqual([]);
  });

  it("the largest page a request may name is read", async () => {
    const res = await admin.get(url(`&page=${"9".repeat(9)}`));
    expect(res.status).not.toBe(400);
  });

  it("quotes the backend's own refusal", async () => {
    const refused = exchange(list, "list-refused");
    expect(refused.status).toBe(400);
    backend.answer(base, 400, "application/json", refused.body);
    const res = await admin.get(url("&page=2"));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("backend_refused");
    const backendAnswer = JSON.parse(refused.body) as { code: string; detail: string };
    expect(res.body.error).toContain(`${backendAnswer.code}: ${backendAnswer.detail}`);
  });

  it("is behind the session: a request with none is refused and nothing reaches the backend", async () => {
    const res = await request(app).get(url());
    expect(res.status).toBe(401);
    expect(backend.economicsReads()).toEqual([]);
  });
});
