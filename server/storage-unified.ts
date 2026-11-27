import type { IStorage } from "./storage";
import { storage as memStorage } from "./storage";
import { storage as sqliteStorage } from "./storage-sqlite-client";

/**
 * Backend selection.
 *
 * SQLite is the default everywhere (development, Electron, production).
 * Set ATHENA_STORAGE=memory to use the in-memory backend, which is intended
 * for automated tests only: nothing survives a restart.
 *
 * The SQLite module is loaded only when it is the chosen backend. Importing it
 * unconditionally opened the database file at module load, so ATHENA_STORAGE=memory
 * still created and locked ./athena.db, and every forked test worker contended
 * on the developer's real database.
 */
const backend = process.env.ATHENA_STORAGE === "memory" ? "memory" : "sqlite";

if (backend === "memory") {
  console.log("[storage] Using in-memory storage (ATHENA_STORAGE=memory). Data will not persist.");
}

export const storage: IStorage = backend === "memory" ? memStorage : sqliteStorage;
