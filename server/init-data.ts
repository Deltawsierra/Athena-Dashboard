import crypto from "crypto";
import fs from "fs";
import path from "path";
import { storage } from "./storage-unified";
import { resolveDbPath } from "./db-sqlite";
import {
  verifyPassword, newPasswordRefusal, LEGACY_DEFAULT_PASSWORDS, LEGACY_DEFAULT_USERNAMES, MIN_PASSWORD_LENGTH,
} from "./password";
import type { User, InsertClient, InsertTest, InsertDocument, InsertSite } from "@shared/schema";
import { DEFAULT_ACTIVE_SYSTEMS, LEGACY_SEEDED_SYSTEMS } from "@shared/ai-systems";

/**
 * First-run seeding. Runs only when the users table is empty.
 *
 * It creates ONE account, `admin`, and no password is written in this code:
 * the password is ATHENA_INITIAL_ADMIN_PASSWORD when that is set and meets
 * the rules every password meets (password.ts newPasswordRefusal), and
 * otherwise a random one, written once to
 * INITIAL_ADMIN_PASSWORD_FILE in the data directory (beside the database),
 * readable only by the user the server runs as. The log names that file,
 * never the password. Either way the account must set a new password at its
 * first sign-in (users.mustChangePassword): until it does, it may change its
 * password, read itself, sign out and send every stop, and nothing else.
 *
 * Earlier releases created two admins with fixed passwords, written here and
 * in the docs of a public repository. An install that kept either is found
 * after the server is listening (flagLegacyDefaultPasswords) and made to
 * change it.
 *
 * Sample clients, sites, tests and documents are written only when
 * ATHENA_SEED_SAMPLE_DATA=1 (see sampleSeedingRequested). A default install
 * gets the users and nothing else.
 *
 * Everything below the users carries isSample: true. These rows exist so a
 * demo install has something to look at, and two of the tests carry severity
 * counts that no scan produced. A dashboard that adds those up next to real
 * findings is presenting invented numbers as measurements, which is precisely
 * what this product exists to stop other people doing. So they are off unless
 * asked for, the rows say what they are, every screen that counts them says
 * so, and Settings removes them.
 */
/**
 * Whether this start was asked to write the sample records.
 *
 * Off unless ATHENA_SEED_SAMPLE_DATA=1. The rows below are fabricated -- a
 * client nobody engaged, a penetration test nobody ran, fifteen findings no
 * scan produced -- and they are stored as real rows, so every screen that
 * reads clients, tests or documents counts them. A customer install must not
 * open onto that, so a demo has to ask for it by name.
 *
 * ATHENA_SKIP_SAMPLE_DATA=true, the old opt-out, still means off and still
 * wins: a deployment that set it keeps exactly the behaviour it asked for.
 */
export function sampleSeedingRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ATHENA_SKIP_SAMPLE_DATA === "true") return false;
  return env.ATHENA_SEED_SAMPLE_DATA === "1";
}

/**
 * Read an install's untouched legacy seed of active systems as today's default.
 *
 * The installer used to write ids the AI Control page does not use
 * (LEGACY_SEEDED_SYSTEMS), so the page drew every switch off while the record
 * said three systems were on. Now that the switches are enforced when a scan
 * starts, that record would refuse every scan. Exactly the installer's list
 * means nobody has switched a system since install -- a switch from the page
 * adds or removes one of the page's own ids -- so it is the installer's
 * default, and becomes today's. Any other list is left exactly as it is: the
 * page shows the ids it knows as they are, and the rest as unknown.
 */
