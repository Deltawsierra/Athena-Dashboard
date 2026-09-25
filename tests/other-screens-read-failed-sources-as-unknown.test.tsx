// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";

import Tests from "@/pages/Tests";
import Documents from "@/pages/Documents";
import AuditLogs from "@/pages/AuditLogs";
import Teams from "@/pages/Teams";
import Failsafe from "@/pages/Failsafe";
import DeletionManagement from "@/pages/DeletionManagement";
import AIControlPanel from "@/pages/AIControlPanel";
import AIHealth from "@/pages/AIHealth";
import CVEClassifier from "@/pages/CVEClassifier";
import Classifiers from "@/pages/Classifiers";
import AIChat from "@/pages/AIChat";
import Assurance from "@/pages/Assurance";

/**
 * The same defect as Risks and Compliance (adversary round 1, F4/F9), found by
 * sweeping every other screen: a query that failed was read through
 * `data = []`, so the screen rendered its empty state or a zero as if the
 * record had been read and found empty -- "No Tests Found", "Total Members 0",
 * "No failsafe activity recorded yet", a kill switch drawn as not engaged.
 * Each screen now says the source could not be read, and why.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // framer-motion and radix probe these in jsdom.
  globalThis.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});

afterEach(cleanup);

/** Every source fails unless seeded. */
function mount(ui: ReactElement, seed: Array<[unknown[], unknown]> = []) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          throw new Error(`source failed: ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  for (const [key, value] of seed) client.setQueryData(key, value);
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return client;
}

async function failed(client: QueryClient, key: unknown[]) {
  await waitFor(() => expect(client.getQueryState(key)?.status).toBe("error"));
}

const text = () => document.body.textContent ?? "";

describe("list screens do not show a failed read as an empty record", () => {
  it("Tests", async () => {
    const client = mount(<Tests />);
    await failed(client, ["/api/tests"]);
    await waitFor(() => expect(text()).toMatch(/Could not load tests: source failed/));
    expect(text()).not.toMatch(/No Tests Found|Create your first security test/);
  });

  it("Documents", async () => {
    const client = mount(<Documents />);
    await failed(client, ["/api/documents"]);
    await waitFor(() => expect(text()).toMatch(/Could not load documents: source failed/));
    expect(text()).not.toMatch(/No Documents Found|Create your first document/);
  });

  it("Audit logs", async () => {
    const client = mount(<AuditLogs />);
    await failed(client, ["/api/logs"]);
    await waitFor(() => expect(text()).toMatch(/Could not load the activity log: source failed/));
    expect(text()).not.toMatch(/No Activity Logs Found|Activity will appear here/);
    expect(text()).not.toMatch(/Showing 0 of 0/);
  });

  it("Classifiers", async () => {
    const client = mount(<Classifiers />);
    await failed(client, ["/api/classifiers"]);
    await waitFor(() => expect(text()).toMatch(/Could not load classifiers: source failed/));
    expect(text()).not.toMatch(/No classifiers yet/);
  });

  it("CVE classifier's model list", async () => {
    const client = mount(<CVEClassifier />);
    await failed(client, ["/api/classifiers"]);
    await waitFor(() => expect(text()).toMatch(/Could not load classifiers: source failed/));
    expect(text()).not.toMatch(/No classifiers recorded|Nothing has been registered yet/);
    expect(screen.getByTestId("text-active-count").textContent).toBe("—");
    expect(text()).not.toMatch(/of 0 recorded/);
  });

  it("AI chat", async () => {
    const client = mount(<AIChat />, [[["/api/assistant/status"], { configured: false }]]);
    await failed(client, ["/api/chat"]);
    await waitFor(() => expect(text()).toMatch(/Could not load the conversation: source failed/));
    expect(text()).not.toMatch(/No messages yet/);
    for (const id of ["text-total-messages", "text-ai-responses", "text-user-messages"]) {
      expect(screen.getByTestId(id).textContent, id).toBe("—");
    }
  });
});

describe("count screens do not show a failed read as zero", () => {
  it("Teams: members", async () => {
    const client = mount(<Teams />);
    await failed(client, ["/api/users"]);
    await waitFor(() => expect(text()).toMatch(/Could not load team members: source failed/));
    expect(text()).not.toMatch(/No team members found/);
    for (const label of ["Total Members", "Active Members", "Administrators", "Inactive"]) {
      const card = Array.from(document.querySelectorAll(".athena-label")).find((el) => el.textContent === label);
      let node: Element | null = card ?? null;
      while (node && !node.querySelector(".athena-figure")) node = node.parentElement;
      expect(node?.querySelector(".athena-figure")?.textContent, `${label} tile`).toBe("—");
    }
  });

  it("Teams: API keys", async () => {
    const client = mount(<Teams />, [[["/api/users"], [
      { id: "u1", username: "admin", email: null, role: "admin", isActive: true, createdAt: new Date().toISOString() },
    ]]]);
    await failed(client, ["/api/api-keys"]);
    fireEvent.click(screen.getByRole("button", { name: "Access & Permissions" }));
    await waitFor(() => expect(text()).toMatch(/Could not load API keys: source failed/));
    expect(text()).not.toMatch(/No API keys yet/);
  });

  it("Deletion management's statistics", async () => {
    const client = mount(<DeletionManagement />);
    await failed(client, ["/api/clients"]);
    await failed(client, ["/api/tests"]);
    await failed(client, ["/api/documents"]);
    for (const id of ["text-total-clients", "text-total-tests", "text-total-documents", "text-total-items"]) {
      await waitFor(() => expect(screen.getByTestId(id).textContent, id).toBe("—"));
    }
  });

  it("AI health", async () => {
    const client = mount(<AIHealth />);
    await failed(client, ["/api/ai-health/latest"]);
    await waitFor(() => expect(text()).toMatch(/Could not load the latest reading: source failed/));
    expect(text()).not.toMatch(/No reading yet/);
  });
});

describe("control screens do not show a failed read as a safe state", () => {
  it("AI control panel: the kill switch and system status are unknown, not off and not offline", async () => {
    const client = mount(<AIControlPanel />);
    await failed(client, ["/api/ai-control"]);
    await waitFor(() => expect(text()).toMatch(/Could not load the AI control settings: source failed/));
    expect(screen.getByTestId("text-active-count").textContent).toBe("—");
    // Override Mode is no longer drawn at all (it governed nothing); it is not
    // drawn in a state nobody read either.
    expect(screen.queryByTestId("text-override-status")).toBeNull();
    expect(screen.getByTestId("text-status").textContent).toBe("—");
    expect(text()).toMatch(/Kill switch state unknown/);
    // The emergency action stays available: not knowing the state is no
    // reason to take away the stop button.
    expect(screen.getByTestId("button-kill-switch")).toBeTruthy();
  });

  it("AI control panel: the installer's settings are not shown as offline, nor as systems it cannot show", () => {
    // What server/init-data.ts wrote on first start before its ids matched
    // the page's -- still on record wherever someone has changed it since
    // (an untouched copy is replaced by today's default at startup).
    mount(<AIControlPanel />, [[["/api/ai-control"], {
      id: "s", systemStatus: "operational", killSwitchEnabled: false, overrideMode: false,
      activeSystems: ["threat_detection", "vulnerability_scanner", "log_analyzer"],
      maxConcurrentTests: 5, autoShutdownThreshold: 90,
      lastModifiedBy: null, updatedAt: new Date().toISOString(),
    }]]);
    expect(screen.getByTestId("text-status").textContent).toBe("Operational");
    // None of those ids is a system this page lists (every switch is off), so
    // the count is 0 of the 2 it switches, not "3 / 3" -- and the ids are
    // shown as what they are, not guessed at.
    expect(screen.getByTestId("text-active-count").textContent).toBe("0 / 2");
    expect(screen.getByTestId("text-unknown-systems").textContent).toBe(
      "Also on record, and not a system this build switches, so it governs nothing: threat_detection, " +
      "vulnerability_scanner, log_analyzer.",
    );
  });

  it("Assurance: a registry that failed hides the views, rather than drawing deployments without it", async () => {
    const client = mount(<Assurance />, [
      [["/api/assurance/status"], { configured: true, reachable: true, authorized: true, url: "https://cp", detail: "ok" }],
      [["/api/assurance/deployments"], [{
        uuid: "d1", name: "checkout", environment: "production", decision: null, decisionLabel: "",
        description: "", findingCount: 3, createdAt: null, updatedAt: null,
      }]],
      [["/api/assurance/unknowns"], []],
      [["/api/assurance/assets"], []],
      [["/api/assurance/providers"], []],
      // ["/api/assurance/findings"] is NOT seeded: its fetch fails.
    ]);
    await failed(client, ["/api/assurance/findings"]);
    await waitFor(() =>
      expect(screen.getByTestId("assurance-registry-failed").textContent).toMatch(
        /Could not load the findings: source failed/,
      ),
    );
    // The deployment is not drawn as if it had no findings.
    expect(text()).not.toMatch(/checkout/);
  });

  it("Failsafe: status, counts and activity are unknown, not zero or quiet", async () => {
    const client = mount(<Failsafe />);
    await failed(client, ["/api/failsafe/status"]);
    await waitFor(() => expect(text()).toMatch(/Could not read the failsafe status: source failed/));
    expect(text()).not.toMatch(/Checking the control plane/);
    expect(text()).not.toMatch(/No failsafe activity recorded yet/);
    expect(text()).not.toMatch(/The engine does not yet publish its live governor state/);
    for (const label of ["Awaiting signatures", "Ready for engine"]) {
      const card = Array.from(document.querySelectorAll(".athena-label")).find((el) => el.textContent === label);
      let node: Element | null = card ?? null;
      while (node && !node.querySelector(".athena-figure")) node = node.parentElement;
      expect(node?.querySelector(".athena-figure")?.textContent, `${label} tile`).toBe("—");
    }
  });
});
