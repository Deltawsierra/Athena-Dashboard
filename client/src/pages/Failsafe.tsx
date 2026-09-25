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
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { errorMessage } from "@/lib/loaded";
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
import { apiRequest, queryClient } from "@/lib/queryClient";
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
  requiredSignatures: number;
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
}

interface FailsafeStateView {
  engineId: string | null;
  engineState: string | null;
  engineStateAvailable: boolean;
  awaitingSignatures: FailsafeCommand[];
  ready: FailsafeCommand[];
  recent: FailsafeCommand[];
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
  const [keyId, setKeyId] = useState("");
  const [signature, setSignature] = useState("");

  const { data, isLoading } = useQuery<DraftedCommand>({
    queryKey: ["/api/failsafe/commands", uuid],
    // Poll while the command is still collecting signatures, so a second
    // operator's paste-back shows up here and a fill-up to `ready` is visible.
    refetchInterval: (query) => {
      const status = (query.state.data as DraftedCommand | undefined)?.command.status;
      return status === "awaiting_signatures" ? 3_000 : false;
    },
  });

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
      queryClient.invalidateQueries({ queryKey: ["/api/failsafe/commands", uuid] });
      queryClient.invalidateQueries({ queryKey: ["/api/failsafe/state"] });
      queryClient.invalidateQueries({ queryKey: ["/api/failsafe/audit"] });
      toast(
        command.status === "ready"
          ? { title: "Command ready", description: "The engine will verify and apply it on its next poll." }
          : { title: "Signature accepted", description: `${command.signers.length} of ${command.requiredSignatures} signatures.` },
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
      queryClient.invalidateQueries({ queryKey: ["/api/failsafe/state"] });
      queryClient.invalidateQueries({ queryKey: ["/api/failsafe/audit"] });
      toast({ title: "Command canceled" });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Could not cancel", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading || !data) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">Loading the command…</div>
    );
  }

  const { command, draft, signingBytes } = data;
  const spec = ACTION_BY_KEY[command.action];
  const signed = command.signers.length;
  const need = command.requiredSignatures;
  const open = command.status === "awaiting_signatures";
  const draftJson = JSON.stringify(draft, null, 2);
  const cli = `mythos-failsafe sign --key YOUR_KEY.key --key-id YOUR_KEY_ID --draft draft.json`;

  return (
    <div className="space-y-5">
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

      {/* signer progress */}
      <div className="flex items-center gap-3">
        <div className="flex gap-1.5">
          {Array.from({ length: need }).map((_, i) => (
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
          {signed} of {need} operator {need === 1 ? "signature" : "signatures"}
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
                  fields. {need > 1 && "A second, different operator must repeat steps 1–2 with their own key."}
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
        {open ? (
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

/* ---- the page --------------------------------------------------------- */

export default function Failsafe() {
  const { toast } = useToast();
  const [engineId, setEngineId] = useState("");
  const [engineIdTouched, setEngineIdTouched] = useState(false);

  // The action the operator is about to draft (confirmation stage).
  const [pending, setPending] = useState<ActionSpec | null>(null);
  const [reason, setReason] = useState("");
  const [typedId, setTypedId] = useState("");

  // The command whose console is open.
  const [openUuid, setOpenUuid] = useState<string | null>(null);

  const {
    data: status,
    isError: statusFailed,
    error: statusError,
  } = useQuery<FailsafeStatus>({
    queryKey: ["/api/failsafe/status"],
    refetchInterval: 30_000,
  });

  // Default the engine id from the deployment, once, until the operator types.
  const effectiveEngineId = engineIdTouched ? engineId : engineId || status?.defaultEngineId || "";

  const configured = status?.configured === true;
  const authorized = status?.authorized === true;
  const canOperate = configured && authorized;

  const {
    data: state,
    isError: stateFailed,
    error: stateError,
  } = useQuery<FailsafeStateView>({
    queryKey: ["/api/failsafe/state", effectiveEngineId],
    enabled: canOperate && effectiveEngineId.length > 0,
    refetchInterval: 5_000,
  });

  const {
    data: audit = [],
    isSuccess: auditRead,
    isError: auditFailed,
    error: auditError,
  } = useQuery<FailsafeAuditEvent[]>({
    queryKey: ["/api/failsafe/audit"],
    enabled: canOperate,
    refetchInterval: 15_000,
  });

  // The command counts and the governor state come from the engine's state
  // read. Until it has answered -- the control plane not ready, no engine
  // named, still loading, or failed -- they are unknown, not zero.
  const stateCount = (read: (view: FailsafeStateView) => number) =>
    state ? read(state) : stateFailed || !canOperate || effectiveEngineId.length === 0 ? "—" : "…";
  const stateUnread = stateFailed
    ? `Could not read the engine state: ${errorMessage(stateError)}`
    : !canOperate
      ? "Not read: the failsafe control plane is not ready."
      : effectiveEngineId.length === 0
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
      queryClient.invalidateQueries({ queryKey: ["/api/failsafe/state"] });
      queryClient.invalidateQueries({ queryKey: ["/api/failsafe/audit"] });
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
            <div className="font-medium">The failsafe control plane is not ready</div>
            <p className="text-sm text-muted-foreground">
              {statusFailed
                ? `Could not read the failsafe status: ${errorMessage(statusError)}`
                : status?.detail ?? "Checking the control plane…"}
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
          value={stateCount((view) => view.awaitingSignatures.length)}
          icon={KeyRound}
          layout="tile"
        />
        <StatCard label="Ready for engine" value={stateCount((view) => view.ready.length)} icon={Radio} layout="tile" />
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
            disabled={!canOperate}
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
                disabled={!canOperate || effectiveEngineId.length === 0}
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
          {inFlight.length === 0 && (
            <GlassCard bodyClassName="py-8 text-center text-sm text-muted-foreground">
              No commands awaiting signatures or waiting on the engine.
            </GlassCard>
          )}
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
                    {cmd.signers.length}/{cmd.requiredSignatures} signed · {relativeExpiry(cmd.expiresAt)}
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
        </div>
      </div>

      {/* audit trail */}
      <div className="mt-8">
        <AthenaLabel>Recent failsafe activity</AthenaLabel>
        <GlassCard className="mt-3" bodyClassName="p-0">
          <div className="divide-y divide-border/50">
            {/* "No activity recorded" only about an audit read that came back
                empty -- not one that failed, has not run, or cannot run. */}
            {!auditRead ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {auditFailed
                  ? `Could not load failsafe activity: ${errorMessage(auditError)}`
                  : !canOperate
                    ? "Failsafe activity is not readable until the control plane is ready."
                    : "Loading failsafe activity…"}
              </div>
            ) : audit.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">No failsafe activity recorded yet.</div>
            )}
            {audit.slice(0, 20).map((event) => (
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
              disabled={!terminateArmed || draft.isPending}
              onClick={(e) => {
                // Keep the dialog logic ours; only fire when armed.
                if (!pending || !terminateArmed) {
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
    </div>
  );
}
