// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";

import Compliance from "@/pages/Compliance";
import { ASVS_VERSION } from "@shared/asvs";
import { ASVS_CURRENT_RELEASE, ASVS_MAPPED_VERSION } from "@shared/asvs-edition";

/**
 * The ASVS mapping is pinned to 4.0.3 (owner decision, 25 Sep 2026) while
 * 5.0.0 is the current release, and it maps what was tested -- it is not a
 * conformance claim. The Compliance page showed neither: a green "Active"
 * badge beside the framework, a "Readiness" ring, and "nothing is currently
 * in breach" whenever no mapped requirement failed.
 *
 * These tests hold the page to saying the edition, that 5.0.0 is current, and
 * what the mapping is, on every panel that renders it -- including before the
 * engagement's mapping has loaded.
 */

afterEach(cleanup);

const CLIENTS = [{ id: "c1", name: "Northwind", status: "active" }];
const TESTS = [{ clientId: "c1", startedAt: "2026-09-20T00:00:00Z", completedAt: "2026-09-20T01:00:00Z" }];

const requirement = (id: string) => ({
  id, chapter: "V5", section: "V5.3", cwe: null, l1: true, l2: true, l3: true,
});

function view(failing: boolean) {
  return {
    client: { id: "c1", name: "Northwind" },
    testsConsidered: 1,
    scannersLoaded: 5,
    rows: [
      { requirement: requirement("V5.3.4"), state: failing ? "failing" : "tested", findings: failing ? [{ type: "sql_injection", severity: "high" }] : [], scanners: ["sqli"], approximate: false },
      { requirement: requirement("V5.3.3"), state: "tested", findings: [], scanners: ["xss"], approximate: false },
      { requirement: requirement("V1.1.1"), state: "not_covered", findings: [], scanners: [], approximate: false },
    ],
    summary: { version: "4.0.3", failing: failing ? 1 : 0, tested: failing ? 1 : 2, notRun: 0, notCovered: 1, total: 3 },
  };
}

function mount(compliance: unknown | undefined) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          throw new Error(`unexpected fetch for ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  client.setQueryData(["/api/clients"], CLIENTS);
  client.setQueryData(["/api/tests"], TESTS);
  if (compliance !== undefined) client.setQueryData(["/api/compliance/c1"], compliance);
  return render(
    <QueryClientProvider client={client}>
      <Compliance />
    </QueryClientProvider>,
  );
}

function statesTheEdition() {
  expect(screen.getByTestId("asvs-version").textContent).toBe("OWASP ASVS 4.0.3");
  const statement = screen.getByTestId("asvs-mapping-statement").textContent ?? "";
  expect(statement).toContain("Pinned to OWASP ASVS 4.0.3");
  expect(statement).toContain("not a conformance claim");
  expect(statement).toContain("ASVS 5.0.0 is the current release");
  const coverage = screen.getByTestId("asvs-coverage-note").textContent ?? "";
  expect(coverage).toContain("ASVS 4.0.3");
  expect(coverage).toContain("not a conformance score");
  expect(coverage).toContain("ASVS 5.0.0 is the current release");
  expect(screen.getByText(/Findings mapped to ASVS 4\.0\.3 requirements\. A mapping of what was tested, not a conformance claim\./)).toBeTruthy();
  // No badge or label that reads as a verdict against the standard.
  expect(screen.queryByText("Active")).toBeNull();
  expect(screen.queryByText("Readiness")).toBeNull();
}

describe("the ASVS edition and what the mapping is", () => {
  it("the mapping is still pinned to 4.0.3, and 5.0.0 is named as current", () => {
    // If the generated catalogue is ever regenerated against another edition,
    // this fails -- and every sentence below has to be re-read with it.
    expect(ASVS_VERSION).toBe("4.0.3");
    expect(ASVS_MAPPED_VERSION).toBe(ASVS_VERSION);
    expect(ASVS_CURRENT_RELEASE).toBe("5.0.0");
  });

  it("is stated on every panel that renders the mapping", () => {
    mount(view(true));
    statesTheEdition();
  });

  it("is stated before the engagement's mapping has loaded", () => {
    // The compliance read is not seeded, so it fails: the edition shown is the
    // one this build's mapping is pinned to, not a literal someone typed.
    mount(undefined);
    statesTheEdition();
  });

  it("does not call an absence of failing requirements an absence of breach", () => {
    mount(view(false));
    expect(document.body.textContent).not.toMatch(/breach/i);
    expect(
      screen.getByText("No mapped requirement is failing in the tests considered. Requirements not run or not covered were not checked."),
    ).toBeTruthy();
  });
});
