// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import AIControlPanel from "@/pages/AIControlPanel";

/**
 * SAFETY and Q7: the AI Control page said "System Shutdown Active -- All AI
 * operations have been terminated" whenever the switch was on, while the scan
 * it was engaged over kept running (the switch told the engine nothing). The
 * server now sends each running scan a stop and answers with what each came
 * to; the page says exactly that -- how many were sent a stop, how many the
 * engine accepted, and which could not be stopped and why -- and never that
 * everything was terminated. And "Confirm Shutdown" is no longer disabled
 * while some other setting on the page is saving.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const SETTINGS = {
  id: "s", systemStatus: "operational", killSwitchEnabled: false, overrideMode: false,
  activeSystems: ["penetration-testing"], maxConcurrentTests: 5, autoShutdownThreshold: 90,
  lastModifiedBy: null, lastModifiedAt: new Date().toISOString(),
};
const ENGAGED = { ...SETTINGS, killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] };

function mount(settings: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async () => { throw new Error("not read again"); } } } });
  client.setQueryData(["/api/ai-control"], settings);
  render(<QueryClientProvider client={client}><AIControlPanel /></QueryClientProvider>);
  return client;
}

/** The PATCH the kill switch sends answers with `stops`; any other PATCH hangs. */
function engageAnswers(stops: unknown, engineRuns?: unknown) {
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push(body);
    if (body.killSwitchEnabled !== true) return new Promise<Response>(() => {});
    return new Response(JSON.stringify({ ...ENGAGED, stops, engineRuns }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return sent;
}

async function engage() {
  fireEvent.click(screen.getByTestId("button-kill-switch"));
  fireEvent.click(screen.getByTestId("button-confirm-kill-switch"));
  return waitFor(() => screen.getByTestId("text-kill-switch-stops"));
}

const scan = (testId: string, stopped: boolean, detail = "") =>
  ({ testId, runId: `run-${testId}`, target: `https://${testId}.example/`, stopped, detail });

describe("the AI Control page says what the kill switch stopped, and nothing more", () => {
  it("names the scans that could not be stopped, and why", async () => {
    mount(SETTINGS);
    engageAnswers({ listed: true, scans: [
      scan("a", true),
      scan("b", false, "could not reach the engine at http://engine: fetch failed"),
    ] });
    const said = (await engage()).textContent ?? "";
    expect(said).toBe(
      "Kill switch engaged; 2 running scans were sent a stop; the engine accepted 1; 1 could not be stopped " +
      "(https://b.example/: could not reach the engine at http://engine: fetch failed). They may still be running: " +
      "stop them from the scan screens, or pause the engine from the Failsafe console.",
    );
    expect(document.body.textContent).not.toMatch(/terminated/i);
  });

  it("says the engine accepted every stop only when it did", async () => {
    mount(SETTINGS);
    engageAnswers({ listed: true, scans: [scan("a", true), scan("b", true)] });
    expect((await engage()).textContent).toBe(
      "Kill switch engaged; 2 running scans were sent a stop, and the engine accepted all of them.",
    );
  });

  it("one scan, one stop", async () => {
    mount(SETTINGS);
    engageAnswers({ listed: true, scans: [scan("a", true)] });
    expect((await engage()).textContent).toBe("Kill switch engaged; 1 running scan was sent a stop, and the engine accepted it.");
  });

  it("no scan running is said as that, not as everything stopped", async () => {
    mount(SETTINGS);
    engageAnswers({ listed: true, scans: [] });
    expect((await engage()).textContent).toBe(
      "Kill switch engaged. No engine scan was recorded as running, so none was sent a stop.",
    );
  });

  it("scans that could not be listed are not read as none", async () => {
    mount(SETTINGS);
    engageAnswers({ listed: false, detail: "database is locked" });
    const said = (await engage()).textContent ?? "";
    expect(said).toMatch(/^Kill switch engaged, but the running scans could not be listed, so none was sent a stop: database is locked\./);
    expect(said).not.toMatch(/No engine scan was recorded as running/);
  });

  it("a switch found engaged on load claims nothing about what it stopped", () => {
    mount(ENGAGED);
    const engaged = screen.getByTestId("text-kill-switch-engaged").textContent ?? "";
    expect(engaged).toMatch(/does not say what was stopped/);
    expect(document.body.textContent).not.toMatch(/terminated/i);
    expect(screen.queryByTestId("text-kill-switch-stops")).toBeNull();
    // ...and the stops can be sent again from here.
    expect((screen.getByTestId("button-resend-stops") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Confirm Shutdown is not held back while another setting is saving", async () => {
    mount(SETTINGS);
    const sent = engageAnswers({ listed: true, scans: [] });
    fireEvent.click(screen.getByTestId("switch-penetration-testing")); // its PATCH never answers
    await waitFor(() => expect(sent).toHaveLength(1));
    fireEvent.click(screen.getByTestId("button-kill-switch"));
    const confirm = screen.getByTestId("button-confirm-kill-switch") as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(sent).toContainEqual({ killSwitchEnabled: true, systemStatus: "shutdown", activeSystems: [] }));
  });

  describe("the runs the engine itself listed as live", () => {
    const run = (runId: string, testId: string | null, stopped: boolean, detail = "") =>
      ({ runId, target: `https://${runId}.example/`, testId, stopped, detail });
    const engineSaid = async () => screen.getByTestId("text-kill-switch-engine-runs").textContent ?? "";

    it("names how many had no record here, and that the engine accepted each stop", async () => {
      mount(SETTINGS);
      engageAnswers({ listed: true, scans: [] }, { listed: true, runs: [run("r1", null, true), run("r2", "t2", true)] });
      await engage();
      expect(await engineSaid()).toBe(
        "The engine also listed 2 live runs that no running scan here recorded (1 with no record here at all); each " +
        "was sent a stop, and the engine accepted all of them.",
      );
    });

    it("says which could not be stopped, and why", async () => {
      mount(SETTINGS);
      engageAnswers({ listed: true, scans: [] }, { listed: true, runs: [run("r1", null, false, "could not reach the engine")] });
      await engage();
      expect(await engineSaid()).toBe(
        "The engine also listed 1 live run that no running scan here recorded (1 with no record here at all); it was " +
        "sent a stop; the engine accepted 0; 1 could not be stopped (https://r1.example/: could not reach the engine). " +
        "They may still be running: pause the engine from the Failsafe console.",
      );
    });

    it("an engine list that could not be read is not read as none", async () => {
      mount(SETTINGS);
      engageAnswers({ listed: true, scans: [] }, { listed: false, detail: "the engine answered 404" });
      await engage();
      expect(await engineSaid()).toMatch(/^The engine's own list of live runs could not be read \(the engine answered 404\)/);
      expect(await engineSaid()).not.toMatch(/listed no other live run/);
    });

    it("an empty list is the engine's word, said as that", async () => {
      mount(SETTINGS);
      engageAnswers({ listed: true, scans: [] }, { listed: true, runs: [] });
      await engage();
      expect(await engineSaid()).toBe("The engine listed no other live run.");
    });

    it("a live run the engine listed with no run id is said to be unstopped, never read as no other live run", async () => {
      mount(SETTINGS);
      engageAnswers({ listed: true, scans: [] }, { listed: true, runs: [], unnamed: 1 });
      await engage();
      expect(await engineSaid()).toBe(
        "The engine listed 1 live run with no run id, so no stop could name it and none was sent: it may still be " +
        "running. Pause, stand down or terminate the engine from the Failsafe console.",
      );
      expect(await engineSaid()).not.toMatch(/listed no other live run/);
    });

    it("says both what came of the named runs' stops and that the unnamed ones got none", async () => {
      mount(SETTINGS);
      engageAnswers({ listed: true, scans: [] }, { listed: true, runs: [run("r1", null, true)], unnamed: 2 });
      await engage();
      expect(await engineSaid()).toBe(
        "The engine also listed 1 live run that no running scan here recorded (1 with no record here at all); it was " +
        "sent a stop, and the engine accepted it. The engine listed 2 live runs with no run id, so no stop could name " +
        "them and none was sent: they may still be running. Pause, stand down or terminate the engine from the Failsafe console.",
      );
    });
  });

  it("a switch that could not be stored says it is NOT engaged, and still says what each stop came to", async () => {
    mount(SETTINGS);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      message: "The kill switch could not be engaged: SQLITE_FULL: database or disk is full. Every stop was sent all the " +
        "same; what each came to is below. Writes are not refused until the switch is engaged.",
      engaged: false,
      stops: { listed: true, scans: [scan("a", true)] },
      engineRuns: { listed: true, runs: [] },
    }), { status: 500, headers: { "Content-Type": "application/json" } })));
    const said = (await engage()).textContent;
    expect(said).toBe("Kill switch NOT engaged, stops sent anyway; 1 running scan was sent a stop, and the engine accepted it.");
    expect(screen.getByTestId("text-kill-switch-not-engaged").textContent).toMatch(
      /^The kill switch could not be engaged: SQLITE_FULL: database or disk is full\. Every stop was sent all the same/,
    );
    expect(document.body.textContent).not.toMatch(/Kill switch engaged/);
  });

  it("a failure that carries no stops is a plain failure: no report is drawn", async () => {
    mount(SETTINGS);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Forbidden" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    })));
    fireEvent.click(screen.getByTestId("button-kill-switch"));
    fireEvent.click(screen.getByTestId("button-confirm-kill-switch"));
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("text-kill-switch-stops")).toBeNull();
    expect(screen.queryByTestId("text-kill-switch-not-engaged")).toBeNull();
  });
});
