/**
 * A stand-in Athena-Backend for the economics reads: it answers each recorded
 * exchange's path with the recorded bytes, exactly, after a SimpleJWT sign-in
 * (/api/token/), and a deployment's recompute (a pause is a stop) with a
 * decision. A path it has no answer for is Django's own 404 page. One path may be
 * HELD: its headers and the first part of its body are sent, and the rest waits
 * until `release()` -- a backend that is slow, or stuck, mid-answer -- or held
 * before its headers (`holdHeaders`). A path's answer can be replaced
 * (`answer(path, ...)`): another status, content type or body.
 *
 * Every request is recorded in the order it arrived. No clock is read.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Exchange } from "./economics-fixtures";

export interface EconomicsSeen {
  method: string;
  path: string;
  query: string;
  bearer: string | undefined;
  body: string;
}

const DJANGO_404 = "\n<!doctype html>\n<html lang=\"en\">\n<head>\n  <title>Not Found</title>\n</head>\n<body>\n  <h1>Not Found</h1><p>The requested resource was not found on this server.</p>\n</body>\n</html>\n";

export async function economicsStandIn(answers: Exchange[]) {
  const seen: EconomicsSeen[] = [];
  let waiters: Array<{ match: (one: EconomicsSeen) => boolean; resolve: (one: EconomicsSeen) => void }> = [];
  let holding: string | null = null;
  let holdingHeaders: string | null = null;
  const held: http.ServerResponse[] = [];
  const heldRest: Array<string | null> = [];
  const overrides = new Map<string, { status: number; contentType: string | null; body: string }>();
  let heldClosed = 0;
  const closed = new WeakSet<http.ServerResponse>();
  let closeWaiters: Array<{ count: number; resolve: () => void }> = [];
  const noteClosed = () => {
    heldClosed += 1;
    const ready = closeWaiters.filter((w) => heldClosed >= w.count);
    closeWaiters = closeWaiters.filter((w) => heldClosed < w.count);
    ready.forEach((w) => w.resolve());
  };
  let issued = 0;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stand-in");
      const authorization = req.headers.authorization;
      const entry: EconomicsSeen = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.search,
        bearer: authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined,
        body: raw,
      };
      seen.push(entry);
      const ready = waiters.filter((w) => w.match(entry));
      waiters = waiters.filter((w) => !w.match(entry));
      ready.forEach((w) => w.resolve(entry));

      if (entry.path === "/api/token/" && entry.method === "POST") {
        issued += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access: `access-${issued}`, refresh: `refresh-${issued}` }));
        return;
      }
      if (entry.bearer === undefined || !entry.bearer.startsWith("access-")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Authentication credentials were not provided." }));
        return;
      }
      if (entry.method === "POST" && /^\/api\/assurance\/deployments\/[^/]+\/recompute\/$/.test(entry.path)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ decision: "paused", decision_label: "Paused" }));
        return;
      }
      const replaced = overrides.get(entry.path);
      const recorded = answers.find((one) => one.path === entry.path + entry.query)
        ?? answers.find((one) => one.path === entry.path);
      const answer = replaced ?? (recorded ? { status: recorded.status, contentType: recorded.content_type, body: recorded.body } : undefined);
      if (entry.method !== "GET" || answer === undefined) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DJANGO_404);
        return;
      }
      if (holdingHeaders !== null && entry.path === holdingHeaders) {
        res.on("close", () => { closed.add(res); noteClosed(); });
        held.push(res);
        heldRest.push(null);
        return;
      }
      res.writeHead(answer.status, answer.contentType === null ? {} : { "Content-Type": answer.contentType });
      if (holding !== null && entry.path === holding) {
        const half = Math.floor(answer.body.length / 2);
        res.on("close", () => { closed.add(res); noteClosed(); });
        res.write(answer.body.slice(0, half));
        held.push(res);
        heldRest.push(answer.body.slice(half));
        return;
      }
      res.end(answer.body);
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    /** Reads of economics routes the backend received. */
    economicsReads: () => seen.filter((one) => one.path.includes("/economics/")),
    /** Hold every answer to this path mid-body until release(). */
    hold(path: string): void { holding = path; },
    /** Hold every answer to this path before its headers, until the stand-in closes. */
    holdHeaders(path: string): void { holdingHeaders = path; },
    /** Answer this path with another status, content type (null: none) and body. */
    answer(path: string, status: number, contentType: string | null, body: string): void {
      overrides.set(path, { status, contentType, body });
    },
    /** Resolves once `count` held answers have been closed (by either side). */
    heldClosedAtLeast(count: number): Promise<void> {
      if (heldClosed >= count) return Promise.resolve();
      return new Promise((resolve) => { closeWaiters.push({ count, resolve }); });
    },
    /** Whether a held answer is still open. */
    holdingOpen: () => held.some((res) => !res.writableEnded && !closed.has(res)),
    release(): void {
      held.forEach((res, index) => {
        const rest = heldRest[index];
        if (rest !== null && !res.destroyed) res.end(rest);
      });
      held.length = 0;
      heldRest.length = 0;
      holding = null;
    },
    waitFor(match: (one: EconomicsSeen) => boolean): Promise<EconomicsSeen> {
      const already = seen.find(match);
      if (already) return Promise.resolve(already);
      return new Promise((resolve) => { waiters.push({ match, resolve }); });
    },
    close: async () => {
      waiters = [];
      closeWaiters = [];
      held.forEach((res) => res.destroy());
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export type EconomicsStandIn = Awaited<ReturnType<typeof economicsStandIn>>;
