/**
 * Compliance: where an engagement stands against OWASP ASVS 4.0.3, read from
 * `/api/compliance/:clientId`. Every requirement's state -- tested, failing,
 * not run, or not covered by any scanner we have -- comes from the engine's own
 * mapping. The coverage ring, the gap list and the counts are all derived from
 * that; nothing here is a placeholder framework badge.
 *
 * The mapping is pinned to ASVS 4.0.3 while 5.0.0 is the current release, and
 * it maps what was tested; it is not a conformance claim. The page used to
 * show neither fact -- a green "Active" badge beside the framework name, a
 * "Readiness" ring, and "nothing is currently in breach" when no mapped
 * requirement failed -- so it read as a verdict against the current standard.
 * It now states the edition, that 5.0.0 is current, and what the mapping is,
 * beside every panel that renders it. See shared/asvs-edition.ts.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Layers, FileCheck2, AlertTriangle, CircleSlash, Box, Search, ChevronDown } from "lucide-react";
import PageHero from "@/components/mythos/PageHero";
import StatCard from "@/components/mythos/StatCard";
import GlassCard from "@/components/GlassCard";
import { Divider, Corners } from "@/components/mythos/Ornament";
import { cn } from "@/lib/utils";
import { ASVS_CURRENT_RELEASE, ASVS_MAPPED_VERSION } from "@shared/asvs-edition";

type ControlState = "failing" | "tested" | "not_covered" | "not_run";
interface AsvsReq { id: string; chapter: string; section: string; cwe: string | null; l1: boolean; l2: boolean; l3: boolean }
interface ControlRow { requirement: AsvsReq; state: ControlState; findings: { type: string; severity: string | null }[]; scanners: string[]; approximate: boolean }
interface Summary { version: string; failing: number; tested: number; notRun: number; notCovered: number; total: number }
interface ComplianceView { client: { id: string; name: string }; testsConsidered: number; scannersLoaded: number | null; rows: ControlRow[]; summary: Summary }
interface ApiClient { id: string; name: string; status: string }

const STATE_META: Record<ControlState, { label: string; cls: string; dot: string }> = {
  tested: { label: "Tested", cls: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10", dot: "bg-emerald-400" },
  failing: { label: "Failing", cls: "text-sev-high border-sev-high/30 bg-sev-high/10", dot: "bg-sev-high" },
  not_run: { label: "Not Run", cls: "text-sky-400 border-sky-500/30 bg-sky-500/10", dot: "bg-sky-400" },
  not_covered: { label: "Not Covered", cls: "text-muted-foreground/60 border-border/50", dot: "bg-muted-foreground/40" },
};
function StatePill({ s }: { s: ControlState }) {
  const m = STATE_META[s];
  return <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium", m.cls)}><span className={cn("h-1 w-1 rounded-full", m.dot)} />{m.label}</span>;
}
function levels(r: AsvsReq): string {
  return [r.l1 && "L1", r.l2 && "L2", r.l3 && "L3"].filter(Boolean).join(" ") || "—";
}

/** What the mapping is, said wherever it is rendered. */
function MappingStatement({ version }: { version: string }) {
  return (
    <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground" data-testid="asvs-mapping-statement">
      Pinned to OWASP ASVS <span className="text-foreground">{version}</span>. This maps the
      requirements this engine&apos;s tests bear on, and what they found; it is{" "}
      <span className="text-foreground">not a conformance claim</span>, and a requirement no scan
      reaches is untested, not met. ASVS {ASVS_CURRENT_RELEASE} is the current release and numbers its
      requirements differently, so the IDs here are {version} IDs.
    </p>
  );
}

