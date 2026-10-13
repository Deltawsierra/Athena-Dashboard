/**
 * A Financial Exposure Receipt's signed bytes, downloaded through this server's
 * relay (server/economics.ts, `/api/economics/receipt`) and saved only when they
 * agree with what is shown (shared/economics-receipt.ts):
 *
 *   1. their SHA-256 is the one Athena-Backend sent with them (`X-Content-SHA256`);
 *   2. the envelope's payload is the document whose digest the report shows
 *      (`receipt.document_digest`, on screen beside this).
 *
 * The relay checks both before it sends a byte; the page checks them again on the
 * bytes it received, before it saves one, so what is saved is what is shown. On a
 * disagreement, a missing header, or any refusal, nothing is saved and the reason
 * is shown. The bytes are saved exactly as they came: never parsed into the file,
 * never re-encoded.
 *
 * SAFETY: the read is a GET under the relay's read deadline, and the page passes
 * it an AbortSignal: leaving the view, or showing another result, aborts it, so a
 * receipt nobody waits for never keeps one of the browser's few connections to
 * this server, which a stop needs.
 */
import { useEffect, useRef, useState } from "react";
import { SHA256_DIGEST, hexOf, receiptFileName, receiptIdOf, signedDocumentSpelling } from "@shared/economics-receipt";
import { ApiError, throwIfResNotOk } from "@/lib/queryClient";
import { text, type Doc } from "@/lib/economics";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The relay's URL for a receipt's signed bytes, checked against `digest`; null where the report names no readable receipt. */
export function receiptUrl(deployment: string, receiptId: unknown, digest: unknown): string | null {
  const id = receiptIdOf(receiptId);
  if (id === null || !UUID.test(deployment) || typeof digest !== "string" || !SHA256_DIGEST.test(digest)) return null;
  const query = new URLSearchParams({ deployment, receipt: id.dashed, digest });
  return `/api/economics/receipt?${query.toString()}`;
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  return `sha256:${hexOf(await crypto.subtle.digest("SHA-256", bytes))}`;
}

/** Why bytes received are not saved, or null when both checks pass. */
async function disagreement(bytes: Uint8Array, named: string | null, shown: string): Promise<{ code: string; why: string } | null> {
  if (named === null || !SHA256_DIGEST.test(named)) {
    return { code: "receipt_digest_missing", why: "the answer did not name the SHA-256 of its bytes (X-Content-SHA256)" };
  }
  const received = await sha256Of(bytes);
  if (received !== named) {
    return { code: "receipt_digest_mismatch", why: `the bytes received have SHA-256 ${received}, not the ${named} they were sent with` };
  }
  const spelling = signedDocumentSpelling(bytes);
  if (spelling === null) return { code: "receipt_unreadable", why: "the envelope has no payload this page can read" };
  const signed = await sha256Of(spelling);
  if (signed !== shown) {
    return { code: "receipt_document_mismatch", why: `the receipt signs a document whose digest is ${signed}, not the ${shown} shown here` };
  }
  return null;
}

/** Hand the bytes to the browser as a file, exactly as they are. */
function save(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

type State =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "saved"; name: string; sha256: string }
  | { kind: "refused"; code: string | null; why: string };

export default function ReceiptDownload({ deployment, receipt }: { deployment: string; receipt: Doc }) {
  const shown = text(receipt.document_digest);
  const id = receiptIdOf(receipt.receipt_id);
  const url = receiptUrl(deployment, receipt.receipt_id, shown);
  const [state, setState] = useState<State>({ kind: "idle" });
  const reading = useRef<AbortController | null>(null);

  // Leaving the view, or another receipt shown here, aborts a read still open.
  useEffect(() => {
    setState({ kind: "idle" });
    return () => {
      reading.current?.abort();
      reading.current = null;
    };
  }, [url]);

  if (url === null || id === null || shown === null) {
    return (
      <p className="text-muted-foreground" data-receipt-state="unreadable">
        not offered: the report names no receipt id and document digest this page can check the bytes against
      </p>
    );
  }

  const download = async () => {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setState({ kind: "reading" });
    try {
      const res = await fetch(url, { credentials: "include", signal: controller.signal });
      await throwIfResNotOk(res);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const wrong = await disagreement(bytes, res.headers.get("X-Content-SHA256"), shown);
      if (controller.signal.aborted) return;
      if (wrong !== null) {
        setState({ kind: "refused", code: wrong.code, why: wrong.why });
        return;
      }
      const name = receiptFileName(id.hex);
      save(bytes, name);
      setState({ kind: "saved", name, sha256: res.headers.get("X-Content-SHA256") ?? "" });
    } catch (cause) {
      if (controller.signal.aborted) return;
      const code = cause instanceof ApiError && typeof cause.body?.code === "string" ? cause.body.code : null;
      setState({ kind: "refused", code, why: cause instanceof Error ? cause.message : "the read failed" });
    } finally {
      if (reading.current === controller) reading.current = null;
    }
  };

  return (
    <div className="space-y-1">
      <button
        type="button"
        className="rounded-md border border-primary/50 px-3 py-1 text-sm disabled:opacity-40"
        onClick={() => void download()}
        disabled={state.kind === "reading"}
        data-testid="receipt-download-button"
      >
        Download the signed receipt
      </button>
      <p className="text-xs text-muted-foreground">
        Saved only when its bytes match the SHA-256 they are sent with and it signs the document digest shown above;
        its signature is verified against the engine&apos;s published keys by whoever reads it, not here.
      </p>
      {state.kind === "reading" ? <p className="text-xs" data-receipt-state="reading">Reading the receipt...</p> : null}
      {state.kind === "saved" ? (
        <p className="text-xs" data-receipt-state="saved">
          Saved <span className="font-mono">{state.name}</span>: its bytes match{" "}
          <span className="font-mono" data-testid="receipt-sha256">{state.sha256}</span>, and it signs the document digest shown.
        </p>
      ) : null}
      {state.kind === "refused" ? (
        <p className="text-xs text-sev-high" role="alert" data-receipt-state="refused" data-receipt-code={state.code ?? ""}>
          Not saved{state.code ? ` (${state.code})` : ""}: {state.why}
        </p>
      ) : null}
    </div>
  );
}
