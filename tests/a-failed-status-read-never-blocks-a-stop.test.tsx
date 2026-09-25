// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider, type Query } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";

import Failsafe, { failsafeStateKey } from "@/pages/Failsafe";
// The engine state is seeded under the page's own key. This file's queryFn
// answers any key it was seeded with, so it cannot tell whether that key
// reaches a route: the state key used to become a URL the server does not
// serve, and every test here passed. That is pinned where the real queryFn
// runs: tests/every-page-query-key-reaches-a-route.test.ts.
import AIControlPanel from "@/pages/AIControlPanel";
import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";

/**
 * PR #52 round 3, F1. A stop -- pause, stand-down, terminate -- is never
 * blocked by a failed or stale status read. The status route is a probe; the
 * draft route (POST /api/failsafe/commands), the signature route and the
 * engine's own signature check are the authority, and each says when it
 * refuses.
 *
 * Since 844a996 one failed 30-second status poll disabled every Draft
 * control, killed the open confirmation's confirm button, and hid the
 * in-flight stand-down a second operator had to open to sign -- and it stayed
 * that way after the backend recovered, until the next 30s poll. Round 2's
 * display rule stands: the failed status is SAID, and nothing read under it is
 * shown as current. Only the controls stopped depending on it.
 *
 * Adapted from the adversarial reproducer r3-failsafe-standdown-blocked.test.tsx.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

let failing = new Set<string>();
const STATUS = { configured: true, reachable: true, authorized: true, url: "http://cp", detail: "", defaultEngineId: "athena-1" };
const command = (over: Record<string, unknown>) => ({
  uuid: "cmd-sd", action: "stand_down", engineId: "athena-1", status: "awaiting_signatures", nonce: "n", reason: "r",
  issuedAt: new Date().toISOString(), signers: ["alice"], requiredSignatures: 2,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: null, updatedAt: null, ...over,
});
const standDown = command({});
const drafted = (cmd: ReturnType<typeof command>) => ({
  command: cmd, signingBytes: "AAAA",
  draft: { action: cmd.action, engine_id: "athena-1", nonce: "n", issued_at: cmd.issuedAt, expires_at: cmd.expiresAt, reason: "r" },
});

function mount(seed: Array<[unknown[], unknown]> = [
  [["/api/failsafe/status"], STATUS],
  [[...failsafeStateKey("athena-1")], {
    engineId: "athena-1", engineState: "running", engineStateAvailable: true,
    awaitingSignatures: [standDown], ready: [], recent: [],
  }],
  [["/api/failsafe/audit"], []],
  [["/api/failsafe/commands", "cmd-sd"], drafted(standDown)],
]) {
  failing = new Set();
  const data = new Map(seed.map(([k, v]) => [JSON.stringify(k), v]));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
      queryFn: async ({ queryKey }) => {
        if (failing.has(String(queryKey[0]))) throw new Error("Failed to fetch");
        const v = data.get(JSON.stringify(queryKey));
        if (v === undefined) throw new Error(`unexpected ${JSON.stringify(queryKey)}`);
        return v;
      } } },
  });
  for (const [k, v] of seed) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}><Failsafe /></QueryClientProvider>);
  return client;
}
const btn = (id: string) => screen.getByTestId(id) as HTMLButtonElement;
const text = () => document.body.textContent ?? "";
const governor = () => screen.getByText("Engine governor").parentElement?.textContent ?? "";

/** The next read of `path` fails, and every query on it has settled as failed. */
async function nextReadFails(client: QueryClient, path: string, key: unknown[] = [path]) {
  failing.add(path);
  await act(async () => { await client.refetchQueries({ queryKey: [path] }); });
  await waitFor(() => expect(client.getQueryState(key)?.status).toBe("error"));
}

/** POST /api/failsafe/commands answers 201, as a working draft route does. */
function draftRouteWorks(posts: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posts.push(String(url));
    return new Response(JSON.stringify(drafted(command({ uuid: "new" }))), {
      status: 201, headers: { "Content-Type": "application/json" },
    });
  }));
}

