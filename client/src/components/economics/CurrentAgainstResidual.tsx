/**
 * Current against residual: the remediation option's economics as Athena-Backend's
 * ROI document serves them (mythos.economics.roi/v1, step 13, #160; and v2, #237).
 *
 * What each figure is (Athena-Backend #237): the kind the backend states for each
 * figure (its `measures`, in mythos_core.measures' words), "estimate" on an
 * estimated expense, the pairs it sets side by side with the reason they do not
 * add, and what each figure nets (`nets`). A tail's difference of two percentiles
 * is read from `difference_of_percentiles` (v2) or, from an older backend, from
 * `reduction` (v1), and labelled the same either way: it is a difference of
 * modelled percentiles, never a saving. A backend that serves no kinds is said so.
 *
 * The ONLY place a residual (counterfactual) run is shown: always beside the
 * current run it is paired with, never as the scenario's exposure. The hard
 * security veto, where it applies (or cannot be read, which counts as applying),
 * is stated ABOVE every figure, in the document's own words; the ROI and payback
 * are then display-only. A figure the document does not serve reads "not served"
 * and is never computed here: the reduction, the investment, the ROI and the
 * payback are the backend's, as served.
 *
 * Two fields #160's fix round adds -- the deployment-decision statement, and the
 * gross cash line beside the retained one -- are not served at its head
 * (f7c9f09), so they read "not served" until it serves them.
 */
import type { ReactNode } from "react";
import GlassCard from "@/components/GlassCard";
import Money from "@/components/economics/Money";
import { Banner, Mark, NotServed, Served } from "@/components/economics/sections";
import { LINE_LABEL, at, bannerOf, currencyOf, has, isRefused, list, obj, text, type Doc } from "@/lib/economics";

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-[minmax(9rem,16rem)_1fr] gap-3 border-b border-border/30 py-1.5 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words" data-testid={testId}>{children}</dd>
    </div>
  );
}

/** The core's eight kinds of figure (mythos_core.measures), and "unknown", in words. */
const KIND_LABEL: Record<string, string> = {
  confirmed_loss: "confirmed loss",
  remediation_expense: "expense",
  revenue_deferral: "revenue deferred",
  modeled_exposure: "modelled exposure",
  insurance_promised: "insurance promised",
  insurance_received: "insurance received",
  funds_frozen: "funds frozen",
  funds_returned: "funds returned",
  unknown: "kind not established",
};

/** What a tail's difference is, under whichever key the backend serves it. */
export const DIFFERENCE_LABEL = "difference of modelled percentiles, not a saving";

/** What the document says each figure nets (`nets`), by its key. */
const NETS_LABEL: Record<string, string> = {
  expected_reduction: "Expected reduction",
  tail_reduction: "Tail percentiles",
  first_year_investment: "First-year investment",
  risk_adjusted_roi: "Risk-adjusted ROI",
  payback: "Payback",
  period: "Period",
  basis: "Basis",
};

type Measures = Map<string, Doc> | null;

/**
 * Each figure's measure, by where it sits ("<line>.<key>", as the document names
 * it), or null from a backend that serves no `measures` at all.
 */
function measuresOf(roi: Doc): Measures {
  if (!has(roi, "measures")) return null;
  const found = new Map<string, Doc>();
  for (const one of list(roi.measures)) {
    const entry = obj(one);
    const section = text(entry?.section);
    const label = text(entry?.label);
    if (entry !== null && section !== null && label !== null) found.set(`${section}.${label}`, entry);
  }
  return found;
}

/** A figure's kind, as the document states it; "estimate" on an estimated expense. */
function Kind({ measures, where }: { measures: Measures; where: string }) {
  if (measures === null) return null;
  const entry = measures.get(where);
  if (entry === undefined) {
    return <span className="ml-1 text-xs text-muted-foreground" data-kind="not-served">(kind not served)</span>;
  }
  const kind = text(entry.kind);
  const why = entry.measure === null ? text(entry.why) : null;
  return (
    <span className="ml-1 text-xs text-muted-foreground" data-kind={kind ?? "unreadable"}>
      ({kind === null ? "kind unreadable" : KIND_LABEL[kind] ?? kind})
      {entry.estimate === true ? <Mark kind="estimate" /> : null}
      {why !== null ? <span className="block" data-not-a-measure="">not held as a measure: {why}</span> : null}
    </span>
  );
}

