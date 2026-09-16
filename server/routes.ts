import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { storage } from "./storage-unified";
import { requireAuth, requireAdmin, asyncHandler, actor } from "./auth";
import * as assistant from "./assistant";
import * as settings from "./settings";
import * as engine from "./engine";
import * as failsafe from "./failsafe";
import * as assurance from "./assurance";
import { controlMap, type ScanFinding } from "./compliance";
import { deploymentSummary } from "./summary";
import * as lifecycle from "./findings";
import {
  insertClientSchema, insertSiteSchema, insertTestSchema,
  insertDocumentSchema, insertAIHealthMetricSchema,
  insertUserSchema, insertAIControlSettingSchema, insertAIChatMessageSchema,
  updateConnectionSettingsSchema,
  insertClassifierSchema, USER_ROLES,
  type User, type PublicUser,
  SETTABLE_FINDING_STATUS,
} from "@shared/schema";

/**
 * Attribution comes from the session, so these fields are not accepted from the
 * request body at all. Taking `data.executedBy ?? session` let the client win,
 * and in an audit product "who ran this test" is evidence.
 */
/**
 * The host a recorded site names, or null if it does not name one.
 *
 * Sites are stored as URLs typed by a person, so this has to survive a bare
 * hostname as well as a URL. It does not invent a scheme for anything with a
 * colon in it: "engine.internal:8099" parses as a scheme, which is the same
 * trap the settings screen's URL validation fell into.
 */
function hostOf(url: string): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname || null;
  } catch {
    return null;
  }
}

const createTestSchema = insertTestSchema.omit({ executedBy: true, isSample: true });

/**
 * `isSample` marks a row the installer wrote, and nothing else may claim it.
 * A caller who could set it could hide real findings behind a label that says
 * "not real", or dress invented ones up as measured. It is stripped from
 * every schema the API parses; the seeder is the only writer.
 */
const createClientSchema = insertClientSchema.omit({ isSample: true });
const createSiteSchema = insertSiteSchema.omit({ isSample: true });

// What a scan needs before the engine is asked anything: a target, and the
// engagement it is being run under. The engagement is a client and, where
// there is one, a site -- both looked up rather than taken on trust, because
// a scan filed under an engagement nobody opened is a scan nobody authorised.

// Authenticated scanning, in the engine's TargetAuthConfig shape. Bounded so a
// launch request cannot smuggle an unbounded credential blob through; the
// engine validates the contents again and refuses a malformed block.
const authIdentitySchema = z.object({
  name: z.string().min(1).max(100),
  cookies: z.record(z.string(), z.string().max(4096)).optional(),
  headers: z.record(z.string(), z.string().max(4096)).optional(),
  login_fields: z.record(z.string(), z.string().max(4096)).optional(),
});

const scanAuthSchema = z.object({
  enabled: z.boolean(),
  login_url: z.string().max(2000).nullish(),
  login_method: z.enum(["GET", "POST"]).optional(),
  authenticated_marker: z.string().max(500).nullish(),
  identities: z.array(authIdentitySchema).max(8),
});

const startScanSchema = z.object({
  clientId: z.string().min(1),
  siteId: z.string().min(1).optional(),
  target: z.string().min(1).max(2000),
  testType: z.string().min(1).max(100).default("penetration_test"),
  // Optional: present only when the operator turned on authenticated scanning.
  // Not persisted -- forwarded to the engine for the scan and then dropped.
  auth: scanAuthSchema.optional(),
});

/**
 * The severity counts, taken from the findings the engine returned.
 *
 * Counted here rather than accepted from anywhere: these numbers are what a
 * client reads on a report, and the only honest source for them is the list
 * of findings they claim to summarise.
 */
function countSeverities(findings: unknown[]): {
  vulnerabilitiesFound: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  severity: string | null;
} {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  let total = 0;
  for (const finding of findings) {
    if (!finding || typeof finding !== "object") continue;
    const entry = finding as Record<string, unknown>;
    // The engine marks its own diagnostics `internal`. They are worth showing
    // and they are not vulnerabilities, so they are not counted as any.
    if (entry.internal === true) continue;
    total += 1;
    const severity = String(entry.severity ?? "").toLowerCase();
    if (severity in counts) counts[severity as keyof typeof counts] += 1;
  }
  const worst = counts.critical ? "critical"
    : counts.high ? "high"
    : counts.medium ? "medium"
    : counts.low ? "low"
    : null;
  return {
    vulnerabilitiesFound: total,
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
    severity: worst,
  };
}
const createDocumentSchema = insertDocumentSchema.omit({ createdBy: true, isSample: true });

const updateClientSchema = createClientSchema.partial();
const updateSiteSchema = createSiteSchema.partial();
// Derived from the create schemas, so attribution is excluded on update too.
// It was stripped on create and left open on update, which meant any
// authenticated user could rewrite "who ran this test" to anyone.
const updateTestSchema = createTestSchema.partial();
const updateDocumentSchema = createDocumentSchema.partial();

/**
 * Refuse a body that tries to set attribution, rather than quietly dropping it.
 *
 * Omitting the field from the schema keeps the forged value out of the record,
 * but zod strips unknown keys silently, so the write answered 200 and the
 * caller had every reason to believe "executed by" now said what they sent.
 * In an audit product that is the difference between a rejected forgery and an
 * apparently accepted one.
 */
const ATTRIBUTION_FIELDS = ["executedBy", "createdBy"] as const;

function forgedAttribution(res: Response, body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const named = ATTRIBUTION_FIELDS.filter((field) => field in (body as Record<string, unknown>));
  if (named.length === 0) return false;
  res.status(400).json({
    message: `${named.join(" and ")} is recorded from the signed-in session and cannot be supplied`,
  });
  return true;
}
const updateAIControlSettingSchema = insertAIControlSettingSchema.partial();
const updateClassifierSchema = insertClassifierSchema.partial();

/**
 * Users may only have these fields changed after creation. Username is
 * immutable, and the schema is strict so unknown keys are rejected rather
 * than silently accepted.
 */
const updateUserSchema = z
  .object({
    email: z.string().email().max(254).nullable(),
    role: z.enum(USER_ROLES),
    isActive: z.boolean(),
    password: z.string().min(8).max(256),
  })
  .partial()
  .strict();

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

// The renderer is same-origin now, so no cross-origin browser client is
// expected. The set is kept empty rather than removed so that adding one
// later is a one-line change rather than a rediscovery.
/**
 * Reject a child record whose parent does not exist.
 *
 * There are no foreign keys, and nothing validated these, so a test could be
 * created against any client id at all. It also narrows the window in which a
 * create racing a client deletion leaves an orphan behind.
 */
async function parentMissing(res: Response, clientId?: string | null, siteId?: string | null): Promise<boolean> {
  if (clientId && !(await storage.getClient(clientId))) {
    res.status(400).json({ message: "No such client" });
    return true;
  }
  if (siteId && !(await storage.getSite(siteId))) {
    res.status(400).json({ message: "No such site" });
    return true;
  }
  return false;
}


/**
 * Refuse mutations while the kill switch is on.
 *
 * The switch was persisted, shown in the UI, and enforced nowhere: with
 * killSwitchEnabled true and systemStatus "shutdown", every write still
 * succeeded. An emergency stop that stops nothing is worse than none, because
 * someone will rely on it.
 *
 * The AI control route itself is exempt, or the switch could never be turned
 * back off.
 */
const killSwitchExempt = new Set(["/api/ai-control", "/api/auth/login", "/api/auth/logout"]);

export const enforceKillSwitch: RequestHandler = (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  // Mounted under "/api", so req.path is relative to that mount: the AI
  // control route arrives here as "/ai-control", not "/api/ai-control".
  // Comparing the full path silently exempted nothing, which would have left
  // no way to switch the kill switch back off.
  const fullPath = `${req.baseUrl}${req.path}`.replace(/\/+$/, "") || req.path;
  if (killSwitchExempt.has(fullPath)) {
    next();
    return;
  }

  storage
    .getAIControlSettings()
    .then((settings) => {
      if (settings?.killSwitchEnabled) {
        res.status(503).json({
          message: "The AI kill switch is engaged. Writes are disabled.",
          systemStatus: settings.systemStatus,
        });
        return;
      }
      next();
    })
    .catch(next);
};

