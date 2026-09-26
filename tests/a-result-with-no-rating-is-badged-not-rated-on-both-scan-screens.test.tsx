// @vitest-environment jsdom
/**
 * A result with no rating is badged "Not rated" on both scan screens, never
 * "Info"; and a rating the engine sent padded or in capitals is read as that
 * rating on the screens, as everywhere else.
 *
 * Both screens badged a result by lower-casing its severity, and anything that
 * was not then a rating -- missing, "severe", " high" -- was badged "Info",
 * which says "not a risk". On Athena that sat beside a risk band that read the
 * same result as "Not rated" ("Findings were recorded with no severity", any of
 * which may be critical); Penetration Testing labelled it "info" beside a total
 * that counted it. A result the engine rated " high" was badged "Info" under a
 * band that said it had no severity. The badge now reads the severity as every
 * other reader does (shared/latest-scans.ts ratingOf), and says "Not rated",
 * muted, for a result with none.
 *
 * And "Not rated" is said over a scan that was stopped or failed with such a
 * result, as over one that completed -- never "Clear".
 *
 * These drive each screen against the real routes, served over HTTP and signed
 * in, with an engine each test tells what to answer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import AthenaScan from "@/pages/AthenaScan";
import PentestScan from "@/pages/PentestScan";
import { queryClient } from "@/lib/queryClient";
import { makeApp, signIn } from "./helpers";

const UNRATED = { type: "banner", message: "Server header" };
const PADDED_HIGH = { type: "sqli", severity: " high", message: "Injectable id" };

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** What the engine answers a start and a poll with; each test sets its own. */
let startBody: (runId: string) => Record<string, unknown>;
let pollAnswer: () => [number, Record<string, unknown>] = () => [404, { detail: "not asked" }];
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
    if (url === "/api/scans/active") return json(res, 200, { active: [] });
    if (req.method === "POST" && url === "/api/scan") {
      runs += 1;
      return json(res, 200, startBody(`run-${runs}`));
    }
    if (req.method === "GET" && url.startsWith("/api/scans/run-")) return json(res, ...pollAnswer());
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
  clientId = (await agent.post("/api/clients").send({ name: "Rated", company: "Rated", email: "r@r.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://rated.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
  await new Promise<void>((r) => engine.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
  pollAnswer = () => [404, { detail: "not asked" }];
});

/** Every request the screen sends goes to the real routes, as the signed-in admin. */
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

/** A run the engine finishes inline with `results`. */
const finishesInline = (results: unknown) => {
  startBody = (runId) => ({ run_id: runId, state: "completed", result: { results } });
};

/** Pick the client, type the target and start the scan, as a person does; wait for the scan's `state`. */
async function startAScan(state: string) {
  await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
  await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
  fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
  fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://rated.example/" } });
  await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("button-start-scan"));
  await waitFor(() => expect(screen.getByTestId("text-state").textContent).toContain(state), { timeout: 6_000 });
}

/** The badge of each result listed, in order. */
async function badges() {
  await waitFor(() => expect(screen.getByTestId("list-findings")).toBeTruthy());
  return screen.getAllByTestId("badge-severity");
}

const text = () => document.body.textContent ?? "";

describe("Athena: a result with no rating", () => {
  it("is badged Not rated, muted, beside a band that says the same -- never Info", async () => {
    finishesInline([UNRATED]);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("completed");
    const [badge] = await badges();
    expect(badge.textContent).toBe("Not rated");
    expect(badge.getAttribute("style")).toMatch(/--muted-foreground/);
    // The row's border too: a severity colour that does not exist ("--sev-unrated") drew none (round 5).
    expect(badge.closest("li")!.getAttribute("style")).toMatch(/--muted-foreground/);
    expect(screen.getByTestId("text-risk-band").textContent).toBe("Not rated");
    expect(screen.getByTestId("list-findings").textContent).not.toMatch(/Info/);
  });

  it("is badged Not rated for a word that is no rating, and a result rated info is still badged Info", async () => {
    finishesInline([{ type: "odd", severity: "severe", message: "?" }, { type: "banner", severity: "info", message: "Server header" }]);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("completed");
    expect((await badges()).map((one) => one.textContent)).toEqual(["Not rated", "Info"]);
  });

  for (const end of ["aborted", "failed"] as const) {
    it(`reads Not rated over a scan that ${end} with such a result, never Clear`, async () => {
      startBody = (runId) => ({ run_id: runId, state: "running" });
      pollAnswer = () => [200, { state: end, result: { results: [UNRATED] } }];
      realRoutes();
      render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
      await startAScan(end);
      await waitFor(() => expect(screen.getByTestId("text-risk-band").textContent).toBe("Not rated"));
      expect(screen.getByTestId("text-risk-band").getAttribute("style")).toMatch(/--muted-foreground/);
      expect(screen.getByTestId("text-risk-basis").textContent).toBe(
        "Findings were recorded with no severity, so no band is derived from them.",
      );
      expect(screen.getByTestId("text-total").textContent).toBe("1");
      expect(text()).not.toMatch(/Clear|returned no (gradable )?findings/);
    });
  }
});

describe("Penetration testing: a result with no rating", () => {
  it("is labelled not rated, never info", async () => {
    finishesInline([UNRATED]);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><PentestScan /></QueryClientProvider>);
    await startAScan("completed");
    const [badge] = await badges();
    expect(badge.textContent).toBe("not rated");
    expect(badge.getAttribute("style")).toMatch(/--muted-foreground/);
    expect(badge.closest("li")!.getAttribute("style")).toMatch(/--muted-foreground/);
    expect(screen.getByTestId("text-count-total").textContent).toBe("1");
  });
});

describe("a result the engine rated ' high', padded", () => {
  it("Athena badges it High and counts it in the Elevated band, never 'recorded with no severity'", async () => {
    finishesInline([PADDED_HIGH]);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("completed");
    const [badge] = await badges();
    expect(badge.textContent).toBe("High");
    expect(screen.getByTestId("text-count-high").textContent).toBe("1");
    expect(screen.getByTestId("text-risk-band").textContent).toBe("Elevated");
    expect(screen.getByTestId("text-risk-basis").textContent).not.toMatch(/no severity/);
  });

  it("Penetration testing labels it high and counts it", async () => {
    finishesInline([PADDED_HIGH]);
    realRoutes();
    render(<QueryClientProvider client={queryClient}><PentestScan /></QueryClientProvider>);
    await startAScan("completed");
    const [badge] = await badges();
    expect(badge.textContent).toBe("high");
    expect(screen.getByTestId("text-count-high").textContent).toBe("1");
  });
});
