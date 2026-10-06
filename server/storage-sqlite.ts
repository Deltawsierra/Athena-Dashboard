import { db, sqlite } from "./db-sqlite";
import * as schema from "@shared/schema";
import { and, desc, eq, getTableColumns, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import crypto from "crypto";
import { randomUUID } from "crypto";
import { DEFAULT_ACTIVE_SYSTEMS } from "@shared/ai-systems";
import { ratingOf } from "@shared/latest-scans";
import { DuplicateRetestCheck, type IStorage, type RetestFiling, type RetestWatchEnd } from "./storage";
import { hashPassword, verifyPassword, dummyVerify } from "./password";
import { generateApiKey, hashApiKey, apiKeyPrefix } from "./api-keys";
import type {
  User, InsertUser,
  Client, InsertClient,
  Site, InsertSite,
  Test, InsertTest,
  Finding, InsertFinding,
  FindingSighting, FindingCheck, RetestWatch,
  Document, InsertDocument,
  ActivityLog, InsertActivityLog,
  AIHealthMetric, InsertAIHealthMetric, BenchmarkReading,
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
  /**
   * A read made after this call's own write committed -- the row read back to
   * return it. A busy database is waited out here, off the event loop, and
   * never by running the whole call again: withBusyRetry re-runs a call only
   * when it failed busy before anything it does was committed, and a call
   * whose write is in cannot fail busy after it any more (one that still
   * cannot read back says so with an error that is not a busy one, which is
   * not retried). Re-running it wrote a second row for one call.
   */
  private async readBack<T>(read: () => T | Promise<T>): Promise<T> {
    const deadline = Date.now() + BUSY_RETRY_FOR_MS;
    for (;;) {
      try {
        return await read();
      } catch (cause) {
        if (!isBusy(cause)) throw cause;
        if (Date.now() >= deadline) {
          throw new Error(`written, but it could not be read back: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 20)));
      }
    }
  }

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
      mustChangePassword: false,
      ...user,
      password: await hashPassword(user.password),
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    db.insert(schema.users).values(row).run();
    return (await this.readBack(() => this.getUser(row.id)))!;
  }
  async updateUser(id: string, user: Partial<InsertUser>): Promise<User | undefined> {
    const updates = { ...user };
    if (updates.password) updates.password = await hashPassword(updates.password);
    if (definedKeys(updates).length > 0) {
      db.update(schema.users).set(updates).where(eq(schema.users.id, id)).run();
    }
    return this.readBack(() => this.getUser(id));
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
      await dummyVerify(password);
      return undefined;
    }
    const result = await verifyPassword(password, user.password);
    if (!result.ok) return undefined;
    if (result.needsRehash) {
      const rehashed = await hashPassword(password);
      // Only over the hash this sign-in verified. The rehash is slow, and a
      // password changed while it ran is the account's now: written over it,
      // the old password stood again, and this sign-in's session held the
      // account's current stamp. A sign-in whose hash was replaced under it
      // verified a password the account no longer has, and is refused.
      const written = db
        .update(schema.users)
        .set({ password: rehashed })
        .where(and(eq(schema.users.id, user.id), eq(schema.users.password, user.password)))
        .run();
      if (written.changes === 0) {
        // Replaced under it: by another sign-in's rehash of this same password
        // (the password is still the account's), or by a change (it is not). The
        // hash in force decides, as a sign-in would (#65 review round 4, F3).
        const now = await this.getUser(user.id);
        if (!now || !(await verifyPassword(password, now.password)).ok) return undefined;
        return now;
      }
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
    return (await this.readBack(() => this.getClient(row.id)))!;
  }
  async updateClient(id: string, client: Partial<InsertClient>): Promise<Client | undefined> {
    if (definedKeys(client).length > 0) {
      db.update(schema.clients).set(client).where(eq(schema.clients.id, id)).run();
    }
    return this.readBack(() => this.getClient(id));
  }
  async deleteClient(id: string): Promise<boolean> {
    // There are no foreign keys, so the children are removed here. Without
    // this, deleting a client orphaned its tests, sites and documents, which
    // then referenced an id that no longer existed.
    const { removed, testIds } = db.transaction(() => {
      const gone = db.select({ id: schema.tests.id }).from(schema.tests).where(eq(schema.tests.clientId, id)).all();
      db.delete(schema.tests).where(eq(schema.tests.clientId, id)).run();
      db.delete(schema.sites).where(eq(schema.sites.clientId, id)).run();
      db.delete(schema.documents).where(eq(schema.documents.clientId, id)).run();
      return { removed: db.delete(schema.clients).where(eq(schema.clients.id, id)).run().changes > 0, testIds: gone.map((one) => one.id) };
    });
    // Only the tests that went are forgotten; every other test stays in
    // memory, so a Stop still finds its run without a read.
    this.forgetSomeTests((test) => test.clientId === id || testIds.includes(test.id));
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
    return (await this.readBack(() => this.getSite(row.id)))!;
  }
  async updateSite(id: string, site: Partial<InsertSite>): Promise<Site | undefined> {
    if (definedKeys(site).length > 0) {
      db.update(schema.sites).set(site).where(eq(schema.sites.id, id)).run();
    }
    return this.readBack(() => this.getSite(id));
  }
  async deleteSite(id: string): Promise<boolean> {
    return db.delete(schema.sites).where(eq(schema.sites.id, id)).run().changes > 0;
  }

  // Tests
  //
  // Every test this process has read or written is kept in memory as well
  // (peekTest / peekAllTests), so a Stop can find the run it names without
  // asking the database first: a database that is locked, slow or failing
  // must never stand between a Stop and the engine.
  private testCache = new Map<string, Test>();
  private testsListed = false;
  private remember<T extends Test | undefined>(test: T): T {
    if (test) this.testCache.set(test.id, { ...test });
    return test;
  }
  peekTest(id: string): Test | undefined {
    const test = this.testCache.get(id);
    return test ? { ...test } : undefined;
  }
  peekAllTests(): Test[] | null {
    return this.testsListed ? Array.from(this.testCache.values()).map((one) => ({ ...one })) : null;
  }
  /**
   * Forget the tests a delete removed -- those alone -- and read the list
   * again in the background, so what this process holds matches the record
   * without anything waiting on it: a Stop answers from what is held (never
   * from a refill), and a refill that fails leaves the list as it was.
   */
  private forgetSomeTests(gone: (test: Test) => boolean): void {
    for (const [id, test] of Array.from(this.testCache.entries())) {
      if (gone(test)) this.testCache.delete(id);
    }
    if (this.testsListed) {
      setImmediate(() => void storage.getAllTests().catch(() => undefined));
    }
  }
  async getTest(id: string): Promise<Test | undefined> {
    return this.remember(db.select().from(schema.tests).where(eq(schema.tests.id, id)).get());
  }
  /**
   * How many rows one page of the full table scan below reads before the
   * event loop is given back.
   *
   * One unbounded `SELECT * FROM tests` (better-sqlite3 runs it synchronously)
   * held the loop for 623 ms at 60,000 rows with realistic column sizes here --
   * and every Stop that arrived while it ran queued behind it, however far
   * past this suite's 50 ms bound that pushed it. A page this size reads in
   * single-digit milliseconds, so a Stop waiting behind at most one page is
   * answered on schedule.
   */
  private static readonly TESTS_PAGE_SIZE = 1000;
  async getAllTests(): Promise<Test[]> {
    const rows: Test[] = [];
    // Paged by rowid, not OFFSET: OFFSET counts live rows from the start on
    // every page, so a row deleted behind the cursor would shift every page
    // after it and could skip or repeat a row. A page's own last rowid names
    // exactly where the next one starts, whatever else is written meanwhile.
    let lastRowid = 0;
    for (;;) {
      const page = db
        .select({ ...getTableColumns(schema.tests), __rowid: sql<number>`tests."rowid"` })
        .from(schema.tests)
        .where(sql`tests."rowid" > ${lastRowid}`)
        .orderBy(sql`tests."rowid"`)
        .limit(SqliteStorage.TESTS_PAGE_SIZE)
        .all();
      if (page.length === 0) break;
      for (const { __rowid, ...row } of page) rows.push(row as Test);
      lastRowid = page[page.length - 1].__rowid;
      if (page.length < SqliteStorage.TESTS_PAGE_SIZE) break;
      // A start caught mid-scan by a fresh row past the cursor is not missed:
      // trackStart marks it directly (routes.ts), off this read entirely.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.testCache = new Map(rows.map((row) => [row.id, { ...row }]));
    this.testsListed = true;
    return rows;
  }
  async getTestsByClient(clientId: string): Promise<Test[]> {
    const rows = db.select().from(schema.tests).where(eq(schema.tests.clientId, clientId)).all();
    rows.forEach((row) => this.remember(row));
    return rows;
  }
  async getTestsBySite(siteId: string): Promise<Test[]> {
    const rows = db.select().from(schema.tests).where(eq(schema.tests.siteId, siteId)).all();
    rows.forEach((row) => this.remember(row));
    return rows;
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
    // Grouped by the severity as stored, and read here as every reader reads it
    // (shared/latest-scans.ts ratingOf: any case, trimmed). Lower-cased alone, a
    // row filed as " high" before filing normalised it was no filed high, while
    // the summary counted it as an open one. Each finding has one severity, so
    // the distinct counts of its stored spellings add up.
    const severity = sql<string>`coalesce(${schema.findings.severity}, '')`;
    const rows = db.select({ severity, n: sql<number>`count(distinct ${schema.findings.id})` })
      .from(schema.findingSightings)
      .innerJoin(schema.findings, eq(schema.findings.id, schema.findingSightings.findingId))
      .where(and(eq(schema.findingSightings.testId, testId), eq(schema.findingSightings.seen, true)))
      .groupBy(severity)
      .all();
    const counts = { critical: 0, high: 0 };
    for (const row of rows) {
      const rating = ratingOf(row.severity);
      if (rating === "critical" || rating === "high") counts[rating] += Number(row.n);
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

  async createRetestWatch(watch: RetestWatch): Promise<RetestWatch> {
    db.insert(schema.retestWatches).values(watch).run();
    return watch;
  }
  async getRetestWatch(engineRunId: string): Promise<RetestWatch | undefined> {
    return db.select().from(schema.retestWatches).where(eq(schema.retestWatches.engineRunId, engineRunId)).get();
  }
  async getOpenRetestWatches(unwatchedSince: Date): Promise<RetestWatch[]> {
    return db.select().from(schema.retestWatches).where(or(
      eq(schema.retestWatches.state, "running"),
      and(eq(schema.retestWatches.state, "unwatched"), gte(schema.retestWatches.endedAt, unwatchedSince)),
    )).all();
  }
  async updateRunningRetestWatch(
    engineRunId: string, patch: Partial<Omit<RetestWatch, "engineRunId" | "state">>,
  ): Promise<boolean> {
    if (definedKeys(patch).length === 0) return (await this.getRetestWatch(engineRunId))?.state === "running";
    return db.update(schema.retestWatches).set(patch)
      .where(and(eq(schema.retestWatches.engineRunId, engineRunId), eq(schema.retestWatches.state, "running")))
      .run().changes === 1;
  }
  async endRetestWatch(engineRunId: string, end: RetestWatchEnd, filing?: RetestFiling): Promise<boolean> {
    // One IMMEDIATE transaction, the claim first: the UPDATE that moves the
    // watch off `running` takes the write lock, and a second dashboard on this
    // file waits for it, then finds the watch ended and writes nothing. The
    // filing is in the same transaction, so a claim is never left without its
    // check, nor a check without its claim.
    const run = sqlite.transaction((): boolean => {
      const claimed = db.update(schema.retestWatches).set(end)
        .where(and(eq(schema.retestWatches.engineRunId, engineRunId), eq(schema.retestWatches.state, "running")))
        .run().changes === 1;
      if (!claimed) return false;
      if (filing) {
        const changed = db.update(schema.findings).set(filing.findingPatch)
          .where(eq(schema.findings.id, filing.findingId)).run().changes;
        if (changed !== 1) throw new Error(`finding ${filing.findingId} is not on record`);
        try {
          db.insert(schema.findingChecks).values({ ...filing.check, id: randomUUID(), checkedAt: new Date() }).run();
        } catch (cause) {
          if (String(cause).includes("UNIQUE")) {
            throw new DuplicateRetestCheck(`a check is already filed for engine run ${filing.check.engineRunId}`);
          }
          throw cause;
        }
      }
      return true;
    });
    return run.immediate();
  }

  async updateFinding(id: string, patch: Partial<Finding>): Promise<Finding | undefined> {
    const { id: _ignored, ...fields } = patch;
    if (Object.keys(fields).length > 0) {
      db.update(schema.findings).set(fields).where(eq(schema.findings.id, id)).run();
    }
    return this.readBack(() => this.getFinding(id));
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
    return (await this.readBack(() => this.getTest(row.id)))!;
  }
  async updateTest(id: string, test: Partial<InsertTest>): Promise<Test | undefined> {
    if (definedKeys(test).length > 0) {
      db.update(schema.tests).set(test).where(eq(schema.tests.id, id)).run();
    }
    return this.readBack(() => this.getTest(id));
  }
  async deleteTest(id: string): Promise<boolean> {
    const removed = db.delete(schema.tests).where(eq(schema.tests.id, id)).run().changes > 0;
    this.testCache.delete(id);
    return removed;
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
    return (await this.readBack(() => this.getDocument(row.id)))!;
  }
  async updateDocument(id: string, document: Partial<InsertDocument>): Promise<Document | undefined> {
    db.update(schema.documents)
      .set({ ...document, updatedAt: new Date() })
      .where(eq(schema.documents.id, id))
      .run();
    return this.readBack(() => this.getDocument(id));
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
    // The sample tests alone are forgotten (forgetSomeTests).
    this.forgetSomeTests((test) => test.isSample === true);
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
    return (await this.readBack(() => db.select().from(schema.activityLogs).where(eq(schema.activityLogs.id, row.id)).get()))!;
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
      benchmark: null,
      benchmarkUnmeasured: null,
      ...metric,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };
    db.insert(schema.aiHealthMetrics).values(row).run();
    return (await this.readBack(() => db.select().from(schema.aiHealthMetrics).where(eq(schema.aiHealthMetrics.id, row.id)).get()))!;
  }
  async getLatestBenchmarkReading(): Promise<BenchmarkReading | null> {
    const held = db
      .select({ benchmark: schema.aiHealthMetrics.benchmark })
      .from(schema.aiHealthMetrics)
      .where(isNotNull(schema.aiHealthMetrics.benchmark))
      // rowid breaks a tie between two readings written in one millisecond.
      .orderBy(desc(schema.aiHealthMetrics.timestamp), desc(sql`rowid`))
      .limit(1)
      .get();
    return held?.benchmark ?? null;
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
      return (await this.readBack(() => this.getConnectionSettings()))!;
    }
    db.update(schema.connectionSettings)
      .set({ ...settings, updatedAt: now, updatedBy } as any)
      .where(eq(schema.connectionSettings.id, existing.id))
      .run();
    return (await this.readBack(() => this.getConnectionSettings()))!;
  }

  async getAIControlSettings(): Promise<AIControlSetting | undefined> {
    return db
      .select()
      .from(schema.aiControlSettings)
      .where(eq(schema.aiControlSettings.id, AI_CONTROL_ID))
      .get();
  }
  async getKillSwitchState(): Promise<{ killSwitchEnabled: boolean; systemStatus: string | null } | undefined> {
    return db
      .select({
        killSwitchEnabled: schema.aiControlSettings.killSwitchEnabled,
        systemStatus: schema.aiControlSettings.systemStatus,
      })
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
        activeSystems: [...DEFAULT_ACTIVE_SYSTEMS],
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
      return (await this.readBack(() => this.getAIControlSettings()))!;
    }
    db.update(schema.aiControlSettings)
      .set({ ...settings, lastModifiedAt: now })
      .where(eq(schema.aiControlSettings.id, existing.id))
      .run();
    return (await this.readBack(() => this.getAIControlSettings()))!;
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
    return (await this.readBack(() => this.getChatMessage(row.id)))!;
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
    return (await this.readBack(() => this.getClassifier(row.id)))!;
  }
  async updateClassifier(id: string, classifier: Partial<InsertClassifier>): Promise<Classifier | undefined> {
    if (definedKeys(classifier).length > 0) {
      db.update(schema.classifiers).set(classifier).where(eq(schema.classifiers.id, id)).run();
    }
    return this.readBack(() => this.getClassifier(id));
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
    return { key: (await this.readBack(() => this.getApiKey(row.id)))!, secret };
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
    return this.readBack(() => this.getApiKey(id));
  }
}

/** Methods that answer from memory, synchronously, and are never retried. */
const IN_MEMORY = new Set<PropertyKey>(["peekTest", "peekAllTests"]);

/** How long, in all, a statement is retried while another connection holds the lock it needs. */
const BUSY_RETRY_FOR_MS = 5_000;

function isBusy(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"));
}

/** Calls that only read: under WAL a read never waits for the write lock, so one never queues behind the writes that do. */
function readsOnly(property: PropertyKey): boolean {
  return typeof property === "string" && /^(get|find|count|filed)[A-Z]/.test(property);
}

/** A call waiting in the BusyLine for its turn. */
type Waiting = { seat: number; go: () => void; fail: (cause: unknown) => void; deadline: number; cause: unknown };

/**
 * One line, first come first served, for the calls a busy database refused --
 * and for every write made while one may be refused: no statement on the
 * event loop ever waits on the lock (db-sqlite.ts BUSY_TIMEOUT_MS is 0: a try
 * is refused at once), and at most ONE call tries at a time while the
 * database is, or may be, busy. So a flood of writes under a held lock --
 * however many, and however they were started, all in one turn of the loop
 * included -- costs the loop one refused try per retry round, never one per
 * write waiting.
 *
 *   - Every call takes a place (`seat`) when it is made, and the line is kept
 *     in the order of those places: a call refused after it was made goes back
 *     where it was made, never behind a later one. So writes land in the order
 *     they were made: a later write of the same row is never overtaken by an
 *     earlier one.
 *   - While the line is not empty, or any call's try is still out (made, and
 *     not yet known to have succeeded or been refused -- `trying`), a new call
 *     that writes joins the line at once instead of trying. So a burst of
 *     writes made in one turn of the loop makes ONE try, not one each. A call
 *     that only reads goes straight through (readsOnly): under WAL a read
 *     never takes the write lock, and one the database still refuses joins the
 *     line like any other.
 *   - The head of the line tries again every 10-30 ms while the database is
 *     busy. When it succeeds the lock is free, and the rest follow one per
 *     turn of the loop.
 *   - A call still waiting when its BUSY_RETRY_FOR_MS are up fails: with the
 *     busy error it met, or, if it never tried, with one saying the lock was
 *     held longer than it waits.
 *   - The head is taken, and a new call joins, in constant time. The calls
 *     past their time are looked for by a pass over the whole line, made only
 *     once the earliest deadline noted may have passed -- but that note is
 *     not moved later when its call leaves the line, so under a steady flood
 *     the pass can run on most steps (measured in the round-five review: 406
 *     of 663 steps, over about 3,259 waiting calls each). Each pass costs
 *     microseconds, and changes no call's order or outcome.
 */
export class BusyLine {
  /**
   * The line, in seat order, from `head` on: a step takes the head in O(1)
   * (the index moves; the array is compacted only now and then), and a call
   * joins at the back in O(1) -- every new call's seat is the highest. Only a
   * call going back to its place (refused after it was made) is placed by a
   * binary search. The one step that touches every call waiting is the
   * search for calls past their time (expire), made only once
   * `earliestDeadline` has passed -- which, left stale by a call that went,
   * can be most steps under a steady flood: not constant time, but a pass of
   * microseconds.
   */
  private waiting: Array<Waiting | undefined> = [];
  private head = 0;
  /** No call waiting has a deadline before this (it may be earlier than any does): the line is searched for calls past their time only once it has passed. */
  private earliestDeadline = Number.POSITIVE_INFINITY;
  private scheduled = false;
  private busyNow = false;
  private seats = 0;
  /** Tries that are out: made, and not yet known to have succeeded or been refused. */
  private trying = 0;

  /** Whether a new write waits its turn: calls are waiting for the lock, a try is still out, or the last one was refused. */
  get queued(): boolean {
    return this.busyNow || this.length > 0 || this.trying > 0;
  }

  /** How many calls are waiting in the line. */
  get length(): number {
    return this.waiting.length - this.head;
  }

  /** A place in the line's order, taken when a call is made. */
  seat(): number {
    this.seats += 1;
    return this.seats;
  }

  /** A try is going out; `settled` is called once it is known how it went. */
  begin(): () => void {
    this.trying += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.trying -= 1;
    };
  }

  /** A call outside the line met a busy database: from now on new writes wait their turn. */
  sawBusy(): void {
    this.busyNow = true;
  }

  /** Wait for this call's turn to try (again), at the place it took when it was made. */
  turn(seat: number, deadline: number, cause: unknown): Promise<void> {
    return new Promise<void>((go, fail) => {
      this.place({ seat, go, fail, deadline, cause });
      this.earliestDeadline = Math.min(this.earliestDeadline, deadline);
      this.schedule(this.busyNow ? "timer" : "now");
    });
  }

  /** What one try from the line came to: a busy refusal keeps the line waiting on a timer; anything else lets the next one go. */
  tried(busy: boolean): void {
    this.busyNow = busy;
    this.scheduled = false;
    if (this.length > 0) this.schedule(busy ? "timer" : "now");
  }

  /** Put a call in its place by seat: at the back (a new call), at the front (the head going back), or found by a binary search. */
  private place(entry: Waiting): void {
    const last = this.waiting.length - 1;
    if (this.length === 0 || this.waiting[last]!.seat < entry.seat) {
      this.waiting.push(entry);
      return;
    }
    if (entry.seat < this.waiting[this.head]!.seat && this.head > 0) {
      this.head -= 1;
      this.waiting[this.head] = entry;
      return;
    }
    let low = this.head;
    let high = this.waiting.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.waiting[mid]!.seat < entry.seat) low = mid + 1;
      else high = mid;
    }
    this.waiting.splice(low, 0, entry);
  }

  /** Take the head of the line. */
  private take(): Waiting | undefined {
    if (this.length === 0) return undefined;
    const entry = this.waiting[this.head];
    this.waiting[this.head] = undefined;
    this.head += 1;
    if (this.head === this.waiting.length) {
      this.waiting = [];
      this.head = 0;
    } else if (this.head >= 1024 && this.head * 2 >= this.waiting.length) {
      this.waiting = this.waiting.slice(this.head);
      this.head = 0;
    }
    return entry;
  }

  /**
   * Fail every call whose time is up, wherever it is in the line. Searched
   * only once the earliest deadline has passed -- so a step normally does
   * nothing here -- and then once for all of them.
   */
  private expire(now: number): void {
    if (now < this.earliestDeadline) return;
    const kept: Array<Waiting | undefined> = [];
    const late: Waiting[] = [];
    let earliest = Number.POSITIVE_INFINITY;
    for (let at = this.head; at < this.waiting.length; at += 1) {
      const one = this.waiting[at]!;
      if (one.deadline <= now) late.push(one);
      else {
        kept.push(one);
        earliest = Math.min(earliest, one.deadline);
      }
    }
    this.waiting = kept;
    this.head = 0;
    this.earliestDeadline = earliest;
    for (const one of late) one.fail(one.cause ?? this.expired());
  }

  private schedule(when: "timer" | "now"): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const next = () => {
      // Calls whose time is up -- wherever they are in the line -- fail with
      // the refusal they met, or, never having tried, with one saying so.
      this.expire(Date.now());
      const head = this.take();
      if (!head) {
        this.scheduled = false;
        this.earliestDeadline = Number.POSITIVE_INFINITY;
        return;
      }
      // The head tries; its result (tried) schedules the next.
      head.go();
    };
    if (when === "now") setImmediate(next);
    else setTimeout(next, 10 + Math.floor(Math.random() * 20));
  }

  private expired(): unknown {
    const error = new Error("database is locked (another connection held its lock for longer than this call waits)") as Error & { code: string };
    error.code = "SQLITE_BUSY";
    return error;
  }
}

/**
 * Wait for a lock without holding the event loop.
 *
 * Each statement is tried once and refused at once when another connection
 * holds the lock it needs (BUSY_TIMEOUT_MS is 0); a call refused as busy, and
 * every write made while one may be, waits its turn in one line (BusyLine)
 * and is tried again, for up to BUSY_RETRY_FOR_MS in all -- off the loop, one
 * call at a time, so every other request, and every Stop, is served in
 * between however many writes are waiting.
 *
 * A call is tried again from the start only when it failed busy before
 * anything it does was committed: every call writes one statement, or one
 * transaction rolled back whole, and any read it makes after its write is
 * waited out inside the call (SqliteStorage.readBack), never by running it
 * again -- so no write is ever made twice.
 */
export function withBusyRetry<T extends object>(target: T, retryForMs = BUSY_RETRY_FOR_MS, line = new BusyLine()): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== "function" || property === "constructor") return value;
      if (IN_MEMORY.has(property)) return value.bind(object);
      return async (...args: unknown[]) => {
        const deadline = Date.now() + retryForMs;
        const seat = line.seat();
        let inLine = false;
        // Decided synchronously, when the call is made: a write made while
        // another's try is still out -- in the same turn of the loop, say --
        // waits its turn rather than trying beside it.
        if (line.queued && !readsOnly(property)) {
          await line.turn(seat, deadline, null);
          inLine = true;
        }
        const writes = !readsOnly(property);
        for (;;) {
          // A write's try is out until it is known how it went; a read's
          // never holds a write back.
          const settled = writes || inLine ? line.begin() : () => undefined;
          try {
            const result = await value.apply(object, args);
            settled();
            if (inLine) line.tried(false);
            return result;
          } catch (cause) {
            settled();
            if (!isBusy(cause)) {
              if (inLine) line.tried(false);
              throw cause;
            }
            if (inLine) line.tried(true);
            else line.sawBusy();
            if (Date.now() >= deadline) throw cause;
            await line.turn(seat, deadline, cause);
            inLine = true;
          }
        }
      };
    },
  });
}

export const storage: IStorage = withBusyRetry(new SqliteStorage());
