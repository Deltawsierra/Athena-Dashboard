import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";

import { NOT_A_LIST } from "@shared/unreadable-rows";
import { standIn } from "./helpers/bad-rows";
import {
  APPROVAL_OPEN, APPROVAL_WINDOWED, CANNOT_COMPARE_WHY, CHAIN_KEY, CHAINS_ROUTE, DEP, DEP_EMPTY, DEP_NO_LIST, DEP_NOT_A_LIST, DEP_OLDER,
  KEYED, OVER, ROUTE, WORDS, overBoundDetail, servedByPath,
} from "./helpers/observed-effects";

/**
 * The read behind the observed effects on the authority chains screen
 * (server/assurance.ts chainOutcomes; GET /api/assurance/deployments/:uuid/chain-outcomes
 * on this server, from Athena-Backend's chain-outcomes/ as #234 serves it), and the
 * reconciliation receipts the authority-chains read now carries:
 *
 *   - each row's `effect_reading` is mapped part by part, in the core's words as served:
 *     the binding with each approval and what was counted, the execution, the key id,
 *     the findings;
 *   - NO KEYED VALUE IS RELAYED: a keyed reference is carried as `{form: "keyed"}`, and a
 *     reference in a form not known here as `unrecognised`, so none of the 64 hex the
 *     backend served reaches this console's answer;
 *   - an older record's parts are carried as served (null where the backend serves null),
 *     never filled in; a part not served stays absent; one that cannot be read is named;
 *   - a row with no `effect_reading` (a backend before #234) is "not_reported", one with
 *     null is "none": never the same;
 *   - a row that cannot be read is counted, never dropped; an answer with no list of
 *     outcomes is unavailable, never none;
 *   - the route is a GET under the read deadline, and this server serves nothing else on it.
 */

let backend: Awaited<ReturnType<typeof standIn>>;

beforeAll(async () => {
  backend = await standIn();
  backend.serve(servedByPath());
}, 120_000);
afterAll(async () => {
  await backend?.close();
});

async function read(path: string) {
  const res = await backend.user.get(path);
  return res;
}

function row(body: { outcomes: Array<{ outcomeId: string | null }> }, id: string) {
  const found = body.outcomes.find((one) => one.outcomeId === id);
  if (!found) throw new Error(`no row ${id}`);
  return found as Record<string, unknown> & { effect: Record<string, unknown> };
}

describe("a version 5 record's reading", () => {
  it("is carried part by part in the core's words: the binding, each approval and what was counted, the execution and the key id", async () => {
    const res = await read(ROUTE(DEP));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(row(res.body, "oe-v5")).toEqual({
      uuid: "row-oe-v5", outcomeId: "oe-v5", workflow: "fleet-wipe", status: "held", statusLabel: "Held",
      evidenceKind: "observed_effect", evidenceKindLabel: "Observed effect", observerEngine: "achilles-effect",
      basisInForce: "demonstrated", signed: true, observedAt: "2026-11-16T12:00:00.123456+00:00", recordedAt: "2026-11-16T12:01:00+00:00",
      effect: {
        served: "reading",
        reading: {
          schema: "mythos.observed-effect/v5",
          digests: WORDS.keyed,
          digestsServed: WORDS.keyed,
          actionReference: { form: "keyed" },
          responseReference: { form: "keyed" },
          keyedUnder: { chain: "v2", chainKey: CHAIN_KEY },
          execution: { state: "accepted", basis: "observed", words: WORDS.asSigned },
          toolBinding: {
            kind: "mcp_server", identifier: "fleet-tools", generation: { form: "keyed" }, effect: "destructive",
            targetCount: 3, maxTargets: 3, targets: { form: "keyed" },
            approvals: [
              { approval: APPROVAL_OPEN, effect: "destructive", targetCount: 3, maxTargets: null, windowS: null, targets: { form: "keyed" }, counted: null },
              {
                approval: APPROVAL_WINDOWED, effect: "destructive", targetCount: 40, maxTargets: 25, windowS: 3600, targets: { form: "keyed" },
                counted: { counted: 3, rested: false, windowCount: 23, lifetimeCount: 31 },
              },
            ],
          },
          toolBindingReading: WORDS.within,
          findings: [],
        },
      },
    });
  });

  it("relays no keyed value, and no plain digest served where a reference belongs: not one of the backend's 64 hex", async () => {
    const res = await read(ROUTE(DEP));
    const text = JSON.stringify(res.body);
    for (const [name, hex] of Object.entries(KEYED)) expect(text.includes(hex), name).toBe(false);
    expect(text).not.toContain("hmac-sha256");
    // A v5 row whose answer reference was served as a plain digest: carried as unrecognised, its value dropped.
    expect(text).not.toContain("77".repeat(32));
    expect(row(res.body, "oe-withheld").effect).toMatchObject({
      reading: { actionReference: { form: "withheld", why: "chain-key-unkept" }, responseReference: { form: "unrecognised" } },
    });
    // And not the evidence digest or the observer's key id either: the view reads neither.
    expect(text).not.toContain("9e".repeat(32));
  });

  it("carries the backend's named finding where the binding's bound is larger than an approval's, in its words", async () => {
    const res = await read(ROUTE(DEP));
    const reading = row(res.body, "oe-over").effect.reading as Record<string, unknown>;
    expect(reading.findings).toEqual([
      {
        code: "binding_bound_over_approval", approval: APPROVAL_WINDOWED, bindingMaxTargets: OVER.bound, approvalMaxTargets: OVER.limit,
        detail: overBoundDetail(OVER.bound, OVER.limit, APPROVAL_WINDOWED),
      },
    ]);
    expect(reading).toMatchObject({ toolBinding: { maxTargets: OVER.bound, targetCount: 4 }, toolBindingReading: WORDS.within });
  });

  it("carries a binding the permit never made as null, beside the core's words for it", async () => {
    const res = await read(ROUTE(DEP));
    expect(row(res.body, "oe-unbound").effect).toMatchObject({ served: "reading", reading: { toolBinding: null, toolBindingReading: WORDS.noBound, findings: [] } });
  });
});

