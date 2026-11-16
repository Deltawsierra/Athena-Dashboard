import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

import {
  BACKEND_PATH, BACKUP, DEP, ELSEWHERE, EVIDENCE_1, EVIDENCE_2, INCIDENT_ID, PRIMARY, REASON, RECORDED, REFUSALS, RELAY, ROUTE_PATH,
  SERVED_ASSETS, SERVED_FINDING, WIDER, declareStandIn, refused, servedBefore, type DeclareStandIn,
} from "./helpers/scope-declarations";

/**
 * An administrator declares an incident's next scope revision through this console's
 * server (DASH-DECLARE), against a stand-in Athena-Backend in the shapes of `master`
 * (tests/helpers/scope-declarations.ts). Synthetic data, invented names.
 *
 *   GET  /api/assurance/findings/<uuid>/scope-choices   what a revision can be declared from:
 *        the incident's own evidence (findings/<uuid>/), the deployment's own assets
 *        (assets/?deployment=), its approved workflows and the current revision, read as the
 *        person. An asset the backend answers for another deployment is never offered.
 *   POST /api/assurance/findings/<uuid>/declare-scope    the backend's POST scope-revisions/,
 *        admin-only here (the console's role) and there (the backend decides), as the person,
 *        with exactly {items, reason, evidence}; a body of another shape, or an item of a kind
 *        the backend does not take, is refused here and nothing is sent.
 *
 *   - A refusal is passed on with the backend's status and its code alone: every code of
 *     assurance/incident_scope.py, both spellings of a missing part (master's `malformed`,
 *     #231's `*_required`), an unknown code as it came, a 403 that names none. Never the
 *     backend's detail, so nothing a person typed comes back from here.
 *   - A 401 is never passed on; it is a sign-in the backend did not take (503).
 *   - Sent with no answer, or answered with neither a recording nor a refusal: 503
 *     `outcome_unknown`, never a refusal and never a recording.
 *   - The read's own path stays a read: no write is served on it.
 */

let stand: DeclareStandIn;

beforeAll(async () => {
  stand = await declareStandIn();
}, 60_000);
afterAll(async () => {
  await stand?.close();
});
beforeEach(() => {
  stand.serve(servedBefore());
  stand.answerPost(RECORDED);
});

const writes = (from: number) => stand.seen.slice(from).filter((one) => one.method !== "GET");

