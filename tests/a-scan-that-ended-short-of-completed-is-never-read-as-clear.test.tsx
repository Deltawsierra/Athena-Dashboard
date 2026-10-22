// @vitest-environment jsdom
/**
 * A scan that ended short of completed -- aborted, failed or refused -- is
 * never read as "Clear".
 *
 * Both scan screens kept one set of finished states (completed, aborted,
 * failed, refused) and drew every one of them the same way once nothing
 * gradable was on record: the Risk band "Clear", the basis "The scan returned
 * no gradable findings.", a ShieldCheck, and "The scan finished and returned no
 * findings. That is a result, not an absence of one." A run the engine stopped
 * before it started, or that raised and stored `{error}` as its result, has no
 * results at all (server/engine.ts resultsOf(undefined) -> []), so that is
 * exactly what it drew: the opposite of what happened.
 *
 * Now `completed` alone keeps that rendering, unchanged. Aborted, failed and
 * refused draw "Not assessed", say which way the scan ended and that no result
 * or band is derived from it, and show the engine's own `reason` and
 * `result.error` when it sent them -- which `runState` now reads, as
 * `retestRun` already did. The Retest panel stays, with a sentence saying what
 * a retest of a scan that did not complete can and cannot say.
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
import PentestScan from "@/pages/PentestScan";
import { queryClient } from "@/lib/queryClient";
import { makeApp, signIn } from "./helpers";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

const HIGH = { type: "reflected_xss", severity: "high", message: "Reflected input on /search", confidence: 0.65 };
/** The engine's own words, as jobs.py records them: a stop's `reason`, a raise's `result.error`. */
const STOP_REASON = "stopped by an operator: customer called";
const RAISED = "RuntimeError: the crawler lost its connection";
const REFUSAL = "the target is a loopback address";

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
    body: JSON.stringify({ username: "admin", password: TEST_ADMIN_PASSWORD }),
  });
  expect(login.status).toBe(200);
  session = (login.headers.get("set-cookie") ?? "").split(";")[0];
  clientId = (await agent.post("/api/clients").send({ name: "Ended", company: "Ended", email: "e@e.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://ended.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  engine.closeAllConnections?.();
  server.closeAllConnections?.();
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
/** A run the engine accepts, then answers the first poll with `answer`, as jobs.py `status` shapes it. */
const endsOnPoll = (answer: Record<string, unknown>) => {
  startBody = (runId) => ({ run_id: runId, state: "running" });
  pollAnswer = () => [200, answer];
};
/** Stopped before it started: no result at all, only the stop's reason (jobs.py submit_scan). */
const ABORTED_BEFORE_START = { state: "aborted", reason: STOP_REASON, done: true, result: null };
/** The work raised: FAILED, with the raise as the stored result's `error` (jobs.py submit_scan, runs.py result_of). */
const FAILED_ON_RAISE = { state: "failed", reason: null, done: true, result: { error: RAISED } };
/** Refused at preflight, with the engine's reason. */
const REFUSED_AT_PREFLIGHT = { state: "refused", reason: REFUSAL, done: true, result: null };

/** Pick the client, type the target and start the scan, as a person does; wait for the scan's `state`. */
async function startAScan(state: string) {
  await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
  await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
  fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
  fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://ended.example/" } });
  await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("button-start-scan"));
  await waitFor(() => expect(screen.getByTestId("text-state").textContent).toContain(state), { timeout: 6_000 });
}

const text = () => document.body.textContent ?? "";
const shieldCheck = () => document.querySelector("svg.lucide-shield-check");
const NO_FINDINGS_BEFORE_END =
  "No findings came back before it ended. That is not a result about the target, and nothing is derived from it.";
const FINISHED_AND_RETURNED_NONE = "The scan finished and returned no findings. That is a result, not an absence of one.";

/** Neither word of a result over a scan that returned none: no "Clear", no shield, no "finished and returned no findings". */
function expectNoVerdict() {
  expect(text()).not.toMatch(/Clear/);
  expect(text()).not.toMatch(/returned no (gradable )?findings/);
  expect(text()).not.toContain(FINISHED_AND_RETURNED_NONE);
  expect(shieldCheck()).toBeNull();
}

describe("Athena: a scan that ended short of completed, with nothing gradable on record", () => {
  it("stopped before it started (aborted, no result): Not assessed, the stop's reason, and never Clear", async () => {
    endsOnPoll(ABORTED_BEFORE_START);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("aborted");
    await waitFor(() => expect(screen.getByTestId("text-not-completed")).toBeTruthy());
    expect(screen.getByTestId("text-risk-band").textContent).toBe("Not assessed");
    // Muted, as "Not read" and "Not rated" are: not Clear's colour.
    expect(screen.getByTestId("text-risk-band").getAttribute("style")).toMatch(/--muted-foreground/);
    expect(screen.getByTestId("text-risk-basis").textContent).toBe(
      "The scan was stopped before it finished, so no result and no band is derived from it.",
    );
    expect(screen.getByTestId("text-not-completed").textContent).toContain("This scan was stopped before it finished.");
    expect(screen.getByTestId("text-not-completed").textContent).toContain(NO_FINDINGS_BEFORE_END);
    expect(screen.getByTestId("text-engine-reason").textContent).toBe(`Engine reason: ${STOP_REASON}`);
    expect(screen.queryByTestId("text-engine-error")).toBeNull();
    // The counts are a reading of what came back (nothing), and are still drawn as such.
    expect(screen.getByTestId("text-total").textContent).toBe("0");
    expectNoVerdict();
  });

  it("failed (the work raised): Not assessed, the engine's error, and never Clear", async () => {
    endsOnPoll(FAILED_ON_RAISE);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("failed");
    await waitFor(() => expect(screen.getByTestId("text-not-completed")).toBeTruthy());
    expect(screen.getByTestId("text-risk-band").textContent).toBe("Not assessed");
    expect(screen.getByTestId("text-risk-basis").textContent).toBe(
      "The scan did not complete: the engine reported an error, so no result and no band is derived from it.",
    );
    expect(screen.getByTestId("text-not-completed").textContent).toContain(
      "This scan did not complete: the engine reported an error.",
    );
    expect(screen.getByTestId("text-engine-error").textContent).toBe(`Engine error: ${RAISED}`);
    expect(screen.queryByTestId("text-engine-reason")).toBeNull();
    expectNoVerdict();
  });

  it("refused at preflight: Not assessed, the engine's reason, and never Clear", async () => {
    endsOnPoll(REFUSED_AT_PREFLIGHT);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("refused");
    await waitFor(() => expect(screen.getByTestId("text-not-completed")).toBeTruthy());
    expect(screen.getByTestId("text-risk-band").textContent).toBe("Not assessed");
    expect(screen.getByTestId("text-risk-basis").textContent).toBe(
      "The engine refused the scan at preflight, so no result and no band is derived from it.",
    );
    expect(screen.getByTestId("text-not-completed").textContent).toContain("The engine refused this scan at preflight.");
    expect(screen.getByTestId("text-engine-reason").textContent).toBe(`Engine reason: ${REFUSAL}`);
    expectNoVerdict();
  });

  it("stopped after it found a high: the band is derived from the high, and the list is said to be what came back before the stop", async () => {
    endsOnPoll({ state: "aborted", reason: STOP_REASON, done: true, result: { results: [HIGH] } });
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("aborted");
    await waitFor(() => expect(screen.getByTestId("text-count-high").textContent).toBe("1"));
    expect(screen.getByTestId("text-risk-band").textContent).toBe("Elevated");
    expect(screen.getByTestId("text-risk-basis").textContent).toBe("Derived from the worst severity found — not a score.");
    expect(screen.getByTestId("text-not-completed").textContent).toContain(
      "The findings listed are what came back before it ended, not a complete assessment of the target.",
    );
    expect(screen.getByTestId("text-not-completed").textContent).not.toContain(NO_FINDINGS_BEFORE_END);
    expect(screen.getByTestId("list-findings")).toBeTruthy();
    expect(text()).not.toMatch(/Not assessed|Clear/);
  });

  it("completed with nothing gradable: unchanged -- Clear, the shield, and a result that is not an absence of one", async () => {
    finishesInline([]);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("completed");
    await waitFor(() => expect(screen.getByTestId("text-risk-band").textContent).toBe("Clear"));
    expect(screen.getByTestId("text-risk-basis").textContent).toBe("The scan returned no gradable findings.");
    expect(screen.getByTestId("text-total").textContent).toBe("0");
    expect(text()).toContain(FINISHED_AND_RETURNED_NONE);
    expect(shieldCheck()).not.toBeNull();
    expect(screen.queryByTestId("text-not-completed")).toBeNull();
    expect(text()).not.toMatch(/Not assessed/);
  });
});

describe("Penetration testing: a scan that ended short of completed, with nothing gradable on record", () => {
  it("stopped before it started: says so with the stop's reason, and never that it finished and returned no findings", async () => {
    endsOnPoll(ABORTED_BEFORE_START);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><PentestScan /></QueryClientProvider>);
    await startAScan("aborted");
    await waitFor(() => expect(screen.getByTestId("text-not-completed")).toBeTruthy());
    expect(screen.getByTestId("text-not-completed").textContent).toContain("This scan was stopped before it finished.");
    expect(screen.getByTestId("text-not-completed").textContent).toContain(NO_FINDINGS_BEFORE_END);
    expect(screen.getByTestId("text-engine-reason").textContent).toBe(`Engine reason: ${STOP_REASON}`);
    expect(text()).not.toContain(FINISHED_AND_RETURNED_NONE);
    expect(text()).not.toMatch(/returned no (gradable )?findings/);
    expect(shieldCheck()).toBeNull();
    // The Retest panel stays, and says what a retest of a scan that did not complete can say.
    expect(screen.getByTestId("text-retest-after-ended").textContent).toBe(
      "This scan did not complete. A retest here looks again only at a finding it returned before it ended, " +
      "and says nothing about checks that did not run.",
    );
  });

  it("failed: says so with the engine's error", async () => {
    endsOnPoll(FAILED_ON_RAISE);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><PentestScan /></QueryClientProvider>);
    await startAScan("failed");
    await waitFor(() => expect(screen.getByTestId("text-not-completed")).toBeTruthy());
    expect(screen.getByTestId("text-not-completed").textContent).toContain(
      "This scan did not complete: the engine reported an error.",
    );
    expect(screen.getByTestId("text-engine-error").textContent).toBe(`Engine error: ${RAISED}`);
    expect(text()).not.toContain(FINISHED_AND_RETURNED_NONE);
    expect(shieldCheck()).toBeNull();
  });

  it("completed with nothing gradable: unchanged -- the shield and a result that is not an absence of one, no retest caveat", async () => {
    finishesInline([]);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><PentestScan /></QueryClientProvider>);
    await startAScan("completed");
    await waitFor(() => expect(text()).toContain(FINISHED_AND_RETURNED_NONE));
    expect(shieldCheck()).not.toBeNull();
    expect(screen.queryByTestId("text-not-completed")).toBeNull();
    expect(screen.queryByTestId("text-retest-after-ended")).toBeNull();
  });
});

