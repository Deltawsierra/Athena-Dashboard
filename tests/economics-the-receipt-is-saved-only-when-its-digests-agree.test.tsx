// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { createHash } from "node:crypto";

import { MASTER, exchange, fixture, served } from "./helpers/economics-fixtures";
import { NOT_SERVED_ROI, STALLED, bytesOf, mountEconomics, refusedWith, shims, type Answer } from "./helpers/economics-render";

/**
 * The page saves a receipt's signed bytes only when they agree with what it shows
 * (components/economics/ReceiptDownload.tsx): their SHA-256 is the one they were
 * sent with (`X-Content-SHA256`), and the envelope signs the document whose digest
 * the report shows (`receipt.document_digest`). The relay checks both before it
 * sends a byte (tests/economics-the-receipt-is-passed-on-only-when-its-digests-agree);
 * the page checks them again on what it received. A disagreement, a missing
 * header or a refusal saves nothing and says why. The bytes saved are the bytes
 * received. And the read passes its AbortSignal: leaving the view aborts it.
 */

beforeAll(shims);

const graded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
const report = served(graded, "report") as Record<string, any>;
const receipt = exchange(graded, "receipt");
const hex = report.receipt.receipt_id as string;
const sha256 = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

let saved: Array<{ name: string; bytes: string }>;
let pending: Map<string, Blob>;

/** A saved file's text, however the environment's Blob reads. */
function textOf(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}

beforeEach(() => {
  saved = [];
  pending = new Map();
  let made = 0;
  // The browser's file save, stood in for: the object URL a Blob gets, and the click that saves it.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      made += 1;
      const url = `blob:receipt-${made}`;
      pending.set(url, blob);
      return url;
    }),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    const blob = pending.get(this.getAttribute("href") ?? "");
    const into = saved; // this test's list, however late the Blob reads
    if (blob) void textOf(blob).then((bytes) => into.push({ name: this.download, bytes }));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
});

async function press(answer: Answer | typeof STALLED, shown: Answer = bytesOf(graded, "report")) {
  const mounted = await mountEconomics(graded, { report: shown, events: bytesOf(graded, "events"), roi: NOT_SERVED_ROI, receipt: answer });
  const panel = mounted.container.querySelector('[data-section="receipt"]') as HTMLElement;
  fireEvent.click(within(panel).getByTestId("receipt-download-button"));
  return { ...mounted, panel };
}

const settled = (panel: HTMLElement) =>
  waitFor(() => {
    const state = panel.querySelector("[data-receipt-state]")?.getAttribute("data-receipt-state");
    if (state !== "saved" && state !== "refused") throw new Error(`still ${state}`);
    return panel.querySelector("[data-receipt-state]") as HTMLElement;
  });

describe("a receipt's signed bytes, saved by the page", () => {
  it("are asked for by the report's receipt id and the digest shown, with the read's signal", async () => {
    const { panel, requested, signals } = await press(bytesOf(graded, "receipt"));
    await settled(panel);
    const index = requested.findIndex((one) => one.startsWith("/api/economics/receipt?"));
    const asked = new URL(requested[index], "http://dashboard");
    expect(asked.searchParams.get("receipt")).toBe(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    );
    expect(asked.searchParams.get("digest")).toBe(report.receipt.document_digest);
    expect(asked.searchParams.get("deployment")).toBe(report.scenario.deployment);
    expect(signals[index]).toBeInstanceOf(AbortSignal);
  });

  it("are saved exactly as received when both digests agree, and the page says what they matched", async () => {
    const { panel } = await press(bytesOf(graded, "receipt"));
    const state = await settled(panel);
    expect(state.getAttribute("data-receipt-state")).toBe("saved");
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ name: `financial-exposure-receipt-${hex}.json`, bytes: receipt.body });
    expect(within(panel).getByTestId("receipt-sha256").textContent).toBe(receipt.headers!["X-Content-SHA256"]);
  });

  it("whose SHA-256 is not the one they were sent with are not saved", async () => {
    const changed = receipt.body.replace(/"sig":"(.)/, (_all, first: string) => `"sig":"${first === "A" ? "B" : "A"}`);
    const { panel } = await press({ ...bytesOf(graded, "receipt"), body: changed });
    const state = await settled(panel);
    expect(state.getAttribute("data-receipt-code")).toBe("receipt_digest_mismatch");
    expect(state.textContent).toContain(sha256(changed));
    expect(saved).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("sent without their SHA-256 are not saved", async () => {
    const headers = { ...receipt.headers! };
    delete headers["X-Content-SHA256"];
    const { panel } = await press({ ...bytesOf(graded, "receipt"), headers });
    expect((await settled(panel)).getAttribute("data-receipt-code")).toBe("receipt_digest_missing");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("that sign another document than the one whose digest is shown are not saved", async () => {
    const other = structuredClone(report);
    other.receipt.document_digest = report.receipt.validity_card_digest;
    const { panel } = await press(bytesOf(graded, "receipt"), { status: 200, body: JSON.stringify(other) });
    const state = await settled(panel);
    expect(state.getAttribute("data-receipt-code")).toBe("receipt_document_mismatch");
    expect(state.textContent).toContain(report.receipt.document_digest);
    expect(state.textContent).toContain(report.receipt.validity_card_digest);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("refused by the relay are not saved, and the refusal is shown with its code", async () => {
    const refusal = refusedWith(502, "the receipt's bytes are not the bytes Athena-Backend named: refused", "receipt_digest_mismatch");
    const { panel } = await press(refusal);
    const state = await settled(panel);
    expect(state.getAttribute("data-receipt-code")).toBe("receipt_digest_mismatch");
    expect(state.textContent).toContain("the receipt's bytes are not the bytes Athena-Backend named");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("still being read when the view is left: the read is aborted", async () => {
    const { panel, requested, signals, unmount } = await press(STALLED);
    await waitFor(() => expect(panel.querySelector('[data-receipt-state="reading"]')).not.toBeNull());
    const index = requested.findIndex((one) => one.startsWith("/api/economics/receipt?"));
    const signal = signals[index]!;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
