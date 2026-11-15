// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import Failsafe from "@/pages/Failsafe";
import { getQueryFn } from "@/lib/queryClient";

/**
 * SAFETY (DASH-FAILSAFE-2), the console's half: no missing or odd field the
 * server passes on is drawn as less than it is.
 *
 *   - A command whose required-signature count is unknown (null) is never
 *     "1/1 signed": the count reads "?", and its console says the count is
 *     not known -- and the stop is still offered for signing.
 *   - An unreadable in-flight row that may be a stop (`possibleStops`) is said
 *     as one: it cannot be opened here, so the page says to find it on the
 *     control plane, and never reads the list as none.
 *   - The "recent" list is not drawn on this page (it is the control plane's
 *     history, served empty under the service token), so its count is not
 *     said under "Commands in flight" either.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const STATUS = { configured: true, reachable: true, authorized: true, url: "http://cp", detail: "", defaultEngineId: "athena-1" };
const command = (uuid: string, action: string, requiredSignatures: number | null, status = "awaiting_signatures") => ({
  uuid, action, engineId: "athena-1", status, nonce: "n", reason: "r",
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  signers: ["alice"], requiredSignatures, createdAt: null, updatedAt: null,
});
const draftOf = (one: ReturnType<typeof command>) => ({
  command: one, signingBytes: "00",
  draft: { action: one.action, engine_id: one.engineId, nonce: one.nonce, issued_at: one.issuedAt, expires_at: one.expiresAt, reason: one.reason },
});

/** The page on a client that reads through the app's own query function, against a stubbed server. */
function mount(served: { state: unknown; commands?: Record<string, unknown> }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.startsWith("/api/failsafe/status")) return ok(STATUS);
    if (u.startsWith("/api/failsafe/state")) return ok(served.state);
    if (u.startsWith("/api/failsafe/audit")) return ok([]);
    const one = /^\/api\/failsafe\/commands\/([^/?]+)/.exec(u);
    if (one && served.commands?.[one[1]]) return ok(served.commands[one[1]]);
    return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
  render(<QueryClientProvider client={client}><Failsafe /></QueryClientProvider>);
}

const text = () => document.body.textContent ?? "";
const unreadable = () => screen.queryAllByTestId("unreadable-rows").map((one) => one.getAttribute("data-list"));
const base = { engineId: "athena-1", engineState: "running", engineStateAvailable: true, ready: [], recent: [] };

describe("an unknown required-signature count is never drawn as fewer", () => {
  it("a stand-down with one signature and an unknown count reads 1/?, never 1/1, and stays signable", async () => {
    const standDown = command("sd-unknown", "stand_down", null);
    mount({ state: { ...base, awaitingSignatures: [standDown] }, commands: { "sd-unknown": draftOf(standDown) } });
    await waitFor(() => expect(screen.queryByTestId("button-open-sd-unknown")).not.toBeNull());
    expect(text()).toMatch(/1\/\? signed/);
    expect(text()).not.toMatch(/1\/1 signed/);

    fireEvent.click(screen.getByTestId("button-open-sd-unknown"));
    await waitFor(() => expect(screen.queryByTestId("text-signer-progress")).not.toBeNull());
    const progress = screen.getByTestId("text-signer-progress").textContent ?? "";
    expect(progress).toMatch(/1 signed; how many operator signatures it needs is not known/);
    expect(progress).not.toMatch(/1 of 1/);
    expect(text()).not.toMatch(/Fully signed/);
    // The stop is still offered for signing: its draft and the step for a second operator.
    expect(text()).toMatch(/Step 1 — sign these exact bytes/);
    expect(text()).toMatch(/a second, different operator may need to repeat steps 1–2/);
  });

  it("control: a count the control plane gave is drawn as it is", async () => {
    mount({ state: { ...base, awaitingSignatures: [command("sd-two", "stand_down", 2)] } });
    await waitFor(() => expect(screen.queryByTestId("button-open-sd-two")).not.toBeNull());
    expect(text()).toMatch(/1\/2 signed/);
  });
});

describe("an unreadable in-flight row that may be a stop is said as one", () => {
  it("rows of awaiting signatures with no uuid, one of them maybe a stop: counted, said as a possible stop, never 'none in flight'", async () => {
    mount({ state: { ...base, awaitingSignatures: [], unreadable: { awaitingSignatures: 2 }, possibleStops: { awaitingSignatures: 1 } } });
    await waitFor(() => expect(screen.queryByTestId("possible-stops")).not.toBeNull());
    const said = screen.getByTestId("possible-stops");
    expect(said.getAttribute("data-list")).toBe("awaitingSignatures");
    expect(said.getAttribute("data-count")).toBe("1");
    expect(said.textContent).toMatch(/1 of them \(awaiting signatures\) may be a stop: it cannot be opened here/);
    expect(unreadable()).toEqual(["awaitingSignatures"]);
    expect(text()).not.toMatch(/No commands awaiting signatures or waiting on the engine/);
  });

  it("control: no possible stop is said when none was counted", async () => {
    mount({ state: { ...base, awaitingSignatures: [], unreadable: { awaitingSignatures: 1 } } });
    await waitFor(() => expect(unreadable()).toEqual(["awaitingSignatures"]));
    expect(screen.queryByTestId("possible-stops")).toBeNull();
  });
});

describe("the recent list is not drawn, so its count is not said under commands in flight", () => {
  it("rows of recent that could not be read: no count under 'Commands in flight', which reads as the in-flight lists are", async () => {
    mount({ state: { ...base, awaitingSignatures: [], unreadable: { recent: 3 } } });
    await waitFor(() => expect(text()).toMatch(/No commands awaiting signatures or waiting on the engine/));
    expect(unreadable()).toEqual([]);
    expect(text()).not.toMatch(/could not be read: recent/);
  });
});
