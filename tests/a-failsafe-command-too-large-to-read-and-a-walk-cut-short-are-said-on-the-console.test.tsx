// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

import Failsafe from "@/pages/Failsafe";
import { getQueryFn } from "@/lib/queryClient";

/**
 * SAFETY (DASH-FAILSAFE-PAGES), the console's half.
 *
 *   - A command the control plane passed over as too large for any page is
 *     said by its id ("a command too large to read"), counted with the rows
 *     that could not be read, and -- when it may be a stop -- said as one. The
 *     list is then never "none in flight", and its tiles read "n+".
 *   - A walk of the pages cut short (its page or time bound, a page that
 *     failed) says how far it read and why, beside the cut.
 *   - A walk that read every page to a last one saying no more is shown
 *     whole, exactly as a single whole page always was.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const STATUS = { configured: true, reachable: true, authorized: true, url: "http://cp", detail: "", defaultEngineId: "athena-1" };
const command = (uuid: string, action: string) => ({
  uuid, action, engineId: "athena-1", status: "awaiting_signatures", nonce: `nonce-${uuid}`, reason: "r",
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  signers: [], requiredSignatures: action === "pause" ? 1 : 2, createdAt: null, updatedAt: null,
});

function mount(state: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.startsWith("/api/failsafe/status")) return ok(STATUS);
    if (u.startsWith("/api/failsafe/state")) return ok(state);
    if (u.startsWith("/api/failsafe/audit")) return ok([]);
    return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
  render(<QueryClientProvider client={client}><Failsafe /></QueryClientProvider>);
}

const text = () => document.body.textContent ?? "";
const figure = (label: string) => screen.getAllByText(label)
  .map((one) => one.closest("div")?.parentElement?.querySelector(".athena-figure"))
  .find((one) => one !== null && one !== undefined)?.textContent;
const base = { engineId: "athena-1", engineState: "running", engineStateAvailable: true, ready: [], recent: [] };
const NONE = /No commands awaiting signatures or waiting on the engine/;

describe("a command too large to read is said by its id, never dropped, and never read as none", () => {
  it("one too large, nothing else listed, the walk whole: its id said, counted, a possible stop, and never 'none in flight'", async () => {
    mount({ ...base, awaitingSignatures: [], tooLarge: ["big-1"], unreadable: { tooLarge: 1 }, possibleStops: { tooLarge: 1 }, pages: { read: 3 } });
    await waitFor(() => expect(screen.queryByTestId("too-large-command")).not.toBeNull());
    const said = screen.getByTestId("too-large-command");
    expect(said.getAttribute("data-id")).toBe("big-1");
    expect(said.textContent).toMatch(/A command too large to read: big-1/);
    expect(text()).toMatch(/1 row could not be read: too large/);
    const stops = screen.getAllByTestId("possible-stops").find((one) => one.getAttribute("data-list") === "tooLarge");
    expect(stops?.textContent).toMatch(/1 of them \(too large to read\) may be a stop/);
    expect(text()).not.toMatch(NONE);
    expect(figure("Awaiting signatures")).toBe("0+");
    expect(figure("Ready for engine")).toBe("0+");
    // The walk was whole: no cut is said.
    expect(screen.queryByTestId("text-inflight-more")).toBeNull();
    expect(screen.queryByTestId("text-inflight-pages")).toBeNull();
  });

  it("one known to be a resume: said by its id and counted, but not as a possible stop", async () => {
    mount({ ...base, awaitingSignatures: [command("p1", "pause")], tooLarge: ["big-resume"], unreadable: { tooLarge: 1 } });
    await waitFor(() => expect(screen.queryByTestId("too-large-command")).not.toBeNull());
    expect(screen.queryAllByTestId("possible-stops").filter((one) => one.getAttribute("data-list") === "tooLarge")).toHaveLength(0);
    expect(figure("Awaiting signatures")).toBe("1+");
  });
});

describe("a walk of the pages cut short says how far it read and why; one read to its end is whole", () => {
  it("cut at the time bound: the cut is said, and how far the pages were read and why", async () => {
    mount({ ...base, awaitingSignatures: [command("sd-1", "stand_down")], more: true,
      pages: { read: 4, unfinished: "the time bound (4000 ms for the pages after the first) was reached" } });
    await waitFor(() => expect(screen.queryByTestId("text-inflight-pages")).not.toBeNull());
    const pages = screen.getByTestId("text-inflight-pages");
    expect(pages.getAttribute("data-read")).toBe("4");
    expect(pages.textContent).toMatch(/Read 4 pages of the control plane's list, then stopped before its last: the time bound/);
    expect(screen.getByTestId("text-inflight-more").getAttribute("data-more")).toBe("true");
    expect(figure("Awaiting signatures")).toBe("1+");
  });

  it("control: every page read, the last saying no more -- whole, as a single whole page always was", async () => {
    mount({ ...base, awaitingSignatures: [command("sd-a", "stand_down"), command("p-b", "pause")], pages: { read: 3 } });
    await waitFor(() => expect(screen.queryByTestId("button-open-sd-a")).not.toBeNull());
    expect(figure("Awaiting signatures")).toBe("2");
    expect(screen.queryByTestId("text-inflight-more")).toBeNull();
    expect(screen.queryByTestId("text-inflight-pages")).toBeNull();
    expect(screen.queryByTestId("too-large-command")).toBeNull();
  });

  it("control: nothing in flight, every page read: 'none in flight'", async () => {
    mount({ ...base, awaitingSignatures: [], pages: { read: 2 } });
    await waitFor(() => expect(text()).toMatch(NONE));
    expect(figure("Awaiting signatures")).toBe("0");
  });
});
