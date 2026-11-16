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
import { BACKEND_PATH, BACKUP, DEP, EVIDENCE_2, REASON, ROUTE_PATH, SERVED_FINDING, declareStandIn, servedBefore } from "./helpers/scope-declarations";
import { BACKEND, FINDING, ROUTE, SCOPE, servedPage } from "./helpers/incident-scopes";

/**
 * SAFETY (DASH-DECLARE): declaring an incident's scope from the recovery screen is on no
 * stop's path. The Stop control and the failsafe panel never wait on the form, on the
 * read its pickers come from, or on its post; and a read or a post that hangs, fails or
 * answers nonsense never delays or disables them.
 *
 *   - Nothing is read for the form until it is opened. One incident's form is open at a
 *     time: opening another closes the first and cancels its read; closing it, or leaving
 *     the screen, cancels it too. So the form's reads never keep more than ONE of the
 *     browser's six connections (tests/a-stop-goes-while-a-scope-declaration-hangs.test.ts
 *     sends a stop through the six with that one, and a declaration, held).
 *   - One declaration is in flight in the whole console at a time: while one hangs, no
 *     other form can send.
 *   - With the read or the post hung, failed or answered with nonsense: a running scan's
 *     Stop is enabled and asks the abort route at once; the failsafe panel's pause,
 *     stand-down and terminate are enabled and a stand-down is drafted.
 *   - No modal stands over the page: nothing makes the rest of it inert while the form
 *     is open or its post is in flight.
 *   - The form sends nothing but its own declaration, and no screen that holds a Stop
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

/** What this console's routes answer over a stand-in backend: two incidents whose scope is reported, and the choices of one. */
const answered: { page: RecoveryRecords | null; choices: Record<string, unknown> } = { page: null, choices: {} };
const OTHER = FINDING.widened;

