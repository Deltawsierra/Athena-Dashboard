import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * Four values this console invented when the control plane said nothing.
 *
 * Each was a `num(x, 0)` or a `bool(x)` in the mapper — a fallback that turns
 * "nobody said" into a definite claim, and a definite claim is what an operator
 * acts on:
 *
 *   1. `ttl_days`  -> the sentence "0-day TTL": this deployment's evidence
 *                     expires the instant it is written.
 *   2. `stages_total` / `evidenced` -> "0/0 stages evidenced": reads as a
 *                     measurement over every stage, when nothing was measured.
 *   3. stage `gap`  -> false: "this stage has no gap".
 *   4. ripple `bounded` -> false: "this list is not bounded", i.e. complete.
 *
 * Every case below is paired with a NEGATIVE CONTROL sending the real `0` or
 * `false`, because "never invent a number" is trivially satisfied by never
 * reporting one. The two must reach the response distinguishably, and the
 * assertion that the two response bodies differ is what pins that.
 *
 * Three deployments, one per posture:
 *   dep-measured — the control plane measured, and the answer happens to be
 *                  0 / false. A real finding. It must survive as 0 / false.
 *   dep-silent   — the control plane sent no such key at all. Older control
 *                  planes do exactly this; the console ships independently of
 *                  it, so this is the ordinary skew case, not a hypothetical.
 *   dep-real     — ordinary non-zero values, so a mapper that answered null to
 *                  everything would fail here.
 */

const OPERATIONAL = {
  system: { name: "checkout", uuid: "dep", environment: "prod", environment_label: "Production" },
  decision: { decision: "ready", decision_label: "Ready" },
  evidence_freshness: { total: 4, current: 3, stale: 1, ttl_days: 90, freshness_ratio: 0.75 },
  change_backlog: { total: 0, new: 0, recurring: 0, cleared: 0, by_status: {}, needs_reassessment: 0 },
  remediation: { open: 0, resolved: 0, wont_fix: 0, by_state: {}, states_reached: [], event_count: 0 },
  readiness: "ready",
  summary: { total_findings: 4, current_evidence: 3, stale_evidence: 1, readiness: "ready" },
};

const RIPPLE = {
  origins: [],
  consequences: [],
  summary: {
    origins: 2,
    origins_with_reach: 1,
    consequences: 3,
    evidenced_consequences: 5,
    bounded: true,
    by_category: {},
    worst_risk: "elevated",
  },
};

const LIFECYCLE = {
  stages: [
    {
      stage: "collection", stage_label: "Collection", control_stage: true, evidenced: true,
      components: [], weakest_evidence: "configuration_verified",
      weakest_evidence_label: "Configuration-verified", gap: true,
      gap_detail: "no retention control evidenced", risk: "elevated",
    },
  ],
  gaps: [],
  summary: { stages_total: 6, evidenced: 4, not_evidenced: 2, control_gaps: 1, worst_risk: "elevated" },
};

/** The same payload with the named keys deleted — the control plane said nothing. */
function withoutKeys<T extends Record<string, unknown>>(obj: T, keys: string[]): T {
  const copy: Record<string, unknown> = { ...obj };
  for (const k of keys) delete copy[k];
  return copy as T;
}

