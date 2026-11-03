// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";

import AppShell from "@/components/AppShell";

/**
 * Every screen of the console carries Athena-Backend's own health in a strip
 * under the top bar (client/src/components/BackendHealthStrip.tsx), from what
 * this server serves at /api/backend-health.
 *
 * "ok" is shown only for a reading of "ok". Degraded is shown with every count
 * by name; unknown, unreachable, "counts not reported" and error are said as
 * such; a reading the page cannot read, or a server it cannot ask, is unknown.
 * Fields the console does not recognise, workers and acknowledgement fields are
 * shown as sent.
 *
 * The served views are written out here as the server sends them, so this file
 * renders against a console without the strip as well (where it fails: no
 * strip, so a degraded backend is not shown at all).
 */

afterEach(() => cleanup());

const EMPTY = { reportedStatus: null, message: null, httpStatus: 200, counts: [], countsReported: false, problems: [], unrecognised: [], workers: null, acknowledgement: [] };

function served(reading: Record<string, unknown>, ageMs = 4_000) {
  return { configured: true, checkedAt: "2026-11-03T12:00:00.000Z", ageMs, reading: { ...EMPTY, ...reading } };
}

const DEGRADED = served({
  verdict: "degraded",
  headline: "Athena-Backend reports itself degraded: it lost or refused what an operator must act on",
  reportedStatus: "degraded",
  message: "Django backend is alive, and lost or refused what an operator must act on: stderr_lines_lost=3, log_records_dropped=12, unrecorded_dispatches_refused=1",
  countsReported: true,
  counts: [
    { name: "stderr_lines_lost", label: "stderr lines lost", value: 3, known: true },
    { name: "log_records_dropped", label: "log records dropped", value: 12, known: true },
    { name: "unrecorded_dispatches_refused", label: "unrecorded dispatches refused", value: 1, known: true },
  ],
});

