/**
 * The dashboard's read-through to Athena-Backend's Economic Exposure routes (MVP
 * step 14: the financial views; the routes Athena-Backend #163 serves).
 *
 * Three reads of ONE scenario version, and two of a deployment, and nothing else:
 *
 *   GET /api/economics/report?deployment=&scenario=[&simulation=][&download=1]
 *       -> GET .../deployments/<d>/economics/scenarios/<s>/results/[?simulation=]
 *          the report of one stored result (mythos.economics.report/v2: v1 and
 *          its currency bridge), as its canonical bytes carrying their own digest
 *   GET /api/economics/events?deployment=&scenario=
 *       -> GET .../scenarios/<s>/events/   the scenario's events, each with its template
 *   GET /api/economics/roi?deployment=&scenario=
 *       -> GET .../scenarios/<s>/roi/      the remediation option's economics
 *          (mythos.economics.roi/v1; Athena-Backend #160, step 13)
 *   GET /api/economics/scenarios?deployment=[&page=][&page_size=]
 *       -> GET .../deployments/<d>/economics/scenarios/[?page=&page_size=]
 *          the deployment's scenario versions, a page at a time (25 unless the
 *          request names up to 100), each with its templates and its latest
 *          exposure run's status, grade and exclusion from totals
 *   GET /api/economics/receipt?deployment=&receipt=&digest=
 *       -> GET .../deployments/<d>/economics/receipts/<receipt id, dashed>/
 *          a Financial Exposure Receipt's signed DSSE envelope, as stored, as a
 *          download; `digest` is the report's `receipt.document_digest`, the
 *          digest the page shows for it
 *
 * Every figure the views show is the backend's. This server does no arithmetic on
 * money and never reads a figure: a document the backend answers is streamed to
 * the browser as its bytes, unmodified (never parsed, never re-encoded), so the
 * digest a report carries is the digest of what the browser received. There is
 * no route that totals scenarios: a portfolio total is the backend's to make
 * (E5), under its own rule (report.may_be_totalled), and is out of this scope;
 * the scenario list is passed on as served, each version with its own standing.
 *
 * A receipt's bytes are checked before one of them is sent (shared/economics-
 * receipt.ts): they are held, bounded (RECEIPT_MAX_BYTES), until the whole answer
 * is in; then the SHA-256 of the bytes must be the one Athena-Backend sent with
 * them (`X-Content-SHA256`), and the envelope's payload must be the document
 * whose digest the page shows (`digest`). Either disagreement, or a header
 * missing, refuses the download (502) and sends none of the bytes; when both
 * agree, the bytes go out exactly as they came, with the header.
 *
 * What is passed on, and how (review round 1, MEDIUM-2): a document is passed on
 * only when the backend answers 200 with a JSON media type; anything else is
 * refused (502) and none of its bytes is sent. Every answer of these routes is
 * `Content-Type: application/json`, `X-Content-Type-Options: nosniff` and
 * `Cache-Control: no-store`, whatever the backend said, and a download
 * (`&download=1`, and every receipt) is `Content-Disposition: attachment` with a
 * fixed file name. A backend 4xx is quoted (its code and detail, bounded); a 5xx,
 * an unreachable backend or a deadline passed is a fixed sentence and code
 * (LOW-1): no backend address, no traceback. The cause is logged here, on the
 * server.
 *
 * Tenancy and roles stay with the backend, and are applied to the PERSON (T6).
 * The browser calls this server same-origin with its session (requireAuth
 * guards every /api route); this server reaches the backend as that signed-in
 * person, with their own backend sign-in, as every assurance read does
 * (server/control-plane.ts, server/person-credential.ts) -- never as a service
 * account that sees every tenant. So a deployment the person's account cannot
 * see is the backend's 404 (`not_served`) or 403, passed on, and never its
 * documents; a person with no backend sign-in is answered 503
 * `backend_sign_in_required` and nothing is asked of the backend. A request
 * names one deployment by uuid, and a scenario, a result or a receipt by uuid,
 * or a page by number, where it names one; only those are forwarded -- any
 * other query parameter is dropped, never passed on -- so no request can widen
 * what the backend is asked. Nothing is cached: every read is a new backend
 * read.
 *
 * SAFETY: none of these is a stop and none is on a stop's path. A read waits on
 * the backend only for itself: it holds no lock and takes no slot a stop needs.
 * And it holds a browser connection for at most ONE total deadline (MEDIUM-3, the
 * lead's decision; since #68 every relay read's: server/read-deadline.ts,
 * READ_DEADLINE_MS, headers and body together): each route is mounted behind
 * `boundedRelayRead`, so past the deadline the browser's connection is answered
 * 504 or cut, and the backend read -- its headers or its body -- is aborted with
 * the read's signal (server/control-plane.ts `readSignalFor`), so stalled
 * economics reads can never fill the browser's few connections to this server
 * ahead of a stop. The views cancel a read they no longer show
 * (lib/queryClient.ts: every query passes its AbortSignal; the receipt download
 * passes its own). (tests/economics-route.test.ts,
 * tests/economics-a-stalled-read-never-holds-a-stop.test.ts,
 * tests/economics-the-receipt-is-passed-on-only-when-its-digests-agree.test.ts,
 * tests/economics-the-scenario-list-route.test.ts)
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Express, Request, Response } from "express";
import { SHA256_DIGEST, receiptFileName, receiptIdOf, signedDocumentSpelling } from "@shared/economics-receipt";
import { asyncHandler } from "./auth";
import { call, body as quoted, isConfigured, ControlPlaneSignInRequired, ControlPlaneUnavailable } from "./control-plane";
import { READ_DEADLINE_MS, _setReadDeadlineForTests, boundedRelayRead } from "./read-deadline";

/** A uuid as the backend's `<uuid:...>` route converter takes one: lowercase hex. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The documents these views read, and the backend route each one is. */
export const ECONOMICS_DOCUMENTS = {
  report: { route: "results/", takesSimulation: true, what: "the report of a stored result" },
  events: { route: "events/", takesSimulation: false, what: "the scenario's events and their templates" },
  roi: { route: "roi/", takesSimulation: false, what: "the remediation option's economics" },
} as const;
export type EconomicsDocument = keyof typeof ECONOMICS_DOCUMENTS;