describe("what a revision can be declared from", () => {
  it("is read as the person, in one answer: the deployment's own assets and approved workflows, the incident's own evidence, and the current revision", async () => {
    const from = stand.seen.length;
    const res = await stand.admin.get(ROUTE_PATH.choices);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      deployment: DEP,
      finding: INCIDENT_ID,
      assets: [
        { uuid: PRIMARY, name: "edge-gateway", kind: "gateway", kindLabel: "Gateway", identifier: "edge-gateway.internal" },
        { uuid: BACKUP, name: "backup-gateway", kind: "gateway", kindLabel: "Gateway", identifier: "backup-gateway.internal" },
        { uuid: RELAY, name: "mail-relay", kind: "gateway", kindLabel: "Gateway", identifier: "mail-relay.internal" },
      ],
      assetsElsewhere: 1,
      workflows: [{ slug: "refund", name: "Refunds" }, { slug: "payout", name: "Payouts" }],
      workflowsWhole: true,
      evidence: [
        { uuid: EVIDENCE_1, classification: "technically_verified", classificationLabel: "Technically verified", summary: "the gateway's own log of the export", source: "edr" },
        { uuid: EVIDENCE_2, classification: "document_supported", classificationLabel: "Document-supported", summary: "the firewall export of 14 November", source: "firewall" },
      ],
      current: {
        revision: 1,
        items: [{ kind: "asset", ref: PRIMARY, assetKind: "gateway" }, { kind: "workflow", ref: "refund", assetKind: null }],
      },
    });
    // The asset of another deployment is not among them, under any field.
    expect(JSON.stringify(res.body.assets)).not.toContain(ELSEWHERE);
    const reads = stand.seen.slice(from);
    expect(reads.map((one) => `${one.method} ${one.path}`).sort()).toEqual([
      `GET ${BACKEND_PATH.assets}`, `GET ${BACKEND_PATH.workflows}`, `GET ${BACKEND_PATH.finding}`, `GET ${BACKEND_PATH.scope}`,
    ].sort());
    expect(reads.every((one) => one.authorization === "Bearer access-for-admin")).toBe(true);
  });

  it("counts what it cannot offer and offers none of it: an asset or evidence with no uuid the backend takes, a workflow with no slug, the current revision's unreadable items", async () => {
    stand.serve({
      ...servedBefore(),
      [BACKEND_PATH.finding]: { ...SERVED_FINDING, evidence: [...(SERVED_FINDING.evidence as unknown[]), { uuid: "not-a-uuid" }, null, 7] },
      [BACKEND_PATH.assets]: { ...SERVED_ASSETS, count: 5, results: [...(SERVED_ASSETS.results as unknown[]), { uuid: "A0A0A0A0-0000-4000-8000-0000000000A9", deployment_uuid: DEP, name: "upper-case-uuid" }] },
      [BACKEND_PATH.workflows]: { approved: [{ slug: "refund", name: "Refunds" }, { slug: "has space", name: "x" }, null], returned: 3, truncated: true, page_size: 1000, approved_count: 9 },
      [BACKEND_PATH.scope]: { deployment: DEP, finding: INCIDENT_ID, current: 1, revisions: [{ revision: 1, current: true, items: [{ kind: "asset", ref: PRIMARY }, "a row", null] }] },
    });
    const res = await stand.admin.get(ROUTE_PATH.choices);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.assets.map((one: { uuid: string }) => one.uuid)).toEqual([PRIMARY, BACKUP, RELAY]);
    expect(res.body.workflows).toEqual([{ slug: "refund", name: "Refunds" }]);
    expect(res.body.workflowsWhole).toBe(false);
    expect(res.body.evidence.map((one: { uuid: string }) => one.uuid)).toEqual([EVIDENCE_1, EVIDENCE_2]);
    expect(res.body.current).toEqual({ revision: 1, items: [{ kind: "asset", ref: PRIMARY, assetKind: null }] });
    expect(res.body.unreadable).toEqual({ assets: 1, workflows: 2, evidence: 3, "current.items": 2 });
  });

  it("says a current revision it cannot name as not known, and a scope never declared as none", async () => {
    stand.serve({ ...servedBefore(), [BACKEND_PATH.scope]: { deployment: DEP, finding: INCIDENT_ID, current: 4, revisions: [{ revision: 1, items: [] }] } });
    expect((await stand.admin.get(ROUTE_PATH.choices)).body.current).toEqual({ revision: 4, items: null });
    stand.serve({ ...servedBefore(), [BACKEND_PATH.scope]: { deployment: DEP, finding: INCIDENT_ID, current: null, revisions: "three" } });
    const unread = (await stand.admin.get(ROUTE_PATH.choices)).body;
    expect(unread.current).toEqual({ revision: null, items: null });
    expect(unread.unreadable.revisions).toBe("not a list");
    stand.serve({ ...servedBefore(), [BACKEND_PATH.scope]: { deployment: DEP, finding: INCIDENT_ID, current: null, revisions: [] } });
    expect((await stand.admin.get(ROUTE_PATH.choices)).body.current).toEqual({ revision: null, items: [] });
  });

  it("passes on the backend's not found, and answers anything it cannot read as unavailable, never as an empty choice", async () => {
    stand.serve({});
    const missing = await stand.admin.get(ROUTE_PATH.choices);
    expect([missing.status, missing.body.code]).toEqual([404, "not_found"]);
    for (const finding of [{ ...SERVED_FINDING, deployment_uuid: null }, { ...SERVED_FINDING, deployment_uuid: "../../kill-switch" }]) {
      stand.serve({ ...servedBefore(), [BACKEND_PATH.finding]: finding });
      const res = await stand.admin.get(ROUTE_PATH.choices);
      expect(res.status).toBe(503);
      expect(res.body.assets).toBeUndefined();
    }
    // A page of assets that does not add up is not offered as the whole list.
    stand.serve({ ...servedBefore(), [BACKEND_PATH.assets]: { ...SERVED_ASSETS, count: 40 } });
    expect((await stand.admin.get(ROUTE_PATH.choices)).status).toBe(503);
    stand.serve({ ...servedBefore(), [BACKEND_PATH.assets]: ["not", "a", "page"] });
    expect((await stand.admin.get(ROUTE_PATH.choices)).status).toBe(503);
  });
});

