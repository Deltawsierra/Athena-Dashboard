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

export type Answer = { status: number; body: string; contentType?: string };

/** The bytes of a recorded exchange, as this server streams them through. */
export function bytesOf(loaded: Fixture, name: string): Answer {
  const one = exchange(loaded, name);
  return { status: one.status, body: one.body, contentType: one.content_type };
}

/** What this server answers when the backend did not serve the document. */
export function refusedWith(status: number, error: string): Answer {
  return { status, body: JSON.stringify({ error }), contentType: "application/json" };
}

export const NO_ROI_ROUTE = refusedWith(
  404,
  "not served: Athena-Backend answered 404 for the remediation option's economics (no such document, or no such route at this backend version)",
);

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
export async function mountEconomics(
  loaded: Fixture,
  answers: { report: Answer; events?: Answer; roi?: Answer },
  simulation?: string,
) {
  const { deployment, scenario } = idsOf(loaded);
  const requested: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requested.push(String(url));
    const document = /^\/api\/economics\/(report|events|roi)\?/.exec(String(url))?.[1] as keyof typeof answers | undefined;
    const answer = document ? answers[document] : undefined;
    if (!answer) return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
    return new Response(answer.body, { status: answer.status, headers: { "Content-Type": answer.contentType ?? "application/json" } });
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
  return { ...view, requested, deployment, scenario };
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
