/**
 * A file this app serves, saved inside the app with the person's own session.
 *
 * The desktop app opens no window and hands no URL to the system browser
 * (electron-main.cjs). So a file of the app's own -- the backend report relayed
 * at /api/scans/:id/backend-pdf, a document stored as a path on this origin --
 * is read here, on the app's origin, with the session cookie, and saved from a
 * Blob. The system browser used to get these, with no session, and answered
 * the report's relay with a 401.
 *
 * Only a path on this app's own origin is such a file. A URL to anywhere else,
 * stored in the app's data, is text with a copy button (components/StoredUrl.tsx,
 * components/TargetUrl.tsx), never a one-click open.
 *
 * Every file the app saves from a Blob URL -- these, and the JSON the pages
 * build (the AI-BOM's export, the assurance receipt's view, the incident pack,
 * the signed Financial Exposure Receipt) -- has that URL revoked here, by
 * revokeBlobUrlLater, and nowhere else.
 */
import { throwIfResNotOk } from "@/lib/queryClient";

/**
 * The path of `stored` when it names a file on this app's own origin -- a path
 * from the root ("/documents/q3.pdf") or an absolute http(s) URL whose origin is
 * this one -- and null for anything else: another origin, a protocol-relative or
 * backslashed path that resolves to another host, another scheme, or no URL at all.
 */
export function appFilePath(stored: string, origin: string = window.location.origin): string | null {
  let absolute: URL | null = null;
  try {
    absolute = new URL(stored);
  } catch {
    absolute = null;
  }
  if (absolute !== null) {
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return null;
    return absolute.origin === origin ? `${absolute.pathname}${absolute.search}` : null;
  }
  if (!stored.startsWith("/")) return null;
  let resolved: URL;
  try {
    resolved = new URL(stored, origin);
  } catch {
    return null;
  }
  return resolved.origin === origin ? `${resolved.pathname}${resolved.search}` : null;
}

/** The file name a path ends in ("q3.pdf"), or `fallback` when it ends in none. */
export function fileNameOf(path: string, fallback: string): string {
  const last = path.split("?")[0].split("/").pop() ?? "";
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  return /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : fallback;
}

/** How long a saved file's Blob URL is kept before it is revoked: long enough for the download to have read it. */
export const BLOB_URL_KEPT_MS = 60_000;

/**
 * Revoke a saved file's Blob URL BLOB_URL_KEPT_MS from now, never now. The
 * download a link's click starts reads the Blob URL after the click returns,
 * and in Chromium (so in the desktop app) a URL revoked at once can leave the
 * save failed or empty. Each in-app download revokes its Blob URL through this.
 */
export function revokeBlobUrlLater(url: string): void {
  setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_KEPT_MS);
}

/**
 * Read `path` from this app's origin with the session's cookie and save it as
 * `fileName`. A refusal is thrown with the server's sentence (a 401 also sends
 * the person to sign in, as every read does). An answer that is the app's own
 * page, not a file, is refused: the server answers a path it has no file at
 * with the page itself, and saving that as "q3.pdf" would be a file that is not one.
 */
export async function saveAppFile(path: string, fileName: string): Promise<void> {
  const response = await fetch(path, { credentials: "include" });
  await throwIfResNotOk(response);
  if (/^text\/html\b/i.test(response.headers.get("Content-Type") ?? "")) {
    throw new Error("This app holds no file at that address.");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    // Never put on the page: a detached link's click starts the download in Chromium.
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
  } finally {
    // Later, not now: the download the click starts reads the Blob URL after
    // this returns, and a URL revoked at once can leave the save failed or empty.
    revokeBlobUrlLater(url);
  }
}
