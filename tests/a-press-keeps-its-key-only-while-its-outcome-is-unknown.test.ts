import { describe, expect, it } from "vitest";

import { ApiError, UnauthorizedError, scanStartFailureTitle } from "../client/src/lib/queryClient";
import { isKeyBug, keyedPress, outcomeUnknown, saysOutcomeUnknown } from "../client/src/lib/keyedPress";
import { IDEMPOTENCY_HEADER, actionFor, keyRecordOf, newKey, readableKey, refusesTheKey } from "../shared/idempotency";

/**
 * The page's side of a press's Idempotency-Key (client/src/lib/keyedPress.ts,
 * shared/idempotency.ts): one key per press; the same key only when the same
 * press is sent again while its outcome is unknown; a new key for anything
 * else; and every answer read for what it says -- a press whose start nobody
 * knows about is never re-sent with a new key, and a key refused is a bug.
 */

const answer = (status: number, body: Record<string, unknown> | null) => new ApiError("said", status, body);
const REQUEST = { clientId: "c", siteId: "s", target: "https://app.customer.example/" };

describe("one key per press", () => {
  it("the same press sent again while its outcome is unknown carries its key", () => {
    let n = 0;
    const press = keyedPress(() => `key-${++n}`);
    const first = press.headersFor(REQUEST)[IDEMPOTENCY_HEADER];
    press.failed(new TypeError("Failed to fetch"));
    expect(press.headersFor(REQUEST)[IDEMPOTENCY_HEADER]).toBe(first);
  });

  it("an answered press lets its key go: the next press is a new action", () => {
    let n = 0;
    const press = keyedPress(() => `key-${++n}`);
    const first = press.headersFor(REQUEST)[IDEMPOTENCY_HEADER];
    press.answered();
    expect(press.headersFor(REQUEST)[IDEMPOTENCY_HEADER]).not.toBe(first);
  });

  it("another request is another action, even while the first is unknown", () => {
    let n = 0;
    const press = keyedPress(() => `key-${++n}`);
    const first = press.headersFor(REQUEST)[IDEMPOTENCY_HEADER];
    press.failed(new TypeError("Failed to fetch"));
    expect(press.headersFor({ ...REQUEST, target: "https://other.customer.example/" })[IDEMPOTENCY_HEADER]).not.toBe(first);
  });

  it("a refusal that says what happened lets the key go", () => {
    let n = 0;
    const press = keyedPress(() => `key-${++n}`);
    const first = press.headersFor(REQUEST)[IDEMPOTENCY_HEADER];
    press.failed(answer(409, { error: "the engine refused this scan", detail: "the engine is stood_down; not accepting new work" }));
    expect(press.headersFor(REQUEST)[IDEMPOTENCY_HEADER]).not.toBe(first);
  });

  it("a key is a UUID, from randomUUID or, outside a secure context, from getRandomValues", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(newKey()).toMatch(uuid);
    const insecure = { getRandomValues: (array: Uint8Array) => globalThis.crypto.getRandomValues(array) };
    expect(newKey(insecure)).toMatch(uuid);
    expect(newKey(insecure)).not.toBe(newKey(insecure));
    expect(actionFor(null, REQUEST).key).toMatch(uuid);
  });
});

describe("each answer is read for what it says", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["no answer arrived", new TypeError("Failed to fetch"), true],
    ["a gateway answered in the server's place", answer(502, null), true],
    ["the first send is still being answered here", answer(409, { reason: "idempotency_in_flight", idempotency: { state: "in_flight" } }), true],
    ["the engine has no answer for the first send yet", answer(409, { reason: "scan_outcome_unknown", idempotency: { state: "in_flight" }, mayStillBeRunning: true }), true],
    ["the engine says the first send raised", answer(409, { reason: "scan_outcome_unknown", idempotency: { state: "unknown" }, mayStillBeRunning: true }), false],
    ["the push's outcome is unknown", answer(503, { reason: "push_outcome_unknown", idempotency: { state: null } }), true],
    ["the engine may have started it (a timeout)", answer(503, { reason: "scan_unanswered", mayStillBeRunning: true }), true],
    ["refused: the concurrency limit", answer(409, { reason: "concurrency_limit" }), false],
    ["refused by the engine", answer(409, { error: "the engine refused this scan" }), false],
    ["a bug: the key refused", answer(500, { reason: "idempotency_bug" }), false],
    ["signed out", new UnauthorizedError(), false],
  ];
  for (const [what, error, unknown] of cases) {
    it(`${what}: ${unknown ? "kept" : "let go"}`, () => {
      expect(outcomeUnknown(error)).toBe(unknown);
    });
  }

  it("the page says unknown as unknown, and a key refused as a bug", () => {
    const unknown = answer(409, { reason: "scan_outcome_unknown", idempotency: { state: "in_flight" }, mayStillBeRunning: true });
    expect(saysOutcomeUnknown(unknown)).toBe(true);
    expect(scanStartFailureTitle(unknown)).toMatch(/^We don't know whether this scan started/);
    expect(scanStartFailureTitle(answer(409, { reason: "idempotency_in_flight" }))).toMatch(/^We don't know whether this scan started/);
    expect(isKeyBug(answer(500, { reason: "idempotency_bug" }))).toBe(true);
    expect(isKeyBug(answer(400, { reason: "idempotency_key_invalid" }))).toBe(true);
    expect(scanStartFailureTitle(answer(500, { reason: "idempotency_bug" }))).toMatch(/bug/);
    // Unchanged: a start that may still be running names what stops it.
    expect(scanStartFailureTitle(answer(503, { reason: "scan_unanswered", mayStillBeRunning: true }))).toMatch(/kill switch/);
  });
});

describe("what the engine and the backend say under a key", () => {
  it("a key is 1 to 255 printable ASCII characters", () => {
    expect(readableKey(" k ")).toBe("k");
    for (const bad of ["", "   ", "x".repeat(256), "café", "a\u007fb", 7, null]) expect(readableKey(bad)).toBeNull();
  });

  it("an answer about a key names its record; the route's own answer does not", () => {
    expect(keyRecordOf({ detail: "d", idempotency: { state: "in_flight", since: "t" } })).toEqual({ state: "in_flight" });
    expect(keyRecordOf({ detail: "the engine is stood_down; not accepting new work" })).toBeNull();
    expect(refusesTheKey(400, { detail: "Idempotency-Key must be 1 to 255 printable ASCII characters. Nothing was done." })).toBe(true);
    expect(refusesTheKey(400, { detail: "Unknown connector 'bogus'." })).toBe(false);
  });
});
