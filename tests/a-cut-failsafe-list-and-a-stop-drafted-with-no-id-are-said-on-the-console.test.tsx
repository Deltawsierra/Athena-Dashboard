// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";

import Failsafe from "@/pages/Failsafe";
import { getQueryFn } from "@/lib/queryClient";

/**
 * SAFETY (DASH-FAILSAFE-3), the console's half.
 *
 *   - Commands in flight that the control plane cut at its page (`more: true`)
 *     or did not say are whole (`more: null`) are never shown as whole: the
 *     tiles read "n+", "No commands awaiting signatures…" is held back, and
 *     the page says a stop awaiting a signature may be among those left out,
 *     and where to find it. A state with no `more` reads as it always did.
 *   - A stop drafted with no uuid opened an empty dialog: the draft to sign
 *     and every way to act on it were hidden. Now it is shown with why it
 *     cannot be opened by its id, the draft to sign, and how to act on it; and
 *     when the commands in flight list it (found by its nonce, action and
 *     engine), it is opened from there, by its id, to sign and relay.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const STATUS = { configured: true, reachable: true, authorized: true, url: "http://cp", detail: "", defaultEngineId: "athena-1" };
const command = (uuid: string, action: string, nonce = `nonce-${uuid}`) => ({
  uuid, action, engineId: "athena-1", status: "awaiting_signatures", nonce, reason: "r",
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  signers: [], requiredSignatures: action === "pause" ? 1 : 2, createdAt: null, updatedAt: null,
});
const draftOf = (one: ReturnType<typeof command>) => ({
  command: one, signingBytes: "C0FFEE",
  draft: { action: one.action, engine_id: one.engineId, nonce: one.nonce, issued_at: one.issuedAt, expires_at: one.expiresAt, reason: one.reason },
});

/** The page on a client that reads through the app's own query function, against a stubbed server. `served.state` may change between reads. */
function mount(served: { state: unknown; draft?: unknown; commands?: Record<string, unknown> }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (u.startsWith("/api/failsafe/status")) return ok(STATUS);
    if (u.startsWith("/api/failsafe/state")) return ok(served.state);
    if (u.startsWith("/api/failsafe/audit")) return ok([]);
    if (init?.method === "POST" && u === "/api/failsafe/commands") return ok(served.draft, 201);
    const one = /^\/api\/failsafe\/commands\/([^/?]+)/.exec(u);
    if (one && served.commands?.[one[1]]) return ok(served.commands[one[1]]);
    return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
  render(<QueryClientProvider client={client}><Failsafe /></QueryClientProvider>);
  return client;
}

const text = () => document.body.textContent ?? "";
/** A tile's figure, by its label (a command's status pill may carry the same words). */
const figure = (label: string) => screen.getAllByText(label)
  .map((one) => one.closest("div")?.parentElement?.querySelector(".athena-figure"))
  .find((one) => one !== null && one !== undefined)?.textContent;
const base = { engineId: "athena-1", engineState: "running", engineStateAvailable: true, ready: [], recent: [] };
const NONE = /No commands awaiting signatures or waiting on the engine/;

describe("a list of commands in flight that may not be whole is never shown as whole", () => {
  it("cut at the control plane's page (more: true), with nothing on the page: never 'none in flight', never a bare 0, and said", async () => {
    mount({ state: { ...base, awaitingSignatures: [], more: true } });
    await waitFor(() => expect(screen.queryByTestId("text-inflight-more")).not.toBeNull());
    const said = screen.getByTestId("text-inflight-more");
    expect(said.getAttribute("data-more")).toBe("true");
    expect(said.textContent).toMatch(/More commands are in flight than the control plane listed/);
    expect(said.textContent).toMatch(/A stop awaiting a signature may be among those left out: find it on the failsafe control plane/);
    expect(text()).not.toMatch(NONE);
    expect(figure("Awaiting signatures")).toBe("0+");
    expect(figure("Ready for engine")).toBe("0+");
    expect(text()).toMatch(/More were left out than were listed/);
  });

  it("cut, with a stop on the page: the stop is drawn and openable, the tile reads 1+, and the cut is said", async () => {
    mount({ state: { ...base, awaitingSignatures: [command("sd-page1", "stand_down")], more: true } });
    await waitFor(() => expect(screen.queryByTestId("button-open-sd-page1")).not.toBeNull());
    expect(figure("Awaiting signatures")).toBe("1+");
    expect(screen.getByTestId("text-inflight-more")).toBeTruthy();
  });

  it("the control plane did not say whether it is whole (more: null): never 'none in flight', and said", async () => {
    mount({ state: { ...base, awaitingSignatures: [], more: null } });
    await waitFor(() => expect(screen.queryByTestId("text-inflight-more")).not.toBeNull());
    const said = screen.getByTestId("text-inflight-more");
    expect(said.getAttribute("data-more")).toBe("null");
    expect(said.textContent).toMatch(/did not say whether this list is all the commands in flight, so it may not be/);
    expect(text()).not.toMatch(NONE);
    expect(figure("Awaiting signatures")).toBe("0+");
    expect(text()).toMatch(/Not said to be all of them/);
  });

  it("control: a whole list (no `more`) reads as it always did -- 'none in flight', a 0, and nothing said", async () => {
    mount({ state: { ...base, awaitingSignatures: [] } });
    await waitFor(() => expect(text()).toMatch(NONE));
    expect(figure("Awaiting signatures")).toBe("0");
    expect(screen.queryByTestId("text-inflight-more")).toBeNull();
  });
});

