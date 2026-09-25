// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import Tests from "@/pages/Tests";
import { queryClient } from "@/lib/queryClient";

/**
 * The Tests screen's Edit dialog, for a test an engine scan wrote: it filled
 * the Findings box with the JSON of {runId, target, results} and sent it back
 * as `details`, with the status, severity and counts from the form -- a status
 * select that does not even list "running". The server now keeps the run's
 * keys and refuses a change to what the engine decided
 * (tests/an-edit-on-the-tests-screen-keeps-the-engine-run.test.ts); this pins
 * the screen's half: for an engine test it edits only the summary, the test
 * type and a person's notes, and shows the rest as the engine's.
 *
 * And a person's test recorded with only "Critical Count: 2" (the total left
 * at 0) says it found 2, rather than hiding its criticals behind the total.
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
const ENGINE = { ...BASE, id: "eng", status: "running", summary: "https://acme.example/ — engine run run-7",
  findings: { runId: "run-7", target: "https://acme.example/", results: [] } };
const MANUAL = { ...BASE, id: "man", status: "completed", completedAt: at, findings: null, criticalCount: 2 };

function serve() {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  const data: Record<string, unknown> = {
    "/api/tests": [ENGINE, MANUAL], "/api/clients": [{ id: "c1", name: "Acme", company: "Acme", status: "active" }],
    "/api/sites": [], "/api/sample-data": { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 },
    "/api/auth/check": { authenticated: true, user: null },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const found = data[String(url).split("?")[0]];
    return new Response(JSON.stringify(found ?? null), { status: found === undefined ? 404 : 200, headers: { "Content-Type": "application/json" } });
  }));
  render(<QueryClientProvider client={queryClient}><Tests /></QueryClientProvider>);
  return writes;
}

describe("the Tests screen edits only what a person wrote", () => {
  it("an engine test's edit sends the summary, the type and the notes -- never the run, status or counts", async () => {
    const writes = serve();
    fireEvent.click(await screen.findByTestId("button-edit-eng"));
    const form = (await screen.findByTestId("button-edit-submit")).closest("form") as HTMLFormElement;
    // The engine's part is shown, not offered as fields.
    expect(screen.getByTestId("text-edit-engine-owned").textContent).toMatch(/Recorded by the engine from run run-7/);
    expect(screen.getByTestId("text-edit-engine-owned").textContent).toMatch(/none until it completes/);
    expect(screen.getByTestId("text-edit-status").textContent).toBe("running");
    for (const id of ["select-edit-status", "select-edit-severity", "input-edit-vulnerabilities", "input-edit-critical",
      "input-edit-high", "input-edit-medium", "input-edit-low"]) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
    // The notes box starts empty: the run's JSON is not a note.
    const notes = screen.getByTestId("input-edit-findings") as HTMLTextAreaElement;
    expect(notes.value).toBe("");

    fireEvent.change(screen.getByTestId("input-edit-summary"), { target: { value: "typo fixed" } });
    fireEvent.submit(form);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: "PATCH", url: "/api/tests/eng",
      body: { summary: "typo fixed", testType: "penetration-test", findings: null },
    });
  });

  it("an engine test's notes are sent as notes", async () => {
    const writes = serve();
    fireEvent.click(await screen.findByTestId("button-edit-eng"));
    const form = (await screen.findByTestId("button-edit-submit")).closest("form") as HTMLFormElement;
    fireEvent.change(screen.getByTestId("input-edit-findings"), { target: { value: "seen by Ann" } });
    fireEvent.submit(form);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect((writes[0].body as { findings: unknown }).findings).toEqual({ details: "seen by Ann" });
  });

  it("a person's test still edits every field", async () => {
    const writes = serve();
    fireEvent.click(await screen.findByTestId("button-edit-man"));
    const form = (await screen.findByTestId("button-edit-submit")).closest("form") as HTMLFormElement;
    expect(screen.queryByTestId("text-edit-engine-owned")).toBeNull();
    fireEvent.change(screen.getByTestId("input-edit-high"), { target: { value: "1" } });
    fireEvent.submit(form);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toMatchObject({ status: "completed", criticalCount: 2, highCount: 1 });
  });

  it("a recorded critical count is shown when the total was left at 0", async () => {
    serve();
    expect((await screen.findByTestId("text-found-man")).textContent).toBe("2 Vulnerabilities Found");
    expect(screen.getByTestId("text-critical-man").textContent).toBe("2");
    expect(screen.getByTestId("text-findings-eng").textContent).toBe("Engine run run-7: 0 results recorded by the engine.");
  });
});
