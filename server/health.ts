/**
 * What this deployment can measure about itself, and what it cannot.
 *
 * The AI Health screen used to read a single row written by the installer:
 * 24% CPU, 41% memory, a 98% success rate, 94% detection accuracy and a 3%
 * false-positive rate. Nothing measured any of it, nothing ever wrote a
 * second row, and the screen graded itself "excellent" off three of those
 * constants. On a screen whose whole purpose is to report measurements, and
 * where detection accuracy and the false-positive rate are the two figures a
 * customer would most want to trust.
 *
 * So this measures the machine and counts the record, and returns null for
 * everything else. Detection accuracy and the false-positive rate stay null:
 * single figures with no run and no commit behind them. What this reads
 * instead is the engine's own run of its detection benchmark, from its
 * /health: the two numbers together, attacks caught and legitimate work let
 * through, for the tuned and the holdout corpus, with the run, the commit and
 * the time they came from. Beside it is the different measurement before it,
 * so a change that raised one number and lowered the other shows as exactly
 * that. Where the engine has no such measurement, or said something this
 * cannot read, the reading holds no number and says why.
 */

import os from "os";
import { storage } from "./storage-unified";
import * as engine from "./engine";
import type {
  BenchmarkReading, EngineMeasurement, InsertAIHealthMetric, MeasuredPair,
} from "@shared/schema";

/** How often a sample is written while the server is running. */
const SAMPLE_EVERY_MS = 60_000;

/**
 * A rolling mean of this server's own API response times.
 *
 * Bounded and reset each sample, so it describes the last interval rather
 * than the whole uptime -- an average since boot stops moving after a day and
 * a number that cannot change is not a monitor.
 */
let responseTotalMs = 0;
let responseCount = 0;

export function recordResponseTime(ms: number): void {
  responseTotalMs += ms;
  responseCount += 1;
}

function takeAverageResponseTime(): number | null {
  if (responseCount === 0) return null;
  const mean = Math.round(responseTotalMs / responseCount);
  responseTotalMs = 0;
  responseCount = 0;
  return mean;
}

/**
 * Process CPU as a percentage of one core, over the interval since the last
 * call. process.cpuUsage() is cumulative microseconds, so a single reading is
 * "CPU since boot" and says nothing about now.
 */
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

function cpuPercent(): number {
  const now = Date.now();
  const delta = process.cpuUsage(lastCpu);
  const elapsedMs = Math.max(1, now - lastCpuAt);
  lastCpu = process.cpuUsage();
  lastCpuAt = now;
  const usedMs = (delta.user + delta.system) / 1000;
  const cores = Math.max(1, os.cpus().length);
  return Math.max(0, Math.min(100, Math.round((usedMs / (elapsedMs * cores)) * 100)));
}

function memoryPercent(): number {
  const total = os.totalmem();
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((process.memoryUsage().rss / total) * 100)));
}

/** The longest reason from the engine that is kept. Its reasons are sentences, not logs. */
const MAX_REASON = 300;

/** The widest gap allowed between a rate and its own counts: the engine rounds rates to four places. */
const RATE_SLACK = 0.0001;

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** What a reading holds of the engine's benchmark: a measurement, or why there is none. */
export type BenchmarkReport = { measurement: EngineMeasurement } | { unmeasured: string };

class Unreadable extends Error {}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_REASON ? `${flat.slice(0, MAX_REASON - 1)}…` : flat;
}

function countOf(raw: Record<string, unknown>, label: string, key: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Unreadable(`the ${label} pair's ${key} is not a count`);
  }
  return value;
}

function rateOf(raw: Record<string, unknown>, label: string, key: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Unreadable(`the ${label} pair's ${key} is not a rate`);
  }
  return value;
}

