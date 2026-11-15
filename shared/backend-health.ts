/**
 * Athena-Backend's health, read strictly (DASH-HEALTH-PANEL).
 *
 * Athena-Backend's `GET /api/health/` answers `"status"` with `"ok"`,
 * `"degraded"` or `"unknown"` (athena-backend #217), with the counts of what a
 * worker lost or refused under `"degraded"`, every counting worker under
 * `"workers"` and every worker whose report could not be read under
 * `"unknown"` (#226). A backend from before #217 answers `{"status": "ok"}` and
 * nothing else.
 *
 * The rule this file keeps: the console says "ok" only when the backend said
 * "ok" explicitly AND reported every count AND every count is zero. Everything
 * else is something other than "ok":
 *
 *   - "degraded": the backend said so, and every count it gave could be read;
 *   - "unknown": the backend said "unknown", or anything in its answer could not
 *     be read -- a missing field, a count that is not a whole number, a status
 *     this console does not know, a body that is not JSON, an HTTP error;
 *   - "unreachable": no answer -- refused, reset, or not within the deadline;
 *   - "uncounted": the backend said "ok" but reported no counts (a backend from
 *     before #217, or #217/#226's own "ok", which carries none). Shown as the
 *     backend's plain status, with "counts not reported by this backend", never
 *     as all-zero and never as this console's "ok".
 *
 * Nothing is dropped: a field this console does not know is listed as it came.
 * Pure: no I/O, no clock. The server reads (server/backend-health.ts); the page
 * draws (client/src/components/BackendHealthStrip.tsx).
 */

/** What the console shows. Only "ok" is ok. */
export type BackendHealthState = "ok" | "degraded" | "unknown" | "unreachable" | "uncounted" | "not_configured";

/** A count the backend reported, by its name, with the words the console uses for it. */
export interface HealthCount {
  name: string;
  label: string;
  value: number;
}

/** A value the backend sent where a count belongs that is not a whole number of zero or more. */
export interface OddValue {
  name: string;
  /** As it came, written out as JSON. */
  raw: string;
}

/** A field the console does not know, listed as it came. */
export interface UnrecognizedField {
  name: string;
  /** As it came, written out as JSON. */
  raw: string;
}

/** One worker the backend reported (#226), with every non-zero count. */
export interface HealthWorker {
  id: string;
  /** The backend's word for the worker ("live", "exited", "stale", "this worker"), or null when it sent none it could be read as. */
  state: string | null;
  counts: HealthCount[];
  odd: OddValue[];
  /** Acknowledgement fields, read only, as they came (`acknowledged_by`, `acknowledged_at`, ...). */
  acknowledgement: UnrecognizedField[];
  /** Any other field on the worker, as it came. */
  unrecognized: UnrecognizedField[];
}

/** A worker whose report the backend could not read, and why (#226 `"unknown"`). */
export interface UnknownWorker {
  id: string;
  why: string;
}

export interface BackendHealthReading {
  state: BackendHealthState;
  /** The backend's own `"status"`, as it came (a string), or null when it sent none. */
  backendStatus: string | null;
  /** The backend's own `"message"`, or null. */
  message: string | null;
  /** Why this reads as it does, when it is not "ok": in plain words, one sentence each. */
  reasons: string[];
  /** Whether the backend reported its counts at all (#217). False: "counts not reported by this backend". */
  countsReported: boolean;
  /** Every non-zero count, by name. */
  counts: HealthCount[];
  /** Counts that could not be read as a number. */
  odd: OddValue[];
  workers: HealthWorker[];
  unknownWorkers: UnknownWorker[];
  /** Top-level fields this console does not know, listed as they came. */
  unrecognized: UnrecognizedField[];
  /** The HTTP status the backend answered with, or null when it did not answer. */
  httpStatus: number | null;
}

