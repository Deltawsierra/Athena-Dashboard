import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";

import { makeApp, signIn } from "./helpers";

/**
 * The reads behind the recovery screen (client/src/components/authority/RecoveryRecords.tsx),
 * against a stand-in Athena-Backend that answers in the shapes athena-backend
 * assurance/recovery_record.py serves (#210 at 7e97884: `served`, `finding_record`,
 * `deployment_records` in history_reads' page envelope), with synthetic data and invented
 * names, and scopes them by who asks as `get_object()` does:
 *
 *   GET /api/assurance/deployments/<uuid>/recovery-records/  ?offset=   (50 incidents a page)
 *   GET /api/assurance/findings/<uuid>/recovery-record/
 *
 *   - Each is relayed as a GET, as the signed-in person (their own backend token, never the
 *     service account's), so a deployment or finding they cannot read is the backend's 404,
 *     passed on as not_found -- exactly as one that does not exist -- and never as an empty
 *     record. A 403 is backend_refused; an ended backend sign-in is 503
 *     backend_sign_in_required, never a 401.
 *   - Every step is mapped to camelCase with every field it carries: its S1 state, every
 *     condition with its witness, every gap and restriction as served, its release word, its
 *     coverage, its residual uncertainty with every source, and who accepted it until when.
 *     A field the backend did not serve is null, never an empty list or a false.
 *   - Read whole or not at all: an incident, a step, or an item of a step's lists that is not
 *     what the backend serves is never dropped (a dropped step or gap would read as one the
 *     record does not have); the read is answered 503 instead.
 *   - `?offset=` is checked here, as the history reads check it, and paged reads come to
 *     every incident once.
 *   - The backend's write (a POST of the next steps and the owner's acceptance) is not
 *     relayed, nor is any other: the backend sees none.
 */

const DEP_A = "0a0a0a0a-0000-4000-8000-00000000000a";
const DEP_B = "0b0b0b0b-0000-4000-8000-00000000000b";
const F_HELD = "f0f0f0f0-0000-4000-8000-0000000000f1";
const F_DONE = "f0f0f0f0-0000-4000-8000-0000000000f2";
const F_B = "f0f0f0f0-0000-4000-8000-0000000000f3";
const T0 = "2026-11-01T00:00:00.000000Z";
const T1 = "2026-11-02T00:00:00.000000Z";
const UNTIL = "2026-12-01T00:00:00+00:00";
const RECORDED = "2026-11-02T09:00:00+00:00";

const GAP_MANIFEST = {
  sources: [{ source: "edr", kind: "log", start: T0, end: T1 }],
  observations: [{ source: "edr", start: T0, end: T1, basis: "observed" }],
  gaps: [{ kind: "failed_collector", subject: "edr-west", detail: "" }],
};
const COVERED_MANIFEST = { sources: GAP_MANIFEST.sources, observations: GAP_MANIFEST.observations, gaps: [] };

/** One step as athena-backend recovery_record.served serves it. */
function servedStep(finding: string, version: number, overrides: Record<string, unknown> = {}) {
  return {
    ref: `${finding.slice(0, 8)}-0000-4000-8000-${String(version).padStart(12, "0")}`,
    version,
    state: "under_investigation",
    reopens: null,
    conditions: [{ condition: "incident_recorded", witness: { kind: "finding", ref: finding } }],
    gaps: [],
    restrictions: [],
    release: "FAIL",
    residual_uncertainty: [],
    links: { incident: finding, evidence: [], permits: [], receipts: [], decision: null, repair_contract: null, closure_evidence: null, unknowns: [], gaps: [], restrictions: [], uncertainty: [] },
    coverage: { manifest: COVERED_MANIFEST, observed_sources: 1, required_sources: 1, complete: true, missing: {}, unknown_inventory: [] },
    accepted_by: null,
    accepted_until: null,
    recorded_by: "owner-a",
    recorded_at: RECORDED,
    ...overrides,
  };
}

