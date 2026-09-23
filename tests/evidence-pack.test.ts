import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";

import { makeApp, signIn } from "./helpers";

/**
 * The evidence pack, which this product advertised and never produced.
 *
 * The engine has built them all along. Two properties decide whether the
 * result means anything, and both were measured against a running engine
 * before this was written:
 *
 * An unsigned pack comes back 201 with `signed: false` and a reason, so that
 * it says it is unsigned rather than looking like a signed one nobody checked.
 * Anything that loses that distinction hands somebody an unverifiable document
 * as proof.
 *
 * And an unscoped pack reports `scans: excluded` -- the scan record has no
 * tenant column -- while still returning a valid root over six other sources.
 * A pack for a customer containing none of their scans is worse than no pack,
 * so the engagement is always sent.
 */
describe("issuing an evidence pack", () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof signIn>>;
  let server: Server;
  let sent: Array<Record<string, unknown>> = [];
  let reply: Record<string, unknown> = {};

  const packWith = (over: Record<string, unknown> = {}) => ({
    manifest: {
      format: "mythos-evidence-pack-v1",
      generated_at: "2026-09-08T12:00:00Z",
      tenant: "default",
      reason: "customer review",
      merkle_root: "sha256:abc123",
      leaf_count: 4,
      sources: [
        { source: "scans", status: "included", reason: null, records: 2,
          chain_ok: true, chain_detail: "every chained row matches", chain_partial: false },
        { source: "effects", status: "included", reason: null, records: 2,
          chain_ok: true, chain_detail: "every effect matches", chain_partial: false },
      ],
    },
    signed: true,
    // The shape a running engine actually sends. Not a string: an object
    // naming the algorithm and the key, captured from an engine started with
    // ENGINE_EVIDENCE_KEY set. The first version of this fixture guessed a
    // string, and the guess made a real defect pass.
    signature: {
      algorithm: "ed25519",
      public_key: "arA//t6gas4j2xRIkuomVwY1LHaQriYEQJMgku4fahU=",
      key_id: "sha256:67c375de9cd80e668f2c7d4cbd56981e",
      signature: "xPZUzgjvmZj64IV3Uu+NhbqJQ1T1YmGeaHJABAHoj9DgZiR3FRZsSPl3v3F0/HDSRDRNb7lErpTPsLMr47I5BQ==",
    },
    unsigned_reason: null,
    ...over,
  });

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ status: "ok" }));
        }
        if (req.url === "/api/evidence/pack") sent.push(JSON.parse(raw || "{}"));
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    process.env.ATHENA_ENGINE_URL = `http://127.0.0.1:${port}`;
    process.env.ATHENA_ENGINE_KEY = "ce_op_test";
    vi.resetModules();
    app = await makeApp();
    agent = await signIn(app);
  });

  afterAll(async () => {
    delete process.env.ATHENA_ENGINE_URL;
    delete process.env.ATHENA_ENGINE_KEY;
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function anEngagement() {
    const client = await agent.post("/api/clients")
      .send({ name: "Packed", company: "Packed Ltd", email: "p@example.test" });
    const site = await agent.post("/api/sites")
      .send({ clientId: client.body.id, name: "Main", url: "https://packed.example" });
    return { clientId: client.body.id as string, siteId: site.body.id as string };
  }

  it("always names the engagement, so the scan record is not silently left out", async () => {
    reply = packWith(); sent = [];
    const { clientId, siteId } = await anEngagement();

    const res = await agent.post("/api/evidence-pack")
      .send({ clientId, siteId, reason: "customer review" });
    expect(res.status).toBe(200);

    // The same engagement string the scan was filed under, composed the same
    // way. A pack scoped to a different spelling is a pack about nothing.
    expect(sent).toHaveLength(1);
    expect(sent[0].engagement_ref).toBe(`${clientId}:${siteId}`);
    expect(sent[0].reason).toBe("customer review");
  });

  it("carries the signed verdict through unchanged", async () => {
    reply = packWith(); sent = [];
    const { clientId } = await anEngagement();

    const res = await agent.post("/api/evidence-pack").send({ clientId, reason: "audit" });
    expect(res.body.signed).toBe(true);
    // The key id is the field that matters downstream: a signature is only
    // checkable against a key the verifier already holds, and this names which
    // published key to ask for.
    expect(res.body.signature).toMatchObject({
      algorithm: "ed25519",
      keyId: "sha256:67c375de9cd80e668f2c7d4cbd56981e",
    });
    expect(res.body.signature.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(res.body.unsignedReason).toBeNull();
  });

  it("refuses to call a pack signed when the signature cannot be read", async () => {
    // signed: true with nothing to check is the worst of the three states --
    // it renders as proof and is not. Reported as unsigned, with a reason that
    // does not claim the engine had no key.
    reply = packWith({ signature: { algorithm: "ed25519", key_id: "sha256:x" } });
    const { clientId } = await anEngagement();

    const res = await agent.post("/api/evidence-pack").send({ clientId, reason: "audit" });
    expect(res.body.signed).toBe(false);
    expect(res.body.signature).toBeNull();
    expect(res.body.unsignedReason).toContain("no signature that could be read");
  });

  it("reports an unsigned pack as unsigned, with the engine's reason", async () => {
    reply = packWith({
      signed: false, signature: null,
      unsigned_reason: "no signing key: set ENGINE_EVIDENCE_KEY to a file holding one",
    });
    const { clientId } = await anEngagement();

    const res = await agent.post("/api/evidence-pack").send({ clientId, reason: "audit" });
    expect(res.status).toBe(200);
    expect(res.body.signed).toBe(false);
    expect(res.body.unsignedReason).toContain("ENGINE_EVIDENCE_KEY");
  });

  it("treats a missing signed flag as unsigned", async () => {
    // An engine that does not say it signed the pack has not signed it.
    // Defaulting the other way is how an unsigned pack is handed over as proof.
    reply = { manifest: packWith().manifest };
    const { clientId } = await anEngagement();

    const res = await agent.post("/api/evidence-pack").send({ clientId, reason: "audit" });
    expect(res.body.signed).toBe(false);
  });

  it("keeps each source's status and the engine's reason for leaving one out", async () => {
    reply = packWith({
      manifest: {
        ...packWith().manifest,
        sources: [
          { source: "scans", status: "excluded", records: 0, chain_ok: true,
            reason: "the scan record has no tenant column, so it cannot be scoped to one customer",
            chain_detail: "", chain_partial: false },
        ],
      },
    });
    const { clientId } = await anEngagement();

    const res = await agent.post("/api/evidence-pack").send({ clientId, reason: "audit" });
    // Without this a pack missing every scan reads as a pack with nothing to
    // report, and it still returns a valid root over the other sources.
    expect(res.body.sources[0].status).toBe("excluded");
    expect(res.body.sources[0].reason).toContain("no tenant column");
  });

  it("requires a reason, and records the issue in the audit log", async () => {
    reply = packWith();
    const { clientId } = await anEngagement();

    expect((await agent.post("/api/evidence-pack").send({ clientId, reason: "" })).status).toBe(400);
    expect((await agent.post("/api/evidence-pack").send({ clientId })).status).toBe(400);

    await agent.post("/api/evidence-pack").send({ clientId, reason: "incident 2026-114" });
    const logs = await agent.get("/api/logs");
    const entry = logs.body.find(
      (one: { entityType: string }) => one.entityType === "evidence_pack",
    );
    expect(entry).toBeDefined();
    expect(entry.details).toMatchObject({ reason: "incident 2026-114", signed: true });
  });

  /**
   * A count nobody sent is not a count of zero.
   *
   * `merkleRoot` was already nullable while `leafCount` defaulted to 0, so a
   * manifest missing the field produced the one combination that cannot be
   * true: a root over an empty tree. The activity log records this pack, so
   * the invented zero was not only displayed -- it was written into the
   * tamper-evident record of what left the machine.
   */
  it("reports an absent leaf count as unknown, not as an empty tree", async () => {
    const pack = packWith();
    delete (pack.manifest as Record<string, unknown>).leaf_count;
    reply = pack;
    const { clientId } = await anEngagement();

    const res = await agent.post("/api/evidence-pack")
      .send({ clientId, reason: "manifest with no leaf count" });

    expect(res.status).toBe(200);
    expect(res.body.leafCount).toBeNull();
    // Still a root. That is the point: the pack commits to something, and how
    // much is what the engine did not say.
    expect(res.body.merkleRoot).toBe("sha256:abc123");

    const logs = await agent.get("/api/logs");
    const entry = logs.body.find(
      (one: { details?: { reason?: string } }) =>
        one.details?.reason === "manifest with no leaf count",
    );
    expect(entry).toBeDefined();
    expect(entry.details.leafCount).toBeNull();
  });

  it("carries a leaf count the engine did send, unchanged", async () => {
    // The control beside the test above: the null is the ABSENT case only.
    reply = packWith();
    const { clientId } = await anEngagement();

    const res = await agent.post("/api/evidence-pack").send({ clientId, reason: "audit" });
    expect(res.body.leafCount).toBe(4);
  });

  it("tells an unreported record count apart from a reported zero", async () => {
    const pack = packWith();
    (pack.manifest as Record<string, unknown>).sources = [
      // The engine looked and there was nothing. A claim about the data.
      { source: "effects", status: "included", reason: null, records: 0,
        chain_ok: true, chain_detail: "no effects in range", chain_partial: false },
      // The engine did not say. A claim about nothing at all.
      { source: "scans", status: "included", reason: null,
        chain_ok: true, chain_detail: "every chained row matches", chain_partial: false },
    ];
    reply = pack;
    const { clientId } = await anEngagement();

    const res = await agent.post("/api/evidence-pack").send({ clientId, reason: "counts" });
    const bySource = Object.fromEntries(
      res.body.sources.map((one: { source: string }) => [one.source, one]),
    );

    expect(bySource.effects.records).toBe(0);
    expect(bySource.scans.records).toBeNull();
    expect(bySource.effects.records).not.toBe(bySource.scans.records);
  });

  it("refuses a site belonging to another client, and needs an admin", async () => {
    reply = packWith();
    const mine = await anEngagement();
    const theirs = await anEngagement();

    const crossed = await agent.post("/api/evidence-pack")
      .send({ clientId: mine.clientId, siteId: theirs.siteId, reason: "audit" });
    expect(crossed.status).toBe(400);

    const anon = await request(app).post("/api/evidence-pack")
      .send({ clientId: mine.clientId, reason: "audit" });
    expect(anon.status).toBe(401);
  });
});
