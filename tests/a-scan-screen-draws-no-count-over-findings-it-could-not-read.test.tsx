// @vitest-environment jsdom
/**
 * A scan screen draws no band, total or count over findings it could not read.
 *
 * When the engine's results for a finished scan could not be read, the record
 * has no counts (see `a-scan-whose-findings-could-not-be-read-has-no-counts-on-record.test.ts`).
 * Athena still derived its risk band and total from them: beside "The findings
 * could not be read", it said "Clear", "The scan returned no gradable findings."
 * and a total of 0 -- and the tests that looked for "returned no findings" did
 * not match the word "gradable". Both screens drew each count as 0.
 *
 * Now neither screen draws a band, a total or a count over them: Athena says
 * "Not read" and why, and both draw each count as "—".
 *
 * These drive each screen against the real routes, served over HTTP and signed
 * in, with an engine each test tells what to answer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import AthenaScan from "@/pages/AthenaScan";
import { latestScanReport } from "@/pages/Evidence";
import PentestScan from "@/pages/PentestScan";
import { queryClient } from "@/lib/queryClient";
import type { IStorage } from "../server/storage";
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
let storage: IStorage;
/** Set by a test to rewrite the record POST /api/scans has just written, before the screen reads it. */
let onStarted: ((testId: string) => Promise<void>) | null = null;

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
  clientId = (await agent.post("/api/clients").send({ name: "Unread", company: "Unread", email: "u@u.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://unread.example" });
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
  onStarted = null;
});

/** Every request the screen sends goes to the real routes, as the signed-in admin. */
function realRoutes() {
  const outbound = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/")) return outbound(url, init);
    const res = await outbound(`${base}${url}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), Cookie: session },
    });
    if (onStarted && init?.method === "POST" && url === "/api/scans" && res.status === 201) {
      await onStarted((await res.clone().json()).test.id);
    }
    return res;
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
  fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://unread.example/" } });
  await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("button-start-scan"));
  await waitFor(() => expect(screen.getByTestId("text-state").textContent).toContain(state), { timeout: 6_000 });
}

const text = () => document.body.textContent ?? "";
const COUNTED = ["critical", "high", "medium", "low"] as const;

/** Athena over findings it could not read: no band, no total, no count, and never "no findings". */
function expectAthenaDrawsNoCount() {
  expect(screen.getByTestId("text-findings-unread").textContent).toBe(UNREAD);
  expect(screen.getByTestId("text-risk-band").textContent).toBe("Not read");
  expect(screen.getByTestId("text-risk-basis").textContent).toBe(
    "The findings could not be read, so no band is derived from them.",
  );
  expect(screen.getByTestId("text-total").textContent).toBe("—");
  for (const sev of COUNTED) expect(screen.getByTestId(`text-count-${sev}`).textContent).toBe("—");
  expect(text()).not.toMatch(/returned no (gradable )?findings/);
  expect(text()).not.toMatch(/Clear/);
}

describe("Athena: a finished scan whose findings could not be read", () => {
  it("finished inline: draws no band, total or count, and never says it returned no gradable findings", async () => {
    finishesInline("garbled");
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("completed");
    await waitFor(() => expect(screen.getByTestId("text-findings-unread")).toBeTruthy());
    expectAthenaDrawsNoCount();
  });

  it("finished on a poll after one that counted a high: the high is not drawn as the scan's", async () => {
    startBody = (runId) => ({ run_id: runId, state: "running" });
    pollAnswer = () => [200, { state: "running", result: { results: [HIGH] } }];
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("running");
    await waitFor(() => expect(screen.getByTestId("text-count-high").textContent).toBe("1"));
    expect(screen.getByTestId("text-risk-band").textContent).toBe("Elevated");

    pollAnswer = () => [200, { state: "completed", result: { results: { 0: HIGH } } }];
    await waitFor(() => expect(screen.getByTestId("text-state").textContent).toContain("completed"), { timeout: 6_000 });
    await waitFor(() => expect(screen.getByTestId("text-risk-band").textContent).toBe("Not read"));
    expectAthenaDrawsNoCount();
  }, 15_000);

  it("stopped (aborted) on a poll whose findings could not be read: no band, total or count either", async () => {
    startBody = (runId) => ({ run_id: runId, state: "running" });
    pollAnswer = () => [200, { state: "aborted", result: { results: "garbled" } }];
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("aborted");
    await waitFor(() => expect(screen.getByTestId("text-findings-unread")).toBeTruthy());
    expectAthenaDrawsNoCount();
  });

  it("says Not recorded, with no total or count, beside findings whose counts were never recorded", async () => {
    finishesInline([HIGH]);
    // As an inline finish was recorded before the inline-count fix: its results, and every count 0.
    onStarted = async (testId) => {
      await storage.updateTest(testId, {
        severity: null, vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      });
    };
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("completed");
    await waitFor(() => expect(screen.getByTestId("list-findings")).toBeTruthy());
    expect(screen.getByTestId("text-risk-band").textContent).toBe("Not recorded");
    expect(screen.getByTestId("text-risk-basis").textContent).toBe(
      "The counts were not recorded, so no band is derived from them.",
    );
    expect(screen.getByTestId("text-total").textContent).toBe("—");
    for (const sev of COUNTED) expect(screen.getByTestId(`text-count-${sev}`).textContent).toBe("—");
    expect(text()).not.toMatch(/Clear/);
  });

  it("still derives the band from counts a readable finish recorded", async () => {
    finishesInline([HIGH]);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("completed");
    await waitFor(() => expect(screen.getByTestId("text-count-high").textContent).toBe("1"));
    expect(screen.getByTestId("text-risk-band").textContent).toBe("Elevated");
    expect(screen.getByTestId("text-total").textContent).toBe("1");
  });

  it("still says Clear over a readable finish that found nothing", async () => {
    finishesInline([]);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("completed");
    await waitFor(() => expect(screen.getByTestId("text-risk-band").textContent).toBe("Clear"));
    expect(screen.getByTestId("text-total").textContent).toBe("0");
    expect(text()).toContain("The scan returned no gradable findings.");
  });
});

describe("Penetration testing: a finished scan whose findings could not be read", () => {
  it("draws no count, says none was recorded, and never says it returned no findings", async () => {
    finishesInline("garbled");
    realRoutes();
    render(<QueryClientProvider client={queryClient}><PentestScan /></QueryClientProvider>);
    await startAScan("completed");
    await waitFor(() => expect(screen.getByTestId("text-findings-unread")).toBeTruthy());
    for (const sev of COUNTED) expect(screen.getByTestId(`text-count-${sev}`).textContent).toBe("—");
    expect(screen.getByTestId("text-counts-unrecorded").textContent).toBe(
      "No counts were recorded for this scan, so none are shown. That is not the same as a count of 0.",
    );
    expect(text()).not.toMatch(/returned no (gradable )?findings/);
  });
});

describe("Evidence: a latest completed scan whose findings could not be read", () => {
  it("says its results could not be read and its counts were not recorded, never 0 critical and 0 high", () => {
    const unread = {
      status: "completed", severity: null, vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      findings: { runId: "run-1", target: "https://unread.example/", results: null },
    };
    expect(latestScanReport(unread)).toBe(
      "Its latest completed scan's results could not be read, so its counts were not recorded",
    );
    expect(latestScanReport(unread)).not.toMatch(/0 critical/);
  });
});
