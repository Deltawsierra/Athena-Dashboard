// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";

/**
 * PR #52 round 3, an open item from round 2. The Athena and Penetration
 * Testing screens read their client and site pickers as `data = []`, so a
 * list that failed to load showed an empty picker with no word of why --
 * "there are no engagements" -- and a failed site list, once a client was
 * chosen, said "No systems recorded" / "This client has no sites recorded":
 * a claim about the record nobody had read. Both lists are read error-first
 * now, and a failure is said beside the pickers.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
});
afterEach(cleanup);

const ENGINE = { configured: true, reachable: true, authorized: true, url: "http://engine.test", detail: "" };
/** Any key not seeded fails, as a source that could not be read. */
function mount(ui: React.ReactElement, seed: Array<[unknown[], unknown]>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
      queryFn: async () => { throw new Error("source failed"); } } },
  });
  for (const [k, v] of seed) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return client;
}
const COMMON: Array<[unknown[], unknown]> = [
  [["/api/engine/status"], ENGINE],
  [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
  [["/api/auth/check"], { authenticated: true, user: null }],
];

for (const [name, Page, noSites] of [
  ["Athena", AthenaScan, /No systems recorded/],
  ["Penetration testing", PentestScan, /This client has no sites recorded/],
] as const) {
  describe(`${name}: a picker whose list failed says so`, () => {
    it("the engagements", async () => {
      const client = mount(<Page />, [...COMMON, [["/api/sites"], []]]);
      await waitFor(() => expect(client.getQueryState(["/api/clients"])?.status).toBe("error"));
      expect(screen.getByTestId("text-pickers-unread").textContent).toMatch(
        /^Could not load the engagements: source failed\. The pickers are empty because the list could not be read, not because nothing is recorded\.$/,
      );
      expect(screen.getByTestId("select-client").textContent).toMatch(/Could not load the engagements/);
    });

    it("the sites: never 'no sites recorded' from a read that failed", async () => {
      const client = mount(<Page />, [...COMMON, [["/api/clients"], [{ id: "c1", name: "Acme" }]]]);
      await waitFor(() => expect(client.getQueryState(["/api/sites"])?.status).toBe("error"));
      fireEvent.change(document.querySelectorAll("select")[0], { target: { value: "c1" } });
      await waitFor(() => expect(screen.getByTestId("select-site").textContent).toMatch(/Could not load the sites/));
      expect(screen.getByTestId("select-site").textContent).not.toMatch(noSites);
      expect(screen.getByTestId("text-pickers-unread").textContent).toMatch(/^Could not load the sites: source failed\./);
    });

    it("says nothing when both lists answered", () => {
      mount(<Page />, [...COMMON, [["/api/clients"], [{ id: "c1", name: "Acme" }]], [["/api/sites"], []]]);
      expect(screen.queryByTestId("text-pickers-unread")).toBeNull();
      fireEvent.change(document.querySelectorAll("select")[0], { target: { value: "c1" } });
      expect(screen.getByTestId("select-site").textContent).toMatch(noSites);
    });
  });
}
