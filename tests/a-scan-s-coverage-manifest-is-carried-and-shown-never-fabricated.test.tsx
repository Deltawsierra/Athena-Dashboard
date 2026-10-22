// @vitest-environment jsdom
/**
 * A scan's coverage manifest -- what the engine checked, and what it did not --
 * is carried to the screens and shown, and never fabricated.
 *
 * Every run result the engine returns carries `coverage` (athena-engine
 * engine/core.py; shape engine/coverage.py resolve: `complete`, `checks`,
 * `not_performed`, `degraded`, `unmeasured`, `limitations`, `notes`). The relay
 * read only `result.results`, the record carried only runId/target/results, and
 * the scan screens listed a run's findings with nothing beside them saying which
 * checks ran -- so "no findings" could not be read against the list of what was
 * asked.
 *
 * Now `runState` and `startScan` read `result.coverage` from the same bounded
 * answer, the scan route records it as the run's own key (refused when a person
 * supplies one, kept through a person's edit of the notes), GET /api/scans/:testId
 * answers it whole, and both screens draw it: performed, degraded (probes lost),
 * not performed (the engine's reason and detail), unmeasured, declared limits,
 * notes, and the `complete` flag as the engine sent it, under one source line
 * ("Read directly from the engine for this run. ..."). A record with no
 * manifest says the engine sent none -- never "complete", never an empty one --
 * and a run still going says the manifest is reported when the run ends.
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
import { readCoverage } from "@shared/scan-coverage";
import type { IStorage } from "../server/storage";
import { makeApp, signIn, signInToBackend } from "./helpers";
import { hybridBackendStandIn, type HybridBackendStandIn } from "./helpers/hybrid-backend-stand-in";
import { TEST_ADMIN_PASSWORD } from "./test-admin";

/** A manifest in the engine's shape at pin aa41bb9af566 (engine/coverage.py _Manifest.resolve). */
let hybrid: HybridBackendStandIn | null = null;
const MANIFEST = {
  complete: false,
  checks: [
    { check: "cors", team: "blue", state: "performed", probes_attempted: 12, probes_failed: 0 },
    { check: "csrf", team: "blue", state: "performed", probes_attempted: 4, probes_failed: 0 },
    {
      check: "header_injection", team: "red", state: "degraded", probes_attempted: 8, probes_failed: 3,
      lost_on: { "GET https://covered.example/search": 3 }, lost_unplaced: 0, answered_on: ["https://covered.example/"],
    },
    { check: "idor", team: "red", state: "not_performed", reason: "precondition", detail: "IDOR needs two identities; one was configured." },
    { check: "sqli", team: "red", state: "not_performed", reason: "not_reached", detail: "The scan stopped before this check ran: stopped by an operator" },
    { check: "tls", team: "blue", state: "unmeasured" },
  ],
  not_performed: ["idor", "sqli"],
  degraded: ["header_injection"],
  unmeasured: ["tls"],
  limitations: { header_injection: ["Raw CRLF header injection is not probed."] },
  notes: ["Surface discovery incomplete: robots.txt could not be read"],
};
const COMPLETE_FALSE =
  "The engine states this manifest is not complete: at least one check did not run, lost probes, or could not say " +
  "what it looked at.";
const NOT_SENT =
  "The engine sent no coverage manifest for this scan, so which checks ran is not known from here. " +
  "That is not the same as every check having run.";
const SOURCE =
  "Read directly from the engine for this run. Recorded by this dashboard directly from the engine; " +
  "not in the Athena-Backend record.";
const PENDING = "Reported by the engine when the run ends.";

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let startBody: (runId: string) => Record<string, unknown>;
let pollAnswer: () => [number, Record<string, unknown>];
let engine: Server;
let server: Server;
let agent: Awaited<ReturnType<typeof signIn>>;
let storage: IStorage;
let base: string;
let session: string;
let clientId: string;
let runs = 0;

