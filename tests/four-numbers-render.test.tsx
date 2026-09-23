// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";

import {
  OperationalAssurancePanel,
  RippleEffectPanel,
  DataLifecyclePanel,
} from "@/pages/Assurance";

/**
 * The operator-facing half of "four values nobody measured".
 *
 * Making the BFF answer `null` accomplishes nothing on its own: the page still
 * has to say something different when it gets one. Before this, `null` and a
 * measured `0` rendered the same eleven characters. So these tests mount the
 * three panels and read the words, and each is paired with a negative control
 * asserting that a REAL zero still renders as a number -- otherwise "never
 * print a 0" is satisfied by a panel that prints nothing, which is the same
 * defect wearing the opposite sign.
 *
 * The query cache is seeded directly rather than fetched: these are assertions
 * about rendering, and the BFF's half is pinned in
 * tests/four-numbers-nobody-measured.test.ts.
 */

function mount(queryKey: string, data: unknown, node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        // Nothing should reach the network; if a panel ever asks, the test
        // should say so rather than quietly render a loading state forever.
        queryFn: async () => {
          throw new Error(`unexpected fetch for ${queryKey}`);
        },
      },
    },
  });
  client.setQueryData([queryKey], data);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const OPERATIONAL = (ttlDays: number | null) => ({
  system: { name: "checkout", uuid: "dep", environment: "prod", environmentLabel: "Production" },
  decision: { decision: "ready", decisionLabel: "Ready" },
  evidenceFreshness: { total: 4, current: 3, stale: 1, ttlDays, freshnessRatio: 0.75 },
  changeBacklog: {
    total: 0, new: 0, recurring: 0, cleared: 0, byStatus: {},
    needsReassessment: 0, needsReassessmentRatio: null,
  },
  remediation: {
    open: 0, resolved: 0, wontFix: 0, byState: {}, statesReached: [],
    eventCount: 0, resolutionRatio: null,
  },
  readiness: "ready",
  summary: {
    totalFindings: 4, currentEvidence: 3, staleEvidence: 1, freshnessRatio: 0.75,
    needsReassessment: 0, needsReassessmentRatio: null, openRemediation: 0,
    resolvedRemediation: 0, decision: "ready", readiness: "ready",
  },
});

const RIPPLE = (bounded: boolean | null) => ({
  origins: [],
  consequences: [],
  summary: {
    origins: 2, originsWithReach: 1, consequences: 3, evidencedConsequences: 5,
    bounded, byCategory: {}, worstRisk: "elevated",
  },
});

const LIFECYCLE = (
  gap: boolean | null,
  summary: { stagesTotal: number | null; evidenced: number | null },
) => ({
  stages: [
    {
      stage: "collection", stageLabel: "Collection", controlStage: true, evidenced: true,
      components: [], weakestEvidence: "configuration_verified",
      weakestEvidenceLabel: "Configuration-verified", gap,
      gapDetail: gap === true ? "no retention control evidenced" : null,
      risk: "elevated",
    },
  ],
  gaps: [],
  summary: {
    ...summary, notEvidenced: 2, controlGaps: 1, worstRisk: "elevated",
  },
});

const opKey = "/api/assurance/deployments/dep-1/operational-assurance";
const rippleKey = "/api/assurance/deployments/dep-1/ripple-effect";
const lifecycleKey = "/api/assurance/deployments/dep-1/data-lifecycle";

afterEach(cleanup);

