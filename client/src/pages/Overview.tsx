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
 * - open findings, the trend, the environment split, the top issues and
 *   which clients carry open critical/high findings
 *                                  /api/findings/summary: every client's
 *                                  lifecycle record (one row per issue, not per
 *                                  sighting) counted once on the server, for
 *                                  every client or not at all
 * - critical/high results of a site's latest completed scan that no finding
 *   stands behind (all of a scan a person recorded on the Tests screen; the
 *   shortfall of one that filed fewer than it reported)
 *                                  the same summary's `untrackedScan`: flagged
 *                                  in Systems Needing Attention, never added to
 *                                  the open totals and never cleared
 *
 * "Open" is open or acknowledged (in review); accepted risks and verified
 * fixes are not open, and every all-clear on this page says so.
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
import { useQuery } from "@tanstack/react-query";
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
import { both, figure, loaded, notInHand, type Loaded } from "@/lib/loaded";
import type { FindingsSummary, UntrackedScan } from "@shared/findings-summary";
import { countsNotRecorded, reportedTotal } from "@shared/latest-scans";

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
  /** How many clients the coverage list shows of how many, and how many have no scan. */
  coverageNote?: string;
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
  criticalCount: number; highCount: number; mediumCount: number; lowCount: number; findings?: unknown;
}
interface ApiDeployment { uuid: string; decision: string | null }

/** A test the engine (or a person) has not finished with. */
const IN_FLIGHT = new Set(["pending", "queued", "running", "in-progress"]);
const SEV_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
/** How many clients the coverage panel lists. */
const COVERAGE_ROWS = 6;

/** What a panel says when its source is not in hand. */
function pending<T>(source: Loaded<unknown>, what: string): PanelRows<T> {
  return { note: notInHand(source, what) };
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
 * The trend rows the chart draws, from the summary's months ("2026-03" ->
 * "Mar 26"). The server counts each finding into its own severity by the UTC
 * month it was first seen, zero-fills the months between, and keeps the
 * latest twelve; this only labels them.
 */
export function trendFromSummary(months: FindingsSummary["byMonth"]): TrendRow[] {
  return months.map(({ month, critical, high, medium, low }) => {
    const [year, mon] = month.split("-").map(Number);
    const m = new Date(Date.UTC(year, mon - 1, 1)).toLocaleString("en-US", {
      month: "short", year: "2-digit", timeZone: "UTC",
    });
    return { m, critical, high, medium, low };
  });
}

/**
 * "latest completed scan reported 3 critical / 5 high that are not tracked as
 * findings" -- the scans' own results no finding stands behind, not their
 * whole counts: a scan that filed some of them is flagged for the rest.
 */
export function untrackedNote(scan: UntrackedScan): string {
  const scans = scan.scans ?? 1;
  // One latest completed scan per site (a test recorded against the client
  // alone counts as one more), so several can stand at once.
  const which = scans > 1 ? `${scans} latest completed scans (one per site)` : "latest completed scan";
  return `${which} reported ${scan.critical} critical / ${scan.high} high that are not tracked as findings`;
}

/**
 * The clients with critical or high results of a site's latest completed scan
 * that no finding row stands behind. Every sentence on this page that sounds
 * like an all-clear is about tracked findings only, and says so; this is what
 * it adds while such results stand.
 */
function untrackedCaveat(summary: FindingsSummary): string {
  const n = summary.byClient.filter((one) => one.untrackedScan).length;
  if (n === 0) return "";
  return ` ${n === 1 ? "1 client has" : `${n} clients have`} critical or high results from a latest completed scan that are not tracked as findings; see Systems Needing Attention.`;
}

