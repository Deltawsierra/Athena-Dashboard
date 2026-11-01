/**
 * What the four authority screens share: the chips, the digests, the instants,
 * and the words for what is absent.
 *
 * Every value is shown as Athena-Backend served it. What it did not serve is said
 * in words ("not recorded", "not served", "not declared"), never drawn as a zero,
 * a blank or a green chip. Green is kept for a verdict the backend itself reached
 * on recorded data (a proven hop, a READY decision); an unknown or unread value
 * is never green.
 */
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import GlassCard from "@/components/GlassCard";
import { errorMessage, type Loaded } from "@/lib/loaded";
import { cn } from "@/lib/utils";

/** How a chip reads. `positive` is reserved for a verdict the backend reached on recorded data. */
export type Tone = "positive" | "info" | "caution" | "warning" | "critical" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  positive: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  info: "text-sky-400 border-sky-500/30 bg-sky-500/10",
  caution: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  warning: "text-orange-400 border-orange-500/30 bg-orange-500/10",
  critical: "text-sev-high border-sev-high/40 bg-sev-high/10",
  neutral: "text-muted-foreground border-border/60 bg-surface-1/50",
};

export function Chip({ tone, children, testId }: { tone: Tone; children: ReactNode; testId?: string }) {
  return (
    <span
      data-tone={tone}
      data-testid={testId}
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium", TONE_CLASS[tone])}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}

/** Something the backend did not serve, or served as absent: said in words, muted. */
export function Absent({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span data-absent="true" data-testid={testId} className="italic text-muted-foreground">
      {children}
    </span>
  );
}

/** A digest in full, monospaced: a reader compares digests, so none is cut short. */
export function Digest({ value, absent = "not recorded", testId }: { value: string | null; absent?: string; testId?: string }) {
  if (!value) return <Absent testId={testId}>{absent}</Absent>;
  return (
    <code data-testid={testId} className="break-all font-mono text-[11px] text-foreground/90">
      {value}
    </code>
  );
}

/** An instant as served (ISO 8601), or what stands in its place when none was. */
export function When({ iso, absent = "not recorded", testId }: { iso: string | null; absent?: string; testId?: string }) {
  if (!iso) return <Absent testId={testId}>{absent}</Absent>;
  return (
    <time data-testid={testId} dateTime={iso} className="font-mono text-[11px] text-foreground/90">
      {iso}
    </time>
  );
}

/** A count as served, or "not said" when the backend served none: never a zero nobody measured. */
export function Count({ value, testId }: { value: number | null; testId?: string }) {
  if (value === null) return <Absent testId={testId}>not said</Absent>;
  return (
    <span data-testid={testId} className="font-mono text-foreground">
      {value}
    </span>
  );
}

/** A labelled fact on one line. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

/** A screen's section: a card with a heading. */
export function Section({
  title,
  icon,
  children,
  testId,
  ruling = false,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  testId?: string;
  ruling?: boolean;
}) {
  return (
    <GlassCard hover={false} glow={false} ruling={ruling} bodyClassName="p-4 space-y-3" data-testid={testId}>
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
      </div>
      {children}
    </GlassCard>
  );
}

/**
 * What Athena-Backend records and does not serve to this console, named on the
 * screen that would show it, so its absence is never read as an empty record.
 */
export function NotServed({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p
      data-not-served="true"
      data-testid={testId}
      className="rounded-md border border-dashed border-border/70 bg-surface-1/40 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground"
    >
      {children}
    </p>
  );
}

/**
 * A source as a screen may read it. Like lib/loaded.ts, and stricter: data kept
 * on screen from the PREVIOUS key while the next one loads (the app's
 * keepPreviousData default) is another deployment's, so it reads as loading here.
 */
export function served<T>(query: UseQueryResult<T>): Loaded<T> {
  if (query.isError) return { state: "error", message: errorMessage(query.error) };
  if (query.data === undefined || query.isPlaceholderData) return { state: "loading" };
  return { state: "ready", data: query.data };
}

/** What a screen shows while its source is not in hand: reading, or why it could not be read. */
export function NotInHand({ source, what }: { source: Loaded<unknown>; what: string }) {
  if (source.state === "error") {
    return (
      <p data-testid="read-error" className="text-[13px] text-muted-foreground">
        Could not read {what}: {source.message}
      </p>
    );
  }
  return (
    <p data-testid="read-loading" className="text-[13px] text-muted-foreground">
      Reading {what}…
    </p>
  );
}

// ---- the six-state decision, in the backend's own labels ----

/** athena-backend assurance/models.py Deployment.Decision, value -> label. */
export const DECISION_LABELS: Record<string, string> = {
  ready: "Ready",
  ready_restricted: "Ready with restrictions",
  needs_more_evidence: "Requires additional evidence",
  audit_incomplete: "Audit incomplete",
  needs_remediation: "Requires remediation",
  not_recommended: "Not recommended",
  paused: "Deployment paused",
};

/**
 * How a decision state reads. Only READY is positive, and only as the decision
 * itself: AUDIT_INCOMPLETE says parts of the system were never assessed, and is
 * never drawn as a clear result. A state this console does not know is neutral.
 */
export function decisionTone(state: string | null, { asInput = false } = {}): Tone {
  switch (state) {
    case "ready":
      return asInput ? "info" : "positive";
    case "ready_restricted":
      return "info";
    case "needs_more_evidence":
    case "audit_incomplete":
      return "caution";
    case "needs_remediation":
      return "warning";
    case "not_recommended":
      return "critical";
    default:
      return "neutral";
  }
}

/** A decision state's label: the backend's, the one served beside it, or the raw value marked as unknown here. */
export function decisionLabel(state: string, served?: string | null): string {
  return DECISION_LABELS[state] ?? served ?? `not recognised here: ${state}`;
}

// ---- a tool registration ----

/** The registration kinds that carry a tool contract (athena-backend assurance/tool_contract.py TOOL_KINDS). */
export const TOOL_KINDS = ["tool", "mcp_server", "skill"] as const;

const TOOL_KIND_LABELS: Record<string, string> = { tool: "Tool", mcp_server: "MCP server", skill: "Agent skill" };

export function toolKindLabel(kind: string): string {
  return TOOL_KIND_LABELS[kind] ?? kind;
}

/** A tool as an approval or an effect names it: its kind and its identifier. */
export function ToolName({ kind, identifier }: { kind: string; identifier: string }) {
  return (
    <span className="text-foreground">
      <span className="text-muted-foreground">{toolKindLabel(kind)}</span>{" "}
      {identifier ? <code className="font-mono text-[12px]">{identifier}</code> : <Absent>no identifier</Absent>}
    </span>
  );
}

/** A composition's status census, every status as served with its count. */
export const CENSUS_LABELS: Record<string, string> = {
  held: "Held",
  violated: "Violated",
  incomplete: "Incomplete",
  not_demonstrated: "Not demonstrated",
};

export function censusTone(status: string): Tone {
  if (status === "violated") return "critical";
  if (status === "incomplete" || status === "not_demonstrated") return "caution";
  return "neutral";
}
