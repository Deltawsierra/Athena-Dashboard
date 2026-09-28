// @vitest-environment jsdom
/**
 * athena-engine #71 answers a scan launch that failed after its run was
 * registered, with its work already started, as a 500 `answer: "status"`
 * naming the run with `state: null`. The dashboard records that run as
 * running, with its Stop, and says what the engine said went wrong in the
 * start's `warning`. That warning is the operator's to read: Athena and
 * Penetration Testing show it beside the scan's Stop, as the server said it.
 *
 * The engine's answer is the one the real engine app sent
 * (tests/fixtures/engine-retest/pr71-f4610ae/scan-failed-after-registration.json,
 * recorded by generate.py beside it at athena-engine f4610ae on the unpinned
 * local core), served by a stand-in engine over HTTP; the screens run against
 * the real routes, signed in.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";
import { queryClient } from "@/lib/queryClient";
import { makeApp, signIn } from "./helpers";

type Exchange = { note: string; request: { method: string; path: string }; status: number; body: any; headers?: Record<string, string> };
const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "fixtures", "engine-retest", "pr71-f4610ae",
  "scan-failed-after-registration.json"), "utf8")) as { exchanges: Exchange[] };
const scenario = fixture.exchanges.filter((one) => !one.note.startsWith("setup"));
const launch = scenario.find((one) => one.request.method === "POST" && one.request.path === "/api/scan")!;
const running = scenario.find((one) => one.request.method === "GET" && one.body?.state === "running")!;

const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

let engine: Server;
let server: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let base: string;
let session: string;
let clientId: string;

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;

  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active") return json(res, 200, { active: [] });
    if (req.method === "POST" && url === "/api/scan") return json(res, launch.status, launch.body, launch.headers ?? {});
    if (req.method === "GET" && url.startsWith("/api/scans/")) return json(res, running.status, running.body);
    return json(res, 404, { detail: "not here" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  const app = await makeApp();
  agent = await signIn(app);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  expect(login.status).toBe(200);
  session = (login.headers.get("set-cookie") ?? "").split(";")[0];
  clientId = (await agent.post("/api/clients").send({ name: "Registered", company: "Registered", email: "r@r.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://offline.invalid" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  engine.closeAllConnections?.();
  server.closeAllConnections?.();
  await new Promise<void>((r) => engine.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
  // Every scan started here is recorded as ended, so none counts against the next.
  const { storage } = await import("../server/storage-unified");
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
});

function realRoutes() {
  const outbound = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/")) return outbound(url, init);
    return outbound(`${base}${url}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), Cookie: session },
    });
  });
}

for (const [name, Screen] of [["Athena", AthenaScan], ["Penetration testing", PentestScan]] as const) {
  describe(`${name}: a scan the engine failed after registering, its work started (500, state null)`, () => {
    it("shows the engine's warning beside the scan's Stop", async () => {
      realRoutes();
      render(<QueryClientProvider client={queryClient}><Screen /></QueryClientProvider>);
      await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
      await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
      fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
      fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://offline.invalid/" } });
      await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByTestId("button-start-scan"));
      const warning = await screen.findByTestId("text-start-warning");
      expect(warning.textContent).toContain(launch.body.run_id);
      expect(warning.textContent).toContain(launch.body.error);
      expect(screen.getByTestId("button-stop-scan")).toBeTruthy();
    });
  });
}
