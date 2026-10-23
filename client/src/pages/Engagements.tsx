/**
 * Engagements: Athena-Backend's record of the engagements the signed-in person
 * can see, read as them when the page loads (GET /api/record/engagements; the
 * Option 1 hybrid, owner decisions 1 and 4). For each engagement: the dashboard
 * client it is linked to (by the client's backendEngagementId) or the plain word
 * that it is linked to none; the backend's client name, scope hosts, status and
 * testing window; the scans the record lists under it, counted by the backend's
 * status words and verdict labels; and the deployments ingested under it, each
 * with its decision and the state of its coverage manifest.
 *
 * Every figure is drawn from rows the list carries, never from silence. The
 * engagements are read first: with none readable the page says why (the
 * person's own backend sign-in, or the backend's refusal in its words) and
 * shows no empty list. The scans and the deployments are read alongside, and
 * a part that could not be read shows the reason where its figures would be
 * -- "no scans recorded" is said only of a list read whole. A scan the record
 * lists as pending with no run id yet is said to await the launch's answer; a
 * stopped or failed record is read in the backend's own words.
 *
 * On load the page also asks the adoption sync (hooks/useRecordAdoption.ts),
 * so a scan the record lists and this dashboard has no row for gets one, and
 * the row's scan page, Stop and kill switch cover it. Nothing here stops,
 * starts or writes anything; the scan page does the stopping.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Boxes, CalendarClock, ClipboardList, ExternalLink, Handshake, ListChecks, Radar } from "lucide-react";
import PageHero from "@/components/mythos/PageHero";
import StatCard from "@/components/mythos/StatCard";
import GlassCard from "@/components/GlassCard";
import { Divider } from "@/components/mythos/Ornament";
import { DecisionPill, Label, StatusPill, type Decision, type StatusTone } from "@/components/mythos/atoms";
import { ApiError } from "@/lib/queryClient";
import { errorMessage, loaded } from "@/lib/loaded";
import { useRecordAdoption } from "@/hooks/useRecordAdoption";
import { BACKEND_RECORD } from "@/lib/sourceLabels";
import {
  ADOPTION_COULD_NOT_BE_READ, ADOPTION_RECENT, ADOPTION_SYNCING, DEPLOYMENTS_COULD_NOT_BE_READ, ENGAGEMENTS_PAGE_SOURCE, ENGAGEMENTS_PAGE_SUBTITLE,
  ENGAGEMENTS_PAGE_TITLE, HIDE_DETAIL, LAUNCH_ANSWER_AWAITED, LINKED_CLIENT, MANIFEST_COULD_NOT_BE_READ, MANIFEST_READING,
  DEPLOYMENTS_SECTION, LINKED_SECTION, NOT_LINKED_TO_CLIENT, NO_DEPLOYMENTS, NO_ENGAGEMENTS, NO_REASON_GIVEN, NO_SCANS_RECORDED,
  NO_VERDICT_SERVED, OPEN_DEPLOYMENT, OPEN_SCAN, PDF_LINK, RECORD_COULD_NOT_BE_READ, RECORD_NEEDS_SIGN_IN, RECORD_READING,
  REPORT_AFTER_ADOPTION, RUNNING_NOW_LABEL, RUNNING_NOW_SUBLABEL, SCANS_COULD_NOT_BE_READ, SCANS_SECTION, SCANS_UNDER_NO_ENGAGEMENT_SHOWN,
  SCOPE_LABEL, SCOPE_NONE, SHOW_DETAIL, WINDOW_ENDED, WINDOW_LABEL, WINDOW_NOT_RECORDED, adoptedLine, collectedLine, engagementRef,
  engineRunRef, failedOnEngine, findingsInRecord, manifestLine, readAtLine, scanCountsLine, stopAskedReading, stoppedOnEngine,
  verdictCountsLine, windowRemaining,
} from "@/lib/backendRecordCopy";

/* ---- the record's shapes, as GET /api/record/engagements answers them ---- */

interface RecordEngagement {
  id: number;
  name: string;
  clientName: string | null;
  scopeSummary: string | null;
  status: string;
  testingWindowStart: string | null;
  testingWindowEnd: string | null;
  scopeHosts: string[];
  /** The dashboard client whose backendEngagementId names this engagement; null when none does. */
  client: { id: string; name: string; company: string } | null;
}