describe("a value nobody measured does not become a sentence", () => {
  it("names the TTL when the control plane reported one", () => {
    mount(opKey, OPERATIONAL(90), <OperationalAssurancePanel deploymentUuid="dep-1" />);
    expect(screen.getByText(/within its 90-day TTL/)).toBeTruthy();
  });

  it("does not write '0-day TTL' when no TTL was reported", () => {
    mount(opKey, OPERATIONAL(null), <OperationalAssurancePanel deploymentUuid="dep-1" />);
    expect(screen.queryByText(/0-day TTL/)).toBeNull();
    expect(screen.getByText(/within its TTL \(length not reported\)/)).toBeTruthy();
  });

  it("still writes a measured 0-day TTL, because that is an answer", () => {
    // The negative control. "Never print 0-day TTL" would be satisfied by a
    // panel that never prints a TTL at all; this is what stops that.
    mount(opKey, OPERATIONAL(0), <OperationalAssurancePanel deploymentUuid="dep-1" />);
    expect(screen.getByText(/within its 0-day TTL/)).toBeTruthy();
    expect(screen.queryByText(/length not reported/)).toBeNull();
  });

  it("annotates a bounded consequence list when the backend said it is bounded", () => {
    mount(rippleKey, RIPPLE(true), <RippleEffectPanel deploymentUuid="dep-1" />);
    expect(screen.getByText(/5 evidenced \(bounded\)/)).toBeTruthy();
    expect(screen.queryByText(/bounding not reported/)).toBeNull();
  });

  it("says bounding was not reported rather than rendering an unbounded list", () => {
    mount(rippleKey, RIPPLE(null), <RippleEffectPanel deploymentUuid="dep-1" />);
    expect(screen.getByText(/bounding not reported/)).toBeTruthy();
    expect(screen.queryByText(/\(bounded\)/)).toBeNull();
  });

  it("says nothing extra when the backend reported the list is not bounded", () => {
    // The negative control for the pair above: `false` is a fact about the
    // list -- it is complete -- and must not be dressed up as a gap.
    mount(rippleKey, RIPPLE(false), <RippleEffectPanel deploymentUuid="dep-1" />);
    expect(screen.queryByText(/bounding not reported/)).toBeNull();
    expect(screen.queryByText(/\(bounded\)/)).toBeNull();
  });

  it("counts evidenced stages when the backend sent a summary", () => {
    mount(
      lifecycleKey,
      LIFECYCLE(true, { stagesTotal: 6, evidenced: 4 }),
      <DataLifecyclePanel deploymentUuid="dep-1" />,
    );
    expect(screen.getByText("4/6 stages evidenced")).toBeTruthy();
  });

  it("does not write '0/0 stages evidenced' when no summary was sent", () => {
    mount(
      lifecycleKey,
      LIFECYCLE(true, { stagesTotal: null, evidenced: null }),
      <DataLifecyclePanel deploymentUuid="dep-1" />,
    );
    expect(screen.queryByText("0/0 stages evidenced")).toBeNull();
    expect(screen.getByText("stage coverage not reported")).toBeTruthy();
  });

  it("still writes a measured 0 of 0 stages, because that is an answer", () => {
    mount(
      lifecycleKey,
      LIFECYCLE(true, { stagesTotal: 0, evidenced: 0 }),
      <DataLifecyclePanel deploymentUuid="dep-1" />,
    );
    expect(screen.getByText("0/0 stages evidenced")).toBeTruthy();
    expect(screen.queryByText("stage coverage not reported")).toBeNull();
  });

  it("shows a reported stage gap with its detail", () => {
    mount(
      lifecycleKey,
      LIFECYCLE(true, { stagesTotal: 6, evidenced: 4 }),
      <DataLifecyclePanel deploymentUuid="dep-1" />,
    );
    expect(screen.getByText("no retention control evidenced")).toBeTruthy();
    expect(screen.queryByText("gap not reported")).toBeNull();
  });

  it("marks an unreported stage gap as unknown rather than rendering it clean", () => {
    mount(
      lifecycleKey,
      LIFECYCLE(null, { stagesTotal: 6, evidenced: 4 }),
      <DataLifecyclePanel deploymentUuid="dep-1" />,
    );
    expect(screen.getByText("gap not reported")).toBeTruthy();
  });

  it("renders a stage the backend said has no gap as clean, with no caveat", () => {
    // The last negative control: `false` means somebody looked and found
    // nothing. A "gap not reported" badge here would be a manufactured
    // finding -- the same defect pointed the other way.
    mount(
      lifecycleKey,
      LIFECYCLE(false, { stagesTotal: 6, evidenced: 4 }),
      <DataLifecyclePanel deploymentUuid="dep-1" />,
    );
    expect(screen.queryByText("gap not reported")).toBeNull();
    expect(screen.getByText("Collection")).toBeTruthy();
  });
});
