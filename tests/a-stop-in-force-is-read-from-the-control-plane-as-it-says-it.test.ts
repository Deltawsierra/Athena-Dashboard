import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import type { Express } from "express";
import type { IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";

import { makeApp, signIn, signInToBackend } from "./helpers";

/**
 * SAFETY (CONSOLE-STOP-IN-FORCE), the server's half: what a control plane that
 * keeps a stop in force says (Athena-Backend #242) reaches the console as it
 * said it, and a control plane that says none of it is read exactly as before.
 *
 *   1. A stop in force carries `inForce`, `readyAt`, `liftedOnlyBy` and
 *      `inForceNote`; a lifted stop `liftedBy` and `liftedAt`. An `in_force`
 *      that cannot be read is "may be in force" (null), never not in force.
 *   2. A cancel the control plane refuses (409) carries its own sentence.
 *   3. The cancel of a start that had been made ready carries how many stops
 *      are back in force; null (they could not be put back) is never none.
 *   4. A start held back (503) carries the control plane's sentence, and is
 *      relayed once: nothing here sends it again.
 *   5. A row the control plane could not read is listed as unreadable with its
 *      why, never among the commands; X-Failsafe-Unreadable and
 *      X-Failsafe-Audit-Missed are carried on the read that had them.
 *   7. An older control plane (none of the keys or headers): every answer is
 *      exactly what it was.
 *
 * (6, a superseded start's reason, rides in the audit trail's `detail`, which
 * this server already passes on whole: the console's half holds it.)
 */

type Answer = { status: number; body: unknown; headers?: Record<string, string> };
const ok = (body: unknown, headers: Record<string, string> = {}): Answer => ({ status: 200, body, headers });

const cmd = (uuid: string, action: string, status = "awaiting_signatures", more: Record<string, unknown> = {}) => ({
  uuid, action, engine_id: "athena-1", nonce: "n", issued_at: "2026-11-03T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
  reason: "r", signers: [], required_signatures: action === "pause" || action === "resume" ? 1 : 2, status,
  created_at: "2026-11-03T00:00:00Z", updated_at: "2026-11-03T00:00:01Z", ...more,
});
/** The command as this server has always handed it to the console: twelve fields, and no other. */
const viewed = (uuid: string, action: string, status = "awaiting_signatures") => ({
  uuid, action, engineId: "athena-1", nonce: "n", issuedAt: "2026-11-03T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z",
  reason: "r", signers: [], requiredSignatures: action === "pause" || action === "resume" ? 1 : 2, status,
  createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:01Z",
});

const PAUSE_NOTE = "In force: answered to its engine on every poll, whatever its window, until a resume drafted and signed " +
  "after it. Nothing else ends it: no window, no cancel, and no release.";
const REFUSED = "this pause was signed into force, and a cancel never ends a stop in force. Sign a resume drafted after it: only that ends it.";
const HELD = "Held, not done: this resume was not made ready, because the stops it would lift could not be read or recorded. " +
  "Every stop in force stays in force. Sign it again.";
const BACK_NOTE = "Every pause this resume had lifted is back in force and answered on every poll, but an engine that had " +
  "already applied the resume is running, and while it keeps running it rejects that old pause as a replay: the old pause " +
  "stops it again only when it restarts. To stop it now, sign a new pause.";
const WHY = "this command's stored row could not be read (ValueError); it is not served to its engine";

/** What the stand-in control plane answers; a case sets them. `headers` ride on the state and the list reads. */
const served: {
  state: unknown; commands: unknown; headers: Record<string, string>;
  /** The state's later pages, by the cursor that reads each. */
  statePages: Record<string, Answer>;
  cancel: (uuid: string) => Answer; signature: (uuid: string) => Answer; draft: (action: string) => Answer;
} = {
  state: {}, commands: [], headers: {}, statePages: {},
  cancel: (uuid) => ok(cmd(uuid, "pause", "canceled")),
  signature: (uuid) => ok(cmd(uuid, "pause", "ready")),
  draft: (action) => ({ status: 201, body: { ...cmd(`drafted-${action}`, action), signing_bytes: "00" } }),
};
const seen: string[] = [];

function controlPlane() {
  return http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      seen.push(`${req.method} ${path}`);
      const send = (answer: Answer) => {
        res.writeHead(answer.status, { "Content-Type": "application/json", ...(answer.headers ?? {}) });
        res.end(JSON.stringify(answer.body));
      };
      if (path === "/api/token/" || path === "/api/token/refresh/") return send(ok({ access: "t", refresh: "r" }));
      const cursor = new URL(req.url ?? "", "http://plane").searchParams.get("cursor");
      if (req.method === "GET" && path === "/api/failsafe/state/" && cursor !== null) {
        return send(served.statePages[cursor] ?? { status: 400, body: { detail: "no such cursor" } });
      }
      if (req.method === "GET" && path === "/api/failsafe/state/") return send(ok(served.state, served.headers));
      if (req.method === "GET" && path === "/api/failsafe/commands/") return send(ok(served.commands, served.headers));
      if (req.method === "GET" && path === "/api/failsafe/audit/") return send(ok([]));
      if (req.method === "POST" && path === "/api/failsafe/commands/") return send(served.draft((JSON.parse(raw) as { action: string }).action));
      const sig = /^\/api\/failsafe\/commands\/([^/]+)\/signatures\/$/.exec(path);
      if (req.method === "POST" && sig) return send(served.signature(sig[1]));
      const cancel = /^\/api\/failsafe\/commands\/([^/]+)\/cancel\/$/.exec(path);
      if (req.method === "POST" && cancel) return send(served.cancel(cancel[1]));
      return send({ status: 404, body: { detail: `no route ${req.method} ${path}` } });
    });
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const ENV = ["ATHENA_FAILSAFE_URL", "ATHENA_FAILSAFE_USER", "ATHENA_FAILSAFE_PASSWORD", "ATHENA_FAILSAFE_ENGINE_ID"];
let plane: Server;
let app: Express;
let admin: Awaited<ReturnType<typeof signIn>>;
let failsafe: typeof import("../server/failsafe");

