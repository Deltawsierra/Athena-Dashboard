// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";

import Failsafe from "@/pages/Failsafe";
import AIHealth from "@/pages/AIHealth";
import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";
import Assurance from "@/pages/Assurance";
import AIControlPanel from "@/pages/AIControlPanel";
import AIChat from "@/pages/AIChat";
import Documents from "@/pages/Documents";
import RetestPanel from "@/components/RetestPanel";

/**
 * PR #52 round 2, R2-B. The baed23b sweep handled a source that never
 * answered, but not one whose NEXT read fails. React Query keeps the last data
 * after a failed refetch, and these screens branched on `data` first, so the
 * last answer kept rendering as the current one:
 *
 *   Failsafe (polls /api/failsafe/state every 5s): the governor pill kept
 *   reading "running" and the command tiles kept their counts, with no word
 *   that the state read was failing.
 *   AI Health (polls /api/ai-health/latest every 60s): the "could not load"
 *   card appeared, and the CPU/memory/scans tiles under it kept the old
 *   reading, unlabelled, as current.
 *
 * The same sweep over every other polled or refetched source found the same
 * shape on the Athena and Penetration Testing engine banners and scan views,
 * the Assurance control-plane status, the AI Control settings (the kill switch
 * drawn in a state nobody had read since), the assistant status and
 * conversation, the document list, and a run's retest decisions (a failed read
 * shown as "the engine kept no decisions"). Each now reads error-first, the
 * rule lib/loaded.ts already had.
 *
 * Adapted from the adversarial reproducer
 * r2-b-polled-source-stale-after-failed-refetch.test.tsx.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Sources answer from `seed` until their path is put in `failing`. */
let failing = new Set<string>();
function mount(ui: ReactElement, seed: Array<[unknown[], unknown]>) {
  failing = new Set();
  const data = new Map(seed.map(([k, v]) => [JSON.stringify(k), v]));
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          const key = JSON.stringify(queryKey);
          if (failing.has(String(queryKey[0]))) throw new Error("bff unreachable");
          if (data.has(key)) return data.get(key);
          throw new Error(`unexpected ${key}`);
        },
      },
    },
  });
  for (const [k, v] of seed) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return client;
}

/** Make the next read of `path` fail, and wait until every query on it has. */
async function nextReadFails(client: QueryClient, path: string, key: unknown[] = [path]) {
  failing.add(path);
  await act(async () => { await client.refetchQueries({ queryKey: [path] }); });
  await waitFor(() => expect(client.getQueryState(key)?.status).toBe("error"));
}

const text = () => document.body.textContent ?? "";
/** The Failsafe governor card's text: its label, then the state or why it is unread. */
const governor = () => screen.getByText("Engine governor").parentElement?.textContent ?? "";

const FAILSAFE_STATUS = { configured: true, reachable: true, authorized: true, url: "http://cp", detail: "", defaultEngineId: "athena-1" };
const FAILSAFE_SEED = (): Array<[unknown[], unknown]> => [
  [["/api/failsafe/status"], FAILSAFE_STATUS],
  [["/api/failsafe/state", "athena-1"], {
    engineId: "athena-1", engineState: "running", engineStateAvailable: true,
    awaitingSignatures: [], ready: [], recent: [],
  }],
  [["/api/failsafe/audit"], [{ uuid: "e1", event: "command_drafted", actor: "alice", timestamp: new Date().toISOString() }]],
];