/** A tested repair the owner accepted, held back by a declared coverage gap (the #210 route test's own case). */
const HELD_STEP = servedStep(F_HELD, 3, {
  state: "repair_tested",
  release: "AUDIT_INCOMPLETE",
  conditions: [
    { condition: "incident_recorded", witness: { kind: "finding", ref: F_HELD } },
    { condition: "repair_agreed", witness: { kind: "repair_contract", ref: "rc-0001" } },
    { condition: "repair_tested", witness: { kind: "closure_evidence", ref: "ce-0001" } },
  ],
  gaps: ["coverage:failed_collector:edr-west"],
  residual_uncertainty: [
    { statement: "Which mail relays still accept the old token?", sources: [{ kind: "unknown", ref: "u-0001" }, { kind: "evidence", ref: "ev-0001" }] },
    { statement: "coverage:failed_collector:edr-west", sources: [{ kind: "coverage", ref: `finding:${F_HELD}` }] },
  ],
  coverage: {
    manifest: GAP_MANIFEST, observed_sources: 1, required_sources: 1, complete: false,
    missing: { "proxy-logs": [{ start: T0, end: T1 }] }, unknown_inventory: ["badge-readers"],
  },
  accepted_by: "owner-a",
  accepted_until: UNTIL,
});

function servedIncident(finding: string, title: string, steps: Array<Record<string, unknown>>) {
  const last = steps[steps.length - 1];
  return { finding, title, severity: "critical", current: { version: last.version, state: last.state, release: last.release }, steps };
}

const HELD = servedIncident(F_HELD, "Ledger tool kept a stale token", [
  servedStep(F_HELD, 1, { accepted_by: "owner-a", accepted_until: UNTIL }),
  servedStep(F_HELD, 2, { state: "repair_proposed", accepted_by: "owner-a", accepted_until: UNTIL }),
  HELD_STEP,
]);
const DONE = servedIncident(F_DONE, "Refund agent wrote outside its approval", [
  servedStep(F_DONE, 1),
  servedStep(F_DONE, 2, {
    state: "recovery_accepted", release: "PASS", accepted_by: null, accepted_until: UNTIL,
    conditions: [{ condition: "owner_accepted", witness: { kind: "owner", ref: "user:7" } }],
  }),
]);

function envelope(deployment: string, incidents: unknown[], total: number, offset: number) {
  return { deployment, incidents, incident_count: total, returned: incidents.length, truncated: offset + incidents.length < total, page_size: 50, offset };
}

/** A page of a deployment with `total` incidents, one step each. */
function pagedEnvelope(offset: number, total: number) {
  const count = Math.max(0, Math.min(50, total - offset));
  const incidents = Array.from({ length: count }, (_, i) => {
    const finding = `f0f0f0f0-0000-4000-8000-${String(offset + i + 1).padStart(12, "0")}`;
    return servedIncident(finding, `Incident ${offset + i + 1}`, [servedStep(finding, 1)]);
  });
  return envelope("dep-paged", incidents, total, offset);
}

/** Who owns what, and what an admin sees: as `visible_deployments` scopes it. */
const OWNERS: Record<string, string> = { [DEP_A]: "alice", [DEP_B]: "bob", "dep-paged": "alice", "dep-carol": "carol" };
const FINDINGS: Record<string, string> = { [F_HELD]: DEP_A, [F_DONE]: DEP_A, [F_B]: DEP_B };
const NO_DEPLOYMENT = { detail: "No Deployment matches the given query." };
const NO_FINDING = { detail: "No Finding matches the given query." };

interface Seen { method: string; path: string; query: string; authorization: string }

/** The console's own accounts for the people reading; the stand-in takes any password. */
const PASSWORDS: Record<"alice" | "bob" | "carol", string> = {
  alice: "alice-recovery-reader-7", // pragma: allowlist secret
  bob: "bob-recovery-reader-8", // pragma: allowlist secret
  carol: "carol-recovery-reader-9", // pragma: allowlist secret
};

