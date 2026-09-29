/**
 * Prove it was fixed.
 *
 * The engine keeps a decision twin for every real finding a scan produced --
 * the inputs that produced it and the verdict it produced -- so a retest can
 * compare like with like rather than comparing today's scan to a remembered
 * summary. Nothing in this app ever asked for one.
 *
 * The verdict is the engine's word, rendered as three states because there are
 * three and they are not two. `inconclusive` is not a soft `closed`: the engine
 * says it whenever the finding's absence is explainable by something other than
 * the finding being gone -- a scan that did not complete, or a detector set
 * that is no longer the approved one. Measured against a live engine with the
 * target simply switched off, the verdict came back `inconclusive` with the
 * connection error as its detail. A panel that collapsed this into fixed/not
 * fixed would tell a customer that a host going down was a vulnerability
 * remediated, so inconclusive is styled as a warning and says in words that it
 * is not proof of a fix.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { loaded } from "@/lib/loaded";
import { AlertTriangle, Loader2, RotateCcw, ShieldCheck, ShieldX, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import GlassCard from "@/components/GlassCard";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, keptStops, mayStillBeRunning } from "@/lib/queryClient";
import { invalidateTestsAndFindings } from "@/lib/invalidate";
import { isAdmin } from "@/utils/auth";
import type { PublicUser } from "@shared/schema";
import { ratingOf } from "@shared/latest-scans";

interface DecisionTwin {
  id: number;
  runId: string | null;
  target: string;
  findingType: string;
  severity: string | null;
  tier: string | null;
  confidence: number | null;
  endpoint: string | null;
  detail: string | null;
  capturedAt: string | null;
}

/** A verdict (server/engine.ts RetestResult). `runId` is the scan record id; `engineRunId` the id a stop names. */
interface RetestResult {
  answer?: "verdict";
  twinId: number | null;
  verdict: string;
  detail: string;
  target: string | null;
  findingType: string | null;
  inventoryDigest: string | null;
  runId: string | null;
  engineRunId?: string | null;
  checkedAt: string | null;
  /** The engine accepted a stop for this run, and it completed anyway with this verdict. */
  completedDespiteStop?: boolean;
  /** A stop was sent for this run, its answer unread, and it completed with this verdict after it. */
  completedAfterUnreadStop?: boolean;
  /**
   * The engine ended this run ABORTED by a stop that landed after its check
   * was filed (the stop's reason): the verdict stands, and the run did not
   * finish. Null or absent for a run that completed.
   */
  stoppedAfterRecording?: string | null;
  /** That stop was the one this dashboard sent, and the engine took it. */
  stopTakenHere?: boolean;
  /** This dashboard had sent a stop for the run, its answer unread. */
  stopSentUnreadHere?: boolean;
}

/**
 * Where a retest is when the engine has not answered it with a verdict
 * (server/routes.ts answerRetestStatus and retestView). Never a verdict:
 * nothing is filed from it, and it is never drawn as fixed or inconclusive.
 */
interface RetestStatusView {
  answer: "status";
  /**
   * `already_finished`, `not_known` and `cleared` are how a Stop kept for a
   * run an unread answer named ends when nothing stopped it (server/routes.ts
   * handlePhase): never drawn as "Stopped".
   */
  phase: "running" | "stopped" | "failed" | "no_verdict" | "unwatched" | "already_finished" | "not_known" | "cleared";
  engineRunId: string | null;
  twinId: number;
  state: string;
  reason: string | null;
  error: string | null;
  stoppable: boolean;
  detail: string;
  lastReadError?: string | null;
  stopAcceptedAt?: string | null;
  /** A stop was sent and answered 2xx, the rest of its answer unread: never an accepted stop. */
  stopUnreadAt?: string | null;
  /** A Stop kept for a run an answer this dashboard did not read had named (server/routes.ts unreadRunView): an admin may clear it. */
  unreadAnswer?: true;
}

