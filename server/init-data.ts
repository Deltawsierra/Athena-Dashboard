import { storage } from "./storage-unified";
import type { InsertUser, InsertClient, InsertTest, InsertDocument, InsertSite } from "@shared/schema";

/**
 * First-run seeding. Runs only when the users table is empty.
 *
 * Default credentials (change them after first login):
 *   admin      / admin123     (admin)
 *   testadmin  / testpass123  (admin)
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

export async function initializeDefaultData(): Promise<void> {
  const existing = await storage.getAllUsers();
  if (existing.length > 0) {
    return;
  }

  console.log("[init] First run: creating default users");

  const adminUser: InsertUser = {
    username: "admin",
    password: "admin123",
    email: "admin@athena.ai",
    role: "admin",
    isActive: true,
  };
  const admin = await storage.createUser(adminUser);

  const testUser: InsertUser = {
    username: "testadmin",
    password: "testpass123",
    email: "test@athena.ai",
    role: "admin",
    isActive: true,
  };
  await storage.createUser(testUser);

  await storage.updateAIControlSettings({
    systemStatus: "operational",
    killSwitchEnabled: false,
    overrideMode: false,
    activeSystems: ["threat_detection", "vulnerability_scanner", "log_analyzer"],
    maxConcurrentTests: 5,
    autoShutdownThreshold: 90,
    lastModifiedBy: admin.id,
  });

  if (!sampleSeedingRequested()) {
    console.log(
      "[init] Default users created. No sample records written " +
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

  console.log("[init] Default users and sample data created. Default login: admin / admin123");
}
