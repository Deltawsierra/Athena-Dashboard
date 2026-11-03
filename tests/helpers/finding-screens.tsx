/**
 * Every screen of this dashboard that shows a finding, its evidence or where it
 * was found, mounted over ONE planted finding. Shared by:
 *
 *   - tests/a-hostile-finding-renders-inert-on-every-screen.test.tsx, which plants
 *     a hostile finding (markup, script, links, a 200 KB string, odd encodings);
 *   - tests/a-target-url-is-text-with-a-copy-button-on-every-screen.test.tsx,
 *     which plants an ordinary one.
 *
 * The screens are the real components. What each reads answers what this
 * dashboard's own routes answer, from a seeded cache or from a stubbed fetch, and
 * every request a stubbed fetch sees is recorded in `requests`.
 *
 * Beside the finding's own screens, the same planted strings reach the screens
 * that show a recovery record (/authority/recovery) and a scan by its name (the
 * Tests list's summary, the Engagements page's scans from the record).
 *
 * The planted finding reaches each screen in the fields that screen shows:
 *
 *   - `text` -- free text the target shaped: a title, a message, a type, a
 *     reason, an evidence line, a reading;
 *   - `long` -- appended to each screen's main free-text field (a message, a
 *     title, a details line, a description);
 *   - `url`  -- a URL the target supplied: the finding's endpoint or location.
 *
 * The Findings page picks its engagement with the shell's Radix select, which
 * opens in jsdom but stalls on an item's selection. A test file that mounts it
 * stands the select in with a native one (its own vi.mock of
 * "@/components/ui/select"); the page's code is unchanged.
 */
import type { ComponentType, ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import Authority from "@/pages/Authority";
import Engagements from "@/pages/Engagements";
import Tests from "@/pages/Tests";
import Findings from "@/pages/Findings";
import Risks from "@/pages/Risks";
import Overview from "@/pages/Overview";
import Assurance from "@/pages/Assurance";
import RetestPanel from "@/components/RetestPanel";
import { ApprovedWorkflowsView } from "@/components/authority/ApprovedWorkflows";
import { AuthorityChainsView } from "@/components/authority/AuthorityChains";
import { ToolContractsView } from "@/components/authority/ToolContracts";
import { ReleaseGateView } from "@/components/authority/ReleaseGate";
import type { ApprovedWorkflows, AuthorityChains, DecisionSupport, ToolAsset, WorkflowComposition } from "@/components/authority/types";
import { getQueryFn, queryClient as appQueryClient } from "@/lib/queryClient";
import type { RecoveryRecords } from "@shared/recovery-record";
import { summarizeFindings } from "../../server/findings-summary";

export interface Planted {
  text: string;
  long: string;
  url: string;
}

/** Every request a stubbed fetch saw, in order. */
export const requests: Array<{ url: string; method: string }> = [];

const NOW = new Date().toISOString();
/** The scan target a person typed: not the target's own words. */
const SCAN_TARGET = "https://app.customer.example/";
const CLIENT = { id: "c1", name: "Acme", company: "Acme", email: "a@acme.test", status: "active", lastTestDate: null, notes: null, backendEngagementId: null };
const COMMON_SEED: Array<[unknown[], unknown]> = [
  [["/api/sample-data"], { clients: 0, sites: 0, tests: 0, documents: 0, findings: 0 }],
  [["/api/auth/check"], { authenticated: true, user: null }],
];

/** jsdom lacks these; the screens' layout code calls them. */
export function standInLayoutApis() {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.releasePointerCapture ??= () => {};
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fetch that records every request and answers from `answer`, or {} for anything it does not name. */
export function recordingFetch(answer: (url: string, init?: RequestInit) => unknown) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, method: init?.method ?? "GET" });
    const body = answer(url, init);
    return body instanceof Response ? body : json(body ?? {});
  });
}

/** A page over a seeded cache: every source answers from `seed`; any other read is an error, never a request. */
function mountSeeded(ui: ReactElement, seed: Array<[unknown[], unknown]>) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, staleTime: Infinity, gcTime: Infinity,
        queryFn: async ({ queryKey }) => { throw new Error(`not seeded: ${JSON.stringify(queryKey)}`); },
      },
    },
  });
  for (const [key, value] of seed) client.setQueryData(key, value);
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/* ---- the findings register (Risks, /findings) ---------------------------------- */

