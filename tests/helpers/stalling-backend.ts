/**
 * A stand-in backend that stalls every read mid-answer: after a SimpleJWT sign-in
 * (/api/token/), each GET is answered 200 `application/json` with the first bytes
 * of a body -- and nothing more, until `release()` or the reader goes away. A
 * deployment's recompute (a pause, when `paused` is true: a stop) is answered at
 * once with a decision, unless `holdPosts()` holds it too.
 *
 * It records every request in the order it arrived, and every held answer that
 * was closed (by the reader cancelling it, or by the stand-in closing). No clock is
 * read.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface StalledSeen {
  method: string;
  path: string;
  body: string;
}

export async function stallingBackend() {
  const seen: StalledSeen[] = [];
  const held: http.ServerResponse[] = [];
  const closed = new WeakSet<http.ServerResponse>();
  let closedCount = 0;
  let holdingPosts = false;
  const heldPosts: Array<() => void> = [];
  let waiters: Array<{ ready: () => boolean; resolve: () => void }> = [];
  let issued = 0;

  const wake = () => {
    const ready = waiters.filter((w) => w.ready());
    waiters = waiters.filter((w) => !w.ready());
    ready.forEach((w) => w.resolve());
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { raw += chunk; });
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://stand-in").pathname;
      const method = req.method ?? "GET";
      seen.push({ method, path, body: raw });
      if (path === "/api/token/" && method === "POST") {
        issued += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access: `access-${issued}`, refresh: `refresh-${issued}` }));
        wake();
        return;
      }
      if (method === "POST" && /^\/api\/assurance\/deployments\/[^/]+\/recompute\/$/.test(path)) {
        const answer = () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ decision: "paused", decision_label: "Paused" }));
        };
        if (holdingPosts) heldPosts.push(answer);
        else answer();
        wake();
        return;
      }
      if (method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"results": [');
        res.on("close", () => {
          if (!closed.has(res)) {
            closed.add(res);
            closedCount += 1;
            wake();
          }
        });
        held.push(res);
        wake();
        return;
      }
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end("{}");
      wake();
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));

  const until = (ready: () => boolean) =>
    ready() ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push({ ready, resolve }); });

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    /** GET reads the backend received (the token endpoint aside). */
    reads: () => seen.filter((one) => one.method === "GET"),
    /** Held answers still open. */
    open: () => held.filter((res) => !closed.has(res)).length,
    /** Held answers closed so far. */
    closedCount: () => closedCount,
    /** Resolves once `count` GET reads have arrived. */
    readsAtLeast: (count: number) => until(() => seen.filter((one) => one.method === "GET").length >= count),
    /** Resolves once `count` held answers have been closed. */
    closedAtLeast: (count: number) => until(() => closedCount >= count),
    /** Resolves once a request matching `match` has arrived. */
    arrived: (match: (one: StalledSeen) => boolean) => until(() => seen.some(match)),
    /** Hold the answer to every recompute from now on, until releasePosts(). */
    holdPosts(): void { holdingPosts = true; },
    releasePosts(): void {
      holdingPosts = false;
      heldPosts.splice(0).forEach((answer) => answer());
    },
    /** Finish every held read. */
    release(): void {
      held.forEach((res) => { if (!closed.has(res) && !res.writableEnded) res.end("]}"); });
    },
    close: async () => {
      waiters = [];
      held.forEach((res) => res.destroy());
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export type StallingBackend = Awaited<ReturnType<typeof stallingBackend>>;
