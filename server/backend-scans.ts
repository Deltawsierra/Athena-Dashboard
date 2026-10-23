/**
 * The dashboard's typed client for Athena-Backend's pentest routes: the
 * governance gate and the record of every scan a person starts here (the
 * Option 1 hybrid).
 *
 * Who each call goes as (server/control-plane.ts, T6):
 *
 *   - the person's role, the engagements, a launch, a scan's record, its
 *     collect and its PDF go as the SIGNED-IN PERSON, with their own backend
 *     sign-in, so the backend's visibility and role checks apply to them and
 *     the backend attributes the launch to them;
 *   - the STOP MIRROR (`mirrorStop`) goes as every other stop does: it presents
 *     the failsafe service token and waits on no sign-in (`stop: true`), and
 *     only when that attempt fails is it sent once more as the person. It is
 *     never on a stop's path: the routes send it AFTER the engine's abort has
 *     been answered, and never await it (decision 6);
 *   - withdrawing an engagement's authority (`withdrawEngagement`) is a stop by
 *     the backend's own judgement (safety/stops.py: an engagement moved off
 *     running), so it presents the service token too.
 *
 * Every call is bounded: the control plane's TIMEOUT_MS, except a launch,
 * which may take `launchTimeouts.launchMs` -- the backend resolves the target,
 * runs its preflight against the engine and sends the launch inside that one
 * call. A launch is not a stop path.
 *
 * Every answer is read by its own field, never guessed from a shape
 * (shared/idempotency.ts, the PR-A contract): a 202 is `status: "pending"`
 * naming the run, and is never "done"; a 200 carries the finished run under
 * `result`; a 502 is the engine's refusal relayed, `status: "failed"`; a 4xx
 * is the backend's refusal, quoted verbatim -- its `detail` or its `error`,
 * whichever it sent. A 409 or 422 that speaks of the Idempotency-Key is about
 * the key, never "the backend refused this scan". A launch that was sent and
 * not answered -- a timeout, a connection cut, a 5xx with no shape this reads
 * -- MAY have started a run: it is said so (BackendLaunchUnanswered), never
 * "refused", and the caller adopts the row from the backend's list.
 *
 * No `ATHENA_*` secret, token or address is read here: the control plane
 * client holds the address and every credential.
 */

import {
  call, body, ControlPlaneRefused, ControlPlaneSignInRequired, ControlPlaneUnanswered, ControlPlaneUnavailable,
} from "./control-plane";
import { IDEMPOTENCY_HEADER, REPLAYED_HEADER, keyRecordOf } from "@shared/idempotency";
import { runIdFrom, stopIdFrom } from "@shared/engine-record";
import { coverageOf } from "@shared/scan-coverage";
import type { RetestCheckView } from "@shared/backend-record";

/** How long a launch may take, headers and body. Tests shorten it. Not a stop path. */
export const launchTimeouts = { launchMs: 25_000 };

/** The most of an answer body read as text (a refusal, a record) that is quoted or parsed. */
const MAX_BODY = 4 * 1024 * 1024;

/** The backend's role words (athena-backend accounts/models.py CustomUser.Roles). */
export const BACKEND_ROLES = ["admin", "analyst", "viewer"] as const;

function causeOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** The answer's body, as text, bounded; "" when it cannot be read. */
async function textWithin(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
  } catch {
    return "";
  }
}

/** The answer's body as a JSON object, or null when it is not one. */
async function jsonObject(response: Response): Promise<{ object: Record<string, unknown> | null; text: string }> {
  const text = await textWithin(response);
  try {
    return { object: objectOf(JSON.parse(text) as unknown), text };
  } catch {
    return { object: null, text };
  }
}

/**
 * The backend's own words for a refusal: its `detail` (DRF's and the
 * engagement routes'), else its `error` (the pentest launch and scan routes'),
 * else the body's first bytes. Quoted verbatim: the refusal is the governance
 * answer, and this never re-words it.
 */
export function refusalWords(object: Record<string, unknown> | null, text: string): string {
  const said = object === null ? null : textOf(object.detail) ?? textOf(object.error);
  if (said !== null) return said;
  const quoted = text.trim().slice(0, 500);
  return quoted === "" ? "(no detail given)" : quoted;
}

/** A refusal the backend answered with its own words: passed on with its status. */
export class BackendRefused extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * A launch that was sent and whose outcome is not known: no answer came, or an
 * answer this client does not read -- a 5xx, a 202 or 200 in no shape it
 * knows -- or the backend's own word that the first send with this key has no
 * answer recorded (`state`). The backend creates the scan's row before it
 * launches, so a run MAY have been started: never "refused", never "did not
 * start". The caller re-reads the backend's list to adopt the row.
 */
