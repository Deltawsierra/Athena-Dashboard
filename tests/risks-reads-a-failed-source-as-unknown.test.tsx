// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, cleanup, waitFor } from "@testing-library/react";

import Risks from "@/pages/Risks";

/**
 * Risks read only `data` and `isLoading` from the findings query, so a request
 * that failed rendered "Total Open Risks 0 · Critical Risks 0 · High Risks 0",
 * "No findings recorded for this engagement yet", and under "Athena Reasoning
 * Live": "No open findings. Nothing here needs attention right now." -- a
 * source nobody read, shown as a measured zero and an explicit all-clear
 * (adversary round 1, F4). The same text showed while it was still loading.
 *
 * The first test is the adversary's reproducer.
 */

afterEach(cleanup);

const CLIENTS = [{ id: "c1", name: "Payments API", status: "active", lastTestDate: null }];

function mount(seed: Array<[unknown[], unknown]>, findings: "rejects" | "never resolves" = "rejects") {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          if (queryKey[0] === "/api/findings" && findings === "never resolves") return new Promise(() => {});
          throw new Error(`source failed: ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  for (const [key, value] of seed) client.setQueryData(key, value);
  render(
    <QueryClientProvider client={client}>
      <Risks />
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

const ALL_CLEAR = /Nothing here needs attention right now/;

describe("Risks when its sources are not in hand", () => {
  it("does not read a failed source as an all-clear", async () => {
    const client = mount([
      [["/api/clients"], CLIENTS],
      [["/api/tests"], []],
      [["/api/users/assignable"], []],
      // ["/api/findings", {clientId: "c1"}] is NOT seeded: its fetch fails.
    ]);
    await waitFor(() =>
      expect(client.getQueryState(["/api/findings", { clientId: "c1" }])?.status).toBe("error"),
    );
    const text = document.body.textContent ?? "";
    expect(text, "failed request rendered as 'nothing needs attention'").not.toMatch(ALL_CLEAR);
    expect(text).not.toMatch(/No findings recorded for this engagement yet/);
    expect(text).not.toMatch(/No open (risks|tracked findings)/);
    expect(text).toMatch(/Could not load findings: source failed/);
    for (const label of ["Total Open Risks", "Critical Risks", "High Risks", "Acknowledged", "Fixed"]) {
      expect(tile(label), `${label} tile`).toBe("—");
    }
    expect(text).not.toMatch(/(^|[^0-9])0%/);
  });

  it("reads findings still loading as loading, not as zero", async () => {
    const client = mount([
      [["/api/clients"], CLIENTS],
      [["/api/tests"], []],
      [["/api/users/assignable"], []],
    ], "never resolves");
    await waitFor(() =>
      expect(client.getQueryState(["/api/findings", { clientId: "c1" }])?.fetchStatus).toBe("fetching"),
    );
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(ALL_CLEAR);
    expect(text).not.toMatch(/No findings recorded/);
    for (const label of ["Total Open Risks", "Critical Risks", "High Risks"]) {
      expect(tile(label), `${label} tile`).toBe("…");
    }
  });

  it("does not give an all-clear when there is no engagement to read", () => {
    mount([
      [["/api/clients"], []],
      [["/api/tests"], []],
      [["/api/users/assignable"], []],
    ]);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(ALL_CLEAR);
    expect(text).toMatch(/No engagement on record yet/);
    expect(tile("Total Open Risks")).toBe("—");
  });

  it("does not give an all-clear when the engagements could not be read", async () => {
    const client = mount([[["/api/tests"], []], [["/api/users/assignable"], []]]);
    await waitFor(() => expect(client.getQueryState(["/api/clients"])?.status).toBe("error"));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(ALL_CLEAR);
    expect(text).toMatch(/Could not load engagements: source failed/);
  });

  // The all-clear also needs the summary's word that the engagement's latest
  // completed scan reported nothing the ledger cannot see (round 2, R2-A).
  const SUMMARY = (untrackedScan: unknown) => ({
    clients: 1, open: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    byEnvironment: [], byMonth: [], topOpen: [],
    byClient: [{ clientId: "c1", open: 0, critical: 0, high: 0, latestSeriousSeenAt: null, untrackedScan }],
  });
  const EMPTY_LEDGER = { findings: [], counts: { open: 0, acknowledged: 0, accepted: 0, fixed: 0 } };

  it("gives the all-clear only for a successful, empty answer", () => {
    mount([
      [["/api/clients"], CLIENTS],
      [["/api/tests"], []],
      [["/api/users/assignable"], []],
      [["/api/findings", { clientId: "c1" }], EMPTY_LEDGER],
      [["/api/findings/summary"], SUMMARY(null)],
    ]);
    const text = document.body.textContent ?? "";
    expect(text).toMatch(ALL_CLEAR);
    expect(text).toMatch(/No findings recorded for this engagement yet/);
    expect(tile("Total Open Risks")).toBe("0");
    // Nothing recorded is not "0% remediated".
    expect(text).not.toMatch(/(^|[^0-9])0%/);
  });

  it("gives no all-clear while the latest completed scan reported criticals the ledger cannot see", () => {
    mount([
      [["/api/clients"], CLIENTS],
      [["/api/tests"], []],
      [["/api/users/assignable"], []],
      [["/api/findings", { clientId: "c1" }], EMPTY_LEDGER],
      [["/api/findings/summary"], SUMMARY({ testId: "t1", completedAt: null, critical: 3, high: 5 })],
    ]);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(ALL_CLEAR);
    expect(text).toMatch(/the latest completed scan reported 3 critical \/ 5 high that are not tracked as findings/);
  });

  it("gives no all-clear when what the latest completed scan reported could not be checked", async () => {
    const client = mount([
      [["/api/clients"], CLIENTS],
      [["/api/tests"], []],
      [["/api/users/assignable"], []],
      [["/api/findings", { clientId: "c1" }], EMPTY_LEDGER],
    ]);
    await waitFor(() => expect(client.getQueryState(["/api/findings/summary"])?.status).toBe("error"));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(ALL_CLEAR);
    expect(text).toMatch(/Could not load what the latest completed scan reported: source failed/);
  });

  it("gives no all-clear for an engagement the summary has not counted yet", () => {
    mount([
      [["/api/clients"], CLIENTS],
      [["/api/tests"], []],
      [["/api/users/assignable"], []],
      [["/api/findings", { clientId: "c1" }], EMPTY_LEDGER],
      [["/api/findings/summary"], { ...SUMMARY(null), byClient: [] }],
    ]);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(ALL_CLEAR);
    expect(text).toMatch(/this engagement is not in the findings summary yet/);
  });
});
