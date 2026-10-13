import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import request from "supertest";
import type { Express } from "express";

import { makeApp, signIn } from "./helpers";
import { economicsStandIn, type EconomicsStandIn } from "./helpers/economics-stand-in";
import { MASTER, exchange, fixture, idsOf, served } from "./helpers/economics-fixtures";
import { RECEIPT_MAX_BYTES } from "../server/economics";

/**
 * A Financial Exposure Receipt's signed bytes (Athena-Backend #163,
 * `GET deployments/<uuid>/economics/receipts/<receipt id>/`), through
 * `/api/economics/receipt` (server/economics.ts). The bytes are passed on exactly
 * as the backend sent them -- with `Content-Type: application/json`, nosniff,
 * attachment, no-store and their `X-Content-SHA256` -- and ONLY when they agree:
 * their SHA-256 is the one the header names, and the envelope's payload is the
 * document whose digest the page shows (the report's `receipt.document_digest`).
 * Any disagreement, or a header missing, refuses the download and sends none of
 * the bytes.
 *
 * The backend here is a stand-in that answers what Athena-Backend's own routes
 * answered, headers included (tests/fixtures/economics, SYNTHETIC).
 */

const graded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
const { deployment } = idsOf(graded);
const report = served(graded, "report") as Record<string, any>;
const receipt = exchange(graded, "receipt");
const shown = report.receipt.document_digest as string;
const hex = report.receipt.receipt_id as string;
const dashed = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const url = (id = hex, digest = shown, extra = "") => `/api/economics/receipt?deployment=${deployment}&receipt=${id}&digest=${digest}${extra}`;
const sha256 = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

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

/** The answer carried none of the receipt's bytes, and no download. */
function noBytes(res: request.Response) {
  const text = raw(res);
  const envelope = JSON.parse(receipt.body) as { payload: string; signatures: Array<{ sig: string }> };
  expect(text).not.toContain(envelope.payload.slice(0, 64));
  expect(text).not.toContain(envelope.signatures[0].sig);
  expect(res.headers["content-disposition"]).toBeUndefined();
  expect(res.headers["x-content-sha256"]).toBeUndefined();
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
}

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
});