export class BackendLaunchUnanswered extends ControlPlaneUnavailable {
  constructor(message: string, readonly state: string | null = null, readonly status: number | null = null) {
    super(message);
  }
}

/** The backend refused the launch's Idempotency-Key itself (422 for another request under the same key): a bug here, and nothing was started by it. */
export class BackendKeyRefused extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// ==== The person ====

export interface BackendPerson {
  id: number | string | null;
  username: string | null;
  email: string | null;
  /** The backend's role word (admin | analyst | viewer), or null when it served none this client reads. */
  role: string | null;
}

/**
 * Who the backend says the signed-in person is, and their role there
 * (`GET /api/accounts/users/me/`, athena-backend accounts/views.py `me`).
 * This is what grounds the admin-only launcher (decision 3).
 */
export async function whoAmI(): Promise<BackendPerson> {
  const response = await call("/api/accounts/users/me/");
  if (!response.ok) throw await refused(response, "the person's own account");
  const { object } = await jsonObject(response);
  if (object === null) throw new ControlPlaneUnavailable("Athena-Backend answered the account read with something that is not a record");
  const role = textOf(object.role);
  return {
    id: typeof object.id === "number" || typeof object.id === "string" ? object.id : null,
    username: textOf(object.username),
    email: textOf(object.email),
    role: role !== null && (BACKEND_ROLES as readonly string[]).includes(role) ? role : role,
  };
}

/** A refusal of a read or a write that is not a launch, in the control plane's terms (as server/assurance.ts reads one). */
async function refused(response: Response, what: string): Promise<ControlPlaneUnavailable> {
  const { object, text } = await jsonObject(response);
  const words = refusalWords(object, text);
  const message = `Athena-Backend answered ${response.status} to ${what}: ${words}`;
  if (response.status === 403 || response.status === 404) return new ControlPlaneRefused(message, response.status);
  if (response.status === 401) {
    return new ControlPlaneSignInRequired(`${message} (Athena-Backend no longer takes your sign-in: sign in to it again)`);
  }
  return new BackendRefused(message, response.status);
}

// ==== Engagements ====

export interface BackendEngagement {
  id: number;
  name: string;
  clientName: string | null;
  scopeSummary: string | null;
  status: string;
  testingWindowStart: string | null;
  testingWindowEnd: string | null;
  scopeHosts: string[];
  createdBy: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

/** An engagement as the backend serves it (pentest/serializers.py EngagementSerializer). */
export function readEngagement(raw: unknown): BackendEngagement | null {
  const object = objectOf(raw);
  const id = numberOf(object?.id);
  if (object === null || id === null) return null;
  return {
    id,
    name: textOf(object.name) ?? "",
    clientName: textOf(object.client_name),
    scopeSummary: textOf(object.scope_summary),
    status: textOf(object.status) ?? "",
    testingWindowStart: textOf(object.testing_window_start),
    testingWindowEnd: textOf(object.testing_window_end),
    scopeHosts: Array.isArray(object.scope_hosts) ? object.scope_hosts.filter((one): one is string => typeof one === "string") : [],
    createdBy: object.created_by ?? null,
    createdAt: textOf(object.created_at),
    updatedAt: textOf(object.updated_at),
  };
}

export async function listEngagements(): Promise<BackendEngagement[]> {
  const response = await call("/api/pentest/engagements/");
  if (!response.ok) throw await refused(response, "the engagements list");
  const text = await textWithin(response);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = null;
  }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(objectOf(parsed)?.results) ? (objectOf(parsed)!.results as unknown[]) : null;
  if (rows === null) throw new ControlPlaneUnavailable("Athena-Backend answered the engagements list with something that is not a list");
  return rows.map(readEngagement).filter((one): one is BackendEngagement => one !== null);
}

/** One engagement, as the person: a 404 is the backend saying it is not theirs to see, or gone (ControlPlaneRefused). */
export async function getEngagement(id: number): Promise<BackendEngagement> {
  const response = await call(`/api/pentest/engagements/${encodeURIComponent(String(id))}/`);
  if (!response.ok) throw await refused(response, `engagement #${id}`);
  const { object } = await jsonObject(response);
  const engagement = readEngagement(object);
  if (engagement === null) throw new ControlPlaneUnavailable(`Athena-Backend answered the read of engagement #${id} with something that is not an engagement`);
  return engagement;
}

export interface NewEngagement {
  name: string;
  clientName: string;
  scopeHosts: string[];
  /** Both dates: an engagement with no window has no authorised period (athena-backend Engagement.window_is_open). */
  testingWindowStart: Date;
  testingWindowEnd: Date;
}

