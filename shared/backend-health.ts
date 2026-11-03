/**
 * Athena-Backend's own health, as an operator reads it on the console.
 *
 * The backend's `GET /api/health/` (Athena-Backend #217, config/api_views.py)
 * answers 200 with
 *
 *   {"status": "ok" | "degraded" | "unknown" | "error", "message": "...",
 *    "degraded": {"<count>": <n>, ...}}          ("degraded" only when degraded)
 *
 * where the counts are what the answering process lost or refused since it
 * started: lines meant for stderr that never reached it, log records dropped,
 * and unrecorded dispatches refused past the hard bound. A follow-up
 * (AB-HEALTH-SHARED) sums every worker's counts and may add a `workers` list
 * and acknowledgement fields.
 *
 * READ STRICTLY. "ok" is shown only when the backend said "ok" AND reported
 * every count this console knows, each a whole number and each zero, with
 * nothing else in the answer pulling the other way. Everything short of that
 * is said as what it is:
 *
 *   - "degraded": the backend said so, with every count it named, by name.
 *   - "unknown": the backend said "unknown", or answered something this
 *     console cannot read in full -- no status, a status it does not know, a
 *     count that is missing or not a whole number, an HTTP status other than 200.
 *   - "unreachable": no answer at all -- refused, cut, or past the timeout.
 *   - "not-reported": the backend said its plain status and reported no counts
 *     (a backend from before #217 -- and #217 itself on "ok", which names no
 *     count). Never read as all-zero.
 *   - "error": the backend said "error".
 *
 * A field this console does not recognise is shown, never dropped.
 *
 * Pure: no I/O, no clock. The server reads the backend (server/backend-health.ts)
 * and classifies the answer here; the console renders the reading.
 */

/** The counts #217 reports, by the backend's own names, with the words the console shows. */
export const KNOWN_COUNTS = {
  stderr_lines_lost: "stderr lines lost",
  log_records_dropped: "log records dropped",
  unrecorded_dispatches_refused: "unrecorded dispatches refused",
} as const;
export type KnownCount = keyof typeof KNOWN_COUNTS;
export const KNOWN_COUNT_NAMES = Object.keys(KNOWN_COUNTS) as KnownCount[];

