/**
 * Evidence: the documents on record for an engagement, read from
 * `/api/documents`. Title, type, owner and date are live; the headline counts
 * are computed from the set.
 *
 * The right rail used to carry a "Release Recommendation" that took the newest
 * test of any status and, finding no critical or high count on it, said "Ready
 * for controlled release" -- so a scan still running, pending or failed (all
 * of which carry zero counts) read as a clean result and a release call. It
 * now describes only the latest COMPLETED scan's counts, and makes no release
 * call at all: severity counts are not a release decision. The assurance
 * decision on the Assurance page is the one this product records.
 *
 * The banner used to read "Document the truth." A record -- signed or not --
 * documents what someone observed or asserted, and who put it on record; it
 * does not make the observation behind it true. The subtitle says that.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import {
  Files,
  FileText,
  FileCheck2,
  ClipboardList,
  FolderArchive,
  Download,
  MoreHorizontal,
  ChevronRight,
  Search,
  Landmark,
  ScanLine,
} from "lucide-react";
import PageHero from "@/components/mythos/PageHero";
import StatCard from "@/components/mythos/StatCard";
import GlassCard from "@/components/GlassCard";
import SampleDataNotice from "@/components/SampleDataNotice";
import { Divider } from "@/components/mythos/Ornament";
import { StatusPill, Avatar } from "@/components/mythos/atoms";
import { figure, loaded, notInHand } from "@/lib/loaded";
import { readScan, type ReadableTest } from "@shared/latest-scans";

interface ApiDoc { id: string; title: string; description: string | null; documentType: string; fileUrl: string | null; createdAt: string; createdBy: string | null }
interface ApiUser { id: string; username: string }
interface ApiClient { id: string; name: string; status: string }
interface ApiTest {
  id: string; clientId: string; status: string; severity: string | null; completedAt: string | null; startedAt: string;
  vulnerabilitiesFound: number; criticalCount: number; highCount: number; mediumCount: number; lowCount: number; findings?: unknown;
}

const TYPE_ICON: Record<string, typeof FileText> = {
  Report: FileText, Policy: ClipboardList, Evidence: FileCheck2, Archive: FolderArchive,
};
function typeIcon(t: string) { return TYPE_ICON[t] ?? FileText; }

/**
 * What a completed scan's record says it found at critical and high, read
 * whole (shared/latest-scans.ts readScan). From the critical and high counts
 * alone, a scan recorded "Severity: Critical, Total Vulnerabilities: 2" with
 * the counts left at 0 "reported 0 critical and 0 high findings".
 */
export function latestScanReport(test: ReadableTest): string {
  const read = readScan(test);
  // An engine scan finished before the inline-count fix has results and no
  // counts: they were never taken, so they are not read as 0. Nor are the
  // counts of one whose results could not be read, which were never taken either.
  if (read.countsNotRecorded) {
    const results = test.findings && typeof test.findings === "object"
      ? (test.findings as { results?: unknown }).results
      : undefined;
    return results !== undefined && !Array.isArray(results)
      ? "Its latest completed scan's results could not be read, so its counts were not recorded"
      : "Its latest completed scan returned results, but its counts were not recorded";
  }
  const n = (count: number, what: string) => `${count} ${what}${count === 1 ? "" : "s"}`;
  const counted = read.counts.critical + read.counts.high + read.counts.medium + read.counts.low;
  // Nothing broken down by severity: no "0 critical" the record never said.
  if (counted === 0 && read.ratedNotCounted) {
    return read.total > 0
      ? `Its latest completed scan reported ${n(read.total, "finding")}, rated ${read.ratedNotCounted}; not broken down by severity`
      : `Its latest completed scan was rated ${read.ratedNotCounted}, with no count recorded`;
  }
  if (counted === 0 && read.unrated > 0) {
    return `Its latest completed scan reported ${n(read.total, "finding")}${read.unrated === read.total ? "" : `, ${read.unrated}`} with no severity recorded`;
  }
  const serious = `${read.counts.critical} critical and ${read.counts.high} high finding${read.counts.critical + read.counts.high === 1 ? "" : "s"}`;
  const notes = [
    read.ratedNotCounted ? `rated ${read.ratedNotCounted}, with no ${read.ratedNotCounted} count recorded` : null,
    read.unrated > 0 ? `${n(read.unrated, "finding")} with no severity recorded` : null,
  ].filter((note): note is string => note !== null);
  return `Its latest completed scan reported ${serious}${notes.length ? `; ${notes.join("; ")}` : ""}`;
}

