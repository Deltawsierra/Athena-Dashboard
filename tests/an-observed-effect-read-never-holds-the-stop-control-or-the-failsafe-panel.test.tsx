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
import type { AuthorityChains } from "@/components/authority/types";
import { standIn } from "./helpers/bad-rows";
import { CHAINS_ROUTE, DEP, ROUTE, servedByPath } from "./helpers/observed-effects";

/**
 * SAFETY (DASH-OE5): the read of the observed effects on the authority chains screen
 * (GET /api/assurance/deployments/<uuid>/chain-outcomes through this console's server;
 * client/src/components/authority/ObservedEffects.tsx) is on no stop's path. The Stop
 * control and the failsafe panel never wait on it, and a read that hangs, fails or answers
 * nonsense never delays or disables them.
 *
 *   - It is ONE read per screen, whatever the backend serves: never one per chain or per
 *     record. So the screen's reads keep at most two of the browser's six connections
 *     (the chains' and this one), whatever the backend does with them, and each is cut at
 *     the server's read deadline (tests/every-relay-read-is-cut-at-its-deadline.test.ts
 *     finds this route among every assurance GET).
 *   - The chains are drawn without it: neither read waits on the other.
 *   - Leaving the screen cancels it.
 *   - With it hung, failed or answered with something that is not a page of outcomes: a
 *     running scan's Stop is enabled and asks the abort route at once; the failsafe panel's
 *     pause, stand-down and terminate are enabled and a stand-down is drafted; and what
 *     became of the read is said in the observed effects' own section, nowhere else.
 *   - The view holds no write and no stop control, and no screen that holds a Stop reads it.
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

/** The chains as this console's real route answers them: four chains, one held back by a receipt. */
const answered: { chains: AuthorityChains | null } = { chains: null };

beforeAll(async () => {
  const backend = await standIn();
  try {
    backend.serve(servedByPath());
    const res = await backend.user.get(CHAINS_ROUTE(DEP));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    answered.chains = res.body as AuthorityChains;
  } finally {
    await backend.close();
  }
}, 120_000);

const STATUS = { configured: true, reachable: true, authorized: true, url: "https://backend.invalid", detail: "ok" };
const DEPLOYMENTS = [{ uuid: DEP, name: "fleet-desk", environment: "production", decision: "audit_incomplete", decisionLabel: "Audit incomplete" }];
const CHAIN_COUNT = 4;

const effectsSection = () => screen.getByTestId("observed-effects-section");

function chainsScreen() {
  const location = memoryLocation({ path: `/authority/chains?deployment=${DEP}`, record: true });
  return (
    <Router hook={location.hook} searchHook={location.searchHook}>
      <Authority params={{ screen: "chains" }} />
    </Router>
  );
}

describe("one read of the observed effects per screen, beside the chains and never before them, cancelled when left", () => {
  interface Read { url: string; signal: AbortSignal | undefined }

  /** The app's own query function over a fetch that answers the chains and never answers the observed effects. */
  function mountWithEffectsReadStalled() {
    const reads: Read[] = [];
    const answers: Record<string, unknown> = {
      "/api/assurance/status": STATUS, "/api/assurance/deployments": DEPLOYMENTS, [CHAINS_ROUTE(DEP)]: answered.chains,
    };
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
    const view = render(<QueryClientProvider client={client}>{chainsScreen()}</QueryClientProvider>);
    const effectReads = () => reads.filter((one) => one.url.includes("/chain-outcomes"));
    return { view, reads, effectReads, inFlight: () => effectReads().filter((one) => one.signal?.aborted !== true) };
  }

  it("draws every chain, its receipts and what holds its proof back, while the observed effects are still being read", async () => {
    const { effectReads } = mountWithEffectsReadStalled();
    await waitFor(() => expect(document.querySelectorAll("[data-chain]").length).toBe(CHAIN_COUNT));
    expect(screen.getByTestId("effect-proof-held-back")).toBeTruthy();
    expect(within(effectsSection()).getByTestId("read-loading").textContent).toBe("Reading the observed effects…");
    expect(effectReads().map((one) => one.url)).toEqual([ROUTE(DEP)]);
  });

  it("makes one read of the observed effects for the whole screen, never one per chain or per record, and it can be cancelled", async () => {
    const { reads, effectReads } = mountWithEffectsReadStalled();
    await waitFor(() => expect(document.querySelectorAll("[data-chain]").length).toBe(CHAIN_COUNT));
    // Every read the screen makes has been made by now: the status, the list, the chains and the one effects read.
    await waitFor(() => expect(reads.map((one) => one.url)).toContain(ROUTE(DEP)));
    expect(effectReads()).toHaveLength(1);
    expect(reads.filter((one) => one.url.startsWith(`/api/assurance/deployments/${DEP}/`)).map((one) => one.url).sort()).toEqual(
      [CHAINS_ROUTE(DEP), ROUTE(DEP)].sort(),
    );
    const [read] = effectReads();
    expect(read.signal, "the read carries a signal, so it can be cancelled").toBeDefined();
    expect(read.signal!.aborted).toBe(false);
  });

  it("leaving the screen cancels the read", async () => {
    const { view, effectReads, inFlight } = mountWithEffectsReadStalled();
    await waitFor(() => expect(inFlight()).toHaveLength(1));
    view.unmount();
    await waitFor(() => expect(inFlight()).toEqual([]));
    expect(effectReads().every((one) => one.signal?.aborted === true)).toBe(true);
  });
});

