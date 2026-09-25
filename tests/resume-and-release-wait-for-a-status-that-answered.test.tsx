// @vitest-environment jsdom
import { it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";

import Failsafe from "@/pages/Failsafe";

/**
 * Resume and release are meant to "wait for a current read" (the console
 * refuses to sign a resume after its re-read fails). But the page's Draft
 * resume / Draft release buttons were gated on `lastReady` -- statusQ.data,
 * the last status that ever answered -- so while every status read was
 * failing they stayed enabled, drafted on a status the page itself said it
 * could not read. They now wait on the status in hand; the three stops stay
 * live whatever the status read says.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

it("Draft resume / release are not live on a status the page could not read", async () => {
  let fail = false;
  const STATUS = { configured: true, reachable: true, authorized: true, url: "http://cp", detail: "", defaultEngineId: "athena-1" };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
      queryFn: async ({ queryKey }) => {
        if (fail && queryKey[0] === "/api/failsafe/status") throw new Error("Failed to fetch");
        if (queryKey[0] === "/api/failsafe/status") return STATUS;
        if (queryKey[0] === "/api/failsafe/audit") return [];
        return { engineId: "athena-1", engineState: "paused", engineStateAvailable: true, awaitingSignatures: [], ready: [], recent: [] };
      } } },
  });
  client.setQueryData(["/api/failsafe/status"], STATUS);
  render(<QueryClientProvider client={client}><Failsafe /></QueryClientProvider>);
  // While the status answers, resume and release are live: the gate is the read, not a blanket "off".
  expect((screen.getByTestId("button-draft-resume") as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByTestId("button-draft-release") as HTMLButtonElement).disabled).toBe(false);
  fail = true;
  await act(async () => { await client.refetchQueries({ queryKey: ["/api/failsafe/status"] }); });
  await waitFor(() => expect(client.getQueryState(["/api/failsafe/status"])?.status).toBe("error"));
  expect(document.body.textContent).toMatch(/Could not read the failsafe status/);
  const resume = screen.getByTestId("button-draft-resume") as HTMLButtonElement;
  const release = screen.getByTestId("button-draft-release") as HTMLButtonElement;
  expect(resume.disabled).toBe(true);
  expect(release.disabled).toBe(true);
  // ...and the stops are not held back by the same failed read.
  for (const stop of ["pause", "stand_down", "terminate"]) {
    expect((screen.getByTestId(`button-draft-${stop}`) as HTMLButtonElement).disabled, stop).toBe(false);
  }
});