describe("an older record's reading (versions 1 to 4)", () => {
  for (const version of [1, 2, 3, 4]) {
    it(`version ${version}: plain digests withheld, no key, no binding, accepted from its 2xx -- each as served, none filled in`, async () => {
      const res = await read(ROUTE(DEP));
      expect(row(res.body, `oe-v${version}`).effect).toEqual({
        served: "reading",
        reading: {
          schema: `mythos.observed-effect/v${version}`,
          digests: WORDS.plain,
          digestsServed: WORDS.withheld,
          actionReference: { form: "withheld", why: "plain-digest" },
          responseReference: { form: "withheld", why: "plain-digest" },
          keyedUnder: null,
          execution: { state: "accepted", basis: "inferred", words: WORDS.noExecutionField },
          toolBinding: null,
          toolBindingReading: WORDS.noBinding,
          findings: [],
        },
      });
    });
  }
});

describe("what is not a reading is said apart from one", () => {
  it("a row the backend serves no reading for is none; one it serves a reading that is not one for is unreadable", async () => {
    const res = await read(ROUTE(DEP));
    expect(row(res.body, "oe-none").effect).toEqual({ served: "none" });
    expect(row(res.body, "oe-odd").effect).toEqual({ served: "unreadable" });
    // The gate's own decision is carried as what it is: not an observed effect.
    expect(row(res.body, "gate-1")).toMatchObject({ evidenceKind: "authorization_check", effect: { served: "none" } });
  });

  it("a backend before #234 serves no reading: each row is not reported, never none", async () => {
    const res = await read(ROUTE(DEP_OLDER));
    expect(res.status).toBe(200);
    expect(res.body.outcomes.map((one: { effect: unknown }) => one.effect)).toEqual([
      { served: "not_reported" }, { served: "not_reported" }, { served: "not_reported" },
    ]);
    // The row that does not say its kind says so: null, never a kind made up here.
    expect(res.body.outcomes[2].evidenceKind).toBeNull();
    expect(res.body).not.toHaveProperty("unreadable");
  });

  it("a part not served stays absent, and a part served in a shape that cannot be read is named, never dropped", async () => {
    const res = await read(ROUTE(DEP));
    const reading = row(res.body, "oe-partial").effect.reading as Record<string, unknown>;
    expect(reading.unreadableFields).toEqual(["actionReference", "execution"]);
    expect(reading.digestsServed).toBeNull();
    expect(reading.toolBindingReading).toBeNull();
    expect(reading).not.toHaveProperty("responseReference");
    expect(reading).not.toHaveProperty("actionReference");
    expect(reading).not.toHaveProperty("execution");
    expect(reading.keyedUnder).toEqual({ chain: null, chainKey: CHAIN_KEY, unreadableFields: ["chain"] });
    const binding = reading.toolBinding as Record<string, unknown>;
    expect(binding.targetCount).toBeNull();
    expect(binding.unreadableFields).toEqual(["targetCount"]);
    // An approval that serves neither its limit nor its count: both absent, never "names none".
    expect(binding.approvals).toEqual([{ approval: APPROVAL_OPEN, effect: "destructive", targetCount: 3, targets: { form: "keyed" } }]);
    expect(binding.unreadable).toEqual({ approvals: 4 });
    // Findings that cannot be read are counted, and the list is no "no finding".
    expect(reading.findings).toEqual([]);
    expect(reading.unreadable).toEqual({ findings: 3 });
  });
});