describe("an observed-effects read that hangs, fails or answers nonsense never delays or disables a stop control", () => {
  const at = new Date(1_700_000_000_000).toISOString();
  const RUNNING = {
    id: "t-run", clientId: "c1", siteId: "s1", testType: "vulnerability-scan", severity: null, startedAt: at, completedAt: null,
    vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, executedBy: null, isSample: false,
    status: "running", summary: "https://fleet.example/ — engine run run-9", findings: { runId: "run-9", target: "https://fleet.example/", results: [] },
  };
  const command = (over: Record<string, unknown> = {}) => ({
    uuid: "cmd-sd", action: "stand_down", engineId: "athena-1", status: "awaiting_signatures", nonce: "n", reason: "r",
    issuedAt: at, signers: ["operator-one"], requiredSignatures: 2, expiresAt: "2999-01-01T00:00:00.000Z", createdAt: null, updatedAt: null, ...over,
  });
  const drafted = (cmd: ReturnType<typeof command>) => ({
    command: cmd, signingBytes: "AAAA",
    draft: { action: cmd.action, engine_id: "athena-1", nonce: "n", issued_at: cmd.issuedAt, expires_at: cmd.expiresAt, reason: "r" },
  });

  /** What each screen was last read as: the chains, a running scan, and the failsafe console. */
  const seed = (): Array<[unknown[], unknown]> => [
    [["/api/assurance/status"], STATUS],
    [["/api/assurance/deployments"], DEPLOYMENTS],
    [[CHAINS_ROUTE(DEP)], answered.chains],
    [["/api/engine/status"], { configured: true, reachable: true, authorized: true, url: "http://engine.test", detail: "" }],
    [["/api/clients"], [{ id: "c1", name: "Fleet", company: "Fleet", email: "f@f.test", status: "active" }]],
    [["/api/sites"], [{ id: "s1", clientId: "c1", name: "Console", url: "https://fleet.example" }]],
    [["/api/tests"], [RUNNING]],
    [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
    [["/api/auth/check"], { authenticated: true, user: null }],
    [["/api/failsafe/status"], { configured: true, reachable: true, authorized: true, url: "http://cp", detail: "", defaultEngineId: "athena-1" }],
    [[...failsafeStateKey("athena-1")], { engineId: "athena-1", engineState: "running", engineStateAvailable: true, awaitingSignatures: [command()], ready: [], recent: [] }],
    [["/api/failsafe/audit"], []],
    [["/api/failsafe/commands", "cmd-sd"], drafted(command())],
  ];

  type Mode = "hangs" | "fails" | "answers a number" | "answers a list" | "answers outcomes that are not a list";
  const NONSENSE: Partial<Record<Mode, unknown>> = {
    "answers a number": 7, "answers a list": ["outcome 1", null], "answers outcomes that are not a list": { outcomes: "sixteen of them" },
  };
  /** What the observed effects' own section says for each: reading, could not read, or an answer it cannot read. */
  const SAID: Record<Mode, string> = {
    hangs: "read-loading", fails: "read-error",
    "answers a number": "effects-answer-unreadable", "answers a list": "effects-answer-unreadable",
    "answers outcomes that are not a list": "effects-answer-unreadable",
  };

  /** The chains screen, a running scan's row and the failsafe console under one cache; the observed-effects read does what `mode` says. */
  function mount(mode: Mode) {
    const state = { effectReads: 0, effectSettled: 0 };
    const data = new Map(seed().map(([key, value]) => [JSON.stringify(key), value]));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey, signal }) => {
          if (String(queryKey[0]).includes("/chain-outcomes")) {
            state.effectReads += 1;
            if (mode === "hangs") {
              return new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => { state.effectSettled += 1; reject(new DOMException("aborted", "AbortError")); });
              });
            }
            state.effectSettled += 1;
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
      const body = String(url).includes("/api/failsafe/commands") ? drafted(command({ uuid: "new" })) : { stopped: true, runId: "run-9" };
      return new Response(JSON.stringify(body), { status: String(url).includes("/api/failsafe/commands") ? 201 : 200, headers: { "Content-Type": "application/json" } });
    }));
    render(
      <QueryClientProvider client={client}>
        <div data-testid="screen-chains">{chainsScreen()}</div>
        <div data-testid="screen-tests"><Tests /></div>
        <div data-testid="screen-failsafe"><Failsafe /></div>
      </QueryClientProvider>,
    );
    return { state, posts };
  }
  const button = (id: string) => screen.getByTestId(id) as HTMLButtonElement;
  const settledOnItsSection = async (mode: Mode) =>
    waitFor(() => expect(within(effectsSection()).getByTestId(SAID[mode])).toBeTruthy());

  for (const mode of ["hangs", "fails", "answers a number", "answers a list", "answers outcomes that are not a list"] as const) {
    it(`while the observed-effects read ${mode}: a running scan's Stop is enabled and asks the abort route at once`, async () => {
      const { state, posts } = mount(mode);
      await settledOnItsSection(mode);
      expect(state.effectReads).toBe(1);
      expect(button("button-stop-t-run").disabled).toBe(false);
      fireEvent.click(button("button-stop-t-run"));
      await waitFor(() => expect(posts).toEqual(["POST /api/scans/t-run/abort"]));
      // A hung read is hanging still: the Stop went without it.
      if (mode === "hangs") expect(state.effectSettled).toBe(0);
    });

    it(`while the observed-effects read ${mode}: the failsafe panel's pause, stand-down and terminate are enabled, and a stand-down is drafted`, async () => {
      const { state, posts } = mount(mode);
      await settledOnItsSection(mode);
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
      if (mode === "hangs") expect(state.effectSettled).toBe(0);
    });

    it(`while the observed-effects read ${mode}: the chains stay drawn, and what became of the read is said in its own section and nowhere else`, async () => {
      mount(mode);
      await settledOnItsSection(mode);
      expect(document.querySelectorAll("[data-chain]").length).toBe(CHAIN_COUNT);
      expect(screen.getByTestId("effect-proof-held-back")).toBeTruthy();
      // Said once, inside the observed effects' section; the other screens say nothing of it and show no error of their own.
      expect(screen.getAllByTestId(SAID[mode])).toHaveLength(1);
      for (const other of ["screen-tests", "screen-failsafe"]) {
        expect(screen.getByTestId(other).textContent, other).not.toMatch(/observed effect|could not read|Could not read|could not be read/i);
      }
      // Nothing of a nonsense answer is drawn as a record, and none of it as no effect.
      expect(within(effectsSection()).queryAllByTestId("observed-effect")).toEqual([]);
      expect(within(effectsSection()).queryByTestId("no-observed-effects")).toBeNull();
      expect(screen.getByTestId("screen-tests").querySelector('[data-testid="button-stop-t-run"]')).not.toBeNull();
    });
  }
});

