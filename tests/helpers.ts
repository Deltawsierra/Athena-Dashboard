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
