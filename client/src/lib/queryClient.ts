import { QueryClient, QueryFunction } from "@tanstack/react-query";

// In the packaged Electron app the renderer is served from app://athena, so API
// calls need an absolute URL. In the browser they are same-origin.
// 127.0.0.1, not localhost: the packaged app's Content-Security-Policy names a
// host literally, and the two spellings do not match each other.
// The page and the API are served from the same origin, in development
// and in the packaged app alike, so requests are relative.
const API_BASE = "";

function getApiUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${API_BASE}${url}`;
}

/** Raised on 401 so the app can send the user back to the login screen. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Your session has expired. Please sign in again.");
    this.name = "UnauthorizedError";
  }
}

/**
 * A request the server refused or failed: its sentence as the message, and
 * its answer as it came (null when it was not JSON), for a caller that has to
 * read more of it than the sentence -- whether a run may still be going.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown> | null) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Whether the server said a run it could not stop may still be going
 * (`mayStillBeRunning`): a start refused as an unread answer whose stop did
 * not take, or a retest whose slot is held. Such a failure is never titled
 * "did not start" or "did not run".
 */
export function mayStillBeRunning(error: unknown): boolean {
  return error instanceof ApiError && error.body?.mayStillBeRunning === true;
}

/**
 * The runs a refused retest keeps a Stop for on its finding's panel
 * (`stoppable`): only when there is one does a toast say "stop it here".
 */
export function keptStops(error: unknown): string[] {
  const kept = error instanceof ApiError ? error.body?.stoppable : undefined;
  return Array.isArray(kept) ? kept.filter((one): one is string => typeof one === "string") : [];
}

/**
 * How a failed scan start is titled. One the server says may still be running
 * names what stops it; an answer it could not read, whose every named run was
 * then stopped or found ended, is no start that "did not start"; anything
 * else did not start.
 */
export function scanStartFailureTitle(error: unknown): string {
  // A press sent again (lib/keyedPress.ts) whose first send's outcome nobody
  // knows yet is neither "did not start" nor "started": it is said as unknown.
  const reason = error instanceof ApiError && typeof error.body?.reason === "string" ? error.body.reason : null;
  if (reason === "scan_outcome_unknown" || reason === "idempotency_in_flight") {
    return "We don't know whether this scan started: check the scans list before starting it again";
  }
  if (reason === "idempotency_bug" || reason === "idempotency_key_invalid") {
    return "The scan was not started: this page sent its key wrongly, which is a bug";
  }
  if (mayStillBeRunning(error)) {
    return "The scan may still be running: stop it with the kill switch on the AI Control page, or a failsafe pause";
  }
  const body = error instanceof ApiError ? error.body : null;
  const runIds = Array.isArray(body?.runIds) ? body.runIds : [];
  if (body?.reason === "unrecognised_engine_answer" && runIds.length > 0) {
    return runIds.length === 1
      ? "The scan's answer could not be read: the run it named was stopped, or had ended"
      : "The scan's answer could not be read: the runs it named were stopped, or had ended";
  }
  return "The scan did not start";
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/**
 * Be told when a request comes back 401.
 *
 * UnauthorizedError was defined and thrown but never caught, so an expired
 * session left the app believing it was signed in: every screen rendered its
 * "no records found" empty state and the user had no way to tell that their
 * session, rather than the database, was the problem.
 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function notifyUnauthorized(): void {
  unauthorizedListeners.forEach((listener) => listener());
}

/** The server's answer to an account that must change its password (server/auth.ts). */
export const PASSWORD_CHANGE_REQUIRED = "password change required"; // pragma: allowlist secret

const passwordChangeListeners = new Set<UnauthorizedListener>();

/**
 * Be told when a request comes back 403 `{"error":"password change required"}`:
 * the account was marked to change its password while the app was open (an
 * install found still on a legacy default), and the app shows the
 * change-password screen.
 */
export function onPasswordChangeRequired(listener: UnauthorizedListener): () => void {
  passwordChangeListeners.add(listener);
  return () => passwordChangeListeners.delete(listener);
}

export async function throwIfResNotOk(res: Response): Promise<void> {
  if (res.ok) return;
  if (res.status === 401) {
    notifyUnauthorized();
    throw new UnauthorizedError();
  }
  if (res.status === 403) {
    const refusal = (await res.clone().json().catch(() => null)) as { error?: unknown } | null;
    if (refusal && refusal.error === PASSWORD_CHANGE_REQUIRED) passwordChangeListeners.forEach((listener) => listener());
  }

  // Prefer the server's JSON `message`; then its `error` (the assurance and
  // failsafe routes answer with `{error}`, and the literal `{"error":"…"}` is
  // not a sentence to show a person); fall back to text, then status.
  const body = await res.clone().json().catch(() => null);
  const answer = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (body && typeof body.message === "string") {
    const issues = Array.isArray(body.issues)
      ? body.issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join("; ")
      : "";
    throw new ApiError(issues ? `${body.message} (${issues})` : body.message, res.status, answer);
  }
  if (body && typeof body.error === "string") {
    throw new ApiError(body.error, res.status, answer);
  }
  const text = (await res.text().catch(() => "")) || res.statusText;
  throw new ApiError(text || `Request failed with status ${res.status}`, res.status, answer);
}

/**
 * The request apiRequest sends, answered as it came: for the caller that has
 * to read a failure's body itself (the kill switch's, whose 500 still says
 * which stops were sent). Anything else should use apiRequest. `headers`: any
 * of the request's own -- a press's Idempotency-Key (lib/keyedPress.ts).
 */
export async function apiFetch(
  method: string, url: string, data?: unknown, headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(getApiUrl(url), {
    method,
    headers: data !== undefined ? { ...headers, "Content-Type": "application/json" } : headers,
    body: data !== undefined ? JSON.stringify(data) : undefined,
    credentials: "include",
  });
}

export async function apiRequest(
  method: string, url: string, data?: unknown, headers: Record<string, string> = {},
): Promise<Response> {
  const res = await apiFetch(method, url, data, headers);
  await throwIfResNotOk(res);
  return res;
}

/**
 * Builds the request URL from the query key. The first element is the path;
 * a trailing object becomes the query string, so callers can write
 * `queryKey: ["/api/tests", { clientId }]`.
 */
function urlFromQueryKey(queryKey: readonly unknown[]): string {
  const [path, ...rest] = queryKey;
  let url = String(path);
  const params = rest.find((p) => p !== null && typeof p === "object") as Record<string, unknown> | undefined;
  if (params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
    }
    const qs = search.toString();
    if (qs) url += `?${qs}`;
  } else {
    const segments = rest.filter((s) => typeof s === "string" || typeof s === "number");
    if (segments.length > 0) url += `/${segments.join("/")}`;
  }
  return getApiUrl(url);
}

type UnauthorizedBehavior = "returnNull" | "throw";

export const getQueryFn: <T>(options: { on401: UnauthorizedBehavior }) => QueryFunction<T> =
  ({ on401 }) =>
  async ({ queryKey }) => {
    const res = await fetch(urlFromQueryKey(queryKey), { credentials: "include" });
    if (res.status === 401 && on401 === "returnNull") return null as never;
    await throwIfResNotOk(res);
    return (await res.json()) as never;
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      // Data is refetched when a mutation invalidates it; 30s keeps navigation
      // snappy without showing indefinitely stale rows.
      staleTime: 30_000,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