beforeAll(async () => {
  plane = controlPlane();
  process.env.ATHENA_FAILSAFE_URL = await listen(plane);
  process.env.ATHENA_FAILSAFE_USER = "svc";
  process.env.ATHENA_FAILSAFE_PASSWORD = "svc"; // pragma: allowlist secret
  process.env.ATHENA_FAILSAFE_ENGINE_ID = "athena-1";
  vi.resetModules();
  app = await makeApp();
  admin = await signIn(app);
  await signInToBackend(admin);
  failsafe = await import("../server/failsafe");
}, 60_000);

afterAll(async () => {
  for (const k of ENV) delete process.env[k];
  plane.closeAllConnections?.();
  await new Promise<void>((r) => plane.close(() => r()));
});

beforeEach(async () => {
  Object.assign(served, {
    state: {}, commands: [], headers: {}, statePages: {},
    cancel: (uuid: string) => ok(cmd(uuid, "pause", "canceled")),
    signature: (uuid: string) => ok(cmd(uuid, "pause", "ready")),
    draft: (action: string) => ({ status: 201, body: { ...cmd(`drafted-${action}`, action), signing_bytes: "00" } }),
  });
  seen.length = 0;
  // A control plane that has shown nothing of #242 yet, and no command known here.
  failsafe._resetForTests();
  await admin.patch("/api/ai-control").send({ killSwitchEnabled: false, systemStatus: "active" });
});

/** A read of a control plane that keeps stops in force: its stop-lane reads carry X-Failsafe-Unreadable ("0" when none). */
async function aPlaneThatKeepsStopsInForce(state: Record<string, unknown> = {}) {
  served.state = { engine_id: "athena-1", awaiting_signatures: [], ready: [], recent: [], ...state };
  served.headers = { "X-Failsafe-Unreadable": "0", "X-Failsafe-More": "false" };
  const res = await admin.get("/api/failsafe/state");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res;
}

