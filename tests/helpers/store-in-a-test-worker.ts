import path from "path";
import { pathToFileURL } from "url";
import { vi } from "vitest";
import type { StoreClient } from "../../server/store-client";

/**
 * The store's worker thread, as a test runs it.
 *
 * The server's store runs on a worker thread of its own (server/store-client.ts),
 * and the client is handed the file that thread runs when it is made
 * (server/store-worker-file.ts storeWorkerFile; dependency injection, nothing
 * in the server branches on a test). From this call on, every server module
 * loaded -- after each `vi.resetModules()` too -- hands its client this file
 * instead: tests/helpers/store-worker-for-tests.mjs, which runs `preludes` in
 * the store's thread first (a test's own patches there: a stalled disk, a
 * fault), and then the server's worker module with its dispatch wrapped
 * (store-worker-for-tests.ts). `workerData` reaches the preludes. The answer
 * puts the server's own file back.
 */
const FILE = path.resolve(__dirname, "../../server/store-worker-file.ts");
const ENTRY = path.resolve(__dirname, "store-worker-for-tests.mjs");

export function storeInATestWorker(options: { preludes?: string[]; workerData?: Record<string, unknown> } = {}): () => void {
  const preludes = (options.preludes ?? []).map((one) => pathToFileURL(one).href);
  vi.doMock(FILE, () => ({
    storeWorkerFile: () => ({ entry: ENTRY, workerData: { ...(options.workerData ?? {}), preludes } }),
  }));
  return () => vi.doUnmock(FILE);
}

/** A prelude's file, by its name under tests/helpers/store-worker-preludes. */
export function prelude(name: string): string {
  return path.resolve(__dirname, "store-worker-preludes", name);
}

/**
 * SQL run on the store's own connection, in its thread, by a test worker
 * (store-worker-for-tests.ts): `pragma` answers the value, `run` the rows
 * changed, `get` and `all` the rows.
 */
export function onTheStoresConnection(
  storage: unknown, how: "pragma" | "run" | "get" | "all", sql: string, ...params: unknown[]
): Promise<unknown> {
  return (storage as StoreClient).ask("__sql", [how, sql, ...params]);
}
