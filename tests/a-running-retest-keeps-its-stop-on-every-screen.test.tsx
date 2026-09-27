// @vitest-environment jsdom
/**
 * A running retest keeps a Stop that can be pressed, wherever it is shown:
 *
 *   - Scans running now draws the engine's running retests with their Stop as
 *     soon as the engine's list is in, without waiting for the app's own list
 *     of tests (which a slow database holds up);
 *   - the retest panel, opened again while a retest runs, shows it running
 *     with its Stop -- from the server's record of the watch -- and offers no
 *     second Retest;
 *   - a Stop whose request hangs is never disabled: pressed again, it sends
 *     the stop again; and the kill switch is named beside it;
 *   - while the engine is answering a retest, the panel says where its Stop is;
 *   - a verdict filed after a stop was accepted says it completed despite it.
 *
 * The components are the real ones; fetch answers what this dashboard's own
 * routes answer (server/routes.ts retestView and the retest routes).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import RunningScans from "@/components/RunningScans";
import RetestPanel from "@/components/RetestPanel";
import { queryClient } from "@/lib/queryClient";

const RETEST_RUN = { runId: "r-1", stopId: "r-1", target: "https://offline.invalid/", state: "running", kind: "retest" };
const never = () => new Promise<Response>(() => undefined);
const ok = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const twin = {
  id: 7, runId: "scan-run", target: "https://offline.invalid/", findingType: "xss", severity: "high", tier: null,
  confidence: null, endpoint: "https://offline.invalid/search", detail: null, capturedAt: null,
};
const running = (runId: string) => ({
  answer: "status", phase: "running", engineRunId: runId, testId: "t1", twinId: 7, state: "running",
  reason: null, error: null, stoppable: true, detail: "The engine is still running this retest against the target.",
});

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("Scans running now", () => {
  it("draws a running retest's Stop while the app's own list of tests is still loading", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      asked.push(`${init?.method ?? "GET"} ${u}`);
      if (u.endsWith("/api/tests")) return never();
      if (u.endsWith("/api/clients")) return never();
      if (u.endsWith("/api/engine/runs")) return ok({ runs: [RETEST_RUN], configured: true });
      if (u.endsWith("/abort")) return ok({ stopped: true, runId: "r-1" });
      return ok({});
    }));
    render(<QueryClientProvider client={queryClient}><RunningScans exclude={null} /></QueryClientProvider>);
    fireEvent.click(await screen.findByTestId("button-stop-retest-run-r-1"));
    await waitFor(() => expect(asked).toContain("POST /api/retests/r-1/abort"));
  });

  it("never disables a retest's Stop while its request hangs: pressed again, it is sent again", async () => {
    const aborts: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/tests")) return ok([]);
      if (u.endsWith("/api/clients")) return ok([]);
      if (u.endsWith("/api/engine/runs")) return ok({ runs: [RETEST_RUN], configured: true });
      if (u.endsWith("/abort") && init?.method === "POST") { aborts.push(u); return never(); }
      return ok({});
    }));
    render(<QueryClientProvider client={queryClient}><RunningScans exclude={null} /></QueryClientProvider>);
    const stop = await screen.findByTestId("button-stop-retest-run-r-1");
    fireEvent.click(stop);
    await waitFor(() => expect(aborts).toHaveLength(1));
    const again = screen.getByTestId("button-stop-retest-run-r-1") as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    fireEvent.click(again);
    await waitFor(() => expect(aborts).toHaveLength(2));
  });
});

describe("the retest panel", () => {
  it("opened again while a retest runs, shows it running with its Stop, from the server's watch, and offers no second Retest", async () => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") posts.push(u);
      if (u.includes("/api/tests/t1/decisions")) return ok({ decisions: [twin], truncated: false, detail: "" });
      if (u.endsWith("/api/tests/t1/retests")) return ok({ retests: [running("eng-1")] });
      if (u.includes("/api/retests/eng-1") && !init?.method) return ok(running("eng-1"));
      if (u.endsWith("/api/retests/eng-1/abort")) return ok({ stopped: true, runId: "eng-1" });
      return ok({});
    }));
    render(<QueryClientProvider client={queryClient}><RetestPanel testId="t1" /></QueryClientProvider>);
    const stop = await screen.findByTestId("button-stop-retest-7");
    expect(screen.getByTestId("text-retest-phase-7").textContent).toBe("Running");
    expect((screen.getByTestId("button-retest-7") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("text-retest-killswitch-7").textContent).toMatch(/kill switch/);
    fireEvent.click(stop);
    await waitFor(() => expect(posts).toEqual(["/api/retests/eng-1/abort"]));
  });

  it("never disables the only Stop while its request hangs: pressed again, it is sent again", async () => {
    const aborts: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/tests/t1/decisions")) return ok({ decisions: [twin], truncated: false, detail: "" });
      if (u.endsWith("/api/tests/t1/retests")) return ok({ retests: [running("eng-2")] });
      if (u.endsWith("/api/retests/eng-2/abort")) { aborts.push(u); return never(); }
      if (u.includes("/api/retests/eng-2")) return ok(running("eng-2"));
      return ok({});
    }));
    render(<QueryClientProvider client={queryClient}><RetestPanel testId="t1" /></QueryClientProvider>);
    fireEvent.click(await screen.findByTestId("button-stop-retest-7"));
    await waitFor(() => expect(aborts).toHaveLength(1));
    const again = screen.getByTestId("button-stop-retest-7") as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    fireEvent.click(again);
    await waitFor(() => expect(aborts).toHaveLength(2));
  });

  it("while the engine is answering a retest, says where its Stop is", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/tests/t1/decisions")) return ok({ decisions: [twin], truncated: false, detail: "" });
      if (u.endsWith("/api/tests/t1/retests")) return ok({ retests: [] });
      if (u.endsWith("/api/tests/t1/retest") && init?.method === "POST") return never();
      return ok({});
    }));
    render(<QueryClientProvider client={queryClient}><RetestPanel testId="t1" /></QueryClientProvider>);
    fireEvent.click(await screen.findByTestId("button-retest-7"));
    const waiting = await screen.findByTestId("text-retest-waiting-7");
    expect(waiting.textContent).toMatch(/Scans running now lists it with its Stop, and the kill switch stops it/);
  });

  it("a verdict filed after a stop was accepted says it completed despite the stop", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/tests/t1/decisions")) return ok({ decisions: [twin], truncated: false, detail: "" });
      if (u.endsWith("/api/tests/t1/retests")) return ok({ retests: [running("eng-3")] });
      if (u.includes("/api/retests/eng-3") && !init?.method) {
        return ok({
          ...running("eng-3"), answer: "verdict", phase: "verdict", stoppable: false,
          result: { twinId: 7, verdict: "closed", detail: "xss was not reported", target: null, findingType: "xss",
            inventoryDigest: null, runId: "511", engineRunId: "eng-3", checkedAt: null, completedDespiteStop: true },
        });
      }
      return ok({});
    }));
    render(<QueryClientProvider client={queryClient}><RetestPanel testId="t1" /></QueryClientProvider>);
    const note = await screen.findByTestId("text-verdict-despite-stop-7", {}, { timeout: 5_000 });
    expect(note.textContent).toMatch(/Completed despite a stop request/);
  });
});
