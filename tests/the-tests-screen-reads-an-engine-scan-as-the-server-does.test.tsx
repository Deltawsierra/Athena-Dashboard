// @vitest-environment jsdom
/**
 * The Tests screen decides "engine scan" by the rule the server guards an edit
 * by (shared/engine-record.ts), never by the run id alone.
 *
 * Read by its run id, a scan the engine finished without one was a person's test
 * to the screen:
 * - its row printed the run's raw JSON as its findings;
 * - its Edit dialog had no "Recorded by the engine" notice, and offered its
 *   status, severity and every count for editing;
 * - its notes box was filled with the run's JSON;
 * - a summary-only edit sent `severity: null` (the select has no "info"), which
 *   the server refused (409) as an edit of the engine's severity, and where the
 *   severity was not "info" the edit went through and wrote the run's JSON into
 *   the notes as a person's.
 *
 * The body the screen sends now is taken by the server: see
 * `every-route-reads-an-engine-scan-by-one-rule.test.ts`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import Tests from "@/pages/Tests";
import { queryClient } from "@/lib/queryClient";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
});

const at = new Date(Date.now() - 3_600_000).toISOString();
const BASE = {
  clientId: "c1", siteId: null, testType: "penetration-test", startedAt: at, completedAt: at, severity: "info",
  summary: "s", vulnerabilitiesFound: 1, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
  executedBy: null, isSample: false,
};
/** What POST /api/scans records for a run the engine finished inline without a run id. */
const NO_RUN_ID = {
  ...BASE, id: "norunid", status: "completed", summary: "https://acme.example/ — engine run unknown",
  findings: { runId: null, target: "https://acme.example/", results: [{ type: "banner", severity: "info", message: "Server header" }] },
};
/** A scan whose results the engine sent could not be read. */
const UNREAD = {
  ...BASE, id: "unreadresults", status: "completed", severity: null, vulnerabilitiesFound: 0,
  findings: { runId: "run-9", target: "https://acme.example/", results: null },
};
/** A person's test, whose run keys were sent as null. */
const PERSONS = {
  ...BASE, id: "persons", status: "completed", severity: "high", highCount: 1,
  findings: { runId: null, target: null, results: null, details: "found by hand" },
};

function serve() {
  const writes: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  const data: Record<string, unknown> = {
    "/api/tests": [NO_RUN_ID, UNREAD, PERSONS],
    "/api/clients": [{ id: "c1", name: "Acme", company: "Acme", status: "active" }],
    "/api/sites": [],
    "/api/sample-data": { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 },
    "/api/auth/check": { authenticated: true, user: null },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const found = data[String(url).split("?")[0]];
    return new Response(JSON.stringify(found ?? null), {
      status: found === undefined ? 404 : 200, headers: { "Content-Type": "application/json" },
    });
  }));
  render(<QueryClientProvider client={queryClient}><Tests /></QueryClientProvider>);
  return writes;
}

const PERSONS_FIELDS = ["input-edit-vulnerabilities", "input-edit-critical", "input-edit-high", "select-edit-severity", "select-edit-status"];

describe("the Tests screen and a scan the engine finished without a run id", () => {
  it("lists it as the engine's, never as the run's raw JSON", async () => {
    serve();
    const row = await screen.findByTestId("text-findings-norunid");
    expect(row.textContent).toBe("Engine run with no id: 1 result recorded by the engine.");
    expect(row.textContent).not.toContain("{");
  });

  it("edits it as an engine scan: the notice, no counts or severity to edit, an empty notes box", async () => {
    serve();
    fireEvent.click(await screen.findByTestId("button-edit-norunid"));
    const notice = await screen.findByTestId("text-edit-engine-owned");
    expect(notice.textContent).toMatch(/^Recorded by the engine from a run it gave no id: its status, severity and counts/);
    expect(screen.getByTestId("text-edit-status").textContent).toBe("completed");
    for (const id of PERSONS_FIELDS) expect(screen.queryByTestId(id)).toBeNull();
    expect((screen.getByTestId("input-edit-findings") as HTMLTextAreaElement).value).toBe("");
  });

  it("sends a summary-only edit as the summary, the test type and the notes: no severity, status or count", async () => {
    const writes = serve();
    fireEvent.click(await screen.findByTestId("button-edit-norunid"));
    const form = (await screen.findByTestId("button-edit-submit")).closest("form") as HTMLFormElement;
    fireEvent.change(screen.getByTestId("input-edit-summary"), { target: { value: "typo fixed" } });
    fireEvent.submit(form);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe("PATCH");
    expect(writes[0].url).toBe("/api/tests/norunid");
    expect(writes[0].body).toEqual({ summary: "typo fixed", testType: "penetration-test", findings: null });
  });
});

describe("the Tests screen and a scan whose results could not be read", () => {
  it("says its results could not be read, and that its counts were not recorded", async () => {
    serve();
    expect((await screen.findByTestId("text-findings-unreadresults")).textContent).toBe(
      "Engine run run-9: its results could not be read.",
    );
    fireEvent.click(await screen.findByTestId("button-edit-unreadresults"));
    expect((await screen.findByTestId("text-edit-engine-owned")).textContent).toMatch(
      /^Recorded by the engine from run run-9: its status, severity and counts \(counts not recorded\)/,
    );
  });
});

describe("the Tests screen and a person's test", () => {
  it("still edits it as a person's, with its notes in the box", async () => {
    serve();
    fireEvent.click(await screen.findByTestId("button-edit-persons"));
    await screen.findByTestId("button-edit-submit");
    expect(screen.queryByTestId("text-edit-engine-owned")).toBeNull();
    for (const id of PERSONS_FIELDS) expect(screen.queryByTestId(id)).not.toBeNull();
    expect((screen.getByTestId("input-edit-findings") as HTMLTextAreaElement).value).toBe("found by hand");
  });
});