/** Create the client's engagement as the person, `running` from the start (decision 2). */
export async function createEngagement(input: NewEngagement): Promise<BackendEngagement> {
  const response = await call("/api/pentest/engagements/", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      client_name: input.clientName,
      scope_hosts: input.scopeHosts,
      status: "running",
      testing_window_start: input.testingWindowStart.toISOString(),
      testing_window_end: input.testingWindowEnd.toISOString(),
    }),
  });
  if (!response.ok) throw await refused(response, "creating the client's engagement");
  const { object } = await jsonObject(response);
  const engagement = readEngagement(object);
  if (engagement === null) throw new ControlPlaneUnavailable("Athena-Backend answered the engagement's creation with something that is not an engagement");
  return engagement;
}

/**
 * Widen an engagement's scope, or move its window, as the person. Never a
 * narrowing and never a status: a PATCH that withdraws authority is a stop by
 * the backend's judgement and goes through `withdrawEngagement`. A caller that
 * passes fewer hosts than the engagement holds is refused here, before anything
 * is sent.
 */
export async function patchEngagement(
  engagement: BackendEngagement,
  patch: { scopeHosts?: string[]; testingWindowStart?: Date; testingWindowEnd?: Date },
): Promise<BackendEngagement> {
  const fields: Record<string, unknown> = {};
  if (patch.scopeHosts !== undefined) {
    const narrowed = engagement.scopeHosts.filter((host) => !patch.scopeHosts!.includes(host));
    if (narrowed.length > 0) {
      throw new Error(`refusing to narrow engagement #${engagement.id}'s scope (${narrowed.join(", ")} would be withdrawn): narrowing is a person's act`);
    }
    fields.scope_hosts = patch.scopeHosts;
  }
  if (patch.testingWindowStart !== undefined) fields.testing_window_start = patch.testingWindowStart.toISOString();
  if (patch.testingWindowEnd !== undefined) fields.testing_window_end = patch.testingWindowEnd.toISOString();
  if (Object.keys(fields).length === 0) return engagement;
  const response = await call(`/api/pentest/engagements/${encodeURIComponent(String(engagement.id))}/`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
  if (!response.ok) throw await refused(response, `changing engagement #${engagement.id}`);
  const { object } = await jsonObject(response);
  return readEngagement(object) ?? engagement;
}

/**
 * Withdraw an engagement's authority -- move it off `running` -- which the
 * backend judges a stop (safety/stops.py), so it goes as every stop does: with
 * the failsafe service token, waiting on no sign-in. Never a DELETE: the
 * record of what was authorised is kept. Never throws: what came of it is
 * answered, for the log.
 */
export async function withdrawEngagement(id: number, status: "completed" | "paused" | "cancelled" = "completed"): Promise<MirrorOutcome> {
  return sentAsStopThenPerson(
    `/api/pentest/engagements/${encodeURIComponent(String(id))}/`,
    { method: "PATCH", body: JSON.stringify({ status }) },
    `withdrawing engagement #${id}`,
  );
}

// ==== Launch ====

export interface LaunchInput {
  url: string;
  engagementId: number;
  /** The person's consent, affirmed on the page (decision 10): the backend refuses without it. */
  consent: true;
  /** Only when the person opted in to the e-mail; never defaulted (decision 10). */
  recipientEmail?: string | null;
  /** The press's key, as the route passed it on (server/idempotency.ts): the backend replays a press it has answered. */
  idempotencyKey?: string;
}

export type LaunchAnswer =
  /**
   * 202: the backend created the scan and the engine named its run; the run goes
   * on, and this is never "done". `engineRunId` is the run as the screens read
   * it (shared/engine-record.ts runIdFrom), `stopId` as a stop addresses it.
   */
  | { answer: "pending"; scanId: string; engineRunId: string | null; stopId: string | null; detail: string; statusUrl: string | null; collectUrl: string | null; replayed: boolean }
  /** 200: the engine finished the run inside the backend's one bounded read; `result` is the engine's response, as the backend stored it. */
  | { answer: "completed"; scanId: string; result: Record<string, unknown>; engineRunId: string | null; stopId: string | null; replayed: boolean }
  /** 502: the engine refused the launch, or the run ended short of completed before the backend's read; the backend's record is `failed`. */
  | { answer: "failed"; scanId: string | null; error: string; engineRunId: string | null; replayed: boolean }
  /** 4xx: the backend refused the launch -- consent, bounds, the engagement, preflight -- in its own words. */
  | { answer: "refused"; status: number; detail: string; replayed: boolean };

/**
 * Launch a scan through the backend, as the person: `wait_seconds: 0`, so the
 * backend answers as soon as the engine names the run (PR-A). Bounded by
 * launchTimeouts.launchMs. See the head of this file for how each answer is read.
 */
export async function launchScan(input: LaunchInput): Promise<LaunchAnswer> {
  let response: Response;
  try {
    response = await call("/api/pentest/scan/", {
      method: "POST",
      ...(input.idempotencyKey !== undefined ? { headers: { [IDEMPOTENCY_HEADER]: input.idempotencyKey } } : {}),
      body: JSON.stringify({
        url: input.url,
        consent: true,
        engagement_id: input.engagementId,
        wait_seconds: 0,
        ...(input.recipientEmail ? { recipient_email: input.recipientEmail } : {}),
      }),
      timeoutMs: launchTimeouts.launchMs,
    });
  } catch (cause) {
    // Sent and not answered: the backend may have created the scan and launched it.
    if (cause instanceof ControlPlaneUnanswered) throw new BackendLaunchUnanswered(cause.message);
    throw cause;
  }
  const replayed = response.headers.get(REPLAYED_HEADER) === "true";
  const { object, text } = await jsonObject(response);

  if (response.status === 202) {
    const scanId = textOf(object?.scan_id);
    if (object === null || scanId === null) {
      throw new BackendLaunchUnanswered(
        `Athena-Backend answered 202 to the launch in a shape this dashboard does not read (${text.slice(0, 200) || "no body"}); ` +
        "it may have started the scan", null, 202,
      );
    }
    return {
      answer: "pending",
      scanId,
      engineRunId: runIdFrom(object.engine_run_id),
      stopId: stopIdFrom(object.engine_run_id),
      detail: textOf(object.detail) ?? "",
      statusUrl: textOf(object.status_url),
      collectUrl: textOf(object.collect_url),
      replayed,
    };
  }
  if (response.status === 200) {
    const scanId = textOf(object?.scan_id);
    const result = objectOf(object?.result);
    if (object === null || scanId === null || result === null) {
      throw new BackendLaunchUnanswered(
        `Athena-Backend answered 200 to the launch in a shape this dashboard does not read (${text.slice(0, 200) || "no body"}); ` +
        "it may have started the scan", null, 200,
      );
    }
    return {
      answer: "completed",
      scanId,
      result,
      engineRunId: runIdFrom(object.engine_run_id) ?? runIdFrom(result.run_id),
      stopId: stopIdFrom(object.engine_run_id) ?? stopIdFrom(result.run_id),
      replayed,
    };
  }
  if (response.status === 502 && object !== null && object.status === "failed") {
    return {
      answer: "failed",
      scanId: textOf(object.scan_id),
      // The backend's words, quoted by their first 500 characters as every error body is: a run's error can be as long as its trace.
      error: (textOf(object.error) ?? refusalWords(object, text)).slice(0, 500),
      engineRunId: runIdFrom(object.engine_run_id),
      replayed,
    };
  }
  // The key's own answers: never read as the route's refusal.
  const record = keyRecordOf(object);
  if (record !== null && (response.status === 409 || response.status === 404)) {
    throw new BackendLaunchUnanswered(
      `Athena-Backend has no answer recorded for the first send of this press (it answered ${response.status}: ${refusalWords(object, text)})`,
      record.state, response.status,
    );
  }
  if (record !== null && (response.status === 422 || response.status === 400)) {
    throw new BackendKeyRefused(
      `Athena-Backend refused this launch's ${IDEMPOTENCY_HEADER} (${response.status}: ${refusalWords(object, text)}): a bug in this ` +
      "dashboard, and nothing was started by it",
      response.status,
    );
  }
  if (response.status === 401) {
    throw new ControlPlaneSignInRequired(
      `Athena-Backend answered 401 to the launch: ${refusalWords(object, text)} (it no longer takes your sign-in: sign in to it again)`,
    );
  }
  if (response.status >= 400 && response.status < 500) {
    return { answer: "refused", status: response.status, detail: refusalWords(object, text), replayed };
  }
  throw new BackendLaunchUnanswered(
    `Athena-Backend answered ${response.status} to the launch${text.trim() ? `: ${text.trim().slice(0, 300)}` : " with no body"}; ` +
    "whether it started the scan is not known", null, response.status,
  );
}

// ==== The record ====

export interface BackendScanRecord {
  uuid: string;
  targetUrl: string | null;
  /** The backend's status word: pending | completed | stopped | failed | unknown. */
  status: string;
  verdict: string | null;
  verdictLabel: string | null;
  createdAt: string | null;
  collectedAt: string | null;
  /** The engine's response, as the backend stored it: whole, so a later reader can read more of it. */
  engineResponse: Record<string, unknown> | null;
  pdfUrl: string | null;
  errorMessage: string | null;
  engineRunId: string | null;
  /** The backend's reading of a Stop asked for this scan, as served. */
  stop: Record<string, unknown> | null;
  engagement: { id: number | null; name: string | null; clientName: string | null; status: string | null } | null;
  /** The record exactly as the backend served it. */
  raw: Record<string, unknown>;
}

/** A scan's record as the backend serves it (PentestScanSerializer + PR-A's additions). Null when it is not a record. */
export function readRecord(raw: unknown): BackendScanRecord | null {
  const object = objectOf(raw);
  const uuid = textOf(object?.uuid);
  if (object === null || uuid === null) return null;
  const engagement = objectOf(object.engagement);
  return {
    uuid,
    targetUrl: textOf(object.target_url),
    status: textOf(object.status) ?? "unknown",
    verdict: textOf(object.verdict),
    verdictLabel: textOf(object.verdict_label),
    createdAt: textOf(object.created_at),
    collectedAt: textOf(object.collected_at),
    engineResponse: objectOf(object.engine_response),
    pdfUrl: textOf(object.pdf_url),
    errorMessage: textOf(object.error_message),
    engineRunId: runIdFrom(object.engine_run_id),
    stop: objectOf(object.stop),
    engagement: engagement === null ? null : {
      id: numberOf(engagement.id),
      name: textOf(engagement.name),
      clientName: textOf(engagement.client_name),
      status: textOf(engagement.status),
    },
    raw: object,
  };
}

/**
 * The run's results as the record holds them -- the engine's `results`, at the
 * top of its response or under `result` -- or null when the record holds none
 * that is a list. Never read as none.
 */
export function recordResults(record: BackendScanRecord): unknown[] | null {
  const response = record.engineResponse;
  if (response === null) return null;
  if (Array.isArray(response.results)) return response.results;
  const nested = objectOf(response.result);
  return nested !== null && Array.isArray(nested.results) ? nested.results : null;
}

/** The engine's coverage manifest as the record holds it (shared/scan-coverage.ts), or null when the record holds none. */
export function recordCoverage(record: BackendScanRecord): Record<string, unknown> | null {
  const response = record.engineResponse;
  if (response === null) return null;
  return coverageOf(response.coverage) ?? coverageOf(objectOf(response.result)?.coverage);
}

/** One scan's record, as the person. A 404 is the backend's: not theirs to see, or no such scan (ControlPlaneRefused). */
export async function readScan(uuid: string): Promise<BackendScanRecord> {
  const response = await call(`/api/pentest/scans/${encodeURIComponent(uuid)}/`);
  if (!response.ok) throw await refused(response, `the record of scan ${uuid}`);
  const { object } = await jsonObject(response);
  const record = readRecord(object);
  if (record === null) throw new ControlPlaneUnavailable(`Athena-Backend answered the read of scan ${uuid} with something that is not a scan record`);
  return record;
}

export interface BackendScanListRow {
  uuid: string;
  targetUrl: string | null;
  status: string;
  createdAt: string | null;
  engineRunId: string | null;
}

/** The scans the backend lists for the person (its first page, newest first), for adopting a launch whose answer was lost. */
export async function listScans(): Promise<BackendScanListRow[]> {
  const response = await call("/api/pentest/scans/");
  if (!response.ok) throw await refused(response, "the scans list");
  const text = await textWithin(response);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = null;
  }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(objectOf(parsed)?.results) ? (objectOf(parsed)!.results as unknown[]) : null;
  if (rows === null) throw new ControlPlaneUnavailable("Athena-Backend answered the scans list with something that is not a list");
  const out: BackendScanListRow[] = [];
  for (const row of rows) {
    const object = objectOf(row);
    const uuid = textOf(object?.uuid);
    if (object === null || uuid === null) continue;
    out.push({
      uuid,
      targetUrl: textOf(object.target_url),
      status: textOf(object.status) ?? "unknown",
      createdAt: textOf(object.created_at),
      engineRunId: runIdFrom(object.engine_run_id),
    });
  }
  return out;
}

