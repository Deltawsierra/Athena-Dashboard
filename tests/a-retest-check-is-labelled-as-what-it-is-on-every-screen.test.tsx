// @vitest-environment jsdom
/**
 * A retest's recording at Athena-Backend is labelled as exactly what it is, on
 * every screen that shows the retest or its check (owner decision 8, the
 * dashboard half; shared/backend-record.ts RetestCheckRecordView, the words in
 * client/src/lib/backendRecordCopy.ts):
 *
 *   - the retest panel, under the verdict: "Recorded in the Athena-Backend as a
 *     retest check (not closure evidence)" once recorded; "Not in the
 *     Athena-Backend record: <the backend's reason>" when the backend answered
 *     404, 409 or 422 -- or the retested scan has no backend record, said as
 *     that; "Athena-Backend is being asked to record this retest check" while
 *     the server asks, read again until the answer, and never read as recorded
 *     from silence; "stopped asking" when the bound was reached, never an
 *     outcome; and nothing of the backend for a verdict the engine answered the
 *     press itself with;
 *   - the Findings page's run-by-run list, beside each check filed by a watch;
 *   - the Risks page's Backend record section: the backend finding's own
 *     retest checks, as served (verdict word, run state, when the engine
 *     checked), under the same label, with "None recorded" for a finding with
 *     none; the section's source line stands.
 *
 * The components are the real ones; fetch answers what this dashboard's own
 * routes answer (server/routes.ts retestView, GET /api/findings,
 * GET /api/record/clients/:id/findings). One stand-in: the Findings page picks
 * its engagement with the shell's Radix select, which in jsdom opens but stalls
 * on an item's selection; the picker is not what is tested here, so the shell's
 * select is stood in for by a native one (the page's own code is unchanged).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import RetestPanel from "@/components/RetestPanel";
import Findings from "@/pages/Findings";
import Risks from "@/pages/Risks";
import { queryClient } from "@/lib/queryClient";
import {
  RETEST_CHECK_ASKING, RETEST_CHECK_DIRECT_SCAN_REASON, RETEST_CHECK_RECORDED, RETEST_CHECK_STOPPED_ASKING, RETEST_CHECKS_NONE,
  retestCheckLine, retestCheckNotInRecord, retestChecksCount,
} from "@/lib/backendRecordCopy";
import { RISKS_BACKEND_SOURCE } from "@/lib/sourceLabels";
import type { RetestCheckRecordView, RetestCheckView } from "@shared/backend-record";
import { summarizeFindings } from "../server/findings-summary";

vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const Picked = React.createContext<{ value: string; onValueChange: (value: string) => void }>({ value: "", onValueChange: () => undefined });
  return {
    Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: ReactNode }) =>
      React.createElement(Picked.Provider, { value: { value, onValueChange } }, children),
    SelectTrigger: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => React.createElement("div", props, children),
    SelectValue: ({ placeholder }: { placeholder?: string }) => React.createElement("span", null, placeholder ?? ""),
    SelectContent: ({ children }: { children: ReactNode }) => {
      const picked = React.useContext(Picked);
      return React.createElement(
        "select", { "data-testid": "native-select", value: picked.value, onChange: (event: { target: { value: string } }) => picked.onValueChange(event.target.value) },
        React.createElement("option", { value: "" }, "—"), children,
      );
    },
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => React.createElement("option", { value }, children),
  };
});
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
const CHECKED_AT = "2026-10-23T04:30:00+00:00";
const CHECK: RetestCheckView = {
  engineRunId: "eng-1", scanRecordId: "702", twinId: 7, twinRunId: "scan-run", verdict: "closed", verdictKnown: true,
  detail: "xss was not reported", state: "completed", stoppedAfterRecording: false, engineCheckedAt: CHECKED_AT,
  collectedAt: "2026-10-23T04:31:00.000Z", collectedBy: "admin",
};
/** A standing as the server files it on the watch's row, in each of its four states. */
function standing(state: RetestCheckRecordView["state"], extra: Partial<RetestCheckRecordView> = {}): RetestCheckRecordView {
  return {
    state, recorded: state === "recorded" ? true : state === "asking" ? null : false, detail: "", reason: null, status: null,
    findingUuid: state === "asking" ? null : "bf1", checkId: state === "recorded" ? "eng-1" : null, check: state === "recorded" ? CHECK : null,
    lastAnswer: null, lastAskedAt: null, lastReadError: null, startedAt: "2026-10-23T04:30:30.000Z", deadlineAt: "2026-10-23T05:30:30.000Z",
    endedAt: state === "asking" ? null : "2026-10-23T04:31:00.000Z", twinRunId: "scan-run", backendScanId: "s1", ...extra,
  };
}
/** A watched retest that ended with a verdict, as GET /api/retests/:runId answers it, with the backend standing on its result. */
const verdictView = (runId: string, backend: RetestCheckRecordView | undefined) => ({
  ...running(runId), answer: "verdict", phase: "verdict", stoppable: false, state: "completed", detail: "The retest finished with a verdict.",
  result: {
    twinId: 7, verdict: "closed", detail: "xss was not reported", target: "https://offline.invalid/", findingType: "xss",
    inventoryDigest: null, runId: "702", engineRunId: runId, checkedAt: CHECKED_AT, stoppedAfterRecording: null,
    applied: null, notFiled: "no finding on record matches this decision", ...(backend ? { backend } : {}),
  },
});

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.releasePointerCapture ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
});

