/**
 * The first-run admin as the test suites use it.
 *
 * First run no longer seeds a fixed password (server/init-data.ts): the admin
 * gets ATHENA_INITIAL_ADMIN_PASSWORD, which tests/setup.ts sets to this value
 * for every test file, and must change it at its first sign-in. Most suites
 * test something else, on an install whose admin has already done that:
 * adminHasSetPassword clears the flag, as the change-password route would.
 * This value exists only in tests/; no install is seeded with it.
 */
export const TEST_ADMIN_PASSWORD = "tests-only-admin-password-4c1e"; // pragma: allowlist secret

/** The seeded admin's must-change flag cleared: an install whose admin has set a password. */
export async function adminHasSetPassword(): Promise<void> {
  const { storage } = await import("../server/storage-unified");
  const admin = await storage.getUserByUsername("admin");
  if (admin?.mustChangePassword) await storage.updateUser(admin.id, { mustChangePassword: false });
}
