import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";

/**
 * The whole path, when there is an engine to drive.
 *
 * Skipped when there is not, because the alternative is a suite that either
 * needs a Python service to run at all or quietly proves nothing. Point
 * ATHENA_E2E_ENGINE_URL at a running engine and it runs:
 *
 *   ATHENA_E2E_ENGINE_URL=http://127.0.0.1:8099 \
 *   ATHENA_E2E_ENGINE_KEY=<operator key> npx vitest run tests/engine-e2e.test.ts
 */
let hybrid: HybridBackendStandIn | null = null;
const url = process.env.ATHENA_E2E_ENGINE_URL;
const key = process.env.ATHENA_E2E_ENGINE_KEY;

describe.skipIf(!url)("against a real engine", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    process.env.ATHENA_ENGINE_URL = url;
    if (key) process.env.ATHENA_ENGINE_KEY = key;
    // A test-only Athena-Backend that launches on the real engine: the dashboard starts every scan through it.
    hybrid = await hybridBackendStandIn({ engine: { url: process.env.ATHENA_ENGINE_URL!, key: process.env.ATHENA_ENGINE_KEY } });
    process.env.ATHENA_FAILSAFE_URL = hybrid.url;
    app = await makeApp();
    agent = await signIn(app);
    await signInToBackend(agent);
  });
  afterAll(async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    await hybrid?.close();
    hybrid = null;
  });

  it("dispatches a scan, follows it, and counts only what came back", async () => {
    const status = await agent.get("/api/engine/status");
    expect(status.body.reachable).toBe(true);

    const client = await agent
      .post("/api/clients")
      .send({ name: "Acme", company: "Acme Corp", email: "sec@acme.test" });

    const started = await agent.post("/api/scans").send({ consent: true,
      clientId: client.body.id,
      // Loopback, which the engine's egress policy refuses. That is the
      // useful case to assert: the refusal is a result with a reason, it
      // reaches the operator unchanged, and it is not a vulnerability.
      target: "http://127.0.0.1:9/",
    });
    expect(started.status).toBe(201);
    expect(started.body.runId).toBeTruthy();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const poll = await agent.get(`/api/scans/${started.body.test.id}`);
      if (!["completed", "aborted", "failed"].includes(poll.body.state)) continue;

      const findings = (poll.body.engine?.findings ?? []) as Array<
        Record<string, unknown>
      >;
      // The engine marks its own diagnostics `internal`. They are worth
      // showing and they are not vulnerabilities.
      const internal = findings.filter((one) => one.internal === true);
      expect(internal.length).toBeGreaterThan(0);
      expect(String(internal[0].details)).toContain("loopback");
      expect(poll.body.test.vulnerabilitiesFound).toBe(0);
      expect(poll.body.test.criticalCount).toBe(0);
      return;
    }
    throw new Error("the scan never reached a finished state");
  }, 40_000);
});