describe("Failsafe", () => {
  it("the governor state is not left reading 'running' after its read fails", async () => {
    const client = mount(<Failsafe />, FAILSAFE_SEED());
    expect(governor()).toBe("Engine governorrunning");
    expect(text()).toMatch(/No commands awaiting signatures or waiting on the engine/);

    await nextReadFails(client, "/api/failsafe/state", ["/api/failsafe/state", "athena-1"]);
    expect(text(), "the failed state read is not mentioned anywhere").toMatch(/Could not read the engine state: bff unreachable/);
    // (Matched on the governor card itself: in the page's whole text the pill
    // runs into its label, "governorrunning", which no \brunning\b matches.)
    expect(governor(), "the last governor state still reads as current").not.toMatch(/running/);
    expect(governor()).toMatch(/Not read/);
    // No "none in flight" from a read that failed, and the counts are unknown.
    expect(text()).not.toMatch(/No commands awaiting signatures or waiting on the engine/);
    expect(screen.getByTestId("text-inflight-unread").textContent).toMatch(/Could not read the engine state/);
    for (const label of ["Awaiting signatures", "Ready for engine"]) {
      const tile = screen.getByText(label).closest("div")?.parentElement;
      expect(tile?.querySelector(".athena-figure")?.textContent, label).toBe("—");
    }
  });

  it("the controls go dead when the status they were enabled by can no longer be read", async () => {
    const client = mount(<Failsafe />, FAILSAFE_SEED());
    expect((screen.getByTestId("button-draft-pause") as HTMLButtonElement).disabled).toBe(false);
    await nextReadFails(client, "/api/failsafe/status");
    expect(text()).toMatch(/Could not read the failsafe status: bff unreachable/);
    for (const action of ["pause", "resume", "stand_down", "release", "terminate"]) {
      expect((screen.getByTestId(`button-draft-${action}`) as HTMLButtonElement).disabled, action).toBe(true);
    }
    // And nothing read under that status is shown as current either.
    expect(governor()).not.toMatch(/running/);
    expect(text()).not.toMatch(/command drafted/);
  });

  it("an engine the operator named keeps no state read under a status that can no longer be read", async () => {
    const client = mount(<Failsafe />, FAILSAFE_SEED());
    // Typed rather than defaulted, so the engine stays named when the status
    // (which supplies the default) goes, and its state read stays cached.
    fireEvent.change(screen.getByTestId("input-engine-id"), { target: { value: "athena-2" } });
    fireEvent.change(screen.getByTestId("input-engine-id"), { target: { value: "athena-1" } });
    await waitFor(() => expect(governor()).toBe("Engine governorrunning"));
    await nextReadFails(client, "/api/failsafe/status");
    expect((screen.getByTestId("input-engine-id") as HTMLInputElement).value).toBe("athena-1");
    expect(governor()).not.toMatch(/running/);
    expect(governor()).toMatch(/Not read: the failsafe control plane is not ready/);
  });

  it("an open draft dialog cannot confirm once the status it was opened under can no longer be read", async () => {
    const client = mount(<Failsafe />, FAILSAFE_SEED());
    fireEvent.click(screen.getByTestId("button-draft-pause"));
    const confirm = () => screen.getByTestId("button-confirm-draft") as HTMLButtonElement;
    expect(confirm().disabled).toBe(false);
    await nextReadFails(client, "/api/failsafe/status");
    expect(confirm().disabled).toBe(true);
  });

  it("a command console does not keep the last status and signers after its read fails", async () => {
    const command = {
      uuid: "cmd-1", action: "pause", engineId: "athena-1", status: "awaiting_signatures",
      signers: ["alice"], requiredSignatures: 2, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const seed = FAILSAFE_SEED();
    seed[1] = [["/api/failsafe/state", "athena-1"], {
      engineId: "athena-1", engineState: "running", engineStateAvailable: true,
      awaitingSignatures: [command], ready: [], recent: [],
    }];
    seed.push([["/api/failsafe/commands", "cmd-1"], { command, draft: { action: "pause" }, signingBytes: "AAAA" }]);
    const client = mount(<Failsafe />, seed);
    fireEvent.click(screen.getByTestId("button-open-cmd-1"));
    await waitFor(() => expect(screen.getByTestId("button-submit-signature")).toBeTruthy());
    expect(text()).toMatch(/1 of 2 operator signatures/);

    await nextReadFails(client, "/api/failsafe/commands", ["/api/failsafe/commands", "cmd-1"]);
    expect(screen.getByTestId("text-command-unread").textContent).toMatch(/Could not read this command from the control plane: bff unreachable/);
    expect(text()).not.toMatch(/1 of 2 operator signatures/);
    expect(screen.queryByTestId("button-submit-signature")).toBeNull();
  });

  it("the audit trail is not left showing the last rows after its read fails", async () => {
    const client = mount(<Failsafe />, FAILSAFE_SEED());
    expect(text()).toMatch(/command drafted/);
    await nextReadFails(client, "/api/failsafe/audit");
    expect(text()).toMatch(/Could not load failsafe activity: bff unreachable/);
    expect(text()).not.toMatch(/command drafted/);
  });
});

describe("AI Health", () => {
  const reading = {
    id: "m1", timestamp: new Date("2026-09-25T10:00:00Z").toISOString(), cpuUsage: 41, memoryUsage: 63, activeScans: 7,
    totalScansToday: 12, successRate: null, averageResponseTime: 120, detectionAccuracy: null,
    falsePositiveRate: null, modelsLoaded: ["clf-a"], lastTrainingDate: null, guardsChecked: null, guardsFailing: null,
  };
  const SEED = (): Array<[unknown[], unknown]> => [
    [["/api/ai-health/latest"], reading],
    [["/api/ai-health"], [reading, { ...reading, id: "m0", averageResponseTime: 110 }]],
  ];

  it("the old reading is not left under the failure card as current; only its time is said", async () => {
    const client = mount(<AIHealth />, SEED());
    await waitFor(() => expect(screen.getByTestId("reading-active").textContent).toMatch(/7/));
    await nextReadFails(client, "/api/ai-health/latest");
    await waitFor(() => expect(screen.getByTestId("text-reading-failed")).toBeTruthy());
    // "Could not load the latest reading" ... and no "Scans running 7" beneath it.
    expect(screen.queryByTestId("reading-active")).toBeNull();
    expect(screen.queryByTestId("reading-cpu")).toBeNull();
    expect(screen.queryByTestId("list-models")).toBeNull();
    expect(screen.getByTestId("text-reading-held").textContent).toMatch(/It is not shown, because it is not current/);
  });

  it("a reading history whose refetch failed is not drawn", async () => {
    const client = mount(<AIHealth />, SEED());
    await nextReadFails(client, "/api/ai-health");
    expect(screen.getByTestId("text-history-failed").textContent).toMatch(/Could not load the reading history: bff unreachable/);
    // Both charts are drawn from the history, and neither draws the stale one.
    expect(screen.getAllByText(/Could not load the reading history: bff unreachable/)).toHaveLength(2);
    expect(text()).not.toMatch(/Not enough readings with traffic/);
  });
});

const ENGINE = { configured: true, reachable: true, authorized: true, url: "http://engine.test", detail: "" };
const SCAN_SEED = (): Array<[unknown[], unknown]> => [
  [["/api/engine/status"], ENGINE],
  [["/api/clients"], [{ id: "c1", name: "Acme" }]],
  [["/api/sites"], []],
  [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
  [["/api/auth/check"], { authenticated: true, user: null }],
  [["/api/scans/t1"], {
    test: { id: "t1", startedAt: new Date().toISOString(), criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 },
    state: "running", engine: { findings: [] },
  }],
  [["/api/tests/t1/decisions"], { decisions: [], truncated: false, detail: "" }],
];

/** Pick the client, type a target and start a scan; the POST answers test t1. */
async function startAScan() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ test: { id: "t1" }, runId: "run-1" }), {
    status: 201, headers: { "Content-Type": "application/json" },
  })));
  fireEvent.change(document.querySelectorAll("select")[0], { target: { value: "c1" } });
  fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://acme.test" } });
  fireEvent.click(screen.getByTestId("button-start-scan"));
  await waitFor(() => expect(screen.getByTestId("text-state").textContent).toMatch(/running/));
}