export const VERDICTS = ["ok", "degraded", "unknown", "unreachable", "not-reported", "error"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** One count, as the backend named it, with the value it reported (only ever a whole number here). */
export interface HealthCount {
  name: string;
  /** The console's words for a known count; the backend's own name for one it does not know. */
  label: string;
  value: number;
  /** Whether this console knows the count (one of KNOWN_COUNTS). */
  known: boolean;
}

/** A field shown as the backend sent it: its name and its value as JSON text, cut at FIELD_TEXT_LIMIT. */
export interface ShownField {
  name: string;
  value: string;
}

export interface HealthWorker {
  fields: ShownField[];
}

export interface BackendHealthReading {
  verdict: Verdict;
  /** One sentence, in plain words. */
  headline: string;
  /** The backend's `status` as it sent it, or null when it sent none (or nothing at all). */
  reportedStatus: string | null;
  /** The backend's `message`, or null. */
  message: string | null;
  /** The HTTP status of the answer, or null when there was none. */
  httpStatus: number | null;
  /** Every non-zero count, by name. Never a zero the backend did not report. */
  counts: HealthCount[];
  /** Whether the backend reported counts at all. */
  countsReported: boolean;
  /** Why the reading is not "ok", or what in the answer could not be read. */
  problems: string[];
  /** Fields this console does not recognise, shown as sent. */
  unrecognised: ShownField[];
  /** AB-HEALTH-SHARED's per-worker reports, as sent; null when the answer carries none. */
  workers: HealthWorker[] | null;
  /** Acknowledgement fields (AB-HEALTH-SHARED), as sent. */
  acknowledgement: ShownField[];
}

/** What one read of the backend's health came to, before it is classified. */
export type HealthOutcome =
  | { kind: "answered"; httpStatus: number; body: unknown }
  /** The answer's body could not be parsed as JSON (or was too large to take). */
  | { kind: "unreadable"; httpStatus: number; why: string }
  | { kind: "unreachable"; why: string }
  | { kind: "timeout"; ms: number };

/** The most of one field's value shown. */
export const FIELD_TEXT_LIMIT = 200;
/** The most unrecognised fields (or workers) listed; the rest are counted. */
export const FIELD_LIST_LIMIT = 50;

/** Fields #217 defines, or AB-HEALTH-SHARED is expected to: read, not listed as unrecognised. */
const READ_FIELDS = new Set(["status", "message", "degraded", "counts", "workers"]);
const ACK_FIELD = /^ack|acknowledg/i;

function shownValue(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > FIELD_TEXT_LIMIT ? `${text.slice(0, FIELD_TEXT_LIMIT)}…` : text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function labelOf(name: string): string {
  return (KNOWN_COUNTS as Record<string, string>)[name] ?? name;
}

function listed(fields: ShownField[], problems: string[], what: string): ShownField[] {
  if (fields.length <= FIELD_LIST_LIMIT) return fields;
  problems.push(`${fields.length - FIELD_LIST_LIMIT} more ${what} are not listed here`);
  return fields.slice(0, FIELD_LIST_LIMIT);
}

/**
 * The counts an answer (or one worker's report) carries: from `degraded` (#217)
 * and from `counts` (a full report, every count, zeros included). Each value
 * that is not a whole number is a problem, never a number.
 */
function readCounts(
  report: Record<string, unknown>, where: string, problems: string[],
): { values: Map<string, number>; reported: boolean } {
  const values = new Map<string, number>();
  let reported = false;
  for (const field of ["counts", "degraded"] as const) {
    if (!(field in report)) continue;
    const raw = report[field];
    if (!isObject(raw)) {
      problems.push(`${where}"${field}" is not a set of counts: ${shownValue(raw)}`);
      continue;
    }
    reported = true;
    for (const [name, value] of Object.entries(raw)) {
      if (!isCount(value)) {
        problems.push(`${where}the count "${name}" is not a whole number: ${shownValue(value)}`);
        continue;
      }
      const before = values.get(name);
      if (before !== undefined && before !== value) {
        problems.push(`${where}the count "${name}" is reported twice, as ${before} and ${value}`);
      }
      values.set(name, Math.max(before ?? 0, value));
    }
  }
  return { values, reported };
}

function workersOf(raw: unknown, problems: string[]): HealthWorker[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) {
    problems.push(`"workers" is not a list: ${shownValue(raw)}`);
    return [];
  }
  if (raw.length > FIELD_LIST_LIMIT) problems.push(`${raw.length - FIELD_LIST_LIMIT} more workers are not listed here`);
  return raw.slice(0, FIELD_LIST_LIMIT).map((one, index) => {
    if (!isObject(one)) {
      problems.push(`worker ${index + 1} is not a report: ${shownValue(one)}`);
      return { fields: [{ name: "report", value: shownValue(one) }] };
    }
    const where = `worker ${index + 1}: `;
    if ("status" in one && one.status !== "ok") {
      problems.push(`${where}status ${shownValue(one.status)}`);
    }
    const { values } = readCounts(one, where, problems);
    for (const [name, value] of Array.from(values.entries())) {
      if (value !== 0) problems.push(`${where}${labelOf(name)}: ${value}`);
    }
    return {
      fields: listed(Object.entries(one).map(([name, value]) => ({ name, value: shownValue(value) })), problems, `fields of worker ${index + 1}`),
    };
  });
}

function blank(verdict: Verdict, headline: string, extra: Partial<BackendHealthReading> = {}): BackendHealthReading {
  return {
    verdict, headline, reportedStatus: null, message: null, httpStatus: null, counts: [], countsReported: false,
    problems: [], unrecognised: [], workers: null, acknowledgement: [], ...extra,
  };
}

/** One read of the backend's health, as the console shows it. See the head of this file. */
export function classifyHealth(outcome: HealthOutcome): BackendHealthReading {
  if (outcome.kind === "unreachable") {
    return blank("unreachable", `Athena-Backend could not be reached: ${outcome.why}`);
  }
  if (outcome.kind === "timeout") {
    return blank("unreachable", `Athena-Backend did not answer its health check within ${Math.round(outcome.ms / 100) / 10} s`);
  }
  if (outcome.kind === "unreadable") {
    return blank("unknown", `Athena-Backend's health answer (HTTP ${outcome.httpStatus}) could not be read: ${outcome.why}`, {
      httpStatus: outcome.httpStatus,
    });
  }

  const { httpStatus, body } = outcome;
  if (!isObject(body)) {
    return blank("unknown", `Athena-Backend's health answer (HTTP ${httpStatus}) is not a report this console can read`, {
      httpStatus, unrecognised: [{ name: "answer", value: shownValue(body) }],
    });
  }

  const problems: string[] = [];
  const reportedStatus = typeof body.status === "string" ? body.status : null;
  const message = typeof body.message === "string" ? body.message : null;
  if ("message" in body && message === null) problems.push(`"message" is not text: ${shownValue(body.message)}`);

  const { values, reported: countsReported } = readCounts(body, "", problems);
  const counts: HealthCount[] = Array.from(values.entries())
    .filter(([, value]) => value !== 0)
    .map(([name, value]) => ({ name, label: labelOf(name), value, known: name in KNOWN_COUNTS }));
  const workers = workersOf(body.workers, problems);

  const unrecognised: ShownField[] = [];
  const acknowledgement: ShownField[] = [];
  for (const [name, value] of Object.entries(body)) {
    if (READ_FIELDS.has(name)) continue;
    (ACK_FIELD.test(name) ? acknowledgement : unrecognised).push({ name, value: shownValue(value) });
  }

  // Listed before any verdict is reached: a field left off the list is something not shown, so never "ok".
  const shownUnrecognised = listed(unrecognised, problems, "unrecognised fields");
  const shownAcknowledgement = listed(acknowledgement, problems, "acknowledgement fields");
  const reading = (verdict: Verdict, headline: string): BackendHealthReading => ({
    verdict, headline, reportedStatus, message, httpStatus, counts, countsReported, problems,
    unrecognised: shownUnrecognised, workers, acknowledgement: shownAcknowledgement,
  });

  if (httpStatus !== 200) {
    return reading("unknown", `Athena-Backend answered its health check with HTTP ${httpStatus}`);
  }
  if (reportedStatus === null) {
    if ("status" in body) problems.push(`"status" is not text: ${shownValue(body.status)}`);
    return reading("unknown", "Athena-Backend's health answer carries no status this console can read");
  }

  switch (reportedStatus) {
    case "degraded": {
      if (counts.length === 0) problems.push("the backend reports itself degraded and names no non-zero count");
      return reading("degraded", "Athena-Backend reports itself degraded: it lost or refused what an operator must act on");
    }
    case "unknown":
      return reading("unknown", "Athena-Backend reports its own health as unknown: its counts could not be read");
    case "error":
      return reading("error", "Athena-Backend reports an error in its own health check");
    case "ok": {
      if (counts.length > 0) {
        problems.push("the backend said \"ok\" with a non-zero count");
        return reading("degraded", "Athena-Backend said \"ok\", but reports non-zero counts");
      }
      if (!countsReported && workers === null && problems.length === 0) {
        return reading("not-reported", "Athena-Backend answers \"ok\": counts not reported by this backend");
      }
      for (const name of KNOWN_COUNT_NAMES) {
        if (!values.has(name)) problems.push(`the count "${name}" (${KNOWN_COUNTS[name]}) is not reported`);
      }
      if (problems.length > 0) {
        return reading("unknown", "Athena-Backend said \"ok\", but its answer could not be read in full");
      }
      return reading("ok", "Athena-Backend reports every count at zero");
    }
    default:
      return reading("unknown", `Athena-Backend answered a status this console does not recognise: ${shownValue(reportedStatus)}`);
  }
}

/**
 * A reading as served, guarded on the console's side too: anything that is not
 * a well-formed reading -- from an older or newer server, or a body cut short --
 * is "unknown", never "ok".
 */
export function guardReading(raw: unknown): BackendHealthReading {
  if (!isObject(raw) || typeof raw.verdict !== "string" || !(VERDICTS as readonly string[]).includes(raw.verdict)
    || typeof raw.headline !== "string" || !Array.isArray(raw.counts) || !Array.isArray(raw.problems)
    || !Array.isArray(raw.unrecognised) || !Array.isArray(raw.acknowledgement)
    || !(raw.workers === null || Array.isArray(raw.workers))) {
    return blank("unknown", "The console's server answered a health reading this page cannot read");
  }
  return raw as unknown as BackendHealthReading;
}
