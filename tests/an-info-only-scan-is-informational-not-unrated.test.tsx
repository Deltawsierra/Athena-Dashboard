// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within } from "@testing-library/react";

import { makeApp, signIn } from "./helpers";
import Deployments from "@/pages/Deployments";
import { summarizeFindings } from "../server/findings-summary";

/**
 * PR #52 round 5, R5-J. An engine scan whose every result the engine rated
 * "info" was written by countSeverities as N results, every count 0 and
 * severity null -- which is how a record says "N results, severity never
 * recorded". Deployments drew it "Not rated" and listed it under Highest Risk
 * Deployments, beside results that each carried a severity.
 *
 * countSeverities now records "info" when every counted result was info, and
 * the whole-record reader reads a row written before that the same way from
 * its results. The band is "Informational": not a risk, never listed under
 * Highest Risk. Through the real scan route, with a stand-in engine that
 * finishes the run inline. Adapted from the round-5 reproducer
 * r5-j-info-only-scan-read-as-not-rated.
 */
let server: import("http").Server;
let written: Record<string, unknown> | undefined;

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  const http = await import("http");
  server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/health") return res.end(JSON.stringify({ status: "ok" }));
      res.end(JSON.stringify({ run_id: "run-info", state: "completed", result: { results: [
        { type: "server_banner", severity: "info", evidence: { endpoint: "https://a.example/" } },
        { type: "tls_version", severity: "info", evidence: { endpoint: "https://a.example/" } },
      ] } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(server.address() as import("net").AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  const agent = await signIn(await makeApp());
  const clientId = (await agent.post("/api/clients").send({ name: "Acme App", company: "Acme", email: "a@a.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "App", url: "https://a.example" });
  const started = await agent.post("/api/scans").send({ clientId, target: "https://a.example/" });
  expect(started.status).toBe(201);
  written = ((await agent.get("/api/tests")).body as Array<Record<string, unknown>>).find((one) => one.clientId === clientId);
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(cleanup);

function mount(test: Record<string, unknown>) {
  const CLIENTS = [{ id: test.clientId, name: "Acme App", company: "Acme", status: "active", lastTestDate: null, notes: null }];
  const summary = summarizeFindings({ clients: CLIENTS as never, sites: [], findings: [], tests: [test] as never });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); } } } });
  for (const [k, v] of [
    [["/api/clients"], CLIENTS], [["/api/sites"], []], [["/api/tests"], [test]],
    [["/api/findings/summary"], JSON.parse(JSON.stringify(summary))], [["/api/assurance/deployments"], []],
    [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
    [["/api/auth/check"], { authenticated: true, user: null }],
  ] as Array<[unknown[], unknown]>) client.setQueryData(k, v);
  render(<QueryClientProvider client={client}><Deployments /></QueryClientProvider>);
  return summary;
}

describe("a scan whose every result was rated info is informational, not unrated", () => {
  it("the scan route records the severity the results carry: info", () => {
    expect(written).toMatchObject({
      status: "completed", severity: "info", vulnerabilitiesFound: 2,
      criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
    });
  });

  it("Deployments draws it Informational, and does not list it as a risk", () => {
    const summary = mount(written!);
    const r = screen.getAllByText("Acme App").map((el) => el.closest("tr")).find(Boolean) as HTMLElement;
    expect(within(r).getByText("Informational")).toBeTruthy();
    expect(within(r).queryByText("Not rated")).toBeNull();
    expect(screen.queryByTestId(`highest-risk-${written!.clientId}`)).toBeNull();
    expect(document.body.textContent).toContain("No completed scan has reported a finding rated above info.");
    // Nothing at critical or high, and nothing unrated, to flag.
    expect(summary.byClient[0].untrackedScan).toBeNull();
  });

  it("a row written before the engine's severity was recorded reads the same, from its results", () => {
    mount({ ...written!, severity: null });
    const r = screen.getAllByText("Acme App").map((el) => el.closest("tr")).find(Boolean) as HTMLElement;
    expect(within(r).getByText("Informational")).toBeTruthy();
    expect(screen.queryByTestId(`highest-risk-${written!.clientId}`)).toBeNull();
  });
});
