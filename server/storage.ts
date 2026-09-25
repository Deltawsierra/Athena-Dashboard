import {
  type User, type InsertUser,
  type Client, type InsertClient,
  type Site, type InsertSite,
  type Test, type InsertTest,
  type Finding, type InsertFinding,
  type FindingSighting, type FindingCheck,
  type Document, type InsertDocument,
  type ActivityLog, type InsertActivityLog,
  type AIHealthMetric, type InsertAIHealthMetric,
  type AIControlSetting, type InsertAIControlSetting,
  type AIChatMessage, type InsertAIChatMessage,
  type Classifier, type InsertClassifier,
  type ConnectionSetting, type UpdateConnectionSettings,
  type SampleDataCounts,
  type ApiKey,
} from "@shared/schema";
import { randomUUID } from "crypto";
import { DEFAULT_ACTIVE_SYSTEMS } from "@shared/ai-systems";
import { hashPassword, verifyPassword, dummyVerify } from "./password";
import { generateApiKey, hashApiKey, apiKeyPrefix } from "./api-keys";

/**
 * The single storage contract. Both the SQLite backend (production) and the
 * in-memory backend (tests) implement exactly this interface, so routes never
 * need to know which one is active.
 */
export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, user: Partial<InsertUser>): Promise<User | undefined>;
  deleteUser(id: string): Promise<boolean>;
  /** Returns the user when the credentials match; re-hashes legacy passwords. */
  validateUser(username: string, password: string): Promise<User | undefined>;

  // Clients
  getClient(id: string): Promise<Client | undefined>;
  getAllClients(): Promise<Client[]>;
  createClient(client: InsertClient): Promise<Client>;
  updateClient(id: string, client: Partial<InsertClient>): Promise<Client | undefined>;
  deleteClient(id: string): Promise<boolean>;

  // Sites
  getSite(id: string): Promise<Site | undefined>;
  getAllSites(): Promise<Site[]>;
  getSitesByClient(clientId: string): Promise<Site[]>;
  createSite(site: InsertSite): Promise<Site>;
  updateSite(id: string, site: Partial<InsertSite>): Promise<Site | undefined>;
  deleteSite(id: string): Promise<boolean>;

  // Tests
  getTest(id: string): Promise<Test | undefined>;
  getAllTests(): Promise<Test[]>;
  getTestsByClient(clientId: string): Promise<Test[]>;
  getTestsBySite(siteId: string): Promise<Test[]>;
  createTest(test: InsertTest): Promise<Test>;
  updateTest(id: string, test: Partial<InsertTest>): Promise<Test | undefined>;
  deleteTest(id: string): Promise<boolean>;

  // Findings
  getFinding(id: string): Promise<Finding | undefined>;
  getFindingsByClient(clientId: string): Promise<Finding[]>;
  /** The row this issue already has in this engagement, if any. */
  findFindingByFingerprint(clientId: string, fingerprint: string): Promise<Finding | undefined>;
  createFinding(finding: InsertFinding): Promise<Finding>;
  updateFinding(id: string, finding: Partial<Finding>): Promise<Finding | undefined>;
  /** What a run observed. Idempotent per (finding, run). */
  recordSighting(findingId: string, runId: string | null, testId: string | null, seen: boolean): Promise<void>;
  getSightings(findingId: string): Promise<FindingSighting[]>;
  /**
   * How many distinct findings this test sighted as seen, at critical and at
   * high (by each finding's severity, case-insensitively). The engine's scans
   * file every result they return, folded into distinct issues at the worst
   * severity each was reported at; a test a person records on the Tests
   * screen files none. The findings summary compares these with what the test
   * reported: a boolean "filed anything" read a scan that reported a critical
   * and filed only a medium as fully tracked.
   */
  filedSeriousFindings(testId: string): Promise<{ critical: number; high: number }>;
  /** A retest, appended. Never replaces an earlier one. */
  recordCheck(check: Omit<FindingCheck, "id" | "checkedAt">): Promise<FindingCheck>;
  getChecks(findingId: string): Promise<FindingCheck[]>;

  // Documents
  getDocument(id: string): Promise<Document | undefined>;
  getAllDocuments(): Promise<Document[]>;
  getDocumentsByClient(clientId: string): Promise<Document[]>;
  createDocument(document: InsertDocument): Promise<Document>;
  updateDocument(id: string, document: Partial<InsertDocument>): Promise<Document | undefined>;
  deleteDocument(id: string): Promise<boolean>;

  /**
   * How much of what the screens are showing was written by the installer.
   *
   * Counted rather than assumed: a deployment that seeded once and has been
   * used since has both kinds of row in the same tables, and "sample data is
   * present" is not the same statement as "these three tests are samples".
   */
  countSampleData(): Promise<SampleDataCounts>;
  /** Remove every seeded row. Real records are untouched. */
  removeSampleData(): Promise<SampleDataCounts>;

  // Activity logs
  getAllActivityLogs(): Promise<ActivityLog[]>;
  getActivityLogsByEntity(entityType: string, entityId: string): Promise<ActivityLog[]>;
  createActivityLog(log: InsertActivityLog): Promise<ActivityLog>;

  // AI health
  getLatestAIHealthMetric(): Promise<AIHealthMetric | undefined>;
  getAIHealthMetrics(limit: number): Promise<AIHealthMetric[]>;
  createAIHealthMetric(metric: InsertAIHealthMetric): Promise<AIHealthMetric>;

  // AI control (single row)
  getConnectionSettings(): Promise<ConnectionSetting | undefined>;
  updateConnectionSettings(
    settings: UpdateConnectionSettings, updatedBy: string | null,
  ): Promise<ConnectionSetting>;
  getAIControlSettings(): Promise<AIControlSetting | undefined>;
  updateAIControlSettings(settings: Partial<InsertAIControlSetting>): Promise<AIControlSetting>;

  // Chat
  getChatMessage(id: string): Promise<AIChatMessage | undefined>;
  getAllChatMessages(): Promise<AIChatMessage[]>;
  getChatMessagesByUser(userId: string): Promise<AIChatMessage[]>;
  createChatMessage(message: InsertAIChatMessage): Promise<AIChatMessage>;
  deleteChatMessage(id: string): Promise<boolean>;

  // Classifiers
  getAllClassifiers(): Promise<Classifier[]>;
  getClassifier(id: string): Promise<Classifier | undefined>;
  createClassifier(classifier: InsertClassifier): Promise<Classifier>;
  updateClassifier(id: string, classifier: Partial<InsertClassifier>): Promise<Classifier | undefined>;
  deleteClassifier(id: string): Promise<boolean>;

  // API keys. The plaintext secret is generated here and returned exactly once,
  // by createApiKey; only its hash is ever stored. Every other method deals in
  // the stored record, never the secret.
  getAllApiKeys(): Promise<ApiKey[]>;
  /** Mint a key: returns the stored record AND the one-time plaintext secret. */
  createApiKey(input: { name: string; createdBy: string | null }): Promise<{ key: ApiKey; secret: string }>;
  /** The live (not revoked) key whose secret hashes to this, if any. */
  findActiveApiKeyByHash(keyHash: string): Promise<ApiKey | undefined>;
  /** Record that a key was just used to authenticate a request. */
  touchApiKey(id: string): Promise<void>;
  /** Revoke a key: it is kept for the audit trail but never authenticates again. */
  revokeApiKey(id: string): Promise<ApiKey | undefined>;
}

