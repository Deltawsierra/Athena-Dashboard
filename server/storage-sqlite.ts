import { db } from "./db-sqlite";
import * as schema from "@shared/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import crypto from "crypto";
import { randomUUID } from "crypto";
import type { IStorage } from "./storage";
import { hashPassword, verifyPassword, dummyVerify } from "./password";
import { generateApiKey, hashApiKey, apiKeyPrefix } from "./api-keys";
import type {
  User, InsertUser,
  Client, InsertClient,
  Site, InsertSite,
  Test, InsertTest,
  Finding, InsertFinding,
  FindingSighting, FindingCheck,
  Document, InsertDocument,
  ActivityLog, InsertActivityLog,
  AIHealthMetric, InsertAIHealthMetric,
  AIControlSetting, InsertAIControlSetting,
  AIChatMessage, InsertAIChatMessage,
  Classifier, InsertClassifier,
  ConnectionSetting, UpdateConnectionSettings,
  SampleDataCounts,
  ApiKey,
} from "@shared/schema";

/**
 * SQLite backend. All methods are synchronous under the hood (better-sqlite3)
 * but exposed as async to satisfy IStorage.
 */
/** The settings table holds one row, and this is its id. */
const AI_CONTROL_ID = "singleton";
const CONNECTION_ID = "singleton";

/**
 * The keys of an update that actually carry a value.
 *
 * Counting keys instead meant `{ phone: undefined }` looked like a change and
 * reached drizzle's set() as an empty object, which throws "No values to set"
 * and surfaced as a 500.
 */
