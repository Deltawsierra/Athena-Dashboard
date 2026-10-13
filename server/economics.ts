/**
 * The dashboard's read-through to Athena-Backend's Economic Exposure routes (MVP
 * step 14: the financial views).
 *
 * Three reads, each of ONE scenario version, and nothing else:
 *
 *   GET /api/economics/report?deployment=&scenario=[&simulation=][&download=1]
 *       -> GET .../deployments/<d>/economics/scenarios/<s>/results/[?simulation=]
 *          the report of one stored result (mythos.economics.report/v1), as its
 *          canonical bytes carrying their own digest
 *   GET /api/economics/events?deployment=&scenario=
 *       -> GET .../scenarios/<s>/events/   the scenario's events, each with its template
 *   GET /api/economics/roi?deployment=&scenario=
 *       -> GET .../scenarios/<s>/roi/      the remediation option's economics
 *          (mythos.economics.roi/v1; Athena-Backend #160, step 13)
 *
 * Every figure the views show is the backend's. This server does no arithmetic on
 * money and never reads a figure: a document the backend answers is streamed to
 * the browser as its bytes, unmodified (never parsed, never re-encoded), so the
 * digest a report carries is the digest of what the browser received. There is
 * no route that totals scenarios: a portfolio total is the backend's to make
 * (E5), under its own rule (report.may_be_totalled), and is out of this scope.
 *
 * What is passed on, and how (review round 1, MEDIUM-2): a document is passed on
 * only when the backend answers 200 with a JSON media type; anything else is
 * refused (502) and none of its bytes is sent. Every answer of these routes is
 * `Content-Type: application/json`, `X-Content-Type-Options: nosniff` and
 * `Cache-Control: no-store`, whatever the backend said, and a download
 * (`&download=1`) is `Content-Disposition: attachment` with a fixed file name. A
 * backend 4xx is quoted (its code and detail, bounded); a 5xx, an unreachable
 * backend or a deadline passed is a fixed sentence and code (LOW-1): no backend
 * address, no traceback. The cause is logged here, on the server.
 *
 * Tenancy and roles stay with the backend. The browser calls this server
 * same-origin with its session (requireAuth guards every /api route); this
 * server reaches the backend with its service account, as every assurance read
 * does (server/control-plane.ts). A request names one deployment and one
 * scenario by uuid, and a result by uuid where it names one; only those are
 * forwarded -- any other query parameter is dropped, never passed on -- so no
 * request can widen what the backend is asked. Nothing is cached: every read is
 * a new backend read.
 *
 * SAFETY: none of these is a stop and none is on a stop's path. A read waits on
 * the backend only for itself: it holds no lock, takes no slot a stop needs and
 * parses nothing. And it holds a browser connection for at most ONE total
 * deadline (MEDIUM-3, the lead's decision: ECONOMICS_DEADLINE_MS, headers and body
 * together): past it, the browser's connection is answered 504 or cut, and the
 * backend read is cancelled, so stalled economics reads can never fill the
 * browser's few connections to this server ahead of a stop. The views cancel a
 * read they no longer show (lib/queryClient.ts: every query passes its AbortSignal).
 * (tests/economics-route.test.ts, tests/economics-a-stalled-read-never-holds-a-stop.test.ts)
 */
import { Readable } from "node:stream";
import type { Express, Request, Response } from "express";
import { asyncHandler } from "./auth";
import { call, body as quoted, isConfigured, ControlPlaneUnavailable } from "./control-plane";
import { READ_DEADLINE_MS, _setReadDeadlineForTests, startReadDeadline } from "./read-deadline";

/** A uuid as the backend's `<uuid:...>` route converter takes one: lowercase hex. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The documents these views read, and the backend route each one is. */
export const ECONOMICS_DOCUMENTS = {
  report: { route: "results/", takesSimulation: true, what: "the report of a stored result" },
  events: { route: "events/", takesSimulation: false, what: "the scenario's events and their templates" },
  roi: { route: "roi/", takesSimulation: false, what: "the remediation option's economics" },
} as const;
export type EconomicsDocument = keyof typeof ECONOMICS_DOCUMENTS;