describe("a failed failsafe status read never blocks a stop", () => {
  it("keeps Draft pause / stand-down / terminate live, says the status is unread, and re-reads it within seconds", async () => {
    const client = mount();
    expect(btn("button-draft-stand_down").disabled).toBe(false);

    await nextReadFails(client, "/api/failsafe/status");
    // Said, not hidden -- and nothing read under the failed status is current.
    expect(text()).toMatch(/Could not read the failsafe status: Failed to fetch/);
    expect(screen.getByTestId("text-stops-stay-live").textContent).toMatch(/Pause, stand-down and terminate stay available/);
    expect(governor()).not.toMatch(/running/);
    for (const action of ["pause", "stand_down", "terminate"]) {
      expect(btn(`button-draft-${action}`).disabled, `${action} must stay operable`).toBe(false);
    }
    // Re-read within seconds, not left for the next 30-second poll.
    const q = client.getQueryCache().find({ queryKey: ["/api/failsafe/status"] }) as Query;
    const interval = (q.options as { refetchInterval?: unknown }).refetchInterval;
    const next = typeof interval === "function" ? (interval as (one: Query) => number | false)(q) : interval;
    expect(q.state.status).toBe("error");
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThanOrEqual(5_000);
  });

  it("drafts the stand-down through the draft route, which is the check", async () => {
    const posts: string[] = [];
    draftRouteWorks(posts);
    const client = mount();
    await nextReadFails(client, "/api/failsafe/status");
    fireEvent.click(btn("button-draft-stand_down"));
    fireEvent.change(screen.getByTestId("input-reason"), { target: { value: "going wrong" } });
    fireEvent.click(btn("button-confirm-draft"));
    await waitFor(() => expect(posts).toContain("/api/failsafe/commands"));
  });

  it("an armed confirmation for a stand-down stays live through a failed status poll", async () => {
    const client = mount();
    fireEvent.click(btn("button-draft-stand_down"));
    expect(btn("button-confirm-draft").disabled).toBe(false);
    await nextReadFails(client, "/api/failsafe/status");
    expect(btn("button-confirm-draft").disabled, "confirm stand-down must stay operable").toBe(false);
  });

  it("the stand-down awaiting a second signature stays reachable, and its console can still be signed", async () => {
    const client = mount();
    expect(screen.getByTestId("button-open-cmd-sd")).toBeTruthy();
    await nextReadFails(client, "/api/failsafe/status");
    // Listed as last read, never as a current reading.
    expect(screen.getByTestId("inflight-last-read-cmd-sd").textContent).toMatch(/Last read as awaiting signatures\. Not a current reading\./);
    expect(text()).not.toMatch(/1\/2 signed/);
    fireEvent.click(screen.getByTestId("button-open-cmd-sd"));
    await waitFor(() => expect(screen.getByTestId("button-submit-signature")).toBeTruthy());
  });

  it("keeps the stops live when the status has never answered: the engine can still be named", async () => {
    const client = mount([
      [[...failsafeStateKey("athena-2")], {
        engineId: "athena-2", engineState: "running", engineStateAvailable: true,
        awaitingSignatures: [command({ uuid: "cmd-2", engineId: "athena-2" })], ready: [], recent: [],
      }],
      [["/api/failsafe/audit"], []],
    ]);
    await waitFor(() => expect(client.getQueryState(["/api/failsafe/status"])?.status).toBe("error"));
    // Nothing cached: the state below is there only if the page reads it.
    client.removeQueries({ queryKey: ["/api/failsafe/state"] });
    expect((screen.getByTestId("input-engine-id") as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(screen.getByTestId("input-engine-id"), { target: { value: "athena-2" } });
    // The state is still read, so the stand-down awaiting a second operator
    // is reachable although no status has ever answered.
    await waitFor(() => expect(screen.getByTestId("button-open-cmd-2")).toBeTruthy());
    for (const action of ["pause", "stand_down", "terminate"]) {
      expect(btn(`button-draft-${action}`).disabled, action).toBe(false);
    }
    // Putting an engine back to work waits for a status that said it may.
    for (const action of ["resume", "release"]) {
      expect(btn(`button-draft-${action}`).disabled, action).toBe(true);
    }
  });

  it("a stop is not held back by a status that answered 'not ready' either; resume and release are", () => {
    mount([
      [["/api/failsafe/status"], { ...STATUS, authorized: false, detail: "the control plane refused this key" }],
      [["/api/failsafe/audit"], []],
    ]);
    expect(text()).toMatch(/the control plane refused this key/);
    for (const action of ["pause", "stand_down", "terminate"]) {
      expect(btn(`button-draft-${action}`).disabled, action).toBe(false);
    }
    for (const action of ["resume", "release"]) {
      expect(btn(`button-draft-${action}`).disabled, action).toBe(true);
    }
  });

  it("a stop's console keeps signing live when its own re-read fails, showing no stale signers", async () => {
    const client = mount();
    fireEvent.click(screen.getByTestId("button-open-cmd-sd"));
    await waitFor(() => expect(text()).toMatch(/1 of 2 operator signatures/));
    await nextReadFails(client, "/api/failsafe/commands", ["/api/failsafe/commands", "cmd-sd"]);
    expect(screen.getByTestId("text-command-unread").textContent).toMatch(/Could not read this command from the control plane: Failed to fetch/);
    expect(screen.getByTestId("text-command-unread").textContent).toMatch(/It is a stop, so signing and relaying stay available/);
    expect(text()).not.toMatch(/1 of 2 operator signatures/);
    expect(screen.getByTestId("button-submit-signature")).toBeTruthy();
    expect(screen.queryByTestId("button-cancel-command")).toBeNull();
  });

  it("a resume's console does not: putting an engine back to work waits for a current read", async () => {
    const resume = command({ uuid: "cmd-rs", action: "resume", requiredSignatures: 1, signers: [] });
    const client = mount([
      [["/api/failsafe/status"], STATUS],
      [[...failsafeStateKey("athena-1")], {
        engineId: "athena-1", engineState: "paused", engineStateAvailable: true,
        awaitingSignatures: [resume], ready: [], recent: [],
      }],
      [["/api/failsafe/audit"], []],
      [["/api/failsafe/commands", "cmd-rs"], drafted(resume)],
    ]);
    fireEvent.click(screen.getByTestId("button-open-cmd-rs"));
    await waitFor(() => expect(screen.getByTestId("button-submit-signature")).toBeTruthy());
    await nextReadFails(client, "/api/failsafe/commands", ["/api/failsafe/commands", "cmd-rs"]);
    expect(screen.getByTestId("text-command-unread")).toBeTruthy();
    expect(screen.queryByTestId("button-submit-signature")).toBeNull();
  });
});

/**
 * The same rule on the other two stops. Both already held when a read FAILED
 * (the round-2 suite pins that); neither held while a read had simply not
 * answered: the AI Control page drew a full-page spinner, kill switch and
 * all, until its settings arrived, and a scan's Stop appeared only once the
 * first read of the scan came back. A read that hangs is a read that fails
 * without saying so.
 */
describe("the other stops are not held back by a read that has not answered", () => {
  function mountHanging(ui: React.ReactElement, seed: Array<[unknown[], unknown]>, hang: string[]) {
    const data = new Map(seed.map(([k, v]) => [JSON.stringify(k), v]));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: ({ queryKey }) => {
          if (hang.includes(String(queryKey[0]))) return new Promise(() => {});
          const v = data.get(JSON.stringify(queryKey));
          return v === undefined ? Promise.reject(new Error(`unexpected ${JSON.stringify(queryKey)}`)) : Promise.resolve(v);
        } } },
    });
    for (const [k, v] of seed) client.setQueryData(k, v);
    render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
    return client;
  }

  it("the AI Control kill switch is on screen, and says its state is unread, while the settings load", () => {
    mountHanging(<AIControlPanel />, [], ["/api/ai-control"]);
    expect(screen.getByTestId("button-kill-switch")).toBeTruthy();
    expect(screen.getByTestId("text-kill-switch-unknown").textContent).toMatch(
      /Kill switch state not read yet: the settings are still loading\. Activating it still sends the shutdown\./,
    );
  });

  for (const [name, Page] of [["Athena", AthenaScan], ["Penetration testing", PentestScan]] as const) {
    it(`${name}: a started scan's Stop is on screen before the first read of it answers`, async () => {
      mountHanging(<Page />, [
        [["/api/engine/status"], { configured: true, reachable: true, authorized: true, url: "http://engine.test", detail: "" }],
        [["/api/clients"], [{ id: "c1", name: "Acme" }]],
        [["/api/sites"], []],
        [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
        [["/api/auth/check"], { authenticated: true, user: null }],
      ], ["/api/scans/t1"]);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        JSON.stringify({ test: { id: "t1" }, runId: "run-1", state: "running" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      )));
      fireEvent.change(document.querySelectorAll("select")[0], { target: { value: "c1" } });
      fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://acme.test" } });
      expect(screen.queryByTestId("button-stop-scan")).toBeNull();
      fireEvent.click(screen.getByTestId("button-start-scan"));
      await waitFor(() => expect(screen.getByTestId("button-stop-scan")).toBeTruthy());
      expect(screen.queryByTestId("text-state")).toBeNull();
    });

    it(`${name}: a scan the engine finished inline offers no Stop`, async () => {
      mountHanging(<Page />, [
        [["/api/engine/status"], { configured: true, reachable: true, authorized: true, url: "http://engine.test", detail: "" }],
        [["/api/clients"], [{ id: "c1", name: "Acme" }]],
        [["/api/sites"], []],
        [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
        [["/api/auth/check"], { authenticated: true, user: null }],
      ], ["/api/scans/t1"]);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        JSON.stringify({ test: { id: "t1" }, runId: "run-1", state: "completed" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      )));
      fireEvent.change(document.querySelectorAll("select")[0], { target: { value: "c1" } });
      fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://acme.test" } });
      fireEvent.click(screen.getByTestId("button-start-scan"));
      await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
      expect(screen.queryByTestId("button-stop-scan")).toBeNull();
    });
  }
});
