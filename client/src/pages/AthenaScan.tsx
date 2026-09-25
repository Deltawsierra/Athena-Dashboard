/**
 * Athena's scan page: one system, dispatched to the engine and watched while it
 * is taken apart.
 *
 * What this replaced is the failure the whole product is against. The page held
 * one fixture (`SAMPLE_SCAN`) shaped like a live run — a ring that filled to 72%
 * on no data, a reasoning log written into the source, a risk score nobody
 * computed, eight modules that scanned nothing. It looked like the truth and was
 * not. Now every figure comes from a real scan: the engine's state, the findings
 * it returned, and the severity counts counted from those findings. What the
 * engine does not report, the page does not draw — a scan people cannot trust is
 * worse than no scan. When no engine is configured it says so in a sentence and
 * the button stays down, and the risk band is *derived* from the real counts,
 * never invented.
 *
 * This is the flagship twin of the Pentest console: the same live contract
 * (`/api/engine/status` + `/api/scans`), read in Athena's language.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Play, Plug, ShieldCheck, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import GlassCard from "@/components/GlassCard";
import SampleDataNotice from "@/components/SampleDataNotice";
import { Divider } from "@/components/mythos/Ornament";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { loaded } from "@/lib/loaded";
import { cn } from "@/lib/utils";
import templeStorm from "@assets/mythos/temple-storm.webp";
import {
  SCAN_STAGES,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  RISK_BAND_TONE,
  bandFromCounts,
  severityToken,
  type SeverityCounts,
  type Severity,
} from "@/lib/athenaScan";
import type { Client, Site, Test } from "@shared/schema";

interface EngineStatus {
  configured: boolean;
  reachable: boolean;
  /** Whether the engine took our key. null when it could not be checked. */
  authorized: boolean | null;
  url: string | null;
  detail: string;
}

/** One finding, in the engine's own shape. */
interface EngineFinding {
  type?: string;
  message?: string;
  details?: string;
  severity?: string;
  confidence?: number;
  internal?: boolean;
}

interface ScanView {
  test: Test;
  state: string;
  detail?: string;
  engine: { findings?: EngineFinding[]; detail?: string } | null;
}