/** The routes this server serves for the views: one per document, each of one scenario. */
export const ECONOMICS_ROUTES = (Object.keys(ECONOMICS_DOCUMENTS) as EconomicsDocument[]).map(
  (document) => `/api/economics/${document}`,
);

/**
 * The most one economics read may take, from its arrival to its last byte:
 * waiting for the backend's headers AND streaming its body. Past it the read is
 * cut. (The control plane's own 15 s bounds only the headers.) It is every relay
 * read's deadline (server/read-deadline.ts), which this relay first had.
 */
export const ECONOMICS_DEADLINE_MS = READ_DEADLINE_MS;

/** Test seam: a shorter deadline, or back to the default with null (every relay read's). */
export function _setEconomicsDeadlineForTests(ms: number | null): void {
  _setReadDeadlineForTests(ms);
}

/** The only query parameters read; any other is dropped, never forwarded. */
const FORWARDED = ["deployment", "scenario", "simulation"] as const;

class Refused extends Error {}

function one(req: Request, name: (typeof FORWARDED)[number], required: boolean): string | null {
  const value = req.query[name];
  if (value === undefined && !required) return null;
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Refused(`${name} is one ${name === "simulation" ? "result" : name}'s uuid (lowercase), named once`);
  }
  return value;
}

/** Whether a download was asked for: `download=1`, or nothing; anything else is refused. */
function wantsDownload(req: Request): boolean {
  const value = req.query.download;
  if (value === undefined) return false;
  if (value !== "1") throw new Refused("download is 1, named once, or absent");
  return true;
}

/** The backend path a request names, or Refused: every part a uuid, nothing else carried. */
export function backendPath(document: EconomicsDocument, req: Request): string {
  const deployment = one(req, "deployment", true);
  const scenario = one(req, "scenario", true);
  const spec = ECONOMICS_DOCUMENTS[document];
  const simulation = spec.takesSimulation ? one(req, "simulation", false) : null;
  if (!spec.takesSimulation && req.query.simulation !== undefined) {
    throw new Refused(`the ${document} document is read for the scenario, not for a named result`);
  }
  return `/api/assurance/deployments/${deployment}/economics/scenarios/${scenario}/${spec.route}` +
    (simulation === null ? "" : `?simulation=${simulation}`);
}

/** Whether a backend's Content-Type names JSON (`application/json`, any parameters). */
export function isJsonMediaType(header: string | null): boolean {
  if (!header) return false;
  return header.split(";")[0].trim().toLowerCase() === "application/json";
}

interface Answer {
  status: number;
  error: string;
  code: string;
  upstream_status?: number;
}

/**
 * What the browser is told when the backend did not answer with the document. A
 * 4xx is the backend's own refusal and is quoted (code and detail, bounded); a
 * 5xx is a fixed sentence: whatever it carries (a traceback, a path) stays here.
 */
async function refusal(document: EconomicsDocument, upstream: globalThis.Response): Promise<Answer> {
  const what = ECONOMICS_DOCUMENTS[document].what;
  const status = upstream.status;
  if (status >= 500) {
    console.warn(`[economics] Athena-Backend answered ${status} for ${what}: ${await quoted(upstream)}`);
    return {
      status: status === 503 ? 503 : 502,
      error: `Athena-Backend could not serve ${what} (a server error); the cause is in this server's log`,
      code: "backend_error",
      upstream_status: status,
    };
  }
  if (status === 401) {
    return {
      status: 503,
      error: "Athena-Backend did not accept this server's service credential",
      code: "backend_credential_refused",
      upstream_status: status,
    };
  }
  const text = await quoted(upstream);
  let detail = "";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const parts = [parsed.code, parsed.detail].filter((part): part is string => typeof part === "string" && part !== "");
    detail = parts.join(": ");
  } catch {
    detail = ""; // not JSON (a framework's own page): its words are not quoted
  }
  if (status === 404) {
    return {
      status: 404,
      error: detail
        ? `not served: Athena-Backend does not serve ${what} here (${detail})`
        : `not served: Athena-Backend answered 404 for ${what} (no such document, or no such route at this backend version)`,
      // The backend itself answered 404: the document is not served (no such
      // document, or no such route). The views read this code, and only this
      // code, as "not served"; any other failure is a failure.
      code: "not_served",
      upstream_status: status,
    };
  }
  if (status >= 400) {
    return {
      status: status === 400 || status === 403 ? status : 502,
      error: `Athena-Backend refused the read of ${what}${detail ? ` (${detail})` : ""}`,
      code: "backend_refused",
      upstream_status: status,
    };
  }
  return {
    status: 502,
    error: `Athena-Backend did not answer ${what} with a document`,
    code: "backend_error",
    upstream_status: status,
  };
}

