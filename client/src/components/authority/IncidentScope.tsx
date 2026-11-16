/**
 * An incident's scope on the recovery screen (SPINE SP-3): what is believed affected,
 * every revision of it, and what about it keeps a recovery step back.
 *
 * Athena-Backend keeps the scope as numbered revisions and ties each recovery step to
 * the revision it was taken under (shared/incident-scope.ts). Three things are drawn:
 *
 *   - on the incident (IncidentScopeSummary), from the recovery record itself: the
 *     current revision's number and every item a revision added and a later one
 *     removed, with who removed it and why;
 *   - on each step (StepScopeFacts), from the record too: the revision it was taken
 *     under, each thing about the scope that keeps it back now -- the item it is for
 *     and why -- what its scope gained and lost, and what its row recorded. A step
 *     taken under an earlier revision that a later one widened says so in words, and
 *     names the later revision and each added item;
 *   - on demand (ScopeHistory), from the scope's own read
 *     (GET /api/assurance/findings/<id>/scope-revisions through this console's server):
 *     who declared the current revision, why and when, its items by kind, and every
 *     revision newest first with what each added and removed.
 *
 * NOT KNOWN IS SAID AS NOT KNOWN. A list the backend served as null cannot be
 * established (no scope is declared, or a revision cannot be read): it reads "Not
 * known", with the backend's own reason beside it (`scope:not_declared`,
 * `scope:unreadable`), never as "none" and never as an empty list. A block the backend
 * did not serve at all reads "not reported by this backend", which is not "no scope".
 * "Nothing" is said only of a list that was served, read whole, and is empty. A row
 * that could not be read is counted beside its list (parts.tsx UnreadableRows).
 *
 * A kind of item this console does not know is drawn as an unknown kind with the value
 * served, never dropped. Every string here came from the backend's record and is drawn
 * as text by the app's own runtime, which marks any character that hides or reorders
 * text (lib/hiddenChars.ts).
 *
 * OFF THE STOP PATH. Nothing here writes, and nothing else waits on the scope read:
 * the record is drawn without it. The read starts only when a person opens it, only
 * one incident's scope is open at a time (opening another closes the first, which
 * cancels its read), a closed or left view cancels it (lib/queryClient.ts), and this
 * console's server cuts it at the read deadline (server/read-deadline.ts). So scope
 * reads never keep more than one of the browser's few connections, whatever the
 * backend does with them. Every Stop and the failsafe console are elsewhere and read
 * none of this.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  SCOPE_NOT_DECLARED,
  SCOPE_UNREADABLE,
  type FindingScope,
  type IncidentScope,
  type ScopeAddedItem,
  type ScopeEvidence,
  type ScopeItem,
  type ScopeItemRef,
  type ScopeLink,
  type ScopeRemovedItem,
  type ScopeRevision,
  type StepScope,
} from "@shared/incident-scope";
import type { RecoveryIncident, RecoveryStep } from "@shared/recovery-record";
import { ApiError } from "@/lib/queryClient";
import { Absent, Chip, Fact, NotInHand, NotServed, UnreadableRows, When, notAListIn, served, unreadableIn } from "./parts";
import { OnDemand, answeredFor } from "./history";

// ---- the words ----

/** The kinds of item a scope names, in the order they are listed. Any other kind is drawn as unknown, with its value. */
const KINDS: ReadonlyArray<readonly [string, { one: string; many: string }]> = [
  ["asset", { one: "asset", many: "Assets" }],
  ["workflow", { one: "workflow", many: "Workflows" }],
  ["route", { one: "route", many: "Routes" }],
  ["identity", { one: "identity", many: "Identities" }],
];
const KIND_WORDS = new Map(KINDS);

/** Whether this console knows a kind of item by name. */
export function knownKind(kind: string | null): boolean {
  return kind !== null && KIND_WORDS.has(kind);
}

/** A kind of item as one of it is named: its own word, or that it is not one known here, with the value served. */
export function kindInWords(kind: string | null): string {
  if (kind === null) return "item of no kind served";
  return KIND_WORDS.get(kind)?.one ?? `item of an unknown kind (${kind})`;
}

/** What each of the backend's two reasons for "not known" says. */
const REASONS: ReadonlyArray<readonly [string, string]> = [
  [SCOPE_NOT_DECLARED, "no scope revision is on record"],
  [SCOPE_UNREADABLE, "a revision of the scope cannot be read"],
];

