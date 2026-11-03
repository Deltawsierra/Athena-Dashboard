/**
 * The recorded histories, a page at a time: what the authority screens share to read
 * Athena-Backend's approval, tool-contract and decision histories
 * (server/assurance.ts approvalHistory, toolContractHistory, toolContractBindings,
 * decisionHistory).
 *
 * Each history is served one bounded page at a time, newest first, with the whole
 * count beside it and `?offset=` to read on. A screen reads the first page; "Load
 * more" reads the next from `offset + returned`, and only when the backend said there
 * is more. Each page is its own read, keyed by the deployment in its path and by its
 * offset, and is read through `served()`: the app keeps the previous key's answer on
 * screen while the next loads (keepPreviousData), and here that would be another
 * page's or another deployment's, so it reads as loading. The pages a person has
 * loaded are held by a component keyed by the deployment, so another deployment
 * starts again from its first page. And a page the backend answered for a deployment
 * other than the one asked is not drawn.
 *
 * Nothing here writes: every read is a GET.
 */
import { Fragment, useState, type ReactNode } from "react";
import { Absent, Count, NotInHand, UnreadableRows } from "./parts";
import type { Loaded } from "@/lib/loaded";
import type { HistoryPage } from "./types";

/** The largest `?offset=` the history reads take (athena-backend HISTORY_MAX_OFFSET, 2^31 - 1). */
export const HISTORY_MAX_OFFSET = 2 ** 31 - 1;

/**
 * Where the page after this one starts: `offset + returned`, only when the backend
 * said the history holds more (`truncated`), the page returned rows, and the next
 * offset is one the backend takes. null otherwise: nothing more to ask for.
 */
export function nextOffset(offset: number, page: HistoryPage): number | null {
  if (page.truncated !== true || page.returned === null || page.returned <= 0) return null;
  const next = offset + page.returned;
  return Number.isInteger(next) && next <= HISTORY_MAX_OFFSET ? next : null;
}

/** A deployment id as compared here: case and hyphens aside (the backend serves a UUID's canonical form). */
function canonical(id: string): string {
  return id.toLowerCase().replace(/-/g, "");
}

/** Whether a page the backend answered for `served` may be drawn under `asked`. Not named is not refused. */
export function answeredFor(served: string | null, asked: string): boolean {
  return served === null || canonical(served) === canonical(asked);
}

export interface PageSlot {
  offset: number;
  /** Whether this is the last page read so far: the one that offers the next. */
  last: boolean;
  /** Read the page that starts at `next`. */
  onMore: (next: number) => void;
}

/**
 * The pages of one history a person has read so far, from the first. Each page is
 * drawn by `page`, which reads it. Key this by the deployment (and by any filter) so
 * another deployment starts from its first page.
 */
export function HistoryPages({ page }: { page: (slot: PageSlot) => ReactNode }) {
  const [offsets, setOffsets] = useState<number[]>([0]);
  const onMore = (next: number) => setOffsets((read) => (read.includes(next) ? read : [...read, next]));
  return (
    <>
      {offsets.map((offset, index) => (
        <Fragment key={offset}>{page({ offset, last: index === offsets.length - 1, onMore })}</Fragment>
      ))}
    </>
  );
}

/**
 * One page of a history: reading, why it could not be read, or its rows -- and, on the
 * last page read, how much of the history is shown and the button that reads on.
 */
export function HistoryPageFrame<T extends HistoryPage>({
  source,
  deployment,
  slot,
  what,
  count,
  rows,
  list,
  children,
}: {
  source: Loaded<T>;
  deployment: string;
  slot: PageSlot;
  /** What is being read, for "Reading …" and "Could not read …". */
  what: string;
  /** The whole count the page states, null when it states none. */
  count: (page: T) => number | null;
  /** How many rows this page holds. */
  rows: (page: T) => number;
  /** The page's list, by its name in `unreadable`: its rows that could not be read are counted under it. */
  list: string;
  children: (page: T) => ReactNode;
}) {
  if (source.state !== "ready") {
    return <NotInHand source={source} what={slot.offset === 0 ? what : `more of ${what}`} />;
  }
  const page = source.data;
  if (!answeredFor(page.deployment, deployment)) {
    return (
      <p className="text-[12px]" data-testid="history-other-deployment">
        <Absent>
          Athena-Backend answered this read for another deployment ({page.deployment}), so it is not shown here.
        </Absent>
      </p>
    );
  }
  return (
    <div className="space-y-2" data-history-page={slot.offset}>
      {children(page)}
      <UnreadableRows from={page} list={list} />
      {slot.last && <HistoryFooter page={page} offset={slot.offset} count={count(page)} rows={rows(page)} onMore={slot.onMore} />}
    </div>
  );
}

function HistoryFooter({
  page,
  offset,
  count,
  rows,
  onMore,
}: {
  page: HistoryPage;
  offset: number;
  count: number | null;
  rows: number;
  onMore: (next: number) => void;
}) {
  const next = nextOffset(offset, page);
  const shown = offset + rows;
  return (
    <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground" data-testid="history-footer">
      <span data-testid="history-shown">
        {count === null ? (
          <>
            Showing {shown}; <Absent>how many are recorded was not said</Absent>
          </>
        ) : (
          <>
            Showing {shown} of <Count value={count} />
          </>
        )}
      </span>
      {next !== null && (
        <button
          type="button"
          data-testid="history-load-more"
          className="rounded-md bg-primary/15 px-3 py-1 text-[12px] font-medium text-primary hover:bg-primary/25"
          onClick={() => onMore(next)}
        >
          Load more
        </button>
      )}
      {next === null && page.truncated === true && (
        <Absent testId="history-no-next">
          More are recorded than shown, and this page does not say where the next one starts.
        </Absent>
      )}
      {page.truncated === null && <Absent testId="history-truncation-not-said">whether more are recorded was not said</Absent>}
    </div>
  );
}

/**
 * A history read on demand: a button that opens it, and the history once open. Nothing
 * is read until it is opened, so a screen of many approvals or tools does not read
 * every one's history at once. Open state is its own, or the caller's (`open`,
 * `onToggle`) when something beside it reads the same history.
 */
export function OnDemand({
  label,
  testId,
  open: controlled,
  onToggle,
  children,
}: {
  /** What the button reads, as "Show …" / "Hide …". */
  label: string;
  testId: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: () => ReactNode;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const toggle = () => {
    if (onToggle) onToggle(!open);
    else setOwn(!open);
  };
  return (
    <div className="space-y-2" data-testid={testId} data-open={open ? "true" : "false"}>
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        aria-expanded={open}
        className="text-[12px] font-medium text-primary hover:underline"
        onClick={toggle}
      >
        {open ? `Hide ${label}` : `Show ${label}`}
      </button>
      {open && <div className="space-y-2 border-l border-border/60 pl-3">{children()}</div>}
    </div>
  );
}
