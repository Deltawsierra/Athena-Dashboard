// @vitest-environment jsdom
/**
 * A scan the engine started without a run id a stop can name shows what stops
 * it -- the Failsafe console, and the kill switch where the engine lists it by
 * a run id -- on every screen that shows the scan, in place of a Stop that
 * cannot reach it. A scan with a run id keeps its Stop, always.
 *
 * Athena and Penetration Testing showed the normal red Stop for such a scan,
 * although the start's answer already said it had no run id. The Stop answered
 * 409, and nothing on the page named the kill switch or the Failsafe console
 * until it was clicked. "Scans running now" left the scan out altogether,
 * while Max Concurrent Tests counted it. The Tests screen listed it as running
 * with no Stop and no word of what stops it, and deleted it at once.
 *
 * The screens show NoStopPanel only where the server said so (`stop:
 * "failsafe"`, or a record with no run id a stop can name). Where the page
 * does not know -- the first read still on its way, or a read that failed --
 * the Stop stays.
 *
 * The panel links the Failsafe console and the AI Control page only for an
 * admin: for anyone else neither is routed, and a link opened "not found".
 * Anyone else is told to ask an admin. And the screen that started such a scan
 * says, beside its Start button, why Start is off -- the scan the engine never
 * named still counts -- and lets it be set aside, still listed under "Scans
 * running now", to start another.
 *
 * Athena and Penetration Testing run against the real routes, served over
 * HTTP and signed in, with an engine each test tells what to answer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";
import Tests from "@/pages/Tests";
import { queryClient } from "@/lib/queryClient";
import { makeApp, signIn } from "./helpers";

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let startBody: (runId: string) => Record<string, unknown>;
const engineSaw: string[] = [];
let engine: Server;
let server: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
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

  engine = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { status: "ok" });
    engineSaw.push(`${req.method} ${url}`);
    if (url === "/api/scans/active") return json(res, 200, { active: [] });
    if (req.method === "POST" && url === "/api/scan") {
      runs += 1;
      return json(res, 200, startBody(`run-${runs}`));
    }
    if (req.method === "POST" && url.endsWith("/abort")) return json(res, 200, {});
    if (req.method === "GET" && url.startsWith("/api/scans/")) return json(res, 200, { state: "running" });
    return json(res, 404, { detail: "not here" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  vi.resetModules();
  const app = await makeApp();
  agent = await signIn(app);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  expect(login.status).toBe(200);
  session = (login.headers.get("set-cookie") ?? "").split(";")[0];
  clientId = (await agent.post("/api/clients").send({ name: "No stop", company: "No stop", email: "n@n.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://nostop.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
  engineSaw.length = 0;
  // Every scan these tests started is recorded as ended, so none is listed as running in the next.
  const { storage } = await import("../server/storage-unified");
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
});

/**
 * Every request the screen sends goes to the real routes, as the signed-in
 * admin. `hold` names the status reads to hold ("pending") or fail ("fail").
 */
