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

export type RecordAdoption =
  | { state: "syncing" }
  | { state: "done"; adopted: number; remaining: number; throttled: boolean }
  | { state: "unread"; message: string };

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
        const adopted = body && Array.isArray(body.adopted) ? body.adopted.length : 0;
        const remaining = body && typeof body.remaining === "number" ? body.remaining : 0;
        if (adopted > 0) {
          // The lists adopted rows appear in, refreshed now that they have.
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["/api/tests"] }),
            queryClient.invalidateQueries({ queryKey: ["/api/record/engagements"] }),
            queryClient.invalidateQueries({ queryKey: ["/api/findings/summary"] }),
          ]);
        }
        if (shown) setState({ state: "done", adopted, remaining, throttled: body?.throttled === true });
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
