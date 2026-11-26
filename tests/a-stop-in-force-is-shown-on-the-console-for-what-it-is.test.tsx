// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";

import Failsafe from "@/pages/Failsafe";
import { getQueryFn } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";

/**
 * SAFETY (CONSOLE-STOP-IN-FORCE), the console's half: what a control plane
 * that keeps a stop in force says (Athena-Backend #242), as the server hands it
 * on (tests/a-stop-in-force-is-read-from-the-control-plane-as-it-says-it.test.ts),
 * is shown for what it is. An operator who sees a pause in force drawn as any
 * other ready row, or a refused cancel as a generic error, may believe an
 * engine is or is not stopped when the opposite is true.
 *
 *   1. A stop in force says so, first and plainly: "In force", since when, what
 *      alone lifts it ("nothing" for a terminate), and the control plane's own
 *      note, drawn as text. A lifted stop says which start lifted it, and when.
 *   2. A stop in force offers no cancel that can only be refused: in its place,
 *      what ends it. A cancel the control plane refuses (409) is shown in its
 *      own words, never as a generic error, and the command is read again.
 *   3. The cancel of a start that had been made ready says, in full, what
 *      became of the stops it had lifted; null is "could not be put back",
 *      never none.
 *   4. A start the control plane held back (503) shows its sentence and that
 *      it must be signed again; the console does not send it again.
 *   5. A row the control plane could not read is listed as unreadable with its
 *      why, never dropped and never drawn as a command; X-Failsafe-Unreadable
 *      and X-Failsafe-Audit-Missed each show a banner on the read that had them.
 *   6. A superseded start shows its reason.
 *   7. An older control plane (none of the new keys): the console is exactly
 *      as it was -- every row's words, the command dialog, a cancel, a refused
 *      cancel and a failed signature.
 *
 * And none of it stands in front of a stop: every stop is offered while a read
 * is in flight, and a stop's signature is relayed while its command is re-read.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const STATUS = { configured: true, reachable: true, authorized: true, url: "http://cp", detail: "", defaultEngineId: "athena-1" };
/** A window long past: an expiry shown is "expired", the same on every run. */
const PAST = "2026-11-26T09:10:00Z";

/** A command as this server hands it to the console. */
const cmd = (uuid: string, action: string, status = "awaiting_signatures", more: Record<string, unknown> = {}) => ({
  uuid, action, engineId: "athena-1", status, nonce: `nonce-${uuid}`, reason: "r",
  issuedAt: "2026-11-26T09:00:00Z", expiresAt: PAST, signers: status === "ready" ? ["alice"] : [],
  requiredSignatures: action === "pause" || action === "resume" ? 1 : 2, createdAt: null, updatedAt: null, ...more,
});
const detailOf = (command: ReturnType<typeof cmd>) => ({
  command, signingBytes: "AAAA",
  draft: { action: command.action, engine_id: command.engineId, nonce: command.nonce, issued_at: command.issuedAt, expires_at: command.expiresAt, reason: command.reason },
});
const stateOf = (lists: Record<string, unknown> = {}) => ({
  engineId: "athena-1", engineState: "paused", engineStateAvailable: true, awaitingSignatures: [], ready: [], recent: [], ...lists,
});

// The control plane's own sentences, each with markup in it: drawn as text, never as markup.
const PAUSE_NOTE = "In force: answered to its engine on every poll, whatever its window, until a resume drafted and signed " +
  "after it. <img src=x data-planted=note> Nothing else ends it: no window, no cancel, and no release.";
const TERMINATE_NOTE = "In force: answered to its engine on every poll, whatever its window. Nothing ends a terminate.";
const REFUSED = "this pause was signed into force, and a cancel never ends a stop in force. <b data-planted=refused>Sign</b> " +
  "a resume drafted after it: only that ends it.";
const HELD = "Held, not done: this resume was not made ready, because the stops it would lift could not be read or " +
  "recorded. Every stop in force stays in force. Sign it again.";
const BACK_NOTE = "Every pause this resume had lifted is back in force and answered on every poll, but an engine that had " +
  "already applied the resume is running, and while it keeps running it rejects that old pause as a replay: the old " +
  "pause stops it again only when it restarts. To stop it now, sign a new pause.";
