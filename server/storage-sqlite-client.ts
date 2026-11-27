import { MemStorage, type IStorage } from "./storage";
import { StoreClient } from "./store-client";
import { storeWorkerFile } from "./store-worker-file";

/**
 * The SQLite store as the server calls it: a client of the worker thread that
 * runs SqliteStorage (store-client.ts), each call a message. Loaded on the
 * event loop without storage-sqlite.ts, db-sqlite.ts or better-sqlite3, which
 * load and run on the store's thread only (tests/the-event-loop-never-loads-
 * the-sqlite-driver.test.ts).
 *
 * Its methods are on its prototype, one per call of the storage contract the
 * client does not answer itself, named as the memory backend, which defines
 * the whole contract, names them.
 */
export class SqliteStoreClient extends StoreClient {}
for (const name of Object.getOwnPropertyNames(MemStorage.prototype)) {
  if (name === "constructor" || name in StoreClient.prototype) continue;
  Object.defineProperty(SqliteStoreClient.prototype, name, {
    value: function (this: StoreClient, ...args: unknown[]) {
      return this.ask(name, args);
    },
    writable: true,
    configurable: true,
  });
}

/** The worker thread runs the file storeWorkerFile() names: the bundle's own, or the source's (store-worker-file.ts). */
export const storage: IStorage = new SqliteStoreClient(storeWorkerFile());