export function mountRisks(p: Planted) {
  const finding = {
    id: "f1", clientId: "c1", siteId: null, type: "reflected_xss", severity: "high", message: `${p.text}${p.long}`,
    status: "open", firstSeenAt: NOW, lastSeenAt: NOW, target: p.url, endpoint: p.url, ownerId: null, sightings: [], checks: [],
  };
  const record = {
    clientId: "c1", engagementId: 7, deployments: [{ uuid: "d1", name: p.text }], readAt: NOW,
    findings: [{
      uuid: "bf1", title: p.text, severity: "high", status: "open", statusLabel: p.text, findingType: p.text,
      deploymentUuid: "d1", scanUuid: null, engineRunId: null, test: null, retestChecks: [],
    }],
  };
  return mountSeeded(<Risks />, [
    [["/api/clients"], [CLIENT]], [["/api/tests"], []], [["/api/sites"], []], [["/api/users/assignable"], []],
    [["/api/assurance/deployments"], []],
    [["/api/findings/summary"], summarizeFindings({ clients: [CLIENT], sites: [], findings: [finding] as never })],
    [["/api/findings", { clientId: "c1" }], { findings: [finding], counts: { open: 1, acknowledged: 0, accepted: 0, fixed: 0 } }],
    [["/api/record/clients/c1/findings"], record],
    ...COMMON_SEED,
  ]);
}

/* ---- the Overview's top open issues ---------------------------------------------- */

export function mountOverview(p: Planted) {
  const findings = [
    { id: "a", clientId: "c1", siteId: null, type: "reflected_xss", severity: "high", message: `${p.text}${p.long}`, status: "open", firstSeenAt: NOW, lastSeenAt: NOW },
  ];
  return mountSeeded(<Overview />, [
    [["/api/clients"], [CLIENT]], [["/api/sites"], []], [["/api/tests"], []], [["/api/assurance/deployments"], []],
    [["/api/findings/summary"], summarizeFindings({ clients: [CLIENT], sites: [], findings: findings as never })],
    ...COMMON_SEED,
  ]);
}

/* ---- a finding's life: the Findings page, its evidence of a fix and its checks --- */

export async function mountFindings(p: Planted) {
  const finding = {
    id: "f1", clientId: "c1", siteId: null, type: "reflected_xss", severity: "high", message: `${p.text}${p.long}`,
    target: SCAN_TARGET, endpoint: p.url, header: null, status: "fixed", ownerId: null, ownerName: null, statusNote: p.text,
    timesSeen: 1, firstSeenAt: NOW, lastSeenAt: NOW, fixedAt: NOW, fixedByRunId: p.text, fixedVerdict: p.text, reopenedAt: null,
    source: "dashboard-direct",
    sightings: [{ id: "s1", runId: p.text, seen: true, observedAt: NOW }],
    checks: [{ id: "k1", verdict: p.text, detail: p.text, runId: p.text, checkedAt: NOW, filedVia: null, requestedAt: null, backend: null }],
  };
  vi.stubGlobal("fetch", recordingFetch((url) => {
    if (url.endsWith("/api/clients")) return [CLIENT];
    if (url.endsWith("/api/users/assignable")) return [];
    if (url.includes("/api/findings?clientId=c1")) return { findings: [finding], counts: { open: 0, acknowledged: 0, accepted: 0, fixed: 1 } };
    return {};
  }));
  const mounted = render(<QueryClientProvider client={appQueryClient}><Findings /></QueryClientProvider>);
  await screen.findByTestId("select-findings-client");
  const picker = screen.getAllByTestId("native-select")[0] as HTMLSelectElement;
  await waitFor(() => { if (!Array.from(picker.options).some((one) => one.value === "c1")) throw new Error("no c1 yet"); });
  fireEvent.change(picker, { target: { value: "c1" } });
  await screen.findByTestId("finding-f1", {}, { timeout: 10_000 });
  return mounted;
}