describe("four values nobody measured", () => {
  let app: Express;
  let user: Awaited<ReturnType<typeof signIn>>;
  let server: Server;

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      const method = req.method ?? "GET";
      const path = (req.url ?? "").split("?")[0];
      const json = (code: number, payload: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (path === "/api/token/" && method === "POST") {
        return json(200, { access: "svc-access-token", refresh: "r" });
      }

      // ---- operational assurance: the TTL ----
      if (path === "/api/assurance/deployments/dep-real/operational-assurance/") {
        return json(200, OPERATIONAL);
      }
      if (path === "/api/assurance/deployments/dep-measured/operational-assurance/") {
        // A control plane that measured and reports a zero-day TTL. Absurd as a
        // policy, but it is an answer, and an answer must survive the mapper.
        return json(200, {
          ...OPERATIONAL,
          evidence_freshness: { ...OPERATIONAL.evidence_freshness, ttl_days: 0 },
        });
      }
      if (path === "/api/assurance/deployments/dep-silent/operational-assurance/") {
        return json(200, {
          ...OPERATIONAL,
          evidence_freshness: withoutKeys(OPERATIONAL.evidence_freshness, ["ttl_days"]),
        });
      }

      // ---- ripple effect: bounded ----
      if (path === "/api/assurance/deployments/dep-real/ripple-effect/") {
        return json(200, RIPPLE);
      }
      if (path === "/api/assurance/deployments/dep-measured/ripple-effect/") {
        // "We checked, and this list is complete." A fact about the list.
        return json(200, { ...RIPPLE, summary: { ...RIPPLE.summary, bounded: false } });
      }
      if (path === "/api/assurance/deployments/dep-silent/ripple-effect/") {
        return json(200, { ...RIPPLE, summary: withoutKeys(RIPPLE.summary, ["bounded"]) });
      }

      // ---- data lifecycle: the stage counts and the per-stage gap ----
      if (path === "/api/assurance/deployments/dep-real/data-lifecycle/") {
        return json(200, LIFECYCLE);
      }
      if (path === "/api/assurance/deployments/dep-measured/data-lifecycle/") {
        // Six stages looked at, none evidenced, and this stage has no gap.
        // Every one of those is a measurement, and the worst of them is the
        // one an operator most needs to see survive.
        return json(200, {
          ...LIFECYCLE,
          stages: [{ ...LIFECYCLE.stages[0], gap: false, gap_detail: null }],
          summary: { ...LIFECYCLE.summary, stages_total: 0, evidenced: 0 },
        });
      }
      if (path === "/api/assurance/deployments/dep-silent/data-lifecycle/") {
        return json(200, {
          ...LIFECYCLE,
          stages: [withoutKeys(LIFECYCLE.stages[0], ["gap"])],
          summary: withoutKeys(LIFECYCLE.summary, ["stages_total", "evidenced"]),
        });
      }

      return json(404, { detail: "not found" });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_FAILSAFE_USER = "svc-operator";
    process.env.ATHENA_FAILSAFE_PASSWORD = "svc-secret";
    vi.resetModules();
    app = await makeApp();
    user = await signIn(app);
  });

  afterAll(async () => {
    delete process.env.ATHENA_FAILSAFE_URL;
    delete process.env.ATHENA_FAILSAFE_USER;
    delete process.env.ATHENA_FAILSAFE_PASSWORD;
    await new Promise<void>((r) => server.close(() => r()));
  });

  const op = (uuid: string) => user.get(`/api/assurance/deployments/${uuid}/operational-assurance`);
  const ripple = (uuid: string) => user.get(`/api/assurance/deployments/${uuid}/ripple-effect`);
  const lifecycle = (uuid: string) => user.get(`/api/assurance/deployments/${uuid}/data-lifecycle`);

  // ---------------------------------------------------------------- TTL ----

  it("carries a reported evidence TTL through unchanged", async () => {
    const res = await op("dep-real");
    expect(res.status).toBe(200);
    expect(res.body.evidenceFreshness.ttlDays).toBe(90);
  });

  it("does not invent a 0-day TTL when the control plane reports none", async () => {
    const res = await op("dep-silent");
    expect(res.status).toBe(200);
    expect(res.body.evidenceFreshness.ttlDays).toBeNull();
    // The rest of the freshness block is untouched: this is a narrowing of one
    // field, not a panel that gives up when one key is missing.
    expect(res.body.evidenceFreshness.total).toBe(4);
    expect(res.body.evidenceFreshness.freshnessRatio).toBe(0.75);
  });

  it("still reports a measured TTL of 0, and reports it distinguishably", async () => {
    const measured = await op("dep-measured");
    const silent = await op("dep-silent");
    expect(measured.body.evidenceFreshness.ttlDays).toBe(0);
    expect(silent.body.evidenceFreshness.ttlDays).toBeNull();
    expect(measured.body.evidenceFreshness).not.toEqual(silent.body.evidenceFreshness);
  });

  // ------------------------------------------------------------ bounded ----

  it("carries a reported bounding through unchanged", async () => {
    const res = await ripple("dep-real");
    expect(res.status).toBe(200);
    expect(res.body.summary.bounded).toBe(true);
  });

  it("does not read silence about bounding as an unbounded list", async () => {
    const res = await ripple("dep-silent");
    expect(res.status).toBe(200);
    expect(res.body.summary.bounded).toBeNull();
    expect(res.body.summary.consequences).toBe(3);
  });

  it("still reports a measured false bounding, and reports it distinguishably", async () => {
    const measured = await ripple("dep-measured");
    const silent = await ripple("dep-silent");
    expect(measured.body.summary.bounded).toBe(false);
    expect(silent.body.summary.bounded).toBeNull();
    expect(JSON.stringify(measured.body)).not.toBe(JSON.stringify(silent.body));
  });

  // ------------------------------------------------------ stage counts ----

  it("carries reported stage coverage through unchanged", async () => {
    const res = await lifecycle("dep-real");
    expect(res.status).toBe(200);
    expect(res.body.summary.stagesTotal).toBe(6);
    expect(res.body.summary.evidenced).toBe(4);
  });

  it("does not invent 0/0 stages evidenced when no summary was sent", async () => {
    const res = await lifecycle("dep-silent");
    expect(res.status).toBe(200);
    expect(res.body.summary.stagesTotal).toBeNull();
    expect(res.body.summary.evidenced).toBeNull();
    // The keys that WERE sent still arrive. A missing pair does not blank the
    // block; that would be the same defect with the sign flipped.
    expect(res.body.summary.notEvidenced).toBe(2);
    expect(res.body.summary.controlGaps).toBe(1);
    expect(res.body.summary.worstRisk).toBe("elevated");
  });

  it("still reports a measured 0 of 0 stages, and reports it distinguishably", async () => {
    const measured = await lifecycle("dep-measured");
    const silent = await lifecycle("dep-silent");
    expect(measured.body.summary.stagesTotal).toBe(0);
    expect(measured.body.summary.evidenced).toBe(0);
    expect(silent.body.summary.stagesTotal).toBeNull();
    expect(silent.body.summary.evidenced).toBeNull();
    expect(measured.body.summary).not.toEqual(silent.body.summary);
  });

  // -------------------------------------------------------- stage gap ----

  it("carries a reported stage gap through unchanged", async () => {
    const res = await lifecycle("dep-real");
    expect(res.body.stages[0].gap).toBe(true);
    expect(res.body.stages[0].gapDetail).toBe("no retention control evidenced");
  });

  it("does not read an unreported stage gap as a clean stage", async () => {
    const res = await lifecycle("dep-silent");
    expect(res.body.stages[0].gap).toBeNull();
    // Everything else about the stage survives — the stage is still rendered,
    // it is the gap verdict alone that is unknown.
    expect(res.body.stages[0].stage).toBe("collection");
    expect(res.body.stages[0].evidenced).toBe(true);
    expect(res.body.stages[0].risk).toBe("elevated");
  });

  it("still reports a measured absence of a stage gap, distinguishably", async () => {
    const measured = await lifecycle("dep-measured");
    const silent = await lifecycle("dep-silent");
    expect(measured.body.stages[0].gap).toBe(false);
    expect(silent.body.stages[0].gap).toBeNull();
    expect(measured.body.stages[0]).not.toEqual(silent.body.stages[0]);
  });

  // ----------------------------------------------------- no test twice ----

  it("defines each of its test names exactly once", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(
      resolve(import.meta.dirname, "four-numbers-nobody-measured.test.ts"),
      "utf8",
    );
    const names = [...source.matchAll(/^\s{2}it\("([^"]+)"/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(10);
    expect(new Set(names).size).toBe(names.length);
  });
});