/** One economics read: the backend's document streamed through as its bytes, or why not. */
async function relay(document: EconomicsDocument, req: Request, res: Response): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!isConfigured()) {
    res.status(503).json({ error: "no Athena control plane is configured, so there is no economics to read", code: "backend_unavailable" });
    return;
  }
  let path: string;
  let download: boolean;
  try {
    path = backendPath(document, req);
    download = wantsDownload(req);
  } catch (cause) {
    if (cause instanceof Refused) {
      res.status(400).json({ error: cause.message, code: "field_malformed" });
      return;
    }
    throw cause;
  }
  const what = ECONOMICS_DOCUMENTS[document].what;

  // ONE deadline for the whole read, headers and body (server/read-deadline.ts):
  // past it the browser's connection is answered or cut, and the backend read
  // cancelled. A browser that goes away stops the backend read too.
  let stream: Readable | null = null;
  let upstreamBody: globalThis.ReadableStream<Uint8Array> | null = null;
  const cut = () => {
    if (stream !== null) stream.destroy();
    else if (upstreamBody !== null) void upstreamBody.cancel().catch(() => undefined);
  };
  const deadline = startReadDeadline(res, { who: "Athena-Backend", what }, cut);
  const gone = () => deadline.passed() || res.writableEnded || res.destroyed;

  let upstream: globalThis.Response;
  try {
    upstream = await call(path, { method: "GET", headers: { Accept: "application/json" } });
  } catch (cause) {
    if (gone()) return;
    if (cause instanceof ControlPlaneUnavailable) {
      console.warn(`[economics] the read of ${what} reached no backend: ${cause.message}`);
      res.status(503).json({ error: `Athena-Backend could not be reached for ${what}`, code: "backend_unavailable" });
      return;
    }
    throw cause;
  }
  upstreamBody = upstream.body;
  if (gone()) {
    cut();
    return;
  }
  if (upstream.status !== 200 || upstream.body === null) {
    const answer = await refusal(document, upstream);
    if (gone()) return;
    const { status, ...rest } = answer;
    res.status(status).json(rest);
    return;
  }
  if (!isJsonMediaType(upstream.headers.get("content-type"))) {
    // A 200 that is not JSON is not a document these views read: none of its bytes
    // is sent on, so it can never run as a page on this server's origin.
    cut();
    console.warn(`[economics] Athena-Backend answered ${what} with ${upstream.headers.get("content-type") ?? "no content type"}: refused`);
    res.status(502).json({ error: `Athena-Backend did not answer ${what} as JSON: refused`, code: "backend_not_json" });
    return;
  }
  // The document's bytes, as the backend sent them: never parsed, never re-encoded.
  res.status(200);
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    download ? `attachment; filename="economics-${document}.json"` : "inline",
  );
  stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/**
 * Register the three reads. Each sits behind the `/api` guards registerRoutes
 * installs first (requireAuth; a read passes the kill switch, which holds back
 * writes and never a stop). None writes anything.
 */
export function registerEconomicsRoutes(app: Express): void {
  for (const document of Object.keys(ECONOMICS_DOCUMENTS) as EconomicsDocument[]) {
    app.get(`/api/economics/${document}`, asyncHandler((req, res) => relay(document, req, res)));
  }
}