interface RecordScan {
  uuid: string;
  targetUrl: string | null;
  /** The backend's status word: pending | completed | stopped | failed | unknown. */
  status: string;
  verdict: string | null;
  verdictLabel: string | null;
  createdAt: string | null;
  collectedAt: string | null;
  engineRunId: string | null;
  /** The backend's reading of a Stop asked of it, as served. */
  stop: { state?: string; detail?: string | null } | null;
  pdfUrl: string | null;
  errorMessage: string | null;
  engagement: { id: number | null; name: string | null; clientName: string | null; status: string | null } | null;
  /** The row here that names this scan (started from here, or adopted), or null until the sync gives it one. */
  test: { id: string; status: string; clientId: string | null; stop: "backend" | null } | null;
}

interface RecordDeployment {
  uuid: string;
  name: string;
  environment: string;
  decision: string | null;
  decisionLabel: string;
  findingCount: number;
  engagementId: number | null;
}

interface RecordView {
  readAt: string;
  engagements: RecordEngagement[];
  /** Every scan the backend lists for the person, or null when the list could not be read (scansUnread says why). */
  scans: RecordScan[] | null;
  scansUnread: string | null;
  deployments: RecordDeployment[] | null;
  deploymentsUnread: string | null;
}

interface Manifest {
  expected: number;
  assessed: number;
  verdict: string;
  complete: boolean;
  summary: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The engagement's status word, toned; the word itself is the backend's. */
function engagementTone(status: string): StatusTone {
  if (status === "running") return "progress";
  if (status === "completed") return "complete";
  if (status === "planned") return "review";
  return "neutral";
}

function scanTone(status: string): StatusTone {
  if (status === "pending") return "progress";
  if (status === "completed") return "complete";
  return "neutral";
}

/** The window as the record dates it: ended, days remaining, or not recorded. */
export function windowReading(start: string | null, end: string | null, now: number): { text: string; ended: boolean } {
  if (end === null) return { text: WINDOW_NOT_RECORDED, ended: false };
  const endsAt = Date.parse(end);
  if (Number.isNaN(endsAt)) return { text: WINDOW_NOT_RECORDED, ended: false };
  if (endsAt < now) return { text: WINDOW_ENDED, ended: true };
  const days = Math.max(1, Math.ceil((endsAt - now) / DAY_MS));
  void start;
  return { text: windowRemaining(days), ended: false };
}

/** Counts by a word the rows carry, in first-seen order. */
function countBy(rows: RecordScan[], word: (row: RecordScan) => string | null): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = word(row);
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries());
}

function when(iso: string | null): string {
  if (iso === null) return "—";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/** What the record says of a scan's outcome, in the backend's words. */
function outcomeOf(scan: RecordScan): string {
  if (scan.status === "completed") return scan.verdictLabel ?? NO_VERDICT_SERVED;
  if (scan.status === "stopped") return stoppedOnEngine(scan.errorMessage);
  if (scan.status === "failed") return failedOnEngine(scan.errorMessage);
  if (scan.engineRunId === null) return LAUNCH_ANSWER_AWAITED;
  return engineRunRef(scan.engineRunId);
}

function ScanRow({ scan }: { scan: RecordScan }) {
  const stopState = scan.stop && typeof scan.stop.state === "string" && scan.stop.state !== "none" ? scan.stop.state : null;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 border-t border-border/40 py-3" data-testid={`record-scan-${scan.uuid}`}>
      <div className="min-w-0 space-y-1">
        <p className="athena-mono truncate text-[13px] text-foreground" data-testid="text-scan-target">{scan.targetUrl ?? "—"}</p>
        <p className="text-[12px] text-muted-foreground" data-testid="text-scan-outcome">{outcomeOf(scan)}</p>
        <p className="text-[11px] text-muted-foreground/80">
          {scan.engineRunId !== null && scan.status !== "pending" ? `${engineRunRef(scan.engineRunId)} · ` : ""}
          {collectedLine(when(scan.collectedAt))}
          {stopState !== null ? ` · ${stopAskedReading(stopState)}` : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={scanTone(scan.status)}>{scan.status}</StatusPill>
        {scan.test !== null ? (
          <Link href={`/athena?test=${encodeURIComponent(scan.test.id)}`} className="text-[12px] text-gold underline-offset-2 hover:underline" data-testid="link-open-scan">
            {OPEN_SCAN}
          </Link>
        ) : null}
        {scan.pdfUrl !== null && scan.test !== null ? (
          <a
            href={`/api/scans/${encodeURIComponent(scan.test.id)}/backend-pdf`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12px] text-gold underline-offset-2 hover:underline"
            data-testid="link-record-pdf"
          >
            <ExternalLink className="h-3 w-3" />
            {PDF_LINK}
          </a>
        ) : null}
        {scan.pdfUrl !== null && scan.test === null ? (
          <span className="text-[11px] text-muted-foreground" data-testid="text-report-after-adoption">{REPORT_AFTER_ADOPTION}</span>
        ) : null}
      </div>
    </li>
  );
}

/** The manifest's state, read through the Assurance relay only while this deployment is on screen. */
function ManifestLine({ uuid }: { uuid: string }) {
  const manifest = loaded(useQuery<Manifest>({ queryKey: [`/api/assurance/deployments/${uuid}/coverage-manifest`] }));
  if (manifest.state === "loading") return <span data-testid="text-manifest">{MANIFEST_READING}</span>;
  if (manifest.state === "error") return <span data-testid="text-manifest">{MANIFEST_COULD_NOT_BE_READ}: {manifest.message}</span>;
  return <span data-testid="text-manifest">{manifestLine(manifest.data.verdict, manifest.data.assessed, manifest.data.expected)}</span>;
}

function DeploymentRow({ deployment }: { deployment: RecordDeployment }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 border-t border-border/40 py-3" data-testid={`record-deployment-${deployment.uuid}`}>
      <div className="min-w-0 space-y-1">
        <p className="text-[13px] font-medium text-foreground">{deployment.name} <span className="text-muted-foreground">· {deployment.environment}</span></p>
        <p className="text-[12px] text-muted-foreground">{findingsInRecord(deployment.findingCount)}</p>
        <p className="text-[11px] text-muted-foreground/80"><ManifestLine uuid={deployment.uuid} /></p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <DecisionPill decision={deployment.decision as Decision} label={deployment.decisionLabel} />
        <Link href={`/assurance?deployment=${encodeURIComponent(deployment.uuid)}`} className="text-[12px] text-gold underline-offset-2 hover:underline" data-testid="link-open-deployment">
          {OPEN_DEPLOYMENT}
        </Link>
      </div>
    </li>
  );
}