export async function migrateLegacyActiveSystems(): Promise<void> {
  // Best-effort: it runs at every start, before the server listens, and a
  // read or write that fails here (a full disk) must never keep the server --
  // and so every Stop and the kill switch -- from coming up. Left unmigrated,
  // the legacy ids switch nothing on: scans are refused, which the page shows.
  try {
    const settings = await storage.getAIControlSettings();
    const recorded = settings?.activeSystems ?? null;
    if (!recorded || recorded.length !== LEGACY_SEEDED_SYSTEMS.length) return;
    if (!LEGACY_SEEDED_SYSTEMS.every((id, i) => recorded[i] === id)) return;
    await storage.updateAIControlSettings({ activeSystems: [...DEFAULT_ACTIVE_SYSTEMS] });
    console.log("[init] AI control: the installer's legacy system ids replaced by its current default");
  } catch (cause) {
    console.error(
      `[init] AI control: the installer's legacy system ids could not be replaced: ${
        cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** The account first run creates. */
const INITIAL_ADMIN_USERNAME = "admin";

/** The file the first-run admin's generated password is written to, in the data directory. */
export const INITIAL_ADMIN_PASSWORD_FILE = "initial-admin-password.txt"; // pragma: allowlist secret

/**
 * Where this install keeps its data: the directory of the SQLite database.
 * A database held in memory has none, so ATHENA_USER_DATA, then the working
 * directory -- where the database file would otherwise have been.
 */
export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const db = resolveDbPath();
  if (db !== ":memory:") return path.dirname(path.resolve(db));
  if (env.ATHENA_USER_DATA) return env.ATHENA_USER_DATA;
  return process.cwd();
}

/**
 * The first-run admin's password, and where it can be read: from
 * ATHENA_INITIAL_ADMIN_PASSWORD when it meets the rules every password meets
 * (password.ts newPasswordRefusal -- twelve spaces, or a value carried in
 * with a file's newline, is not taken), otherwise generated
 * (crypto.randomBytes, 32 url-safe characters) and written to the password
 * file, created anew with mode 0600 -- a file a previous install left behind
 * names a password no account has, so it is replaced. Throws when the file
 * cannot be written: an admin whose password nobody can read is not created.
 */
function initialAdminPassword(env: NodeJS.ProcessEnv): { password: string; file: string | null; refused: string | null } {
  const fromEnv = env.ATHENA_INITIAL_ADMIN_PASSWORD;
  const refused = typeof fromEnv === "string" && fromEnv.length > 0
    ? newPasswordRefusal(fromEnv, null, INITIAL_ADMIN_USERNAME)
    : null;
  if (typeof fromEnv === "string" && fromEnv.length > 0 && refused === null) {
    return { password: fromEnv, file: null, refused: null };
  }
  const password = crypto.randomBytes(24).toString("base64url");
  const dir = dataDirectory(env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, INITIAL_ADMIN_PASSWORD_FILE);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `${password}\n`, { mode: 0o600, flag: "wx" });
  // The mode given at creation is narrowed by the umask, never widened; this
  // makes it exactly 0600 whatever the umask was.
  fs.chmodSync(file, 0o600);
  return { password, file, refused };
}

export async function initializeDefaultData(): Promise<void> {
  await migrateLegacyActiveSystems();
  // Best-effort, as migrateLegacyActiveSystems is: it runs before the server
  // listens, and nothing in it -- an unwritable data directory, a full disk,
  // a failed read -- may keep the server, and so every Stop and the kill
  // switch, from coming up. What failed is logged; with no user written, the
  // next start is a first run again and tries again.
  try {
    await seedFirstRun();
  } catch (cause) {
    console.error(
      `[init] First-run seeding did not complete: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

async function seedFirstRun(): Promise<void> {
  const existing = await storage.getAllUsers();
  if (existing.length > 0) {
    return;
  }

  console.log("[init] First run: creating the admin account");

  let initial: ReturnType<typeof initialAdminPassword>;
  try {
    initial = initialAdminPassword(process.env);
  } catch (cause) {
    console.error(
      "[init] First run: the admin account was not created, because its generated password could not be " +
        `written to ${path.join(dataDirectory(), INITIAL_ADMIN_PASSWORD_FILE)}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Set ATHENA_INITIAL_ADMIN_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters, no whitespace at either end), ` +
        "or make the directory writable, and restart.",
    );
    return;
  }

  const admin = await storage.createUser({
    username: INITIAL_ADMIN_USERNAME,
    password: initial.password,
    email: null,
    role: "admin",
    isActive: true,
    mustChangePassword: true,
  });

  if (initial.file === null) {
    console.log(
      '[init] First run: created the admin account "admin" with the password set in ATHENA_INITIAL_ADMIN_PASSWORD. ' +
        "It must be changed at the first sign-in.",
    );
  } else {
    if (initial.refused !== null) {
      // Why, never the value.
      console.warn(`[init] ATHENA_INITIAL_ADMIN_PASSWORD was not used: ${initial.refused}.`);
    }
    console.log(
      `[init] First run: created the admin account "admin". Its generated password is in ${initial.file} ` +
        "(readable only by this user). Sign in with it and set a new one; then delete the file.",
    );
  }

  // The page's own ids: the installer used to write ids no screen knew
  // (LEGACY_SEEDED_SYSTEMS), and every switch read off over a record that
  // said three systems were on.
  await storage.updateAIControlSettings({
    systemStatus: "operational",
    killSwitchEnabled: false,
    activeSystems: [...DEFAULT_ACTIVE_SYSTEMS],
    maxConcurrentTests: 5,
    lastModifiedBy: admin.id,
  });

  if (!sampleSeedingRequested()) {
    console.log(
      "[init] No sample records written " +
        "(set ATHENA_SEED_SAMPLE_DATA=1 to seed them for a demo).",
    );
    return;
  }

  const sampleClients: InsertClient[] = [
    { name: "Acme Corporation", company: "Acme Corp", email: "security@acme.com", phone: "555-0100", notes: "Primary enterprise client - Monthly security assessments", isSample: true },
    { name: "TechStart Inc", company: "TechStart", email: "ciso@techstart.io", phone: "555-0200", notes: "Startup client - Quarterly penetration testing", isSample: true },
    { name: "Global Finance Ltd", company: "Global Finance", email: "compliance@globalfinance.com", phone: "555-0300", notes: "Financial sector client - Compliance-focused security", isSample: true },
  ];
  const clients = [];
  for (const clientData of sampleClients) {
    clients.push(await storage.createClient(clientData));
  }

  // Sites: the Tests screen offers a site picker, no client code creates one,
  // and nothing seeded any, so the picker could never contain a site.
  const sampleSites: InsertSite[] = [
    { clientId: clients[0].id, url: "https://acme.example.com", name: "Acme Production", environment: "production", status: "active", isSample: true },
    { clientId: clients[0].id, url: "https://staging.acme.example.com", name: "Acme Staging", environment: "staging", status: "active", isSample: true },
    { clientId: clients[1].id, url: "https://app.techstart.example.io", name: "TechStart App", environment: "production", status: "active", isSample: true },
    { clientId: clients[2].id, url: "https://portal.globalfinance.example.com", name: "Global Finance Portal", environment: "production", status: "active", isSample: true },
  ];
  const sites = [];
  for (const siteData of sampleSites) {
    sites.push(await storage.createSite(siteData));
  }

  const sampleTests: InsertTest[] = [
    {
      clientId: clients[0].id, siteId: sites[0].id, testType: "penetration-test", status: "completed", severity: "high",
      summary: "Quarterly penetration testing revealed 3 critical vulnerabilities",
      findings: { details: "SQL injection vulnerability in login form, XSS in user profile, Weak password policy" },
      vulnerabilitiesFound: 15, criticalCount: 3, highCount: 5, mediumCount: 4, lowCount: 3,
      executedBy: admin.id, completedAt: new Date(), isSample: true,
    },
    {
      clientId: clients[1].id, siteId: sites[2].id, testType: "vulnerability-scan", status: "in-progress", severity: "medium",
      summary: "Ongoing vulnerability assessment of cloud infrastructure", findings: null,
      vulnerabilitiesFound: 8, criticalCount: 0, highCount: 2, mediumCount: 4, lowCount: 2,
      executedBy: admin.id, completedAt: null, isSample: true,
    },
    {
      clientId: clients[2].id, siteId: null, testType: "compliance-audit", status: "pending", severity: "low",
      summary: "Scheduled PCI-DSS compliance audit", findings: null,
      vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      executedBy: admin.id, completedAt: null, isSample: true,
    },
  ];
  for (const testData of sampleTests) {
    await storage.createTest(testData);
  }

  const sampleDocuments: InsertDocument[] = [
    { clientId: clients[0].id, title: "Security Assessment Report Q1 2024", description: "Comprehensive security assessment findings and recommendations", documentType: "Report", fileUrl: "/documents/acme-q1-2024.pdf", createdBy: admin.id, isSample: true },
    { clientId: clients[1].id, title: "Penetration Test Results", description: "Full penetration test results with remediation guidelines", documentType: "Test Results", fileUrl: "/documents/techstart-pentest.pdf", createdBy: admin.id, isSample: true },
    { clientId: clients[2].id, title: "Compliance Checklist", description: "PCI-DSS compliance checklist and requirements", documentType: "Compliance", fileUrl: "/documents/globalfinance-compliance.pdf", createdBy: admin.id, isSample: true },
  ];
  for (const docData of sampleDocuments) {
    await storage.createDocument(docData);
  }

  // No AI health metric is seeded any more. The one that used to be written
  // here reported 98% success, 94% detection accuracy and a 3% false-positive
  // rate on a machine that had measured nothing, and it was the only row that
  // table ever held. server/health.ts takes a real reading a minute after the
  // server starts and every minute after that.

  await storage.createActivityLog({
    action: "seeded",
    entityType: "system",
    entityId: null,
    userId: admin.id,
    details: { clients: clients.length, tests: sampleTests.length, documents: sampleDocuments.length },
    ipAddress: null,
  });

  console.log("[init] Sample data created.");
}

/**
 * An install that kept a legacy default password, found and made to change it.
 *
 * Each account named in LEGACY_DEFAULT_USERNAMES that is not already flagged
 * is checked against the LEGACY_DEFAULT_PASSWORDS with verifyPassword -- at
 * most two key derivations per account, off the event loop, once per start.
 * A match sets mustChangePassword, so the account can do nothing but change
 * its password, sign out and send stops until it does; a warning names the
 * account, never the password.
 *
 * Called after the server is listening and never awaited by anything on a
 * stop's path. Best-effort: a read or write that fails is logged and the
 * start goes on. Returns the accounts it flagged.
 */
export async function flagLegacyDefaultPasswords(): Promise<string[]> {
  const flagged: string[] = [];
  for (const username of LEGACY_DEFAULT_USERNAMES) {
    try {
      const user: User | undefined = await storage.getUserByUsername(username);
      if (!user || user.mustChangePassword) continue;
      let match = false;
      for (const legacy of LEGACY_DEFAULT_PASSWORDS) {
        if ((await verifyPassword(legacy, user.password)).ok) {
          match = true;
          break;
        }
      }
      if (!match) continue;
      await storage.updateUser(user.id, { mustChangePassword: true });
      flagged.push(username);
      console.warn(
        `[init] The account "${username}" still has a default password an earlier release shipped with, ` +
          "which anyone who has read the public repository knows. It must set a new password at its next sign-in, " +
          "and can do nothing else but sign out and send stops until it does.",
      );
    } catch (cause) {
      console.error(
        `[init] Whether the account "${username}" still has a legacy default password could not be checked: ${
          cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return flagged;
}
