import { Worker } from "worker_threads";
import { getTableColumns } from "drizzle-orm";
import * as schema from "@shared/schema";
import type { InsertTest, SampleDataCounts, Test } from "@shared/schema";
import type { IStorage } from "./storage";
import { checkpointer, checkpointerTurns, noteStoreThread, openReport } from "./db-sqlite";
import { errorFromMessage, patiently, readsOnly, STORE_NOT_ANSWERED, STORE_PAGE_ROWS, withAnswerToCome, type StoreErrorMessage } from "./store-protocol";
import type { StoreWorkerFile } from "./store-worker-file";

/**
 * How long a call that only reads waits for the store's answer. One that is
 * not answered in time is refused, and its callers read a refused read as not
 * known -- the kill switch as engaged (shared/kill-switch-flag.ts), an account
 * as unread (auth.ts).
 */
export const STORE_READ_MS = 2_000;
/**
 * How long a write waits for the store's answer. One that is not answered in
 * time is refused, said as not known to be written -- it may land later, when
 * the disk answers -- and is never sent again.
 */
export const STORE_WRITE_MS = 10_000;
/**
 * How long the worker thread may take to start: to load, open the database
 * and bring its schema up to date. A call made meanwhile waits for it (its
 * own time starts once the thread has started), and is refused once this has
 * passed, unsent; the thread goes on starting, and the calls made once it has
 * are answered.
 */
export const STORE_START_MS = 30_000;
/**
 * How many times updateTestWith works its change out, each from the row as it
 * then stands, before it gives up, writing nothing, because another writer
 * changed the row every time in between.
 */
export const STORE_CHANGE_TRIES = 8;

/**
 * How the bundle's CommonJS worker (store-worker-file.ts) is started: required
 * from a script, as the checkpointer's thread requires better-sqlite3 -- inside
 * the desktop app's asar archive, require is what reads. A module (the
 * source's) is started as the thread's own file: a script's globals
 * (`__filename` is "[worker eval]") would reach it.
 */
const REQUIRE_THE_ENTRY = `require(require("worker_threads").workerData.entry);`;