afterEach(async () => {
  await backend.close();
  for (const [key, value] of [["ATHENA_FAILSAFE_URL", saved.url], ["ATHENA_FAILSAFE_USER", saved.user], ["ATHENA_FAILSAFE_PASSWORD", saved.password]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("a receipt's signed bytes", () => {
  it("the fixture is the backend's own: its header names its bytes, and the report names its id", () => {
    expect(receipt.status).toBe(200);
    expect(receipt.path).toBe(`/api/assurance/deployments/${deployment}/economics/receipts/${dashed}/`);
    expect(receipt.headers?.["X-Content-SHA256"]).toBe(sha256(receipt.body));
  });

  it("are passed on exactly as the backend sent them: JSON, nosniff, attachment, no-store and their SHA-256", async () => {
    const res = await asBytes(admin.get(url()));
    expect(res.status).toBe(200);
    expect(raw(res)).toBe(receipt.body);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="financial-exposure-receipt-${hex}.json"`);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-sha256"]).toBe(receipt.headers!["X-Content-SHA256"]);
    expect(res.headers["x-content-sha256"]).toBe(sha256(res.body as Buffer));
    // The backend was asked for the receipt by its dashed id, and for nothing else.
    const [read] = backend.economicsReads();
    expect(read.path).toBe(receipt.path);
    expect(read.query).toBe("");
    expect(read.bearer).toMatch(/^access-/);
  });

  it("are asked for by the report's id, undashed or dashed, and forwarded dashed; any other parameter is dropped", async () => {
    for (const id of [hex, dashed]) {
      const res = await asBytes(admin.get(url(id, shown, "&inline=1&tenant=all")));
      expect(res.status, id).toBe(200);
    }
    expect(backend.economicsReads().map((one) => one.path + one.query)).toEqual([receipt.path, receipt.path]);
  });

  it("whose SHA-256 is not the one their header names are refused, and none of them is sent", async () => {
    // One byte of the signature changed on the way: the header still names the bytes as signed.
    const changed = receipt.body.replace(/"sig":"(.)/, (_all, first: string) => `"sig":"${first === "A" ? "B" : "A"}`);
    expect(changed).not.toBe(receipt.body);
    backend.answer(receipt.path, 200, "application/json", changed, receipt.headers);
    const res = await asBytes(admin.get(url()));
    expect(res.status).toBe(502);
    const answer = JSON.parse(raw(res));
    expect(answer.code).toBe("receipt_digest_mismatch");
    expect(answer.error).toContain(sha256(changed));
    expect(answer.error).toContain(receipt.headers!["X-Content-SHA256"]);
    noBytes(res);
  });

  it("sent without their SHA-256, or with one that is not a SHA-256, are refused, and none of them is sent", async () => {
    for (const header of [undefined, "", "sha256:ABC", `md5:${"0".repeat(32)}`, sha256(receipt.body).toUpperCase()]) {
      const headers: Record<string, string> = { ...receipt.headers! };
      delete headers["X-Content-SHA256"];
      if (header !== undefined) headers["X-Content-SHA256"] = header;
      backend.answer(receipt.path, 200, "application/json", receipt.body, headers);
      const res = await asBytes(admin.get(url()));
      expect(res.status, String(header)).toBe(502);
      expect(JSON.parse(raw(res)).code, String(header)).toBe("receipt_digest_missing");
      noBytes(res);
    }
  });

  it("whose payload is not the document whose digest the page shows are refused, and none of them is sent", async () => {
    // The page shows another document's digest (the Validity Card's, the report's own): the bytes are refused.
    for (const digest of [report.receipt.validity_card_digest as string, report.digest as string, sha256("")]) {
      const res = await asBytes(admin.get(url(hex, digest)));
      expect(res.status, digest).toBe(502);
      const answer = JSON.parse(raw(res));
      expect(answer.code).toBe("receipt_document_mismatch");
      expect(answer.error).toContain(shown);
      expect(answer.error).toContain(digest);
      noBytes(res);
    }
  });

  it("an envelope with no payload that reads as base64 of UTF-8 text is refused", async () => {
    const envelope = JSON.parse(receipt.body) as Record<string, unknown>;
    for (const body of [
      JSON.stringify({ ...envelope, payload: "not base64!" }),
      JSON.stringify({ ...envelope, payload: `${String(envelope.payload)}\n` }),
      JSON.stringify({ ...envelope, payload: Buffer.from([0xff, 0xfe, 0x7b]).toString("base64") }),
      JSON.stringify({ ...envelope, payload: 7 }),
      JSON.stringify([envelope]),
      "{",
    ]) {
      backend.answer(receipt.path, 200, "application/json", body, { ...receipt.headers!, "X-Content-SHA256": sha256(body) });
      const res = await asBytes(admin.get(url()));
      expect(res.status, body.slice(0, 40)).toBe(502);
      expect(JSON.parse(raw(res)).code, body.slice(0, 40)).toBe("receipt_unreadable");
    }
  });

  it("past the bound are refused, and none of them is sent", async () => {
    const body = " ".repeat(RECEIPT_MAX_BYTES + 1);
    backend.answer(receipt.path, 200, "application/json", body, { "X-Content-SHA256": sha256(body) });
    const res = await asBytes(admin.get(url()));
    expect(res.status).toBe(502);
    expect(JSON.parse(raw(res)).code).toBe("receipt_too_large");
  });

  it("whose answer breaks off mid-way are refused with a fixed sentence, and none of them is sent", async () => {
    backend.hold(receipt.path);
    const pending = asBytes(admin.get(url())).then((res) => res);
    await backend.waitFor((one) => one.path === receipt.path);
    backend.cutHeld();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(JSON.parse(raw(res))).toEqual({
      error: "Athena-Backend's answer of a Financial Exposure Receipt's signed bytes broke off: none of it is sent",
      code: "backend_error",
    });
    noBytes(res);
  });

  it("a 200 that is not JSON is refused, and none of it is sent", async () => {
    const page = "<html><script>alert(1)</script></html>";
    backend.answer(receipt.path, 200, "text/html; charset=utf-8", page, { "X-Content-SHA256": sha256(page) });
    const res = await asBytes(admin.get(url()));
    expect(res.status).toBe(502);
    expect(JSON.parse(raw(res)).code).toBe("backend_not_json");
    expect(raw(res)).not.toContain("<script>");
  });

  it("a receipt the deployment has not is 'not served', quoting the backend's own 404", async () => {
    const missing = exchange(graded, "receipt-missing");
    const id = /receipts\/([0-9a-f-]{36})\//.exec(missing.path)![1];
    const res = await admin.get(url(id));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_served");
    expect(res.body.error).toContain(JSON.parse(missing.body).detail);
  });

  it("refuse a request that names anything but a deployment, a receipt id and a SHA-256 digest, and forward none", async () => {
    const bad = [
      `?receipt=${hex}&digest=${shown}`,
      `?deployment=${deployment}&digest=${shown}`,
      `?deployment=${deployment}&receipt=${hex}`,
      `?deployment=${deployment}&receipt=${hex.toUpperCase()}&digest=${shown}`,
      `?deployment=${deployment}&receipt=${hex.slice(1)}&digest=${shown}`,
      `?deployment=${deployment}&receipt=../../commands&digest=${shown}`,
      `?deployment=${deployment}&receipt=${hex}&receipt=${hex}&digest=${shown}`,
      `?deployment=${deployment}&receipt=${hex}&digest=${shown.toUpperCase()}`,
      `?deployment=${deployment}&receipt=${hex}&digest=${shown.slice(0, -1)}`,
      `?deployment=${deployment}&receipt=${hex}&digest=${shown.replace("sha256:", "")}`,
      `?deployment=${deployment}&receipt=${hex}&digest=${shown}&digest=${shown}`,
    ];
    for (const query of bad) {
      const res = await admin.get(`/api/economics/receipt${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.code, query).toBe("field_malformed");
    }
    expect(backend.economicsReads()).toEqual([]);
  });

  it("are behind the session: a request with none is refused and nothing reaches the backend", async () => {
    const res = await request(app).get(url());
    expect(res.status).toBe(401);
    expect(backend.economicsReads()).toEqual([]);
  });

  it("with no control plane configured, every economics read answers 503 before it reads its request", async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    for (const path of ["/api/economics/receipt", "/api/economics/scenarios", "/api/economics/receipt?receipt=x1"]) {
      const res = await admin.get(path);
      expect(res.status, path).toBe(503);
      expect(res.body.code).toBe("backend_unavailable");
    }
  });
});
