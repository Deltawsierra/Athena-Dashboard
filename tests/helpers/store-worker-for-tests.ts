// The server's worker module (server/store-worker.ts), with its dispatch
// wrapped: one call more, `__sql`, which runs SQL on the store's own
// connection in this thread (store-in-a-test-worker.ts onTheStoresConnection).
// Every other call is the server's.
import { serveStore, storeDispatch, type StoreRequest } from "../../server/store-worker";
import { sqlite } from "../../server/db-sqlite";

const served = storeDispatch();

serveStore(async (request: StoreRequest) => {
  if (request.method !== "__sql") return served(request);
  const [how, text, ...params] = request.args as [string, string, ...unknown[]];
  if (how === "pragma") return sqlite.pragma(text, { simple: true });
  if (how === "run") return sqlite.prepare(text).run(...params).changes;
  if (how === "get") return sqlite.prepare(text).get(...params);
  if (how === "all") return sqlite.prepare(text).all(...params);
  throw new Error(`__sql: no such way to run it: ${how}`);
});
