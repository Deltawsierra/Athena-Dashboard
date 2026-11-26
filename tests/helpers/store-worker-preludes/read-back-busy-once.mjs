// In the store's worker thread: the read-back after the first insert into
// activity_logs meets SQLITE_BUSY, once. Counted in the shared cell, for the
// test to read: [inserts into activity_logs, busy refusals thrown].
import { workerData } from "worker_threads";
import { createRequire } from "module";

const Database = createRequire(import.meta.url)("better-sqlite3");
const counts = new Int32Array(workerData.readBackBusyOnce);
const proto = Database.prototype;
const realPrepare = proto.prepare;
let armed = false;
proto.prepare = function (sql) {
  const text = String(sql).toLowerCase();
  if (text.startsWith('insert into "activity_logs"')) {
    if (Atomics.add(counts, 0, 1) === 0) armed = true;
  } else if (armed && text.startsWith("select") && text.includes('"activity_logs"')) {
    armed = false;
    Atomics.add(counts, 1, 1);
    const busy = new Error("database is locked");
    busy.code = "SQLITE_BUSY";
    throw busy;
  }
  return realPrepare.call(this, sql);
};
