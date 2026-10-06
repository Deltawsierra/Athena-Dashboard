import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn } from "./helpers";

/**
 * A finding says what its closure stands on (Phase 6 item 3, the closure display).
 *
 * The backend now serves each finding's `closure`: its closure gate's own verdict
 * (athena-backend assurance/retest_closure.py closure_standing). This server
 * carries it through as the backend said it, and nothing better: a standing it
 * does not know reads "unknown", and a closure it was not served -- an older
 * backend, a shape it cannot read -- reads null, "not said". Neither is ever
 * "verified_closed".
 */

const COMPLETE_FIXTURES = {
  vulnerable: { ran: true, outcome: "failed" },
  repaired: { ran: true, outcome: "passed" },
  benign: { ran: true, outcome: "passed" },
  incomplete_repair: {
    restored_reachability: { ran: true, outcome: "failed" },
    displaced_effects: { ran: true, outcome: "failed" },
  },
};

function findingRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    uuid: "f-x", deployment_uuid: "dep-1", finding_type: "sql_injection",
    title: "SQL injection", severity: "critical",
    confidence: 0.6, status: "open", status_label: "Open", status_must_not_imply: null,
    owner: null, impact: "", business_impact: "", recommendation: "",
    control_mapping: {}, location: "/search", retest_required: true,
    evidence_class: "partially_verified", evidence: [],
    change_status: "recurring", change_label: "Recurring", age_days: 3, stale: false,
    receipt: { algorithm: "sha256", digest: "d".repeat(64), evidence_count: 1, computed_at: null },
    first_seen: null, last_seen: null, assignee: null, remediation_state: "triaged",
    ...over,
  };
}

describe("a finding's closure standing survives the BFF as the backend said it", () => {
  let app: Express;
  let user: Awaited<ReturnType<typeof signIn>>;
  let server: Server;

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const method = req.method ?? "GET";
        const path = (req.url ?? "").split("?")[0];
        const json = (code: number, payload: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (path === "/api/token/" && method === "POST") return json(200, { access: "svc-access-token", refresh: "r" });
        if (path === "/api/assurance/findings/" && method === "GET") {
          return json(200, [
            findingRow({
              uuid: "f-verified", status: "closed", status_label: "Closed",
              closure: {
                standing: "verified_closed", retest_required: true, reasons: [],
                evidence: {
                  uuid: "r-1", origin: "independent", content_digest: "sha256:ab12",
                  recorded_at: "2026-10-05T12:00:00+00:00", fixtures: COMPLETE_FIXTURES,
                },
              },
            }),
            findingRow({
              uuid: "f-refused",
              closure: {
                standing: "not_closable", retest_required: true,
                reasons: ["incomplete_repair/displaced_effects: passed -- the check accepted a planted incomplete repair"],
                evidence: {
                  uuid: "r-2", origin: "independent", content_digest: "sha256:cd34", recorded_at: null,
                  fixtures: { ...COMPLETE_FIXTURES, benign: "yes" },
                },
              },
            }),
            findingRow({ uuid: "f-future", closure: { standing: "super_closed", retest_required: true, reasons: [], evidence: null } }),
            findingRow({ uuid: "f-accepted", status: "accepted", closure: { standing: "not_a_closure", retest_required: true, reasons: [], evidence: null } }),
            findingRow({ uuid: "f-garbled", closure: "verified_closed" }),
            findingRow({ uuid: "f-absent" }),
          ]);
        }
        return json(404, { detail: `no route ${method} ${path}` });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    process.env.ATHENA_FAILSAFE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_FAILSAFE_USER = "svc-operator";
    process.env.ATHENA_FAILSAFE_PASSWORD = "svc-secret"; // pragma: allowlist secret
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

  async function findings() {
    const res = await user.get("/api/assurance/findings?deployment=dep-1");
    expect(res.status).toBe(200);
    const by: Record<string, Record<string, unknown>> = {};
    for (const f of res.body as Record<string, unknown>[]) by[String(f.uuid)] = f;
    return by;
  }

  it("carries a verified closure with its evidence, every fixture run as served", async () => {
    const closure = (await findings())["f-verified"].closure as Record<string, any>;
    expect(closure.standing).toBe("verified_closed");
    expect(closure.reasons).toEqual([]);
    expect(closure.evidence).toMatchObject({
      uuid: "r-1", origin: "independent", contentDigest: "sha256:ab12", recordedAt: "2026-10-05T12:00:00+00:00",
    });
    expect(closure.evidence.fixtures.vulnerable).toEqual({ ran: true, outcome: "failed" });
    expect(closure.evidence.fixtures.incompleteRepair.displaced_effects).toEqual({ ran: true, outcome: "failed" });
  });

  it("carries a refused closure's reasons, and an unreadable run as unreadable", async () => {
    const closure = (await findings())["f-refused"].closure as Record<string, any>;
    expect(closure.standing).toBe("not_closable");
    expect(closure.reasons[0]).toMatch(/displaced_effects: passed/);
    expect(closure.evidence.fixtures.benign).toEqual({ ran: null, outcome: "unreadable" });
  });

  it("carries an accepted risk or a false positive as not a closure", async () => {
    const closure = (await findings())["f-accepted"].closure as Record<string, unknown>;
    expect(closure.standing).toBe("not_a_closure");
    expect(closure.reasons).toEqual([]);
  });

  it("reads a standing it does not know as unknown, never as verified", async () => {
    expect(((await findings())["f-future"].closure as Record<string, unknown>).standing).toBe("unknown");
  });

  it("reads a closure it cannot read, or was not served, as not said", async () => {
    const by = await findings();
    expect(by["f-garbled"].closure).toBeNull();
    expect(by["f-absent"].closure).toBeNull();
  });
});
