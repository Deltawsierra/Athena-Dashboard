import { parentPort } from "worker_threads";
import { SqliteStorage, STORE_CALLS, withBusyRetry } from "./storage-sqlite";
import { checkpointer, checkpointerTurns, closeDatabase, openDatabase, openReport, watchCheckpointer } from "./db-sqlite";
import { errorToMessage, STORE_PAGE_ROWS } from "./store-protocol";

/**
 * The store's worker thread: better-sqlite3, the schema and its migrations,
 * the busy line (storage-sqlite.ts withBusyRetry) and the checkpointer
 * thread all live here, off the event loop. The loop's client
 * (store-client.ts) sends each call as a message; here each is started as it
 * arrives, in that order, exactly as the loop used to start them, so a
 * statement the disk holds holds this thread and nothing on the loop.
 * The messages are store-protocol.ts's.
 */

/** One call, as the client sends it. */
export interface StoreRequest {
  id: number;
  method: string;
  args: unknown[];
}

/** What answers a call. A test's worker wraps the server's (tests/helpers/store-worker-for-tests.ts). */
export type StoreDispatch = (request: StoreRequest) => Promise<unknown>;

/** The server's dispatch: SqliteStorage under withBusyRetry, and no call but the ones it defines (STORE_CALLS). */
export function storeDispatch(): StoreDispatch {
  const store = withBusyRetry(new SqliteStorage()) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const known = new Set(STORE_CALLS);
  return async ({ method, args }) => {
    if (!known.has(method)) throw new Error(`the store has no call named ${JSON.stringify(method)}`);
    return store[method](...args);
  };
}

/**
 * Serve the client on this thread's port with `dispatch`: open the database
 * (an open that fails is said, and each call tries again and fails with why,
 * as on the loop before), say so, and answer every call. What opening found
 * and the checkpointer's state go to the loop as they change.
 */
export function serveStore(dispatch: StoreDispatch): void {
  const port = parentPort;
  if (!port) throw new Error("the store's worker runs only as a worker thread");
  // Each part is sent when it changes, and only then: the turns change every second the log is written to.
  const said: Record<string, string> = {};
  const changed = (): Record<string, unknown> | undefined => {
    const parts: Record<string, unknown> = { openReport, checkpointer, checkpointerTurns };
    const out: Record<string, unknown> = {};
    for (const [name, part] of Object.entries(parts)) {
      const now = JSON.stringify(part);
      if (said[name] === now) continue;
      said[name] = now;
      out[name] = JSON.parse(now);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  try {
    openDatabase();
  } catch (cause) {
    console.error(`[db] the database could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  // What opening found goes with `ready`; the checkpointer's state and turns as each changes.
  port.postMessage({ ready: true, mirror: changed() });
  const unwatch = watchCheckpointer(() => {
    const mirror = changed();
    if (mirror) port.postMessage({ mirror });
  });

  const answer = (id: number, result: unknown) => {
    if (Array.isArray(result) && result.length > STORE_PAGE_ROWS) {
      for (let at = 0; at < result.length; at += STORE_PAGE_ROWS) {
        port.postMessage({ id, rows: result.slice(at, at + STORE_PAGE_ROWS), more: at + STORE_PAGE_ROWS < result.length });
      }
      return;
    }
    port.postMessage({ id, result });
  };
  const refuse = (id: number, cause: unknown) => {
    port.postMessage({ id, error: errorToMessage(cause) });
  };

  port.on("message", (message: unknown) => {
    const request = message as Partial<StoreRequest> & { close?: boolean };
    if (request?.close) {
      unwatch();
      void closeDatabase().then(() => port.postMessage({ closed: true }));
      return;
    }
    if (typeof request?.id !== "number" || typeof request.method !== "string" || !Array.isArray(request.args)) return;
    const { id } = request;
    let answered: Promise<unknown>;
    try {
      answered = dispatch(request as StoreRequest);
    } catch (cause) {
      answered = Promise.reject(cause);
    }
    answered.then((result) => {
      try {
        answer(id, result);
      } catch (cause) {
        refuse(id, cause);
      }
    }, (cause) => refuse(id, cause));
  });
}