/** Draft a stand-down from the console. */
function draftStandDown() {
  fireEvent.click(screen.getByTestId("button-draft-stand_down"));
  fireEvent.change(screen.getByTestId("input-reason"), { target: { value: "runaway" } });
  fireEvent.click(screen.getByTestId("button-confirm-draft"));
}

describe("a stop drafted with no id is shown, with why it cannot be opened and how to act on it", () => {
  const orphan = { ...command("", "stand_down", "nonce-orphan") };
  const UNOPENABLE = "the control plane's answer to the draft named no command id (uuid), so this console cannot read the command, " +
    "relay a signature to it or withdraw it by its id";

  it("drafted with no uuid: never an empty dialog -- the reason, the draft to sign, and how to find it by its nonce", async () => {
    mount({ state: { ...base, awaitingSignatures: [] }, draft: { ...draftOf(orphan), unopenable: UNOPENABLE } });
    await waitFor(() => expect((screen.getByTestId("button-draft-stand_down") as HTMLButtonElement).disabled).toBe(false));
    draftStandDown();
    await waitFor(() => expect(screen.queryByTestId("unopened-draft")).not.toBeNull());
    const shown = screen.getByTestId("unopened-draft");
    expect(within(shown).getByTestId("text-unopened-why").textContent).toMatch(/Drafted, but it cannot be opened here by its id: the control plane's answer to the draft named no command id/);
    expect(within(shown).getByTestId("text-unopened-draft-json").textContent).toMatch(/"nonce": "nonce-orphan"/);
    expect(shown.textContent).toMatch(/C0FFEE/);
    expect(within(shown).getByTestId("text-unopened-how").textContent).toMatch(/looks for it by its nonce nonce-orphan on every read of the commands in flight/);
    expect(within(shown).getByTestId("text-unopened-how").textContent).toMatch(/find it on the failsafe control plane by that nonce to relay its signature or withdraw it/);
    expect(screen.queryByTestId("button-open-drafted")).toBeNull();
  });

  it("drafted with no uuid, and listed in flight with its id: found by its nonce, and opened by that id to sign and relay", async () => {
    const listed = command("sd-found-by-nonce", "stand_down", "nonce-orphan");
    const served = {
      state: { ...base, awaitingSignatures: [] as unknown[] },
      draft: { ...draftOf(orphan), unopenable: UNOPENABLE },
      commands: { "sd-found-by-nonce": draftOf(listed) },
    };
    const client = mount(served);
    await waitFor(() => expect((screen.getByTestId("button-draft-stand_down") as HTMLButtonElement).disabled).toBe(false));
    // The control plane lists it, with its id, once it is drafted; and a command with another nonce besides.
    served.state = { ...base, awaitingSignatures: [command("sd-other", "stand_down", "nonce-other"), listed] };
    draftStandDown();
    await waitFor(() => expect(screen.queryByTestId("unopened-draft")).not.toBeNull());
    await client.refetchQueries({ queryKey: ["/api/failsafe/state"] });
    await waitFor(() => expect(screen.queryByTestId("button-open-drafted")).not.toBeNull());
    expect(screen.getByTestId("text-unopened-found").textContent).toMatch(/Found among the commands in flight by its nonce nonce-orphan/);
    fireEvent.click(screen.getByTestId("button-open-drafted"));
    await waitFor(() => expect(screen.queryByTestId("button-submit-signature")).not.toBeNull());
    expect(screen.queryByTestId("unopened-draft")).toBeNull();
    expect(text()).toMatch(/Step 1 — sign these exact bytes/);
  });

  it("drafted with no uuid and no nonce: said, with how to find it on the control plane", async () => {
    const bare = { ...command("", "stand_down", "") };
    mount({ state: { ...base, awaitingSignatures: [] }, draft: { ...draftOf(bare), unopenable: UNOPENABLE } });
    await waitFor(() => expect((screen.getByTestId("button-draft-stand_down") as HTMLButtonElement).disabled).toBe(false));
    draftStandDown();
    await waitFor(() => expect(screen.queryByTestId("unopened-draft")).not.toBeNull());
    expect(screen.getByTestId("text-unopened-how").textContent).toMatch(/named no nonce either, so it cannot be found here\. Find it on the failsafe control plane \(the newest stand down drafted for athena-1\)/);
  });

  it("control: a stop drafted with its uuid opens its console, as it always did", async () => {
    const withId = command("sd-with-id", "stand_down");
    mount({ state: { ...base, awaitingSignatures: [] }, draft: draftOf(withId), commands: { "sd-with-id": draftOf(withId) } });
    await waitFor(() => expect((screen.getByTestId("button-draft-stand_down") as HTMLButtonElement).disabled).toBe(false));
    draftStandDown();
    await waitFor(() => expect(screen.queryByTestId("button-submit-signature")).not.toBeNull());
    expect(screen.queryByTestId("unopened-draft")).toBeNull();
  });
});