/** The reasons for "not known" the backend gave among `gaps`, in its own names. */
export function reasonsAmong(gaps: ReadonlyArray<string> | null | undefined): string[] {
  if (!gaps) return [];
  return REASONS.map(([code]) => code).filter((code) => gaps.includes(code));
}

/** Every reason for "not known" any step of an incident gives. */
export function reasonsOf(incident: RecoveryIncident): string[] {
  return reasonsAmong(incident.steps.flatMap((step) => step.scope?.gaps ?? []));
}

/** What a scope gap says, read from the backend's name for it. */
export type ScopeGap =
  | { is: "not_declared" }
  | { is: "unreadable" }
  | { is: "added"; revision: number; kind: string; ref: string }
  | { is: "other" };

const ADDED_GAP = /^scope:revision:(\d+):added:([^:]*):([\s\S]*)$/;

/** A gap the backend names `scope:...`, read; null for a gap that is not about the scope. */
export function readScopeGap(gap: string): ScopeGap | null {
  if (!gap.startsWith("scope:")) return null;
  if (gap === SCOPE_NOT_DECLARED) return { is: "not_declared" };
  if (gap === SCOPE_UNREADABLE) return { is: "unreadable" };
  const added = ADDED_GAP.exec(gap);
  if (added) return { is: "added", revision: Number(added[1]), kind: added[2], ref: added[3] };
  return { is: "other" };
}

/**
 * A scope gap in words, for the step's list of gaps: no declared scope, a revision that
 * cannot be read, or an item a revision added that the step does not cover. One this
 * console does not know is shown as served. null for a gap that is not about the scope.
 */
export function scopeGapInWords(gap: string): string | null {
  const read = readScopeGap(gap);
  if (read === null) return null;
  if (read.is === "not_declared") return "Scope gap: no scope revision is on record for this step, so what it covers is not known";
  if (read.is === "unreadable") return "Scope gap: a revision of this incident's scope cannot be read, so what is in scope is not known";
  if (read.is === "added") {
    return `Scope gap: revision ${read.revision} added ${kindInWords(read.kind)} ${read.ref} to the scope, and this step does not cover it`;
  }
  return `Scope gap not recognised here: ${gap}`;
}

/** What a link that names an added item says of it, by the link's kind. A kind not known here is shown as served. */
const LINK_WORDS = new Map([
  ["evidence", "evidence of a finding on it"],
  ["permit", "a gate permit of it"],
  ["coverage", "a coverage observation of it (looked at in full, nothing found)"],
]);

// ---- small pieces ----

function Heading({ children }: { children: string }) {
  return <p className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>;
}

/** The backend's reason for a "not known", in words with its own name beside; or that it gave none. */
function Why({ reasons, none = "The backend gives no reason." }: { reasons: string[]; none?: string }) {
  if (reasons.length === 0) return <span data-testid="scope-no-reason"> {none}</span>;
  return (
    <span data-testid="scope-reason">
      {" "}The backend&apos;s reason:{" "}
      {reasons.map((code, index) => (
        <span key={code} data-scope-reason={code}>
          {index > 0 ? "; " : ""}
          {REASONS.find(([known]) => known === code)?.[1] ?? "one this console does not know"} (<code className="font-mono text-[11px]">{code}</code>)
        </span>
      ))}
      .
    </span>
  );
}

/** One item, by its kind and reference as served. An unknown kind is named as unknown, never dropped. */
function ItemName({ item, assetKind }: { item: ScopeItemRef; assetKind?: string | null }) {
  return (
    <span data-testid="scope-item" data-item-kind={item.kind ?? ""} data-kind-known={knownKind(item.kind) ? "true" : "false"}>
      <span className={knownKind(item.kind) ? "text-muted-foreground" : "text-amber-400"}>{kindInWords(item.kind)}</span>{" "}
      <code className="break-all font-mono text-[11px] text-foreground/90">{item.ref ?? "no reference served"}</code>
      {assetKind ? <span className="break-all text-muted-foreground"> ({assetKind})</span> : null}
    </span>
  );
}

type Counted = { unreadable?: Record<string, number | string> };

/**
 * One of the scope's lists, said as what it is: not known (null), not a list (it could
 * not be read), nothing (served, read whole and empty), or its rows -- with the count
 * of any row that could not be read beside them. "Nothing" is never said of a list
 * with a row that could not be read.
 */
