// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import Failsafe from "@/pages/Failsafe";

/**
 * SAFETY: an operator drafts a PAUSE. The draft route answers 201 with the
 * whole DraftedCommand (draft + signing bytes) -- and the page threw it away,
 * opening a console that read the command again. When that first read failed
 * (the same network blip the round-3 fix was about), the console had no
 * cached answer to fall back on ("stale" is only commandQ.data), so it showed
 * "Could not read this command ... Close" and no Step 1 / Submit signature:
 * the stop the operator had just drafted could not be signed or relayed from
 * here, and nothing read the command again on its own.
 *
 * The draft's own answer now seeds the console, so the stale-stop path
 * applies to it; the console still reads the command on opening, and keeps
 * reading it while the read fails. A resume just drafted is not signable on a
 * failed read: putting an engine back to work may wait for one.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const STATUS = { configured: true, reachable: true, authorized: true, url: "http://cp", detail: "", defaultEngineId: "athena-1" };
const pause = {
  uuid: "new-pause", action: "pause", engineId: "athena-1", status: "awaiting_signatures", nonce: "n", reason: "r",
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  signers: [], requiredSignatures: 1, createdAt: null, updatedAt: null,
};
const drafted = {
  command: pause, signingBytes: "AAAA",
  draft: { action: "pause", engine_id: "athena-1", nonce: "n", issued_at: pause.issuedAt, expires_at: pause.expiresAt, reason: "r" },
};

it("a just-drafted pause can be signed even when the console's first read of it fails", async () => {
  let blip = true;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
      queryFn: async ({ queryKey }) => {
        if (queryKey[0] === "/api/failsafe/commands") {
          if (blip) throw new Error("Failed to fetch"); // the blip
          return { ...drafted, command: { ...pause, signers: ["alice"] } };
        }
        if (queryKey[0] === "/api/failsafe/status") return STATUS;
        if (queryKey[0] === "/api/failsafe/audit") return [];
        return { engineId: "athena-1", engineState: null, engineStateAvailable: false, awaitingSignatures: [], ready: [], recent: [] };
      } } },
  });
  client.setQueryData(["/api/failsafe/status"], STATUS);
  render(<QueryClientProvider client={client}><Failsafe /></QueryClientProvider>);
  // The draft route works and answers with the whole drafted command.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(drafted), {
    status: 201, headers: { "Content-Type": "application/json" },
  })));

  fireEvent.click(screen.getByTestId("button-draft-pause"));
  fireEvent.change(screen.getByTestId("input-reason"), { target: { value: "runaway" } });
  fireEvent.click(screen.getByTestId("button-confirm-draft"));

  await waitFor(() => expect(client.getQueryState(["/api/failsafe/commands", "new-pause"])?.status).toBe("error"));
  // What a stop needs: the bytes to sign and a way to relay the signature.
  expect(screen.queryByTestId("button-submit-signature"), "pause just drafted must be signable").toBeTruthy();
  expect(document.body.textContent).toContain("AAAA"); // the signing bytes the draft route returned
  expect(screen.getByTestId("text-command-unread").textContent).toMatch(/It is a stop, so signing and relaying stay available/);

  // Nobody presses "Read it again": the console reads it again on its own, and
  // once the control plane answers, what it shows is the command as read.
  blip = false;
  await waitFor(() => expect(client.getQueryState(["/api/failsafe/commands", "new-pause"])?.status).toBe("success"),
    { timeout: 6_000 });
  await waitFor(() => expect(screen.queryByTestId("text-command-unread")).toBeNull());
  expect(document.body.textContent).toMatch(/1 of 1 operator signature/);
}, 10_000);

it("a just-drafted resume is not signable on a failed first read: putting an engine back to work waits for one", async () => {
  const STATUS_READY = STATUS;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
      queryFn: async ({ queryKey }) => {
        if (queryKey[0] === "/api/failsafe/commands") throw new Error("Failed to fetch");
        if (queryKey[0] === "/api/failsafe/status") return STATUS_READY;
        if (queryKey[0] === "/api/failsafe/audit") return [];
        return { engineId: "athena-1", engineState: "paused", engineStateAvailable: true, awaitingSignatures: [], ready: [], recent: [] };
      } } },
  });
  client.setQueryData(["/api/failsafe/status"], STATUS_READY);
  render(<QueryClientProvider client={client}><Failsafe /></QueryClientProvider>);
  const resume = { ...pause, uuid: "new-resume", action: "resume" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    command: resume, signingBytes: "BBBB", draft: { ...drafted.draft, action: "resume" },
  }), { status: 201, headers: { "Content-Type": "application/json" } })));

  fireEvent.click(screen.getByTestId("button-draft-resume"));
  fireEvent.click(screen.getByTestId("button-confirm-draft"));
  await waitFor(() => expect(client.getQueryState(["/api/failsafe/commands", "new-resume"])?.status).toBe("error"));
  await waitFor(() => expect(screen.getByTestId("text-command-unread")).toBeTruthy());
  expect(screen.queryByTestId("button-submit-signature")).toBeNull();
});
