/**
 * The metric card that heads every page. Two layouts cover the references: a
 * "stat" (label above, ringed icon in the corner, a big figure, a delta line)
 * and a "tile" (a ringed icon on the left, figure and label to its right).
 */
import { type ReactNode } from "react";
import { type LucideIcon } from "lucide-react";
import GlassCard from "@/components/GlassCard";
import { cn } from "@/lib/utils";
import { Delta } from "./atoms";

interface DeltaSpec {
  value: string;
  direction: "up" | "down";
  good?: boolean;
  note?: string;
}

interface StatCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  layout?: "stat" | "tile";
  delta?: DeltaSpec;
  sublabel?: string;
  /** Optional tint for the ringed icon, e.g. a severity colour. */
  accent?: string;
  className?: string;
  /**
   * Rendered above everything else in the card -- e.g. the sample-data label,
   * which has to sit inside the card so a crop of one card still carries it.
   */
  tag?: ReactNode;
  "data-testid"?: string;
}

function Ring({ icon: Icon, accent }: { icon: LucideIcon; accent?: string }) {
  return (
    <span
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border"
      style={{
        borderColor: accent ? `hsl(${accent} / 0.4)` : "hsl(var(--gold-dim) / 0.5)",
        color: accent ? `hsl(${accent})` : "hsl(var(--gold))",
        background: accent ? `hsl(${accent} / 0.08)` : "hsl(var(--gold) / 0.05)",
      }}
    >
      <Icon className="h-5 w-5" />
    </span>
  );
}

export default function StatCard({
  label,
  value,
  icon,
  layout = "stat",
  delta,
  sublabel,
  accent,
  className,
  tag,
  "data-testid": testId,
}: StatCardProps) {
  if (layout === "tile") {
    const row = (
      <>
        <Ring icon={icon} accent={accent} />
        <div className="min-w-0">
          <p className="athena-label">{label}</p>
          <p className="mt-1 flex items-baseline gap-2">
            <span className="athena-figure text-[30px] font-semibold leading-none text-foreground">{value}</span>
            {delta && <Delta {...delta} />}
          </p>
          {sublabel && <p className="mt-1 text-[11px] text-muted-foreground">{sublabel}</p>}
        </div>
      </>
    );
    return (
      <GlassCard
        hover={false}
        bodyClassName={tag ? "space-y-3" : "flex items-center gap-4"}
        className={className}
        data-testid={testId}
      >
        {tag ? (
          <>
            {tag}
            <div className="flex items-center gap-4">{row}</div>
          </>
        ) : (
          row
        )}
      </GlassCard>
    );
  }

  return (
    <GlassCard hover={false} className={cn("flex flex-col", className)} data-testid={testId}>
      {tag && <div className="mb-3">{tag}</div>}
      <div className="flex items-start justify-between">
        <p className="athena-label max-w-[8rem] leading-tight">{label}</p>
        <Ring icon={icon} accent={accent} />
      </div>
      <p className="mt-3 flex items-baseline gap-3">
        <span className="athena-figure text-[34px] font-semibold leading-none text-foreground">{value}</span>
        {delta && <Delta {...delta} />}
      </p>
      {sublabel && <p className="mt-1.5 text-[11px] text-muted-foreground">{sublabel}</p>}
    </GlassCard>
  );
}
