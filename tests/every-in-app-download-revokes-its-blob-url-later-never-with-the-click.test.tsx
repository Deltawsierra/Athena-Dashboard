// @vitest-environment jsdom
/**
 * Every in-app download keeps its Blob URL until the save has read it.
 *
 * A Blob URL revoked right after the link's click can leave the save failed or
 * empty in Chromium, and so in the desktop app: the download the click starts
 * reads the URL after the click returns. The app-file save (lib/appFile.ts
 * saveAppFile) was moved to a revoke BLOB_URL_KEPT_MS later; four downloads
 * still revoked at once: the AI-BOM's "Export JSON", the assurance receipt's
 * "Download this view (JSON)", the incident pack's download (pages/Assurance.tsx)
 * and the signed Financial Exposure Receipt (components/economics/
 * ReceiptDownload.tsx). Now each one revokes through lib/appFile.ts
 * revokeBlobUrlLater:
 *
 *   - each download, clicked: its Blob URL is not revoked before the click, with
 *     it, or when the click's handler has returned; it is revoked once, the URL
 *     it made, when BLOB_URL_KEPT_MS is up. Each file keeps its name and type;
 *   - no source file of the page's code (client/, shared/) names
 *     revokeObjectURL but lib/appFile.ts, and that names it once, inside
 *     revokeBlobUrlLater. jsdom cannot show the race itself; the timing and the
 *     one place are pinned.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { AiBomPanel, AssuranceReceiptPanel, IncidentPackView } from "@/pages/Assurance";
import { BLOB_URL_KEPT_MS, saveAppFile } from "@/lib/appFile";
import { MASTER, fixture, served } from "./helpers/economics-fixtures";
import { NOT_SERVED_ROI, bytesOf, mountEconomics, shims } from "./helpers/economics-render";

const ROOT = path.resolve(__dirname, "..");
const HELPER = "client/src/lib/appFile.ts";

let made: string[];
let blobs: Blob[];
let clicked: HTMLAnchorElement[];
/** How many revokes had been made when each click ran. */
let revokedAtClick: number[];
let revoke: ReturnType<typeof vi.fn>;
/** Who waits for the next click. */
let waiting: Array<() => void>;
const nextClick = () => new Promise<void>((resolve) => waiting.push(resolve));

beforeAll(shims);
beforeEach(() => {
  made = [];
  blobs = [];
  clicked = [];
  revokedAtClick = [];
  revoke = vi.fn();
  waiting = [];
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      blobs.push(blob);
      const url = `blob:http://localhost/saved-${made.length + 1}`;
      made.push(url);
      return url;
    }),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: revoke });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
    clicked.push(this);
    revokedAtClick.push(revoke.mock.calls.length);
    for (const resolve of waiting.splice(0)) resolve();
  });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Left as no-ops, not removed: a revoke runs BLOB_URL_KEPT_MS after its save, possibly after this test.
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: () => "" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: () => undefined });
});

/** `data` seeded under `key`, and `ui` over it. */
function mountOver(key: string, data: unknown, ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => { throw new Error(`not seeded: ${JSON.stringify(queryKey)}`); },
      },
    },
  });
  client.setQueryData([key], data);
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/**
 * Under fake timers, `press` saves one file. Its Blob URL is not revoked before,
 * with or after the click, until BLOB_URL_KEPT_MS is up; then once, that URL.
 * The file saved is `name`, of `type`.
 */
async function expectRevokedOnlyLater(press: () => Promise<void>, name: string, type: string) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await press();
  expect(clicked, "one save").toHaveLength(1);
  expect(made, "one Blob URL").toHaveLength(1);
  const [url] = made;
  expect(clicked[0].getAttribute("href")).toBe(url);
  expect(clicked[0].download).toBe(name);
  expect(blobs[0].type).toBe(type);
  expect(revokedAtClick, "revoked before the click").toEqual([0]);
  expect(revoke, "revoked with the click, before the save read it").not.toHaveBeenCalled();
  vi.advanceTimersByTime(BLOB_URL_KEPT_MS - 1);
  expect(revoke, "revoked before its time").not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(revoke.mock.calls).toEqual([[url]]);
  vi.advanceTimersByTime(BLOB_URL_KEPT_MS);
  expect(revoke, "revoked once").toHaveBeenCalledTimes(1);
  expect(BLOB_URL_KEPT_MS).toBeGreaterThanOrEqual(10_000);
}