function ReadinessDonut({ pct }: { pct: number }) {
  const r = 52, c = 2 * Math.PI * r;
  return (
    <div className="relative h-[140px] w-[140px] shrink-0">
      <svg viewBox="0 0 140 140" className="h-full w-full -rotate-90">
        <circle cx="70" cy="70" r={r} fill="none" stroke="hsl(40 20% 30% / 0.35)" strokeWidth="12" />
        <circle cx="70" cy="70" r={r} fill="none" stroke="hsl(var(--gold))" strokeWidth="12" strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`} style={{ filter: "drop-shadow(0 0 6px hsl(44 88% 62% / 0.6))" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="athena-figure text-[26px] font-semibold text-foreground">{pct}%</span>
        <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Tested</span>
      </div>
    </div>
  );
}

export default function Compliance() {
  const { data: clients = [] } = useQuery<ApiClient[]>({ queryKey: ["/api/clients"] });
  const { data: tests = [] } = useQuery<{ clientId: string; startedAt: string; completedAt: string | null }[]>({ queryKey: ["/api/tests"] });
  // default to the most recently scanned engagement so fresh ASVS results surface
  const latestTest = tests.slice().sort((a, b) =>
    new Date(b.completedAt || b.startedAt).getTime() - new Date(a.completedAt || a.startedAt).getTime(),
  )[0];
  const defaultClientId = latestTest?.clientId ?? clients.find((c) => c.status === "active")?.id ?? clients[0]?.id ?? "";
  const [picked, setPicked] = useState("");
  const [search, setSearch] = useState("");
  const clientId = picked || defaultClientId;
  const { data, isLoading } = useQuery<ComplianceView>({ queryKey: [`/api/compliance/${clientId}`], enabled: clientId !== "" });

  const rows = data?.rows ?? [];
  const summary = data?.summary;
  const total = summary?.total ?? 0;
  // The server reports the edition it mapped against; before it answers, the
  // edition this build's mapping is pinned to -- the same constant it reads.
  const version = summary?.version ?? ASVS_MAPPED_VERSION;
  const testedPct = total ? Math.round(((summary?.tested ?? 0) / total) * 100) : 0;

  // show the requirements that matter first: failing, then not-run, then tested
  const orderRank: Record<ControlState, number> = { failing: 0, not_run: 1, tested: 2, not_covered: 3 };
  const q = search.trim().toLowerCase();
  const matched = rows.filter((r) =>
    q === "" ||
    r.requirement.id.toLowerCase().includes(q) ||
    r.requirement.chapter.toLowerCase().includes(q) ||
    r.requirement.section.toLowerCase().includes(q),
  );
  const shown = matched.slice().sort((a, b) => orderRank[a.state] - orderRank[b.state]).slice(0, 20);
  const gaps = rows.filter((r) => r.state === "failing").slice(0, 6);

  const legend = [
    { label: "Tested", value: summary?.tested ?? 0, cls: "bg-emerald-400" },
    { label: "Failing", value: summary?.failing ?? 0, cls: "bg-sev-high" },
    { label: "Not Run", value: summary?.notRun ?? 0, cls: "bg-sky-400" },
    { label: "Not Covered", value: summary?.notCovered ?? 0, cls: "bg-muted-foreground/50" },
  ];
  const empty = !isLoading && rows.length === 0;

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-8">
      <PageHero
        title="Compliance"
        subtitle="Turn AI risk management into audit readiness. Map controls, collect evidence, and demonstrate trust."
        background="owl-seal"
        verbs={["Trust", "Govern", "Demonstrate", "Advance"]}
      />
      <Divider variant="key" className="mt-5" />

      {/* stats -- live from the ASVS mapping */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard layout="tile" label={`ASVS ${version} Requirements`} value={total} icon={Layers} />
        <StatCard layout="tile" label="Tested" value={summary?.tested ?? 0} icon={FileCheck2} />
        <StatCard layout="tile" label="Open Gaps" value={summary?.failing ?? 0} icon={AlertTriangle} accent="var(--sev-high)" />
        <StatCard layout="tile" label="Not Run" value={summary?.notRun ?? 0} icon={CircleSlash} />
        <StatCard layout="tile" label="Tests Considered" value={data?.testsConsidered ?? 0} icon={Box} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <GlassCard hover={false}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="athena-label">Framework</p>
                <p className="mt-1 text-[13px] text-foreground" data-testid="asvs-version">OWASP ASVS <span className="text-muted-foreground">{version}</span></p>
              </div>
              <div className="flex items-center gap-2">
                {clients.length > 0 && (
                  <span className="relative inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-surface-1/50 px-3 py-1.5 text-[12px] text-foreground">
                    <select value={clientId} onChange={(e) => setPicked(e.target.value)} className="cursor-pointer appearance-none bg-transparent pr-4 focus:outline-none">
                      {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-muted-foreground" />
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-surface-1/50 px-2.5 py-0.5 text-[11px] text-muted-foreground" title={`ASVS ${ASVS_CURRENT_RELEASE} is the current release`}>Pinned · {version}</span>
              </div>
            </div>
            <p className="mt-2 text-[12px] text-muted-foreground">
              {data?.scannersLoaded != null
                ? `${data.scannersLoaded} scanners loaded, bearing on the application-security verification standard.`
                : "The application-security verification standard the engine maps its findings onto."}
            </p>
            <MappingStatement version={version} />
          </GlassCard>

          <GlassCard hover={false} bodyClassName="p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-3">
              <div>
                <p className="athena-label">Control Mapping</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Findings mapped to ASVS {version} requirements. A mapping of what was tested, not a conformance claim.</p>
              </div>
              <label className="hidden items-center gap-2 rounded-lg border border-border/60 bg-surface-1/50 px-3 py-1.5 text-[12px] text-muted-foreground md:flex">
                <Search className="h-3.5 w-3.5" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search requirements…" className="w-36 bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none" />
              </label>
            </div>
            {empty ? (
              <p className="px-5 py-10 text-center text-[13px] text-muted-foreground">{isLoading ? "Loading control mapping…" : "No control mapping yet — run a scan to populate ASVS coverage."}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/80">
                      {["#", "Requirement", "Level", "State", "Findings"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.length === 0 && (
                      <tr><td colSpan={5} className="px-4 py-8 text-center text-[12px] text-muted-foreground">No requirements match “{search}”.</td></tr>
                    )}
                    {shown.map((r) => (
                      <tr key={r.requirement.id} className="border-t border-border/40 hover:bg-surface-1/40">
                        <td className="px-4 py-2.5 text-[11px] text-muted-foreground">{r.requirement.id}</td>
                        <td className="px-4 py-2.5 text-[12px] text-foreground">{r.requirement.chapter} · {r.requirement.section}</td>
                        <td className="px-4 py-2.5 text-[11px] text-muted-foreground">{levels(r.requirement)}</td>
                        <td className="px-4 py-2.5"><StatePill s={r.state} /></td>
                        <td className="px-4 py-2.5 text-[12px] text-muted-foreground">{r.findings.length || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </GlassCard>
        </div>

        {/* right rail */}
        <div className="space-y-5">
          {/* Not `ruling`: gold is for judgements, and this is a measurement. */}
          <GlassCard hover={false} className="relative overflow-hidden" data-testid="asvs-coverage">
            <Corners />
            <div className="mb-3 flex items-center justify-between">
              <p className="athena-label">Test Coverage</p>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-surface-1/50 px-2 py-0.5 text-[10px] text-muted-foreground">ASVS {version}</span>
            </div>
            <div className="flex items-center gap-4">
              <ReadinessDonut pct={testedPct} />
              <ul className="flex-1 space-y-1.5">
                {legend.map((l) => (
                  <li key={l.label} className="flex items-center gap-2 text-[12px]">
                    <span className={cn("h-2 w-2 rounded-full", l.cls)} />
                    <span className="font-semibold text-foreground">{l.value}</span>
                    <span className="text-muted-foreground">{l.label}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground" data-testid="asvs-coverage-note">
              Share of ASVS {version} requirements in the Tested state. A mapping of what was tested,
              not a conformance score; ASVS {ASVS_CURRENT_RELEASE} is the current release.
            </p>
          </GlassCard>

          <GlassCard hover={false}>
            <p className="athena-label mb-2">High-Priority Control Gaps</p>
            {gaps.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">{isLoading ? "Loading…" : "No mapped requirement is failing in the tests considered. Requirements not run or not covered were not checked."}</p>
            ) : (
              <ul className="space-y-2.5">
                {gaps.map((g) => (
                  <li key={g.requirement.id} className="flex items-center gap-2.5">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-sev-high" />
                    <span className="text-[12px] font-medium text-foreground">{g.requirement.id}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{g.requirement.section}</span>
                  </li>
                ))}
              </ul>
            )}
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