/** The retest panel over a retest the server lists as running, whose poll route answers `answers` in turn (the last one for good). */
function panelOver(runId: string, answers: unknown[]) {
  const reads: string[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/tests/t1/decisions")) return ok({ decisions: [twin], truncated: false, detail: "" });
    if (u.endsWith("/api/tests/t1/retests")) return ok({ retests: [running(runId)] });
    if (u.includes(`/api/retests/${runId}`) && !init?.method) {
      reads.push(u);
      return ok(answers.length > 1 ? answers.shift() : answers[0]);
    }
    return ok({});
  }));
  render(<QueryClientProvider client={queryClient}><RetestPanel testId="t1" /></QueryClientProvider>);
  return reads;
}

describe("the retest panel says where the verdict's recording at Athena-Backend stands", () => {
  it("while the server asks, says so and reads again -- never 'recorded' from silence -- then says recorded as a retest check, not closure evidence", async () => {
    const reads = panelOver("eng-1", [verdictView("eng-1", standing("asking")), verdictView("eng-1", standing("asking")), verdictView("eng-1", standing("recorded"))]);
    const line = await screen.findByTestId("text-retest-check-record-7", {}, { timeout: 5_000 });
    expect(line.textContent).toBe(RETEST_CHECK_ASKING);
    expect(line.getAttribute("data-state")).toBe("asking");
    expect(screen.getByTestId("text-verdict-7").textContent).toBe("Closed");
    await waitFor(() => expect(screen.getByTestId("text-retest-check-record-7").textContent).toBe(RETEST_CHECK_RECORDED), { timeout: 6_000 });
    expect(screen.getByTestId("text-retest-check-record-7").getAttribute("data-state")).toBe("recorded");
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(RETEST_CHECK_RECORDED).toBe("Recorded in the Athena-Backend as a retest check (not closure evidence)");
    expect(screen.queryByText(/closure evidence recorded/)).toBeNull();
  });

  it("says 'not in the Athena-Backend record' with the backend's own reason for its 404, 409 or 422", async () => {
    panelOver("eng-2", [verdictView("eng-2", standing("not_in_record", { status: 404, detail: "the engine has no run eng-2 this backend can read" }))]);
    const line = await screen.findByTestId("text-retest-check-record-7", {}, { timeout: 5_000 });
    expect(line.textContent).toBe("Not in the Athena-Backend record: the engine has no run eng-2 this backend can read");
    expect(line.textContent).toBe(retestCheckNotInRecord("the engine has no run eng-2 this backend can read"));
  });

  it("says a retest of a scan this dashboard recorded directly from the engine is not in the backend record, as that", async () => {
    panelOver("eng-3", [verdictView("eng-3", standing("not_in_record", { reason: "dashboard_direct", detail: "whatever the server wrote", backendScanId: null }))]);
    const line = await screen.findByTestId("text-retest-check-record-7", {}, { timeout: 5_000 });
    expect(line.textContent).toBe(`Not in the Athena-Backend record: ${RETEST_CHECK_DIRECT_SCAN_REASON}`);
    expect(line.textContent).toMatch(/recorded by this dashboard directly from the engine/);
  });

  it("says this dashboard stopped asking when the bound was reached -- never an outcome", async () => {
    panelOver("eng-4", [verdictView("eng-4", standing("unwatched", { lastAnswer: "unavailable", status: 503 }))]);
    const line = await screen.findByTestId("text-retest-check-record-7", {}, { timeout: 5_000 });
    expect(line.textContent).toBe(RETEST_CHECK_STOPPED_ASKING);
    expect(line.textContent).not.toMatch(/Recorded in/);
  });

  it("says nothing of the backend for a verdict the engine answered the press itself with", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/tests/t1/decisions")) return ok({ decisions: [twin], truncated: false, detail: "" });
      if (u.endsWith("/api/tests/t1/retests")) return ok({ retests: [] });
      if (u.endsWith("/api/tests/t1/retest") && init?.method === "POST") {
        return ok({ answer: "verdict", ...verdictView("eng-5", undefined).result, applied: { findingId: "f1", status: "fixed", detail: "closed" } });
      }
      return ok({});
    }));
    render(<QueryClientProvider client={queryClient}><RetestPanel testId="t1" /></QueryClientProvider>);
    fireEvent.click(await screen.findByTestId("button-retest-7"));
    await screen.findByTestId("verdict-7");
    expect(screen.queryByTestId("text-retest-check-record-7")).toBeNull();
  });
});