function Listed<T>({ rows, from, list, label, notKnown, none, testId, children }: {
  rows: T[] | null;
  /** What holds this list's `unreadable` count. */
  from: Counted;
  list: string;
  /** The list's name in "N rows could not be read: ...". */
  label: string;
  notKnown: ReactNode;
  none: string;
  testId: string;
  children: (row: T, index: number) => ReactNode;
}) {
  if (rows === null) {
    return (
      <p className="text-[12px]" data-testid={`${testId}-not-known`}>
        <Absent>{notKnown}</Absent>
      </p>
    );
  }
  const unread = unreadableIn(from, list);
  return (
    <div className="space-y-1" data-testid={testId} data-row-count={rows.length} data-unread-count={notAListIn(from, list) ? "unknown" : unread}>
      {rows.length === 0 && unread === 0 && <p className="text-[12px] text-muted-foreground">{none}</p>}
      {rows.length > 0 && (
        <ul className="space-y-1">
          {rows.map((row, index) => (
            <li key={index} className="text-[12px]">
              {children(row, index)}
            </li>
          ))}
        </ul>
      )}
      <UnreadableRows from={from} list={list} label={label} />
    </div>
  );
}

/** One removed item: both revisions, who removed it and why. */
function RemovedItem({ item }: { item: ScopeRemovedItem }) {
  return (
    <span data-testid="scope-removed-item" data-removed-ref={item.ref ?? ""}>
      <ItemName item={item} />
      <span className="text-muted-foreground">
        {" "}-- added by {item.added === null ? "a revision not named" : `revision ${item.added}`}, removed by{" "}
        {item.removed === null ? "a revision not named" : `revision ${item.removed}`}; removed by{" "}
      </span>
      <span className="break-all text-foreground" data-testid="removed-by">
        {item.removedBy ?? <Absent>nobody on record</Absent>}
      </span>
      <span className="text-muted-foreground">; why: </span>
      <span className="break-words text-foreground" data-testid="removed-why">
        {item.reason ?? <Absent>no reason on record</Absent>}
      </span>
    </span>
  );
}

/** Every item a revision added and a later one removed. Never silent: not known, nothing, or each with who and why. */
function RemovedItems({ rows, from, reasons, testId, of }: {
  rows: ScopeRemovedItem[] | null;
  from: Counted;
  reasons: string[];
  testId: string;
  /** Whose scope: "this incident's scope" or "this step's scope". */
  of: string;
}) {
  return (
    <Listed
      rows={rows}
      from={from}
      list="removed"
      label="removed items"
      testId={testId}
      notKnown={
        <>
          Not known: what {of} has lost cannot be established.
          <Why reasons={reasons} />
        </>
      }
      none={`No item a later revision added to ${of} has been removed since. A removal of an item of the first revision is not listed on the record: it is among the scope's revisions.`}
    >
      {(item) => <RemovedItem item={item} />}
    </Listed>
  );
}

// ---- one scope open at a time ----

const OpenScope = createContext<{ open: string | null; set: (key: string | null) => void } | null>(null);

/**
 * Holds which incident's scope is open: one at a time. Opening another closes the
 * first, and a closed scope's read is cancelled, so the scope reads of one screen never
 * keep more than one of the browser's connections.
 */
export function OneScopeAtATime({ children }: { children: ReactNode }) {
  const [open, set] = useState<string | null>(null);
  return <OpenScope.Provider value={{ open, set }}>{children}</OpenScope.Provider>;
}

function useScopeOpen(key: string): [boolean, (open: boolean) => void] {
  const shared = useContext(OpenScope);
  const [own, setOwn] = useState(false);
  if (shared === null) return [own, setOwn];
  return [shared.open === key, (open) => shared.set(open ? key : null)];
}

// ---- on the incident ----

/** A finding id as this screen will put it in a read's path (Authority.tsx holds ?finding= to the same rule). */
const FINDING_ID = /^[0-9A-Za-z][0-9A-Za-z_-]*$/;