for (const [name, Page] of [["Athena", AthenaScan], ["Penetration testing", PentestScan]] as const) {
  describe(name, () => {
    it("the engine banner does not keep saying connected after the status read fails", async () => {
      const client = mount(<Page />, SCAN_SEED());
      expect(screen.getByTestId("text-engine-connected").textContent).toMatch(/engine at http:\/\/engine.test/);
      await nextReadFails(client, "/api/engine/status");
      expect(screen.queryByTestId("text-engine-connected")).toBeNull();
      expect(screen.getByTestId("text-engine-unread").textContent).toMatch(/bff unreachable/);
      expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(true);
    });

    it("a scan whose state can no longer be read is not shown as running, and can still be stopped", async () => {
      const client = mount(<Page />, SCAN_SEED());
      await startAScan();
      expect(screen.getByTestId("button-stop-scan")).toBeTruthy();

      await nextReadFails(client, "/api/scans/t1");
      expect(screen.getByTestId("text-scan-unread").textContent).toMatch(/Could not read this scan's state: bff unreachable/);
      expect(screen.queryByTestId("text-state")).toBeNull();
      // It may still be running: the stop stays, a second scan does not start over it.
      expect(screen.getByTestId("button-stop-scan")).toBeTruthy();
      expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(true);
      expect(text()).not.toMatch(/No scan running/);
    });
  });
}

describe("Assurance", () => {
  it("draws nothing from a reachability it could no longer confirm", async () => {
    const client = mount(<Assurance />, [
      [["/api/assurance/status"], { configured: true, reachable: true, authorized: true, url: "http://cp", detail: "" }],
      [["/api/assurance/deployments"], []], [["/api/assurance/findings"], []], [["/api/assurance/unknowns"], []],
      [["/api/assurance/assets"], []], [["/api/assurance/providers"], []],
    ]);
    await waitFor(() => expect(text()).toMatch(/Each deployment, the assets it is built from/));
    await nextReadFails(client, "/api/assurance/status");
    expect(text()).toMatch(/Could not check the control plane\.bff unreachable/);
    expect(text()).not.toMatch(/Each deployment, the assets it is built from/);
  });
});

describe("AI Control", () => {
  it("does not draw the kill switch in a state it failed to re-read", async () => {
    const client = mount(<AIControlPanel />, [
      [["/api/ai-control"], {
        id: "s", systemStatus: "operational", killSwitchEnabled: false, overrideMode: false,
        activeSystems: ["threat_detection"], maxConcurrentTests: 5, autoShutdownThreshold: 90,
        lastModifiedBy: null, lastModifiedAt: new Date().toISOString(),
      }],
    ]);
    expect(text()).toMatch(/Operational/);
    expect(screen.queryByTestId("text-kill-switch-unknown")).toBeNull();
    await nextReadFails(client, "/api/ai-control");
    expect(text()).toMatch(/Could not load the AI control settings: bff unreachable/);
    expect(screen.getByTestId("text-kill-switch-unknown")).toBeTruthy();
    expect(text()).not.toMatch(/Operational/);
  });
});

describe("AI Chat", () => {
  const SEED = (): Array<[unknown[], unknown]> => [
    [["/api/chat"], [{ id: "m1", sender: "user", message: "the earlier question", timestamp: new Date().toISOString(), userId: "u" }]],
    [["/api/assistant/status"], { configured: true, model: "athena-assistant-1", detail: "" }],
  ];

  it("does not name a connected assistant it failed to re-check", async () => {
    const client = mount(<AIChat />, SEED());
    expect(screen.getByTestId("badge-assistant").textContent).toMatch(/athena-assistant-1/);
    await nextReadFails(client, "/api/assistant/status");
    expect(screen.getByTestId("badge-assistant").textContent).toMatch(/Status unknown/);
    expect(screen.getByTestId("text-assistant-unread").textContent).toMatch(/bff unreachable/);
  });

  it("does not leave the last conversation standing as the whole of it", async () => {
    const client = mount(<AIChat />, SEED());
    expect(text()).toMatch(/the earlier question/);
    await nextReadFails(client, "/api/chat");
    expect(text()).toMatch(/Could not load the conversation: bff unreachable/);
    // (The message list animates its rows out, so allow it the exit.)
    await waitFor(() => expect(text()).not.toMatch(/the earlier question/));
  });
});

describe("Documents", () => {
  it("does not list rows from a read that has since failed", async () => {
    const client = mount(<Documents />, [
      [["/api/documents"], [{ id: "d1", clientId: "c1", title: "Q3 pentest report", documentType: "Report", description: null, fileUrl: null, createdAt: new Date().toISOString(), createdBy: null }]],
      [["/api/clients"], [{ id: "c1", name: "Acme" }]],
      [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
      [["/api/auth/check"], { authenticated: true, user: null }],
    ]);
    expect(text()).toMatch(/Q3 pentest report/);
    await nextReadFails(client, "/api/documents");
    expect(text()).toMatch(/Could not load documents: bff unreachable/);
    expect(text()).not.toMatch(/Q3 pentest report/);
  });
});

describe("Retest decisions", () => {
  it("a failed read is not 'the engine kept no decisions'", async () => {
    const client = mount(<RetestPanel testId="t9" />, []);
    await waitFor(() => expect(client.getQueryState(["/api/tests/t9/decisions"])?.status).toBe("error"));
    expect(screen.getByTestId("text-decisions-unread").textContent).toMatch(/Could not load this run's decisions/);
    expect(screen.queryByTestId("text-no-decisions")).toBeNull();
  });
});