describe("the Findings page's run-by-run list", () => {
  const now = new Date().toISOString();
  const CLIENT = { id: "c1", name: "Acme", company: "Acme", email: "a@acme.test", status: "active", lastTestDate: null, notes: null, backendEngagementId: null };
  const check = (id: string, backend: RetestCheckRecordView | null) => ({
    id, verdict: "closed", detail: "xss was not reported", runId: "702", checkedAt: now, filedVia: "retest_watch", requestedAt: now, backend,
  });
  const finding = (checks: unknown[]) => ({
    id: "f1", clientId: "c1", siteId: null, type: "xss", severity: "high", message: "Reflected input on /search", target: "https://offline.invalid/",
    endpoint: "https://offline.invalid/search", header: null, status: "fixed", ownerId: null, ownerName: null, statusNote: null, timesSeen: 1,
    firstSeenAt: now, lastSeenAt: now, fixedAt: now, fixedByRunId: "702", fixedVerdict: "closed", reopenedAt: null, source: "dashboard-direct",
    sightings: [], checks,
  });

  async function pageWith(checks: unknown[]) {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      const u = String(url);
      if (u.endsWith("/api/clients")) return ok([CLIENT]);
      if (u.endsWith("/api/users/assignable")) return ok([]);
      if (u.includes("/api/findings?clientId=c1")) return ok({ findings: [finding(checks)], counts: { open: 0, acknowledged: 0, accepted: 0, fixed: 1 } });
      return ok({});
    }));
    render(<QueryClientProvider client={queryClient}><Findings /></QueryClientProvider>);
    // The engagement is chosen on the page: the one client, picked through the stood-in select.
    await screen.findByTestId("select-findings-client");
    const picker = screen.getAllByTestId("native-select")[0] as HTMLSelectElement;
    await waitFor(() => expect(Array.from(picker.options).map((one) => one.value)).toContain("c1"));
    fireEvent.change(picker, { target: { value: "c1" } });
    await screen.findByTestId("finding-f1");
  }

  it("says, beside a check the watch filed, where its recording at Athena-Backend stands, in the same words as the retest panel", async () => {
    await pageWith([
      check("k1", standing("recorded")),
      check("k2", standing("not_in_record", { reason: "dashboard_direct", backendScanId: null })),
      check("k3", standing("asking")),
      check("k4", null),
    ]);
    expect(screen.getByTestId("text-check-backend-record-k1").textContent).toBe(RETEST_CHECK_RECORDED);
    expect(screen.getByTestId("text-check-backend-record-k2").textContent).toBe(retestCheckNotInRecord(RETEST_CHECK_DIRECT_SCAN_REASON));
    expect(screen.getByTestId("text-check-backend-record-k3").textContent).toBe(RETEST_CHECK_ASKING);
    // A check with no watch behind it: nothing is said of the backend, and nothing is invented.
    expect(screen.queryByTestId("text-check-backend-record-k4")).toBeNull();
    expect(screen.getByTestId("text-check-collected-k1").textContent).toMatch(/collected when the engine finished/);
  });
});