describe("the observed effects' view holds no stop and no write, and no stop control reads it", () => {
  const ROOT = path.resolve(__dirname, "..");
  const source = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
  /** The module specifiers a file imports. */
  const imports = (file: string) => Array.from(source(file).matchAll(/from\s+"([^"]+)"/g)).map((match) => match[1]);

  it("the view and the chains screen send nothing: no mutation, no request of their own, only the cache's reads", () => {
    for (const file of ["client/src/components/authority/ObservedEffects.tsx", "client/src/components/authority/AuthorityChains.tsx"]) {
      const code = source(file);
      for (const sends of ["useMutation", "apiRequest", "apiFetch", "fetch(", "XMLHttpRequest", "sendBeacon", "setQueryData", "invalidateQueries"]) {
        expect(code.includes(sends), `${file} uses ${sends}`).toBe(false);
      }
      // No read opts out of being cancelled when its view is left.
      expect(code.includes("cancelWhenLeft"), file).toBe(false);
    }
    // One read in the view, and one in the chains screen: never one per record or per chain.
    expect(source("client/src/components/authority/ObservedEffects.tsx").match(/useQuery</g) ?? []).toHaveLength(1);
    expect(source("client/src/components/authority/AuthorityChains.tsx").match(/useQuery</g) ?? []).toHaveLength(1);
  });

  it("no screen that holds a Stop imports the observed effects' view, the chains screen or the observed effect's shapes", () => {
    const holdsAStop = [
      "client/src/pages/Failsafe.tsx", "client/src/pages/AIControlPanel.tsx", "client/src/pages/Tests.tsx", "client/src/pages/AthenaScan.tsx",
      "client/src/pages/PentestScan.tsx", "client/src/components/RunningScans.tsx", "client/src/components/NoStopPanel.tsx",
      "client/src/components/RetestPanel.tsx", "client/src/components/AppShell.tsx",
      // What the failsafe console draws its unread rows with: shared with the authority screens, and it reads no observed effect.
      "client/src/components/authority/parts.tsx",
    ];
    for (const file of holdsAStop) {
      expect(imports(file).filter((one) => /ObservedEffects|AuthorityChains|observed-effect/.test(one)), file).toEqual([]);
    }
    // And the view imports nothing a stop is sent with.
    expect(imports("client/src/components/authority/ObservedEffects.tsx").sort()).toEqual([
      "./parts", "@shared/observed-effect", "@tanstack/react-query", "lucide-react", "react",
    ]);
  });
});
