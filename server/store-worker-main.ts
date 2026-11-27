// The store's worker thread, as the server runs it (store-client.ts): bundled
// to dist/store-worker.cjs beside the server (build-electron-server.cjs), and
// run from source through store-worker-source.mjs.
import { serveStore, storeDispatch } from "./store-worker";

serveStore(storeDispatch());
