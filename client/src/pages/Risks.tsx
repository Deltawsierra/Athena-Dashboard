/**
 * Risks: every open finding across the estate, read from the engine's own
 * record. The severity heatmap, the category donut, the register and the
 * headline counts are all derived from `/api/findings`; the reasoning card
 * quotes the sharpest open finding. Where the backend has no source -- the
 * ripple effects are illustrative -- the copy says as much rather than
 * inventing a number.
 *
 * A findings request that failed, or had not answered yet, used to render as
 * "0 open" and "No open findings. Nothing here needs attention right now." A
 * source nobody read is not a zero and not an all-clear: every figure here
 * reads "…" while it loads and "—" with the reason when it failed, and the
 * all-clear appears only for a successful, empty answer.
 *
 * "Open" here is open or acknowledged (in review): an acknowledged critical
 * is still there, and used to drop out of every open figure -- so the
 * reasoning card said "nothing here needs attention" above a register row
 * reading "Critical · Acknowledged". Accepted risks and verified fixes are
 * not open, and the all-clear says it does not count them.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  AlertTriangle,
  Flame,
  TriangleAlert,
  CheckCircle2,
  ShieldCheck,
  MoreHorizontal,
  X,
  ShieldAlert,
  Radio,
  Share2,
  UserX,
} from "lucide-react";
import PageHero from "@/components/mythos/PageHero";
import StatCard from "@/components/mythos/StatCard";
import GlassCard from "@/components/GlassCard";
import SampleDataNotice from "@/components/SampleDataNotice";
import { Divider, Corners } from "@/components/mythos/Ornament";
import { SEV_LABEL, SeverityPill, StatusPill, severityFrom, type Severity, type StatusTone } from "@/components/mythos/atoms";
import owlMedallion from "@assets/mythos/owl-medallion.webp";
import { cn } from "@/lib/utils";
import { figure, loaded, notInHand, type Loaded } from "@/lib/loaded";
import { isOpenStatus, untrackedResults, type FindingsSummary, type UntrackedScan } from "@shared/findings-summary";

/* ---- live types (subset of the API shapes) ---------------------------- */
interface ApiClient { id: string; name: string; status: string; lastTestDate: string | null }
interface ApiFinding {
  id: string; type: string; severity: string | null; message: string | null;
  target: string | null; endpoint: string | null; status: string; ownerId: string | null;
}
interface FindingsView { findings: ApiFinding[]; counts: Record<string, number> }
interface ApiUser { id: string; username: string }

// "unrated" (no severity recorded) ranks below low and above info: it may be critical.
const SEV_ORDER: Severity[] = ["critical", "high", "medium", "low", "unrated", "info"];
// The heatmap's columns: the four bands, and the findings no severity rates,
// which were counted in none of them.
const SEV_COLS = ["Critical", "High", "Medium", "Low", "Not rated"] as const;
const SEV_HUE = ["--sev-critical", "--sev-high", "--sev-medium", "--sev-low", "--muted-foreground"];
const CAT_COLORS = ["hsl(var(--gold))", "hsl(var(--sev-high))", "hsl(var(--sev-medium))", "hsl(210 80% 60%)", "hsl(var(--accent-violet))", "hsl(0 0% 55%)"];

