import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * "Models loaded" is a measurement, or it is absent -- it is never the
 * operator's notes.
 *
 * The AI Health "Models loaded" reading and the CVE page's loaded-model list
 * used to come from the hand-typed `classifiers` records: a name and an
 * accuracy somebody keyed in, presented as if the engine had reported what it
 * had loaded. A record called anything, with any accuracy, read as a loaded
 * model; a real model appeared only if someone typed it. This re-sources both
 * from the engine's measured inventory (GET /api/extensions, the same one
 * loadedScanners reads), and keeps the operator records as the notes they are.
 *
 * The rule is loadedScanners': null when the engine could not be asked, never
 * an empty list, and never a silent fall back to the records.
 */
describe("the loaded-model inventory is measured from the engine", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;
  let server: Server;
  let extensions: Record<string, unknown> = {};
  let extensionsStatus = 200;

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
        if (url === "/api/extensions") {
          res.writeHead(extensionsStatus, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(extensions));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
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

  // Scanners, the ML/CVE detectors, the model artifact, and one detector the
  // engine has on disk but switched off. The shape the real engine sends.
  const anInventory = () => ({
    extensions: [
      { name: "command_injection", kind: "scanner", enabled: true },
      { name: "ml_threat_classifier", kind: "detector", enabled: true, digest: "sha256:aaa" },
      { name: "cve_classifier", kind: "detector", enabled: true, digest: "sha256:bbb" },
      { name: "ml_threat_model", kind: "artifact", enabled: true, digest: "sha256:ccc" },
      { name: "retired_detector", kind: "detector", enabled: false, digest: "sha256:ddd" },
    ],
  });

  // A hand-typed record whose name could never be an engine model, so its
  // appearance anywhere "loaded" is unambiguously the old misattribution.
  async function recordAnOperatorClassifier() {
    const res = await agent.post("/api/classifiers").send({
      name: "operator-typed-ghost",
      type: "threat",
      accuracy: 99,
      status: "active",
      trainingDataSize: 123,
      lastTrainedAt: new Date("2020-01-02T03:04:05.000Z").toISOString(),
    });
    expect(res.status).toBe(201);
  }

  it("measure() reads the engine's enabled model rows, and never the operator record", async () => {
    extensionsStatus = 200;
    extensions = anInventory();
    await recordAnOperatorClassifier();

    const { measure } = await import("../server/health");
    const reading = await measure();

    // The enabled model/detector rows, measured from the engine, sorted.
    expect(reading.modelsLoaded).toEqual([
      "cve_classifier", "ml_threat_classifier", "ml_threat_model",
    ]);
    // A scanner is loadedScanners' row, not a model.
    expect(reading.modelsLoaded).not.toContain("command_injection");
    // Present on disk but switched off did not load.
    expect(reading.modelsLoaded).not.toContain("retired_detector");
    // The whole point: the hand-typed record is not a loaded model.
    expect(reading.modelsLoaded).not.toContain("operator-typed-ghost");

    // The engine's inventory carries no training timestamp, so there is no
    // measured "most recently trained" date -- and not the operator's date.
    expect(reading.lastTrainingDate).toBeNull();
  });

  it("reports the inventory unavailable (null) -- not the records, not [] -- when the engine will not answer", async () => {
    extensionsStatus = 503;
    extensions = {};
    await recordAnOperatorClassifier(); // an active record is on file

    const { measure } = await import("../server/health");
    const reading = await measure();

    // null is "unavailable"; [] would be a false "no models loaded"; the
    // records would be the original lie. It degrades to the first, never the
    // last two.
    expect(reading.modelsLoaded).toBeNull();
    expect(reading.lastTrainingDate).toBeNull();
  });

  it("serves the engine's model inventory at GET /api/loaded-models", async () => {
    extensionsStatus = 200;
    extensions = anInventory();

    const res = await agent.get("/api/loaded-models");
    expect(res.status).toBe(200);

    const rows = res.body as Array<{ name: string; kind: string; enabled: boolean; digest: string | null }>;
    expect(rows.map((one) => one.name)).toEqual([
      "cve_classifier", "ml_threat_classifier", "ml_threat_model", "retired_detector",
    ]);
    // The scanner stays out of the model inventory.
    expect(rows.map((one) => one.name)).not.toContain("command_injection");

    // The measured fields ride along; the disabled row shows its state.
    const byName = Object.fromEntries(rows.map((one) => [one.name, one]));
    expect(byName["cve_classifier"]).toMatchObject({ kind: "detector", enabled: true, digest: "sha256:bbb" });
    expect(byName["retired_detector"].enabled).toBe(false);
  });

  it("answers null at GET /api/loaded-models when the engine cannot be asked -- never the operator records", async () => {
    extensionsStatus = 503;
    extensions = {};

    const res = await agent.get("/api/loaded-models");
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});
