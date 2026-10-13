/**
 * The dashboard's read-through to Athena-Backend's Economic Exposure routes (MVP
 * step 14: the financial views).
 *
 * Three reads, each of ONE scenario version, and nothing else:
 *
 *   GET /api/economics/report?deployment=&scenario=[&simulation=]
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
 * Tenancy and roles stay with the backend. The browser calls this server
 * same-origin with its session (requireAuth guards every /api route); this
 * server reaches the backend with its service account, as every assurance read
 * does (server/control-plane.ts). A request names one deployment and one
 * scenario by uuid, and a result by uuid where it names one; only those are
 * forwarded -- any other query parameter is dropped, never passed on -- so no
 * request can widen what the backend is asked. Nothing is cached: every answer
 * is `Cache-Control: no-store`, and every read is a new backend read.
 *
 * SAFETY: none of these is a stop and none is on a stop's path. A read waits on
 * the backend only for itself: it holds no lock, takes no slot a stop needs and
 * parses nothing, so a slow, hung or failed economics read never blocks, delays
 * or drops a stop, pause, stand-down, terminate or revoke
 * (tests/economics-route.test.ts).
 */
import { Readable } from "node:stream";
import type { Express, Request, Response } from "express";
import { asyncHandler } from "./auth";
import { call, body as quoted, isConfigured, ControlPlaneUnavailable } from "./control-plane";

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

/** What the browser is told when the backend did not answer with the document. */
async function refusal(document: EconomicsDocument, upstream: globalThis.Response): Promise<{ status: number; error: string }> {
  const text = await quoted(upstream);
  let detail = "";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const parts = [parsed.code, parsed.detail].filter((part): part is string => typeof part === "string" && part !== "");
    detail = parts.join(": ");
  } catch {
    detail = ""; // not JSON (a framework's own page): its words are not quoted
  }
  const what = ECONOMICS_DOCUMENTS[document].what;
  if (upstream.status === 404) {
    return {
      status: 404,
      error: detail
        ? `not served: Athena-Backend has no ${what} here (${detail})`
        : `not served: Athena-Backend answered 404 for ${what} (no such document, or no such route at this backend version)`,
    };
  }
  if (upstream.status === 400 || upstream.status === 403) {
    return { status: upstream.status, error: `Athena-Backend refused the read of ${what}${detail ? ` (${detail})` : ""}` };
  }
  if (upstream.status === 401) {
    return { status: 503, error: "Athena-Backend did not accept this server's service credential" };
  }
  return {
    status: upstream.status === 503 ? 503 : 502,
    error: `Athena-Backend answered ${upstream.status} for ${what}${detail ? ` (${detail})` : ""}`,
  };
}

/** One economics read: the backend's document streamed through as its bytes, or why not. */
async function relay(document: EconomicsDocument, req: Request, res: Response): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  if (!isConfigured()) {
    res.status(503).json({ error: "no Athena control plane is configured, so there is no economics to read" });
    return;
  }
  let path: string;
  try {
    path = backendPath(document, req);
  } catch (cause) {
    if (cause instanceof Refused) {
      res.status(400).json({ error: cause.message, code: "field_malformed" });
      return;
    }
    throw cause;
  }
  let upstream: globalThis.Response;
  try {
    upstream = await call(path, { method: "GET", headers: { Accept: "application/json" } });
  } catch (cause) {
    if (cause instanceof ControlPlaneUnavailable) {
      res.status(503).json({ error: cause.message });
      return;
    }
    throw cause;
  }
  if (upstream.status !== 200 || upstream.body === null) {
    const { status, error } = await refusal(document, upstream);
    res.status(status).json({ error });
    return;
  }
  // The document's bytes, as the backend sent them: never parsed, never re-encoded.
  res.status(200);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
  const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>);
  // A browser that goes away stops the backend read too: nothing is held for it.
  res.on("close", () => { if (!res.writableFinished) stream.destroy(); });
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
