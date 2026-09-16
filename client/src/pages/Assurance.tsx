/**
 * Assurance: the system of record, read straight from the Athena control plane.
 *
 * The other pages read this desktop app's own store; this one reads the Django
 * backend that is the source of truth for the assurance graph — the deployments
 * under assurance and their six-state decision (Phase 0.5), the findings graded
 * by how strongly each is known (evidence classification, Phase 0.3), and the
 * Unknowns Register (Phase 0.4): the gaps the evidence could not close, tracked
 * as managed objects instead of rounded down to "fine" or up to "broken".
 *
 * It is honest about its own absence. When no control plane is configured, or
 * it cannot be reached, the page says so in words and shows nothing invented —
 * an unconfigured backend is a fact about the deployment, not an error to hide.
 * Nothing here decides anything: it surfaces the backend's conclusions so a
 * human can make the release decision from them.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Boxes, HelpCircle, RefreshCw, ShieldQuestion } from "lucide-react";
import PageHero from "@/components/mythos/PageHero";
import GlassCard from "@/components/GlassCard";
import { Divider } from "@/components/mythos/Ornament";
import {
  DecisionPill,
  EvidenceClassChip,
  SeverityPill,
  type Severity,
} from "@/components/mythos/atoms";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface AssuranceStatus {
  configured: boolean;
  reachable: boolean;
  authorized: boolean | null;
  url: string | null;
  detail: string;
}
interface Deployment {
  uuid: string;
  name: string;
  environment: string;
  decision: string | null;
  decisionLabel: string;
  findingCount: number;
  updatedAt: string | null;
}
interface Finding {
  uuid: string;
  deploymentUuid: string | null;
  title: string;
  severity: string;
  status: string;
  evidenceClass: string;
  location: string;
}
interface Unknown {
  uuid: string;
  deploymentUuid: string | null;
  question: string;
  whyItMatters: string;
  evidenceNeeded: string;
  deploymentImpact: string;
  impactLabel: string;
  status: string;
  statusLabel: string;
  source: string;
  reviewBy: string | null;
}

const UNKNOWN_STATUSES = ["open", "investigating", "resolved", "accepted"] as const;
const IMPACT_TONE: Record<string, string> = {
  high: "text-sev-high",
  medium: "text-sev-medium",
  low: "text-emerald-400",
};

function asSeverity(s: string): Severity {
  return (["critical", "high", "medium", "low", "info"].includes(s) ? s : "info") as Severity;
}

export default function Assurance() {
  const { toast } = useToast();
  const [selected, setSelected] = useState<string | "">("");

  const { data: status } = useQuery<AssuranceStatus>({
    queryKey: ["/api/assurance/status"],
    refetchInterval: 30_000,
  });
  const reachable = status?.configured === true && status?.reachable === true && status?.authorized === true;

  const { data: deployments = [], isLoading: depLoading } = useQuery<Deployment[]>({
    queryKey: ["/api/assurance/deployments"],
    enabled: reachable,
  });
  const { data: findings = [] } = useQuery<Finding[]>({
    queryKey: ["/api/assurance/findings", selected ? { deployment: selected } : {}],
    enabled: reachable,
  });
  const { data: unknowns = [] } = useQuery<Unknown[]>({
    queryKey: ["/api/assurance/unknowns", selected ? { deployment: selected } : {}],
    enabled: reachable,
  });

  const recompute = useMutation({
    mutationFn: async (uuid: string) =>
      (await apiRequest("POST", `/api/assurance/deployments/${uuid}/recompute`, { paused: false })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/assurance/deployments"] });
      toast({ title: "Decision recomputed" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not recompute", description: error.message, variant: "destructive" }),
  });

  const setDisposition = useMutation({
    mutationFn: async ({ uuid, status: next }: { uuid: string; status: string }) =>
      (await apiRequest("PATCH", `/api/assurance/unknowns/${uuid}`, { status: next })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/assurance/unknowns"] });
      toast({ title: "Unknown updated" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not update", description: error.message, variant: "destructive" }),
  });

  const openUnknowns = useMemo(
    () => unknowns.filter((u) => u.status === "open" || u.status === "investigating"),
    [unknowns],
  );

  return (
    <div className="space-y-6">
      <PageHero
        title="Assurance"
        subtitle="The system of record: decisions, evidence, and the gaps we have not closed."
        background="astrolabe"
        verbs={["Scan", "Analyze", "Evidence", "Deploy"]}
      />

      {/* Control-plane honesty banner. */}
      {status && !reachable && (
        <GlassCard bodyClassName="flex items-start gap-3">
          <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
          <div className="text-[13px] leading-relaxed">
            <p className="font-medium text-foreground">
              {status.configured ? "The control plane is not answering." : "No control plane is configured."}
            </p>
            <p className="mt-1 text-muted-foreground">{status.detail}</p>
          </div>
        </GlassCard>
      )}

      {reachable && (
        <>
          {/* Deployments + six-state decision. */}
          <GlassCard>
            <div className="mb-4 flex items-center gap-2">
              <Boxes className="h-4 w-4 text-primary" />
              <h2 className="text-[15px] font-semibold text-foreground">Deployments under assurance</h2>
            </div>
            {depLoading ? (
              <p className="text-[13px] text-muted-foreground">Loading…</p>
            ) : deployments.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                No deployments recorded yet. A completed scan populates the system of record.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium">System</th>
                      <th className="pb-2 pr-4 font-medium">Environment</th>
                      <th className="pb-2 pr-4 font-medium">Decision</th>
                      <th className="pb-2 pr-4 font-medium">Findings</th>
                      <th className="pb-2 pr-4 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {deployments.map((d) => (
                      <tr
                        key={d.uuid}
                        className={cn(
                          "border-t border-border/40 hover:bg-surface-1/40",
                          selected === d.uuid && "bg-surface-1/60",
                        )}
                      >
                        <td className="py-2.5 pr-4">
                          <button
                            className="text-left font-medium text-foreground hover:text-primary"
                            onClick={() => setSelected(selected === d.uuid ? "" : d.uuid)}
                          >
                            {d.name}
                          </button>
                        </td>
                        <td className="py-2.5 pr-4 text-muted-foreground">{d.environment}</td>
                        <td className="py-2.5 pr-4">
                          <DecisionPill decision={d.decision as never} label={d.decisionLabel || undefined} />
                        </td>
                        <td className="py-2.5 pr-4 text-muted-foreground">{d.findingCount}</td>
                        <td className="py-2.5 pr-4">
                          <button
                            className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-primary disabled:opacity-50"
                            onClick={() => recompute.mutate(d.uuid)}
                            disabled={recompute.isPending}
                            title="Recompute the decision from current findings"
                          >
                            <RefreshCw className={cn("h-3.5 w-3.5", recompute.isPending && "animate-spin")} />
                            Recompute
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {selected && (
              <p className="mt-3 text-[12px] text-muted-foreground">
                Showing findings and unknowns for one deployment.{" "}
                <button className="text-primary hover:underline" onClick={() => setSelected("")}>
                  Show all
                </button>
              </p>
            )}
          </GlassCard>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Findings, with the evidence class surfaced. */}
            <GlassCard>
              <h2 className="mb-4 text-[15px] font-semibold text-foreground">Findings</h2>
              {findings.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">No findings in scope.</p>
              ) : (
                <ul className="space-y-3">
                  {findings.map((f) => (
                    <li key={f.uuid} className="rounded-lg border border-border/40 bg-surface-0/40 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-[13px] font-medium text-foreground">{f.title}</p>
                        <SeverityPill severity={asSeverity(f.severity)} />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <EvidenceClassChip value={f.evidenceClass} />
                        <span className="text-[11px] text-muted-foreground">{f.status}</span>
                        {f.location && (
                          <span className="text-[11px] text-muted-foreground">· {f.location}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </GlassCard>

            {/* The Unknowns Register. */}
            <GlassCard>
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <HelpCircle className="h-4 w-4 text-amber-400" />
                  <h2 className="text-[15px] font-semibold text-foreground">Unknowns Register</h2>
                </div>
                <span className="text-[12px] text-muted-foreground">{openUnknowns.length} open</span>
              </div>
              {unknowns.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  No open gaps. Every finding in scope is verified or resolved.
                </p>
              ) : (
                <ul className="space-y-3">
                  {unknowns.map((u) => (
                    <li key={u.uuid} className="rounded-lg border border-border/40 bg-surface-0/40 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-[13px] font-medium text-foreground">{u.question}</p>
                        <span className={cn("shrink-0 text-[11px] font-semibold", IMPACT_TONE[u.deploymentImpact])}>
                          {u.impactLabel}
                        </span>
                      </div>
                      {u.whyItMatters && (
                        <p className="mt-1 text-[12px] text-muted-foreground">{u.whyItMatters}</p>
                      )}
                      {u.evidenceNeeded && (
                        <p className="mt-1 text-[12px] text-muted-foreground">
                          <span className="text-foreground/70">To close: </span>
                          {u.evidenceNeeded}
                        </p>
                      )}
                      <div className="mt-2 flex items-center gap-2">
                        <label className="text-[11px] text-muted-foreground" htmlFor={`u-${u.uuid}`}>
                          Disposition
                        </label>
                        <select
                          id={`u-${u.uuid}`}
                          className="rounded-md border border-border/60 bg-surface-1/60 px-2 py-1 text-[12px] text-foreground"
                          value={u.status}
                          disabled={setDisposition.isPending}
                          onChange={(e) => setDisposition.mutate({ uuid: u.uuid, status: e.target.value })}
                        >
                          {UNKNOWN_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                        <span className="text-[11px] text-muted-foreground">{u.source}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </GlassCard>
          </div>

          <Divider />
        </>
      )}
    </div>
  );
}
