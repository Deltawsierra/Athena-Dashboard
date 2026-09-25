/**
 * Findings, as things with a life rather than entries in a scan's output.
 *
 * Before this, a finding existed only inside the scan that produced it.
 * Rescanning a host produced a second unrelated copy of the same issue, nobody
 * owned anything, and there was no way to ask what was still open.
 *
 * The control this page deliberately does not offer is "mark as fixed".
 * Fixed is a claim about the customer's system and only a retest the engine
 * answered `closed` may make it -- so the status menu offers open,
 * acknowledged and accepted, and the page says where fixed comes from instead
 * of pretending it is a fourth option somebody forgot to enable. A status a
 * person could set to fixed without evidence would be the same defect as a
 * compliance control that renders green because nothing tested it.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleDot, Eye, History, ShieldQuestion, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import GlassCard from "@/components/GlassCard";
import PageHeader from "@/components/PageHeader";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { invalidateTestsAndFindings } from "@/lib/invalidate";
import type { Client } from "@shared/schema";

interface FindingRow {
  id: string;
  type: string;
  severity: string | null;
  message: string | null;
  target: string | null;
  endpoint: string | null;
  header: string | null;
  status: string;
  ownerId: string | null;
  ownerName: string | null;
  statusNote: string | null;
  timesSeen: number;
  firstSeenAt: string;
  lastSeenAt: string;
  fixedAt: string | null;
  fixedByRunId: string | null;
  fixedVerdict: string | null;
  reopenedAt: string | null;
  sightings: Array<{ id: string; runId: string | null; seen: boolean; observedAt: string }>;
  checks: Array<{ id: string; verdict: string; detail: string | null; runId: string | null; checkedAt: string }>;
}

interface FindingsView {
  findings: FindingRow[];
  counts: { open: number; acknowledged: number; accepted: number; fixed: number };
}

const STATUS: Record<string, { label: string; colour: string; icon: typeof CircleDot }> = {
  open: { label: "Open", colour: "hsl(var(--sev-critical))", icon: CircleDot },
  acknowledged: { label: "Acknowledged", colour: "hsl(var(--gold))", icon: Eye },
  accepted: { label: "Accepted", colour: "hsl(var(--gold))", icon: ShieldQuestion },
  fixed: { label: "Fixed", colour: "hsl(var(--primary))", icon: CircleCheck },
};

/** What a person may set. `fixed` is absent on purpose. */
const SETTABLE = ["open", "acknowledged", "accepted"];

