import Database from "better-sqlite3";
import { BroadcastChannel } from "worker_threads";
import { prelude, storeInATestWorker } from "./store-in-a-test-worker";

/**
 * A SQLite store held as a stalled disk holds it, deterministically.
 *
 * better-sqlite3 runs each statement synchronously, for as long as the disk
 * takes to answer it: while a slow or stalled disk holds one statement, it
 * holds the thread that runs it. The store runs on a worker thread of its own
 * (server/store-client.ts), so that thread is held, and the event loop is not;
 * a store whose statements ran on the loop (as they did) held the whole
 * process -- every request, a Stop included. This does that on purpose, for a
 * test, on both threads: from `holdFor(ms)` on, every statement the store's
 * thread runs (tests/helpers/store-worker-preludes/held.mjs, in a test worker:
 * tests/helpers/store-in-a-test-worker.ts), and every statement this process
 * runs on its main thread, waits, before it runs (a statement's run, get, all
 * or iterate, and a database's exec), until `ms` have passed since the call: a
 * disk that answers nothing for `ms`, then answers. Nothing is held on the
 * checkpointer's thread. `holdFor(0)` lets a held statement of the store's
 * thread go at once.
 *
 * Each statement held is noted: when it started (Date.now(), the clock a
 * process of its own reads too), how long it was held, and on which thread.
 * `onHeld` is called once, as the first statement is held, before it waits
 * (the store's thread says so as it starts to wait). `endTheStoreThread()`
 * ends the store's thread while a statement of its is held, as a crash would,
 * and answers when it said it was exiting. `release()` puts better-sqlite3
 * and the store's worker file back as they were.
 */
export interface HeldStore {
  holdFor(ms: number): void;
  held: Array<{ startedAt: number; heldMs: number; sql: string; thread?: "store" | "main" }>;
  onHeld: (() => void) | null;
  endTheStoreThread(): Promise<number>;
  release(): void;
}

let made = 0;

export function aStoreThatCanBeHeld(): HeldStore {
  const shared = new SharedArrayBuffer(16);
  const until = new Float64Array(shared, 0, 1);
  const flags = new Int32Array(shared, 8, 2);
  made += 1;
  const name = `athena-held-store-${process.pid}-${made}-${Date.now()}`;
  const channel = new BroadcastChannel(name);
  channel.unref();
  let exited: ((at: number) => void) | null = null;
  const firstHeld = () => {
    const first = store.onHeld;
    store.onHeld = null;
    first?.();
  };
  channel.onmessage = (event) => {
    const said = (event as MessageEvent).data as { holding?: boolean; held?: HeldStore["held"][number]; exiting?: number };
    if (said.holding) firstHeld();
    if (said.held) store.held.push(said.held);
    if (said.exiting !== undefined) exited?.(said.exiting);
  };
  const putBack = storeInATestWorker({ preludes: [prelude("held.mjs")], workerData: { held: { shared, channel: name } } });

  const probe = new Database(":memory:");
  // Every statement of every connection on this thread is one native class, whichever copy of the module opened it.
  const statement = Object.getPrototypeOf(probe.prepare("select 1")) as Record<string, (...args: unknown[]) => unknown>;
  probe.close();
  const store: HeldStore = {
    holdFor(ms) {
      until[0] = Date.now() + ms;
      Atomics.notify(flags, 0);
    },
    held: [],
    onHeld: null,
    endTheStoreThread() {
      return new Promise<number>((said) => {
        exited = said;
        Atomics.store(flags, 1, 1);
        Atomics.notify(flags, 0);
      });
    },
    release() {
      for (const [name, original] of originals) statement[name] = original;
      Database.prototype.exec = exec;
      until[0] = 0;
      Atomics.notify(flags, 0);
      channel.close();
      putBack();
    },
  };
  const hold = (sql: unknown) => {
    const startedAt = Date.now();
    if (startedAt >= until[0]) return;
    firstHeld();
    // Atomics.wait sleeps this thread itself, as a read or write the disk does not answer does.
    while (Date.now() < until[0]) Atomics.wait(flags, 0, 0, Math.max(1, until[0] - Date.now()));
    store.held.push({ startedAt, heldMs: Date.now() - startedAt, sql: String(sql).slice(0, 80), thread: "main" });
  };
  const originals = (["run", "get", "all", "iterate"] as const).map((name) => [name, statement[name]] as const);
  for (const [name, original] of originals) {
    statement[name] = function (this: { source: string }, ...args: unknown[]) {
      hold(this.source);
      return original.apply(this, args);
    };
  }
  const exec = Database.prototype.exec;
  Database.prototype.exec = function (this: Database.Database, source: string) {
    hold(source);
    return exec.call(this, source);
  };
  return store;
}