/* ---- a scan's own decisions, with their retest (RetestPanel) --------------------- */

export async function mountRetestPanel(p: Planted) {
  const twin = {
    id: 7, runId: "scan-run", target: SCAN_TARGET, findingType: p.text, severity: "high", tier: null,
    confidence: null, endpoint: p.url, detail: `${p.text}${p.long}`, capturedAt: null,
  };
  vi.stubGlobal("fetch", recordingFetch((url) => {
    if (url.includes("/api/tests/t1/decisions")) return { decisions: [twin], truncated: false, detail: "" };
    if (url.endsWith("/api/tests/t1/retests")) return { retests: [] };
    return {};
  }));
  const mounted = render(<QueryClientProvider client={appQueryClient}><RetestPanel testId="t1" /></QueryClientProvider>);
  await screen.findByTestId("decision-7", {}, { timeout: 10_000 });
  return mounted;
}

/* ---- the Athena and Penetration testing scan screens: the engine's findings ------ */

export async function mountScan(Page: ComponentType, p: Planted) {
  const findings = [
    {
      type: p.text, severity: "high", message: p.text, details: `${p.text}${p.long}`, confidence: 0.65, confidence_basis: p.text,
      narrative: p.text, evidence: { endpoint: p.url, request_url: p.url },
    },
    // The engine's own diagnostic, shown under "From the engine".
    { type: "engine_note", internal: true, message: p.text, details: p.text },
  ];
  const mounted = mountSeeded(<Page />, [
    [["/api/engine/status"], { configured: true, reachable: true, authorized: true, url: "http://engine.test", detail: "" }],
    [["/api/clients"], [{ id: "c1", name: "Acme" }]],
    [["/api/sites"], []],
    [["/api/scans/t1"], {
      test: { id: "t1", startedAt: NOW, criticalCount: 0, highCount: 1, mediumCount: 0, lowCount: 0 },
      state: "running",
      engine: { findings },
    }],
    ...COMMON_SEED,
  ]);
  // Start a scan as a person does; the POST answers test t1.
  vi.stubGlobal("fetch", recordingFetch(() => json({ test: { id: "t1" }, runId: "run-1" }, 201)));
  fireEvent.change(document.querySelectorAll("select")[0], { target: { value: "c1" } });
  fireEvent.change(screen.getByTestId("input-target"), { target: { value: SCAN_TARGET } });
  fireEvent.click(screen.getByTestId("checkbox-consent"));
  fireEvent.click(screen.getByTestId("button-start-scan"));
  await screen.findByTestId("list-findings", {}, { timeout: 10_000 });
  return mounted;
}

/* ---- the Assurance console: a finding, its closure, its history, its incident pack */

export const ASSURANCE_FINDING = "af1";