function defaultControlSettings(): AIControlSetting {
  return {
    id: randomUUID(),
    systemStatus: "active",
    killSwitchEnabled: false,
    overrideMode: false,
    // Every system this build can switch, on: an install that has never
    // touched the AI Control page scans as it always did.
    activeSystems: [...DEFAULT_ACTIVE_SYSTEMS],
    maxConcurrentTests: 5,
    autoShutdownThreshold: 90,
    lastModifiedBy: null,
    lastModifiedAt: new Date(),
  };
}

/** In-memory backend. Used by tests and by ATHENA_STORAGE=memory. */

/**
 * Return a copy, never the stored object.
 *
 * The in-memory backend used to hand out live references, so a caller that
 * mutated a returned record rewrote the store behind everyone's back. The
 * SQLite backend cannot do that, and the two must behave alike.
 */
function copy<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : ({ ...(value as object) } as T);
}

/**
 * A test's findings, as the dashboard adds them up.
 *
 * vulnerabilitiesFound is a separate column the seeder set to 15 while the
 * severity counts add to 15 as well; the dashboard sums the severities, so
 * that is what "findings" has to mean here or the notice reports a different
 * number from the figure it is explaining.
 */
function countFindings(test: Test): number {
  return (test.criticalCount ?? 0) + (test.highCount ?? 0)
    + (test.mediumCount ?? 0) + (test.lowCount ?? 0);
}