describe("the recovery records' reads", () => {
  let app: Express;
  let admin: Awaited<ReturnType<typeof signIn>>;
  let alice: Awaited<ReturnType<typeof signIn>>;
  let bob: Awaited<ReturnType<typeof signIn>>;
  /** Whose backend sign-in ends in the 401 case: nobody else's is touched by it. */
  let carol: Awaited<ReturnType<typeof signIn>>;
  let server: Server;
  const seen: Seen[] = [];
  /** Answers the stand-in gives a path in place of its own, for the malformed-answer cases. */
  const planted: Record<string, [number, unknown]> = {};

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const method = req.method ?? "GET";
        const [path, query = ""] = (req.url ?? "").split("?");
        const json = (code: number, payload: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (path === "/api/token/" && method === "POST") {
          // Each account gets a token that names it, so a read says whose credential it went with.
          let username = "(none)";
          try { username = String((JSON.parse(raw || "{}") as { username?: unknown }).username); } catch { /* not JSON */ }
          return json(200, { access: `access-for-${username}`, refresh: `refresh-for-${username}` });
        }
        if (path === "/api/token/revoke/") return json(200, { revoked: true });
        if (path === "/api/token/refresh/") return json(401, { detail: "Token is blacklisted", code: "token_not_valid" });
        const authorization = req.headers.authorization ?? "";
        seen.push({ method, path, query, authorization });
        const who = authorization.replace(/^Bearer access-for-/, "");
        const sees = (deployment: string) => who === "admin" || OWNERS[deployment] === who;
        if (planted[path]) return json(planted[path][0], planted[path][1]);
        if (method !== "GET") return json(405, { detail: `Method "${method}" not allowed.` });
        const records = /^\/api\/assurance\/deployments\/([^/]+)\/recovery-records\/$/.exec(path);
        if (records) {
          const [, deployment] = records;
          if (!(deployment in OWNERS) || !sees(deployment)) return json(404, NO_DEPLOYMENT);
          const offset = Number(new URLSearchParams(query).get("offset") ?? "0");
          if (deployment === "dep-paged") return json(200, pagedEnvelope(offset, 120));
          return json(200, deployment === DEP_A ? envelope(DEP_A, [HELD, DONE], 2, 0) : envelope(DEP_B, [], 0, 0));
        }
        const one = /^\/api\/assurance\/findings\/([^/]+)\/recovery-record\/$/.exec(path);
        if (one) {
          const [, finding] = one;
          if (!(finding in FINDINGS) || !sees(FINDINGS[finding])) return json(404, NO_FINDING);
          if (finding === F_B) return json(200, { deployment: DEP_B, finding: F_B, title: "b", severity: "low", current: null, steps: [] });
          return json(200, { deployment: DEP_A, ...(finding === F_HELD ? HELD : DONE) });
        }
        return json(404, { detail: "Not found." });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_FAILSAFE_USER = "svc-operator";
    process.env.ATHENA_FAILSAFE_PASSWORD = "svc-secret"; // pragma: allowlist secret
    app = await makeApp();
    admin = await signIn(app);
    for (const username of ["alice", "bob", "carol"] as const) {
      const made = await admin.post("/api/users").send({ username, password: PASSWORDS[username], role: "user", email: `${username}@tenant.test` });
      expect(made.status).toBe(201);
    }
    alice = await signIn(app, "alice", PASSWORDS.alice);
    bob = await signIn(app, "bob", PASSWORDS.bob);
    carol = await signIn(app, "carol", PASSWORDS.carol);
  });

  afterAll(async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    delete process.env.ATHENA_FAILSAFE_USER;
    delete process.env.ATHENA_FAILSAFE_PASSWORD;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("maps a deployment's incidents, every step with every field it carries, nulls kept null", async () => {
    const res = await alice.get(`/api/assurance/deployments/${DEP_A}/recovery-records`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ deployment: DEP_A, incidentCount: 2, returned: 2, truncated: false, pageSize: 50, offset: 0 });
    const [held, done] = res.body.incidents;
    expect(held).toMatchObject({
      finding: F_HELD, title: "Ledger tool kept a stale token", severity: "critical",
      current: { version: 3, state: "repair_tested", release: "AUDIT_INCOMPLETE" },
    });
    // Every step, oldest first, as served.
    expect(held.steps.map((one: { version: number }) => one.version)).toEqual([1, 2, 3]);
    expect(held.steps[2]).toEqual({
      ref: HELD_STEP.ref, version: 3, state: "repair_tested", reopens: null,
      conditions: [
        { condition: "incident_recorded", witness: { kind: "finding", ref: F_HELD } },
        { condition: "repair_agreed", witness: { kind: "repair_contract", ref: "rc-0001" } },
        { condition: "repair_tested", witness: { kind: "closure_evidence", ref: "ce-0001" } },
      ],
      gaps: ["coverage:failed_collector:edr-west"],
      restrictions: [],
      release: "AUDIT_INCOMPLETE",
      residualUncertainty: [
        { statement: "Which mail relays still accept the old token?", sources: [{ kind: "unknown", ref: "u-0001" }, { kind: "evidence", ref: "ev-0001" }] },
        { statement: "coverage:failed_collector:edr-west", sources: [{ kind: "coverage", ref: `finding:${F_HELD}` }] },
      ],
      coverage: {
        sources: [{ source: "edr", kind: "log", start: T0, end: T1 }],
        declaredGaps: [{ kind: "failed_collector", subject: "edr-west", detail: null, start: null, end: null }],
        observedSources: 1, requiredSources: 1, complete: false,
        missing: { "proxy-logs": [{ start: T0, end: T1 }] }, unknownInventory: ["badge-readers"],
      },
      acceptedBy: "owner-a", acceptedUntil: UNTIL, recordedBy: "owner-a", recordedAt: RECORDED,
    });
    // An acceptance whose account is gone: who is null, never a name made up here; its end stays.
    expect(done.steps[1]).toMatchObject({ state: "recovery_accepted", release: "PASS", acceptedBy: null, acceptedUntil: UNTIL });
    // The step's links are the backend's working record, not what the screen reads: not carried.
    expect(held.steps[2]).not.toHaveProperty("links");
  });

  it("keeps a field the backend did not serve as null -- never an empty list, a zero or a false", async () => {
    const bare = servedStep(F_HELD, 1);
    for (const key of ["conditions", "gaps", "restrictions", "residual_uncertainty", "coverage", "release", "accepted_until"] as const) {
      delete (bare as Record<string, unknown>)[key];
    }
    planted[`/api/assurance/deployments/${DEP_A}/recovery-records/`] = [200, {
      deployment: DEP_A,
      incidents: [{ finding: F_HELD, steps: [bare, servedStep(F_HELD, 2, { coverage: { manifest: null } })] }],
    }];
    try {
      const res = await alice.get(`/api/assurance/deployments/${DEP_A}/recovery-records`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ incidentCount: null, returned: null, truncated: null, pageSize: null, offset: null });
      const [incident] = res.body.incidents;
      expect(incident).toMatchObject({ title: null, severity: null, current: null });
      expect(incident.steps[0]).toMatchObject({
        conditions: null, gaps: null, restrictions: null, residualUncertainty: null, coverage: null, release: null, acceptedUntil: null,
      });
      expect(incident.steps[1].coverage).toEqual({
        sources: null, declaredGaps: null, observedSources: null, requiredSources: null, complete: null, missing: null, unknownInventory: null,
      });
    } finally {
      delete planted[`/api/assurance/deployments/${DEP_A}/recovery-records/`];
    }
  });

  it("answers a record it cannot read whole as unavailable -- never with a step, a gap or a source left out", async () => {
    const path = `/api/assurance/deployments/${DEP_A}/recovery-records/`;
    const withStep = (patch: Record<string, unknown>) => envelope(DEP_A, [{ ...HELD, steps: [HELD.steps[0], { ...HELD_STEP, ...patch }] }], 1, 0);
    const cases: Array<[string, unknown]> = [
      ["no list of incidents", { deployment: DEP_A, incident_count: 1 }],
      ["incidents not a list", { deployment: DEP_A, incidents: { [F_HELD]: HELD } }],
      ["an incident that is not a record", envelope(DEP_A, [HELD, "f-2"], 2, 0)],
      ["an incident with no steps", envelope(DEP_A, [{ finding: F_HELD, current: null }], 1, 0)],
      ["a step that is not a record", envelope(DEP_A, [{ ...HELD, steps: [HELD.steps[0], null, HELD_STEP] }], 1, 0)],
      ["a gap that is not a string", withStep({ gaps: ["coverage:failed_collector:edr-west", { kind: "failed_collector" }] })],
      ["gaps that are not a list", withStep({ gaps: "coverage:failed_collector:edr-west" })],
      ["a restriction that is not a string", withStep({ restrictions: [7] })],
      ["a condition that is not a record", withStep({ conditions: ["incident_recorded"] })],
      ["a residual uncertainty that is not a record", withStep({ residual_uncertainty: ["unknown"] })],
      ["a source that is not a record", withStep({ residual_uncertainty: [{ statement: "x", sources: ["unknown:u-1"] }] })],
      ["sources that are not a list", withStep({ residual_uncertainty: [{ statement: "x", sources: "unknown:u-1" }] })],
      ["missing coverage that is not a list", withStep({ coverage: { ...HELD_STEP.coverage, missing: { "proxy-logs": "all" } } })],
    ];
    try {
      for (const [what, answer] of cases) {
        planted[path] = [200, answer];
        const res = await alice.get(`/api/assurance/deployments/${DEP_A}/recovery-records`);
        expect(res.status, what).toBe(503);
        expect(res.body.error, what).toContain("cannot be read whole");
        expect(res.body.incidents, what).toBeUndefined();
      }
    } finally {
      delete planted[path];
    }
  });

  it("reads one incident by its finding, with the deployment the backend answered for", async () => {
    const res = await alice.get(`/api/assurance/findings/${F_HELD}/recovery-record`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deployment: DEP_A, finding: F_HELD, current: { version: 3, release: "AUDIT_INCOMPLETE" } });
    expect(res.body.steps.map((one: { state: string }) => one.state)).toEqual(["under_investigation", "repair_proposed", "repair_tested"]);
    expect(res.body.steps[2].gaps).toEqual(["coverage:failed_collector:edr-west"]);
    // A finding with no step recorded reads as that: no current step, no steps.
    const none = await bob.get(`/api/assurance/findings/${F_B}/recovery-record`);
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ deployment: DEP_B, current: null, steps: [] });
  });

  it("passes on a deployment or finding the person cannot read as not found -- the same answer as one that does not exist", async () => {
    const absent = "0c0c0c0c-0000-4000-8000-00000000000c";
    for (const [theirs, nobodys] of [
      [`/api/assurance/deployments/${DEP_B}/recovery-records`, `/api/assurance/deployments/${absent}/recovery-records`],
      [`/api/assurance/findings/${F_B}/recovery-record`, `/api/assurance/findings/${absent}/recovery-record`],
    ]) {
      const refused = await alice.get(theirs);
      const missing = await alice.get(nobodys);
      expect(refused.status, theirs).toBe(404);
      expect(refused.body.code, theirs).toBe("not_found");
      expect(missing.status, nobodys).toBe(404);
      expect(missing.body.code, nobodys).toBe("not_found");
      expect(refused.body.incidents).toBeUndefined();
      expect(refused.body.steps).toBeUndefined();
    }
    // The owner reads their own; an admin reads both.
    expect((await bob.get(`/api/assurance/deployments/${DEP_B}/recovery-records`)).body).toMatchObject({ deployment: DEP_B, incidentCount: 0, incidents: [] });
    expect((await admin.get(`/api/assurance/deployments/${DEP_B}/recovery-records`)).status).toBe(200);
    expect((await admin.get(`/api/assurance/findings/${F_HELD}/recovery-record`)).status).toBe(200);
  });

  it("passes on a 403 as backend_refused, and an ended backend sign-in as 503 backend_sign_in_required, never 401", async () => {
    const records = "/api/assurance/deployments/dep-carol/recovery-records/";
    const finding = `/api/assurance/findings/${F_HELD}/recovery-record/`;
    try {
      planted[records] = [403, { detail: "You do not have permission to perform this action." }];
      planted[finding] = [403, { detail: "You do not have permission to perform this action." }];
      for (const url of ["/api/assurance/deployments/dep-carol/recovery-records", `/api/assurance/findings/${F_HELD}/recovery-record`]) {
        const res = await carol.get(url);
        expect(res.status, url).toBe(403);
        expect(res.body.code, url).toBe("backend_refused");
      }
      // The backend refuses carol's token, renewed and all: her sign-in to it ended.
      planted[records] = [401, { detail: "Given token not valid for any token type" }];
      planted[finding] = [401, { detail: "Given token not valid for any token type" }];
      for (const url of ["/api/assurance/deployments/dep-carol/recovery-records", `/api/assurance/findings/${F_HELD}/recovery-record`]) {
        const res = await carol.get(url);
        expect(res.status, url).toBe(503);
        expect(res.body.code, url).toBe("backend_sign_in_required");
      }
    } finally {
      delete planted[records];
      delete planted[finding];
    }
  });

  it("reads on from offset + returned while the backend says there is more, every incident once", async () => {
    const findings: string[] = [];
    let offset = 0;
    for (let page = 0; page < 5; page += 1) {
      const res = await alice.get(`/api/assurance/deployments/dep-paged/recovery-records?offset=${offset}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ incidentCount: 120, pageSize: 50, offset });
      findings.push(...res.body.incidents.map((one: { finding: string }) => one.finding));
      if (res.body.truncated !== true) break;
      offset += res.body.returned;
    }
    expect(findings).toEqual(Array.from({ length: 120 }, (_, i) => `f0f0f0f0-0000-4000-8000-${String(i + 1).padStart(12, "0")}`));
    const asked = seen.filter((one) => one.path === "/api/assurance/deployments/dep-paged/recovery-records/").map((one) => one.query);
    expect(asked).toEqual(["offset=0", "offset=50", "offset=100"]);
  });

  it("refuses an offset that is not plain digits up to 2^31 - 1 with a 400 here, and relays nothing for it", async () => {
    for (const offset of ["-1", "+1", " 1", "1.0", "1e3", "0x10", "１", "", "2147483648", "abc"]) {
      const before = seen.length;
      const res = await alice.get(`/api/assurance/deployments/${DEP_A}/recovery-records?offset=${encodeURIComponent(offset)}`);
      expect(res.status, JSON.stringify(offset)).toBe(400);
      expect(res.body.code, JSON.stringify(offset)).toBe("invalid_offset");
      expect(seen.slice(before), JSON.stringify(offset)).toEqual([]);
    }
    const before = seen.length;
    expect((await alice.get(`/api/assurance/deployments/${DEP_A}/recovery-records?offset=1&offset=2`)).status).toBe(400);
    expect(seen.slice(before)).toEqual([]);
  });

  it("refuses both reads to anyone not signed in to this console, and relays nothing for them", async () => {
    const before = seen.length;
    expect((await request(app).get(`/api/assurance/deployments/${DEP_A}/recovery-records`)).status).toBe(401);
    expect((await request(app).get(`/api/assurance/findings/${F_HELD}/recovery-record`)).status).toBe(401);
    expect(seen.slice(before)).toEqual([]);
  });

  it("relays no write: not the backend's POST of the next steps or an acceptance, nor any other", async () => {
    const before = seen.length;
    for (const send of [
      () => admin.post(`/api/assurance/findings/${F_HELD}/recovery-record`).send({ accept: { until: UNTIL } }),
      () => alice.post(`/api/assurance/findings/${F_HELD}/recovery-record`).send({ evidence: [] }),
      () => admin.put(`/api/assurance/findings/${F_HELD}/recovery-record`).send({}),
      () => admin.patch(`/api/assurance/findings/${F_HELD}/recovery-record`).send({ state: "recovery_accepted" }),
      () => admin.delete(`/api/assurance/findings/${F_HELD}/recovery-record`),
      () => admin.post(`/api/assurance/deployments/${DEP_A}/recovery-records`).send({}),
      () => admin.put(`/api/assurance/deployments/${DEP_A}/recovery-records`).send({}),
      () => admin.delete(`/api/assurance/deployments/${DEP_A}/recovery-records`),
    ]) {
      expect((await send()).status).toBe(404);
    }
    expect(seen.slice(before)).toEqual([]);
    expect(seen.filter((one) => one.method !== "GET").map((one) => `${one.method} ${one.path}`)).toEqual([]);
  });

  it("went to the backend as the signed-in person every time, never as the service account", async () => {
    const reads = seen.filter((one) => /\/(recovery-records|recovery-record)\/$/.test(one.path));
    expect(reads.length).toBeGreaterThan(10);
    for (const person of ["alice", "bob", "carol", "admin"]) {
      expect(reads.some((one) => one.authorization === `Bearer access-for-${person}`), person).toBe(true);
    }
    expect(reads.filter((one) => !/^Bearer access-for-(?:alice|bob|carol|admin)$/.test(one.authorization)).map((one) => `${one.path} ${one.authorization}`)).toEqual([]);
  });
});
