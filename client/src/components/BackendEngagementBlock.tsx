/**
 * Each client's Athena-Backend engagement, on the Clients page (the Option 1
 * hybrid, owner decision 2 and plan section 14).
 *
 * What this dashboard recorded is shown from its own record: the engagement
 * id it created or adopted for the client, and the client's testing window.
 * The engagement's name, status and scope are the backend's to say, so they
 * are read from Athena-Backend only when a person asks (never on the page's
 * load: the Clients page's requests do not grow with its clients). The
 * window's renewal is a person's act -- a press, then a confirm step -- and is
 * never done on its own. Every authored word is in lib/backendRecordCopy.ts,
 * held to the persona lint by test.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarClock, RefreshCw } from "lucide-react";

import GlassCard from "@/components/GlassCard";
import { Label, StatusPill } from "@/components/mythos/atoms";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { errorMessage } from "@/lib/loaded";
import { cn } from "@/lib/utils";
import {
  ENGAGEMENTS_SOURCE, ENGAGEMENTS_TITLE, NO_ENGAGEMENT_YET, NO_WINDOW_YET, READ_ENGAGEMENT, RENEW_ACTION,
  RENEW_CONFIRM_ACTION, RENEW_CONFIRM_BODY, RENEW_CONFIRM_TITLE,
} from "@/lib/backendRecordCopy";

/** The client's fields this block reads (GET /api/clients); the backend fields are absent on an older record. */
export interface EngagedClient {
  id: string;
  name: string;
  company: string;
  backendEngagementId?: number | null;
  testingWindowStart?: string | null;
  testingWindowEnd?: string | null;
}

/** GET /api/clients/:id/backend-engagement (server/routes.ts). */
interface EngagementRead {
  backendEngagementId: number | null;
  testingWindowStart: string | null;
  testingWindowEnd: string | null;
  hosts: string[];
  engagement: {
    id: number; name: string; clientName: string | null; status: string; scopeHosts: string[];
    testingWindowStart: string | null; testingWindowEnd: string | null;
  } | null;
}

const day = (value: string | null | undefined) => (value ? new Date(value).toLocaleDateString() : null);

function windowLine(start: string | null | undefined, end: string | null | undefined): string | null {
  const from = day(start);
  const to = day(end);
  if (!from && !to) return null;
  return `Testing window ${from ?? "?"} → ${to ?? "?"}`;
}

function EngagementRow({ client }: { client: EngagedClient }) {
  const { toast } = useToast();
  const [asked, setAsked] = useState(false);
  const engagementId = client.backendEngagementId ?? null;
  // Read from Athena-Backend only once asked; a failed read is said, never drawn as "no engagement".
  const read = useQuery<EngagementRead>({ queryKey: [`/api/clients/${client.id}/backend-engagement`], enabled: asked, retry: false });
  const renew = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/clients/${client.id}/testing-window/renew`, {});
      return (await response.json()) as { days: number; client: EngagedClient; engagement: unknown };
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
      void queryClient.invalidateQueries({ queryKey: [`/api/clients/${client.id}/backend-engagement`] });
      toast({ title: "Testing window renewed", description: `${result.days} days from now, recorded here${engagementId !== null ? " and on the backend engagement" : ""}.` });
    },
    onError: (error: Error) => toast({ title: "Testing window not renewed", description: error.message, variant: "destructive" }),
  });
  const window = windowLine(client.testingWindowStart, client.testingWindowEnd);
  const ended = client.testingWindowEnd ? new Date(client.testingWindowEnd).getTime() < Date.now() : false;

  return (
    <li className="rounded-lg border border-border/50 p-3" data-testid={`backend-engagement-${client.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 text-[13px]">
          <p className="font-medium text-foreground">{client.name} <span className="text-muted-foreground">· {client.company}</span></p>
          <p className="mt-1 text-muted-foreground" data-testid={`text-engagement-${client.id}`}>
            {engagementId !== null ? `Backend engagement #${engagementId}` : NO_ENGAGEMENT_YET}
          </p>
          <p className={cn("mt-1 flex items-center gap-1.5", ended ? "text-sev-medium" : "text-muted-foreground")} data-testid={`text-testing-window-${client.id}`}>
            <CalendarClock className="h-3.5 w-3.5 shrink-0" />
            {window ?? NO_WINDOW_YET}{window && ended ? " · ended" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {engagementId !== null && (
            <Button type="button" variant="outline" size="sm" onClick={() => setAsked(true)} data-testid={`button-read-engagement-${client.id}`}>
              {READ_ENGAGEMENT}
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="secondary" size="sm" data-testid={`button-renew-window-${client.id}`}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {RENEW_ACTION}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{RENEW_CONFIRM_TITLE}</AlertDialogTitle>
                <AlertDialogDescription data-testid={`text-renew-confirm-${client.id}`}>{RENEW_CONFIRM_BODY}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => renew.mutate()} data-testid={`button-confirm-renew-${client.id}`}>
                  {RENEW_CONFIRM_ACTION}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      {asked && (
        <div className="mt-3 border-t border-border/40 pt-3 text-[12px]" data-testid={`text-engagement-read-${client.id}`}>
          {read.isPending ? (
            <p className="text-muted-foreground">Reading the engagement from Athena-Backend…</p>
          ) : read.isError ? (
            <p className="text-sev-medium">Could not read the engagement from Athena-Backend: {errorMessage(read.error)}</p>
          ) : read.data.engagement === null ? (
            <p className="text-muted-foreground">{NO_ENGAGEMENT_YET}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
              <span className="font-medium text-foreground">#{read.data.engagement.id} {read.data.engagement.name}</span>
              <StatusPill tone={read.data.engagement.status === "running" ? "progress" : "neutral"}>{read.data.engagement.status}</StatusPill>
              <span>scope: {read.data.engagement.scopeHosts.length > 0 ? read.data.engagement.scopeHosts.join(", ") : "none"}</span>
              <span>{windowLine(read.data.engagement.testingWindowStart, read.data.engagement.testingWindowEnd) ?? "no testing window on the engagement"}</span>
              {read.data.hosts.length > 0 && <span>sites here: {read.data.hosts.join(", ")}</span>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export default function BackendEngagementBlock({ clients, className }: { clients: EngagedClient[]; className?: string }) {
  return (
    <GlassCard hover={false} className={className} data-testid="panel-backend-engagements">
      <Label>{ENGAGEMENTS_TITLE}</Label>
      <p className="mt-1 text-[11px] text-muted-foreground" data-testid="text-engagements-source">{ENGAGEMENTS_SOURCE}</p>
      {clients.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted-foreground">No clients on record.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {clients.map((client) => <EngagementRow key={client.id} client={client} />)}
        </ul>
      )}
    </GlassCard>
  );
}
