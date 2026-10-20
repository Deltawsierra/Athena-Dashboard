import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import { makeApp, signIn, signInToBackend } from "./helpers";
import { economicsStandIn, type EconomicsStandIn } from "./helpers/economics-stand-in";
import { MASTER, exchange, fixture, idsOf } from "./helpers/economics-fixtures";

/**
 * What the economics relay passes on, and in what words (review round 1,
 * MEDIUM-2 and LOW-1).
 *
 * - A document goes to the browser only when the backend answered 200 with a JSON
 *   media type. Anything else -- a backend misbehaving, compromised, or behind a
 *   proxy that answers an HTML page -- is refused, and none of its bytes is sent:
 *   nothing the backend says can run as a page on this server's origin.
 * - Every answer is `Content-Type: application/json`, `X-Content-Type-Options:
 *   nosniff` and `Cache-Control: no-store`; a download is `Content-Disposition:
 *   attachment` with a fixed file name.
 * - A backend 4xx is the backend's refusal and is quoted. A 5xx, or a backend that
 *   cannot be reached, is a fixed sentence and code: no traceback, no address.
 */

const graded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
const { deployment, scenario } = idsOf(graded);
const reportPath = exchange(graded, "report").path;
const query = (extra = "") => `?deployment=${deployment}&scenario=${scenario}${extra}`;

let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let backend: EconomicsStandIn;
const saved = { url: process.env.ATHENA_FAILSAFE_URL, user: process.env.ATHENA_FAILSAFE_USER, password: process.env.ATHENA_FAILSAFE_PASSWORD };

const asBytes = (res: request.Request) => res.buffer(true).parse((stream, done) => {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => done(null, Buffer.concat(chunks)));
});
const raw = (res: request.Response): string => (Buffer.isBuffer(res.body) ? res.body.toString("utf8") : res.text);

beforeAll(async () => {
  app = await makeApp();
  admin = await signIn(app);
});

beforeEach(async () => {
  backend = await economicsStandIn([...graded.exchanges!]);
  process.env.ATHENA_FAILSAFE_URL = backend.url;
  process.env.ATHENA_FAILSAFE_USER = "svc-dashboard";
  process.env.ATHENA_FAILSAFE_PASSWORD = "stand-in-only"; // pragma: allowlist secret
  (await import("../server/control-plane"))._resetForTests();
  // T6: the person reads the backend as themselves; signed in to this one.
  await signInToBackend(admin);
});

afterEach(async () => {
  await backend.close();
  for (const [key, value] of [["ATHENA_FAILSAFE_URL", saved.url], ["ATHENA_FAILSAFE_USER", saved.user], ["ATHENA_FAILSAFE_PASSWORD", saved.password]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function safeHeaders(res: request.Response) {
  expect(res.headers["content-type"]).toMatch(/^application\/json(;|$)/);
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(res.headers["cache-control"]).toBe("no-store");
}

describe("only JSON is passed on", () => {
  it("a document is application/json, nosniff, no-store and inline, its bytes untouched", async () => {
    const res = await asBytes(admin.get(`/api/economics/report${query()}`));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(raw(res)).toBe(exchange(graded, "report").body);
  });

  it("a download is an attachment with a fixed file name, the same bytes", async () => {
    const res = await asBytes(admin.get(`/api/economics/report${query("&download=1")}`));
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="economics-report.json"');
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(raw(res)).toBe(exchange(graded, "report").body);
    for (const bad of ["&download=0", "&download=yes", "&download=1&download=1", "&download="]) {
      const refused = await admin.get(`/api/economics/report${query(bad)}`);
      expect(refused.status, bad).toBe(400);
    }
  });

  it("a backend 200 that is an HTML page with a script is refused, and none of it reaches the browser", async () => {
    const page = "<!doctype html><script>alert(document.cookie)</script>";
    backend.answer(reportPath, 200, "text/html; charset=utf-8", page);
    const res = await asBytes(admin.get(`/api/economics/report${query()}`));
    expect(res.status).toBe(502);
    safeHeaders(res);
    expect(raw(res)).not.toContain("<script");
    expect(raw(res)).not.toContain("alert(");
    expect(JSON.parse(raw(res)).code).toBe("backend_not_json");
  });

  it("so is a 200 with no content type, or one that only resembles JSON", async () => {
    for (const type of [null, "text/plain", "application/json-seq", "text/json", "application/javascript"]) {
      backend.answer(reportPath, 200, type, exchange(graded, "report").body);
      const res = await admin.get(`/api/economics/report${query()}`);
      expect(res.status, String(type)).toBe(502);
      expect(res.body.code, String(type)).toBe("backend_not_json");
    }
    backend.answer(reportPath, 200, "Application/JSON; charset=utf-8", exchange(graded, "report").body);
    expect((await admin.get(`/api/economics/report${query()}`)).status).toBe(200);
  });

  it("every refusal of this server is nosniff and no-store too", async () => {
    safeHeaders(await admin.get(`/api/economics/report?deployment=x&scenario=y`));
    backend.answer(reportPath, 500, "application/json", "{}");
    safeHeaders(await admin.get(`/api/economics/report${query()}`));
  });
});

describe("only a refusal is quoted", () => {
  it("a backend 4xx is quoted: it is the backend's own refusal", async () => {
    backend.answer(reportPath, 403, "application/json", JSON.stringify({ detail: "You do not have permission to perform this action." }));
    const res = await admin.get(`/api/economics/report${query()}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("backend_refused");
    expect(res.body.error).toContain("You do not have permission to perform this action.");
  });

  it("a backend 5xx is a fixed sentence: its traceback and paths stay on the server", async () => {
    const leak = { code: "server_error", detail: "Traceback: /srv/athena/assurance/economics/views.py line 99 KeyError: 'svc'" };
    for (const status of [500, 502, 503]) {
      backend.answer(reportPath, status, "application/json", JSON.stringify(leak));
      const res = await admin.get(`/api/economics/report${query()}`);
      expect(res.status, String(status)).toBe(status === 503 ? 503 : 502);
      expect(res.body.code).toBe("backend_error");
      expect(JSON.stringify(res.body)).not.toMatch(/Traceback|\/srv|views\.py|KeyError|server_error/);
    }
  });

  it("a backend that cannot be reached is a fixed sentence: no address", async () => {
    // A port nothing listens on: taken, then closed.
    const closed = http.createServer();
    await new Promise<void>((ready) => closed.listen(0, "127.0.0.1", ready));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((done) => closed.close(() => done()));
    process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${port}/internal-backend.example.invalid`;
    (await import("../server/control-plane"))._resetForTests();
    const res = await admin.get(`/api/economics/report${query()}`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("backend_unavailable");
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|internal-backend|example\.invalid|fetch failed|ECONNREFUSED/);
    expect(JSON.stringify(res.body)).not.toContain(String(port));
  });
});