/** The deployment's reads: its scenario versions, and a receipt's signed bytes. */
export const ECONOMICS_DEPLOYMENT_READS = {
  scenarios: { what: "the deployment's scenario versions" },
  receipt: { what: "a Financial Exposure Receipt's signed bytes" },
} as const;

/**
 * The routes this server serves for the views: one per document of a scenario, and
 * the deployment's two. None totals anything.
 */
export const ECONOMICS_ROUTES = [
  ...(Object.keys(ECONOMICS_DOCUMENTS) as EconomicsDocument[]).map((document) => `/api/economics/${document}`),
  ...Object.keys(ECONOMICS_DEPLOYMENT_READS).map((read) => `/api/economics/${read}`),
];

/** Athena-Backend's page size for the scenario list, and the most one request may name (#163). */
export const SCENARIO_PAGE_SIZE = 25;
export const SCENARIO_PAGE_SIZE_MAX = 100;
/** The most digits a page number may have (the backend's MAX_QUERY_DIGITS). */
const MAX_QUERY_DIGITS = 9;

/**
 * The most bytes a receipt may have: they are held until both checks pass, so the
 * hold is bounded. A signed receipt is a few kilobytes; past this the answer is
 * refused and the backend read cancelled.
 */
export const RECEIPT_MAX_BYTES = 1024 * 1024;

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

/**
 * A page number or a page size as the backend reads one (#163 `_whole`): ASCII
 * digits, no sign, no leading zero, at most MAX_QUERY_DIGITS of them, from 1 to
 * `most`; null where the request names none.
 */
function whole(req: Request, name: "page" | "page_size", most: number): string | null {
  const value = req.query[name];
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    !new RegExp(`^[1-9][0-9]{0,${MAX_QUERY_DIGITS - 1}}$`).test(value) ||
    Number(value) > most
  ) {
    throw new Refused(`${name} is a whole number from 1 to ${most}, named once, or absent`);
  }
  return value;
}

/** The backend path of a scenario-list request, or Refused: the deployment's uuid, and a page and a size if named. */
export function scenarioListPath(req: Request): string {
  const deployment = one(req, "deployment", true);
  const page = whole(req, "page", 10 ** MAX_QUERY_DIGITS - 1);
  const size = whole(req, "page_size", SCENARIO_PAGE_SIZE_MAX);
  const query = new URLSearchParams();
  if (page !== null) query.set("page", page);
  if (size !== null) query.set("page_size", size);
  const search = query.toString();
  return `/api/assurance/deployments/${deployment}/economics/scenarios/${search ? `?${search}` : ""}`;
}