/** The incident's scope as its recovery record states it, and its revisions on demand. */
export function IncidentScopeSummary({ incident, deployment }: { incident: RecoveryIncident; deployment: string }) {
  const scope = incident.scope;
  const key = incident.finding ?? "";
  const [open, setOpen] = useScopeOpen(key);
  if (scope === undefined) {
    return (
      <div className="space-y-1" data-testid="incident-scope" data-scope-reported="false">
        <p className="text-[12px] text-muted-foreground">Scope</p>
        <NotServed testId="scope-not-reported">
          The scope is not reported by this backend. This answer carries none of the fields Athena-Backend serves an
          incident&apos;s scope in, as a backend from before it versioned the scope does. That is not an incident without a
          scope: whether one is declared, what it names, and whether it has changed since a step was taken are not known here.
        </NotServed>
      </div>
    );
  }
  const reasons = reasonsOf(incident);
  const readable = incident.finding !== null && FINDING_ID.test(incident.finding);
  return (
    <div className="space-y-2" data-testid="incident-scope" data-scope-reported="true" data-scope-revision={scope.revision ?? ""}>
      <p className="text-[12px] text-muted-foreground">Scope</p>
      <Fact label="Current scope">
        {scope.revision === null ? (
          <Absent testId="scope-current-none">
            No scope is declared for this incident, so what its recovery covers is not known.
            <Why reasons={reasons} none="No step of this record names the reason." />
          </Absent>
        ) : (
          <span className="font-mono text-foreground" data-testid="scope-current">{`revision ${scope.revision}`}</span>
        )}
      </Fact>
      <Heading>Items added and later removed</Heading>
      <RemovedItems rows={scope.removed} from={scope} reasons={reasons} testId="scope-removed" of="this incident's scope" />
      {readable ? (
        <OnDemand
          label="this incident's scope: who declared it, why and when, its items, and every revision, newest first"
          testId="incident-scope-revisions"
          open={open}
          onToggle={setOpen}
        >
          {() => <ScopeHistory deployment={deployment} finding={incident.finding as string} reasons={reasons} />}
        </OnDemand>
      ) : (
        <Absent testId="scope-revisions-unreadable-id">
          This record names no finding id Athena-Backend issues, so the revisions of its scope are not read.
        </Absent>
      )}
    </div>
  );
}

// ---- on a step ----

/** How a step stands against the scope: kept back, not known, nothing named, or not reported at all. */
export type ScopeStanding = "kept_back" | "not_known" | "none_named" | "not_reported";

/**
 * How a step stands against the scope, from what the backend served. Only a list of
 * scope gaps that was served, read whole and is empty names nothing: a list not served,
 * not a list, or with a row that could not be read is not known, never nothing.
 */
export function scopeStanding(step: RecoveryStep): ScopeStanding {
  const scope = step.scope;
  if (scope === undefined) return "not_reported";
  if (scope.gaps === null) return "not_known";
  if (scope.gaps.length > 0) return "kept_back";
  return unreadableIn(scope, "gaps") > 0 ? "not_known" : "none_named";
}

/** The revisions later than the step's own that added an item, each with the items it added, in the order served. */
function widenedBy(scope: StepScope): Array<{ revision: number; items: ScopeItemRef[] }> {
  if (scope.gaps === null || scope.revision === null) return [];
  const later: Array<{ revision: number; items: ScopeItemRef[] }> = [];
  for (const gap of scope.gaps) {
    const read = readScopeGap(gap);
    if (read === null || read.is !== "added" || !(read.revision > scope.revision)) continue;
    const held = later.find((one) => one.revision === read.revision);
    if (held) held.items.push({ kind: read.kind, ref: read.ref });
    else later.push({ revision: read.revision, items: [{ kind: read.kind, ref: read.ref }] });
  }
  return later;
}

/** One thing about the scope that keeps a step back: the item it is for, and why. */
function KeptBackBy({ gap, taken }: { gap: string; taken: number | null }) {
  const read = readScopeGap(gap);
  return (
    <span data-testid="scope-gap" data-scope-gap={gap}>
      <span className="text-amber-400" data-testid="scope-gap-words">
        {read === null || read.is === "other" ? (
          "Not recognised here, shown as the backend names it"
        ) : read.is === "not_declared" ? (
          "No scope revision is on record for this step, so what it covers is not known"
        ) : read.is === "unreadable" ? (
          "A revision of this incident's scope cannot be read, so what is in scope is not known"
        ) : (
          <>
            <ItemName item={{ kind: read.kind, ref: read.ref }} />
            {taken !== null && read.revision > taken
              ? `: revision ${read.revision} added it to the scope after this step was taken under revision ${taken}`
              : `: revision ${read.revision} added it to the scope, and nothing this step rests on names it`}
          </>
        )}
      </span>{" "}
      <code className="break-all font-mono text-[11px] text-muted-foreground">{gap}</code>
    </span>
  );
}