/**
 * Whether a request path is aimed at the API, whatever spelling it arrived in.
 *
 * Decodes once, collapses repeated slashes, and resolves dot segments, so
 * "/./api/x", "/y/../api/x", "//api/x" and "/%61pi/x" all read as API paths.
 */
function looksLikeApiPath(rawPath: string): boolean {
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    // A malformed escape cannot be decoded; test what we were given.
  }

  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments[0]?.toLowerCase() === "api";
}

/** Refuse a query parameter that was supplied more than once. */
function badQueryParam(res: Response, value: unknown): boolean {
  if (value !== undefined && typeof value !== "string") {
    res.status(400).json({ message: "Query parameters must be supplied once" });
    return true;
  }
  return false;
}

/** Whether a parsed update actually carries a change worth recording. */
function hasChanges(data: object): boolean {
  return Object.values(data).some((value) => value !== undefined);
}

const ALLOWED_ORIGINS = new Set<string>([]);

/**
 * Login throttling.
 *
 * There was none: 200 failed sign-ins in seven seconds all answered 401 and the
 * account still worked afterwards. Failures are counted per address and
 * username; a successful sign-in clears the counter.
 */
const LOGIN_MAX_FAILURES = 10;
// Higher than the per-username limit: several people can share one address.
const LOGIN_MAX_FAILURES_PER_ADDRESS = 50;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map<string, { count: number; first: number }>();

function loginKey(req: Request, username: string): string {
  // Not lowercased. The account lookup is case sensitive, so folding here let
  // an attacker who knew only the lowercase spelling of a username lock the
  // real account out by failing ten times against a casing that does not exist.
  return `${req.ip ?? "unknown"}|${username}`;
}

/** A second bucket, per address only, so a spray across usernames is bounded. */
function addressKey(req: Request): string {
  return `addr|${req.ip ?? "unknown"}`;
}

function loginBlocked(key: string, now: number, limit = LOGIN_MAX_FAILURES): boolean {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (now - entry.first > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= limit;
}

const LOGIN_MAP_LIMIT = 10_000;

function recordLoginFailure(key: string, now: number): void {
  // Bounding runs first. It used to sit after the early return below, which is
  // the path a spray across many usernames always takes, so the one case the
  // bound existed for could never reach it.
  if (loginFailures.size >= LOGIN_MAP_LIMIT) {
    pruneLoginFailures(now);
  }

  const entry = loginFailures.get(key);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, first: now });
    return;
  }
  entry.count += 1;
}

function pruneLoginFailures(now: number): void {
  const entries = Array.from(loginFailures.entries());
  for (const [key, value] of entries) {
    if (now - value.first > LOGIN_WINDOW_MS) loginFailures.delete(key);
  }

  // Still over the cap means nothing had expired, which is exactly what a fast
  // spray looks like. Drop the oldest until it fits.
  if (loginFailures.size >= LOGIN_MAP_LIMIT) {
    Array.from(loginFailures.entries())
      .sort((a, b) => a[1].first - b[1].first)
      .slice(0, Math.ceil(LOGIN_MAP_LIMIT / 4))
      .forEach(([key]) => loginFailures.delete(key));
  }
}

/** Exported for tests, which need a clean slate between cases. */
export function resetLoginThrottle(): void {
  loginFailures.clear();
}

function publicUser(user: User): PublicUser {
  const { password: _password, ...rest } = user;
  return rest;
}

