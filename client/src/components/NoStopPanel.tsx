/**
 * What stands in place of a Stop for a scan no Stop can reach.
 *
 * The engine's contract is that every scan it starts has a run id a stop can
 * name (athena-engine #71: a path-safe uuid). A start answered without one --
 * no run id, or one no stop can address (shared/engine-record.ts runIdFrom) --
 * breaks it, and the server marks that scan `stop: "failsafe"`. Such a scan was
 * shown with a normal red Stop that answered 409 when clicked, and nothing on
 * the page named what could stop it until then. This says so before any click,
 * and links to what can: the Failsafe console, which pauses, stands down or
 * terminates the engine itself, and the kill switch, which reaches the run only
 * if the engine lists it by a run id.
 *
 * Shown only where the server said the scan cannot be named. Where the page
 * does not know -- a read still loading, or one that failed -- the normal Stop
 * stays: no working Stop is ever hidden behind this.
 */
import { Link } from "wouter";
import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";

export default function NoStopPanel({ className, testId }: { className?: string; testId?: string }) {
  return (
    <div
      role="alert"
      className={cn("rounded-lg border border-destructive bg-destructive/10 p-3 text-[13px] text-foreground", className)}
      data-testid={testId ? `panel-no-stop-${testId}` : "panel-no-stop"}
    >
      <p className="flex items-center gap-2 font-semibold text-destructive">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        No Stop can reach this scan
      </p>
      <p className="mt-1">
        The engine started this scan without a run id a stop can name, which its contract does not allow: the engine
        never named the run, so this app cannot stop it by itself. It may still be running. Stop it from the{" "}
        <Link href="/failsafe" className="font-medium underline" data-testid="link-failsafe-console">
          Failsafe console
        </Link>
        : pause, stand down or terminate the engine. The{" "}
        <Link href="/ai-control" className="font-medium underline" data-testid="link-kill-switch">
          kill switch on the AI Control page
        </Link>{" "}
        stops it only if the engine lists it by a run id. Both need an admin.
      </p>
    </div>
  );
}
