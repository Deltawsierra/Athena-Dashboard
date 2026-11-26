import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn, signInToBackend } from "../helpers";
import { newServiceToken } from "./control-plane-stand-in";
import { hostileText, older, outcomeRow, v5 } from "./observed-effects";

/**
 * A stand-in for Athena-Backend's chain-outcomes read as its pull request #241 serves
 * it (assurance/outcome_pages.py), and this console signed in to it. Every name is
 * invented.
 *
 *   - `?recorded_as=observed_effect` serves only the rows recorded as observed effects;
 *     `matching_count` counts them, `recorded_count` every outcome;
 *   - `next` is the cursor for the page after this one, null on the last, and
 *     `?before=<next>` reads it; a cursor is taken only for the deployment and the
 *     filter it was issued under, and anything else is `400 bad_cursor`;
 *   - any other value of `recorded_as` is `400 unknown_recorded_as`, and ANY OTHER
 *     PARAMETER is `400 unknown_parameter`: never the first page again;
 *   - a deployment marked `older` is a backend from before #241: it reads no parameter
 *     and answers its newest outcomes of every kind, with no `next` and no
 *     `matching_count`.
 *
 * Every request is kept as it arrived (`requests`), so a test can say exactly what was
 * sent, and with which credentials: this console holds a failsafe service token
 * (`serviceToken`), which only a stop may carry. `script` makes the next request for one
 * page answer something else, once.
 */

export const DEP_PAGES = "dep-pages";
export const DEP_PAGES_OLDER = "dep-pages-older";
export const DEP_PAGES_NO_COUNT = "dep-pages-no-count";
export const DEP_PAGES_ODD_NEXT = "dep-pages-odd-next";
export const DEP_PAGES_NONE = "dep-pages-none";

export const PAGES_ROUTE = (dep: string, before?: string) =>
  `/api/assurance/deployments/${dep}/chain-outcomes${before === undefined ? "" : `?before=${encodeURIComponent(before)}`}`;

/** The backend's words (assurance/outcome_pages.py `_bad_cursor`). */
export const BAD_CURSOR_WORDS =
  "before is not a cursor this read issued. A cursor is the `next` of an earlier answer for the same deployment and the same filter; read the first page again without it.";
export const UNKNOWN_RECORDED_AS_WORDS = "recorded_as names what a row was recorded as; the only value is 'observed_effect'";

const gate = (id: string) =>
  outcomeRow(id, null, { evidence_kind: "authorization_check", evidence_kind_label: "Authorization check", observer_engine: "achilles" });
/** Recorded as an observed effect; its signature no longer checks: the backend reads it as attested, its reading null. */
export const UNSIGNED = "oe-key-retired";
const unsigned = outcomeRow(UNSIGNED, null, {
  evidence_kind: "attested", evidence_kind_label: "Attested", basis_in_force: "attested", signed: false, approval_recipients: null,
});

interface Recorded { row: Record<string, unknown>; effect: boolean }
const effect = (row: Record<string, unknown>): Recorded => ({ row, effect: true });
const other = (row: Record<string, unknown>): Recorded => ({ row, effect: false });

/** Each deployment's outcomes, newest first, and how many rows one page holds. */
const RECORD: Record<string, { rows: Recorded[]; size: number; older?: boolean; leaveOut?: string[]; put?: Record<string, unknown> }> = {
  // Five recorded as observed effects among nine outcomes: pages of two, two and one.
  [DEP_PAGES]: {
    size: 2,
    rows: [
      effect(outcomeRow("oe-1", v5())), other(gate("gate-1")), effect(outcomeRow("oe-2", older(4))), other(gate("gate-2")),
      effect(unsigned), effect(outcomeRow("oe-4", v5())), other(gate("gate-3")), other(gate("gate-4")), effect(outcomeRow("oe-5", v5())),
    ],
  },
  [DEP_PAGES_OLDER]: {
    size: 100, older: true,
    rows: [effect(outcomeRow("old-1", v5())), other(gate("gate-old")), effect(outcomeRow("old-2", older(3)))],
  },
  // A backend that pages and serves no count of what the filter matched, and none of every outcome.
  [DEP_PAGES_NO_COUNT]: {
    size: 2, leaveOut: ["matching_count", "recorded_count"],
    rows: [effect(outcomeRow("nc-1", v5())), effect(outcomeRow("nc-2", v5()))],
  },
  // A backend whose `next` is not a cursor, and whose count is not one either.
  [DEP_PAGES_ODD_NEXT]: {
    size: 2, put: { next: 7, matching_count: "five" },
    rows: [effect(outcomeRow("odd-1", v5())), effect(outcomeRow("odd-2", v5())), effect(outcomeRow("odd-3", v5()))],
  },
  [DEP_PAGES_NONE]: { size: 2, rows: [other(gate("gate-only"))] },
};

export interface BackendRequest {
  dep: string;
  search: string;
  params: Array<[string, string]>;
  /** The X-Failsafe-Service-Token header as it arrived; undefined when none was sent. */
  serviceToken: string | undefined;
  /** The Authorization header as it arrived. */
  authorization: string | undefined;
}
export interface Scripted { status: number; body: unknown }

export const HOSTILE_REFUSAL = hostileText("refusal");