// ==== The record's list, whole ====

/**
 * One row of `GET /api/pentest/scans/` as the backend lists it (the detail
 * serializer without `engine_response`; athena-backend #188): the RECORD of a
 * scan, for the Engagements page and for adopting the scans this dashboard has
 * no row for (server/backend-adoption.ts). The run's results live on the detail
 * alone (readScan). Read by field, never guessed from a shape: a status word the
 * backend did not send reads "unknown", never "completed".
 */
export interface BackendScanRow {
  uuid: string;
  targetUrl: string | null;
  /** The backend's status word: pending | completed | stopped | failed | unknown. */
  status: string;
  verdict: string | null;
  verdictLabel: string | null;
  createdAt: string | null;
  collectedAt: string | null;
  /** The run as the screens read it (shared/engine-record.ts runIdFrom), and as a stop addresses it (stopIdFrom). */
  engineRunId: string | null;
  stopId: string | null;
  /** The backend's reading of a Stop asked for this scan, as served. */
  stop: Record<string, unknown> | null;
  pdfUrl: string | null;
  emailSent: boolean | null;
  errorMessage: string | null;
  engagement: { id: number | null; name: string | null; clientName: string | null; status: string | null } | null;
}

/** A list row as the backend serves it. Null when it is not a row. */
export function readScanRow(raw: unknown): BackendScanRow | null {
  const object = objectOf(raw);
  const uuid = textOf(object?.uuid);
  if (object === null || uuid === null) return null;
  const engagement = objectOf(object.engagement);
  return {
    uuid,
    targetUrl: textOf(object.target_url),
    status: textOf(object.status) ?? "unknown",
    verdict: textOf(object.verdict),
    verdictLabel: textOf(object.verdict_label),
    createdAt: textOf(object.created_at),
    collectedAt: textOf(object.collected_at),
    engineRunId: runIdFrom(object.engine_run_id),
    stopId: stopIdFrom(object.engine_run_id),
    stop: objectOf(object.stop),
    pdfUrl: textOf(object.pdf_url),
    emailSent: typeof object.email_sent === "boolean" ? object.email_sent : null,
    errorMessage: textOf(object.error_message),
    engagement: engagement === null ? null : {
      id: numberOf(engagement.id),
      name: textOf(engagement.name),
      clientName: textOf(engagement.client_name),
      status: textOf(engagement.status),
    },
  };
}

