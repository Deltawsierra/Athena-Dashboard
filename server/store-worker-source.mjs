// The store's worker thread run from source (npm run dev, the tests): the
// TypeScript worker, loaded with tsx, which the source runs on. The bundled
// server runs dist/store-worker.cjs instead (store-worker-file.ts).
import { tsImport } from "tsx/esm/api";

await tsImport("./store-worker-main.ts", import.meta.url);
