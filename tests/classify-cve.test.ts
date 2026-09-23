import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * A classifier that says nothing must not look like one that said something.
 *
 * This screen printed "SQL Injection, 92% confident" for every input, both
 * constants. It was then rebuilt to stop classifying, on the stated grounds
 * that the engine had no such route — which was false; POST /api/classify-cve
 * has been there all along. Both versions were wrong in the same way: a claim
 * made without checking.
 *
 * The engine's model knows five classes, so an input carrying no signal comes
 * back at exactly the floor with whichever label wins the tie-break, which is
 * always `rce`. Rendering that as a finding would be the third version of it.
 */
describe("classifying a vulnerability description", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;
  let server: Server;
  let reply: Record<string, unknown> = {};
  let seen: Array<Record<string, unknown>> = [];

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
        if (req.url === "/api/classify-cve") seen.push(JSON.parse(raw || "{}"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_ENGINE_KEY = "ce_op_test";
    vi.resetModules();
    app = await makeApp();
    agent = await signIn(app);
  });

  afterAll(async () => {
    delete process.env.ATHENA_ENGINE_URL;
    delete process.env.ATHENA_ENGINE_KEY;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("passes the engine's answer through, floor and label set included", async () => {
    reply = {
      label: "sql_injection", confidence: 0.284, informative: true,
      baseline: 0.2, classes: ["buffer_overflow", "path_traversal", "rce", "sql_injection", "xss"],
      engine_version: "ml-v1",
    };
    const res = await agent.post("/api/classify-cve").send({ text: "union select from users" });

    expect(res.status).toBe(200);
    expect(res.body.label).toBe("sql_injection");
    expect(res.body.informative).toBe(true);
    // The floor travels with the answer, so 0.284 can be read against it.
    expect(res.body.baseline).toBe(0.2);
    expect(res.body.classes).toHaveLength(5);
  });

  it("carries the uninformative verdict rather than flattening it", async () => {
    reply = {
      label: "rce", confidence: 0.2, informative: false,
      baseline: 0.2, classes: ["buffer_overflow", "path_traversal", "rce", "sql_injection", "xss"],
      engine_version: "ml-v1",
    };
    const res = await agent.post("/api/classify-cve").send({ text: "csrf token missing" });

    expect(res.status).toBe(200);
    // The label is still returned — hiding it is its own dishonesty — but the
    // flag that stops it reading as a finding survives the round trip.
    expect(res.body.label).toBe("rce");
    expect(res.body.informative).toBe(false);
    expect(res.body.confidence).toBe(res.body.baseline);
  });

  it("treats a missing informative flag as not informative", async () => {
    // An older engine that does not send the field has not told us the answer
    // was informative, and assuming it was is how the floor case gets rendered
    // as a finding.
    reply = { label: "rce", confidence: 0.2, engine_version: "ml-v1" };
    const res = await agent.post("/api/classify-cve").send({ text: "anything" });

    expect(res.status).toBe(200);
    expect(res.body.informative).toBe(false);
  });

  it("reports an absent confidence as unknown, not as zero", async () => {
    // Zero is a measurement -- "the model scored this class at nothing". An
    // engine that sent no confidence has not measured anything, and rendering
    // 0.0% for it states a result nobody reached. Same defect as the 92% this
    // screen used to invent, with a more modest number.
    reply = { label: "sql_injection", informative: true, baseline: 0.2, engine_version: "ml-v1" };
    const res = await agent.post("/api/classify-cve").send({ text: "union select" });

    expect(res.status).toBe(200);
    expect(res.body.confidence).toBeNull();
    // The label still travels: hiding it would be its own dishonesty.
    expect(res.body.label).toBe("sql_injection");
  });

  it("carries a confidence of zero the engine did send", async () => {
    // The control: null is the ABSENT case only. A real zero is a real answer.
    reply = { label: "rce", confidence: 0, informative: false, baseline: 0.2, engine_version: "ml-v1" };
    const res = await agent.post("/api/classify-cve").send({ text: "zzzz" });

    expect(res.status).toBe(200);
    expect(res.body.confidence).toBe(0);
    expect(res.body.confidence).not.toBeNull();
  });

  it("refuses an empty description before the engine is asked", async () => {
    seen = [];
    for (const text of ["", "   ", "\n\t"]) {
      const res = await agent.post("/api/classify-cve").send({ text });
      expect(res.status).toBe(400);
    }
    // An empty string is a question the model cannot be asked: it answers at
    // the floor with a tie-break label, which reads exactly like a finding.
    expect(seen).toEqual([]);
  });

  it("reports a model that is not loaded as unavailable, not as an answer", async () => {
    reply = { label: null, confidence: 0.0, informative: false, error: "CVE model is not loaded" };
    const res = await agent.post("/api/classify-cve").send({ text: "sql injection" });

    // 503 and the engine's own words. A missing model is a fact about the
    // deployment, not a classification of the text.
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("not loaded");
  });

  it("needs a signed-in user", async () => {
    const request = (await import("supertest")).default;
    const anon = await request(app).post("/api/classify-cve").send({ text: "sql injection" });
    expect(anon.status).toBe(401);
  });
});