export async function mountAssurance(p: Planted) {
  const finding = {
    uuid: ASSURANCE_FINDING, deploymentUuid: "d1", title: `${p.text}${p.long}`, severity: "high",
    status: "open", statusLabel: p.text, statusMustNotImply: p.text, evidenceClass: p.text, location: p.url,
    assetUuid: null, assetName: p.text, changeStatus: "new", changeLabel: p.text, ageDays: 3, stale: true,
    receipt: { algorithm: "sha256", digest: "9".repeat(64), evidenceCount: 1 },
    assignee: p.text, remediationState: "triage",
    closure: {
      standing: "not_closable", retestRequired: true, reasons: [p.text],
      evidence: {
        uuid: "r-1", origin: p.text, contentDigest: p.text, recordedAt: null,
        fixtures: {
          vulnerable: { ran: true, outcome: p.text }, repaired: { ran: true, outcome: "passed" }, benign: { ran: false, outcome: null },
          incompleteRepair: { [p.text]: { ran: true, outcome: p.text } },
        },
      },
    },
  };
  const pack = {
    packVersion: "mythos.incident.pack/1.0", attests: p.text,
    identity: {
      deployment: { name: p.text, uuid: "d1", environment: "production", environmentLabel: "Production", owner: p.text },
      finding: {
        uuid: ASSURANCE_FINDING, fingerprint: p.text, category: p.text, title: `${p.text}${p.long}`, severity: "high",
        severityLabel: "High", status: "open", statusLabel: p.text, statusMustNotImply: p.text,
      },
    },
    surface: { asset: { name: p.text, kindLabel: p.text, classificationLabel: p.text }, assetPresent: true, location: p.url, controlMapping: {} },
    evidence: { algorithm: "sha256", rows: [[p.text, p.url]], count: 1, evidenceClass: p.text },
    receipt: { algorithm: "sha256", digest: "9".repeat(64), evidenceCount: 1 },
    runtimeTranscript: {
      inAssuranceRecord: false, see: p.text, reason: p.text,
      enginePackRef: { available: false, scanUuid: null, engineRunId: null },
    },
    decision: { decision: null, decisionLabel: p.text },
    algorithm: "sha256", digest: "8".repeat(64), computedAt: null, signed: false, unsignedReason: p.text,
  };
  const mounted = mountSeeded(<Assurance />, [
    [["/api/assurance/status"], { configured: true, reachable: true, authorized: true, url: null, detail: "" }],
    [["/api/assurance/deployments"], [{ uuid: "d1", name: "checkout", environment: "production", decision: null, decisionLabel: "", findingCount: 1, updatedAt: null }]],
    [["/api/assurance/findings"], [finding]],
    [["/api/assurance/unknowns"], []], [["/api/assurance/assets"], []], [["/api/assurance/providers"], []],
    [["/api/users/assignable"], []],
    [[`/api/assurance/findings/${ASSURANCE_FINDING}/remediation`], {
      state: "triage", stateLabel: p.text, assignee: p.text,
      events: [{ fromState: null, toState: "triage", actor: p.text, note: p.text, createdAt: null }],
    }],
    [[`/api/assurance/findings/${ASSURANCE_FINDING}/incident-pack`], pack],
    ...COMMON_SEED,
  ]);
  // The flat list: every finding, each with its closure, its history and its pack.
  fireEvent.click(screen.getByRole("button", { name: "List" }));
  const row = await waitFor(() => {
    const found = Array.from(document.querySelectorAll("li")).find((li) => li.querySelector("[data-testid='closure-standing']"));
    if (!found) throw new Error("no finding row with a closure standing yet");
    return found as HTMLElement;
  }, { timeout: 10_000 });
  await act(async () => {
    fireEvent.click(screen.getByTestId("closure-standing-toggle"));
    fireEvent.click(Array.from(row.querySelectorAll("button")).find((one) => one.textContent === "History")!);
    fireEvent.click(Array.from(row.querySelectorAll("button")).find((one) => one.textContent === "Incident pack")!);
  });
  await screen.findByTestId("incident-pack-signature");
  return { mounted, pack };
}

/** The incident pack's export: "Download this view (JSON)". */
export function incidentPackDownload(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((one) => one.textContent?.includes("Download this view (JSON)"));
  if (!(button instanceof HTMLButtonElement)) throw new Error("no incident-pack download");
  return button;
}

/* ---- the authority screens (G10): approvals, chains, tool contracts, release gate */