const WHY = "this command's stored row could not be read (ValueError); it is not served to its engine";
const SUPERSEDED = "drafted at or before the pause pause-1, the newest stop made ready for its engine: delivered after it, " +
  "it would undo that stop";

const PAUSE_IN_FORCE = cmd("pause-in-force", "pause", "ready", {
  inForce: true, readyAt: "2026-11-26T09:00:00+00:00", liftedOnlyBy: "resume", inForceNote: PAUSE_NOTE,
});
const TERMINATE_IN_FORCE = cmd("terminate-in-force", "terminate", "ready", {
  signers: ["alice", "bob"], inForce: true, readyAt: "2026-11-26T09:01:00+00:00", liftedOnlyBy: null, inForceNote: TERMINATE_NOTE,
});
const PAUSE_LIFTED = cmd("pause-lifted", "pause", "ready", { liftedBy: "resume-1", liftedAt: "2026-11-26T09:05:00+00:00" });

type Answer = { status: number; body: unknown };
interface Served {
  state: () => unknown | Promise<unknown>;
  audit: unknown[];
  /** The command each read of it answers, by uuid; a read may be held (a promise not yet settled). */
  detail: (uuid: string, read: number) => unknown | Promise<unknown>;
  cancel?: (uuid: string) => Answer;
  signature?: (uuid: string) => Answer;
}
let calls: string[] = [];

