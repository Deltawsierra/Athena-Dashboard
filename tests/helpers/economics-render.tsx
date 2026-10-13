/**
 * Mount the economics views with the app's own query function, over a fetch that
 * answers as this dashboard's server does: a document the backend served is its
 * recorded bytes (streamed through unmodified, server/economics.ts), anything
 * else the server's `{error}` answer. So the views parse the backend's real
 * bytes, with the real JSON parse, every time.
 */
import { vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor, screen } from "@testing-library/react";
import { getQueryFn } from "@/lib/queryClient";
import { EconomicsView } from "@/pages/Economics";
import { exchange, idsOf, type Fixture } from "./economics-fixtures";

export type Answer = { status: number; body: string; contentType?: string; headers?: Record<string, string> };

/** The bytes of a recorded exchange, as this server streams them through (with the headers it passes on). */
export function bytesOf(loaded: Fixture, name: string): Answer {
  const one = exchange(loaded, name);
  return { status: one.status, body: one.body, contentType: one.content_type, headers: one.headers };
}

/** What this server answers when the backend did not serve the document. */
export function refusedWith(status: number, error: string, code?: string): Answer {
  return { status, body: JSON.stringify({ error, ...(code ? { code } : {}) }), contentType: "application/json" };
}

/**
 * What this server answers for the backend's own 404 of the ROI route (a scenario
 * with no remediation option): "not served", with the code the views read as such
 * (tests/economics-route.test.ts pins the server's side of it).
 */
export const NOT_SERVED_ROI = {
  ...refusedWith(
    404,
    "not served: Athena-Backend does not serve the remediation option's economics here (The scenario has no remediation option with a residual run: record one and simulate it.)",
    "not_served",
  ),
};

export function shims(): void {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
}

/**
 * Render one scenario's views. `answers` maps a document (report, events, roi) to
 * what the server answers for it; `simulation` names a result.
 */
/** A read whose connection failed: no answer at all (fetch rejects, as a browser's does). */
export const NETWORK_ERROR = "network-error" as const;

/** A read the backend never answers: it waits until its signal aborts it. */
export const STALLED = "stalled" as const;

export async function mountEconomics(
  loaded: Fixture,
  answers: {
    report: Answer;
    events?: Answer;
    roi?: Answer | typeof NETWORK_ERROR;
    receipt?: Answer | typeof STALLED;
  },
  simulation?: string,
) {
  const { deployment, scenario } = idsOf(loaded);
  const requested: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requested.push(String(url));
    signals.push(init?.signal ?? undefined);
    const document = /^\/api\/economics\/(report|events|roi|receipt)\?/.exec(String(url))?.[1] as keyof typeof answers | undefined;
    const answer = document ? answers[document] : undefined;
    if (!answer) return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
    if (answer === NETWORK_ERROR) throw new TypeError("Failed to fetch");
    if (answer === STALLED) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return new Response(answer.body, {
      status: answer.status,
      headers: { ...(answer.headers ?? {}), "Content-Type": answer.contentType ?? "application/json" },
    });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
  const view = render(
    <QueryClientProvider client={client}>
      <EconomicsView deployment={deployment} scenario={scenario} simulation={simulation} />
    </QueryClientProvider>,
  );
  await waitFor(() => {
    if (screen.queryByTestId("economics-loading")) throw new Error("still reading");
  });
  return { ...view, requested, signals, deployment, scenario };
}

/** Every amount the views render: the string each one shows. */
export function renderedAmounts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-money]")).map((one) => one.getAttribute("data-amount") ?? "");
}

/** Every rendered text node's text, one by one (textContent would run two nodes' digits together). */
export function textNodes(container: HTMLElement): string[] {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const found: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) found.push(node.nodeValue ?? "");
  return found;
}

/** Every decimal token in the rendered text (an amount, a ratio, a share, a time's fraction). */
export function decimalTokens(container: HTMLElement): string[] {
  return textNodes(container).flatMap((one) => one.match(/\d+\.\d+/g) ?? []);
}

/** Every whitespace-separated word of the rendered text, its punctuation trimmed. */
export function words(container: HTMLElement): Set<string> {
  return new Set(textNodes(container).flatMap((one) => one.split(/\s+/)).map((word) => word.replace(/^[(\[]+|[),.;:\]]+$/g, "")));
}
