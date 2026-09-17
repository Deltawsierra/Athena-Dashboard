/**
 * Overview: the assurance program at a glance. Five headline metrics, then the
 * three readings a leader scans first -- where risk sits overall, where findings
 * are trending, and which environments carry the most -- over the working lists
 * (coverage, systems needing attention, activity, upcoming reviews, open issues).
 *
 * Every figure is fixture data shaped like the real program, so the page reads
 * as a populated estate rather than a wireframe and can be wired to live counts
 * later without moving anything.
 */
import {
  Boxes,
  ScanLine,
  AlertTriangle,
  CheckCircle2,
  ShieldCheck,
  FileCheck2,
  Calendar,
  ArrowRight,
} from "lucide-react";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import GlassCard from "@/components/GlassCard";
import mythosGlyph from "@assets/mythos/mark-glyph.webp";
import PageHero from "@/components/mythos/PageHero";
import { Divider, RingFrame } from "@/components/mythos/Ornament";
import StatCard from "@/components/mythos/StatCard";
import { Label, SeverityPill, type Severity } from "@/components/mythos/atoms";
import { cn } from "@/lib/utils";

const TREND = [
  { m: "Jan", critical: 4, high: 6, medium: 3, low: 2 },
  { m: "Feb", critical: 5, high: 7, medium: 4, low: 3 },
  { m: "Mar", critical: 7, high: 8, medium: 5, low: 3 },
  { m: "Apr", critical: 9, high: 9, medium: 6, low: 4 },
  { m: "May", critical: 11, high: 10, medium: 6, low: 4 },
  { m: "Jun", critical: 13, high: 11, medium: 7, low: 4 },
  { m: "Jul", critical: 16, high: 11, medium: 8, low: 5 },
  { m: "Aug", critical: 18, high: 12, medium: 8, low: 5 },
  { m: "Sep", critical: 21, high: 13, medium: 9, low: 5 },
  { m: "Oct", critical: 23, high: 14, medium: 9, low: 5 },
];
const TREND_SERIES = [
  { key: "critical", label: "Critical", color: "hsl(var(--sev-critical))" },
  { key: "high", label: "High", color: "hsl(var(--sev-high))" },
  { key: "medium", label: "Medium", color: "hsl(var(--sev-medium))" },
  { key: "low", label: "Low", color: "hsl(var(--sev-low))" },
] as const;

const ENV_RISK = [
  { env: "Production", value: 11, tone: "hsl(var(--sev-critical))" },
  { env: "Staging", value: 7, tone: "hsl(var(--sev-high))" },
  { env: "Development", value: 4, tone: "hsl(var(--sev-medium))" },
  { env: "Third-party", value: 3, tone: "hsl(var(--sev-medium))" },
  { env: "R&D", value: 2, tone: "hsl(var(--sev-info))" },
];
const ENV_MAX = 11;

const COVERAGE = [
  { name: "Customer Support Agent", pct: 100 },
  { name: "Fraud Detection", pct: 87 },
  { name: "Document Intelligence", pct: 71 },
  { name: "Marketing Assistant", pct: 56 },
  { name: "Internal Knowledge Copilot", pct: 43 },
  { name: "Code Review Assistant", pct: 38 },
];

const ATTENTION = [
  { name: "Marketing Content Generator", note: "New high severity findings", sev: "high", ago: "2d ago" },
  { name: "HR Policy Assistant", note: "Scan overdue (7 days)", sev: "medium", ago: "3d ago" },
  { name: "Finance Data Q&A", note: "Unreviewed findings", sev: "medium", ago: "4d ago" },
  { name: "Legacy Chatbot", note: "Compliance evidence missing", sev: "low", ago: "5d ago" },
  { name: "Product Research Agent", note: "Third-party data sharing risk", sev: "low", ago: "6d ago" },
] as { name: string; note: string; sev: Severity; ago: string }[];

const ACTIVITY = [
  { icon: CheckCircle2, tone: "text-emerald-400", text: "Scan completed: Customer Support Agent", meta: "No new findings", ago: "2h ago" },
  { icon: AlertTriangle, tone: "text-sev-high", text: "New high severity finding", meta: "Marketing Content Generator", ago: "4h ago" },
  { icon: ShieldCheck, tone: "text-emerald-400", text: "Deployment approved", meta: "Fraud Detection", ago: "6h ago" },
  { icon: FileCheck2, tone: "text-primary", text: "Evidence uploaded", meta: "Internal Knowledge Copilot", ago: "1d ago" },
  { icon: ScanLine, tone: "text-primary", text: "Scan started", meta: "HR Policy Assistant", ago: "1d ago" },
];