/** What a receipt request names, or Refused: a deployment, a receipt id, and the digest the page shows. */
export function receiptRequest(req: Request): { path: string; hex: string; digest: string } {
  const deployment = one(req, "deployment", true);
  const id = req.query.receipt;
  const receipt = typeof id === "string" ? receiptIdOf(id) : null;
  if (receipt === null) {
    throw new Refused("receipt is one receipt's id (32 lowercase hex digits, or dashed), named once");
  }
  const digest = req.query.digest;
  if (typeof digest !== "string" || !SHA256_DIGEST.test(digest)) {
    throw new Refused("digest is the receipt's document digest the page shows (sha256: and 64 lowercase hex digits), named once");
  }
  return {
    path: `/api/assurance/deployments/${deployment}/economics/receipts/${receipt.dashed}/`,
    hex: receipt.hex,
    digest,
  };
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
async function refusal(what: string, upstream: globalThis.Response): Promise<Answer> {
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
    // The person's token, renewed once already (control-plane.ts call), was still
    // refused: their backend sign-in has ended. Never 401 to the browser.
    void upstream.body?.cancel().catch(() => undefined);
    return {
      status: 503,
      error: "Athena-Backend no longer takes your sign-in: sign in to Athena-Backend again",
      code: "backend_sign_in_required",
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

/** The headers every answer of these routes carries, whatever the backend said. */
function guarded(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

/** The 503 of a server with no control plane configured: before a request is read. */
function unconfigured(res: Response): boolean {
  if (isConfigured()) return false;
  res.status(503).json({ error: "no Athena control plane is configured, so there is no economics to read", code: "backend_unavailable" });
  return true;
}

/** A request's parameters read by `read`, or its 400 answered and null. */
function readRequest<T>(res: Response, read: () => T): T | null {
  try {
    return read();
  } catch (cause) {
    if (cause instanceof Refused) {
      res.status(400).json({ error: cause.message, code: "field_malformed" });
      return null;
    }
    throw cause;
  }
}

/**
 * Whether the browser has had its answer: the read deadline's 504 or cut
 * (server/read-deadline.ts), or the browser gone. Nothing more is sent then.
 */
function gone(res: Response): boolean {
  return res.headersSent || res.writableEnded || res.destroyed;
}

/**
 * The backend's answer to `path`, or null when the browser has been answered: an
 * unreachable backend (503, fixed) or a deadline passed. The read's signal (the
 * deadline's, laid by boundedRelayRead) aborts the backend read with it.
 */
async function backendRead(path: string, what: string, res: Response): Promise<globalThis.Response | null> {
  try {
    const upstream = await call(path, { method: "GET", headers: { Accept: "application/json" } });
    if (gone(res)) {
      void upstream.body?.cancel().catch(() => undefined);
      return null;
    }
    return upstream;
  } catch (cause) {
    if (gone(res)) return null;
    if (cause instanceof ControlPlaneSignInRequired) {
      // The person has no backend sign-in: nothing was asked of the backend.
      res.status(503).json({ error: `${what} is read as you, and ${cause.message}`, code: cause.code });
      return null;
    }
    if (cause instanceof ControlPlaneUnavailable) {
      console.warn(`[economics] the read of ${what} reached no backend: ${cause.message}`);
      res.status(503).json({ error: `Athena-Backend could not be reached for ${what}`, code: "backend_unavailable" });
      return null;
    }
    throw cause;
  }
}

/**
 * Whether the backend answered the document: 200 with a JSON media type. Otherwise
 * the browser is answered why (its refusal quoted, or a fixed sentence) and the
 * backend's body is cancelled: none of its bytes is sent on.
 */
async function answeredJson(upstream: globalThis.Response, what: string, res: Response): Promise<boolean> {
  if (upstream.status !== 200 || upstream.body === null) {
    const answer = await refusal(what, upstream);
    if (gone(res)) return false;
    const { status, ...rest } = answer;
    res.status(status).json(rest);
    return false;
  }
  if (!isJsonMediaType(upstream.headers.get("content-type"))) {
    // A 200 that is not JSON is not a document these views read: none of its bytes
    // is sent on, so it can never run as a page on this server's origin.
    void upstream.body.cancel().catch(() => undefined);
    console.warn(`[economics] Athena-Backend answered ${what} with ${upstream.headers.get("content-type") ?? "no content type"}: refused`);
    res.status(502).json({ error: `Athena-Backend did not answer ${what} as JSON: refused`, code: "backend_not_json" });
    return false;
  }
  return true;
}

/**
 * One economics read: the backend's document streamed through as its bytes, or
 * why not. `plan` reads the request (Refused: 400) into the backend path and, for
 * a download, the file name.
 */
async function relay(req: Request, res: Response, what: string, plan: () => { path: string; download: string | null }): Promise<void> {
  guarded(res);
  if (unconfigured(res)) return;
  const planned = readRequest(res, plan);
  if (planned === null) return;
  const upstream = await backendRead(planned.path, what, res);
  if (upstream === null || !(await answeredJson(upstream, what, res))) return;
  if (gone(res)) {
    void upstream.body?.cancel().catch(() => undefined);
    return;
  }
  // The document's bytes, as the backend sent them: never parsed, never re-encoded.
  res.status(200);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", planned.download !== null ? `attachment; filename="${planned.download}"` : "inline");
  const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>);
  stream.on("error", () => res.destroy());
  res.on("close", () => {
    if (!res.writableFinished) stream.destroy();
  });
  stream.pipe(res);
}

/** The backend's bytes, held until the whole answer is in: or null past RECEIPT_MAX_BYTES (the read cancelled). */
async function heldBytes(upstream: globalThis.Response): Promise<Buffer | null> {
  const reader = (upstream.body as globalThis.ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RECEIPT_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A receipt the relay will not pass on: none of its bytes is sent. */
function receiptRefused(res: Response, code: string, error: string): void {
  console.warn(`[economics] a receipt was refused (${code}): ${error}`);
  res.status(502).json({ error, code });
}

/**
 * A receipt's signed bytes, passed on only when they are the bytes their
 * `X-Content-SHA256` names AND their payload is the document whose digest the page
 * shows; then exactly as they came. Held, bounded, until both are known.
 */
async function relayReceipt(req: Request, res: Response): Promise<void> {
  guarded(res);
  if (unconfigured(res)) return;
  const asked = readRequest(res, () => receiptRequest(req));
  if (asked === null) return;
  const what = ECONOMICS_DEPLOYMENT_READS.receipt.what;
  const upstream = await backendRead(asked.path, what, res);
  if (upstream === null || !(await answeredJson(upstream, what, res))) return;
  const named = upstream.headers.get("x-content-sha256");
  if (named === null || !SHA256_DIGEST.test(named)) {
    void upstream.body?.cancel().catch(() => undefined);
    receiptRefused(res, "receipt_digest_missing",
      "Athena-Backend sent the receipt without the SHA-256 of its bytes (X-Content-SHA256): refused, none of it is sent");
    return;
  }
  let bytes: Buffer | null;
  try {
    bytes = await heldBytes(upstream);
  } catch (cause) {
    if (gone(res)) return; // the deadline cut it, or the browser went away
    // The backend's answer broke off: what came is not the receipt, and none of it is sent.
    console.warn(`[economics] the read of ${what} broke off: ${cause instanceof Error ? cause.message : String(cause)}`);
    res.status(502).json({ error: `Athena-Backend's answer of ${what} broke off: none of it is sent`, code: "backend_error" });
    return;
  }
  if (gone(res)) return;
  if (bytes === null) {
    receiptRefused(res, "receipt_too_large", `the receipt is larger than ${RECEIPT_MAX_BYTES} bytes: refused, none of it is sent`);
    return;
  }
  const received = sha256(bytes);
  if (received !== named) {
    receiptRefused(res, "receipt_digest_mismatch",
      `the receipt's bytes are not the bytes Athena-Backend named: their SHA-256 is ${received}, X-Content-SHA256 says ${named}; refused, none of them is sent`);
    return;
  }
  const spelling = signedDocumentSpelling(bytes);
  if (spelling === null) {
    receiptRefused(res, "receipt_unreadable",
      "the receipt's envelope has no payload this server can read (a JSON object whose payload is base64 of UTF-8 text): refused, none of it is sent");
    return;
  }
  const signed = sha256(spelling);
  if (signed !== asked.digest) {
    receiptRefused(res, "receipt_document_mismatch",
      `the receipt signs a document whose digest is ${signed}, not the ${asked.digest} the page shows: refused, none of it is sent`);
    return;
  }
  // Both agree: the bytes exactly as they came, with the digest they were checked against.
  res.status(200);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${receiptFileName(asked.hex)}"`);
  res.setHeader("X-Content-SHA256", named);
  res.setHeader("Content-Length", String(bytes.byteLength));
  res.end(bytes);
}

/**
 * Register the reads. Each sits behind the `/api` guards registerRoutes installs
 * first (requireAuth; a read passes the kill switch, which holds back writes and
 * never a stop), and behind the read deadline (boundedRelayRead), with its own
 * sentence. None writes anything.
 */
export function registerEconomicsRoutes(app: Express): void {
  const bounded = (what: string) => boundedRelayRead({ who: "Athena-Backend", what });
  for (const document of Object.keys(ECONOMICS_DOCUMENTS) as EconomicsDocument[]) {
    const what = ECONOMICS_DOCUMENTS[document].what;
    app.get(
      `/api/economics/${document}`,
      bounded(what),
      asyncHandler((req, res) =>
        relay(req, res, what, () => {
          const path = backendPath(document, req);
          return { path, download: wantsDownload(req) ? `economics-${document}.json` : null };
        }),
      ),
    );
  }
  const scenarios = ECONOMICS_DEPLOYMENT_READS.scenarios.what;
  app.get(
    "/api/economics/scenarios",
    bounded(scenarios),
    asyncHandler((req, res) => relay(req, res, scenarios, () => ({ path: scenarioListPath(req), download: null }))),
  );
  app.get("/api/economics/receipt", bounded(ECONOMICS_DEPLOYMENT_READS.receipt.what), asyncHandler(relayReceipt));
}