function notFound(res: Response, what: string): void {
  res.status(404).json({ message: `${what} not found` });
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

export function registerRoutes(app: Express): void {
  // Allow the packaged Electron renderer (app://athena) to call the API with cookies.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // ==== AUTHENTICATION (public) ====
  app.post(
    "/api/auth/login",
    asyncHandler(async (req, res) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Username and password are required" });
        return;
      }
      const now = Date.now();
      const key = loginKey(req, parsed.data.username);
      const byAddress = addressKey(req);

      // Per username and per address. Only the first existed, so a flood of
      // distinct usernames from one address never engaged the throttle and
      // each attempt still paid for a synchronous key derivation.
      if (loginBlocked(key, now) || loginBlocked(byAddress, now, LOGIN_MAX_FAILURES_PER_ADDRESS)) {
        res.status(429).json({ message: "Too many failed sign-in attempts. Try again later." });
        return;
      }

      const user = await storage.validateUser(parsed.data.username, parsed.data.password);
      if (!user || !user.isActive) {
        recordLoginFailure(key, now);
        recordLoginFailure(byAddress, now);
        res.status(401).json({ message: "Invalid username or password" });
        return;
      }

      loginFailures.delete(key);
      loginFailures.delete(byAddress);
      await regenerateSession(req);
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;

      await storage.createActivityLog({
        action: "login",
        entityType: "user",
        entityId: user.id,
        userId: user.id,
        ipAddress: req.ip ?? null,
        details: null,
      });

      res.json({ user: publicUser(user) });
    }),
  );

  app.post(
    "/api/auth/logout",
    asyncHandler(async (req, res) => {
      const who = actor(req);
      if (req.session) {
        await destroySession(req);
      }
      res.clearCookie("athena.sid");
      if (who.userId) {
        await storage.createActivityLog({
          action: "logout", entityType: "user", entityId: who.userId, details: null, ...who,
        });
      }
      res.json({ success: true });
    }),
  );

  app.get(
    "/api/auth/check",
    asyncHandler(async (req, res) => {
      if (req.session?.userId) {
        const user = await storage.getUser(req.session.userId);
        if (user && user.isActive) {
          res.json({ authenticated: true, user: publicUser(user) });
          return;
        }
      }
      res.json({ authenticated: false });
    }),
  );

  // Everything below requires a session.
  app.use("/api", requireAuth);

  // ...and, for writes, that the kill switch is not engaged.
  app.use("/api", enforceKillSwitch);

  // ==== CLIENTS ====
  app.get("/api/clients", asyncHandler(async (_req, res) => {
    res.json(await storage.getAllClients());
  }));

  app.get("/api/clients/:id", asyncHandler(async (req, res) => {
    const client = await storage.getClient(req.params.id);
    if (!client) return notFound(res, "Client");
    res.json(client);
  }));

  app.post("/api/clients", asyncHandler(async (req, res) => {
    const data = createClientSchema.parse(req.body);
    const client = await storage.createClient(data);
    await storage.createActivityLog({
      action: "created", entityType: "client", entityId: client.id,
      details: { name: client.name, company: client.company }, ...actor(req),
    });
    res.status(201).json(client);
  }));

  app.patch("/api/clients/:id", asyncHandler(async (req, res) => {
    const data = updateClientSchema.parse(req.body);
    const client = await storage.updateClient(req.params.id, data);
    if (!client) return notFound(res, "Client");
    if (hasChanges(data)) {
      await storage.createActivityLog({ action: "updated", entityType: "client", entityId: client.id, details: null, ...actor(req) });
    }
    res.json(client);
  }));

  app.delete("/api/clients/:id", asyncHandler(async (req, res) => {
    // Deleting a client removes its tests, sites and documents. Those rows
    // used to disappear with no audit trace at all, so the log recorded one
    // deletion where ten had happened. Count them before they are gone.
    const cascaded = {
      tests: (await storage.getTestsByClient(req.params.id)).map((t) => t.id),
      sites: (await storage.getSitesByClient(req.params.id)).map((s) => s.id),
      documents: (await storage.getDocumentsByClient(req.params.id)).map((d) => d.id),
    };

    const success = await storage.deleteClient(req.params.id);
    if (!success) return notFound(res, "Client");

    await storage.createActivityLog({
      action: "deleted", entityType: "client", entityId: req.params.id,
      details: { cascaded }, ...actor(req),
    });
    res.json({ success: true });
  }));

  // ==== SITES ====
  app.get("/api/sites", asyncHandler(async (req, res) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    res.json(clientId ? await storage.getSitesByClient(clientId) : await storage.getAllSites());
  }));

  app.post("/api/sites", asyncHandler(async (req, res) => {
    const data = createSiteSchema.parse(req.body);
    if (await parentMissing(res, (data as { clientId?: string }).clientId, (data as { siteId?: string | null }).siteId)) return;
    const site = await storage.createSite(data);
    await storage.createActivityLog({
      action: "created", entityType: "site", entityId: site.id,
      details: { url: site.url, clientId: site.clientId }, ...actor(req),
    });
    res.status(201).json(site);
  }));

  app.patch("/api/sites/:id", asyncHandler(async (req, res) => {
    const data = updateSiteSchema.parse(req.body);
    const site = await storage.updateSite(req.params.id, data);
    if (!site) return notFound(res, "Site");
    if (hasChanges(data)) {
      await storage.createActivityLog({ action: "updated", entityType: "site", entityId: site.id, details: null, ...actor(req) });
    }
    res.json(site);
  }));

  app.delete("/api/sites/:id", asyncHandler(async (req, res) => {
    const success = await storage.deleteSite(req.params.id);
    if (!success) return notFound(res, "Site");
    await storage.createActivityLog({ action: "deleted", entityType: "site", entityId: req.params.id, details: null, ...actor(req) });
    res.json({ success: true });
  }));

  // ==== TESTS ====
  app.get("/api/tests", asyncHandler(async (req, res) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
    if (clientId) return void res.json(await storage.getTestsByClient(clientId));
    if (siteId) return void res.json(await storage.getTestsBySite(siteId));
    res.json(await storage.getAllTests());
  }));

  app.get("/api/tests/:id", asyncHandler(async (req, res) => {
    const test = await storage.getTest(req.params.id);
    if (!test) return notFound(res, "Test");
    res.json(test);
  }));

  app.post("/api/tests", asyncHandler(async (req, res) => {
    // Attribution is evidence in an audit product, so it comes from the
    // session and is not part of the input schema at all. The spread below
    // already overrode it, but a schema that still accepted the field is how
    // the update path came to allow forging it.
    if (forgedAttribution(res, req.body)) return;
    const data = createTestSchema.parse(req.body);
    if (await parentMissing(res, data.clientId, data.siteId)) return;
    const test = await storage.createTest({ ...data, executedBy: req.session.userId ?? null });
    await storage.createActivityLog({
      action: "created", entityType: "test", entityId: test.id,
      details: { testType: test.testType, clientId: test.clientId }, ...actor(req),
    });
    res.status(201).json(test);
  }));

  app.patch("/api/tests/:id", asyncHandler(async (req, res) => {
    if (forgedAttribution(res, req.body)) return;
    const data = updateTestSchema.parse(req.body);
    const test = await storage.updateTest(req.params.id, data);
    if (!test) return notFound(res, "Test");
    if (hasChanges(data)) {
      await storage.createActivityLog({ action: "updated", entityType: "test", entityId: test.id, details: null, ...actor(req) });
    }
    res.json(test);
  }));

  app.delete("/api/tests/:id", asyncHandler(async (req, res) => {
    const success = await storage.deleteTest(req.params.id);
    if (!success) return notFound(res, "Test");
    await storage.createActivityLog({ action: "deleted", entityType: "test", entityId: req.params.id, details: null, ...actor(req) });
    res.json({ success: true });
  }));

  // ==== SCANS: the engine, and what it found ====
  //
  // A test row is the record; the engine is what makes it true. These two
  // routes are the only place the two meet, and they are deliberately thin:
  // Athena decides who may ask and under which engagement, the engine decides
  // whether the target may be reached, and neither pretends to do the other's
  // job. A refusal from the engine is passed through with its reason intact,
  // because "the target is a loopback address" is the sentence the operator
  // needs and "scan failed" is not.

  app.get("/api/engine/status", asyncHandler(async (_req, res) => {
    res.json(await engine.status());
  }));

  app.post("/api/scans", asyncHandler(async (req, res) => {
    const data = startScanSchema.parse(req.body);

    const client = await storage.getClient(data.clientId);
    if (!client) return notFound(res, "Client");
    const site = data.siteId ? await storage.getSite(data.siteId) : null;
    if (data.siteId && !site) return notFound(res, "Site");
    // A site that belongs to another client is not a site of this engagement.
    if (site && site.clientId !== data.clientId) {
      return void res.status(400).json({
        error: "that site belongs to a different client",
      });
    }

    // The engagement the engine will record against every effect. It is the
    // client and the site, not something the caller composes, so a scan
    // cannot be filed under an engagement nobody opened.
    const engagementRef = site ? `${client.id}:${site.id}` : client.id;

    // The hosts this engagement authorises, taken from the sites somebody
    // recorded against the client. One site if one was chosen, otherwise all
    // of the client's.
    //
    // This is the half of the scope check the engine cannot do. Given no
    // scope it falls back to the target's own host, and a check whose only
    // possible answer is "yes" is not a check -- so the side holding the site
    // list is the side that has to send it.
    const engagementSites = site ? [site] : await storage.getSitesByClient(client.id);
    const scope = engagementSites
      .map((one) => hostOf(one.url))
      .filter((host): host is string => host !== null);

    if (scope.length === 0) {
      // No recorded site means nothing on record authorises any host, and
      // scanning on the strength of the target the caller just typed is the
      // unfalsifiable check again, one layer up. Refuse and say what is
      // missing.
      return void res.status(400).json({
        error:
          `no site is recorded for ${client.name}, so nothing on record ` +
          `authorises scanning ${data.target}. Add the site to the client first.`,
      });
    }

    let started;
    try {
      started = await engine.startScan({
        target: data.target,
        engagementRef,
        scope,
        // Forwarded only when the operator enabled authenticated scanning.
        ...(data.auth?.enabled ? { auth: data.auth } : {}),
      });
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        // 503, not 500. Nothing is broken: the engine is not there, or not
        // answering, and that is a fact about the deployment.
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }

    if (started.state === "refused") {
      return void res.status(409).json({
        error: "the engine refused this scan",
        detail: started.refused ?? "",
      });
    }

    const test = await storage.createTest({
      clientId: data.clientId,
      siteId: data.siteId ?? null,
      testType: data.testType,
      status: started.state === "completed" ? "completed" : "running",
      severity: null,
      completedAt: null,
      summary: `${data.target} — engine run ${started.runId ?? "unknown"}`,
      findings: { runId: started.runId, target: data.target, results: started.findings },
      vulnerabilitiesFound: 0,
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      executedBy: req.session.userId ?? null,
    });

    // File what came back as findings with a life of their own. A scan that
    // completes inline has its results now; one still running is filed when
    // it finishes, on the status route.
    const filed = await lifecycle.ingest(storage, started.findings ?? [], {
      clientId: data.clientId,
      siteId: data.siteId ?? null,
      engagementRef,
      target: data.target,
      testId: test.id,
      runId: started.runId ?? null,
    });

    await storage.createActivityLog({
      action: "started", entityType: "test", entityId: test.id,
      details: { target: data.target, engagementRef, runId: started.runId, filed },
      ...actor(req),
    });

    res.status(201).json({ test, runId: started.runId, state: started.state, filed });
  }));

  /**
   * Stop a scan that is going wrong.
   *
   * The engine has had a stop button since the abort registry landed, and the
   * client here has had `abort` since the engine was first wired up. Nothing
   * called it: there was no route, so there was no button, and an operator
   * watching a scan they wanted to halt could revoke the whole API key or
   * nothing. Making the stop fast is worth little while it is unreachable.
   */
  app.post("/api/scans/:testId/abort", asyncHandler(async (req, res) => {
    const test = await storage.getTest(req.params.testId);
    if (!test) return notFound(res, "Test");

    const recorded = (test.findings ?? {}) as Record<string, unknown>;
    const runId = typeof recorded.runId === "string" ? recorded.runId : null;
    if (!runId) {
      return void res.status(409).json({
        error: "this test has no engine run recorded against it, so there is nothing to stop",
      });
    }

    let stopped: boolean;
    try {
      stopped = await engine.abort(runId);
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }

    // The engine's answer, not an assumption. Recording "aborted" on a stop
    // the engine did not accept would be the record saying a scan halted when
    // it is still running against somebody's system.
    if (!stopped) {
      return void res.status(502).json({
        error: "the engine did not accept the stop; the scan may still be running",
      });
    }

    await storage.createActivityLog({
      action: "aborted", entityType: "test", entityId: test.id,
      details: { runId }, ...actor(req),
    });

    res.json({ stopped: true, runId });
  }));

  app.get("/api/scans/:testId", asyncHandler(async (req, res) => {
    const test = await storage.getTest(req.params.testId);
    if (!test) return notFound(res, "Test");

    const recorded = (test.findings ?? {}) as Record<string, unknown>;
    const runId = typeof recorded.runId === "string" ? recorded.runId : null;
    if (!runId || test.status === "completed") {
      return void res.json({ test, state: test.status, engine: null });
    }

    let current;
    try {
      current = await engine.runState(runId);
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        // The record stands even when the engine has gone. Saying so beats
        // reporting the row's last known status as if it were current.
        return void res.status(200).json({
          test, state: test.status, engine: null, detail: cause.message,
        });
      }
      throw cause;
    }

    // Counted from what came back, never from what was asked for.
    const counts = countSeverities(current.findings);
    const finished = current.state === "completed" || current.state === "aborted"
      || current.state === "failed";

    const updated = await storage.updateTest(test.id, {
      status: current.state,
      completedAt: finished ? new Date() : null,
      findings: { ...recorded, results: current.findings },
      ...counts,
    });

    // Filed once the run has stopped moving. Filing a scan still in flight
    // would record half a picture as the current state of the engagement,
    // and the next poll would file the same findings again.
    let filed: lifecycle.IngestResult | null = null;
    if (finished) {
      const client = await storage.getClient(test.clientId);
      const site = test.siteId ? await storage.getSite(test.siteId) : null;
      if (client) {
        filed = await lifecycle.ingest(storage, current.findings ?? [], {
          clientId: client.id,
          siteId: test.siteId ?? null,
          engagementRef: site ? `${client.id}:${site.id}` : client.id,
          target: typeof recorded.target === "string" ? recorded.target : null,
          testId: test.id,
          runId,
        });
      }
    }

    res.json({ test: updated ?? test, state: current.state, engine: current, filed });
  }));

  // ==== RETEST ====
  //
  // "Prove it was fixed" is the second of the six deliverables this product
  // advertises that the engine has always been able to answer and this app
  // never asked. The engine captures a decision twin per real finding during a
  // scan, and /api/remediation/retest goes back to the target and looks again.
  //
  // The verdict is the engine's own word and is passed through unchanged.
  // There are three, and they are not two: closed, still_open, inconclusive.
  // Measured against a live engine with the target simply switched off, the
  // answer is `inconclusive` with the connection error as its detail -- not
  // `closed`. A screen that renders this as fixed/not-fixed would report a
  // host that went down as a vulnerability remediated.

  /** The decisions the engine kept during this test's run. */
  app.get("/api/tests/:testId/decisions", asyncHandler(async (req, res) => {
    const test = await storage.getTest(req.params.testId);
    if (!test) return notFound(res, "Test");

    const recorded = (test.findings ?? {}) as Record<string, unknown>;
    const runId = typeof recorded.runId === "string" ? recorded.runId : null;
    if (!runId) {
      // A test with no engine run behind it -- a sample row, or one recorded
      // before the engine was wired up -- has nothing to retest. Said plainly
      // rather than returning an empty list, which reads as "the scan found
      // nothing worth keeping".
      return void res.json({
        decisions: [],
        truncated: false,
        detail: "this test has no engine run behind it, so there is nothing to retest",
      });
    }

    try {
      const listed = await engine.listDecisions(runId);
      res.json({ ...listed, detail: "" });
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }
  }));

  const retestSchema = z.object({ twinId: z.number().int().nonnegative() });

  app.post("/api/tests/:testId/retest", asyncHandler(async (req, res) => {
    const data = retestSchema.parse(req.body);

    const test = await storage.getTest(req.params.testId);
    if (!test) return notFound(res, "Test");

    const client = await storage.getClient(test.clientId);
    if (!client) return notFound(res, "Client");
    const site = test.siteId ? await storage.getSite(test.siteId) : null;

    // Composed here, from the engagement this test was filed under -- not
    // taken from the twin. A retest touches the customer's system, and the
    // engine used to derive its scope from the twin's own recorded target,
    // which is a check whose only possible answer is yes. The side holding
    // the site list is the side that has to send it.
    const engagementRef = site ? `${client.id}:${site.id}` : client.id;
    const engagementSites = site ? [site] : await storage.getSitesByClient(client.id);
    const scope = engagementSites
      .map((one) => hostOf(one.url))
      .filter((host): host is string => host !== null);

    if (scope.length === 0) {
      return void res.status(400).json({
        error:
          `no site is recorded for ${client.name}, so nothing on record ` +
          `authorises going back to that target. Add the site to the client first.`,
      });
    }

    let result;
    try {
      result = await engine.retest({ twinId: data.twinId, engagementRef, scope });
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }

    // Carry the verdict into the finding it is about.
    //
    // The finding is identified from the twin's own recorded place, fetched
    // from the engine -- not from anything the caller sent. A caller who could
    // name the finding to mark fixed could mark any finding fixed, which is
    // the one thing this lifecycle exists to prevent.
    let applied: { findingId: string; status: string; detail: string } | null = null;
    const recorded = (test.findings ?? {}) as Record<string, unknown>;
    const runId = typeof recorded.runId === "string" ? recorded.runId : null;
    if (runId) {
      try {
        const listed = await engine.listDecisions(runId);
        const twin = listed.decisions.find((one) => one.id === data.twinId);
        if (twin) {
          const key = lifecycle.fingerprint(client.id, {
            type: twin.findingType,
            severity: null, message: null,
            target: twin.target,
            endpoint: twin.endpoint,
            header: null,
          });
          const finding = await storage.findFindingByFingerprint(client.id, key);
          if (finding) {
            const decided = lifecycle.statusFromVerdict(result.verdict, finding.status);
            await storage.updateFinding(finding.id, {
              status: decided.status,
              statusNote: decided.detail,
              statusChangedBy: req.session.userId ?? null,
              statusChangedAt: new Date(),
              // Only a `closed` verdict writes these, and they are what makes
              // the claim checkable afterwards.
              ...(decided.fixed
                ? { fixedAt: new Date(), fixedByRunId: result.runId, fixedVerdict: result.verdict }
                : { fixedAt: null, fixedByRunId: null, fixedVerdict: null }),
            });
            // Appended, never replaced. The answer given today does not erase
            // the answer given last month: a client asking whether March's
            // findings are gone is owed the sequence, not the last word.
            await storage.recordCheck({
              findingId: finding.id,
              verdict: result.verdict,
              detail: result.detail || decided.detail,
              runId: result.runId,
              inventoryDigest: result.inventoryDigest,
              checkedBy: req.session.userId ?? null,
            });
            applied = { findingId: finding.id, status: decided.status, detail: decided.detail };
          }
        }
      } catch (cause) {
        // The retest itself succeeded; failing to file it is worth saying but
        // is not worth throwing away the verdict the operator asked for.
        if (!(cause instanceof engine.EngineUnavailable)) throw cause;
      }
    }

    // A retest sends real requests to somebody's system, so it is an act and
    // belongs in the record with the authority it ran under.
    await storage.createActivityLog({
      action: "retested", entityType: "test", entityId: test.id,
      details: {
        twinId: data.twinId,
        engagementRef,
        verdict: result.verdict,
        findingType: result.findingType,
        target: result.target,
        applied,
      },
      ...actor(req),
    });

    res.json({ ...result, applied });
  }));

  // ==== DOCUMENTS ====
  app.get("/api/documents", asyncHandler(async (req, res) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    res.json(clientId ? await storage.getDocumentsByClient(clientId) : await storage.getAllDocuments());
  }));

  app.post("/api/documents", asyncHandler(async (req, res) => {
    if (forgedAttribution(res, req.body)) return;
    const data = createDocumentSchema.parse(req.body);
    if (await parentMissing(res, (data as { clientId?: string }).clientId, (data as { siteId?: string | null }).siteId)) return;
    const document = await storage.createDocument({ ...data, createdBy: req.session.userId ?? null });
    await storage.createActivityLog({
      action: "created", entityType: "document", entityId: document.id,
      details: { title: document.title, clientId: document.clientId }, ...actor(req),
    });
    res.status(201).json(document);
  }));

  app.patch("/api/documents/:id", asyncHandler(async (req, res) => {
    if (forgedAttribution(res, req.body)) return;
    const data = updateDocumentSchema.parse(req.body);
    const document = await storage.updateDocument(req.params.id, data);
    if (!document) return notFound(res, "Document");
    if (hasChanges(data)) {
      await storage.createActivityLog({ action: "updated", entityType: "document", entityId: document.id, details: null, ...actor(req) });
    }
    res.json(document);
  }));

  app.delete("/api/documents/:id", asyncHandler(async (req, res) => {
    const success = await storage.deleteDocument(req.params.id);
    if (!success) return notFound(res, "Document");
    await storage.createActivityLog({ action: "deleted", entityType: "document", entityId: req.params.id, details: null, ...actor(req) });
    res.json({ success: true });
  }));

  // ==== ACTIVITY LOGS (read-only; entries are written by the server) ====
  // Admin-only: the log carries every user's id, IP address and sign-in
  // times, and the user administration it describes is itself admin-only.
  app.get("/api/logs", requireAdmin, asyncHandler(async (req, res) => {
    // A repeated or array-valued parameter used to fail the string test and be
    // dropped, so the filter silently disappeared and the endpoint returned
    // everything rather than refusing.
    if (badQueryParam(res, req.query.entityType) || badQueryParam(res, req.query.entityId)) return;
    const entityType = typeof req.query.entityType === "string" ? req.query.entityType : undefined;
    const entityId = typeof req.query.entityId === "string" ? req.query.entityId : undefined;
    if (entityType && entityId) {
      return void res.json(await storage.getActivityLogsByEntity(entityType, entityId));
    }
    res.json(await storage.getAllActivityLogs());
  }));

  // ==== AI HEALTH ====
  app.get("/api/ai-health/latest", asyncHandler(async (_req, res) => {
    // null rather than 404. "No reading has been taken yet" is a state of a
    // healthy deployment in its first minute, not a missing resource, and a
    // 404 made the screen render its error fallback on every fresh install.
    res.json((await storage.getLatestAIHealthMetric()) ?? null);
  }));

  app.get("/api/ai-health", asyncHandler(async (req, res) => {
    const raw = parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1000) : 50;
    res.json(await storage.getAIHealthMetrics(limit));
  }));

  app.post("/api/ai-health", requireAdmin, asyncHandler(async (req, res) => {
    const data = insertAIHealthMetricSchema.parse(req.body);
    const metric = await storage.createAIHealthMetric(data);
    await storage.createActivityLog({
      action: "created", entityType: "ai_health_metric", entityId: metric.id,
      details: null, ...actor(req),
    });
    res.status(201).json(metric);
  }));

  // ==== USERS (admin only) ====
  /**
   * Who a finding can be given to.
   *
   * Separate from /api/users, which is admin-only and returns the whole user
   * record. Assigning an owner is ordinary work for any operator, and this
   * returns only what a picker needs -- an id and a name. The findings list
   * already shows owners by name, so this discloses nothing it does not.
   */
  app.get("/api/users/assignable", asyncHandler(async (_req, res) => {
    const users = await storage.getAllUsers();
    res.json(users
      .filter((one) => one.isActive)
      .map((one) => ({ id: one.id, username: one.username })));
  }));

  app.get("/api/users", requireAdmin, asyncHandler(async (_req, res) => {
    const users = await storage.getAllUsers();
    res.json(users.map(publicUser));
  }));

  app.post("/api/users", requireAdmin, asyncHandler(async (req, res) => {
    const data = insertUserSchema.parse(req.body);
    if (await storage.getUserByUsername(data.username)) {
      res.status(409).json({ message: "Username already exists" });
      return;
    }
    const user = await storage.createUser(data);
    await storage.createActivityLog({
      action: "created", entityType: "user", entityId: user.id,
      details: { username: user.username, role: user.role }, ...actor(req),
    });
    res.status(201).json(publicUser(user));
  }));

  app.patch("/api/users/:id", requireAdmin, asyncHandler(async (req, res) => {
    const data = updateUserSchema.parse(req.body);
    const isSelf = req.params.id === req.session.userId;
    if (isSelf && (data.role === "user" || data.isActive === false)) {
      res.status(400).json({ message: "You cannot demote or deactivate your own account" });
      return;
    }
    const user = await storage.updateUser(req.params.id, data);
    if (!user) return notFound(res, "User");
    const changed = Object.keys(data).filter((k) => k !== "password");
    await storage.createActivityLog({
      action: "updated", entityType: "user", entityId: user.id,
      details: { fields: data.password ? [...changed, "password"] : changed }, ...actor(req),
    });
    res.json(publicUser(user));
  }));

  app.delete("/api/users/:id", requireAdmin, asyncHandler(async (req, res) => {
    if (req.params.id === req.session.userId) {
      res.status(400).json({ message: "You cannot delete your own account" });
      return;
    }
    const success = await storage.deleteUser(req.params.id);
    if (!success) return notFound(res, "User");
    await storage.createActivityLog({ action: "deleted", entityType: "user", entityId: req.params.id, details: null, ...actor(req) });
    res.json({ success: true });
  }));

  // ==== AI CONTROL ====
  app.get("/api/ai-control", asyncHandler(async (_req, res) => {
    const settings = await storage.getAIControlSettings();
    res.json(settings ?? (await storage.updateAIControlSettings({})));
  }));

  app.patch("/api/ai-control", requireAdmin, asyncHandler(async (req, res) => {
    const data = updateAIControlSettingSchema.parse(req.body);
    const settings = await storage.updateAIControlSettings({ ...data, lastModifiedBy: req.session.userId ?? null });
    await storage.createActivityLog({ action: "updated", entityType: "ai_control", entityId: settings.id, details: data, ...actor(req) });
    res.json(settings);
  }));

  // ==== AI CHAT ====
  app.get("/api/chat", asyncHandler(async (req, res) => {
    res.json(await storage.getChatMessagesByUser(req.session.userId!));
  }));

  // ==== SETTINGS: where this deployment talks to ====
  //
  // Admin only, both ways. These fields decide where a customer's data goes
  // -- which engine is asked to scan them, and which third party sees a
  // summary of what was found -- so they are not an ordinary user's to read
  // or to change.

  app.get("/api/settings/connections", requireAdmin, asyncHandler(async (_req, res) => {
    // Secrets come back as `set: true` and `value: null`. There is no benign
    // version of an API key on the wire: it reaches a browser, a devtools
    // network tab and whatever is between, and the only thing the screen
    // needs is whether somebody has to type one.
    res.json({ fields: settings.readable() });
  }));

  app.patch("/api/settings/connections", requireAdmin, asyncHandler(async (req, res) => {
    const data = updateConnectionSettingsSchema.parse(req.body);
    await settings.save(data, req.session.userId ?? null);

    // Which fields moved, never what they moved to. An audit log that records
    // a credential is a second place the credential lives.
    await storage.createActivityLog({
      action: "updated", entityType: "connection_settings", entityId: "singleton",
      details: { fields: Object.keys(data).sort() },
      ...actor(req),
    });

    res.json({ fields: settings.readable() });
  }));

  // ==== SAMPLE DATA ====
  // The installer seeds three clients, four sites, three tests and three
  // documents so a fresh install is not a blank screen. Two of those tests
  // carry severity counts, and until now the dashboard added them into its
  // totals with nothing to say they were written rather than found. Reading
  // is open to anyone signed in, because every screen that counts these rows
  // needs to say so; removing them is an admin's.

  app.get("/api/sample-data", asyncHandler(async (_req, res) => {
    res.json(await storage.countSampleData());
  }));

  app.delete("/api/sample-data", requireAdmin, asyncHandler(async (req, res) => {
    const removed = await storage.removeSampleData();
    await storage.createActivityLog({
      action: "deleted", entityType: "sample_data", entityId: null,
      details: removed, ...actor(req),
    });
    res.json({ removed });
  }));

  /**
   * Classify a vulnerability description with the engine's model.
   *
   * The screen behind this printed "SQL Injection, 92% confident" for every
   * input, then stopped classifying at all on the stated grounds that the
   * engine had no such route. It has one. This is that route.
   */
  const classifyRequestSchema = z.object({
    text: z.string().trim().min(1, "there is nothing to classify").max(20_000),
  });

  app.post("/api/classify-cve", asyncHandler(async (req, res) => {
    // Rejected here rather than sent on. An empty string is a question the
    // model cannot be asked: it answers at the floor with a tie-break label,
    // which reads exactly like a finding.
    const data = classifyRequestSchema.parse(req.body);

    let result;
    try {
      result = await engine.classifyCve(data.text);
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }

    if (result.unavailable) {
      // The engine's own words. Its model can be absent while the engine is
      // up, and that is a different thing from the engine being down.
      return void res.status(503).json({ error: result.unavailable });
    }

    res.json(result);
  }));

  // ==== EVIDENCE ====
  // "Evidence Pack" is one of the six things this product says it produces.
  // The engine has built them all along -- signed, Merkle-committed, with a
  // per-source status -- and nothing in this app ever asked for one.

  const evidenceRequestSchema = z.object({
    clientId: z.string().min(1),
    siteId: z.string().optional(),
    testId: z.string().optional(),
    reason: z.string().trim().min(1, "say what this pack is for").max(1000),
  });

  app.post("/api/evidence-pack", requireAdmin, asyncHandler(async (req, res) => {
    // Admin only. A pack is a cross-source record of what this deployment did
    // to somebody's systems, assembled for handing to a third party.
    const data = evidenceRequestSchema.parse(req.body);

    const client = await storage.getClient(data.clientId);
    if (!client) return notFound(res, "Client");
    const site = data.siteId ? await storage.getSite(data.siteId) : null;
    if (data.siteId && !site) return notFound(res, "Site");
    if (site && site.clientId !== data.clientId) {
      return void res.status(400).json({ error: "that site belongs to a different client" });
    }

    // The same engagement string the scan was filed under, composed the same
    // way. A pack scoped to a different spelling of the engagement is a pack
    // about nothing.
    const engagementRef = site ? `${client.id}:${site.id}` : client.id;

    // The engine's run id, when this pack is about one test. Recorded in the
    // test's findings by the scan route.
    let runId: string | undefined;
    if (data.testId) {
      const test = await storage.getTest(data.testId);
      if (!test) return notFound(res, "Test");
      if (test.clientId !== data.clientId) {
        return void res.status(400).json({ error: "that test belongs to a different client" });
      }
      const recorded = (test.findings ?? {}) as Record<string, unknown>;
      if (typeof recorded.runId === "string") runId = recorded.runId;
    }

    let pack;
    try {
      pack = await engine.buildEvidencePack({ engagementRef, reason: data.reason, runId });
    } catch (cause) {
      if (cause instanceof engine.EngineUnavailable) {
        return void res.status(503).json({ error: cause.message });
      }
      throw cause;
    }

    // Recorded because issuing one is an act: it assembles a customer's
    // records into a document that leaves this machine. What it was for is
    // part of that, which is why `reason` is required.
    await storage.createActivityLog({
      action: "issued", entityType: "evidence_pack", entityId: engagementRef,
      details: {
        reason: data.reason,
        signed: pack.signed,
        leafCount: pack.leafCount,
        merkleRoot: pack.merkleRoot,
        runId: runId ?? null,
      },
      ...actor(req),
    });

    res.json(pack);
  }));

  // ==== FAILSAFE ====
  //
  // The operator console for the three engine failsafes -- pause, stand-down,
  // terminate. This server drafts commands and RELAYS operator signatures; it
  // never holds a signing key, so nothing here can make an engine act on its
  // own. Operators sign out of band with `mythos-failsafe` (their private key
  // stays on their machine), stand-down and terminate need two distinct
  // operators, and the engine independently verifies every command before
  // obeying. See server/failsafe.ts for the trust model.
  //
  // Every route is admin-only: these are the highest-stakes controls in the
  // product, so reaching the console at all is a guarded action. The
  // cryptographic two-person rule is the guard on the actions themselves.

  const FAILSAFE_ACTIONS = ["pause", "resume", "stand_down", "release", "terminate"] as const;
  const draftCommandSchema = z.object({
    action: z.enum(FAILSAFE_ACTIONS),
    engineId: z.string().trim().min(1, "an engine id is required").max(200),
    reason: z.string().max(2000).optional().default(""),
  });
  const submitSignatureSchema = z.object({
    keyId: z.string().trim().min(1).max(128),
    sig: z.string().trim().regex(/^[0-9a-fA-F]+$/, "a signature is hex").max(256),
  });
  const failsafeUnavailable = (res: Response, cause: unknown): boolean => {
    if (cause instanceof failsafe.FailsafeUnavailable) {
      // 503, not 500: the control plane is not there or not answering, which
      // is a fact about the deployment, not a bug in this server.
      res.status(503).json({ error: cause.message });
      return true;
    }
    return false;
  };

  app.get("/api/failsafe/status", requireAdmin, asyncHandler(async (_req, res) => {
    // status() answers its own unreachability rather than throwing, so a
    // control plane that is simply not configured renders as words on the
    // page, not a 503.
    res.json({ ...(await failsafe.status()), defaultEngineId: failsafe.defaultEngineId() });
  }));

  app.get("/api/failsafe/state", requireAdmin, asyncHandler(async (req, res) => {
    const engineId = typeof req.query.engineId === "string" ? req.query.engineId : undefined;
    try {
      res.json(await failsafe.state(engineId));
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  app.get("/api/failsafe/commands", requireAdmin, asyncHandler(async (req, res) => {
    const engineId = typeof req.query.engineId === "string" ? req.query.engineId : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    try {
      res.json(await failsafe.listCommands({ engineId, status }));
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  app.post("/api/failsafe/commands", requireAdmin, asyncHandler(async (req, res) => {
    const data = draftCommandSchema.parse(req.body);
    let result;
    try {
      result = await failsafe.draftCommand(data);
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) {
      // The backend's own refusal, verbatim -- e.g. terminate from a service
      // account that is not an admin. The operator needs the reason.
      return void res.status(result.status).json({ error: result.detail });
    }
    // Drafting a failsafe command is an act worth recording on this side too,
    // independent of the backend's own audit trail.
    await storage.createActivityLog({
      action: "drafted",
      entityType: "failsafe_command",
      entityId: result.drafted.command.uuid,
      details: { failsafeAction: data.action, engineId: data.engineId, reason: data.reason },
      ...actor(req),
    });
    res.status(201).json(result.drafted);
  }));

  app.get("/api/failsafe/commands/:uuid", requireAdmin, asyncHandler(async (req, res) => {
    let drafted;
    try {
      drafted = await failsafe.getCommand(req.params.uuid);
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
    if (!drafted) return notFound(res, "Command");
    res.json(drafted);
  }));

  app.post("/api/failsafe/commands/:uuid/signatures", requireAdmin, asyncHandler(async (req, res) => {
    const data = submitSignatureSchema.parse(req.body);
    let result;
    try {
      result = await failsafe.submitSignature(req.params.uuid, data);
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) {
      // A rejected signature (bad key, forged, already signed) is the operator's
      // to see verbatim -- it is the whole point of relaying it here.
      return void res.status(result.status).json({ error: result.detail });
    }
    await storage.createActivityLog({
      action: "signed",
      entityType: "failsafe_command",
      entityId: req.params.uuid,
      details: { keyId: data.keyId, status: result.command.status, signers: result.command.signers },
      ...actor(req),
    });
    res.json(result.command);
  }));

  app.post("/api/failsafe/commands/:uuid/cancel", requireAdmin, asyncHandler(async (req, res) => {
    let result;
    try {
      result = await failsafe.cancelCommand(req.params.uuid);
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) {
      return void res.status(result.status).json({ error: result.detail });
    }
    await storage.createActivityLog({
      action: "canceled",
      entityType: "failsafe_command",
      entityId: req.params.uuid,
      details: { status: result.command.status },
      ...actor(req),
    });
    res.json(result.command);
  }));

  app.get("/api/failsafe/audit", requireAdmin, asyncHandler(async (req, res) => {
    const command = typeof req.query.command === "string" ? req.query.command : undefined;
    try {
      res.json(await failsafe.audit({ command }));
    } catch (cause) {
      if (failsafeUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  // ==== ASSURANCE (system of record, read + disposition) ====
  //
  // A read-through to the Athena control plane (Athena-Backend), which is the
  // system of record for the assurance graph: the deployments under assurance,
  // their findings graded by how strongly each is known, the six-state
  // deployment decision, and the Unknowns Register. The browser calls this
  // server same-origin with its session cookie; this server reaches the backend
  // with its service account (server/assurance.ts). Every route is behind the
  // `/api` requireAuth guard above; the reads stay open to any signed-in
  // operator, but the two writes -- recompute a decision, dispose of an Unknown
  // -- are admin-only, so a non-admin gets a clean 403 at the front door rather
  // than reaching the backend (which enforces the same rule independently).
  // When no control plane is configured the calls answer 503 with a reason, and
  // the screen says so in words rather than inventing data.

  const assuranceUnavailable = (res: Response, cause: unknown): boolean => {
    if (cause instanceof assurance.ControlPlaneUnavailable) {
      res.status(503).json({ error: cause.message });
      return true;
    }
    return false;
  };
  const qp = (req: Request, key: string): string | undefined =>
    typeof req.query[key] === "string" ? (req.query[key] as string) : undefined;

  app.get("/api/assurance/status", asyncHandler(async (_req, res) => {
    // status() answers its own unreachability rather than throwing, so an
    // unconfigured backend renders as words, not a 503.
    res.json(await assurance.status());
  }));

  app.get("/api/assurance/deployments", asyncHandler(async (_req, res) => {
    try {
      res.json(await assurance.listDeployments());
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  app.get("/api/assurance/findings", asyncHandler(async (req, res) => {
    try {
      res.json(
        await assurance.listFindings({
          deployment: qp(req, "deployment"),
          severity: qp(req, "severity"),
          status: qp(req, "status"),
        }),
      );
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  app.get("/api/assurance/unknowns", asyncHandler(async (req, res) => {
    try {
      res.json(
        await assurance.listUnknowns({
          deployment: qp(req, "deployment"),
          status: qp(req, "status"),
          impact: qp(req, "impact"),
        }),
      );
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  app.get("/api/assurance/assets", asyncHandler(async (req, res) => {
    try {
      res.json(
        await assurance.listAssets({
          deployment: qp(req, "deployment"),
          kind: qp(req, "kind"),
          classification: qp(req, "classification"),
        }),
      );
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  app.get("/api/assurance/providers", asyncHandler(async (_req, res) => {
    try {
      res.json(await assurance.listProviders());
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
  }));

  const recomputeSchema = z.object({ paused: z.boolean().optional().default(false) });

  app.post("/api/assurance/deployments/:uuid/recompute", requireAdmin, asyncHandler(async (req, res) => {
    const { paused } = recomputeSchema.parse(req.body ?? {});
    let result;
    try {
      result = await assurance.recomputeDecision(req.params.uuid, paused);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) {
      // The backend's own refusal (a deployment that is gone, a credential that
      // may not recompute it), verbatim, so the operator sees why.
      return void res.status(result.status).json({ error: result.detail });
    }
    await storage.createActivityLog({
      action: "recomputed",
      entityType: "assurance_deployment",
      entityId: req.params.uuid,
      details: { decision: result.decision, paused },
      ...actor(req),
    });
    res.json({ decision: result.decision, decisionLabel: result.decisionLabel });
  }));

  const unknownPatchSchema = z
    .object({
      status: z.enum(["open", "investigating", "resolved", "accepted"]).optional(),
      deploymentImpact: z.enum(["low", "medium", "high"]).optional(),
      notes: z.string().max(2000).optional(),
      reviewBy: z.string().max(32).nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: "name at least one field to change" });

  app.patch("/api/assurance/unknowns/:uuid", requireAdmin, asyncHandler(async (req, res) => {
    const data = unknownPatchSchema.parse(req.body);
    let result;
    try {
      result = await assurance.patchUnknown(req.params.uuid, data);
    } catch (cause) {
      if (assuranceUnavailable(res, cause)) return;
      throw cause;
    }
    if (!result.ok) {
      // The backend's own refusal, verbatim, so the operator sees why.
      return void res.status(result.status).json({ error: result.detail });
    }
    await storage.createActivityLog({
      action: "updated",
      entityType: "assurance_unknown",
      entityId: req.params.uuid,
      details: { status: result.unknown.status, deploymentImpact: result.unknown.deploymentImpact },
      ...actor(req),
    });
    res.json(result.unknown);
  }));

  // ==== FINDING LIFECYCLE ====
  //
  // A finding as a thing with a life: an identity that survives a rescan, an
  // owner, and a status. The rule that matters is what a person may set.
  // `fixed` is not on that list. It is a claim about the customer's system and
  // only a retest the engine answered `closed` may make it -- the route below
  // refuses it, and the retest route writes it along with the run that earned
  // it. A human may accept a risk or say they have looked at something; those
  // are opinions, stored under their name as opinions.

  app.get("/api/findings", asyncHandler(async (req, res) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : null;
    if (!clientId) {
      return void res.status(400).json({ error: "name the engagement: ?clientId=" });
    }
    const client = await storage.getClient(clientId);
    if (!client) return notFound(res, "Client");

    const status = typeof req.query.status === "string" ? req.query.status : null;
    const rows = (await storage.getFindingsByClient(clientId))
      .filter((one) => (status ? one.status === status : true))
      .sort((a, b) => Number(b.lastSeenAt) - Number(a.lastSeenAt));

    // Owners as names, so the page does not have to hold a user table to
    // render "who has this".
    const users = await storage.getAllUsers();
    const nameOf = new Map(users.map((one) => [one.id, one.username]));

    // Each finding's own history: what every run observed, and every retest
    // that has ever been run against it. This is what makes a second
    // engagement weeks later answer "is what you found last time gone?" --
    // from a record of observations rather than a status field whose past was
    // overwritten each time it changed.
    const withHistory = await Promise.all(rows.map(async (one) => ({
      ...one,
      ownerName: one.ownerId ? nameOf.get(one.ownerId) ?? null : null,
      sightings: (await storage.getSightings(one.id))
        .sort((a, b) => Number(a.observedAt) - Number(b.observedAt)),
      checks: (await storage.getChecks(one.id))
        .sort((a, b) => Number(a.checkedAt) - Number(b.checkedAt)),
    })));

    res.json({
      findings: withHistory,
      counts: {
        open: rows.filter((one) => one.status === "open").length,
        acknowledged: rows.filter((one) => one.status === "acknowledged").length,
        accepted: rows.filter((one) => one.status === "accepted").length,
        fixed: rows.filter((one) => one.status === "fixed").length,
      },
    });
  }));

  const findingPatchSchema = z.object({
    // `fixed` is deliberately absent. A caller who sends it gets the sentence
    // below rather than a silent rejection, because the reason is the point.
    status: z.enum(SETTABLE_FINDING_STATUS).optional(),
    ownerId: z.string().nullable().optional(),
    note: z.string().trim().max(1000).optional(),
  });

  app.patch("/api/findings/:id", asyncHandler(async (req, res) => {
    if (req.body?.status === "fixed") {
      return void res.status(400).json({
        error:
          "a finding cannot be marked fixed by hand. Fixed means the engine went " +
          "back to the target and did not find it: run a retest, and if it comes " +
          "back closed the finding is closed with the run that proved it. If the " +
          "risk is being carried rather than removed, mark it accepted.",
      });
    }
    const data = findingPatchSchema.parse(req.body);

    const finding = await storage.getFinding(req.params.id);
    if (!finding) return notFound(res, "Finding");

    if (data.ownerId) {
      const owner = await storage.getUser(data.ownerId);
      if (!owner) return void res.status(400).json({ error: "no such user to own it" });
    }

    const updated = await storage.updateFinding(finding.id, {
      ...(data.status ? { status: data.status } : {}),
      ...(data.ownerId !== undefined ? { ownerId: data.ownerId } : {}),
      ...(data.note !== undefined ? { statusNote: data.note } : {}),
      ...(data.status || data.note !== undefined
        ? { statusChangedBy: req.session.userId ?? null, statusChangedAt: new Date() }
        : {}),
      // Whatever a person does here, the evidence columns are theirs to read
      // and nobody's to write.
    });

    await storage.createActivityLog({
      action: "updated", entityType: "finding", entityId: finding.id,
      details: {
        status: data.status ?? finding.status,
        ownerId: data.ownerId ?? finding.ownerId,
        note: data.note ?? null,
      },
      ...actor(req),
    });

    res.json(updated);
  }));

  // ==== COMPLIANCE ====
  //
  // "Compliance mapping" is the third of the six advertised deliverables, and
  // the one with the most room to mislead. The engine's scanners bear on 21 of
  // ASVS 4.0.3's 286 requirements. A screen that rendered 286 rows and left
  // 265 of them looking satisfied would tell a customer something false about
  // the great majority of the standard -- and convincingly, because the 21 are
  // real. So the four states are kept apart all the way to the page, and the
  // untested ones are counted out loud.

  app.get("/api/compliance/:clientId", asyncHandler(async (req, res) => {
    const client = await storage.getClient(req.params.clientId);
    if (!client) return notFound(res, "Client");

    const siteId = typeof req.query.siteId === "string" ? req.query.siteId : null;
    if (siteId) {
      const site = await storage.getSite(siteId);
      if (!site) return notFound(res, "Site");
      if (site.clientId !== client.id) {
        return void res.status(400).json({ error: "that site belongs to a different client" });
      }
    }

    const tests = (await storage.getTestsByClient(client.id))
      .filter((test) => (siteId ? test.siteId === siteId : true))
      // A row the installer wrote is not evidence about a customer's systems.
      // Counting sample findings towards a compliance verdict would be the
      // seeded-dashboard failure again, in the one place it matters most.
      .filter((test) => test.isSample !== true);

    const findings: ScanFinding[] = [];
    for (const test of tests) {
      const recorded = (test.findings ?? {}) as Record<string, unknown>;
      const results = Array.isArray(recorded.results) ? recorded.results : [];
      for (const one of results) {
        const finding = one as Record<string, unknown>;
        // Measured against a live engine: the scanner emits `header` at the
        // top level, and the pipeline moves a scanner's own fields into
        // `evidence` before the finding is returned. Reading only the top
        // level found nothing, so every missing-header finding was reported
        // as one the standard does not cover -- a wrong answer that looked
        // like a considered one. Both places are read; evidence wins.
        const evidence = (finding.evidence ?? {}) as Record<string, unknown>;
        const header = typeof evidence.header === "string"
          ? evidence.header
          : typeof finding.header === "string" ? finding.header : undefined;
        findings.push({
          testId: test.id,
          type: typeof finding.type === "string" ? finding.type : undefined,
          header,
          severity: typeof finding.severity === "string" ? finding.severity : undefined,
          message: typeof finding.message === "string" ? finding.message : undefined,
          internal: finding.internal === true,
        });
      }
    }

    // Null when the engine could not be asked, and null is not an empty list:
    // an engine that did not answer has not told us anything ran, so every
    // requirement a scanner could reach is reported as not run rather than
    // tested. Reading silence as a pass is the failure this screen is about.
    const scanners = await engine.loadedScanners();

    const { rows, summary } = controlMap(findings, scanners);
    res.json({
      client: { id: client.id, name: client.name },
      siteId,
      testsConsidered: tests.length,
      scannersLoaded: scanners,
      rows,
      summary,
    });
  }));

  app.get("/api/assistant/status", asyncHandler(async (_req, res) => {
    res.json(await assistant.status());
  }));

  app.post("/api/chat", asyncHandler(async (req, res) => {
    // `sender` is the server's to set, not the caller's. The browser used to
    // POST `sender: "ai"` with a string it had chosen itself, so the record
    // could not distinguish a message an assistant produced from one the page
    // made up -- which is exactly what it was doing. A caller may say what
    // they typed; who said it is decided here.
    const data = insertAIChatMessageSchema.parse({
      ...req.body, sender: "user", userId: req.session.userId,
    });
    const message = await storage.createChatMessage(data);
    await storage.createActivityLog({
      action: "created", entityType: "chat_message", entityId: message.id,
      details: null, ...actor(req),
    });

    // The reply is produced here, not in the browser.
    //
    // It used to be produced in the browser, by picking one of five strings
    // out of the page's own source and POSTing it back with `sender: "ai"`.
    // Anything a client can POST as an assistant message is a message the
    // record cannot vouch for, so the client no longer sends one at all --
    // and a client that tries is refused above, because `sender` is now the
    // server's to set on this path.
    if (!assistant.isConfigured()) {
      return void res.status(201).json({ message, reply: null });
    }

    const history = await storage.getChatMessagesByUser(req.session.userId!);
    let text: string;
    try {
      text = await assistant.reply(
        history.map((one) => ({
          role: one.sender === "ai" ? ("assistant" as const) : ("user" as const),
          content: one.message,
        })),
        await deploymentSummary(),
      );
    } catch (cause) {
      if (cause instanceof assistant.AssistantUnavailable) {
        // The operator's message is kept -- they typed it, it is theirs --
        // and the failure is reported instead of being papered over with a
        // sentence nothing produced.
        return void res.status(201).json({
          message, reply: null, error: cause.message,
        });
      }
      throw cause;
    }

    const answer = await storage.createChatMessage({
      userId: req.session.userId!, message: text, sender: "ai", attachments: null,
    });
    res.status(201).json({ message, reply: answer });
  }));

  app.delete("/api/chat/:id", asyncHandler(async (req, res) => {
    // GET scopes to the session's own messages; DELETE did not, so any
    // authenticated user could delete anyone else's chat history by id.
    const message = await storage.getChatMessage(req.params.id);
    if (!message || message.userId !== req.session.userId) return notFound(res, "Message");

    const success = await storage.deleteChatMessage(req.params.id);
    if (!success) return notFound(res, "Message");
    await storage.createActivityLog({
      action: "deleted", entityType: "chat_message", entityId: req.params.id,
      details: null, ...actor(req),
    });
    res.json({ success: true });
  }));

  // ==== CLASSIFIERS ====
  app.get("/api/classifiers", asyncHandler(async (_req, res) => {
    res.json(await storage.getAllClassifiers());
  }));

  app.get("/api/classifiers/:id", asyncHandler(async (req, res) => {
    const classifier = await storage.getClassifier(req.params.id);
    if (!classifier) return notFound(res, "Classifier");
    res.json(classifier);
  }));

  app.post("/api/classifiers", asyncHandler(async (req, res) => {
    const data = insertClassifierSchema.parse(req.body);
    const classifier = await storage.createClassifier(data);
    await storage.createActivityLog({
      action: "created", entityType: "classifier", entityId: classifier.id,
      details: { name: classifier.name, type: classifier.type }, ...actor(req),
    });
    res.status(201).json(classifier);
  }));

  app.patch("/api/classifiers/:id", asyncHandler(async (req, res) => {
    const data = updateClassifierSchema.parse(req.body);
    const classifier = await storage.updateClassifier(req.params.id, data);
    if (!classifier) return notFound(res, "Classifier");
    if (hasChanges(data)) {
      await storage.createActivityLog({ action: "updated", entityType: "classifier", entityId: classifier.id, details: null, ...actor(req) });
    }
    res.json(classifier);
  }));

  app.delete("/api/classifiers/:id", asyncHandler(async (req, res) => {
    const success = await storage.deleteClassifier(req.params.id);
    if (!success) return notFound(res, "Classifier");
    await storage.createActivityLog({ action: "deleted", entityType: "classifier", entityId: req.params.id, details: null, ...actor(req) });
    res.json({ success: true });
  }));

  // Unknown API paths must not fall through to the SPA catch-all. The literal
  // "/api/*" pattern missed "//api/clients" and "/api%2fclients"; widening it
  // by hand then still missed "/./api/clients", "/x/../api/clients" and
  // percent-encoded letters such as "/%61pi/clients". Normalising the path and
  // testing that covers the whole family rather than the spellings we thought
  // of. None of these ever reached a handler, but answering an API caller with
  // a page of HTML and a 200 is its own bug.
  app.all("*", (req, res, next) => {
    if (looksLikeApiPath(req.path)) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    next();
  });
}
