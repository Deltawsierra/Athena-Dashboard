// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { getQueryFn } from "@/lib/queryClient";
import Economics from "@/pages/Economics";
import { MASTER, exchange, fixture, served } from "./helpers/economics-fixtures";
import { decimalTokens, shims } from "./helpers/economics-render";

/**
 * The scenario picker (components/economics/ScenarioPicker.tsx) replaces typed
 * uuids: a deployment from the deployments list, then one of its scenario
 * versions from Athena-Backend's scenario list (#163), a page at a time. Each
 * version as the list serves it -- templates, latest exposure run's status, grade,
 * banner, exclusion from every total and why -- and nothing added up. Paging goes
 * only to a page the list names. Picking a version reads its latest exposure run.
 * Every read passes its AbortSignal: leaving the page aborts them.
 *
 * The list is Athena-Backend's own answer (SYNTHETIC): five versions of one
 * deployment -- graded, Unknown, refused, never run, and one with a remediation
 * option -- read two a page.
 */

beforeAll(shims);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const list = fixture(MASTER, "scenario-list");
const pages = [1, 2, 3].map((n) => served(list, `list-page-${n}`) as Record<string, any>);
const deployment = pages[0].deployment as string;
const DEPLOYMENTS = [
  { uuid: deployment, name: "payments-agent", environment: "SYNTHETIC" },
  { uuid: "00000000-0000-4000-8000-0000000000bb", name: "another", environment: "SYNTHETIC" },
];

/** A fetch that answers as this server does: the deployments, and each page of the list as the backend served it. */
function answering() {
  const requested: Array<{ url: string; signal: AbortSignal | undefined }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requested.push({ url: String(url), signal: init?.signal ?? undefined });
    const asked = new URL(String(url), "http://dashboard");
    if (asked.pathname === "/api/assurance/deployments") return Response.json(DEPLOYMENTS);
    if (asked.pathname === "/api/economics/scenarios" && asked.searchParams.get("deployment") === deployment) {
      const page = Number(asked.searchParams.get("page") ?? "1");
      return new Response(exchange(list, `list-page-${page}`).body, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "not in this test", code: "not_served" }), { status: 404 });
  }));
  return requested;
}

function mount(path: string) {
  const location = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
  const view = render(
    <QueryClientProvider client={client}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <Economics />
      </Router>
    </QueryClientProvider>,
  );
  return { ...view, location };
}

const entries = () => Array.from(document.querySelectorAll("[data-scenario-entry]")) as HTMLElement[];
const listed = () => entries().map((one) => one.getAttribute("data-scenario-entry"));

