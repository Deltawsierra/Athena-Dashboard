/**
 * Deployments: the systems under assessment, read from `/api/clients` and the
 * tests run against them. Each row is a client system; its risk and findings
 * are what the latest COMPLETED test of each of its sites reported (the same
 * tests the findings summary reads: shared/latest-scans.ts), and a system
 * with no completed test says "Not scanned". A later scan of one site says
 * nothing about another, so it no longer replaces that site's result. An
 * engine test whose counts were never recorded (all zero beside real results,
 * from before the inline-count fix) says "Counts not recorded", never "0".
 * Columns the backend has no source for -- model provider, data-sensitivity
 * tags -- are omitted rather than filled with fiction.
 *
 * This page used to call a never-scanned system "Clean", give every system a
 * 0-100 "risk score" from a hard-coded table (Clean was 8, High 72), count a
 * pending scan as a scan, and tick off "N of N approved for production" and
 * "N systems live in production" from nothing but the client status "active",
 * which every new client gets by default. Athena computes no risk score and
 * records neither a human sign-off nor a production deployment, so the page
 * now says "Not scored" and "Not tracked" instead.
 *
 * While a source is loading a figure reads "…"; when it failed, "—" and the
 * reason. See client/src/lib/loaded.ts.
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
import { SeverityPill, StatusPill, Timeline, type StatusTone, type TimelineStep } from "@/components/mythos/atoms";
import { both, figure, loaded, notInHand, type Loaded } from "@/lib/loaded";
import { cn } from "@/lib/utils";
import type { FindingsSummary } from "@shared/findings-summary";
import { completedTime, latestCompletedBySite, readScan } from "@shared/latest-scans";

interface ApiClient { id: string; name: string; company: string; status: string; lastTestDate: string | null; notes: string | null }
interface ApiTest {
  id: string; clientId: string; siteId?: string | null; testType: string; status: string; severity: string | null;
  completedAt: string | null; startedAt: string; vulnerabilitiesFound: number;
  criticalCount: number; highCount: number; mediumCount: number; lowCount: number;
  findings?: unknown;
}

/** What a system's latest completed tests reported, worst first. */
type Band = "critical" | "high" | "medium" | "low" | "unrated" | "unrecorded" | "info" | "none" | "unscanned";
const BAND_ORDER: Band[] = ["critical", "high", "medium", "low", "unrated", "unrecorded", "info", "none", "unscanned"];
/**
 * From the whole record (shared/latest-scans.ts readScan): the severity field
 * AND the per-severity counts. It read the severity field and the total only,
 * so a test recorded on the Tests screen with "Critical Count: 2" and the
 * severity and total left at their defaults read "None reported" -- beside a
 * findings summary that flagged those two criticals. A total with no severity
 * recorded anywhere is "Not rated", not the "Medium" this used to guess; one
 * whose every result was rated info is "Informational", not "Not rated".
 */
function bandOf(test: ApiTest | undefined): Band {
  if (!test) return "unscanned";
  const read = readScan(test);
  if (read.countsNotRecorded) return "unrecorded";
  return read.severity ?? (read.total > 0 ? "unrated" : "none");
}
const BAND_DOT: Record<Band, string> = {
  critical: "bg-sev-critical", high: "bg-sev-high", medium: "bg-sev-medium", low: "bg-emerald-400",
  unrated: "bg-muted-foreground/60", unrecorded: "bg-muted-foreground/40", info: "bg-sky-400/60",
  none: "bg-muted-foreground/40", unscanned: "bg-muted-foreground/20",
};
const BAND_TEXT: Record<Band, string> = {
  critical: "text-sev-critical", high: "text-sev-high", medium: "text-sev-medium", low: "text-emerald-400",
  unrated: "text-foreground", unrecorded: "text-muted-foreground", info: "text-muted-foreground",
  none: "text-muted-foreground", unscanned: "text-muted-foreground",
};
// "None reported", not "Clean": a scan that reported nothing has not shown
// that nothing is there. "Not recorded": results came back, and their counts
// were never written down -- which is not "none". "Not rated": findings were
// reported with no severity recorded for any of them. "Informational": every
// result was rated info -- a severity was recorded, and it is not a risk.
const BAND_LABEL: Record<Band, string> = {
  critical: "Critical", high: "High", medium: "Medium", low: "Low", unrated: "Not rated",
  unrecorded: "Not recorded", info: "Informational", none: "None reported", unscanned: "Not scanned",
};
/** Bands that are not a risk: never listed under Highest Risk. */
const NOT_A_RISK = new Set<Band>(["info", "none", "unscanned"]);
/** Bands a severity pill can draw; the others are drawn as what they are. */
const RATED = new Set<Band>(["critical", "high", "medium", "low"]);
/** The worse of two bands. */
const worse = (a: Band, b: Band) => (BAND_ORDER.indexOf(a) <= BAND_ORDER.indexOf(b) ? a : b);

