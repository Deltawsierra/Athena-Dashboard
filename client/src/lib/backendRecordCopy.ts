/**
 * What the scan pages, the Tests screen and the Clients page say about
 * Athena-Backend's record of a scan started through it (the Option 1 hybrid,
 * plan section 11 and 14), in one place so the screens cannot drift, and so a
 * test holds every string to the persona lint (shared/persona-lint.ts).
 *
 * The record has three states and the words say exactly which one the page is
 * in: not asked yet, being collected, collected. A record not yet collected is
 * never a verdict; a run that did not finish has none, and says so in the one
 * pinned sentence. The backend's own words -- its verdict label, its error
 * message, its status word -- are shown verbatim and are not authored here.
 * Labels are by SOURCE: never "legacy", never a promise about the backend.
 */

/** The panel's heading on both scan pages. */
export const BACKEND_RECORD_TITLE = "Backend record";

/** collected: null -- the run has not been seen to end, so the backend has not been asked. */
export const NOT_YET_IN_RECORD = "Not yet in the Athena-Backend record for this run.";

/** collected: false, watch running -- asked, not answered with the record yet. */
export const COLLECTING = "Athena-Backend is collecting this run's record.";

/** collected: false, watch unwatched -- this dashboard stopped asking at its deadline. */
export const NO_LONGER_ASKED =
  "This dashboard stopped asking Athena-Backend for this run's record; the backend's own collector records the run's end.";

/** A collected record of a run that was stopped or failed: no verdict, and never one derived here. */
export const NO_VERDICT_DID_NOT_FINISH = "No verdict: the run did not finish.";

/** A collected record whose verdict the backend served none for, although the run completed. */
export const NO_VERDICT_SERVED = "No verdict: the record carries none.";

/** The Stop's mirror reading (plan section 14). */
export const MIRRORED = "Stop mirrored to the backend record.";
export const NOT_MIRRORED = "Stop not mirrored to the backend record.";

/** When the record's bytes differ from what this dashboard read directly from the engine: the record's are shown. */
export const DIFFERS_FROM_DIRECT =
  "The record's results or coverage differ from what this dashboard read directly from the engine; the record's are shown.";

/** The link to the record's report, relayed as the person; shown only when the record has one. */
export const PDF_LINK = "Report (PDF) from the Athena-Backend record";

/** The Tests screen's pill for a hybrid row whose record is not collected yet. */
export const RECORD_PENDING_PILL = "Backend record: pending";

/** The Tests screen's pill for a collected record: the backend's verdict label, or its status word for a run that did not finish. */
export function recordPill(label: string): string {
  return `Backend record: ${label}`;
}

/** The engagement line beneath the record (plan section 14): "Backend engagement #<id> · deployment <name> · <host>". */
export function engagementLine(id: number | null, name: string | null, host: string | null): string {
  const parts = [`Backend engagement #${id ?? "?"}`, `deployment ${name ?? "unnamed"}`];
  if (host) parts.push(host);
  return parts.join(" · ");
}

/** The Clients page: a client with no backend engagement on record. */
export const NO_ENGAGEMENT_YET = "No backend engagement yet; one is created the first time a scan starts for this client.";

/** The Clients page: a client whose testing window is not set. */
export const NO_WINDOW_YET = "No testing window set; the first scan records one of 90 days from then.";

/** The Clients page: the renew action and its confirm step. Never automatic. */
export const RENEW_ACTION = "Renew / extend";
export const RENEW_CONFIRM_TITLE = "Renew the testing window";
export const RENEW_CONFIRM_BODY =
  "The window is set to 90 days from now, here and on the client's Athena-Backend engagement, in your name. " +
  "This is a person's act: it is never renewed on its own.";
export const RENEW_CONFIRM_ACTION = "Renew for 90 days";

/** The Clients page: the block's heading and its one source line. */
export const ENGAGEMENTS_TITLE = "Backend engagements";
export const ENGAGEMENTS_SOURCE =
  "The engagement id and the testing window are this dashboard's record of what it created or renewed at " +
  "Athena-Backend; the engagement's name, status and scope are read from Athena-Backend when asked.";

/** The Clients page: the on-demand read of the backend's engagement. */
export const READ_ENGAGEMENT = "Read from Athena-Backend";

/**
 * A scan adopted from the Athena-Backend record (server/backend-adoption.ts)
 * whose engagement no client here names: wherever a row's client is shown.
 * No client is made up for it.
 */
