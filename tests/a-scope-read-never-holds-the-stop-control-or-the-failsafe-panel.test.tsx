// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import fs from "fs";
import path from "path";

import Authority from "@/pages/Authority";
import Failsafe, { failsafeStateKey } from "@/pages/Failsafe";
import Tests from "@/pages/Tests";
import { getQueryFn, queryClient as appQueryClient } from "@/lib/queryClient";
import type { RecoveryRecords } from "@shared/recovery-record";
import { standIn } from "./helpers/bad-rows";
import { DEP, FINDING, ROUTE, servedByPath, type CaseName } from "./helpers/incident-scopes";

/**
 * SAFETY (DASH-SCOPE): the read of an incident's scope on the recovery screen is on no
 * stop's path in the console either. The Stop control and the failsafe panel never wait
 * on it, and a scope read that hangs, fails or answers nonsense never delays or disables
 * them.
 *
 *   - Nothing is read for a scope until a person opens it, and the record it rides
 *     beside is drawn without it.
 *   - One incident's scope is open at a time: opening another closes the first and
 *     cancels its read. So the scope reads of the screen never keep more than ONE of the
 *     browser's six connections, whatever the backend does with them
 *     (tests/a-stop-goes-while-a-scope-read-hangs-fails-or-answers-nonsense.test.ts sends a
 *     stop through the six with that one held). Closing the scope, or leaving the
 *     screen, cancels the read too.
 *   - With the scope read hung, failed or answered with something that is not a scope: a
 *     running scan's Stop is enabled and asks the abort route at once; the failsafe
 *     panel's pause, stand-down and terminate are enabled and a stand-down is drafted;
 *     and what became of the scope read is said on its own panel, nowhere else.
 *   - The scope view holds no write and no stop control, and no screen that holds a Stop
 *     reads it.
 *
 * No clock is read: the tests wait on the requests themselves.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  (Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The deployment's recovery page as this console's real route answers it for a backend that serves the scope. */
const answered: { page: RecoveryRecords | null } = { page: null };
const OPENABLE: CaseName[] = ["declared", "three", "widened"];

beforeAll(async () => {
  const backend = await standIn();
  try {
    backend.serve(servedByPath());
    const whole = await backend.user.get(ROUTE.page);
    expect(whole.status, JSON.stringify(whole.body)).toBe(200);
    const incidents = (whole.body as RecoveryRecords).incidents.filter((one) => OPENABLE.some((name) => FINDING[name] === one.finding));
    answered.page = { ...(whole.body as RecoveryRecords), incidents, incidentCount: incidents.length, returned: incidents.length };
  } finally {
    await backend.close();
  }
}, 120_000);

const STATUS = { configured: true, reachable: true, authorized: true, url: "https://backend.invalid", detail: "ok" };
const DEPLOYMENTS = [{ uuid: DEP, name: "harbor-desk", environment: "production", decision: "audit_incomplete", decisionLabel: "Audit incomplete" }];
const PAGE_URL = `${ROUTE.page}?offset=0`;

const card = (name: CaseName) => document.querySelector(`[data-testid="incident"][data-incident="${FINDING[name]}"]`) as HTMLElement;
const toggle = (name: CaseName) => within(card(name)).getByTestId("incident-scope-revisions-toggle");
const panel = (name: CaseName) => within(card(name)).getByTestId("incident-scope-revisions");

function recoveryScreen() {
  const location = memoryLocation({ path: `/authority/recovery?deployment=${DEP}`, record: true });
  return (
    <Router hook={location.hook} searchHook={location.searchHook}>
      <Authority params={{ screen: "recovery" }} />
    </Router>
  );
}

