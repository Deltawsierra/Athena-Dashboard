import Database from "better-sqlite3";

/**
 * A SQLite store held as a stalled disk holds it, deterministically.
 *
 * better-sqlite3 runs every statement on the event loop, synchronously, for as
 * long as the disk takes to answer it: while a slow or stalled disk holds one
 * statement, it holds the whole process -- every request, a Stop included.
 * This does that on purpose, for a test. From `holdFor(ms)` on, every
 * statement this process runs on its main thread (a statement's run, get, all
 * or iterate, and a database's exec) waits, before it runs, until `ms` have
 * passed since the call: a disk that answers nothing for `ms`, then answers.
 * Nothing is held off the main thread (the checkpointer's thread).
 *
 * Each statement held is noted: when it started (Date.now(), the clock a
 * process of its own reads too) and how long it was held. `onHeld` is called
 * once, as the first statement is held, before it waits. `release()` puts
 * better-sqlite3 back as it was.
 */
export interface HeldStore {
  holdFor(ms: number): void;
  held: Array<{ startedAt: number; heldMs: number; sql: string }>;
  onHeld: (() => void) | null;
  release(): void;
}

export function aStoreThatCanBeHeld(): HeldStore {
  const probe = new Database(":memory:");
  // Every statement of every connection in this process is one native class, whichever copy of the module opened it.
  const statement = Object.getPrototypeOf(probe.prepare("select 1")) as Record<string, (...args: unknown[]) => unknown>;
  probe.close();
  const cell = new Int32Array(new SharedArrayBuffer(4));
  let until = 0;
  const store: HeldStore = {
    holdFor(ms) {
      until = Date.now() + ms;
    },
    held: [],
    onHeld: null,
    release() {
      for (const [name, original] of originals) statement[name] = original;
      Database.prototype.exec = exec;
    },
  };
  const hold = (sql: unknown) => {
    const startedAt = Date.now();
    if (startedAt >= until) return;
    const first = store.onHeld;
    store.onHeld = null;
    first?.();
    // Atomics.wait sleeps this thread itself, as a read or write the disk does not answer does.
    while (Date.now() < until) Atomics.wait(cell, 0, 0, until - Date.now());
    store.held.push({ startedAt, heldMs: Date.now() - startedAt, sql: String(sql).slice(0, 80) });
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