/** The links of a step that name an added item, each by its kind; or that nothing names it. */
function NamedBy({ links }: { links: ScopeLink[] | null }) {
  if (links === null) return <Absent>what names it was not served</Absent>;
  if (links.length === 0) {
    return (
      <span className="text-amber-400" data-testid="added-open">
        nothing this step rests on names it: an open gap
      </span>
    );
  }
  return (
    <span className="text-muted-foreground" data-testid="added-named-by">
      named by{" "}
      {links.map((link, index) => (
        <span key={index} data-link-kind={link.kind ?? ""}>
          {index > 0 ? "; " : ""}
          {link.kind === null ? "a link of no kind served" : LINK_WORDS.get(link.kind) ?? `a link of an unknown kind (${link.kind})`}{" "}
          <code className="break-all font-mono text-[11px]">{link.ref ?? "no reference served"}</code>
        </span>
      ))}
    </span>
  );
}

/**
 * What a step says of the scope it was taken under: the revision, each thing about the
 * scope that keeps it back now, whether a later revision widened the scope after it,
 * what its row recorded, and what its scope gained and lost. `releaseInWords` is the
 * recovery screen's own reading of a release word, so the recorded one is said in the
 * same words as the step's.
 */
export function StepScopeFacts({ step, incident, releaseInWords }: {
  step: RecoveryStep;
  /** The incident's own scope block, for its current revision; undefined when it has none. */
  incident: IncidentScope | undefined;
  releaseInWords: (release: string | null) => string;
}) {
  const scope = step.scope;
  if (scope === undefined) {
    return (
      <div data-testid="step-scope" data-scope-standing="not_reported">
        <Fact label="Taken under scope">
          <Absent testId="step-scope-not-reported">not reported by this backend</Absent>
        </Fact>
      </div>
    );
  }
  const standing = scopeStanding(step);
  const reasons = reasonsAmong(scope.gaps);
  const now = incident?.revision ?? null;
  const later = widenedBy(scope);
  const recorded = scope.recorded;
  const differs = recorded !== null && (recorded.state !== step.state || recorded.release !== step.release);
  return (
    <div className="space-y-1" data-testid="step-scope" data-scope-standing={standing} data-step-scope-revision={scope.revision ?? ""}>
      <Fact label="Taken under scope">
        {scope.revision === null ? (
          <Absent testId="step-scope-revision">no revision: this step names none</Absent>
        ) : (
          <span className="font-mono text-foreground" data-testid="step-scope-revision">{`revision ${scope.revision}`}</span>
        )}
        {scope.revision !== null && now !== null && now !== scope.revision && (
          <span className="text-muted-foreground" data-testid="step-scope-current">{` -- the incident's scope is now at revision ${now}`}</span>
        )}
      </Fact>
      {later.length > 0 && (
        <p className="text-[12px] font-medium text-amber-400" data-testid="step-scope-widened">
          The scope has widened since this step was taken under revision {scope.revision}:{" "}
          {later.map((one, at) => (
            <span key={one.revision} data-widened-by={one.revision}>
              {at > 0 ? "; " : ""}
              {`revision ${one.revision} added `}
              {one.items.map((item, index) => (
                <span key={index}>
                  {index > 0 ? ", " : ""}
                  <ItemName item={item} />
                </span>
              ))}
            </span>
          ))}
          . What this step recorded does not stand for the wider scope.
        </p>
      )}
      {scope.gaps === null ? (
        <p className="text-[12px]" data-testid="step-scope-gaps-not-known">
          <Absent>
            Not known: what about the scope keeps this step back was not served, so whether anything does is not known.
          </Absent>
        </p>
      ) : (
        <div className="space-y-1" data-testid="step-scope-gaps" data-scope-gap-count={scope.gaps.length}>
          {standing === "none_named" && <p className="text-[12px] text-muted-foreground">No scope gap is recorded against this step.</p>}
          {scope.gaps.length > 0 && (
            <>
              <p className="text-[12px] font-medium text-amber-400" data-testid="step-scope-kept-back">
                {`Kept back by the scope: ${scope.gaps.length} ${scope.gaps.length === 1 ? "thing" : "things"}`}
              </p>
              <ul className="space-y-1">
                {scope.gaps.map((gap, index) => (
                  <li key={index} className="text-[12px]">
                    <KeptBackBy gap={gap} taken={scope.revision} />
                  </li>
                ))}
              </ul>
            </>
          )}
          <UnreadableRows from={scope} list="gaps" label="what about the scope keeps this step back" />
        </div>
      )}
      <UnreadableRows from={scope} list="recorded" label="what this step's row recorded" />
      {recorded !== null && differs && (
        <p className="text-[12px] text-muted-foreground" data-testid="step-recorded" data-recorded-state={recorded.state ?? ""} data-recorded-release={recorded.release ?? ""}>
          As its row recorded it{scope.revision === null ? "" : `, under scope revision ${scope.revision}`}: state{" "}
          <code className="break-all font-mono text-[11px]">{recorded.state ?? "none served"}</code>; {releaseInWords(recorded.release)};{" "}
          {recorded.gaps === null ? "its gaps then were not served" : recorded.gaps.length === 0 ? "no gap then" : `${recorded.gaps.length} ${recorded.gaps.length === 1 ? "gap" : "gaps"} then`}
          . That is history: it is not how this step reads now.
        </p>
      )}
      <UnreadableRows from={scope} list="recorded.gaps" label="the gaps this step's row recorded" />
      <Heading>What this step&apos;s scope gained and lost</Heading>
      <UnreadableRows from={scope} list="scopeItems" label="what this step's scope gained and lost" />
      <Listed
        rows={scope.added}
        from={scope}
        list="added"
        label="items this step's scope gained"
        testId="step-scope-added"
        notKnown={
          <>
            Not known: what this step&apos;s scope gained cannot be established.
            <Why reasons={reasons} />
          </>
        }
        none="No item was added to this step's scope after its first revision."
      >
        {(item: ScopeAddedItem) => (
          <span data-testid="scope-added-item" data-added-ref={item.ref ?? ""}>
            <ItemName item={item} />
            <span className="text-muted-foreground">
              {" "}-- added by {item.revision === null ? "a revision not named" : `revision ${item.revision}`};{" "}
            </span>
            <NamedBy links={item.coveredBy} />
          </span>
        )}
      </Listed>
      <UnreadableRows from={scope} list="added.coveredBy" label="the links that name an added item" />
      <RemovedItems rows={scope.removed} from={scope} reasons={reasons} testId="step-scope-removed" of="this step's scope" />
    </div>
  );
}