describe("the page of outcomes", () => {
  it("counts the rows that cannot be read beside the rows read, and carries the page's counts as served", async () => {
    const res = await read(ROUTE(DEP));
    expect(res.body.unreadable).toEqual({ outcomes: 4 });
    expect(res.body.outcomes).toHaveLength(12);
    expect(res.body).toMatchObject({ returned: 16, truncated: true, pageSize: 100, recordedCount: 340 });
  });

  it("an empty page is an empty page; one whose outcomes are not a list says so; one with no list at all is unavailable", async () => {
    const empty = await read(ROUTE(DEP_EMPTY));
    expect(empty.body).toEqual({ outcomes: [], returned: 0, truncated: false, pageSize: 100, recordedCount: 0 });
    const notAList = await read(ROUTE(DEP_NOT_A_LIST));
    expect(notAList.status).toBe(200);
    expect(notAList.body.outcomes).toEqual([]);
    expect(notAList.body.unreadable).toEqual({ outcomes: NOT_A_LIST });
    const none = await read(ROUTE(DEP_NO_LIST));
    expect(none.status).toBe(503);
    expect(none.body.outcomes).toBeUndefined();
  });

  it("a deployment the backend does not know, or does not show this person, is its 404, passed on", async () => {
    const res = await read(ROUTE("dep-unknown"));
    expect(res.status).toBe(404);
    expect(res.body.outcomes).toBeUndefined();
  });
});

describe("the receipts read back into a chain's produces hop", () => {
  it("are carried with whether each verifies and binds, and the backend's words for why not; a bad row is counted", async () => {
    const res = await read(CHAINS_ROUTE(DEP));
    expect(res.status).toBe(200);
    const [heldBack, proven, none, olderChain] = res.body.chains;
    expect(heldBack.reconciliations).toEqual([
      {
        receiptId: "rcpt-2", dispatchId: "d-77", attempt: 1, gateOutcomeId: "gate-1", answer: "applied", conclusion: "committed",
        readAt: "2026-11-16T12:05:00.000000Z", provider: "fleet-provider", verified: true, binds: false, why: CANNOT_COMPARE_WHY,
      },
      expect.objectContaining({ receiptId: "rcpt-3", verified: false, binds: false }),
      // Not said is null: never read as binding, and never as not.
      expect.objectContaining({ receiptId: "rcpt-4", verified: null, binds: null, why: null }),
    ]);
    expect(heldBack.unreadable).toEqual({ reconciliations: 4 });
    expect(heldBack.hops[0].reasons[0].code).toBe("reconciliation_cannot_compare");
    expect(proven.reconciliations).toHaveLength(1);
    expect(proven).not.toHaveProperty("unreadable");
    expect(none.reconciliations).toEqual([]);
    // A backend from before F1 serves none: absent, never an empty list.
    expect(olderChain).not.toHaveProperty("reconciliations");
  });
});

describe("the read is a GET under the read deadline, and nothing is written", () => {
  type RouteLayer = { route?: { path: string | string[]; methods: Record<string, boolean>; stack: Array<{ handle: { name: string } }> }; handle: { name: string }; match: (path: string) => boolean };

  it("this server routes only GET on the outcomes' path, and the read passes the read deadline's layer first", async () => {
    const { makeApp } = await import("./helpers");
    const app: Express = await makeApp();
    const routes = (app as unknown as { _router: { stack: RouteLayer[] } })._router.stack;
    const path = ROUTE("00000000-0000-4000-8000-0000000000aa");
    const methods = routes
      .filter((layer) => layer.route && typeof layer.route.path === "string" && layer.route.path.endsWith("/chain-outcomes") && layer.match(path))
      .flatMap((layer) => Object.keys(layer.route!.methods).filter((method) => layer.route!.methods[method]).map((method) => method.toUpperCase()));
    expect(methods).toEqual(["GET"]);
    let bounded = false;
    for (const layer of routes) {
      if (!layer.match(path)) continue;
      if (!layer.route && layer.handle.name === "boundedRelayReadLayer") { bounded = true; break; }
      if (layer.route?.methods.get) break;
    }
    expect(bounded, "the read is cut at the read deadline").toBe(true);
  });

  it("a POST to the outcomes' path is never relayed: the backend's write is not reachable from here", async () => {
    const res = await backend.user.post(ROUTE(DEP)).send({ outcomes: [{ workflow: "fleet-wipe", status: "held" }] });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
  });
});
