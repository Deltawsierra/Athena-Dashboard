import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";

import { makeApp, signIn } from "./helpers";
import {
  BACKEND, BACKUP, CASES, DEP, EVIDENCE_1, EVIDENCE_2, FINDING, LEAK, MODEM, NOT_DECLARED, PRIMARY, ROUTE, UNREADABLE, addedGap,
  servedByPath, type CaseName,
} from "./helpers/incident-scopes";

/**
 * An incident's scope as this console's server reads it from Athena-Backend (SPINE SP-3;
 * athena-backend #229 at abdaa57), against a stand-in that answers in the shapes
 * assurance/incident_scope.py and assurance/recovery_record.py serve, with synthetic data
 * (tests/helpers/incident-scopes.ts):
 *
 *   GET /api/assurance/deployments/<uuid>/recovery-records/   each incident's `scope_revision`
 *   GET /api/assurance/findings/<uuid>/recovery-record/       and `scope_removed`; each step's
 *                                                             `scope_revision`, `scope_gaps`,
 *                                                             `scope_items` and `recorded`
 *   GET /api/assurance/findings/<uuid>/scope-revisions/       every revision of one incident
 *
 *   - Every field is mapped to camelCase as served. What the backend cannot establish
 *     is null and STAYS null: never an empty list, which would say that nothing was
 *     added or removed. An empty list stays an empty list.
 *   - A backend from before #229 serves none of these fields: the `scope` block is then
 *     absent altogether, on the incident and on each step, so the screen can say "not
 *     reported" and never "no scope".
 *   - A row of a scope list that cannot be read is counted under its list and every
 *     other row is kept (shared/unreadable-rows.ts). It never fails the record it
 *     rides on, never throws, and what it held is not passed on.
 *   - Each read goes as the signed-in person, so a finding they cannot read is the
 *     backend's 404, passed on as not_found. The backend's write on the scope route (a
 *     POST of the next revision) is not relayed, nor is any other.
 */

const NOT_A_LIST = "not a list";
const NO_FINDING = { detail: "No Finding matches the given query." };

interface Seen { method: string; path: string; authorization: string }

/** The console's own account for a second reader; the stand-in takes any password. */
const READER_PASSWORD = "quinn-scope-reader-5"; // pragma: allowlist secret

