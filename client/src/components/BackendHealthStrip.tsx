/**
 * Athena-Backend's own health, on every screen: a strip under the top bar.
 *
 * The backend says whether it lost or refused anything an operator must act
 * on (Athena-Backend #217: stderr lines lost, log records dropped, unrecorded
 * dispatches refused). This shows its state and every non-zero count by name.
 * The reading is strict (shared/backend-health.ts): "ok" only when the backend
 * said "ok" with every count reported and zero; anything else is said as what
 * it is, never as "ok" -- and a reading this page cannot read, or a server it
 * cannot ask, is "unknown".
 *
 * A read, off every stop path: the server answers it from memory
 * (server/backend-health.ts), and nothing here is on a stop's way. No
 * acknowledge button yet; acknowledgement fields a backend sends are shown.
 */
import { useContext, type ReactNode } from "react";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { loaded } from "@/lib/loaded";
import { cn } from "@/lib/utils";
import {
  guardReading, type BackendHealthReading, type ShownField, type Verdict,
} from "@shared/backend-health";

/** How often the strip asks this server for the last reading (the server reads the backend on its own timer). */
export const HEALTH_STRIP_REFRESH_MS = 10_000;
/** Sooner while no reading is in hand, or the last ask could not be answered. */
export const HEALTH_STRIP_RETRY_MS = 2_000;

const VERDICT_WORDS: Record<Verdict, string> = {
  ok: "ok",
  degraded: "degraded",
  unknown: "unknown",
  unreachable: "unreachable",
  "not-reported": "counts not reported",
  error: "error",
};

const VERDICT_CLASS: Record<Verdict, string> = {
  ok: "border-border/60 text-muted-foreground",
  degraded: "border-sev-high/60 bg-sev-high/10 text-foreground",
  error: "border-sev-high/60 bg-sev-high/10 text-foreground",
  unknown: "border-sev-medium/60 bg-sev-medium/10 text-foreground",
  unreachable: "border-sev-medium/60 bg-sev-medium/10 text-foreground",
  "not-reported": "border-border/60 bg-surface-1/40 text-foreground",
};

interface ServedView {
  configured: boolean;
  reading?: unknown;
  checkedAt?: unknown;
  ageMs?: unknown;
}

function FieldList({ fields, testId }: { fields: ShownField[]; testId: string }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-0.5" data-testid={testId}>
      {fields.map((one, index) => (
        <li key={`${one.name}-${index}`} className="font-mono text-[11px]">
          {one.name} = {one.value}
        </li>
      ))}
    </ul>
  );
}

function Details({ reading }: { reading: BackendHealthReading }) {
  return (
    <div className="mt-1 space-y-1 text-[12px]">
      {reading.counts.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-0.5" data-testid="backend-health-counts">
          {reading.counts.map((one) => (
            <li key={one.name} data-testid={`backend-health-count-${one.name}`}>
              <span className="font-medium">{one.label}</span>: {one.value}
              {!one.known && <span className="text-muted-foreground"> (a count this console does not know)</span>}
            </li>
          ))}
        </ul>
      )}
      {reading.reportedStatus !== null && reading.verdict !== "ok" && (
        <p className="text-muted-foreground" data-testid="backend-health-reported-status">
          The backend&apos;s own status: {JSON.stringify(reading.reportedStatus)}
          {reading.message !== null && <> -- {reading.message}</>}
        </p>
      )}
      {reading.problems.length > 0 && (
        <ul className="list-disc pl-5" data-testid="backend-health-problems">
          {reading.problems.map((one, index) => <li key={index}>{one}</li>)}
        </ul>
      )}
      {reading.unrecognised.length > 0 && (
        <div data-testid="backend-health-unrecognised">
          <p className="text-muted-foreground">Fields this console does not recognise, as the backend sent them:</p>
          <FieldList fields={reading.unrecognised} testId="backend-health-unrecognised-list" />
        </div>
      )}
      {reading.acknowledgement.length > 0 && (
        <div data-testid="backend-health-acknowledgement">
          <p className="text-muted-foreground">Acknowledgement, as the backend sent it:</p>
          <FieldList fields={reading.acknowledgement} testId="backend-health-acknowledgement-list" />
        </div>
      )}
      {reading.workers !== null && (
        <div data-testid="backend-health-workers">
          <p className="text-muted-foreground">
            {reading.workers.length === 1 ? "1 worker reported:" : `${reading.workers.length} workers reported:`}
          </p>
          <ol className="list-decimal space-y-0.5 pl-5">
            {reading.workers.map((worker, index) => (
              <li key={index} data-testid={`backend-health-worker-${index + 1}`}>
                <FieldList fields={worker.fields} testId={`backend-health-worker-${index + 1}-fields`} />
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function Strip({ verdict, headline, children, when }: { verdict: Verdict; headline: string; children?: ReactNode; when?: string }) {
  return (
    <section
      className={cn("border-b px-4 py-1.5 text-[12px] md:px-6", VERDICT_CLASS[verdict])}
      data-testid="backend-health"
      data-verdict={verdict}
      aria-live="polite"
    >
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">Athena-Backend health:</span>
        <span className="rounded border border-current/30 px-1.5 font-semibold uppercase tracking-wider" data-testid="backend-health-verdict">
          {VERDICT_WORDS[verdict]}
        </span>
        <span data-testid="backend-health-headline">{headline}</span>
        {when && <span className="text-muted-foreground" data-testid="backend-health-when">{when}</span>}
      </p>
      {children}
    </section>
  );
}

function readAt(view: ServedView): string | undefined {
  return typeof view.ageMs === "number" && Number.isFinite(view.ageMs) ? `(read ${Math.round(view.ageMs / 1000)} s ago)` : undefined;
}

/**
 * The strip, wherever the app's query client is. A shell mounted with none (a
 * page rendered on its own, in a test) has nothing to ask with, and shows no
 * strip rather than throwing; the app itself always has one (client/src/App.tsx).
 */
export default function BackendHealthStrip() {
  const client = useContext(QueryClientContext);
  return client ? <BackendHealthReadout /> : null;
}

function BackendHealthReadout() {
  const query = useQuery<ServedView>({
    queryKey: ["/api/backend-health"],
    refetchInterval: (q) =>
      q.state.status === "error" || (q.state.data as ServedView | undefined)?.checkedAt == null
        ? HEALTH_STRIP_RETRY_MS
        : HEALTH_STRIP_REFRESH_MS,
  });
  const source = loaded(query);
  if (source.state === "loading") {
    return <Strip verdict="unknown" headline="Reading Athena-Backend's health…" />;
  }
  if (source.state === "error") {
    return <Strip verdict="unknown" headline={`This console's server could not be asked for Athena-Backend's health: ${source.message}`} />;
  }
  const view = source.data;
  if (view !== null && typeof view === "object" && view.configured === false) return null;
  if (view === null || typeof view !== "object" || view.configured !== true) {
    return <Strip verdict="unknown" headline="The console's server answered a health reading this page cannot read" />;
  }
  const reading = guardReading(view.reading);
  return (
    <Strip verdict={reading.verdict} headline={reading.headline} when={readAt(view)}>
      <Details reading={reading} />
    </Strip>
  );
}
