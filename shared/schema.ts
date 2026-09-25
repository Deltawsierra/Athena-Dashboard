import { sqliteTable, text, integer, customType } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/**
 * Athena data model.
 *
 * The runtime database is SQLite (better-sqlite3), so the schema is declared with
 * sqlite-core types. Booleans and timestamps are stored as INTEGER, JSON as TEXT.
 * IDs are generated in the storage layer (crypto.randomUUID) rather than by the DB.
 */

const id = () => text("id").primaryKey();
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });
const bool = (name: string) => integer(name, { mode: "boolean" });
/**
 * Written by the installer rather than by anybody's work.
 *
 * The first run seeds three clients, four sites and three tests so that a
 * fresh install has something to look at. Those tests carry severity counts,
 * and a dashboard that adds them up alongside real ones is presenting
 * invented findings as measurements -- which is the single thing this product
 * cannot be caught doing. So the rows say what they are, every screen that
 * counts them says so too, and one button removes them.
 *
 * Callers cannot set it: it is omitted from every schema the API parses, and
 * the seeder is the only code that passes it.
 */
const sample = () => integer("is_sample", { mode: "boolean" }).notNull().default(false);
/**
 * A JSON column that tolerates a value it did not write.
 *
 * drizzle's own json mode calls JSON.parse on every read, so one malformed cell
 * left by an earlier version of the schema made every request that touched the
 * table answer 500, with no way back short of editing the database by hand.
 * A cell that will not parse reads as null.
 */
const jsonColumn = customType<{ data: unknown; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => {
    if (value === null || value === undefined) return value as unknown;
    try {
      return JSON.parse(value as string);
    } catch {
      console.warn("[schema] ignoring a JSON column that could not be parsed");
      return null;
    }
  },
});

const json = <T>(name: string) => jsonColumn(name).$type<T>();