export function renderAuthorityScreens(p: Planted) {
  const composition: WorkflowComposition = {
    signal: "needs_more_evidence", ruleDecision: "needs_more_evidence",
    census: { held: 0, violated: 1, incomplete: 0, not_demonstrated: 0 },
    deciding: [p.text], workflowsAssessed: 1, workflowsExpected: 1, workflowsUnreported: 0, workflowsUnapproved: 0,
    workflowsUnexercised: 1, unexercised: [p.text], authorizationChecked: [p.text], offRoute: [p.text],
    explanation: `${p.text}${p.long}`,
  };
  const approved: ApprovedWorkflows = {
    approved: [{
      uuid: "wf-1", slug: "refunds", name: p.text, description: `${p.text}${p.long}`, approvedBy: p.text, approvedAt: NOW,
      tools: [{ kind: "tool", identifier: p.text, approvedDigest: "a".repeat(64), boundAt: NOW, currentDigest: "b".repeat(64), superseded: true }],
    }],
    returned: 1, truncated: false, pageSize: 1000, approvedCount: 1, composition,
  };
  const chains = {
    chains: [{
      uuid: "ch-1", workflow: p.text, effect: p.text, digest: `sha256:${"e".repeat(64)}`,
      standing: true, verdict: "unproven", basis: "demonstrated", basisInForce: "attested", signed: false,
      observerEngine: p.text, outcomeId: p.text, gateOutcomeId: null, effectOutcomeId: null, route: "current",
      observedAt: NOW, recordedAt: NOW, recordedBy: p.text, source: p.text, note: `${p.text}${p.long}`, unprovenHops: [0], brokenHops: [],
      hops: [{
        index: 0, from: { kind: "agent", ref: p.text, version: null }, relation: "invokes",
        to: { kind: "tool", ref: p.url, version: null }, verdict: "unproven", provenBy: [],
        reasons: [{ verdict: "unproven", code: "no_dispatch_state", detail: p.text }],
      }],
    }],
    returned: 1, truncated: false, pageSize: 100, recorded: 1, standing: 1, superseded: 0,
    verdictCensus: { broken: 0, proven: 0, unproven: 1 },
    approvalsInForce: { [p.text]: "9".repeat(64) },
    effects: [{
      digest: `sha256:${"1".repeat(64)}`, workflow: p.text, toolKind: "tool", toolIdentifier: p.text,
      effectClass: "write", effectKind: "consequential", status: "unknown", reasons: [p.text],
      chains: [], toDo: p.text,
    }],
    effectCensus: { covered: 0, missing: 0, not_required: 0, unknown: 1 },
  } as unknown as AuthorityChains;
  const assets: ToolAsset[] = [{
    uuid: "as-1", deploymentUuid: "dep-1", kind: "tool", kindLabel: p.text, name: p.text, identifier: p.text,
    classification: "approved", classificationLabel: p.text,
    metadata: { effect_class: "write", description: `${p.text}${p.long}`, endpoint: p.url, permissions: [p.text] },
    firstSeen: NOW, lastSeen: NOW,
  }];
  const decision = {
    decision: "audit_incomplete", decisionLabel: p.text, revision: 12,
    fromFindings: "ready", claimCap: null, coverageCap: "audit_incomplete", acceptedRiskCap: null,
    policyVersion: p.text, composition, paused: false,
    claims: {
      hasClaims: true, retestPending: false, contradicted: [], stale: [], unknown: [], supporting: [],
      supersededToolContracts: [
        { subject: "workflow", claimFingerprint: null, workflow: p.text, toolKind: "tool", toolIdentifier: p.text, boundDigest: "a".repeat(64), currentDigest: "b".repeat(64) },
      ],
      authorityChainsBroken: [],
      authorityChainsUnproven: [{
        uuid: "ch-1", workflow: p.text, effect: p.text, digest: `sha256:${"e".repeat(64)}`, verdict: "unproven",
        hops: [{ index: 0, relation: "invokes", from: { kind: "agent", ref: p.text, version: null }, to: { kind: "tool", ref: p.url, version: null }, verdict: "unproven", reasons: [p.text] }],
      }],
      authorityChainsMissing: [], effectClassesUnknown: [],
    },
    note: `${p.text}${p.long}`,
  } as unknown as DecisionSupport;
  return [
    render(<ApprovedWorkflowsView data={approved} />),
    render(<AuthorityChainsView data={chains} />),
    render(<ToolContractsView assets={assets} workflows={approved} />),
    render(<ReleaseGateView data={decision} />),
  ];
}

/* ---- a recovery record (/authority/recovery): an incident, its steps, its coverage */