/** States the engine reports for a run that has stopped moving. */
const FINISHED = new Set(["completed", "aborted", "failed", "refused"]);

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold"
      style={{
        color: `hsl(var(--sev-${severity}))`,
        borderColor: `hsl(var(--sev-${severity}) / 0.4)`,
        background: `hsl(var(--sev-${severity}) / 0.1)`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(var(--sev-${severity}))` }} />
      {severity === "info" ? "Info" : SEVERITY_LABEL[severity]}
    </span>
  );
}

export default function AthenaScan() {
  const { toast } = useToast();

  const [clientId, setClientId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [target, setTarget] = useState("");
  const [testId, setTestId] = useState<string | null>(null);

  // Polled, like the scan below. React Query keeps the last answer after a
  // poll fails, and read raw that answer went on saying "engine at <url>"
  // while the status could not be read. Read through loaded(), a failed read
  // is said as one, and scanning is off until the status is in hand again.
  const engine$ = loaded(useQuery<EngineStatus>({
    queryKey: ["/api/engine/status"],
    refetchInterval: 30_000,
  }));
  const engine = engine$.state === "ready" ? engine$.data : undefined;

  const { data: clients = [] } = useQuery<Client[]>({ queryKey: ["/api/clients"] });
  const { data: sites = [] } = useQuery<Site[]>({ queryKey: ["/api/sites"] });

  const sitesForClient = useMemo(
    () => sites.filter((site) => site.clientId === clientId),
    [sites, clientId],
  );
  useEffect(() => {
    if (siteId && !sitesForClient.some((site) => site.id === siteId)) setSiteId("");
  }, [siteId, sitesForClient]);

  const scan$ = loaded(useQuery<ScanView>({
    queryKey: [`/api/scans/${testId}`],
    enabled: testId !== null,
    // Polled while it moves, left alone once it has stopped.
    refetchInterval: (query) => {
      const state = (query.state.data as ScanView | undefined)?.state;
      return state && FINISHED.has(state) ? false : 2_000;
    },
  }));
  // The scan's last state, only while it is current. When a poll fails the
  // run may still be going: the state is said to be unread, the stop stays
  // within reach, and a second scan is not started over it.
  const scan = scan$.state === "ready" ? scan$.data : undefined;
  const scanUnread = testId !== null && scan$.state === "error" ? scan$.message : null;

  const start = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/scans", {
        clientId,
        siteId: siteId || undefined,
        target: target.trim(),
      });
      return (await response.json()) as { test: Test; runId: string | null };
    },
    onSuccess: (result) => {
      setTestId(result.test.id);
      queryClient.invalidateQueries({ queryKey: ["/api/tests"] });
    },
    onError: (error: Error) =>
      // The engine's own refusal, verbatim — "the target is a loopback address"
      // is the sentence an operator needs, not "scan failed".
      toast({ title: "The scan did not start", description: error.message, variant: "destructive" }),
  });

  const stop = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/scans/${testId}/abort`, undefined);
      return (await response.json()) as { stopped: boolean };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/scans/${testId}`] });
      toast({
        title: "Stop sent",
        description: "The engine will send no further request for this scan.",
      });
    },
    onError: (error: Error) =>
      toast({ title: "Not stopped", description: error.message, variant: "destructive" }),
  });

  // Reachable is not enough: the engine's /health takes no credential, so a
  // wrong key answers it happily. `null` (an engine too old to be asked) is
  // allowed through rather than grounding a working deployment.
  const engineReady = Boolean(engine?.configured && engine?.reachable) && engine?.authorized !== false;
  const engagementReady = clientId !== "" && target.trim() !== "";
  const canScan = engineReady && engagementReady;

  const returned = scan?.engine?.findings ?? [];
  const findings = returned.filter((f) => !f.internal);
  const notes = returned.filter((f) => f.internal);
  const running = scan !== undefined && !FINISHED.has(scan.state);
  const mayBeRunning = running || scanUnread !== null;
  const finished = scan !== undefined && FINISHED.has(scan.state);

  const counts: SeverityCounts = {
    critical: Number(scan?.test.criticalCount ?? 0),
    high: Number(scan?.test.highCount ?? 0),
    medium: Number(scan?.test.mediumCount ?? 0),
    low: Number(scan?.test.lowCount ?? 0),
  };
  const totalFindings = counts.critical + counts.high + counts.medium + counts.low;
  const band = bandFromCounts(counts);
  const clientName = clients.find((c) => c.id === clientId)?.name ?? "—";

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-8 md:py-8">
      {/* ---- Hero -------------------------------------------------------- */}
      <div className="relative overflow-hidden rounded-2xl border border-border/50">
        <img
          src={templeStorm}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover object-right"
        />
        <div className="pointer-events-none absolute inset-0 bg-background/40" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/30" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-background/70 to-transparent" />

        <div className="relative flex flex-wrap items-start justify-between gap-6 px-6 py-7 md:px-8">
          <div>
            <h1 className="font-serif text-5xl font-semibold tracking-tight text-foreground [text-shadow:0_2px_18px_hsl(var(--background)/0.8)]">
              Athena
            </h1>
            <p className="mt-2 text-[15px] text-muted-foreground">
              See the system. Understand the risks. Deploy with confidence.
            </p>
          </div>
          <div className="flex items-start gap-10 pt-2">
            <ul className="hidden space-y-1 text-[10px] uppercase tracking-[0.24em] text-muted-foreground/70 sm:block">
              {SCAN_STAGES.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <div className="space-y-1 border-l border-border/50 pl-10 text-[10px] uppercase tracking-[0.24em]">
              <p className="text-gold">Greater</p>
              <p className="text-gold">Clarity</p>
              <p className="mt-2 text-muted-foreground/70">Safer AI</p>
            </div>
          </div>
        </div>
      </div>

      <Divider variant="astrolabe" className="mt-5" />
      {/* The deployment and site pickers list seeded demo rows like any other. */}
      <SampleDataNotice counts={["clients", "sites"]} className="mt-5" />

      {/* ---- Engine status: the honest banner --------------------------- */}
      {engine$.state === "error" && (
        <GlassCard ruling className="mt-6">
          <div className="flex items-start gap-3">
            <Plug className="mt-0.5 h-5 w-5 shrink-0 text-gold" />
            <div className="space-y-1">
              <p className="athena-label">Could not check the engine</p>
              <p className="text-[13px] text-muted-foreground" data-testid="text-engine-unread">
                {engine$.message}. Scanning is off until the engine&apos;s status can be read again.
              </p>
            </div>
          </div>
        </GlassCard>
      )}
      {engine?.reachable && engineReady && (
        <div className="mt-6 flex items-center gap-2 text-[11px] text-muted-foreground" data-testid="text-engine-connected">
          <span className="athena-live h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.9)]" />
          <span className="athena-mono">engine at {engine.url}</span>
        </div>
      )}
      {engine && !engineReady && (
        <GlassCard ruling className="mt-6">
          <div className="flex items-start gap-3">
            <Plug className="mt-0.5 h-5 w-5 shrink-0 text-gold" />
            <div className="space-y-1">
              <p className="athena-label">
                {engine.reachable ? "The engine will not accept this key" : "No engine connected"}
              </p>
              <p className="text-[13px] text-muted-foreground" data-testid="text-engine-detail">
                {engine.detail}
              </p>
            </div>
          </div>
        </GlassCard>
      )}

      {/* ---- Start a scan ----------------------------------------------- */}
      <GlassCard className="mt-5">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canScan && !mayBeRunning) start.mutate();
          }}
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="client">Deployment owner</Label>
              <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger id="client" data-testid="select-client">
                  <SelectValue placeholder="Choose the engagement" />
                </SelectTrigger>
                <SelectContent>
                  {clients.map((client) => (
                    <SelectItem key={client.id} value={client.id}>
                      {client.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="site">System</Label>
              <Select
                value={siteId}
                onValueChange={setSiteId}
                disabled={clientId === "" || sitesForClient.length === 0}
              >
                <SelectTrigger id="site" data-testid="select-site">
                  <SelectValue
                    placeholder={
                      clientId === ""
                        ? "Choose an owner first"
                        : sitesForClient.length === 0
                          ? "No systems recorded"
                          : "Optional"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {sitesForClient.map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="target">Target</Label>
              <Input
                id="target"
                data-testid="input-target"
                placeholder="https://app.customer.example"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </div>
          </div>
          <p className="text-[12px] text-muted-foreground">
            The engine checks the target against its own egress policy and refuses
            anything it may not reach; its reason is shown here unchanged.
          </p>

          <div className="flex items-center gap-3">
            <Button type="submit" data-testid="button-start-scan" disabled={!canScan || start.isPending || mayBeRunning}>
              <Play className="mr-2 h-4 w-4" />
              {start.isPending ? "Asking the engine…" : "Start scan"}
            </Button>
            {mayBeRunning && (
              <Button
                type="button"
                variant="destructive"
                onClick={() => stop.mutate()}
                disabled={stop.isPending}
                data-testid="button-stop-scan"
              >
                <Square className="mr-2 h-4 w-4" />
                {stop.isPending ? "Stopping…" : "Stop"}
              </Button>
            )}
            {engine && !engineReady && (
              <span className="text-[12px] text-muted-foreground">
                {engine.reachable ? "Scanning needs a key the engine accepts." : "Scanning needs an engine."}
              </span>
            )}
          </div>
        </form>
      </GlassCard>

      {/* ---- Live scan: only real readings ------------------------------ */}
      {scanUnread !== null && (
        <GlassCard ruling className="mt-5">
          <p className="text-[13px] text-muted-foreground" data-testid="text-scan-unread">
            Could not read this scan&apos;s state: {scanUnread}. It may still be running; the page keeps asking,
            and the stop stays available until the engine answers.
          </p>
        </GlassCard>
      )}
      {scan && (
        <>
          {/* Top row: target + state */}
          <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <GlassCard hover={false} className="flex flex-col">
              <div className="flex items-center justify-between">
                <p className="athena-label">Scan Target</p>
                <span
                  className={cn(
                    "flex items-center gap-1.5 text-[11px] font-medium",
                    running ? "text-primary" : "text-muted-foreground",
                  )}
                  data-testid="text-state"
                >
                  {running && <span className="athena-live h-2 w-2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.9)]" />}
                  {scan.state}
                </span>
              </div>
              <h2 className="mt-3 break-all text-xl font-semibold text-foreground">{target || "—"}</h2>
              <p className="mt-1 text-[13px] text-muted-foreground">{clientName}</p>
              {scan.detail && <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{scan.detail}</p>}
              <div className="mt-4 border-t border-border/40 pt-4">
                <p className="athena-label">Started</p>
                <p className="mt-1 text-[13px] font-medium text-foreground">
                  {scan.test.startedAt ? new Date(scan.test.startedAt).toLocaleString() : "—"}
                </p>
              </div>
            </GlassCard>

            {/* Risk — derived from the real counts, never invented. */}
            <GlassCard className="flex flex-col justify-center">
              <p className="athena-label">Risk</p>
              <div className="mt-2 flex items-baseline gap-3">
                <span
                  className="whitespace-nowrap text-2xl font-semibold"
                  style={{ color: `hsl(var(--${RISK_BAND_TONE[band]}))` }}
                  data-testid="text-risk-band"
                >
                  {band === "Clear" && !finished ? "Assessing…" : band}
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
                {band === "Clear"
                  ? finished
                    ? "The scan returned no gradable findings."
                    : "No gradable findings yet."
                  : "Derived from the worst severity found — not a score."}
              </p>
            </GlassCard>
          </div>

          {/* Findings by severity — real counts */}
          <GlassCard className="mt-5">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
              <div className="shrink-0">
                <span className="athena-figure text-[40px] font-semibold leading-none text-foreground" data-testid="text-total">
                  {totalFindings}
                </span>
                <p className="mt-1 text-[11px] text-muted-foreground">Total findings</p>
              </div>
              {SEVERITY_ORDER.map((sev) => (
                <div key={sev}>
                  <p className="athena-label">{SEVERITY_LABEL[sev]}</p>
                  <p
                    className="athena-figure text-2xl font-semibold"
                    style={{ color: `hsl(var(--sev-${sev}))` }}
                    data-testid={`text-count-${sev}`}
                  >
                    {counts[sev]}
                  </p>
                </div>
              ))}
            </div>
          </GlassCard>

          {/* Findings themselves — real, non-internal engine findings */}
          <GlassCard hover={false} glow={false} className="mt-5">
            <p className="athena-label">Findings</p>
            {findings.length === 0 && finished && (
              <div className="mt-3 flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <p className="text-[13px] text-muted-foreground">
                  The scan finished and returned no findings. That is a result, not an absence of one.
                </p>
              </div>
            )}
            {findings.length === 0 && running && (
              <p className="mt-3 text-[13px] text-muted-foreground">The engine has reported nothing yet.</p>
            )}
            {findings.length > 0 && (
              <ul className="mt-4 space-y-3" data-testid="list-findings">
                {findings.map((f, i) => {
                  const level = severityToken(f.severity);
                  return (
                    <li
                      key={i}
                      className="space-y-1 rounded-lg border p-4"
                      style={{ borderColor: `hsl(var(--sev-${level}) / 0.35)` }}
                    >
                      <div className="flex items-center gap-2">
                        <SeverityBadge severity={level} />
                        <span className="athena-mono text-[11px] text-muted-foreground">{f.type}</span>
                      </div>
                      <p className="text-[13px] font-medium text-foreground">{f.message}</p>
                      {f.details && <p className="text-[13px] text-muted-foreground">{f.details}</p>}
                      {typeof f.confidence === "number" && (
                        <p className="athena-mono text-[11px] text-muted-foreground">
                          confidence {f.confidence.toFixed(2)}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {notes.length > 0 && (
              <div className="mt-5 space-y-2 border-t border-border/40 pt-4">
                <p className="athena-label">From the engine</p>
                {notes.map((note, i) => (
                  <div key={i} className="flex items-start gap-2 text-[13px] text-muted-foreground">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{note.details ?? note.message}</span>
                  </div>
                ))}
              </div>
            )}

            {finished && totalFindings > 0 && (
              <a
                href="/findings"
                className="mt-4 inline-flex items-center gap-1 text-[12px] font-medium text-primary hover:underline"
              >
                View all findings <ChevronRight className="h-3.5 w-3.5" />
              </a>
            )}
          </GlassCard>
        </>
      )}

      {/* No scan yet: an honest prompt, not a fabricated run. */}
      {testId === null && engineReady && (
        <GlassCard className="mt-5">
          <p className="text-[13px] text-muted-foreground">
            No scan running. Choose a deployment and a target above, and Athena dispatches a
            real run to the engine — every figure on this page comes back from it.
          </p>
        </GlassCard>
      )}

      <Divider className="mt-6" />
    </div>
  );
}
