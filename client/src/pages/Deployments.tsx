/**
 * Deployments: the systems under assessment, read from `/api/clients` and the
 * tests run against them. Each row is a client system with the risk from its
 * most recent test; the headline counts and the highest-risk rail are computed
 * from that same data. Columns the backend has no source for -- model provider,
 * data-sensitivity tags -- are omitted rather than filled with fiction.
 */
import {
  Boxes,
  Activity,
  Clock,
  PauseCircle,
  Gauge,
  ChevronRight,
  MoreHorizontal,
  Plus,
  Search,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import PageHero from "@/components/mythos/PageHero";
import StatCard from "@/components/mythos/StatCard";
import GlassCard from "@/components/GlassCard";
import SampleDataNotice from "@/components/SampleDataNotice";
import { Divider, Emblem } from "@/components/mythos/Ornament";
import { StatusPill, Timeline, type StatusTone, type TimelineStep } from "@/components/mythos/atoms";
import { cn } from "@/lib/utils";

interface ApiClient { id: string; name: string; company: string; status: string; lastTestDate: string | null; notes: string | null }
interface ApiTest {
  id: string; clientId: string; testType: string; status: string; severity: string | null;
  completedAt: string | null; startedAt: string; vulnerabilitiesFound: number;
  criticalCount: number; highCount: number; mediumCount: number; lowCount: number;
}

type Band = "critical" | "high" | "medium" | "low" | "none";
function bandOf(sev: string | null, vulns: number): Band {
  const v = (sev || "").toLowerCase();
  if (v === "critical") return "critical";
  if (v === "high") return "high";
  if (v === "medium") return "medium";
  if (v === "low") return "low";
  return vulns > 0 ? "medium" : "none";
}
const BAND_DOT: Record<Band, string> = { critical: "bg-sev-critical", high: "bg-sev-high", medium: "bg-sev-medium", low: "bg-emerald-400", none: "bg-muted-foreground/40" };
const BAND_TEXT: Record<Band, string> = { critical: "text-sev-critical", high: "text-sev-high", medium: "text-sev-medium", low: "text-emerald-400", none: "text-muted-foreground" };
const BAND_LABEL: Record<Band, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", none: "Clean" };
// a rough 0-100 score so the average tile means something
const BAND_SCORE: Record<Band, number> = { critical: 90, high: 72, medium: 50, low: 28, none: 8 };

const READINESS_TONE: Record<string, StatusTone> = {
  completed: "complete", running: "progress", pending: "progress", queued: "review", failed: "neutral", aborted: "neutral",
};
function readinessLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * The release-readiness pipeline, derived from the real fleet rather than a
 * fixed script: each step's state and detail come from actual counts of
 * registered systems, completed scans, systems carrying findings, and systems
 * live in production. Nothing here claims progress that the data does not show —
 * an empty fleet reads as "todo" at every step, and each detail states the count
 * it is based on.
 */
function readinessSteps(
  registered: number,
  scanned: number,
  pendingScans: number,
  withFindings: number,
  live: number,
): TimelineStep[] {
  const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
  const discover: TimelineStep = {
    title: "Discover",
    detail: `${registered} ${plural(registered, "system")} registered.`,
    state: registered > 0 ? "done" : "todo",
  };
  const scan: TimelineStep = {
    title: "Scan",
    detail: registered === 0
      ? "No systems to scan yet."
      : `${scanned} of ${registered} scanned${pendingScans > 0 ? ` · ${pendingScans} in flight` : ""}.`,
    state: registered === 0
      ? "todo"
      : scanned >= registered
        ? "done"
        : scanned > 0 || pendingScans > 0
          ? "active"
          : "todo",
  };
  const review: TimelineStep = {
    title: "Review Evidence",
    detail: scanned === 0
      ? "Awaiting the first scan."
      : withFindings > 0
        ? `${withFindings} ${plural(withFindings, "system")} with findings to review.`
        : "No open findings on scanned systems.",
    state: scanned === 0 ? "todo" : withFindings > 0 ? "active" : "done",
  };
  const approval: TimelineStep = {
    title: "Human Approval",
    detail: registered === 0
      ? "No systems awaiting sign-off."
      : `${live} of ${registered} approved for production.`,
    state: registered === 0 ? "todo" : live >= registered ? "done" : live > 0 ? "active" : "todo",
  };
  const deploy: TimelineStep = {
    title: "Deploy",
    detail: `${live} ${plural(live, "system")} live in production.`,
    state: live > 0 ? "done" : "todo",
  };
  return [discover, scan, review, approval, deploy];
}


export default function Deployments() {
  const { data: clients = [], isLoading: cLoading } = useQuery<ApiClient[]>({ queryKey: ["/api/clients"] });
  const { data: tests = [] } = useQuery<ApiTest[]>({ queryKey: ["/api/tests"] });

  // latest test per client
  const latest = new Map<string, ApiTest>();
  for (const t of tests) {
    const cur = latest.get(t.clientId);
    const when = (x: ApiTest) => new Date(x.completedAt || x.startedAt).getTime();
    if (!cur || when(t) > when(cur)) latest.set(t.clientId, t);
  }

  const rows = clients.map((c) => {
    const t = latest.get(c.id);
    const vulns = t?.vulnerabilitiesFound ?? 0;
    const band = bandOf(t?.severity ?? null, vulns);
    return {
      id: c.id, system: c.name, company: c.company, status: c.status,
      readiness: t ? readinessLabel(t.status) : "Not scanned",
      readinessTone: t ? (READINESS_TONE[t.status] ?? "neutral") : ("neutral" as StatusTone),
      band, vulns, score: BAND_SCORE[band],
      crit: t?.criticalCount ?? 0, high: t?.highCount ?? 0,
      lastScan: (c.lastTestDate || t?.completedAt) ? new Date((c.lastTestDate || t?.completedAt) as string).toLocaleString() : "—",
    };
  });

  const production = clients.filter((c) => c.status === "active").length;
  const pending = tests.filter((t) => t.status === "pending" || t.status === "running").length;
  const paused = clients.filter((c) => c.status === "paused" || c.status === "inactive").length;
  const scored = rows.filter((r) => r.band !== "none");
  const avgScore = scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : 0;

  // The release-readiness pipeline, derived from the same live fleet as the rest
  // of the page: registered systems, how many have a scan, how many carry
  // findings to review, and how many are live in production.
  const scannedCount = rows.filter((r) => r.readiness !== "Not scanned").length;
  const withFindings = rows.filter((r) => r.band !== "none").length;
  const readiness = readinessSteps(clients.length, scannedCount, pending, withFindings, production);

  // filters
  const [, navigate] = useLocation();
  const [statusF, setStatusF] = useState("all");
  const [search, setSearch] = useState("");
  const statuses = Array.from(new Set(clients.map((c) => c.status)));
  const q = search.trim().toLowerCase();
  const viewRows = rows.filter((r) =>
    (statusF === "all" || r.status === statusF) &&
    (q === "" || r.system.toLowerCase().includes(q) || r.company.toLowerCase().includes(q)),
  );
  const filtersActive = statusF !== "all" || q !== "";
  const clearFilters = () => { setStatusF("all"); setSearch(""); };

  const highestRisk = rows.slice().filter((r) => r.band !== "none").sort((a, b) => b.score - a.score).slice(0, 3);
  const recent = tests.slice()
    .sort((a, b) => new Date(b.completedAt || b.startedAt).getTime() - new Date(a.completedAt || a.startedAt).getTime())
    .slice(0, 5)
    .map((t) => {
      const c = clients.find((x) => x.id === t.clientId);
      return { title: `${readinessLabel(t.status)} — ${t.testType.replace(/-/g, " ")}`, note: c?.name ?? "system", when: new Date(t.completedAt || t.startedAt).toLocaleDateString() };
    });

  const empty = !cLoading && clients.length === 0;

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-8">
      <PageHero
        title="Deployments"
        subtitle="Review and manage AI systems before trust expands."
        background="sunburst"
        verbs={["Scan", "Analyze", "Evidence", "Deploy"]}
      />
      <Divider variant="key" className="mt-5" />
      {/* Seeded demo rows are real rows, so they are counted here; this says
          how many, and that no scan produced their severity counts. */}
      <SampleDataNotice counts={["clients", "tests", "findings"]} className="mt-5" />

      {/* stats -- live */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Total Deployments" value={clients.length} icon={Boxes} />
        <StatCard label="Active Systems" value={production} icon={Activity} />
        <StatCard label="Scans Pending" value={pending} icon={Clock} />
        <StatCard label="Paused" value={paused} icon={PauseCircle} />
        <StatCard label="Average Risk Score" value={avgScore} icon={Gauge} sublabel="out of 100" />
      </div>

      {/* filters -- live */}
      <GlassCard hover={false} className="mt-5" bodyClassName="flex flex-wrap items-end gap-4">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Status</span>
          <select value={statusF} onChange={(e) => setStatusF(e.target.value)} className="rounded-lg border border-border/60 bg-surface-1/50 px-3 py-2 text-[13px] capitalize text-foreground">
            <option value="all">All statuses</option>
            {statuses.map((s) => <option key={s} value={s} className="capitalize">{s}</option>)}
          </select>
        </label>
        <label className="flex min-w-[220px] flex-[2] flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Search</span>
          <span className="flex items-center gap-2 rounded-lg border border-border/60 bg-surface-1/50 px-3 py-2 text-[13px] text-muted-foreground">
            <Search className="h-3.5 w-3.5" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search deployments…" className="w-full bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none" />
          </span>
        </label>
        {filtersActive && <button onClick={clearFilters} className="pb-2 text-[12px] font-medium text-gold hover:text-primary">Clear filters</button>}
      </GlassCard>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <GlassCard hover={false} className="overflow-hidden" bodyClassName="p-0">
          <div className="flex items-center justify-between border-b border-border/50 px-5 py-3">
            <p className="athena-label">AI Deployments</p>
            <span className="text-[11px] text-muted-foreground">{viewRows.length}{filtersActive ? ` of ${clients.length}` : ""} system{viewRows.length === 1 ? "" : "s"}</span>
          </div>
          {empty ? (
            <p className="px-5 py-10 text-center text-[13px] text-muted-foreground">No systems on record yet. Add a client and run a scan to populate this list.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left">
                <thead>
                  <tr className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                    {["System", "Status", "Readiness", "Risk", "Findings", "Last Scan", ""].map((h) => (
                      <th key={h} className="px-4 py-2 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cLoading ? (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-[12px] text-muted-foreground">Loading…</td></tr>
                  ) : viewRows.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-[12px] text-muted-foreground">No systems match the current filters.</td></tr>
                  ) : viewRows.map((d) => (
                    <tr key={d.id} className="border-t border-border/40 hover:bg-surface-1/40">
                      <td className="px-4 py-4">
                        <span className="block text-[13px] font-medium text-foreground">{d.system}</span>
                        <span className="block text-[11px] text-muted-foreground">{d.company}</span>
                      </td>
                      <td className="px-4 py-4 text-[12px] capitalize text-foreground">{d.status}</td>
                      <td className="px-4 py-4"><StatusPill tone={d.readinessTone}>{d.readiness}</StatusPill></td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          <span className={cn("h-2 w-2 rounded-full", BAND_DOT[d.band])} />
                          <span className="leading-tight">
                            <span className={cn("block text-[12px] font-medium", BAND_TEXT[d.band])}>{BAND_LABEL[d.band]}</span>
                            <span className="block text-[11px] text-muted-foreground">{d.score}/100</span>
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-[12px] text-muted-foreground">
                        {d.vulns > 0 ? <><span className="font-medium text-foreground">{d.vulns}</span> ({d.crit}C / {d.high}H)</> : "—"}
                      </td>
                      <td className="px-4 py-4 text-[12px] text-muted-foreground">{d.lastScan}</td>
                      <td className="px-4 py-4 text-muted-foreground"><MoreHorizontal className="h-4 w-4" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </GlassCard>

        {/* right rail */}
        <div className="space-y-5">
          <GlassCard hover={false}>
            <div className="mb-4 flex items-center justify-between">
              <p className="athena-label">Release Readiness</p>
              <span className="flex items-center gap-1 text-[11px] text-gold">View pipeline <ChevronRight className="h-3 w-3" /></span>
            </div>
            <Timeline steps={readiness} />
            <p className="mt-4 border-t border-border/40 pt-3 font-serif text-[13px] italic text-muted-foreground">
              "Trust is earned in the details before it reaches the world."
              <span className="mt-1 block text-[10px] uppercase tracking-[0.2em] text-gold-dim">— Mythos</span>
            </p>
          </GlassCard>

          <GlassCard hover={false}>
            <p className="athena-label mb-3">Highest Risk Deployments</p>
            {highestRisk.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No scored systems yet.</p>
            ) : (
              <ul className="space-y-3">
                {highestRisk.map((h) => (
                  <li key={h.id} className="flex items-center gap-3">
                    <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold", h.band === "critical" ? "border-sev-critical/40 text-sev-critical" : "border-sev-high/40 text-sev-high")}>{h.score}</span>
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-[13px] text-foreground">{h.system}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{h.vulns} finding{h.vulns === 1 ? "" : "s"}</span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </li>
                ))}
              </ul>
            )}
          </GlassCard>

          <GlassCard hover={false}>
            <div className="mb-3 flex items-center justify-between">
              <p className="athena-label">Recent Activity</p>
              <span className="flex items-center gap-1 text-[11px] text-gold">View all <ChevronRight className="h-3 w-3" /></span>
            </div>
            {recent.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No recent scans.</p>
            ) : (
              <ul className="space-y-3">
                {recent.map((a, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-gold" />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block text-[12px] capitalize text-foreground">{a.title}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{a.note}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground/70">{a.when}</span>
                  </li>
                ))}
              </ul>
            )}
          </GlassCard>
        </div>
      </div>

      {/* footer banner */}
      <GlassCard hover={false} ruling className="mt-5" bodyClassName="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Emblem kind="markMedallion" size={40} />
          <div>
            <p className="text-[11px] uppercase tracking-[0.28em] text-gold">Control today. A safer tomorrow.</p>
            <p className="mt-1 text-[13px] text-muted-foreground">Deploy AI with confidence, backed by evidence, governed by people.</p>
          </div>
        </div>
        <button onClick={() => navigate("/athena")} className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-gold-dim to-gold px-4 py-2 text-[13px] font-semibold text-background hover:brightness-110">
          <Plus className="h-4 w-4" /> New Deployment
        </button>
      </GlassCard>
    </div>
  );
}
