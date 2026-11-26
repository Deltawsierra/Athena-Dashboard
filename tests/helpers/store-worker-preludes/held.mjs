// A stalled disk, in the store's worker thread (tests/helpers/held-store.ts):
// every statement this thread runs (a statement's run, get, all or iterate, a
// database's exec) waits, before it runs, until the time in the shared cell
// has passed. As each starts to wait it says so, and once it has run, how long
// it was held, on the held store's channel. A flag in the cell ends the thread
// while a statement is held, as a crash would.
import { workerData, BroadcastChannel } from "worker_threads";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const { shared, channel: name } = workerData.held;
const until = new Float64Array(shared, 0, 1);
const flags = new Int32Array(shared, 8, 2);
const channel = new BroadcastChannel(name);
channel.unref();

const hold = (sql) => {
  const startedAt = Date.now();
  if (startedAt >= until[0]) return;
  channel.postMessage({ holding: true });
  while (Date.now() < until[0]) {
    if (Atomics.load(flags, 1) === 1) {
      Atomics.store(flags, 1, 0);
      channel.postMessage({ exiting: Date.now() });
      process.exit(1);
    }
    Atomics.wait(flags, 0, 0, Math.max(1, until[0] - Date.now()));
  }
  channel.postMessage({ held: { startedAt, heldMs: Date.now() - startedAt, sql: String(sql).slice(0, 80), thread: "store" } });
};

const probe = new Database(":memory:");
const statement = Object.getPrototypeOf(probe.prepare("select 1"));
probe.close();
for (const name of ["run", "get", "all", "iterate"]) {
  const original = statement[name];
  statement[name] = function (...args) {
    hold(this.source);
    return original.apply(this, args);
  };
}
const exec = Database.prototype.exec;
Database.prototype.exec = function (source) {
  hold(source);
  return exec.call(this, source);
};