/** The counts athena-backend #217 reports, in its order, with plain words for each. */
export const KNOWN_COUNTS: ReadonlyArray<readonly [string, string]> = [
  ["stderr_lines_lost", "stderr lines lost"],
  ["log_records_dropped", "log records dropped"],
  ["unrecorded_dispatches_refused", "unrecorded dispatches refused"],
  // #226: a worker whose report could not be published.
  ["worker_reports_unpublished", "worker reports not published"],
];

/** The counts every #217 backend reports: an "ok" that names fewer is not read as all-zero. */
export const REQUIRED_COUNTS: readonly string[] = ["stderr_lines_lost", "log_records_dropped", "unrecorded_dispatches_refused"];

const KNOWN_TOP_LEVEL = new Set(["status", "message", "degraded", "counts", "workers", "unknown"]);

/** The words for a count: the known ones by name, any other with its underscores as spaces. */
export function countLabel(name: string): string {
  const known = KNOWN_COUNTS.find(([key]) => key === name);
  return known ? known[1] : name.replace(/_/g, " ");
}

function raw(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A count is a whole number of zero or more; anything else is odd. */
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function emptyReading(state: BackendHealthState, httpStatus: number | null, reasons: string[]): BackendHealthReading {
  return {
    state, backendStatus: null, message: null, reasons, countsReported: false, counts: [], odd: [],
    workers: [], unknownWorkers: [], unrecognized: [], httpStatus,
  };
}

/** No control plane is configured, so there is nothing to read. */
export function notConfigured(): BackendHealthReading {
  return emptyReading("not_configured", null, ["no Athena-Backend address is configured (ATHENA_FAILSAFE_URL), so its health is not read"]);
}

/** No answer: refused, reset, or not within the deadline. */
export function unreachable(why: string): BackendHealthReading {
  return emptyReading("unreachable", null, [why]);
}

/** Read a counts object: every non-zero count, and every value that is not a count. */
function readCounts(source: Record<string, unknown>): { counts: HealthCount[]; zeros: string[]; odd: OddValue[] } {
  const counts: HealthCount[] = [];
  const zeros: string[] = [];
  const odd: OddValue[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (!isCount(value)) odd.push({ name, raw: raw(value) });
    else if (value === 0) zeros.push(name);
    else counts.push({ name, label: countLabel(name), value });
  }
  return { counts, zeros, odd };
}

const ACKNOWLEDGEMENT = /^acknowledg/i;

function readWorker(id: string, value: unknown): { worker: HealthWorker; problems: string[] } {
  const problems: string[] = [];
  const worker: HealthWorker = { id, state: null, counts: [], odd: [], acknowledgement: [], unrecognized: [] };
  if (!isRecord(value)) {
    worker.odd.push({ name: "worker", raw: raw(value) });
    problems.push(`worker ${id}'s entry could not be read`);
    return { worker, problems };
  }
  for (const [name, field] of Object.entries(value)) {
    if (name === "id" || name === "worker") continue;
    if (name === "state") {
      if (typeof field === "string" && field.trim()) worker.state = field;
      else {
        worker.odd.push({ name, raw: raw(field) });
        problems.push(`worker ${id}'s state could not be read`);
      }
    } else if (ACKNOWLEDGEMENT.test(name)) {
      worker.acknowledgement.push({ name, raw: raw(field) });
    } else if (name === "counts" && isRecord(field)) {
      const read = readCounts(field);
      worker.counts.push(...read.counts);
      worker.odd.push(...read.odd);
      for (const one of read.odd) problems.push(`worker ${id}'s count ${one.name} is not a number (${one.raw})`);
    } else if (KNOWN_COUNTS.some(([key]) => key === name)) {
      // #226 puts each non-zero count beside the state. Any other field, a number or not, is listed as it came.
      if (!isCount(field)) {
        worker.odd.push({ name, raw: raw(field) });
        problems.push(`worker ${id}'s count ${name} is not a number (${raw(field)})`);
      } else if (field > 0) worker.counts.push({ name, label: countLabel(name), value: field });
    } else {
      worker.unrecognized.push({ name, raw: raw(field) });
    }
  }
  if (worker.state === null && !worker.odd.some((one) => one.name === "state")) {
    problems.push(`worker ${id} has no state`);
  }
  return { worker, problems };
}

function readWorkers(value: unknown): { workers: HealthWorker[]; problems: string[] } {
  const workers: HealthWorker[] = [];
  const problems: string[] = [];
  const entries: Array<[string, unknown]> = isRecord(value)
    ? Object.entries(value)
    : Array.isArray(value)
      ? value.map((one, index) => {
        const named = isRecord(one) ? (one.id ?? one.worker) : undefined;
        return [typeof named === "string" && named ? named : `#${index + 1}`, one] as [string, unknown];
      })
      : [];
  if (!isRecord(value) && !Array.isArray(value)) {
    problems.push(`the workers field could not be read (${raw(value)})`);
    return { workers, problems };
  }
  for (const [id, one] of entries) {
    const read = readWorker(id, one);
    workers.push(read.worker);
    problems.push(...read.problems);
  }
  return { workers, problems };
}

function readUnknownWorkers(value: unknown): { unknownWorkers: UnknownWorker[]; problems: string[] } {
  if (!isRecord(value)) return { unknownWorkers: [], problems: [`the unknown field could not be read (${raw(value)})`] };
  return {
    unknownWorkers: Object.entries(value).map(([id, why]) => ({ id, why: typeof why === "string" ? why : raw(why) })),
    problems: [],
  };
}

/**
 * The backend's answer to `GET /api/health/`, read strictly: `httpStatus` as it
 * answered, `body` as its text (null when none arrived).
 */
export function interpretHealth(httpStatus: number, body: string | null): BackendHealthReading {
  if (httpStatus < 200 || httpStatus > 299) {
    const reading = emptyReading("unknown", httpStatus, [`Athena-Backend answered HTTP ${httpStatus} to its health check`]);
    return reading;
  }
  let parsed: unknown;
  try {
    parsed = body === null ? undefined : JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) {
    return emptyReading("unknown", httpStatus, ["Athena-Backend's health answer could not be read as a JSON object"]);
  }

  const reasons: string[] = [];
  const reading: BackendHealthReading = {
    state: "unknown", backendStatus: null, message: null, reasons, countsReported: false, counts: [], odd: [],
    workers: [], unknownWorkers: [], unrecognized: [], httpStatus,
  };

  for (const [name, value] of Object.entries(parsed)) {
    if (!KNOWN_TOP_LEVEL.has(name)) reading.unrecognized.push({ name, raw: raw(value) });
  }
  if (typeof parsed.message === "string") reading.message = parsed.message;
  else if ("message" in parsed) reading.unrecognized.push({ name: "message", raw: raw(parsed.message) });

  // The counts: under "degraded" (#217, #226) or "counts" (an "ok" that names its zeros).
  const zeros: string[] = [];
  let countProblem = false;
  for (const key of ["degraded", "counts"] as const) {
    if (!(key in parsed)) continue;
    const source = parsed[key];
    if (!isRecord(source)) {
      reading.odd.push({ name: key, raw: raw(source) });
      reasons.push(`the ${key} field could not be read (${raw(source)})`);
      countProblem = true;
      continue;
    }
    reading.countsReported = true;
    const read = readCounts(source);
    reading.counts.push(...read.counts);
    zeros.push(...read.zeros);
    reading.odd.push(...read.odd);
    for (const one of read.odd) {
      reasons.push(`the count ${one.name} is not a number (${one.raw})`);
      countProblem = true;
    }
  }

  let workerProblem = false;
  if ("workers" in parsed) {
    const read = readWorkers(parsed.workers);
    reading.workers = read.workers;
    if (read.problems.length > 0) {
      reasons.push(...read.problems);
      workerProblem = true;
    }
  }
  if ("unknown" in parsed) {
    const read = readUnknownWorkers(parsed.unknown);
    reading.unknownWorkers = read.unknownWorkers;
    reasons.push(...read.problems);
    if (read.problems.length > 0) workerProblem = true;
  }
  const workerCounts = reading.workers.some((one) => one.counts.length > 0);

  const status = parsed.status;
  if (typeof status !== "string") {
    reasons.unshift(status === undefined
      ? "Athena-Backend's health answer has no status field"
      : `Athena-Backend's health status could not be read (${raw(status)})`);
    if (status !== undefined) reading.unrecognized.push({ name: "status", raw: raw(status) });
    return reading; // unknown
  }
  reading.backendStatus = status;

  if (status === "degraded") {
    if (!("degraded" in parsed)) {
      reasons.unshift("Athena-Backend says degraded but sent no counts (the degraded field is missing)");
      return reading; // unknown
    }
    if (countProblem || workerProblem) return reading; // unknown: a count or a worker could not be read
    if (reading.counts.length === 0) {
      reasons.unshift("Athena-Backend says degraded but every count it sent is zero");
      return reading; // unknown: the two cannot both be so
    }
    reading.state = "degraded";
    if (reading.unknownWorkers.length > 0) {
      reasons.push(`${reading.unknownWorkers.length} worker report(s) could not be read by Athena-Backend`);
    }
    return reading;
  }

  if (status === "unknown") {
    reasons.unshift("Athena-Backend says its counts could not all be read");
    return reading;
  }

  if (status === "ok") {
    if (countProblem || workerProblem) return reading; // unknown
    if (reading.counts.length > 0 || workerCounts) {
      reasons.unshift("Athena-Backend says ok but reports a count above zero");
      return reading; // unknown: the two cannot both be so
    }
    if (reading.unknownWorkers.length > 0) {
      reasons.unshift("Athena-Backend says ok but names worker reports it could not read");
      return reading; // unknown
    }
    if (!reading.countsReported) {
      reading.state = "uncounted";
      reasons.push("counts not reported by this backend");
      return reading;
    }
    const missing = REQUIRED_COUNTS.filter((name) => !zeros.includes(name));
    if (missing.length > 0) {
      reasons.unshift(`Athena-Backend says ok but did not report ${missing.map(countLabel).join(", ")}`);
      return reading; // unknown: a count it did not send is not read as zero
    }
    reading.state = "ok";
    return reading;
  }

  reasons.unshift(`Athena-Backend's health status "${status}" is not one this console knows`);
  return reading; // unknown
}

/** What the console's route answers: the reading, and when it was taken. */
export interface BackendHealthView extends BackendHealthReading {
  /** When the reading was taken (ISO 8601), or null when none has been. */
  readAt: string | null;
  /** Whether a read is under way now. */
  reading: boolean;
}

const STATES: ReadonlySet<string> = new Set(["ok", "degraded", "unknown", "unreachable", "uncounted", "not_configured"]);

/**
 * The route's answer, checked again in the page: an answer whose shape is not
 * the one this console sends reads unknown, never ok.
 */
export function viewFrom(value: unknown): BackendHealthView | null {
  if (!isRecord(value) || typeof value.state !== "string" || !STATES.has(value.state)) return null;
  const list = <T>(key: string): T[] | null => (Array.isArray(value[key]) ? (value[key] as T[]) : null);
  const reasons = list<string>("reasons");
  const counts = list<HealthCount>("counts");
  const odd = list<OddValue>("odd");
  const workers = list<HealthWorker>("workers");
  const unknownWorkers = list<UnknownWorker>("unknownWorkers");
  const unrecognized = list<UnrecognizedField>("unrecognized");
  if (!reasons || !counts || !odd || !workers || !unknownWorkers || !unrecognized) return null;
  if (typeof value.countsReported !== "boolean") return null;
  if (!counts.every((one) => isRecord(one) && typeof one.name === "string" && isCount(one.value))) return null;
  if (value.state === "ok" && (counts.length > 0 || odd.length > 0 || !value.countsReported)) return null;
  return value as unknown as BackendHealthView;
}
