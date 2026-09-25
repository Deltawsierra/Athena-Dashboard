// @vitest-environment jsdom
import { it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

import AIControlPanel from "@/pages/AIControlPanel";

/**
 * R5-H, the page's half. It offered an "Auto-Shutdown Threshold" ("system
 * load threshold for automatic safety shutdown"), "Override Mode" ("bypass
 * safety protocols for emergency operations") and a "Threat Detection"
 * switch, none of which anything enforced -- controls that do nothing,
 * presented as safety controls. They are gone. What remains is enforced when
 * a scan starts (server/routes.ts POST /api/scans), and each says so; no
 * switch claims to stop a running scan.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const SETTINGS = {
  id: "s", systemStatus: "operational", killSwitchEnabled: false, overrideMode: true,
  activeSystems: ["penetration-testing", "vulnerability-scanner"], maxConcurrentTests: 5, autoShutdownThreshold: 90,
  lastModifiedBy: null, lastModifiedAt: new Date().toISOString(),
};

function mount(settings: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async () => settings } } });
  client.setQueryData(["/api/ai-control"], settings);
  render(<QueryClientProvider client={client}><AIControlPanel /></QueryClientProvider>);
}

it("offers no threshold, no override mode and no threat detection -- only switches and a limit it enforces", () => {
  mount(SETTINGS);
  const text = document.body.textContent ?? "";
  expect(text).not.toMatch(/Auto-Shutdown|Override Mode|Bypass safety|Threat Detection/i);
  for (const id of ["switch-override-mode", "input-shutdown-threshold", "text-override-status", "switch-threat-detection"]) {
    expect(screen.queryByTestId(id), id).toBeNull();
  }
  expect(screen.getByTestId("system-penetration-testing").textContent)
    .toBe("Penetration TestingOff: no penetration test (the scan screens' scans) can be started.");
  expect(screen.getByTestId("system-vulnerability-scanner").textContent)
    .toBe("Vulnerability ScannerOff: no vulnerability scan can be started.");
  expect(text).toMatch(/Enforced when a scan starts: a scan whose system is switched off is refused\. A scan already running is not stopped by a switch/);
  expect(screen.getByTestId("text-max-tests-effect").textContent)
    .toBe("A scan is refused while this many engine scans are running (as the engine lists them; as recorded here when it cannot be asked).");
  expect(screen.getByTestId("text-active-count").textContent).toBe("2 / 2");
  expect(screen.queryByTestId("text-unknown-systems")).toBeNull();
});

it("Reactivate All Systems switches on exactly the systems the page offers", async () => {
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify(SETTINGS), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  mount({ ...SETTINGS, killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] });
  fireEvent.click(screen.getByText("Reactivate All Systems"));
  await waitFor(() => expect(sent).toEqual([
    { killSwitchEnabled: false, systemStatus: "active", activeSystems: ["penetration-testing", "vulnerability-scanner"] },
  ]));
});