function useLiveOverview(): OverviewModel {
  const clients = loaded(useQuery<ApiClient[]>({ queryKey: ["/api/clients"] }));
  const sites = loaded(useQuery<ApiSite[]>({ queryKey: ["/api/sites"] }));
  const tests = loaded(useQuery<ApiTest[]>({ queryKey: ["/api/tests"] }));
  const deployments = loaded(useQuery<ApiDeployment[]>({ queryKey: ["/api/assurance/deployments"] }));
  // Every client's findings, counted once on the server. It answers for every
  // client or errors -- a total over whichever clients happened to read cleanly
  // would be wrong and look right -- so there is no partial total to guard
  // against here. One request, however many clients there are.
  const summary = loaded(useQuery<FindingsSummary>({ queryKey: ["/api/findings/summary"] }));

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
      value: figure(summary, (s) => s.open.total),
      sublabel:
        summary.state === "ready"
          ? `${summary.data.open.critical} critical · ${summary.data.open.high} high` +
            (summary.data.byClient.some((one) => one.untrackedScan)
              ? ` · ${plural(summary.data.byClient.filter((one) => one.untrackedScan).length, "untracked scan result")} not counted`
              : "")
          : summary.state === "error" ? "Could not load findings" : "Across every engagement",
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
    if (summary.state !== "ready") return pending(summary, "findings by environment");
    const rows = summary.data.byEnvironment.map(({ environment, open }) => ({
      env: environment ? humanize(environment) : "No site recorded",
      value: open,
      tone: "hsl(var(--primary))",
    }));
    return rowsOr(
      rows,
      "No open tracked findings to place. This fills in from the sites open findings are recorded on." +
        untrackedCaveat(summary.data),
    );
  })();

  // Least covered first, so a cut at six rows drops the best-covered clients,
  // never the ones with no scan -- and the panel says how many it left out.
  let coverageNote: string | undefined;
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
    rows.sort((a, b) => (a.pct ?? -1) - (b.pct ?? -1));
    const unscanned = clientData.filter(
      (client) => !testList.some((t) => t.clientId === client.id && t.status === "completed"),
    ).length;
    if (clientData.length > 0) {
      const shown = Math.min(COVERAGE_ROWS, clientData.length);
      coverageNote = [
        shown < clientData.length
          ? `Showing ${shown} of ${plural(clientData.length, "client")}, least covered first.`
          : `All ${plural(clientData.length, "client")}, least covered first.`,
        unscanned === 0
          ? "Every client has a completed scan."
          : `${unscanned} of ${clientData.length} ${unscanned === 1 ? "has" : "have"} no completed scan.`,
      ].join(" ");
    }
    return rowsOr(
      rows.slice(0, COVERAGE_ROWS),
      "No clients registered yet. Add a client and its sites; each row then shows how many of its sites have a completed scan.",
    );
  })();

  const attention: OverviewModel["attention"] = (() => {
    const src = both(both(clients, summary), tests);
    if (src.state !== "ready") return pending(src, "systems needing attention");
    const [[clientData, counted], testList] = src.data;
    const byClient = new Map(counted.byClient.map((one) => [one.clientId, one]));
    const flagged: Array<{ rank: number; row: { name: string; note: string; sev: Severity | null; ago: string | null } }> = [];
    for (const client of clientData) {
      const own = byClient.get(client.id);
      const tracked = own ? own.critical + own.high : 0;
      // A scan's reported counts that no finding stands behind: a person's
      // record of a pentest, say. Nothing tracks whether those were fixed, so
      // the client is flagged with them rather than cleared.
      const untracked = own?.untrackedScan ?? null;
      const reported = untracked ? untracked.critical + untracked.high : 0;
      if (own && (tracked > 0 || reported > 0)) {
        const notes = [
          tracked > 0 ? plural(tracked, "open critical/high finding") : null,
          untracked && reported > 0 ? untrackedNote(untracked) : null,
        ].filter((note): note is string => note !== null);
        const note = notes.join(" · ");
        const times = [own.latestSeriousSeenAt, untracked?.completedAt ?? null]
          .filter((at): at is string => Boolean(at))
          .sort();
        flagged.push({
          rank: tracked + reported,
          row: {
            name: client.name,
            note: note.charAt(0).toUpperCase() + note.slice(1),
            sev: own.critical > 0 || (untracked?.critical ?? 0) > 0 ? "critical" : "high",
            ago: ago(times[times.length - 1] ?? null),
          },
        });
      } else if (!testList.some((t) => t.clientId === client.id && t.status === "completed")) {
        flagged.push({ rank: 0, row: { name: client.name, note: "No completed scan on record", sev: null, ago: null } });
      } else if (!own) {
        // Registered since the summary was counted: its findings are unknown
        // here, which is not the same as none.
        flagged.push({ rank: 0, row: { name: client.name, note: "Not in the findings summary yet: its findings are not counted", sev: null, ago: null } });
      }
    }
    flagged.sort((a, b) => b.rank - a.rank);
    // Only when neither source reports anything, and saying what it covers:
    // tracked findings, and what each client's latest completed scan reported.
    // Exactly what it covers: tracked findings open or in review, the results
    // of each site's latest completed scan, and completed scans. It does not
    // say those scans reported nothing -- a scan whose critical was filed and
    // later fixed or accepted reported one -- only that nothing they
    // reported at critical or high is without a finding.
    return rowsOr(
      flagged.slice(0, 5).map((one) => one.row),
      clientData.length === 0
        ? "No clients registered yet."
        : "Nothing flagged: no client has an open or in-review critical or high finding, every critical or high result of each site's latest completed scan is tracked as a finding, and every client has a completed scan. Accepted risks and verified fixes are not counted as open.",
    );
  })();

  const activity: OverviewModel["activity"] = (() => {
    if (tests.state !== "ready") return pending(tests, "recent scans");
    const nameOf = new Map((clients.state === "ready" ? clients.data : []).map((client) => [client.id, client.name]));
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
          // From the counts too, and never a 0 nobody recorded: a total left
          // at 0 beside "Critical Count: 2" said "0 findings reported".
          meta: [nameOf.get(t.clientId) ?? "Unknown client", !done ? null
            : countsNotRecorded(t) ? "counts not recorded"
            : `${plural(reportedTotal(t), "finding")} reported`]
            .filter(Boolean)
            .join(" · "),
          ago: ago(t.completedAt || t.startedAt),
        };
      });
    return rowsOr(rows, "No scans recorded yet. Scans started from Athena appear here as they run.");
  })();

  const issues: OverviewModel["issues"] = (() => {
    if (summary.state !== "ready") return pending(summary, "open findings");
    const rows = summary.data.topOpen.map((f) => ({
      t: f.message || humanize(f.type),
      sev: normSev(f.severity),
      meta: f.clientName || undefined,
    }));
    return rowsOr(rows, "No open tracked findings on record." + untrackedCaveat(summary.data));
  })();

  return {
    metrics,
    posture: {
      note:
        "Not scored. Athena does not compute an overall risk score, so none is shown. " +
        "The open findings below are the tracked findings on record; the Risks page lists each one." +
        (summary.state === "ready" ? untrackedCaveat(summary.data) : ""),
    },
    postureFigures: [
      { value: figure(summary, (s) => s.open.total), label: "Open Findings" },
      { value: figure(summary, (s) => s.open.critical), label: "Critical" },
      { value: figure(summary, (s) => s.open.high), label: "High" },
    ],
    trend:
      summary.state === "ready"
        ? rowsOr(
            trendFromSummary(summary.data.byMonth),
            "No tracked findings recorded yet. The trend fills in as scans record findings, by the month each was first seen." +
              untrackedCaveat(summary.data),
          )
        : pending(summary, "the findings trend"),
    environments,
    coverage,
    coverageNote,
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
        <SampleDataNotice counts={["clients", "sites", "tests", "findings"]} className="mt-5" />
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
          {model.coverageNote && (
            <p className="mt-4 text-[11px] text-muted-foreground" data-testid="overview-coverage-note">
              {model.coverageNote}
            </p>
          )}
        </Panel>

        <Panel
          id="attention"
          title="Systems Needing Attention"
          caption="Open or in-review critical or high findings, scan results no finding stands behind, or no completed scan."
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