describe("the Risks page's Backend record section lists the backend finding's retest checks under the same label", () => {
  const now = new Date().toISOString();
  const CLIENT = { id: "c1", name: "Acme", company: "Acme", status: "active", lastTestDate: null, notes: null };
  const ledgerFinding = {
    id: "f1", clientId: "c1", siteId: null, type: "sql_injection", severity: "high", message: "SQL error f1", status: "open",
    firstSeenAt: now, lastSeenAt: now, target: "https://app.example", endpoint: "https://app.example/f1", ownerId: null,
    source: "dashboard-direct", sightings: [], checks: [],
  };
  const summary = summarizeFindings({ clients: [CLIENT], sites: [], findings: [ledgerFinding] as never });
  const SECOND: RetestCheckView = { ...CHECK, engineRunId: "eng-0", verdict: "still_open", state: "aborted", stoppedAfterRecording: true, engineCheckedAt: null };
  const RECORD = {
    clientId: "c1", engagementId: 7, readAt: now,
    deployments: [{ uuid: "d1", name: "Acme shop" }],
    findings: [
      { uuid: "bf1", title: "Prompt injection via tool output", severity: "high", status: "open", statusLabel: "Open", findingType: "prompt_injection",
        deploymentUuid: "d1", scanUuid: "s1", engineRunId: "run-77", test: { id: "t9", status: "completed" }, retestChecks: [CHECK, SECOND] },
      { uuid: "bf2", title: "Over-broad token scope", severity: "medium", status: "open", statusLabel: "Open", findingType: "excessive_agency",
        deploymentUuid: "d1", scanUuid: "s2", engineRunId: null, test: null, retestChecks: [] },
    ],
  };

  function mountSeeded(ui: ReactElement, seed: Array<[unknown[], unknown]>) {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false, staleTime: Infinity, gcTime: Infinity,
          queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); },
        },
      },
    });
    for (const [k, v] of seed) client.setQueryData(k, v);
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  }

  it("shows each check as the backend served it -- verdict word, run state, when the engine checked -- labelled a retest check, never closure evidence; none recorded as that", () => {
    mountSeeded(<Risks />, [
      [["/api/clients"], [CLIENT]], [["/api/tests"], []], [["/api/sites"], []], [["/api/users/assignable"], []],
      [["/api/assurance/deployments"], []],
      [["/api/findings/summary"], summary],
      [["/api/findings", { clientId: "c1" }], { findings: [ledgerFinding], counts: { open: 1, acknowledged: 0, accepted: 0, fixed: 0 } }],
      [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
      [["/api/auth/check"], { authenticated: true, user: null }],
      [["/api/record/clients/c1/findings"], RECORD],
    ]);
    const section = screen.getByTestId("panel-risks-backend-record");
    expect(within(section).getByTestId("text-risks-backend-source").textContent).toBe(RISKS_BACKEND_SOURCE);
    expect(within(section).getByText("Retest checks")).toBeTruthy();
    const first = within(section).getByTestId("record-finding-bf1");
    expect(within(first).getByTestId("text-record-finding-retest-checks-count").textContent).toBe(retestChecksCount(2));
    expect(within(first).getByTestId("text-record-finding-retest-checks-label").textContent).toBe(RETEST_CHECK_RECORDED);
    expect(within(first).getByTestId("retest-check-eng-1").textContent).toBe(retestCheckLine(CHECK));
    expect(within(first).getByTestId("retest-check-eng-1").textContent).toBe(`closed · the run completed · checked by the engine at ${CHECKED_AT}`);
    expect(within(first).getByTestId("retest-check-eng-0").textContent).toBe(
      "still_open · the run ended stopped after its check was recorded · the engine's check time was not served",
    );
    const second = within(section).getByTestId("record-finding-bf2");
    expect(within(second).getByTestId("text-record-finding-no-retest-checks").textContent).toBe(RETEST_CHECKS_NONE);
    expect(section.textContent).not.toMatch(/closure evidence recorded|verified/i);
    // The ledger's own register beneath stands as it was: the backend's checks are listed nowhere in it.
    expect(screen.getByTestId("text-risks-ledger-read-only")).toBeTruthy();
  });
});