/** A test the engine (or a person) has not finished with. */
const IN_FLIGHT = new Set(["pending", "queued", "running", "in-progress"]);
const READINESS_TONE: Record<string, StatusTone> = {
  completed: "complete", running: "progress", pending: "progress", "in-progress": "progress",
  queued: "review", failed: "neutral", aborted: "neutral",
};
function readinessLabel(status: string): string {
  const words = status.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
const when = (t: ApiTest) => new Date(t.completedAt || t.startedAt).getTime();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Whether a completed test reported any finding at all, by its total, any
 * count or its severity field -- or returned results whose counts were never
 * recorded. Read from the total and counts alone, a test recorded "Severity:
 * Critical" with both left at 0 reported nothing, and this step was ticked
 * done beside the row the table draws as Critical.
 */
function reportsFindings(test: ApiTest): boolean {
  const read = readScan(test);
  return read.total > 0 || read.severity !== null || read.countsNotRecorded;
}

/**
 * The release-readiness pipeline, each step from a record or marked as not
 * tracked. "Scanned" means a completed test; a pending or running one is in
 * flight, not a scan. Findings to review are the open tracked findings on
 * record AND whatever each system's latest completed scan reported: only the
 * engine's scans file findings, so a scan a person recorded on the Tests
 * screen has counts and no finding rows, and reading the findings alone ticked
 * this step done beside a "Critical 15 (3C / 5H)" row. It is done only when
 * neither reports anything.
 * Nothing records a human sign-off or a production deployment -- an assurance
 * decision on the Assurance page is decision support, not an approval, and a
 * client's status is not a deployment -- so those two steps say so and are
 * never ticked off.
 */
function readinessSteps(
  registered: Loaded<number>,
  scanned: Loaded<{ scanned: number; inFlight: number; reporting: number }>,
  withOpen: Loaded<number>,
): TimelineStep[] {
  const discover: TimelineStep = registered.state === "ready"
    ? { title: "Discover", detail: `${plural(registered.data, "system")} registered.`, state: registered.data > 0 ? "done" : "todo" }
    : { title: "Discover", detail: notInHand(registered, "systems"), state: "todo" };

  const src = both(registered, scanned);
  let scan: TimelineStep;
  let review: TimelineStep;
  if (src.state !== "ready") {
    scan = { title: "Scan", detail: notInHand(src, "scans"), state: "todo" };
    review = { title: "Review Evidence", detail: notInHand(src, "scans"), state: "todo" };
  } else {
    const [total, { scanned: done, inFlight, reporting }] = src.data;
    scan = {
      title: "Scan",
      detail: total === 0
        ? "No systems to scan yet."
        : `${done} of ${total} with a completed scan${inFlight > 0 ? ` · ${inFlight} in flight` : ""}.`,
      state: total === 0 ? "todo" : done >= total ? "done" : done > 0 || inFlight > 0 ? "active" : "todo",
    };
    if (withOpen.state !== "ready") {
      review = { title: "Review Evidence", detail: notInHand(withOpen, "findings"), state: "todo" };
    } else if (withOpen.data > 0 || reporting > 0) {
      const detail = [
        withOpen.data > 0 ? `${plural(withOpen.data, "system")} with open findings to review.` : null,
        reporting > 0
          ? `${plural(reporting, "system")} whose latest completed scan reported findings to review.`
          : null,
      ].filter(Boolean).join(" ");
      review = { title: "Review Evidence", detail, state: "active" };
    } else if (done === 0) {
      review = { title: "Review Evidence", detail: "Awaiting the first completed scan.", state: "todo" };
    } else {
      review = {
        title: "Review Evidence",
        detail: "No open or in-review tracked findings, and no site's latest completed scan reported any.",
        state: "done",
      };
    }
  }

  const approval: TimelineStep = {
    title: "Human Approval",
    detail: "Not tracked: Athena records no human sign-off for a system. Assurance decisions (Assurance page) are decision support, not approval.",
    state: "todo",
  };
  const deploy: TimelineStep = {
    title: "Deploy",
    detail: "Not tracked: nothing records which systems are live in production.",
    state: "todo",
  };
  return [discover, scan, review, approval, deploy];
}


export default function Deployments() {
  const clientsQ = loaded(useQuery<ApiClient[]>({ queryKey: ["/api/clients"] }));
  const testsQ = loaded(useQuery<ApiTest[]>({ queryKey: ["/api/tests"] }));
  const summaryQ = loaded(useQuery<FindingsSummary>({ queryKey: ["/api/findings/summary"] }));
  const clients = clientsQ.state === "ready" ? clientsQ.data : [];
  const tests = testsQ.state === "ready" ? testsQ.data : [];

  // Per client: the newest test of any status (what is happening now), and the
  // latest COMPLETED test of each of its sites (the only ones whose counts are
  // a result, and each the result for its own site).
  const latest = new Map<string, ApiTest>();
  for (const t of tests) {
    const cur = latest.get(t.clientId);
    if (!cur || when(t) > when(cur)) latest.set(t.clientId, t);
  }
  const latestDone = new Map<string, ApiTest[]>();
  for (const t of Array.from(latestCompletedBySite(tests).values())) {
    latestDone.set(t.clientId, [...(latestDone.get(t.clientId) ?? []), t]);
  }

  const rows = clients.map((c) => {
    const t = latest.get(c.id);
    const done = latestDone.get(c.id) ?? [];
    const reads = done.map(readScan);
    const recorded = reads.filter((one) => !one.countsNotRecorded);
    const newest = done.slice().sort((a, b) => completedTime(b) - completedTime(a))[0];
    // The latest completed scan on record; a date typed onto the client only
    // when there is none.
    const lastScan = newest?.completedAt || c.lastTestDate || null;
    return {
      id: c.id, system: c.name, company: c.company, status: c.status,
      readiness: t ? readinessLabel(t.status) : "Not scanned",
      readinessTone: t ? (READINESS_TONE[t.status] ?? "neutral") : ("neutral" as StatusTone),
      band: done.map(bandOf).reduce(worse, "unscanned" as Band),
      scanned: done.length > 0,
      sites: done.length,
      unrecorded: done.length - recorded.length,
      // Scans rated at a severity they count nothing at: a 0 beside their
      // rating is no reading, and at critical or high the C/H figures do not
      // break them down.
      ratedNotCounted: recorded.filter((one) => one.ratedNotCounted !== null).length,
      ratedSerious: recorded.filter((one) => one.ratedNotCounted === "critical" || one.ratedNotCounted === "high").length,
      vulns: recorded.reduce((n, one) => n + one.total, 0),
      crit: recorded.reduce((n, one) => n + one.counts.critical, 0),
      high: recorded.reduce((n, one) => n + one.counts.high, 0),
      lastScan: lastScan ? new Date(lastScan).toLocaleString() : "—",
    };
  });

  const inFlightTests = figure(testsQ, (list) => list.filter((t) => IN_FLIGHT.has(t.status)).length);
  const registered: Loaded<number> = clientsQ.state === "ready" ? { state: "ready", data: clientsQ.data.length } : clientsQ;
  const scanProgress: Loaded<{ scanned: number; inFlight: number; reporting: number }> = (() => {
    const src = both(clientsQ, testsQ);
    if (src.state !== "ready") return src;
    const [clientList, testList] = src.data;
    const ids = new Set(clientList.map((c) => c.id));
    const scanned = clientList.filter((c) => latestDone.has(c.id)).length;
    const inFlight = new Set(testList.filter((t) => IN_FLIGHT.has(t.status) && ids.has(t.clientId)).map((t) => t.clientId)).size;
    // The same scans the table's Risk and Findings columns read.
    const reporting = clientList.filter((c) => (latestDone.get(c.id) ?? []).some(reportsFindings)).length;
    return { state: "ready", data: { scanned, inFlight, reporting } };
  })();
  const withOpen: Loaded<number> = (() => {
    const src = both(clientsQ, summaryQ);
    if (src.state !== "ready") return src;
    const [clientList, summary] = src.data;
    const open = new Map(summary.byClient.map((one) => [one.clientId, one.open]));
    // A system registered since the summary was counted has findings nobody
    // has counted yet: unknown, not none.
    const uncounted = clientList.filter((c) => !open.has(c.id)).length;
    if (uncounted > 0) {
      return { state: "error", message: `${plural(uncounted, "system")} not in the findings summary yet` };
    }
    return { state: "ready", data: clientList.filter((c) => (open.get(c.id) ?? 0) > 0).length };
  })();
  const readiness = readinessSteps(registered, scanProgress, withOpen);

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

  // Worst latest-completed result first, then most critical, then most high.
  // A system whose findings are unrated, or whose counts were not recorded,
  // is listed after the rated ones -- not left out, which let the empty state
  // say no completed scan had reported a finding.
  const highestRisk = rows
    .filter((r) => !NOT_A_RISK.has(r.band))
    .sort((a, b) =>
      BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band) || b.crit - a.crit || b.high - a.high || b.vulns - a.vulns)
    .slice(0, 3);
  const recent = tests.slice()
    .sort((a, b) => when(b) - when(a))
    .slice(0, 5)
    .map((t) => {
      const c = clients.find((x) => x.id === t.clientId);
      return { title: `${readinessLabel(t.status)} — ${t.testType.replace(/-/g, " ")}`, note: c?.name ?? "system", when: new Date(t.completedAt || t.startedAt).toLocaleDateString() };
    });

  const table = both(clientsQ, testsQ);
  const empty = clientsQ.state === "ready" && clients.length === 0;

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
        <StatCard label="Total Deployments" value={figure(clientsQ, (list) => list.length)} icon={Boxes}
          sublabel={clientsQ.state === "error" ? "Could not load systems" : "Systems registered"} />
        <StatCard label="Active Systems" value={figure(clientsQ, (list) => list.filter((c) => c.status === "active").length)} icon={Activity}
          sublabel="Client status set to active" />
        <StatCard label="Scans Pending" value={inFlightTests} icon={Clock}
          sublabel={testsQ.state === "error" ? "Could not load scans" : "Pending, queued or running"} />
        <StatCard label="Paused" value={figure(clientsQ, (list) => list.filter((c) => c.status === "paused" || c.status === "inactive").length)} icon={PauseCircle}
          sublabel="Client status paused or inactive" />
        {/* Athena computes no risk score. The old tile averaged a hard-coded
            0-100 mapping of severity bands (a clean system scored 8). */}
        <StatCard label="Risk Score" value="—" icon={Gauge} sublabel="Not scored: Athena computes no risk score" />
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
                  {table.state !== "ready" ? (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-[12px] text-muted-foreground">{notInHand(table, "systems")}</td></tr>
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
                            <span className="block text-[11px] text-muted-foreground">
                              {!d.scanned ? "—" : d.sites > 1 ? `Latest completed scan of each of ${d.sites} sites` : "Latest completed scan"}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-[12px] text-muted-foreground">
                        {!d.scanned ? "—" : d.vulns > 0 ? <><span className="font-medium text-foreground">{d.vulns}</span> ({d.crit}C / {d.high}H)</> : d.unrecorded > 0 ? null : d.ratedNotCounted > 0 ? "No count recorded" : "0 reported"}
                        {d.ratedSerious > 0 && (
                          <span className="block text-[11px]" data-testid={`text-rated-not-counted-${d.id}`}>
                            {d.ratedSerious === d.sites ? "Rated" : `${plural(d.ratedSerious, "scan")} rated`} critical or high, not counted by severity: the C/H figures leave {d.ratedSerious === 1 ? "it" : "them"} out.
                          </span>
                        )}
                        {d.unrecorded > 0 && (
                          <span className="block text-[11px]" data-testid={`text-counts-not-recorded-${d.id}`}>
                            {d.unrecorded === d.sites
                              ? "Counts not recorded"
                              : `Counts not recorded for ${plural(d.unrecorded, "scan")}`}
                            : results came back, but the scan&apos;s counts were never written down.
                          </span>
                        )}
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
            <p className="-mt-2 mb-3 text-[11px] text-muted-foreground">By what each system&apos;s latest completed scan reported.</p>
            {table.state !== "ready" ? (
              <p className="text-[12px] text-muted-foreground">{notInHand(table, "scans")}</p>
            ) : highestRisk.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                {rows.some((r) => r.band === "info")
                  ? "No completed scan has reported a finding rated above info."
                  : "No completed scan has reported a finding."}
              </p>
            ) : (
              <ul className="space-y-3">
                {highestRisk.map((h) => (
                  <li key={h.id} className="flex items-center gap-3" data-testid={`highest-risk-${h.id}`}>
                    {RATED.has(h.band)
                      ? <SeverityPill severity={h.band as "critical" | "high" | "medium" | "low"} />
                      : <StatusPill tone="neutral">{BAND_LABEL[h.band]}</StatusPill>}
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-[13px] text-foreground">{h.system}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {h.band === "unrecorded"
                          ? "Counts not recorded"
                          : h.vulns === 0 && h.ratedNotCounted > 0
                            ? "No count recorded"
                            : `${h.vulns} finding${h.vulns === 1 ? "" : "s"} reported (${h.crit}C / ${h.high}H)`}
                        {h.band !== "unrecorded" && h.unrecorded > 0 ? ` · counts not recorded for ${plural(h.unrecorded, "scan")}` : ""}
                        {h.ratedSerious > 0 ? ` · ${h.ratedSerious === h.sites ? "rated" : `${plural(h.ratedSerious, "scan")} rated`}, not counted by severity` : ""}
                      </span>
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
            {testsQ.state !== "ready" ? (
              <p className="text-[12px] text-muted-foreground">{notInHand(testsQ, "scans")}</p>
            ) : recent.length === 0 ? (
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
