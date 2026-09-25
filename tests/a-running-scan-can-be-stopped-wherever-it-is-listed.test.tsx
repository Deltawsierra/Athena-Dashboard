// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";
import Tests from "@/pages/Tests";

/**
 * R5-I. A running engine scan's Stop (POST /api/scans/:testId/abort) was
 * reachable only from the page instance that STARTED it: AthenaScan and
 * PentestScan kept the scan in component state, set by the start and by
 * nothing else, and read no list of running scans; the Tests screen listed the
 * same running scan with Edit and Delete and no Stop. After a reload, a
 * navigation away and back, or for a scan a colleague started, no per-scan
 * Stop existed anywhere while the engine kept scanning the customer's system.
 *
 * (The adversary's reproducer asserted a Stop existed and failed. It is kept
 * here and made exact: the Stop is that scan's, and pressing it asks the
 * abort route for that scan.)
 *
 * Now the Tests screen offers Stop on every row whose engine run may still be
 * running (findings.runId set, status not finished), and both scan screens
 * list every such scan they did not start, each with its Stop. No Stop waits
 * on the engine's status: an unread status leaves it on screen.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  (Element.prototype as any).hasPointerCapture ??= () => false;
  (Element.prototype as any).scrollIntoView ??= () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const at = new Date(Date.now() - 600_000).toISOString();
const BASE = { clientId: "c1", siteId: "s1", testType: "vulnerability-scan", severity: null, startedAt: at, completedAt: null,
  vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, executedBy: null, isSample: false };
const RUNNING = { ...BASE, id: "t-run", status: "running", summary: "https://acme.example/ — engine run run-7",
  findings: { runId: "run-7", target: "https://acme.example/", results: [] } };
const QUEUED = { ...BASE, id: "t-queued", status: "queued", summary: "q", findings: { runId: "run-8", target: "https://b.example/", results: [] } };
const ENDED = { ...BASE, id: "t-end", status: "aborted", summary: "e", findings: { runId: "run-6", target: "https://acme.example/", results: [] } };
const MANUAL = { ...BASE, id: "t-man", status: "running", summary: "m", findings: { details: "by hand" } };
const BLANK = { ...BASE, id: "t-blank", status: "running", summary: "b", findings: { runId: "", details: "x" } };

function seed(overrides: Array<[unknown[], unknown]> = []): Array<[unknown[], unknown]> {
  return [
    [["/api/engine/status"], { configured: true, reachable: true, authorized: true, url: "http://engine.test", detail: "" }],
    [["/api/clients"], [{ id: "c1", name: "Acme", company: "Acme", email: "a@a.test", status: "active" }]],
    [["/api/sites"], [{ id: "s1", clientId: "c1", name: "Checkout", url: "https://acme.example" }]],
    [["/api/tests"], [RUNNING, QUEUED, ENDED, MANUAL, BLANK]],
    [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
    [["/api/auth/check"], { authenticated: true, user: null }],
    ...overrides,
  ];
}

function mount(ui: React.ReactElement, data = seed(), failing: string[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async ({ queryKey }) => {
      throw new Error(failing.includes(String(queryKey[0])) ? "bff unreachable" : "unseeded");
    } } } });
  for (const [k, v] of data) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return client;
}

/** Answers the abort route, and records what was asked. */
function abortAnswers() {
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    asked.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify({ stopped: true, runId: "run-7" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return asked;
}

describe("a running engine scan can be stopped wherever it is listed", () => {
  it("the Tests screen offers each running scan its Stop, and none to a scan that ended or a person's test", async () => {
    const asked = abortAnswers();
    mount(<Tests />);
    expect(screen.getByTestId("button-delete-t-run")).toBeTruthy();
    expect(screen.getByTestId("button-stop-t-run").textContent).toBe("Stop");
    expect(screen.getByTestId("button-stop-t-queued")).toBeTruthy();
    for (const id of ["t-end", "t-man", "t-blank"]) expect(screen.queryByTestId(`button-stop-${id}`), id).toBeNull();
    fireEvent.click(screen.getByTestId("button-stop-t-run"));
    await waitFor(() => expect(asked).toEqual(["POST /api/scans/t-run/abort"]));
  });

  for (const [name, Page] of [["Athena", AthenaScan], ["Penetration testing", PentestScan]] as const) {
    it(`${name}: opened again while run-7 is running, the screen offers its Stop`, async () => {
      const asked = abortAnswers();
      mount(<Page />);
      expect(screen.getByTestId("running-scan-t-run").textContent).toMatch(/https:\/\/acme\.example\/.*Acme · engine run run-7 · running/);
      expect(screen.getByTestId("button-stop-scan-t-run").textContent).toBe("Stop");
      expect(screen.getByTestId("button-stop-scan-t-queued")).toBeTruthy();
      for (const id of ["t-end", "t-man", "t-blank"]) expect(screen.queryByTestId(`button-stop-scan-${id}`), id).toBeNull();
      fireEvent.click(screen.getByTestId("button-stop-scan-t-run"));
      await waitFor(() => expect(asked).toEqual(["POST /api/scans/t-run/abort"]));
    });

    it(`${name}: the Stop does not wait on the engine's status`, async () => {
      const data = seed().filter(([key]) => key[0] !== "/api/engine/status");
      mount(<Page />, data, ["/api/engine/status"]);
      await waitFor(() => expect(screen.getByTestId("text-engine-unread")).toBeTruthy());
      expect((screen.getByTestId("button-stop-scan-t-run") as HTMLButtonElement).disabled).toBe(false);
    });

    it(`${name}: a list of running scans that could not be read is said as that, not as none`, async () => {
      const data = seed().filter(([key]) => key[0] !== "/api/tests");
      mount(<Page />, data, ["/api/tests"]);
      await waitFor(() => expect(screen.getByTestId("text-running-scans-unread").textContent)
        .toMatch(/^Could not read which scans are running: bff unreachable\./));
    });
  }
});