type Call = {
  id: number;
  method: string;
  args: unknown[];
  write: boolean;
  resolve: (value: unknown) => void;
  reject: (cause: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  rows: unknown[] | null;
  /** Answered, or refused: an answer that comes later is still learnt from, and settles nothing. */
  settled: boolean;
  /** A read refused for its time: the answer still to come, for a caller that waits it out (patiently). */
  late: { resolve: (value: unknown) => void; reject: (cause: unknown) => void } | null;
};

type Thread = {
  worker: Worker;
  ready: boolean;
  /** STORE_START_MS passed before it started: calls are refused until it has. */
  startLate: boolean;
  startTimer: ReturnType<typeof setTimeout> | null;
  /** Calls made before the thread started, sent in the order they were made once it has. */
  waiting: Call[];
  /** Calls sent, by id, until their answer comes or the thread ends. */
  pending: Map<number, Call>;
  /** Why it ended, when an error ended it. */
  failed: string | null;
  closing: boolean;
  closed: (() => void) | null;
  ending: Promise<void> | null;
};

/** The tests table's columns: an answer that is a row of it (or a list of them) is a test this process now holds. */
const TEST_COLUMNS = Object.keys(getTableColumns(schema.tests));

function isTest(value: unknown): value is Test {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === TEST_COLUMNS.length && TEST_COLUMNS.every((key) => key in value);
}

type Mirror = { openReport?: typeof openReport; checkpointer?: typeof checkpointer; checkpointerTurns?: typeof checkpointerTurns };

/** What the worker thread's database reports, held here as the event loop reads it (db-sqlite.ts openReport, checkpointer). */
function mirror(said: Mirror): void {
  if (said.openReport) Object.assign(openReport, said.openReport);
  if (said.checkpointer) Object.assign(checkpointer, said.checkpointer);
  if (said.checkpointerTurns) {
    checkpointerTurns.counts = { ...said.checkpointerTurns.counts };
    checkpointerTurns.last = said.checkpointerTurns.last;
  }
}

function refusal(message: string): Error {
  return Object.assign(new Error(message), { code: STORE_NOT_ANSWERED });
}

/**
 * The SQLite store, on a worker thread of its own, as the event loop calls it.
 *
 * better-sqlite3 runs each statement synchronously, for as long as the disk
 * takes to answer it. On the event loop, a statement a slow or stalled disk
 * held -- a page's read, a findings write, a background note -- held every
 * request with it: a Stop that arrived 100 ms after a statement held 3 s
 * reached the engine after 2908-2934 ms (DASH-STORE-OFF-THE-LOOP). Here the
 * statements run on the store's own thread (server/store-worker.ts), and the
 * loop sends each call as a message and goes on: measured, a Stop answered in
 * 6 ms while the thread's statement was held 3 s, at about 0.05 ms a call.
 *
 *   - One thread, and the calls go to it in the order they are made; it
 *     starts each as it arrives, as the loop did, so the busy line's order
 *     (storage-sqlite.ts BusyLine) and every transaction are as they were.
 *   - What the worker answers that holds tests is remembered here (peekTest,
 *     peekAllTests) -- the whole table, once it is read (the app reads it as
 *     it starts: routes.ts) -- so a Stop finds the run it names without a call.
 *   - A list of more than STORE_PAGE_ROWS rows comes a page a message, the
 *     tests table a page a call: a message is read whole, in one turn.
 *   - Every call has a time (STORE_READ_MS, STORE_WRITE_MS): a read not
 *     answered in time is refused, and read as not known; a write is refused
 *     as not known to be written, and never sent again.
 *   - A thread that ends refuses every call it held, at once, as not known
 *     (to be written); the next call starts a new one. Nothing is retried.
 *   - updateTestWith's change runs here, on the loop, by compare and swap
 *     (updateTestWith).
 *
 * The worker's file is handed in (storeWorkerFile(), store-worker-file.ts):
 * the server's own, or a test's, which wraps it.
 */
export interface StoreClient extends IStorage {}
export class StoreClient {
  private thread: Thread | null = null;
  private seq = 0;
  private testCache = new Map<string, Test>();
  private testsListed = false;

  constructor(private readonly file: StoreWorkerFile) {}

  /**
   * One call of the store, by name, answered by the worker thread: what each
   * method the client does not answer itself forwards to
   * (storage-sqlite.ts SqliteStoreClient).
   */
  ask(method: string, args: unknown[]): Promise<unknown> {
    return this.call(method, args, true);
  }

  /**
   * A call, made now. In line (`inLine`), it goes after every updateTestWith
   * made before it has sent its write (the line below); not in line, it is
   * one of those writes' own calls, and goes at once.
   */
  private call(method: string, args: unknown[], inLine: boolean): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.seq += 1;
      const call: Call = { id: this.seq, method, args, write: !readsOnly(method), resolve, reject, timer: null, rows: null, settled: false, late: null };
      if (!inLine || this.line === null) {
        this.dispatch(call);
        return;
      }
      // Waiting in line, it has its time from now, as it would have waiting on the thread.
      const timer = setTimeout(() => this.refuse(call, `the store did not take it within ${(call.write ? STORE_WRITE_MS : STORE_READ_MS) / 1000} s`, false),
        call.write ? STORE_WRITE_MS : STORE_READ_MS);
      this.line.push(() => {
        clearTimeout(timer);
        if (!call.settled) this.dispatch(call);
      });
    });
  }

  private dispatch(call: Call): void {
    const thread = this.thread ?? this.start();
    if (thread.ready) {
      this.send(thread, call);
    } else if (thread.startLate) {
      this.refuse(call, `the store's worker thread has not started within ${STORE_START_MS / 1000} s`, false);
    } else {
      thread.waiting.push(call);
      thread.worker.ref();
    }
  }

  /**
   * The calls made while an updateTestWith is between its read and its
   * write, in the order they were made, or null when none is: they are sent
   * once its write has been. On the event loop its step was one transaction,
   * made when it was called, and every call made after it saw its write; the
   * read and the write are two messages now, and a call sent between them
   * would not (a record read the moment the watch that filed it said so, say).
   */
  private line: Array<() => void> | null = null;

  /** Take the line for one updateTestWith: resolved at its turn, and the line is held until `open()`. */
  private takeTheLine(): Promise<() => void> {
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      const waiting = this.line ?? [];
      this.line = null;
      // In order, until one of them takes the line again: the rest wait for that one.
      while (waiting.length > 0 && this.line === null) waiting.shift()!();
      if (waiting.length > 0) this.line = [...waiting, ...(this.line ?? [])];
    };
    if (this.line === null) {
      this.line = [];
      return Promise.resolve(open);
    }
    return new Promise((turn, refused) => {
      let gone = false;
      const timer = setTimeout(() => {
        gone = true;
        refused(refusal(`the store did not take it within ${STORE_WRITE_MS / 1000} s: updateTestWith, not sent, and not written`));
      }, STORE_WRITE_MS);
      this.line!.push(() => {
        clearTimeout(timer);
        if (gone) return;
        this.line = [];
        turn(open);
      });
    });
  }

  peekTest(id: string): Test | undefined {
    const test = this.testCache.get(id);
    return test ? { ...test } : undefined;
  }
  peekAllTests(): Test[] | null {
    return this.testsListed ? Array.from(this.testCache.values()).map((one) => ({ ...one })) : null;
  }

  /**
   * Every test, a page a call (SqliteStorage.getTestsPage): no message
   * carries more than STORE_PAGE_ROWS of them, and each page has its own
   * time. What it read is what this process holds from now on.
   */
  getAllTests(): Promise<Test[]> {
    type Page = { rows: Test[]; lastRowid: number | null };
    const rows: Test[] = [];
    // Held a page at a time, as each page comes, and put in place whole at the end: built in one step, 60,000 rows
    // held the loop 30-36 ms.
    const held = new Map<string, Test>();
    let after = 0;
    /** Whether that was the last page. */
    const take = (page: Page): boolean => {
      for (const row of page.rows) {
        rows.push(row);
        held.set(row.id, { ...row });
      }
      if (page.lastRowid === null || page.rows.length < STORE_PAGE_ROWS) return true;
      after = page.lastRowid;
      return false;
    };
    const done = (): Test[] => {
      this.testCache = held;
      this.testsListed = true;
      return rows;
    };
    const rest = async (waitedOut: boolean): Promise<Test[]> => {
      for (;;) {
        const asked = this.ask("getTestsPage", [after]) as Promise<Page>;
        if (take(await (waitedOut ? patiently(asked) : asked))) return done();
      }
    };
    // A page refused for its time refuses the read; the read waited out goes on from that page's answer (patiently).
    return rest(false).catch((cause: unknown) => {
      const answer = (cause as { answer?: Promise<Page> } | null)?.answer;
      if (cause instanceof Error && answer instanceof Promise) {
        throw withAnswerToCome(cause, answer.then((page) => (take(page) ? done() : rest(true))));
      }
      throw cause;
    });
  }

  /**
   * Change a test from the row as it is when the change lands, by compare
   * and swap: `change` runs here, on the event loop, against the row the
   * worker read, and the worker writes what it answers only if the row is
   * still that one (SqliteStorage.updateTestIfUnchanged: compared and written
   * in one IMMEDIATE transaction). If another writer changed the row in
   * between, the worker answers the row as it now stands and `change` is run
   * again, from that row -- at most STORE_CHANGE_TRIES times, then nothing is
   * written and the call is refused. `change` is handed a copy, and may be run
   * more than once (server/storage.ts IStorage.updateTestWith).
   */
  async updateTestWith(id: string, change: (test: Test) => Partial<InsertTest> | null): Promise<Test | undefined> {
    // Calls made from now on go after this one's write (the line, above).
    const open = await this.takeTheLine();
    try {
      let row = (await this.call("getTest", [id], false)) as Test | undefined;
      for (let tries = 1; ; tries += 1) {
        if (!row) return undefined;
        const updates = change(structuredClone(row));
        if (updates === null || Object.values(updates).every((value) => value === undefined)) return row;
        const writing = this.call("updateTestIfUnchanged", [id, row, updates], false);
        open();
        const outcome = (await writing) as { written: boolean; row: Test | undefined };
        if (outcome.row) this.remember(outcome.row);
        if (outcome.written) return outcome.row;
        if (tries >= STORE_CHANGE_TRIES) {
          throw new Error(`test ${id} was changed by another writer each of the ${tries} times this change was worked out; nothing was written`);
        }
        row = outcome.row;
      }
    } finally {
      open();
    }
  }

  async deleteTest(id: string): Promise<boolean> {
    const removed = (await this.ask("deleteTest", [id])) as boolean;
    this.testCache.delete(id);
    return removed;
  }

  async deleteClient(id: string): Promise<boolean> {
    const { removed, testIds } = (await this.ask("deleteClientWithItsTests", [id])) as { removed: boolean; testIds: string[] };
    // Only the tests that went are forgotten; every other test stays in
    // memory, so a Stop still finds its run without a call.
    this.forgetSomeTests((test) => test.clientId === id || testIds.includes(test.id));
    return removed;
  }

  async removeSampleData(): Promise<SampleDataCounts> {
    const removed = (await this.ask("removeSampleData", [])) as SampleDataCounts;
    this.forgetSomeTests((test) => test.isSample === true);
    return removed;
  }

  /**
   * End the worker thread: it closes the database (its checkpointer thread,
   * its connection), and then it is ended; the next call starts a new one.
   * For tests, through db-sqlite.ts closeDatabase, which removes the files
   * afterwards (Windows will not remove an open file). Never throws.
   */
  close(): Promise<void> {
    return this.thread ? this.end(this.thread) : Promise.resolve();
  }

  private end(thread: Thread): Promise<void> {
    if (this.thread === thread) this.thread = null;
    if (thread.ending) return thread.ending;
    thread.closing = true;
    thread.ending = new Promise<void>((done) => {
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        thread.worker.terminate().then(() => done(), () => done());
      };
      // A thread whose statement the disk holds may not get to it: it is ended anyway.
      const timer = setTimeout(end, 5_000);
      thread.closed = end;
      try {
        thread.worker.postMessage({ close: true });
      } catch {
        end();
      }
    });
    return thread.ending;
  }

  private remember(test: Test): void {
    this.testCache.set(test.id, { ...test });
  }

  /** Every test an answer carries is held from now on, as the store answered it. */
  private learn(result: unknown): void {
    if (isTest(result)) this.remember(result);
    else if (Array.isArray(result)) for (const one of result) if (isTest(one)) this.remember(one);
  }

  /**
   * Forget the tests a delete removed -- those alone -- and read the list
   * again in the background, so what this process holds matches the record
   * without anything waiting on it: a Stop answers from what is held (never
   * from a refill), and a refill that fails leaves the list as it was.
   */
  private forgetSomeTests(gone: (test: Test) => boolean): void {
    for (const [id, test] of Array.from(this.testCache.entries())) {
      if (gone(test)) this.testCache.delete(id);
    }
    if (this.testsListed) setImmediate(() => void this.getAllTests().catch(() => undefined));
  }

  private start(): Thread {
    const workerData = { ...(this.file.workerData ?? {}), entry: this.file.entry };
    const worker = /\.c?js$/.test(this.file.entry)
      ? new Worker(REQUIRE_THE_ENTRY, { eval: true, workerData })
      : new Worker(this.file.entry, { workerData });
    const thread: Thread = {
      worker, ready: false, startLate: false, startTimer: null, waiting: [], pending: new Map(), failed: null, closing: false, closed: null, ending: null,
    };
    this.thread = thread;
    thread.startTimer = setTimeout(() => {
      thread.startTimer = null;
      thread.startLate = true;
      const waiting = thread.waiting;
      thread.waiting = [];
      for (const call of waiting) this.refuse(call, `the store's worker thread did not start within ${STORE_START_MS / 1000} s`, false);
      this.idle(thread);
    }, STORE_START_MS);
    const forget = noteStoreThread(() => this.end(thread));
    worker.on("message", (message: unknown) => this.answer(thread, message));
    worker.on("error", (cause: unknown) => {
      thread.failed = cause instanceof Error ? cause.message : String(cause);
    });
    worker.on("exit", (code: number) => {
      forget();
      if (thread.startTimer) clearTimeout(thread.startTimer);
      if (this.thread === thread) this.thread = null;
      const why = thread.closing ? "it was closed" : thread.failed ? `it failed: ${thread.failed}` : `it exited with code ${code}`;
      const waiting = thread.waiting;
      thread.waiting = [];
      for (const call of waiting) this.refuse(call, `the store's worker thread ended before it started (${why})`, false);
      for (const call of Array.from(thread.pending.values())) {
        if (call.timer) clearTimeout(call.timer);
        if (!call.settled) this.refuse(call, `the store's worker thread ended before it answered (${why})`, true);
        call.late?.reject(refusal(`the store's worker thread ended before it answered (${why}): ${call.method}, what it reads is not known`));
      }
      thread.pending.clear();
      if (!thread.closing) console.error(`[db] the store's worker thread ended (${why}); the next call starts a new one`);
    });
    return thread;
  }

  private send(thread: Thread, call: Call): void {
    thread.pending.set(call.id, call);
    thread.worker.ref();
    call.timer = setTimeout(() => {
      call.timer = null;
      if (call.settled) return;
      this.refuse(call, `the store did not answer within ${(call.write ? STORE_WRITE_MS : STORE_READ_MS) / 1000} s`, true, !call.write);
      this.idle(thread);
    }, call.write ? STORE_WRITE_MS : STORE_READ_MS);
    try {
      thread.worker.postMessage({ id: call.id, method: call.method, args: call.args });
    } catch (cause) {
      thread.pending.delete(call.id);
      clearTimeout(call.timer);
      call.settled = true;
      call.reject(cause);
      this.idle(thread);
    }
  }

  /** Refuse a call the store did not answer: a read as not known, a write as not known to be written (or not written, when it was never sent). */
  private refuse(call: Call, why: string, sent: boolean, answerToCome = false): void {
    if (call.settled) return;
    call.settled = true;
    const what = !call.write ? "what it reads is not known" : sent ? "not known to be written" : "not sent, and not written";
    const refused = refusal(`${why}: ${call.method}, ${what}`);
    // A read still on the thread: its answer, when it comes, for a caller that waits it out (patiently).
    if (answerToCome) {
      withAnswerToCome(refused, new Promise((resolve, reject) => {
        call.late = { resolve, reject };
      }));
    }
    call.reject(refused);
  }

  private answer(thread: Thread, message: unknown): void {
    if (message === null || typeof message !== "object") return;
    const said = message as {
      ready?: boolean; closed?: boolean; mirror?: Mirror; id?: number;
      result?: unknown; error?: StoreErrorMessage; rows?: unknown[]; more?: boolean;
    };
    if (said.mirror) mirror(said.mirror);
    if (said.ready) {
      thread.ready = true;
      if (thread.startTimer) clearTimeout(thread.startTimer);
      thread.startTimer = null;
      thread.startLate = false;
      const waiting = thread.waiting;
      thread.waiting = [];
      for (const call of waiting) if (!call.settled) this.send(thread, call);
      this.idle(thread);
      return;
    }
    if (said.closed) {
      thread.closed?.();
      return;
    }
    if (typeof said.id !== "number") return;
    const call = thread.pending.get(said.id);
    if (!call) return;
    // Answered: its time no longer runs, whatever of the answer is still to come.
    if (call.timer) {
      clearTimeout(call.timer);
      call.timer = null;
    }
    let result: unknown;
    if (said.rows) {
      (call.rows ??= []).push(...said.rows);
      if (said.more) return;
      result = call.rows;
    } else if (said.error) {
      thread.pending.delete(call.id);
      const failed = errorFromMessage(said.error);
      if (!call.settled) {
        call.settled = true;
        call.reject(failed);
      }
      call.late?.reject(failed);
      this.idle(thread);
      return;
    } else {
      result = said.result;
    }
    thread.pending.delete(call.id);
    this.learn(result);
    if (!call.settled) {
      call.settled = true;
      call.resolve(result);
    }
    call.late?.resolve(result);
    this.idle(thread);
  }

  /** With no call waiting on it, the thread keeps the process alive no longer. */
  private idle(thread: Thread): void {
    if (thread.waiting.length > 0) return;
    for (const call of Array.from(thread.pending.values())) if (!call.settled) return;
    thread.worker.unref();
  }
}
