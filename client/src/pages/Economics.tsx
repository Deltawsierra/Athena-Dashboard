/**
 * Economic Exposure: one scenario version's financial views, read from
 * Athena-Backend's economics routes and nothing else (server/economics.ts).
 *
 *   1. Scenario card          5. Current against residual (the ROI document, #160)
 *   2. Distribution           6. Currency bridge (the v2 report's, #163)
 *   3. Cost waterfall         7. Validity Card
 *   4. Sensitivity tornado    8. Receipt: the report's bytes, and the receipt's
 *                                signed bytes, checked against the digests (#163)
 *
 * The version is picked from the deployment's scenario list (#163), a page at a
 * time (components/economics/ScenarioPicker.tsx): no uuid is typed.
 *
 * The browser does no arithmetic on money: every amount is the backend's decimal
 * string, shown as served (lib/economics.ts). One scenario is read at a time and
 * nothing is totalled. A result not for capital decisions carries the report's
 * banner above every figure; a refused one shows its refusal and kept inputs and
 * no figure; a residual (counterfactual) run is shown only against the current
 * run, never as exposure. Nothing here stops, pauses or starts anything, and the
 * stop controls elsewhere are untouched.
 */
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { Landmark } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import GlassCard from "@/components/GlassCard";
import CurrentAgainstResidual from "@/components/economics/CurrentAgainstResidual";
import CurrencyBridge from "@/components/economics/CurrencyBridge";
import ScenarioPicker from "@/components/economics/ScenarioPicker";
import {
  CostWaterfall,
  Distribution,
  ReceiptPanel,
  RefusalPanel,
  ScenarioCard,
  Tornado,
  ValidityCardView,
} from "@/components/economics/sections";
import { at, isConfirmedNotServed, isRefused, isResidualRun, obj, residualMarker, text, type Doc } from "@/lib/economics";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface EconomicsTarget {
  deployment: string;
  scenario: string;
  /** A stored result's uuid; the scenario's latest when absent. */
  simulation?: string;
}

/** The report's own URL on this server: what the page reads. */
export function reportUrl(target: EconomicsTarget): string {
  const query = new URLSearchParams({ deployment: target.deployment, scenario: target.scenario });
  if (target.simulation) query.set("simulation", target.simulation);
  return `/api/economics/report?${query.toString()}`;
}

/**
 * The download of the result ON SCREEN: pinned to the uuid of the result the report
 * shown is of (never "the latest", which can have moved on), or null where the
 * report names none.
 */
export function downloadUrl(target: EconomicsTarget, report: unknown): string | null {
  const shown = text(at(report, "simulation", "uuid"));
  if (shown === null || !UUID.test(shown)) return null;
  return `${reportUrl({ ...target, simulation: shown })}&download=1`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "the read failed";
}


function ResidualRefused({ roi, roiError }: { roi: Doc | null; roiError: string | null }) {
  return (
    <div className="space-y-6">
      <GlassCard hover={false} glow={false}>
        <p className="text-sm" data-testid="residual-refused">
          This result is the residual (counterfactual) run of the scenario&apos;s remediation option. It is not exposure,
          and is shown only against the current run, below.
        </p>
      </GlassCard>
      <CurrentAgainstResidual roi={roi} roiError={roiError} reportRefused={false} />
    </div>
  );
}

/** No figure of a result whose run could not be shown to be the scenario's own: only why. */
function Unchecked({ why }: { why: string }) {
  return (
    <GlassCard hover={false} glow={false}>
      <p className="text-sm" data-testid="residual-unchecked">
        Whether this result is a residual (counterfactual) run could not be checked: {why}. A residual run is never
        exposure, so no figure of this result is shown.
      </p>
    </GlassCard>
  );
}