describe("the scenario picker", () => {
  it("offers the deployments to pick from, and no field to type a uuid in", async () => {
    answering();
    const { location } = mount("/economics");
    const choice = await screen.findByTestId("deployment-choice");
    const options = Array.from((choice as HTMLSelectElement).options).map((one) => one.value);
    expect(options).toEqual(["", ...DEPLOYMENTS.map((one) => one.uuid)]);
    expect(document.querySelectorAll('input[type="text"], input:not([type])')).toHaveLength(0);
    fireEvent.change(choice, { target: { value: deployment } });
    expect(location.history!.at(-1)).toBe(`/economics?deployment=${deployment}`);
  });

  it("lists a deployment's versions as served: templates, latest run, grade, banner, exclusion and why", async () => {
    answering();
    mount(`/economics?deployment=${deployment}`);
    await waitFor(() => expect(listed()).toEqual(pages[0].scenarios.map((one: any) => one.uuid)));
    const all = [...pages[0].scenarios, ...pages[1].scenarios, ...pages[2].scenarios] as Array<Record<string, any>>;
    expect(all).toHaveLength(pages[0].count);
    for (const [index, entry] of pages[0].scenarios.entries() as IterableIterator<[number, Record<string, any>]>) {
      const shown = within(entries()[index]);
      expect(entries()[index].textContent).toContain(entry.title);
      for (const template of entry.templates) {
        expect(shown.getByTestId("entry-templates").textContent).toContain(`${template.template_id} v${template.version}`);
      }
      expect(shown.getByTestId("entry-run").textContent).toContain(entry.latest_exposure_run.status);
      expect(shown.getByTestId("entry-run").textContent).toContain(entry.latest_exposure_run.recorded_at);
      expect(shown.getByTestId("entry-grade").textContent).toBe(entry.grade ?? "not graded");
      expect(shown.getByTestId("entry-excluded").textContent).toMatch(entry.excluded_from_totals ? /^yes/ : /^no/);
      if (entry.banner_reason) expect(shown.getByTestId("entry-excluded").textContent).toContain(entry.banner_reason);
    }
    expect(screen.getByTestId("scenario-page").textContent).toContain(`Page ${pages[0].page} of ${pages[0].pages}`);
  });

  it("a version not graded A to D carries its banner, as served; a graded one carries none", async () => {
    answering();
    mount(`/economics?deployment=${deployment}`);
    const all = [...pages[0].scenarios, ...pages[1].scenarios, ...pages[2].scenarios] as Array<Record<string, any>>;
    const unknown = all.find((one) => one.grade === "Unknown")!;
    const graded = all.find((one) => ["A", "B", "C", "D"].includes(one.grade) && one.banner === null)!;
    expect(unknown && graded).toBeTruthy();
    for (const page of [1, 2, 3]) {
      await waitFor(() => expect(listed()).toEqual(pages[page - 1].scenarios.map((one: any) => one.uuid)));
      for (const entry of entries()) {
        const uuid = entry.getAttribute("data-scenario-entry");
        const served = all.find((one) => one.uuid === uuid)!;
        const banner = entry.querySelector("[data-economics-banner]");
        if (served.banner !== null) expect(banner?.querySelector("[data-banner-text]")?.textContent, uuid!).toBe(served.banner);
        if (served.uuid === graded.uuid) expect(banner).toBeNull();
        if (served.excluded_from_totals !== false || !["A", "B", "C", "D"].includes(served.grade)) expect(banner, uuid!).not.toBeNull();
      }
      if (page < 3) fireEvent.click(screen.getByTestId("scenarios-next"));
    }
  });

  it("pages only to the pages the list names: next and previous as served, none past either end", async () => {
    const requested = answering();
    mount(`/economics?deployment=${deployment}`);
    await waitFor(() => expect(listed()).toEqual(pages[0].scenarios.map((one: any) => one.uuid)));
    expect(pages[0].previous).toBeNull();
    expect(screen.queryByTestId("scenarios-previous")).toBeNull();
    fireEvent.click(screen.getByTestId("scenarios-next"));
    await waitFor(() => expect(listed()).toEqual(pages[1].scenarios.map((one: any) => one.uuid)));
    fireEvent.click(screen.getByTestId("scenarios-next"));
    await waitFor(() => expect(listed()).toEqual(pages[2].scenarios.map((one: any) => one.uuid)));
    expect(pages[2].next).toBeNull();
    expect(screen.queryByTestId("scenarios-next")).toBeNull();
    fireEvent.click(screen.getByTestId("scenarios-previous"));
    await waitFor(() => expect(listed()).toEqual(pages[1].scenarios.map((one: any) => one.uuid)));
    const asked = requested.filter((one) => one.url.startsWith("/api/economics/scenarios")).map((one) => new URL(one.url, "http://d").searchParams.get("page"));
    expect(asked).toEqual([null, String(pages[0].next), String(pages[1].next), String(pages[2].previous)]);
  });

  it("picking a version reads its latest exposure run; a version never run has no result to read", async () => {
    answering();
    const { location } = mount(`/economics?deployment=${deployment}`);
    await waitFor(() => expect(listed()).toEqual(pages[0].scenarios.map((one: any) => one.uuid)));
    const first = pages[0].scenarios[0] as Record<string, any>;
    fireEvent.click(within(entries()[0]).getByTestId("entry-read"));
    expect(location.history!.at(-1)).toBe(
      `/economics?deployment=${deployment}&scenario=${first.uuid}&simulation=${first.latest_exposure_run.uuid}`,
    );
    const all = [...pages[0].scenarios, ...pages[1].scenarios, ...pages[2].scenarios] as Array<Record<string, any>>;
    const unrun = all.find((one) => one.latest_exposure_run === null)!;
    const page = pages.findIndex((one) => one.scenarios.some((entry: any) => entry.uuid === unrun.uuid)) + 1;
    for (let at = 1; at < page; at += 1) {
      fireEvent.click(await screen.findByTestId("scenarios-next"));
      await waitFor(() => expect(listed()).toEqual(pages[at].scenarios.map((one: any) => one.uuid)));
    }
    const entry = entries().find((one) => one.getAttribute("data-scenario-entry") === unrun.uuid)!;
    expect(within(entry).queryByTestId("entry-read")).toBeNull();
    expect(within(entry).getByTestId("entry-no-result").textContent).toMatch(/no exposure run recorded/);
  });

  it("adds nothing up: no amount, no decimal, and the list's own count", async () => {
    answering();
    const { container } = mount(`/economics?deployment=${deployment}`);
    await waitFor(() => expect(listed()).toHaveLength(pages[0].scenarios.length));
    expect(container.querySelectorAll("[data-money]")).toHaveLength(0);
    // The only decimals shown are the fractions of the times the list serves (when each was recorded).
    const times = pages[0].scenarios.flatMap((one: any) => [one.recorded_at, one.latest_exposure_run?.recorded_at]).filter(Boolean) as string[];
    for (const token of decimalTokens(container)) expect(times.some((time) => time.includes(token)), token).toBe(true);
    expect(screen.getByTestId("scenario-page").textContent).toContain(`${pages[0].count} scenario`);
    expect(container.textContent).not.toMatch(/\btotal of\b|\bsum\b|portfolio/i);
  });

  it("its reads are cancelled when the page is left", async () => {
    const reads: Array<{ url: string; signal: AbortSignal | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      reads.push({ url: String(url), signal: init?.signal ?? undefined });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }));
    const { unmount } = mount(`/economics?deployment=${deployment}`);
    await waitFor(() => expect(reads.map((one) => one.url.split("?")[0]).sort()).toEqual(["/api/assurance/deployments", "/api/economics/scenarios"]));
    for (const read of reads) expect(read.signal?.aborted, read.url).toBe(false);
    unmount();
    await waitFor(() => expect(reads.every((one) => one.signal?.aborted)).toBe(true));
  });
});