export const NOT_LINKED_TO_CLIENT = "Not linked to a dashboard client";

/** Beside such a row on the Tests screen and in Scans running now: where it came from, by source. */
export const ADOPTED_FROM_RECORD = "Adopted from the Athena-Backend record; not started from this dashboard";

// ==== The Engagements page (client/src/pages/Engagements.tsx) ====
//
// Athena-Backend's record of the engagements the person can see, read as them
// when the page loads (GET /api/record/engagements). Every count is drawn from
// the rows the list carries, never from silence: a list that could not be read
// shows the reason and no figure, and "no scans recorded" is said only of a
// list read whole. The backend's own words -- a status, a verdict label, an
// error message, a decision label -- are shown as served and not authored here.

export const ENGAGEMENTS_PAGE_TITLE = "Engagements";
export const ENGAGEMENTS_PAGE_SUBTITLE =
  "Athena-Backend's record of the engagements you can see: each one's scans, testing window and deployments, read as you when this page loads.";
/** The one source line under the hero. */
export const ENGAGEMENTS_PAGE_SOURCE =
  "Every figure on this page is read from the Athena-Backend record. A scan this dashboard recorded directly from the engine " +
  "is not in that record; the Tests page lists it by its source.";
/** The server's reason backend_sign_in_required: the record is read as the person, or not at all. */
export const RECORD_NEEDS_SIGN_IN =
  "Sign in to Athena-Backend to read its record: this page reads it as you, and nothing is shown from a record that was not read.";
/** Any other failed read: the prefix, then the server's words. */
export const RECORD_COULD_NOT_BE_READ = "The record could not be read";
export const RECORD_READING = "Reading the Athena-Backend record…";
/** A record read whole that lists no engagement for the person. */
export const NO_ENGAGEMENTS = "Athena-Backend lists no engagement you can see.";
/** The scans list read whole, with no row under this engagement: a measurement, said as one. */
export const NO_SCANS_RECORDED = "No scans recorded for this engagement.";
/** The scans list could not be read: no count is drawn, and the reason is shown. */
export const SCANS_COULD_NOT_BE_READ = "The record's scans could not be read";
export const NO_DEPLOYMENTS = "No deployments ingested under this engagement.";
export const DEPLOYMENTS_COULD_NOT_BE_READ = "The record's deployments could not be read";
/** The testing window, by the record's dates. */
export const WINDOW_ENDED = "Window ended";
export const WINDOW_NOT_RECORDED = "No testing window recorded";
export function windowRemaining(days: number): string {
  return days === 1 ? "1 day remaining" : `${days} days remaining`;
}
export const SCOPE_NONE = "No scope hosts recorded";
/** A pending scan the engine has not named a run for: nothing here can poll or stop it yet. */
export const LAUNCH_ANSWER_AWAITED = "The launch's answer is still awaited: the engine has not named this scan's run.";
/** A record of a run that ended short of completed, with the backend's error_message. */
export function stoppedOnEngine(detail: string | null): string {
  return `Stopped on the engine: ${detail && detail.trim() !== "" ? detail : "no detail recorded"}`;
}
export function failedOnEngine(detail: string | null): string {
  return `Failed on the engine: ${detail && detail.trim() !== "" ? detail : "no detail recorded"}`;
}
/** The backend's reading of a Stop asked of it for the scan (owed, delivered), as served. */
export function stopAskedReading(state: string): string {
  return `Stop asked of the backend: ${state}`;
}
export const OPEN_SCAN = "Open scan";
export const OPEN_DEPLOYMENT = "Open in Assurance";
/** A completed scan whose report the record lists, before the sync has given it a row here: the relay goes through the row. */
export const REPORT_AFTER_ADOPTION = "Report in the record; its link appears once this scan is adopted into the dashboard.";
export const LINKED_CLIENT = "Dashboard client";
/** Scans the list carries under an engagement the engagements list does not show. */
export const SCANS_UNDER_NO_ENGAGEMENT_SHOWN = "Scans the record lists under no engagement shown here";
/**
 * The adoption sync's outcome on this load (POST /api/record/adopt), said from
 * the answer's own fields and never from silence: a scan the record lists that
 * has no row here yet -- awaiting the launch's answer, a finished scan whose
 * detail could not be read now, the scans after a row that could not be
 * written, the candidates left for the next sync -- is said as such, and
 * "every scan has its row" only when none of those stands.
 */
