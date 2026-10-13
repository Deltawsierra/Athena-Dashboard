/**
 * A Financial Exposure Receipt's signed bytes, checked against what the page shows
 * (Athena-Backend #163: `GET deployments/<uuid>/economics/receipts/<receipt id>/`).
 *
 * The route answers the receipt's signed DSSE envelope as stored, with the SHA-256
 * of those bytes in `X-Content-SHA256`. The report names the receipt by its id and
 * by `receipt.document_digest`: the digest of the document the envelope signs. Two
 * checks, made by the relay (server/economics.ts) before it sends a byte and again
 * by the page before it saves one:
 *
 *   1. the bytes are the bytes their `X-Content-SHA256` names;
 *   2. the envelope's payload is the document whose digest the page shows.
 *
 * The payload is the document in the spelling it is signed over (mythos_core's
 * canonical bytes: sorted keys, no whitespace, UTF-8); the report's digest is of
 * the backend's ASCII spelling of the same document (models.canonical_digest:
 * every character outside printable ASCII written `\uXXXX`, lowercase, a UTF-16
 * pair past the first plane). The two differ only in that escaping, so the payload
 * is respelled character by character -- never parsed, never re-encoded as JSON, so
 * no number or key order can move -- and its SHA-256 compared with the digest
 * shown (tests/fixtures/economics/<dir>/canonical-spellings.json pins the rule to
 * the backend's own functions).
 *
 * No money is read here: a receipt is checked as bytes, and nothing in it is shown.
 * Pure functions, for the server and the browser alike (each hashes with its own
 * SHA-256).
 */

/** `sha256:` and 64 lowercase hex digits: how the backend writes every digest. */
export const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

const HEX_ID = /^[0-9a-f]{32}$/;
const DASHED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A receipt id as the report names it (32 lowercase hex digits) or dashed, as the
 * route takes it: `{ dashed, hex }`, or null for anything else.
 */
export function receiptIdOf(id: unknown): { dashed: string; hex: string } | null {
  if (typeof id !== "string") return null;
  let hex: string;
  if (HEX_ID.test(id)) hex = id;
  else if (DASHED_ID.test(id)) hex = id.replace(/-/g, "");
  else return null;
  const dashed = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { dashed, hex };
}

/** The file a receipt is saved as: the backend's own name for it. */
export function receiptFileName(hex: string): string {
  return `financial-exposure-receipt-${hex}.json`;
}

/** Base64 as Python's b64encode writes it, and nothing else: no whitespace, no URL alphabet, padded. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * The backend's ASCII spelling of a canonical JSON text: every UTF-16 code unit
 * outside printable ASCII (U+0020 to U+007E) written `\uXXXX` in lowercase hex, as
 * Python's json.dumps(ensure_ascii=True) writes it. (In a canonical text such a
 * unit stands only inside a string: whitespace and control characters are already
 * escaped in both spellings.)
 */
export function asciiSpelling(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    out += unit >= 0x20 && unit <= 0x7e ? text[index] : `\\u${unit.toString(16).padStart(4, "0")}`;
  }
  return out;
}

/**
 * The ASCII bytes whose SHA-256 a report's `receipt.document_digest` is, read from
 * a receipt's envelope bytes: the envelope a JSON object whose `payload` is
 * strict base64 of UTF-8 text. Null where the envelope cannot be read so.
 */
export function signedDocumentSpelling(envelope: Uint8Array): Uint8Array | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const payload = (parsed as Record<string, unknown>).payload;
  if (typeof payload !== "string" || !BASE64.test(payload)) return null;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  // Only the one spelling: a payload whose bits past its last byte are not zero is refused.
  if (btoa(binary) !== payload) return null;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  return new TextEncoder().encode(asciiSpelling(text));
}

/** Lowercase hex of a digest's bytes. */
export function hexOf(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .map((one) => one.toString(16).padStart(2, "0"))
    .join("");
}