/** A watched retest as the poll route answers it: a status, or -- once it completed with one -- the verdict. */
type RetestWatchView =
  | RetestStatusView
  | (Omit<RetestStatusView, "answer" | "phase"> & { answer: "verdict"; phase: "verdict"; result: RetestResult });

type RetestAnswer = RetestResult | RetestStatusView;

/** What a retest's Stop answers (server/routes.ts POST /api/retests/:runId/abort). */
interface StopAnswer {
  stopped: boolean;
  runId: string;
  alreadyFinished?: boolean;
  /** The engine does not know the run: it has ended or never ran. Nothing was stopped. */
  unknownRun?: boolean;
  /**
   * With `unknownRun`: the id only an answer this dashboard did not read had
   * named, so that is no end -- a run the engine started may still be running
   * under another id (`mayStillBeRunning`). The Stop is kept; `detail` is the
   * server's words for it.
   */
  namedOnly?: boolean;
  mayStillBeRunning?: boolean;
  detail?: string;
}

/** Read `answer` before `verdict`: a status is never a verdict. */
function isStatus(answer: RetestAnswer): answer is RetestStatusView {
  return answer.answer === "status";
}

/** How often a running retest is read, and for how long this page keeps reading it. The server bounds its own watch. */
const POLL_MS = 2_000;
const POLL_FOR_MS = 65 * 60_000;

const PHASE_LABEL: Record<RetestStatusView["phase"], string> = {
  running: "Running",
  stopped: "Stopped",
  failed: "Failed",
  no_verdict: "No verdict",
  unwatched: "No longer watched",
  already_finished: "Already finished",
  not_known: "Not known to the engine",
  cleared: "Cleared by an admin",
};

/** Whether a status still keeps its Stop. */
const isOpen = (view: RetestStatusView): boolean => view.phase === "running" || view.phase === "unwatched";

interface DecisionsView {
  decisions: DecisionTwin[];
  /** More were captured than are shown. Said out loud, never implied. */
  truncated: boolean;
  detail: string;
}

/** How each verdict is said and shown. Unknown words are treated as unproven. */
function verdictStyle(verdict: string): {
  label: string;
  colour: string;
  icon: typeof ShieldCheck;
  meaning: string;
} {
  switch (verdict) {
    case "closed":
      return {
        label: "Closed",
        colour: "hsl(var(--primary))",
        icon: ShieldCheck,
        meaning:
          "The engine went back to the target, did not find it, and the detector " +
          "set it used is the approved one.",
      };
    case "still_open":
      return {
        label: "Still open",
        colour: "hsl(var(--sev-critical))",
        icon: ShieldX,
        meaning: "The engine went back to the target and found it again.",
      };
    default:
      return {
        label: verdict === "inconclusive" ? "Inconclusive" : verdict,
        colour: "hsl(var(--gold))",
        icon: AlertTriangle,
        meaning:
          "Not proof of a fix. The finding's absence is explainable by something " +
          "other than the finding being gone, so the engine will not call it closed.",
      };
  }
}