describe("1. a stop in force, and a lifted stop, are read as the control plane says them", () => {
  it("a pause in force carries that it is, since when, what alone lifts it, and the control plane's own note", async () => {
    const res = await aPlaneThatKeepsStopsInForce({
      ready: [cmd("pause-in-force", "pause", "ready", {
        in_force: true, ready_at: "2026-11-26T09:00:00+00:00", lifted_only_by: "resume", in_force_note: PAUSE_NOTE,
      })],
    });
    expect(res.body.ready).toEqual([{
      ...viewed("pause-in-force", "pause", "ready"),
      inForce: true, readyAt: "2026-11-26T09:00:00+00:00", liftedOnlyBy: "resume", inForceNote: PAUSE_NOTE,
    }]);
  });

  it("a terminate in force: the control plane's null is 'nothing lifts it', kept apart from 'not said'", async () => {
    const res = await aPlaneThatKeepsStopsInForce({
      ready: [
        cmd("terminate-in-force", "terminate", "ready", { in_force: true, ready_at: "2026-11-26T09:00:00+00:00", lifted_only_by: null, in_force_note: "Nothing ends a terminate." }),
        cmd("pause-not-said", "pause", "ready", { in_force: true }),
      ],
    });
    expect(res.body.ready[0].liftedOnlyBy).toBeNull();
    expect(res.body.ready[1]).toEqual({ ...viewed("pause-not-said", "pause", "ready"), inForce: true, readyAt: null });
    expect(res.body.ready[1]).not.toHaveProperty("liftedOnlyBy");
  });

  for (const odd of ["yes", 1, null, { a: 1 }]) {
    it(`an in_force that is ${JSON.stringify(odd)} may be in force (null): never read as not in force`, async () => {
      const res = await aPlaneThatKeepsStopsInForce({ ready: [cmd("pause-odd", "pause", "ready", { in_force: odd })] });
      expect(res.body.ready[0].inForce).toBeNull();
    });
  }

  it("a stop a start lifted carries which start, and when; a row saying both is in force", async () => {
    const res = await aPlaneThatKeepsStopsInForce({
      ready: [
        cmd("pause-lifted", "pause", "ready", { lifted_by: "resume-1", lifted_at: "2026-11-26T09:05:00+00:00" }),
        cmd("pause-unnamed", "pause", "ready", { lifted_by: null, lifted_at: "2026-11-26T09:06:00+00:00" }),
        cmd("pause-both", "pause", "ready", { in_force: true, lifted_by: "resume-2", lifted_at: "2026-11-26T09:07:00+00:00" }),
      ],
    });
    expect(res.body.ready[0]).toEqual({ ...viewed("pause-lifted", "pause", "ready"), liftedBy: "resume-1", liftedAt: "2026-11-26T09:05:00+00:00" });
    expect(res.body.ready[1].liftedBy).toBeNull();
    expect(res.body.ready[2].inForce).toBe(true);
    expect(res.body.ready[2]).not.toHaveProperty("liftedAt");
  });
});

describe("2. a cancel the control plane refuses (409) carries its own sentence", () => {
  it("from a control plane that keeps stops in force: the refusal as it always was, and its detail beside it", async () => {
    await aPlaneThatKeepsStopsInForce({ awaiting_signatures: [cmd("pause-raced", "pause")] });
    served.cancel = () => ({ status: 409, body: { detail: REFUSED } });
    const res = await admin.post("/api/failsafe/commands/pause-raced/cancel").send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: JSON.stringify({ detail: REFUSED }), controlPlaneStatus: 409, controlPlaneSaid: REFUSED });
  });
});