function EngagementCard({
  engagement, scans, scansUnread, deployments, deploymentsUnread, open, now,
}: {
  engagement: RecordEngagement;
  /** This engagement's rows, or null when the list could not be read. */
  scans: RecordScan[] | null;
  scansUnread: string | null;
  deployments: RecordDeployment[] | null;
  deploymentsUnread: string | null;
  open: boolean;
  now: number;
}) {
  const [expanded, setExpanded] = useState(open);
  const window = windowReading(engagement.testingWindowStart, engagement.testingWindowEnd, now);
  const byStatus = scans === null ? [] : countBy(scans, (row) => row.status);
  const byVerdict = scans === null ? [] : countBy(scans, (row) => (row.status === "completed" ? row.verdictLabel ?? NO_VERDICT_SERVED : null));
  return (
    <GlassCard hover={false} data-testid={`engagement-${engagement.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h3 className="font-serif text-[20px] font-semibold text-foreground" data-testid="text-engagement-name">
            {engagement.name || `Engagement #${engagement.id}`}
          </h3>
          <p className="text-[12px] text-muted-foreground">
            {engagementRef(engagement.id)}
            {engagement.clientName ? ` · ${engagement.clientName}` : ""}
          </p>
          <p className="text-[12px]" data-testid="text-engagement-client">
            {engagement.client !== null ? (
              <>
                <span className="text-muted-foreground">{LINKED_CLIENT}: </span>
                <Link href="/clients" className="text-gold underline-offset-2 hover:underline">{engagement.client.name} · {engagement.client.company}</Link>
              </>
            ) : (
              <span className="text-muted-foreground">{NOT_LINKED_TO_CLIENT}</span>
            )}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusPill tone={engagementTone(engagement.status)}>{engagement.status}</StatusPill>
          <span
            className={window.ended ? "text-[12px] font-medium text-sev-high" : "text-[12px] text-muted-foreground"}
            data-testid="text-engagement-window"
          >
            <CalendarClock className="mr-1 inline h-3 w-3" />
            {window.text}
          </span>
        </div>
      </div>

      <dl className="mt-4 grid gap-3 text-[12px] sm:grid-cols-2">
        <div>
          <dt className="athena-label">{SCOPE_LABEL}</dt>
          <dd className="mt-1 text-foreground" data-testid="text-engagement-scope">
            {engagement.scopeHosts.length === 0 ? <span className="text-muted-foreground">{SCOPE_NONE}</span> : engagement.scopeHosts.join(", ")}
          </dd>
        </div>
        <div>
          <dt className="athena-label">{WINDOW_LABEL}</dt>
          <dd className="mt-1 text-foreground">
            {engagement.testingWindowStart === null && engagement.testingWindowEnd === null
              ? <span className="text-muted-foreground">{WINDOW_NOT_RECORDED}</span>
              : `${when(engagement.testingWindowStart)} – ${when(engagement.testingWindowEnd)}`}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="athena-label">{SCANS_SECTION}</dt>
          <dd className="mt-1 text-foreground" data-testid="text-engagement-scan-counts">
            {scans === null
              ? <span className="text-muted-foreground">{SCANS_COULD_NOT_BE_READ}: {scansUnread ?? NO_REASON_GIVEN}</span>
              : scans.length === 0
                ? <span className="text-muted-foreground">{NO_SCANS_RECORDED}</span>
                : (
                  <>
                    <span>{scanCountsLine(scans.length, byStatus)}</span>
                    <span className="block text-muted-foreground" data-testid="text-engagement-verdict-counts">{verdictCountsLine(byVerdict)}</span>
                  </>
                )}
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={() => setExpanded((cur) => !cur)}
        className="mt-4 text-[12px] text-gold underline-offset-2 hover:underline"
        data-testid="button-engagement-detail"
        aria-expanded={expanded}
      >
        {expanded ? HIDE_DETAIL : SHOW_DETAIL}
      </button>

      {expanded ? (
        <div className="mt-3 space-y-5" data-testid="engagement-detail">
          <section>
            <Label>{SCANS_SECTION}</Label>
            {scans === null ? (
              <p className="mt-2 text-[12px] text-muted-foreground">{SCANS_COULD_NOT_BE_READ}: {scansUnread ?? NO_REASON_GIVEN}</p>
            ) : scans.length === 0 ? (
              <p className="mt-2 text-[12px] text-muted-foreground">{NO_SCANS_RECORDED}</p>
            ) : (
              <ul className="mt-2">{scans.map((scan) => <ScanRow key={scan.uuid} scan={scan} />)}</ul>
            )}
          </section>
          <section>
            <Label>{DEPLOYMENTS_SECTION}</Label>
            {deployments === null ? (
              <p className="mt-2 text-[12px] text-muted-foreground" data-testid="text-deployments-unread">{DEPLOYMENTS_COULD_NOT_BE_READ}: {deploymentsUnread ?? NO_REASON_GIVEN}</p>
            ) : deployments.length === 0 ? (
              <p className="mt-2 text-[12px] text-muted-foreground" data-testid="text-no-deployments">{NO_DEPLOYMENTS}</p>
            ) : (
              <ul className="mt-2">{deployments.map((one) => <DeploymentRow key={one.uuid} deployment={one} />)}</ul>
            )}
          </section>
        </div>
      ) : null}
    </GlassCard>
  );
}

/** Why the record was not read, in the server's terms: its sign-in reason stands out from every other. */
function RecordUnread({ error }: { error: unknown }) {
  const needsSignIn = error instanceof ApiError && error.body?.reason === "backend_sign_in_required";
  return (
    <GlassCard hover={false} glow={false} data-testid="panel-record-unread">
      {needsSignIn ? (
        <p className="text-sm" data-testid="text-record-sign-in">{RECORD_NEEDS_SIGN_IN}</p>
      ) : (
        <p className="text-sm" data-testid="text-record-unread">{RECORD_COULD_NOT_BE_READ}: {errorMessage(error)}</p>
      )}
    </GlassCard>
  );
}

export default function Engagements() {
  const adoption = useRecordAdoption();
  const record = useQuery<RecordView>({ queryKey: ["/api/record/engagements"] });
  const now = Date.now();

  const view = record.data;
  const scansOf = (id: number): RecordScan[] | null => (view?.scans == null ? null : view.scans.filter((row) => row.engagement?.id === id));
  const deploymentsOf = (id: number): RecordDeployment[] | null =>
    (view?.deployments == null ? null : view.deployments.filter((one) => one.engagementId === id));
  const shownIds = new Set((view?.engagements ?? []).map((one) => one.id));
  const orphanScans = view?.scans == null ? [] : view.scans.filter((row) => row.engagement?.id == null || !shownIds.has(row.engagement.id));
  const linked = (view?.engagements ?? []).filter((one) => one.client !== null);
  const unlinked = (view?.engagements ?? []).filter((one) => one.client === null);
  const runningNow = view?.scans == null ? null : view.scans.filter((row) => row.status === "pending" && row.engineRunId !== null).length;

  return (
    <div className="space-y-6 p-6" data-testid="page-engagements">
      <PageHero
        title={ENGAGEMENTS_PAGE_TITLE}
        subtitle={ENGAGEMENTS_PAGE_SUBTITLE}
        background="council"
        verbs={["Engage", "Scan", "Record", "Decide"]}
      >
        <p className="mt-3 text-[12px] text-muted-foreground" data-testid="text-engagements-source">
          <span className="text-gold">{BACKEND_RECORD}.</span> {ENGAGEMENTS_PAGE_SOURCE}
        </p>
        <p className="mt-1 text-[12px] text-muted-foreground" data-testid="text-adoption-outcome">
          {adoption.state === "syncing"
            ? ADOPTION_SYNCING
            : adoption.state === "unread"
              ? `${ADOPTION_COULD_NOT_BE_READ}: ${adoption.message}`
              : adoption.throttled
                ? ADOPTION_RECENT
                : adoptedLine(adoption.adopted, adoption.remaining)}
        </p>
      </PageHero>

      {record.isError ? (
        <RecordUnread error={record.error} />
      ) : view === undefined ? (
        <p className="text-sm text-muted-foreground" data-testid="text-record-reading">{RECORD_READING}</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Engagements" value={view.engagements.length} icon={Handshake} data-testid="stat-engagements" />
            <StatCard
              label={SCANS_SECTION}
              value={view.scans === null ? "—" : view.scans.length}
              icon={ListChecks}
              sublabel={view.scans === null ? `${SCANS_COULD_NOT_BE_READ}: ${view.scansUnread ?? NO_REASON_GIVEN}` : undefined}
              data-testid="stat-record-scans"
            />
            <StatCard
              label={RUNNING_NOW_LABEL}
              value={runningNow === null ? "—" : runningNow}
              icon={Radar}
              sublabel={runningNow === null ? `${SCANS_COULD_NOT_BE_READ}: ${view.scansUnread ?? NO_REASON_GIVEN}` : RUNNING_NOW_SUBLABEL}
              data-testid="stat-record-running"
            />
            <StatCard
              label="Deployments"
              value={view.deployments === null ? "—" : view.deployments.length}
              icon={Boxes}
              sublabel={view.deployments === null ? `${DEPLOYMENTS_COULD_NOT_BE_READ}: ${view.deploymentsUnread ?? NO_REASON_GIVEN}` : undefined}
              data-testid="stat-record-deployments"
            />
          </div>

          {view.engagements.length === 0 ? (
            <GlassCard hover={false} glow={false} data-testid="panel-no-engagements">
              <p className="text-sm text-muted-foreground">{NO_ENGAGEMENTS}</p>
            </GlassCard>
          ) : null}

          {linked.length > 0 ? (
            <section className="space-y-4" data-testid="section-linked">
              <div className="flex items-center gap-3">
                <ClipboardList className="h-4 w-4 text-gold" />
                <h2 className="athena-label">{LINKED_SECTION}</h2>
              </div>
              {linked.map((one, index) => (
                <EngagementCard
                  key={one.id}
                  engagement={one}
                  scans={scansOf(one.id)}
                  scansUnread={view.scansUnread}
                  deployments={deploymentsOf(one.id)}
                  deploymentsUnread={view.deploymentsUnread}
                  open={index === 0}
                  now={now}
                />
              ))}
            </section>
          ) : null}

          {unlinked.length > 0 ? (
            <section className="space-y-4" data-testid="section-unlinked">
              <Divider variant="key" />
              <h2 className="athena-label" data-testid="text-unlinked-heading">{NOT_LINKED_TO_CLIENT}</h2>
              {unlinked.map((one) => (
                <EngagementCard
                  key={one.id}
                  engagement={one}
                  scans={scansOf(one.id)}
                  scansUnread={view.scansUnread}
                  deployments={deploymentsOf(one.id)}
                  deploymentsUnread={view.deploymentsUnread}
                  open={linked.length === 0}
                  now={now}
                />
              ))}
            </section>
          ) : null}

          {orphanScans.length > 0 ? (
            <GlassCard hover={false} data-testid="section-orphan-scans">
              <Label>{SCANS_UNDER_NO_ENGAGEMENT_SHOWN}</Label>
              <ul className="mt-2">{orphanScans.map((scan) => <ScanRow key={scan.uuid} scan={scan} />)}</ul>
            </GlassCard>
          ) : null}

          <p className="text-[11px] text-muted-foreground" data-testid="text-record-read-at">{readAtLine(when(view.readAt))}</p>
        </>
      )}
    </div>
  );
}