const click = (button: HTMLElement) => async () => { await act(async () => { fireEvent.click(button); }); };

/* ---- the pages' JSON downloads (pages/Assurance.tsx) ---------------------------- */

const BOM = {
  format: "mythos.ai-bom", version: "1.0",
  deployment: { uuid: "dep-1", name: "checkout" },
  components: [{
    uuid: "c-1", name: "chat model", kind: "model", kindLabel: "Model", identifier: "m", classification: "approved",
    classificationLabel: "Approved", shadow: false, providerName: null, facts: {},
  }],
  providers: [],
  summary: {
    componentCount: 1, providerCount: 0, shadowComponents: 0, componentsByKind: {}, componentsByClassification: {},
    declaredFactCount: 0, weakestEvidence: null,
  },
  receipt: { algorithm: "sha256", digest: "f".repeat(64) },
  generatedAt: null,
};

const RECEIPT = {
  receiptVersion: "mythos.assurance.receipt/3.1",
  system: { name: "checkout", uuid: "dep-1", environment: "production", environmentLabel: "Production" },
  result: { decision: "needs_more_evidence", decisionLabel: "Needs more evidence" },
  policy: { declared: false },
  evidence: { algorithm: "sha256", root: "b".repeat(64), findingCount: 3 },
  assessments: { compliance: "c".repeat(64), capabilities: "d".repeat(64), boundary: "e".repeat(64), bom: "f".repeat(64) },
  algorithm: "sha256",
  digest: "a".repeat(64),
  computedAt: "2026-09-25T00:00:00Z",
  signed: false,
  unsignedReason: "This backend holds no signing key.",
};

const PACK = {
  packVersion: "mythos.incident.pack/1.0",
  identity: {
    deployment: { name: "checkout", uuid: "d1", environment: "production", environmentLabel: "Production", owner: null },
    finding: {
      uuid: "f-1", fingerprint: "fp", category: "prompt_injection", title: "t", severity: "high",
      severityLabel: "High", status: "open", statusLabel: "Open", statusMustNotImply: null,
    },
  },
  surface: { asset: null, assetPresent: false, location: null, controlMapping: {} },
  evidence: { algorithm: "sha256", rows: [], count: 1, evidenceClass: "observed" },
  receipt: { algorithm: "sha256", digest: "9".repeat(64), evidenceCount: 1 },
  runtimeTranscript: {
    inAssuranceRecord: false, see: "", reason: "kept by the engine",
    enginePackRef: { available: false, scanUuid: null, engineRunId: null },
  },
  decision: { decision: null, decisionLabel: null },
  algorithm: "sha256",
  digest: "8".repeat(64),
  computedAt: null,
  signed: false,
  unsignedReason: null,
};