export class MemStorage implements IStorage {
  private users = new Map<string, User>();
  private clients = new Map<string, Client>();
  private sites = new Map<string, Site>();
  private tests = new Map<string, Test>();
  private documents = new Map<string, Document>();
  private activityLogs = new Map<string, ActivityLog>();
  private aiHealthMetrics = new Map<string, AIHealthMetric>();
  private aiControlSettings: AIControlSetting | undefined = defaultControlSettings();
  private connectionSettings: ConnectionSetting | undefined;
  private chatMessages = new Map<string, AIChatMessage>();
  private classifiers = new Map<string, Classifier>();
  private apiKeys = new Map<string, ApiKey>();

  // Users
  async getUser(id: string) { return this.users.get(id); }
  async getUserByUsername(username: string) {
    return Array.from(this.users.values()).find((u) => u.username === username);
  }
  async getAllUsers() { return Array.from(this.users.values()); }
  async createUser(insertUser: InsertUser): Promise<User> {
    // SQLite enforces users.username UNIQUE and this backend did not, so the
    // two disagreed about a duplicate: here the second row was accepted and
    // could then never sign in, because the lookup returns the first.
    const clash = Array.from(this.users.values()).some(
      (existing) => existing.username === insertUser.username,
    );
    if (clash) {
      const error = new Error("UNIQUE constraint failed: users.username") as Error & { code?: string };
      error.code = "SQLITE_CONSTRAINT_UNIQUE";
      throw error;
    }

    const user: User = {
      email: null,
      isActive: true,
      ...insertUser,
      password: hashPassword(insertUser.password),
      id: randomUUID(),
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }
  async updateUser(id: string, updates: Partial<InsertUser>) {
    const user = this.users.get(id);
    if (!user) return undefined;
    const next = { ...updates };
    if (next.password) next.password = hashPassword(next.password);
    const updated: User = { ...user, ...next };
    this.users.set(id, updated);
    return updated;
  }
  async deleteUser(id: string) { return this.users.delete(id); }
  async validateUser(username: string, password: string) {
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
      user.password = hashPassword(password);
      this.users.set(user.id, user);
    }
    return user;
  }

  // Clients
  async getClient(id: string) { return this.clients.get(id); }
  async getAllClients() { return Array.from(this.clients.values()); }
  async createClient(insertClient: InsertClient): Promise<Client> {
    const client: Client = {
      status: "active",
      phone: null,
      notes: null,
      lastTestDate: null,
      isSample: false,
      ...insertClient,
      id: randomUUID(),
      createdAt: new Date(),
    };
    this.clients.set(client.id, client);
    return client;
  }
  async updateClient(id: string, updates: Partial<InsertClient>) {
    const client = this.clients.get(id);
    if (!client) return undefined;
    const updated: Client = { ...client, ...updates };
    this.clients.set(id, updated);
    return updated;
  }
  async deleteClient(id: string) {
    // Match the SQLite backend, which removes the client's children with it.
    for (const [testId, test] of Array.from(this.tests.entries())) {
      if (test.clientId === id) this.tests.delete(testId);
    }
    for (const [siteId, site] of Array.from(this.sites.entries())) {
      if (site.clientId === id) this.sites.delete(siteId);
    }
    for (const [docId, doc] of Array.from(this.documents.entries())) {
      if (doc.clientId === id) this.documents.delete(docId);
    }
    return this.clients.delete(id);
  }