describe("3. the cancel of a start that had been made ready says what became of the stops it had lifted", () => {
  const cancelResume = async (answer: Answer) => {
    await aPlaneThatKeepsStopsInForce({ ready: [cmd("resume-ready", "resume", "ready")] });
    served.cancel = () => answer;
    return admin.post("/api/failsafe/commands/resume-ready/cancel").send({});
  };

  it("the stops put back: how many, which, and the note in full", async () => {
    const res = await cancelResume(ok(
      { ...cmd("resume-ready", "resume", "canceled"), back_in_force: ["pause-1", "pause-2"], back_in_force_note: BACK_NOTE },
      { "X-Failsafe-Back-In-Force": "2" },
    ));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      ...viewed("resume-ready", "resume", "canceled"),
      backInForce: 2, backInForceStops: ["pause-1", "pause-2"], backInForceNote: BACK_NOTE,
    });
  });

  it("null -- they could not be put back -- is null, never 0 and never left out", async () => {
    const res = await cancelResume(ok(
      { ...cmd("resume-ready", "resume", "canceled"), back_in_force: null, back_in_force_note: "The stops this resume had lifted could not be put back in force." },
      { "X-Failsafe-Back-In-Force": "unknown" },
    ));
    expect(res.body).toHaveProperty("backInForce", null);
    expect(res.body.backInForceNote).toMatch(/could not be put back in force/);
  });

  it("none lifted is 0; a body and a header that disagree, or a value that is not a list, are not known", async () => {
    expect((await cancelResume(ok({ ...cmd("resume-ready", "resume", "canceled"), back_in_force: [] }, { "X-Failsafe-Back-In-Force": "0" }))).body.backInForce).toBe(0);
    expect((await cancelResume(ok({ ...cmd("resume-ready", "resume", "canceled"), back_in_force: null }, { "X-Failsafe-Back-In-Force": "2" }))).body.backInForce).toBe("unreadable");
    expect((await cancelResume(ok({ ...cmd("resume-ready", "resume", "canceled"), back_in_force: "two" }))).body.backInForce).toBe("unreadable");
    // A list with an element that is not a stop's id: never read as the shorter list -- how many is not known,
    // with no header, and with a header that would agree with the shorter list.
    for (const headers of [{}, { "X-Failsafe-Back-In-Force": "1" }]) {
      const mixed = (await cancelResume(ok({ ...cmd("resume-ready", "resume", "canceled"), back_in_force: ["pause-1", 7] }, headers))).body;
      expect(mixed.backInForce, JSON.stringify(headers)).toBe("unreadable");
      expect(mixed).not.toHaveProperty("backInForceStops");
    }
    expect((await cancelResume(ok(cmd("resume-ready", "resume", "canceled"), { "X-Failsafe-Back-In-Force": "unknown" }))).body.backInForce).toBeNull();
  });
});

describe("4. a start the control plane held back (503) carries its sentence, and is relayed once", () => {
  it("the 503 as it always was, the control plane's own sentence beside it, and one relay", async () => {
    await aPlaneThatKeepsStopsInForce({ awaiting_signatures: [cmd("resume-held", "resume")] });
    served.signature = () => ({ status: 503, body: { detail: HELD } });
    const res = await admin.post("/api/failsafe/commands/resume-held/signatures").send({ keyId: "alice", sig: "abcd" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: `the control plane answered 503: ${JSON.stringify({ detail: HELD })}`,
      controlPlaneStatus: 503, controlPlaneSaid: HELD,
    });
    expect(seen.filter((line) => line === "POST /api/failsafe/commands/resume-held/signatures/"), "never sent again from here").toHaveLength(1);
  });
});

