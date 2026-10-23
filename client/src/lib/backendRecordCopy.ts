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
  ];
}
