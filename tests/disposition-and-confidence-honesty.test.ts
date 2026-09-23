import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { readFileSync } from "fs";
import { resolve } from "path";

import { makeApp, signIn } from "./helpers";

/**
 * Two things the backend takes care to say honestly, and this server was
 * quietly unsaying.
 *
 * `Finding.confidence` is nullable with no default, and migration 0016 went
 * back and nulled the confidences an earlier ingest had invented, because a
 * number nobody computed is indistinguishable on screen from a number somebody
 * measured. This server's findings mapper then read that null through
 * `num(raw.confidence, 0.5)` and served `0.5`. The fabrication the backend
 * removed at the source was being reintroduced one hop before the operator.
 *
 * `CONTAINED` and `INVALIDATED` exist because the other states were being
 * stretched to cover them, and the backend carries the wrong reading of each as
 * data (`MUST_NOT_IMPLY`) specifically so the API and this console show the same
 * caveat rather than each inventing one. This server dropped the field, so the
 * caveat appeared in no user interface anywhere in the platform.
 *
 * Both are one-line mapper defects with no test between them and production.
 */

const CONTAINED_CAVEAT =
  "The defect has not been removed. A control limits one path to it; the " +
  "weakness itself is still present, and no fix is implied.";
const REMEDIATING_CAVEAT =
  "A fix being in progress is not a fix being done, and not a risk being " +
  "contained in the meantime.";

function findingRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    uuid: "f-x", deployment_uuid: "dep-1", finding_type: "prompt_injection",
    title: "Prompt injection may be possible", severity: "high",
    confidence: 0.6, status: "open", status_label: "Open",
    status_must_not_imply: null,
    owner: null, impact: "", business_impact: "", recommendation: "",
    control_mapping: {}, location: "/chat", retest_required: true,
    evidence_class: "partially_verified", evidence: [],
    change_status: "recurring", change_label: "Recurring", age_days: 3, stale: false,
    receipt: { algorithm: "sha256", digest: "d".repeat(64), evidence_count: 1, computed_at: null },
    first_seen: null, last_seen: null, assignee: null, remediation_state: "triaged",
    ...over,
  };
}

