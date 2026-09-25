// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";

import Settings from "@/pages/Settings";

/**
 * /api/engine/status separates three things: whether the engine answered
 * (`reachable`), and whether it accepted the operator key (`authorized`:
 * true, false, or null for "could not be checked" -- server/engine.ts is
 * explicit that null is "not known, and not yes"). Settings folded them
 * together (adversary round 1, F5): authorized:null showed a green "Engine is
 * connected -- Reachable at ... and authorized.", and an engine that answered
 * but rejected the key showed the tile "Unreachable" and "Engine configured
 * but not reachable". The first two tests are the adversary's reproducers.
 */

afterEach(cleanup);

const URL = "https://engine:8443";

function mount(engine: unknown | "rejects" | "never resolves") {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          if (queryKey[0] === "/api/engine/status" && engine === "never resolves") return new Promise(() => {});
          throw new Error(`source failed: ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  client.setQueryData(["/api/settings/connections"], { fields: [] });
  client.setQueryData(["/api/api-keys"], []);
  if (engine !== "rejects" && engine !== "never resolves") client.setQueryData(["/api/engine/status"], engine);
  render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  );
  return client;
}

/** The Engine tile's figure. */
function engineTile(): string {
  const label = Array.from(document.querySelectorAll(".athena-label")).find((el) => el.textContent === "Engine");
  let node: Element | null = label ?? null;
  while (node && !node.querySelector(".athena-figure")) node = node.parentElement;
  return node?.querySelector(".athena-figure")?.textContent ?? "";
}

function guidance(): string {
  return screen.getByTestId("settings-card-guidance").textContent ?? "";
}

describe("Settings says what the server checked about the engine", () => {
  it("does not say 'authorized' when the server said the key could not be checked", () => {
    mount({
      configured: true, reachable: true, authorized: null, url: URL,
      detail: "the engine answered, but the key could not be checked: timeout",
    });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/and authorized/);
    expect(text).not.toMatch(/Engine is connected/);
    expect(guidance()).toContain("Engine reachable; operator key not checked");
    expect(guidance()).toContain("the engine answered, but the key could not be checked: timeout");
    expect(engineTile()).toBe("Key not checked");
  });

  it("does not call a reachable engine 'not reachable' when it only rejected the key", () => {
    mount({
      configured: true, reachable: true, authorized: false, url: URL,
      detail: "the engine rejected the operator key (401): bad key",
    });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Engine configured but not reachable/);
    expect(text).not.toMatch(/Unreachable/);
    expect(guidance()).toContain("Engine reachable; key rejected");
    expect(guidance()).toContain("the engine rejected the operator key (401): bad key");
    expect(engineTile()).toBe("Key rejected");
  });

  it("says connected and authorized only when the engine accepted the key", () => {
    mount({ configured: true, reachable: true, authorized: true, url: URL, detail: "ok" });
    expect(within(screen.getByTestId("settings-card-guidance")).getByText("Engine is connected")).toBeTruthy();
    expect(guidance()).toContain(`Reachable at ${URL} and authorized.`);
    expect(engineTile()).toBe("Connected");
  });

  it("says unreachable only when the engine did not answer", () => {
    mount({ configured: true, reachable: false, authorized: false, url: URL, detail: "connect ECONNREFUSED" });
    expect(guidance()).toContain("Engine configured but not reachable");
    expect(guidance()).toContain("connect ECONNREFUSED");
    expect(engineTile()).toBe("Unreachable");
  });

  it("does not say no engine is configured when it could not ask", async () => {
    const client = mount("rejects");
    await waitFor(() => expect(client.getQueryState(["/api/engine/status"])?.status).toBe("error"));
    expect(guidance()).not.toMatch(/No engine is configured/);
    expect(guidance()).toMatch(/Engine status could not be read/);
    expect(engineTile()).toBe("—");
  });

  it("does not say no engine is configured while it is still asking", async () => {
    const client = mount("never resolves");
    await waitFor(() => expect(client.getQueryState(["/api/engine/status"])?.fetchStatus).toBe("fetching"));
    expect(guidance()).not.toMatch(/No engine is configured/);
    expect(engineTile()).toBe("…");
  });
});