describe("the declaration: admin-only, decided by the backend", () => {
  it("is refused to a console account that is not an admin, and to anyone not signed in, and sends nothing", async () => {
    const from = stand.seen.length;
    const reader = await stand.reader.post(ROUTE_PATH.declare).send(WIDER);
    expect(reader.status).toBe(403);
    expect((await request(stand.app).post(ROUTE_PATH.declare).send(WIDER)).status).toBe(401);
    expect(writes(from)).toEqual([]);
  });

  it("sends an admin's revision to the backend as that person, exactly the three parts, and answers 201 with nothing of the backend's answer", async () => {
    const from = stand.seen.length;
    const res = await stand.admin.post(ROUTE_PATH.declare).send(WIDER);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ recorded: true });
    const sent = writes(from);
    expect(sent.map((one) => `${one.method} ${one.path}`)).toEqual([`POST ${BACKEND_PATH.scope}`]);
    expect(sent[0].authorization).toBe("Bearer access-for-admin");
    expect(JSON.parse(sent[0].body)).toEqual(WIDER);
    expect(Object.keys(JSON.parse(sent[0].body))).toEqual(["items", "reason", "evidence"]);
  });

  it("refuses here, sending nothing, a body of another shape or an item of a kind the backend does not take", async () => {
    const from = stand.seen.length;
    for (const body of [
      { ...WIDER, items: [{ kind: "route", ref: "backup-route" }] },
      { ...WIDER, items: [{ kind: "identity", ref: "svc-ledger" }] },
      { ...WIDER, items: [{ kind: "asset", ref: PRIMARY, asset_kind: "gateway" }] },
      { ...WIDER, revision: 2 },
      { ...WIDER, declared_by: "someone-else" },
      { items: WIDER.items, evidence: WIDER.evidence },
      { ...WIDER, reason: ["a reason"] },
      { ...WIDER, items: "everything" },
      { ...WIDER, evidence: [7] },
      { ...WIDER, reason: "x".repeat(2001) },
    ]) {
      expect((await stand.admin.post(ROUTE_PATH.declare).send(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(writes(from)).toEqual([]);
  });

  it("passes the backend's 403 on as a refusal it named no code for", async () => {
    stand.answerPost({ status: 403, body: { detail: "Changing the assurance record requires an admin role." } });
    const res = await stand.admin.post(ROUTE_PATH.declare).send(WIDER);
    expect(res.status).toBe(403);
    expect(res.body.code).toBeNull();
    expect(res.body.backendStatus).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("requires an admin role");
  });
});

describe("a refusal is passed on by its code alone, never with what was typed", () => {
  for (const [code, status] of REFUSALS) {
    it(`${code} (${status})`, async () => {
      stand.answerPost(refused(code, status));
      const res = await stand.admin.post(ROUTE_PATH.declare).send(WIDER);
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
      expect(res.body.backendStatus).toBe(status);
      // The backend's detail repeats the reason; nothing of it comes back from here.
      expect(JSON.stringify(res.body)).not.toContain(REASON);
      expect(JSON.stringify(res.body)).not.toContain("refused: ");
    });
  }

  it("both spellings of a part left out: master's malformed and #231's items_required, reason_required, evidence_required", async () => {
    for (const code of ["malformed", "items_required", "reason_required", "evidence_required"]) {
      stand.answerPost(refused(code, 400));
      const res = await stand.admin.post(ROUTE_PATH.declare).send(WIDER);
      expect([res.status, res.body.code], code).toEqual([400, code]);
    }
  });

  it("an unknown code as it came; a code that is not a code, or none, as none", async () => {
    stand.answerPost(refused("scope_frozen", 409));
    const unknown = await stand.admin.post(ROUTE_PATH.declare).send(WIDER);
    expect([unknown.status, unknown.body.code]).toEqual([409, "scope_frozen"]);
    for (const body of [{ code: "<img src=x onerror=1>" }, { code: "x".repeat(65) }, { code: 7 }, { detail: REASON }, "not an object", null]) {
      stand.answerPost({ status: 400, body });
      const res = await stand.admin.post(ROUTE_PATH.declare).send(WIDER);
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, null]);
      expect(JSON.stringify(res.body)).not.toContain(REASON);
    }
    stand.answerPost({ status: 409, raw: `<html>${REASON}</html>` });
    const page = await stand.admin.post(ROUTE_PATH.declare).send(WIDER);
    expect([page.status, page.body.code]).toEqual([409, null]);
    expect(JSON.stringify(page.body)).not.toContain(REASON);
  });

  it("a refusal whose body stalls after its headers is answered within a bound, with no code", async () => {
    stand.answerPost({ stallBody: 409 });
    const res = await stand.admin.post(ROUTE_PATH.declare).send(WIDER);
    expect([res.status, res.body.code]).toEqual([409, null]);
    // The backend's half-sent answer is abandoned, holding nothing.
    for (let tries = 0; tries < 200 && stand.holding() > 0; tries += 1) await new Promise((r) => setTimeout(r, 10));
    expect(stand.holding()).toBe(0);
  }, 15_000);
});