describe("at most one scope read is in flight, and it is cancelled when closed or left", () => {
  interface Read { url: string; signal: AbortSignal | undefined }

  /** The app's own query function over a fetch that answers the record and never answers a scope read. */
  function mountWithScopeReadsStalled() {
    const reads: Read[] = [];
    const answers: Record<string, unknown> = { "/api/assurance/status": STATUS, "/api/assurance/deployments": DEPLOYMENTS, [PAGE_URL]: answered.page };
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      reads.push({ url: String(url), signal: init?.signal ?? undefined });
      if (String(url) in answers) {
        return Promise.resolve(new Response(JSON.stringify(answers[String(url)]), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }));
    const client = new QueryClient({
      defaultOptions: { ...appQueryClient.getDefaultOptions(), queries: { ...appQueryClient.getDefaultOptions().queries, queryFn: getQueryFn({ on401: "throw" }) } },
    });
    const view = render(<QueryClientProvider client={client}>{recoveryScreen()}</QueryClientProvider>);
    const scopeReads = () => reads.filter((one) => one.url.includes("/scope-revisions"));
    return { view, scopeReads, inFlight: () => scopeReads().filter((one) => one.signal?.aborted !== true) };
  }

  it("reads nothing for a scope until a person opens it, and draws the record without it", async () => {
    const { scopeReads } = mountWithScopeReadsStalled();
    await waitFor(() => expect(document.querySelectorAll('[data-testid="incident"]').length).toBe(OPENABLE.length));
    expect(scopeReads()).toEqual([]);
    // The record's own account of the scope is already on screen: what keeps the widened one back, in words.
    expect(within(card("widened")).getByTestId("step-scope-widened")).toBeTruthy();
    expect(within(card("three")).getByTestId("scope-removed").getAttribute("data-row-count")).toBe("1");
  });

  it("opening another incident's scope closes the first and cancels its read: one in flight, never two", async () => {
    const { scopeReads, inFlight } = mountWithScopeReadsStalled();
    await waitFor(() => expect(document.querySelectorAll('[data-testid="incident"]').length).toBe(OPENABLE.length));
    fireEvent.click(toggle("declared"));
    await waitFor(() => expect(scopeReads().map((one) => one.url)).toEqual([ROUTE.scope("declared")]));
    const first = scopeReads()[0];
    expect(first.signal, "the scope read carries a signal, so it can be cancelled").toBeDefined();
    expect(first.signal!.aborted).toBe(false);
    expect(within(panel("declared")).getByTestId("read-loading").textContent).toBe("Reading this incident's scope…");

    for (const [next, soFar] of [["three", 2], ["widened", 3]] as const) {
      fireEvent.click(toggle(next));
      await waitFor(() => expect(scopeReads()).toHaveLength(soFar));
      // The one before it is closed and its read cancelled; exactly one scope read is in flight.
      await waitFor(() => expect(inFlight().map((one) => one.url)).toEqual([ROUTE.scope(next)]));
      expect(document.querySelectorAll('[data-testid="incident-scope-revisions"][data-open="true"]')).toHaveLength(1);
      expect(panel(next).getAttribute("data-open")).toBe("true");
    }
    expect(first.signal!.aborted).toBe(true);
    expect(panel("declared").getAttribute("data-open")).toBe("false");
  });

  it("closing the scope cancels its read, and so does leaving the screen", async () => {
    const { view, scopeReads, inFlight } = mountWithScopeReadsStalled();
    await waitFor(() => expect(document.querySelectorAll('[data-testid="incident"]').length).toBe(OPENABLE.length));
    fireEvent.click(toggle("three"));
    await waitFor(() => expect(inFlight()).toHaveLength(1));
    fireEvent.click(toggle("three"));
    await waitFor(() => expect(inFlight()).toEqual([]));
    expect(panel("three").getAttribute("data-open")).toBe("false");
    // Opened again, and the screen left while its read is still held.
    fireEvent.click(toggle("three"));
    await waitFor(() => expect(inFlight()).toHaveLength(1));
    view.unmount();
    await waitFor(() => expect(inFlight()).toEqual([]));
    expect(scopeReads().every((one) => one.signal?.aborted === true)).toBe(true);
  });
});

