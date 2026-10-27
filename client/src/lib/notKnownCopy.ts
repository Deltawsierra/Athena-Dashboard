/**
 * What the screens say about a scan whose run the engine does not know -- its
 * reads answered 404 "No such scan run" for a while (server/routes.ts
 * notKnown: the answer's `engineKnowsRun: false`, the row's `findings.notKnown`)
 * -- and about a person's act that recorded it so (POST
 * /api/scans/:testId/record-not-known: status `not_known`, shared/engine-record.ts
 * NOT_KNOWN_STATUS). In one place so the scan pages, the Tests screen and the
 * Overview cannot drift, and so a test holds every string to the persona lint
 * (tests/not-known-copy-lints-clean.test.ts).
 *
 * State language only: the engine does not know the run. Never an end the
 * engine did not state -- the reading says the status is unchanged, and the
 * run may still be running -- never a result, and never a verdict about the
 * target. The engine's own words are shown verbatim and are not authored here.
 */

/** The label: the Tests screen's filter option and badge, the panel's heading. */
export const NOT_KNOWN_LABEL = "Not known to the engine";

/** The reading, beside the Stop: since when, what may be so, and what reaches the run. `since` is the time, as shown. */
export function notKnownSince(since: string): string {
  return `Not known to the engine since ${since}: it may still be running under another id. Stop sends the stop again; ` +
    "the kill switch on the AI Control page sends it a stop by id.";
}

/** Before the engine's own words, verbatim. */
export const ENGINE_WORDS = "The engine's words:";

/** The reading changes no status. */
export const STATUS_UNCHANGED = "Its status is unchanged: the engine has not said it ended.";

/** The person's act: an admin's, behind a confirm step. */
export const RECORD_ACTION = "Record as not known to the engine";
export const RECORD_ACTION_PENDING = "Sending the stop…";
export const RECORD_CONFIRM_TITLE = "Record this scan as not known to the engine";
export const RECORD_CONFIRM_BODY =
  "A stop is sent to the run first. Only if the engine answers that it does not know the run is this scan recorded " +
  "as not known to the engine, in your name, with the engine's words; otherwise nothing is recorded. This is a " +
  "person's act: nothing records it on its own.";
export const RECORD_CONFIRM_ACTION = "Send the stop, then record";
/** Said to anyone who may not record it: who can, and what that does. */
export const ASK_AN_ADMIN =
  "An admin can record it as not known to the engine: a stop is sent first, and it is recorded only if the engine " +
  "answers that it does not know the run.";

/** What the act came to. */
export const RECORDED_TITLE = "Recorded as not known to the engine";
export const RECORDED_BODY = "The engine answered the stop that it does not know this run.";
export const ALREADY_RECORDED = "This scan was already recorded as not known to the engine; nothing was sent.";
export const NOT_RECORDED_TITLE = "Not recorded";

/** A recorded row: who recorded it, and when (as shown). */
export function recordedBy(who: string | null, at: string): string {
  return `Recorded as not known to the engine by ${who ?? "a person whose name was not recorded"} at ${at}.`;
}

/** The Risk band's basis for a recorded row, beneath "Not assessed" (lib/scanSummaryCopy.ts NOT_ASSESSED). */
export const NOT_KNOWN_BASIS = "The engine does not know this run, so no result and no band is derived from it.";

/** The Tests screen's note beside a row whose reading stands (its status unchanged). `since` as shown. */
export function readingNote(since: string): string {
  return `Not known to the engine since ${since}; its status is unchanged, and its Stop is sent as before.`;
}

/** The Overview's own figure beside the scans on record: never summed with any other. */
export function notKnownCount(count: number): string {
  return `${count} not known to the engine`;
}

/** Every authored string above, for the lint test. */
export function allNotKnownStrings(): string[] {
  return [
    NOT_KNOWN_LABEL,
    notKnownSince("27/10/2026, 10:00:00"),
    ENGINE_WORDS,
    STATUS_UNCHANGED,
    RECORD_ACTION,
    RECORD_ACTION_PENDING,
    RECORD_CONFIRM_TITLE,
    RECORD_CONFIRM_BODY,
    RECORD_CONFIRM_ACTION,
    ASK_AN_ADMIN,
    RECORDED_TITLE,
    RECORDED_BODY,
    ALREADY_RECORDED,
    NOT_RECORDED_TITLE,
    recordedBy("admin", "27/10/2026, 10:00:00"),
    recordedBy(null, "27/10/2026, 10:00:00"),
    NOT_KNOWN_BASIS,
    readingNote("27/10/2026, 10:00:00"),
    notKnownCount(1),
    notKnownCount(3),
  ];
}
