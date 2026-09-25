// @vitest-environment jsdom
import { it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import Tests from "@/pages/Tests";

/**
 * R5-B, the screen's half. Deleting a running engine scan now sends its run a
 * stop first, and deletes the row only once the engine accepted it
 * (server/routes.ts stopBeforeDeleting). The Delete dialog said only "Are you
 * sure you want to delete this test?" -- about a scan that was still scanning
 * a customer's system. It says what will happen now; a finished scan or a
 * person's test keeps the plain question.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
});
afterEach(cleanup);

const at = new Date(Date.now() - 600_000).toISOString();
const BASE = { clientId: "c1", siteId: null, testType: "vulnerability-scan", severity: null, startedAt: at, completedAt: null,
  summary: "s", vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, executedBy: null, isSample: false };
const RUNNING = { ...BASE, id: "t-run", status: "running", findings: { runId: "run-7", target: "https://acme.example/", results: [] } };
const ENDED = { ...BASE, id: "t-end", status: "aborted", findings: { runId: "run-6", target: "https://acme.example/", results: [] } };
const MANUAL = { ...BASE, id: "t-man", status: "in-progress", findings: { details: "by hand" } };

it("the Delete dialog of a running engine scan says the run is stopped first, and nothing deleted if it will not stop", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async () => { throw new Error("unseeded"); } } } });
  client.setQueryData(["/api/tests"], [RUNNING, ENDED, MANUAL]);
  client.setQueryData(["/api/clients"], [{ id: "c1", name: "Acme", company: "Acme", email: "a@a.test", status: "active" }]);
  client.setQueryData(["/api/sites"], []);
  client.setQueryData(["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 });
  render(<QueryClientProvider client={client}><Tests /></QueryClientProvider>);

  fireEvent.click(screen.getByTestId("button-delete-t-run"));
  expect((await screen.findByTestId("text-delete-warning-t-run")).textContent).toBe(
    "This scan's engine run run-7 may still be running. Deleting it sends the engine a stop first, and deletes the " +
    "test only once the engine accepts the stop; if it does not, nothing is deleted and the scan keeps its Stop. " +
    "This action cannot be undone.",
  );
  cleanup();

  render(<QueryClientProvider client={client}><Tests /></QueryClientProvider>);
  for (const id of ["t-end", "t-man"]) {
    fireEvent.click(screen.getByTestId(`button-delete-${id}`));
    expect((await screen.findByTestId(`text-delete-warning-${id}`)).textContent)
      .toBe("Are you sure you want to delete this test? This action cannot be undone.");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await screen.findByTestId(`button-delete-${id}`);
  }
});
