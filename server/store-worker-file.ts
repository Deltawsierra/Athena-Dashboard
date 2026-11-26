import path from "path";
import { fileURLToPath } from "url";

/** The file the store's worker thread runs (store-client.ts), and what it is handed. */
export interface StoreWorkerFile {
  entry: string;
  workerData?: Record<string, unknown>;
}

/**
 * The server's own: dist/store-worker.cjs, beside the bundle, when the server
 * runs bundled (the desktop app; build-electron-server.cjs builds both); the
 * source's bootstrap, store-worker-source.mjs, when it runs from source (npm
 * run dev, the tests).
 */
export function storeWorkerFile(): StoreWorkerFile {
  const here = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  return { entry: here.endsWith(".cjs") ? path.join(dir, "store-worker.cjs") : path.join(dir, "store-worker-source.mjs") };
}