/** The console, with /api/backend-health answering `answer` (a value, or an Error it fails with). */
function mount(answer: unknown) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        refetchInterval: false,
        queryFn: async ({ queryKey }) => {
          if (queryKey[0] === "/api/backend-health") {
            if (answer instanceof Error) throw answer;
            return answer;
          }
          throw new Error(`not stood in: ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <AppShell onLogout={() => {}} isAdmin username="admin"><div /></AppShell>
    </QueryClientProvider>,
  );
}

async function strip() {
  const found = await screen.findByTestId("backend-health");
  // The first answer, not the loading strip.
  for (let i = 0; i < 50 && within(found).queryByText(/^Reading Athena-Backend/); i += 1) await new Promise((r) => setTimeout(r, 10));
  return screen.getByTestId("backend-health");
}

describe("a degraded backend is shown degraded on every screen, with its counts by name", () => {
  it("the state, each named count, and the backend's own words", async () => {
    mount(DEGRADED);
    const shown = await strip();
    expect(shown.getAttribute("data-verdict")).toBe("degraded");
    expect(within(shown).getByTestId("backend-health-verdict").textContent).toBe("degraded");
    expect(within(shown).getByTestId("backend-health-count-stderr_lines_lost").textContent).toBe("stderr lines lost: 3");
    expect(within(shown).getByTestId("backend-health-count-log_records_dropped").textContent).toBe("log records dropped: 12");
    expect(within(shown).getByTestId("backend-health-count-unrecorded_dispatches_refused").textContent).toBe("unrecorded dispatches refused: 1");
    expect(within(shown).getByTestId("backend-health-reported-status").textContent).toContain('"degraded"');
    expect(within(shown).getByTestId("backend-health-when").textContent).toBe("(read 4 s ago)");
    expect(shown.textContent).not.toMatch(/\bok\b/);
  });
});

describe("nothing short of a reading of ok shows ok", () => {
  it("ok: ok, with no counts listed", async () => {
    mount(served({ verdict: "ok", headline: "Athena-Backend reports every count at zero", reportedStatus: "ok", countsReported: true }));
    const shown = await strip();
    expect(shown.getAttribute("data-verdict")).toBe("ok");
    expect(within(shown).getByTestId("backend-health-verdict").textContent).toBe("ok");
    expect(within(shown).queryByTestId("backend-health-counts")).toBeNull();
  });

  it.each([
    ["unknown", "unknown", "Athena-Backend reports its own health as unknown: its counts could not be read"],
    ["unreachable", "unreachable", "Athena-Backend could not be reached: ECONNREFUSED"],
    ["not-reported", "counts not reported", "Athena-Backend answers \"ok\": counts not reported by this backend"],
    ["error", "error", "Athena-Backend reports an error in its own health check"],
  ])("%s: said as such", async (verdict, words, headline) => {
    mount(served({ verdict, headline, reportedStatus: verdict === "not-reported" ? "ok" : null }));
    const shown = await strip();
    expect(shown.getAttribute("data-verdict")).toBe(verdict);
    expect(within(shown).getByTestId("backend-health-verdict").textContent).toBe(words);
    expect(within(shown).getByTestId("backend-health-headline").textContent).toBe(headline);
  });

  it("an old backend's plain ok: its plain status, labelled counts not reported by this backend -- never the ok badge", async () => {
    mount(served({ verdict: "not-reported", headline: "Athena-Backend answers \"ok\": counts not reported by this backend", reportedStatus: "ok" }));
    const shown = await strip();
    expect(within(shown).getByTestId("backend-health-verdict").textContent).not.toBe("ok");
    expect(within(shown).getByTestId("backend-health-reported-status").textContent).toContain('"ok"');
    expect(shown.textContent).toContain("counts not reported by this backend");
  });

  it.each([
    ["a reading with no verdict", { configured: true, checkedAt: null, ageMs: null, reading: { headline: "x" } }],
    ["a verdict this page does not know", served({ verdict: "fine", headline: "x" })],
    ["a reading cut short", { configured: true, reading: { verdict: "ok" } }],
    ["no reading at all", { configured: true }],
    ["something that is not a view", "ok"],
    ["null", null],
  ])("%s: unknown, never ok", async (_what, view) => {
    mount(view);
    const shown = await strip();
    expect(shown.getAttribute("data-verdict")).toBe("unknown");
  });

  it("this server could not be asked: unknown, with why", async () => {
    mount(new Error("503: Service Unavailable"));
    const shown = await strip();
    expect(shown.getAttribute("data-verdict")).toBe("unknown");
    expect(within(shown).getByTestId("backend-health-headline").textContent).toMatch(/could not be asked.*503/);
  });

  it("no backend configured: no strip", async () => {
    mount({ configured: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("backend-health")).toBeNull();
  });
});

describe("what the console does not recognise is shown", () => {
  it("unrecognised fields, problems, workers and acknowledgement fields, as sent -- beside an ok too", async () => {
    mount(served({
      verdict: "ok", headline: "Athena-Backend reports every count at zero", reportedStatus: "ok", countsReported: true,
      unrecognised: [{ name: "build", value: '"abc123"' }],
    }));
    const ok = await strip();
    expect(within(ok).getByTestId("backend-health-unrecognised-list").textContent).toBe('build = "abc123"');
    cleanup();

    mount(served({
      verdict: "degraded", headline: "Athena-Backend reports itself degraded: it lost or refused what an operator must act on",
      reportedStatus: "degraded", countsReported: true,
      counts: [{ name: "sockets_leaked", label: "sockets_leaked", value: 2, known: false }],
      problems: ['worker 2: status "unknown"'],
      workers: [{ fields: [{ name: "pid", value: "101" }] }, { fields: [{ name: "pid", value: "102" }, { name: "status", value: '"unknown"' }] }],
      acknowledgement: [{ name: "acknowledged_by", value: '"operator-1"' }],
    }));
    const shown = await strip();
    expect(within(shown).getByTestId("backend-health-count-sockets_leaked").textContent).toBe("sockets_leaked: 2 (a count this console does not know)");
    expect(within(shown).getByTestId("backend-health-problems").textContent).toContain('worker 2: status "unknown"');
    expect(within(shown).getByTestId("backend-health-workers").textContent).toContain("2 workers reported:");
    expect(within(shown).getByTestId("backend-health-worker-2-fields").textContent).toContain('status = "unknown"');
    expect(within(shown).getByTestId("backend-health-acknowledgement-list").textContent).toBe('acknowledged_by = "operator-1"');
    // No acknowledge button yet.
    expect(within(shown).queryByRole("button")).toBeNull();
  });
});