/** One pair, read as the engine sends it, and checked against its own counts. */
function pairOf(raw: unknown, label: string): MeasuredPair {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Unreadable(`the ${label} pair is not an object`);
  const pair = raw as Record<string, unknown>;
  const attacks = countOf(pair, label, "attacks");
  const caught = countOf(pair, label, "caught");
  const legitimate = countOf(pair, label, "legitimate");
  const flagged = countOf(pair, label, "flagged");
  if (caught > attacks || flagged > legitimate) throw new Unreadable(`the ${label} pair counts more cases than it measured`);
  // A share of nothing is not a rate, whatever number is sent with it.
  if (attacks === 0 || legitimate === 0) throw new Unreadable(`the ${label} pair was measured over no cases of one kind`);
  const securityRetained = rateOf(pair, label, "security_retained");
  const utilityRetained = rateOf(pair, label, "utility_retained");
  if (Math.abs(securityRetained - caught / attacks) > RATE_SLACK) {
    throw new Unreadable(`the ${label} pair's security_retained is not ${caught} of ${attacks}`);
  }
  if (Math.abs(utilityRetained - (1 - flagged / legitimate)) > RATE_SLACK) {
    throw new Unreadable(`the ${label} pair's utility_retained is not ${flagged} of ${legitimate} flagged`);
  }
  return { securityRetained, utilityRetained, attacks, caught, legitimate, flagged };
}

function reasonOf(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Unreadable(`${field} gives no reason`);
  return clip(value);
}

function measurementOf(block: Record<string, unknown>): EngineMeasurement {
  const run = block.run;
  if (typeof run !== "string" || run.trim() === "" || run.length > 200) throw new Unreadable("it names no run");
  const measuredAt = block.measured_at;
  if (typeof measuredAt !== "string" || Number.isNaN(Date.parse(measuredAt))) {
    throw new Unreadable("it does not say when it was measured");
  }
  const commit = block.commit;
  if (commit !== null && (typeof commit !== "string" || !COMMIT_ID.test(commit))) {
    throw new Unreadable("its commit is not a commit id");
  }
  const modified = block.commit_modified;
  if (modified !== null && typeof modified !== "boolean") throw new Unreadable("commit_modified is not true, false or null");
  const holdout = block.holdout === null ? null : pairOf(block.holdout, "holdout");
  return {
    run,
    measuredAt,
    commit,
    commitModified: commit === null ? null : modified,
    commitUnknown: commit === null ? reasonOf(block.commit_unknown, "a missing commit") : null,
    tuned: pairOf(block.tuned, "tuned"),
    holdout,
    holdoutUnmeasured: holdout === null ? reasonOf(block.holdout_unmeasured, "a missing holdout pair") : null,
  };
}

/**
 * The engine's benchmark, as its /health reported it: a measurement, or why
 * this reading holds none. Never a number the engine did not send, and never
 * one read from a report whose parts do not agree.
 */
