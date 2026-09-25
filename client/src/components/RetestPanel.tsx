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

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { loaded } from "@/lib/loaded";
import { AlertTriangle, RotateCcw, ShieldCheck, ShieldX } from "lucide-react";

import { Button } from "@/components/ui/button";
import GlassCard from "@/components/GlassCard";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { invalidateTestsAndFindings } from "@/lib/invalidate";

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

interface RetestResult {
  twinId: number | null;
  verdict: string;
  detail: string;
  target: string | null;
  findingType: string | null;
  inventoryDigest: string | null;
  runId: string | null;
  checkedAt: string | null;
}

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

export default function RetestPanel({ testId }: { testId: string }) {
  const { toast } = useToast();
  const [results, setResults] = useState<Record<number, RetestResult>>({});

  // Read error-first: a failed read is not "the engine kept no decisions",
  // and a refetch that failed does not leave the last list standing as current.
  const decisions$ = loaded(useQuery<DecisionsView>({
    queryKey: [`/api/tests/${testId}/decisions`],
  }));
  const data = decisions$.state === "ready" ? decisions$.data : undefined;

  const run = useMutation({
    mutationFn: async (twinId: number) => {
      const response = await apiRequest("POST", `/api/tests/${testId}/retest`, { twinId });
      return (await response.json()) as RetestResult;
    },
    onSuccess: (result) => {
      // The verdict may have closed or reopened a finding.
      void invalidateTestsAndFindings();
      if (typeof result.twinId === "number") {
        setResults((previous) => ({ ...previous, [result.twinId as number]: result }));
      }
    },
    onError: (error: Error) => {
      // The engine's or the server's own words. "Retest failed" tells an
      // operator nothing about whether anything was reached.
      toast({ title: "The retest did not run", description: error.message, variant: "destructive" });
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
          const style = result ? verdictStyle(result.verdict) : null;
          const Icon = style?.icon;
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
                    {twin.severity && (
                      <span
                        className="athena-label"
                        style={{ color: `hsl(var(--sev-${twin.severity}))` }}
                      >
                        {twin.severity}
                      </span>
                    )}
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
                  disabled={run.isPending}
                  data-testid={`button-retest-${twin.id}`}
                >
                  <RotateCcw className="mr-2 h-3.5 w-3.5" />
                  {run.isPending && run.variables === twin.id ? "Retesting…" : "Retest"}
                </Button>
              </div>

              {result && style && Icon && (
                <div
                  className="mt-3 flex items-start gap-2 border-t border-border/60 pt-3"
                  data-testid={`verdict-${twin.id}`}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: style.colour }} />
                  <div className="min-w-0 space-y-1">
                    <div
                      className="athena-label"
                      style={{ color: style.colour }}
                      data-testid={`text-verdict-${twin.id}`}
                    >
                      {style.label}
                    </div>
                    {/* The engine's sentence, then what the verdict means.
                        The detail carries the reason -- a connection refused,
                        an unapproved detector set -- and summarising it away
                        is how "inconclusive" starts reading as "fine". */}
                    <p className="text-sm text-muted-foreground">{result.detail}</p>
                    <p className="text-xs text-muted-foreground">{style.meaning}</p>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </GlassCard>
  );
}
