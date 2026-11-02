/**
 * A URL the app did not build, shown as text with a copy button. Never a link.
 *
 * The scanned target controls most of these strings: a finding's endpoint or
 * location, a request URL, a link in evidence. A link drawn from one would open
 * a URL the target chose, on one click, from the console a person uses to
 * inspect that target. An operator types the rest into the app's own data, such
 * as a document's file URL (StoredUrl), and the same holds for those. So the
 * string is shown as the characters it is (React escapes it, so markup in it is
 * text), and the button beside it puts exactly that string on the clipboard and
 * nothing else. Opening it is a separate, deliberate act, in whatever the person
 * chooses.
 *
 * `httpOnly` (a URL stored in the app's data): only an http(s) URL is copyable.
 * Any other scheme -- javascript:, file:, data:, a bare word -- is shown as
 * inert text and flagged, with no copy button. A target's place stays copyable
 * whatever it is, because it is often no URL at all (a header name, a path).
 *
 * The desktop shell holds the same line underneath: its window-open handler
 * opens no URL in the system browser (electron-main.cjs). The rule lives here,
 * in one component, so a screen that shows such a URL uses this and does not
 * draw an <a href> of its own (README, "Target URLs are text").
 */
import { useState, type MouseEvent } from "react";
import { Check, Copy, X } from "lucide-react";

import { cn } from "@/lib/utils";

type Copied = "copied" | "failed" | null;

const LABEL: Record<Exclude<Copied, null> | "idle", string> = {
  idle: "Copy to the clipboard",
  copied: "Copied to the clipboard",
  failed: "Could not copy: the clipboard refused",
};

/** Said beside a stored URL that is not http(s): it is shown, and nothing more is done with it. */
export const NOT_HTTP = "not an http(s) address: shown as text only";

/** Whether `value` parses as an absolute http: or https: URL. */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export default function TargetUrl({ value, className, httpOnly = false }: { value: string; className?: string; httpOnly?: boolean }) {
  const [copied, setCopied] = useState<Copied>(null);
  const copy = async (event: MouseEvent<HTMLButtonElement>) => {
    // A card or row around it may have a click of its own.
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  // Nothing to show, nothing to copy: no empty line with a button beside it.
  if (value === "") return null;
  if (httpOnly && !isHttpUrl(value)) {
    return (
      <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1 align-bottom", className)} data-testid="target-url" data-inert="true">
        <span className="min-w-0 truncate" data-testid="text-target-url">{value}</span>
        <span className="shrink-0 rounded border border-border/60 px-1 text-[10px] text-sev-medium" data-testid="text-url-not-http">
          {NOT_HTTP}
        </span>
      </span>
    );
  }
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