beforeAll(async () => {
  const stand = await declareStandIn();
  try {
    // The page with a second incident beside the one declared for, so a second form can be opened.
    const before = stand.seen.length;
    stand.serve({
      ...servedBefore(),
      [BACKEND_PATH.page]: servedPage(["declared", "widened"]),
      [`/api/assurance/findings/${FINDING.widened}/`]: { ...SERVED_FINDING, uuid: FINDING.widened },
      [BACKEND.scope("widened")]: SCOPE.widened,
    });
    const page = await stand.admin.get(`${ROUTE_PATH.page}?offset=0`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    answered.page = page.body;
    for (const finding of [FINDING.declared, FINDING.widened]) {
      const choices = await stand.admin.get(`/api/assurance/findings/${finding}/scope-choices`);
      expect(choices.status, JSON.stringify(choices.body)).toBe(200);
      answered.choices[finding] = choices.body;
    }
    expect(ROUTE_PATH.choices).toBe(`/api/assurance/findings/${FINDING.declared}/scope-choices`);
    expect(stand.seen.length).toBeGreaterThan(before);
  } finally {
    await stand.close();
  }
}, 120_000);

const ADMIN = { authenticated: true, user: { id: "u-1", username: "admin", role: "admin", email: "admin@tenant.test", mustChangePassword: false } };
const STATUS = { configured: true, reachable: true, authorized: true, url: "https://backend.invalid", detail: "ok" };
const DEPLOYMENTS = [{ uuid: DEP, name: "harbor-desk", environment: "production", decision: "audit_incomplete", decisionLabel: "Audit incomplete" }];
const PAGE_URL = `${ROUTE.page}?offset=0`;
const CHOICES_OF = (finding: string) => `/api/assurance/findings/${finding}/scope-choices`;

const card = (finding: string) => document.querySelector(`[data-testid="incident"][data-incident="${finding}"]`) as HTMLElement;
const toggle = (finding: string) => within(card(finding)).getByTestId("incident-scope-declare-toggle");
const formOf = (finding: string) => within(card(finding)).getByTestId("incident-scope-declare");

function recoveryScreen() {
  const location = memoryLocation({ path: `/authority/recovery?deployment=${DEP}`, record: true });
  return (
    <Router hook={location.hook} searchHook={location.searchHook}>
      <Authority params={{ screen: "recovery" }} />
    </Router>
  );
}

describe("at most one of the form's reads is in flight, and it is cancelled when closed or left", () => {
  interface Read { url: string; signal: AbortSignal | undefined }

  /** The app's own query function over a fetch that answers the screen and never answers the form's read. */
  function mountWithChoicesStalled() {
    const reads: Read[] = [];
    const answers: Record<string, unknown> = {
      "/api/assurance/status": STATUS, "/api/assurance/deployments": DEPLOYMENTS, "/api/auth/check": ADMIN, [PAGE_URL]: answered.page,
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
    const view = render(<QueryClientProvider client={client}>{recoveryScreen()}</QueryClientProvider>);
    const choiceReads = () => reads.filter((one) => one.url.includes("/scope-choices"));
    return { view, choiceReads, inFlight: () => choiceReads().filter((one) => one.signal?.aborted !== true) };
  }

  it("reads nothing for the form until it is opened, and draws the record without it", async () => {
    const { choiceReads } = mountWithChoicesStalled();
    await waitFor(() => expect(document.querySelectorAll('[data-testid="incident-scope-declare-toggle"]').length).toBe(2));
    expect(choiceReads()).toEqual([]);
    expect(within(card(OTHER)).getByTestId("step-scope-widened")).toBeTruthy();
  });

  it("opening another incident's form closes the first and cancels its read: one in flight, never two", async () => {
    const { choiceReads, inFlight } = mountWithChoicesStalled();
    await waitFor(() => expect(document.querySelectorAll('[data-testid="incident-scope-declare-toggle"]').length).toBe(2));
    fireEvent.click(toggle(FINDING.declared));
    await waitFor(() => expect(choiceReads().map((one) => one.url)).toEqual([CHOICES_OF(FINDING.declared)]));
    const first = choiceReads()[0];
    expect(first.signal, "the form's read carries a signal, so it can be cancelled").toBeDefined();
    expect(within(formOf(FINDING.declared)).getByTestId("read-loading").textContent).toBe("Reading what this incident's scope can be declared from…");
    fireEvent.click(toggle(OTHER));
    await waitFor(() => expect(inFlight().map((one) => one.url)).toEqual([CHOICES_OF(OTHER)]));
    expect(first.signal!.aborted).toBe(true);
    expect(document.querySelectorAll('[data-testid="incident-scope-declare"][data-open="true"]')).toHaveLength(1);
    expect(formOf(FINDING.declared).getAttribute("data-open")).toBe("false");
  });

  it("closing the form cancels its read, and so does leaving the screen", async () => {
    const { view, choiceReads, inFlight } = mountWithChoicesStalled();
    await waitFor(() => expect(document.querySelectorAll('[data-testid="incident-scope-declare-toggle"]').length).toBe(2));
    fireEvent.click(toggle(FINDING.declared));
    await waitFor(() => expect(inFlight()).toHaveLength(1));
    fireEvent.click(toggle(FINDING.declared));
    await waitFor(() => expect(inFlight()).toEqual([]));
    fireEvent.click(toggle(FINDING.declared));
    await waitFor(() => expect(inFlight()).toHaveLength(1));
    view.unmount();
    await waitFor(() => expect(inFlight()).toEqual([]));
    expect(choiceReads().every((one) => one.signal?.aborted === true)).toBe(true);
  });
});

describe("a read or a post of the form that hangs, fails or answers nonsense never delays or disables a stop control", () => {
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
    [["/api/auth/check"], ADMIN],
    [["/api/failsafe/status"], { configured: true, reachable: true, authorized: true, url: "http://cp", detail: "", defaultEngineId: "athena-1" }],
    [[...failsafeStateKey("athena-1")], { engineId: "athena-1", engineState: "running", engineStateAvailable: true, awaitingSignatures: [command()], ready: [], recent: [] }],
    [["/api/failsafe/audit"], []],
    [["/api/failsafe/commands", "cmd-sd"], drafted(command())],
  ];

  type Mode =
    | "read hangs" | "read fails" | "read answers a number" | "read answers a list" | "read answers lists that are not lists"
    | "post hangs" | "post fails" | "post answers a page that is not JSON" | "post answers 200 with nonsense" | "post answers later";
  const READS: Partial<Record<Mode, unknown>> = {
    "read answers a number": 7, "read answers a list": ["an asset", null], "read answers lists that are not lists": { assets: "three", workflows: 2, evidence: null },
  };
  /** What the form's own panel says for each: reading, could not read, an answer it cannot read, or the post's outcome. */
  const SAID: Record<Mode, string> = {
    "read hangs": "read-loading", "read fails": "read-error", "read answers a number": "declare-scope-answer-unreadable",
    "read answers a list": "declare-scope-answer-unreadable", "read answers lists that are not lists": "declare-scope-answer-unreadable",
    "post hangs": "declare-scope-send", "post fails": "declare-scope-said", "post answers a page that is not JSON": "declare-scope-said",
    "post answers 200 with nonsense": "declare-scope-said", "post answers later": "declare-scope-send",
  };

  /** The recovery screen, a running scan's row and the failsafe console under one cache; the form's read and post do what `mode` says. */
  function mount(mode: Mode) {
    const state = { choiceReads: 0, choicesSettled: 0, declarations: 0, declarationsSettled: 0, release: () => undefined as void };
    const data = new Map(seed().map(([key, value]) => [JSON.stringify(key), value]));
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false, staleTime: Infinity, gcTime: Infinity,
          queryFn: async ({ queryKey, signal }) => {
            if (String(queryKey[0]).includes("/scope-choices")) {
              state.choiceReads += 1;
              if (mode === "read hangs") {
                return new Promise((_resolve, reject) => {
                  signal.addEventListener("abort", () => { state.choicesSettled += 1; reject(new DOMException("aborted", "AbortError")); });
                });
              }
              state.choicesSettled += 1;
              if (mode === "read fails") throw new Error("the Athena control plane answered 500");
              const finding = FINDING.declared === String(queryKey[0]).split("/")[4] ? FINDING.declared : OTHER;
              return mode in READS ? READS[mode] : answered.choices[finding];
            }
            const value = data.get(JSON.stringify(queryKey));
            if (value === undefined) throw new Error(`unseeded ${JSON.stringify(queryKey)}`);
            return value;
          },
        },
      },
    });
    for (const [key, value] of seed()) client.setQueryData(key, value);
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      posts.push(`${init?.method ?? "GET"} ${url}`);
      if (String(url).includes("/declare-scope")) {
        state.declarations += 1;
        if (mode === "post hangs") return new Promise<Response>(() => undefined);
        if (mode === "post answers later") {
          return new Promise<Response>((resolve) => {
            state.release = () => {
              state.declarationsSettled += 1;
              resolve(new Response(JSON.stringify({ recorded: true }), { status: 201, headers: { "Content-Type": "application/json" } }));
            };
          });
        }
        state.declarationsSettled += 1;
        if (mode === "post fails") return new Response(JSON.stringify({ error: "x" }), { status: 500, headers: { "Content-Type": "application/json" } });
        if (mode === "post answers a page that is not JSON") return new Response("<html>gateway error</html>", { status: 502, headers: { "Content-Type": "text/html" } });
        return new Response("<html>nonsense</html>", { status: 200, headers: { "Content-Type": "text/html" } });
      }
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

  /** Open the form on the declared incident and, for a post mode, send a widening. */
  async function drive(mode: Mode) {
    await waitFor(() => expect(within(card(FINDING.declared)).getByTestId("incident-scope-declare-toggle")).toBeTruthy());
    fireEvent.click(toggle(FINDING.declared));
    const panel = formOf(FINDING.declared);
    if (mode.startsWith("post")) {
      await waitFor(() => expect(within(panel).getByTestId("declare-scope-form")).toBeTruthy());
      const pick = (testId: string, attribute: string, value: string) =>
        fireEvent.click(within(panel).getAllByTestId(testId).find((one) => one.getAttribute(attribute) === value)!);
      pick("declare-item", "data-item-ref", BACKUP);
      pick("declare-evidence-item", "data-evidence-ref", EVIDENCE_2);
      fireEvent.change(within(panel).getByTestId("declare-reason"), { target: { value: REASON } });
      fireEvent.click(within(panel).getByTestId("declare-scope-review"));
      fireEvent.click(within(panel).getByTestId("declare-scope-send"));
    }
    await waitFor(() => expect(within(card(FINDING.declared)).getByTestId(SAID[mode])).toBeTruthy());
  }

  /** Nothing over the page: no modal, nothing made inert, and the stop screens not hidden from a person. */
  function nothingCoversThePage() {
    expect(document.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="alertdialog"]').length).toBe(0);
    expect(document.body.style.pointerEvents).not.toBe("none");
    for (const id of ["screen-tests", "screen-failsafe"]) {
      expect(screen.getByTestId(id).closest("[aria-hidden='true'], [inert]"), id).toBeNull();
    }
  }

  const MODES: Mode[] = [
    "read hangs", "read fails", "read answers a number", "read answers a list", "read answers lists that are not lists",
    "post hangs", "post fails", "post answers a page that is not JSON", "post answers 200 with nonsense",
  ];
  for (const mode of MODES) {
    it(`while the form's ${mode}: a running scan's Stop is enabled and asks the abort route at once`, async () => {
      const { state, posts } = mount(mode);
      await drive(mode);
      // One read for the form; and after a post whose outcome is not known, one more, made once that post had its answer.
      await waitFor(() => expect(state.choiceReads).toBe(mode.startsWith("post") && mode !== "post hangs" ? 2 : 1));
      expect(state.declarations).toBe(mode.startsWith("post") ? 1 : 0);
      nothingCoversThePage();
      expect(button("button-stop-t-run").disabled).toBe(false);
      const before = posts.length;
      fireEvent.click(button("button-stop-t-run"));
      await waitFor(() => expect(posts.slice(before)).toEqual(["POST /api/scans/t-run/abort"]));
      // A hung read or post is hanging still: the Stop went without it.
      if (mode === "read hangs") expect(state.choicesSettled).toBe(0);
      if (mode === "post hangs") expect(state.declarationsSettled).toBe(0);
    });

    it(`while the form's ${mode}: the failsafe panel's pause, stand-down and terminate are enabled, and a stand-down is drafted`, async () => {
      const { state, posts } = mount(mode);
      await drive(mode);
      nothingCoversThePage();
      for (const action of ["pause", "stand_down", "terminate"]) {
        expect(button(`button-draft-${action}`).disabled, `${action} must stay operable`).toBe(false);
      }
      expect(screen.getByTestId("button-open-cmd-sd")).toBeTruthy();
      fireEvent.click(button("button-draft-stand_down"));
      fireEvent.change(screen.getByTestId("input-reason"), { target: { value: "going wrong" } });
      expect(button("button-confirm-draft").disabled).toBe(false);
      fireEvent.click(button("button-confirm-draft"));
      await waitFor(() => expect(posts).toContain("POST /api/failsafe/commands"));
      if (mode === "read hangs") expect(state.choicesSettled).toBe(0);
      if (mode === "post hangs") expect(state.declarationsSettled).toBe(0);
    });
  }

  it("while one declaration hangs, no other form can send: one is in flight in the whole console", async () => {
    const { state } = mount("post hangs");
    await drive("post hangs");
    expect(within(formOf(FINDING.declared)).getByTestId("declare-scope-send").textContent).toBe("Declaring revision 2...");
    // The other incident's form, opened and filled while the first one's post is held.
    fireEvent.click(toggle(OTHER));
    const other = formOf(OTHER);
    await waitFor(() => expect(within(other).getByTestId("declare-scope-form")).toBeTruthy());
    fireEvent.click(within(other).getAllByTestId("declare-item").find((one) => one.getAttribute("data-item-ref") === "payout")!);
    fireEvent.click(within(other).getAllByTestId("declare-evidence-item")[0]);
    fireEvent.change(within(other).getByTestId("declare-reason"), { target: { value: "the payout workflow ran on the same night" } });
    fireEvent.click(within(other).getByTestId("declare-scope-review"));
    const send = within(other).getByTestId("declare-scope-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(within(other).getByTestId("declare-scope-another")).toBeTruthy();
    fireEvent.click(send);
    expect(state.declarations).toBe(1);
    // And the first form, its post in flight, cannot be closed under it, nor changed.
    expect(formOf(FINDING.declared).getAttribute("data-open")).toBe("true");
    expect((within(formOf(FINDING.declared)).getByTestId("declare-reason") as HTMLInputElement).disabled).toBe(true);
    nothingCoversThePage();
    expect(button("button-stop-t-run").disabled).toBe(false);
  });

  it("a declaration that ends while another incident's form is open closes its own form only", async () => {
    const { state } = mount("post answers later");
    await drive("post answers later");
    fireEvent.click(toggle(OTHER));
    await waitFor(() => expect(within(formOf(OTHER)).getByTestId("declare-scope-form")).toBeTruthy());
    state.release();
    await waitFor(() => expect(within(card(FINDING.declared)).getByTestId("declare-scope-said").getAttribute("data-said")).toBe("recorded"));
    await waitFor(() => expect(formOf(FINDING.declared).getAttribute("data-open")).toBe("false"));
    expect(formOf(OTHER).getAttribute("data-open")).toBe("true");
    expect(within(formOf(OTHER)).getByTestId("declare-scope-form")).toBeTruthy();
  });
});

