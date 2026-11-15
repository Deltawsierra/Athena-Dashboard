/**
 * The failsafe console: pause, stand-down, and terminate for a Mythos engine.
 *
 * These are the end-all controls -- the ones that exist for when something has
 * gone truly wrong -- so this screen is built to two rules the whole feature
 * turns on:
 *
 *   (a) The engine can never reach these itself, and neither can this browser
 *       or this server. A private signing key never touches either. What
 *       happens here is: an operator DRAFTS a command, the control plane issues
 *       a single-use nonce and the exact bytes to sign, and the operator signs
 *       them OUT OF BAND with `mythos-failsafe` on their own machine. This page
 *       only relays the resulting signature. A compromised server cannot mint a
 *       command the engine will obey.
 *
 *   (b) They can't be triggered by accident. Stand-down and terminate need two
 *       distinct operators' signatures (the two-person rule), terminate also
 *       demands the operator type the engine's id to confirm, and every
 *       consequential button is behind a deliberate confirmation. The engine
 *       verifies every signature itself before it acts.
 *
 * Nothing here fakes an engine's state: until the engine reports its live
 * governor state and the backend proxies it, this says "not reported by the
 * engine" rather than drawing a green light nobody checked.
 *
 * And one rule about reads: a stop is never blocked by one. Pause, stand-down
 * and terminate -- drafting them, confirming them, and reaching an in-flight
 * one to add the second signature -- stay live whatever the status or state
 * reads last said, or failed to say. Those reads are probes. The draft and
 * signature routes check the control plane themselves and say when they
 * refuse, and the engine checks every signature before it acts; a status poll
 * that failed has no business standing between an operator and a stop. What
 * a failed read changes is what is SHOWN: the status, the governor, the counts
 * and a command's signers read as unknown, never as their last answer.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { loaded } from "@/lib/loaded";
import {
  Snowflake,
  Play,
  Home,
  Unlock,
  Skull,
  ShieldAlert,
  Copy,
  Check,
  KeyRound,
  Radio,
  Ban,
  Terminal,
} from "lucide-react";

import PageHero from "@/components/mythos/PageHero";
import StatCard from "@/components/mythos/StatCard";
import GlassCard from "@/components/GlassCard";
import { Divider } from "@/components/mythos/Ornament";
import { StatusPill, Label as AthenaLabel, type StatusTone } from "@/components/mythos/atoms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, rowsRead, type RowsRead } from "@/lib/queryClient";
import { UnreadableLists, UnreadableRows, notAListIn, unreadableIn } from "@/components/authority/parts";
import { cn } from "@/lib/utils";

/* ---- API shapes (mirror server/failsafe.ts) --------------------------- */

interface FailsafeStatus {
  configured: boolean;
  reachable: boolean;
  authorized: boolean | null;
  url: string | null;
  detail: string;
  defaultEngineId: string;
}

interface FailsafeCommand {
  uuid: string;
  engineId: string;
  action: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  reason: string;
  signers: string[];
  /** Null when the control plane did not say how many it needs: unknown, never read as fewer (server/failsafe.ts). */
  requiredSignatures: number | null;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
}

interface CommandDraft {
  action: string;
  engine_id: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
  reason: string;
}

interface DraftedCommand {
  command: FailsafeCommand;
  signingBytes: string;
  draft: CommandDraft;
  /**
   * Only when the control plane's answer to a draft named no command id
   * (server/failsafe.ts draftCommand): why it cannot be opened here by its id.
   * It is shown all the same, with that reason (UnopenedDraft), never hidden.
   */
  unopenable?: string;
}

interface FailsafeStateView {
  engineId: string | null;
  engineState: string | null;
  engineStateAvailable: boolean;
  awaitingSignatures: FailsafeCommand[];
  ready: FailsafeCommand[];
  recent: FailsafeCommand[];
  /**
   * Rows of a list the server could not read, by list (server/failsafe.ts state;
   * shared/unreadable-rows.ts); or "not a list". Only when one could not be. Such
   * a list is never read as none: a stop awaiting its second signature may be the
   * row that could not be read.
   */
  unreadable?: Record<string, number | string>;
  /**
   * Of those rows of `awaitingSignatures` and `ready`, how many may be a stop
   * (server/failsafe.ts possibleStops): a row with no uuid whose action is a
   * stop's or cannot be read, or a row that is not a command at all. It cannot
   * be opened here, so the page says a stop may be awaiting a signature.
   */
  possibleStops?: Record<string, number>;
  /**
   * Whether `awaitingSignatures` and `ready` are all there is (server/failsafe.ts
   * morePastThePage): `true` when the control plane left commands out past its
   * page (its row or byte limit), `null` when it did not say. Absent when it
   * said it left none out. A list that may not be whole is never shown as whole.
   */
  more?: true | null;
}

/** Whether the in-flight lists may not be all there is: cut at the control plane's page, or not said (`more`). */
function maybePartial(view: FailsafeStateView): boolean {
  return view.more !== undefined;
}

/** The lists "Commands in flight" draws, and so the only ones whose unreadable rows it says. */
const IN_FLIGHT_LISTS = ["awaitingSignatures", "ready"] as const;

/**
 * The in-flight lists' unreadable rows, for "Commands in flight". `recent` is
 * not among them: the page never draws it (it is the control plane's history,
 * served empty under the service token this console reads with; the trail
 * below is the page's history), so its count is not said under commands it
 * does not show.
 */
function inFlightUnreadable(view: FailsafeStateView): { unreadable?: Record<string, number | string> } {
  const held = view.unreadable;
  if (!held) return {};
  const kept = Object.fromEntries(IN_FLIGHT_LISTS.filter((list) => list in held).map((list) => [list, held[list]]));
  return { unreadable: kept };
}

/** How many unreadable in-flight rows may be a stop (possibleStops), by list; numbers only. */
function possibleStopsIn(view: FailsafeStateView, list: (typeof IN_FLIGHT_LISTS)[number]): number {
  const count = view.possibleStops?.[list];
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;
}

/** A required-signature count as a reader is told it: "?" when the control plane did not say. */
function needOf(command: FailsafeCommand): string {
  return command.requiredSignatures === null ? "?" : String(command.requiredSignatures);
}