describe("an answer that is neither a recording nor a refusal leaves the outcome unknown", () => {
  it("a 500, a 200 and a dropped connection are 503 outcome_unknown, never a refusal or a recording", async () => {
    for (const [answer, status] of [[{ status: 500, raw: "Server Error (500)" }, 500], [{ status: 200, body: {} }, 200], [{ drop: true }, null]] as const) {
      stand.answerPost(answer);
      const res = await stand.admin.post(ROUTE_PATH.declare).send(WIDER);
      expect([res.status, res.body.code, res.body.backendStatus], JSON.stringify(answer)).toEqual([503, "outcome_unknown", status]);
      expect(res.body.recorded).toBeUndefined();
    }
  });

  it("a 401 is never passed on: it is a sign-in the backend did not take", async () => {
    stand.answerPost({ status: 401, body: { detail: "Given token not valid for any token type" } });
    // The person's token renewed and the declaration sent again, and refused 401 again.
    stand.takeRefresh(true);
    const from = stand.seen.length;
    const again = await stand.admin.post(ROUTE_PATH.declare).send(WIDER);
    expect([again.status, again.body.code]).toEqual([503, "backend_sign_in_required"]);
    expect(writes(from).map((one) => one.authorization)).toEqual(["Bearer access-for-admin", "Bearer access-for-admin-renewed"]);
    // And the renewal itself refused: the sign-in ended, nothing sent again.
    stand.takeRefresh(false);
    const ended = await stand.admin.post(ROUTE_PATH.declare).send(WIDER);
    expect([ended.status, ended.body.code]).toEqual([503, "backend_sign_in_required"]);
  });
});

describe("the scope read's own path stays a read", () => {
  it("serves no write on /scope-revisions, and the declaration's route is a POST of its own, behind the admin guard", async () => {
    const from = stand.seen.length;
    for (const send of [
      () => stand.admin.post(ROUTE_PATH.scope).send(WIDER),
      () => stand.admin.put(ROUTE_PATH.scope).send(WIDER),
      () => stand.admin.patch(ROUTE_PATH.scope).send(WIDER),
      () => stand.admin.delete(ROUTE_PATH.scope),
      () => stand.admin.get(ROUTE_PATH.declare),
      () => stand.admin.put(ROUTE_PATH.declare).send(WIDER),
      () => stand.admin.post(ROUTE_PATH.choices).send(WIDER),
    ]) {
      expect((await send()).status).toBe(404);
    }
    expect(writes(from)).toEqual([]);
  });
});