function definedKeys(updates: object): string[] {
  return Object.entries(updates)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

/** The severity counts a dashboard adds up, for one test. */
function countFindings(test: Test): number {
  return (test.criticalCount ?? 0) + (test.highCount ?? 0)
    + (test.mediumCount ?? 0) + (test.lowCount ?? 0);
}

export class SqliteStorage implements IStorage {
  // Users
  async getUser(id: string): Promise<User | undefined> {
    return db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  }
  async getUserByUsername(username: string): Promise<User | undefined> {
    return db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  }
  async getAllUsers(): Promise<User[]> {
    return db.select().from(schema.users).all();
  }
  async createUser(user: InsertUser): Promise<User> {
    const row: User = {
      email: null,
      isActive: true,
      ...user,
      password: hashPassword(user.password),
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    db.insert(schema.users).values(row).run();
    return (await this.getUser(row.id))!;
  }
  async updateUser(id: string, user: Partial<InsertUser>): Promise<User | undefined> {
    const updates = { ...user };
    if (updates.password) updates.password = hashPassword(updates.password);
    if (definedKeys(updates).length > 0) {
      db.update(schema.users).set(updates).where(eq(schema.users.id, id)).run();
    }
    return this.getUser(id);
  }
  async deleteUser(id: string): Promise<boolean> {
    return db.delete(schema.users).where(eq(schema.users.id, id)).run().changes > 0;
  }
  async validateUser(username: string, password: string): Promise<User | undefined> {
    const user = await this.getUserByUsername(username);
    if (!user) {
      // Spend the same work as a real check. Returning immediately made login
      // timing a username oracle: an unknown name answered in about a
      // twentieth of the time a real one took.
      dummyVerify(password);
      return undefined;
    }
    const result = verifyPassword(password, user.password);
    if (!result.ok) return undefined;
    if (result.needsRehash) {
      const rehashed = hashPassword(password);
      db.update(schema.users).set({ password: rehashed }).where(eq(schema.users.id, user.id)).run();
      user.password = rehashed;
    }
    return user;
  }

  // Clients
  async getClient(id: string): Promise<Client | undefined> {
    return db.select().from(schema.clients).where(eq(schema.clients.id, id)).get();
  }
  async getAllClients(): Promise<Client[]> {
    return db.select().from(schema.clients).all();
  }
  async createClient(client: InsertClient): Promise<Client> {
    const row: Client = {
      status: "active",
      phone: null,
      notes: null,
      lastTestDate: null,
      isSample: false,
      ...client,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    db.insert(schema.clients).values(row).run();
    return (await this.getClient(row.id))!;
  }
  async updateClient(id: string, client: Partial<InsertClient>): Promise<Client | undefined> {
    if (definedKeys(client).length > 0) {
      db.update(schema.clients).set(client).where(eq(schema.clients.id, id)).run();
    }
    return this.getClient(id);
  }
  async deleteClient(id: string): Promise<boolean> {
    // There are no foreign keys, so the children are removed here. Without
    // this, deleting a client orphaned its tests, sites and documents, which
    // then referenced an id that no longer existed.
    const removed = db.transaction(() => {
      db.delete(schema.tests).where(eq(schema.tests.clientId, id)).run();
      db.delete(schema.sites).where(eq(schema.sites.clientId, id)).run();
      db.delete(schema.documents).where(eq(schema.documents.clientId, id)).run();
      return db.delete(schema.clients).where(eq(schema.clients.id, id)).run().changes > 0;
    });
    return removed;
  }

  // Sites
  async getSite(id: string): Promise<Site | undefined> {
    return db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
  }
  async getAllSites(): Promise<Site[]> {
    return db.select().from(schema.sites).all();
  }
  async getSitesByClient(clientId: string): Promise<Site[]> {
    return db.select().from(schema.sites).where(eq(schema.sites.clientId, clientId)).all();
  }
  async createSite(site: InsertSite): Promise<Site> {
    const row: Site = {
      environment: "production",
      status: "active",
      isSample: false,
      ...site,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    db.insert(schema.sites).values(row).run();
    return (await this.getSite(row.id))!;
  }
  async updateSite(id: string, site: Partial<InsertSite>): Promise<Site | undefined> {
    if (definedKeys(site).length > 0) {
      db.update(schema.sites).set(site).where(eq(schema.sites.id, id)).run();
    }
    return this.getSite(id);
  }
  async deleteSite(id: string): Promise<boolean> {
    return db.delete(schema.sites).where(eq(schema.sites.id, id)).run().changes > 0;
  }

  // Tests
  async getTest(id: string): Promise<Test | undefined> {
    return db.select().from(schema.tests).where(eq(schema.tests.id, id)).get();
  }
  async getAllTests(): Promise<Test[]> {
    return db.select().from(schema.tests).all();
  }
  async getTestsByClient(clientId: string): Promise<Test[]> {
    return db.select().from(schema.tests).where(eq(schema.tests.clientId, clientId)).all();
  }
  async getTestsBySite(siteId: string): Promise<Test[]> {
    return db.select().from(schema.tests).where(eq(schema.tests.siteId, siteId)).all();
  }
  // Findings
  async getFinding(id: string): Promise<Finding | undefined> {
    return db.select().from(schema.findings).where(eq(schema.findings.id, id)).get();
  }
  async getFindingsByClient(clientId: string): Promise<Finding[]> {
    return db.select().from(schema.findings)
      .where(eq(schema.findings.clientId, clientId)).all();
  }
  async findFindingByFingerprint(
    clientId: string, fingerprint: string,
  ): Promise<Finding | undefined> {
    // Keyed on the customer, which is what the unique index is on. Not the
    // engagement string: one customer scanned with a site named and again
    // without it yields two engagement references for the same issue.
    return db.select().from(schema.findings)
      .where(and(
        eq(schema.findings.clientId, clientId),
        eq(schema.findings.fingerprint, fingerprint),
      )).get();
  }
  async createFinding(insert: InsertFinding): Promise<Finding> {
    const now = new Date();
    const row: Finding = {
      siteId: null, severity: null, message: null, target: null,
      endpoint: null, header: null, status: "open", ownerId: null,
      statusNote: null, statusChangedBy: null, statusChangedAt: null,
      timesSeen: 1, lastTestId: null, lastRunId: null,
      fixedAt: null, fixedByRunId: null, fixedVerdict: null, reopenedAt: null,
      isSample: false,
      ...insert,
      id: randomUUID(),
      firstSeenAt: now,
      lastSeenAt: now,
    } as Finding;
    db.insert(schema.findings).values(row).run();
    return row;
  }
  async recordSighting(
    findingId: string, runId: string | null, testId: string | null, seen: boolean,
  ): Promise<void> {
    // Idempotent per (finding, run): the status route can poll the same run
    // more than once and must not write the same observation again.
    const already = db.select().from(schema.findingSightings)
      .where(and(
        eq(schema.findingSightings.findingId, findingId),
        runId === null
          ? isNull(schema.findingSightings.runId)
          : eq(schema.findingSightings.runId, runId),
      )).get();
    if (already) {
      db.update(schema.findingSightings).set({ seen })
        .where(eq(schema.findingSightings.id, already.id)).run();
      return;
    }
    db.insert(schema.findingSightings).values({
      id: randomUUID(), findingId, runId, testId, seen, observedAt: new Date(),
    }).run();
  }
  async getSightings(findingId: string): Promise<FindingSighting[]> {
    return db.select().from(schema.findingSightings)
      .where(eq(schema.findingSightings.findingId, findingId)).all();
  }
  async filedSeriousFindings(testId: string): Promise<{ critical: number; high: number }> {
    // Distinct findings: a finding sighted twice by one test is one finding.
    // Served by idx_sightings_test, then the findings primary key.
    const severity = sql<string>`lower(coalesce(${schema.findings.severity}, ''))`;
    const rows = db.select({ severity, n: sql<number>`count(distinct ${schema.findings.id})` })
      .from(schema.findingSightings)
      .innerJoin(schema.findings, eq(schema.findings.id, schema.findingSightings.findingId))
      .where(and(eq(schema.findingSightings.testId, testId), eq(schema.findingSightings.seen, true)))
      .groupBy(severity)
      .all();
    const counts = { critical: 0, high: 0 };
    for (const row of rows) {
      if (row.severity === "critical" || row.severity === "high") counts[row.severity] = Number(row.n);
    }
    return counts;
  }
  async recordCheck(check: Omit<FindingCheck, "id" | "checkedAt">): Promise<FindingCheck> {
    const row: FindingCheck = { ...check, id: randomUUID(), checkedAt: new Date() };
    db.insert(schema.findingChecks).values(row).run();
    return row;
  }
  async getChecks(findingId: string): Promise<FindingCheck[]> {
    return db.select().from(schema.findingChecks)
      .where(eq(schema.findingChecks.findingId, findingId)).all();
  }

  async updateFinding(id: string, patch: Partial<Finding>): Promise<Finding | undefined> {
    const { id: _ignored, ...fields } = patch;
    if (Object.keys(fields).length > 0) {
      db.update(schema.findings).set(fields).where(eq(schema.findings.id, id)).run();
    }
    return this.getFinding(id);
  }

  async createTest(test: InsertTest): Promise<Test> {
    const row: Test = {
      status: "pending",
      siteId: null,
      severity: null,
      completedAt: null,
      summary: null,
      findings: null,
      vulnerabilitiesFound: 0,
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      executedBy: null,
      isSample: false,
      ...test,
      id: crypto.randomUUID(),
      startedAt: new Date(),
    };
    db.insert(schema.tests).values(row).run();
    return (await this.getTest(row.id))!;
  }
  async updateTest(id: string, test: Partial<InsertTest>): Promise<Test | undefined> {
    if (definedKeys(test).length > 0) {
      db.update(schema.tests).set(test).where(eq(schema.tests.id, id)).run();
    }
    return this.getTest(id);
  }
  async deleteTest(id: string): Promise<boolean> {
    return db.delete(schema.tests).where(eq(schema.tests.id, id)).run().changes > 0;
  }

  // Documents
  async getDocument(id: string): Promise<Document | undefined> {
    return db.select().from(schema.documents).where(eq(schema.documents.id, id)).get();
  }
  async getAllDocuments(): Promise<Document[]> {
    return db.select().from(schema.documents).all();
  }
  async getDocumentsByClient(clientId: string): Promise<Document[]> {
    return db.select().from(schema.documents).where(eq(schema.documents.clientId, clientId)).all();
  }
  async createDocument(document: InsertDocument): Promise<Document> {
    const now = new Date();
    const row: Document = {
      description: null,
      fileUrl: null,
      createdBy: null,
      isSample: false,
      ...document,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    db.insert(schema.documents).values(row).run();
    return (await this.getDocument(row.id))!;
  }
  async updateDocument(id: string, document: Partial<InsertDocument>): Promise<Document | undefined> {
    db.update(schema.documents)
      .set({ ...document, updatedAt: new Date() })
      .where(eq(schema.documents.id, id))
      .run();
    return this.getDocument(id);
  }
  async deleteDocument(id: string): Promise<boolean> {
    return db.delete(schema.documents).where(eq(schema.documents.id, id)).run().changes > 0;
  }

  // Sample data
  async countSampleData(): Promise<SampleDataCounts> {
    const tests = db.select().from(schema.tests)
      .where(eq(schema.tests.isSample, true)).all();
    return {
      clients: db.select().from(schema.clients).where(eq(schema.clients.isSample, true)).all().length,
      sites: db.select().from(schema.sites).where(eq(schema.sites.isSample, true)).all().length,
      tests: tests.length,
      documents: db.select().from(schema.documents).where(eq(schema.documents.isSample, true)).all().length,
      findings: tests.reduce((sum, test) => sum + countFindings(test), 0),
    };
  }
  async removeSampleData(): Promise<SampleDataCounts> {
    const removed = await this.countSampleData();
    // One transaction: a half-removed seed leaves a dashboard whose notice
    // says one thing and whose figures say another, which is worse than
    // either state on its own.
    db.transaction(() => {
      db.delete(schema.tests).where(eq(schema.tests.isSample, true)).run();
      db.delete(schema.documents).where(eq(schema.documents.isSample, true)).run();
      db.delete(schema.sites).where(eq(schema.sites.isSample, true)).run();
      db.delete(schema.clients).where(eq(schema.clients.isSample, true)).run();
    });
    return removed;
  }

  // Activity logs
  async getAllActivityLogs(): Promise<ActivityLog[]> {
    return db.select().from(schema.activityLogs).orderBy(desc(schema.activityLogs.timestamp)).all();
  }
  async getActivityLogsByEntity(entityType: string, entityId: string): Promise<ActivityLog[]> {
    return db
      .select()
      .from(schema.activityLogs)
      .where(and(eq(schema.activityLogs.entityType, entityType), eq(schema.activityLogs.entityId, entityId)))
      .orderBy(desc(schema.activityLogs.timestamp))
      .all();
  }
  async createActivityLog(log: InsertActivityLog): Promise<ActivityLog> {
    const row: ActivityLog = {
      entityId: null,
      userId: null,
      details: null,
      ipAddress: null,
      ...log,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };
    db.insert(schema.activityLogs).values(row).run();
    return db.select().from(schema.activityLogs).where(eq(schema.activityLogs.id, row.id)).get()!;
  }

  // AI health
  async getLatestAIHealthMetric(): Promise<AIHealthMetric | undefined> {
    return db.select().from(schema.aiHealthMetrics).orderBy(desc(schema.aiHealthMetrics.timestamp)).limit(1).get();
  }
  async getAIHealthMetrics(limit: number): Promise<AIHealthMetric[]> {
    return db
      .select()
      .from(schema.aiHealthMetrics)
      .orderBy(desc(schema.aiHealthMetrics.timestamp))
      .limit(Math.max(1, Math.min(limit, 1000)))
      .all();
  }
  async createAIHealthMetric(metric: InsertAIHealthMetric): Promise<AIHealthMetric> {
    const row: AIHealthMetric = {
      activeScans: 0,
      totalScansToday: 0,
      modelsLoaded: null,
      lastTrainingDate: null,
      // Null, not zero. A figure nobody measured is absent; zero would read
      // as a measured zero, which for a detection accuracy is a claim.
      successRate: null,
      averageResponseTime: null,
      detectionAccuracy: null,
      falsePositiveRate: null,
      guardsChecked: null,
      guardsFailing: null,
      ...metric,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };
    db.insert(schema.aiHealthMetrics).values(row).run();
    return db.select().from(schema.aiHealthMetrics).where(eq(schema.aiHealthMetrics.id, row.id)).get()!;
  }

  // AI control: exactly one row, under a fixed id.
  //
  // It used to be "the first row we find", created on first update with a
  // random id and no constraint, so two concurrent updates each inserted a row
  // and one of the two settings was silently lost. Later writes then updated
  // only one of the duplicates.
  // Where this deployment talks to. One row, like the AI control settings
  // below, and written whole rather than merged column by column so a form
  // that clears a field actually clears it.
  async getConnectionSettings(): Promise<ConnectionSetting | undefined> {
    return db
      .select()
      .from(schema.connectionSettings)
      .where(eq(schema.connectionSettings.id, CONNECTION_ID))
      .get();
  }

  async updateConnectionSettings(
    settings: UpdateConnectionSettings, updatedBy: string | null,
  ): Promise<ConnectionSetting> {
    const existing = await this.getConnectionSettings();
    const now = new Date();
    if (!existing) {
      db.insert(schema.connectionSettings).values({
        engineUrl: null, engineKey: null,
        assistantUrl: null, assistantKey: null, assistantModel: null,
        ...settings,
        id: CONNECTION_ID, updatedAt: now, updatedBy,
      } as any).run();
      return (await this.getConnectionSettings())!;
    }
    db.update(schema.connectionSettings)
      .set({ ...settings, updatedAt: now, updatedBy } as any)
      .where(eq(schema.connectionSettings.id, existing.id))
      .run();
    return (await this.getConnectionSettings())!;
  }

  async getAIControlSettings(): Promise<AIControlSetting | undefined> {
    return db
      .select()
      .from(schema.aiControlSettings)
      .where(eq(schema.aiControlSettings.id, AI_CONTROL_ID))
      .get();
  }
  async updateAIControlSettings(settings: Partial<InsertAIControlSetting>): Promise<AIControlSetting> {
    const existing = await this.getAIControlSettings();
    const now = new Date();
    if (!existing) {
      const row: AIControlSetting = {
        systemStatus: "active",
        killSwitchEnabled: false,
        overrideMode: false,
        activeSystems: [],
        maxConcurrentTests: 5,
        autoShutdownThreshold: 90,
        lastModifiedBy: null,
        ...settings,
        id: AI_CONTROL_ID,
        lastModifiedAt: now,
      };
      db.insert(schema.aiControlSettings).values(row).onConflictDoUpdate({
        target: schema.aiControlSettings.id,
        set: { ...settings, lastModifiedAt: now },
      }).run();
      return (await this.getAIControlSettings())!;
    }
    db.update(schema.aiControlSettings)
      .set({ ...settings, lastModifiedAt: now })
      .where(eq(schema.aiControlSettings.id, existing.id))
      .run();
    return (await this.getAIControlSettings())!;
  }

  // Chat
  async getChatMessage(id: string): Promise<AIChatMessage | undefined> {
    return db.select().from(schema.aiChatMessages).where(eq(schema.aiChatMessages.id, id)).get();
  }
  async getAllChatMessages(): Promise<AIChatMessage[]> {
    return db.select().from(schema.aiChatMessages).orderBy(schema.aiChatMessages.timestamp).all();
  }
  async getChatMessagesByUser(userId: string): Promise<AIChatMessage[]> {
    return db
      .select()
      .from(schema.aiChatMessages)
      .where(eq(schema.aiChatMessages.userId, userId))
      .orderBy(schema.aiChatMessages.timestamp)
      .all();
  }
  async createChatMessage(message: InsertAIChatMessage): Promise<AIChatMessage> {
    const row: AIChatMessage = {
      attachments: null,
      ...message,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };
    db.insert(schema.aiChatMessages).values(row).run();
    return (await this.getChatMessage(row.id))!;
  }
  async deleteChatMessage(id: string): Promise<boolean> {
    return db.delete(schema.aiChatMessages).where(eq(schema.aiChatMessages.id, id)).run().changes > 0;
  }

  // Classifiers
  async getAllClassifiers(): Promise<Classifier[]> {
    return db.select().from(schema.classifiers).all();
  }
  async getClassifier(id: string): Promise<Classifier | undefined> {
    return db.select().from(schema.classifiers).where(eq(schema.classifiers.id, id)).get();
  }
  async createClassifier(classifier: InsertClassifier): Promise<Classifier> {
    const row: Classifier = {
      status: "active",
      trainingDataSize: 0,
      lastTrainedAt: null,
      description: null,
      ...classifier,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    db.insert(schema.classifiers).values(row).run();
    return (await this.getClassifier(row.id))!;
  }
  async updateClassifier(id: string, classifier: Partial<InsertClassifier>): Promise<Classifier | undefined> {
    if (definedKeys(classifier).length > 0) {
      db.update(schema.classifiers).set(classifier).where(eq(schema.classifiers.id, id)).run();
    }
    return this.getClassifier(id);
  }
  async deleteClassifier(id: string): Promise<boolean> {
    return db.delete(schema.classifiers).where(eq(schema.classifiers.id, id)).run().changes > 0;
  }

  // API keys
  async getAllApiKeys(): Promise<ApiKey[]> {
    return db.select().from(schema.apiKeys).orderBy(desc(schema.apiKeys.createdAt)).all();
  }
  async getApiKey(id: string): Promise<ApiKey | undefined> {
    return db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
  }
  async createApiKey(input: { name: string; createdBy: string | null }): Promise<{ key: ApiKey; secret: string }> {
    const secret = generateApiKey();
    const row: ApiKey = {
      id: crypto.randomUUID(),
      name: input.name,
      prefix: apiKeyPrefix(secret),
      keyHash: hashApiKey(secret),
      createdBy: input.createdBy,
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
    };
    db.insert(schema.apiKeys).values(row).run();
    return { key: (await this.getApiKey(row.id))!, secret };
  }
  async findActiveApiKeyByHash(keyHash: string): Promise<ApiKey | undefined> {
    return db
      .select()
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.keyHash, keyHash), isNull(schema.apiKeys.revokedAt)))
      .get();
  }
  async touchApiKey(id: string): Promise<void> {
    db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, id)).run();
  }
  async revokeApiKey(id: string): Promise<ApiKey | undefined> {
    const existing = await this.getApiKey(id);
    if (!existing) return undefined;
    if (existing.revokedAt == null) {
      db.update(schema.apiKeys).set({ revokedAt: new Date() }).where(eq(schema.apiKeys.id, id)).run();
    }
    return this.getApiKey(id);
  }
}

export const storage = new SqliteStorage();
