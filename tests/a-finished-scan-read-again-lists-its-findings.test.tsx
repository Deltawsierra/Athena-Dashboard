// @vitest-environment jsdom
/**
 * A finished scan read again lists the findings it recorded, and never says it
 * returned none when it holds some.
 *
 * `GET /api/scans/:testId` stops asking the engine once a run is recorded as
 * completed, and answered `engine: null` from then on. The Athena and
 * Penetration Testing screens read that as an empty list: a scan the engine
 * finished inline, read at once, and any finished scan read again, said "The
 * scan finished and returned no findings" beside the counts counted from those
 * findings. The route now answers the findings the record holds, as the engine
 * sent them, and a screen given none to read says they could not be read.
 *
 * These drive each screen against the real routes, signed in, with an engine
 * that finishes the scan inline.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";
import { queryClient } from "@/lib/queryClient";
import type { IStorage } from "../server/storage";
import { makeApp, signIn } from "./helpers";

/** mythos-core `evidence.BASIS`, as the engine sends it on every finding it scores. */
const BASIS =
  "ordinal: derived from the number of independent signals in the evidence. " +
  "Not a probability that this finding is real.";
const FINDINGS = [
  {
    type: "reflected_xss", severity: "high", message: "Reflected input on /search", endpoint: "/search",
    confidence: 0.65, confidence_basis: BASIS,
  },
  { type: "missing_header", severity: "low", message: "No Content-Security-Policy header", header: "content-security-policy", confidence: 0.25 },
];

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let engine: Server;
let server: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
/** Where the real routes are served, and the session the screen sends them. */
let base: string;
let session: string;
let clientId: string;
let runs = 0;
/** Set by a test: the record's findings are made unreadable once the scan has started. */
let garbleOnStart = false;

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;

  // The engine finishes every scan inline, with both findings.
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active") return json(res, 200, { active: [] });
    if (req.method === "POST" && url === "/api/scan") {
      runs += 1;
      return json(res, 200, { run_id: `run-${runs}`, state: "completed", result: { results: FINDINGS } });
    }
    return json(res, 404, { detail: "not here" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  const app = await makeApp();
  agent = await signIn(app);
  storage = (await import("../server/storage-unified")).storage;
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
  clientId = (await agent.post("/api/clients").send({ name: "Inline", company: "Inline", email: "i@i.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://inline.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
  garbleOnStart = false;
});

/**
 * Every request the screen sends goes to the real routes, served over HTTP, as the
 * signed-in admin. The server shares this process, and its own requests to the
 * engine go out as sent.
 */
function realRoutes() {
  const outbound = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/")) return outbound(url, init);
    const res = await outbound(`${base}${url}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), Cookie: session },
    });
    if (garbleOnStart && init?.method === "POST" && url === "/api/scans" && res.status === 201) {
      const { test } = await res.clone().json();
      await storage.updateTest(test.id, { findings: { ...test.findings, results: "garbled" } });
    }
    return res;
  });
}

/** Pick the client, type the target and start the scan, as a person does. */
async function startAScan() {
  await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
  await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
  fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
  fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://inline.example/" } });
  await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("button-start-scan"));
  // The record's counts, counted from the findings the engine returned.
  await waitFor(() => expect(screen.getByTestId("text-count-high").textContent).toBe("1"));
  expect(screen.getByTestId("text-count-low").textContent).toBe("1");
}

const text = () => document.body.textContent ?? "";

for (const [name, Page] of [["Athena", AthenaScan], ["Penetration testing", PentestScan]] as const) {
  describe(`${name}: a scan the engine finished, read again`, () => {
    it("lists the findings it recorded, each with the engine's basis for its confidence, beside its counts", async () => {
      realRoutes();
      render(<QueryClientProvider client={queryClient}><Page /></QueryClientProvider>);
      await startAScan();

      expect(text()).not.toMatch(/returned no (gradable )?findings/);
      const list = await screen.findByTestId("list-findings");
      expect(list.querySelectorAll("li")).toHaveLength(2);
      const xss = within(list).getByText("Reflected input on /search").closest("li") as HTMLElement;
      expect(within(xss).getByTestId("text-finding-confidence-value").textContent).toBe("confidence 0.65");
      expect(within(xss).getByTestId("text-finding-confidence-basis").textContent).toBe(
        `The engine's basis for this number: ${BASIS}`,
      );
      const header = within(list).getByText("No Content-Security-Policy header").closest("li") as HTMLElement;
      expect(within(header).getByTestId("text-finding-confidence-basis").textContent).toBe(
        "The engine sent no basis for this number.",
      );
      expect(screen.queryByTestId("text-findings-unread")).toBeNull();
    });

    it("says the findings could not be read, never that it returned none, when the record's cannot be", async () => {
      garbleOnStart = true;
      realRoutes();
      render(<QueryClientProvider client={queryClient}><Page /></QueryClientProvider>);
      await startAScan();

      expect(text()).not.toMatch(/returned no (gradable )?findings/);
      expect(screen.getByTestId("text-findings-unread").textContent).toBe(
        "The findings could not be read, so none are listed here. That is not the same as none found.",
      );
      // Why, in the route's words.
      expect(text()).toMatch(/the findings recorded for this scan could not be read/);
      expect(screen.queryByTestId("list-findings")).toBeNull();
    });
  });
}
