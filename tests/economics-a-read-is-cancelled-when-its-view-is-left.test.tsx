// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";

import { getQueryFn } from "@/lib/queryClient";
import { EconomicsView } from "@/pages/Economics";
import { shims } from "./helpers/economics-render";

/**
 * SAFETY (review round 1, MEDIUM-3): an economics read nobody will see is
 * cancelled, so it never keeps one of the browser's few connections to this
 * server -- which a stop needs. The views' reads pass React Query's AbortSignal to
 * fetch; leaving the view, or replacing it with another scenario's, aborts every
 * read still open. Since the relay-read deadline PR every query passes it (the
 * assurance reads included: tests/a-relay-read-is-cancelled-when-its-view-is-left);
 * only a query whose meta says `cancelWhenLeft: false` passes none.
 */

beforeAll(shims);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const A = { deployment: "11111111-1111-4111-8111-111111111111", scenario: "22222222-2222-4222-8222-222222222222" };
const B = { deployment: "11111111-1111-4111-8111-111111111111", scenario: "33333333-3333-4333-8333-333333333333" };

/** A fetch whose every read the backend stalls: it never answers until aborted. */
function stalledFetch() {
  const reads: Array<{ url: string; signal: AbortSignal | undefined }> = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    reads.push({ url: String(url), signal: init?.signal ?? undefined });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }));
  return reads;
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
}

describe("an economics read is cancelled when its view is left", () => {
  it("leaving the view aborts its three open reads", async () => {
    const reads = stalledFetch();
    const view = render(
      <QueryClientProvider client={client()}>
        <EconomicsView {...A} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(reads).toHaveLength(3));
    expect(reads.map((one) => one.url.split("?")[0]).sort()).toEqual(["/api/economics/events", "/api/economics/report", "/api/economics/roi"]);
    for (const read of reads) {
      expect(read.signal, read.url).toBeDefined();
      expect(read.signal!.aborted).toBe(false);
    }
    view.unmount();
    await waitFor(() => expect(reads.every((one) => one.signal!.aborted)).toBe(true));
  });

  it("replacing it with another scenario aborts the first scenario's reads, not the second's", async () => {
    const reads = stalledFetch();
    const queries = client();
    const view = render(
      <QueryClientProvider client={queries}>
        <EconomicsView {...A} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(reads).toHaveLength(3));
    view.rerender(
      <QueryClientProvider client={queries}>
        <EconomicsView {...B} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(reads).toHaveLength(6));
    const first = reads.filter((one) => one.url.includes(A.scenario));
    const second = reads.filter((one) => one.url.includes(B.scenario));
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    await waitFor(() => expect(first.every((one) => one.signal!.aborted)).toBe(true));
    expect(second.some((one) => one.signal!.aborted)).toBe(false);
  });

  it("every query passes its signal, another screen's included; only an explicit opt-out passes none", async () => {
    const reads = stalledFetch();
    const fn = getQueryFn({ on401: "throw" });
    const controller = new AbortController();
    void fn({ queryKey: ["/api/assurance/deployments"], meta: undefined, signal: controller.signal } as never).catch(() => undefined);
    void fn({ queryKey: ["/api/economics/report", A], meta: undefined, signal: controller.signal } as never).catch(() => undefined);
    void fn({ queryKey: ["/api/clients"], meta: { cancelWhenLeft: false }, signal: controller.signal } as never).catch(() => undefined);
    await waitFor(() => expect(reads).toHaveLength(3));
    expect(reads[0].signal).toBe(controller.signal);
    expect(reads[1].signal).toBe(controller.signal);
    expect(reads[2].signal).toBeUndefined();
    controller.abort();
  });
});