describe("a scope read that hangs, fails or answers nonsense never delays or disables a stop control", () => {
  const at = new Date(1_700_000_000_000).toISOString();
  const RUNNING = {
    id: "t-run", clientId: "c1", siteId: "s1", testType: "vulnerability-scan", severity: null, startedAt: at, completedAt: null,
    vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, executedBy: null, isSample: false,
    status: "running", summary: "https://acme.example/ — engine run run-7", findings: { runId: "run-7", target: "https://acme.example/", results: [] },
  };
  const command = (over: Record<string, unknown> = {}) => ({
    uuid: "cmd-sd", action: "stand_down", engineId: "athena-1", status: "awaiting_signatures", nonce: "n", reason: "r",
    issuedAt: at, signers: ["alice"], requiredSignatures: 2, expiresAt: "2999-01-01T00:00:00.000Z", createdAt: null, updatedAt: null, ...over,
  });
  const drafted = (cmd: ReturnType<typeof command>) => ({
    command: cmd, signingBytes: "AAAA",
    draft: { action: cmd.action, engine_id: "athena-1", nonce: "n", issued_at: cmd.issuedAt, expires_at: cmd.expiresAt, reason: "r" },
  });

  /** What each screen was last read as: the recovery record, a running scan, and the failsafe console. */
  const seed = (): Array<[unknown[], unknown]> => [
    [["/api/assurance/status"], STATUS],
    [["/api/assurance/deployments"], DEPLOYMENTS],
    [[ROUTE.page, { offset: 0 }], answered.page],
    [["/api/engine/status"], { configured: true, reachable: true, authorized: true, url: "http://engine.test", detail: "" }],
    [["/api/clients"], [{ id: "c1", name: "Acme", company: "Acme", email: "a@a.test", status: "active" }]],
    [["/api/sites"], [{ id: "s1", clientId: "c1", name: "Checkout", url: "https://acme.example" }]],
    [["/api/tests"], [RUNNING]],
    [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
    [["/api/auth/check"], { authenticated: true, user: null }],
    [["/api/failsafe/status"], { configured: true, reachable: true, authorized: true, url: "http://cp", detail: "", defaultEngineId: "athena-1" }],
    [[...failsafeStateKey("athena-1")], { engineId: "athena-1", engineState: "running", engineStateAvailable: true, awaitingSignatures: [command()], ready: [], recent: [] }],
    [["/api/failsafe/audit"], []],
    [["/api/failsafe/commands", "cmd-sd"], drafted(command())],
  ];

  type Mode = "hangs" | "fails" | "answers a number" | "answers a list" | "answers revisions that are not a list";
  const NONSENSE: Partial<Record<Mode, unknown>> = {
    "answers a number": 7, "answers a list": ["revision 1", null], "answers revisions that are not a list": { revisions: "three of them" },
  };
  /** What the scope's own panel says for each: reading, could not read, or an answer it cannot read. */
  const SAID: Record<Mode, string> = {
    hangs: "read-loading", fails: "read-error",
    "answers a number": "scope-answer-unreadable", "answers a list": "scope-answer-unreadable", "answers revisions that are not a list": "scope-answer-unreadable",
  };

  /** The recovery screen, a running scan's row and the failsafe console under one cache; the scope read does what `mode` says. */
  function mount(mode: Mode) {
    const state = { scopeReads: 0, scopeSettled: 0 };
    const data = new Map(seed().map(([key, value]) => [JSON.stringify(key), value]));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey, signal }) => {
          if (String(queryKey[0]).includes("/scope-revisions")) {
            state.scopeReads += 1;
            if (mode === "hangs") {
              return new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => { state.scopeSettled += 1; reject(new DOMException("aborted", "AbortError")); });
              });
            }
            state.scopeSettled += 1;
            if (mode === "fails") throw new Error("the Athena control plane answered 500");
            return NONSENSE[mode];
          }
          const value = data.get(JSON.stringify(queryKey));
          if (value === undefined) throw new Error(`unseeded ${JSON.stringify(queryKey)}`);
          return value;
        } } },
    });
    for (const [key, value] of seed()) client.setQueryData(key, value);
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      posts.push(`${init?.method ?? "GET"} ${url}`);
      const body = String(url).includes("/api/failsafe/commands") ? drafted(command({ uuid: "new" })) : { stopped: true, runId: "run-7" };
      return new Response(JSON.stringify(body), { status: String(url).includes("/api/failsafe/commands") ? 201 : 200, headers: { "Content-Type": "application/json" } });
    }));
    render(
      <QueryClientProvider client={client}>
        <div data-testid="screen-recovery">{recoveryScreen()}</div>
        <div data-testid="screen-tests"><Tests /></div>
        <div data-testid="screen-failsafe"><Failsafe /></div>
      </QueryClientProvider>,
    );
    return { state, posts };
  }
  const button = (id: string) => screen.getByTestId(id) as HTMLButtonElement;

  for (const mode of ["hangs", "fails", "answers a number", "answers a list", "answers revisions that are not a list"] as const) {
    it(`while the scope read ${mode}: a running scan's Stop is enabled and asks the abort route at once`, async () => {
      const { state, posts } = mount(mode);
      fireEvent.click(toggle("widened"));
      await waitFor(() => expect(within(panel("widened")).getByTestId(SAID[mode])).toBeTruthy());
      expect(state.scopeReads).toBe(1);
      expect(button("button-stop-t-run").disabled).toBe(false);
      fireEvent.click(button("button-stop-t-run"));
      await waitFor(() => expect(posts).toEqual(["POST /api/scans/t-run/abort"]));
      // A hung read is hanging still: the Stop went without it.
      if (mode === "hangs") expect(state.scopeSettled).toBe(0);
    });

    it(`while the scope read ${mode}: the failsafe panel's pause, stand-down and terminate are enabled, and a stand-down is drafted`, async () => {
      const { state, posts } = mount(mode);
      fireEvent.click(toggle("widened"));
      await waitFor(() => expect(within(panel("widened")).getByTestId(SAID[mode])).toBeTruthy());
      for (const action of ["pause", "stand_down", "terminate"]) {
        expect(button(`button-draft-${action}`).disabled, `${action} must stay operable`).toBe(false);
      }
      // The stand-down a second operator has to sign is still reachable.
      expect(screen.getByTestId("button-open-cmd-sd")).toBeTruthy();
      fireEvent.click(button("button-draft-stand_down"));
      fireEvent.change(screen.getByTestId("input-reason"), { target: { value: "going wrong" } });
      expect(button("button-confirm-draft").disabled).toBe(false);
      fireEvent.click(button("button-confirm-draft"));
      await waitFor(() => expect(posts).toContain("POST /api/failsafe/commands"));
      if (mode === "hangs") expect(state.scopeSettled).toBe(0);
    });

    it(`while the scope read ${mode}: the record stays drawn, and what became of the read is said on the scope's own panel and nowhere else`, async () => {
      mount(mode);
      fireEvent.click(toggle("widened"));
      await waitFor(() => expect(within(panel("widened")).getByTestId(SAID[mode])).toBeTruthy());
      // The record it rides beside: its state, what keeps it back, and the other incidents.
      expect(within(card("widened")).getByTestId("step-scope-widened")).toBeTruthy();
      expect(within(within(card("widened")).getByTestId("incident-current")).getByTestId("step-state").textContent).toBe("repair_tested");
      expect(document.querySelectorAll('[data-testid="incident"]').length).toBe(OPENABLE.length);
      // Said once, inside the scope's panel; the other screens say nothing of it and show no error of their own.
      expect(screen.getAllByTestId(SAID[mode])).toHaveLength(1);
      for (const other of ["screen-tests", "screen-failsafe"]) {
        expect(screen.getByTestId(other).textContent, other).not.toMatch(/scope|could not read|Could not read/i);
      }
      expect(screen.getByTestId("screen-tests").querySelector('[data-testid="button-stop-t-run"]')).not.toBeNull();
    });
  }
});

