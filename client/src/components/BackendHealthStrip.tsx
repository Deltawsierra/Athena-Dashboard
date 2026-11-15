/**
 * Athena-Backend's health, on every screen of the console (DASH-HEALTH-PANEL).
 *
 * A strip under the top bar: the backend's state as this server last read it
 * (server/backend-health.ts, read strictly by shared/backend-health.ts), every
 * non-zero count by name, each worker athena-backend #226 reports, every worker
 * report it could not read, and every field this console does not know, as it
 * came. "ok" is shown only when the backend said "ok" with every count reported
 * and zero; a failed read of this server's own route, an answer whose shape is
 * not the one this console sends, or a reading that is not current, never shows
 * "ok".
 *
 * Off every stop: this page asks this server only, which answers at once from
 * what it last read and never waits on the backend. The read here has its own
 * deadline (`STRIP_TIMING.deadlineMs`) and backs off when it fails. It keeps its
 * own state (no query cache), so the shell draws it wherever the shell is drawn.
 *
 * No acknowledge button: acknowledgement fields are shown read-only when the
 * backend sends them.
 */
import { useEffect, useState } from "react";
import {
  viewFrom,
  type BackendHealthState,
  type BackendHealthView,
  type HealthCount,
  type HealthWorker,
  type UnrecognizedField,
} from "@shared/backend-health";
import { cn } from "@/lib/utils";

export const BACKEND_HEALTH_KEY = ["/api/backend-health"] as const;

/** How this page reads the route. Tests shorten these. */
export const STRIP_TIMING = {
  /** The whole read of this server's route. */
  deadlineMs: 5_000,
  /** Between two reads that were answered. */
  everyMs: 15_000,
  /** While the server has not read the backend yet. */
  soonMs: 2_000,
  /** The most between two reads, backing off after failures. */
  maxBackoffMs: 300_000,
};

/** The wait before the next read of the route, after `failures` in a row. */
export function stripBackoffMs(failures: number): number {
  if (failures <= 0) return STRIP_TIMING.everyMs;
  return Math.min(STRIP_TIMING.maxBackoffMs, STRIP_TIMING.everyMs * 2 ** Math.min(failures, 30));
}