/** Beside a step's state: a caution chip when the scope keeps it back, or when whether it does is not known. */
export function ScopeStandingChip({ step }: { step: RecoveryStep }) {
  const standing = scopeStanding(step);
  if (standing === "kept_back") {
    return (
      <Chip tone="caution" testId="step-scope-standing">
        Kept back by the scope
      </Chip>
    );
  }
  if (standing === "not_known") {
    return (
      <Chip tone="caution" testId="step-scope-standing">
        Whether the scope keeps this step back is not known
      </Chip>
    );
  }
  return null;
}

// ---- the scope's own read ----

function notFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Who declared a revision, when and why: each as recorded, or said as absent. */
function Declared({ revision }: { revision: ScopeRevision }) {
  return (
    <div className="space-y-0.5" data-testid="revision-declared">
      <Fact label="Declared by">
        <span className="break-all text-foreground" data-testid="revision-declared-by">
          {revision.declaredBy ?? <Absent>nobody on record</Absent>}
        </span>{" "}
        <span className="text-muted-foreground">at</span> <When iso={revision.declaredAt} testId="revision-declared-at" />
      </Fact>
      <Fact label="Why">
        <span className="break-words text-foreground" data-testid="revision-why">
          {revision.reason ?? <Absent>no reason served</Absent>}
        </span>
      </Fact>
    </div>
  );
}

