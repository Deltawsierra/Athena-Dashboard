// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import Tests from "@/pages/Tests";
import { queryClient } from "@/lib/queryClient";

/**
 * The Tests screen reads an engine run exactly as the server does, and says
 * what it recorded exactly:
 *   - a test whose findings say runId "" is a person's (the server's runIdOf
 *     reads it so): every field edits, and it is not "Recorded by the engine
 *     from run ";
 *   - an engine test's Notes box opens with its notes, or empty -- never a
 *     non-string `details` rendered as "[object Object]", which a save would
 *     then write back as the notes;
 *   - one result is "1 result", not "1 results".
 *
 * (Pins mutants T01-T03 of the round-5 mutation run; T02 and T03 survived the
 * whole suite.)
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); queryClient.clear(); });

const at = new Date(Date.now() - 3_600_000).toISOString();
const BASE = { clientId: "c1", siteId: null, testType: "penetration-test", startedAt: at, completedAt: null, severity: null,
  summary: "s", vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, executedBy: null, isSample: false };
const BLANK_RUN = { ...BASE, id: "blank", status: "pending", findings: { runId: "", details: "manual" } };
const ODD_NOTES = { ...BASE, id: "odd", status: "running", findings: { runId: "run-8", target: "https://a.example/", results: [], details: { by: "api" } } };
const ONE = { ...BASE, id: "one", status: "running", findings: { runId: "run-9", target: "https://a.example/", results: [{ type: "xss", severity: "high" }] } };

function serve() {
  const data: Record<string, unknown> = {
    "/api/tests": [BLANK_RUN, ODD_NOTES, ONE], "/api/clients": [{ id: "c1", name: "Acme", company: "Acme", status: "active" }],
    "/api/sites": [], "/api/sample-data": { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 },
    "/api/auth/check": { authenticated: true, user: null },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const found = data[String(url).split("?")[0]];
    return new Response(JSON.stringify(found ?? null), { status: found === undefined ? 404 : 200, headers: { "Content-Type": "application/json" } });
  }));
  render(<QueryClientProvider client={queryClient}><Tests /></QueryClientProvider>);
}

describe("the Tests screen reads the engine run exactly as the server does", () => {
  it('a test whose findings say runId "" is a person\'s, and edits every field', async () => {
    serve();
    fireEvent.click(await screen.findByTestId("button-edit-blank"));
    await screen.findByTestId("button-edit-submit");
    expect(screen.queryByTestId("text-edit-engine-owned")).toBeNull();
    expect(screen.getByTestId("select-edit-status")).toBeTruthy();
  });

  it("an engine test's notes box never opens with a non-string rendered as text", async () => {
    serve();
    fireEvent.click(await screen.findByTestId("button-edit-odd"));
    await screen.findByTestId("button-edit-submit");
    expect((screen.getByTestId("input-edit-findings") as HTMLTextAreaElement).value).toBe("");
  });

  it("one result is one result", async () => {
    serve();
    expect((await screen.findByTestId("text-findings-one")).textContent).toBe("Engine run run-9: 1 result recorded by the engine.");
  });
});