export function readBenchmark(status: engine.EngineStatus): BenchmarkReport {
  if (!status.configured) return { unmeasured: "no engine is configured, so nothing has measured its detection" };
  if (!status.reachable) return { unmeasured: "the engine's health report could not be had when this reading was taken" };
  const health = status.health;
  if (!health || typeof health !== "object" || Array.isArray(health)) {
    return { unmeasured: "the engine answered, but its health report could not be read" };
  }
  if (!("benchmark" in health)) {
    return { unmeasured: "the engine's health report carries no benchmark measurement: the engine predates it" };
  }
  const raw = (health as Record<string, unknown>).benchmark;
  const unreadable = (why: string): BenchmarkReport => ({
    unmeasured: `the engine reported a benchmark measurement this dashboard could not read (${why})`,
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unreadable("it is not an object");
  const block = raw as Record<string, unknown>;
  if (block.measured === false) {
    return typeof block.reason === "string" && block.reason.trim() !== ""
      ? { unmeasured: `the engine has no measurement to report: ${clip(block.reason)}` }
      : { unmeasured: "the engine has no measurement to report, and gave no reason" };
  }
  if (block.measured !== true) return unreadable("it says neither that it measured nor that it did not");
  try {
    return { measurement: measurementOf(block) };
  } catch (cause) {
    if (cause instanceof Unreadable) return unreadable(cause.message);
    throw cause;
  }
}

function samePair(a: MeasuredPair | null, b: MeasuredPair | null): boolean {
  if (a === null || b === null) return a === b;
  return a.securityRetained === b.securityRetained && a.utilityRetained === b.utilityRetained &&
    a.attacks === b.attacks && a.caught === b.caught && a.legitimate === b.legitimate && a.flagged === b.flagged;
}

/**
 * Whether two measurements are one: the same code, and the same numbers. Each
 * engine start runs the benchmark again, and the same code measures the same.
 * Comparing against the run before would show "no change" after every restart,
 * and hide the change a remediation made the first time the engine restarts.
 */
export function sameMeasurement(a: EngineMeasurement, b: EngineMeasurement): boolean {
  return a.commit === b.commit && a.commitModified === b.commitModified &&
    samePair(a.tuned, b.tuned) && samePair(a.holdout, b.holdout);
}

/** This measurement, and the latest different one recorded before it. */
async function withPrevious(current: EngineMeasurement): Promise<BenchmarkReading> {
  const last = await storage.getLatestBenchmarkReading();
  if (!last?.current?.tuned) return { current, previous: null };
  return { current, previous: sameMeasurement(last.current, current) ? last.previous : last.current };
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** One reading. Everything in it was measured or counted, or it is null. */
export async function measure(): Promise<InsertAIHealthMetric> {
  // Sample rows are excluded from every count here. The installer seeds three
  // tests, one of them in progress, and counting those as work this
  // deployment did would put "1 scan running, 3 today" on a machine that has
  // scanned nothing -- the same fiction the sample-data notice exists to stop
  // the dashboard telling.
  const tests = (await storage.getAllTests()).filter((test) => !test.isSample);
  const midnight = startOfToday();

  const active = tests.filter((test) => test.status === "in-progress").length;
  const today = tests.filter((test) => test.startedAt.getTime() >= midnight).length;

  // Of the scans that finished, how many finished rather than failed. Null
  // until something has finished: 100% of nothing is not a success rate.
  const completed = tests.filter((test) => test.status === "completed").length;
  const failed = tests.filter((test) => test.status === "failed").length;
  const finished = completed + failed;

  const classifiers = await storage.getAllClassifiers();
  const loaded = classifiers.filter((one) => one.status === "active");
  // The most recent training date anybody recorded, not "now" and not null
  // when one exists.
  const trained = loaded
    .map((one) => one.lastTrainedAt)
    .filter((date): date is Date => date instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  // The engine's boot canary: how many detection guards answered and how many
  // failed. This is the one real statement about detection either side of the
  // wire can make, and it is worth more than an accuracy figure nobody
  // computed.
  let guardsChecked: number | null = null;
  let guardsFailing: number | null = null;
  let benchmark: BenchmarkReport = { unmeasured: "the engine's health report could not be had when this reading was taken" };
  try {
    const status = await engine.status();
    const guards = (status.health as { guards?: { checked?: number; failing?: number } } | null)
      ?.guards;
    if (guards && typeof guards.checked === "number") guardsChecked = guards.checked;
    if (guards && typeof guards.failing === "number") guardsFailing = guards.failing;
    benchmark = readBenchmark(status);
  } catch {
    // An engine that is not there is a fact about the deployment. It leaves
    // these null; it does not fail the sample or invent a number.
  }

  return {
    cpuUsage: cpuPercent(),
    memoryUsage: memoryPercent(),
    activeScans: active,
    totalScansToday: today,
    successRate: finished > 0 ? Math.round((completed / finished) * 100) : null,
    averageResponseTime: takeAverageResponseTime(),
    modelsLoaded: loaded.map((one) => one.name),
    lastTrainingDate: trained,
    // Deliberately absent. See the note at the top of this file.
    detectionAccuracy: null,
    falsePositiveRate: null,
    guardsChecked,
    guardsFailing,
    benchmark: "measurement" in benchmark ? await withPrevious(benchmark.measurement) : null,
    benchmarkUnmeasured: "unmeasured" in benchmark ? benchmark.unmeasured : null,
  };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start writing a sample every minute, so the trend charts have something
 * real to draw. One is taken immediately, because a screen opened in the
 * first minute of uptime should not be empty.
 */
export function startSampling(): void {
  if (timer) return;
  const write = async () => {
    try {
      await storage.createAIHealthMetric(await measure());
    } catch (cause) {
      // Never take the server down over a metric.
      console.warn("[health] could not record a sample:", cause);
    }
  };
  void write();
  timer = setInterval(write, SAMPLE_EVERY_MS);
  // Do not hold the process open for the sake of a metric.
  timer.unref?.();
}

export function stopSampling(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
