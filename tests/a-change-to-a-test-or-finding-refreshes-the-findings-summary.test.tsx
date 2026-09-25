// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import Overview from "@/pages/Overview";
import Tests from "@/pages/Tests";
import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";
import DeletionManagement from "@/pages/DeletionManagement";
import RetestPanel from "@/components/RetestPanel";
import SampleDataNotice from "@/components/SampleDataNotice";
import { queryClient } from "@/lib/queryClient";
import { derivedFromTestsOrFindings } from "@/lib/invalidate";
import { summarizeFindings } from "../server/findings-summary";

/**
 * PR #52 round 3, F4. The untracked-scan flag, the open totals and the top
 * open findings live in /api/findings/summary, and nothing that changed a
 * test or a finding invalidated it: the Tests screen's create, edit and
 * delete, a scan's start and finish, a retest, a finding's status, a
 * deletion and the sample-data removal all invalidated /api/tests (and
 * friends) only. With the app's own QueryClient (staleTime 30s), coming back
 * to the Overview within 30 seconds drew the FRESH test list beside the
 * STALE summary: "5 findings reported" under Recent Activity, and "Nothing
 * flagged" in the attention panel.
 *
 * These drive the screens' own mutations -- not a stand-in invalidation --
 * against the app's real QueryClient. Adapted from the adversarial reproducer
 * r3-summary-stale-after-test-edit.test.tsx, which invalidated /api/tests by
 * hand the way Tests.tsx did.
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

const t0 = new Date(Date.now() - 3_600_000);
const CLIENTS = [{ id: "c1", name: "Acme", company: "Acme", status: "active", lastTestDate: null, notes: null }];
const SITES = [{ id: "s1", clientId: "c1", name: "App", environment: "production" }];
const BASE = { id: "t1", clientId: "c1", siteId: "s1", testType: "penetration-test", startedAt: t0.toISOString(), completedAt: null as string | null,
  severity: null as string | null, summary: null, findings: null, vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
const CLEAN = { ...BASE, id: "t0", status: "completed", startedAt: new Date(t0.getTime() - 7_200_000).toISOString(), completedAt: new Date(t0.getTime() - 3_600_000).toISOString() };
const PENDING = { ...BASE, status: "pending" };
// What the server holds once the Tests screen's edit is saved: completed now,
// 3 critical / 2 high.
const EDITED = { ...BASE, status: "completed", completedAt: new Date().toISOString(), severity: "critical", vulnerabilitiesFound: 5, criticalCount: 3, highCount: 2 };
const summaryOf = (tests: Array<typeof BASE & { status: string }>) => JSON.parse(JSON.stringify(summarizeFindings({
  clients: CLIENTS, sites: SITES, findings: [],
  tests: tests.map((t) => ({ ...t, startedAt: new Date(t.startedAt), completedAt: t.completedAt ? new Date(t.completedAt) : null })) as never,
})));

let server: Record<string, unknown> = {};
const writes: Array<{ method: string; url: string; body: unknown }> = [];
function serve(tests: Array<typeof BASE & { status: string }>) {
  server = {
    "/api/clients": CLIENTS, "/api/sites": SITES, "/api/tests": tests, "/api/findings/summary": summaryOf(tests),
    "/api/assurance/deployments": [], "/api/sample-data": { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 },
    "/api/auth/check": { authenticated: true, user: null },
  };
}
/** The API as a stub: reads answer from `server`; a write calls `onWrite` and answers its result. */
function stubApi(onWrite: (method: string, url: string, body: unknown) => unknown = () => ({})) {
  writes.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      writes.push({ method, url: String(url), body });
      return new Response(JSON.stringify(onWrite(method, String(url), body)), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const found = server[String(url).split("?")[0]];
    return new Response(JSON.stringify(found ?? null), { status: found === undefined ? 404 : 200, headers: { "Content-Type": "application/json" } });
  }));
}
const mountApp = (ui: React.ReactElement) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
/** The Radix select's native twin, which the form submits. */
const nativeSelect = (form: HTMLFormElement, name: string) => form.querySelector(`select[name="${name}"]`) as HTMLSelectElement;