/** How many pages of the backend's list are followed before the read is refused as unbounded. */
export const MAX_LIST_PAGES = 100;

/** The path, relative to the backend's base, of a DRF page's `next` link; null when the page is the last. */
function nextPathOf(page: Record<string, unknown>): string | null {
  const next = page.next;
  if (typeof next !== "string" || next === "") return null;
  try {
    const url = new URL(next);
    return `${url.pathname}${url.search}`;
  } catch {
    return next.startsWith("/") ? next : `/${next}`;
  }
}

/**
 * Every scan the backend lists for the person, following each page's `next`
 * (DRF pagination) up to MAX_LIST_PAGES: a list read WHOLE, or refused -- never
 * a first page read as the whole, and never an unreadable list read as an empty
 * one. Bounded: the control plane's TIMEOUT_MS per page and, when served under
 * the read deadline (server/read-deadline.ts), cancelled with it. A read, on no
 * stop's path. `listScans` (above) stays the first-page read the launch route
 * adopts a lost answer from.
 */
export async function listScanRows(): Promise<BackendScanRow[]> {
  const rows: BackendScanRow[] = [];
  let path: string | null = "/api/pentest/scans/";
  for (let page = 0; path !== null; page += 1) {
    if (page >= MAX_LIST_PAGES) {
      throw new ControlPlaneUnavailable(`Athena-Backend lists more than ${MAX_LIST_PAGES} pages of scans; the list was not read whole`);
    }
    const response = await call(path);
    if (!response.ok) throw await refused(response, "the scans list");
    const text = await textWithin(response);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
    if (Array.isArray(parsed)) {
      // A bare list is not paginated: as the first answer it is the whole list;
      // behind a page's next link it is neither that list's next page nor the whole.
      if (page > 0) {
        throw new ControlPlaneUnavailable("Athena-Backend answered a later page of the scans list with a bare list, not a page; the list was not read whole");
      }
      for (const row of parsed) {
        const one = readScanRow(row);
        if (one !== null) rows.push(one);
      }
      return rows;
    }
    const pageOf = objectOf(parsed);
    if (pageOf === null || !Array.isArray(pageOf.results)) {
      throw new ControlPlaneUnavailable("Athena-Backend answered the scans list with something that is not a list");
    }
    for (const row of pageOf.results) {
      const one = readScanRow(row);
      if (one !== null) rows.push(one);
    }
    path = nextPathOf(pageOf);
  }
  return rows;
}

