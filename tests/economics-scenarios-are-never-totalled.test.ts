import { describe, it, expect, beforeAll } from "vitest";
import type { Express } from "express";

import { makeApp, signIn } from "./helpers";
import { ECONOMICS_ROUTES } from "../server/economics";
import { MASTER, fixture, served } from "./helpers/economics-fixtures";

/**
 * Honesty rule: scenarios are never totalled. A portfolio total is the backend's
 * to make (E5), under its own fail-closed rule (report.may_be_totalled), and is
 * out of this scope: this dashboard reads the figures of ONE scenario version at
 * a time and offers no route that adds scenarios up -- under /api/economics or
 * anywhere else on this server. The deployment's scenario list (Athena-Backend
 * #163) names its versions, each with its own standing, and carries no figure:
 * it is passed on as served, to pick one version from.
 * (That the views add up nothing within a scenario either -- no figure the
 * backend did not serve -- is tests/economics-the-browser-does-no-arithmetic-on-money;
 * that the picker adds up nothing is tests/economics-the-scenario-picker-pages-what-the-backend-lists.)
 */

const READS = [
  "/api/economics/events", "/api/economics/receipt", "/api/economics/report", "/api/economics/roi", "/api/economics/scenarios",
];

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
  it("the economics routes are five reads -- three of one scenario version, the list and one receipt -- and nothing else", () => {
    expect(ECONOMICS_ROUTES.slice().sort()).toEqual(READS);
    expect(economicsRoutes(app)).toEqual(READS.map((path) => `GET ${path}`));
  });

  it("the scenario list carries no figure and no total: each version's own standing, and nothing summed", () => {
    const loaded = fixture(MASTER, "scenario-list");
    const pages = ["list-page-1", "list-page-2", "list-page-3", "list-default"].map((name) => served(loaded, name) as Record<string, any>);
    for (const page of pages) {
      expect(Object.keys(page).sort()).toEqual(["count", "deployment", "next", "page", "page_size", "pages", "previous", "scenarios", "statement"]);
      for (const entry of page.scenarios as Array<Record<string, unknown>>) {
        expect(Object.keys(entry).sort()).toEqual([
          "banner", "banner_reason", "excluded_from_totals", "grade", "latest_exposure_run", "recorded_at", "supersedes", "templates", "title", "uuid",
        ]);
      }
    }
  });

  it("nor does any other route of this server: none outside the five reads names a total, a portfolio or economics", () => {
    const stack = (app as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })._router.stack;
    const paths = stack.filter((layer) => layer.route).map((layer) => String(layer.route!.path));
    expect(paths.length).toBeGreaterThan(100);
    const named = paths.filter((path) => /total|portfolio|aggregat|econom|financ|exposure/i.test(path));
    expect(named.sort()).toEqual(READS);
  });

  it("a total or a portfolio is no route here", async () => {
    for (const path of [
      "/api/economics/total", "/api/economics/totals", "/api/economics/portfolio", "/api/economics/scenarios/total",
      "/api/economics/report/total", "/api/economics/receipts", "/api/assurance/economics/total", "/api/assurance/portfolio",
      "/api/portfolio", "/api/totals",
    ]) {
      const res = await admin.get(path);
      expect(res.status, path).toBe(404);
    }
  });
});