describe("a change to a test or a finding refreshes the findings summary", () => {
  it("back on the Overview after the Tests screen's edit, a 3C/2H pentest is not drawn beside an all-clear", async () => {
    stubApi((method) => {
      if (method === "PATCH") { serve([CLEAN, EDITED]); return EDITED; }
      return {};
    });
    serve([CLEAN, PENDING]);
    const first = mountApp(<Overview />);
    await waitFor(() => expect(screen.getByTestId("overview-panel-attention").textContent).toMatch(/Nothing flagged/));
    first.unmount();

    // The Tests screen's own edit dialog: completed, 3 critical, 2 high.
    const tests = mountApp(<Tests />);
    fireEvent.click(await screen.findByTestId("button-edit-t1"));
    const form = (await screen.findByTestId("button-edit-submit")).closest("form") as HTMLFormElement;
    fireEvent.change(nativeSelect(form, "status"), { target: { value: "completed" } });
    fireEvent.change(screen.getByTestId("input-edit-vulnerabilities"), { target: { value: "5" } });
    fireEvent.change(screen.getByTestId("input-edit-critical"), { target: { value: "3" } });
    fireEvent.change(screen.getByTestId("input-edit-high"), { target: { value: "2" } });
    fireEvent.submit(form);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ method: "PATCH", url: "/api/tests/t1", body: { status: "completed", criticalCount: 3, highCount: 2 } });
    await waitFor(() => expect(queryClient.getQueryState(["/api/findings/summary"])?.isInvalidated).toBe(true));
    tests.unmount();

    mountApp(<Overview />);
    await waitFor(() => expect(screen.getByTestId("overview-panel-activity").textContent).toMatch(/5 findings reported/));
    await waitFor(() => expect(screen.getByTestId("overview-panel-attention").textContent).toMatch(/3 critical \/ 2 high/));
    expect(screen.getByTestId("overview-panel-attention").textContent, "a stale summary answered beside the fresh test list")
      .not.toMatch(/Nothing flagged/);
  });

  it("the Tests screen's create and delete refresh it too", async () => {
    serve([CLEAN, PENDING]);
    stubApi((method) => (method === "POST" ? { ...EDITED, id: "t9" } : { success: true }));
    mountApp(<Tests />);
    // Create.
    fireEvent.click(await screen.findByTestId("button-create-test"));
    const form = (await screen.findByTestId("button-submit")).closest("form") as HTMLFormElement;
    fireEvent.change(nativeSelect(form, "clientId"), { target: { value: "c1" } });
    fireEvent.change(nativeSelect(form, "testType"), { target: { value: "penetration-test" } });
    queryClient.setQueryData(["/api/findings/summary"], summaryOf([CLEAN]));
    fireEvent.submit(form);
    await waitFor(() => expect(writes.map((one) => one.method)).toEqual(["POST"]));
    await waitFor(() => expect(queryClient.getQueryState(["/api/findings/summary"])?.isInvalidated).toBe(true));

    // Delete.
    queryClient.setQueryData(["/api/findings/summary"], summaryOf([CLEAN]));
    expect(queryClient.getQueryState(["/api/findings/summary"])?.isInvalidated).toBe(false);
    fireEvent.click(screen.getByTestId("button-delete-t1"));
    fireEvent.click(await screen.findByTestId("button-confirm-delete-t1"));
    await waitFor(() => expect(writes.map((one) => one.method)).toEqual(["POST", "DELETE"]));
    await waitFor(() => expect(queryClient.getQueryState(["/api/findings/summary"])?.isInvalidated).toBe(true));
  });

  for (const [name, Page] of [["Athena", AthenaScan], ["Penetration testing", PentestScan]] as const) {
  it(`${name}: a scan that finishes on a later poll refreshes it: that poll filed its findings`, async () => {
    serve([CLEAN]);
    let state = "running";
    server["/api/engine/status"] = { configured: true, reachable: true, authorized: true, url: "http://engine.test", detail: "" };
    stubApi(() => ({ test: { id: "t5" }, runId: "run-5", state: "running" }));
    Object.defineProperty(server, "/api/scans/t5", {
      enumerable: true,
      get: () => ({ test: { ...BASE, id: "t5", status: state }, state, engine: { findings: [] } }),
    });
    mountApp(<Page />);
    await waitFor(() => expect(document.querySelector('select option[value="c1"]')).toBeTruthy());
    fireEvent.change(document.querySelectorAll("select")[0], { target: { value: "c1" } });
    fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://acme.test" } });
    await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("button-start-scan"));
    await waitFor(() => expect(screen.getByTestId("text-state").textContent).toMatch(/running/));
    queryClient.setQueryData(["/api/findings/summary"], summaryOf([CLEAN]));
    expect(queryClient.getQueryState(["/api/findings/summary"])?.isInvalidated).toBe(false);

    state = "completed";
    await waitFor(() => expect(screen.getByTestId("text-state").textContent).toMatch(/completed/), { timeout: 5_000 });
    await waitFor(() => expect(queryClient.getQueryState(["/api/findings/summary"])?.isInvalidated).toBe(true));
  });
  }

  /** Seed a fresh summary, do `act`, and expect the summary marked stale by it. */
  async function refreshedBy(act: () => Promise<void> | void) {
    queryClient.setQueryData(["/api/findings/summary"], summaryOf([CLEAN]));
    expect(queryClient.getQueryState(["/api/findings/summary"])?.isInvalidated).toBe(false);
    await act();
    await waitFor(() => expect(queryClient.getQueryState(["/api/findings/summary"])?.isInvalidated).toBe(true));
  }

  it("a retest refreshes it: its verdict may have closed or reopened a finding", async () => {
    serve([CLEAN]);
    server["/api/tests/t0/decisions"] = { decisions: [{
      id: 7, runId: "run-0", target: "https://acme.test", findingType: "xss", severity: "high", tier: null,
      confidence: null, endpoint: "https://acme.test/q", detail: null, capturedAt: null,
    }], truncated: false, detail: "" };
    stubApi(() => ({ twinId: 7, verdict: "closed", detail: "gone", target: null, findingType: "xss", inventoryDigest: null, runId: "r", checkedAt: null }));
    mountApp(<RetestPanel testId="t0" />);
    const button = await screen.findByTestId("button-retest-7");
    await refreshedBy(() => { fireEvent.click(button); });
  });

  it("deleting a client or a test refreshes it", async () => {
    serve([CLEAN]);
    server["/api/documents"] = [];
    stubApi(() => ({ success: true }));
    mountApp(<DeletionManagement />);
    const button = await screen.findByTestId("button-delete-tests-t0");
    await refreshedBy(async () => {
      fireEvent.click(button);
      fireEvent.click(await screen.findByTestId("button-confirm-delete"));
    });
    expect(writes.map((one) => `${one.method} ${one.url}`)).toEqual(["DELETE /api/tests/t0"]);
  });

  it("removing the sample rows refreshes it: their counts reached the summary", async () => {
    serve([CLEAN]);
    server["/api/sample-data"] = { clients: 1, sites: 1, tests: 1, documents: 0, findings: 3 };
    server["/api/auth/check"] = { authenticated: true, user: { id: "u", username: "admin", role: "admin", isActive: true } };
    stubApi(() => ({ removed: { clients: 1, sites: 1, tests: 1, documents: 0, findings: 3 } }));
    mountApp(<SampleDataNotice counts={["clients", "tests", "findings"]} />);
    const button = await screen.findByTestId("button-remove-sample-data");
    await refreshedBy(() => { fireEvent.click(button); });
  });

  it("names every answer computed from tests or findings, and nothing else", () => {
    for (const key of [
      ["/api/tests"], ["/api/findings/summary"], ["/api/findings", { clientId: "c1" }], ["/api/findings?clientId=c1"],
      ["/api/sample-data"], ["/api/compliance/c1"],
    ]) expect(derivedFromTestsOrFindings(key), JSON.stringify(key)).toBe(true);
    for (const key of [
      ["/api/clients"], ["/api/scans/t1"], ["/api/tests/t1/decisions"], ["/api/failsafe/status"], ["/api/findings-other"], [42],
    ]) expect(derivedFromTestsOrFindings(key), JSON.stringify(key)).toBe(false);
  });
});
