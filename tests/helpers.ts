import type { Express } from "express";
import request from "supertest";
import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";
import type { IStorage } from "../server/storage";
import type { Test } from "@shared/schema";
import { ingest, type IngestResult } from "../server/findings";
import { ratingOf } from "@shared/latest-scans";
import { isEngineInternal } from "@shared/engine-internal";

export { TEST_ADMIN_PASSWORD };

/** Boots an app with in-memory storage and a known session secret. */
export async function makeApp(): Promise<Express> {
  process.env.ATHENA_STORAGE = "memory";
  process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-characters";
  process.env.NODE_ENV = "test";

  const { createApp } = await import("../server/app");
  const { initializeDefaultData } = await import("../server/init-data");

  const app = createApp();
  await initializeDefaultData();
  await adminHasSetPassword();
  return app;
}

/**
 * Signs the agent's person in to Athena-Backend (POST /api/auth/backend-sign-in),
 * for a test whose control plane is stood up after the person signed in to this
 * console. Since T6 everything that is not a stop goes to the backend as the
 * signed-in person, with their own backend sign-in: a sign-in to this console
 * made while no control plane was configured has none.
 */
export async function signInToBackend(
  agent: ReturnType<typeof request.agent>,
  password = TEST_ADMIN_PASSWORD,
): Promise<void> {
  const res = await agent.post("/api/auth/backend-sign-in").send({ password });
  if (res.status !== 200) {
    throw new Error(`backend sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

/** The same, for a session held as a cookie header. */
export async function signInToBackendWithCookie(
  app: Express,
  cookie: string,
  password = TEST_ADMIN_PASSWORD,
): Promise<void> {
  const res = await request(app).post("/api/auth/backend-sign-in").set("Cookie", cookie).send({ password });
  if (res.status !== 200) {
    throw new Error(`backend sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

/** Signs in and returns an agent whose cookie jar carries the session. */
export async function signIn(
  app: Express,
  username = "admin",
  password = TEST_ADMIN_PASSWORD,
): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password });
  if (res.status !== 200) {
    throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return agent;
}

/**
 * A scan this dashboard dispatched to the engine itself and recorded, as every
 * scan was before the hybrid: a finished row naming its run (shared/engine-record.ts
 * runId, target, results -- none of BACKEND_RECORD_KEYS), its results filed into
 * this dashboard's own ledger as the status route files them (server/findings.ts
 * ingest). A scan started through Athena-Backend is recorded there instead and
 * never filed here, so the ledger's own tests -- findings, retests, the findings
 * summary -- scaffold the legacy rows they read with this, never through
 * POST /api/scans. The counts are the scan route's reading of the results
 * (ratingOf, isEngineInternal), so the row reads as one the route wrote.
 */
export async function recordLegacyScan(storage: IStorage, scan: {
  clientId: string;
  siteId?: string | null;
  target: string;
  runId: string;
  results: unknown[];
  executedBy?: string | null;
  completedAt?: Date;
}): Promise<{ test: Test; filed: IngestResult }> {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  let total = 0;
  let info = 0;
  for (const one of scan.results) {
    if (!one || typeof one !== "object") continue;
    const entry = one as Record<string, unknown>;
    if (isEngineInternal(entry.internal)) continue;
    total += 1;
    const rating = ratingOf(entry.severity);
    if (rating === "info") info += 1;
    else if (rating !== null) counts[rating] += 1;
  }
  const severity = counts.critical ? "critical" : counts.high ? "high" : counts.medium ? "medium" : counts.low ? "low"
    : total > 0 && info === total ? "info" : null;
  const siteId = scan.siteId ?? null;
  const test = await storage.createTest({
    clientId: scan.clientId,
    siteId,
    testType: "vulnerability-scan",
    status: "completed",
    completedAt: scan.completedAt ?? new Date(),
    summary: `${scan.target} — engine run ${scan.runId}`,
    findings: { runId: scan.runId, target: scan.target, results: scan.results },
    vulnerabilitiesFound: total,
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
    severity,
    executedBy: scan.executedBy ?? null,
  });
  const filed = await ingest(storage, scan.results, {
    clientId: scan.clientId,
    siteId,
    engagementRef: siteId ? `${scan.clientId}:${siteId}` : scan.clientId,
    target: scan.target,
    testId: test.id,
    runId: scan.runId,
  });
  return { test, filed };
}
