// The store's worker thread as a test runs it (store-in-a-test-worker.ts): the
// test's preludes first, in this thread (a stalled disk, a fault), then the
// server's worker module, with its dispatch wrapped (store-worker-for-tests.ts),
// loaded with tsx as the server's source bootstrap is.
import { workerData } from "worker_threads";
import { tsImport } from "tsx/esm/api";

for (const prelude of workerData.preludes ?? []) await import(prelude);
await tsImport("./store-worker-for-tests.ts", import.meta.url);
