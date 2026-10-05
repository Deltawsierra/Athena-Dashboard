// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";

import App from "@/App";

// The decorative layers want a GPU and a layout engine jsdom does not have; the app is what is under test.
vi.mock("@/components/three/AmbientField", () => ({ default: () => null }));
vi.mock("@/components/MagneticCursor", () => ({ default: () => null }));
vi.mock("@/components/CursorGlow", () => ({ default: () => null }));
vi.mock("@/components/SmoothScroll", () => ({ default: ({ children }: { children: unknown }) => children }));

/**
 * An account that must change its password sees the change-password screen
 * before anything else -- when sign-in says so, when the session it already
 * holds says so, and when the server refuses a request with "password change
 * required". The kill switch stays reachable on that screen for an admin:
 * pressing it sends the switch, and only the switch, and the screen says
 * engaged only when the server's answer does.
 */

const USER = { id: "u1", username: "admin", role: "admin", email: null, isActive: true, mustChangePassword: true, createdAt: "2026-01-01T00:00:00Z" };
type Sent = { method: string; url: string; body: unknown };

function serve(answers: (sent: Sent) => { status: number; body: unknown } | undefined): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const one: Sent = { method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    sent.push(one);
    const answer = answers(one) ?? { status: 404, body: { message: "not found" } };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } });
  }));
  return sent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the change-password screen comes first and keeps the kill switch", () => {
  it("a session that must change its password opens on the change-password screen, with the kill switch, and no shell", async () => {
    const sent = serve((one) => {
      if (one.url === "/api/auth/check") return { status: 200, body: { authenticated: true, user: USER } };
      if (one.url === "/api/ai-control" && one.method === "PATCH") {
        return { status: 200, body: { killSwitchEnabled: true, stops: { sent: 1, accepted: 1 }, engineRuns: { sent: 0, accepted: 0 } } };
      }
      return undefined;
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("input-new-password")).toBeTruthy());
    expect(screen.queryByText("Overview")).toBeNull();

    await act(async () => { fireEvent.click(screen.getByTestId("button-change-password-kill-switch")); });
    await waitFor(() => expect(screen.getByTestId("text-change-password-kill-switch").textContent).toMatch(/kill switch is engaged/));
    const pressed = sent.filter((one) => one.url === "/api/ai-control");
    expect(pressed).toEqual([{ method: "PATCH", url: "/api/ai-control", body: { killSwitchEnabled: true } }]);
  });

  it("says the switch was not engaged when the server's answer does not say engaged", async () => {
    serve((one) => {
      if (one.url === "/api/auth/check") return { status: 200, body: { authenticated: true, user: USER } };
      if (one.url === "/api/ai-control") return { status: 503, body: { message: "the database is locked" } };
      return undefined;
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("button-change-password-kill-switch")).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByTestId("button-change-password-kill-switch")); });
    await waitFor(() => expect(screen.getByTestId("text-change-password-kill-switch").textContent).toMatch(/was not engaged/));
  });

  it("a new password is sent with the current one, and the app opens once the server clears the flag", async () => {
    const sent = serve((one) => {
      if (one.url === "/api/auth/check") return { status: 200, body: { authenticated: true, user: USER } };
      if (one.url === "/api/auth/change-password") return { status: 200, body: { user: { ...USER, mustChangePassword: false } } };
      return undefined;
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("input-current-password")).toBeTruthy());
    fireEvent.change(screen.getByTestId("input-current-password"), { target: { value: "the-initial-password" } });
    fireEvent.change(screen.getByTestId("input-new-password"), { target: { value: "a-new-and-long-password" } });
    fireEvent.change(screen.getByTestId("input-confirm-password"), { target: { value: "a-new-and-long-password" } });
    await act(async () => { fireEvent.click(screen.getByTestId("button-change-password")); });
    await waitFor(() => expect(screen.queryByTestId("input-new-password")).toBeNull());
    expect(sent.find((one) => one.url === "/api/auth/change-password")?.body)
      .toEqual({ currentPassword: "the-initial-password", newPassword: "a-new-and-long-password" }); // pragma: allowlist secret
  });

  it("a request refused with \"password change required\" while the app is open brings the change-password screen", async () => {
    let checks = 0;
    serve((one) => {
      if (one.url === "/api/auth/check") {
        checks += 1;
        return { status: 200, body: { authenticated: true, user: { ...USER, mustChangePassword: checks > 1 } } };
      }
      return { status: 403, body: { error: "password change required" } };
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("input-new-password")).toBeTruthy());
    expect(checks).toBeGreaterThan(1);
  });

  it("an admin opens the failsafe console from it, and drafts a stand-down without changing the password", async () => {
    const sent = serve((one) => {
      if (one.url === "/api/auth/check") return { status: 200, body: { authenticated: true, user: USER } };
      if (one.url.startsWith("/api/failsafe/status")) {
        return { status: 200, body: { configured: true, reachable: true, authorized: true, url: "https://cp.test", detail: "", defaultEngineId: "engine-1" } };
      }
      if (one.url.startsWith("/api/failsafe/state")) return {
        status: 200,
        body: { engineId: "engine-1", engineState: "running", engineStateAvailable: true, awaitingSignatures: [], ready: [], recent: [] },
      };
      if (one.url.startsWith("/api/failsafe/audit")) return { status: 403, body: { error: "password change required" } };
      return undefined;
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("button-change-password-failsafe")).toBeTruthy());
    expect(screen.queryByTestId("change-password-failsafe-console")).toBeNull();

    await act(async () => { fireEvent.click(screen.getByTestId("button-change-password-failsafe")); });

    await waitFor(() => expect(screen.getByTestId("button-draft-stand_down")).toBeTruthy());
    expect(screen.getByTestId("input-new-password")).toBeTruthy();
    expect(sent.some((one) => one.url.startsWith("/api/failsafe/status"))).toBe(true);
  });

  it("an account that is not an admin is offered neither the kill switch nor the console", async () => {
    serve((one) => (one.url === "/api/auth/check"
      ? { status: 200, body: { authenticated: true, user: { ...USER, role: "user" } } }
      : undefined));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("input-new-password")).toBeTruthy());
    expect(screen.queryByTestId("button-change-password-failsafe")).toBeNull();
    expect(screen.queryByTestId("button-change-password-kill-switch")).toBeNull();
  });

  it("refuses a short new password before sending it", async () => {
    const sent = serve((one) => (one.url === "/api/auth/check" ? { status: 200, body: { authenticated: true, user: USER } } : undefined));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("input-current-password")).toBeTruthy());
    fireEvent.change(screen.getByTestId("input-current-password"), { target: { value: "the-initial-password" } });
    fireEvent.change(screen.getByTestId("input-new-password"), { target: { value: "too-short" } });
    fireEvent.change(screen.getByTestId("input-confirm-password"), { target: { value: "too-short" } });
    await act(async () => { fireEvent.click(screen.getByTestId("button-change-password")); });
    expect(screen.getByTestId("text-change-password-error").textContent).toMatch(/at least 12 characters/);
    expect(sent.some((one) => one.url === "/api/auth/change-password")).toBe(false);
  });
});
