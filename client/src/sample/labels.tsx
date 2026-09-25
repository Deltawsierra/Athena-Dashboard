/**
 * The words sample mode wears. One label, used on every panel it touches and
 * at the top of every page it touches, so the disclosure cannot drift between
 * screens and cannot be left off one.
 */
import { FlaskConical } from "lucide-react";

import { SAMPLE_MODE_ENV } from "./mode";

export const SAMPLE_LABEL = "Sample data — not from your environment";

/** The page-level banner. Not dismissible: it is the reason the page may show what it shows. */
export function SampleModeBanner() {
  return (
    <div
      role="note"
      data-testid="sample-mode-banner"
      className="athena-panel mt-5 flex items-start gap-3 p-4"
      style={{ borderColor: "hsl(var(--gold) / 0.6)", background: "hsl(var(--gold) / 0.06)" }}
    >
      <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-gold" />
      <div className="min-w-0">
        <p className="text-[13px] font-semibold uppercase tracking-[0.12em] text-gold">{SAMPLE_LABEL}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          Sample mode is on. Every panel marked as sample shows figures written for a
          demonstration; none of them was measured in your environment. This build was made
          with <code className="font-mono">{SAMPLE_MODE_ENV}=1</code>; build without it to see
          your own data.
        </p>
      </div>
    </div>
  );
}

/** The per-panel label. Sits inside the panel, so a crop of one card keeps it. */
export function SamplePanelLabel({ className }: { className?: string }) {
  return (
    <p
      data-testid="sample-panel-label"
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-gold ${className ?? ""}`}
      style={{ borderColor: "hsl(var(--gold) / 0.55)", background: "hsl(var(--gold) / 0.1)" }}
    >
      <FlaskConical className="h-3 w-3 shrink-0" />
      {SAMPLE_LABEL}
    </p>
  );
}
