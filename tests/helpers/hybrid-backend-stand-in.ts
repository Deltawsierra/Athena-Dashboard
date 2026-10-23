/**
 * A stand-in Athena-Backend for the pentest routes the Option 1 hybrid uses --
 * TEST HELPER ONLY, reachable by nothing in server/ -- modelling the PR-A
 * contract (athena-backend pentest/views.py, serializers.py, the collect route
 * and the `stopped` status) as the backend answers it:
 *
 *   - `GET /api/accounts/users/me/`: the account's role (admin | analyst | viewer).
 *   - Engagements (`/api/pentest/engagements/`, `<id>/`): visible to their creator,
 *     and to an admin; the serializer's fields, `testing_window_start/end` among
 *     them; a DELETE is answered and RECORDED (the dashboard must never send one).
 *   - `POST /api/pentest/scan/` (admin or analyst): the backend's own refusals in
 *     its own words and order -- the url, the recipient, consent ("User consent
 *     required. Include 'consent': true."), `wait_seconds` (0 ≤ w ≤ 600, else 400
 *     naming the field), `authorise_target` (engagement required, visible,
 *     running, inside its window -- both dates -- and covering the host) as 403
 *     `{error}`, a preflight refusal as 409 `{error, assurance}`; the
 *     Idempotency-Key layer per account (a replay answers the FIRST answer again
 *     with `Idempotent-Replayed: true` and launches nothing; the same key for
 *     another request is 422; the same key while the first is unanswered is 409
 *     `{idempotency: {state: "in_flight"}}`); then the scan's row is created
 *     BEFORE the launch, and the launch goes to the test's own ENGINE STUB
 *     (`POST /api/scan`, as the real backend launches with its own key), so
 *     every live poll and every Stop in the tests still reaches that stub.
 *     `wait_seconds: 0` is exactly one bounded engine read, then 202
 *     `{scan_id, status: "pending", engine_run_id, detail, status_url, collect_url}`;
 *     a run the engine finished inside that read is 200 `{scan_id, result}`; one
 *     it refused, or that ended aborted or failed inside the read, is recorded
 *     `failed` and answered 502 `{scan_id, status: "failed", error, engine_run_id}`.
 *   - `GET /api/pentest/scans/` (paginated; the detail's fields without
 *     `engine_response`), `GET /api/pentest/scans/<uuid>/` (the detail serializer
 *     plus `engine_run_id`, `stop`, `collected_at`, `engagement`; never
 *     `recipient_email`, never `assurance`).
 *   - `POST /api/pentest/scans/<uuid>/collect/` (admin or analyst, visible):
 *     409 `{detail, status}` unless pending with a run; one bounded engine read:
 *     not over → 202 "still running"; completed → the record completed (verdict
 *     derived, PDF) → 200 detail; aborted → `stopped`, "Stopped on the engine:
 *     <reason>", the partial response kept, no verdict → 200; failed → `failed`,
 *     "Failed on the engine: <error>" → 200; engine 404 → `failed`, "the engine
 *     has no run <id>" → 200; engine unreachable → 503 `{detail}`, row untouched.
 *     A second collector gets the 409: nothing is written twice.
 *   - `POST /api/pentest/scans/<uuid>/stop/`: a stop for every POST (safety/stops.py):
 *     the failsafe service token is taken on it, as FAILSAFE_SERVICE_USER; the Stop
 *     is recorded on the row. By default the stand-in sends the engine stub NO
 *     abort of its own (the dashboard's direct abort is the stop in these tests,
 *     and the tests count the stub's aborts); `stopAbortsEngine` turns that on.
 *   - `GET /api/pentest/scans/<uuid>/pdf/`: bytes for a completed scan; 409
 *     `{error, detail}` for any other status (a stopped or failed run has no PDF).
 *   - With `assurance`, the retest-check routes of athena-backend #189 (owner
 *     decision 8; assurance/retest_checks.py, FindingViewSet.retest_checks_collect):
 *     `POST /api/assurance/findings/<uuid>/retest-checks/collect/` (admin or
 *     analyst; the finding visible) with `{run_id, twin_run_id}`, in the
 *     backend's order -- a run already recorded is 200 with its row (409 when it
 *     is another finding's); ONE read of the engine stub's `GET /api/scans/<run_id>`
 *     (404 → 404 "the engine has no run"; unreachable → 503, nothing written); a
 *     run still going → 202 `{phase: "running"}`; one that stopped, failed or
 *     ended without a verdict → 200 `{phase, recorded: false}`, nothing written;
 *     then identity, every check or nothing written: the scan under `twin_run_id`
 *     is in this record (else 404), its deployment is the finding's (else 422),
 *     the verdict's type is the finding's and the finding is the one of that type
 *     in the deployment (else 422 / 409 with the candidates), the verdict's target
 *     host is the scan's (else 422), and the engine lists the twin under that run
 *     with that type (else 422); then one row, UNIQUE on the run id, answered 201
 *     `{check, recorded: true, closure}`. A check is NOT closure evidence: the
 *     finding's status, closure and everything else stay as they were.
 *     `GET /api/assurance/findings/<uuid>/retest-checks/`: every check, newest
 *     first, paginated; the findings list carries each finding's latest ten.
 *
 * Every request is recorded with the account it was made as, what authenticated
 * it, whether the backend judges it a stop, its Idempotency-Key, and its status.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { judgeStop } from "./control-plane-stand-in";
import { TEST_ADMIN_PASSWORD } from "../test-admin";

export type HybridRole = "admin" | "analyst" | "viewer";

export interface HybridAccount {
  password: string;
  role: HybridRole;
  active?: boolean;
}

export interface HybridSeen {
  n: number;
  method: string;
  path: string;
  query: string;
  body: string;
  json: Record<string, unknown> | null;
  /** The account the request was made as; for the token routes, the account signing in. */
  account: string | null;
  by: "service token" | "bearer" | null;
  /** Whether the backend judges this request a stop. */
  stop: boolean;
  bearer: string | undefined;
  serviceToken: string | undefined;
  idempotencyKey: string | null;
  status: number;
  /** Whether the answer was a replay of a first send's (Idempotent-Replayed). */
  replayed: boolean;
}

/** An engagement as the stand-in holds and serves it (EngagementSerializer's fields). */
export interface HybridEngagement {
  id: number;
  name: string;
  client_name: string | null;
  scope_summary: string | null;
  status: string;
  testing_window_start: string | null;
  testing_window_end: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  scope_hosts: string[];
}

/** A scan as the stand-in holds it (PentestScan's fields the contract serves, and what it never serves). */
export interface HybridScan {
  uuid: string;
  user: string;
  engagement: number | null;
  target_url: string;
  consent: boolean;
  /** pending | completed | stopped | failed | unknown */
  status: string;
  verdict: string | null;
  created_at: string;
  collected_at: string | null;
  /** As the engine named it (text, a number, or nothing): the backend records it as sent; the dashboard reads it by its one rule. */
  engine_run_id: string | number | null;
  engine_response: Record<string, unknown> | null;
  error_message: string | null;
  /** Never served. */
  recipient_email: string | null;
  email_sent: boolean;
  stop_requested_at: string | null;
  stop_delivered_at: string | null;
  stop_detail: string | null;
}

/** A deployment as the assurance record lists it (DeploymentSerializer, with #188's `engagement_id`). */
export interface HybridDeployment {
  uuid: string;
  name: string;
  environment: string;
  decision: string | null;
  decision_label: string;
  description: string;
  finding_count: number;
  engagement_id: number | null;
  created_at: string;
  updated_at: string;
  /** The account that owns it: visible to it and to an admin (visible_deployments). */
  owner: string;
}

