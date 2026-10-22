// @vitest-environment jsdom
/**
 * Each surface says which record it shows, by source.
 *
 * The dashboard dispatches its scans to the engine itself and records them
 * here, from the engine's own answers; the Assurance page reads the backend's
 * record of the assessments the backend launched. The Overview counted both
 * populations side by side with nothing to say so, and neither scan page said
 * that no backend verdict, claim or report applies to the scan it shows.
 *
 * Until dashboard scans are routed through Athena-Backend (planned apart from
 * this), each surface is labelled by SOURCE -- never by era or "world"
 * (client/src/lib/sourceLabels.ts): beneath the Overview's headline tiles,
 * which record each counting tile counts; on both scan pages, where this scan
 * is recorded; at the top of the Risks page's register, where its findings are
 * recorded; on the Assurance page, which record it reads. No plumbing, no
 * mapping: words only, each held to the persona lint.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import Overview from "@/pages/Overview";
import Assurance from "@/pages/Assurance";
import Risks from "@/pages/Risks";
import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";
import { queryClient } from "@/lib/queryClient";
import { summarizeFindings } from "../server/findings-summary";
import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

let hybrid: HybridBackendStandIn | null = null;
const DASHBOARD_DIRECT = "Recorded by this dashboard directly from the engine; not in the Athena-Backend record";
const BACKEND_RECORD = "From the Athena-Backend record";
const OVERVIEW_SOURCES =
  `Open Findings — ${DASHBOARD_DIRECT}. Assurance Decisions — ${BACKEND_RECORD}. ` +
  "The two tiles count separate populations and are not reconciled here.";
const ASSURANCE_SCOPE =
  "This page describes assessments launched through Athena-Backend. A scan started from this dashboard's " +
  "Athena or Penetration Testing page is not in that record; it is recorded by this dashboard directly from the engine.";

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let engine: Server;
let server: Server;
let base: string;
let session: string;
let clientId: string;
let runs = 0;

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;

  // A stand-in engine that accepts every scan and keeps it running, for the scan pages.
  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/api/scans/active") return json(res, 200, { active: [] });
    if (req.method === "POST" && url === "/api/scan") {
      runs += 1;
      return json(res, 202, { run_id: `run-${runs}`, state: "running" });
    }
    if (req.method === "GET" && url.startsWith("/api/scans/run-")) return json(res, 200, { state: "running", done: false, result: null });
    return json(res, 404, { detail: "not here" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  hybrid = await hybridBackendStandIn({ engine: { url: process.env.ATHENA_ENGINE_URL!, key: process.env.ATHENA_ENGINE_KEY } });
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  vi.resetModules();
  const app = await makeApp();
  const agent = await signIn(app);
  await signInToBackend(agent);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: TEST_ADMIN_PASSWORD }),
  });
  expect(login.status).toBe(200);
  session = (login.headers.get("set-cookie") ?? "").split(";")[0];
  clientId = (await agent.post("/api/clients").send({ name: "Labelled", company: "Labelled", email: "l@l.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://labelled.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_FAILSAFE_URL;
  await hybrid?.close();
  hybrid = null;
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  // Every scan started here is recorded as ended, so none counts against another suite.
  const { storage } = await import("../server/storage-unified");
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
  engine.closeAllConnections?.();
  server.closeAllConnections?.();
  await new Promise<void>((r) => engine.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
});

/** A page over a seeded cache: every source answers from `seed`, and any other read is an error, never a loading state. */
function mountSeeded(ui: ReactElement, seed: Array<[unknown[], unknown]>) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => { throw new Error(`unexpected ${JSON.stringify(queryKey)}`); },
      },
    },
  });
  for (const [k, v] of seed) client.setQueryData(k, v);
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Every request a scan page sends goes to the real routes, as the signed-in admin. */
function realRoutes() {
  const outbound = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/")) return outbound(url, init);
    return outbound(`${base}${url}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), Cookie: session },
    });
  });
}

const EMPTY_SUMMARY = () => summarizeFindings({ clients: [], sites: [], findings: [] });
const COMMON_SEED: Array<[unknown[], unknown]> = [
  [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
  [["/api/auth/check"], { authenticated: true, user: null }],
];

describe("Overview", () => {
  it("says beneath the headline tiles which record each counting tile counts", () => {
    mountSeeded(<Overview />, [
      [["/api/clients"], []], [["/api/sites"], []], [["/api/tests"], []], [["/api/assurance/deployments"], []],
      [["/api/findings/summary"], EMPTY_SUMMARY()],
      ...COMMON_SEED,
    ]);
    expect(screen.getByTestId("text-overview-sources").textContent).toBe(OVERVIEW_SOURCES);
    // The two tiles it names are the two tiles on the page.
    expect(screen.getByTestId("overview-metric-findings").textContent).toContain("Open Findings");
    expect(screen.getByTestId("overview-metric-decisions").textContent).toContain("Assurance Decisions");
  });
});

describe("Risks", () => {
  const CLIENT = { id: "c1", name: "Acme", company: "Acme", status: "active", lastTestDate: null, notes: null };
  const FINDING = {
    id: "f1", clientId: "c1", siteId: null, type: "sql_injection", severity: "high", message: "SQL error with crafted payload",
    status: "open", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), target: "https://app.example",
    endpoint: "https://app.example/login", ownerId: null, sightings: [], checks: [],
  };

  it("says at the top of its register where the findings are recorded", () => {
    mountSeeded(<Risks />, [
      [["/api/clients"], [CLIENT]], [["/api/tests"], []], [["/api/sites"], []], [["/api/users/assignable"], []],
      [["/api/assurance/deployments"], []],
      [["/api/findings/summary"], summarizeFindings({ clients: [CLIENT], sites: [], findings: [FINDING] as never })],
      [["/api/findings", { clientId: "c1" }], { findings: [FINDING], counts: { open: 1, acknowledged: 0, accepted: 0, fixed: 0 } }],
      ...COMMON_SEED,
    ]);
    expect(screen.getByTestId("text-risks-source").textContent).toBe(`${DASHBOARD_DIRECT}.`);
    // The register it heads is on the page, with the finding in it.
    expect(document.body.textContent ?? "").toContain("Risk Register");
    expect(document.body.textContent ?? "").toContain("SQL error with crafted payload");
  });

  it("says so with no engagement on record too", () => {
    mountSeeded(<Risks />, [
      [["/api/clients"], []], [["/api/tests"], []], [["/api/sites"], []], [["/api/users/assignable"], []],
      [["/api/assurance/deployments"], []], [["/api/findings/summary"], EMPTY_SUMMARY()],
      ...COMMON_SEED,
    ]);
    expect(screen.getByTestId("text-risks-source").textContent).toBe(`${DASHBOARD_DIRECT}.`);
  });
});

describe("Assurance", () => {
  const seedWith = (status: Record<string, unknown>): Array<[unknown[], unknown]> => [
    [["/api/assurance/status"], status],
    [["/api/assurance/deployments"], []], [["/api/assurance/findings"], []], [["/api/assurance/unknowns"], []],
    [["/api/assurance/assets"], []], [["/api/assurance/providers"], []],
  ];

  it("says it reads the Athena-Backend record, and that a scan this dashboard dispatched is not in it", () => {
    mountSeeded(<Assurance />, seedWith({ configured: true, reachable: true, authorized: true, url: null, detail: "" }));
    expect(screen.getByTestId("text-assurance-source").textContent).toBe(BACKEND_RECORD);
    expect(screen.getByTestId("text-assurance-scope").textContent).toBe(ASSURANCE_SCOPE);
  });

  it("says so with no control plane configured too", () => {
    mountSeeded(<Assurance />, seedWith({
      configured: false, reachable: null, authorized: null, url: null, detail: "no control plane is configured",
    }));
    expect(screen.getByTestId("text-assurance-source").textContent).toBe(BACKEND_RECORD);
    expect(screen.getByTestId("text-assurance-scope").textContent).toBe(ASSURANCE_SCOPE);
  });
});

for (const [name, Screen] of [["Athena", AthenaScan], ["Penetration testing", PentestScan]] as const) {
  describe(`${name}: the scan it shows`, () => {
    it("says where the scan is recorded, as soon as there is a scan to show", async () => {
      realRoutes();
      render(<QueryClientProvider client={queryClient}><Screen /></QueryClientProvider>);
      await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
      await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
      fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
      fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://labelled.example/" } });
      fireEvent.click(screen.getByTestId("checkbox-consent"));
      await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByTestId("button-start-scan"));
      await waitFor(() => expect(screen.getByTestId("text-state").textContent).toContain("running"), { timeout: 6_000 });
      expect(screen.getByTestId("text-scan-source").textContent).toBe(`${DASHBOARD_DIRECT}.`);
      // Said by source: never by era, never as a promise about the backend, never as the old phrase.
      expect(document.body.textContent ?? "").not.toMatch(/legacy|backend will record|deployment assurance/i);
      // The Stop is where it always was.
      expect(screen.getByTestId("button-stop-scan")).toBeTruthy();
    });
  });
}
