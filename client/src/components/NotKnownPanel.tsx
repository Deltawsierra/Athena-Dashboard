/**
 * What stands beside the Stop of a scan whose run the engine does not know --
 * the server's reading (server/routes.ts notKnown: the run's reads answered 404
 * "No such scan run" for a while; the answer's `engineKnowsRun: false`) -- and
 * what a scan page says once a person has recorded it so (status `not_known`).
 *
 * The reading is no end: the status is unchanged, the run may still be running
 * under another id, and the Stop beside this is offered and sent as before --
 * nothing here enters a Stop's condition or waits on one. An admin may record
 * the scan as not known to the engine (POST /api/scans/:testId/record-not-known),
 * behind a confirm step: the server sends the run its stop first, and records
 * it only if the engine answers that stop that it does not know the run. That
 * is not a stop, and the kill switch refuses it while engaged (the switch has
 * sent the run a stop already). Anyone else is told who can.
 *
 * Shown only for a scan this dashboard dispatched itself: the server gives a
 * hybrid row no reading -- its end is its record's.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateTestsAndFindings } from "@/lib/invalidate";
import {
  ALREADY_RECORDED, ASK_AN_ADMIN, ENGINE_WORDS, NOT_KNOWN_LABEL, NOT_RECORDED_TITLE, RECORDED_BODY, RECORDED_TITLE,
  RECORD_ACTION, RECORD_ACTION_PENDING, RECORD_CONFIRM_ACTION, RECORD_CONFIRM_BODY, RECORD_CONFIRM_TITLE, STATUS_UNCHANGED,
  notKnownSince, recordedBy,
} from "@/lib/notKnownCopy";
import { NOTHING_HERE_IS_A_RESULT } from "@/lib/scanSummaryCopy";
import { cn } from "@/lib/utils";
import { isAdmin } from "@/utils/auth";
import type { NotKnownRecorded } from "@shared/engine-record";
import type { PublicUser } from "@shared/schema";

/** The server's reading, as the status answer carries it (`notKnown`). */
export interface NotKnownReading {
  since: string;
  reads: number;
  said: string;
}

/** A time the server wrote, as this browser shows times; the text as sent when it is not one. */
function shown(at: string): string {
  const time = new Date(at);
  return Number.isNaN(time.getTime()) ? at : time.toLocaleString();
}

/** Beside the Stop of a scan whose run the engine does not know, while it may still be running. */
export default function NotKnownPanel({ testId, reading, className }: {
  testId: string;
  reading: NotKnownReading;
  className?: string;
}) {
  const { toast } = useToast();
  const { data: session } = useQuery<{ authenticated: boolean; user: PublicUser | null }>({
    queryKey: ["/api/auth/check"],
  });
  const admin = isAdmin(session?.user ?? null);
  const record = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/scans/${testId}/record-not-known`, {});
      return (await response.json()) as { recorded: boolean; alreadyRecorded?: boolean };
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: [`/api/scans/${testId}`] });
      void invalidateTestsAndFindings();
      toast({ title: RECORDED_TITLE, description: result.alreadyRecorded ? ALREADY_RECORDED : RECORDED_BODY });
    },
    onError: (error: Error) => {
      void queryClient.invalidateQueries({ queryKey: [`/api/scans/${testId}`] });
      // The server's own words: the engine knows the run, could not be asked, or the record could not be written.
      toast({ title: NOT_RECORDED_TITLE, description: error.message, variant: "destructive" });
    },
  });

  return (
    <div
      role="status"
      className={cn("rounded-lg border border-border/60 bg-surface-1/50 p-3 text-[13px] text-foreground", className)}
      data-testid="panel-not-known"
    >
      <p className="flex items-center gap-2 font-semibold">
        <AlertTriangle className="h-4 w-4 shrink-0 athena-gold" />
        {NOT_KNOWN_LABEL}
      </p>
      <p className="mt-1" data-testid="text-not-known-since">{notKnownSince(shown(reading.since))}</p>
      <p className="mt-1 text-muted-foreground" data-testid="text-not-known-said">
        {ENGINE_WORDS} <span className="athena-mono">{reading.said}</span>
      </p>
      <p className="mt-1 text-muted-foreground" data-testid="text-not-known-status">{STATUS_UNCHANGED}</p>
      {admin ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="mt-2" disabled={record.isPending} data-testid="button-record-not-known">
              {record.isPending ? RECORD_ACTION_PENDING : RECORD_ACTION}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{RECORD_CONFIRM_TITLE}</AlertDialogTitle>
              <AlertDialogDescription data-testid="text-record-not-known-confirm">{RECORD_CONFIRM_BODY}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => record.mutate()} data-testid="button-confirm-record-not-known">
                {RECORD_CONFIRM_ACTION}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <p className="mt-1 text-muted-foreground" data-testid="text-not-known-ask-an-admin">{ASK_AN_ADMIN}</p>
      )}
    </div>
  );
}

/**
 * A scan page's account of a scan a person recorded as not known to the engine:
 * who, when, the engine's words, and that nothing here is a result. Never "the
 * scan finished and returned no findings", and never a band (lib/notKnownCopy.ts
 * NOT_KNOWN_BASIS).
 */
export function NotKnownRecordedSummary({ recorded, className }: { recorded: NotKnownRecorded | null; className?: string }) {
  return (
    <div className={cn("flex items-start gap-3", className)} data-testid="text-not-known-recorded">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="space-y-1 text-[13px] text-muted-foreground">
        <p>{recorded ? recordedBy(recorded.by, shown(recorded.at)) : `${NOT_KNOWN_LABEL}.`}</p>
        {recorded && recorded.said !== "" && (
          <p data-testid="text-not-known-recorded-said">
            {ENGINE_WORDS} <span className="athena-mono">{recorded.said}</span>
          </p>
        )}
        <p>{NOTHING_HERE_IS_A_RESULT}</p>
      </div>
    </div>
  );
}
