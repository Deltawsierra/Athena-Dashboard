// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import Failsafe from "@/pages/Failsafe";
import { getQueryFn, queryClient } from "@/lib/queryClient";

/**
 * PR #52 round 5, killer K7 for Failsafe.tsx mutant F06: the co-sign
 * console's relay invalidated the command's key through the module's app
 * client, and every Failsafe render test mounts its own client, so none could
 * see whether the invalidation reached the command it relayed for. Spelled
 * ["/api/failsafe/command", uuid] -- a key nothing reads -- the suite passed,
 * and a stop just co-signed sat on screen as "awaiting signatures" until the
 * next 3-second poll.
 *
 * The console now invalidates through the client it is mounted on
 * (useQueryClient), so the command is read again at once however the page is
 * mounted -- on the app's own client, as the app mounts it, or on another. The
 * query-key sweep (every-page-query-key-reaches-a-route) also refuses an
 * invalidation key no page reads.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); queryClient.clear(); });

async function relayAndCountReads(client: QueryClient) {
  const now = Date.now();
  const cmd = (signers: string[], status: string) => ({
    uuid: "sd-9", action: "stand_down", engineId: "athena-1", status, nonce: "n", reason: "r",
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
    signers, requiredSignatures: 2, createdAt: null, updatedAt: null,
  });
  let relayed = false;
  const reads: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.startsWith("/api/failsafe/status")) return ok({ configured: true, reachable: true, authorized: true, url: "http://cp", detail: "", defaultEngineId: "athena-1" });
    if (u.startsWith("/api/failsafe/audit")) return ok([]);
    if (u.startsWith("/api/failsafe/state")) {
      return ok({ engineId: "athena-1", engineState: "running", engineStateAvailable: true,
        awaitingSignatures: relayed ? [] : [cmd(["alice"], "awaiting_signatures")], ready: [], recent: [] });
    }
    if (u === "/api/failsafe/commands/sd-9/signatures" && init?.method === "POST") {
      relayed = true;
      return ok(cmd(["alice", "bob"], "ready"));
    }
    if (u === "/api/failsafe/commands/sd-9") {
      reads.push(Date.now());
      const c = relayed ? cmd(["alice", "bob"], "ready") : cmd(["alice"], "awaiting_signatures");
      return ok({ command: c, signingBytes: "AAAA", draft: { action: "stand_down", engine_id: "athena-1", nonce: "n", issued_at: c.issuedAt, expires_at: c.expiresAt, reason: "r" } });
    }
    return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
  }));

  render(<QueryClientProvider client={client}><Failsafe /></QueryClientProvider>);
  fireEvent.click(await screen.findByTestId("button-open-sd-9"));
  await screen.findByTestId("button-submit-signature");
  fireEvent.change(screen.getByTestId("input-signature-keyid"), { target: { value: "bob" } });
  fireEvent.change(screen.getByTestId("input-signature"), { target: { value: "abcd" } });
  const before = reads.length;
  const at = Date.now();
  fireEvent.click(screen.getByTestId("button-submit-signature"));
  await waitFor(() => expect(relayed).toBe(true));
  // Read back at once -- not on the next 3-second poll.
  await waitFor(() => expect(reads.length).toBeGreaterThan(before), { timeout: 1_500 });
  expect(reads[reads.length - 1] - at).toBeLessThan(1_500);
}

describe("a relayed signature is read back at once", () => {
  it("on the app's own client, as the app mounts the page", async () => {
    await relayAndCountReads(queryClient);
  }, 10_000);

  it("on any client the page is mounted on", async () => {
    const own = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
    await relayAndCountReads(own);
    own.clear();
  }, 10_000);
});