// ==== Collect ====

export type CollectAnswer =
  /** 202: the backend read the run and it is not over yet. */
  | { answer: "pending"; detail: string }
  /** 200: the backend collected the run's end into its record. */
  | { answer: "collected"; record: BackendScanRecord }
  /** 409: the scan is not pending (already collected, or never named a run): the record stands as it is. */
  | { answer: "conflict"; detail: string }
  /** 503: the backend could not reach the engine; the row is untouched. Anything else this does not read is here too. */
  | { answer: "unavailable"; status: number; detail: string };

/** Ask the backend to collect a finished run's record, as the person (PR-A `collect/`). Reads, and writes nothing here. */
export async function collectScan(uuid: string): Promise<CollectAnswer> {
  const response = await call(`/api/pentest/scans/${encodeURIComponent(uuid)}/collect/`, { method: "POST", body: "{}" });
  const { object, text } = await jsonObject(response);
  if (response.status === 202) return { answer: "pending", detail: textOf(object?.detail) ?? "still running" };
  if (response.status === 200) {
    const record = readRecord(object);
    if (record === null) {
      return { answer: "unavailable", status: 200, detail: `Athena-Backend answered the collect with something that is not a scan record (${text.slice(0, 200) || "no body"})` };
    }
    return { answer: "collected", record };
  }
  if (response.status === 409) return { answer: "conflict", detail: refusalWords(object, text) };
  if (response.status === 403 || response.status === 404 || response.status === 401) throw await refused(response, `collecting scan ${uuid}`);
  return { answer: "unavailable", status: response.status, detail: refusalWords(object, text) };
}

