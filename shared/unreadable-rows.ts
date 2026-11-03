/**
 * Rows of a list the backend served that could not be read: counted, never
 * dropped unsaid, and never the reason a whole read fails (DASH-ROWS,
 * DASH-FAILSAFE-ROWS).
 *
 * The server reads every list the backend serves through rowsOf: each row that
 * is a plain object is handed on, and each that is not is counted under the
 * list's name. A screen says "N rows could not be read" beside the list
 * (client/src/components/authority/parts.tsx UnreadableRows). What such a row
 * held is not shown: it could not be read.
 *
 * It has no imports, so the failsafe module (server/failsafe.ts, the stop
 * lane's reads) and the assurance reads share it without either loading the
 * other.
 */

/** How many rows of each list could not be read, by the list's name here; or NOT_A_LIST. */
export type UnreadableRows = Record<string, number | typeof NOT_A_LIST>;

/**
 * What `unreadable[list]` holds when the value served for the list is there
 * but is not a list at all (a string, a number, a record, true): the whole list
 * could not be read, so how many rows it held is not known. A screen says "The
 * list could not be read", never that it is empty. A list the answer did not
 * carry (absent, or null) is not counted: it was not served, and reads as it
 * always did.
 */
export const NOT_A_LIST = "not a list";

/** `{ unreadable }` when a row of some list could not be read; nothing when every row was. */
export function withUnreadable(unreadable: UnreadableRows): { unreadable?: UnreadableRows } {
  return Object.keys(unreadable).length > 0 ? { unreadable } : {};
}

/**
 * Every element of a list that is a plain object. Each element that is not one
 * is counted in `unreadable[list]`, never dropped silently. A value that is
 * served but is not a list reads as no rows, and `unreadable[list]` says the
 * whole list could not be read (NOT_A_LIST), so it never reads as empty. A list
 * not served (absent, or null) is [] and is not counted. Never throws.
 */
export function rowsOf(raw: unknown, unreadable: UnreadableRows, list: string): Record<string, unknown>[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) unreadable[list] = NOT_A_LIST;
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  let unread = 0;
  for (const one of raw) {
    if (!!one && typeof one === "object" && !Array.isArray(one)) rows.push(one as Record<string, unknown>);
    else unread += 1;
  }
  const before = unreadable[list];
  // A list already found not to be one stays so: its count is not known.
  if (unread > 0 && before !== NOT_A_LIST) unreadable[list] = (before ?? 0) + unread;
  return rows;
}

/**
 * The header a bare-list answer carries its count in (the failsafe command list
 * and audit trail: GET /api/failsafe/commands, /api/failsafe/audit). Their body
 * stays the array it always was, so a console page loaded before the server
 * was updated still reads it; the page's own query reads the count from here
 * (client/src/lib/queryClient.ts, `meta.unreadableRows`). Sent only when a row
 * could not be read. Its value is the count as JSON: {"events": 2}.
 */
export const UNREADABLE_ROWS_HEADER = "X-Athena-Unreadable-Rows";

/** The header's value for a count; null when every row was read (no header is sent). */
export function unreadableHeaderValue(unreadable: UnreadableRows): string | null {
  return Object.keys(unreadable).length > 0 ? JSON.stringify(unreadable) : null;
}

/**
 * The count a header carried, as UnreadableRows; undefined when there was no
 * header. A header that is there but cannot be read is not dropped: it reads as
 * `{ [fallback]: NOT_A_LIST }`, so the list is said to be unread, never whole.
 */
export function unreadableFromHeader(raw: string | null | undefined, fallback: string): UnreadableRows | undefined {
  if (raw === null || raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { [fallback]: NOT_A_LIST };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { [fallback]: NOT_A_LIST };
  const out: UnreadableRows = {};
  for (const [list, count] of Object.entries(parsed as Record<string, unknown>)) {
    if (count === NOT_A_LIST) out[list] = NOT_A_LIST;
    else if (typeof count === "number" && Number.isFinite(count) && count >= 1) out[list] = Math.floor(count);
    else out[list] = NOT_A_LIST;
  }
  return Object.keys(out).length > 0 ? out : { [fallback]: NOT_A_LIST };
}
