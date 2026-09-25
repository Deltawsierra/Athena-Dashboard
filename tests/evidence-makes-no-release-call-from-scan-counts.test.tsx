// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

import Evidence from "@/pages/Evidence";

/**
 * Evidence's "Release Recommendation" took the newest test of ANY status and,
 * finding no critical or high count on it, said "Ready for controlled release"
 * under a green check (adversary round 1, F2). A scan that is still running,
 * has not started or has failed has zero counts, so an unfinished scan read as
 * a clean result and a release recommendation. And severity counts alone are
 * never a release decision: Athena's release decision is the assurance
 * decision, a human's to make from the evidence.
 *
 * The card now describes the latest COMPLETED scan's counts and makes no
 * release call. The first test is the adversary's reproducer.
 */

afterEach(cleanup);

const now = () => new Date().toISOString();
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function mount(seed: Array<[unknown[], unknown]>) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          throw new Error(`source failed: ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  for (const [key, value] of seed) client.setQueryData(key, value);
  render(
    <QueryClientProvider client={client}>
      <Evidence />
    </QueryClientProvider>,
  );
  return client;
}

const base = (tests: unknown[]): Array<[unknown[], unknown]> => [
  [["/api/documents"], []],
  [["/api/users/assignable"], []],
  [["/api/clients"], [{ id: "c1", name: "Payments API", status: "active" }]],
  [["/api/tests"], tests],
];

function card(): string {
  return screen.getByTestId("evidence-latest-scan").textContent ?? "";
}

describe("Evidence's scan card", () => {
  it("does not say 'Ready for controlled release' for a scan that is still running", () => {
    mount(base([{
      id: "t1", clientId: "c1", status: "running", severity: null, completedAt: null,
      startedAt: now(), criticalCount: 0, highCount: 0,
    }]));
    expect(document.body.textContent ?? "").not.toMatch(/Ready for controlled release/);
    expect(card()).toContain("No completed scan yet");
    expect(card()).toContain("1 not finished or failed");
  });

  it("makes no release call even when the latest completed scan reported nothing serious", () => {
    mount(base([{
      id: "t1", clientId: "c1", status: "completed", severity: null, completedAt: now(),
      startedAt: now(), criticalCount: 0, highCount: 0,
    }]));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Ready for|release\./i);
    expect(text).not.toMatch(/Resolve before release/);
    expect(card()).toContain("Payments API");
    expect(card()).toContain("reported 0 critical and 0 high findings");
    expect(card()).toMatch(/not a release decision/);
  });

  it("reads the latest completed scan, not a newer one that failed or is pending", () => {
    mount(base([
      {
        id: "done", clientId: "c1", status: "completed", severity: "high", completedAt: ago(5),
        startedAt: ago(6), criticalCount: 1, highCount: 2,
      },
      { id: "failed", clientId: "c1", status: "failed", severity: null, completedAt: ago(1), startedAt: ago(2), criticalCount: 0, highCount: 0 },
      { id: "pending", clientId: "c1", status: "pending", severity: null, completedAt: null, startedAt: now(), criticalCount: 0, highCount: 0 },
    ]));
    expect(card()).toContain("reported 1 critical and 2 high findings");
  });

  it("counts tests as tests on record, not as scans with a decision", () => {
    mount(base([
      { id: "a", clientId: "c1", status: "completed", severity: null, completedAt: now(), startedAt: now(), criticalCount: 0, highCount: 0 },
      { id: "b", clientId: "c1", status: "running", severity: null, completedAt: null, startedAt: now(), criticalCount: 0, highCount: 0 },
    ]));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Scans with a decision/);
    const tile = screen.getByText("Tests on record").closest("div")?.parentElement;
    expect(tile?.querySelector(".athena-figure")?.textContent).toBe("2");
    expect(tile?.textContent).toContain("1 completed");
  });

  it("reads failed sources as unknown, never as an empty record", async () => {
    const client = mount([]);
    await waitFor(() => expect(client.getQueryState(["/api/documents"])?.status).toBe("error"));
    await waitFor(() => expect(client.getQueryState(["/api/tests"])?.status).toBe("error"));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/No documents on record yet/);
    expect(text).not.toMatch(/No completed scan yet/);
    expect(text).toMatch(/Could not load documents: source failed/);
    expect(card()).toMatch(/Could not load scans: source failed/);
    for (const label of ["Documents", "Reports", "Document Types", "Tests on record"]) {
      const tile = screen.getByText(label).closest("div")?.parentElement;
      expect(tile?.querySelector(".athena-figure")?.textContent, `${label} tile`).toBe("—");
    }
  });
});
