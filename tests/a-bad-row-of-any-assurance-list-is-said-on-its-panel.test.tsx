// @vitest-environment jsdom
/**
 * A row of any assurance list that the server could not read is said on the
 * panel that draws the list, by name, and never read as "none" (DASH-ROWS).
 *
 * The server now counts such a row in the read's `unreadable`, under the list's
 * name, where one used to fail the whole read (server/assurance.ts rowsOf;
 * tests/no-assurance-read-fails-whole-on-one-bad-row-of-any-list.test.ts). Each
 * panel here is handed the answer the real route gives for a backend that
 * served one bad row of each kind in every list (tests/helpers/bad-rows.ts),
 * and must say "4 rows could not be read: <list>" for each of them; a panel
 * handed the clean answer says nothing of the kind; and a panel whose list
 * had only rows that could not be read does not say the list is empty.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import type { ReactElement } from "react";

import {
  AiBomPanel, BomDriftPanel, BusinessImpactPanel, CapabilityPanel, CompliancePanel, ConnectorsPanel, CoverageManifestPanel,
  DataBoundaryPanel, DataLifecyclePanel, DeclaredArchitecturePanel, EffectiveAccessPanel, IncidentPackView, MetadataLoggingPanel,
  OperationalRiskPanel, PersonalContextPanel, PostureDomainCard, PosturePanel, RemediationDetailView, RevalidationPlanPanel,
  RippleEffectPanel, RouteMapPanel, TrainingReusePanel, VendorAssurancePanel, VerticalPacksPanel,
} from "@/pages/Assurance";
import { listLabel } from "@/components/authority/parts";
import { getQueryFn } from "@/lib/queryClient";
import { CASES, DEP, FINDING, FOUR, LEAK, clean, rows, standIn } from "./helpers/bad-rows";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Each read's panel, by the route it reads. */
const PANELS: Record<string, () => ReactElement> = {
  capabilities: () => <CapabilityPanel deploymentUuid={DEP} />,
  "route-map": () => <RouteMapPanel deploymentUuid={DEP} />,
  "ai-bom": () => <AiBomPanel deploymentUuid={DEP} />,
  "data-boundary": () => <DataBoundaryPanel deploymentUuid={DEP} admin={false} />,
  compliance: () => <CompliancePanel deploymentUuid={DEP} />,
  "business-impact": () => <BusinessImpactPanel deploymentUuid={DEP} />,
  "vendor-assurance": () => <VendorAssurancePanel deploymentUuid={DEP} />,
  "assurance-packs": () => <VerticalPacksPanel deploymentUuid={DEP} />,
  "assurance-packs/health": () => <VerticalPacksPanel deploymentUuid={DEP} />,
  remediation: () => <RemediationDetailView findingUuid={FINDING} />,
  "effective-access": () => <EffectiveAccessPanel deploymentUuid={DEP} />,
  "ripple-effect": () => <RippleEffectPanel deploymentUuid={DEP} />,
  posture: () => <PosturePanel deploymentUuid={DEP} />,
  "cloud-posture": () => <PostureDomainCard icon={Cpu} deploymentUuid={DEP} domain="Cloud" query="cloud-posture" />,
  "secrets-posture": () => <PostureDomainCard icon={Cpu} deploymentUuid={DEP} domain="Secrets" query="secrets-posture" />,
  "repo-posture": () => <PostureDomainCard icon={Cpu} deploymentUuid={DEP} domain="Repos" query="repo-posture" />,
  "personal-context": () => <PersonalContextPanel deploymentUuid={DEP} />,
  "data-lifecycle": () => <DataLifecyclePanel deploymentUuid={DEP} />,
  "training-reuse": () => <TrainingReusePanel deploymentUuid={DEP} />,
  "metadata-logging": () => <MetadataLoggingPanel deploymentUuid={DEP} />,
  "bom-drift": () => <BomDriftPanel deploymentUuid={DEP} admin={false} />,
  "coverage-manifest": () => <CoverageManifestPanel deploymentUuid={DEP} />,
  "revalidation-plan": () => <RevalidationPlanPanel deploymentUuid={DEP} />,
  "operational-risk": () => <OperationalRiskPanel deploymentUuid={DEP} />,
  "incident-pack": () => <IncidentPackView findingUuid={FINDING} />,
  connectors: () => <ConnectorsPanel deploymentUuid={DEP} admin={false} findings={[]} />,
};
/** Read by no screen of this console: the assign picker reads the console's own users. */
const NO_PANEL = new Set(["assignable"]);

const panelOf = (route: string) => route.replace(`/api/assurance/deployments/${DEP}/`, "").replace(`/api/assurance/findings/${FINDING}/`, "");

/** What the dashboard's routes answered, by route: for the bad rows, and with them taken out. */
const answered: Record<"bad" | "clean" | "allBad", Record<string, unknown>> = { bad: {}, clean: {}, allBad: {} };

/** Every top-level list of a served answer with only bad rows in it. */
function onlyBad(served: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(served).map(([k, v]) => [k, Array.isArray(v) ? [null, LEAK] : v]));
}

beforeAll(async () => {
  const backend = await standIn();
  try {
    for (const one of CASES) {
      for (const [kind, served] of [["bad", one.served], ["clean", clean(one.served)], ["allBad", onlyBad(one.served)]] as const) {
        backend.serve({ [one.backend]: served });
        const res = await backend.user.get(one.route);
        expect(res.status, `${kind} ${one.route}`).toBe(200);
        answered[kind][one.route] = res.body;
      }
    }
    backend.serve({
      [`/api/assurance/deployments/${DEP}/declared-architecture/`]: {
        declared: rows({ uuid: "d-1", name: "model" }),
        drift: { undeclared: rows({ asset_uuid: "a-1" }), missing: rows({ declared_uuid: "d-1" }), summary: {} },
      },
    });
    answered.bad.declared = (await backend.user.get(`/api/assurance/deployments/${DEP}/declared-architecture`)).body;
    backend.serve({ [`/api/assurance/deployments/${DEP}/declared-architecture/`]: { declared: [null], drift: {} } });
    answered.allBad.declared = (await backend.user.get(`/api/assurance/deployments/${DEP}/declared-architecture`)).body;
  } finally {
    await backend.close();
  }
}, 120_000);

