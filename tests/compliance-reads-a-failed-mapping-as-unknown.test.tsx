// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";

import Compliance from "@/pages/Compliance";

/**
 * When /api/compliance/:clientId failed, Compliance showed every tile as 0,
 * the coverage ring as "0% Tested", the table as "No control mapping yet --
 * run a scan to populate ASVS coverage." and Control Gaps as "No mapped
 * requirement is failing in the tests considered." (adversary round 1, F9) --
 * a no-failures statement about a mapping nobody read. The first test is the
 * adversary's reproducer.
 */

afterEach(cleanup);

const CLIENTS = [{ id: "c1", name: "Payments API", status: "active" }];
const NO_FAILING = /No mapped requirement is failing/;

function mount(seed: Array<[unknown[], unknown]>, mapping: "rejects" | "never resolves" = "rejects") {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          if (String(queryKey[0]).startsWith("/api/compliance/") && mapping === "never resolves") {
            return new Promise(() => {});
          }
          throw new Error(`source failed: ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  for (const [key, value] of seed) client.setQueryData(key, value);
  render(
    <QueryClientProvider client={client}>
      <Compliance />
    </QueryClientProvider>,
  );
  return client;
}

/** The figure on the headline card with this label. */
function tile(label: string): string | null | undefined {
  const labels = Array.from(document.querySelectorAll(".athena-label")).filter((el) => el.textContent === label);
  expect(labels, `one card labelled ${label}`).toHaveLength(1);
  let node: Element | null = labels[0];
  while (node && !node.querySelector(".athena-figure")) node = node.parentElement;
  return node?.querySelector(".athena-figure")?.textContent;
}

describe("Compliance when the mapping is not in hand", () => {
  it("does not say no requirement is failing", async () => {
    const client = mount([
      [["/api/clients"], CLIENTS],
      [["/api/tests"], []],
    ]);
    await waitFor(() => expect(client.getQueryState(["/api/compliance/c1"])?.status).toBe("error"));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(NO_FAILING);
    expect(text).not.toMatch(/No control mapping yet/);
    expect(text).toMatch(/Could not load the control mapping: source failed/);
    for (const label of ["ASVS 4.0.3 Requirements", "Tested", "Open Gaps", "Not Run", "Tests Considered"]) {
      expect(tile(label), `${label} tile`).toBe("—");
    }
    const coverage = screen.getByTestId("asvs-coverage");
    expect(within(coverage).queryByText("0%")).toBeNull();
    expect(coverage.querySelector(".athena-figure")?.textContent).toBe("—");
  });

  it("reads a mapping still loading as loading, not as no failures", async () => {
    const client = mount([[["/api/clients"], CLIENTS], [["/api/tests"], []]], "never resolves");
    await waitFor(() => expect(client.getQueryState(["/api/compliance/c1"])?.fetchStatus).toBe("fetching"));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(NO_FAILING);
    expect(tile("Open Gaps")).toBe("…");
  });

  it("does not say no requirement is failing when there is no engagement to map", () => {
    mount([[["/api/clients"], []], [["/api/tests"], []]]);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(NO_FAILING);
    expect(text).toMatch(/No engagement on record yet/);
    expect(tile("Open Gaps")).toBe("—");
  });

  it("says no requirement is failing only when the mapping came back with none failing", () => {
    mount([
      [["/api/clients"], CLIENTS],
      [["/api/tests"], []],
      [["/api/compliance/c1"], {
        client: { id: "c1", name: "Payments API" }, testsConsidered: 2, scannersLoaded: 4,
        rows: [{
          requirement: { id: "V5.3.3", chapter: "V5", section: "Output encoding", cwe: null, l1: true, l2: true, l3: true },
          state: "tested", findings: [], scanners: ["xss"], approximate: false,
        }],
        summary: { version: "4.0.3", failing: 0, tested: 1, notRun: 0, notCovered: 0, total: 1 },
      }],
    ]);
    expect(document.body.textContent).toMatch(NO_FAILING);
    expect(tile("Open Gaps")).toBe("0");
    expect(tile("Tests Considered")).toBe("2");
  });
});