describe("GET /api/scans/:testId: the engine's reason and error reach the answer", () => {
  async function startViaRoute(): Promise<string> {
    const started = await agent.post("/api/scans").send({ clientId, target: "https://ended.example/" });
    expect(started.status).toBe(201);
    return started.body.test.id as string;
  }

  it("a failed run answers its result.error and done, as retestRun reads them", async () => {
    endsOnPoll(FAILED_ON_RAISE);
    const id = await startViaRoute();
    const read = await agent.get(`/api/scans/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.state).toBe("failed");
    expect(read.body.engine.error).toBe(RAISED);
    expect(read.body.engine.done).toBe(true);
    expect(read.body.engine.findings).toEqual([]);
  });

  it("an aborted run answers the stop's reason as its detail, and no error", async () => {
    endsOnPoll(ABORTED_BEFORE_START);
    const id = await startViaRoute();
    const read = await agent.get(`/api/scans/${id}`);
    expect(read.body.state).toBe("aborted");
    expect(read.body.engine.detail).toBe(STOP_REASON);
    expect(read.body.engine.error).toBeNull();
  });

  it("a completed run carries no error", async () => {
    endsOnPoll({ state: "completed", reason: null, done: true, result: { results: [HIGH] } });
    const id = await startViaRoute();
    const read = await agent.get(`/api/scans/${id}`);
    expect(read.body.state).toBe("completed");
    expect(read.body.engine.error).toBeNull();
    expect(read.body.engine.findings).toEqual([HIGH]);
  });
});
