// @vitest-environment jsdom
/**
 * The Athena and Penetration Testing screens list the findings they can show,
 * and say so when there are findings they cannot.
 *
 * Round 1 of PR #55's adversary found three ways a screen did not:
 *
 * - A row with an object in a text field (`message: { text }`) was answered, and
 *   the page threw "Objects are not valid as a React child" and went blank.
 * - An engine `result.results` that is not a list was recorded as `[]`, and the
 *   screen said "The scan finished and returned no findings".
 * - A row marked `internal: "yes"` was counted as a high and listed as a note,
 *   so the screen said it "returned no findings" beside High 1.
 *
 * It also pins two things the screens did and nothing tested: the engine's notes
 * on a finished scan read again are listed under "From the engine", and Athena
 * does not say "The engine has reported nothing yet" while the engine cannot be
 * reached mid-run.
 *
 * These drive each screen against the real routes, served over HTTP and signed
 * in, with an engine each test tells what to answer.
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
import { makeApp, signIn } from "./helpers";

const HIGH = { type: "reflected_xss", severity: "high", message: "Reflected input on /search", confidence: 0.65 };
const UNREAD = "The findings could not be read, so none are listed here. That is not the same as none found.";

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** What the engine answers a start and a poll with; each test sets its own. */
let startBody: (runId: string) => Record<string, unknown>;
let pollAnswer: () => [number, Record<string, unknown>];
let engine: Server;
let server: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let base: string;
let session: string;
let clientId: string;
let runs = 0;

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
    if (req.method === "POST" && url === "/api/scan") {
      runs += 1;
      return json(res, 200, startBody(`run-${runs}`));
    }
    if (req.method === "GET" && url.startsWith("/api/scans/run-")) return json(res, ...pollAnswer());
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
  clientId = (await agent.post("/api/clients").send({ name: "Shown", company: "Shown", email: "s@s.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://shown.example" });
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
});

/** Every request the screen sends goes to the real routes, as the signed-in admin. */
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

/** A run the engine finishes inline with `results`. */
const finishesInline = (results: unknown) => {
  startBody = (runId) => ({ run_id: runId, state: "completed", result: { results } });
  pollAnswer = () => [404, { detail: "not asked" }];
};

/** Pick the client, type the target and start the scan, as a person does; wait for the scan's `state`. */
async function startAScan(state: string) {
  await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
  await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
  fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
  fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://shown.example/" } });
  await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("button-start-scan"));
  await waitFor(() => expect(screen.getByTestId("text-state").textContent).toContain(state));
}

const text = () => document.body.textContent ?? "";

for (const [name, Page] of [["Athena", AthenaScan], ["Penetration testing", PentestScan]] as const) {
  describe(`${name}: findings it cannot show`, () => {
    it("says a finding with an object for its message could not be read, and never blanks the page", async () => {
      finishesInline([HIGH, { type: "reflected_xss", severity: "high", message: { text: "an object message" } }]);
      realRoutes();
      render(<QueryClientProvider client={queryClient}><Page /></QueryClientProvider>);
      await startAScan("completed");

      await waitFor(() => expect(screen.getByTestId("text-findings-unread").textContent).toBe(UNREAD));
      expect(text()).toMatch(/the findings recorded for this scan could not be read/);
      expect(screen.queryByTestId("list-findings")).toBeNull();
      expect(text()).not.toMatch(/returned no findings/);
      // Counted, not dropped: both rows are highs.
      expect(screen.getByTestId("text-count-high").textContent).toBe("2");
    });

    it("says results the engine sent that are not a list could not be read, never that it returned none", async () => {
      finishesInline("garbled");
      realRoutes();
      render(<QueryClientProvider client={queryClient}><Page /></QueryClientProvider>);
      await startAScan("completed");

      await waitFor(() => expect(screen.getByTestId("text-findings-unread").textContent).toBe(UNREAD));
      expect(text()).toMatch(/the findings recorded for this scan could not be read/);
      expect(text()).not.toMatch(/returned no findings/);
      expect(screen.queryByTestId("list-findings")).toBeNull();
    });

    it("lists any truthy `internal` as the engine's note, never as a finding, and its counts agree", async () => {
      finishesInline([
        HIGH,
        { type: "engine_error", severity: "high", message: "a note marked yes", internal: "yes" },
        { type: "engine_error", severity: "high", message: "a note marked true", internal: true },
        // Falsy as the engine reads it (Python): a finding, though JavaScript calls [] truthy.
        { ...HIGH, message: "a finding marked with an empty list", internal: [] },
      ]);
      realRoutes();
      render(<QueryClientProvider client={queryClient}><Page /></QueryClientProvider>);
      await startAScan("completed");

      const list = await screen.findByTestId("list-findings");
      expect(list.querySelectorAll("li")).toHaveLength(2);
      expect(within(list).getByText("Reflected input on /search")).toBeTruthy();
      expect(within(list).getByText("a finding marked with an empty list")).toBeTruthy();
      expect(screen.getByTestId("text-count-high").textContent).toBe("2");
      // The notes of a finished scan, read again from the record, are listed as the engine's.
      expect(text()).toMatch(/From the engine/);
      expect(text()).toContain("a note marked yes");
      expect(text()).toContain("a note marked true");
      expect(list.textContent).not.toContain("a note marked");
      expect(text()).not.toMatch(/returned no findings/);
      expect(screen.queryByTestId("text-findings-unread")).toBeNull();
    });

    it("says the findings could not be read while the engine cannot be reached mid-run, and never that it has none", async () => {
      startBody = (runId) => ({ run_id: runId, state: "running" });
      pollAnswer = () => [503, { detail: "the engine is restarting" }];
      realRoutes();
      render(<QueryClientProvider client={queryClient}><Page /></QueryClientProvider>);
      await startAScan("running");

      await waitFor(() => expect(screen.getByTestId("text-findings-unread").textContent).toBe(UNREAD));
      expect(text()).toMatch(/the engine answered 503/);
      expect(text()).not.toMatch(/reported nothing yet/);
      expect(text()).not.toMatch(/returned no findings/);
    });
  });
}

describe("Athena: a run with nothing to report yet", () => {
  it("says the engine has reported nothing yet, which it only says over a list it read", async () => {
    startBody = (runId) => ({ run_id: runId, state: "running" });
    pollAnswer = () => [200, { state: "running" }];
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("running");

    await waitFor(() => expect(text()).toMatch(/The engine has reported nothing yet\./));
    expect(screen.queryByTestId("text-findings-unread")).toBeNull();
  });
});