describe("each download's Blob URL is revoked later, never with the click", () => {
  it("the AI-BOM's Export JSON", async () => {
    mountOver("/api/assurance/deployments/dep-1/ai-bom", BOM, <AiBomPanel deploymentUuid="dep-1" />);
    await expectRevokedOnlyLater(click(screen.getByRole("button", { name: /Export JSON/ })), "ai-bom-checkout.json", "application/json");
  });

  it("the assurance receipt's Download this view (JSON)", async () => {
    mountOver("/api/assurance/deployments/dep-1/assurance-receipt", RECEIPT, <AssuranceReceiptPanel deploymentUuid="dep-1" />);
    await expectRevokedOnlyLater(
      click(screen.getByRole("button", { name: /Download this view \(JSON\)/ })),
      "assurance-receipt-checkout.json",
      "application/json",
    );
  });

  it("the incident pack's Download this view (JSON)", async () => {
    mountOver("/api/assurance/findings/f-1/incident-pack", PACK, <IncidentPackView findingUuid="f-1" />);
    await expectRevokedOnlyLater(
      click(screen.getByRole("button", { name: /Download this view \(JSON\)/ })),
      "incident-pack-f-1.json",
      "application/json",
    );
  });

  /* ---- the signed Financial Exposure Receipt (components/economics/ReceiptDownload.tsx) ---- */

  it("the signed Financial Exposure Receipt, saved once both its digests agree", async () => {
    const graded = fixture(MASTER, "graded-usd-policy-market-value-receipt");
    const hex = (served(graded, "report") as { receipt: { receipt_id: string } }).receipt.receipt_id;
    const { container } = await mountEconomics(graded, {
      report: bytesOf(graded, "report"), events: bytesOf(graded, "events"), roi: NOT_SERVED_ROI, receipt: bytesOf(graded, "receipt"),
    });
    const panel = container.querySelector('[data-section="receipt"]') as HTMLElement;
    // Its read and both checks are awaited by the click itself: waitFor's own
    // settling timer would never fire under fake timers.
    await expectRevokedOnlyLater(async () => {
      const saved = nextClick();
      await act(async () => {
        fireEvent.click(within(panel).getByTestId("receipt-download-button"));
        await saved;
      });
    }, `financial-exposure-receipt-${hex}.json`, "application/json");
    expect(panel.querySelector("[data-receipt-state]")?.getAttribute("data-receipt-state")).toBe("saved");
  });

  /* ---- an app file (lib/appFile.ts saveAppFile) ------------------------------------ */

  it("an app file read with the session", async () => {
    const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF, { status: 200, headers: { "Content-Type": "application/pdf" } })));
    await expectRevokedOnlyLater(() => saveAppFile("/api/scans/t9/backend-pdf", "scan-t9-report.pdf"), "scan-t9-report.pdf", "application/pdf");
  });
});

/* ---- one place revokes: lib/appFile.ts revokeBlobUrlLater ------------------------ */

/** The page's code: every source file under client/ and shared/. */
const SCANNED = ["client", "shared"];
/**
 * Source files whose path says settings are not read by this scan (the
 * project's automated searches leave settings files unread). They are named
 * here so the gap is in view: a new one fails this test until it is added.
 */
const LEFT_UNREAD = ["client/src/pages/Settings.tsx", "client/src/sample/settings.ts"];
const NAMED_FOR_SETTINGS = /settings/i;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(file);
      return /\.(?:[cm]?[jt]sx?|html)$/.test(entry.name) ? [file] : [];
    })
    .sort();
}

describe("no download revokes its Blob URL but through revokeBlobUrlLater", () => {
  const files = SCANNED.flatMap(sourceFiles);
  const read = files.filter((file) => !NAMED_FOR_SETTINGS.test(file));
  const mentions = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8").match(/\brevokeObjectURL\b/g)?.length ?? 0;

  it("the scan reaches every download's file, and leaves unread only the files it names", () => {
    for (const file of [HELPER, "client/src/components/economics/ReceiptDownload.tsx", "client/src/pages/Assurance.tsx"]) {
      expect(read, file).toContain(file);
    }
    expect(files.filter((file) => NAMED_FOR_SETTINGS.test(file))).toEqual(LEFT_UNREAD);
  });

  it("no file of the page's code names revokeObjectURL but lib/appFile.ts", () => {
    const elsewhere = read.filter((file) => file !== HELPER && mentions(file) > 0);
    expect(elsewhere, "revoke through revokeBlobUrlLater (lib/appFile.ts), never at once").toEqual([]);
  });

  it("lib/appFile.ts names it once, inside revokeBlobUrlLater", () => {
    const source = fs.readFileSync(path.join(ROOT, HELPER), "utf8");
    expect(mentions(HELPER)).toBe(1);
    const start = source.indexOf("export function revokeBlobUrlLater(");
    expect(start, "revokeBlobUrlLater is exported").toBeGreaterThanOrEqual(0);
    const end = source.indexOf("\n}\n", start);
    const at = source.search(/\brevokeObjectURL\b/);
    expect(at > start && at < end, "the one revoke is inside revokeBlobUrlLater").toBe(true);
  });
});