describe("an incident's scope, as this console's server reads it", () => {
  let app: Express;
  let admin: Awaited<ReturnType<typeof signIn>>;
  let quinn: Awaited<ReturnType<typeof signIn>>;
  let server: Server;
  const seen: Seen[] = [];
  /** What the stand-in answers by path: the cases' answers, and whatever a test plants over one. */
  const served: Record<string, unknown> = servedByPath();
  /** An answer with its own status, or a raw body, in place of a path's own. */
  const planted: Record<string, { status: number; body: string; type?: string }> = {};

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const method = req.method ?? "GET";
        const [path] = (req.url ?? "").split("?");
        const json = (code: number, payload: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (path === "/api/token/" && method === "POST") {
          let username = "(none)";
          try { username = String((JSON.parse(raw || "{}") as { username?: unknown }).username); } catch { /* not JSON */ }
          return json(200, { access: `access-for-${username}`, refresh: `refresh-for-${username}` });
        }
        if (path === "/api/token/revoke/") return json(200, { revoked: true });
        if (path === "/api/token/refresh/") return json(401, { detail: "Token is blacklisted", code: "token_not_valid" });
        seen.push({ method, path, authorization: req.headers.authorization ?? "" });
        if (planted[path]) {
          res.writeHead(planted[path].status, { "Content-Type": planted[path].type ?? "application/json" });
          return res.end(planted[path].body);
        }
        if (method !== "GET") return json(405, { detail: `Method "${method}" not allowed.` });
        if (path in served) return json(200, served[path]);
        return json(404, NO_FINDING);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_FAILSAFE_USER = "svc-operator";
    process.env.ATHENA_FAILSAFE_PASSWORD = "svc-secret"; // pragma: allowlist secret
    app = await makeApp();
    admin = await signIn(app);
    const made = await admin.post("/api/users").send({ username: "quinn", password: READER_PASSWORD, role: "user", email: "quinn@tenant.test" });
    expect(made.status).toBe(201);
    quinn = await signIn(app, "quinn", READER_PASSWORD);
  });

  afterAll(async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    delete process.env.ATHENA_FAILSAFE_USER;
    delete process.env.ATHENA_FAILSAFE_PASSWORD;
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** The deployment's page, by case. */
  async function page(): Promise<Record<CaseName, Record<string, any>>> {
    const res = await admin.get(ROUTE.page);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.incidents).toHaveLength(CASES.length);
    return Object.fromEntries(CASES.map((name, index) => [name, res.body.incidents[index]])) as Record<CaseName, Record<string, any>>;
  }

  const WHY_REMOVED = "the refund workflow was never called, and the modem was never on this network";
  const MODEM_GONE = { kind: "asset", ref: MODEM, added: 2, removed: 3, removedBy: "owner-d", reason: WHY_REMOVED };

  describe("on the recovery reads", () => {
    it("maps the incident's scope and each step's: its revision, what keeps it back, what it gained and lost, what its row recorded", async () => {
      const { declared, three, widened, open } = await page();
      // A scope declared once: revision 1, and a list of removed items that was read and is empty.
      expect(declared.scope).toEqual({ revision: 1, removed: [] });
      expect(declared.steps[1].scope).toEqual({
        revision: 1, gaps: [], added: [], removed: [], recorded: { state: "recovery_accepted", gaps: [], release: "PASS" },
      });
      // Three revisions: the item one added and a later one removed, with both numbers, who and why.
      expect(three.scope).toEqual({ revision: 3, removed: [MODEM_GONE] });
      expect(three.steps.map((one: any) => one.scope.revision)).toEqual([1, 3]);
      expect(three.steps[1].scope).toEqual({
        revision: 3,
        gaps: [],
        added: [{
          kind: "asset", ref: BACKUP, revision: 2,
          coveredBy: [{ kind: "evidence", ref: EVIDENCE_2 }, { kind: "coverage", ref: `asset:${BACKUP}` }],
        }],
        removed: [MODEM_GONE],
        recorded: { state: "recovery_accepted", gaps: [], release: "PASS" },
      });
      // Accepted under revision 1, widened by revision 2: served as it reads now, with what the row recorded beside it.
      expect(widened.scope).toEqual({ revision: 2, removed: [] });
      expect(widened.current).toEqual({ version: 2, state: "repair_tested", release: "AUDIT_INCOMPLETE" });
      const lapsed = widened.steps[1];
      expect([lapsed.state, lapsed.release]).toEqual(["repair_tested", "AUDIT_INCOMPLETE"]);
      expect(lapsed.gaps).toEqual([addedGap(2, "asset", BACKUP), addedGap(2, "workflow", "payout")]);
      expect(lapsed.scope).toEqual({
        revision: 1,
        gaps: [addedGap(2, "asset", BACKUP), addedGap(2, "workflow", "payout")],
        added: [], removed: [],
        recorded: { state: "recovery_accepted", gaps: [], release: "PASS" },
      });
      // An added item nothing names is an empty list of links, kept empty: an open gap. Another is named by a permit.
      expect(open.steps[0].scope.added).toEqual([
        { kind: "asset", ref: BACKUP, revision: 2, coveredBy: [] },
        { kind: "workflow", ref: "payout", revision: 2, coveredBy: [{ kind: "permit", ref: "gate-7" }] },
      ]);
      expect(open.steps[0].scope.gaps).toEqual([addedGap(2, "asset", BACKUP)]);
    });

    it("keeps what the backend cannot establish as null -- never an empty list -- and an empty list as an empty list", async () => {
      const { undeclared, unreadable, before, declared } = await page();
      // No scope declared: no revision, and what was removed is not known.
      expect(undeclared.scope).toEqual({ revision: null, removed: null });
      expect(undeclared.steps[0].scope).toEqual({
        revision: null, gaps: [NOT_DECLARED], added: null, removed: null,
        recorded: { state: "repair_tested", gaps: [NOT_DECLARED], release: "AUDIT_INCOMPLETE" },
      });
      // A revision that cannot be read: the incident's removed items are not known...
      expect(unreadable.scope).toEqual({ revision: 2, removed: null });
      // ...a step taken under a revision that could be read knows what its own scope gained and lost...
      expect(unreadable.steps[0].scope).toMatchObject({ revision: 1, gaps: [UNREADABLE], added: [], removed: [] });
      // ...and one taken under the unreadable revision does not.
      expect(unreadable.steps[1].scope).toMatchObject({ revision: 2, gaps: [UNREADABLE], added: null, removed: null });
      // A row from before the scope was versioned serves `scope_items` as null whole: both lists are not known.
      expect(before.scope).toEqual({ revision: null, removed: null });
      expect(before.steps[0].scope).toEqual({
        revision: null, gaps: [NOT_DECLARED], added: null, removed: null,
        recorded: { state: "recovery_accepted", gaps: [], release: "PASS" },
      });
      // Every null above is JSON null, and every empty list a list: neither is the other.
      for (const one of [undeclared.scope.removed, unreadable.scope.removed, before.steps[0].scope.added]) expect(one).toBeNull();
      for (const one of [declared.scope.removed, declared.steps[0].scope.added, unreadable.steps[0].scope.removed]) expect(one).toEqual([]);
    });

    it("leaves the scope out altogether for a backend that serves none of its fields, and says what a partial one did not serve", async () => {
      const { older, partial } = await page();
      // A backend from before #229: no scope block on the incident, none on a step. Nothing is filled in.
      expect(older).not.toHaveProperty("scope");
      expect(Object.keys(older).sort()).toEqual(["current", "finding", "severity", "steps", "title"]);
      for (const step of older.steps) expect(step).not.toHaveProperty("scope");
      expect(older.steps[0]).toMatchObject({ state: "recovery_accepted", release: "PASS" });
      // Only the revisions served: everything else of the scope is null, never empty.
      expect(partial.scope).toEqual({ revision: 1, removed: null });
      expect(partial.steps[0].scope).toEqual({ revision: 1, gaps: null, added: null, removed: null, recorded: null });
    });

    it("counts a row that cannot be read under its list, keeps every row that can, and never fails the record", async () => {
      const all = await page();
      const { rows } = all;
      const gone = { kind: "asset", ref: BACKUP, added: 2, removed: 3, removedBy: "owner-d", reason: "a false alarm: the route was never connected" };
      expect(rows.scope).toEqual({ revision: 2, removed: [gone], unreadable: { removed: 2 } });
      expect(rows.steps[0].scope).toEqual({
        revision: 2,
        gaps: [addedGap(2, "asset", BACKUP)],
        added: [{ kind: "asset", ref: BACKUP, revision: 2, coveredBy: [{ kind: "evidence", ref: EVIDENCE_2 }] }],
        removed: [gone],
        recorded: { state: "recovery_accepted", gaps: ["a gap the row recorded"], release: "PASS" },
        unreadable: { gaps: 3, added: 2, "added.coveredBy": 2, removed: 1, "recorded.gaps": 1 },
      });
      // What an unreadable row held is not passed on, and no other incident of the page was lost to it.
      expect(JSON.stringify(all)).not.toContain(LEAK);
      expect(Object.values(all).map((one) => one.finding)).toEqual(CASES.map((name) => FINDING[name]));
      // The same incident read on its own.
      const one = await admin.get(ROUTE.record("rows"));
      expect(one.status).toBe(200);
      expect(one.body.scope).toEqual(rows.scope);
      expect(one.body.steps[0].scope).toEqual(rows.steps[0].scope);
    });

    it("says a scope value served as something it cannot read could not be read -- never that it is empty or absent", async () => {
      const path = BACKEND.record("rows");
      const step = (served[path] as { steps: Array<Record<string, unknown>> }).steps[0];
      planted[path] = {
        status: 200,
        body: JSON.stringify({
          ...(served[path] as object), scope_revision: "two", scope_removed: "nothing",
          steps: [{ ...step, scope_revision: [2], scope_gaps: { gap: LEAK }, scope_items: LEAK, recorded: 7 }, {
            ...step, version: 2, scope_items: { added: LEAK, removed: 7 }, recorded: { state: 4, gaps: LEAK, release: null },
          }],
        }),
      };
      try {
        const res = await admin.get(ROUTE.record("rows"));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.scope).toEqual({ revision: null, removed: [], unreadable: { removed: NOT_A_LIST } });
        expect(res.body.steps[0].scope).toEqual({
          revision: null, gaps: [], added: null, removed: null, recorded: null,
          unreadable: { gaps: NOT_A_LIST, scopeItems: NOT_A_LIST, recorded: NOT_A_LIST },
        });
        expect(res.body.steps[1].scope).toMatchObject({
          added: [], removed: [], recorded: { state: null, gaps: [], release: null },
          unreadable: { added: NOT_A_LIST, removed: NOT_A_LIST, "recorded.gaps": NOT_A_LIST },
        });
        expect(JSON.stringify(res.body)).not.toContain(LEAK);
      } finally {
        delete planted[path];
      }
    });
  });

  describe("on the scope's own read", () => {
    it("maps every revision oldest first as served: what it names, what it added and removed, why, who and when", async () => {
      const res = await admin.get(ROUTE.scope("three"));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const primary = { kind: "asset", ref: PRIMARY, assetKind: "gateway" };
      const backup = { kind: "asset", ref: BACKUP, assetKind: "gateway" };
      const modem = { kind: "asset", ref: MODEM, assetKind: "modem" };
      const refund = { kind: "workflow", ref: "refund", assetKind: null };
      const ref = ({ kind, ref: named }: { kind: string; ref: string }) => ({ kind, ref: named });
      const prefix = FINDING.three.slice(0, 8);
      expect(res.body).toEqual({
        deployment: DEP, finding: FINDING.three, current: 3,
        revisions: [
          {
            ref: `${prefix}-0000-4000-9000-000000000001`, revision: 1, supersedes: null, current: false,
            items: [primary, refund], added: [ref(primary), ref(refund)], removed: [],
            reason: "what the scan reached", evidence: [{ uuid: EVIDENCE_1, classification: "technically_verified" }],
            declaredBy: "owner-d", declaredAt: "2026-11-01T09:00:00+00:00",
          },
          {
            ref: `${prefix}-0000-4000-9000-000000000002`, revision: 2, supersedes: 1, current: false,
            items: [primary, refund, backup, modem], added: [ref(backup), ref(modem)], removed: [],
            reason: "a backup route and a vendor modem in the firewall export",
            evidence: [{ uuid: EVIDENCE_2, classification: "technically_verified" }],
            // Nobody on record: null, never a name made up here.
            declaredBy: null, declaredAt: "2026-11-02T09:00:00+00:00",
          },
          {
            ref: `${prefix}-0000-4000-9000-000000000003`, revision: 3, supersedes: 2, current: true,
            items: [primary, backup], added: [], removed: [ref(refund), ref(modem)],
            reason: WHY_REMOVED, evidence: [{ uuid: EVIDENCE_1, classification: "technically_verified" }],
            declaredBy: "owner-d", declaredAt: "2026-11-03T09:00:00+00:00",
          },
        ],
      });
    });

    it("keeps what a revision added and removed as null where the backend cannot establish it, and its items as stored", async () => {
      const res = await admin.get(ROUTE.scope("unreadable"));
      expect(res.status).toBe(200);
      const [first, second] = res.body.revisions;
      expect([first.added, first.removed]).toEqual([[{ kind: "asset", ref: PRIMARY }], []]);
      expect(second).toMatchObject({
        revision: 2, current: true, added: null, removed: null, declaredBy: null, evidence: [],
        // The item is carried as stored, with the reference it does not have as null: never dropped.
        items: [{ kind: "asset", ref: null, assetKind: null }],
      });
      // No scope declared: no current revision, and a list of revisions that was read and is empty.
      const none = await admin.get(ROUTE.scope("undeclared"));
      expect(none.status).toBe(200);
      expect(none.body).toEqual({ deployment: DEP, finding: FINDING.undeclared, current: null, revisions: [] });
    });

    it("carries a kind of item this console does not know exactly as served, and one with no kind as that", async () => {
      const res = await admin.get(ROUTE.scope("kind"));
      expect(res.status).toBe(200);
      expect(res.body.revisions[1].items).toEqual([
        { kind: "asset", ref: PRIMARY, assetKind: "gateway" },
        { kind: "route", ref: "backup-route", assetKind: null },
        { kind: "identity", ref: "svc-ledger", assetKind: null },
        { kind: "modem", ref: "vendor-modem-7", assetKind: null },
        { kind: null, ref: "an-item-of-no-kind", assetKind: null },
      ]);
      expect(res.body.revisions[1].added.map((one: { kind: string | null }) => one.kind)).toEqual(["route", "identity", "modem", null]);
    });

    it("counts each unreadable row under its list, the revisions' own and each revision's, and keeps the rest", async () => {
      const res = await admin.get(ROUTE.scope("rows"));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.unreadable).toEqual({ revisions: 2 });
      expect(res.body.revisions.map((one: { revision: number }) => one.revision)).toEqual([1, 2]);
      expect(res.body.current).toBe(2);
      const [first, second] = res.body.revisions;
      expect(first).not.toHaveProperty("unreadable");
      expect(second.items.map((one: { ref: string }) => one.ref)).toEqual([PRIMARY, BACKUP]);
      expect(second.added).toEqual([{ kind: "asset", ref: BACKUP }]);
      // `removed` was served as something that is not a list: no rows, and said as unread, never as nothing removed.
      expect(second.removed).toEqual([]);
      expect(second.unreadable).toEqual({ items: 2, added: 1, removed: NOT_A_LIST, evidence: 1 });
      expect(JSON.stringify(res.body)).not.toContain(LEAK);
    });

    it("answers a body that is not a JSON object as unavailable, and an object with no revisions as not known -- never as no scope", async () => {
      const path = BACKEND.scope("declared");
      try {
        for (const [what, body, type] of [
          ["a list", "[1, 2]", "application/json"],
          ["a string", "\"none\"", "application/json"],
          ["null", "null", "application/json"],
          ["a page that is not JSON", "<html><body>gateway error</body></html>", "text/html"],
          ["nothing at all", "", "application/json"],
        ] as const) {
          planted[path] = { status: 200, body, type };
          const res = await admin.get(ROUTE.scope("declared"));
          expect(res.status, what).toBe(503);
          expect(res.body.revisions, what).toBeUndefined();
        }
        // An object that names no revisions: null, not an empty list.
        planted[path] = { status: 200, body: "{}" };
        expect((await admin.get(ROUTE.scope("declared"))).body).toEqual({ deployment: null, finding: null, current: null, revisions: null });
        // Fields of the wrong kind: read as not served, and the list as unread.
        planted[path] = { status: 200, body: JSON.stringify({ deployment: 4, finding: [], current: "two", revisions: "three of them" }) };
        expect((await admin.get(ROUTE.scope("declared"))).body).toEqual({
          deployment: null, finding: null, current: null, revisions: [], unreadable: { revisions: NOT_A_LIST },
        });
        // A backend that errors is unavailability, not an empty scope.
        planted[path] = { status: 500, body: JSON.stringify({ detail: "Server Error (500)" }) };
        const down = await admin.get(ROUTE.scope("declared"));
        expect(down.status).toBe(503);
        expect(down.body.revisions).toBeUndefined();
      } finally {
        delete planted[path];
      }
    });

    it("passes on a finding the person cannot read, and a backend without the route, as not found; a 403 as refused; an ended sign-in as 503, never 401", async () => {
      // No scope read is served for these: the stand-in answers 404, as a backend from before #229 answers the route.
      for (const name of ["older", "partial", "contradicted"] as const) {
        const res = await admin.get(ROUTE.scope(name));
        expect(res.status, name).toBe(404);
        expect(res.body.code, name).toBe("not_found");
        expect(res.body.revisions, name).toBeUndefined();
      }
      const path = BACKEND.scope("declared");
      try {
        planted[path] = { status: 403, body: JSON.stringify({ detail: "You do not have permission to perform this action." }) };
        const refused = await quinn.get(ROUTE.scope("declared"));
        expect([refused.status, refused.body.code]).toEqual([403, "backend_refused"]);
        planted[path] = { status: 401, body: JSON.stringify({ detail: "Given token not valid for any token type" }) };
        const ended = await quinn.get(ROUTE.scope("declared"));
        expect([ended.status, ended.body.code]).toEqual([503, "backend_sign_in_required"]);
      } finally {
        delete planted[path];
      }
    });

    it("refuses the read to anyone not signed in to this console, and relays nothing for them", async () => {
      const before = seen.length;
      expect((await request(app).get(ROUTE.scope("declared"))).status).toBe(401);
      expect(seen.slice(before)).toEqual([]);
    });

    it("relays no write: not the backend's POST of the next revision, nor any other", async () => {
      const before = seen.length;
      const body = { items: [{ kind: "asset", ref: PRIMARY }], reason: "a wider scope", evidence: [EVIDENCE_1] };
      for (const send of [
        () => admin.post(ROUTE.scope("declared")).send(body),
        () => quinn.post(ROUTE.scope("declared")).send(body),
        () => admin.put(ROUTE.scope("declared")).send(body),
        () => admin.patch(ROUTE.scope("declared")).send({ reason: "edited" }),
        () => admin.delete(ROUTE.scope("declared")),
      ]) {
        expect((await send()).status).toBe(404);
      }
      expect(seen.slice(before)).toEqual([]);
      expect(seen.filter((one) => one.method !== "GET").map((one) => `${one.method} ${one.path}`)).toEqual([]);
    });

    it("went to the backend as the signed-in person every time, never as the service account", async () => {
      // quinn's reads are the two above (her backend sign-in ended with the second); the rest are the admin's.
      const reads = seen.filter((one) => one.path.endsWith("/scope-revisions/"));
      expect(reads.length).toBeGreaterThan(10);
      for (const person of ["admin", "quinn"]) {
        expect(reads.some((one) => one.authorization === `Bearer access-for-${person}`), person).toBe(true);
      }
      expect(reads.filter((one) => !/^Bearer access-for-(?:admin|quinn)$/.test(one.authorization)).map((one) => `${one.path} ${one.authorization}`)).toEqual([]);
    });
  });
});
