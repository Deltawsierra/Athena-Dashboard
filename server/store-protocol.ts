import { DuplicateBackendScan, DuplicateRetestCheck } from "./storage";

/**
 * What the store's worker thread (server/store-worker.ts) and its client on
 * the event loop (server/store-client.ts) say to each other.
 *
 *   loop -> worker   {id, method, args}: one store call; {close: true}: close
 *                    the database and say so ({closed: true}).
 *   worker -> loop   {ready: true, mirror}: the database is open and calls are
 *                    taken; {id, result} or {id, error}: a call's answer; a
 *                    list of more than STORE_PAGE_ROWS rows comes as
 *                    {id, rows, more}, a page a message, `more` false on the
 *                    last; {mirror}: the checkpointer's state and turns,
 *                    whenever they change (what opening the database found,
 *                    openReport, comes with `ready`).
 */

/**
 * The most rows one message carries. A message is read whole, in one turn
 * of the event loop, and 60,000 test rows in one held the loop 169-180 ms to
 * read (DASH-STORE-OFF-THE-LOOP, option A); a page this size is read in a few
 * milliseconds, so a Stop waits behind one page at most. It is the tests
 * table's page too (SqliteStorage.getTestsPage).
 */
export const STORE_PAGE_ROWS = 1000;

/** The code of the error a call is refused with when the store did not answer it, in time or at all (store-client.ts). */
export const STORE_NOT_ANSWERED = "STORE_NOT_ANSWERED";

/**
 * Calls that only read. Under WAL a read never waits for the write lock, so
 * one never queues behind the writes that do (storage-sqlite.ts BusyLine); and
 * a read the store does not answer in time is read as not known, where a write
 * is said as not known to be written (store-client.ts).
 */
export function readsOnly(property: PropertyKey): boolean {
  return typeof property === "string" && /^(get|find|count|filed)[A-Z]/.test(property);
}

/** An error as it crosses between the threads: structured clone keeps neither an Error's class nor its `code`. */
export interface StoreErrorMessage {
  name: string;
  message: string;
  code?: string;
  /** The storage contract's own errors (server/storage.ts), which callers tell apart by class. */
  kind?: "DuplicateBackendScan" | "DuplicateRetestCheck";
}

export function errorToMessage(cause: unknown): StoreErrorMessage {
  if (!(cause instanceof Error)) return { name: "Error", message: String(cause) };
  const code = (cause as { code?: unknown }).code;
  return {
    name: cause.name,
    message: cause.message,
    ...(typeof code === "string" ? { code } : {}),
    ...(cause instanceof DuplicateBackendScan ? { kind: "DuplicateBackendScan" as const } : {}),
    ...(cause instanceof DuplicateRetestCheck ? { kind: "DuplicateRetestCheck" as const } : {}),
  };
}

export function errorFromMessage(said: StoreErrorMessage): Error {
  if (said.kind === "DuplicateBackendScan") return new DuplicateBackendScan(said.message);
  if (said.kind === "DuplicateRetestCheck") return new DuplicateRetestCheck(said.message);
  const error = new Error(said.message) as Error & { code?: string };
  error.name = said.name;
  if (said.code !== undefined) error.code = said.code;
  return error;
}

/**
 * A read on a stop's path, waited out. A call the store does not answer in
 * time is refused (store-client.ts STORE_READ_MS), and its callers read it as
 * not known -- but a stop that needs the read (a scan's Stop for a test this
 * process never read, the kill switch's read of the tests table, an API key's
 * Stop: their own reads, each before it can send) cannot send without it, and
 * a read refused for being slow would drop the stop where a slow read only
 * delayed it. The refusal carries the store's answer still to come
 * (`answer`); this waits for it, as the stop waited for the read before. A
 * read that failed, or a store whose thread ended, fails as it did.
 */
export function patiently<T>(read: Promise<T>): Promise<T> {
  return read.catch((cause: unknown) => {
    const answer = (cause as { answer?: Promise<T> } | null)?.answer;
    if (answer instanceof Promise) return answer;
    throw cause;
  });
}

/** Give a refusal the answer still to come, for patiently(); one no caller waits for fails no one. */
export function withAnswerToCome(refused: Error, answer: Promise<unknown>): Error {
  answer.catch(() => undefined);
  Object.defineProperty(refused, "answer", { value: answer, enumerable: false, configurable: true, writable: true });
  return refused;
}