/** A figure's place in the document ("headline.expected_reduction"), in words. */
function placeOf(where: unknown): string {
  const path = text(where);
  if (path === null) return "a figure the document does not name";
  return path.replace(/^gross_cash\./, "gross cash: ").replace(/^headline\./, "headline: ").split("_").join(" ");
}

/** The pairs the document sets beside each other, each with the reason they do not add: never a sum. */
function SideBySide({ roi }: { roi: Doc }) {
  if (!has(roi, "side_by_side")) return null;
  const pairs = list(roi.side_by_side).map(obj);
  return (
    <div className="mt-3 rounded-lg border border-border/40 p-3 text-sm" data-testid="roi-side-by-side">
      <h3 className="font-semibold">Set side by side, never added</h3>
      {pairs.length === 0 ? <p className="text-muted-foreground">The document sets no figures side by side.</p> : (
        <ul className="mt-1 list-disc pl-5">
          {pairs.map((pair, index) => {
            if (pair === null) return <li key={index} data-side-by-side="unreadable">a pair the document serves that cannot be read</li>;
            const kinds = list(pair.kinds).map((one) => text(one));
            const reason = text(pair.do_not_add);
            return (
              <li key={index} data-side-by-side="">
                {placeOf(pair.left)} ({KIND_LABEL[kinds[0] ?? ""] ?? kinds[0] ?? "kind not served"}) beside{" "}
                {placeOf(pair.right)} ({KIND_LABEL[kinds[1] ?? ""] ?? kinds[1] ?? "kind not served"}):{" "}
                <span data-do-not-add="">{reason !== null ? `they do not add (${reason})` : "no reason they do not add is served; nothing here adds them"}</span>
                {text(pair.statement) ? <span className="block text-xs text-muted-foreground">{text(pair.statement)}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** What the document says each figure nets, or that this backend does not say. */
function Nets({ roi }: { roi: Doc }) {
  const nets = obj(roi.nets);
  return (
    <div className="mt-3 rounded-lg border border-border/40 p-3 text-sm" data-testid="roi-nets">
      <h3 className="font-semibold">What each figure nets</h3>
      {!has(roi, "nets") ? <NotServed why="this backend version does not say what each figure nets" /> : nets === null ? (
        <NotServed why="the document's statement of what each figure nets cannot be read" />
      ) : (
        <dl>
          {Object.entries(nets).map(([key, value]) => (
            <Row key={key} label={NETS_LABEL[key] ?? key}><Served value={value} /></Row>
          ))}
        </dl>
      )}
    </div>
  );
}

/** The veto, stated above the figures wherever it applies or cannot be read. */
function Veto({ roi }: { roi: Doc }) {
  const veto = obj(roi.veto);
  if (veto === null) {
    return (
      <div className="mb-4 rounded-lg border border-sev-high/50 bg-sev-high/10 px-3 py-2 text-sm" data-veto="unserved">
        The hard security veto is not served: whether remediation is required regardless of ROI cannot be read here.
      </div>
    );
  }
  if (veto.applies === false) {
    return (
      <p className="mb-4 text-xs text-muted-foreground" data-veto="does-not-apply">
        Hard security veto: does not apply. {text(veto.reason) ?? ""}
      </p>
    );
  }
  return (
    <div role="alert" className="mb-4 rounded-lg border border-sev-high/60 bg-sev-high/15 px-3 py-2 text-sm" data-veto="applies">
      <p className="font-semibold text-sev-high" data-veto-statement="">{text(veto.statement) ?? "(the veto applies; no statement was served)"}</p>
      <p className="mt-1 text-xs">
        {veto.applies === "unknown" ? "The blocker status cannot be read, so the veto is treated as applying. " : ""}
        {text(veto.reason) ?? ""}
      </p>
      {list(veto.blockers).length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {list(veto.blockers).map((one, index) => <li key={index}>{text(at(one, "reason")) ?? ""}</li>)}
        </ul>
      )}
      <p className="mt-1 text-xs text-muted-foreground">The ROI and payback below are display-only.</p>
    </div>
  );
}

function Side({ label, side }: { label: string; side: unknown }) {
  const part = obj(side);
  if (part === null || "not_reported" in part) {
    return <Row label={label}><NotServed why={text(part?.not_reported) ?? undefined} /></Row>;
  }
  const refusal = obj(part.refusal);
  return (
    <Row label={label} testId={`roi-side-${label.toLowerCase().split(" ")[0]}`}>
      <span className="font-mono text-xs">{text(part.simulation)}</span>{" "}
      <span className="text-xs text-muted-foreground">
        {text(part.status)}{refusal ? ` (${text(refusal.code) ?? "refused"})` : ""}, grade {text(part.grade) ?? "not graded"}
        {part.excluded_from_totals === true ? `, excluded from totals: ${text(part.banner_reason) ?? ""}` : ""}
      </span>
    </Row>
  );
}

/** One line's economics, as served: the exposures, the reduction, the ROI, the payback, the tail. */
function EconomicsRows({ figures, code, minorUnit, line, measures }: { figures: Doc; code: string; minorUnit: number | null; line: string; measures: Measures }) {
  const money = (value: unknown) => <Money value={value} currency={code} minorUnit={minorUnit} />;
  const section = line === "headline" ? "headline" : "gross_cash";
  const kind = (key: string) => <Kind measures={measures} where={`${section}.${key}`} />;
  const ratio = (part: unknown, unit?: string) => {
    const entry = obj(part);
    if (entry === null) return <NotServed />;
    return (
      <span>
        {typeof entry.value === "string" ? <span className="font-mono">{entry.value}{unit ? ` ${unit}` : ""}</span> : <NotServed why={text(entry.not_meaningful) ?? undefined} />}
        {entry.display_only === true ? <span className="ml-2 rounded border border-sev-high/40 px-1 text-[10px] uppercase text-sev-high" data-display-only="">display only</span> : null}
        <span className="block text-xs text-muted-foreground">{text(entry.statement) ?? ""}</span>
      </span>
    );
  };
  const tail = (key: string) => {
    const part = obj(at(figures, "tail_reduction", key));
    if (part === null) return <NotServed />;
    // #237 serves it as difference_of_percentiles; an older backend as reduction. The same figure either way.
    const difference = has(part, "difference_of_percentiles") ? part.difference_of_percentiles : part.reduction;
    return (
      <span>
        current {money(part.current)}{kind(`tail_reduction.${key}.current`)}, residual {money(part.residual)}
        {kind(`tail_reduction.${key}.residual`)}, <span data-tail-difference="">{DIFFERENCE_LABEL}</span>{" "}
        {difference === null ? <NotServed why={text(part.not_reported) ?? undefined} /> : money(difference)}
        {kind(`tail_reduction.${key}.difference_of_percentiles`)}
      </span>
    );
  };
  const id = (name: string) => (line === "headline" ? `roi-${name}` : `roi-${line}-${name}`);
  return (
    <>
      <Row label="Current expected annual exposure">{money(figures.current_expected_annual_exposure)}{kind("current_expected_annual_exposure")}</Row>
      <Row label="Residual expected annual exposure">{money(figures.residual_expected_annual_exposure)}{kind("residual_expected_annual_exposure")}</Row>
      <Row label="Expected reduction" testId={id("reduction")}>{money(figures.expected_reduction)}{kind("expected_reduction")}</Row>
      <Row label="Risk-adjusted ROI" testId={id("ratio")}>{ratio(figures.risk_adjusted_roi)}</Row>
      <Row label="Payback" testId={id("payback")}>{ratio(figures.payback, text(at(figures, "payback", "unit")) ?? undefined)}</Row>
      <Row label="Tail, P90" testId={id("tail-p90")}>{tail("p90")}</Row>
      <Row label="Tail, P95" testId={id("tail-p95")}>{tail("p95")}</Row>
      <Row label="Tail basis"><Served value={at(figures, "tail_reduction", "basis")} /></Row>
    </>
  );
}

/** The headline line's economics, or why there are none. */
function Figures({ roi }: { roi: Doc }) {
  const { code, minorUnit } = currencyOf(roi);
  const figures = obj(roi.figures);
  if (isRefused({ status: roi.status, refusal: null }) || figures === null || "not_reported" in figures) {
    return <p data-testid="roi-figures"><NotServed why={text(figures?.not_reported) ?? `the document's status is ${text(roi.status) ?? "not served"}`} /></p>;
  }
  const investment = obj(figures.first_year_investment) ?? {};
  const money = (value: unknown) => <Money value={value} currency={code} minorUnit={minorUnit} />;
  const measures = measuresOf(roi);
  return (
    <dl data-testid="roi-figures">
      <Row label="First-year investment" testId="roi-investment">
        base {money(investment.base)} <span className="text-muted-foreground">within low</span> {money(investment.low)}{" "}
        <span className="text-muted-foreground">to high</span> {money(investment.high)}
        <Kind measures={measures} where="headline.first_year_investment.base" />
      </Row>
      <EconomicsRows figures={figures} code={code} minorUnit={minorUnit} line="headline" measures={measures} />
      {measures === null ? (
        <p className="pt-1 text-xs text-muted-foreground" data-testid="roi-kinds-not-served">
          The kind of each figure is not served by this backend version.
        </p>
      ) : null}
    </dl>
  );
}

/**
 * The gross-cash line beside a retained headline (#160's owner interim, decision 6),
 * as the document serves it: "not served" only where the document has no such field.
 */
function GrossBeside({ roi }: { roi: Doc }) {
  const { code, minorUnit } = currencyOf(roi);
  const figures = obj(roi.figures);
  let body: ReactNode;
  if (figures === null || "not_reported" in figures) {
    body = <NotServed why={text(figures?.not_reported) ?? "no figures are served"} />;
  } else if (!has(roi, "figures", "gross_cash")) {
    body = <NotServed why="the ROI document carries no gross-cash line beside the headline" />;
  } else {
    const gross = obj(figures.gross_cash);
    body = (
      <>
        {gross === null ? (
          <p data-served-field="figures.gross_cash">The headline line is gross cash itself: there is no second line.</p>
        ) : (
          <dl><EconomicsRows figures={gross} code={code} minorUnit={minorUnit} line="gross" measures={measuresOf(roi)} /></dl>
        )}
        {text(figures.gross_cash_statement) ? <p className="text-xs text-muted-foreground">{text(figures.gross_cash_statement)}</p> : null}
      </>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-border/40 p-3 text-sm" data-testid="roi-gross-beside-retained">
      <h3 className="font-semibold">Gross cash, beside the headline</h3>
      {body}
    </div>
  );
}

/** The deployment's standing decision, stated beside the economics (#160, decision 9): never a veto. */
function DeploymentDecision({ roi }: { roi: Doc }) {
  if (!has(roi, "deployment_decision")) {
    return <NotServed why="the ROI document carries no deployment-decision statement" />;
  }
  const decision = obj(roi.deployment_decision);
  if (decision === null || text(decision.statement) === null) {
    return <span className="text-muted-foreground" data-not-read="">served, but not read by this dashboard version yet</span>;
  }
  return (
    <span data-served-field="deployment_decision">
      {text(decision.statement)}
      <span className="block text-xs text-muted-foreground">
        {text(decision.veto) ?? ""} {text(decision.source) ? `(${text(decision.source)})` : ""}
      </span>
    </span>
  );
}

export default function CurrentAgainstResidual(
  { roi, roiError, reportRefused, report = null }: { roi: Doc | null; roiError: string | null; reportRefused: boolean; report?: Doc | null },
) {
  const section = (body: ReactNode) => (
    <section data-figure-section="current-against-residual" aria-label="Current against residual">
      <GlassCard hover={false} glow={false}>{body}</GlassCard>
    </section>
  );
  if (reportRefused) {
    // Beside a refused report the ROI view shows nothing but the refusal: no amount,
    // no ratio, no days, no run.
    const code = text(at(report, "refusal", "code"));
    return (
      <section data-section="current-against-residual" aria-label="Current against residual">
        <GlassCard hover={false} glow={false}>
          <h2 className="text-lg font-semibold tracking-tight">Current against residual</h2>
          <p className="mt-2 text-sm" data-testid="roi-refused-only">
            The scenario&apos;s report is refused{code ? ` (${code})` : ""}: beside a refusal this view shows nothing else.
          </p>
        </GlassCard>
      </section>
    );
  }
  if (roi === null) {
    // Nothing served: no figure here, so no figure section.
    return (
      <section data-section="current-against-residual" aria-label="Current against residual">
        <GlassCard hover={false} glow={false}>
          <h2 className="text-lg font-semibold tracking-tight">Current against residual</h2>
          <p className="mt-2 text-sm text-muted-foreground" data-testid="roi-not-served">
            {roiError ?? "Reading the remediation option's economics..."}
          </p>
        </GlassCard>
      </section>
    );
  }
  // The ROI document's own banner; where it carries none but the scenario's report
  // does, the report's: every figure on the page sits under the banner it is owed.
  const bannerDoc = bannerOf(roi) !== null ? roi : report !== null && bannerOf(report) !== null ? report : roi;
  const option = obj(roi.option) ?? {};
  const effect = obj(option.control_effect) ?? {};
  const reduction = (key: string) => {
    const entry = obj(effect[key]);
    if (entry === null) return <span className="text-muted-foreground">none</span>;
    return (
      <span>
        {text(entry.low)} / {text(entry.base)} / {text(entry.high)} <span className="text-xs text-muted-foreground">(low / base / high, as recorded; {text(entry.source_type)}: {text(entry.evidence_ref)})</span>
      </span>
    );
  };
  // With no economics computed, no amount is shown here, not even the option's
  // recorded costs. (Beside a refused report this view shows only the refusal, above.)
  const withheld = roi.status !== "completed" ? `no economics were computed (${text(roi.status) ?? "status not served"})` : null;
  const cost = (key: string) => {
    const entry = obj(option[key]);
    if (entry === null) return <NotServed />;
    if (withheld !== null) return <span className="text-muted-foreground">not shown: {withheld}</span>;
    const currency = text(entry.currency) ?? "";
    return (
      <span>
        base <Money value={entry.base} currency={currency} /> <span className="text-muted-foreground">within</span>{" "}
        <Money value={entry.low} currency={currency} /> <span className="text-muted-foreground">to</span>{" "}
        <Money value={entry.high} currency={currency} /> <span className="text-xs text-muted-foreground">(as recorded; {text(entry.source_type)})</span>
      </span>
    );
  };
  const delta = obj(roi.confidence_delta) ?? {};
  const utility = obj(roi.utility_retained) ?? {};
  const failed = list(at(roi, "integrity", "failed")).filter((one): one is string => typeof one === "string");
  return section(
    <>
      {/* Above every figure: the veto, then the banner. */}
      <Veto roi={roi} />
      <Banner doc={bannerDoc} />
      <h2 className="text-lg font-semibold tracking-tight">Current against residual</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        The residual run is the counterfactual of the option below: it is never the scenario&apos;s exposure, and is shown
        only here, against the current run it is paired with.
      </p>
      <dl className="mt-3 text-sm">
        <Row label="Option"><Served value={option.title} /> <span className="text-xs text-muted-foreground">({String(option.time_to_implement_days ?? "?")} days to implement)</span></Row>
        <Row label="Implementation cost">{cost("implementation_cost")}</Row>
        <Row label="Recurring cost (a year)">{cost("recurring_cost")}</Row>
        <Row label="Frequency reduction">{reduction("frequency_reduction")}</Row>
        <Row label="Magnitude reduction">{reduction("magnitude_reduction")}</Row>
        <Side label="Current run" side={roi.current} />
        <Side label="Residual run" side={roi.residual} />
        <Row label="Line" testId="roi-line">{LINE_LABEL[text(roi.line) ?? ""] ?? <NotServed why={text(at(roi, "figures", "not_reported")) ?? undefined} />}</Row>
        <Row label="Deployment decision" testId="roi-deployment-decision"><DeploymentDecision roi={roi} /></Row>
      </dl>
      <div className="mt-3 text-sm">
        <Figures roi={roi} />
      </div>
      <GrossBeside roi={roi} />
      <SideBySide roi={roi} />
      <Nets roi={roi} />
      <dl className="mt-3 text-sm">
        <Row label="Utility retained"><Served value={utility.status} /> <span className="text-xs text-muted-foreground">{text(utility.reason) ?? ""}</span></Row>
        <Row label="Confidence">
          {text(delta.current) ?? "not graded"} to {text(delta.residual) ?? "not graded"}: {text(delta.change) ?? "?"}
          {text(delta.not_comparable) ? <span className="block text-xs text-muted-foreground">{text(delta.not_comparable)}</span> : null}
        </Row>
        <Row label="Excluded from every total" testId="roi-excluded-from-totals">
          {roi.excluded_from_totals === false ? "no" : roi.excluded_from_totals === true ? "yes" : "not served (read as yes)"}
          {text(roi.banner_reason) ? <span className="block text-xs text-muted-foreground">{text(roi.banner_reason)}</span> : null}
        </Row>
        <Row label="Integrity">
          {at(roi, "integrity", "verified") === true ? "verified" : <span className="text-sev-high">not verified{failed.length ? `: failed ${failed.join(", ")}` : ""}</span>}
        </Row>
        <Row label="Digest"><span className="font-mono text-xs">{text(roi.digest) ?? "not served"}</span></Row>
      </dl>
    </>,
  );
}