async function readRoute(signal: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, STRIP_TIMING.deadlineMs);
  try {
    const response = await fetch(BACKEND_HEALTH_KEY[0], { credentials: "include", signal: controller.signal });
    if (!response.ok) throw new Error(`this server answered HTTP ${response.status}`);
    return await response.json();
  } catch (cause) {
    if (controller.signal.aborted && !signal.aborted) {
      throw new Error(`this server did not answer within ${Math.round(STRIP_TIMING.deadlineMs / 1000)} s`);
    }
    throw cause instanceof Error ? cause : new Error(String(cause));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** What the last read of the route gave: an answer, a failure, or nothing yet. */
type Latest = { kind: "none" } | { kind: "answer"; data: unknown } | { kind: "failed"; message: string };

/** The strip, reading this server's route. */
export default function BackendHealthStrip() {
  const [latest, setLatest] = useState<Latest>({ kind: "none" });
  useEffect(() => {
    const stopped = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const next = (ms: number) => {
      if (!stopped.signal.aborted) timer = setTimeout(read, ms);
    };
    const read = async () => {
      timer = null;
      try {
        const data = await readRoute(stopped.signal);
        if (stopped.signal.aborted) return;
        failures = 0;
        setLatest({ kind: "answer", data });
        const view = viewFrom(data);
        next(view && view.readAt === null && view.state !== "not_configured" ? STRIP_TIMING.soonMs : STRIP_TIMING.everyMs);
      } catch (cause) {
        if (stopped.signal.aborted) return;
        failures += 1;
        // A failed read is shown as that, never as the reading before it.
        setLatest({ kind: "failed", message: cause instanceof Error ? cause.message : String(cause) });
        next(stripBackoffMs(failures));
      }
    };
    void read();
    return () => {
      stopped.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  if (latest.kind === "failed") {
    return (
      <BackendHealthPanel
        view={null}
        problem={`unreachable: the console could not read Athena-Backend's health from this server (${latest.message})`}
        problemState="unreachable"
      />
    );
  }
  if (latest.kind === "none") {
    return <BackendHealthPanel view={null} problem="unknown: Athena-Backend's health has not been read yet" problemState="unknown" />;
  }
  const view = viewFrom(latest.data);
  if (!view) {
    return <BackendHealthPanel view={null} problem="unknown: this server's answer about Athena-Backend's health could not be read" problemState="unknown" />;
  }
  return <BackendHealthPanel view={view} />;
}

/** What each state is called on the strip. Only "ok" is ok. */
export const STATE_WORDS: Record<BackendHealthState, string> = {
  ok: "ok",
  degraded: "degraded",
  unknown: "unknown",
  unreachable: "unreachable",
  uncounted: "the backend says \"ok\"; counts not reported by this backend",
  not_configured: "not configured",
};

const TONE: Record<BackendHealthState, string> = {
  ok: "text-green-600 dark:text-green-400",
  degraded: "text-sev-high",
  unknown: "text-sev-medium",
  unreachable: "text-sev-medium",
  uncounted: "text-muted-foreground",
  not_configured: "text-muted-foreground",
};

function Counts({ counts, testid }: { counts: HealthCount[]; testid: string }) {
  if (counts.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1" data-testid={testid}>
      {counts.map((one) => (
        <li key={one.name} data-testid={`${testid}-${one.name}`}>
          {one.label}: <span className="font-semibold tabular-nums">{one.value}</span>
        </li>
      ))}
    </ul>
  );
}

function Fields({ fields, title, testid }: { fields: UnrecognizedField[]; title: string; testid: string }) {
  if (fields.length === 0) return null;
  return (
    <div data-testid={testid}>
      <span className="text-muted-foreground">{title}: </span>
      {fields.map((one, index) => (
        <span key={`${one.name}-${index}`} className="mr-3 break-all">
          <code>{one.name}</code> = <code>{one.raw}</code>
        </span>
      ))}
    </div>
  );
}

function Worker({ worker }: { worker: HealthWorker }) {
  return (
    <li className="flex flex-col gap-0.5" data-testid={`backend-health-worker-${worker.id}`}>
      <span>
        <code className="break-all">{worker.id}</code>
        {" "}
        <span className="text-muted-foreground">({worker.state ?? "state not reported"})</span>
      </span>
      <Counts counts={worker.counts} testid={`backend-health-worker-${worker.id}-count`} />
      <Fields fields={worker.odd.map((one) => ({ name: one.name, raw: one.raw }))} title="could not be read" testid={`backend-health-worker-${worker.id}-odd`} />
      <Fields fields={worker.acknowledgement} title="acknowledgement (read only)" testid={`backend-health-worker-${worker.id}-acknowledgement`} />
      <Fields fields={worker.unrecognized} title="fields this console does not know" testid={`backend-health-worker-${worker.id}-unrecognized`} />
    </li>
  );
}

/** The strip as drawn, from a reading (or from why there is none). */
export function BackendHealthPanel({ view, problem, problemState }: {
  view: BackendHealthView | null;
  problem?: string;
  problemState?: BackendHealthState;
}) {
  const state: BackendHealthState = view ? view.state : (problemState ?? "unknown");
  const detail = view !== null && (
    view.reasons.length > 0 || view.workers.length > 0 || view.unknownWorkers.length > 0
    || view.unrecognized.length > 0 || view.odd.length > 0 || view.message !== null
  );
  return (
    <section
      aria-label="Athena-Backend health"
      className="flex flex-col gap-1 border-b border-border/60 bg-surface-0/60 px-4 py-2 text-xs md:px-6"
      data-testid="backend-health-strip"
      data-state={state}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-muted-foreground">Athena-Backend health:</span>
        <span className={cn("font-semibold", TONE[state])} data-testid="backend-health-state">{STATE_WORDS[state]}</span>
        {view && view.backendStatus !== null && view.backendStatus !== view.state && !(view.state === "uncounted") && (
          <span className="text-muted-foreground" data-testid="backend-health-backend-status">
            (the backend&apos;s status: <code>{JSON.stringify(view.backendStatus)}</code>)
          </span>
        )}
        {view && <Counts counts={view.counts} testid="backend-health-count" />}
        {view && !view.countsReported && view.state !== "not_configured" && view.state !== "uncounted" && (
          <span className="text-muted-foreground" data-testid="backend-health-counts-not-reported">counts not reported</span>
        )}
        {view?.readAt && (
          <span className="text-muted-foreground" data-testid="backend-health-read-at">
            read {new Date(view.readAt).toLocaleTimeString()}
          </span>
        )}
        {view?.reading && <span className="text-muted-foreground">reading now</span>}
      </div>
      {problem && <p className="text-sev-medium" data-testid="backend-health-problem">{problem}</p>}
      {detail && view && (
        <div className="flex flex-col gap-1" data-testid="backend-health-detail">
          {view.reasons.map((reason, index) => (
            <p key={index} data-testid="backend-health-reason">{reason}</p>
          ))}
          {view.message !== null && (
            <p className="text-muted-foreground" data-testid="backend-health-message">
              The backend&apos;s message: {view.message}
            </p>
          )}
          <Fields fields={view.odd.map((one) => ({ name: one.name, raw: one.raw }))} title="could not be read" testid="backend-health-odd" />
          {view.workers.length > 0 && (
            <div>
              <span className="text-muted-foreground">Workers ({view.workers.length}):</span>
              <ul className="ml-3 flex flex-col gap-1" data-testid="backend-health-workers">
                {view.workers.map((worker) => <Worker key={worker.id} worker={worker} />)}
              </ul>
            </div>
          )}
          {view.unknownWorkers.length > 0 && (
            <div>
              <span className="text-muted-foreground">Worker reports Athena-Backend could not read ({view.unknownWorkers.length}):</span>
              <ul className="ml-3" data-testid="backend-health-unknown-workers">
                {view.unknownWorkers.map((one) => (
                  <li key={one.id} data-testid={`backend-health-unknown-worker-${one.id}`}>
                    <code className="break-all">{one.id}</code>: {one.why}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Fields fields={view.unrecognized} title="Fields this console does not know" testid="backend-health-unrecognized" />
        </div>
      )}
    </section>
  );
}