// ==== Retest checks (owner decision 8: the backend PULLS a retest's verdict and records it as a check) ====

/** One retest check as the backend serves it (assurance/serializers.py RetestCheckSerializer). Null when it is not one. */
export function readRetestCheck(raw: unknown): RetestCheckView | null {
  const object = objectOf(raw);
  const engineRunId = textOf(object?.engine_run_id) ?? (typeof object?.engine_run_id === "number" ? String(object.engine_run_id) : null);
  if (object === null || engineRunId === null) return null;
  return {
    engineRunId,
    scanRecordId: textOf(object.scan_record_id) ?? (typeof object.scan_record_id === "number" ? String(object.scan_record_id) : null),
    twinId: numberOf(object.twin_id),
    twinRunId: textOf(object.twin_run_id) ?? (typeof object.twin_run_id === "number" ? String(object.twin_run_id) : null),
    verdict: textOf(object.verdict),
    verdictKnown: typeof object.verdict_known === "boolean" ? object.verdict_known : null,
    detail: typeof object.detail === "string" ? object.detail : null,
    state: textOf(object.state),
    stoppedAfterRecording: typeof object.stopped_after_recording === "boolean" ? object.stopped_after_recording : null,
    engineCheckedAt: textOf(object.engine_checked_at),
    collectedAt: textOf(object.collected_at),
    collectedBy: textOf(object.collected_by),
  };
}

/**
 * The backend's answers to a retest-check collect, each read by its own field
 * (athena-backend assurance/retest_checks.py, FindingViewSet.retest_checks_collect):
 */
export type RetestCheckCollectAnswer =
  /** 201: the check was recorded now; 200 with `check`: the backend already held the row for this run (`existing`). Either is a RETEST CHECK, never closure evidence. */
  | { answer: "recorded"; status: 201 | 200; existing: boolean; check: RetestCheckView; closure: Record<string, unknown> | null }
  /** 202: the run is still going on the engine; nothing was recorded. Asked again later. */
  | { answer: "running"; status: 202; phase: string; detail: string }
  /** 200 with `phase` (stopped | failed | refused | ended_without_verdict): the run produced no verdict; nothing was recorded. */
  | { answer: "not_a_verdict"; status: 200; phase: string | null; detail: string }
  /**
   * 404, 409, 422 -- the engine has no run this backend can read, the scan is not in the record, or the identity does
   * not hold -- in the backend's own words; and a 400, this dashboard's request refused (a bug here). Nothing was
   * recorded, and asking again changes nothing: the retest is NOT in the backend's record.
   */
  | { answer: "not_in_record"; status: 400 | 404 | 409 | 422; detail: string; candidates: string[] }
  /** 503 -- the backend could not read the engine -- or an answer in no shape this reads: nothing recorded; asked again. */
  | { answer: "unavailable"; status: number; detail: string };

/**
 * Ask the backend to collect a finished retest run's verdict from the engine and
 * record it against `findingUuid` as a retest check, as the person
 * (`POST /api/assurance/findings/<uuid>/retest-checks/collect/`, athena-backend
 * #189). The body names the retest run (`run_id`) and the scan run the retested
 * twin was listed under (`twin_run_id`); the backend reads the engine itself,
 * with its own key, and decides identity itself. Bounded by the control plane's
 * TIMEOUT_MS. Reads, and writes nothing here. A 401 is the person's sign-in
 * (ControlPlaneSignInRequired); a 403 the backend's refusal of this person
 * (ControlPlaneRefused); every other answer is returned as what it said.
 *
 * SAFETY: never on a stop's path. The retest-check watch (server/retest-check-
 * watch.ts) sends this after the dashboard's own filing of the verdict, off the
 * request path, and nothing that answers a stop, a 202 or the kill switch
 * awaits it.
 */