export async function mountRecoveryRecords(p: Planted) {
  const step = {
    ref: "f-hostile-step-1", version: 1, state: p.text, reopens: null,
    conditions: [{ condition: p.text, witness: { kind: p.text, ref: p.text } }],
    gaps: [p.text], restrictions: [`${p.text}${p.long}`], release: "AUDIT_INCOMPLETE",
    residualUncertainty: [{ statement: p.text, sources: [{ kind: p.text, ref: p.text }] }],
    coverage: {
      sources: [{ source: p.text, kind: p.text, start: NOW, end: NOW }],
      declaredGaps: [{ kind: p.text, subject: p.text, detail: p.text, start: null, end: null }],
      observedSources: 1, requiredSources: 2, complete: false, missing: { [p.text]: [{ start: NOW, end: NOW }] }, unknownInventory: [p.text],
    },
    acceptedBy: p.text, acceptedUntil: null, recordedBy: p.text, recordedAt: NOW,
  };
  const page: RecoveryRecords = {
    deployment: "d1",
    incidents: [{
      finding: "f-hostile", title: `${p.text}${p.long}`, severity: "high",
      current: { version: 1, state: p.text, release: "AUDIT_INCOMPLETE" }, steps: [step, { ...step, ref: "f-hostile-step-2", version: 2 }],
    }],
    incidentCount: 1, returned: 1, truncated: false, pageSize: 50, offset: 0,
  };
  vi.stubGlobal("fetch", recordingFetch((url) => {
    if (url.endsWith("/api/assurance/status")) return { configured: true, reachable: true, authorized: true, url: null, detail: "" };
    if (url.endsWith("/api/assurance/deployments")) return [{ uuid: "d1", name: "checkout", environment: "production", decision: null, decisionLabel: "" }];
    if (url.includes("/api/assurance/deployments/d1/recovery-records")) return page;
    return {};
  }));
  const location = memoryLocation({ path: "/authority/recovery?deployment=d1", record: true });
  const client = new QueryClient({
    defaultOptions: { ...appQueryClient.getDefaultOptions(), queries: { ...appQueryClient.getDefaultOptions().queries, retry: false, queryFn: getQueryFn({ on401: "throw" }) } },
  });
  const mounted = render(
    <QueryClientProvider client={client}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <Authority params={{ screen: "recovery" }} />
      </Router>
    </QueryClientProvider>,
  );
  const card = await screen.findByTestId("incident", {}, { timeout: 10_000 });
  // Every step, not only the current one.
  const history = Array.from(card.querySelectorAll("button")).find((one) => /histor|step/i.test(one.textContent ?? ""));
  if (history) await act(async () => { fireEvent.click(history); });
  return mounted;
}

/* ---- a scan by its name: the Tests list, and the Engagements page's scans ------- */

/**
 * A scan adopted from the record is listed by a summary built from the target URL
 * the record names (server/backend-adoption.ts), so a scan's name carries what the
 * record was given.
 */
export function mountScanList(p: Planted) {
  const test = {
    id: "t1", clientId: "c1", siteId: null, testType: "penetration-test", status: "completed", severity: "high",
    startedAt: NOW, completedAt: NOW, summary: `${p.text}${p.long}`, findings: null,
    vulnerabilitiesFound: 1, criticalCount: 0, highCount: 1, mediumCount: 0, lowCount: 0, executedBy: null,
  };
  return mountSeeded(<Tests />, [
    [["/api/tests"], [test]], [["/api/clients"], [CLIENT]], [["/api/sites"], []], [["/api/assurance/deployments"], []],
    ...COMMON_SEED,
  ]);
}

export function mountEngagements(p: Planted) {
  const record = {
    readAt: NOW,
    engagements: [{
      id: 7, name: p.text, clientName: p.text, scopeSummary: p.text, status: "running",
      testingWindowStart: NOW, testingWindowEnd: NOW, scopeHosts: [p.text], client: null,
    }],
    scans: [{
      uuid: "bs-1", targetUrl: p.url, status: "failed", verdict: null, verdictLabel: p.text, createdAt: NOW, collectedAt: NOW,
      engineRunId: p.text, stop: { state: p.text, detail: p.text }, pdfUrl: null, errorMessage: `${p.text}${p.long}`,
      engagement: { id: 7, name: p.text, clientName: p.text, status: p.text }, test: null,
    }],
    scansUnread: null,
    deployments: [],
    deploymentsUnread: null,
  };
  return mountSeeded(<Engagements />, [
    [["/api/record/engagements"], record], [["/api/clients"], [CLIENT]], [["/api/tests"], []], [["/api/sites"], []],
    ...COMMON_SEED,
  ]);
}
