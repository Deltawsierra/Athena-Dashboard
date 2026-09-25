import { describe, it, expect, afterEach, vi } from "vitest";
import type { Express } from "express";

import { makeApp, signIn } from "./helpers";

/**
 * A default install writes no fabricated rows.
 *
 * The installer used to seed three clients, four sites, three tests and three
 * documents on every first start unless someone knew to set
 * ATHENA_SKIP_SAMPLE_DATA=true. One of those tests is a "completed"
 * penetration test with fifteen findings -- three critical, five high -- that
 * no scan produced, and it rendered on Deployments, Evidence, Risks and
 * Compliance as a real result. Owner decision: no fabricated figure may render
 * as real in a default build. So the seed is now opt-in
 * (ATHENA_SEED_SAMPLE_DATA=1), and the old opt-out still turns it off.
 */

const SEED = "ATHENA_SEED_SAMPLE_DATA";
const SKIP = "ATHENA_SKIP_SAMPLE_DATA";

/** A fresh app with its own in-memory storage, started under `env`. */
async function startWith(env: Record<string, string | undefined>): Promise<Express> {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  return makeApp();
}

afterEach(() => {
  delete process.env[SEED];
  delete process.env[SKIP];
});

async function counts(app: Express) {
  const agent = await signIn(app);
  const sample = await agent.get("/api/sample-data");
  expect(sample.status).toBe(200);
  const clients = await agent.get("/api/clients");
  const tests = await agent.get("/api/tests");
  const documents = await agent.get("/api/documents");
  return {
    sample: sample.body,
    clients: clients.body.length as number,
    tests: tests.body.length as number,
    documents: documents.body.length as number,
  };
}

const NONE = { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 };

describe("installer sample rows", () => {
  it("are not written on a default first start", async () => {
    const app = await startWith({ [SEED]: undefined, [SKIP]: undefined });
    const seen = await counts(app);
    expect(seen.sample).toEqual(NONE);
    expect(seen.clients).toBe(0);
    expect(seen.tests).toBe(0);
    expect(seen.documents).toBe(0);
  });

  it("are written only when a demo asks for them by name", async () => {
    const app = await startWith({ [SEED]: "1", [SKIP]: undefined });
    const seen = await counts(app);
    expect(seen.sample).toEqual({ clients: 3, sites: 4, tests: 3, documents: 3, findings: 23 });
  });

  it("stay off under the old opt-out, even if the new flag is also set", async () => {
    const app = await startWith({ [SEED]: "1", [SKIP]: "true" });
    expect((await counts(app)).sample).toEqual(NONE);
  });

  it("stay off for any value of the flag other than 1", async () => {
    for (const value of ["true", "yes", "0", ""]) {
      const app = await startWith({ [SEED]: value, [SKIP]: undefined });
      expect((await counts(app)).sample, `${SEED}=${JSON.stringify(value)} seeded rows`).toEqual(NONE);
    }
  });

  it("still leave the sign-in accounts in place", async () => {
    const app = await startWith({ [SEED]: undefined, [SKIP]: undefined });
    // signIn throws unless the default admin exists.
    await expect(signIn(app)).resolves.toBeTruthy();
  });
});