/** The eight views of one scenario version. */
export function EconomicsView({ deployment, scenario, simulation }: EconomicsTarget) {
  const report = useQuery<Doc>({ queryKey: ["/api/economics/report", { deployment, scenario, simulation }] });
  const events = useQuery<Doc>({ queryKey: ["/api/economics/events", { deployment, scenario }] });
  const roi = useQuery<Doc>({ queryKey: ["/api/economics/roi", { deployment, scenario }] });

  if (report.isError) {
    return (
      <GlassCard hover={false} glow={false}>
        <p className="text-sm" data-testid="report-error">The report could not be read: {errorText(report.error)}</p>
      </GlassCard>
    );
  }
  if (report.data === undefined) {
    return <p className="text-sm text-muted-foreground" data-testid="economics-loading">Reading the report...</p>;
  }
  const doc = obj(report.data) ?? {};
  const roiDoc = roi.isSuccess ? obj(roi.data) : null;
  // The backend's own "not served" (its sentence says so), or a failure, said as one.
  const roiError = !roi.isError ? null
    : isConfirmedNotServed(roi.error) ? errorText(roi.error) : `the ROI read failed: ${errorText(roi.error)}`;
  const refused = isRefused(doc);

  // Is this result a residual (counterfactual) run? A residual run is never
  // exposure, and the guard FAILS CLOSED. The report must say it is the scenario's
  // own run (`residual_of: null`); a report that does not say, or says it unreadably,
  // shows no figure. And the ROI read must have settled, served or answered "not
  // served" by the backend itself: on any other failure of it (a 5xx, a refusal, a
  // timeout, a dropped connection) no figure is shown either -- only why. A served
  // ROI document that names this result as its residual run wins over the marker.
  const marker = residualMarker(doc);
  if (marker === "residual") return <ResidualRefused roi={roiDoc} roiError={roiError} />;
  if (marker !== "own") {
    return (
      <Unchecked why={marker === "absent"
        ? "the report does not say (it carries no residual_of)"
        : "the report's residual_of cannot be read"} />
    );
  }
  if (!roi.isSuccess && !roi.isError) {
    return <p className="text-sm text-muted-foreground" data-testid="economics-loading">Reading the report...</p>;
  }
  if (roi.isError && !isConfirmedNotServed(roi.error)) return <Unchecked why={roiError ?? "the ROI read failed"} />;
  if (roiDoc !== null && isResidualRun(doc, roiDoc)) return <ResidualRefused roi={roiDoc} roiError={null} />;

  const target = { deployment, scenario, simulation };
  return (
    <div className="space-y-6" data-testid="economics-views">
      <ScenarioCard report={doc} events={events.data ?? null} eventsError={events.isError ? errorText(events.error) : null} />
      {refused ? (
        <RefusalPanel report={doc} />
      ) : (
        <>
          <Distribution report={doc} />
          <CostWaterfall report={doc} />
          <Tornado report={doc} />
        </>
      )}
      <CurrentAgainstResidual roi={roiDoc} roiError={roiError} reportRefused={refused} report={doc} />
      <CurrencyBridge report={doc} />
      <ValidityCardView report={doc} refused={refused} />
      <ReceiptPanel report={doc} href={downloadUrl(target, doc)} deployment={deployment} />
    </div>
  );
}

export default function Economics() {
  const search = new URLSearchParams(useSearch());
  const deployment = search.get("deployment") ?? "";
  const scenario = search.get("scenario") ?? "";
  const simulation = search.get("simulation") ?? undefined;
  const chosen = UUID.test(deployment) && UUID.test(scenario) && (simulation === undefined || UUID.test(simulation));
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Economic Exposure"
        icon={<Landmark className="h-8 w-8" />}
        description="One scenario version's financial exposure, exactly as Athena-Backend's economics routes serve it: estimates with their ranges, not a prediction or advice."
      />
      <ScenarioPicker deployment={deployment} scenario={UUID.test(scenario) ? scenario : null} />
      {chosen ? <EconomicsView deployment={deployment} scenario={scenario} simulation={simulation} /> : null}
    </div>
  );
}