describe("the scope view holds no stop and no write, and no stop control reads it", () => {
  const ROOT = path.resolve(__dirname, "..");
  const source = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
  /** The module specifiers a file imports. */
  const imports = (file: string) => Array.from(source(file).matchAll(/from\s+"([^"]+)"/g)).map((match) => match[1]);

  it("the scope view and the recovery screen send nothing: no mutation, no request of their own, only the cache's reads", () => {
    for (const file of ["client/src/components/authority/IncidentScope.tsx", "client/src/components/authority/RecoveryRecords.tsx"]) {
      const code = source(file);
      for (const sends of ["useMutation", "apiRequest", "apiFetch", "fetch(", "XMLHttpRequest", "sendBeacon", "setQueryData", "invalidateQueries"]) {
        expect(code.includes(sends), `${file} uses ${sends}`).toBe(false);
      }
      // No read opts out of being cancelled when its view is left.
      expect(code.includes("cancelWhenLeft"), file).toBe(false);
    }
    expect(source("client/src/components/authority/IncidentScope.tsx").match(/useQuery</g) ?? []).toHaveLength(1);
  });

  it("no screen that holds a Stop imports the scope view, the recovery screen or the scope's shapes", () => {
    const holdsAStop = [
      "client/src/pages/Failsafe.tsx", "client/src/pages/AIControlPanel.tsx", "client/src/pages/Tests.tsx", "client/src/pages/AthenaScan.tsx",
      "client/src/pages/PentestScan.tsx", "client/src/components/RunningScans.tsx", "client/src/components/NoStopPanel.tsx",
      "client/src/components/RetestPanel.tsx", "client/src/components/AppShell.tsx",
      // What the failsafe console draws its unread rows with: shared with the authority screens, and it reads no scope.
      "client/src/components/authority/parts.tsx",
    ];
    for (const file of holdsAStop) {
      expect(imports(file).filter((one) => /IncidentScope|RecoveryRecords|incident-scope|recovery-record/.test(one)), file).toEqual([]);
    }
    // And the scope view imports nothing a stop is sent with.
    expect(imports("client/src/components/authority/IncidentScope.tsx").sort()).toEqual([
      "./history", "./parts", "@/lib/queryClient", "@shared/incident-scope", "@shared/recovery-record", "@tanstack/react-query", "react",
    ]);
  });
});
