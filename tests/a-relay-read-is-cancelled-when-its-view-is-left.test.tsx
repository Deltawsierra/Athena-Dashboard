// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";

import Assurance, { ClaimsPanel } from "@/pages/Assurance";
import { getQueryFn } from "@/lib/queryClient";

/**
 * SAFETY: a relay read nobody will see is cancelled, so it never keeps one of the
 * browser's few connections to this server -- which a stop needs. Every query
 * passes React Query's AbortSignal to its fetch (lib/queryClient.ts); leaving a
 * screen, or replacing what it shows, aborts every read of it still open. Here
 * the Assurance screen, whose reads relay the control plane, and one of its panels.
 * (Stops are not reads: they go through apiRequest, which takes no signal.)
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A fetch the backend stalls: no read is answered until it is aborted. */
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

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });

describe("a relay read is cancelled when its view is left", () => {
  it("leaving the Assurance screen aborts every control-plane read it has open", async () => {
    const reads = stalledFetch();
    const view = render(
      <QueryClientProvider client={client()}>
        <Assurance admin={true} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(reads.some((one) => one.url.startsWith("/api/assurance/"))).toBe(true));
    const open = reads.filter((one) => one.url.startsWith("/api/assurance/"));
    for (const read of open) {
      expect(read.signal, read.url).toBeDefined();
      expect(read.signal!.aborted).toBe(false);
    }
    view.unmount();
    await waitFor(() => expect(open.every((one) => one.signal!.aborted)).toBe(true));
  });

  it("replacing what a panel shows aborts the first deployment's reads, not the second's", async () => {
    const reads = stalledFetch();
    const queries = client();
    const view = render(
      <QueryClientProvider client={queries}>
        <ClaimsPanel deploymentUuid="dep-a" admin={false} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(reads.some((one) => one.url.includes("dep-a"))).toBe(true));
    view.rerender(
      <QueryClientProvider client={queries}>
        <ClaimsPanel deploymentUuid="dep-b" admin={false} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(reads.some((one) => one.url.includes("dep-b"))).toBe(true));
    const first = reads.filter((one) => one.url.includes("dep-a"));
    const second = reads.filter((one) => one.url.includes("dep-b"));
    await waitFor(() => expect(first.every((one) => one.signal?.aborted === true)).toBe(true));
    expect(second.some((one) => one.signal?.aborted === true)).toBe(false);
  });
});
