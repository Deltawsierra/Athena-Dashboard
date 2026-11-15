import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { CASES, DEP, FOUR, LEAK, NOT_A_LIST, clean, listAt, rows, standIn } from "./helpers/bad-rows";

/**
 * No assurance read fails whole because one row the backend served is bad
 * (server/assurance.ts rowsOf; DASH-ROWS, after Dash #94).
 *
 * Every read below mapped each of its lists, and the lists inside their rows,
 * with `(raw.x as Record<string, unknown>[]).map(...)`: the cast checks
 * nothing, so one null row threw, the whole read answered 500, and its panel
 * showed nothing at all. A number or a string row drew a blank one. Now every
 * list goes through rowsOf: the rows that can be read are shown, each one that
 * cannot is counted in the answer's `unreadable` under the list's name (a
 * list inside a row as `outer.inner`), and what a bad row held is never
 * carried. A clean answer has no `unreadable` at all.
 *
 * Each read is driven through its real route, against a stand-in backend, with
 * one row of each bad kind beside one good row in every list it maps.
 */

describe("no assurance read fails whole on one bad row of any list", () => {
  let backend: Awaited<ReturnType<typeof standIn>>;
  beforeAll(async () => { backend = await standIn(); });
  afterAll(async () => { await backend.close(); });

  async function read(path: string) {
    const res = await backend.user.get(path);
    expect(res.status, `${path}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    // What a row that could not be read held is never carried.
    expect(JSON.stringify(res.body), path).not.toContain(LEAK);
    return res.body as Record<string, unknown>;
  }

  it.each(CASES.map((one) => [one.route, one] as const))("%s: the rows it can read are shown, and each one it cannot is counted", async (_route, one) => {
    backend.serve({ [one.backend]: one.served });
    const body = await read(one.route);
    for (const list of one.lists) {
      expect(listAt(body, list), list).toHaveLength(1);
    }
    expect(body.unreadable).toEqual(Object.fromEntries(one.lists.map((list) => [list, FOUR])));
  });

  it.each(CASES.map((one) => [one.route, one] as const))("%s: a clean answer reads as it always did, with no count", async (_route, one) => {
    backend.serve({ [one.backend]: clean(one.served) });
    const body = await read(one.route);
    for (const list of one.lists) expect(listAt(body, list), list).toHaveLength(1);
    expect(body).not.toHaveProperty("unreadable");
  });

  it("a list whose every row is bad is still a read: none shown, all counted", async () => {
    backend.serve({ [`/api/assurance/deployments/${DEP}/capabilities/`]: { capabilities: [null, null], categories: [], summary: {} } });
    const body = await read(`/api/assurance/deployments/${DEP}/capabilities`);
    expect(body.capabilities).toEqual([]);
    expect(body.unreadable).toEqual({ capabilities: 2 });
  });

  it("a list served as something that is not a list is said to be one that could not be read, never an empty one", async () => {
    backend.serve({
      [`/api/assurance/deployments/${DEP}/vendor-assurance/`]: {
        vendors: [{ provider_uuid: "p-1", assertions: LEAK, dependent_assets: [] }],
        ungoverned_dependencies: { rows: [LEAK] },
        summary: {},
      },
    });
    const body = await read(`/api/assurance/deployments/${DEP}/vendor-assurance`);
    expect(body.unreadable).toEqual({ "vendors.assertions": NOT_A_LIST, ungovernedDependencies: NOT_A_LIST });
  });

  it("declared architecture: its declared rows are counted on the read, and its drift's on the drift", async () => {
    backend.serve({
      [`/api/assurance/deployments/${DEP}/declared-architecture/`]: {
        declared: rows({ uuid: "d-1", name: "model" }),
        drift: { undeclared: rows({ asset_uuid: "a-1" }), missing: rows({ declared_uuid: "d-1" }), summary: {} },
      },
    });
    const body = await read(`/api/assurance/deployments/${DEP}/declared-architecture`);
    expect(body.declared).toHaveLength(1);
    expect(body.unreadable).toEqual({ declared: FOUR });
    const drift = body.drift as Record<string, unknown>;
    expect(drift.undeclared).toHaveLength(1);
    expect(drift.missing).toHaveLength(1);
    expect(drift.unreadable).toEqual({ undeclared: FOUR, missing: FOUR });
  });
});