export interface AdoptionOutcomeView {
  adopted: number;
  remaining: number;
  awaitingRun: number;
  detailUnread: number;
  writeFailed: string | null;
}
export const ADOPTION_EVERY_ROW = "Every scan the record lists has its row in this dashboard.";
export const ADOPTION_NONE_THIS_SYNC = "No scan was adopted this sync.";
export function adoptedCountLine(adopted: number): string {
  return `Adopted ${adopted} scan${adopted === 1 ? "" : "s"} from the record into this dashboard.`;
}
export function awaitingRunLine(count: number): string {
  return count === 1
    ? "1 scan awaits the launch's answer and has no row here yet."
    : `${count} scans await the launch's answer and have no row here yet.`;
}
export function detailUnreadLine(count: number): string {
  return count === 1
    ? "1 finished scan could not be read now; it is adopted whole on the next sync."
    : `${count} finished scans could not be read now; each is adopted whole on the next sync.`;
}
export function writeFailedLine(reason: string): string {
  return `A row could not be written: ${reason}; the scans after it wait for the next sync.`;
}
export function remainingLine(count: number): string {
  return `${count} more await the next sync.`;
}
export function adoptionOutcomeLine(outcome: AdoptionOutcomeView): string {
  const { adopted, remaining, awaitingRun, detailUnread, writeFailed } = outcome;
  if (adopted === 0 && remaining === 0 && awaitingRun === 0 && detailUnread === 0 && writeFailed === null) return ADOPTION_EVERY_ROW;
  const parts = [adopted > 0 ? adoptedCountLine(adopted) : ADOPTION_NONE_THIS_SYNC];
  if (awaitingRun > 0) parts.push(awaitingRunLine(awaitingRun));
  if (detailUnread > 0) parts.push(detailUnreadLine(detailUnread));
  if (writeFailed !== null) parts.push(writeFailedLine(writeFailed));
  if (remaining > 0) parts.push(remainingLine(remaining));
  return parts.join(" ");
}
/** The sync's answer did not carry a field this page reads: said as unread, never read as zero. */
export function syncAnswerMissing(field: string): string {
  return `the sync's answer did not say ${field}`;
}
export const ADOPTION_COULD_NOT_BE_READ = "The adoption sync could not be read";
export const ADOPTION_SYNCING = "Adopting the record's scans into this dashboard…";
/** A sync within the server's interval of the last: answered from that one, and said so. */
export const ADOPTION_RECENT = "Synced with the record moments ago; the next load syncs again.";
/** Counts drawn from the list's rows, by the backend's status words and verdict labels. */
export function scanCountsLine(total: number, byWord: Array<[string, number]>): string {
  const head = `${total} scan${total === 1 ? "" : "s"} in the record`;
  return byWord.length === 0 ? head : `${head} · ${byWord.map(([word, count]) => `${word} ${count}`).join(" · ")}`;
}
export function verdictCountsLine(byLabel: Array<[string, number]>): string {
  return byLabel.length === 0 ? "No verdict in the record yet." : `Verdicts · ${byLabel.map(([label, count]) => `${label} ${count}`).join(" · ")}`;
}
/** A deployment's coverage manifest, by the backend's word and figures (GET /api/assurance/deployments/:uuid/coverage-manifest). */
export function manifestLine(verdict: string, assessed: number, expected: number): string {
  return `Coverage manifest: ${verdict} · ${assessed} of ${expected} expected assessed`;
}
export const MANIFEST_COULD_NOT_BE_READ = "The coverage manifest could not be read";
export const MANIFEST_READING = "Reading the coverage manifest…";
export function findingsInRecord(count: number): string {
  return `${count} finding${count === 1 ? "" : "s"} in the record`;
}
export const SHOW_DETAIL = "Show scans and deployments";
export const HIDE_DETAIL = "Hide scans and deployments";
/** The page's section and field labels. */
export const LINKED_SECTION = "Linked to a dashboard client";
export const SCANS_SECTION = "Scans in the record";
export const DEPLOYMENTS_SECTION = "Deployments ingested under it";
export const SCOPE_LABEL = "Scope hosts";
export const WINDOW_LABEL = "Testing window";
export const RUNNING_NOW_LABEL = "Running now";
export const RUNNING_NOW_SUBLABEL = "pending in the record, with a run the engine named";
export const NO_REASON_GIVEN = "no reason given";
export function engagementRef(id: number): string {
  return `Backend engagement #${id}`;
}
export function engineRunRef(id: string): string {
  return `engine run ${id}`;
}
export function collectedLine(when: string): string {
  return `collected ${when}`;
}
export function readAtLine(when: string): string {
  return `Read from Athena-Backend at ${when}.`;
}