/** The items a revision names, by kind: the kinds known here in their order, then every other kind under its own value. */
function ItemsByKind({ revision }: { revision: ScopeRevision }) {
  const items = revision.items;
  if (items === null) {
    return (
      <p className="text-[12px]" data-testid="revision-items-not-known">
        <Absent>Not known: the items of this revision were not served.</Absent>
      </p>
    );
  }
  const groups: Array<{ kind: string | null; rows: ScopeItem[] }> = KINDS.map(([kind]) => ({ kind, rows: [] as ScopeItem[] }));
  for (const item of items) {
    const group = groups.find((one) => one.kind === item.kind);
    if (group) group.rows.push(item);
    else groups.push({ kind: item.kind, rows: [item] });
  }
  const unread = unreadableIn(revision, "items");
  return (
    <div className="space-y-1" data-testid="revision-items" data-row-count={items.length} data-unread-count={notAListIn(revision, "items") ? "unknown" : unread}>
      {items.length === 0 && unread === 0 && <p className="text-[12px] text-muted-foreground">This revision names no item.</p>}
      {groups.filter((group) => group.rows.length > 0).map((group, index) => (
        <div key={index} className="text-[12px]" data-testid="items-of-kind" data-item-kind={group.kind ?? ""} data-kind-known={knownKind(group.kind) ? "true" : "false"}>
          <span className={knownKind(group.kind) ? "font-medium text-foreground" : "font-medium text-amber-400"}>
            {group.kind === null ? "No kind served" : KIND_WORDS.get(group.kind)?.many ?? `Unknown kind (${group.kind})`}
            {` (${group.rows.length})`}
          </span>
          <ul className="space-y-0.5 pl-3">
            {group.rows.map((item, at) => (
              <li key={at}>
                <ItemName item={item} assetKind={item.assetKind} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      <UnreadableRows from={revision} list="items" label="this revision's items" />
    </div>
  );
}

/** What a revision added or removed against the one before it: not known, nothing, or each item. */
function Changed({ revision, list, reasons }: { revision: ScopeRevision; list: "added" | "removed"; reasons: string[] }) {
  return (
    <Listed
      rows={revision[list]}
      from={revision}
      list={list}
      label={list === "added" ? "what this revision added" : "what this revision removed"}
      testId={`revision-${list}`}
      notKnown={
        <>
          Not known: what this revision {list} cannot be established, because its items or those of the revision before it
          cannot be read.
          <Why reasons={reasons.filter((code) => code === SCOPE_UNREADABLE)} none="The scope's read gives no reason for it." />
        </>
      }
      none={list === "added" ? "Added nothing." : "Removed nothing."}
    >
      {(item: ScopeItemRef) => <ItemName item={item} />}
    </Listed>
  );
}

function RestsOn({ revision }: { revision: ScopeRevision }) {
  return (
    <Listed
      rows={revision.evidence}
      from={revision}
      list="evidence"
      label="the evidence this revision rests on"
      testId="revision-evidence"
      notKnown="The evidence this revision rests on was not served."
      none="It names no evidence."
    >
      {(one: ScopeEvidence) => (
        <span data-testid="revision-evidence-item">
          <code className="break-all font-mono text-[11px] text-foreground/90">{one.uuid ?? "no id served"}</code>{" "}
          <span className="break-all text-muted-foreground">{one.classification ?? "classification not served"}</span>
        </span>
      )}
    </Listed>
  );
}

/** One revision in the history: its number, who declared it and why, what it added and removed, and what it names. */
function RevisionRow({ revision, reasons }: { revision: ScopeRevision; reasons: string[] }) {
  return (
    <li className="space-y-1 rounded-md border border-border/40 p-2" data-testid="scope-revision" data-revision={revision.revision ?? ""}>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-mono text-foreground">{revision.revision === null ? "revision (no number served)" : `revision ${revision.revision}`}</span>
        {revision.current === true && (
          <Chip tone="neutral" testId="revision-current">
            current
          </Chip>
        )}
        {revision.current === null && <Absent>whether it is current was not said</Absent>}
        <span className="text-muted-foreground">
          {revision.supersedes === null ? "supersedes none" : `supersedes revision ${revision.supersedes}`}
        </span>
      </div>
      <Declared revision={revision} />
      <Heading>Added</Heading>
      <Changed revision={revision} list="added" reasons={reasons} />
      <Heading>Removed</Heading>
      <Changed revision={revision} list="removed" reasons={reasons} />
      <Heading>Names in all</Heading>
      <ItemsByKind revision={revision} />
      <Heading>Rests on</Heading>
      <RestsOn revision={revision} />
    </li>
  );
}

/**
 * One incident's scope from its own read: the current revision in full, then every
 * revision newest first. Read only once opened; nothing on the screen waits on it.
 */
export function ScopeHistory({ deployment, finding, reasons }: {
  deployment: string;
  finding: string;
  /** The reasons for "not known" the recovery record's steps give, for a revision whose change cannot be established. */
  reasons: string[];
}) {
  const query = useQuery<FindingScope>({
    queryKey: [`/api/assurance/findings/${encodeURIComponent(finding)}/scope-revisions`],
  });
  if (query.isError && notFound(query.error)) {
    return (
      <div className="space-y-1 rounded-md border border-dashed border-border/70 bg-surface-1/40 px-3 py-2 text-[12px]" data-testid="scope-not-found">
        <p className="font-medium text-foreground">Not found.</p>
        <p className="text-muted-foreground">
          Athena-Backend answers that it has no scope to read for this finding for you. It answers a finding you may not read
          exactly as one that does not exist, and a backend without the scope&apos;s route answers the same. This is not an
          empty scope: nothing of this incident&apos;s scope was read.
        </p>
      </div>
    );
  }
  const source = served(query);
  if (source.state !== "ready") return <NotInHand source={source} what="this incident's scope" />;
  const scope = source.data;
  // This console's server answers the shape or an error. Anything else is not a scope, and is said so: it is
  // never read as a scope with no revision, and it never throws.
  const shaped: unknown = scope;
  const revisionsServed: unknown = shaped !== null && typeof shaped === "object" ? (shaped as { revisions?: unknown }).revisions : undefined;
  if (shaped === null || typeof shaped !== "object" || Array.isArray(shaped) || !(revisionsServed === null || revisionsServed === undefined || Array.isArray(revisionsServed))) {
    return (
      <p className="text-[12px] text-amber-400" data-testid="scope-answer-unreadable">
        The answer to this incident&apos;s scope read is not one this console can read, so its scope is not known here. That
        is not an incident without a scope.
      </p>
    );
  }
  if (!answeredFor(scope.deployment ?? null, deployment) || !answeredFor(scope.finding ?? null, finding)) {
    return (
      <p className="text-[12px]" data-testid="scope-other-incident">
        <Absent>
          Athena-Backend answered this read for another deployment or finding ({scope.deployment ?? "no deployment named"},{" "}
          {scope.finding ?? "no finding named"}), so it is not shown here.
        </Absent>
      </p>
    );
  }
  const revisions = scope.revisions ?? null;
  if (revisions === null) {
    return (
      <p className="text-[12px]" data-testid="scope-revisions-not-known">
        <Absent>
          Not known: Athena-Backend served no list of revisions for this incident&apos;s scope. That is not an incident
          without a scope.
        </Absent>
      </p>
    );
  }
  const unread = unreadableIn(scope, "revisions");
  const named = typeof scope.current === "number" ? scope.current : null;
  const current = named === null ? null : revisions.find((one) => one.revision === named) ?? null;
  // Newest first: the backend serves them oldest first. Every one is drawn; none is merged or left out.
  const newestFirst = revisions.slice().reverse();
  return (
    <div className="space-y-2" data-testid="scope-history" data-revision-count={revisions.length} data-unread-count={notAListIn(scope, "revisions") ? "unknown" : unread}>
      <UnreadableRows from={scope} list="revisions" label="the revisions of this incident's scope" />
      {revisions.length === 0 && unread === 0 && (
        <p className="text-[12px] text-muted-foreground" data-testid="scope-none-declared">
          Athena-Backend records no revision of a scope for this incident: none is declared. What the incident affected is
          then not declared, which is not the same as nothing being affected.
        </p>
      )}
      {revisions.length > 0 && (
        <>
          <Heading>The current scope</Heading>
          {current === null ? (
            <p className="text-[12px]" data-testid="scope-current-not-served">
              <Absent>
                {named === null
                  ? "Athena-Backend names no current revision on this read, so none of the revisions below is shown as the current one."
                  : `The current revision Athena-Backend names (${named}) is not among the revisions served.`}
              </Absent>
            </p>
          ) : (
            <div className="space-y-1 rounded-md border border-border/50 p-2" data-testid="scope-current-revision" data-revision={current.revision ?? ""}>
              <p className="font-mono text-[12px] text-foreground">{`revision ${current.revision}`}</p>
              <Declared revision={current} />
              <Heading>Its items, by kind</Heading>
              <ItemsByKind revision={current} />
            </div>
          )}
          <Heading>{`Every revision, newest first (${revisions.length})`}</Heading>
          <ol className="space-y-2" data-testid="scope-revisions">
            {newestFirst.map((revision, index) => (
              <RevisionRow key={index} revision={revision} reasons={reasons} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