export const USER_ROLES = ["admin", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = sqliteTable("users", {
  id: id(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  role: text("role").notNull().default("user"),
  email: text("email"),
  isActive: bool("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull(),
});

export const clients = sqliteTable("clients", {
  id: id(),
  name: text("name").notNull(),
  company: text("company").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull(),
  lastTestDate: timestamp("last_test_date"),
  notes: text("notes"),
  isSample: sample(),
});

export const sites = sqliteTable("sites", {
  id: id(),
  clientId: text("client_id").notNull(),
  url: text("url").notNull(),
  name: text("name").notNull(),
  environment: text("environment").notNull().default("production"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull(),
  isSample: sample(),
});

export const tests = sqliteTable("tests", {
  id: id(),
  clientId: text("client_id").notNull(),
  siteId: text("site_id"),
  testType: text("test_type").notNull(),
  status: text("status").notNull().default("pending"),
  severity: text("severity"),
  startedAt: timestamp("started_at").notNull(),
  completedAt: timestamp("completed_at"),
  summary: text("summary"),
  findings: json<unknown>("findings"),
  vulnerabilitiesFound: integer("vulnerabilities_found").notNull().default(0),
  criticalCount: integer("critical_count").notNull().default(0),
  highCount: integer("high_count").notNull().default(0),
  mediumCount: integer("medium_count").notNull().default(0),
  lowCount: integer("low_count").notNull().default(0),
  executedBy: text("executed_by"),
  isSample: sample(),
});

/**
 * A finding, as a thing with a life rather than an entry in a scan's blob.
 *
 * Until now a finding existed only inside `tests.findings`, so rescanning the
 * same host produced a second copy of the same issue with no relation to the
 * first, nobody owned anything, and there was nowhere to record that a problem
 * had been looked at. Three scans of one host meant three sets of unrelated
 * rows and no way to ask "what is still open".
 *
 * `fingerprint` is what makes two sightings the same finding. Derived from the
 * engagement, the finding type, and the place it was found -- the endpoint, or
 * for a missing header the header's name -- and deliberately NOT from the
 * payload: the scanners try several payloads against one endpoint and a
 * fingerprint that included them would treat one issue as many, which is the
 * duplication this table exists to end.
 *
 * `status` carries the rule this whole product is built on. `fixed` is not a
 * label a person may apply. It is reachable only from a retest the engine
 * answered `closed`, and the columns recording which retest did it are part of
 * the row. A human may say a risk is accepted, or that they have looked at
 * something -- those are opinions and are stored as opinions. "Fixed" is a
 * claim about the customer's system, and only evidence may make it.
 */
export const findings = sqliteTable("findings", {
  id: id(),
  /** Same issue, same fingerprint. Unique within an engagement. */
  fingerprint: text("fingerprint").notNull(),
  clientId: text("client_id").notNull(),
  siteId: text("site_id"),
  engagementRef: text("engagement_ref").notNull(),

  type: text("type").notNull(),
  severity: text("severity"),
  message: text("message"),
  /** Where it was found. One of these is what distinguishes it from its siblings. */
  target: text("target"),
  endpoint: text("endpoint"),
  header: text("header"),

  /** open | acknowledged | accepted | fixed */
  status: text("status").notNull().default("open"),
  /** Who is answerable for it. Null means nobody has taken it. */
  ownerId: text("owner_id"),
  /** Why it was acknowledged or accepted, in the words of whoever did it. */
  statusNote: text("status_note"),
  statusChangedBy: text("status_changed_by"),
  statusChangedAt: timestamp("status_changed_at"),

  firstSeenAt: timestamp("first_seen_at").notNull(),
  lastSeenAt: timestamp("last_seen_at").notNull(),
  /** How many scans have reported it. Not how many payloads triggered it. */
  timesSeen: integer("times_seen").notNull().default(1),
  lastTestId: text("last_test_id"),
  lastRunId: text("last_run_id"),

  /** The retest that closed it. Absent on anything not verified fixed. */
  fixedAt: timestamp("fixed_at"),
  fixedByRunId: text("fixed_by_run_id"),
  /** The engine's own verdict word, kept so the claim can be checked. */
  fixedVerdict: text("fixed_verdict"),
  /** Set when a finding the engine had closed came back in a later scan. */
  reopenedAt: timestamp("reopened_at"),
  isSample: sample(),
});

/**
 * Every time a run looked at a finding, and what it saw.
 *
 * One row per finding per run, kept for ever and never overwritten. This is
 * what makes a second engagement a week later mean something: the client asks
 * whether the things found in March are gone, and the answer is a record of
 * what each run since then actually observed, rather than a status field whose
 * history was thrown away every time it changed.
 *
 * `seen` has three readings and only three. True means the run reported this
 * finding. False means the run went to this target and did not report it --
 * which is NOT the same as fixed, and is deliberately not allowed to close
 * anything: a scanner that was switched off, or a run that stopped early, also
 * produces a finding nobody saw. Absence is evidence of absence only when
 * something looked, and a scan cannot tell you it looked properly. Only a
 * retest verdict of `closed` closes a finding.
 */
export const findingSightings = sqliteTable("finding_sightings", {
  id: id(),
  findingId: text("finding_id").notNull(),
  /** The engine run. Null for a check that had none. */
  runId: text("run_id"),
  testId: text("test_id"),
  /** Whether this run reported the finding. */
  seen: bool("seen").notNull(),
  observedAt: timestamp("observed_at").notNull(),
});

/**
 * Every retest, kept as its own record.
 *
 * A retest is an independent question asked on a particular day, and the
 * answer to the one asked in March is not replaced by the answer to the one
 * asked in June. Each is stored with its own run and its own verdict so a
 * client can be shown the sequence -- still_open, still_open, closed -- rather
 * than only the last word.
 */
export const findingChecks = sqliteTable("finding_checks", {
  id: id(),
  findingId: text("finding_id").notNull(),
  /** The engine's own word: closed | still_open | inconclusive. */
  verdict: text("verdict").notNull(),
  detail: text("detail"),
  /** The run the retest performed, which is what makes the verdict checkable. */
  runId: text("run_id"),
  /** The detector set it ran with, so two verdicts can be compared fairly. */
  inventoryDigest: text("inventory_digest"),
  checkedBy: text("checked_by"),
  checkedAt: timestamp("checked_at").notNull(),
});

export const documents = sqliteTable("documents", {
  id: id(),
  clientId: text("client_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  documentType: text("document_type").notNull(),
  fileUrl: text("file_url"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  createdBy: text("created_by"),
  isSample: sample(),
});

export const activityLogs = sqliteTable("activity_logs", {
  id: id(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  userId: text("user_id"),
  details: json<unknown>("details"),
  ipAddress: text("ip_address"),
  timestamp: timestamp("timestamp").notNull(),
});

/**
 * What this deployment can actually measure about itself.
 *
 * Four of these columns used to be NOT NULL, which forced every writer to
 * supply a number whether or not one existed -- and the only writer was the
 * installer, which supplied 98% success, 94% detection accuracy and a 3%
 * false-positive rate. Nothing measured anything; nothing ever wrote a second
 * row; and the screen graded itself "excellent" off those three constants.
 *
 * They are nullable now, because null is the honest value for a figure with
 * no source, and a screen can render "not measured" from a null and cannot
 * render it from a 94. Detection accuracy and the false-positive rate are
 * always null here: they come from a benchmark that runs in the engine's CI
 * and is not exposed on any route, so this app has no way to know them and
 * will not print a number that looks like it does.
 */
export const aiHealthMetrics = sqliteTable("ai_health_metrics", {
  id: id(),
  timestamp: timestamp("timestamp").notNull(),
  cpuUsage: integer("cpu_usage").notNull(),
  memoryUsage: integer("memory_usage").notNull(),
  activeScans: integer("active_scans").notNull().default(0),
  totalScansToday: integer("total_scans_today").notNull().default(0),
  /** Finished scans that completed rather than failed. Null before any finish. */
  successRate: integer("success_rate"),
  /** This server's own mean API response time. Null before any request. */
  averageResponseTime: integer("average_response_time"),
  modelsLoaded: json<string[]>("models_loaded"),
  lastTrainingDate: timestamp("last_training_date"),
  /** No source in this app. Always null; the screen says why. */
  detectionAccuracy: integer("detection_accuracy"),
  /** No source in this app. Always null; the screen says why. */
  falsePositiveRate: integer("false_positive_rate"),
  /** The engine's boot canary, when an engine answered. */
  guardsChecked: integer("guards_checked"),
  guardsFailing: integer("guards_failing"),
});

export const aiControlSettings = sqliteTable("ai_control_settings", {
  id: id(),
  systemStatus: text("system_status").notNull().default("active"),
  killSwitchEnabled: bool("kill_switch_enabled").notNull().default(false),
  overrideMode: bool("override_mode").notNull().default(false),
  activeSystems: json<string[]>("active_systems"),
  maxConcurrentTests: integer("max_concurrent_tests").notNull().default(5),
  autoShutdownThreshold: integer("auto_shutdown_threshold").notNull().default(90),
  lastModifiedBy: text("last_modified_by"),
  lastModifiedAt: timestamp("last_modified_at").notNull(),
});

/**
 * Where this deployment talks to, and with what.
 *
 * A singleton, like the AI control row above it. Before this the addresses
 * and keys were environment variables only, which is fine for a server and
 * useless for a desktop application: a packaged Electron build has no shell
 * to set them in, so both the engine and the assistant shipped permanently
 * disconnected with no way to connect them.
 *
 * The keys are stored as written. Encrypting them with something else on the
 * same disk would be theatre -- anything the app can decrypt unattended, so
 * can anyone holding the file -- so the honest arrangement is to say where
 * they live, keep them off the wire, and let the operating system's own file
 * permissions do the work they are for. They are never returned by the API:
 * the settings screen is told whether a key is set, never what it is.
 */
export const connectionSettings = sqliteTable("connection_settings", {
  id: id(),
  engineUrl: text("engine_url"),
  engineKey: text("engine_key"),
  assistantUrl: text("assistant_url"),
  assistantKey: text("assistant_key"),
  assistantModel: text("assistant_model"),
  updatedAt: timestamp("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

export const aiChatMessages = sqliteTable("ai_chat_messages", {
  id: id(),
  userId: text("user_id").notNull(),
  message: text("message").notNull(),
  sender: text("sender").notNull(),
  attachments: json<unknown>("attachments"),
  timestamp: timestamp("timestamp").notNull(),
});

export const classifiers = sqliteTable("classifiers", {
  id: id(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  accuracy: integer("accuracy").notNull(),
  status: text("status").notNull().default("active"),
  trainingDataSize: integer("training_data_size").notNull().default(0),
  lastTrainedAt: timestamp("last_trained_at"),
  createdAt: timestamp("created_at").notNull(),
  description: text("description"),
});

/**
 * Programmatic access credentials for this dashboard's own API.
 *
 * The plaintext key is shown to its creator exactly once, at creation, and is
 * never stored: only a SHA-256 hash of it lives here, so a leaked database
 * cannot yield a working key, and there is nothing to log. `prefix` is a short,
 * non-secret head of the key kept for display, so the list can tell one key from
 * another without holding the secret. A key authenticates as the account that
 * created it (its role and all). Revoking sets `revokedAt`; a revoked key is
 * kept for the audit trail and never authenticates again.
 */
export const apiKeys = sqliteTable("api_keys", {
  id: id(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
});

// ---------------------------------------------------------------------------
// Insert schemas. Dates arrive over JSON as ISO strings, so date fields that a
// client may set are coerced. Server-managed timestamps are omitted.
// ---------------------------------------------------------------------------

const optionalDate = z.coerce.date().nullable().optional();
const optionalStringArray = z.array(z.string()).nullable().optional();
const optionalJson = z.unknown().nullable().optional();

export const insertUserSchema = createInsertSchema(users, {
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(256),
  role: z.enum(USER_ROLES).default("user"),
  email: z.string().email().max(254).nullable().optional(),
}).omit({ id: true, createdAt: true });

export const insertClientSchema = createInsertSchema(clients, {
  name: z.string().min(1).max(200),
  company: z.string().min(1).max(200),
  email: z.string().email().max(254),
  lastTestDate: optionalDate,
}).omit({ id: true, createdAt: true });

export const insertSiteSchema = createInsertSchema(sites, {
  url: z.string().min(1).max(2048),
  name: z.string().min(1).max(200),
}).omit({ id: true, createdAt: true });

export const insertTestSchema = createInsertSchema(tests, {
  testType: z.string().min(1).max(100),
  completedAt: optionalDate,
  findings: optionalJson,
}).omit({ id: true, startedAt: true });

/**
 * What a caller may send to create a test. Who ran it is recorded from the
 * signed-in session (the route refuses a body that names it: in an audit
 * product that is evidence), and whether a row is sample data is the
 * seeder's alone. Shared so the Tests screen builds its body from the same
 * schema the route parses -- it built an InsertTest, which carries
 * `executedBy`, sent `executedBy: null`, and every create from that screen
 * was refused with a 400.
 */
export const createTestSchema = insertTestSchema.omit({ executedBy: true, isSample: true });
export type CreateTest = z.infer<typeof createTestSchema>;

export const insertFindingSchema = createInsertSchema(findings, {
  statusChangedAt: optionalDate,
  fixedAt: optionalDate,
  reopenedAt: optionalDate,
}).omit({ id: true, firstSeenAt: true, lastSeenAt: true });

export const insertDocumentSchema = createInsertSchema(documents, {
  title: z.string().min(1).max(300),
  documentType: z.string().min(1).max(100),
}).omit({ id: true, createdAt: true, updatedAt: true });

export const insertActivityLogSchema = createInsertSchema(activityLogs, {
  details: optionalJson,
}).omit({ id: true, timestamp: true });

export const insertAIHealthMetricSchema = createInsertSchema(aiHealthMetrics, {
  modelsLoaded: optionalStringArray,
  lastTrainingDate: optionalDate,
}).omit({ id: true, timestamp: true });

export const insertAIControlSettingSchema = createInsertSchema(aiControlSettings, {
  activeSystems: optionalStringArray,
}).omit({ id: true, lastModifiedAt: true });

/**
 * An address this deployment will actually try to fetch.
 *
 * `z.string().url()` is not enough on its own: it is `new URL()` underneath,
 * and `new URL("engine.internal:8099")` parses -- `engine.internal:` is read
 * as a scheme. So a host and port with the scheme left off is accepted, and
 * the confusing failure arrives much later, out of fetch, in front of
 * somebody who has already closed the settings screen.
 */
const httpUrl = z
  .string()
  .max(2000)
  .refine(
    (value) => {
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: "must be an http:// or https:// address" },
  );

// Every field optional and nullable: a settings form saves what it was given
// and leaves the rest alone. Checked here rather than at the point of use, so
// a typo is refused while somebody is still looking at the field.
export const updateConnectionSettingsSchema = z.object({
  engineUrl: httpUrl.or(z.literal("")).nullish(),
  engineKey: z.string().max(500).or(z.literal("")).nullish(),
  assistantUrl: httpUrl.or(z.literal("")).nullish(),
  assistantKey: z.string().max(500).or(z.literal("")).nullish(),
  assistantModel: z.string().max(200).or(z.literal("")).nullish(),
});

export const insertAIChatMessageSchema = createInsertSchema(aiChatMessages, {
  message: z.string().min(1).max(20000),
  sender: z.enum(["user", "ai", "system"]),
  attachments: optionalJson,
}).omit({ id: true, timestamp: true });

export const insertClassifierSchema = createInsertSchema(classifiers, {
  name: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  lastTrainedAt: optionalDate,
}).omit({ id: true, createdAt: true });

/**
 * What a caller may set when minting an API key: a name to tell it apart later.
 * The secret, its hash, its prefix and every timestamp are the server's to set —
 * a caller cannot choose the key, and the key never comes back over this schema.
 */
export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type PublicUser = Omit<User, "password">;
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clients.$inferSelect;
export type InsertSite = z.infer<typeof insertSiteSchema>;
export type Site = typeof sites.$inferSelect;
export type InsertTest = z.infer<typeof insertTestSchema>;
export type Test = typeof tests.$inferSelect;
export type InsertFinding = z.infer<typeof insertFindingSchema>;
export type FindingSighting = typeof findingSightings.$inferSelect;
export type FindingCheck = typeof findingChecks.$inferSelect;
export type Finding = typeof findings.$inferSelect;

/**
 * The states a finding can be in.
 *
 * `fixed` is absent from what a person may set, on purpose. It is a claim
 * about the customer's system, and only a retest the engine answered `closed`
 * may make it. The other three are opinions and are stored as opinions.
 */
export const SETTABLE_FINDING_STATUS = ["open", "acknowledged", "accepted"] as const;
export const FINDING_STATUS = [...SETTABLE_FINDING_STATUS, "fixed"] as const;
export type FindingStatus = (typeof FINDING_STATUS)[number];
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documents.$inferSelect;
export type InsertActivityLog = z.infer<typeof insertActivityLogSchema>;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type InsertAIHealthMetric = z.infer<typeof insertAIHealthMetricSchema>;
export type AIHealthMetric = typeof aiHealthMetrics.$inferSelect;
export type InsertAIControlSetting = z.infer<typeof insertAIControlSettingSchema>;
export type AIControlSetting = typeof aiControlSettings.$inferSelect;
export type InsertAIChatMessage = z.infer<typeof insertAIChatMessageSchema>;
export type AIChatMessage = typeof aiChatMessages.$inferSelect;
export type ConnectionSetting = typeof connectionSettings.$inferSelect;
export type UpdateConnectionSettings = z.infer<typeof updateConnectionSettingsSchema>;
export type InsertClassifier = z.infer<typeof insertClassifierSchema>;
export type Classifier = typeof classifiers.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
/** An API key as it is safe to return: never its hash. */
export type PublicApiKey = Omit<ApiKey, "keyHash">;
export type CreateApiKey = z.infer<typeof createApiKeySchema>;

/**
 * How many seeded rows are still in the database, per table.
 *
 * Shared with the client because the notice on the dashboard states these
 * numbers rather than saying "some of this is sample data", which is the kind
 * of hedge a reader discounts.
 */
export interface SampleDataCounts {
  clients: number;
  sites: number;
  tests: number;
  documents: number;
  /** Findings across the seeded tests: what the severity totals are inflated by. */
  findings: number;
}
