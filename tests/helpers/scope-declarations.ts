import type { Express } from "express";
import type { Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn, signInToBackend } from "../helpers";
import {
  BACKEND, BACKUP, DEP, EVIDENCE_1, EVIDENCE_2, FINDING, INCIDENT, ITEM, PRIMARY, SCOPE, addedGap, named, servedPage, servedRevision, servedStep,
} from "./incident-scopes";

/**
 * Declaring an incident's next scope revision (DASH-DECLARE) against a stand-in
 * Athena-Backend that answers in the shapes athena-backend `master` serves
 * (assurance/views.py FindingViewSet retrieve, AssetViewSet, approved_workflows and
 * scope_revisions; assurance/incident_scope.py), and takes the write as the test says.
 * Synthetic data, invented names.
 *
 * The incident is tests/helpers/incident-scopes.ts's `declared` one: its scope is at
 * revision 1 (the edge gateway and the refund workflow), and its recovery was accepted
 * under it. The deployment's assets are the edge gateway, the backup gateway and a
 * mail relay, plus one the backend answers for ANOTHER deployment; its approved
 * workflows are refund and payout. The incident's own evidence is two pieces.
 *
 * Once a revision is recorded, the stand-in answers as the backend does after it:
 * revision 2 adds the backup gateway, and the accepted step is kept back by it
 * (`scope:revision:2:added:asset:<backup>`).
 */

export { BACKUP, DEP, EVIDENCE_1, EVIDENCE_2, PRIMARY };

/** The incident a revision is declared for. */
export const INCIDENT_ID = FINDING.declared;
/** A third asset of the deployment, in no revision yet. */
export const RELAY = "a0a0a0a0-0000-4000-8000-0000000000a4";
/** Another deployment, and an asset the backend answers for it. */
export const OTHER_DEP = "0d0d0d0d-0000-4000-8000-0000000000ee";
export const ELSEWHERE = "a0a0a0a0-0000-4000-8000-0000000000ee";
/** What a person types as the reason. A refusal never repeats it. */
export const REASON = "a backup gateway answered in the firewall export of 14 November";

/** The backend's paths, and this console's routes. */
export const BACKEND_PATH = {
  finding: `/api/assurance/findings/${INCIDENT_ID}/`,
  assets: "/api/assurance/assets/",
  workflows: `/api/assurance/deployments/${DEP}/approved-workflows/`,
  scope: BACKEND.scope("declared"),
  record: BACKEND.record("declared"),
  page: BACKEND.page,
};
export const ROUTE_PATH = {
  choices: `/api/assurance/findings/${INCIDENT_ID}/scope-choices`,
  declare: `/api/assurance/findings/${INCIDENT_ID}/declare-scope`,
  scope: `/api/assurance/findings/${INCIDENT_ID}/scope-revisions`,
  record: `/api/assurance/findings/${INCIDENT_ID}/recovery-record`,
  page: `/api/assurance/deployments/${DEP}/recovery-records`,
};

type Served = Record<string, unknown>;

export const SERVED_FINDING: Served = {
  uuid: INCIDENT_ID, deployment_uuid: DEP, title: "Refund agent wrote outside its approval", severity: "high",
  evidence: [
    { uuid: EVIDENCE_1, classification: "technically_verified", classification_label: "Technically verified", summary: "the gateway's own log of the export", source: "edr", content_hash: "1".repeat(64), created_at: "2026-11-01T09:00:00Z" },
    { uuid: EVIDENCE_2, classification: "document_supported", classification_label: "Document-supported", summary: "the firewall export of 14 November", source: "firewall", content_hash: "2".repeat(64), created_at: "2026-11-14T09:00:00Z" },
  ],
};

const asset = (uuid: string, name: string, deployment = DEP) => ({
  uuid, deployment_uuid: deployment, kind: "gateway", kind_label: "Gateway", name, identifier: `${name}.internal`, classification: "approved",
  classification_label: "Approved", provider: null, provider_uuid: null, provider_name: null, finding_count: 0, metadata: {}, first_seen: null, last_seen: null,
});

export const SERVED_ASSETS: Served = {
  count: 4, next: null, previous: null,
  results: [asset(PRIMARY, "edge-gateway"), asset(BACKUP, "backup-gateway"), asset(RELAY, "mail-relay"), asset(ELSEWHERE, "another-tenant-gateway", OTHER_DEP)],
};