describe("a finding's confidence and disposition survive the BFF", () => {
  let app: Express;
  let user: Awaited<ReturnType<typeof signIn>>;
  let server: Server;

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const method = req.method ?? "GET";
        const path = (req.url ?? "").split("?")[0];
        const json = (code: number, payload: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };

        if (path === "/api/token/" && method === "POST") {
          return json(200, { access: "svc-access-token", refresh: "r" });
        }

        if (path === "/api/assurance/findings/" && method === "GET") {
          return json(200, [
            // Nothing computed a confidence for this one. The backend says so.
            findingRow({ uuid: "f-null", confidence: null }),
            // A confidence that WAS measured, and happens to be the number the
            // old fallback invented. The negative control: if the fix nulled
            // everything, this is the case that catches it.
            findingRow({ uuid: "f-half", confidence: 0.5 }),
            findingRow({
              uuid: "f-contained", status: "contained",
              status_label: "Contained (defect not removed)",
              status_must_not_imply: CONTAINED_CAVEAT,
            }),
            findingRow({
              uuid: "f-remediating", status: "remediating",
              status_label: "Remediating",
              status_must_not_imply: REMEDIATING_CAVEAT,
            }),
            // A disposition this side has never been taught. The backend is a
            // separate deployable; a state it adds must arrive as itself, not as
            // a label this server guessed.
            findingRow({
              uuid: "f-future", status: "quarantined",
              status_label: "", status_must_not_imply: null,
            }),
          ]);
        }

        if (path === "/api/assurance/findings/f-contained/incident-pack/" && method === "GET") {
          return json(200, {
            pack_version: "mythos.assurance.incident_pack/1.0",
            attests: "integrity and provenance, never the truth of the conclusion",
            identity: {
              deployment: {
                name: "acme-chatbot", uuid: "dep-1",
                environment: "production", environment_label: "Production", owner: null,
              },
              finding: {
                uuid: "f-contained", fingerprint: "fp".repeat(8), category: "prompt_injection",
                title: "Prompt injection via tool output", severity: "high", severity_label: "High",
                status: "contained", status_label: "Contained (defect not removed)",
                status_must_not_imply: CONTAINED_CAVEAT,
              },
            },
            surface: { asset: null, asset_present: false, location: null, control_mapping: {} },
            evidence: { algorithm: "sha256", rows: [], count: 0, evidence_class: "unverified" },
            receipt: { algorithm: "sha256", digest: "d".repeat(64), evidence_count: 0 },
            runtime_transcript: {
              in_assurance_record: false, see: "engine evidence pack",
              reason: "the turn-by-turn transcript lives in the engine's pack",
              engine_pack_ref: { available: false, scan_uuid: null, engine_run_id: null },
            },
            ripple: {
              is_traced_origin: false, origins: [], consequences: [],
              deployment_summary: {
                origins: 0, origins_with_reach: 0, consequences: 0, evidenced_consequences: 0,
                bounded: true, by_category: {}, worst_risk: null,
              },
              note: "This finding is not itself a traced origin.",
            },
            decision: { decision: null, decision_label: null },
            algorithm: "sha256", digest: "e".repeat(64), computed_at: null,
          });
        }

        return json(404, { detail: `no route ${method} ${path}` });
      });
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

  async function findings() {
    const res = await user.get("/api/assurance/findings?deployment=dep-1");
    expect(res.status).toBe(200);
    const by: Record<string, Record<string, unknown>> = {};
    for (const f of res.body as Record<string, unknown>[]) by[String(f.uuid)] = f;
    return by;
  }

  // ---- the negative control comes first: a real measurement still arrives ----

  it("carries a measured confidence through unchanged, including a measured 0.5", async () => {
    const by = await findings();
    expect(by["f-half"].confidence).toBe(0.5);
    expect(by["f-contained"].confidence).toBe(0.6);
  });

  it("carries a null confidence as null, never as a number", async () => {
    const by = await findings();
    // The whole point: `0.5` here would be a number no part of the platform
    // computed, arriving beside genuine ones with nothing to tell them apart.
    expect(by["f-null"].confidence).toBeNull();
    expect(typeof by["f-null"].confidence).not.toBe("number");
  });

  it("serves the disposition's label and its caveat, both from the backend", async () => {
    const by = await findings();
    expect(by["f-contained"]).toMatchObject({
      status: "contained",
      statusLabel: "Contained (defect not removed)",
      statusMustNotImply: CONTAINED_CAVEAT,
    });
  });

  it("keeps Contained's caveat distinct from Remediating's", async () => {
    const by = await findings();
    const contained = by["f-contained"];
    const remediating = by["f-remediating"];
    expect(contained.status).not.toBe(remediating.status);
    expect(contained.statusLabel).not.toBe(remediating.statusLabel);
    expect(contained.statusMustNotImply).not.toBe(remediating.statusMustNotImply);
    // And each says the thing it is for: a contained finding is not being fixed.
    expect(String(contained.statusMustNotImply)).toMatch(/has not been removed/i);
    expect(String(remediating.statusMustNotImply)).toMatch(/not a fix being done/i);
  });

  it("does not invent a label or a caveat for a disposition it has not been taught", async () => {
    const by = await findings();
    // Passed through as itself. A guessed label would be this console asserting
    // something about a state only the backend knows the meaning of.
    expect(by["f-future"].status).toBe("quarantined");
    expect(by["f-future"].statusLabel).toBe("");
    expect(by["f-future"].statusMustNotImply).toBeNull();
  });

  it("carries the caveat onto the incident pack, which is a report", async () => {
    const res = await user.get("/api/assurance/findings/f-contained/incident-pack");
    expect(res.status).toBe(200);
    expect(res.body.identity.finding).toMatchObject({
      status: "contained",
      statusLabel: "Contained (defect not removed)",
      statusMustNotImply: CONTAINED_CAVEAT,
    });
  });
});

/**
 * The console has no component tests, so the render is guarded by its source
 * instead of by a DOM. Narrow on purpose: each assertion names one thing that
 * regressed here before, and would regress silently again -- a bare status slug
 * in a muted grey beside `remediating` in the same grey, and a pack headed
 * "Incident evidence pack" that showed no disposition at all.
 */
describe("the console renders a disposition as a disposition", () => {
  const src = readFileSync(
    resolve(__dirname, "..", "client", "src", "pages", "Assurance.tsx"),
    "utf8",
  );

  it("renders the finding's disposition through the chip, not as a bare slug", () => {
    expect(src).toContain("<DispositionChip status={f.status}");
    // The exact shape that was there: a slug in the muted colour every other
    // secondary detail on the row also wears.
    expect(src).not.toContain('<span className="text-[11px] text-muted-foreground">{f.status}</span>');
  });

  it("tones contained and invalidated apart from remediating", () => {
    const tone = (k: string) => {
      const m = src.match(new RegExp(`^\\s{2}${k}: "([^"]*)"`, "m"));
      expect(m, `no DISPOSITION_TONE entry for ${k}`).toBeTruthy();
      return m![1];
    };
    expect(tone("contained")).not.toBe(tone("remediating"));
    expect(tone("invalidated")).not.toBe(tone("remediating"));
    expect(tone("contained")).not.toBe(tone("invalidated"));
  });

  it("shows the caveat as text, not only as a hover title", () => {
    expect(src).toContain("function DispositionCaveat");
    expect(src).toContain("Must not be read as:");
    expect(src).toContain("<DispositionCaveat text={f.statusMustNotImply} />");
  });

  it("puts the disposition on the incident pack panel", () => {
    expect(src).toContain("status={data.identity.finding.status}");
    expect(src).toContain("<DispositionCaveat text={data.identity.finding.statusMustNotImply} />");
  });
});