export async function collectRetestCheck(findingUuid: string, body: { runId: string; twinRunId: string }): Promise<RetestCheckCollectAnswer> {
  const response = await call(`/api/assurance/findings/${encodeURIComponent(findingUuid)}/retest-checks/collect/`, {
    method: "POST",
    body: JSON.stringify({ run_id: body.runId, twin_run_id: body.twinRunId }),
  });
  const { object, text } = await jsonObject(response);
  if (response.status === 201 || response.status === 200) {
    const check = readRetestCheck(object?.check);
    if (check !== null) {
      return { answer: "recorded", status: response.status, existing: response.status === 200 || object?.recorded !== true, check, closure: objectOf(object?.closure) };
    }
    if (response.status === 200 && object !== null && typeof object.phase === "string") {
      return { answer: "not_a_verdict", status: 200, phase: object.phase, detail: refusalWords(object, text) };
    }
    return {
      answer: "unavailable", status: response.status,
      detail: `Athena-Backend answered ${response.status} to the retest-check collect in a shape this dashboard does not read (${text.slice(0, 200) || "no body"})`,
    };
  }
  if (response.status === 202) {
    return { answer: "running", status: 202, phase: textOf(object?.phase) ?? "running", detail: refusalWords(object, text) };
  }
  if (response.status === 400 || response.status === 404 || response.status === 409 || response.status === 422) {
    const candidates = Array.isArray(object?.candidates) ? object!.candidates.filter((one): one is string => typeof one === "string") : [];
    const detail = response.status === 400
      ? `Athena-Backend refused this dashboard's request (400): ${refusalWords(object, text)}`
      : refusalWords(object, text);
    return { answer: "not_in_record", status: response.status, detail, candidates };
  }
  if (response.status === 401 || response.status === 403) throw await refused(response, `recording retest check ${body.runId}`);
  return { answer: "unavailable", status: response.status, detail: refusalWords(object, text) };
}

// ==== The PDF ====

/** The backend's report for a completed scan, as the person: the raw answer, for the route to relay as it is. */
export async function fetchPdf(uuid: string): Promise<Response> {
  return call(`/api/pentest/scans/${encodeURIComponent(uuid)}/pdf/`, { headers: { Accept: "application/pdf, application/json" } });
}

// ==== The stop mirror ====

/** What a request sent as a stop, then as the person, came to. */
export interface MirrorOutcome {
  /** Whether the backend took it (2xx). */
  mirrored: boolean;
  /** Which credential the backend took it on; null when neither was taken. */
  via: "stop credential" | "person" | null;
  status: number | null;
  /** Why not, in the backend's or the network's words; "" when mirrored. */
  detail: string;
}

/**
 * Send `init` to `path` first as a stop -- the failsafe service token, waiting
 * on no sign-in -- and, only if that attempt fails, once more as the person.
 * Never throws: a mirror's failure is a fact for the log and the page, never
 * an error that reaches a stop's answer.
 */
async function sentAsStopThenPerson(path: string, init: { method: string; body: string }, what: string): Promise<MirrorOutcome> {
  let first: string;
  try {
    // SAFETY: `stop: true` presents the service token and waits on no person's
    // sign-in. The caller has already answered the engine's stop; nothing here
    // can hold it back or change it.
    const response = await call(path, { ...init, stop: true });
    if (response.ok) return { mirrored: true, via: "stop credential", status: response.status, detail: "" };
    first = `Athena-Backend answered ${response.status} to ${what} sent with the stop credential: ${await body(response)}`;
  } catch (cause) {
    first = `${what} could not be sent with the stop credential: ${causeOf(cause)}`;
  }
  // Decision 6: the person's credential only after the stop credential failed, and never waited on by a stop.
  try {
    const response = await call(path, init);
    if (response.ok) return { mirrored: true, via: "person", status: response.status, detail: `${first}; it was then taken as the person` };
    return {
      mirrored: false, via: null, status: response.status,
      detail: `${first}; sent as the person, Athena-Backend answered ${response.status}: ${await body(response)}`,
    };
  } catch (cause) {
    return { mirrored: false, via: null, status: null, detail: `${first}; sent as the person: ${causeOf(cause)}` };
  }
}

/**
 * Mirror a Stop this dashboard sent the engine into the backend's record of the
 * scan (`POST /api/pentest/scans/<uuid>/stop/`, a stop for every POST by the
 * backend's judgement). The engine's abort is the stop; this is the record of
 * it. Sent after the stop's answer, never awaited by it; never throws.
 */
export async function mirrorStop(uuid: string, reason: string): Promise<MirrorOutcome> {
  return sentAsStopThenPerson(
    `/api/pentest/scans/${encodeURIComponent(uuid)}/stop/`,
    { method: "POST", body: JSON.stringify({ reason }) },
    `the stop mirror for scan ${uuid}`,
  );
}