const workflow = (slug: string, name: string) => ({ uuid: `wf-${slug}`, slug, name, description: "", approved_by: "owner-d", approved_at: "2026-11-01T09:00:00Z", tools: [] });

export const SERVED_WORKFLOWS: Served = {
  approved: [workflow("refund", "Refunds"), workflow("payout", "Payouts")],
  returned: 2, truncated: false, page_size: 1000, approved_count: 2, composition: null,
};

/** The scope after revision 2 added the backup gateway. */
export const SCOPE_AFTER: Served = {
  deployment: DEP, finding: INCIDENT_ID, current: 2,
  revisions: [
    { ...servedRevision(INCIDENT_ID, 1, { items: [ITEM.primary, ITEM.refund], added: [named(ITEM.primary), named(ITEM.refund)] }), current: false },
    {
      ...servedRevision(INCIDENT_ID, 2, {
        items: [ITEM.primary, ITEM.refund, ITEM.backup], added: [named(ITEM.backup)], reason: REASON, declared_by: "admin",
        evidence: [{ uuid: EVIDENCE_2, classification: "document_supported" }],
      }),
      current: true,
    },
  ],
};

/** The incident's record after revision 2: the step accepted under revision 1 is kept back by the gateway it added. */
export function incidentAfter(): Served {
  const before = INCIDENT.declared as { steps: Served[] };
  const gap = addedGap(2, "asset", BACKUP);
  const kept = servedStep(INCIDENT_ID, 2, {
    state: "repair_tested", release: "AUDIT_INCOMPLETE", gaps: [gap], scope_gaps: [gap], scope_revision: 1,
    conditions: (before.steps[1] as { conditions: unknown }).conditions,
    residual_uncertainty: [{ statement: gap, sources: [{ kind: "scope", ref: `finding:${INCIDENT_ID}` }] }],
    scope_items: { added: [{ revision: 2, ...named(ITEM.backup), covered_by: [] }], removed: [] },
    accepted_by: "owner-d", accepted_until: "2999-01-01T00:00:00+00:00", recorded_by: "owner-d",
    recorded: { state: "recovery_accepted", gaps: [], release: "PASS" },
  });
  return {
    ...INCIDENT.declared, scope_revision: 2, scope_removed: [],
    current: { version: 2, state: "repair_tested", release: "AUDIT_INCOMPLETE" },
    steps: [before.steps[0], kept],
  };
}

/** Everything the stand-in answers by path before a revision is recorded. */
export function servedBefore(): Record<string, unknown> {
  return {
    [BACKEND_PATH.finding]: SERVED_FINDING,
    [BACKEND_PATH.assets]: SERVED_ASSETS,
    [BACKEND_PATH.workflows]: SERVED_WORKFLOWS,
    [BACKEND_PATH.scope]: SCOPE.declared,
    [BACKEND_PATH.record]: { deployment: DEP, ...INCIDENT.declared },
    [BACKEND_PATH.page]: servedPage(["declared"]),
  };
}

/** And after it. */
export function servedAfter(): Record<string, unknown> {
  const after = incidentAfter();
  const page = servedPage(["declared"]) as { incidents: unknown[] };
  return {
    ...servedBefore(),
    [BACKEND_PATH.scope]: SCOPE_AFTER,
    [BACKEND_PATH.record]: { deployment: DEP, ...after },
    [BACKEND_PATH.page]: { ...page, incidents: [after] },
  };
}

/** What the stand-in does with the write: answer it, hold it unanswered, drop the connection, or stall its body. */
export type PostAnswer =
  | { status: number; body?: unknown; raw?: string }
  | { hang: true }
  | { drop: true }
  | { stallBody: number };

/** Every backend refusal code of assurance/incident_scope.py (master and PR #231), with the status the view gives it. */
export const REFUSALS: ReadonlyArray<readonly [code: string, status: 400 | 409]> = [
  ["malformed", 400], ["not_posted", 400], ["items_required", 400], ["reason_required", 400], ["evidence_required", 400],
  ["unknown_link", 400], ["nothing_changed", 409], ["not_current", 409], ["raced", 409], ["bad_supersedes", 400],
  ["declared_by_required", 400],
];

/** The backend's answer to a refused write: its code, and a detail that repeats what was typed (as no backend should). */
export const refused = (code: string, status = 400): PostAnswer => ({ status, body: { code, detail: `refused: ${REASON}` } });

