// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";

import Evidence from "@/pages/Evidence";

/**
 * The Evidence page opened with "Document the truth." A record documents what
 * someone observed or asserted and who put it on record; signing it proves who
 * recorded it and that it has not changed since, never that the observation
 * behind it is true. The page now says what a record is.
 */

afterEach(cleanup);

function mount() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          throw new Error(`unexpected fetch for ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  client.setQueryData(["/api/documents"], [
    {
      id: "d1", title: "Retest report", description: null, documentType: "Report",
      fileUrl: null, createdAt: "2026-09-20T00:00:00Z", createdBy: "u1",
    },
  ]);
  client.setQueryData(["/api/users/assignable"], [{ id: "u1", username: "analyst" }]);
  client.setQueryData(["/api/clients"], []);
  client.setQueryData(["/api/tests"], []);
  return render(
    <QueryClientProvider client={client}>
      <Evidence />
    </QueryClientProvider>,
  );
}

describe("the Evidence page's framing", () => {
  it("says a record shows what was asserted, not that it is true", () => {
    mount();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Document the truth/i);
    expect(
      screen.getByText(
        "What was recorded, by whom, and when. A record shows what was observed or asserted, not that it is true.",
      ),
    ).toBeTruthy();
    // And the page does show the who and the when it promises.
    expect(screen.getAllByText("Retest report").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/analyst/).length).toBeGreaterThan(0);
  });
});
