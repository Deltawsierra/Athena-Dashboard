/**
 * Overview: the assurance program at a glance. Five headline figures, then the
 * three readings a leader scans first -- overall posture, how findings are
 * arriving, and which environments carry the open ones -- over the working
 * lists (scan coverage, systems needing attention, recent scans, reviews, and
 * the top open issues).
 *
 * This page used to be drawn entirely from fixtures: 42 AI systems, a 62%
 * "Moderate Risk" ring, 87% compliance readiness, "Customer Support Agent 100%"
 * coverage, "Deployment approved: Fraud Detection" in the activity feed. None of
 * it came from anywhere and nothing on the page said so, so a customer read an
 * invented estate as their own.
 *
 * Now every figure is computed from a record, or the panel says it is not
 * measured and what would fill it:
 *
 * - systems, sites and scans       /api/clients, /api/sites, /api/tests
 * - open findings, the trend, the environment split and the top issues
 *                                  each client's /api/findings (the lifecycle
 *                                  record: one row per issue, not per sighting)
 * - assurance decisions            /api/assurance/deployments
 * - overall risk score, compliance readiness, the review schedule
 *                                  nothing computes these, so they say so
 *
 * While a source is loading a figure reads "…", and when it failed it reads
 * "—" with the reason: a zero is a measurement, and an unknown is not one.
 *
 * The old fixture figures still exist, for prospect demos only, in
 * client/src/sample -- shown when the build turns sample mode on, with a banner
 * on the page and a label on every panel. See client/src/sample/mode.ts.
 */