/** The browser's fetch, answering each route with what the dashboard answered for it. */
function serve(answers: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url).split("?")[0];
    const body = answers[path];
    return new Response(JSON.stringify(body ?? { message: "not served here" }), {
      status: body === undefined ? 404 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
}

function mount(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** The "could not be read" lines a panel draws, as `list count text`. */
function unreadLines(): string[] {
  return Array.from(document.querySelectorAll("[data-testid='unreadable-lists'] [data-testid='unreadable-rows']"))
    .map((one) => `${one.getAttribute("data-list")} ${one.getAttribute("data-count")} ${one.textContent}`);
}

const said = (list: string) => `${list} ${FOUR} ${FOUR} rows could not be read: ${listLabel(list)}`;

/** Open the pack whose frameworks the applied read draws. */
async function openPack(route: string) {
  if (!route.endsWith("assurance-packs/health")) return;
  fireEvent.click(await screen.findByRole("button", { name: "Health" }));
}

/** The answers a panel reads: its own, and the clean ones it reads beside it. */
function answersFor(kind: "bad" | "clean" | "allBad", route: string): Record<string, unknown> {
  const out: Record<string, unknown> = { [route]: answered[kind][route] };
  if (route.endsWith("assurance-packs/health")) out[`/api/assurance/deployments/${DEP}/assurance-packs`] = answered.clean[`/api/assurance/deployments/${DEP}/assurance-packs`];
  // The posture panel draws a card for each domain, each reading its own.
  if (route.endsWith("/posture")) {
    for (const read of ["cloud-posture", "secrets-posture", "repo-posture"]) {
      out[`/api/assurance/deployments/${DEP}/${read}`] = answered.clean[`/api/assurance/deployments/${DEP}/${read}`];
    }
  }
  return out;
}

describe("a bad row of any assurance list is said on its panel", () => {
  it("every read whose rows are counted has a panel here, or is read by no screen", () => {
    expect(CASES.map((one) => panelOf(one.route)).filter((one) => !(one in PANELS) && !NO_PANEL.has(one))).toEqual([]);
  });

  it.each(CASES.filter((one) => !NO_PANEL.has(panelOf(one.route))).map((one) => [one.route, one] as const))(
    "%s: each list with rows that could not be read is said, by name",
    async (route, one) => {
      serve(answersFor("bad", route));
      mount(PANELS[panelOf(route)]());
      await openPack(route);
      await waitFor(() => expect(unreadLines()).toEqual(one.lists.map(said)));
      expect(document.body.textContent).not.toContain(LEAK);
    },
  );

  it.each(CASES.filter((one) => !NO_PANEL.has(panelOf(one.route))).map((one) => [one.route] as const))(
    "%s: a read whose rows were all read says nothing of the kind",
    async (route) => {
      serve(answersFor("clean", route));
      mount(PANELS[panelOf(route)]());
      await openPack(route);
      // Wait for the panel to draw what it read: its loading line gone.
      await waitFor(() => expect(document.body.textContent).not.toMatch(/Loading/));
      expect(document.body.textContent, "the panel drew its read").not.toMatch(/Could not load/);
      expect(document.querySelectorAll("[data-testid='unreadable-rows']")).toHaveLength(0);
    },
  );

  it("declared architecture: its declared rows and its drift's are each said", async () => {
    serve({ [`/api/assurance/deployments/${DEP}/declared-architecture`]: answered.bad.declared });
    mount(<DeclaredArchitecturePanel deploymentUuid={DEP} admin={false} />);
    await waitFor(() => expect(unreadLines()).toEqual(["declared", "undeclared", "missing"].map(said)));
  });

  // A list whose every row could not be read is not a list with none.
  const NONE: Array<[string, string, () => ReactElement]> = [
    [`/api/assurance/deployments/${DEP}/capabilities`, "No capabilities derived yet", PANELS.capabilities],
    [`/api/assurance/deployments/${DEP}/data-boundary`, "No third-party data destinations resolved", PANELS["data-boundary"]],
    [`/api/assurance/deployments/${DEP}/effective-access`, "No principals resolved", PANELS["effective-access"]],
    [`/api/assurance/deployments/${DEP}/personal-context`, "No data-bearing components discovered", PANELS["personal-context"]],
    [`/api/assurance/deployments/${DEP}/training-reuse`, "No providers resolved", PANELS["training-reuse"]],
    [`/api/assurance/deployments/${DEP}/metadata-logging`, "No logging sinks evidenced", PANELS["metadata-logging"]],
    [`/api/assurance/deployments/${DEP}/vendor-assurance`, "No vendors resolved", PANELS["vendor-assurance"]],
    [`/api/assurance/findings/${FINDING}/remediation`, "No workflow history recorded yet", PANELS.remediation],
    [`/api/assurance/deployments/${DEP}/declared-architecture`, "No architecture declared", () => <DeclaredArchitecturePanel deploymentUuid={DEP} admin={false} />],
  ];
  it.each(NONE)("%s: a list whose every row could not be read never says %s", async (route, none, panel) => {
    const body = route.endsWith("declared-architecture") ? answered.allBad.declared : answered.allBad[route];
    serve({ [route]: body });
    mount(panel());
    await waitFor(() => expect(unreadLines().length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toContain(none);
  });
});
