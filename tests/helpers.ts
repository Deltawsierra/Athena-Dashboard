import type { Express } from "express";
import request from "supertest";
import { TEST_ADMIN_PASSWORD, adminHasSetPassword } from "./test-admin";

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
