/**
 * A stand-in for Athena-Backend's `GET /api/health/` (athena-backend #217, #226),
 * told by each test what to answer: a body with a status, a hang (the request is
 * taken and never answered), or a socket destroyed. Every other path is 404.
 * Records each request it saw, with its headers, so a test can say what the
 * health read sent -- and that it sent no credential.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type HealthAnswer =
  | { kind: "answer"; status: number; body: string }
  | { kind: "hang" }
  | { kind: "destroy" };

export interface HealthStandIn {
  url: string;
  answer: HealthAnswer;
  seen: Array<{ path: string; headers: http.IncomingHttpHeaders }>;
  /** Requests taken and not answered (a hang), still open. */
  holding(): number;
  waitFor(test: () => boolean, ms?: number): Promise<void>;
  close(): Promise<void>;
}

export const json = (value: unknown, status = 200): HealthAnswer => ({ kind: "answer", status, body: JSON.stringify(value) });

export async function healthStandIn(answer: HealthAnswer = json({ status: "ok", message: "Django backend is alive." })): Promise<HealthStandIn> {
  const held = new Set<http.ServerResponse>();
  const stand: HealthStandIn = {
    url: "",
    answer,
    seen: [],
    holding: () => held.size,
    async waitFor(test, ms = 5_000) {
      const until = Date.now() + ms;
      while (!test()) {
        if (Date.now() > until) throw new Error("the health stand-in did not see what was waited for");
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    close: async () => {
      for (const res of held) res.destroy();
      held.clear();
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
  const server = http.createServer((req, res) => {
    stand.seen.push({ path: req.url ?? "", headers: req.headers });
    if (req.url !== "/api/health/") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "Not found." }));
      return;
    }
    const now = stand.answer;
    if (now.kind === "hang") {
      held.add(res);
      res.on("close", () => held.delete(res));
      return;
    }
    if (now.kind === "destroy") {
      req.socket.destroy();
      return;
    }
    res.writeHead(now.status, { "Content-Type": "application/json" });
    res.end(now.body);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  stand.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stand;
}