/** A finding's severity, read as every reader reads it (any case, trimmed); "unrated" when it has none, never info. */
function normSev(s: string | null): Severity {
  return severityFrom(s);
}
function humanize(t: string): string {
  return t.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
/** The impact a severity implies; none is invented for a finding no severity rates. */
function impactOf(sev: Severity): "High" | "Medium" | "Low" | "Unknown" {
  if (sev === "critical" || sev === "high") return "High";
  if (sev === "medium") return "Medium";
  if (sev === "unrated") return "Unknown";
  return "Low";
}
const STATUS_TONE: Record<string, { label: string; tone: StatusTone }> = {
  open: { label: "Open", tone: "review" },
  acknowledged: { label: "Acknowledged", tone: "progress" },
  accepted: { label: "Accepted", tone: "neutral" },
  fixed: { label: "Fixed", tone: "complete" },
};

const RIPPLE = [
  { icon: ShieldAlert, text: "Exposure of additional customer PII across connected systems" },
  { icon: Radio, text: "Potential regulatory investigation (PCI, GLBA, GDPR)" },
  { icon: Share2, text: "Increased attack surface for adversarial data extraction" },
  { icon: UserX, text: "Reputational damage and customer churn" },
];

function Donut({ segments, center, sub }: { segments: { value: number; color: string }[]; center: string; sub: string }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = 52, c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="relative h-[150px] w-[150px] shrink-0">
      <svg viewBox="0 0 140 140" className="h-full w-full -rotate-90">
        <circle cx="70" cy="70" r={r} fill="none" stroke="hsl(40 20% 30% / 0.25)" strokeWidth="14" />
        {segments.map((s, i) => {
          const len = (s.value / total) * c;
          const el = <circle key={i} cx="70" cy="70" r={r} fill="none" stroke={s.color} strokeWidth="14" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} />;
          offset += len;
          return el;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="athena-figure text-[24px] font-semibold text-foreground">{center}</span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{sub}</span>
      </div>
    </div>
  );
}

function HeatCell({ hue, count }: { hue: string; count: number }) {
  if (count === 0) return <td className="border border-border/30 px-3 py-2.5 text-center text-[12px] text-muted-foreground/40">0</td>;
  const alpha = 0.2 + Math.min(count, 5) / 5 * 0.55;
  return <td className="border border-border/30 px-3 py-2.5 text-center text-[12px] font-semibold text-foreground" style={{ background: `hsl(var(${hue}) / ${alpha})` }}>{count}</td>;
}

function FilterSelect({
  label, value, onChange, options,
}: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-border/60 bg-surface-1/50 px-3 py-2 text-[13px] text-foreground"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export default function Risks() {
  const clientsQ = loaded(useQuery<ApiClient[]>({ queryKey: ["/api/clients"] }));
  const clients = clientsQ.state === "ready" ? clientsQ.data : [];
  const { data: tests = [] } = useQuery<{ clientId: string; startedAt: string; completedAt: string | null }[]>({ queryKey: ["/api/tests"] });
  const [selClient, setSelClient] = useState("");
  // default to the most recently scanned engagement so fresh results surface
  const latestTest = tests.slice().sort((a, b) =>
    new Date(b.completedAt || b.startedAt).getTime() - new Date(a.completedAt || a.startedAt).getTime(),
  )[0];
  const defaultClient = latestTest?.clientId
    ?? clients.find((c) => c.status === "active")?.id ?? clients[0]?.id ?? "";
  const clientId = selClient || defaultClient;
  const { data: users = [] } = useQuery<ApiUser[]>({ queryKey: ["/api/users/assignable"] });
  const findingsQ = useQuery<FindingsView>({
    queryKey: ["/api/findings", { clientId }],
    enabled: clientId !== "",
  });
  // What the findings figures read: the engagements first (no engagement is
  // not an empty one), then the chosen engagement's findings.
  const noEngagement = clientsQ.state === "ready" && clients.length === 0;
  const source: Loaded<FindingsView> =
    clientsQ.state === "error"
      ? { state: "error", message: `engagements: ${clientsQ.message}` }
      : noEngagement
        ? { state: "error", message: "no engagement on record" }
        : loaded(findingsQ);
  const ready = source.state === "ready";
  /** Why the findings figures are not shown, in a sentence. */
  const unavailable = clientsQ.state === "error"
    ? `Could not load engagements: ${clientsQ.message}`
    : noEngagement
      ? "No engagement on record yet. Add a client and run a scan; its findings appear here."
      : notInHand(source, "findings");

  // What this engagement's latest completed scan reported, when no finding row
  // stands behind it (a scan a person recorded on the Tests screen). The
  // findings ledger cannot see those counts, so "nothing needs attention" is
  // said only once the summary has answered that there are none.
  const summaryQ = loaded(useQuery<FindingsSummary>({ queryKey: ["/api/findings/summary"] }));
  const untracked: Loaded<UntrackedScan | null> = (() => {
    if (summaryQ.state !== "ready") return summaryQ;
    const own = summaryQ.data.byClient.find((one) => one.clientId === clientId);
    return own
      ? { state: "ready", data: own.untrackedScan }
      : { state: "error", message: "this engagement is not in the findings summary yet" };
  })();

  const data = ready ? source.data : undefined;
  const findings = data?.findings ?? [];
  const counts = data?.counts ?? {};
  const count = (read: (view: FindingsView) => number) => (noEngagement ? "—" : figure(source, read));
  const userName = (id: string | null) => users.find((u) => u.id === id)?.username ?? (id ? "Assigned" : "Unassigned");

  // headline counts, from the full engagement record (unaffected by the filters)
  const allOpen = findings.filter((f) => isOpenStatus(f.status));
  const crit = allOpen.filter((f) => normSev(f.severity) === "critical").length;
  const high = allOpen.filter((f) => normSev(f.severity) === "high").length;
  const sharpest = allOpen.slice().sort((a, b) => SEV_ORDER.indexOf(normSev(a.severity)) - SEV_ORDER.indexOf(normSev(b.severity)))[0];

  // filters -- narrow the register and the charts, live over the findings
  const [sevF, setSevF] = useState("all");
  const [statusF, setStatusF] = useState("all");
  const [catF, setCatF] = useState("all");
  const [search, setSearch] = useState("");
  const catOptions = Array.from(new Set(findings.map((f) => humanize(f.type)))).sort();
  const q = search.trim().toLowerCase();
  const view = findings.filter((f) =>
    (sevF === "all" || normSev(f.severity) === sevF) &&
    (statusF === "all" || f.status === statusF) &&
    (catF === "all" || humanize(f.type) === catF) &&
    (q === "" || (f.message ?? "").toLowerCase().includes(q) || (f.target ?? "").toLowerCase().includes(q) || f.type.toLowerCase().includes(q)),
  );
  const filtersActive = sevF !== "all" || statusF !== "all" || catF !== "all" || q !== "";
  const clearFilters = () => { setSevF("all"); setStatusF("all"); setCatF("all"); setSearch(""); };
  const open = view.filter((f) => isOpenStatus(f.status));

  // category (by finding type) breakdown for the donut + legend
  const byCat = new Map<string, number>();
  open.forEach((f) => byCat.set(humanize(f.type), (byCat.get(humanize(f.type)) ?? 0) + 1));
  const cats = Array.from(byCat.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const donut = cats.map(([label, value], i) => ({ label, value, color: CAT_COLORS[i % CAT_COLORS.length] }));

  // category x severity heatmap
  const heat = cats.map(([label]) => {
    const rows = open.filter((f) => humanize(f.type) === label);
    const cells = SEV_ORDER.slice(0, 5).map((sv) => rows.filter((f) => normSev(f.severity) === sv).length);
    return { name: label, cells, total: rows.length };
  });

  // register, worst first (filtered)
  const register = [...view]
    .sort((a, b) => SEV_ORDER.indexOf(normSev(a.severity)) - SEV_ORDER.indexOf(normSev(b.severity)))
    .map((f, i) => ({
      n: i + 1, sev: normSev(f.severity), finding: f.message || humanize(f.type),
      category: humanize(f.type), system: f.target || f.endpoint || "—",
      impact: impactOf(normSev(f.severity)), owner: userName(f.ownerId),
      status: STATUS_TONE[f.status] ?? { label: humanize(f.status), tone: "neutral" as StatusTone },
    }));

  // A share of nothing is not 0%: with no findings on record, or none in hand,
  // there is no remediated share to show.
  const fixedPct = ready && findings.length > 0 ? `${Math.round(((counts.fixed ?? 0) / findings.length) * 100)}%` : "—";
  const remediation = [
    { label: "Fixed", value: counts.fixed ?? 0, cls: "bg-emerald-400", color: "hsl(150 60% 55%)" },
    { label: "Acknowledged", value: counts.acknowledged ?? 0, cls: "bg-sky-400", color: "hsl(205 80% 60%)" },
    { label: "Open", value: counts.open ?? 0, cls: "bg-muted-foreground/50", color: "hsl(40 10% 45%)" },
  ];

  const empty = ready && view.length === 0;
  const emptyReason = findings.length === 0
    ? "No findings recorded for this engagement yet. Run a scan from the Athena screen and results will appear here."
    : "No findings match the current filters.";

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-8">
      <PageHero
        title="Risks"
        subtitle="Discover, prioritize, and remediate AI risks before they become real-world problems."
        background="astrolabe"
        verbs={["Analyze", "Evidence", "Mitigate", "Strengthen"]}
      />
      <Divider variant="astrolabe" className="mt-5" />
      {/* The engagement picker lists seeded demo clients like any other, and a
          seeded test's counts can reach the reasoning panel; this says how many. */}
      <SampleDataNotice counts={["clients", "tests"]} className="mt-5" />

      {/* stats -- all live from the findings ledger */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Total Open Risks" value={count((v) => (v.counts.open ?? 0) + (v.counts.acknowledged ?? 0))} icon={AlertTriangle}
          sublabel={source.state === "error" ? "Not in hand" : "Open or in review, this engagement"} />
        <StatCard label="Critical Risks" value={count(() => crit)} icon={Flame} accent="var(--sev-critical)" />
        <StatCard label="High Risks" value={count(() => high)} icon={TriangleAlert} accent="var(--sev-high)" />
        <StatCard label="Acknowledged" value={count((v) => v.counts.acknowledged ?? 0)} icon={ShieldCheck} sublabel="in review" />
        <StatCard label="Fixed" value={count((v) => v.counts.fixed ?? 0)} icon={CheckCircle2} sublabel="remediated & verified" />
      </div>

      {/* filters -- all live: engagement switches the query, the rest filter the view */}
      <GlassCard hover={false} className="mt-5" bodyClassName="flex flex-wrap items-end gap-4">
        <FilterSelect label="Engagement" value={clientId} onChange={setSelClient}
          options={clients.map((c) => ({ value: c.id, label: c.name }))} />
        <FilterSelect label="Severity" value={sevF} onChange={setSevF}
          options={[{ value: "all", label: "All severities" }, ...SEV_ORDER.map((s) => ({ value: s, label: SEV_LABEL[s] }))]} />
        <FilterSelect label="Status" value={statusF} onChange={setStatusF}
          options={[{ value: "all", label: "All statuses" }, { value: "open", label: "Open" }, { value: "acknowledged", label: "Acknowledged" }, { value: "accepted", label: "Accepted" }, { value: "fixed", label: "Fixed" }]} />
        <FilterSelect label="Category" value={catF} onChange={setCatF}
          options={[{ value: "all", label: "All categories" }, ...catOptions.map((c) => ({ value: c, label: c }))]} />
        <label className="flex min-w-[180px] flex-1 flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Search</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search findings…"
            className="rounded-lg border border-border/60 bg-surface-1/50 px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/70"
          />
        </label>
        {filtersActive && (
          <button onClick={clearFilters} className="flex items-center gap-1.5 pb-2 text-[12px] font-medium text-gold hover:text-primary"><X className="h-3.5 w-3.5" /> Clear filters</button>
        )}
      </GlassCard>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <GlassCard hover={false}>
              <p className="athena-label mb-3">Risks by Category and Severity</p>
              {!ready ? (
                <p className="py-8 text-center text-[12px] text-muted-foreground">{unavailable}</p>
              ) : heat.length === 0 ? (
                <p className="py-8 text-center text-[12px] text-muted-foreground">No open tracked findings to chart.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground/80">
                        <th className="px-2 py-1.5 font-medium"></th>
                        {SEV_COLS.map((s) => <th key={s} className="px-2 py-1.5 text-center font-medium">{s}</th>)}
                        <th className="px-2 py-1.5 text-center font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {heat.map((c) => (
                        <tr key={c.name}>
                          <td className="whitespace-nowrap px-2 py-2.5 text-[12px] text-foreground">{c.name}</td>
                          {c.cells.map((n, i) => <HeatCell key={i} hue={SEV_HUE[i]} count={n} />)}
                          <td className="border border-border/30 px-2 py-2.5 text-center text-[12px] font-semibold text-foreground">{c.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </GlassCard>

            <GlassCard hover={false} className="relative overflow-hidden">
              <Corners />
              <p className="athena-label mb-3">Open Risks by Category</p>
              <div className="flex items-center gap-4">
                <Donut segments={donut.length ? donut : [{ value: 1, color: "hsl(40 20% 30% / 0.4)" }]} center={String(count(() => open.length))} sub="Open Risks" />
                <ul className="flex-1 space-y-1.5">
                  {!ready ? (
                    <li className="text-[12px] text-muted-foreground">{unavailable}</li>
                  ) : donut.length === 0 ? (
                    <li className="text-[12px] text-muted-foreground">No open tracked findings.</li>
                  ) : donut.map((d) => (
                    <li key={d.label} className="flex items-center gap-2 text-[12px]">
                      <span className="h-2 w-2 rounded-full" style={{ background: d.color }} />
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{d.label}</span>
                      <span className="font-semibold text-foreground">{d.value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </GlassCard>
          </div>

          <GlassCard hover={false} bodyClassName="p-0">
            <div className="flex items-center justify-between border-b border-border/50 px-5 py-3">
              <p className="athena-label">Risk Register <span className="text-muted-foreground">({ready ? `${view.length}${filtersActive ? ` of ${findings.length}` : ""}` : count(() => 0)})</span></p>
            </div>
            {!ready ? (
              <p className="px-5 py-10 text-center text-[13px] text-muted-foreground">{unavailable}</p>
            ) : empty ? (
              <p className="px-5 py-10 text-center text-[13px] text-muted-foreground">{emptyReason}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/80">
                      {["#", "Severity", "Finding", "Category", "Affected System", "Impact", "Owner", "Status", ""].map((h, i) => (
                        <th key={i} className="px-3 py-2 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {register.map((r) => (
                      <tr key={r.n} className="border-t border-border/40 hover:bg-surface-1/40">
                        <td className="px-3 py-2.5 text-[12px] text-muted-foreground">{r.n}</td>
                        <td className="px-3 py-2.5"><SeverityPill severity={r.sev} /></td>
                        <td className="px-3 py-2.5 text-[12px] text-foreground">{r.finding}</td>
                        <td className="px-3 py-2.5 text-[12px] text-muted-foreground">{r.category}</td>
                        <td className="px-3 py-2.5 text-[12px] text-muted-foreground">{r.system}</td>
                        <td className="px-3 py-2.5"><span className={cn("text-[12px] font-medium", r.impact === "High" ? "text-sev-high" : r.impact === "Medium" ? "text-sev-medium" : "text-sky-400")}>{r.impact}</span></td>
                        <td className="px-3 py-2.5 text-[12px] text-muted-foreground">{r.owner}</td>
                        <td className="px-3 py-2.5"><StatusPill tone={r.status.tone}>{r.status.label}</StatusPill></td>
                        <td className="px-3 py-2.5 text-muted-foreground"><MoreHorizontal className="h-4 w-4" /></td>
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
          <GlassCard hover={false} ruling>
            <div className="mb-3 flex items-center justify-between">
              <p className="athena-label">Athena Reasoning</p>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-primary"><span className="athena-live h-1.5 w-1.5 rounded-full bg-primary" /> Live</span>
            </div>
            <div className="flex gap-3">
              <img src={owlMedallion} alt="" aria-hidden="true" className="h-9 w-9 shrink-0 select-none object-contain" />
              {/* The all-clear is said only about an answer that came back
                  empty -- never about one that failed or has not arrived. */}
              <p className="font-serif text-[13px] italic text-foreground">
                {!ready
                  ? unavailable
                  : sharpest
                    ? `"${sharpest.message || humanize(sharpest.type)}" — ${normSev(sharpest.severity) === "unrated" ? "no severity recorded" : `${normSev(sharpest.severity)} severity`} on ${sharpest.target || "the target"}.`
                    : untracked.state !== "ready"
                      ? `"No open or in-review tracked findings." ${notInHand(untracked, "what the latest completed scan reported")}`
                      : untracked.data
                        ? `"No open or in-review tracked findings, but ${(untracked.data.scans ?? 1) > 1 ? `${untracked.data.scans} latest completed scans (one per site)` : "the latest completed scan"} reported ${untrackedResults(untracked.data)}."`
                        // Exactly what it covers. Not "the latest scan reported
                        // no critical": one it reported and filed, then fixed
                        // or accepted, is not open and not untracked. And never
                        // beside a scan rated critical or high that counted
                        // nothing there, or results nobody rated: the summary
                        // flags those (untrackedScan), since none is on record
                        // as tracked.
                        : "\"No open or in-review tracked findings, and every critical or high result of this engagement's latest completed scans is tracked as a finding. Nothing here needs attention right now. Accepted risks and verified fixes are not counted.\""}
              </p>
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
              {ready && sharpest
                ? "This is the sharpest open finding on record. Remediate it, then re-run the scan to confirm it closes."
                : "When a scan records a finding, Athena's read on the most pressing one shows here."}
            </p>
          </GlassCard>

          <GlassCard hover={false}>
            <p className="athena-label mb-1">Likely Ripple Effects</p>
            <p className="mb-3 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">Illustrative — not from scan data</p>
            <ul className="space-y-3">
              {RIPPLE.map((r) => {
                const Icon = r.icon;
                return (
                  <li key={r.text} className="flex items-start gap-2.5">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                    <span className="text-[12px] leading-snug text-muted-foreground">{r.text}</span>
                  </li>
                );
              })}
            </ul>
          </GlassCard>

          <GlassCard hover={false} className="relative overflow-hidden">
            <Corners />
            <div className="mb-3 flex items-center justify-between">
              <p className="athena-label">Remediation Progress</p>
            </div>
            <div className="flex items-center gap-4">
              <Donut segments={ready && remediation.some((r) => r.value) ? remediation : [{ value: 1, color: "hsl(40 20% 30% / 0.4)" }]} center={fixedPct} sub="Remediated" />
              <ul className="flex-1 space-y-1.5">
                {remediation.map((r) => (
                  <li key={r.label} className="flex items-center gap-2 text-[12px]">
                    <span className={cn("h-2 w-2 rounded-full", r.cls)} />
                    <span className="font-semibold text-foreground">{count(() => r.value)}</span>
                    <span className="text-muted-foreground">{r.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