/**
 * The backend's one bounded read of a fresh run at launch (tests/helpers/
 * hybrid-backend-stand-in.ts, `wait_seconds`): the run is still going then,
 * whatever a case's poll body says, so the dashboard's own polls are what read
 * it -- as they were when the dashboard launched the run itself.
 */
const firstReads = new Set<string>();
const firstRead = (url: string) => { if (firstReads.has(url)) return false; firstReads.add(url); return true; };
const STILL_RUNNING = (url: string) => ({ run_id: url.slice(url.lastIndexOf("/") + 1), state: "running", done: false, result: null });

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
    if (req.method === "GET" && url.startsWith("/api/scans/run-")) {
      if (firstRead(url)) return json(res, 200, STILL_RUNNING(url));
      return json(res, ...pollAnswer());
    }
    return json(res, 404, { detail: "not here" });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.ATHENA_ENGINE_KEY = "ce_op_test";
  hybrid = await hybridBackendStandIn({ engine: { url: process.env.ATHENA_ENGINE_URL!, key: process.env.ATHENA_ENGINE_KEY } });
  process.env.ATHENA_FAILSAFE_URL = hybrid.url;
  vi.resetModules();
  const app = await makeApp();
  agent = await signIn(app);
  await signInToBackend(agent);
  storage = (await import("../server/storage-unified")).storage;
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
  clientId = (await agent.post("/api/clients").send({ name: "Covered", company: "Covered", email: "c@c.test" })).body.id;
  await agent.post("/api/sites").send({ clientId, name: "Shop", url: "https://covered.example" });
});
afterAll(async () => {
  delete process.env.ATHENA_FAILSAFE_URL;
  await hybrid?.close();
  hybrid = null;
  delete process.env.ATHENA_ENGINE_URL;
  delete process.env.ATHENA_ENGINE_KEY;
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

/** A run the engine finishes inline, with `result` as given. */
const finishesInline = (result: Record<string, unknown>) => {
  startBody = (runId) => ({ run_id: runId, state: "completed", result });
  pollAnswer = () => [404, { detail: "not asked" }];
};
/** A run the engine accepts, then answers the first poll with `answer`. */
const endsOnPoll = (answer: Record<string, unknown>) => {
  startBody = (runId) => ({ run_id: runId, state: "running" });
  pollAnswer = () => [200, answer];
};
const completedWith = (coverage: unknown) => ({ state: "completed", reason: null, done: true, result: { results: [], coverage } });

async function startViaRoute(): Promise<string> {
  const started = await agent.post("/api/scans").send({ consent: true, clientId, target: "https://covered.example/" });
  expect(started.status).toBe(201);
  return started.body.test.id as string;
}

async function startAScan(state: string) {
  await waitFor(() => expect(screen.getByTestId("text-engine-connected")).toBeTruthy());
  await waitFor(() => expect(document.querySelector(`select option[value="${clientId}"]`)).toBeTruthy());
  fireEvent.change(document.querySelectorAll("select")[0], { target: { value: clientId } });
  fireEvent.change(screen.getByTestId("input-target"), { target: { value: "https://covered.example/" } });
  fireEvent.click(screen.getByTestId("checkbox-consent"));
  await waitFor(() => expect((screen.getByTestId("button-start-scan") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("button-start-scan"));
  await waitFor(() => expect(screen.getByTestId("text-state").textContent).toContain(state), { timeout: 6_000 });
}

const text = () => document.body.textContent ?? "";
const recordOf = async (id: string) => (await storage.getTest(id))!.findings as Record<string, unknown>;

describe("GET /api/scans/:testId carries the engine's coverage manifest", () => {
  it("a run that ended on a poll with a manifest: answered whole, recorded whole, and answered again from the completed record", async () => {
    endsOnPoll(completedWith(MANIFEST));
    const id = await startViaRoute();
    const read = await agent.get(`/api/scans/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.state).toBe("completed");
    expect(read.body.coverage).toEqual(MANIFEST);
    expect((await recordOf(id)).coverage).toEqual(MANIFEST);
    expect((await recordOf(id)).results).toEqual([]);
    // Recorded completed, the engine is not asked again: the record answers the manifest.
    pollAnswer = () => [500, { detail: "a completed row is never polled" }];
    const again = await agent.get(`/api/scans/${id}`);
    expect(again.body.state).toBe("completed");
    expect(again.body.coverage).toEqual(MANIFEST);
  });

  it("a run the engine finished inline with a manifest: recorded by the start, answered by every read", async () => {
    finishesInline({ results: [], coverage: MANIFEST });
    const id = await startViaRoute();
    expect((await recordOf(id)).coverage).toEqual(MANIFEST);
    expect((await agent.get(`/api/scans/${id}`)).body.coverage).toEqual(MANIFEST);
  });

  it("a run that was stopped carries its manifest too: the checks it never reached are what it says", async () => {
    endsOnPoll({ state: "aborted", reason: "stopped by an operator", done: true, result: { results: [], coverage: MANIFEST } });
    const id = await startViaRoute();
    const read = await agent.get(`/api/scans/${id}`);
    expect(read.body.state).toBe("aborted");
    expect(read.body.coverage).toEqual(MANIFEST);
  });

  it("a person's edit of the notes keeps the manifest; a manifest sent with the edit is refused as the run's", async () => {
    endsOnPoll(completedWith(MANIFEST));
    const id = await startViaRoute();
    await agent.get(`/api/scans/${id}`);
    const edited = await agent.patch(`/api/tests/${id}`).send({ findings: { details: "reviewed by hand" } });
    expect(edited.status).toBe(200);
    const read = await agent.get(`/api/scans/${id}`);
    expect(read.body.coverage).toEqual(MANIFEST);
    expect(read.body.test.findings.details).toBe("reviewed by hand");
    const forged = await agent.patch(`/api/tests/${id}`).send({ findings: { details: "x", coverage: { complete: true, checks: [] } } });
    expect(forged.status).toBe(409);
    expect(forged.body.message).toContain("findings.coverage");
    expect((await recordOf(id)).coverage).toEqual(MANIFEST);
  });

  it("a person's own test may not supply a manifest -- refused on create and on edit, naming the key -- and answers none", async () => {
    const created = await agent.post("/api/tests").send({
      clientId, testType: "manual", status: "pending", findings: { coverage: MANIFEST },
    });
    expect(created.status, "POST /api/tests accepted a supplied coverage manifest").toBe(400);
    expect(created.body.message).toContain("findings.coverage");
    const plain = await agent.post("/api/tests").send({ clientId, testType: "manual", status: "pending" });
    expect(plain.status).toBe(201);
    const edited = await agent.patch(`/api/tests/${plain.body.id}`).send({ findings: { coverage: MANIFEST } });
    expect(edited.status).toBe(400);
    expect(edited.body.message).toContain("findings.coverage");
    const read = await agent.get(`/api/scans/${plain.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body.coverage).toBeNull();
  });

  it("a run that sent no manifest, or one that is not an object, answers null: never an empty manifest", async () => {
    endsOnPoll({ state: "completed", reason: null, done: true, result: { results: [] } });
    const none = await startViaRoute();
    const readNone = await agent.get(`/api/scans/${none}`);
    expect(readNone.body.coverage).toBeNull();
    expect((await recordOf(none)).coverage).toBeUndefined();

    endsOnPoll(completedWith("complete"));
    const garbled = await startViaRoute();
    expect((await agent.get(`/api/scans/${garbled}`)).body.coverage).toBeNull();
    expect((await recordOf(garbled)).coverage).toBeUndefined();
  });
});

describe("both scan screens draw the engine's manifest for this scan, and say when none was sent", () => {
  for (const [name, Screen] of [["Athena", AthenaScan], ["Penetration testing", PentestScan]] as const) {
    it(`${name}: performed, degraded, not performed and unmeasured, with the engine's reasons, and complete as the engine sent it`, async () => {
      endsOnPoll(completedWith(MANIFEST));
      realRoutes();
      render(<QueryClientProvider client={queryClient}><Screen /></QueryClientProvider>);
      await startAScan("completed");
      await waitFor(() => expect(screen.getByTestId("text-coverage-complete")).toBeTruthy());
      expect(screen.getByTestId("text-coverage-source").textContent).toBe(SOURCE);
      expect(screen.getByTestId("text-coverage-complete").textContent).toBe(COMPLETE_FALSE);
      expect(screen.getByTestId("text-coverage-performed").textContent).toBe("2 of 6 checks performed");
      const performed = screen.getByTestId("list-coverage-performed").textContent ?? "";
      expect(performed).toContain("cors");
      expect(performed).toContain("csrf");
      expect(performed).toContain("12 probes");
      const degraded = screen.getByTestId("list-coverage-degraded").textContent ?? "";
      expect(degraded).toContain("header_injection");
      expect(degraded).toContain("3 of 8 probes lost");
      const notPerformed = screen.getByTestId("list-coverage-not-performed").textContent ?? "";
      expect(notPerformed).toContain("idor");
      expect(notPerformed).toContain("it needed something it did not have");
      expect(notPerformed).toContain("IDOR needs two identities; one was configured.");
      expect(notPerformed).toContain("sqli");
      expect(notPerformed).toContain("the scan ended before it ran");
      expect(screen.getByTestId("list-coverage-unmeasured").textContent).toContain("tls");
      expect(screen.getByTestId("list-coverage-limitations").textContent).toContain("Raw CRLF header injection is not probed.");
      expect(screen.getByTestId("list-coverage-notes").textContent).toContain("Surface discovery incomplete: robots.txt could not be read");
      expect(screen.queryByTestId("text-coverage-not-sent")).toBeNull();
      expect(screen.queryByTestId("text-coverage-pending")).toBeNull();
      expect(screen.queryByTestId("text-coverage-unread-rows")).toBeNull();
    });

    it(`${name}: a run that sent no manifest says so, and is never drawn as complete`, async () => {
      finishesInline({ results: [] });
      realRoutes();
      render(<QueryClientProvider client={queryClient}><Screen /></QueryClientProvider>);
      await startAScan("completed");
      await waitFor(() => expect(screen.getByTestId("text-coverage-not-sent")).toBeTruthy());
      expect(screen.getByTestId("text-coverage-not-sent").textContent).toBe(NOT_SENT);
      expect(screen.getByTestId("text-coverage-source").textContent).toBe(SOURCE);
      expect(screen.queryByTestId("text-coverage-complete")).toBeNull();
      expect(screen.queryByTestId("text-coverage-performed")).toBeNull();
      expect(screen.queryByTestId("text-coverage-pending")).toBeNull();
      expect(text()).not.toMatch(/checks performed|manifest is complete/);
      // The completed scan's own rendering stands beside it, unchanged.
      expect(text()).toContain("The scan finished and returned no findings. That is a result, not an absence of one.");
    });
  }

  it("Athena: while the run goes on the manifest is said to be reported when it ends; once it has ended, it is drawn", async () => {
    startBody = (runId) => ({ run_id: runId, state: "running" });
    pollAnswer = () => [200, { state: "running", done: false, result: null }];
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("running");
    await waitFor(() => expect(screen.getByTestId("text-coverage-pending")).toBeTruthy());
    expect(screen.getByTestId("text-coverage-pending").textContent).toBe(PENDING);
    expect(screen.getByTestId("text-coverage-source").textContent).toBe(SOURCE);
    expect(screen.queryByTestId("text-coverage-not-sent")).toBeNull();
    expect(screen.queryByTestId("text-coverage-complete")).toBeNull();
    pollAnswer = () => [200, { state: "aborted", reason: "stopped by an operator", done: true, result: { results: [], coverage: MANIFEST } }];
    await waitFor(() => expect(screen.getByTestId("text-state").textContent).toContain("aborted"), { timeout: 6_000 });
    await waitFor(() => expect(screen.getByTestId("text-coverage-complete")).toBeTruthy());
    expect(screen.queryByTestId("text-coverage-pending")).toBeNull();
    expect(screen.getByTestId("text-coverage-complete").textContent).toBe(COMPLETE_FALSE);
    expect(screen.getByTestId("list-coverage-not-performed").textContent).toContain("sqli");
  }, 15_000);

  it("Athena: a manifest whose complete flag is true is said so only because the engine said so, and rows it cannot read are counted", async () => {
    endsOnPoll(completedWith({
      complete: true,
      checks: [{ check: "cors", team: "blue", state: "performed", probes_attempted: 1, probes_failed: 0 }, "not a row", { state: "performed" }],
      notes: [],
    }));
    realRoutes();
    render(<QueryClientProvider client={queryClient}><AthenaScan /></QueryClientProvider>);
    await startAScan("completed");
    await waitFor(() => expect(screen.getByTestId("text-coverage-complete")).toBeTruthy());
    expect(screen.getByTestId("text-coverage-complete").textContent).toBe(
      "The engine states this manifest is complete: every check it offers ran and saw what it tried to see.",
    );
    expect(screen.getByTestId("text-coverage-performed").textContent).toBe("1 of 1 checks performed");
    expect(screen.getByTestId("text-coverage-unread-rows").textContent).toBe(
      "2 rows of the manifest could not be read, and are not listed.",
    );
  });
});

describe("readCoverage re-expresses the engine's manifest and never re-decides it", () => {
  it("is null for anything that is not an object: absent, null, text, a list", () => {
    for (const raw of [undefined, null, "complete", 1, true, [], [MANIFEST]]) expect(readCoverage(raw)).toBeNull();
  });

  it("complete is the engine's own flag, verbatim, and null when it did not send a boolean", () => {
    expect(readCoverage({ complete: true, checks: [] })?.complete).toBe(true);
    expect(readCoverage({ complete: false, checks: [] })?.complete).toBe(false);
    expect(readCoverage({ complete: "yes", checks: [] })?.complete).toBeNull();
    expect(readCoverage({ checks: [] })?.complete).toBeNull();
    // Every row performed does not make it complete here: only the engine says so.
    expect(readCoverage({ checks: [{ check: "cors", state: "performed" }] })?.complete).toBeNull();
  });

  it("groups rows by the engine's state word, keeps an unknown state under its own word, and counts rows it cannot read", () => {
    const read = readCoverage({
      ...MANIFEST,
      checks: [...MANIFEST.checks, { check: "xxe", team: "red", state: "pending" }, null, { team: "red" }],
    })!;
    expect(read.performed.map((one) => one.check)).toEqual(["cors", "csrf"]);
    expect(read.degraded.map((one) => one.check)).toEqual(["header_injection"]);
    expect(read.notPerformed.map((one) => ({ check: one.check, reason: one.reason }))).toEqual([
      { check: "idor", reason: "precondition" }, { check: "sqli", reason: "not_reached" },
    ]);
    expect(read.unmeasured.map((one) => one.check)).toEqual(["tls"]);
    expect(read.other).toEqual([{
      check: "xxe", team: "red", state: "pending", reason: null, detail: null, probesAttempted: null, probesFailed: null,
    }]);
    expect(read.unreadRows).toBe(2);
    expect(read.limitations).toEqual([{ check: "header_injection", texts: ["Raw CRLF header injection is not probed."] }]);
    expect(read.notes).toEqual(["Surface discovery incomplete: robots.txt could not be read"]);
    const degraded = read.degraded[0];
    expect({ attempted: degraded.probesAttempted, failed: degraded.probesFailed }).toEqual({ attempted: 8, failed: 3 });
  });
});