function realRoutes(hold: { read?: "pending" | "fail" } = {}) {
  const outbound = globalThis.fetch;
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/")) return outbound(url, init);
    sent.push(`${init?.method ?? "GET"} ${url}`);
    if (hold.read && (init?.method ?? "GET") === "GET" && /^\/api\/scans\/[^/]+$/.test(String(url)) && String(url) !== "/api/scans/active") {
      if (hold.read === "pending") return new Promise<Response>(() => {});
      throw new TypeError("Failed to fetch");
    }
    return outbound(`${base}${url}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), Cookie: session },
    });
  });
  return sent;
}

/** Pick the client, type the target and start the scan, as a person does. */
async function startAScan(target = "https://nostop.example/") {
  await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
  await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
  fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
  fireEvent.change(screen.getByTestId("input-target"), { target: { value: target } });
  await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("button-start-scan"));
}

/** The panel says what stops the scan, and links to it; no Stop is on the page for it. */
function expectPanelNotStop(panel: HTMLElement) {
  expect(panel.textContent).toContain("No Stop can reach this scan");
  expect(panel.textContent).toContain("the engine never named the run");
  expect(panel.textContent).toContain("pause, stand down or terminate the engine");
  expect(panel.querySelector('a[href="/failsafe"]')?.textContent).toBe("Failsafe console");
  expect(panel.querySelector('a[href="/ai-control"]')?.textContent).toBe("kill switch on the AI Control page");
}

for (const [name, Screen] of [["Athena", AthenaScan], ["Penetration testing", PentestScan]] as const) {
  describe(`${name}: a scan the engine started without a run id a stop can name`, () => {
    for (const [label, answer] of [
      ["no run id", {}],
      ["a run id that is only space", { run_id: " " }],
      ["the run id '..'", { run_id: ".." }],
      ["a run id with a '/'", { run_id: "a/b" }],
    ] as const) {
      it(`${label}: the panel stands in place of the Stop, and no stop URL is ever sent`, async () => {
        startBody = () => ({ ...answer, state: "running" });
        const sent = realRoutes();
        render(<QueryClientProvider client={queryClient}><Screen /></QueryClientProvider>);
        await startAScan();
        const panel = await screen.findByTestId("panel-no-stop");
        await waitFor(() => expectPanelNotStop(panel));
        expect(screen.queryByTestId("button-stop-scan")).toBeNull();
        // Start is off while the scan may be running, and says why beside it.
        expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId("text-start-held").textContent).toMatch(
          /^Start is off while this scan may still be running\. The engine never named it, so this page cannot learn when it stops, and it still counts toward Max Concurrent Tests\./,
        );
        // Still so once the scan has been read again.
        await waitFor(() => expect(sent.some((one) => /^GET \/api\/scans\/[0-9a-f-]{36}$/.test(one))).toBe(true));
        expect(screen.getByTestId("panel-no-stop")).toBeTruthy();
        expect(screen.queryByTestId("button-stop-scan")).toBeNull();
        expect(sent.filter((one) => one.endsWith("/abort"))).toEqual([]);
        expect(engineSaw.filter((one) => one.endsWith("/abort"))).toEqual([]);
      });
    }
  });

  describe(`${name}: a scan the engine never named can be set aside to start another`, () => {
    it("Set this scan aside turns Start on, and the scan stays listed under Scans running now with the panel", async () => {
      startBody = () => ({ state: "running" });
      realRoutes();
      render(<QueryClientProvider client={queryClient}><Screen /></QueryClientProvider>);
      await startAScan();
      await screen.findByTestId("panel-no-stop");
      const started = document.querySelector('[data-testid="text-start-held"]');
      expect(started).toBeTruthy();
      fireEvent.click(screen.getByTestId("button-set-aside"));
      await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
      expect(screen.queryByTestId("text-start-held")).toBeNull();
      const listed = await screen.findByTestId("list-running-scans", {}, { timeout: 4_000 }).catch(async () => {
        // The list is read again on its own interval; a refetch brings the set-aside scan in.
        await queryClient.invalidateQueries({ queryKey: ["/api/tests"] });
        return screen.findByTestId("list-running-scans");
      });
      await waitFor(() => expect(listed.querySelector('[data-testid^="panel-no-stop-"]')).toBeTruthy());
    });
  });

  describe(`${name}: a scan with a run id keeps its Stop`, () => {
    it("and no Start note is shown", async () => {
      startBody = (runId) => ({ run_id: runId, state: "running" });
      realRoutes();
      render(<QueryClientProvider client={queryClient}><Screen /></QueryClientProvider>);
      await startAScan();
      await waitFor(() => expect(screen.getByTestId("button-stop-scan")).toBeTruthy());
      expect(screen.queryByTestId("text-start-held")).toBeNull();
    });

    it("while the first read is still on its way", async () => {
      startBody = (runId) => ({ run_id: runId, state: "running" });
      realRoutes({ read: "pending" });
      render(<QueryClientProvider client={queryClient}><Screen /></QueryClientProvider>);
      await startAScan();
      await waitFor(() => expect(screen.getByTestId("button-stop-scan")).toBeTruthy());
      expect(screen.queryByTestId("panel-no-stop")).toBeNull();
    });

    it("after a read fails", async () => {
      startBody = (runId) => ({ run_id: runId, state: "running" });
      const sent = realRoutes({ read: "fail" });
      render(<QueryClientProvider client={queryClient}><Screen /></QueryClientProvider>);
      await startAScan();
      await waitFor(() => expect(sent.some((one) => /^GET \/api\/scans\/[0-9a-f-]{36}$/.test(one))).toBe(true));
      await waitFor(() => expect(screen.getByTestId("button-stop-scan")).toBeTruthy());
      expect(screen.queryByTestId("panel-no-stop")).toBeNull();
      fireEvent.click(screen.getByTestId("button-stop-scan"));
      await waitFor(() => expect(engineSaw.some((one) => /^POST \/api\/scans\/run-\d+\/abort$/.test(one))).toBe(true));
    });
  });
}

describe("Scans running now", () => {
  it("lists a scan started elsewhere with no run id, with the panel in place of its Stop, beside one with its Stop", async () => {
    startBody = () => ({ state: "running" });
    const unnamed = await agent.post("/api/scans").send({ clientId, target: "https://nostop.example/unnamed" });
    startBody = (runId) => ({ run_id: runId, state: "running" });
    const named = await agent.post("/api/scans").send({ clientId, target: "https://nostop.example/named" });
    expect([unnamed.status, named.status]).toEqual([201, 201]);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    const row = await screen.findByTestId(`running-scan-${unnamed.body.test.id}`);
    expect(row.textContent).toContain("https://nostop.example/unnamed");
    expect(row.textContent).toContain("no run id from the engine");
    await waitFor(() => expectPanelNotStop(screen.getByTestId(`panel-no-stop-${unnamed.body.test.id}`)));
    expect(screen.queryByTestId(`button-stop-scan-${unnamed.body.test.id}`)).toBeNull();
    expect(screen.getByTestId(`button-stop-scan-${named.body.test.id}`)).toBeTruthy();
  });
});

describe("the Tests screen", () => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const BASE = {
    clientId: "c1", siteId: null, testType: "penetration-test", startedAt: at, completedAt: null, severity: null,
    summary: "s", vulnerabilitiesFound: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
    executedBy: null, isSample: false,
  };
  const UNNAMED = { ...BASE, id: "unnamed", status: "running", findings: { runId: null, target: "https://acme.example/", results: null } };
  /** A scan the engine started with the id " ": no run id to the screens, but a stop still reaches it by that id. */
  const BLANK = { ...BASE, id: "blank", status: "running", findings: { runId: " ", target: "https://acme.example/", results: null } };
  const ADMIN = { id: "u1", username: "admin", role: "admin" };
  const ANALYST = { id: "u2", username: "analyst", role: "analyst" };
  const NAMED = { ...BASE, id: "named", status: "running", findings: { runId: "run-7", target: "https://acme.example/", results: null } };

  function serve(user: Record<string, unknown> | null = ADMIN) {
    const writes: Array<{ method: string; url: string }> = [];
    const data: Record<string, unknown> = {
      "/api/tests": [UNNAMED, NAMED, BLANK],
      "/api/clients": [{ id: "c1", name: "Acme", company: "Acme", status: "active" }],
      "/api/sites": [],
      "/api/sample-data": { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 },
      "/api/auth/check": { authenticated: true, user },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        writes.push({ method, url: String(url) });
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const found = data[String(url).split("?")[0]];
      return new Response(JSON.stringify(found ?? null), {
        status: found === undefined ? 404 : 200, headers: { "Content-Type": "application/json" },
      });
    }));
    render(<QueryClientProvider client={queryClient}><Tests /></QueryClientProvider>);
    return writes;
  }

  it("shows the panel for a running scan with no run id, and says deleting its record frees its place; a named one keeps its Stop", async () => {
    serve();
    const panel = await screen.findByTestId("panel-no-stop-unnamed");
    await waitFor(() => expectPanelNotStop(panel));
    expect(screen.queryByTestId("button-stop-unnamed")).toBeNull();
    expect(screen.getByTestId("text-no-stop-record-unnamed").textContent).toMatch(/delete this record to free its place\.$/);
    expect(screen.getByTestId("button-stop-named")).toBeTruthy();
    expect(screen.queryByTestId("panel-no-stop-named")).toBeNull();
  });

  it("deletes such a scan only when asked to delete it without a stop, and says no stop can be sent", async () => {
    const writes = serve();
    fireEvent.click(await screen.findByTestId("button-delete-unnamed"));
    const warning = await screen.findByTestId("text-delete-warning-unnamed");
    expect(warning.textContent).toMatch(/no stop can be sent/);
    expect(warning.textContent).toMatch(/Deleting it anyway sends no stop\./);
    const confirm = screen.getByTestId("button-confirm-delete-unnamed");
    expect(confirm.textContent).toBe("Delete without a stop");
    fireEvent.click(confirm);
    await waitFor(() => expect(writes).toEqual([{ method: "DELETE", url: "/api/tests/unnamed?force=1" }]));
  });

  it("for anyone not an admin, links to neither admin page, and says to ask an admin", async () => {
    serve(ANALYST);
    const panel = await screen.findByTestId("panel-no-stop-unnamed");
    await waitFor(() => expect(within(panel).getByTestId("text-ask-an-admin")).toBeTruthy());
    expect(within(panel).getByTestId("text-ask-an-admin").textContent).toMatch(
      /^To stop it, ask an admin to use the Failsafe console \(pause, stand down or terminate the engine\) or the kill switch on the AI Control page/,
    );
    expect(panel.querySelector('a[href="/failsafe"]')).toBeNull();
    expect(panel.querySelector('a[href="/ai-control"]')).toBeNull();
    expect(panel.querySelectorAll("a")).toHaveLength(0);
  });

  it("an admin is given both links, and no ask-an-admin sentence", async () => {
    serve(ADMIN);
    const panel = await screen.findByTestId("panel-no-stop-unnamed");
    await waitFor(() => expect(panel.querySelector('a[href="/failsafe"]')).toBeTruthy());
    expect(within(panel).queryByTestId("text-ask-an-admin")).toBeNull();
  });

  it("a scan the engine started with the id \" \" shows the panel, and is deleted without force: a stop still reaches it", async () => {
    const writes = serve();
    await screen.findByTestId("panel-no-stop-blank");
    expect(screen.queryByTestId("button-stop-blank")).toBeNull();
    fireEvent.click(screen.getByTestId("button-delete-blank"));
    expect((await screen.findByTestId("text-delete-warning-blank")).textContent).toMatch(/a stop can still reach it by that id/);
    expect(screen.getByTestId("button-confirm-delete-blank").textContent).toBe("Delete");
    fireEvent.click(screen.getByTestId("button-confirm-delete-blank"));
    await waitFor(() => expect(writes).toEqual([{ method: "DELETE", url: "/api/tests/blank" }]));
  });

  it("a named running scan is deleted without force: its stop is sent first, by the server", async () => {
    const writes = serve();
    fireEvent.click(await screen.findByTestId("button-delete-named"));
    expect(screen.getByTestId("button-confirm-delete-named").textContent).toBe("Delete");
    fireEvent.click(screen.getByTestId("button-confirm-delete-named"));
    await waitFor(() => expect(writes).toEqual([{ method: "DELETE", url: "/api/tests/named" }]));
  });
});
