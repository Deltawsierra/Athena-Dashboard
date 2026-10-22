import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeApp, signIn } from "./helpers";
import { BACKEND_RECORD_KEYS, backendEngagementIdOf, backendScanIdOf, stoppedOnlyAtBackend } from "../shared/engine-record";

/**
 * The keys a scan's record carries from Athena-Backend (the Option 1 hybrid)
 * are the scan route's and the collect watch's to write, as the run's own keys
 * are (shared/engine-record.ts BACKEND_RECORD_KEYS): the backend scan and
 * engagement ids, the collected record, a stop's mirror reading, and the mark
 * that only the backend's Stop reaches the run.
 *
 * Supplied by a person -- on POST /api/tests or PATCH /api/tests/:id -- any of
 * them would make a hand-written row read as a backend-recorded scan: its
 * "Backend record" panel would show a verdict nobody collected, a Stop would be
 * mirrored to a scan the backend never had, and the row's live Stop would be
 * hidden behind "only the backend's Stop reaches this run". So each is refused
 * (400, naming the key), on create as on update; an edit of an engine scan
 * keeps them whatever the body says; and a key sent as null supplies nothing.
 */

let admin: Awaited<ReturnType<typeof signIn>>;
let clientId = "";

beforeAll(async () => {
  admin = await signIn(await makeApp());
  clientId = (await admin.post("/api/clients").send({ name: "Keys", company: "Keys", email: "k@k.test" })).body.id;
});

afterAll(async () => {
  const { storage } = await import("../server/storage-unified");
  for (const test of await storage.getAllTests()) {
    if (test.status === "running") await storage.updateTest(test.id, { status: "aborted" });
  }
});

describe("a backend record's keys are the scan route's to write", () => {
  it("names the five keys, and reads each as the scan route recorded it", () => {
    expect([...BACKEND_RECORD_KEYS]).toEqual(["backendScanId", "backendEngagementId", "backend", "backendMirror", "stop"]);
    const findings = { runId: "run-9", target: "https://k.example/", backendScanId: "11111111-2222-4333-8444-555555555555", backendEngagementId: 7, stop: "backend" };
    expect(backendScanIdOf(findings)).toBe("11111111-2222-4333-8444-555555555555");
    expect(backendEngagementIdOf(findings)).toBe(7);
    expect(stoppedOnlyAtBackend(findings)).toBe(true);
    expect(backendScanIdOf({ runId: "run-9" })).toBeNull();
    expect(backendEngagementIdOf({ backendEngagementId: "7" })).toBeNull();
    expect(stoppedOnlyAtBackend({ stop: "failsafe" })).toBe(false);
    expect(backendScanIdOf(null)).toBeNull();
  });

  for (const [findings, named] of [
    [{ backendScanId: "11111111-2222-4333-8444-555555555555" }, "findings.backendScanId"],
    [{ backendEngagementId: 7 }, "findings.backendEngagementId"],
    [{ backend: { status: "completed", verdict: "READY", verdictLabel: "Ready for deployment", collectedAt: null, detail: "" } }, "findings.backend"],
    [{ backendMirror: { at: "2026-10-22T00:00:00Z", mirrored: true, via: "stop credential", detail: "" } }, "findings.backendMirror"],
    [{ stop: "backend" }, "findings.stop"],
    [{ backendScanId: "11111111-2222-4333-8444-555555555555", backendEngagementId: 7, details: "mine" }, "findings.backendScanId, findings.backendEngagementId"],
  ] as Array<[Record<string, unknown>, string]>) {
    it(`create and edit each refuse ${named}`, async () => {
      const before = (await admin.get("/api/tests")).body.length;
      const created = await admin.post("/api/tests").send({ clientId, testType: "manual", status: "pending", findings });
      expect(created.status, `POST /api/tests accepted ${named}`).toBe(400);
      expect(created.body.message).toContain(named);
      expect(created.body.message).toContain("recorded by the scan that started an engine run and cannot be supplied");
      expect((await admin.get("/api/tests")).body.length).toBe(before);

      const plain = await admin.post("/api/tests").send({ clientId, testType: "manual", status: "pending" });
      expect(plain.status).toBe(201);
      const edited = await admin.patch(`/api/tests/${plain.body.id}`).send({ findings });
      expect(edited.status, `PATCH /api/tests/:id accepted ${named}`).toBe(400);
      expect(edited.body.message).toContain(named);
      expect((await admin.get(`/api/tests/${plain.body.id}`)).body.findings).toBeNull();
    });
  }

  it("a key sent as null supplies nothing, and a person's own notes are still accepted", async () => {
    const created = await admin.post("/api/tests").send({
      clientId, testType: "manual", status: "pending",
      findings: { details: "by hand", backendScanId: null, backendEngagementId: null, backend: null, backendMirror: null, stop: null },
    });
    expect(created.status).toBe(201);
    expect(created.body.findings).toMatchObject({ details: "by hand" });
  });

  it("an edit of a hybrid scan keeps its backend keys, and a change to one is refused as an engine scan's", async () => {
    const { storage } = await import("../server/storage-unified");
    const recorded = {
      runId: "run-hybrid-1", target: "https://k.example/", results: [],
      backendScanId: "11111111-2222-4333-8444-555555555555", backendEngagementId: 7,
      backend: { status: "pending", verdict: null, verdictLabel: null, collectedAt: null, detail: "" },
    };
    const test = await storage.createTest({
      clientId, testType: "penetration_test", status: "running", summary: "https://k.example/ — engine run run-hybrid-1",
      findings: recorded, executedBy: null,
    });

    // A person's edit: the notes change; every backend key stays as recorded.
    const noted = await admin.patch(`/api/tests/${test.id}`).send({ summary: "renamed", findings: { details: "looked at it" } });
    expect(noted.status).toBe(200);
    expect(noted.body.summary).toBe("renamed");
    expect(noted.body.findings).toMatchObject({ ...recorded, details: "looked at it" });

    // A body that changes a backend key is refused, naming it, and the row is unchanged.
    const forged = await admin.patch(`/api/tests/${test.id}`).send({
      findings: { ...recorded, backendScanId: "99999999-2222-4333-8444-555555555555" },
    });
    expect(forged.status).toBe(409);
    expect(forged.body.message).toContain("findings.backendScanId");
    const verdictForged = await admin.patch(`/api/tests/${test.id}`).send({
      findings: { ...recorded, backend: { ...recorded.backend, status: "completed", verdict: "READY" } },
    });
    expect(verdictForged.status).toBe(409);
    expect(verdictForged.body.message).toContain("findings.backend");
    expect((await admin.get(`/api/tests/${test.id}`)).body.findings).toMatchObject({ ...recorded, details: "looked at it" });
  });
});