/** Every authored string above, for the lint test (tests/the-backend-record-copy-lints-clean-and-names-its-source.test.ts). */
export function allBackendRecordStrings(): string[] {
  return [
    BACKEND_RECORD_TITLE,
    NOT_YET_IN_RECORD,
    COLLECTING,
    NO_LONGER_ASKED,
    NO_VERDICT_DID_NOT_FINISH,
    NO_VERDICT_SERVED,
    MIRRORED,
    NOT_MIRRORED,
    DIFFERS_FROM_DIRECT,
    PDF_LINK,
    RECORD_PENDING_PILL,
    recordPill("Ready"),
    engagementLine(7, "Acme shop", "acme.example"),
    NO_ENGAGEMENT_YET,
    NO_WINDOW_YET,
    RENEW_ACTION,
    RENEW_CONFIRM_TITLE,
    RENEW_CONFIRM_BODY,
    RENEW_CONFIRM_ACTION,
    ENGAGEMENTS_TITLE,
    ENGAGEMENTS_SOURCE,
    READ_ENGAGEMENT,
    NOT_LINKED_TO_CLIENT,
    ADOPTED_FROM_RECORD,
    ENGAGEMENTS_PAGE_TITLE,
    ENGAGEMENTS_PAGE_SUBTITLE,
    ENGAGEMENTS_PAGE_SOURCE,
    RECORD_NEEDS_SIGN_IN,
    RECORD_COULD_NOT_BE_READ,
    RECORD_READING,
    NO_ENGAGEMENTS,
    NO_SCANS_RECORDED,
    SCANS_COULD_NOT_BE_READ,
    NO_DEPLOYMENTS,
    DEPLOYMENTS_COULD_NOT_BE_READ,
    WINDOW_ENDED,
    WINDOW_NOT_RECORDED,
    windowRemaining(1),
    windowRemaining(12),
    SCOPE_NONE,
    LAUNCH_ANSWER_AWAITED,
    stoppedOnEngine("stopped by an operator"),
    stoppedOnEngine(null),
    failedOnEngine("the engine reported an error"),
    failedOnEngine(""),
    stopAskedReading("owed"),
    OPEN_SCAN,
    OPEN_DEPLOYMENT,
    REPORT_AFTER_ADOPTION,
    LINKED_CLIENT,
    SCANS_UNDER_NO_ENGAGEMENT_SHOWN,
    ADOPTION_EVERY_ROW,
    ADOPTION_NONE_THIS_SYNC,
    adoptedCountLine(1),
    adoptedCountLine(3),
    awaitingRunLine(1),
    awaitingRunLine(2),
    detailUnreadLine(1),
    detailUnreadLine(4),
    writeFailedLine("the database is locked"),
    remainingLine(3),
    adoptionOutcomeLine({ adopted: 2, remaining: 3, awaitingRun: 1, detailUnread: 1, writeFailed: "the database is locked" }),
    adoptionOutcomeLine({ adopted: 0, remaining: 0, awaitingRun: 1, detailUnread: 0, writeFailed: null }),
    syncAnswerMissing("how many scans await the launch's answer"),
    ADOPTION_COULD_NOT_BE_READ,
    ADOPTION_SYNCING,
    ADOPTION_RECENT,
    scanCountsLine(0, []),
    scanCountsLine(3, [["pending", 2], ["completed", 1]]),
    verdictCountsLine([]),
    verdictCountsLine([["Requires remediation", 1]]),
    manifestLine("complete", 4, 4),
    MANIFEST_COULD_NOT_BE_READ,
    MANIFEST_READING,
    findingsInRecord(1),
    findingsInRecord(2),
    SHOW_DETAIL,
    HIDE_DETAIL,
    LINKED_SECTION,
    SCANS_SECTION,
    DEPLOYMENTS_SECTION,
    SCOPE_LABEL,
    WINDOW_LABEL,
    RUNNING_NOW_LABEL,
    RUNNING_NOW_SUBLABEL,
    NO_REASON_GIVEN,
    engagementRef(7),
    engineRunRef("run-1"),
    collectedLine("—"),
    readAtLine("2026-10-23"),
  ];
}