describe("5. a row the control plane could not read is listed as unreadable, and its headers are carried", () => {
  const unreadableRow = (uuid: string | null, action: string | null, status: string | null) =>
    ({ uuid, engine_id: uuid === null ? null : "athena-1", action, status, unreadable: true, why: WHY });

  it("the state: never among the commands, never dropped; named with its why, counted, and a possible stop", async () => {
    served.state = {
      engine_id: "athena-1",
      awaiting_signatures: [cmd("standdown-good", "stand_down"), unreadableRow(null, null, null)],
      ready: [unreadableRow("pause-unreadable", "pause", "ready"), unreadableRow("resume-unreadable", "resume", "ready"), cmd("pause-good", "pause", "ready")],
      recent: [],
    };
    served.headers = { "X-Failsafe-Unreadable": "3", "X-Failsafe-Audit-Missed": "2" };
    const res = await admin.get("/api/failsafe/state");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.awaitingSignatures.map((c: { uuid: string }) => c.uuid)).toEqual(["standdown-good"]);
    expect(res.body.ready.map((c: { uuid: string }) => c.uuid), "an unreadable row is never drawn as a command").toEqual(["pause-good"]);
    expect(res.body.unreadableCommands).toEqual([
      { uuid: null, engineId: null, action: null, status: null, why: WHY, list: "awaitingSignatures" },
      { uuid: "pause-unreadable", engineId: "athena-1", action: "pause", status: "ready", why: WHY, list: "ready" },
      { uuid: "resume-unreadable", engineId: "athena-1", action: "resume", status: "ready", why: WHY, list: "ready" },
    ]);
    expect(res.body.unreadable).toEqual({ awaitingSignatures: 1, ready: 2 });
    // The pause, and the row whose action could not be read, may be stops; the resume is not one.
    expect(res.body.possibleStops).toEqual({ awaitingSignatures: 1, ready: 1 });
    expect(res.body.planeUnreadable).toBe(3);
    expect(res.body.auditMissed).toBe(2);
    // What is remembered of such a row is what was remembered before: its action, by its uuid.
    expect(failsafe.knownActionOf("pause-unreadable")).toBe("pause");
    expect(failsafe.knownActionOf("resume-unreadable")).toBe("resume");
  });

  it("a count that is 0 is not said; one that is not a count is unknown (null), never 0", async () => {
    served.state = { engine_id: "athena-1", awaiting_signatures: [], ready: [], recent: [] };
    served.headers = { "X-Failsafe-Unreadable": "0", "X-Failsafe-Audit-Missed": "0" };
    const none = await admin.get("/api/failsafe/state");
    expect(none.body).not.toHaveProperty("planeUnreadable");
    expect(none.body).not.toHaveProperty("auditMissed");
    served.headers = { "X-Failsafe-Unreadable": "many", "X-Failsafe-Audit-Missed": "-1" };
    const odd = await admin.get("/api/failsafe/state");
    expect(odd.body).toHaveProperty("planeUnreadable", null);
    expect(odd.body).toHaveProperty("auditMissed", null);
  });

  it("over the pages: an unreadable row relisted on a later page is named and counted once; each page's header is added in", async () => {
    // The control plane relists the awaiting stops on a later page: one row, as a readable one is.
    served.state = {
      engine_id: "athena-1", awaiting_signatures: [unreadableRow("pause-unreadable", "pause", "awaiting_signatures")],
      ready: [], recent: [], more: true, next: "page2",
    };
    served.headers = { "X-Failsafe-Unreadable": "1", "X-Failsafe-More": "true", "X-Failsafe-Next": "page2" };
    served.statePages.page2 = ok(
      { awaiting_signatures: [unreadableRow("pause-unreadable", "pause", "awaiting_signatures"), cmd("standdown-good", "stand_down")], ready: [], recent: [], more: false },
      { "X-Failsafe-Unreadable": "1", "X-Failsafe-More": "false", "X-Failsafe-Audit-Missed": "3" },
    );
    const res = await admin.get("/api/failsafe/state");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.pages).toEqual({ read: 2 });
    expect(res.body.awaitingSignatures.map((c: { uuid: string }) => c.uuid)).toEqual(["standdown-good"]);
    expect(res.body.unreadableCommands.map((c: { uuid: string }) => c.uuid)).toEqual(["pause-unreadable"]);
    expect(res.body.unreadable).toEqual({ awaitingSignatures: 1 });
    expect(res.body.possibleStops).toEqual({ awaitingSignatures: 1 });
    // The control plane's own counts, page by page, as it said them: never fewer.
    expect(res.body.planeUnreadable).toBe(2);
    expect(res.body.auditMissed).toBe(3);
  });

  it("the command list: the unreadable row is not among the commands, and is counted in the answer's header", async () => {
    served.commands = [cmd("pause-listed", "pause", "ready"), unreadableRow("pause-unreadable", "pause", "ready")];
    served.headers = { "X-Failsafe-Unreadable": "1" };
    const res = await admin.get("/api/failsafe/commands");
    expect(res.body.map((c: { uuid: string }) => c.uuid)).toEqual(["pause-listed"]);
    expect(JSON.parse(res.headers["x-athena-unreadable-rows"])).toEqual({ commands: 1 });
  });

  it("a stop's answer that says audit rows of it are missing carries how many", async () => {
    served.draft = (action) => ({ status: 201, body: { ...cmd("pause-drafted", action), signing_bytes: "00" }, headers: { "X-Failsafe-Audit-Missed": "1" } });
    const drafted = await admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "athena-1", reason: "r" });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    expect(drafted.body.command).toEqual({ ...viewed("pause-drafted", "pause"), auditMissed: 1 });
    served.signature = (uuid) => ok(cmd(uuid, "pause", "ready"), { "X-Failsafe-Audit-Missed": "2" });
    const signed = await admin.post("/api/failsafe/commands/pause-drafted/signatures").send({ keyId: "alice", sig: "abcd" });
    expect(signed.body).toEqual({ ...viewed("pause-drafted", "pause", "ready"), auditMissed: 2 });
  });
});