/** A finding as the assurance record lists it (FindingSerializer, with #188's `scan_uuid`, `engine_run_id` and #189's `retest_checks`). */
export interface HybridFinding {
  uuid: string;
  deployment_uuid: string;
  finding_type: string;
  title: string;
  severity: string;
  confidence: number | null;
  status: string;
  status_label: string;
  status_must_not_imply: string | null;
  owner: string | null;
  impact: string;
  business_impact: string;
  recommendation: string;
  location: string;
  retest_required: boolean;
  evidence_class: string;
  evidence: unknown[];
  asset_uuid: string | null;
  asset_name: string | null;
  change_status: string;
  change_label: string;
  age_days: number | null;
  stale: boolean;
  receipt: { algorithm: string; digest: string; evidence_count: number };
  first_seen: string | null;
  last_seen: string | null;
  assignee: string | null;
  remediation_state: string;
  closure: unknown;
  /** The scan this finding was ingested from, and the run it names; null for one filed another way. */
  scan_uuid: string | null;
  engine_run_id: string | number | null;
  /** The retest checks recorded against it, newest first (#189 RetestCheckSerializer); the list serves the latest ten. */
  retest_checks: HybridRetestCheck[];
}

/** One retest check as the backend serves it (#189 RetestCheckSerializer's fields, and nothing else). */
export interface HybridRetestCheck {
  engine_run_id: string;
  scan_record_id: string | null;
  twin_id: number;
  twin_run_id: string;
  /** The engine's word, as sent (closed | still_open | inconclusive, or another). */
  verdict: string;
  verdict_known: boolean;
  detail: string;
  /** completed | aborted */
  state: string;
  stopped_after_recording: boolean;
  engine_checked_at: string | null;
  collected_at: string;
  collected_by: string | null;
}

/** The verdicts the engine's retest files (athena-backend assurance/retest_checks.py KNOWN_VERDICTS). */
const KNOWN_VERDICTS = ["closed", "still_open", "inconclusive"];
/** The shape of an engine run id the backend names to the engine (retest_checks.py RUN_ID). */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** What the backend says for a run that ended without a verdict it keeps (retest_checks.py _PHASE_DETAIL). */
const PHASE_DETAIL: Record<string, string> = {
  stopped: "the run was stopped on the engine before its check was filed: no verdict, and nothing was recorded",
  failed: "the run failed on the engine: its inconclusive result is not a verdict on the finding, and nothing was recorded",
  refused: "the engine refused the run before any of its work started: nothing was recorded",
  ended_without_verdict: "the run ended without a verdict: nothing was recorded",
};
/** How many of a finding's checks its serializer carries (serializers.py RETEST_CHECKS_SERVED). */
const RETEST_CHECKS_SERVED = 10;

export interface HybridStandInOptions {
  /** The test's own engine stub: where every launch goes, as the real backend launches with its own key. */
  engine: { url: string; key?: string };
  /**
   * Serve the assurance record's two lists -- `GET /api/assurance/deployments/`
   * and `GET /api/assurance/findings/` (`?deployment=` filter) -- from this
   * stand-in's own stores (addDeployment, addFinding), as the backend serves them
   * after #188, instead of forwarding them to the upstream or answering 404.
   */
  assurance?: boolean;
  /**
   * Page every list (the scans, the deployments, the findings) this many rows
   * at a time, with DRF's absolute `next` and `previous` links and `?page=N`;
   * absent, each list is one page with `next: null`, as before.
   */
  pageSize?: number;
  /** The accounts that may sign in; the default is the console's admin, an admin here too. */
  accounts?: Record<string, HybridAccount>;
  /** FAILSAFE_SERVICE_TOKEN; null or absent for none. */
  serviceToken?: string | null;
  /** FAILSAFE_SERVICE_USER: the account the service token authenticates as. An admin unless said otherwise (decision 6). */
  serviceUser?: string;
  serviceUserRole?: HybridRole;
  /** SCAN_INLINE_WAIT_SECONDS: the most the engine is asked to wait inline. */
  inlineWaitSeconds?: number;
  /** SCAN_COLLECT_SECONDS: the most `wait_seconds` may be. */
  collectSeconds?: number;
  /** How long one engine call may take (ENGINE_TIMEOUT). */
  engineTimeoutMs?: number;
  /** Whether a Stop on this stand-in sends the engine stub an abort of its own. Off by default (see the header). */
  stopAbortsEngine?: boolean;
  /**
   * A control-plane stand-in behind this one (a test's own, serving the
   * failsafe and assurance routes): every request this stand-in does not serve
   * is forwarded to it as it came, headers and all, and its answer relayed; a
   * sign-in of an account this stand-in does not know is forwarded too, and the
   * tokens it answers are taken here as that account's, with the service user's
   * role. So a test that already stands up a control plane keeps it, with this
   * stand-in in front for the pentest routes alone.
   */
  upstream?: string;
}

export const VERDICT_LABEL: Record<string, string> = {
  READY: "Ready for deployment",
  READY_RESTRICTED: "Ready with restrictions",
  NEEDS_REMEDIATION: "Requires remediation",
  BLOCKED: "Not recommended for production",
};
const VERDICT_ORDER = ["READY", "READY_RESTRICTED", "NEEDS_REMEDIATION", "BLOCKED"];
const SEVERITY_TO_VERDICT: Record<string, string> = {
  critical: "BLOCKED", high: "NEEDS_REMEDIATION", medium: "READY_RESTRICTED", low: "READY",
};

/** PentestScan.derive_verdict: the worst finding's verdict; None for a run that holds no findings list. */
export function deriveVerdict(engineResponse: Record<string, unknown> | null): string | null {
  if (engineResponse === null) return null;
  const findings = Array.isArray(engineResponse.findings) ? engineResponse.findings
    : Array.isArray(engineResponse.results) ? engineResponse.results : null;
  if (findings === null) return null;
  let worst = 0;
  for (const one of findings) {
    if (!one || typeof one !== "object" || (one as { internal?: unknown }).internal) continue;
    const severity = String((one as { severity?: unknown }).severity ?? "").trim().toLowerCase();
    const index = VERDICT_ORDER.indexOf(SEVERITY_TO_VERDICT[severity] ?? "READY");
    if (index > worst) worst = index;
  }
  return VERDICT_ORDER[worst];
}

/** Engagement.covers: an entry covers itself and its subdomains. */
function covers(scopeHosts: string[], host: string): boolean {
  const wanted = host.trim().toLowerCase();
  if (wanted === "") return false;
  return scopeHosts.some((entry) => {
    const one = String(entry).trim().toLowerCase();
    return one !== "" && (wanted === one || wanted.endsWith(`.${one}`));
  });
}

function parse(raw: string): Record<string, unknown> | null {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return "";
  }
}

/** The run id as the engine named it: text or a whole number as sent (the backend records it as it is), else none. */
function runIdOf(value: unknown): string | number | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return null;
}

