/**
 * Reading Athena-Backend's Economic Exposure documents in the browser, as served.
 *
 * The documents (mythos.economics.report/v2 -- v1 and its currency bridge --, the
 * events route's, mythos.economics.roi/v1 and the deployment's scenario list)
 * arrive as the backend's own bytes (server/economics.ts) and are read here, never
 * recomputed. The rules every view follows:
 *
 * - NO arithmetic on money. An amount is the backend's decimal string, shown as
 *   it is, with the served currency: no sum, no conversion, no rounding, never a
 *   float. The backend already states every loss at the currency's minor unit
 *   (JPY 0 places, KWD 3); an amount that is not a plain decimal string -- a
 *   number, an exponent, anything else -- is unreadable and shown so, never
 *   converted.
 * - Nothing is totalled across scenarios: a view reads one scenario version, and
 *   the picker lists versions with their own standing, adding nothing up.
 * - A result not for capital decisions carries the report's banner text, shown
 *   exactly, above every figure.
 * - A refused result shows its refusal code and its kept inputs, never a figure.
 * - `excluded_from_totals` and every downgrade reason are shown; stale or
 *   downgraded data is marked.
 * - A residual (counterfactual) run is shown only in the current-against-residual
 *   view, never as exposure.
 */

export type Doc = Record<string, unknown>;

export function obj(value: unknown): Doc | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Doc) : null;
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A field down a path of object keys, or undefined where any step is not an object. */
export function at(value: unknown, ...path: string[]): unknown {
  let here: unknown = value;
  for (const key of path) {
    const found = obj(here);
    if (found === null) return undefined;
    here = found[key];
  }
  return here;
}

/** The grades a total may sum (the backend's allow-list, report.GRADES_FOR_TOTALS). */
export const GRADES_A_TO_D = new Set(["A", "B", "C", "D"]);

/** The backend's banner text, as it states it (report.UNKNOWN_BANNER); used only to recognise it in tests. */
export const SERVED_BANNER = "Unknown: not for capital decisions";

/** A plain decimal string: digits, an optional sign, an optional fractional part. */
const DECIMAL = /^-?\d+(\.\d+)?$/;

export type Amount =
  | { kind: "amount"; text: string }
  | { kind: "absent" }
  | { kind: "unreadable"; why: string };

/**
 * A served amount, read WITHOUT conversion: the string itself when it is a plain
 * decimal, never a number made from it. A JSON number is refused rather than
 * shown: the backend serves money as strings (canonical JSON holds no float), so
 * a number here was not served as money and its digits cannot be trusted.
 */
export function servedAmount(value: unknown): Amount {
  if (value === null || value === undefined) return { kind: "absent" };
  if (typeof value === "number") return { kind: "unreadable", why: "served as a number, not as a decimal string" };
  if (typeof value !== "string") return { kind: "unreadable", why: "not a decimal string" };
  if (!DECIMAL.test(value)) return { kind: "unreadable", why: "not a plain decimal string" };
  return { kind: "amount", text: value };
}

/** The digits after the point of a decimal string: read from the text, no arithmetic. */
export function placesOf(decimal: string): number {
  const point = decimal.indexOf(".");
  return point < 0 ? 0 : decimal.length - point - 1;
}

/** The report's currency: its code and the minor unit it states, as served. */
export interface Currency {
  code: string;
  minorUnit: number | null;
}

export function currencyOf(doc: unknown): Currency {
  const code = text(at(doc, "currency", "code")) ?? "";
  const minor = at(doc, "currency", "minor_unit");
  return { code, minorUnit: typeof minor === "number" && Number.isInteger(minor) ? minor : null };
}

/**
 * Whether a report, or an ROI document, is refused: a run the engine refused, or
 * stored rows that no longer verify (served as the refusal `stored_row_unverified`).
 * Fail closed: anything but a completed status with no refusal is refused.
 */
export function isRefused(doc: unknown): boolean {
  return text(at(doc, "status")) !== "completed" || at(doc, "refusal") !== null;
}

/**
 * The banner a document's figures carry, or null where it may be read for capital
 * decisions. The report's own text where it serves one (shown exactly); where it
 * serves none but the document is not graded A to D, or is excluded from totals,
 * the dashboard's own fail-closed line -- it never reads such a document as clean.
 */
export function bannerOf(doc: unknown): { text: string; served: boolean; reason: string | null } | null {
  const banner = text(at(doc, "banner"));
  const reason = text(at(doc, "banner_reason"));
  if (banner !== null) return { text: banner, served: true, reason };
  const grade = text(at(doc, "grade"));
  if (at(doc, "excluded_from_totals") !== false || grade === null || !GRADES_A_TO_D.has(grade)) {
    return {
      text: "Not graded A to D, and no banner was served: not for capital decisions",
      served: false,
      reason,
    };
  }
  return null;
}

/** Whether a served document has a field, down a path of keys: present, even if null. */
export function has(value: unknown, ...path: string[]): boolean {
  if (path.length === 0) return value !== undefined;
  const parent = obj(at(value, ...path.slice(0, -1)));
  return parent !== null && Object.prototype.hasOwnProperty.call(parent, path[path.length - 1]);
}

/**
 * Whether a report is of a residual (counterfactual) run: its result is the one
 * the ROI document names as the residual run. Such a run is never exposure; it is
 * shown only against the current run, in the ROI's own view.
 */
export function isResidualRun(report: unknown, roi: unknown): boolean {
  const shown = text(at(report, "simulation", "uuid"));
  const residual = text(at(roi, "residual", "simulation"));
  return shown !== null && residual !== null && shown === residual;
}

/**
 * What the report itself says of its run (Athena-Backend #160, merged:
 * `residual_of`, null for the scenario's own run, the remediation option for a
 * residual run): "own" or "residual" where it says so; "absent" where the report
 * carries no such field (a backend from before #160), and "unreadable" where the
 * field is neither null nor an object. Only "own" lets a result be read as exposure.
 */
export function residualMarker(report: unknown): "own" | "residual" | "absent" | "unreadable" {
  if (!has(report, "residual_of")) return "absent";
  const marker = at(report, "residual_of");
  if (marker === null) return "own";
  return obj(marker) !== null ? "residual" : "unreadable";
}

/**
 * Whether a failed ROI read is the backend's own "not served" (it answered 404: no
 * remediation option with a residual run, or no ROI route at this version), which
 * this server answers 404 with `code: "not_served"`. Only that confirms there is no
 * residual run to mistake for exposure; any other failure -- a 5xx, a refusal, a
 * timeout, a dropped connection, this server's own 404 -- confirms nothing.
 */
export function isConfirmedNotServed(error: unknown): boolean {
  const failed = error as { status?: unknown; body?: unknown } | null;
  return failed !== null && typeof failed === "object" && failed.status === 404 && at(failed.body, "code") === "not_served";
}

/** The lines a report states figures for, in its order (report.LINES). */
export const CASH_LINES = ["gross_cash", "retained_cash"] as const;
export const MARKET_VALUE_LINE = "market_value";

export const LINE_LABEL: Record<string, string> = {
  gross_cash: "Gross cash",
  retained_cash: "Retained cash",
  market_value: "Market-value reaction",
};

/** The money units the backend's parameters use (engine/parameters.py MONEY_UNITS). */
export function isMoneyUnit(unit: unknown): boolean {
  return typeof unit === "string" && unit.startsWith("money");
}