/** The page (and its toasts) on a client that reads through the app's own query function, against a stubbed server. */
function mount(served: Served) {
  calls = [];
  const reads = new Map<string, number>();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u}`);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (u.startsWith("/api/failsafe/status")) return json(200, STATUS);
    if (u.startsWith("/api/failsafe/state")) return json(200, await served.state());
    if (u.startsWith("/api/failsafe/audit")) return json(200, served.audit);
    const action = /^\/api\/failsafe\/commands\/([^/?]+)\/(cancel|signatures)$/.exec(u);
    if (method === "POST" && action) {
      const answer = (action[2] === "cancel" ? served.cancel : served.signature)?.(action[1]);
      return answer ? json(answer.status, answer.body) : json(404, { message: "Not found" });
    }
    const one = /^\/api\/failsafe\/commands\/([^/?]+)$/.exec(u);
    if (method === "GET" && one) {
      const read = (reads.get(one[1]) ?? 0) + 1;
      reads.set(one[1], read);
      const body = await served.detail(one[1], read);
      return body === undefined ? json(404, { message: "Not found" }) : json(200, body);
    }
    return json(404, { message: "Not found" });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
  render(<QueryClientProvider client={client}><Failsafe /><Toaster /></QueryClientProvider>);
}

const text = () => document.body.textContent ?? "";
/** A command's row in "Commands in flight": the card its open button is on. */
const rowOf = (uuid: string) => screen.getByTestId(`button-open-${uuid}`).closest(".group") as HTMLElement;
const dialog = () => screen.getByRole("dialog");
const planted = () => document.querySelectorAll("[data-planted]").length;
const stopsOffered = () => ["pause", "stand_down", "terminate"].map((key) => (screen.getByTestId(`button-draft-${key}`) as HTMLButtonElement).disabled);
const signatureReads = (uuid: string) => calls.filter((one) => one === `GET /api/failsafe/commands/${uuid}`).length;
const relays = (uuid: string) => calls.filter((one) => one === `POST /api/failsafe/commands/${uuid}/signatures`).length;

async function openCommand(uuid: string) {
  fireEvent.click(await screen.findByTestId(`button-open-${uuid}`));
  await within(await screen.findByRole("dialog")).findByTestId("button-close-console");
}

describe("1. a stop in force says so, first and plainly; a lifted stop says which start lifted it, and when", () => {
  it("each row: in force, since when, what alone lifts it, the control plane's note as text; lifted, by which start and when", async () => {
    mount({ state: () => stateOf({ ready: [PAUSE_IN_FORCE, TERMINATE_IN_FORCE, PAUSE_LIFTED] }), audit: [], detail: () => undefined });
    await screen.findByTestId("button-open-pause-in-force");

    const pause = within(screen.getByTestId("row-in-force-pause-in-force"));
    expect(pause.getByTestId("text-in-force").textContent).toBe("In force");
    expect(pause.getByTestId("text-in-force-since").textContent).toMatch(/^Since: 2026-11-26T09:00:00\+00:00 \(/);
    expect(pause.getByTestId("text-lifted-only-by").textContent).toBe("Lifted only by: a resume drafted and signed after it");
    expect(pause.getByTestId("text-in-force-note").textContent, "the control plane's own note, whole").toBe(PAUSE_NOTE);
    expect(planted(), "the note's markup is text, never an element").toBe(0);
    // "In force" first on the row's line, and its pill; never "Ready for the engine", never "expired".
    expect(screen.getByTestId("text-row-in-force-pause-in-force").textContent).toBe("In force");
    expect(rowOf("pause-in-force").textContent).toMatch(/^In forcePause · athena-11\/1 signed · in force whatever its windowIn force/);
    for (const uuid of ["pause-in-force", "terminate-in-force"]) {
      expect(rowOf(uuid).textContent, uuid).not.toMatch(/Ready for the engine|expired/);
    }

    const terminate = within(screen.getByTestId("row-in-force-terminate-in-force"));
    expect(terminate.getByTestId("text-lifted-only-by").textContent, "nothing lifts a terminate").toBe("Lifted only by: nothing");
    expect(terminate.getByTestId("text-in-force-note").textContent).toBe(TERMINATE_NOTE);

    const lifted = screen.getByTestId("row-in-force-pause-lifted");
    expect(lifted.getAttribute("data-lifted")).toBe("true");
    expect(within(lifted).getByTestId("text-lifted-by").textContent).toMatch(/^Lifted by the start resume-1 at 2026-11-26T09:05:00\+00:00 \(/);
    expect(rowOf("pause-lifted").textContent, "a lifted stop is no longer answered: not 'ready for the engine'").not.toMatch(/Ready for the engine/);
    expect(rowOf("pause-lifted").textContent).toMatch(/Lifted/);
  });

  it("the command's dialog: 'In force' first, before anything else of it, and never 'the engine will apply this on its next poll'", async () => {
    mount({
      state: () => stateOf({ ready: [PAUSE_IN_FORCE, PAUSE_LIFTED] }), audit: [],
      detail: (uuid) => ({ "pause-in-force": detailOf(PAUSE_IN_FORCE), "pause-lifted": detailOf(PAUSE_LIFTED) })[uuid],
    });
    await openCommand("pause-in-force");
    const box = within(dialog());
    const block = box.getByTestId("in-force-pause-in-force");
    expect(within(block).getByTestId("text-in-force").textContent).toBe("In force");
    expect(within(block).getByTestId("text-in-force-note").textContent).toBe(PAUSE_NOTE);
    const title = box.getAllByText("Pause").find((one) => one.className.includes("font-serif"));
    expect(title, "the action's title").toBeDefined();
    expect(block.compareDocumentPosition(title!) & Node.DOCUMENT_POSITION_FOLLOWING, "in force is said before the title").toBeTruthy();
    expect(dialog().textContent).not.toMatch(/Fully signed\. The engine will verify|Ready for the engine|expired/);
    expect(planted()).toBe(0);

    fireEvent.click(box.getByTestId("button-close-console"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openCommand("pause-lifted");
    expect(within(dialog()).getByTestId("text-lifted-by").textContent).toMatch(/resume-1/);
    expect(dialog().textContent, "a lifted stop is not applied on any poll").not.toMatch(/Fully signed\. The engine will verify|Ready for the engine/);
  });
});

describe("2. a stop in force offers no cancel; a cancel the control plane refuses is shown in its own words", () => {
  it("in place of a cancel, what ends it: a resume for a pause, nothing for a terminate", async () => {
    mount({
      state: () => stateOf({ ready: [PAUSE_IN_FORCE, TERMINATE_IN_FORCE] }), audit: [],
      detail: (uuid) => ({ "pause-in-force": detailOf(PAUSE_IN_FORCE), "terminate-in-force": detailOf(TERMINATE_IN_FORCE) })[uuid],
    });
    await openCommand("pause-in-force");
    expect(within(dialog()).queryByTestId("button-cancel-command")).toBeNull();
    expect(within(dialog()).getByTestId("text-no-cancel-in-force").textContent)
      .toBe("A cancel never ends a stop in force, so none is offered here. Only a resume drafted and signed after it ends it.");
    fireEvent.click(within(dialog()).getByTestId("button-close-console"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openCommand("terminate-in-force");
    expect(within(dialog()).queryByTestId("button-cancel-command")).toBeNull();
    expect(within(dialog()).getByTestId("text-no-cancel-in-force").textContent)
      .toBe("A cancel never ends a stop in force, so none is offered here. Nothing ends it.");
  });

  it("a 409: its detail as it said it, on the dialog and in the toast; the command read again, its signature relayed meanwhile", async () => {
    const awaiting = cmd("pause-raced", "pause");
    let release: (body: unknown) => void = () => undefined;
    const held = new Promise<unknown>((resolve) => { release = resolve; });
    mount({
      state: () => stateOf({ awaitingSignatures: [awaiting] }), audit: [],
      // The first read: still awaiting a signature. The second, after the refusal: held, then in force.
      detail: (_uuid, read) => (read === 1 ? detailOf(awaiting) : held),
      cancel: () => ({ status: 409, body: { error: JSON.stringify({ detail: REFUSED }), controlPlaneStatus: 409, controlPlaneSaid: REFUSED } }),
      signature: () => ({ status: 200, body: cmd("pause-raced", "pause", "ready") }),
    });
    await openCommand("pause-raced");
    fireEvent.click(within(dialog()).getByTestId("button-cancel-command"));
    const notice = await within(dialog()).findByTestId("notice-cancel-refused");
    expect(within(notice).getByTestId("text-cancel-refused").textContent, "its own words, never a generic error").toBe(REFUSED);
    expect(notice.textContent).toMatch(/^The control plane refused this cancel \(409\)\. Nothing was canceled\. It said:/);
    await waitFor(() => expect(screen.getAllByText((_, el) => el?.textContent === REFUSED).length, "and in the toast").toBeGreaterThanOrEqual(2));
    expect(planted(), "its markup is text").toBe(0);

    // Read again at once; while that read is in flight, the stop's signature still goes, and every stop is offered.
    await waitFor(() => expect(signatureReads("pause-raced")).toBe(2));
    const submit = within(dialog()).getByTestId("button-submit-signature") as HTMLButtonElement;
    expect(submit.disabled, "a stop's signature never waits on its command's read").toBe(false);
    expect(stopsOffered()).toEqual([false, false, false]);
    fireEvent.change(within(dialog()).getByTestId("input-signature"), { target: { value: '{"key_id": "alice", "sig": "abcd"}' } });
    fireEvent.click(submit);
    await waitFor(() => expect(relays("pause-raced")).toBe(1));

    // What it is now -- in force -- is what is shown, and still no cancel.
    release(detailOf({ ...PAUSE_IN_FORCE, uuid: "pause-raced" }));
    await within(dialog()).findByTestId("in-force-pause-raced");
    expect(within(dialog()).queryByTestId("button-cancel-command")).toBeNull();
    expect(within(dialog()).getByTestId("text-cancel-refused").textContent, "the refusal stays until the dialog is closed").toBe(REFUSED);
  });
});

describe("3. the cancel of a start that had been made ready says what became of the stops it had lifted", () => {
  const cancelResume = async (answer: Record<string, unknown>) => {
    const resume = cmd("resume-raced", "resume");
    mount({
      state: () => stateOf({ awaitingSignatures: [resume] }), audit: [], detail: () => detailOf(resume),
      cancel: () => ({ status: 200, body: { ...cmd("resume-raced", "resume", "canceled"), ...answer } }),
    });
    await openCommand("resume-raced");
    fireEvent.click(within(dialog()).getByTestId("button-cancel-command"));
    return within(await screen.findByTestId("notice-start-canceled"));
  };

  it("put back: how many, which, and the control plane's note in full; the dialog stays open on it", async () => {
    const notice = await cancelResume({ backInForce: 2, backInForceStops: ["pause-1", "pause-2"], backInForceNote: BACK_NOTE });
    expect(notice.getByTestId("text-back-in-force").textContent).toBe("2 stops are back in force.");
    expect(notice.getByTestId("text-back-in-force-stops").textContent).toBe("pause-1, pause-2");
    expect(notice.getByTestId("text-back-in-force-note").textContent, "in full").toBe(BACK_NOTE);
    expect(screen.queryByRole("dialog"), "kept until the operator closes it").not.toBeNull();
  });

  it("null -- they could not be put back -- is 'could not be put back in force', never none and never 0", async () => {
    const note = "The stops this resume had lifted could not be put back in force (logged as an error) and are not answered. " +
      "To stop it now, sign a new pause.";
    const notice = await cancelResume({ backInForce: null, backInForceNote: note });
    const said = notice.getByTestId("text-back-in-force");
    expect(said.textContent).toBe("The stops it had lifted could not be put back in force.");
    expect(said.getAttribute("data-back")).toBe("null");
    expect(said.textContent).not.toMatch(/\b0\b|\bnone\b|\bno stops?\b/i);
    expect(notice.getByTestId("text-back-in-force-note").textContent).toBe(note);
  });

  it("a count that could not be read is said so, never a number", async () => {
    const notice = await cancelResume({ backInForce: "unreadable" });
    expect(notice.getByTestId("text-back-in-force").textContent).toBe("How many stops are back in force could not be read from the control plane's answer.");
  });
});

describe("4. a start the control plane held back (503) shows its sentence, and is not sent again", () => {
  it("the sentence as it said it, that it must be signed again, and one relay", async () => {
    const resume = cmd("resume-held", "resume");
    mount({
      state: () => stateOf({ awaitingSignatures: [resume] }), audit: [], detail: () => detailOf(resume),
      signature: () => ({ status: 503, body: { error: `the control plane answered 503: ${JSON.stringify({ detail: HELD })}`, controlPlaneStatus: 503, controlPlaneSaid: HELD } }),
    });
    await openCommand("resume-held");
    fireEvent.change(within(dialog()).getByTestId("input-signature"), { target: { value: '{"key_id": "alice", "sig": "abcd"}' } });
    fireEvent.click(within(dialog()).getByTestId("button-submit-signature"));
    const notice = within(await screen.findByTestId("notice-start-held"));
    expect(notice.getByTestId("text-start-held").textContent).toBe(HELD);
    expect(notice.getByTestId("text-start-sign-again").textContent)
      .toBe("This console has not sent the signature again, and will not. To go on, sign it again and submit it.");
    // Not sent again: one relay, a second and a half on.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(relays("resume-held")).toBe(1);
    expect((within(dialog()).getByTestId("button-submit-signature") as HTMLButtonElement).disabled, "the operator can sign it again").toBe(false);
  }, 10_000);
});

describe("5. a row the control plane could not read is listed as unreadable; its headers each show a banner", () => {
  const unreadable = (uuid: string | null, action: string | null, list: string) =>
    ({ uuid, engineId: uuid === null ? null : "athena-1", action, status: uuid === null ? null : "ready", why: WHY, list });

  it("named with its why, never dropped and never drawn as a command; a banner for each header; every stop offered", async () => {
    mount({
      state: () => stateOf({
        ready: [cmd("pause-good", "pause", "ready")],
        unreadable: { awaitingSignatures: 1, ready: 2, recent: 1 }, possibleStops: { awaitingSignatures: 1, ready: 1 },
        unreadableCommands: [
          unreadable(null, null, "awaitingSignatures"), unreadable("pause-unreadable", "pause", "ready"),
          unreadable("resume-unreadable", "resume", "ready"), unreadable("old-unreadable", "pause", "recent"),
        ],
        planeUnreadable: 4, auditMissed: 2,
      }),
      audit: [], detail: () => undefined,
    });
    await screen.findByTestId("button-open-pause-good");
    const named = screen.getAllByTestId("unreadable-command");
    expect(named.map((one) => [one.getAttribute("data-uuid"), one.getAttribute("data-list")]), "every in-flight one, none dropped").toEqual([
      ["", "awaitingSignatures"], ["pause-unreadable", "ready"], ["resume-unreadable", "ready"],
    ]);
    for (const one of named) expect(within(one).getByTestId("text-unreadable-why").textContent).toBe(WHY);
    expect(named[1].textContent).toMatch(/^Unreadable command: Pause · athena-1id pause-unreadable · stored status ready · listed under ready/);
    expect(named[1].textContent).toMatch(/It may be a stop/);
    expect(named[2].textContent, "a resume is not called a possible stop").not.toMatch(/It may be a stop/);
    expect(screen.queryByTestId("button-open-pause-unreadable"), "never drawn as a command to open or sign").toBeNull();
    expect(screen.queryByTestId("button-open-resume-unreadable")).toBeNull();

    const banner = screen.getByTestId("banner-plane-unreadable");
    expect(banner.getAttribute("data-count")).toBe("4");
    expect(banner.textContent).toMatch(/^The control plane could not read 4 command rows on this read\. A row it cannot read is not served to its engine, and may be a stop\./);
    const audit = screen.getByTestId("banner-audit-missed");
    expect(audit.getAttribute("data-count")).toBe("2");
    expect(audit.textContent).toMatch(/^2 audit rows of failsafe stops are missing on the control plane: it could not write them\. The stops themselves stand\./);
    expect(stopsOffered(), "a new stop is offered whatever a banner says").toEqual([false, false, false]);
  });

  it("a header alone: never 'no commands'; one sent but not a count is said unknown, never none", async () => {
    mount({ state: () => stateOf({ planeUnreadable: null, auditMissed: null }), audit: [], detail: () => undefined });
    const banner = await screen.findByTestId("banner-plane-unreadable");
    expect(banner.getAttribute("data-count")).toBe("null");
    expect(banner.textContent).toMatch(/could not read command rows on this read, but not readably how many/);
    expect(screen.getByTestId("banner-audit-missed").textContent).toMatch(/it said so, but not readably how many/);
    expect(text()).not.toMatch(/No commands awaiting signatures or waiting on the engine/);
  });

  it("one unreadable row and nothing else listed: never 'no commands awaiting signatures'", async () => {
    mount({ state: () => stateOf({ planeUnreadable: 1 }), audit: [], detail: () => undefined });
    await screen.findByTestId("banner-plane-unreadable");
    expect(text()).not.toMatch(/No commands awaiting signatures or waiting on the engine/);
  });
});

describe("6. a superseded start shows its reason", () => {
  it("the trail's superseded event says why, in the control plane's words, by command", async () => {
    mount({
      state: () => stateOf(), detail: () => undefined,
      audit: [
        { uuid: "e1", timestamp: "2026-11-26T09:06:00Z", event: "superseded", commandUuid: "resume-held", actor: null,
          detail: { by: "state read", superseded_by: "pause-1", reason: SUPERSEDED } },
        // A stop draft set aside by a newer one says no reason: nothing is made up for it.
        { uuid: "e2", timestamp: "2026-11-26T09:07:00Z", event: "superseded", commandUuid: "pause-old", actor: "alice",
          detail: { by: "pause-new", limit: 5 } },
      ],
    });
    const reason = await screen.findByTestId("text-superseded-reason");
    expect(reason.getAttribute("data-command")).toBe("resume-held");
    expect(reason.textContent).toBe(`Command resume-held: ${SUPERSEDED}`);
    expect(screen.getAllByTestId("text-superseded-reason")).toHaveLength(1);
  });
});

describe("7. an older control plane (none of the new keys): the console is exactly as it was", () => {
  const awaitingPause = cmd("pause-old", "pause");
  const awaitingStandDown = cmd("standdown-old", "stand_down", "awaiting_signatures", { signers: ["alice"] });
  const readyStandDown = cmd("standdown-ready", "stand_down", "ready", { signers: ["alice", "bob"] });
  const readyResume = cmd("resume-ready", "resume", "ready");
  const NEW = ["in-force-", "row-in-force-", "text-row-in-force-", "text-no-cancel-in-force", "banner-plane-unreadable",
    "banner-audit-missed", "unreadable-command", "text-superseded-reason", "notice-"];
  const newOnes = () => NEW.flatMap((prefix) => [...document.querySelectorAll(`[data-testid^="${prefix}"]`)].map((one) => one.getAttribute("data-testid")));

  it("every row, the dialog, a cancel, a refused cancel and a failed signature: the words they always had", async () => {
    let refuse = false;
    mount({
      state: () => stateOf({ awaitingSignatures: [awaitingPause, awaitingStandDown], ready: [readyStandDown, readyResume] }),
      audit: [{ uuid: "e1", timestamp: "2026-11-26T09:06:00Z", event: "superseded", commandUuid: "pause-0", actor: "alice", detail: { by: "pause-old", limit: 5 } }],
      detail: (uuid) => detailOf([awaitingPause, awaitingStandDown, readyStandDown, readyResume].find((one) => one.uuid === uuid)!),
      cancel: (uuid) => (refuse
        ? { status: 409, body: { error: JSON.stringify({ detail: "command is canceled; cannot cancel" }) } }
        : { status: 200, body: cmd(uuid, "pause", "canceled") }),
      signature: () => ({ status: 503, body: { error: `the control plane answered 503: ${JSON.stringify({ detail: "busy" })}` } }),
    });
    await screen.findByTestId("button-open-pause-old");
    expect(["pause-old", "standdown-old", "standdown-ready", "resume-ready"].map((uuid) => rowOf(uuid).textContent)).toEqual([
      "Pause · athena-10/1 signed · expiredAwaiting signaturesSign / relay",
      "Stand down · athena-11/2 signed · expiredAwaiting signaturesSign / relay",
      "Stand down · athena-12/2 signed · expiredReady for the engineView",
      "Resume · athena-11/1 signed · expiredReady for the engineView",
    ]);
    await screen.findByText("superseded");
    expect(newOnes()).toEqual([]);

    // A ready command's dialog: fully signed, and the engine applies it on its next poll; no cancel, as before.
    await openCommand("standdown-ready");
    expect(dialog().textContent).toMatch(/Ready for the engine/);
    expect(dialog().textContent).toMatch(/Fully signed\. The engine will verify the signatures itself and apply this on its next poll\./);
    expect(dialog().textContent).toMatch(/athena-1 · expired/);
    expect(within(dialog()).queryByTestId("button-cancel-command")).toBeNull();
    expect(newOnes()).toEqual([]);
    fireEvent.click(within(dialog()).getByTestId("button-close-console"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // A cancel closes the dialog, as it always did.
    await openCommand("pause-old");
    fireEvent.click(within(dialog()).getByTestId("button-cancel-command"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(newOnes()).toEqual([]);

    // A refused cancel: the toast as it always was (the body as quoted), and nothing on the dialog.
    refuse = true;
    await openCommand("standdown-old");
    fireEvent.click(within(dialog()).getByTestId("button-cancel-command"));
    await screen.findByText(JSON.stringify({ detail: "command is canceled; cannot cancel" }));
    expect(screen.getByText("Could not cancel")).toBeTruthy();
    expect(newOnes()).toEqual([]);
    fireEvent.click(within(dialog()).getByTestId("button-close-console"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // A failed signature on a start: the toast as it always was, and nothing on the dialog.
    await openCommand("resume-ready");
    expect(within(dialog()).queryByTestId("button-submit-signature"), "a ready command takes no signature, as before").toBeNull();
    fireEvent.click(within(dialog()).getByTestId("button-close-console"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openCommand("standdown-old");
    fireEvent.change(within(dialog()).getByTestId("input-signature"), { target: { value: '{"key_id": "bob", "sig": "abcd"}' } });
    fireEvent.click(within(dialog()).getByTestId("button-submit-signature"));
    await screen.findByText(`the control plane answered 503: ${JSON.stringify({ detail: "busy" })}`);
    expect(newOnes()).toEqual([]);
  }, 15_000);
});

describe("SAFETY: nothing here stands in front of a stop", () => {
  it("while the state read is in flight, and has not answered, every stop is offered", async () => {
    mount({ state: () => new Promise(() => undefined), audit: [], detail: () => undefined });
    await screen.findByTestId("button-draft-pause");
    await waitFor(() => expect(calls.some((one) => one.startsWith("GET /api/failsafe/state"))).toBe(true));
    expect(stopsOffered()).toEqual([false, false, false]);
  });
});
