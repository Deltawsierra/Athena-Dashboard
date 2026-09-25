// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

/**
 * The kill switch page's report:
 *   - an engagement whose stops partly failed is toasted as a failure, not a
 *     plain success;
 *   - after "Reactivate All Systems", the page no longer says "Kill switch
 *     engaged; ... sent a stop" about a switch that is now off.
 *
 * (Pins mutants A02 and A03 of the round-5 mutation run, which survived the
 * whole suite.)
 */
const toasts: Array<{ title?: string; variant?: string }> = [];
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (t: { title?: string; variant?: string }) => { toasts.push(t); } }),
  toast: (t: { title?: string; variant?: string }) => { toasts.push(t); },
}));

import AIControlPanel from "@/pages/AIControlPanel";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); toasts.length = 0; });

const SETTINGS = {
  id: "s", systemStatus: "operational", killSwitchEnabled: false, overrideMode: false,
  activeSystems: ["penetration-testing"], maxConcurrentTests: 5, autoShutdownThreshold: 90,
  lastModifiedBy: null, lastModifiedAt: new Date().toISOString(),
};
const ENGAGED = { ...SETTINGS, killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] };
const scan = (testId: string, stopped: boolean, detail = "") =>
  ({ testId, runId: `run-${testId}`, target: `https://${testId}.example/`, stopped, detail });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async () => ENGAGED } } });
  client.setQueryData(["/api/ai-control"], SETTINGS);
  render(<QueryClientProvider client={client}><AIControlPanel /></QueryClientProvider>);
  return client;
}

function answers(stops: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.killSwitchEnabled === true) {
      return new Response(JSON.stringify({ ...ENGAGED, stops }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ...SETTINGS, ...body }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

async function engage() {
  fireEvent.click(screen.getByTestId("button-kill-switch"));
  fireEvent.click(screen.getByTestId("button-confirm-kill-switch"));
  return waitFor(() => screen.getByTestId("text-kill-switch-stops"));
}

describe("the kill switch page's report", () => {
  it("a stop that failed is toasted as a failure, not a plain success", async () => {
    mount();
    answers({ listed: true, scans: [scan("a", true), scan("b", false, "the engine did not accept the stop")] });
    await engage();
    const t = toasts.find((one) => one.title === "Kill switch engaged");
    expect(t?.variant).toBe("destructive");
  });

  it("after reactivating, the page no longer shows the engagement's report", async () => {
    const client = mount();
    answers({ listed: true, scans: [scan("a", true)] });
    await engage();
    client.setQueryData(["/api/ai-control"], ENGAGED);
    await waitFor(() => screen.getByTestId("button-resend-stops"));
    fireEvent.click(screen.getByText("Reactivate All Systems"));
    await waitFor(() => expect(screen.queryByTestId("text-kill-switch-stops")).toBeNull());
  });
});
