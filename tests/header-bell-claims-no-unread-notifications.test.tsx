// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";

import AppShell from "@/components/AppShell";

/**
 * The header bell carried a lit "unread" dot on every screen, for every user,
 * in every build (adversary round 1, F12). No notifications query exists and
 * the button does nothing, so nothing in the data produced that claim. The
 * dot is gone; nothing says there is something unread when nothing records
 * notifications at all. Adapted from the adversary's reproducer.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          throw new Error(`source failed: ${JSON.stringify(queryKey)}`);
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

describe("the header notification bell", () => {
  it("shows no unread indicator nothing backs (sample mode off)", () => {
    mount();
    const bell = screen.getByTestId("button-notifications");
    expect(bell.querySelectorAll("span").length, "a lit unread dot with no notifications source").toBe(0);
    expect(bell.getAttribute("title")).toMatch(/not tracked/);
  });

  it("shows none in sample mode either", () => {
    vi.stubEnv("VITE_MYTHOS_SAMPLE_MODE", "1");
    mount();
    expect(screen.getByTestId("button-notifications").querySelectorAll("span").length).toBe(0);
  });
});