const tabOn = "rounded-full bg-primary/15 px-3 py-1 text-[12px] font-medium text-primary";
const tabOff = "rounded-full px-3 py-1 text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors";

export default function Evidence() {
  const docsQ = loaded(useQuery<ApiDoc[]>({ queryKey: ["/api/documents"] }));
  const { data: users = [] } = useQuery<ApiUser[]>({ queryKey: ["/api/users/assignable"] });
  const { data: clients = [] } = useQuery<ApiClient[]>({ queryKey: ["/api/clients"] });
  const testsQ = loaded(useQuery<ApiTest[]>({ queryKey: ["/api/tests"] }));
  const docs = docsQ.state === "ready" ? docsQ.data : [];

  const userName = (id: string | null) => users.find((u) => u.id === id)?.username ?? "—";

  const byType = new Map<string, number>();
  docs.forEach((d) => byType.set(d.documentType, (byType.get(d.documentType) ?? 0) + 1));
  const reports = byType.get("Report") ?? 0;

  const [typeF, setTypeF] = useState("all");
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const view = docs.filter((d) =>
    (typeF === "all" || d.documentType === typeF) &&
    (q === "" || d.title.toLowerCase().includes(q) || (d.description ?? "").toLowerCase().includes(q)),
  );
  const openDoc = (url: string | null) => { if (url) window.open(url, "_blank", "noopener,noreferrer"); };

  // The latest COMPLETED test: the only kind whose counts are a result. A
  // running, pending or failed one has zero counts because it has none.
  const tests = testsQ.state === "ready" ? testsQ.data : [];
  const completed = tests.filter((t) => t.status === "completed");
  const unfinished = tests.length - completed.length;
  const latestDone = completed
    .slice()
    .sort((a, b) => new Date(b.completedAt || b.startedAt).getTime() - new Date(a.completedAt || a.startedAt).getTime())[0];
  const latestClient = latestDone ? clients.find((c) => c.id === latestDone.clientId) : undefined;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  const empty = docsQ.state === "ready" && docs.length === 0;

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-8">
      <PageHero
        title="Evidence"
        subtitle="What was recorded, by whom, and when. A record shows what was observed or asserted, not that it is true."
        background="library"
        verbs={["Evidence", "Proof", "Trust", "Deploys"]}
      />
      <Divider variant="laurel" className="mt-5" />
      {/* Seeded demo rows are real rows, so they are counted here; this says how many. */}
      <SampleDataNotice counts={["documents", "clients", "tests"]} className="mt-5" />

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          {/* stats -- live from the document store */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Documents" value={figure(docsQ, (list) => list.length)} icon={Files}
              sublabel={docsQ.state === "error" ? "Could not load documents" : "On record for this org"} />
            <StatCard label="Reports" value={figure(docsQ, () => reports)} icon={FileText} sublabel="Assessment reports" />
            <StatCard label="Document Types" value={figure(docsQ, () => byType.size)} icon={ClipboardList} sublabel="Distinct categories" />
            {/* Every test, whatever its status. It said "Scans with a decision",
                which none of them carries. */}
            <StatCard label="Tests on record" value={figure(testsQ, (list) => list.length)} icon={FileCheck2}
              sublabel={testsQ.state === "ready" ? `${completed.length} completed` : testsQ.state === "error" ? "Could not load scans" : "Any status"} />
          </div>

          {/* table */}
          <GlassCard hover={false} bodyClassName="p-0">
            <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-4 py-3">
              <div className="flex flex-wrap gap-1">
                <button onClick={() => setTypeF("all")} className={typeF === "all" ? tabOn : tabOff}>All</button>
                {Array.from(byType.keys()).map((t) => (
                  <button key={t} onClick={() => setTypeF(t)} className={typeF === t ? tabOn : tabOff}>{t}</button>
                ))}
              </div>
              <label className="ml-auto flex items-center gap-2 rounded-lg border border-border/60 bg-surface-1/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                <Search className="h-3.5 w-3.5" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search evidence…" className="w-32 bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none" />
              </label>
            </div>
            {empty ? (
              <p className="px-5 py-10 text-center text-[13px] text-muted-foreground">No documents on record yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                      {["Evidence Artifact", "Type", "Owner", "Created", "Actions"].map((h) => (
                        <th key={h} className="px-4 py-2 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {docsQ.state !== "ready" ? (
                      <tr><td colSpan={5} className="px-4 py-8 text-center text-[12px] text-muted-foreground">{notInHand(docsQ, "documents")}</td></tr>
                    ) : view.length === 0 ? (
                      <tr><td colSpan={5} className="px-4 py-8 text-center text-[12px] text-muted-foreground">No documents match the current filter.</td></tr>
                    ) : view.map((d) => {
                      const Icon = typeIcon(d.documentType);
                      return (
                        <tr key={d.id} className="border-t border-border/40 hover:bg-surface-1/40">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gold-dim/40 bg-gold/5 text-gold"><Icon className="h-4 w-4" /></span>
                              <span className="leading-tight">
                                <span className="block text-[13px] font-medium text-foreground">{d.title}</span>
                                {d.description && <span className="block text-[11px] text-muted-foreground">{d.description}</span>}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3"><StatusPill tone="review">{d.documentType}</StatusPill></td>
                          <td className="px-4 py-3"><Avatar name={userName(d.createdBy)} size={30} /></td>
                          <td className="px-4 py-3 text-[12px] text-muted-foreground">{new Date(d.createdAt).toLocaleDateString()}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <button onClick={() => openDoc(d.fileUrl)} disabled={!d.fileUrl} className="rounded-md border border-border/60 px-2.5 py-1 text-[12px] text-foreground hover:border-primary/50 disabled:opacity-40">View</button>
                              <button onClick={() => openDoc(d.fileUrl)} disabled={!d.fileUrl} title="Download" className="rounded-md border border-border/60 p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"><Download className="h-3.5 w-3.5" /></button>
                              <button className="p-1 text-muted-foreground"><MoreHorizontal className="h-4 w-4" /></button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </GlassCard>

          <GlassCard hover={false} ruling bodyClassName="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-full border border-gold-dim/40 text-gold"><Landmark className="h-5 w-5" /></span>
              <div>
                <p className="font-serif text-[18px] text-foreground">From evidence to confidence.</p>
                <p className="text-[13px] text-muted-foreground">Clear documentation. Measurable progress. Safer AI for what's next.</p>
              </div>
            </div>
            <button className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-gold">Turn evidence into opportunity <ChevronRight className="h-4 w-4" /></button>
          </GlassCard>
        </div>

        {/* right rail */}
        <div className="space-y-5">
          {/* Not `ruling`: gold is for judgements, and this is a description of
              what a scan reported, not a release call. */}
          <GlassCard hover={false} data-testid="evidence-latest-scan">
            <p className="athena-label mb-3">Latest Completed Scan</p>
            {testsQ.state !== "ready" ? (
              <p className="text-[12px] text-muted-foreground">{notInHand(testsQ, "scans")}</p>
            ) : latestDone ? (
              <>
                <div className="flex items-start gap-3">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-border/60 bg-surface-1/50 text-muted-foreground">
                    <ScanLine className="h-6 w-6" />
                  </span>
                  <div>
                    <p className="text-[14px] font-semibold text-foreground">{latestClient?.name ?? "Unknown system"}</p>
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      {latestScanReport(latestDone)}
                      {latestDone.completedAt ? ` (${new Date(latestDone.completedAt).toLocaleDateString()})` : ""}.
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                  A scan&apos;s severity counts are not a release decision.
                  {unfinished > 0 ? ` ${plural(unfinished, "other test")} not finished or failed, and not counted here.` : ""}
                </p>
                <Link href="/assurance" className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-border/60 py-2 text-[12px] font-medium text-foreground hover:border-primary/50">
                  Assurance decisions <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </>
            ) : (
              <p className="text-[12px] text-muted-foreground">
                No completed scan yet{tests.length > 0 ? ` (${plural(tests.length, "test")} on record, ${unfinished} not finished or failed)` : ""}. A scan&apos;s counts show here once one completes.
              </p>
            )}
          </GlassCard>

          <GlassCard hover={false}>
            <p className="athena-label mb-1">Recent Document Activity</p>
            {docsQ.state !== "ready" ? (
              <p className="text-[12px] text-muted-foreground">{notInHand(docsQ, "documents")}</p>
            ) : docs.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No document activity yet.</p>
            ) : (
              <ul className="mt-2 space-y-3">
                {docs.slice(0, 5).map((d) => (
                  <li key={d.id} className="flex items-start gap-2.5">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-gold" />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block text-[12px] text-foreground">{d.title}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{d.documentType} · {userName(d.createdBy)}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground/70">{new Date(d.createdAt).toLocaleDateString()}</span>
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
