// @vitest-environment jsdom
/**
 * Risks and the Overview read a finding no severity rates -- none recorded, or
 * a word that is no rating -- as "Not rated", never "Info"; and a rating
 * stored with space or capitals (a row filed before round 4) as that rating.
 *
 * Both screens lower-cased the stored severity and read anything else as
 * info. On Risks such a finding was a gray "Info" pill with impact "Low", the
 * Athena Reasoning line called it "info severity", and the heatmap counted it
 * in none of its columns; a row filed as " high" was "Info" too. The Overview
 * listed it among the top open issues with an "Info" pill, and the trend left
 * it out without a word. Now it is "Not rated" (muted), its impact "Unknown"
 * (none is invented), the reasoning line says no severity is recorded, the
 * heatmap has a "Not rated" column, and the trend says how many it does not draw.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";

import { asSeverity } from "@/pages/Assurance";
import Overview from "@/pages/Overview";
import Risks from "@/pages/Risks";
import { summarizeFindings } from "../server/findings-summary";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const CLIENTS = [{ id: "c1", name: "Payments API", status: "active", lastTestDate: null }];
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

function client(seed: Array<[unknown[], unknown]>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity, queryFn: async () => new Promise(() => {}) } },
  });
  for (const [key, value] of seed) qc.setQueryData(key, value);
  return qc;
}

const riskFinding = (id: string, severity: string | null, message: string) => ({
  id, type: "odd", severity, message, target: "https://r5.example/", endpoint: "/x", status: "open", ownerId: null,
});

function mountRisks(findings: ReturnType<typeof riskFinding>[]) {
  const qc = client([
    [["/api/clients"], CLIENTS],
    [["/api/tests"], []],
    [["/api/users/assignable"], []],
    [["/api/findings", { clientId: "c1" }], { findings, counts: { open: findings.length } }],
    [["/api/findings/summary"], {
      clients: 1, open: { total: findings.length, critical: 0, high: 0, medium: 0, low: 0, unrated: 0, info: 0 },
      byEnvironment: [], byMonth: [], topOpen: [],
      byClient: [{ clientId: "c1", open: findings.length, critical: 0, high: 0, latestSeriousSeenAt: null, untrackedScan: null }],
    }],
  ]);
  render(<QueryClientProvider client={qc}><Risks /></QueryClientProvider>);
}

/** The register's rows, as the cells of each. */
const registerRows = () => Array.from(document.querySelectorAll("tbody tr"))
  .filter((tr) => tr.querySelector('[data-testid="pill-severity"]'))
  .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? ""));

describe("Risks", () => {
  for (const [label, severity] of [["a word that is no rating", "severe"], ["no severity recorded", null], ["an empty severity", ""]] as const) {
    it(`reads ${label} as Not rated, muted, with no impact invented and a reasoning line that says so`, () => {
      mountRisks([riskFinding("f1", severity, "Something odd")]);
      const [row] = registerRows();
      expect(row[1]).toBe("Not rated");
      expect(row[5]).toBe("Unknown");
      const pill = document.querySelector('tbody tr [data-testid="pill-severity"]') as HTMLElement;
      expect(pill.getAttribute("style")).toMatch(/--muted-foreground/);
      expect(document.body.textContent).toContain("\"Something odd\" — no severity recorded on https://r5.example/.");
      expect(document.body.textContent).not.toMatch(/info severity/);
    });
  }

  it("reads a rating stored with space or capitals as that rating, and ranks Not rated below low and above info", () => {
    mountRisks([
      riskFinding("f1", "info", "Banner"),
      riskFinding("f2", null, "Unrated"),
      riskFinding("f3", " high", "Padded"),
      riskFinding("f4", "LOW", "Shouted"),
    ]);
    expect(registerRows().map((row) => [row[1], row[2], row[5]])).toEqual([
      ["High", "Padded", "High"],
      ["Low", "Shouted", "Low"],
      ["Not rated", "Unrated", "Unknown"],
      ["Info", "Banner", "Low"],
    ]);
  });

  it("counts a finding no severity rates in the heatmap's own Not rated column", () => {
    mountRisks([riskFinding("f1", null, "Unrated"), riskFinding("f2", "medium", "Rated")]);
    const heat = Array.from(document.querySelectorAll("table")).find((table) => /Not rated/.test(table.querySelector("thead")?.textContent ?? ""))!;
    expect(Array.from(heat.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual(["", "Critical", "High", "Medium", "Low", "Not rated", "Total"]);
    expect(Array.from(heat.querySelectorAll("tbody tr td")).map((td) => td.textContent)).toEqual(["Odd", "0", "0", "1", "0", "1", "2"]);
  });
});

describe("the Assurance console's severity pill", () => {
  it("reads a severity that is missing or no rating as Not rated, and any case or padding as its rating", () => {
    expect(["", "severe", " HIGH ", "Critical", "info"].map((one) => asSeverity(one)))
      .toEqual(["unrated", "unrated", "high", "critical", "info"]);
    expect(asSeverity(null as unknown as string)).toBe("unrated");
  });
});

describe("the Overview", () => {
  const FINDINGS = [
    { id: "a", clientId: "c1", siteId: null, type: "odd", severity: null, message: "Unrated one", status: "open", firstSeenAt: iso(3), lastSeenAt: iso(3) },
    { id: "b", clientId: "c1", siteId: null, type: "odd", severity: "severe", message: "Odd word", status: "open", firstSeenAt: iso(3), lastSeenAt: iso(3) },
    { id: "c", clientId: "c1", siteId: null, type: "odd", severity: "info", message: "Banner", status: "open", firstSeenAt: iso(3), lastSeenAt: iso(3) },
    { id: "d", clientId: "c1", siteId: null, type: "odd", severity: "low", message: "Low one", status: "open", firstSeenAt: iso(3), lastSeenAt: iso(3) },
  ];

  function mountOverview() {
    const qc = client([
      [["/api/clients"], CLIENTS],
      [["/api/sites"], []],
      [["/api/tests"], []],
      [["/api/assurance/deployments"], []],
      [["/api/findings/summary"], summarizeFindings({
        clients: CLIENTS, sites: [], findings: FINDINGS as unknown as Parameters<typeof summarizeFindings>[0]["findings"],
      })],
      [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
      [["/api/auth/check"], { authenticated: true, user: null }],
    ]);
    render(<QueryClientProvider client={qc}><Overview /></QueryClientProvider>);
  }

  it("lists a top open issue no severity rates as Not rated, never Info, below low and above info", () => {
    mountOverview();
    const panel = screen.getByTestId("overview-panel-issues");
    const rows = Array.from(panel.querySelectorAll("li")).map((li) => [
      li.querySelector(".truncate")?.textContent, within(li).getByTestId("pill-severity").textContent,
    ]);
    expect(rows).toEqual([["Low one", "Low"], ["Unrated one", "Not rated"], ["Odd word", "Not rated"], ["Banner", "Info"]]);
  });

  it("says how many findings no severity rates the trend does not draw, never dropping them silently", () => {
    mountOverview();
    expect(screen.getByTestId("text-trend-unrated").textContent).toBe(
      "2 findings with no severity recorded in these months are not drawn: they are not rated, and may be critical.",
    );
  });
});