describe("the form sends nothing but its own declaration, and no stop control reads it", () => {
  const ROOT = path.resolve(__dirname, "..");
  const source = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
  const imports = (file: string) => Array.from(source(file).matchAll(/from\s+"([^"]+)"/g)).map((match) => match[1]);
  const FORM = "client/src/components/authority/DeclareScope.tsx";

  it("holds one write, its own declaration, under one key the whole console shares; and imports nothing a stop is sent with", () => {
    const code = source(FORM);
    expect(code.match(/useMutation\(/g) ?? []).toHaveLength(1);
    expect(code.match(/apiRequest\(/g) ?? []).toHaveLength(1);
    expect(code).toContain('apiRequest("POST", `/api/assurance/findings/${encodeURIComponent(finding)}/declare-scope`, body)');
    expect(code).toContain("mutationKey: DECLARE_SCOPE");
    for (const stop of ["/abort", "/failsafe", "ai-control", "killSwitch", "apiFetch", "fetch(", "XMLHttpRequest", "sendBeacon", "setQueryData", "cancelWhenLeft"]) {
      expect(code.includes(stop), `${FORM} names ${stop}`).toBe(false);
    }
    // No modal: nothing it draws can make the page under it inert.
    for (const modal of ["AlertDialog", "Dialog", "Sheet", "Drawer", "Popover", "aria-modal"]) {
      expect(code.includes(modal), `${FORM} uses ${modal}`).toBe(false);
    }
    expect(imports(FORM).sort()).toEqual([
      "./IncidentScope", "./history", "./parts", "@/lib/queryClient", "@/utils/auth", "@shared/incident-scope", "@shared/recovery-record",
      "@shared/schema", "@shared/scope-declaration", "@tanstack/react-query", "react",
    ]);
  });

  it("no screen that holds a Stop imports the form or its shapes", () => {
    const holdsAStop = [
      "client/src/pages/Failsafe.tsx", "client/src/pages/AIControlPanel.tsx", "client/src/pages/Tests.tsx", "client/src/pages/AthenaScan.tsx",
      "client/src/pages/PentestScan.tsx", "client/src/components/RunningScans.tsx", "client/src/components/NoStopPanel.tsx",
      "client/src/components/RetestPanel.tsx", "client/src/components/AppShell.tsx", "client/src/components/authority/parts.tsx",
    ];
    for (const file of holdsAStop) {
      expect(imports(file).filter((one) => /DeclareScope|scope-declaration/.test(one)), file).toEqual([]);
    }
  });
});