/**
 * A count of a state list as the tile shows it: the rows read, and a "+" when
 * some could not be -- never a bare 0 over a row nobody could read; "?" when the
 * list was not a list at all.
 */
function listFigure(view: FailsafeStateView, list: "awaitingSignatures" | "ready"): string | number {
  if (notAListIn(view, list)) return "?";
  // A list cut at the control plane's page (or not said to be whole) is at least what was read, never exactly it.
  return unreadableIn(view, list) > 0 || maybePartial(view) ? `${view[list].length}+` : view[list].length;
}

/** What the tile says under its count when rows of its list could not be read. */
function listUnread(view: FailsafeStateView | undefined, list: "awaitingSignatures" | "ready"): string | undefined {
  if (!view) return undefined;
  if (notAListIn(view, list)) return "The list could not be read";
  const count = unreadableIn(view, list);
  if (count > 0) return `${count === 1 ? "1 row" : `${count} rows`} could not be read`;
  if (view.more === true) return "More were left out than were listed";
  if (view.more === null) return "Not said to be all of them";
  return undefined;
}

interface FailsafeAuditEvent {
  uuid: string;
  timestamp: string;
  event: string;
  commandUuid: string | null;
  actor: string | null;
  detail: Record<string, unknown>;
}

/* ---- the five controls ------------------------------------------------ */

type ActionKey = "pause" | "resume" | "stand_down" | "release" | "terminate";

interface ActionSpec {
  key: ActionKey;
  label: string;
  gloss: string;
  icon: typeof Snowflake;
  /** Distinct operator signatures the engine will require. */
  signatures: number;
  /** critical draws the red panel + typed-id confirm; danger draws amber. */
  weight: "recover" | "danger" | "critical";
}

const ACTIONS: ActionSpec[] = [
  {
    key: "pause",
    label: "Pause",
    gloss: "Freeze the engine mid-action. It holds exactly where it is and does nothing until resumed.",
    icon: Snowflake,
    signatures: 1,
    weight: "danger",
  },
  {
    key: "resume",
    label: "Resume",
    gloss: "Allow a paused engine to act again, continuing from where it froze.",
    icon: Play,
    signatures: 1,
    weight: "recover",
  },
  {
    key: "stand_down",
    label: "Stand down",
    gloss: "Stop the engine, pull its software off wherever it was working, and send it home to idle. Two operators.",
    icon: Home,
    signatures: 2,
    weight: "danger",
  },
  {
    key: "release",
    label: "Release",
    gloss: "Manually release a stood-down engine from idle so it can be tasked again. Two operators.",
    icon: Unlock,
    signatures: 2,
    weight: "recover",
  },
  {
    key: "terminate",
    label: "Terminate",
    gloss: "Destroy the engine completely and irreversibly on the spot. Two operators, and you must type the engine id.",
    icon: Skull,
    signatures: 2,
    weight: "critical",
  },
];

const ACTION_BY_KEY: Record<string, ActionSpec> = Object.fromEntries(
  ACTIONS.map((a) => [a.key, a]),
);

/**
 * Whether an action stops the engine: pause, stand-down, terminate. These are
 * never gated on a read (see the header). Resume and release put an engine
 * back to work, and stay gated on the control plane having said it is ready.
 */
function isStop(action: string): boolean {
  const spec = ACTION_BY_KEY[action];
  return spec !== undefined && spec.weight !== "recover";
}

/** How soon a failed status read is retried: seconds, not the next 30s poll. */
const STATUS_RETRY_MS = 3_000;

/**
 * The query keys this page reads, as the app's default query function turns
 * them into URLs (lib/queryClient.ts): a string after the path becomes a path
 * segment, an object becomes the query string.
 *
 * The engine state was keyed ["/api/failsafe/state", engineId], which the
 * default query function sent as GET /api/failsafe/state/athena-1 -- a path
 * the server does not serve (404). The server reads the engine from
 * ?engineId=, so in every build with an engine named the governor, the counts
 * and the in-flight list -- the only way a second operator reaches a
 * stand-down or a terminate to co-sign it -- never read. The prefix
 * ["/api/failsafe/state"] still matches both for invalidation.
 */
export const failsafeStateKey = (engineId: string) => ["/api/failsafe/state", { engineId }] as const;
/** GET /api/failsafe/commands/:uuid -- a path segment, as the server serves it. */
export const failsafeCommandKey = (uuid: string) => ["/api/failsafe/commands", uuid] as const;

function actionLabel(key: string): string {
  return ACTION_BY_KEY[key]?.label ?? key;
}

/* ---- status colour language ------------------------------------------- */

function commandTone(status: string): StatusTone {
  switch (status) {
    case "ready":
      return "approved";
    case "consumed":
      return "complete";
    case "awaiting_signatures":
      return "progress";
    default:
      return "neutral"; // expired, canceled
  }
}

function commandStatusLabel(status: string): string {
  switch (status) {
    case "awaiting_signatures":
      return "Awaiting signatures";
    case "ready":
      return "Ready for the engine";
    case "consumed":
      return "Consumed";
    case "expired":
      return "Expired";
    case "canceled":
      return "Canceled";
    default:
      return status;
  }
}

function engineStateTone(state: string | null): StatusTone {
  switch (state) {
    case "running":
      return "passed";
    case "paused":
      return "progress";
    case "stood_down":
      return "review";
    default:
      return "neutral"; // terminated, or unknown
  }
}

/* ---- small helpers ---------------------------------------------------- */

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-2"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard denied (e.g. no https); the block is selectable anyway */
        }
      }}
      data-testid={`button-copy-${label}`}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : `Copy ${label}`}
    </Button>
  );
}