  // Sites
  async getSite(id: string) { return this.sites.get(id); }
  async getAllSites() { return Array.from(this.sites.values()); }
  async getSitesByClient(clientId: string) {
    return Array.from(this.sites.values()).filter((s) => s.clientId === clientId);
  }
  async createSite(insertSite: InsertSite): Promise<Site> {
    const site: Site = {
      environment: "production",
      status: "active",
      isSample: false,
      ...insertSite,
      id: randomUUID(),
      createdAt: new Date(),
    };
    this.sites.set(site.id, site);
    return site;
  }
  async updateSite(id: string, updates: Partial<InsertSite>) {
    const site = this.sites.get(id);
    if (!site) return undefined;
    const updated: Site = { ...site, ...updates };
    this.sites.set(id, updated);
    return updated;
  }
  async deleteSite(id: string) { return this.sites.delete(id); }

  // Tests
  async getTest(id: string) { return this.tests.get(id); }
  async getAllTests() { return Array.from(this.tests.values()); }
  async getTestsByClient(clientId: string) {
    return Array.from(this.tests.values()).filter((t) => t.clientId === clientId);
  }
  async getTestsBySite(siteId: string) {
    return Array.from(this.tests.values()).filter((t) => t.siteId === siteId);
  }
  // Findings
  private findings = new Map<string, Finding>();

  async getFinding(id: string) { return this.findings.get(id); }
  async getFindingsByClient(clientId: string) {
    return Array.from(this.findings.values()).filter((f) => f.clientId === clientId);
  }
  async findFindingByFingerprint(clientId: string, fingerprint: string) {
    return Array.from(this.findings.values()).find(
      (f) => f.clientId === clientId && f.fingerprint === fingerprint,
    );
  }
  async createFinding(insert: InsertFinding): Promise<Finding> {
    const now = new Date();
    const finding: Finding = {
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
    this.findings.set(finding.id, finding);
    return finding;
  }
  async updateFinding(id: string, patch: Partial<Finding>) {
    const existing = this.findings.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch, id: existing.id };
    this.findings.set(id, updated);
    return updated;
  }

  private sightings: FindingSighting[] = [];
  private checks: FindingCheck[] = [];

  async recordSighting(findingId: string, runId: string | null, testId: string | null, seen: boolean) {
    // One observation per finding per run: a status poll that fires twice on
    // the same run must not write the same fact twice.
    const already = this.sightings.find(
      (one) => one.findingId === findingId && one.runId === runId,
    );
    if (already) { already.seen = seen; return; }
    this.sightings.push({
      id: randomUUID(), findingId, runId, testId, seen, observedAt: new Date(),
    });
  }
  async getSightings(findingId: string) {
    return this.sightings.filter((one) => one.findingId === findingId);
  }
  async filedSeriousFindings(testId: string) {
    const ids = new Set(
      this.sightings.filter((one) => one.testId === testId && one.seen).map((one) => one.findingId),
    );
    const counts = { critical: 0, high: 0 };
    for (const id of Array.from(ids)) {
      const severity = (this.findings.get(id)?.severity ?? "").toLowerCase();
      if (severity === "critical" || severity === "high") counts[severity] += 1;
    }
    return counts;
  }
  async recordCheck(check: Omit<FindingCheck, "id" | "checkedAt">) {
    const row: FindingCheck = { ...check, id: randomUUID(), checkedAt: new Date() };
    this.checks.push(row);
    return row;
  }
  async getChecks(findingId: string) {
    return this.checks.filter((one) => one.findingId === findingId);
  }