/** The 201 the backend answers a recording with: the scope with only the new revision. */
export const RECORDED: PostAnswer = {
  status: 201,
  body: { deployment: DEP, finding: INCIDENT_ID, current: 2, revisions: (SCOPE_AFTER.revisions as unknown[]).slice(-1) },
};

export interface Seen {
  method: string;
  path: string;
  authorization: string;
  body: string;
}

export interface DeclareStandIn {
  app: Express;
  /** The console's admin, signed in to the stand-in backend. */
  admin: Awaited<ReturnType<typeof signIn>>;
  /** A console account with the user role, signed in to the stand-in backend too. */
  reader: Awaited<ReturnType<typeof signIn>>;
  seen: Seen[];
  /** What the backend answers each GET with, by path. */
  serve(answers: Record<string, unknown>): void;
  /** What it does with the next writes. A recording (201) also moves it to servedAfter(). */
  answerPost(answer: PostAnswer): void;
  /** Whether a person's token is renewed by its refresh token (it is not, by default). */
  takeRefresh(yes: boolean): void;
  /** Writes it holds unanswered now. */
  holding(): number;
  close(): Promise<void>;
}

const READER_PASSWORD = "quinn-declares-nothing-7"; // pragma: allowlist secret

/** A stand-in Athena-Backend for the declaration, and this console signed in to it as an admin and as a reader. */
export async function declareStandIn(): Promise<DeclareStandIn> {
  const http = await import("http");
  const seen: Seen[] = [];
  let served: Record<string, unknown> = servedBefore();
  let post: PostAnswer = RECORDED;
  let refreshes = false;
  const held = new Set<ServerResponse>();
  const server: Server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
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
      if (path === "/api/token/refresh/") {
        return refreshes
          ? json(200, { access: "access-for-admin-renewed", refresh: "refresh-for-admin-renewed" })
          : json(401, { detail: "Token is blacklisted", code: "token_not_valid" });
      }
      seen.push({ method, path, authorization: req.headers.authorization ?? "", body: raw });
      if (method === "POST" && path === BACKEND_PATH.scope) {
        const answer = post;
        if ("hang" in answer) {
          held.add(res);
          res.on("close", () => held.delete(res));
          return;
        }
        if ("drop" in answer) return void req.socket.destroy();
        if ("stallBody" in answer) {
          res.writeHead(answer.stallBody, { "Content-Type": "application/json" });
          res.write('{"code": "nothing_cha');
          held.add(res);
          res.on("close", () => held.delete(res));
          return;
        }
        if (answer.status === 201) served = servedAfter();
        if (answer.raw !== undefined) {
          res.writeHead(answer.status, { "Content-Type": "text/html" });
          return res.end(answer.raw);
        }
        return json(answer.status, answer.body ?? {});
      }
      if (method === "GET" && path in served) return json(200, served[path]);
      return json(404, { detail: "Not found." });
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${port}`;
  process.env.ATHENA_FAILSAFE_USER = "svc-operator";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc-secret"; // pragma: allowlist secret
  const app = await makeApp();
  const admin = await signIn(app);
  await signInToBackend(admin);
  const made = await admin.post("/api/users").send({ username: "quinn", password: READER_PASSWORD, role: "user", email: "quinn@tenant.test" });
  if (made.status !== 201) throw new Error(`the reader was not made: ${made.status}`);
  const reader = await signIn(app, "quinn", READER_PASSWORD);
  await signInToBackend(reader, READER_PASSWORD);
  return {
    app, admin, reader, seen,
    serve(answers) { served = answers; },
    answerPost(answer) { post = answer; },
    takeRefresh(yes) { refreshes = yes; },
    holding: () => held.size,
    async close() {
      for (const res of held) res.destroy();
      server.closeAllConnections?.();
      delete process.env.ATHENA_FAILSAFE_URL;
      delete process.env.ATHENA_FAILSAFE_USER;
      delete process.env.ATHENA_FAILSAFE_PASSWORD;
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** The body an administrator posts for the widening: the current items, the backup gateway, the firewall export. */
export const WIDER = {
  items: [{ kind: "asset", ref: PRIMARY }, { kind: "workflow", ref: "refund" }, { kind: "asset", ref: BACKUP }],
  reason: REASON,
  evidence: [EVIDENCE_2],
};
