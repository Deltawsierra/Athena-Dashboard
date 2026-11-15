// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

import Failsafe from "@/pages/Failsafe";
import { getQueryFn } from "@/lib/queryClient";

/**
 * SAFETY (DASH-FAILSAFE-ROWS), the console's half: a row of the failsafe state
 * or the audit trail the server could not read is said on the page, and never
 * read as none.
 *
 * The state's lists carry their count on the state (`unreadable`); the audit
 * trail's body stays an array -- so a console page loaded before the server was
 * updated still draws it -- and its count rides in the X-Athena-Unreadable-Rows
 * header, which the page's own query reads (lib/queryClient.ts). So:
 *
 *   - "Awaiting signatures" and "Ready for engine" never read as a bare 0
 *     while a row of their list could not be read: a stand-down awaiting its
 *     second signature may be that row.
 *   - "No commands awaiting signatures or waiting on the engine" is held back,
 *     and each list's unreadable rows are said in the in-flight section.
 *   - "No failsafe activity recorded yet" is held back, and the trail says how
 *     many rows could not be read.
 *   - Every good row is still drawn, and every stop still offered.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const STATUS = { configured: true, reachable: true, authorized: true, url: "http://cp", detail: "", defaultEngineId: "athena-1" };
const command = (uuid: string, action: string, status = "awaiting_signatures") => ({
  uuid, action, engineId: "athena-1", status, nonce: "n", reason: "r",
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  signers: ["alice"], requiredSignatures: 2, createdAt: null, updatedAt: null,
});
const event = (uuid: string) => ({ uuid, timestamp: new Date().toISOString(), event: "command_drafted", commandUuid: null, actor: "alice", detail: {} });

/** The page on a client that reads through the app's own query function, against a stubbed server. */
function mount(served: { state: unknown; audit: unknown[]; auditUnreadable?: unknown }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const ok = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...headers } });
    if (u.startsWith("/api/failsafe/status")) return ok(STATUS);
    if (u.startsWith("/api/failsafe/state")) return ok(served.state);
    if (u.startsWith("/api/failsafe/audit")) {
      return ok(served.audit, served.auditUnreadable === undefined ? {} : { "X-Athena-Unreadable-Rows": JSON.stringify(served.auditUnreadable) });
    }
    return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
  render(<QueryClientProvider client={client}><Failsafe /></QueryClientProvider>);
}

const text = () => document.body.textContent ?? "";
const tile = (label: string) => screen.getByText(label).closest("div")?.parentElement;
const figure = (label: string) => tile(label)?.querySelector(".athena-figure")?.textContent;
const unreadable = () => screen.queryAllByTestId("unreadable-rows").map((one) => [one.getAttribute("data-list"), one.getAttribute("data-count"), one.textContent]);

describe("the failsafe console says a row it could not read, and never reads its list as none", () => {
  it("rows of the state that could not be read: no bare 0, no 'none in flight', each list's count said, the good rows drawn", async () => {
    mount({
      state: {
        engineId: "athena-1", engineState: "running", engineStateAvailable: true,
        awaitingSignatures: [], ready: [command("pause-ready", "pause", "ready")], recent: [],
        unreadable: { awaitingSignatures: 1, ready: 2, recent: 3 },
      },
      audit: [event("e1")],
    });
    await waitFor(() => expect(screen.queryByTestId("button-open-pause-ready")).not.toBeNull());
    expect(figure("Awaiting signatures"), "a list with an unreadable row is never a bare 0").not.toBe("0");
    expect(tile("Awaiting signatures")?.textContent).toMatch(/1 row could not be read/);
    expect(tile("Ready for engine")?.textContent).toMatch(/2 rows could not be read/);
    expect(text()).not.toMatch(/No commands awaiting signatures or waiting on the engine/);
    // The in-flight lists' counts are said under "Commands in flight"; the history's (recent) is not, since the
    // page never draws that list (DASH-FAILSAFE-2).
    expect(unreadable()).toEqual([
      ["awaitingSignatures", "1", "1 row could not be read: awaiting signatures"],
      ["ready", "2", "2 rows could not be read: ready"],
    ]);
    // Every stop is still offered.
    for (const key of ["pause", "stand_down", "terminate"]) {
      expect((screen.getByTestId(`button-draft-${key}`) as HTMLButtonElement).disabled, key).toBe(false);
    }
  });

  it("a list of the state that was not a list: its count is unknown, never 0, and the list is said unread", async () => {
    mount({
      state: {
        engineId: "athena-1", engineState: "running", engineStateAvailable: true,
        awaitingSignatures: [], ready: [], recent: [], unreadable: { awaitingSignatures: "not a list" },
      },
      audit: [],
    });
    await waitFor(() => expect(text()).toMatch(/The list could not be read: awaiting signatures/));
    expect(figure("Awaiting signatures")).not.toBe("0");
    expect(text()).not.toMatch(/No commands awaiting signatures or waiting on the engine/);
  });

  it("rows of the audit trail that could not be read: counted under it, and never 'no activity'", async () => {
    mount({
      state: { engineId: "athena-1", engineState: "running", engineStateAvailable: true, awaitingSignatures: [], ready: [], recent: [] },
      audit: [],
      auditUnreadable: { events: 2 },
    });
    await waitFor(() => expect(text()).toMatch(/2 rows could not be read: failsafe activity/));
    expect(text()).not.toMatch(/No failsafe activity recorded yet/);
  });

  it("the good audit rows are drawn beside the count", async () => {
    mount({
      state: { engineId: "athena-1", engineState: "running", engineStateAvailable: true, awaitingSignatures: [], ready: [], recent: [] },
      audit: [event("e1")],
      auditUnreadable: { events: 1 },
    });
    await waitFor(() => expect(text()).toMatch(/command drafted/));
    expect(text()).toMatch(/1 row could not be read: failsafe activity/);
  });

  it("controls: a clean state and trail read as they did -- a 0, 'none in flight', 'no activity', and no count", async () => {
    mount({
      state: { engineId: "athena-1", engineState: "running", engineStateAvailable: true, awaitingSignatures: [], ready: [], recent: [] },
      audit: [],
    });
    await waitFor(() => expect(text()).toMatch(/No commands awaiting signatures or waiting on the engine/));
    await waitFor(() => expect(text()).toMatch(/No failsafe activity recorded yet/));
    expect(figure("Awaiting signatures")).toBe("0");
    expect(unreadable()).toEqual([]);
  });
});
