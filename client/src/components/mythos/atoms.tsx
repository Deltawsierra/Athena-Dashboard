/**
 * The small shared parts every Mythos page is assembled from. Kept in one file
 * so a pill or a bar means the same thing on Risks as it does on Compliance.
 */
import { ArrowDown, ArrowUp, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/* --- labels ------------------------------------------------------------- */
export function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("athena-label", className)}>{children}</p>;
}

/* --- delta (up/down vs a period) --------------------------------------- */
export function Delta({
  value,
  direction,
  good,
  note,
}: {
  value: string;
  direction: "up" | "down";
  /** Whether this direction is good news (green) or bad (red). */
  good?: boolean;
  note?: string;
}) {
  const Icon = direction === "up" ? ArrowUp : ArrowDown;
  const color = good ? "text-emerald-400" : "text-sev-high";
  return (
    <span className="inline-flex items-baseline gap-1.5 text-[12px]">
      <span className={cn("inline-flex items-center gap-0.5 font-medium", color)}>
        <Icon className="h-3 w-3" />
        {value}
      </span>
      {note && <span className="text-muted-foreground">{note}</span>}
    </span>
  );
}

/* --- severity pill (reserved colours only) ----------------------------- */
export type Severity = "critical" | "high" | "medium" | "low" | "info";
const SEV_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};
export function SeverityPill({ severity }: { severity: Severity }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold"
      style={{
        color: `hsl(var(--sev-${severity}))`,
        borderColor: `hsl(var(--sev-${severity}) / 0.4)`,
        background: `hsl(var(--sev-${severity}) / 0.1)`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(var(--sev-${severity}))` }} />
      {SEV_LABEL[severity]}
    </span>
  );
}

/* --- status pill (semantic tones) -------------------------------------- */
export type StatusTone = "complete" | "progress" | "approved" | "passed" | "review" | "neutral";
const STATUS_TONE: Record<StatusTone, string> = {
  complete: "emerald",
  approved: "emerald",
  passed: "emerald",
  progress: "amber",
  review: "sky",
  neutral: "zinc",
};
export function StatusPill({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  const map: Record<string, string> = {
    emerald: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
    amber: "text-amber-400 border-amber-500/30 bg-amber-500/10",
    sky: "text-sky-400 border-sky-500/30 bg-sky-500/10",
    zinc: "text-muted-foreground border-border/60 bg-surface-1/50",
  };
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium", map[STATUS_TONE[tone]])}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/* --- deployment decision pill (six-state) ------------------------------ */
// The Mythos shared decision vocabulary. `null` is a real state — a deployment
// with no assessment yet has no decision, and an absent decision is never Ready.
export type Decision =
  | "ready"
  | "ready_restricted"
  | "needs_more_evidence"
  | "needs_remediation"
  | "not_recommended"
  | "paused"
  | null;
const DECISION_LABEL: Record<string, string> = {
  ready: "Ready",
  ready_restricted: "Ready · restricted",
  needs_more_evidence: "More evidence",
  needs_remediation: "Remediation",
  not_recommended: "Not recommended",
  paused: "Paused",
};
const DECISION_CLASS: Record<string, string> = {
  ready: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  ready_restricted: "text-sky-400 border-sky-500/30 bg-sky-500/10",
  needs_more_evidence: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  needs_remediation: "text-orange-400 border-orange-500/30 bg-orange-500/10",
  not_recommended: "text-sev-high border-sev-high/40 bg-sev-high/10",
  paused: "text-muted-foreground border-border/60 bg-surface-1/50",
  unassessed: "text-muted-foreground border-border/60 bg-surface-1/50",
};
export function DecisionPill({ decision, label }: { decision: Decision; label?: string }) {
  const key = decision ?? "unassessed";
  const text = label || DECISION_LABEL[key ?? ""] || "Not assessed";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-semibold",
        DECISION_CLASS[key] ?? DECISION_CLASS.unassessed,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {text}
    </span>
  );
}

/* --- evidence class chip (how strongly a thing is known) --------------- */
// The evidence taxonomy, strongest to weakest. The chip's whole job is to keep
// an assumption from reading like a fact, so the weaker classes are visibly
// muted rather than reassuring.
export type EvidenceClass =
  | "technically_verified"
  | "configuration_verified"
  | "document_supported"
  | "contractually_stated"
  | "vendor_asserted"
  | "partially_verified"
  | "unknown"
  | "not_documented";
const EVIDENCE_LABEL: Record<string, string> = {
  technically_verified: "Technically verified",
  configuration_verified: "Config verified",
  document_supported: "Document supported",
  contractually_stated: "Contractually stated",
  vendor_asserted: "Vendor asserted",
  partially_verified: "Partially verified",
  unknown: "Unknown",
  not_documented: "Not documented",
};
const EVIDENCE_CLASS: Record<string, string> = {
  technically_verified: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  configuration_verified: "text-teal-300 border-teal-500/30 bg-teal-500/10",
  document_supported: "text-sky-400 border-sky-500/30 bg-sky-500/10",
  contractually_stated: "text-sky-300/80 border-sky-500/20 bg-sky-500/[0.06]",
  vendor_asserted: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  partially_verified: "text-amber-300/90 border-amber-500/25 bg-amber-500/[0.08]",
  unknown: "text-muted-foreground border-border/60 bg-surface-1/50",
  not_documented: "text-muted-foreground border-dashed border-border/70 bg-surface-1/40",
};
export function EvidenceClassChip({ value, label }: { value: string; label?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
        EVIDENCE_CLASS[value] ?? EVIDENCE_CLASS.unknown,
      )}
      title="How strongly this is known"
    >
      {label || EVIDENCE_LABEL[value] || value || "Unknown"}
    </span>
  );
}

/* --- asset classification chip (how an asset is governed) -------------- */
// The asset governance taxonomy for the assurance graph. The chip leads with
// the classifications that need attention: an unmanaged or high-risk asset must
// not read as reassuringly as an approved one, so the weaker states carry the
// alarming tones and an unrecognised value degrades to muted rather than blank.
export type AssetClass =
  | "high_risk"
  | "unmanaged"
  | "unknown"
  | "known"
  | "approved"
  | "retired";
const ASSET_CLASS_LABEL: Record<string, string> = {
  high_risk: "High risk",
  unmanaged: "Unmanaged",
  unknown: "Unknown",
  known: "Known",
  approved: "Approved",
  retired: "Retired",
};
const ASSET_CLASS_CLASS: Record<string, string> = {
  high_risk: "text-sev-high border-sev-high/40 bg-sev-high/10",
  unmanaged: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  unknown: "text-muted-foreground border-border/60 bg-surface-1/50",
  known: "text-sky-400 border-sky-500/30 bg-sky-500/10",
  approved: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  retired: "text-muted-foreground border-dashed border-border/70 bg-surface-1/40",
};
export function AssetClassChip({ value, label }: { value: string; label?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
        ASSET_CLASS_CLASS[value] ?? ASSET_CLASS_CLASS.unknown,
      )}
      title="How this asset is governed"
    >
      {label || ASSET_CLASS_LABEL[value] || value || "Unknown"}
    </span>
  );
}

/* --- coverage / meter bar ---------------------------------------------- */
export function Meter({ percent, tone = "gold" }: { percent: number; tone?: "gold" | "emerald" | "sev" }) {
  const bar =
    tone === "emerald"
      ? "bg-emerald-500"
      : tone === "sev"
        ? percent >= 80
          ? "bg-emerald-500"
          : percent >= 50
            ? "bg-amber-500"
            : "bg-sev-high"
        : "bg-gradient-to-r from-gold-dim to-gold";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
      <div className={cn("h-full rounded-full", bar)} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

/* --- initials avatar ---------------------------------------------------- */
export function Avatar({ name, sub, size = 32 }: { name: string; sub?: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="flex shrink-0 items-center justify-center rounded-full border border-gold-dim/40 bg-gradient-to-br from-primary/25 to-surface-2 text-[11px] font-semibold text-foreground"
        style={{ width: size, height: size }}
      >
        {initials}
      </span>
      {(sub || name) && (
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-[13px] text-foreground">{name}</span>
          {sub && <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>}
        </span>
      )}
    </div>
  );
}

/* --- numbered / checked timeline --------------------------------------- */
export interface TimelineStep {
  title: string;
  detail?: string;
  state: "done" | "active" | "todo";
}
export function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="space-y-4">
      {steps.map((s, i) => (
        <li key={s.title} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold",
                s.state === "done"
                  ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400"
                  : s.state === "active"
                    ? "border-primary bg-primary/15 text-primary shadow-[var(--glow-primary)]"
                    : "border-border/60 bg-surface-1/50 text-muted-foreground",
              )}
            >
              {s.state === "done" ? "✓" : i + 1}
            </span>
            {i < steps.length - 1 && <span className="mt-1 w-px flex-1 bg-border/50" />}
          </div>
          <div className="pb-1">
            <p className={cn("text-[13px] font-medium", s.state === "todo" ? "text-muted-foreground" : "text-foreground")}>
              {s.title}
            </p>
            {s.detail && <p className="mt-0.5 text-[12px] text-muted-foreground">{s.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* --- framework badge tile ---------------------------------------------- */
export function FrameworkBadge({
  abbr,
  name,
  state,
  active,
  icon: Icon,
}: {
  abbr: string;
  name: string;
  state: string;
  active?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <button
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-center transition-colors",
        active
          ? "border-primary/60 bg-primary/[0.06] shadow-[var(--glow-primary)]"
          : "border-border/60 bg-surface-0/50 hover:border-primary/40",
      )}
    >
      <span
        className={cn(
          "flex h-11 w-11 items-center justify-center rounded-full border text-[12px] font-bold",
          active ? "border-primary/50 text-primary" : "border-border/60 text-muted-foreground",
        )}
      >
        {Icon ? <Icon className="h-5 w-5" /> : abbr}
      </span>
      <span className="text-[13px] font-medium text-foreground">{name}</span>
      <span className={cn("text-[11px]", active ? "text-primary" : "text-muted-foreground")}>{state}</span>
    </button>
  );
}