import {
  Boxes,
  ScanLine,
  AlertTriangle,
  CheckCircle2,
  ShieldCheck,
  Calendar,
  ArrowRight,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import type { ReactNode } from "react";
import GlassCard from "@/components/GlassCard";
import SampleDataNotice from "@/components/SampleDataNotice";
import mythosGlyph from "@assets/mythos/mark-glyph.webp";
import PageHero from "@/components/mythos/PageHero";
import { Divider, RingFrame } from "@/components/mythos/Ornament";
import StatCard from "@/components/mythos/StatCard";
import { Label, SeverityPill, type Severity } from "@/components/mythos/atoms";
import { isSampleMode, overviewSample, SampleModeBanner, SamplePanelLabel } from "@/sample";
import { cn } from "@/lib/utils";

/* ---- the page's model: what every panel renders, live or sample ------- */

/** A panel's rows, or the one sentence it shows instead of rows. */
export type PanelRows<T> = { rows: T[] } | { note: string };

export interface OverviewMetric {
  key: string;
  label: string;
  value: string | number;
  sublabel?: string;
  icon: LucideIcon;
  accent?: string;
  delta?: { value: string; direction: "up" | "down"; good?: boolean; note?: string };
}

export interface TrendRow {
  m: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface OverviewModel {
  metrics: OverviewMetric[];
  /** A scored posture, or why there is no score. */
  posture: { pct: number; label: string; summary: string } | { note: string };
  postureFigures: { value: string | number; label: string }[];
  trend: PanelRows<TrendRow>;
  environments: PanelRows<{ env: string; value: number; tone: string }>;
  coverage: PanelRows<{ name: string; pct: number | null; detail?: string }>;
  attention: PanelRows<{ name: string; note: string; sev: Severity | null; ago: string | null }>;
  activity: PanelRows<{ icon: LucideIcon; tone: string; text: string; meta: string; ago: string | null }>;
  reviews: PanelRows<{ date: string; name: string; findings: number; sev: Severity }>;
  issues: PanelRows<{ t: string; sev: Severity; meta?: string }>;
}

const TREND_SERIES = [
  { key: "critical", label: "Critical", color: "hsl(var(--sev-critical))" },
  { key: "high", label: "High", color: "hsl(var(--sev-high))" },
  { key: "medium", label: "Medium", color: "hsl(var(--sev-medium))" },
  { key: "low", label: "Low", color: "hsl(var(--sev-low))" },
] as const;

/* ---- the live model ---------------------------------------------------- */

interface ApiClient { id: string; name: string }
interface ApiSite { id: string; clientId: string; environment: string }
interface ApiTest {
  id: string; clientId: string; siteId: string | null; testType: string; status: string;
  startedAt: string; completedAt: string | null; vulnerabilitiesFound: number;
}
interface ApiFinding {
  id: string; clientId: string; siteId: string | null; type: string; severity: string | null;
  message: string | null; status: string; firstSeenAt: string; lastSeenAt: string;
}
interface FindingsView { findings: ApiFinding[] }
interface ApiDeployment { uuid: string; decision: string | null }

/** A test the engine (or a person) has not finished with. */
const IN_FLIGHT = new Set(["pending", "queued", "running", "in-progress"]);
const SEV_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

type Loaded<T> =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; data: T };

function loaded<T>(query: UseQueryResult<T>): Loaded<T> {
  if (query.isError) {
    return { state: "error", message: query.error instanceof Error ? query.error.message : "request failed" };
  }
  if (query.data === undefined) return { state: "loading" };
  return { state: "ready", data: query.data };
}

/** Two sources that must both be in hand before a figure means anything. */
function both<A, B>(a: Loaded<A>, b: Loaded<B>): Loaded<[A, B]> {
  if (a.state === "error") return a;
  if (b.state === "error") return b;
  if (a.state === "loading" || b.state === "loading") return { state: "loading" };
  return { state: "ready", data: [a.data, b.data] };
}

/** "…" while loading, "—" when the source failed: never a number nobody read. */
function figure<T>(source: Loaded<T>, read: (data: T) => string | number): string | number {
  if (source.state === "ready") return read(source.data);
  return source.state === "loading" ? "…" : "—";
}

/** What a panel says when its source is not in hand. */
function pending<T>(source: Loaded<unknown>, what: string): PanelRows<T> {
  return source.state === "error"
    ? { note: `Could not load ${what}: ${source.message}` }
    : { note: "Loading…" };
}

function rowsOr<T>(rows: T[], empty: string): PanelRows<T> {
  return rows.length > 0 ? { rows } : { note: empty };
}

function normSev(value: string | null): Severity {
  const v = (value || "").toLowerCase();
  return (SEV_ORDER as string[]).includes(v) ? (v as Severity) : "info";
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3h ago", or the date once it is a month old; null when there is no time. */
function ago(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  const minutes = Math.round(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toLocaleDateString();
}

/**
 * Findings by the month they were first recorded, one series per severity.
 * Months between the first and the last are filled with zeros -- a month with
 * no new findings is a measurement -- and the window is the last twelve.
 */
export function trendRows(findings: ApiFinding[]): TrendRow[] {
  const dated = findings
    .map((finding) => ({ finding, at: new Date(finding.firstSeenAt) }))
    .filter((one) => !Number.isNaN(one.at.getTime()));
  if (dated.length === 0) return [];
  const key = (d: Date) => d.getFullYear() * 12 + d.getMonth();
  const last = Math.max(...dated.map((one) => key(one.at)));
  const first = Math.max(Math.min(...dated.map((one) => key(one.at))), last - 11);
  const rows: TrendRow[] = [];
  for (let k = first; k <= last; k += 1) {
    const m = new Date(Math.floor(k / 12), k % 12, 1).toLocaleString("en-US", { month: "short", year: "2-digit" });
    rows.push({ m, critical: 0, high: 0, medium: 0, low: 0 });
  }
  for (const { finding, at } of dated) {
    const k = key(at);
    if (k < first) continue;
    const sev = normSev(finding.severity);
    if (sev !== "info") rows[k - first][sev] += 1;
  }
  return rows;
}

function useLiveOverview(): OverviewModel {
  const clientsQ = useQuery<ApiClient[]>({ queryKey: ["/api/clients"] });
  const sitesQ = useQuery<ApiSite[]>({ queryKey: ["/api/sites"] });
  const testsQ = useQuery<ApiTest[]>({ queryKey: ["/api/tests"] });
  const deploymentsQ = useQuery<ApiDeployment[]>({ queryKey: ["/api/assurance/deployments"] });
  // The findings route answers one engagement at a time. Same key as the Risks
  // page, so the two screens share one cache entry per client.
  const clientList = clientsQ.data ?? [];
  const findingsQs = useQueries({
    queries: clientList.map((client) => ({ queryKey: ["/api/findings", { clientId: client.id }] })),
  }) as UseQueryResult<FindingsView>[];

  const clients = loaded(clientsQ);
  const sites = loaded(sitesQ);
  const tests = loaded(testsQ);
  const deployments = loaded(deploymentsQ);

  // Every client's findings, or nothing: a total over whichever clients
  // happened to load first would be wrong and look right.
  let findings: Loaded<ApiFinding[]>;
  if (clients.state !== "ready") {
    findings = clients;
  } else {
    const failed = findingsQs.find((q) => q.isError);
    if (failed) {
      findings = { state: "error", message: failed.error instanceof Error ? failed.error.message : "request failed" };
    } else if (findingsQs.some((q) => q.data === undefined)) {
      findings = { state: "loading" };
    } else {
      findings = { state: "ready", data: findingsQs.flatMap((q) => q.data?.findings ?? []) };
    }
  }

  const nameOf = new Map(clientList.map((client) => [client.id, client.name]));
  const open: Loaded<ApiFinding[]> =
    findings.state === "ready" ? { state: "ready", data: findings.data.filter((f) => f.status === "open") } : findings;
  const bySev = (list: ApiFinding[], sev: Severity) => list.filter((f) => normSev(f.severity) === sev).length;

  const metrics: OverviewMetric[] = [
    {
      key: "systems",
      label: "Systems Registered",
      value: figure(clients, (list) => list.length),
      sublabel: sites.state === "ready" ? `${plural(sites.data.length, "site")} on record` : "Clients on record",
      icon: Boxes,
    },
    {
      key: "scans",
      label: "Scans In Progress",
      value: figure(tests, (list) => list.filter((t) => IN_FLIGHT.has(t.status)).length),
      sublabel: tests.state === "ready" ? `${plural(tests.data.length, "scan")} on record` : "Pending, queued or running",
      icon: ScanLine,
    },
    {
      key: "findings",
      label: "Open Findings",
      value: figure(open, (list) => list.length),
      sublabel:
        open.state === "ready"
          ? `${bySev(open.data, "critical")} critical · ${bySev(open.data, "high")} high`
          : open.state === "error" ? "Could not load findings" : "Across every engagement",
      icon: AlertTriangle,
      accent: "var(--sev-high)",
    },
    {
      key: "decisions",
      label: "Assurance Decisions",
      value: figure(deployments, (list) => list.filter((d) => d.decision !== null).length),
      sublabel:
        deployments.state === "ready"
          ? `of ${plural(deployments.data.length, "deployment")} · ${deployments.data.filter((d) => d.decision === "ready").length} ready`
          : deployments.state === "error" ? "Assurance control plane not reachable" : "Deployments with a decision",
      icon: CheckCircle2,
    },
    {
      key: "readiness",
      label: "Compliance Readiness",
      value: "—",
      // Nothing computes a readiness score. The Compliance page reports which
      // ASVS requirements the scans tested, which is a different, real thing.
      sublabel: "Not measured: no readiness score is computed",
      icon: ShieldCheck,
    },
  ];

  const environments: OverviewModel["environments"] = (() => {
    const src = both(open, sites);
    if (src.state !== "ready") return pending(src, "findings by environment");
    const [list, siteList] = src.data;
    const envOf = new Map(siteList.map((site) => [site.id, site.environment]));
    const counts = new Map<string, number>();
    for (const finding of list) {
      const env = finding.siteId && envOf.has(finding.siteId)
        ? humanize(envOf.get(finding.siteId) as string)
        : "No site recorded";
      counts.set(env, (counts.get(env) ?? 0) + 1);
    }
    const rows = Array.from(counts.entries())
      .map(([env, value]) => ({ env, value, tone: "hsl(var(--primary))" }))
      .sort((a, b) => b.value - a.value);
    return rowsOr(rows, "No open findings to place. This fills in from the sites open findings are recorded on.");
  })();

  const coverage: OverviewModel["coverage"] = (() => {
    const src = both(both(clients, sites), tests);
    if (src.state !== "ready") return pending(src, "scan coverage");
    const [[clientData, siteList], testList] = src.data;
    const rows = clientData.map((client) => {
      const own = siteList.filter((site) => site.clientId === client.id);
      const scanned = own.filter((site) =>
        testList.some((t) => t.siteId === site.id && t.status === "completed"),
      ).length;
      return own.length === 0
        ? { name: client.name, pct: null, detail: "No sites registered" }
        : {
            name: client.name,
            pct: Math.round((scanned / own.length) * 100),
            detail: `${scanned} of ${plural(own.length, "site")} scanned`,
          };
    });
    rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
    return rowsOr(
      rows.slice(0, 6),
      "No clients registered yet. Add a client and its sites; each row then shows how many of its sites have a completed scan.",
    );
  })();

  const attention: OverviewModel["attention"] = (() => {
    const src = both(both(clients, open), tests);
    if (src.state !== "ready") return pending(src, "systems needing attention");
    const [[clientData, list], testList] = src.data;
    const flagged: Array<{ rank: number; row: { name: string; note: string; sev: Severity | null; ago: string | null } }> = [];
    for (const client of clientData) {
      const serious = list.filter(
        (f) => f.clientId === client.id && (normSev(f.severity) === "critical" || normSev(f.severity) === "high"),
      );
      if (serious.length > 0) {
        const worst: Severity = serious.some((f) => normSev(f.severity) === "critical") ? "critical" : "high";
        const latest = serious.map((f) => String(f.lastSeenAt)).sort().pop() ?? null;
        flagged.push({
          rank: serious.length,
          row: { name: client.name, note: `${plural(serious.length, "open critical/high finding")}`, sev: worst, ago: ago(latest) },
        });
      } else if (!testList.some((t) => t.clientId === client.id && t.status === "completed")) {
        flagged.push({ rank: 0, row: { name: client.name, note: "No completed scan on record", sev: null, ago: null } });
      }
    }
    flagged.sort((a, b) => b.rank - a.rank);
    return rowsOr(
      flagged.slice(0, 5).map((one) => one.row),
      clientData.length === 0
        ? "No clients registered yet."
        : "Nothing flagged: no client has an open critical or high finding, and every client has a completed scan.",
    );
  })();

  const activity: OverviewModel["activity"] = (() => {
    if (tests.state !== "ready") return pending(tests, "recent scans");
    const when = (t: ApiTest) => new Date(t.completedAt || t.startedAt).getTime();
    const rows = tests.data
      .slice()
      .sort((a, b) => when(b) - when(a))
      .slice(0, 5)
      .map((t) => {
        const done = t.status === "completed";
        const failed = t.status === "failed" || t.status === "aborted";
        return {
          icon: done ? CheckCircle2 : failed ? XCircle : ScanLine,
          tone: done ? "text-emerald-400" : failed ? "text-sev-high" : "text-primary",
          text: `${humanize(t.status)}: ${humanize(t.testType)}`,
          meta: [nameOf.get(t.clientId) ?? "Unknown client", done ? `${plural(t.vulnerabilitiesFound, "finding")} reported` : null]
            .filter(Boolean)
            .join(" · "),
          ago: ago(t.completedAt || t.startedAt),
        };
      });
    return rowsOr(rows, "No scans recorded yet. Scans started from Athena appear here as they run.");
  })();

  const issues: OverviewModel["issues"] = (() => {
    if (open.state !== "ready") return pending(open, "open findings");
    const rank = (f: ApiFinding) => SEV_ORDER.indexOf(normSev(f.severity));
    const rows = open.data
      .slice()
      .sort((a, b) => rank(a) - rank(b) || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
      .slice(0, 5)
      .map((f) => ({ t: f.message || humanize(f.type), sev: normSev(f.severity), meta: nameOf.get(f.clientId) }));
    return rowsOr(rows, "No open findings on record.");
  })();

  return {
    metrics,
    posture: {
      note:
        "Not scored. Athena does not compute an overall risk score, so none is shown. " +
        "The open findings below are counted from the record; the Risks page lists each one.",
    },
    postureFigures: [
      { value: figure(open, (list) => list.length), label: "Open Findings" },
      { value: figure(open, (list) => bySev(list, "critical")), label: "Critical" },
      { value: figure(open, (list) => bySev(list, "high")), label: "High" },
    ],
    trend:
      findings.state === "ready"
        ? rowsOr(
            trendRows(findings.data),
            "No findings recorded yet. The trend fills in as scans record findings, by the month each was first seen.",
          )
        : pending(findings, "the findings trend"),
    environments,
    coverage,
    attention,
    activity,
    reviews: {
      note:
        "Not tracked yet. Athena records no human-review schedule, so there is nothing to list. " +
        "Who owns each finding, and its status, is on the Risks page.",
    },
    issues,
  };
}

/* ---- rendering ---------------------------------------------------------- */

function Panel({
  id,
  title,
  caption,
  link,
  sample,
  children,
}: {
  id: string;
  title: string;
  caption?: string;
  link?: { href: string; label: string };
  sample: boolean;
  children: ReactNode;
}) {
  return (
    <GlassCard hover={false} data-testid={`overview-panel-${id}`}>
      {sample && <SamplePanelLabel className="mb-3" />}
      <div className="flex items-center justify-between gap-3">
        <Label>{title}</Label>
        {link && (
          <Link href={link.href} className="flex shrink-0 items-center gap-1 text-[12px] text-primary hover:underline">
            {link.label} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      {caption && <p className="mt-1 text-[11px] text-muted-foreground">{caption}</p>}
      {children}
    </GlassCard>
  );
}

function Note({ text }: { text: string }) {
  return <p className="mt-4 text-[12px] leading-relaxed text-muted-foreground">{text}</p>;
}

function RiskRing({ pct, label }: { pct: number; label: string }) {
  const size = 150;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
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
        <span className="font-serif text-lg font-semibold text-gold">{label}</span>
      </div>
    </div>
  );
}

export function OverviewView({ model, sample }: { model: OverviewModel; sample: boolean }) {
  const tag = sample ? <SamplePanelLabel /> : undefined;
  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-8">
      <PageHero
        title="Overview"
        subtitle="Your AI assurance program at a glance. Manage risk. Enable innovation. Build trust."
        background="vista"
        verbs={["Analyze", "Evidence", "Deploy"]}
      />
      {sample ? (
        <SampleModeBanner />
      ) : (
        // Rows the installer wrote are real rows, so they are counted -- and
        // this says how many there are, with the means to remove them.
        <SampleDataNotice counts={["clients", "sites", "tests"]} className="mt-5" />
      )}
      <Divider variant="astrolabe" className="mt-5" />

      {/* headline metrics */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-5">
        {model.metrics.map((m) => (
          <StatCard
            key={m.key}
            data-testid={`overview-metric-${m.key}`}
            label={m.label}
            value={m.value}
            icon={m.icon}
            accent={m.accent}
            sublabel={m.sublabel}
            delta={m.delta}
            tag={tag}
          />
        ))}
      </div>

      {/* posture / trend / env */}
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)_360px]">
        <Panel id="posture" title="Overall Risk Posture" sample={sample}>
          {"pct" in model.posture ? (
            <>
              <div className="mt-4">
                <RingFrame variant="ring" className="mx-auto w-[248px]">
                  <RiskRing pct={model.posture.pct} label={model.posture.label} />
                </RingFrame>
              </div>
              <p className="mt-4 text-center text-[12px] leading-relaxed text-muted-foreground">{model.posture.summary}</p>
            </>
          ) : (
            <Note text={model.posture.note} />
          )}
          <div className="mt-5 grid grid-cols-3 gap-2 border-t border-border/40 pt-4 text-center">
            {model.postureFigures.map((x) => (
              <div key={x.label}>
                <p className="athena-figure text-xl font-semibold text-foreground">{x.value}</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{x.label}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          id="trend"
          title="Findings Trend"
          caption="New findings by the month they were first recorded, critical to low."
          sample={sample}
        >
          {"rows" in model.trend ? (
            <>
              <div className="mt-3 flex flex-wrap gap-3">
                {TREND_SERIES.map((s) => (
                  <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                    {s.label}
                  </span>
                ))}
              </div>
              <div className="mt-4 h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={model.trend.rows} margin={{ top: 6, right: 24, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="m" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} axisLine={false} tickLine={false} />
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
            </>
          ) : (
            <Note text={model.trend.note} />
          )}
        </Panel>

        <Panel
          id="environments"
          title="Open Findings by Environment"
          caption="The environment of the site each open finding was recorded on."
          sample={sample}
        >
          {"rows" in model.environments ? (
            <EnvironmentBars rows={model.environments.rows} />
          ) : (
            <Note text={model.environments.note} />
          )}
        </Panel>
      </div>

      {/* coverage / attention */}
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_460px]">
        <Panel
          id="coverage"
          title="Scan Coverage by Client"
          caption="Registered sites with at least one completed scan."
          link={{ href: "/clients", label: "View all systems" }}
          sample={sample}
        >
          {"rows" in model.coverage ? (
            <ul className="mt-4 space-y-3.5">
              {model.coverage.rows.map((p) => (
                <li key={p.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-muted-foreground">{p.name}</span>
                    {p.detail && <span className="block text-[11px] text-muted-foreground/70">{p.detail}</span>}
                  </span>
                  {p.pct === null ? (
                    <span className="text-[12px] text-muted-foreground">—</span>
                  ) : (
                    <div className="flex items-center gap-3">
                      <div className="h-2 w-40 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className={cn("h-full rounded-full", p.pct >= 70 ? "bg-emerald-500" : "bg-surface-2")}
                          style={{ width: `${p.pct}%`, background: p.pct >= 70 ? undefined : "hsl(var(--muted-foreground) / 0.5)" }}
                        />
                      </div>
                      <span className="w-9 text-right text-[12px] font-medium text-foreground">{p.pct}%</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Note text={model.coverage.note} />
          )}
        </Panel>

        <Panel
          id="attention"
          title="Systems Needing Attention"
          caption="Open critical or high findings, or no completed scan."
          link={{ href: "/clients", label: "View all" }}
          sample={sample}
        >
          {"rows" in model.attention ? (
            <ul className="mt-3 divide-y divide-border/40">
              {model.attention.rows.map((a) => (
                <li key={a.name} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-foreground">{a.name}</p>
                    <p className="truncate text-[12px] text-muted-foreground">{a.note}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {a.sev && <SeverityPill severity={a.sev} />}
                    {a.ago && <span className="w-14 text-right text-[11px] text-muted-foreground">{a.ago}</span>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Note text={model.attention.note} />
          )}
        </Panel>
      </div>

      {/* activity / reviews / issues */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel id="activity" title="Recent Activity" link={{ href: "/tests", label: "View all scans" }} sample={sample}>
          {"rows" in model.activity ? (
            <ul className="mt-3 space-y-3">
              {model.activity.rows.map((a, i) => {
                const Icon = a.icon;
                return (
                  <li key={i} className="flex items-start gap-3">
                    <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", a.tone)} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-foreground">{a.text}</p>
                      <p className="text-[12px] text-muted-foreground">{a.meta}</p>
                    </div>
                    {a.ago && <span className="shrink-0 text-[11px] text-muted-foreground">{a.ago}</span>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Note text={model.activity.note} />
          )}
        </Panel>

        <Panel id="reviews" title="Upcoming Human Reviews" sample={sample}>
          {"rows" in model.reviews ? (
            <ul className="mt-3 space-y-2.5">
              {model.reviews.rows.map((r) => (
                <li key={r.name} className="flex items-center gap-3">
                  <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="w-12 shrink-0 text-[12px] text-muted-foreground">{r.date}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{r.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{r.findings} findings</span>
                  <SeverityPill severity={r.sev} />
                </li>
              ))}
            </ul>
          ) : (
            <Note text={model.reviews.note} />
          )}
        </Panel>

        <Panel id="issues" title="Top Open Issues" link={{ href: "/findings", label: "View all" }} sample={sample}>
          {"rows" in model.issues ? (
            <ol className="mt-3 space-y-2.5">
              {model.issues.rows.map((o, i) => (
                <li key={i} className="flex items-center gap-3">
                  <span className="w-4 shrink-0 text-[12px] font-medium text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-foreground">{o.t}</span>
                    {o.meta && <span className="block truncate text-[11px] text-muted-foreground">{o.meta}</span>}
                  </span>
                  <SeverityPill severity={o.sev} />
                </li>
              ))}
            </ol>
          ) : (
            <Note text={model.issues.note} />
          )}
        </Panel>
      </div>
    </div>
  );
}

function EnvironmentBars({ rows }: { rows: { env: string; value: number; tone: string }[] }) {
  const max = Math.max(...rows.map((e) => e.value), 1);
  return (
    <ul className="mt-4 space-y-4">
      {rows.map((e) => (
        <li key={e.env}>
          <div className="mb-1.5 flex items-center justify-between text-[13px]">
            <span className="text-muted-foreground">{e.env}</span>
            <span className="font-medium text-foreground">{e.value}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full" style={{ width: `${(e.value / max) * 100}%`, background: e.tone }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function LiveOverview() {
  return <OverviewView model={useLiveOverview()} sample={false} />;
}

export default function Overview() {
  // The sample figures are asked for only on the sample branch, and
  // overviewSample() refuses outright when sample mode is off.
  return isSampleMode() ? <OverviewView model={overviewSample()} sample /> : <LiveOverview />;
}
