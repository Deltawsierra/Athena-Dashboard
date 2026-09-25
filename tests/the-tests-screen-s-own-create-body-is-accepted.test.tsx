// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import Tests from "@/pages/Tests";
import { queryClient } from "@/lib/queryClient";
import { makeApp, signIn } from "./helpers";

/**
 * PR #52 round 3, F6 (pre-existing since #13). The Tests screen built its
 * create body as an InsertTest -- the table's insert type, which carries
 * `executedBy` -- and sent `executedBy: null`. The route refuses any body
 * that names attribution ("executedBy is recorded from the signed-in session
 * and cannot be supplied"), rightly: who ran a test is evidence. So every
 * create from that screen answered 400, and no test could be recorded there.
 *
 * The server was right and the client was wrong. The screen now builds the
 * route's own schema type (CreateTest, shared), which has no `executedBy`,
 * and leaves `completedAt` to the server, which stamps it. This captures the
 * body the screen actually sends, then sends exactly that to the real routes.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); queryClient.clear(); });

describe("the Tests screen's own create body", () => {
  it("is what the create route accepts: no attribution, and a completion time the server stamps", async () => {
    const app = await makeApp();
    const agent = await signIn(app);
    const client = (await agent.post("/api/clients").send({ name: "UiCreate", company: "UiCreate", email: "ui@example.test" })).body;
    const site = (await agent.post("/api/sites").send({ clientId: client.id, name: "App", url: "https://e.example" })).body;

    // The screen, against a stubbed API that records what it sends.
    const sent: unknown[] = [];
    const reads: Record<string, unknown> = {
      "/api/tests": [], "/api/clients": [client], "/api/sites": [site],
      "/api/sample-data": { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 },
      "/api/auth/check": { authenticated: true, user: null },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        sent.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } });
      }
      const body = reads[String(url).split("?")[0]];
      return new Response(JSON.stringify(body ?? null), { status: body === undefined ? 404 : 200, headers: { "Content-Type": "application/json" } });
    }));
    render(<QueryClientProvider client={queryClient}><Tests /></QueryClientProvider>);
    fireEvent.click(await screen.findByTestId("button-create-test"));
    const form = (await screen.findByTestId("button-submit")).closest("form") as HTMLFormElement;
    const select = (name: string) => form.querySelector(`select[name="${name}"]`) as HTMLSelectElement;
    await waitFor(() => expect(select("clientId").querySelector(`option[value="${client.id}"]`)).toBeTruthy());
    fireEvent.change(select("clientId"), { target: { value: client.id } });
    fireEvent.change(select("siteId"), { target: { value: site.id } });
    fireEvent.change(select("testType"), { target: { value: "penetration-test" } });
    fireEvent.change(select("status"), { target: { value: "completed" } });
    fireEvent.change(select("severity"), { target: { value: "critical" } });
    fireEvent.change(screen.getByTestId("input-vulnerabilities"), { target: { value: "5" } });
    fireEvent.change(screen.getByTestId("input-critical"), { target: { value: "3" } });
    fireEvent.change(screen.getByTestId("input-high"), { target: { value: "2" } });
    fireEvent.submit(form);
    await waitFor(() => expect(sent).toHaveLength(1));

    const body = sent[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("executedBy");
    expect(body).toMatchObject({
      clientId: client.id, siteId: site.id, testType: "penetration-test", status: "completed",
      severity: "critical", vulnerabilitiesFound: 5, criticalCount: 3, highCount: 2,
    });

    // Exactly that body, to the real route.
    const before = Date.now();
    const created = await agent.post("/api/tests").send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.executedBy).toBeTruthy();
    expect(new Date(created.body.completedAt).getTime()).toBeGreaterThanOrEqual(before);
    // And a body that does name attribution is still refused.
    const forged = await agent.post("/api/tests").send({ ...body, executedBy: null });
    expect(forged.status).toBe(400);
  });
});