  async createTest(insertTest: InsertTest): Promise<Test> {
    const test: Test = {
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
      ...insertTest,
      id: randomUUID(),
      startedAt: new Date(),
    };
    this.tests.set(test.id, test);
    return test;
  }
  async updateTest(id: string, updates: Partial<InsertTest>) {
    const test = this.tests.get(id);
    if (!test) return undefined;
    const updated: Test = { ...test, ...updates };
    this.tests.set(id, updated);
    return updated;
  }
  async deleteTest(id: string) { return this.tests.delete(id); }

  // Documents
  async getDocument(id: string) { return this.documents.get(id); }
  async getAllDocuments() { return Array.from(this.documents.values()); }
  async getDocumentsByClient(clientId: string) {
    return Array.from(this.documents.values()).filter((d) => d.clientId === clientId);
  }
  async createDocument(insertDocument: InsertDocument): Promise<Document> {
    const now = new Date();
    const document: Document = {
      description: null,
      fileUrl: null,
      createdBy: null,
      isSample: false,
      ...insertDocument,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.documents.set(document.id, document);
    return document;
  }
  async updateDocument(id: string, updates: Partial<InsertDocument>) {
    const document = this.documents.get(id);
    if (!document) return undefined;
    const updated: Document = { ...document, ...updates, updatedAt: new Date() };
    this.documents.set(id, updated);
    return updated;
  }
  async deleteDocument(id: string) { return this.documents.delete(id); }

  // Sample data
  async countSampleData(): Promise<SampleDataCounts> {
    const clients = Array.from(this.clients.values()).filter((one) => one.isSample);
    const sites = Array.from(this.sites.values()).filter((one) => one.isSample);
    const tests = Array.from(this.tests.values()).filter((one) => one.isSample);
    const documents = Array.from(this.documents.values()).filter((one) => one.isSample);
    return {
      clients: clients.length,
      sites: sites.length,
      tests: tests.length,
      documents: documents.length,
      findings: tests.reduce((sum, test) => sum + countFindings(test), 0),
    };
  }
  async removeSampleData(): Promise<SampleDataCounts> {
    const removed = await this.countSampleData();
    // Children first, so a failure part-way leaves orphans rather than
    // clients whose tests point at nothing.
    for (const [id, one] of Array.from(this.tests.entries())) if (one.isSample) this.tests.delete(id);
    for (const [id, one] of Array.from(this.documents.entries())) if (one.isSample) this.documents.delete(id);
    for (const [id, one] of Array.from(this.sites.entries())) if (one.isSample) this.sites.delete(id);
    for (const [id, one] of Array.from(this.clients.entries())) if (one.isSample) this.clients.delete(id);
    return removed;
  }

  // Activity logs
  async getAllActivityLogs() {
    // Reverse before sorting so that entries written in the same millisecond
    // come back newest first, matching SQLite's rowid tiebreak. Sorting the
    // insertion order directly returned same-millisecond ties oldest first, so
    // "newest first" meant the opposite thing in tests and in production.
    return Array.from(this.activityLogs.values())
      .reverse()
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .map((log) => ({ ...log }));
  }
  async getActivityLogsByEntity(entityType: string, entityId: string) {
    return (await this.getAllActivityLogs()).filter(
      (l) => l.entityType === entityType && l.entityId === entityId,
    );
  }
  async createActivityLog(insertLog: InsertActivityLog): Promise<ActivityLog> {
    const log: ActivityLog = {
      entityId: null,
      userId: null,
      details: null,
      ipAddress: null,
      ...insertLog,
      id: randomUUID(),
      timestamp: new Date(),
    };
    this.activityLogs.set(log.id, log);
    return log;
  }

  // AI health
  async getLatestAIHealthMetric() {
    return (await this.getAIHealthMetrics(1))[0];
  }
  async getAIHealthMetrics(limit: number) {
    // Same clamp as the SQLite backend, which bounded it to 1..1000.
    const bounded = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 1000);
    return Array.from(this.aiHealthMetrics.values())
      .reverse()
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, bounded)
      .map((metric) => ({ ...metric }));
  }
  async createAIHealthMetric(insertMetric: InsertAIHealthMetric): Promise<AIHealthMetric> {
    const metric: AIHealthMetric = {
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
      ...insertMetric,
      id: randomUUID(),
      timestamp: new Date(),
    };
    this.aiHealthMetrics.set(metric.id, metric);
    return metric;
  }

  // Where this deployment talks to
  async getConnectionSettings() { return this.connectionSettings; }
  async updateConnectionSettings(
    settings: UpdateConnectionSettings, updatedBy: string | null,
  ) {
    const base = this.connectionSettings ?? {
      id: "connection-settings",
      engineUrl: null, engineKey: null,
      assistantUrl: null, assistantKey: null, assistantModel: null,
      updatedAt: new Date(), updatedBy: null,
    };
    this.connectionSettings = {
      ...base, ...settings, updatedAt: new Date(), updatedBy,
    } as ConnectionSetting;
    return this.connectionSettings;
  }

  // AI control
  async getAIControlSettings() { return this.aiControlSettings; }
  async updateAIControlSettings(updates: Partial<InsertAIControlSetting>) {
    const base = this.aiControlSettings ?? defaultControlSettings();
    this.aiControlSettings = { ...base, ...updates, lastModifiedAt: new Date() };
    return this.aiControlSettings;
  }

  // Chat
  async getChatMessage(id: string) { return copy(this.chatMessages.get(id)); }
  async getAllChatMessages() {
    return Array.from(this.chatMessages.values()).sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
  }
  async getChatMessagesByUser(userId: string) {
    return (await this.getAllChatMessages()).filter((m) => m.userId === userId);
  }
  async createChatMessage(insertMessage: InsertAIChatMessage): Promise<AIChatMessage> {
    const message: AIChatMessage = {
      attachments: null,
      ...insertMessage,
      id: randomUUID(),
      timestamp: new Date(),
    };
    this.chatMessages.set(message.id, message);
    return message;
  }
  async deleteChatMessage(id: string) { return this.chatMessages.delete(id); }

  // Classifiers
  async getAllClassifiers() { return Array.from(this.classifiers.values()); }
  async getClassifier(id: string) { return this.classifiers.get(id); }
  async createClassifier(insertClassifier: InsertClassifier): Promise<Classifier> {
    const classifier: Classifier = {
      status: "active",
      trainingDataSize: 0,
      lastTrainedAt: null,
      description: null,
      ...insertClassifier,
      id: randomUUID(),
      createdAt: new Date(),
    };
    this.classifiers.set(classifier.id, classifier);
    return classifier;
  }
  async updateClassifier(id: string, updates: Partial<InsertClassifier>) {
    const classifier = this.classifiers.get(id);
    if (!classifier) return undefined;
    const updated: Classifier = { ...classifier, ...updates };
    this.classifiers.set(id, updated);
    return updated;
  }
  async deleteClassifier(id: string) { return this.classifiers.delete(id); }

  // API keys
  async getAllApiKeys() { return Array.from(this.apiKeys.values()); }
  async createApiKey(input: { name: string; createdBy: string | null }): Promise<{ key: ApiKey; secret: string }> {
    const secret = generateApiKey();
    const key: ApiKey = {
      id: randomUUID(),
      name: input.name,
      prefix: apiKeyPrefix(secret),
      keyHash: hashApiKey(secret),
      createdBy: input.createdBy,
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.apiKeys.set(key.id, key);
    return { key, secret };
  }
  async findActiveApiKeyByHash(keyHash: string) {
    return Array.from(this.apiKeys.values()).find(
      (k) => k.keyHash === keyHash && k.revokedAt == null,
    );
  }
  async touchApiKey(id: string) {
    const key = this.apiKeys.get(id);
    if (key) this.apiKeys.set(id, { ...key, lastUsedAt: new Date() });
  }
  async revokeApiKey(id: string) {
    const key = this.apiKeys.get(id);
    if (!key) return undefined;
    if (key.revokedAt != null) return key;
    const revoked: ApiKey = { ...key, revokedAt: new Date() };
    this.apiKeys.set(id, revoked);
    return revoked;
  }
}

export const storage = new MemStorage();