export async function pagingBackend(): Promise<{
  user: Awaited<ReturnType<typeof signIn>>;
  /** The failsafe service token this console was started with (invented here): a stop's, never a read's. */
  serviceToken: string;
  /** Every chain-outcomes request the backend was sent, in order. */
  requests: BackendRequest[];
  requestsFor(dep: string): BackendRequest[];
  /** The cursor the backend issued for the page after the first `rows` matched rows of `dep`. */
  cursorAfter(dep: string, rows: number): string;
  /** The next request for this page of `dep` (`before` undefined: the first page) answers `answer`, once. */
  script(dep: string, before: string | undefined, answer: Scripted): void;
  close(): Promise<void>;
}> {
  const requests: BackendRequest[] = [];
  const serviceToken = newServiceToken();
  const scripted = new Map<string, Scripted[]>();
  const cursors = new Map<string, { dep: string; filter: string; index: number }>();
  // Shaped like a signed cursor: url-safe text, a colon, a signature. It holds no row id.
  const cursorFor = (dep: string, filter: string, index: number) => {
    const cursor = `WyJ${Buffer.from(`${dep}|${filter}|${index}`).toString("base64url")}:1tKx_${index}-ZqY`;
    cursors.set(cursor, { dep, filter, index });
    return cursor;
  };
  const http = await import("http");
  const server: Server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url = new URL(req.url ?? "", "http://backend.invalid");
      const json = (code: number, payload: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === "/api/token/" && req.method === "POST") {
        let username = "(none)";
        try { username = String((JSON.parse(raw || "{}") as { username?: unknown }).username); } catch { /* not JSON */ }
        return json(200, { access: `access-for-${username}`, refresh: `refresh-for-${username}` });
      }
      if (url.pathname === "/api/token/revoke/") return json(200, { revoked: true });
      if (url.pathname === "/api/token/refresh/") return json(200, { access: "access-for-admin", refresh: "refresh-for-admin" });
      const named = /^\/api\/assurance\/deployments\/([^/]+)\/chain-outcomes\/$/.exec(url.pathname);
      if (req.method !== "GET" || named === null || !(named[1] in RECORD)) return json(404, { detail: "Not found." });
      const dep = named[1];
      const params = Array.from(url.searchParams.entries());
      const header = (name: string) => {
        const value = req.headers[name];
        return Array.isArray(value) ? value.join(", ") : value;
      };
      requests.push({ dep, search: url.search, params, serviceToken: header("x-failsafe-service-token"), authorization: header("authorization") });
      const record = RECORD[dep];
      const queued = scripted.get(`${dep}|${url.searchParams.get("before") ?? ""}`);
      if (queued && queued.length > 0) {
        const answer = queued.shift()!;
        return json(answer.status, answer.body);
      }
      if (record.older) {
        return json(200, { outcomes: record.rows.map((one) => one.row), returned: record.rows.length, truncated: false, page_size: 100, recorded_count: record.rows.length, composition: { signal: null } });
      }
      const unknown = Array.from(new Set(params.map(([name]) => name))).filter((name) => name !== "before" && name !== "recorded_as").sort();
      if (unknown.length > 0) {
        return json(400, {
          error: `this read takes before and recorded_as, and does not know ${unknown.map((name) => `'${name}'`).join(", ")}. The rest of the outcomes are read with before=<the \`next\` of the answer before>; there is no offset and no page number.`,
          code: "unknown_parameter", parameters: unknown, unknown_count: unknown.length,
        });
      }
      const filters = url.searchParams.getAll("recorded_as");
      if (url.searchParams.has("recorded_as") && (filters.length !== 1 || filters[0] !== "observed_effect")) {
        return json(400, { error: UNKNOWN_RECORDED_AS_WORDS, code: "unknown_recorded_as" });
      }
      const filter = filters[0] ?? "";
      const matched = filter === "" ? record.rows : record.rows.filter((one) => one.effect);
      let from = 0;
      if (url.searchParams.has("before")) {
        const given = url.searchParams.getAll("before");
        const place = given.length === 1 ? cursors.get(given[0]) : undefined;
        if (place === undefined || place.dep !== dep || place.filter !== filter) return json(400, { error: BAD_CURSOR_WORDS, code: "bad_cursor" });
        from = place.index;
      }
      const page = matched.slice(from, from + record.size);
      const further = matched.length > from + record.size;
      const answer: Record<string, unknown> = {
        outcomes: page.map((one) => one.row), returned: page.length, truncated: further, page_size: record.size,
        recorded_count: record.rows.length, matching_count: matched.length,
        next: further ? cursorFor(dep, filter, from + record.size) : null, composition: { signal: null },
        ...(record.put ?? {}),
      };
      for (const key of record.leaveOut ?? []) delete answer[key];
      return json(200, answer);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${port}`;
  process.env.ATHENA_FAILSAFE_USER = "svc-operator";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc-secret"; // pragma: allowlist secret
  process.env.ATHENA_FAILSAFE_SERVICE_TOKEN = serviceToken;
  const app: Express = await makeApp();
  const user = await signIn(app);
  await signInToBackend(user);
  return {
    user,
    serviceToken,
    requests,
    requestsFor: (dep) => requests.filter((one) => one.dep === dep),
    cursorAfter: (dep, rows) => cursorFor(dep, "observed_effect", rows),
    script(dep, before, answer) {
      const key = `${dep}|${before ?? ""}`;
      scripted.set(key, [...(scripted.get(key) ?? []), answer]);
    },
    async close() {
      delete process.env.ATHENA_FAILSAFE_URL;
      delete process.env.ATHENA_FAILSAFE_USER;
      delete process.env.ATHENA_FAILSAFE_PASSWORD;
      delete process.env.ATHENA_FAILSAFE_SERVICE_TOKEN;
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
