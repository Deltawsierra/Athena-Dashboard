import { TEST_ADMIN_PASSWORD } from "./test-admin";

/**
 * Test environment, set before any module is imported.
 *
 * `makeApp` sets these too, but an ES import is hoisted: a test file that
 * imports anything from `server/` at the top pulls in storage-unified, which
 * chooses its backend at module load, before makeApp has run. Two files doing
 * that shared the real ./athena.db on disk, so a kill switch thrown in one
 * file answered 503 to another, and rows created in one were counted by the
 * next. This runs first, so the choice is always the in-memory backend.
 */
process.env.ATHENA_STORAGE = "memory";
process.env.SESSION_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.NODE_ENV = "test";
// The first-run admin's password (server/init-data.ts): from the environment,
// so first run writes no password file into the working tree.
process.env.ATHENA_INITIAL_ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
