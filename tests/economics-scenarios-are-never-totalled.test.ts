import { describe, it, expect, beforeAll } from "vitest";
import type { Express } from "express";

import { makeApp, signIn } from "./helpers";
import { ECONOMICS_ROUTES } from "../server/economics";

/**
 * Honesty rule: scenarios are never totalled. A portfolio total is the backend's
 * to make (E5), under its own fail-closed rule (report.may_be_totalled), and is
 * out of this scope: this dashboard reads ONE scenario version at a time and
 * offers no route that adds scenarios up, or reads more than one at once --
 * under /api/economics or anywhere else on this server.
 * (That the views add up nothing within a scenario either -- no figure the
 * backend did not serve -- is tests/economics-the-browser-does-no-arithmetic-on-money.)
 */

let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  app = await makeApp();
  admin = await signIn(app);
});

/** Every route the app registers under /api/economics, as "METHOD path". */
function economicsRoutes(express: Express): string[] {
  const stack = (express as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })._router.stack;
  return stack
    .filter((layer) => layer.route && String(layer.route.path).startsWith("/api/economics"))
    .flatMap((layer) => Object.keys(layer.route!.methods).map((method) => `${method.toUpperCase()} ${layer.route!.path}`))
    .sort();
}

describe("no economics route totals scenarios", () => {
  it("the economics routes are three reads, each of one scenario version, and nothing else", () => {
    expect(ECONOMICS_ROUTES.slice().sort()).toEqual(["/api/economics/events", "/api/economics/report", "/api/economics/roi"]);
    expect(economicsRoutes(app)).toEqual(["GET /api/economics/events", "GET /api/economics/report", "GET /api/economics/roi"]);
  });

  it("nor does any other route of this server: none outside the three reads names a total, a portfolio or economics", () => {
    const stack = (app as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })._router.stack;
    const paths = stack.filter((layer) => layer.route).map((layer) => String(layer.route!.path));
    expect(paths.length).toBeGreaterThan(100);
    const named = paths.filter((path) => /total|portfolio|aggregat|econom|financ|exposure/i.test(path));
    expect(named.sort()).toEqual(["/api/economics/events", "/api/economics/report", "/api/economics/roi"]);
  });

  it("a total, a portfolio or a list of scenarios is no route here", async () => {
    for (const path of [
      "/api/economics/total", "/api/economics/totals", "/api/economics/portfolio", "/api/economics/scenarios",
      "/api/economics/report/total", "/api/assurance/economics/total", "/api/assurance/portfolio", "/api/portfolio",
      "/api/totals",
    ]) {
      const res = await admin.get(path);
      expect(res.status, path).toBe(404);
    }
  });
});
