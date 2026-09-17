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
import { Boxes, Building2, HelpCircle, Network, RefreshCw, ShieldQuestion } from "lucide-react";
import PageHero from "@/components/mythos/PageHero";
import GlassCard from "@/components/GlassCard";
import { Divider } from "@/components/mythos/Ornament";
import {
  AssetClassChip,
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
  assetName: string | null;
}
interface Asset {
  uuid: string;
  kind: string;
  kindLabel: string;
  name: string;
  identifier: string;
  classification: string;
  classificationLabel: string;
  providerName: string | null;
  findingCount: number;
}
interface Assertion {
  uuid: string;
  field: string;
  fieldLabel: string;
  value: string;
  evidenceClass: string;
  evidenceClassLabel: string;
  source: string;
  sourceLabel: string;
}
interface Provider {
  uuid: string;
  name: string;
  kind: string;
  kindLabel: string;
  assertions: Assertion[];
  profile: { declaredFields: number; weakestEvidence: string | null };
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
// The classifications that need attention lead: an unmanaged or high-risk asset
// is the one an operator has to see first, an approved or retired one last. An
// unrecognised classification sorts after the known order rather than vanishing.
const ASSET_CLASS_ORDER = ["high_risk", "unmanaged", "unknown", "known", "approved", "retired"];
function assetRank(classification: string): number {
  const i = ASSET_CLASS_ORDER.indexOf(classification);
  return i === -1 ? ASSET_CLASS_ORDER.length : i;
}
const IMPACT_TONE: Record<string, string> = {
  high: "text-sev-high",
  medium: "text-sev-medium",
  low: "text-emerald-400",
};

function asSeverity(s: string): Severity {
  // Lowercased first: a backend "Critical"/"HIGH" must not collapse to the Info
  // pill because the case did not match.
  const lower = (s ?? "").toLowerCase();
  return (["critical", "high", "medium", "low", "info"].includes(lower) ? lower : "info") as Severity;
}

/**
 * The banner headline, accurate to why the console is not reading. Configured
 * but unreachable, reachable but the credential was rejected, and reachable but
 * the backend errored are three different facts, and saying "not answering" for
 * all of them is a lie about a backend that answered.
 */
function bannerHeadline(status: AssuranceStatus): string {
  if (!status.configured) return "No control plane is configured.";
  if (status.reachable === false) return "The control plane is not answering.";
  if (status.authorized === false) return "The control plane rejected this console's credential.";
  return "The control plane returned an error.";
}

export default function Assurance() {
  const { toast } = useToast();
  const [selected, setSelected] = useState<string | "">("");

  const {
    data: status,
    isLoading: statusLoading,
    isError: statusError,
    error: statusErr,
  } = useQuery<AssuranceStatus>({
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
  const { data: assets = [] } = useQuery<Asset[]>({
    queryKey: ["/api/assurance/assets", selected ? { deployment: selected } : {}],
    enabled: reachable,
  });
  // Providers are a global registry — not scoped to the selected deployment.
  const { data: providers = [] } = useQuery<Provider[]>({
    queryKey: ["/api/assurance/providers"],
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

  const sortedAssets = useMemo(
    () =>
      [...assets].sort((a, b) => {
        const byClass = assetRank(a.classification) - assetRank(b.classification);
        return byClass !== 0 ? byClass : a.name.localeCompare(b.name);
      }),
    [assets],
  );

  return (
    <div className="space-y-6">
      <PageHero
        title="Assurance"
        subtitle="The system of record: decisions, evidence, and the gaps we have not closed."
        background="astrolabe"
        verbs={["Scan", "Analyze", "Evidence", "Deploy"]}
      />

      {/* Still checking: never a bare hero with no explanation. */}
      {statusLoading && !statusError && (
        <GlassCard bodyClassName="flex items-center gap-3">
          <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">Checking the control plane…</p>
        </GlassCard>
      )}

      {/* The status query itself failed (this server unreachable, not the backend). */}
      {statusError && (
        <GlassCard bodyClassName="flex items-start gap-3">
          <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-sev-high" />
          <div className="text-[13px] leading-relaxed">
            <p className="font-medium text-foreground">Could not check the control plane.</p>
            <p className="mt-1 text-muted-foreground">
              {statusErr instanceof Error ? statusErr.message : "The status request failed."}
            </p>
          </div>
        </GlassCard>
      )}

      {/* Control-plane honesty banner, accurate to why it is not reading. */}
      {status && !reachable && (
        <GlassCard bodyClassName="flex items-start gap-3">
          <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
          <div className="text-[13px] leading-relaxed">
            <p className="font-medium text-foreground">{bannerHeadline(status)}</p>
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
                            disabled={recompute.isPending && recompute.variables === d.uuid}
                            title="Recompute the decision from current findings"
                          >
                            <RefreshCw
                              className={cn(
                                "h-3.5 w-3.5",
                                recompute.isPending && recompute.variables === d.uuid && "animate-spin",
                              )}
                            />
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

          {/* The asset graph: what is deployed, and how each thing is governed. */}
          <GlassCard>
            <div className="mb-4 flex items-center gap-2">
              <Network className="h-4 w-4 text-primary" />
              <h2 className="text-[15px] font-semibold text-foreground">Assets</h2>
            </div>
            {sortedAssets.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No assets discovered yet.</p>
            ) : (
              <ul className="space-y-2.5">
                {sortedAssets.map((a) => (
                  <li
                    key={a.uuid}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/40 bg-surface-0/40 p-3"
                  >
                    <span className="text-[13px] font-semibold text-foreground">{a.name}</span>
                    <span className="text-[12px] text-muted-foreground">{a.kindLabel}</span>
                    <AssetClassChip value={a.classification} label={a.classificationLabel || undefined} />
                    <span className="text-[11px] text-muted-foreground">
                      {a.findingCount} {a.findingCount === 1 ? "finding" : "findings"}
                    </span>
                    {a.providerName && (
                      <span className="text-[11px] text-muted-foreground">· {a.providerName}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </GlassCard>

          {/* The provider registry: the vendors under assurance and each one's
              declared assurance profile (Phase 1.5). Read-only. */}
          <GlassCard>
            <div className="mb-4 flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              <h2 className="text-[15px] font-semibold text-foreground">Providers</h2>
            </div>
            {providers.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No providers recorded yet.</p>
            ) : (
              <ul className="space-y-3">
                {providers.map((p) => (
                  <li
                    key={p.uuid}
                    className="rounded-lg border border-border/40 bg-surface-0/40 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="text-[13px] font-semibold text-foreground">{p.name}</span>
                      <span className="text-[12px] text-muted-foreground">{p.kindLabel}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                      <span>
                        {p.profile.declaredFields} {p.profile.declaredFields === 1 ? "fact" : "facts"}
                      </span>
                      {p.profile.weakestEvidence && (
                        <span className="flex items-center gap-1.5">
                          <span>weakest:</span>
                          <EvidenceClassChip value={p.profile.weakestEvidence} />
                        </span>
                      )}
                    </div>
                    {p.assertions.length === 0 ? (
                      <p className="mt-2 text-[12px] text-muted-foreground">No profile facts recorded.</p>
                    ) : (
                      <ul className="mt-2 space-y-1.5">
                        {p.assertions.map((a) => (
                          <li
                            key={a.uuid}
                            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/30 pt-1.5"
                          >
                            <span className="min-w-[9rem] text-[12px] text-muted-foreground">
                              {a.fieldLabel}
                            </span>
                            <span className="flex-1 text-[12px] text-foreground">{a.value}</span>
                            <EvidenceClassChip value={a.evidenceClass} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
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
                        {f.assetName && (
                          <span className="text-[11px] text-muted-foreground">· {f.assetName}</span>
                        )}
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
                          disabled={setDisposition.isPending && setDisposition.variables?.uuid === u.uuid}
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
