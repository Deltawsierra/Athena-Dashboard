// @vitest-environment jsdom
/**
 * A change made while the deployments list is being read for the first time asks
 * for the list again, and the read asked before the change is never shown.
 *
 * Every change on the Assurance page refreshes the deployments list, whose
 * decision may have moved (`invalidateAssuranceComputed`). It invalidated the list
 * without cancelling it, and invalidating restarts only a read that already has
 * data: React Query keeps a first read in flight. That read was asked before the
 * change, and it could land after the change's reads with the decision from before
 * it. PR #54 round 5 closed the same gap for the deployment's computed panels.
 *
 * The page draws no deployment, and so no control that makes a change, until the
 * list is in hand. So here the change comes from a claims panel mounted beside the
 * page, on the app's own query client, with `fetch` answered by hand.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import Assurance, { ClaimsPanel } from "@/pages/Assurance";
import { queryClient } from "@/lib/queryClient";

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
  queryClient.clear();
});

const LIST = "/api/assurance/deployments";
const RECOMPUTE_CLAIMS = "/api/assurance/deployments/dep/recompute-claims";
const REGISTRIES = ["/api/assurance/findings", "/api/assurance/unknowns", "/api/assurance/assets", "/api/assurance/providers"];

const deployment = (decision: string, decisionLabel: string) => ({
  uuid: "dep",
  name: "Claims assistant",
  environment: "production",
  decision,
  decisionLabel,
  findingCount: 0,
  updatedAt: null,
});

/** Let the query client tell the page what changed, and the page render it. */
async function settle() {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
}

/** The control plane, reached through `fetch`: every request waits until the test answers it. */
function controlPlane() {
  type Request = { url: string; method: string; answer: (body: unknown) => void };
  const asked: Request[] = [];
  const answered = new Set<Request>();
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    new Promise<Response>((resolve) =>
      asked.push({ url, method: init?.method ?? "GET", answer: (body) => resolve(json(body)) }),
    ),
  );
  const all = (url: string, method = "GET") => asked.filter((r) => r.url === url && r.method === method);
  return {
    /** Every read of `url` asked for so far, answered or not. */
    reads: (url: string) => all(url),
    /** The request to `url` asked for last. */
    newest: (url: string, method = "GET") => {
      const requests = all(url, method);
      expect(requests.length).toBeGreaterThan(0);
      return requests[requests.length - 1];
    },
    async answer(request: Request, body: unknown) {
      expect(answered.has(request)).toBe(false);
      answered.add(request);
      await act(async () => request.answer(body));
      await settle();
    },
  };
}

/** The deployment's header on the page: its name, environment and decision. */
function header() {
  return screen.getByText("Claims assistant").closest("div") as HTMLElement;
}

describe("the deployments list, when a change is made during its first read", () => {
  it("is asked for again, and the read asked before the change is never shown", async () => {
    const cp = controlPlane();
    render(
      <QueryClientProvider client={queryClient}>
        <Assurance admin={true} />
        <ClaimsPanel deploymentUuid="dep" admin={true} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(cp.reads("/api/assurance/status")).toHaveLength(1));
    await cp.answer(cp.newest("/api/assurance/status"), {
      configured: true, reachable: true, authorized: true, url: "http://cp", detail: "",
    });
    await waitFor(() => expect(cp.reads(LIST)).toHaveLength(1));
    // Every registry but the list arrives. The list is read as it stands -- the
    // deployment ready -- and is slow to arrive.
    for (const url of REGISTRIES) await cp.answer(cp.newest(url), []);
    const listBefore = cp.newest(LIST);
    expect(screen.getByText("Loading…")).toBeTruthy();

    // An admin recomputes the claims while the list is loading: a claim is
    // contradicted, and the deployment needs more evidence.
    fireEvent.click(screen.getByRole("button", { name: "Recompute claims" }));
    await waitFor(() => expect(cp.newest(RECOMPUTE_CLAIMS, "POST")).toBeTruthy());
    await cp.answer(cp.newest(RECOMPUTE_CLAIMS, "POST"), { created: 1, updated: 0, superseded: 1, stale: 0 });
    // The list is asked for again, though its first read had not landed.
    expect(cp.reads(LIST)).toHaveLength(2);

    // The list asked for before the change lands: it is not shown.
    await cp.answer(listBefore, [deployment("ready", "Ready")]);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("Claims assistant")).toBeNull();
    expect(screen.queryByText("Ready")).toBeNull();

    // The list asked for after the change lands.
    await cp.answer(cp.newest(LIST), [deployment("needs_more_evidence", "More evidence")]);
    expect(within(header()).getByText("More evidence")).toBeTruthy();
    expect(screen.queryByText("Ready")).toBeNull();
    expect(queryClient.isFetching({ queryKey: [LIST], exact: true })).toBe(0);
    expect(cp.reads(LIST)).toHaveLength(2);
  });
});
