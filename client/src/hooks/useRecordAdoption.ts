/**
 * The adoption sync, asked once per sign-in from the app's shell (App.tsx) and
 * again when the Engagements page loads: POST /api/record/adopt gives every
 * scan Athena-Backend lists for the person that this dashboard has no row for
 * its row (server/backend-adoption.ts, the Option 1 hybrid, owner decision 4),
 * so the screens, each row's Stop and the kill switch cover it.
 *
 * A read on no stop's path: the screens show what they have while the sync
 * runs, and the lists it adopted into -- the Tests screen's and the Overview's
 * among them, which send nothing of their own on load -- refresh once rows
 * were adopted. The server
 * throttles a sync within its interval and answers the last outcome; a sync
 * the backend refused, or a person with no backend sign-in, is answered
 * "could not be read" with the reason, and nothing changes. The answer is
 * read by its fields; the body is never sent, because the server reads none.
 */
import { useEffect, useRef, useState } from "react";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { errorMessage } from "@/lib/loaded";
import { syncAnswerMissing } from "@/lib/backendRecordCopy";

export type RecordAdoption =
  | { state: "syncing" }
  | {
    state: "done";
    adopted: number;
    /** Candidates left for the next sync (the server's per-sync cap). */
    remaining: number;
    /** Pending scans the engine has not named a run for: no row here until it does. */
    awaitingRun: number;
    /** Finished scans whose detail could not be read now, and the server's reasons: adopted whole next time. */
    detailUnread: number;
    detailUnreadReasons: string[];
    /** A row that could not be written stopped the sync there, in the server's words; null when every row was written. */
    writeFailed: string | null;
    throttled: boolean;
  }
  | { state: "unread"; message: string };

/**
 * The answer read by its fields (server/backend-adoption.ts AdoptionOutcome).
 * A field the answer does not carry is the honest side -- unread, with which
 * field -- never a zero that would read as "nothing awaits".
 */
export function readAdoptionAnswer(body: Record<string, unknown> | null): RecordAdoption {
  const unread = (field: string): RecordAdoption => ({ state: "unread", message: syncAnswerMissing(field) });
  if (body === null) return unread("anything this page reads");
  if (!Array.isArray(body.adopted)) return unread("which scans were adopted");
  if (typeof body.remaining !== "number") return unread("how many scans await the next sync");
  if (typeof body.awaitingRun !== "number") return unread("how many scans await the launch's answer");
  if (!Array.isArray(body.detailUnread)) return unread("how many finished scans could not be read");
  if (body.writeFailed !== null && typeof body.writeFailed !== "string") return unread("whether a row could not be written");
  if (typeof body.throttled !== "boolean") return unread("whether this answer is the last sync's");
  return {
    state: "done",
    adopted: body.adopted.length,
    remaining: body.remaining,
    awaitingRun: body.awaitingRun,
    detailUnread: body.detailUnread.length,
    detailUnreadReasons: body.detailUnread
      .map((one) => (one && typeof one === "object" ? (one as { reason?: unknown }).reason : undefined))
      .filter((one): one is string => typeof one === "string"),
    writeFailed: body.writeFailed,
    throttled: body.throttled,
  };
}

export function useRecordAdoption(): RecordAdoption {
  const [state, setState] = useState<RecordAdoption>({ state: "syncing" });
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    let shown = true;
    (async () => {
      try {
        const response = await apiFetch("POST", "/api/record/adopt");
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!response.ok) {
          const said = body && typeof body.error === "string" ? body.error : `Athena-Backend answered ${response.status}`;
          if (shown) setState({ state: "unread", message: said });
          return;
        }
        const read = readAdoptionAnswer(body);
        if (read.state === "done" && read.adopted > 0) {
          // The lists adopted rows appear in, refreshed now that they have.
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["/api/tests"] }),
            queryClient.invalidateQueries({ queryKey: ["/api/record/engagements"] }),
            queryClient.invalidateQueries({ queryKey: ["/api/findings/summary"] }),
          ]);
        }
        if (shown) setState(read);
      } catch (cause) {
        if (shown) setState({ state: "unread", message: errorMessage(cause) });
      }
    })();
    return () => {
      shown = false;
    };
  }, []);
  return state;
}
