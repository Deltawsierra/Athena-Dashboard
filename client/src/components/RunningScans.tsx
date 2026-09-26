/**
 * Every engine scan recorded as running that this page did not start, each
 * with its Stop.
 *
 * The scan screens kept their scan in component state, set by the start and
 * by nothing else, and read no list of running scans. So a scan's Stop
 * existed only on the page instance that started it: after a reload, a
 * navigation away and back, or for a scan a colleague started, no per-scan
 * Stop was anywhere in the product while the engine went on scanning. This
 * reads the recorded tests and offers the Stop for every one whose engine run
 * may still be running (read as the server reads it, lib/engineRuns.ts). The
 * Stop asks the abort route, which asks the engine and says if it did not
 * stop; nothing here decides that a scan has stopped.
 *
 * A scan the engine started with no run id a stop can name was left out of
 * this list altogether, while Max Concurrent Tests counted it. It is listed,
 * with NoStopPanel in place of a Stop: what stops it is the Failsafe console.
 */
import { useQuery, useMutation } from "@tanstack/react-query";
import { Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import GlassCard from "@/components/GlassCard";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateTestsAndFindings } from "@/lib/invalidate";
import NoStopPanel from "@/components/NoStopPanel";
import { failsafeOnly, unfinishedRunOf } from "@/lib/engineRuns";
import { loaded } from "@/lib/loaded";
import type { Client, Test } from "@shared/schema";

export default function RunningScans({ exclude, className }: { exclude: string | null; className?: string }) {
  const { toast } = useToast();
  // Re-read now and then, so a scan started elsewhere shows up here.
  const tests$ = loaded(useQuery<Test[]>({ queryKey: ["/api/tests"], refetchInterval: 15_000 }));
  const clients$ = loaded(useQuery<Client[]>({ queryKey: ["/api/clients"] }));

  const stop = useMutation({
    mutationFn: async (testId: string) => {
      const response = await apiRequest("POST", `/api/scans/${testId}/abort`, undefined);
      return (await response.json()) as { stopped: boolean; runId: string };
    },
    onSuccess: (result, testId) => {
      queryClient.invalidateQueries({ queryKey: [`/api/scans/${testId}`] });
      void invalidateTestsAndFindings();
      toast({ title: "Stop sent", description: `The engine accepted the stop for run ${result.runId}.` });
    },
    onError: (error: Error) => toast({ title: "Not stopped", description: error.message, variant: "destructive" }),
  });

  if (tests$.state === "loading") return null;
  if (tests$.state === "error") {
    return (
      <GlassCard ruling className={className}>
        <p className="text-[13px] text-muted-foreground" data-testid="text-running-scans-unread">
          Could not read which scans are running: {tests$.message}. A scan started elsewhere can still be stopped with
          the kill switch on the AI Control page, or by pausing the engine from the Failsafe console.
        </p>
      </GlassCard>
    );
  }

  const running = tests$.data.filter(
    (test) => test.id !== exclude && (unfinishedRunOf(test) !== null || failsafeOnly(test)),
  );
  if (running.length === 0) return null;
  const clientName = (id: string) =>
    (clients$.state === "ready" ? clients$.data.find((one) => one.id === id)?.name : undefined) ?? "an engagement";

  return (
    <GlassCard className={className} data-testid="list-running-scans">
      <p className="athena-label">Scans running now</p>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Recorded as running, and not started from this page. Each is stopped here, or says what stops it.
      </p>
      <ul className="mt-3 space-y-2">
        {running.map((test) => {
          const recorded = test.findings as { target?: unknown };
          const runId = unfinishedRunOf(test);
          const target = typeof recorded.target === "string" ? recorded.target : runId !== null ? `run ${runId}` : "a scan";
          if (runId === null) {
            return (
              <li key={test.id} className="space-y-2 rounded-lg border p-3" data-testid={`running-scan-${test.id}`}>
                <div className="min-w-0 text-[13px]">
                  <p className="break-all font-medium text-foreground">{target}</p>
                  <p className="text-muted-foreground">
                    {clientName(test.clientId)} · no run id from the engine · {test.status} · started{" "}
                    {new Date(test.startedAt).toLocaleString()}
                  </p>
                </div>
                <NoStopPanel testId={test.id} />
              </li>
            );
          }
          return (
            <li key={test.id} className="flex items-center justify-between gap-3 rounded-lg border p-3" data-testid={`running-scan-${test.id}`}>
              <div className="min-w-0 text-[13px]">
                <p className="break-all font-medium text-foreground">{target}</p>
                <p className="text-muted-foreground">
                  {clientName(test.clientId)} · engine run {runId} · {test.status} · started{" "}
                  {new Date(test.startedAt).toLocaleString()}
                </p>
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => stop.mutate(test.id)}
                disabled={stop.isPending && stop.variables === test.id}
                data-testid={`button-stop-scan-${test.id}`}
              >
                <Square className="mr-2 h-4 w-4" />
                {stop.isPending && stop.variables === test.id ? "Stopping…" : "Stop"}
              </Button>
            </li>
          );
        })}
      </ul>
    </GlassCard>
  );
}