describe("7. an older control plane (none of the keys or headers): every answer is exactly what it was", () => {
  it("the state, the list, a draft, a signature, a cancel, a refused cancel and a failed signature", async () => {
    served.state = {
      engine_id: "athena-1", engine_state: null, engine_state_available: false,
      awaiting_signatures: [cmd("standdown-old", "stand_down"), cmd("resume-old", "resume")],
      ready: [cmd("pause-old", "pause", "ready")], recent: [], more: false,
    };
    served.headers = { "X-Failsafe-More": "false" };
    const state = await admin.get("/api/failsafe/state");
    expect(state.body).toEqual({
      engineId: "athena-1", engineState: null, engineStateAvailable: false,
      awaitingSignatures: [viewed("standdown-old", "stand_down"), viewed("resume-old", "resume")],
      ready: [viewed("pause-old", "pause", "ready")], recent: [],
    });

    served.commands = [cmd("pause-old", "pause", "ready")];
    const list = await admin.get("/api/failsafe/commands");
    expect(list.body).toEqual([viewed("pause-old", "pause", "ready")]);
    expect(list.headers["x-athena-unreadable-rows"]).toBeUndefined();

    const drafted = await admin.post("/api/failsafe/commands").send({ action: "pause", engineId: "athena-1", reason: "r" });
    expect(drafted.body.command).toEqual(viewed("drafted-pause", "pause"));
    const signed = await admin.post("/api/failsafe/commands/drafted-pause/signatures").send({ keyId: "alice", sig: "abcd" });
    expect(signed.body).toEqual(viewed("drafted-pause", "pause", "ready"));

    served.cancel = (uuid) => ok(cmd(uuid, "resume", "canceled"));
    const canceled = await admin.post("/api/failsafe/commands/resume-old/cancel").send({});
    expect(canceled.body).toEqual(viewed("resume-old", "resume", "canceled"));

    // A refusal and a failure: the sentence they always carried, and no key more.
    served.cancel = () => ({ status: 409, body: { detail: "command is canceled; cannot cancel" } });
    const refused = await admin.post("/api/failsafe/commands/standdown-old/cancel").send({});
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: JSON.stringify({ detail: "command is canceled; cannot cancel" }) });
    served.signature = () => ({ status: 503, body: { detail: "the control plane is busy" } });
    const failed = await admin.post("/api/failsafe/commands/resume-old/signatures").send({ keyId: "alice", sig: "abcd" });
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: `the control plane answered 503: ${JSON.stringify({ detail: "the control plane is busy" })}` });
  });
});