const REVIEWS = [
  { date: "Oct 15", name: "Customer Support Agent", findings: 3, sev: "high" },
  { date: "Oct 16", name: "Finance Data Q&A", findings: 5, sev: "medium" },
  { date: "Oct 17", name: "Marketing Content Generator", findings: 4, sev: "medium" },
  { date: "Oct 18", name: "Code Review Assistant", findings: 2, sev: "low" },
  { date: "Oct 20", name: "Vendor Data Extractor", findings: 3, sev: "low" },
] as { date: string; name: string; findings: number; sev: Severity }[];

const OPEN_ISSUES = [
  { t: "Customer PII included in support prompts", sev: "critical" },
  { t: "Unrestricted access to CRM customer records", sev: "high" },
  { t: "Potential data retention beyond policy", sev: "high" },
  { t: "Third-party data sharing lacks contractual controls", sev: "medium" },
  { t: "Insufficient monitoring for prompt injection", sev: "medium" },
] as { t: string; sev: Severity }[];

function RiskPosture() {
  const size = 150;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = 0.62; // moderate
  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(40 20% 30% / 0.35)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsl(var(--sev-medium))"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${pct * c} ${c}`}
          style={{ filter: "drop-shadow(0 0 6px hsl(var(--sev-medium) / 0.6))" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
        <img src={mythosGlyph} alt="" aria-hidden="true" className="h-8 w-8 select-none object-contain" />
        <span className="font-serif text-lg font-semibold text-gold">Moderate Risk</span>
      </div>
    </div>
  );
}

export default function Overview() {
  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-8">
      <PageHero
        title="Overview"
        subtitle="Your AI assurance program at a glance. Manage risk. Enable innovation. Build trust."
        background="vista"
        verbs={["Analyze", "Evidence", "Deploy"]}
      />
      <Divider variant="astrolabe" className="mt-5" />

      {/* headline metrics */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Total AI Systems" value={42} icon={Boxes} delta={{ value: "+16%", direction: "up", good: true, note: "vs. last month" }} />
        <StatCard label="Active Scans" value={18} icon={ScanLine} delta={{ value: "+6%", direction: "up", good: true, note: "vs. last month" }} />
        <StatCard label="Open Findings" value={23} icon={AlertTriangle} accent="var(--sev-high)" delta={{ value: "+28%", direction: "up", good: false, note: "vs. last month" }} />
        <StatCard label="Deployment Decisions" value={31} icon={CheckCircle2} delta={{ value: "+48%", direction: "up", good: true, note: "approved" }} />
        <StatCard label="Compliance Readiness" value="87%" icon={ShieldCheck} delta={{ value: "+5%", direction: "up", good: true, note: "vs. last month" }} />
      </div>

      {/* posture / trend / env */}
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)_360px]">
        <GlassCard hover={false}>
          <Label>Overall Risk Posture</Label>
          <div className="mt-4">
            <RingFrame variant="ring" className="mx-auto w-[248px]">
              <RiskPosture />
            </RingFrame>
          </div>
          <p className="mt-4 text-center text-[12px] leading-relaxed text-muted-foreground">
            Your AI program shows moderate risk. Address high-priority findings to reduce exposure and maintain momentum.
          </p>
          <div className="mt-5 grid grid-cols-3 gap-2 border-t border-border/40 pt-4 text-center">
            {[
              { v: "23", k: "Open Findings" },
              { v: "4", k: "High Severity" },
              { v: "87%", k: "Compliance Ready" },
            ].map((x) => (
              <div key={x.k}>
                <p className="athena-figure text-xl font-semibold text-foreground">{x.v}</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{x.k}</p>
              </div>
            ))}
          </div>
        </GlassCard>

        <GlassCard hover={false}>
          <div className="flex items-center justify-between">
            <Label>Findings Trend</Label>
            <div className="flex gap-3">
              {TREND_SERIES.map((s) => (
                <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
          </div>
          <div className="mt-4 h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={TREND} margin={{ top: 6, right: 24, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="m" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--surface-2))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "hsl(var(--foreground))" }}
                />
                {TREND_SERIES.map((s) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    stroke={s.color}
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: s.color, strokeWidth: 0 }}
                    activeDot={{ r: 4 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </GlassCard>

        <GlassCard hover={false}>
          <Label>Top Risks by Environment</Label>
          <ul className="mt-4 space-y-4">
            {ENV_RISK.map((e) => (
              <li key={e.env}>
                <div className="mb-1.5 flex items-center justify-between text-[13px]">
                  <span className="text-muted-foreground">{e.env}</span>
                  <span className="font-medium text-foreground">{e.value}</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full" style={{ width: `${(e.value / ENV_MAX) * 100}%`, background: e.tone }} />
                </div>
              </li>
            ))}
          </ul>
        </GlassCard>
      </div>

      {/* coverage / attention */}
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_460px]">
        <GlassCard hover={false}>
          <div className="flex items-center justify-between">
            <Label>Assessment Coverage by Project</Label>
            <a href="#" className="flex items-center gap-1 text-[12px] text-primary hover:underline">
              View all projects <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
          <ul className="mt-4 space-y-3.5">
            {COVERAGE.map((p) => (
              <li key={p.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                <span className="truncate text-[13px] text-muted-foreground">{p.name}</span>
                <div className="flex items-center gap-3">
                  <div className="h-2 w-40 overflow-hidden rounded-full bg-surface-2">
                    <div className={cn("h-full rounded-full", p.pct >= 70 ? "bg-emerald-500" : "bg-surface-2")} style={{ width: `${p.pct}%`, background: p.pct >= 70 ? undefined : "hsl(var(--muted-foreground) / 0.5)" }} />
                  </div>
                  <span className="w-9 text-right text-[12px] font-medium text-foreground">{p.pct}%</span>
                </div>
              </li>
            ))}
          </ul>
        </GlassCard>

        <GlassCard hover={false}>
          <div className="flex items-center justify-between">
            <Label>Systems Needing Attention</Label>
            <a href="#" className="flex items-center gap-1 text-[12px] text-primary hover:underline">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
          <ul className="mt-3 divide-y divide-border/40">
            {ATTENTION.map((a) => (
              <li key={a.name} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-foreground">{a.name}</p>
                  <p className="truncate text-[12px] text-muted-foreground">{a.note}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <SeverityPill severity={a.sev} />
                  <span className="w-12 text-right text-[11px] text-muted-foreground">{a.ago}</span>
                </div>
              </li>
            ))}
          </ul>
        </GlassCard>
      </div>

      {/* activity / reviews / issues */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <GlassCard hover={false}>
          <div className="flex items-center justify-between">
            <Label>Recent Activity</Label>
            <a href="#" className="flex items-center gap-1 text-[12px] text-primary hover:underline">
              View all activity <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
          <ul className="mt-3 space-y-3">
            {ACTIVITY.map((a, i) => {
              const Icon = a.icon;
              return (
                <li key={i} className="flex items-start gap-3">
                  <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", a.tone)} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-foreground">{a.text}</p>
                    <p className="text-[12px] text-muted-foreground">{a.meta}</p>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{a.ago}</span>
                </li>
              );
            })}
          </ul>
        </GlassCard>

        <GlassCard hover={false}>
          <div className="flex items-center justify-between">
            <Label>Upcoming Human Reviews</Label>
            <a href="#" className="flex items-center gap-1 text-[12px] text-primary hover:underline">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
          <ul className="mt-3 space-y-2.5">
            {REVIEWS.map((r) => (
              <li key={r.name} className="flex items-center gap-3">
                <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="w-12 shrink-0 text-[12px] text-muted-foreground">{r.date}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{r.name}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{r.findings} findings</span>
                <SeverityPill severity={r.sev} />
              </li>
            ))}
          </ul>
        </GlassCard>

        <GlassCard hover={false}>
          <div className="flex items-center justify-between">
            <Label>Top Open Issues</Label>
            <a href="#" className="flex items-center gap-1 text-[12px] text-primary hover:underline">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
          <ol className="mt-3 space-y-2.5">
            {OPEN_ISSUES.map((o, i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="w-4 shrink-0 text-[12px] font-medium text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{o.t}</span>
                <SeverityPill severity={o.sev} />
              </li>
            ))}
          </ol>
        </GlassCard>
      </div>
    </div>
  );
}