/** The run id as one path segment of the engine's routes, for the stand-in's own reads of the run. */
function runSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** Whether a run id the engine named can be read back as exactly one path segment (shared/engine-record.ts stopIdFrom's rule). */
function addressable(value: string | number | null): boolean {
  if (value === null) return false;
  const text = String(value);
  return text !== "" && text !== "." && text !== ".." && !text.includes("/") && !text.includes("\\");
}

export async function hybridBackendStandIn(opts: HybridStandInOptions) {
  const seen: HybridSeen[] = [];
  const held: http.ServerResponse[] = [];
  const accounts = new Map<string, HybridAccount>(Object.entries(opts.accounts ?? { admin: { password: TEST_ADMIN_PASSWORD, role: "admin" } }));
  const serviceUser = opts.serviceUser ?? "svc-failsafe";
  const serviceUserRole: HybridRole = opts.serviceUserRole ?? "admin";
  const inlineWait = opts.inlineWaitSeconds ?? 20;
  const collectSeconds = opts.collectSeconds ?? 600;
  const engineTimeoutMs = opts.engineTimeoutMs ?? 20_000;
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();
  const blacklisted = new Set<string>();
  const engagements = new Map<number, HybridEngagement>();
  const scans = new Map<string, HybridScan>();
  /** The assurance record's deployments and findings, served when opts.assurance is set. */
  const deployments = new Map<string, HybridDeployment>();
  const findings = new Map<string, HybridFinding>();
  /** Every retest check recorded, by the engine run id it is UNIQUE on, with the finding it was recorded against. */
  const retestChecks = new Map<string, HybridRetestCheck & { finding_uuid: string }>();
  /** The Idempotency-Key layer: per account and route, the first request and its answer. */
  const keyed = new Map<string, { request: string; answer: { status: number; body: unknown } | null }>();
  const engineCalls: Array<{ method: string; path: string; body: Record<string, unknown> | null; key: string | null }> = [];
  let nextEngagement = 0;
  let issued = 0;
  let waiters: Array<{ match: (one: HybridSeen) => boolean; resolve: (one: HybridSeen) => void }> = [];
  const controls = {
    /** Launches held unanswered until releaseLaunches(): the dashboard's bound, not this, ends the wait. */
    holdLaunches: false,
    /** The next launch is answered with this, before anything is sent to the engine. */
    failNextLaunch: null as { status: number; body: unknown } | null,
    /** A preflight refusal every launch gets (409 {error, assurance}). */
    preflightRefusal: null as string | null,
    /** Collects held unanswered until releaseCollects(). */
    holdCollects: false,
    /** Every collect is answered with this instead of reading the engine. */
    failNextCollect: null as { status: number; body: unknown } | null,
    /** The engine is treated as unreachable by collect (503) while true. */
    engineUnreachable: false,
    stopAbortsEngine: opts.stopAbortsEngine === true,
    /** Stops held unanswered until releaseStops(). */
    holdStops: false,
    /** Each stop POST takes the next of these as its answer, before anything is recorded; empty for the stand-in's own. */
    stopAnswers: [] as Array<{ status: number; body: unknown }>,
    /** A launch's answer is sent this many ms after the launch is done: the row exists, the run is named, the answer is late. */
    answerDelayMs: 0,
    /** The next assurance list read (deployments or findings) is answered with this instead of the store. */
    failNextAssurance: null as { status: number; body: unknown } | null,
    /** The next scans list read is answered with this instead of the list. */
    failNextScansList: null as { status: number; body: unknown } | null,
    /** Scans list reads held unanswered until releaseScansLists(): a sync in flight that no stop waits on. */
    holdScansLists: false,
    /** The next scan detail read is answered with this instead of the record (a finished scan the sync cannot read now). */
    failNextScanDetail: null as { status: number; body: unknown } | null,
    /** The next retest-check collect is answered with this, before anything is read or written. */
    failNextRetestCheckCollect: null as { status: number; body: unknown } | null,
    /** Retest-check collects held unanswered until releaseRetestCheckCollects(). */
    holdRetestCheckCollects: false,
  };
  const heldLaunches: Array<() => void> = [];
  const heldScansLists: Array<() => void> = [];
  const heldCollects: Array<() => void> = [];
  const heldStops: Array<() => void> = [];
  const heldRetestCheckCollects: Array<() => void> = [];
  /** The scans a collect is reading the engine for right now: a second collector meanwhile is told the record is claimed (409). */
  const collecting = new Set<string>();

  const issue = (account: string) => {
    issued += 1;
    const pair = { access: `access-${account}-${issued}`, refresh: `refresh-${account}-${issued}` };
    access.set(pair.access, account);
    refresh.set(pair.refresh, account);
    return pair;
  };
  const roleOf = (account: string): HybridRole => (account === serviceUser ? serviceUserRole : accounts.get(account)?.role ?? "viewer");
  const isAdmin = (account: string) => roleOf(account) === "admin";
  const engagementsVisibleTo = (account: string) =>
    Array.from(engagements.values()).filter((one) => isAdmin(account) || one.created_by === account);
  const scansVisibleTo = (account: string) =>
    Array.from(scans.values()).filter((one) => isAdmin(account) || one.user === account);

  const engagementOf = (one: HybridEngagement) => ({ ...one, scope_hosts: [...one.scope_hosts] });
  const stopReadingOf = (scan: HybridScan) =>
    scan.stop_requested_at === null
      ? { state: "none", detail: null }
      : { state: scan.stop_delivered_at !== null ? "delivered" : "owed", detail: scan.stop_detail };
  const detailOf = (scan: HybridScan) => {
    const engagement = scan.engagement === null ? null : engagements.get(scan.engagement) ?? null;
    return {
      id: Array.from(scans.keys()).indexOf(scan.uuid) + 1,
      uuid: scan.uuid,
      user: scan.user,
      target_url: scan.target_url,
      consent: scan.consent,
      status: scan.status,
      verdict: scan.verdict,
      verdict_label: scan.verdict === null ? null : VERDICT_LABEL[scan.verdict] ?? scan.verdict,
      created_at: scan.created_at,
      collected_at: scan.collected_at,
      engine_run_id: scan.engine_run_id,
      stop: stopReadingOf(scan),
      engine_response: scan.engine_response,
      pdf_url: scan.status === "completed" ? `/api/pentest/scans/${scan.uuid}/pdf/` : null,
      email_sent: scan.email_sent,
      error_message: scan.error_message,
      engagement: engagement === null ? null
        : { id: engagement.id, name: engagement.name, client_name: engagement.client_name, status: engagement.status },
    };
  };
  const listRowOf = (scan: HybridScan) => {
    const { engine_response: _omitted, ...row } = detailOf(scan);
    return row;
  };
  /**
   * A list as DRF's PageNumberPagination serves it: one page holding every row
   * when no page size is set; else `?page=N` of pageSize rows, with absolute
   * `next` and `previous` links on this stand-in's own address.
   */
  const pageOf = (rows: unknown[], path: string, query: URLSearchParams) => {
    const size = opts.pageSize;
    if (size === undefined) return { count: rows.length, next: null, previous: null, results: rows };
    const page = Math.max(1, Number.parseInt(query.get("page") ?? "1", 10) || 1);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
    const link = (n: number) => `${base}?${new URLSearchParams({ ...Object.fromEntries(query), page: String(n) }).toString()}`;
    const last = Math.max(1, Math.ceil(rows.length / size));
    return {
      count: rows.length,
      next: page < last ? link(page + 1) : null,
      previous: page > 1 ? link(page - 1) : null,
      results: rows.slice((page - 1) * size, page * size),
    };
  };
  const deploymentsVisibleTo = (account: string) =>
    Array.from(deployments.values()).filter((one) => isAdmin(account) || one.owner === account);

  /** One call to the engine stub, bounded by engineTimeoutMs. */
  async function engine(method: string, path: string, body?: Record<string, unknown>, key?: string): Promise<
    { ok: true; status: number; body: Record<string, unknown> | null } | { ok: false; detail: string }
  > {
    engineCalls.push({ method, path, body: body ?? null, key: key ?? null });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), engineTimeoutMs);
    try {
      const response = await fetch(`${opts.engine.url}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(opts.engine.key ? { "X-API-Key": opts.engine.key } : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      return { ok: true, status: response.status, body: parse(text) };
    } catch (cause) {
      return { ok: false, detail: `the engine could not be reached: ${cause instanceof Error ? cause.message : String(cause)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  function complete(scan: HybridScan, result: Record<string, unknown>): void {
    scan.engine_response = result;
    scan.status = "completed";
    scan.verdict = deriveVerdict(result);
    scan.collected_at = new Date().toISOString();
    scan.error_message = null;
    if (scan.recipient_email) scan.email_sent = true;
  }

  /** Read the run once and record its end if it has one. What the collect route answers. */
  async function collectOnce(scan: HybridScan): Promise<{ status: number; body: unknown }> {
    if (controls.engineUnreachable) return { status: 503, body: { detail: "the engine could not be reached, so the record was left as it was: still pending" } };
    const read = await engine("GET", `/api/scans/${runSegment(scan.engine_run_id!)}`);
    if (!read.ok) return { status: 503, body: { detail: `${read.detail}; the record was left as it was: still pending` } };
    if (read.status === 404) {
      scan.status = "failed";
      scan.verdict = null;
      scan.error_message = `the engine has no run ${scan.engine_run_id}`;
      scan.collected_at = new Date().toISOString();
      return { status: 200, body: detailOf(scan) };
    }
    const payload = read.body ?? {};
    const state = typeof payload.state === "string" ? payload.state : "unknown";
    const result = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result) ? (payload.result as Record<string, unknown>) : null;
    if (state === "completed" || payload.done === true && state !== "aborted" && state !== "failed") {
      complete(scan, result ?? {});
      return { status: 200, body: detailOf(scan) };
    }
    if (state === "aborted") {
      scan.status = "stopped";
      scan.verdict = null;
      scan.engine_response = result;
      scan.error_message = `Stopped on the engine: ${typeof payload.reason === "string" ? payload.reason : typeof result?.detail === "string" ? result.detail : "stopped"}`;
      scan.collected_at = new Date().toISOString();
      return { status: 200, body: detailOf(scan) };
    }
    if (state === "failed") {
      scan.status = "failed";
      scan.verdict = null;
      scan.engine_response = result;
      scan.error_message = `Failed on the engine: ${typeof result?.error === "string" ? result.error : typeof payload.error === "string" ? payload.error : "failed"}`;
      scan.collected_at = new Date().toISOString();
      return { status: 200, body: detailOf(scan) };
    }
    return { status: 202, body: { scan_id: scan.uuid, status: "pending", engine_run_id: scan.engine_run_id, detail: "still running" } };
  }

  /** run_pentest_scan after its refusals: the row, then the launch, then the answer. */
  async function launch(account: string, body: Record<string, unknown>, engagement: HybridEngagement): Promise<{ status: number; body: unknown }> {
    const waitSeconds = typeof body.wait_seconds === "number" ? body.wait_seconds : null;
    const scan: HybridScan = {
      uuid: randomUUID(), user: account, engagement: engagement.id, target_url: String(body.url), consent: true, status: "pending",
      verdict: null, created_at: new Date().toISOString(), collected_at: null, engine_run_id: null, engine_response: null,
      error_message: null, recipient_email: typeof body.recipient_email === "string" ? body.recipient_email : null, email_sent: false,
      stop_requested_at: null, stop_delivered_at: null, stop_detail: null,
    };
    scans.set(scan.uuid, scan);
    const sent = await engine("POST", "/api/scan", {
      target: scan.target_url,
      engagement_ref: `athena-backend:engagement:${engagement.id}`,
      scope: [...engagement.scope_hosts],
      wait_seconds: waitSeconds === null ? inlineWait : Math.min(waitSeconds, inlineWait),
    }, scan.uuid);
    const failed = (error: string) => {
      scan.status = "failed";
      scan.verdict = null;
      scan.error_message = error;
      return { status: 502, body: { scan_id: scan.uuid, status: "failed", error, engine_run_id: scan.engine_run_id } };
    };
    if (!sent.ok) {
      // The engine could not be reached, or its answer was not read: the backend
      // records the scan failed in its own words (views.py: EngineError ->
      // mark_failed("Engine error: ...")), naming no run.
      return failed(`Engine error: ${sent.detail}`);
    }
    const payload = sent.body ?? {};
    scan.engine_run_id = runIdOf(payload.run_id);
    // A 200 is the run's end only when its `state` says so: completed is the
    // finished run; aborted or failed is a run that ended short of completed
    // inside the launch, recorded failed (the backend's existing behaviour); a
    // 200 that names a run still going is read as the engine's 202 is -- as
    // the dashboard's own reader always read it.
    if (sent.status === 200 && payload.state === "completed") {
      const result = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result) ? (payload.result as Record<string, unknown>) : payload;
      complete(scan, result);
      return { status: 200, body: { scan_id: scan.uuid, result } };
    }
    if (sent.status === 200 && (payload.state === "aborted" || payload.state === "failed")) {
      const said = payload.state === "aborted"
        ? `Scan aborted: Stopped on the engine: ${typeof payload.reason === "string" ? payload.reason : "stopped"}`
        : `Scan failed: ${typeof payload.error === "string" ? payload.error : "failed on the engine"}`;
      return failed(said);
    }
    if (sent.status === 202 || sent.status === 200) {
      if (!addressable(scan.engine_run_id)) {
        // The engine took the launch and named no run -- or one no route can
        // address as one segment: the backend's row is pending, recorded with
        // what the engine said, and nothing is read for it. Its 202 says so.
        return {
          status: 202,
          body: {
            scan_id: scan.uuid, status: "pending", engine_run_id: scan.engine_run_id,
            detail: "the engine accepted the launch without naming a run this backend can read; nothing is read or collected for it",
            status_url: `/api/pentest/scans/${scan.uuid}/`, collect_url: `/api/pentest/scans/${scan.uuid}/collect/`,
          },
        };
      }
      // wait_seconds: 0 is exactly one bounded read; a longer wait reads until the run ends or the wait is up.
      const deadline = Date.now() + (waitSeconds ?? collectSeconds) * 1000;
      for (;;) {
        const read = await collectOnce(scan);
        if (read.status === 200) {
          const detail = read.body as ReturnType<typeof detailOf>;
          if (detail.status === "completed") return { status: 200, body: { scan_id: scan.uuid, result: scan.engine_response } };
          // A run that ended short of completed inside the launch's own read is recorded failed (the existing behaviour).
          scan.status = "failed";
          return { status: 502, body: { scan_id: scan.uuid, status: "failed", error: `Scan aborted: ${scan.error_message}`, engine_run_id: scan.engine_run_id } };
        }
        if (read.status === 503) {
          scan.error_message = (read.body as { detail: string }).detail;
          return { status: 202, body: { scan_id: scan.uuid, status: "pending", engine_run_id: scan.engine_run_id, detail: "the run is on the engine; its record is collected when it ends", status_url: `/api/pentest/scans/${scan.uuid}/`, collect_url: `/api/pentest/scans/${scan.uuid}/collect/` } };
        }
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return {
        status: 202,
        body: {
          scan_id: scan.uuid, status: "pending", engine_run_id: scan.engine_run_id,
          detail: "the run is on the engine; its record is collected when it ends",
          status_url: `/api/pentest/scans/${scan.uuid}/`, collect_url: `/api/pentest/scans/${scan.uuid}/collect/`,
        },
      };
    }
    // Any other answer (a 4xx refusal, a 5xx, a 429): an EngineError at the
    // backend, recorded failed with the engine's words -- and with the run the
    // engine named, kept "whatever else went wrong" (views.py run_pentest_scan).
    const said = sent.body && typeof sent.body.detail === "string" ? sent.body.detail
      : sent.body && typeof sent.body.error === "string" ? sent.body.error : `the engine answered ${sent.status}`;
    return failed(`Engine error: ${said}`);
  }

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { raw += chunk; });
    req.on("end", () => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://stand-in");
        const method = req.method ?? "GET";
        const path = url.pathname;
        const header = (name: string): string | undefined => {
          const value = req.headers[name];
          return Array.isArray(value) ? value.join(", ") : value;
        };
        const presented = header("x-failsafe-service-token");
        const authorization = header("authorization");
        const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
        const body = parse(raw);
        const stopRoute = /^\/api\/pentest\/scans\/[^/]+\/stop\/$/.test(path) && method === "POST";
        const stop = stopRoute || judgeStop(method, path, raw, () => undefined);
        const entry: HybridSeen = {
          n: seen.length + 1, method, path, query: url.search, body: raw, json: body, account: null, by: null, stop,
          bearer, serviceToken: presented, idempotencyKey: header("idempotency-key") ?? null, status: 0, replayed: false,
        };
        // Recorded on arrival (status 0 until answered), so a test can wait for a
        // request the stand-in is holding; the entry is filled in as it is answered,
        // and the waiters are asked again then, so a wait for an answer's status is met.
        const notify = () => {
          const ready = waiters.filter((w) => w.match(entry));
          waiters = waiters.filter((w) => !w.match(entry));
          for (const w of ready) w.resolve(entry);
        };
        seen.push(entry);
        notify();
        const answeredWith = (status: number) => {
          entry.status = status;
          notify();
        };
        const answer = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
          answeredWith(status);
          res.writeHead(status, { "Content-Type": "application/json", ...headers });
          res.end(payload === undefined ? "" : JSON.stringify(payload));
        };
        /** Forward the request to the upstream control plane as it came, and relay its answer. */
        const forward = async (): Promise<{ status: number; json: Record<string, unknown> | null } | null> => {
          if (!opts.upstream) return null;
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(req.headers)) {
            if (["host", "connection", "content-length", "transfer-encoding"].includes(name) || value === undefined) continue;
            headers[name] = Array.isArray(value) ? value.join(", ") : value;
          }
          try {
            const upstream = await fetch(`${opts.upstream}${path}${url.search}`, {
              method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: raw }),
            });
            const text = await upstream.text();
            entry.status = upstream.status;
            // Relayed with the headers a caller reads: the key layer's replay mark and a refusal's Retry-After.
            const relayed: Record<string, string> = { "Content-Type": upstream.headers.get("content-type") ?? "application/json" };
            for (const name of ["idempotent-replayed", "retry-after"]) {
              const value = upstream.headers.get(name);
              if (value !== null) relayed[name] = value;
            }
            res.writeHead(upstream.status, relayed);
            res.end(text);
            return { status: upstream.status, json: parse(text) };
          } catch (cause) {
            answer(502, { detail: `the upstream control plane could not be reached: ${cause instanceof Error ? cause.message : String(cause)}` });
            return { status: 502, json: null };
          }
        };
        const assuranceList = opts.assurance === true && method === "GET"
          && (path === "/api/assurance/deployments/" || path === "/api/assurance/findings/");
        /** #189's retest-check routes on a finding: `retest-checks/` (the list) and `retest-checks/collect/`. */
        const retestCheckPath = opts.assurance === true ? /^\/api\/assurance\/findings\/([^/]+)\/retest-checks\/(collect\/)?$/.exec(path) : null;
        const servedHere = path.startsWith("/api/pentest/") || path === "/api/accounts/users/me/"
          || path === "/api/token/" || path === "/api/token/refresh/" || path === "/api/token/revoke/" || assuranceList || retestCheckPath !== null;
        if (!servedHere && opts.upstream) return void (await forward());

        if (path === "/api/token/" && method === "POST") {
          const username = typeof body?.username === "string" ? body.username : "";
          entry.account = username || null;
          const one = accounts.get(username);
          if (!one && opts.upstream) {
            // The upstream's account (the test's service account): its tokens are taken here as that account's.
            const relayed = await forward();
            const pair = relayed?.json;
            if (relayed?.status === 200 && pair && typeof pair.access === "string") {
              accounts.set(username, { password: "", role: serviceUserRole, active: true });
              access.set(pair.access, username);
              if (typeof pair.refresh === "string") refresh.set(pair.refresh, username);
            }
            return;
          }
          if (!one || one.active === false || one.password !== body?.password) {
            return answer(401, { detail: "No active account found with the given credentials" });
          }
          return answer(200, issue(username));
        }
        if (path === "/api/token/refresh/" && method === "POST") {
          const sent = typeof body?.refresh === "string" ? body.refresh : "";
          const account = refresh.get(sent) ?? null;
          entry.account = account;
          if (account === null && opts.upstream) {
            const relayed = await forward();
            const pair = relayed?.json;
            if (relayed?.status === 200 && pair && typeof pair.access === "string") {
              access.set(pair.access, serviceUser);
              if (typeof pair.refresh === "string") refresh.set(pair.refresh, serviceUser);
            }
            return;
          }
          if (account === null || blacklisted.has(sent)) return answer(401, { detail: "Token is blacklisted", code: "token_not_valid" });
          blacklisted.add(sent);
          return answer(200, issue(account));
        }
        if (path === "/api/token/revoke/" && method === "POST") {
          const sent = typeof body?.refresh === "string" ? body.refresh : "";
          entry.account = refresh.get(sent) ?? null;
          if (entry.account === null) return answer(401, { detail: "the refresh token does not verify: nothing was revoked", code: "token_not_valid" });
          blacklisted.add(sent);
          return answer(200, { revoked: true });
        }

        // Authentication, in the backend's order: the service token only on a stop, then a bearer.
        if (presented !== undefined && stop && opts.serviceToken && presented === opts.serviceToken) {
          entry.by = "service token";
          entry.account = serviceUser;
        } else if (bearer !== undefined && access.has(bearer) && accounts.get(access.get(bearer)!)?.active !== false) {
          entry.by = "bearer";
          entry.account = access.get(bearer)!;
        } else if (bearer !== undefined && opts.upstream && stop) {
          // A stop on the upstream's service account token (no service token configured): taken as the service user.
          entry.by = "bearer";
          entry.account = serviceUser;
        } else {
          return answer(401, { detail: "Authentication credentials were not provided." });
        }
        const who = entry.account!;
        const role = roleOf(who);
        const adminOrAnalyst = role === "admin" || role === "analyst";
        const forbidden = () => answer(403, { detail: "You do not have permission to perform this action." });

        if (path === "/api/accounts/users/me/" && method === "GET") {
          return answer(200, { id: Array.from(accounts.keys()).indexOf(who) + 1, username: who, email: `${who}@example.test`, role });
        }

        // ---- the assurance record's lists (opts.assurance) ----
        if (assuranceList) {
          if (controls.failNextAssurance !== null) {
            const fault = controls.failNextAssurance;
            controls.failNextAssurance = null;
            return answer(fault.status, fault.body);
          }
          const visible = deploymentsVisibleTo(who);
          if (path === "/api/assurance/deployments/") {
            const rows = visible.map(({ owner: _owner, ...one }) => one);
            return answer(200, pageOf(rows, path, url.searchParams));
          }
          const wanted = url.searchParams.get("deployment");
          const uuids = new Set(visible.map((one) => one.uuid));
          const rows = Array.from(findings.values())
            .filter((one) => uuids.has(one.deployment_uuid) && (wanted === null || one.deployment_uuid === wanted))
            // The serializer carries the latest RETEST_CHECKS_SERVED checks, newest first; the whole list is the retest-checks route.
            .map((one) => ({ ...one, retest_checks: one.retest_checks.slice(0, RETEST_CHECKS_SERVED) }));
          return answer(200, pageOf(rows, path, url.searchParams));
        }

        // ---- the retest-check routes (opts.assurance; athena-backend #189) ----
        if (retestCheckPath) {
          const uuid = retestCheckPath[1];
          const collect = retestCheckPath[2] === "collect/";
          // The permission classes run before the view: a viewer's collect is 403 before any lookup.
          if (collect && method === "POST" && !adminOrAnalyst) return forbidden();
          const visible = new Set(deploymentsVisibleTo(who).map((one) => one.uuid));
          const finding = findings.get(uuid);
          // get_object on the person's queryset: a finding they cannot see is "not found", as detail is.
          if (!finding || !visible.has(finding.deployment_uuid)) return answer(404, { detail: "No Finding matches the given query." });
          if (!collect && method === "GET") return answer(200, pageOf(finding.retest_checks, path, url.searchParams));
          if (!collect || method !== "POST") return answer(405, { detail: `Method "${method}" not allowed.` });
          if (controls.failNextRetestCheckCollect !== null) {
            const fault = controls.failNextRetestCheckCollect;
            controls.failNextRetestCheckCollect = null;
            return answer(fault.status, fault.body);
          }
          if (controls.holdRetestCheckCollects) {
            await new Promise<void>((release) => { heldRetestCheckCollects.push(release); held.push(res); });
            if (res.destroyed) return;
          }
          // The body: both run ids required, each a run id this backend names to the engine (the view's ValidationError shape).
          if (body === null) return answer(400, { body: "a JSON object naming run_id and twin_run_id" });
          const named: Record<string, string> = {};
          for (const field of ["run_id", "twin_run_id"]) {
            const value = body[field];
            if (typeof value !== "string" || value.trim() === "") return answer(400, { [field]: "required: the engine's run id, a non-empty string" });
            if (!RUN_ID.test(value)) {
              return answer(400, { [field]: "not a run id this backend names to the engine: letters, digits, '.', '_' and '-', at most 64 of them" });
            }
            named[field] = value;
          }
          const runId = named.run_id;
          const twinRunId = named.twin_run_id;
          const served = (row: HybridRetestCheck & { finding_uuid: string }): HybridRetestCheck => {
            const { finding_uuid: _own, ...fields } = row;
            return fields;
          };
          // The finding's closure standing, unchanged by any check: a check is not closure evidence.
          const closure = () => finding.closure ?? { standing: "not_closable", retest_required: finding.retest_required, reasons: ["no closure evidence recorded"], evidence: null };
          // 1. A run already recorded is answered with its row, and the engine is not read.
          const existing = retestChecks.get(runId);
          if (existing !== undefined) {
            if (existing.finding_uuid !== uuid) {
              return answer(409, { detail: `run ${runId} is already recorded as a retest check of another finding; nothing was written`, run_id: runId, recorded: false });
            }
            return answer(200, { check: served(existing), recorded: false, closure: closure() });
          }
          // 2. ONE bounded engine read, before anything is written. Its 404 is a 404 here (a tenant-bound key reads another tenant's run as no such run).
          const unreadable = (what: string, kind: string, extra: Record<string, unknown>) => answer(503, {
            detail: `Not recorded: the engine could not be read about ${what} (${kind}). Nothing was written; collect it again once the engine can be read.`,
            ...extra, recorded: false, engine: kind,
          });
          if (controls.engineUnreachable) return unreadable(`retest run ${runId}`, "unreachable", { run_id: runId });
          const read = await engine("GET", `/api/scans/${runSegment(runId)}`);
          if (!read.ok) return unreadable(`retest run ${runId}`, "unreachable", { run_id: runId });
          if (read.status === 404) return answer(404, { detail: `the engine has no run ${runId} this backend can read`, run_id: runId, recorded: false });
          if (read.status !== 200) return unreadable(`retest run ${runId}`, "refused", { run_id: runId });
          const payload = read.body ?? {};
          const state = typeof payload.state === "string" ? payload.state : "unknown";
          const result = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result) ? (payload.result as Record<string, unknown>) : {};
          const verdict = typeof result.verdict === "string" ? result.verdict : null;
          const check = result.check && typeof result.check === "object" && !Array.isArray(result.check) ? (result.check as Record<string, unknown>) : null;
          // 3. read_retest_run's phases: a run still going is 202; one that ended without a verdict is its honest phase, nothing written.
          const notAVerdict = (phase: string, status: number) => answer(status, {
            phase, state, run_id: runId, recorded: false,
            detail: phase === "running"
              ? "the run is still going on the engine: nothing was recorded; collect it once it has ended"
              : PHASE_DETAIL[phase] ?? "the run produced no verdict this backend reads: nothing was recorded",
          });
          if (payload.done !== true || state === "queued" || state === "running" || state === "aborting") return notAVerdict("running", 202);
          if (state === "failed") return notAVerdict("failed", 200);
          if (state === "aborted" && !(verdict !== null && check !== null)) return notAVerdict("stopped", 200);
          if (verdict === null) return notAVerdict("ended_without_verdict", 200);
          // 4. Identity. Every check passes, or nothing is written.
          const scan = Array.from(scans.values()).find((one) => one.engine_run_id !== null && String(one.engine_run_id) === twinRunId);
          if (!scan) {
            return answer(404, {
              detail: "that scan is not in this record: no scan of this backend ran under that engine run, so its retest cannot be recorded here",
              twin_run_id: twinRunId, recorded: false,
            });
          }
          // The scan's deployment: the one its engagement's ingest keyed (existing_deployment_for_scan), found and never created here.
          const scanDeployment = Array.from(deployments.values()).find((one) => one.engagement_id === scan.engagement);
          if (!scanDeployment) {
            return answer(422, {
              detail: "that scan's deployment is not in this record: its run was never ingested here, so no finding of it can have been retested",
              twin_run_id: twinRunId, recorded: false,
            });
          }
          if (scanDeployment.uuid !== finding.deployment_uuid) {
            return answer(422, { detail: "the twin's scan belongs to another deployment than this finding's; nothing was written", twin_run_id: twinRunId, recorded: false });
          }
          const findingType = typeof result.finding_type === "string" && result.finding_type !== "" ? result.finding_type : null;
          if (findingType === null) return answer(422, { detail: "the engine's verdict names no finding type; nothing was written", recorded: false });
          if (findingType !== finding.finding_type) {
            return answer(422, {
              detail: `the verdict is of type '${findingType}'; this finding is of type '${finding.finding_type}'; nothing was written`,
              finding_type: findingType, recorded: false,
            });
          }
          const candidates = Array.from(findings.values()).filter((one) => one.deployment_uuid === scanDeployment.uuid && one.finding_type === findingType).map((one) => one.uuid);
          if (candidates.length > 1) {
            return answer(409, {
              detail: `${candidates.length} findings of type '${findingType}' are in that deployment, so the run's twin cannot be told to one of them; nothing was written`,
              finding_type: findingType, candidates, recorded: false,
            });
          }
          if (candidates[0] !== uuid) return answer(409, { detail: "the run's twin is a finding other than this one; nothing was written", recorded: false });
          const verdictHost = typeof result.target === "string" ? hostOf(result.target) : "";
          const scanHost = hostOf(scan.target_url);
          if (verdictHost === "" || verdictHost !== scanHost) {
            return answer(422, { detail: `the verdict's target host '${verdictHost || "(none)"}' is not the scan's ('${scanHost}'); nothing was written`, recorded: false });
          }
          const twinId = typeof result.twin_id === "number" && Number.isSafeInteger(result.twin_id) ? result.twin_id : null;
          if (twinId === null) return answer(422, { detail: "the engine's verdict names no twin; nothing was written", recorded: false });
          // The strong check: one more bounded read -- the engine lists the twin under the scan run with the verdict's type.
          const twins = await engine("GET", `/api/decisions?run_id=${encodeURIComponent(twinRunId)}&finding_type=${encodeURIComponent(findingType)}`);
          if (!twins.ok || twins.status !== 200) return unreadable(`the twins of scan run ${twinRunId}`, twins.ok ? "refused" : "unreachable", { twin_run_id: twinRunId });
          const decisions = Array.isArray(twins.body?.decisions) ? (twins.body!.decisions as unknown[]) : [];
          const listed = decisions.some((one) => !!one && typeof one === "object"
            && (one as { id?: unknown }).id === twinId && (one as { finding_type?: unknown }).finding_type === findingType);
          if (!listed) {
            return answer(422, { detail: `the engine lists no twin ${twinId} of type '${findingType}' under scan run ${twinRunId}; nothing was written`, twin_run_id: twinRunId, recorded: false });
          }
          // 5. One row, UNIQUE on the run id, this table only: the finding's status, closure and everything else stay as they were.
          const checkedAt = check !== null && typeof check.checked_at === "string" ? check.checked_at : null;
          const row: HybridRetestCheck & { finding_uuid: string } = {
            finding_uuid: uuid,
            engine_run_id: runId,
            scan_record_id: result.scan_record_id === null || result.scan_record_id === undefined ? null : String(result.scan_record_id).slice(0, 64),
            twin_id: twinId,
            twin_run_id: twinRunId,
            verdict: verdict.slice(0, 32),
            verdict_known: KNOWN_VERDICTS.includes(verdict),
            detail: (typeof result.detail === "string" ? result.detail : "").slice(0, 1000),
            state: state === "aborted" ? "aborted" : "completed",
            stopped_after_recording: state === "aborted",
            engine_checked_at: checkedAt,
            collected_at: new Date().toISOString(),
            collected_by: who,
          };
          retestChecks.set(runId, row);
          finding.retest_checks.unshift(served(row));
          return answer(201, { check: served(row), recorded: true, closure: closure() });
        }

        // ---- engagements ----
        if (path === "/api/pentest/engagements/") {
          if (!adminOrAnalyst) return forbidden();
          if (method === "GET") return answer(200, engagementsVisibleTo(who).map(engagementOf));
          if (method === "POST") {
            if (body === null) return answer(400, { detail: "the body must be a JSON object" });
            const hosts = body.scope_hosts === undefined ? [] : body.scope_hosts;
            if (!Array.isArray(hosts) || hosts.some((one) => typeof one !== "string" || one === "")) {
              return answer(400, { scope_hosts: ["Expected a list of items but got a scalar, or a blank entry."] });
            }
            if (typeof body.name !== "string" || body.name === "") return answer(400, { name: ["This field is required."] });
            nextEngagement += 1;
            const now = new Date().toISOString();
            const made: HybridEngagement = {
              id: nextEngagement, name: body.name, client_name: typeof body.client_name === "string" ? body.client_name : null,
              scope_summary: typeof body.scope_summary === "string" ? body.scope_summary : null,
              status: typeof body.status === "string" ? body.status : "planned",
              testing_window_start: typeof body.testing_window_start === "string" ? body.testing_window_start : null,
              testing_window_end: typeof body.testing_window_end === "string" ? body.testing_window_end : null,
              created_by: who, created_at: now, updated_at: now, scope_hosts: hosts as string[],
            };
            engagements.set(made.id, made);
            return answer(201, engagementOf(made));
          }
          return answer(405, { detail: `Method "${method}" not allowed.` });
        }
        const engagementPath = /^\/api\/pentest\/engagements\/(\d+)\/$/.exec(path);
        if (engagementPath) {
          if (!adminOrAnalyst) return forbidden();
          const found = engagementsVisibleTo(who).find((one) => one.id === Number(engagementPath[1]));
          if (!found) return answer(404, { detail: "Engagement not found." });
          if (method === "GET") return answer(200, engagementOf(found));
          if (method === "PATCH") {
            if (body === null) return answer(400, { detail: "the body must be a JSON object" });
            if (body.scope_hosts !== undefined && (!Array.isArray(body.scope_hosts) || body.scope_hosts.some((one) => typeof one !== "string" || one === ""))) {
              return answer(400, { scope_hosts: ["Expected a list of items but got a scalar, or a blank entry."] });
            }
            for (const field of ["name", "client_name", "scope_summary", "status", "testing_window_start", "testing_window_end", "scope_hosts"] as const) {
              if (body[field] !== undefined) (found as unknown as Record<string, unknown>)[field] = body[field];
            }
            found.updated_at = new Date().toISOString();
            return answer(200, engagementOf(found));
          }
          if (method === "DELETE") {
            engagements.delete(found.id);
            return answer(204, undefined);
          }
          return answer(405, { detail: `Method "${method}" not allowed.` });
        }

        // ---- the launch ----
        if (path === "/api/pentest/scan/" && method === "POST") {
          if (!adminOrAnalyst) return forbidden();
          if (body === null) return answer(400, { error: "The request body must be a JSON object." });
          const key = entry.idempotencyKey;
          const keyedAs = key === null ? null : `${who}\u0000pentest:run_pentest_scan\u0000${key}`;
          if (keyedAs !== null) {
            const earlier = keyed.get(keyedAs);
            if (earlier) {
              if (earlier.request !== raw) return answer(422, { detail: "Idempotency-Key reused for a different request", idempotency: { state: "done" } });
              if (earlier.answer === null) return answer(409, { detail: "the first request with this Idempotency-Key has not been answered yet", idempotency: { state: "in_flight" } });
              entry.replayed = true;
              return answer(earlier.answer.status, earlier.answer.body, { "Idempotent-Replayed": "true" });
            }
            keyed.set(keyedAs, { request: raw, answer: null });
          }
          const record = (status: number, payload: unknown) => {
            if (keyedAs !== null) keyed.set(keyedAs, { request: raw, answer: { status, body: payload } });
            return answer(status, payload);
          };
          if (controls.failNextLaunch !== null) {
            const fault = controls.failNextLaunch;
            controls.failNextLaunch = null;
            return record(fault.status, fault.body);
          }
          const recipient = body.recipient_email;
          if (recipient !== undefined && recipient !== null && (typeof recipient !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient))) {
            return record(400, { error: "recipient_email is not a valid e-mail address." });
          }
          if (typeof body.url !== "string" || !/^https?:\/\//.test(body.url)) {
            return record(400, { error: "A valid target URL is required (http:// or https://)." });
          }
          if (!["true", "1", "yes"].includes(String(body.consent ?? false).trim().toLowerCase())) {
            return record(400, { error: "User consent required. Include 'consent': true." });
          }
          if (body.wait_seconds !== undefined && (typeof body.wait_seconds !== "number" || !Number.isFinite(body.wait_seconds) || body.wait_seconds < 0 || body.wait_seconds > collectSeconds)) {
            return record(400, { error: `wait_seconds must be a number from 0 to ${collectSeconds}.` });
          }
          // authorise_target, in the backend's words.
          const engagementId = body.engagement_id;
          if (engagementId === undefined || engagementId === null || engagementId === "") {
            return record(403, { error: "engagement_id is required. A scan runs under a recorded engagement that names the authorised scope and testing window." });
          }
          const engagement = engagementsVisibleTo(who).find((one) => String(one.id) === String(engagementId));
          if (!engagement) return record(403, { error: "No such engagement." });
          if (engagement.status !== "running") {
            return record(403, { error: `Engagement '${engagement.name}' is ${engagement.status}, so testing is not authorised. Set it to running first.` });
          }
          const start = engagement.testing_window_start === null ? NaN : Date.parse(engagement.testing_window_start);
          const end = engagement.testing_window_end === null ? NaN : Date.parse(engagement.testing_window_end);
          const now = Date.now();
          if (Number.isNaN(start) || Number.isNaN(end) || !(start <= now && now <= end)) {
            return record(403, { error: `Engagement '${engagement.name}' is outside its authorised testing window.` });
          }
          const host = hostOf(body.url);
          if (!covers(engagement.scope_hosts, host)) {
            return record(403, { error: `${host || "that host"} is not in the authorised scope for '${engagement.name}'.` });
          }
          if (controls.preflightRefusal !== null) {
            return record(409, { error: `This engine is not the deployment that was approved: ${controls.preflightRefusal}`, assurance: { verdict: "refused" } });
          }
          if (controls.holdLaunches) {
            // Held past the dashboard's deadline, the launch still goes ahead once released, as the backend's does
            // for a caller that has gone: the engine is asked, the row records, and the key's answer is kept for a replay.
            await new Promise<void>((release) => { heldLaunches.push(release); held.push(res); });
          }
          const answered = await launch(who, body, engagement);
          if (controls.answerDelayMs > 0) await new Promise((r) => setTimeout(r, controls.answerDelayMs));
          if (res.destroyed) {
            // The dashboard gave up waiting: the answer is recorded for a replay all the same, and noted as answered.
            if (keyedAs !== null) keyed.set(keyedAs, { request: raw, answer: { status: answered.status, body: answered.body } });
            answeredWith(answered.status);
            return;
          }
          return record(answered.status, answered.body);
        }

        // ---- the scans ----
        if (path === "/api/pentest/scans/" && method === "GET") {
          if (controls.failNextScansList !== null) {
            const fault = controls.failNextScansList;
            controls.failNextScansList = null;
            return answer(fault.status, fault.body);
          }
          if (controls.holdScansLists) {
            await new Promise<void>((release) => { heldScansLists.push(release); held.push(res); });
            if (res.destroyed) return;
          }
          const rows = scansVisibleTo(who).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(listRowOf);
          return answer(200, pageOf(rows, path, url.searchParams));
        }
        const scanPath = /^\/api\/pentest\/scans\/([^/]+)\/(collect\/|stop\/|pdf\/|status\/)?$/.exec(path);
        if (scanPath) {
          // The permission classes run before the view: a viewer's collect is 403 before any lookup.
          if (scanPath[2] === "collect/" && method === "POST" && !adminOrAnalyst) return forbidden();
          const scan = scansVisibleTo(who).find((one) => one.uuid === scanPath[1]);
          if (!scan) return answer(404, { error: "Scan not found" });
          const leaf = scanPath[2];
          if (leaf === undefined && method === "GET") {
            if (controls.failNextScanDetail !== null) {
              const fault = controls.failNextScanDetail;
              controls.failNextScanDetail = null;
              return answer(fault.status, fault.body);
            }
            return answer(200, detailOf(scan));
          }
          if (leaf === "status/") return answer(501, { detail: "Not implemented." });
          if (leaf === "stop/" && method === "POST") {
            if (controls.holdStops) {
              await new Promise<void>((release) => { heldStops.push(release); held.push(res); });
              if (res.destroyed) return;
            }
            const queued = controls.stopAnswers.shift();
            if (queued) return answer(queued.status, queued.body);
            const at = new Date().toISOString();
            scan.stop_requested_at = at;
            if (controls.stopAbortsEngine && scan.engine_run_id !== null) {
              const sent = await engine("POST", `/api/scans/${runSegment(scan.engine_run_id)}/abort`);
              scan.stop_delivered_at = sent.ok ? at : null;
              scan.stop_detail = sent.ok ? `the engine answered ${sent.status}` : `owed: ${sent.detail}`;
            } else if (scan.engine_run_id !== null) {
              scan.stop_delivered_at = at;
              scan.stop_detail = "the engine answered that the run had already ended";
            } else {
              scan.stop_detail = "Owed, not delivered: the scan names no run yet.";
            }
            return answer(scan.stop_delivered_at !== null ? 200 : 202, {
              scan_id: scan.uuid, status: scan.status, engine_run_id: scan.engine_run_id, stop: stopReadingOf(scan), stop_saved: true,
            });
          }
          if (leaf === "pdf/" && method === "GET") {
            if (scan.status !== "completed") {
              return answer(409, { error: `This scan is ${scan.status}, so there is no report to render.`, detail: scan.error_message });
            }
            answeredWith(200);
            res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="pentest_${scan.uuid}.pdf"` });
            res.end(`%PDF-1.4 stand-in report for ${scan.uuid}`);
            return;
          }
          if (leaf === "collect/" && method === "POST") {
            if (!adminOrAnalyst) return forbidden();
            if (controls.failNextCollect !== null) {
              const fault = controls.failNextCollect;
              controls.failNextCollect = null;
              return answer(fault.status, fault.body);
            }
            if (controls.holdCollects) {
              await new Promise<void>((release) => { heldCollects.push(release); held.push(res); });
              if (res.destroyed) return;
            }
            // The claim: a scan no longer pending -- collected by another collector while this one was held -- is 409,
            // and so is one another collector is reading the engine for this moment (the row is claimed).
            if (scan.status !== "pending" || scan.engine_run_id === null) {
              return answer(409, { detail: `the scan is ${scan.status}${scan.engine_run_id === null ? " and names no run" : ""}, so there is nothing to collect`, status: scan.status });
            }
            if (collecting.has(scan.uuid)) return answer(409, { detail: "the scan is being collected already", status: scan.status });
            collecting.add(scan.uuid);
            try {
              const collected = await collectOnce(scan);
              return answer(collected.status, collected.body);
            } finally {
              collecting.delete(scan.uuid);
            }
          }
          return answer(405, { detail: `Method "${method}" not allowed.` });
        }
        return answer(404, { detail: "Not found." });
      })();
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    controls,
    /** Every call this stand-in made to the engine stub, in order. */
    engineCalls,
    /** The engagements it holds, by id. */
    engagements,
    /** The scans it holds, by uuid. */
    scans,
    /** The assurance record's deployments and findings it holds (served when opts.assurance is set). */
    deployments,
    findings,
    /** Every retest check recorded (#189), by the engine run id it is unique on, each naming the finding it was recorded against. */
    retestChecks,
    /** A deployment in the assurance record, as the backend's ingest would have made one under an engagement. */
    addDeployment(input: Partial<HybridDeployment> & { uuid: string; name: string }): HybridDeployment {
      const now = new Date().toISOString();
      const made: HybridDeployment = {
        environment: "production", decision: null, decision_label: "Not assessed", description: "", finding_count: 0,
        engagement_id: null, created_at: now, updated_at: now, owner: "admin", ...input,
      };
      deployments.set(made.uuid, made);
      return made;
    },
    /** A finding in the assurance record, ingested from a scan (scan_uuid, engine_run_id) or filed another way (null). */
    addFinding(input: Partial<HybridFinding> & { uuid: string; deployment_uuid: string }): HybridFinding {
      const made: HybridFinding = {
        finding_type: "prompt_injection", title: "a finding", severity: "medium", confidence: null, status: "open", status_label: "Open",
        status_must_not_imply: null, owner: null, impact: "", business_impact: "", recommendation: "", location: "", retest_required: false,
        evidence_class: "technically_verified", evidence: [], asset_uuid: null, asset_name: null, change_status: "new", change_label: "New",
        age_days: null, stale: false, receipt: { algorithm: "sha256", digest: "0".repeat(64), evidence_count: 0 }, first_seen: null, last_seen: null,
        assignee: null, remediation_state: "open", closure: null, scan_uuid: null, engine_run_id: null, retest_checks: [], ...input,
      };
      findings.set(made.uuid, made);
      const deployment = deployments.get(made.deployment_uuid);
      if (deployment) deployment.finding_count = Array.from(findings.values()).filter((one) => one.deployment_uuid === deployment.uuid).length;
      return made;
    },
    /** An engagement made directly, as the Django admin would make one: visible to its creator and to admins. */
    addEngagement(input: Partial<HybridEngagement> & { name: string; scope_hosts: string[] }): HybridEngagement {
      nextEngagement += 1;
      const now = new Date().toISOString();
      const made: HybridEngagement = {
        id: nextEngagement, client_name: null, scope_summary: null, status: "running",
        testing_window_start: new Date(Date.now() - 60_000).toISOString(), testing_window_end: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        created_by: "admin", created_at: now, updated_at: now, ...input,
      };
      engagements.set(made.id, made);
      return made;
    },
    /** The role of an account from now on. */
    setRole(account: string, role: HybridRole): void {
      const one = accounts.get(account);
      if (one) one.role = role;
    },
    /** Hold every launch's answer until releaseLaunches(). */
    holdLaunches(): void { controls.holdLaunches = true; },
    releaseLaunches(): void {
      controls.holdLaunches = false;
      heldLaunches.splice(0).forEach((release) => release());
    },
    holdCollects(): void { controls.holdCollects = true; },
    releaseCollects(): void {
      controls.holdCollects = false;
      heldCollects.splice(0).forEach((release) => release());
    },
    holdStops(): void { controls.holdStops = true; },
    releaseStops(): void {
      controls.holdStops = false;
      heldStops.splice(0).forEach((release) => release());
    },
    /** Hold every scans list read's answer until releaseScansLists(). */
    holdScansLists(): void { controls.holdScansLists = true; },
    releaseScansLists(): void {
      controls.holdScansLists = false;
      heldScansLists.splice(0).forEach((release) => release());
    },
    /** Hold every retest-check collect's answer until releaseRetestCheckCollects(): a collect in flight that no stop waits on. */
    holdRetestCheckCollects(): void { controls.holdRetestCheckCollects = true; },
    releaseRetestCheckCollects(): void {
      controls.holdRetestCheckCollects = false;
      heldRetestCheckCollects.splice(0).forEach((release) => release());
    },
    /** Requests of one kind seen so far. */
    launches: () => seen.filter((one) => one.method === "POST" && one.path === "/api/pentest/scan/"),
    /** The scan collects (`/api/pentest/scans/<uuid>/collect/`); a retest-check collect is another route (retestCheckCollects). */
    collects: () => seen.filter((one) => one.method === "POST" && one.path.startsWith("/api/pentest/scans/") && one.path.endsWith("/collect/")),
    retestCheckCollects: () => seen.filter((one) => one.method === "POST" && /^\/api\/assurance\/findings\/[^/]+\/retest-checks\/collect\/$/.test(one.path)),
    stops: () => seen.filter((one) => one.method === "POST" && one.path.endsWith("/stop/")),
    deletes: () => seen.filter((one) => one.method === "DELETE"),
    /** The first request, arrived or yet to arrive, that matches. */
    waitFor(match: (one: HybridSeen) => boolean): Promise<HybridSeen> {
      const already = seen.find(match);
      if (already) return Promise.resolve(already);
      return new Promise<HybridSeen>((resolve) => { waiters.push({ match, resolve }); });
    },
    close: async () => {
      waiters = [];
      heldLaunches.splice(0).forEach((release) => release());
      heldCollects.splice(0).forEach((release) => release());
      heldStops.splice(0).forEach((release) => release());
      heldScansLists.splice(0).forEach((release) => release());
      heldRetestCheckCollects.splice(0).forEach((release) => release());
      for (const res of held) res.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export type HybridBackendStandIn = Awaited<ReturnType<typeof hybridBackendStandIn>>;
