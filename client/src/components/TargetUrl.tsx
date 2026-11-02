/**
 * A URL the scanned target supplied, shown as text with a copy button. Never a link.
 *
 * The target controls these strings: a finding's endpoint or location, a request
 * URL, a link in evidence. A link drawn from one would open a URL the target
 * chose, on one click, from the console a person uses to inspect that target.
 * So the string is shown as the characters it is (React escapes it, so markup in
 * it is text), and the button beside it puts exactly that string on the
 * clipboard and nothing else. Opening it is a separate, deliberate act, in
 * whatever the person chooses.
 *
 * The desktop shell holds the same line underneath: its window-open handler
 * opens no URL in the system browser (electron-main.cjs). The rule lives here,
 * in one component, so a screen that shows such a URL uses this and does not
 * draw an <a href> of its own (README, "Target URLs are text").
 */
import { useState } from "react";
import { Check, Copy, X } from "lucide-react";

import { cn } from "@/lib/utils";

type Copied = "copied" | "failed" | null;

const LABEL: Record<Exclude<Copied, null> | "idle", string> = {
  idle: "Copy to the clipboard",
  copied: "Copied to the clipboard",
  failed: "Could not copy: the clipboard refused",
};

export default function TargetUrl({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState<Copied>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  // Nothing to show, nothing to copy: no empty line with a button beside it.
  if (value === "") return null;
  const label = LABEL[copied ?? "idle"];
  const Icon = copied === "copied" ? Check : copied === "failed" ? X : Copy;
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1 align-bottom", className)} data-testid="target-url">
      <span className="min-w-0 truncate" data-testid="text-target-url">{value}</span>
      {/* No text in the button, only its label: the cell's text stays the URL alone. */}
      <button
        type="button"
        onClick={copy}
        aria-label={label}
        title={label}
        data-copied={copied ?? undefined}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-primary"
        data-testid="button-copy-target-url"
      >
        <Icon className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  );
}