/** The verdict, drawn as the engine said it. */
function VerdictView({ twinId, result }: { twinId: number; result: RetestResult }) {
  const style = verdictStyle(result.verdict);
  const Icon = style.icon;
  return (
    <div className="mt-3 flex items-start gap-2 border-t border-border/60 pt-3" data-testid={`verdict-${twinId}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: style.colour }} />
      <div className="min-w-0 space-y-1">
        <div className="athena-label" style={{ color: style.colour }} data-testid={`text-verdict-${twinId}`}>
          {style.label}
        </div>
        {/* The engine's sentence, then what the verdict means.
            The detail carries the reason -- a connection refused,
            an unapproved detector set -- and summarising it away
            is how "inconclusive" starts reading as "fine". */}
        <p className="text-sm text-muted-foreground">{result.detail}</p>
        <p className="text-xs text-muted-foreground">{style.meaning}</p>
        {/* A run the engine ended stopped after its check was recorded is
            never drawn as one that finished -- anyway, or cleanly. */}
        {result.stoppedAfterRecording ? (
          <p className="text-xs athena-gold" data-testid={`text-verdict-stopped-after-recording-${twinId}`}>
            Stopped after its check was recorded ({result.stoppedAfterRecording}): the engine filed this verdict&apos;s
            check, then a stop landed and the run ended stopped. The verdict stands and was filed.
            {result.stopTakenHere
              ? " The stop sent from this dashboard was taken."
              : result.stopSentUnreadHere ? " A stop was sent from this dashboard; its answer was not read." : ""}
          </p>
        ) : null}
        {!result.stoppedAfterRecording && result.completedDespiteStop && (
          <p className="text-xs athena-gold" data-testid={`text-verdict-despite-stop-${twinId}`}>
            Completed despite a stop request: the engine accepted a stop for this retest, but the run finished anyway
            with this verdict, which was filed.
          </p>
        )}
        {!result.stoppedAfterRecording && !result.completedDespiteStop && result.completedAfterUnreadStop && (
          <p className="text-xs athena-gold" data-testid={`text-verdict-after-unread-stop-${twinId}`}>
            Completed after a stop whose answer was not read: a stop was sent for this retest, but the engine&apos;s answer
            to it was not read, and the run finished with this verdict, which was filed.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * A retest the engine answered with a status: running, stopped, failed, or
 * ended without a verdict. While it runs it is read every POLL_MS, and its
 * Stop is a separate request by the engine run id -- it never waits on a
 * read, and a read that failed never takes it away.
 */
function RetestStatusPanel({ twinId, initial, onVerdict, onStopAnswered }: {
  twinId: number;
  initial: RetestStatusView;
  onVerdict: (result: RetestResult) => void;
  /** The engine answered a Stop: the finding's open retests are read again (a run that ended no longer blocks Retest). */
  onStopAnswered: () => void;
}) {
  const { toast } = useToast();
  const [since] = useState(() => Date.now());
  const runId = initial.engineRunId;
  const { data: session } = useQuery<{ authenticated: boolean; user: PublicUser | null }>({ queryKey: ["/api/auth/check"] });
  const watch = useQuery<RetestWatchView>({
    queryKey: [`/api/retests/${runId}`],
    enabled: runId !== null && initial.phase === "running",
    retry: false,
    refetchInterval: (query) => {
      const phase = query.state.data?.phase;
      if (phase !== undefined && phase !== "running") return false;
      return Date.now() - since < POLL_FOR_MS ? POLL_MS : false;
    },
  });
  const latest = watch.data;

  useEffect(() => {
    if (latest && latest.answer === "verdict") onVerdict(latest.result);
  }, [latest, onVerdict]);

  const stop = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/retests/${encodeURIComponent(runId as string)}/abort`, undefined);
      return (await response.json()) as StopAnswer;
    },
    onSuccess: (result: StopAnswer) => {
      void watch.refetch();
      onStopAnswered();
      toast(result.alreadyFinished
        ? { title: "Already finished", description: `Retest run ${result.runId} had already ended; nothing was stopped.` }
        : result.unknownRun && result.namedOnly
          ? {
            title: "May still be running",
            description: `Retest run ${result.runId}: ${result.detail ?? "the engine does not know the run this answer named; " +
              "a run it started may still be running under another id -- the kill switch or a failsafe pause stops it"}.`,
            variant: "destructive",
          }
        : result.unknownRun
          ? {
            title: "Not known to the engine",
            description: `The engine does not know retest run ${result.runId} -- it has ended or never ran -- so nothing was stopped.`,
          }
          : { title: "Stop sent", description: `The engine accepted the stop for retest run ${result.runId}.` });
    },
    onError: (error: Error) => toast({
      title: "Not stopped",
      description: `${error.message} Press Stop again, or use the kill switch on the AI Control page.`,
      variant: "destructive",
    }),
  });

  // An admin may clear a Stop kept for a run an unread answer named, when
  // the run is known to be gone and its Stop cannot say so (POST
  // /api/retests/:runId/clear): nothing is sent to the engine.
  const clear = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/retests/${encodeURIComponent(runId as string)}/clear`, undefined);
      return (await response.json()) as { cleared: number; runId: string };
    },
    onSuccess: (result: { cleared: number; runId: string }) => {
      void watch.refetch();
      onStopAnswered();
      toast({
        title: "Stop cleared",
        description: `The Stop kept for run ${result.runId} was cleared; nothing was sent to the engine. The kill switch on the ` +
          "AI Control page, or a failsafe pause, stops it if it is still running.",
      });
    },
    onError: (error: Error) => toast({ title: "Not cleared", description: error.message, variant: "destructive" }),
  });

  const view: RetestStatusView = latest && latest.answer === "status" ? latest : initial;
  const stoppable = runId !== null && isOpen(view);
  const clearable = stoppable && view.unreadAnswer === true && isAdmin(session?.user ?? null);
  const ended = ["stopped", "already_finished", "not_known", "cleared"].includes(view.phase);
  const colour = view.phase === "running" ? "hsl(var(--primary))" : ended ? "hsl(var(--muted-foreground))" : "hsl(var(--gold))";

  return (
    <div
      className="mt-3 flex flex-wrap items-start justify-between gap-3 border-t border-border/60 pt-3"
      data-testid={`retest-status-${twinId}`}
      data-run-id={runId ?? undefined}
    >
      <div className="min-w-0 space-y-1">
        <div className="athena-label flex items-center gap-2" style={{ color: colour }} data-testid={`text-retest-phase-${twinId}`}>
          {view.phase === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {PHASE_LABEL[view.phase]}
        </div>
        <p className="text-sm text-muted-foreground" data-testid={`text-retest-status-${twinId}`}>{view.detail}</p>
        {runId !== null && (
          <p className="athena-mono text-xs text-muted-foreground">engine run {runId}</p>
        )}
        {watch.isError && (
          <p className="text-xs text-muted-foreground" data-testid={`text-retest-unread-${twinId}`}>
            Could not read where this retest is: {watch.error instanceof Error ? watch.error.message : "request failed"}.
            {stoppable ? " Its Stop still works." : ""}
          </p>
        )}
      </div>
      {stoppable && (
        <div className="flex flex-col items-end gap-1">
          {/* Never disabled: a Stop request that hangs must not take away the
              only Stop. Pressed again, it sends the stop again. */}
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => stop.mutate()}
            data-testid={`button-stop-retest-${twinId}`}
            data-run-id={runId ?? undefined}
          >
            <Square className="mr-2 h-3.5 w-3.5" />
            {stop.isPending ? "Stopping… (press to resend)" : "Stop"}
          </Button>
          <span className="text-[11px] text-muted-foreground" data-testid={`text-retest-killswitch-${twinId}`}>
            or the kill switch on the AI Control page
          </span>
          {clearable && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => clear.mutate()}
              disabled={clear.isPending}
              data-testid={`button-clear-retest-${twinId}`}
              data-run-id={runId ?? undefined}
            >
              Clear this Stop (admin; sends nothing)
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default function RetestPanel({ testId }: { testId: string }) {
  const { toast } = useToast();
  const [results, setResults] = useState<Record<number, RetestAnswer>>({});

  // Read error-first: a failed read is not "the engine kept no decisions",
  // and a refetch that failed does not leave the last list standing as current.
  const decisions$ = loaded(useQuery<DecisionsView>({
    queryKey: [`/api/tests/${testId}/decisions`],
  }));
  // Retests of this test still running -- started from here before a reload,
  // or from another page: each is shown running, with its Stop, and offers no
  // second Retest.
  const open$ = useQuery<{ retests: RetestStatusView[] }>({ queryKey: [`/api/tests/${testId}/retests`], retry: false });
  // Every open run of each finding, each with its own Stop: a finding one
  // unread answer named two runs for keeps both, never only the last.
  const openByTwin = new Map<number, RetestStatusView[]>();
  for (const one of open$.data?.retests ?? []) {
    if (one.answer === "status" && isOpen(one)) openByTwin.set(one.twinId, [...(openByTwin.get(one.twinId) ?? []), one]);
  }
  // Every run this page has listed stays shown after it leaves the list, read
  // by its own id: how it ended -- stopped, already finished, not known to the
  // engine -- is said where its Stop was, never dropped in silence.
  const [remembered, setRemembered] = useState<Record<string, RetestStatusView>>({});
  useEffect(() => {
    const listed = (open$.data?.retests ?? []).filter((one) => one.answer === "status" && isOpen(one) && one.engineRunId !== null);
    if (listed.every((one) => (one.engineRunId as string) in remembered)) return;
    setRemembered((previous) => {
      const next = { ...previous };
      for (const one of listed) next[one.engineRunId as string] ??= one;
      return next;
    });
  }, [open$.data, remembered]);
  const data = decisions$.state === "ready" ? decisions$.data : undefined;

  const run = useMutation({
    mutationFn: async (twinId: number) => {
      const response = await apiRequest("POST", `/api/tests/${testId}/retest`, { twinId });
      return (await response.json()) as RetestAnswer;
    },
    onSuccess: (result, twinId) => {
      // Read `answer` first: a status is where the run is, not a verdict, and
      // changed no finding.
      if (isStatus(result)) {
        setResults((previous) => ({ ...previous, [twinId]: result }));
        return;
      }
      // The verdict may have closed or reopened a finding.
      void invalidateTestsAndFindings();
      if (typeof result.twinId === "number") {
        setResults((previous) => ({ ...previous, [result.twinId as number]: result }));
      }
    },
    onError: (error: Error) => {
      // Refused because one is already running (maybe started elsewhere): show it.
      void open$.refetch();
      // The engine's or the server's own words. "Retest failed" tells an
      // operator nothing about whether anything was reached. A retest the
      // server says may still be running -- its answer unread and its stop not
      // taken, or its slot held -- is never titled "did not run": the title
      // says it may be running, and what stops it (its Stop, when it keeps
      // one, is on this panel).
      // "Stop it here" only when this panel keeps a Stop for it.
      toast(mayStillBeRunning(error)
        ? {
          title: keptStops(error).length > 0
            ? "The retest may still be running: stop it here, with the kill switch on the AI Control page, or a failsafe pause"
            : "The retest may still be running: stop it with the kill switch on the AI Control page, or a failsafe pause",
          description: error.message,
          variant: "destructive",
        }
        : { title: "The retest did not run", description: error.message, variant: "destructive" });
    },
  });

  if (decisions$.state === "loading") return null;

  const decisions = data?.decisions ?? [];

  return (
    <GlassCard>
      <div className="athena-label mb-1 flex items-center gap-2">
        <RotateCcw className="h-3.5 w-3.5" />
        Prove it was fixed
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        A retest sends real requests to the target again under this
        engagement. It is not a replay of the recorded input: it asks whether
        the finding is still there.
      </p>

      {decisions$.state === "error" && (
        <p className="text-sm text-muted-foreground" data-testid="text-decisions-unread">
          Could not load this run&apos;s decisions: {decisions$.message}
        </p>
      )}

      {data?.detail && (
        <p className="text-sm text-muted-foreground" data-testid="text-retest-detail">
          {data.detail}
        </p>
      )}

      {data && !data.detail && decisions.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="text-no-decisions">
          The engine kept no decisions for this run, so there is nothing to
          retest. Decisions are captured per finding, so a scan that found
          nothing leaves none.
        </p>
      )}

      {data?.truncated && (
        // A list that silently stops at the limit looks exactly like a
        // complete one. Measured: one scan of one small host captured 81
        // decisions, so filling the limit is an ordinary outcome.
        <p className="mb-3 text-sm athena-gold" data-testid="text-decisions-truncated">
          The engine kept more decisions for this run than are listed here.
          These are the most recent {decisions.length}.
        </p>
      )}

      <ul className="space-y-3" data-testid="list-decisions">
        {decisions.map((twin) => {
          const result = results[twin.id];
          // The statuses shown, one per run: this page's own answer first,
          // then every other open run of this finding, each with its Stop.
          // A run whose verdict this page has is shown as that verdict only.
          const verdictRun = result && !isStatus(result) ? result.engineRunId ?? null : null;
          const open = (openByTwin.get(twin.id) ?? []).filter((one) => verdictRun === null || one.engineRunId !== verdictRun);
          const statuses: RetestStatusView[] = [
            ...(result && isStatus(result) ? [result] : []),
            ...open,
            ...Object.values(remembered).filter((one) => one.twinId === twin.id && one.engineRunId !== verdictRun),
          ].filter((one, at, all) =>
            one.engineRunId === null ? at === all.indexOf(one) : all.findIndex((other) => other.engineRunId === one.engineRunId) === at);
          // Blocked while this page's own retest is open, or the server lists an open run of this finding.
          const running = (result !== undefined && isStatus(result) && isOpen(result)) || open.length > 0;
          return (
            <li
              key={twin.id}
              className="rounded-lg border border-border/60 p-4"
              data-testid={`decision-${twin.id}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="athena-mono text-xs text-muted-foreground">
                      {twin.findingType}
                    </span>
                    {/* Its rating as every reader reads it (any case, trimmed), or "not rated" -- never a bare word, never nothing. */}
                    <span
                      className="athena-label"
                      style={{ color: `hsl(var(${ratingOf(twin.severity) ? `--sev-${ratingOf(twin.severity)}` : "--muted-foreground"}))` }}
                    >
                      {ratingOf(twin.severity) ?? "not rated"}
                    </span>
                  </div>
                  <div className="truncate text-sm">{twin.endpoint ?? twin.target}</div>
                  {twin.detail && (
                    <p className="mt-1 text-sm text-muted-foreground">{twin.detail}</p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => run.mutate(twin.id)}
                  disabled={run.isPending || running}
                  data-testid={`button-retest-${twin.id}`}
                >
                  <RotateCcw className="mr-2 h-3.5 w-3.5" />
                  {run.isPending && run.variables === twin.id ? "Retesting…" : "Retest"}
                </Button>
              </div>

              {run.isPending && run.variables === twin.id && (
                // The engine holds the request for up to 30 s for the verdict
                // before it answers with a run id. Until then the run is on
                // its live list: Scans running now lists it with a Stop, and
                // the kill switch stops it.
                <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground" data-testid={`text-retest-waiting-${twin.id}`}>
                  Waiting for the engine to answer. While it does, this retest is on the engine&apos;s list of live
                  runs: Scans running now lists it with its Stop, and the kill switch stops it.
                </p>
              )}

              {result && !isStatus(result) && <VerdictView twinId={twin.id} result={result} />}

              {statuses.map((status) => (
                <RetestStatusPanel
                  key={status.engineRunId ?? `no-run-${twin.id}`}
                  twinId={twin.id}
                  initial={status}
                  onVerdict={(verdict) => {
                    void invalidateTestsAndFindings();
                    void open$.refetch();
                    setResults((previous) => ({ ...previous, [twin.id]: { ...verdict, answer: "verdict" } }));
                  }}
                  onStopAnswered={() => void open$.refetch()}
                />
              ))}
            </li>
          );
        })}
      </ul>
    </GlassCard>
  );
}