export default function Findings() {
  const { toast } = useToast();
  const [clientId, setClientId] = useState("");
  const [filter, setFilter] = useState("all");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const { data: clients = [] } = useQuery<Client[]>({ queryKey: ["/api/clients"] });
  // Not /api/users: that is admin-only, and assigning an owner is ordinary
  // work. This returns just the id and name a picker needs.
  const { data: users = [] } = useQuery<Array<{ id: string; username: string }>>({
    queryKey: ["/api/users/assignable"],
  });

  const key = `/api/findings?clientId=${clientId}`;
  const { data } = useQuery<FindingsView>({ queryKey: [key], enabled: clientId !== "" });

  const patch = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) => {
      const response = await apiRequest("PATCH", `/api/findings/${id}`, body);
      return response.json();
    },
    // Every answer computed from findings, this list included.
    onSuccess: () => invalidateTestsAndFindings(),
    onError: (error: Error) => {
      // The server's sentence, verbatim. The refusal to mark something fixed
      // explains what to do instead, and summarising it away would lose that.
      toast({ title: "Not changed", description: error.message, variant: "destructive" });
    },
  });

  const shown = useMemo(
    () => (data?.findings ?? []).filter((one) => filter === "all" || one.status === filter),
    [data, filter],
  );

  return (
    <div className="min-h-screen">
      <div className="container mx-auto max-w-5xl space-y-6 p-6">
        <PageHeader
          title="Findings"
          icon={<CircleDot className="h-8 w-8 text-primary" />}
          description="One row per issue, kept across scans. Whoever owns it, what has been decided about it, and — where the engine has been back to check — whether it is gone."
        />

        <GlassCard className="athena-fluted">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="client">Engagement</Label>
              <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger id="client" data-testid="select-findings-client">
                  <SelectValue placeholder="Choose the engagement" />
                </SelectTrigger>
                <SelectContent>
                  {clients.map((client) => (
                    <SelectItem key={client.id} value={client.id}>{client.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="filter">Showing</Label>
              <Select value={filter} onValueChange={setFilter}>
                <SelectTrigger id="filter" data-testid="select-findings-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Everything</SelectItem>
                  {Object.entries(STATUS).map(([value, meta]) => (
                    <SelectItem key={value} value={value}>{meta.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </GlassCard>

        {data && (
          <>
            <GlassCard>
              <div className="flex flex-wrap gap-x-10 gap-y-4">
                {Object.entries(STATUS).map(([value, meta]) => (
                  <div key={value}>
                    <div className="athena-label" style={{ color: meta.colour }}>{meta.label}</div>
                    <div
                      className="athena-figure text-2xl"
                      style={{ color: meta.colour }}
                      data-testid={`text-count-${value}`}
                    >
                      {data.counts[value as keyof FindingsView["counts"]]}
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                Fixed is not something anybody sets here. It means the engine went back to
                the target and did not find it — run a retest from the scan, and a{" "}
                <span className="athena-mono">closed</span> verdict closes the finding with
                the run that proved it.
              </p>
            </GlassCard>

            {shown.length === 0 && (
              <p className="text-sm text-muted-foreground" data-testid="text-no-findings">
                Nothing in this state.
              </p>
            )}

            <ul className="space-y-3" data-testid="list-findings">
              {shown.map((finding) => {
                const meta = STATUS[finding.status] ?? STATUS.open;
                const Icon = meta.icon;
                return (
                  <li key={finding.id}>
                    <GlassCard data-testid={`finding-${finding.id}`}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Icon className="h-4 w-4 shrink-0" style={{ color: meta.colour }} />
                            <span
                              className="athena-label"
                              style={{ color: meta.colour }}
                              data-testid={`text-status-${finding.id}`}
                            >
                              {meta.label}
                            </span>
                            <span className="athena-mono text-xs text-muted-foreground">
                              {finding.type}
                            </span>
                            {finding.severity && (
                              <span
                                className="athena-label"
                                style={{ color: `hsl(var(--sev-${finding.severity}))` }}
                              >
                                {finding.severity}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 truncate text-sm">
                            {finding.endpoint ?? finding.header ?? finding.target}
                          </div>
                          {finding.message && (
                            <p className="text-sm text-muted-foreground">{finding.message}</p>
                          )}
                          <p className="mt-1 athena-mono text-xs text-muted-foreground">
                            seen in {finding.timesSeen} scan{finding.timesSeen === 1 ? "" : "s"}
                            {finding.reopenedAt && (
                              <span style={{ color: "hsl(var(--sev-critical))" }}>
                                {" "}· came back after being verified fixed
                              </span>
                            )}
                          </p>
                        </div>
                      </div>

                      {/* Where a "fixed" came from. The claim and its evidence
                          travel together or the claim is not worth having. */}
                      {finding.status === "fixed" && (
                        <p
                          className="mt-3 border-t border-border/60 pt-3 text-sm text-muted-foreground"
                          data-testid={`text-evidence-${finding.id}`}
                        >
                          Verified by the engine on run{" "}
                          <span className="athena-mono">{finding.fixedByRunId ?? "unknown"}</span>,
                          verdict <span className="athena-mono">{finding.fixedVerdict}</span>.
                        </p>
                      )}

                      {finding.statusNote && finding.status !== "fixed" && (
                        <p className="mt-3 border-t border-border/60 pt-3 text-sm text-muted-foreground">
                          {finding.statusNote}
                        </p>
                      )}

                      {/* Every run that looked, and every retest, in order.
                          This is what a client asking "is what you found last
                          time gone?" is actually owed: the observations, not a
                          status field whose history was overwritten. A run
                          that did not report something is shown as exactly
                          that -- never as a fix, because a scanner switched
                          off produces the same silence. */}
                      {(finding.sightings.length > 0 || finding.checks.length > 0) && (
                        <div
                          className="mt-3 border-t border-border/60 pt-3"
                          data-testid={`history-${finding.id}`}
                        >
                          <div className="athena-label mb-2 flex items-center gap-1">
                            <History className="h-3 w-3" /> Run by run
                          </div>
                          <ul className="space-y-1">
                            {finding.sightings.map((one) => (
                              <li key={one.id} className="athena-mono text-xs">
                                <span style={{ color: one.seen ? "hsl(var(--sev-critical))" : "hsl(var(--gold))" }}>
                                  {one.seen ? "reported" : "not reported"}
                                </span>
                                <span className="text-muted-foreground">
                                  {" "}· scan {(one.runId ?? "unknown").slice(0, 8)} ·{" "}
                                  {new Date(one.observedAt).toLocaleDateString()}
                                </span>
                                {!one.seen && (
                                  <span className="text-muted-foreground">
                                    {" "}— the scan did not report it. That is not proof it is gone.
                                  </span>
                                )}
                              </li>
                            ))}
                            {finding.checks.map((one) => (
                              <li key={one.id} className="athena-mono text-xs">
                                <span
                                  style={{
                                    color: one.verdict === "closed"
                                      ? "hsl(var(--primary))"
                                      : one.verdict === "still_open"
                                        ? "hsl(var(--sev-critical))"
                                        : "hsl(var(--gold))",
                                  }}
                                >
                                  retest {one.verdict}
                                </span>
                                <span className="text-muted-foreground">
                                  {" "}· run {(one.runId ?? "unknown").slice(0, 8)} ·{" "}
                                  {new Date(one.checkedAt).toLocaleDateString()}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border/60 pt-4">
                        <div className="space-y-1">
                          <div className="athena-label">Status</div>
                          <Select
                            value={SETTABLE.includes(finding.status) ? finding.status : ""}
                            onValueChange={(status) =>
                              patch.mutate({ id: finding.id, body: { status, note: notes[finding.id] } })
                            }
                          >
                            <SelectTrigger className="w-44" data-testid={`select-status-${finding.id}`}>
                              <SelectValue placeholder="Verified fixed" />
                            </SelectTrigger>
                            <SelectContent>
                              {SETTABLE.map((value) => (
                                <SelectItem key={value} value={value}>{STATUS[value].label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1">
                          <div className="athena-label flex items-center gap-1">
                            <UserRound className="h-3 w-3" /> Owner
                          </div>
                          <Select
                            value={finding.ownerId ?? ""}
                            onValueChange={(ownerId) => patch.mutate({ id: finding.id, body: { ownerId } })}
                          >
                            <SelectTrigger className="w-44" data-testid={`select-owner-${finding.id}`}>
                              <SelectValue placeholder="Nobody" />
                            </SelectTrigger>
                            <SelectContent>
                              {users.map((user) => (
                                <SelectItem key={user.id} value={user.id}>{user.username}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="min-w-[14rem] flex-1 space-y-1">
                          <div className="athena-label">Why</div>
                          <Input
                            placeholder="Recorded with the decision"
                            value={notes[finding.id] ?? ""}
                            onChange={(event) =>
                              setNotes((was) => ({ ...was, [finding.id]: event.target.value }))
                            }
                            data-testid={`input-note-${finding.id}`}
                          />
                        </div>

                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() =>
                            patch.mutate({ id: finding.id, body: { note: notes[finding.id] ?? "" } })
                          }
                          disabled={patch.isPending}
                          data-testid={`button-save-note-${finding.id}`}
                        >
                          Save
                        </Button>
                      </div>

                      {finding.ownerName && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Owned by {finding.ownerName}.
                        </p>
                      )}
                    </GlassCard>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