function relativeExpiry(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "expired";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s left` : `${secs}s left`;
}

/* ---- the co-sign console for one command ------------------------------ */
//
// Reused for a command the operator just drafted AND for one picked out of the
// in-flight list (so a SECOND operator, in their own session, can add the
// second signature). It fetches the authoritative draft + signing bytes from
// the control plane, so the bytes shown are exactly what the CLI reproduces.

function CommandConsole({
  uuid,
  onClose,
}: {
  uuid: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  // The client the page is mounted on: the one this console's command is read
  // through, so an invalidation here reaches the query that reads it. The
  // module's app client is that client only when the page is mounted on it.
  const client = useQueryClient();
  const [keyId, setKeyId] = useState("");
  const [signature, setSignature] = useState("");

  const commandQ = useQuery<DraftedCommand>({
    queryKey: failsafeCommandKey(uuid),
    // Poll while the command is still collecting signatures, so a second
    // operator's paste-back shows up here and a fill-up to `ready` is visible;
    // and while the read is failing, so it is read again without anyone asking.
    refetchInterval: (query) => {
      if (query.state.status === "error") return 3_000;
      const status = (query.state.data as DraftedCommand | undefined)?.command.status;
      return status === "awaiting_signatures" ? 3_000 : false;
    },
    // A command just drafted is seeded with the draft route's own answer (see
    // the page's draft.onSuccess). It is still read from the control plane on
    // opening, so what is shown is the authoritative command.
    refetchOnMount: "always",
  });
  // A poll that failed after one that succeeded leaves the last answer in the
  // cache. Its status and signer count are then a reading nobody has taken
  // since, so the error wins over it (see lib/loaded.ts).
  const command$ = loaded(commandQ);
  const data = command$.state === "ready" ? command$.data : undefined;
  // ...but a failed re-read must not take a STOP out of reach. The draft and
  // its signing bytes were fixed when the command was issued, so the last ones
  // read are still the ones to sign; the signature route checks the command
  // itself and refuses one that has expired, been canceled or filled up.
  const stale = command$.state === "error" ? commandQ.data : undefined;
  const relayStale =
    stale !== undefined && isStop(stale.command.action) && stale.command.status === "awaiting_signatures";

  const submit = useMutation({
    mutationFn: async () => {
      // The operator pastes the whole {"key_id","sig"} the CLI printed, or fills
      // the two fields. Accept either.
      let payload: { keyId: string; sig: string };
      const trimmed = signature.trim();
      if (trimmed.startsWith("{")) {
        const parsed = JSON.parse(trimmed) as { key_id?: string; sig?: string };
        if (!parsed.key_id || !parsed.sig) throw new Error("that JSON has no key_id/sig");
        payload = { keyId: parsed.key_id, sig: parsed.sig };
      } else {
        if (!keyId.trim() || !trimmed) throw new Error("paste the signer's key id and signature");
        payload = { keyId: keyId.trim(), sig: trimmed };
      }
      const response = await apiRequest("POST", `/api/failsafe/commands/${uuid}/signatures`, payload);
      return (await response.json()) as FailsafeCommand;
    },
    onSuccess: (command) => {
      setSignature("");
      setKeyId("");
      client.invalidateQueries({ queryKey: failsafeCommandKey(uuid) });
      client.invalidateQueries({ queryKey: ["/api/failsafe/state"] });
      client.invalidateQueries({ queryKey: ["/api/failsafe/audit"] });
      toast(
        command.status === "ready"
          ? { title: "Command ready", description: "The engine will verify and apply it on its next poll." }
          : {
            title: "Signature accepted",
            description: command.requiredSignatures === null
              ? `${command.signers.length} signed; how many it needs is not known (the control plane did not say).`
              : `${command.signers.length} of ${command.requiredSignatures} signatures.`,
          },
      );
    },
    onError: (error: Error) => {
      toast({ title: "The signature was not accepted", description: error.message, variant: "destructive" });
    },
  });

  const cancel = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/failsafe/commands/${uuid}/cancel`, {});
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["/api/failsafe/state"] });
      client.invalidateQueries({ queryKey: ["/api/failsafe/audit"] });
      toast({ title: "Command canceled" });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Could not cancel", description: error.message, variant: "destructive" });
    },
  });

  const unread = command$.state === "error" ? (
    <div className="space-y-4 py-2 text-center text-sm text-muted-foreground" data-testid="text-command-unread">
      <p>
        Could not read this command from the control plane: {command$.message}. Its status and signatures are
        not shown, because the last ones read may no longer be current.
        {relayStale &&
          " It is a stop, so signing and relaying stay available: the signature route checks the command itself" +
            " and says if it can no longer be signed."}
      </p>
      <div className="flex justify-center gap-3">
        <Button type="button" variant="outline" onClick={() => void commandQ.refetch()} data-testid="button-reread-command">
          Read it again
        </Button>
        {!relayStale && (
          <Button type="button" variant="outline" onClick={onClose} data-testid="button-close-console">
            Close
          </Button>
        )}
      </div>
    </div>
  ) : null;

  if (command$.state === "error" && !relayStale) return unread;
  const shown = data ?? (relayStale ? stale : undefined);
  if (!shown) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">Loading the command…</div>
    );
  }

  const { command, draft, signingBytes } = shown;
  const spec = ACTION_BY_KEY[command.action];
  const signed = command.signers.length;
  const need = command.requiredSignatures;
  const open = command.status === "awaiting_signatures";
  const draftJson = JSON.stringify(draft, null, 2);
  const cli = `mythos-failsafe sign --key YOUR_KEY.key --key-id YOUR_KEY_ID --draft draft.json`;

  return (
    <div className="space-y-5">
      {unread}
      {data && (
      <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {spec && (
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border/60 bg-surface-1/60">
              <spec.icon className="h-5 w-5 text-gold" />
            </span>
          )}
          <div>
            <div className="font-serif text-xl">{actionLabel(command.action)}</div>
            <div className="athena-mono text-xs text-muted-foreground">
              {command.engineId} · {relativeExpiry(command.expiresAt)}
            </div>
          </div>
        </div>
        <StatusPill tone={commandTone(command.status)}>{commandStatusLabel(command.status)}</StatusPill>
      </div>

      {/* signer progress: an unknown count is said, never drawn as the signatures already given */}
      <div className="flex items-center gap-3" data-testid="text-signer-progress">
        <div className="flex gap-1.5">
          {Array.from({ length: need ?? signed }).map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-2.5 w-8 rounded-full",
                i < signed ? "bg-emerald-500/80" : "bg-surface-2 border border-border/60",
              )}
            />
          ))}
        </div>
        <span className="text-sm text-muted-foreground">
          {need === null
            ? `${signed} signed; how many operator signatures it needs is not known (the control plane did not say)`
            : `${signed} of ${need} operator ${need === 1 ? "signature" : "signatures"}`}
          {command.signers.length > 0 && (
            <span className="athena-mono ml-2 text-xs text-gold-dim">({command.signers.join(", ")})</span>
          )}
        </span>
      </div>

      {command.status === "ready" && (
        <GlassCard ruling bodyClassName="flex items-start gap-3">
          <Radio className="mt-0.5 h-5 w-5 shrink-0 text-gold" />
          <p className="text-sm text-foreground/90">
            Fully signed. The engine will verify the signatures itself and apply this on its next poll.
            Nothing on this server can make it act sooner.
          </p>
        </GlassCard>
      )}
      </>
      )}
      {!data && (
        <div className="font-serif text-xl" data-testid="text-command-stale-action">
          {actionLabel(command.action)}{" "}
          <span className="athena-mono text-xs text-muted-foreground">· {command.engineId}</span>
        </div>
      )}

      {open && (
        <>
          <Divider className="my-1" />
          <div className="space-y-4">
            <div>
              <AthenaLabel>Step 1 — sign these exact bytes on your own machine</AthenaLabel>
              <p className="mt-1 text-sm text-muted-foreground">
                Your private key never enters this browser or the server. Save the draft below to{" "}
                <span className="athena-mono">draft.json</span> and sign it with the operator CLI.
              </p>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="athena-label">Draft to sign</span>
                <CopyButton text={draftJson} label="draft" />
              </div>
              <pre className="athena-mono max-h-56 overflow-auto rounded-lg border border-border/60 bg-surface-0/70 p-3 text-xs leading-relaxed">
                {draftJson}
              </pre>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="athena-label flex items-center gap-1.5">
                  <Terminal className="h-3.5 w-3.5" /> Command
                </span>
                <CopyButton text={cli} label="command" />
              </div>
              <pre className="athena-mono overflow-auto rounded-lg border border-border/60 bg-surface-0/70 p-3 text-xs">
                {cli}
              </pre>
              <p className="mt-1 text-xs text-muted-foreground">
                Signing bytes (for cross-checking):{" "}
                <span className="athena-mono break-all text-gold-dim">{signingBytes}</span>
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <AthenaLabel>Step 2 — paste back what the CLI printed</AthenaLabel>
                <p className="mt-1 text-sm text-muted-foreground">
                  Paste the whole <span className="athena-mono">{`{"key_id": …, "sig": …}`}</span> object, or fill the
                  fields.{" "}
                  {need === null
                    ? "How many signatures it needs is not known: a second, different operator may need to repeat steps 1–2 with their own key."
                    : need > 1 && "A second, different operator must repeat steps 1–2 with their own key."}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
                <div className="space-y-1.5">
                  <Label htmlFor="fs-key-id" className="text-xs">Key id (optional if pasting JSON)</Label>
                  <Input
                    id="fs-key-id"
                    value={keyId}
                    onChange={(e) => setKeyId(e.target.value)}
                    placeholder="alice"
                    className="athena-mono"
                    data-testid="input-signature-keyid"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="fs-sig" className="text-xs">Signature</Label>
                  <Textarea
                    id="fs-sig"
                    value={signature}
                    onChange={(e) => setSignature(e.target.value)}
                    placeholder={`{"key_id": "alice", "sig": "…"}`}
                    className="athena-mono h-20"
                    data-testid="input-signature"
                  />
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      <Divider className="my-1" />
      <div className="flex flex-wrap justify-between gap-3">
        {open && data ? (
          <Button
            type="button"
            variant="ghost"
            className="gap-2 text-muted-foreground"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            data-testid="button-cancel-command"
          >
            <Ban className="h-4 w-4" /> Cancel command
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-3">
          <Button type="button" variant="outline" onClick={onClose} data-testid="button-close-console">
            Close
          </Button>
          {open && (
            <Button
              type="button"
              className="gap-2"
              onClick={() => submit.mutate()}
              disabled={submit.isPending}
              data-testid="button-submit-signature"
            >
              <KeyRound className="h-4 w-4" />
              {submit.isPending ? "Submitting…" : "Submit signature"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- a command drafted with no id to open it by ------------------------ */
//
// The control plane drafted it, but its answer named no uuid (server/failsafe.ts
// draftCommand `unopenable`). It used to open an empty dialog: the draft to
// sign, its signing bytes and every way to act on it were hidden. Now it is
// shown with the reason it cannot be opened by its id, the draft to sign (the
// fields its signers sign are all here), and how to act on it: it is found by
// its nonce among the commands in flight -- the same command, with its id --
// and opened from there; until then, on the failsafe control plane.

/** The command in flight that a draft with no id is, found by its other identifiers: nonce, action and engine. */
function foundByNonce(drafted: DraftedCommand, inFlight: FailsafeCommand[]): FailsafeCommand | undefined {
  const nonce = drafted.draft.nonce || drafted.command.nonce;
  if (!nonce) return undefined;
  const action = drafted.draft.action || drafted.command.action;
  const engine = drafted.draft.engine_id || drafted.command.engineId;
  return inFlight.find((cmd) => cmd.uuid !== "" && cmd.nonce === nonce && cmd.action === action && cmd.engineId === engine);
}

function UnopenedDraft({
  drafted,
  inFlight,
  onOpen,
  onClose,
}: {
  drafted: DraftedCommand;
  inFlight: FailsafeCommand[];
  onOpen: (uuid: string) => void;
  onClose: () => void;
}) {
  const found = foundByNonce(drafted, inFlight);
  const nonce = drafted.draft.nonce || drafted.command.nonce;
  const action = drafted.draft.action || drafted.command.action;
  const engine = drafted.draft.engine_id || drafted.command.engineId;
  const draftJson = JSON.stringify(drafted.draft, null, 2);
  const why = drafted.unopenable ?? "the control plane's answer to the draft named no command id (uuid)";
  return (
    <div className="space-y-4" data-testid="unopened-draft">
      <div>
        <div className="font-serif text-xl">
          {actionLabel(action)}{" "}
          <span className="athena-mono text-xs text-muted-foreground">· {engine || "engine not named"}</span>
        </div>
        <p className="mt-1 text-sm text-amber-400" data-testid="text-unopened-why">
          Drafted, but it cannot be opened here by its id: {why}.
        </p>
      </div>
      {found ? (
        <GlassCard bodyClassName="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm" data-testid="text-unopened-found">
            Found among the commands in flight by its nonce <span className="athena-mono">{nonce}</span>: open it there
            to sign it, relay its signatures, or withdraw it.
          </p>
          <Button type="button" className="gap-2" onClick={() => onOpen(found.uuid)} data-testid="button-open-drafted">
            <KeyRound className="h-4 w-4" /> Open it
          </Button>
        </GlassCard>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="text-unopened-how">
          {nonce ? (
            <>
              How to act on it: sign the draft below now. This console looks for it by its nonce{" "}
              <span className="athena-mono">{nonce}</span> on every read of the commands in flight, and offers to open
              it here when it is listed; until then, find it on the failsafe control plane by that nonce to relay its
              signature or withdraw it.
            </>
          ) : (
            <>
              How to act on it: its answer named no nonce either, so it cannot be found here. Find it on the failsafe
              control plane (the newest {actionLabel(action).toLowerCase()} drafted for {engine || "this engine"}) to
              sign it, relay its signatures, or withdraw it.
            </>
          )}
        </p>
      )}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="athena-label">Draft to sign</span>
          <CopyButton text={draftJson} label="draft" />
        </div>
        <pre className="athena-mono max-h-56 overflow-auto rounded-lg border border-border/60 bg-surface-0/70 p-3 text-xs leading-relaxed" data-testid="text-unopened-draft-json">
          {draftJson}
        </pre>
        {drafted.signingBytes && (
          <p className="mt-1 text-xs text-muted-foreground">
            Signing bytes (for cross-checking):{" "}
            <span className="athena-mono break-all text-gold-dim">{drafted.signingBytes}</span>
          </p>
        )}
      </div>
      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={onClose} data-testid="button-close-unopened">
          Close
        </Button>
      </div>
    </div>
  );
}

/* ---- the page --------------------------------------------------------- */

interface FailsafeProps {
  /**
   * False on the change-password screen: an account that must change its
   * password may send every stop from this console, and is refused the activity
   * history (not a stop), so it is not read there.
   */
  showActivity?: boolean;
}

/** The failsafe console page, as the app's route mounts it. */
export default function Failsafe() {
  return <FailsafeConsole />;
}

/** The console itself, as the page and the change-password screen mount it. */
export function FailsafeConsole({ showActivity = true }: FailsafeProps) {
  const { toast } = useToast();
  // The client the page is mounted on and reads through: what it seeds and
  // invalidates reaches the queries it draws.
  const pageClient = useQueryClient();
  const [engineId, setEngineId] = useState("");
  const [engineIdTouched, setEngineIdTouched] = useState(false);

  // The action the operator is about to draft (confirmation stage).
  const [pending, setPending] = useState<ActionSpec | null>(null);
  const [reason, setReason] = useState("");
  const [typedId, setTypedId] = useState("");

  // The command whose console is open.
  const [openUuid, setOpenUuid] = useState<string | null>(null);
  // A command drafted with no id to open it by: shown, never hidden (UnopenedDraft).
  const [unopened, setUnopened] = useState<DraftedCommand | null>(null);

  // Every source on this console is polled, and React Query keeps the last
  // answer after a poll fails. Read raw, that answer went on rendering as the
  // current one: the governor said "running" and the counts held while every
  // read of the engine state was failing. So each is SHOWN through loaded(),
  // where an error wins over data it has since failed to refresh, and nothing
  // is shown from a status or state that is not in hand.
  //
  // What an operator can DO is another matter. For a while a failed status
  // poll also took the controls away: one network blip disabled pause,
  // stand-down and terminate, killed an armed confirmation, and hid the
  // stand-down a second operator had to sign -- for up to 30 seconds after
  // the control plane was back. A stop is never gated on a read now (see the
  // header); a failed status is re-read within seconds; and only resume and
  // release wait on a status read that answered, now, that the control plane
  // is ready.
  const statusQ = useQuery<FailsafeStatus>({
    queryKey: ["/api/failsafe/status"],
    refetchInterval: (query) => (query.state.status === "error" ? STATUS_RETRY_MS : 30_000),
  });
  const status$ = loaded(statusQ);
  const status = status$.state === "ready" ? status$.data : undefined;
  const statusFailed = status$.state === "error";
  const statusError = status$.state === "error" ? status$.message : "";
  /** The last status that answered, even if a later read failed: for the engine id only, never for showing. */
  const lastStatus = statusQ.data;

  // Default the engine id from the deployment, once, until the operator types.
  // From the last status that answered: an input's value is not a reading, and
  // losing it on a failed poll would take the stop's target away.
  const effectiveEngineId = engineIdTouched ? engineId : engineId || lastStatus?.defaultEngineId || "";
  const engineNamed = effectiveEngineId.trim().length > 0;

  /**
   * Whether the status in hand NOW says the control plane is usable: what the
   * page shows, and what resume and release wait on. They waited on the last
   * status that ever answered, so while every status read was failing -- the
   * page saying "Could not read the failsafe status" -- an engine could still
   * be put back to work from here. Putting one back to work waits for a
   * current read; a stop never does.
   */
  const canOperate = status?.configured === true && status?.authorized === true;
  /** Whether an action may be drafted and confirmed. A stop, whenever an engine is named. */
  const operable = (action: string) => engineNamed && (isStop(action) || canOperate);
  const stateReadable = canOperate && engineNamed;

  // Read unless a status that answered said there is nothing to read. A status
  // that failed, or has not answered, does not stop the state being read: the
  // in-flight commands it lists are how a second operator reaches a stop.
  const stateQ = useQuery<FailsafeStateView>({
    queryKey: failsafeStateKey(effectiveEngineId),
    enabled: engineNamed && (status === undefined || canOperate),
    refetchInterval: 5_000,
  });
  const state$ = loaded(stateQ);
  // Shown only while the status and the state are both in hand: a state read
  // under a status nobody can read now is not shown as current.
  const state = stateReadable && state$.state === "ready" ? state$.data : undefined;
  const stateFailed = stateReadable && state$.state === "error";
  // The commands the last state read listed as in flight, kept reachable while
  // that read is not shown as current. Each one's console reads it afresh.
  const lastInFlight = !state && stateQ.data ? [...stateQ.data.awaitingSignatures, ...stateQ.data.ready] : [];

  // The trail's body is a bare list; how many of its rows the server could not read rides in a header,
  // which the default query function reads for a query that names its list (meta.unreadableRows).
  const audit$ = loaded(useQuery<FailsafeAuditEvent[] | RowsRead<FailsafeAuditEvent>>({
    queryKey: ["/api/failsafe/audit"],
    enabled: canOperate && showActivity,
    refetchInterval: 15_000,
    meta: { unreadableRows: "events" },
  }));
  const auditRead = canOperate && showActivity && audit$.state === "ready" ? rowsRead<FailsafeAuditEvent>(audit$.data, "events") : undefined;
  const audit = auditRead?.rows;
  /** Whether rows of the trail could not be read: then it is never "no activity". */
  const auditUnread = auditRead !== undefined && unreadableIn(auditRead, "events") > 0;
  const auditFailed = canOperate && showActivity && audit$.state === "error";

  // The command counts and the governor state come from the engine's state
  // read. Until it has answered -- the control plane not ready, no engine
  // named, still loading, or failed -- they are unknown, not zero.
  const stateCount = (read: (view: FailsafeStateView) => number | string) =>
    state ? read(state) : stateFailed || !canOperate || !engineNamed ? "—" : "…";
  /** Whether rows of the in-flight lists could not be read: then there is never "none in flight". */
  const inFlightUnread = state !== undefined && (unreadableIn(state, "awaitingSignatures") > 0 || unreadableIn(state, "ready") > 0);
  /** Whether the in-flight lists may not be all there is (the control plane cut them, or did not say): never "none in flight". */
  const inFlightPartial = state !== undefined && maybePartial(state);
  const stateUnread = stateFailed
    ? `Could not read the engine state: ${state$.state === "error" ? state$.message : ""}`
    : statusFailed
      ? "Not read: the failsafe status could not be read."
      : !canOperate
        ? "Not read: the failsafe control plane is not ready."
        : !engineNamed
          ? "Not read: name a target engine."
          : "Reading the engine state…";

  const draft = useMutation({
    mutationFn: async (spec: ActionSpec) => {
      const response = await apiRequest("POST", "/api/failsafe/commands", {
        action: spec.key,
        engineId: effectiveEngineId,
        reason: reason.trim(),
      });
      return (await response.json()) as DraftedCommand;
    },
    onSuccess: (drafted) => {
      setPending(null);
      setReason("");
      setTypedId("");
      pageClient.invalidateQueries({ queryKey: ["/api/failsafe/state"] });
      pageClient.invalidateQueries({ queryKey: ["/api/failsafe/audit"] });
      // The draft route answered with the whole command -- the draft to sign
      // and its signing bytes -- and the console used to throw that away and
      // read it again. When that first read failed there was nothing to sign
      // and no Submit: a stop just drafted could not be relayed from here.
      // Seeded, a failed first read leaves the drafted stop signable (the
      // console's stale-stop path); the read still decides what is shown.
      if (!drafted.command.uuid) {
        // Drafted with no id: opening it by "" showed an empty dialog, the draft hidden. Shown, and why.
        setUnopened(drafted);
        toast({ title: "Command drafted", description: "It cannot be opened here by its id: see why, and how to act on it." });
        return;
      }
      pageClient.setQueryData(failsafeCommandKey(drafted.command.uuid), drafted);
      setOpenUuid(drafted.command.uuid);
      toast({ title: "Command drafted", description: "Sign it out of band, then paste the signature back." });
    },
    onError: (error: Error) => {
      toast({ title: "Could not draft the command", description: error.message, variant: "destructive" });
    },
  });

  const inFlight = useMemo(() => {
    if (!state) return [] as FailsafeCommand[];
    // awaiting first (they need action), then ready (waiting on the engine).
    return [...state.awaitingSignatures, ...state.ready];
  }, [state]);

  const terminateArmed =
    pending?.key === "terminate" ? typedId.trim() === effectiveEngineId.trim() && effectiveEngineId.length > 0 : true;

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-8">
      <PageHero
        title="Failsafe"
        subtitle="Pause, stand down, or terminate a Mythos engine — guarded actions, signed out of band, verified by the engine itself."
        background="storm"
        verbs={["Pause", "Stand down", "Terminate", "Verify"]}
        signoff={{ gold: ["Human", "Authority"], muted: "Over the machine" }}
      />
      <Divider variant="laurel" className="mt-5" />

      {/* configuration / reachability banner */}
      {!canOperate && (
        <GlassCard className="mt-5" bodyClassName="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-sev-high" />
          <div className="space-y-1">
            <div className="font-medium">
              {statusFailed
                ? "The failsafe status could not be read"
                : status
                  ? "The failsafe control plane is not ready"
                  : "Checking the failsafe control plane"}
            </div>
            <p className="text-sm text-muted-foreground" data-testid="text-failsafe-status">
              {statusFailed
                ? `Could not read the failsafe status: ${statusError}. Reading it again in a few seconds.`
                : status?.detail ?? "Checking the control plane…"}
            </p>
            <p className="text-sm text-muted-foreground" data-testid="text-stops-stay-live">
              Pause, stand-down and terminate stay available whatever this says: drafting or signing one asks the
              control plane itself, which says if it refuses, and the engine verifies every signature before it acts.
            </p>
          </div>
        </GlassCard>
      )}

      {/* live state header */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <GlassCard bodyClassName="space-y-2">
          <span className="athena-label">Engine governor</span>
          {!state ? (
            <div>
              <StatusPill tone="neutral">Not read</StatusPill>
              <p className="mt-1.5 text-xs text-muted-foreground">{stateUnread}</p>
            </div>
          ) : state.engineStateAvailable ? (
            <StatusPill tone={engineStateTone(state.engineState)}>{state.engineState ?? "unknown"}</StatusPill>
          ) : (
            <div>
              <StatusPill tone="neutral">Not reported</StatusPill>
              <p className="mt-1.5 text-xs text-muted-foreground">
                The engine does not yet publish its live governor state.
              </p>
            </div>
          )}
        </GlassCard>
        <StatCard
          label="Awaiting signatures"
          value={stateCount((view) => listFigure(view, "awaitingSignatures"))}
          sublabel={listUnread(state, "awaitingSignatures")}
          icon={KeyRound}
          layout="tile"
        />
        <StatCard
          label="Ready for engine"
          value={stateCount((view) => listFigure(view, "ready"))}
          sublabel={listUnread(state, "ready")}
          icon={Radio}
          layout="tile"
        />
        <GlassCard bodyClassName="space-y-2">
          <span className="athena-label">Target engine</span>
          <Input
            value={effectiveEngineId}
            onChange={(e) => {
              setEngineId(e.target.value);
              setEngineIdTouched(true);
            }}
            placeholder="athena-1"
            className="athena-mono"
            data-testid="input-engine-id"
          />
        </GlassCard>
      </div>

      {/* the controls */}
      <div className="mt-6">
        <AthenaLabel>Controls</AthenaLabel>
        <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {ACTIONS.map((spec) => (
            <GlassCard
              key={spec.key}
              className={cn(
                spec.weight === "critical" && "border-sev-critical/40",
              )}
              bodyClassName="flex h-full flex-col gap-3"
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "flex h-11 w-11 items-center justify-center rounded-full border",
                    spec.weight === "critical"
                      ? "border-sev-critical/50 bg-sev-critical/10 text-sev-critical"
                      : spec.weight === "danger"
                        ? "border-sev-high/40 bg-sev-high/10 text-sev-high"
                        : "border-border/60 bg-surface-1/60 text-muted-foreground",
                  )}
                >
                  <spec.icon className="h-5 w-5" />
                </span>
                <div>
                  <div className="font-serif text-lg leading-tight">{spec.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {spec.signatures === 1 ? "One operator" : "Two operators"}
                  </div>
                </div>
              </div>
              <p className="flex-1 text-sm text-muted-foreground">{spec.gloss}</p>
              <Button
                type="button"
                variant={spec.weight === "recover" ? "outline" : "default"}
                className={cn(
                  "w-full gap-2",
                  spec.weight === "critical" && "bg-sev-critical text-white hover:bg-sev-critical/90",
                )}
                disabled={!operable(spec.key)}
                onClick={() => {
                  setReason("");
                  setTypedId("");
                  setPending(spec);
                }}
                data-testid={`button-draft-${spec.key}`}
              >
                <spec.icon className="h-4 w-4" />
                Draft {spec.label.toLowerCase()}
              </Button>
            </GlassCard>
          ))}
        </div>
      </div>

      {/* in-flight commands */}
      <div className="mt-8">
        <AthenaLabel>Commands in flight</AthenaLabel>
        <div className="mt-3 space-y-3">
          {/* "None in flight" only about a state read that answered. */}
          {!state ? (
            <GlassCard bodyClassName="py-8 text-center text-sm text-muted-foreground" data-testid="text-inflight-unread">
              {stateUnread}
              {lastInFlight.length > 0 &&
                " The commands the last state read listed are below, so a stop still waiting for a second" +
                  " signature stays within reach; each one's current status is read when it is opened."}
            </GlassCard>
          ) : inFlight.length === 0 && !inFlightUnread && !inFlightPartial && (
            <GlassCard bodyClassName="py-8 text-center text-sm text-muted-foreground">
              No commands awaiting signatures or waiting on the engine.
            </GlassCard>
          )}
          {/* A list the control plane cut at its page, or did not say is whole: said, never shown as whole. */}
          {state && state.more !== undefined && (
            <p className="text-[12px] text-amber-400" data-testid="text-inflight-more" data-more={String(state.more)}>
              {state.more === true
                ? "More commands are in flight than the control plane listed: it left some out past its page (its row or" +
                  " byte limit), so this list is not all of them. A stop awaiting a signature may be among those left out:" +
                  " find it on the failsafe control plane to sign it."
                : "The control plane did not say whether this list is all the commands in flight, so it may not be. A stop" +
                  " awaiting a signature may be missing from it: check the failsafe control plane."}
            </p>
          )}
          {/* Rows of the state the server could not read: said, never read as none. */}
          {state && <UnreadableLists from={inFlightUnreadable(state)} />}
          {/* An unreadable row that may be a stop cannot be opened here: said, so its signature is sought where it can be given. */}
          {state && IN_FLIGHT_LISTS.filter((list) => possibleStopsIn(state, list) > 0).map((list) => (
            <p key={list} className="text-[12px] text-amber-400" data-testid="possible-stops" data-list={list} data-count={possibleStopsIn(state, list)}>
              {possibleStopsIn(state, list) === 1 ? "1 of them" : `${possibleStopsIn(state, list)} of them`} ({list === "ready" ? "ready" : "awaiting signatures"})
              {" "}may be a stop: it cannot be opened here, so find it on the failsafe control plane to sign it.
            </p>
          ))}
          {inFlight.map((cmd) => (
            <GlassCard key={cmd.uuid} bodyClassName="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-surface-1/60">
                  {(() => {
                    const Icon = ACTION_BY_KEY[cmd.action]?.icon ?? ShieldAlert;
                    return <Icon className="h-4 w-4 text-gold" />;
                  })()}
                </span>
                <div>
                  <div className="font-medium">
                    {actionLabel(cmd.action)}{" "}
                    <span className="athena-mono text-xs text-muted-foreground">· {cmd.engineId}</span>
                  </div>
                  <div className="athena-mono text-xs text-muted-foreground">
                    {cmd.signers.length}/{needOf(cmd)} signed · {relativeExpiry(cmd.expiresAt)}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <StatusPill tone={commandTone(cmd.status)}>{commandStatusLabel(cmd.status)}</StatusPill>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOpenUuid(cmd.uuid)}
                  data-testid={`button-open-${cmd.uuid}`}
                >
                  {cmd.status === "awaiting_signatures" ? "Sign / relay" : "View"}
                </Button>
              </div>
            </GlassCard>
          ))}
          {lastInFlight.map((cmd) => (
            <GlassCard
              key={cmd.uuid}
              bodyClassName="flex flex-wrap items-center justify-between gap-3"
              data-testid={`inflight-last-read-${cmd.uuid}`}
            >
              <div>
                <div className="font-medium">
                  {actionLabel(cmd.action)}{" "}
                  <span className="athena-mono text-xs text-muted-foreground">· {cmd.engineId}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Last read as {commandStatusLabel(cmd.status).toLowerCase()}. Not a current reading.
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setOpenUuid(cmd.uuid)}
                data-testid={`button-open-${cmd.uuid}`}
              >
                {cmd.status === "awaiting_signatures" ? "Sign / relay" : "View"}
              </Button>
            </GlassCard>
          ))}
        </div>
      </div>

      {/* audit trail */}
      <div className="mt-8">
        <AthenaLabel>Recent failsafe activity</AthenaLabel>
        <GlassCard className="mt-3" bodyClassName="p-0">
          <div className="divide-y divide-border/50">
            {/* "No activity recorded" only about an audit read that came back
                empty -- not one that failed, has not run, or cannot run. */}
            {!audit ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {!showActivity
                  ? "Failsafe activity is shown once the password is changed. Every stop works from here now."
                  : auditFailed
                  ? `Could not load failsafe activity: ${audit$.state === "error" ? audit$.message : ""}`
                  : !canOperate
                    ? "Failsafe activity is not readable until the control plane is ready."
                    : "Loading failsafe activity…"}
              </div>
            ) : audit.length === 0 && !auditUnread && (
              <div className="py-8 text-center text-sm text-muted-foreground">No failsafe activity recorded yet.</div>
            )}
            {auditUnread && (
              <div className="px-5 py-3">
                <UnreadableRows from={auditRead} list="events" label="failsafe activity" />
              </div>
            )}
            {(audit ?? []).slice(0, 20).map((event) => (
              <div key={event.uuid} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <span className="font-medium">{event.event.replace(/_/g, " ")}</span>
                  {event.actor && <span className="ml-2 text-sm text-muted-foreground">by {event.actor}</span>}
                </div>
                <span className="athena-mono shrink-0 text-xs text-muted-foreground">
                  {new Date(event.timestamp).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </GlassCard>
      </div>

      {/* ---- draft confirmation ---- */}
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent
          className={cn(pending?.weight === "critical" && "border-sev-critical/50")}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {pending && <pending.icon className="h-5 w-5" />}
              {pending ? `Draft: ${pending.label}` : ""}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 pt-1">
                <p>{pending?.gloss}</p>
                <p className="text-sm">
                  Target engine: <span className="athena-mono text-foreground">{effectiveEngineId || "—"}</span>.{" "}
                  {pending && pending.signatures > 1 && (
                    <span>This needs {pending.signatures} distinct operator signatures.</span>
                  )}
                </p>
                {pending?.weight === "critical" && (
                  <div className="rounded-lg border border-sev-critical/40 bg-sev-critical/5 p-3 text-sm text-foreground/90">
                    Terminate is <strong>irreversible</strong>: it destroys the engine completely, with a kill
                    attestation but nothing recoverable. Type the engine id to confirm.
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="fs-reason" className="text-xs">Reason (recorded in the audit trail)</Label>
              <Textarea
                id="fs-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this engine must be stopped"
                className="h-20"
                data-testid="input-reason"
              />
            </div>
            {pending?.weight === "critical" && (
              <div className="space-y-1.5">
                <Label htmlFor="fs-typed-id" className="text-xs">
                  Type the engine id (<span className="athena-mono">{effectiveEngineId}</span>) to confirm
                </Label>
                <Input
                  id="fs-typed-id"
                  value={typedId}
                  onChange={(e) => setTypedId(e.target.value)}
                  placeholder={effectiveEngineId}
                  className="athena-mono"
                  data-testid="input-typed-id"
                />
              </div>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-draft">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(pending?.weight === "critical" && "bg-sev-critical text-white hover:bg-sev-critical/90")}
              disabled={!pending || !operable(pending.key) || !terminateArmed || draft.isPending}
              onClick={(e) => {
                // Keep the dialog logic ours; only fire when armed. A stop is
                // not held back by a status read: the draft route decides.
                if (!pending || !terminateArmed || !operable(pending.key)) {
                  e.preventDefault();
                  return;
                }
                draft.mutate(pending);
              }}
              data-testid="button-confirm-draft"
            >
              {draft.isPending ? "Drafting…" : `Draft ${pending?.label.toLowerCase() ?? ""}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- command console ---- */}
      <Dialog open={openUuid !== null} onOpenChange={(open) => !open && setOpenUuid(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Failsafe command</DialogTitle>
            <DialogDescription>
              Sign out of band and relay the signatures. The engine verifies every command itself.
            </DialogDescription>
          </DialogHeader>
          {openUuid && <CommandConsole uuid={openUuid} onClose={() => setOpenUuid(null)} />}
        </DialogContent>
      </Dialog>

      {/* ---- a command drafted with no id ---- */}
      <Dialog open={unopened !== null} onOpenChange={(open) => !open && setUnopened(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Failsafe command drafted</DialogTitle>
            <DialogDescription>
              The control plane drafted it, but named no id to open it by here.
            </DialogDescription>
          </DialogHeader>
          {unopened && (
            <UnopenedDraft
              drafted={unopened}
              inFlight={[...inFlight, ...lastInFlight]}
              onOpen={(uuid) => {
                setUnopened(null);
                setOpenUuid(uuid);
              }}
              onClose={() => setUnopened(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
