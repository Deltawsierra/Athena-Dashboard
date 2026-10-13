/**
 * The economics views of one scenario version's report (mythos.economics.report/v1),
 * each rendering what the report serves and nothing else (lib/economics.ts has the
 * rules). Every amount goes through <Money>; every figure section opens with the
 * report's banner where it carries one; a refused report renders none of these
 * figure sections at all (<RefusalPanel> instead).
 */
import type { ReactNode } from "react";
import GlassCard from "@/components/GlassCard";
import Money from "@/components/economics/Money";
import {
  CASH_LINES,
  LINE_LABEL,
  MARKET_VALUE_LINE,
  at,
  bannerOf,
  currencyOf,
  has,
  isMoneyUnit,
  list,
  obj,
  text,
  type Doc,
} from "@/lib/economics";

// ------------------------------------------------------------------ small parts

/** A value the document does not serve: said so, never filled in. */
export function NotServed({ why }: { why?: string }) {
  return (
    <span className="text-muted-foreground" data-not-served="">
      not served{why ? `: ${why}` : ""}
    </span>
  );
}

/** A plain served value (a date, a code, a ratio as recorded), or "not served". */
export function Served({ value, why }: { value: unknown; why?: string }) {
  if (typeof value === "string" && value !== "") return <span>{value}</span>;
  if (typeof value === "number" || typeof value === "boolean") return <span>{String(value)}</span>;
  return <NotServed why={why} />;
}

/** A mark on stale or downgraded data. */
export function Mark({ kind, children }: { kind: "stale" | "downgraded" | "estimate" | "unavailable"; children?: ReactNode }) {
  const label = { stale: "Stale", downgraded: "Downgraded", estimate: "Estimate", unavailable: "Unavailable" }[kind];
  return (
    <span
      className="ml-1 inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400"
      data-mark={kind}
    >
      {label}
      {children ? <span className="normal-case font-normal tracking-normal">{children}</span> : null}
    </span>
  );
}

/** The report's banner, exactly as served, with its reason; or the fail-closed line. */
export function Banner({ doc }: { doc: unknown }) {
  const banner = bannerOf(doc);
  if (banner === null) return null;
  return (
    <div
      role="alert"
      className="mb-4 rounded-lg border border-sev-high/40 bg-sev-high/10 px-3 py-2 text-sm"
      data-economics-banner=""
      data-served={banner.served ? "true" : "false"}
    >
      <p className="font-semibold text-sev-high" data-banner-text="">{banner.text}</p>
      {banner.reason ? <p className="mt-1 text-xs text-muted-foreground" data-banner-reason="">{banner.reason}</p> : null}
    </div>
  );
}

/**
 * A section that shows figures: the document's banner first, above every figure in
 * it, then its body.
 */
export function FigureSection(
  { title, id, doc, children, note }: { title: string; id: string; doc: unknown; children: ReactNode; note?: ReactNode },
) {
  return (
    <section data-figure-section={id} aria-label={title}>
      <GlassCard hover={false} glow={false}>
        <Banner doc={doc} />
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
        <div className="mt-4 space-y-4 text-sm">{children}</div>
      </GlassCard>
    </section>
  );
}

/** A section with no figures in it. */
export function PlainSection({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section data-section={id} aria-label={title}>
      <GlassCard hover={false} glow={false}>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <div className="mt-4 space-y-3 text-sm">{children}</div>
      </GlassCard>
    </section>
  );
}

/** Where a report would state its valuation date, were it to (it states none today). */
const VALUATION_DATE: string[][] = [["valuation_date"], ["build", "valuation_date"], ["currency", "valuation_date"]];

/**
 * A field the dashboard looks for: "not served" only where the document does not
 * have it -- decided by the document, never by a fixed sentence -- and its value
 * where it does. A value that is not plain text is served, but not read by this
 * dashboard version yet.
 */
export function Presence(
  { doc, paths, absent, showsValue = true }: { doc: unknown; paths: string[][]; absent: string; showsValue?: boolean },
) {
  const found = paths.find((path) => has(doc, ...path));
  if (found === undefined) return <NotServed why={absent} />;
  const value = at(doc, ...found);
  if (showsValue && typeof value === "string" && value !== "") return <span data-served-field={found.join(".")}>{value}</span>;
  return (
    <span className="text-muted-foreground" data-served-field={found.join(".")} data-not-read="">
      served ({found.join(".")}), but not read by this dashboard version yet
    </span>
  );
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-[minmax(9rem,14rem)_1fr] gap-3 border-b border-border/30 py-1.5 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words" data-testid={testId}>{children}</dd>
    </div>
  );
}

function strings(value: unknown): string[] {
  return list(value).filter((one): one is string => typeof one === "string");
}

// ------------------------------------------------------------------ 1. scenario card

/**
 * The scenario card: name, template, deployment, grade, status, as-of and valuation
 * date, and whether it is excluded from every total, with why. The template is the
 * events route's (each event's), the rest the report's. The report states no
 * valuation date, so none is shown: it is not computed here from anything else.
 */
export function ScenarioCard({ report, events, eventsError }: { report: Doc; events: unknown; eventsError: string | null }) {
  const refusal = obj(report.refusal);
  const templates = list(at(events, "events")).map((event) => {
    const template = obj(at(event, "template"));
    return {
      event: text(at(event, "event_key")) ?? "",
      name: text(template?.name),
      id: text(template?.template_id),
      version: template?.version,
    };
  });
  const excluded = report.excluded_from_totals;
  const failed = strings(at(report, "integrity", "failed"));
  return (
    <section data-section="scenario-card" aria-label="Scenario">
      <GlassCard hover={false} glow={false}>
        <Banner doc={report} />
        <h2 className="text-xl font-semibold tracking-tight" data-testid="scenario-name">
          <Served value={at(report, "scenario", "title")} />
        </h2>
        <dl className="mt-3 text-sm">
          <Row label="Template" testId="scenario-template">
            {eventsError !== null ? (
              <NotServed why={eventsError} />
            ) : templates.length === 0 ? (
              <NotServed why="the events route names no template" />
            ) : (
              <ul className="space-y-0.5">
                {templates.map((one) => (
                  <li key={one.event}>
                    {one.name ?? <NotServed />}{" "}
                    <span className="text-muted-foreground">
                      ({one.id ?? "?"} v{typeof one.version === "number" ? one.version : "?"}; event {one.event})
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Row>
          <Row label="Deployment" testId="scenario-deployment">
            <span className="font-mono"><Served value={at(report, "scenario", "deployment")} /></span>
          </Row>
          <Row label="Grade" testId="scenario-grade">
            {typeof report.grade === "string" ? report.grade : "not graded"}
          </Row>
          <Row label="Status" testId="scenario-status">
            {refusal !== null ? (
              <span>
                refused <span className="font-mono" data-testid="refusal-code">{text(refusal.code) ?? "(no code served)"}</span>
              </span>
            ) : (
              <Served value={report.status} />
            )}
          </Row>
          <Row label="As of" testId="scenario-as-of"><Served value={at(report, "build", "as_of")} /></Row>
          <Row label="Valuation date" testId="scenario-valuation-date">
            <Presence doc={report} paths={VALUATION_DATE} absent="the report states no valuation date" />
          </Row>
          <Row label="Excluded from every total" testId="excluded-from-totals">
            {excluded === false ? "no" : excluded === true ? "yes" : "not served (read as yes)"}
          </Row>
          {text(report.banner_reason) !== null && (
            <Row label="Why" testId="banner-reason">{text(report.banner_reason)}</Row>
          )}
          <Row label="Integrity" testId="integrity">
            {at(report, "integrity", "verified") === true ? (
              "every stored row verified"
            ) : (
              <span className="text-sev-high">
                not verified{failed.length ? `: failed ${failed.join(", ")}` : ""}
              </span>
            )}
          </Row>
          <Row label="Result">
            <span className="font-mono text-xs">{text(at(report, "simulation", "uuid")) ?? "?"}</span>{" "}
            <span className="text-muted-foreground">
              seed {text(at(report, "simulation", "seed")) ?? "?"}, {String(at(report, "simulation", "draws") ?? "?")} draws, recorded{" "}
              {text(at(report, "simulation", "recorded_at")) ?? "?"}
            </span>
          </Row>
          <Row label="Review"><Served value={at(report, "scenario", "review", "status")} /></Row>
        </dl>
      </GlassCard>
    </section>
  );
}

// ------------------------------------------------------------------ refusal

/**
 * A refused result: its refusal code and detail, and the inputs it kept, named --
 * never a figure. The inputs' entered figures are in the report's bytes (the
 * download); beside a refusal none is shown.
 */
export function RefusalPanel({ report }: { report: Doc }) {
  const refusal = obj(report.refusal);
  const parameters = obj(report.parameters);
  const kept = parameters !== null && !("not_reported" in parameters) ? Object.entries(parameters) : [];
  return (
    <section data-section="refusal" aria-label="Refused">
      <GlassCard hover={false} glow={false}>
        <Banner doc={report} />
        <h2 className="text-lg font-semibold tracking-tight">Refused: no figures</h2>
        <p className="mt-2 text-sm">
          Refusal code <span className="font-mono" data-testid="refusal-panel-code">{text(refusal?.code) ?? "(none served)"}</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          The backend&apos;s detail of a refusal can state an input&apos;s figures, so it is not shown beside one: it is in
          the report&apos;s bytes (the download below).
        </p>
        <h3 className="mt-4 text-sm font-semibold">Kept inputs</h3>
        <p className="text-xs text-muted-foreground">
          The inputs this run was given, by name and provenance. A refused result shows no figure: the entered values are
          in the report&apos;s bytes.
        </p>
        {parameters !== null && "not_reported" in parameters ? (
          <p className="mt-2 text-sm"><NotServed why={text(parameters.not_reported) ?? undefined} /></p>
        ) : (
          <table className="mt-2 w-full text-left text-xs" data-testid="kept-inputs">
            <thead className="text-muted-foreground">
              <tr><th className="py-1 pr-2">Input</th><th className="pr-2">Unit</th><th className="pr-2">Source</th><th className="pr-2">Evidence</th><th className="pr-2">Effective</th><th>Read by</th></tr>
            </thead>
            <tbody>
              {kept.map(([name, entry]) => (
                <tr key={name} className="border-t border-border/30" data-kept-input={name}>
                  <td className="py-1 pr-2 font-mono">{name}</td>
                  <td className="pr-2">{text(at(entry, "unit")) ?? ""}</td>
                  <td className="pr-2">{text(at(entry, "source_type")) ?? ""}</td>
                  <td className="pr-2">{text(at(entry, "evidence_ref")) ?? ""}</td>
                  <td className="pr-2">{text(at(entry, "effective_date")) ?? ""}</td>
                  <td>{strings(at(entry, "read_by")).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Unknowns report={report} />
      </GlassCard>
    </section>
  );
}

/**
 * Every unknown the report lists -- a component, a refusal, an integrity failure --
 * by kind, id and what it misses. Beside a refusal, so never its prose, which can
 * state an input's figures.
 */
export function Unknowns({ report }: { report: Doc }) {
  const unknowns = list(report.unknowns);
  if (unknowns.length === 0) return null;
  return (
    <div className="mt-4" data-testid="unknowns">
      <h3 className="text-sm font-semibold">Unknowns</h3>
      <ul className="mt-1 space-y-1 text-xs">
        {unknowns.map((one, index) => (
          <li key={index} data-unknown={text(at(one, "id")) ?? ""}>
            <span className="font-mono">{text(at(one, "kind"))}: {text(at(one, "id"))}</span>
            {strings(at(one, "missing")).length ? <span className="text-muted-foreground"> (missing {strings(at(one, "missing")).join(", ")})</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ 2. distribution

const POINTS: Array<{ key: string; label: (severe: string) => string; band: string | null }> = [
  { key: "mean", label: () => "Mean", band: "mean" },
  { key: "expected_annual_loss", label: () => "Expected annual loss", band: null },
  { key: "severe_plausible", label: (severe) => `Severe but plausible (P${severe})`, band: "severe_plausible" },
];

function LineFigures({ report, line, headline }: { report: Doc; line: string; headline: string | null }) {
  const { code, minorUnit } = currencyOf(report);
  const block = obj(at(report, "summary", "lines", line));
  const severe = text(at(report, "summary", "severe_percentile")) ?? text(at(report, "simulation", "severe_percentile")) ?? "?";
  const level = text(at(report, "summary", "confidence_level"));
  const grade = text(at(report, "validity_card", "fields", "confidence_grade", "lines", line, "grade"));
  const label = LINE_LABEL[line] ?? line;
  if (block === null || ("not_reported" in block && Object.keys(block).length === 1)) {
    return (
      <div data-line={line}>
        <h3 className="font-semibold">{label}</h3>
        <p><NotServed why={text(block?.not_reported) ?? "the report serves no such line"} /></p>
      </div>
    );
  }
  const notReported = obj(block.not_reported) ?? {};
  const why = (key: string) => text(notReported[key]);
  const money = (key: string) => <Money value={block[key]} currency={code} minorUnit={minorUnit} reason={why(key)} />;
  const band = (key: string | null) => {
    if (key === null) return null;
    const pair = list(at(block, "bands", key));
    if (pair.length !== 2) return <span className="text-muted-foreground">band: <NotServed why={why(`bands.${key}`) ?? undefined} /></span>;
    return (
      <span className="text-muted-foreground" data-band={key}>
        band{level ? ` at ${level}` : ""}: <Money value={pair[0]} currency={code} minorUnit={minorUnit} /> to{" "}
        <Money value={pair[1]} currency={code} minorUnit={minorUnit} />
      </span>
    );
  };
  return (
    <div data-line={line} className="rounded-lg border border-border/40 p-3">
      <h3 className="flex flex-wrap items-center gap-2 font-semibold">
        {label}
        {headline === line ? (
          <span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide" data-headline="">
            headline
          </span>
        ) : null}
        <span className="text-xs font-normal text-muted-foreground" data-line-grade="">
          grade {grade ?? "not graded"}
        </span>
      </h3>
      {/* The point and its range together: P50 within P10 to P90. */}
      <p className="mt-2" data-range="p10-p90">
        P50 {money("p50")} <span className="text-muted-foreground">within P10</span> {money("p10")}{" "}
        <span className="text-muted-foreground">to P90</span> {money("p90")}
      </p>
      <dl className="mt-2">
        {POINTS.map((point) => (
          <Row key={point.key} label={point.label(severe)}>
            <span data-point={point.key}>
              {money(point.key)}{" "}
              {point.band ? band(point.band) : (
                <span className="text-muted-foreground">
                  (no band of its own; the line&apos;s range is P10 {money("p10")} to P90 {money("p90")})
                </span>
              )}
            </span>
          </Row>
        ))}
      </dl>
      <Histogram report={report} line={line} />
    </div>
  );
}

/**
 * The served histogram of a line: bins in the report's order, each bar's height
 * its share of the largest COUNT (a count of draws, never money); the edges are
 * the served amounts, as labels.
 */
function Histogram({ report, line }: { report: Doc; line: string }) {
  const histogram = obj(at(report, "charts", "lines", line, "histogram"));
  if (histogram === null) return null;
  const { code } = currencyOf(report);
  const bins = list(histogram.bins).map((bin) => ({ lower: at(bin, "lower"), upper: at(bin, "upper"), count: at(bin, "count") }));
  const counts = bins.map((bin) => (typeof bin.count === "number" ? bin.count : 0));
  const tallest = Math.max(1, ...counts);
  return (
    <figure className="mt-3" data-histogram={line}>
      <div className="flex h-16 items-end gap-px" aria-hidden="true">
        {bins.map((bin, index) => (
          <div
            key={index}
            className="flex-1 rounded-t-sm bg-primary/50"
            style={{ height: `${(counts[index] / tallest) * 100}%` }}
            title={`${code} ${String(bin.lower)} to ${String(bin.upper)}: ${String(bin.count)} draws`}
          />
        ))}
      </div>
      <figcaption className="mt-1 text-[11px] text-muted-foreground">
        {bins.length} bins of the run&apos;s draws, from <Money value={bins[0]?.lower} currency={code} /> to{" "}
        <Money value={bins[bins.length - 1]?.upper} currency={code} />; above it,{" "}
        {String(at(histogram, "above", "count") ?? "?")} draws. Heights are counts of draws.
      </figcaption>
    </figure>
  );
}

/** P10 / P50 / P90, mean, expected annual loss and severe-but-plausible, for gross AND retained cash. */
export function Distribution({ report }: { report: Doc }) {
  const headline = text(at(report, "summary", "headline"));
  const basis = text(at(report, "summary", "basis"));
  return (
    <FigureSection
      title="Distribution"
      id="distribution"
      doc={report}
      note={
        <>
          Basis: {basis ?? "not served"}. {text(at(report, "summary", "statement")) ?? ""} Both cash lines are graded; the
          headline is the one the report marks.
        </>
      }
    >
      {CASH_LINES.map((line) => <LineFigures key={line} report={report} line={line} headline={headline} />)}
      <div className="rounded-lg border border-dashed border-border/60 p-3" data-market-value-distribution="">
        <p className="mb-2 text-xs text-muted-foreground">
          Market-value reaction is not cash: it is shown on its own line and never added to either cash line.
        </p>
        <LineFigures report={report} line={MARKET_VALUE_LINE} headline={headline} />
      </div>
    </FigureSection>
  );
}

// ------------------------------------------------------------------ 3. cost waterfall

function ComponentRow({ component, code, minorUnit }: { component: unknown; code: string; minorUnit: number | null }) {
  const status = text(at(component, "status"));
  const formula = list(at(component, "formula"));
  return (
    <li className="grid grid-cols-[1fr_auto] gap-3 border-t border-border/30 py-1.5" data-component={text(at(component, "component_id")) ?? ""}>
      <div>
        <span className="font-medium">{text(at(component, "family")) ?? "?"}</span>{" "}
        <span className="text-muted-foreground">
          {text(at(component, "component_id"))} · {String(formula[0] ?? "?")} v{String(formula[1] ?? "?")} · {status}
        </span>
        {status !== "estimated" ? (
          <p className="text-xs text-muted-foreground">
            unknown: {text(at(component, "unknown_reason")) ?? "no reason served"}
            {strings(at(component, "missing")).length ? ` (missing ${strings(at(component, "missing")).join(", ")})` : ""}
          </p>
        ) : null}
      </div>
      <div className="text-right text-xs">
        <div>low <Money value={at(component, "low")} currency={code} minorUnit={minorUnit} /></div>
        <div>base <Money value={at(component, "base")} currency={code} minorUnit={minorUnit} /></div>
        <div>high <Money value={at(component, "high")} currency={code} minorUnit={minorUnit} /></div>
      </div>
    </li>
  );
}

function Total({ label, total, code, minorUnit, testId }: { label: string; total: unknown; code: string; minorUnit: number | null; testId: string }) {
  const line = obj(total);
  if (line === null) return null;
  return (
    <div className="mt-2 rounded-md bg-muted/20 px-3 py-2 text-xs" data-testid={testId}>
      <span className="font-semibold">{label}</span> <span className="text-muted-foreground">({text(line.reads_as) ?? ""})</span>
      <div className="mt-1 flex flex-wrap gap-4">
        <span>low <Money value={line.low} currency={code} minorUnit={minorUnit} /></span>
        <span>base <Money value={line.base} currency={code} minorUnit={minorUnit} /></span>
        <span>high <Money value={line.high} currency={code} minorUnit={minorUnit} /></span>
      </div>
    </div>
  );
}

/**
 * The loss components the report serves, in its order, each event's cash
 * components first and its totals as served; the market-value reaction on its OWN
 * line, never among the cash. Nothing is added up here: every figure, totals
 * included, is the report's.
 */
export function CostWaterfall({ report }: { report: Doc }) {
  const { code, minorUnit } = currencyOf(report);
  return (
    <FigureSection
      title="Cost waterfall"
      id="waterfall"
      doc={report}
      note="Each event's components at low, base and high, in the report's order, then its totals as the report states them. Steps are not drawn to scale and nothing is summed here."
    >
      {list(report.loss_events).map((event) => {
        const components = list(at(event, "components"));
        // Only a component the report marks as cash is a cash step; anything else is not cash.
        const cash = components.filter((component) => at(component, "cash") === true);
        const notCash = components.filter((component) => at(component, "cash") !== true);
        const key = text(at(event, "event_key")) ?? "";
        return (
          <div key={key} className="rounded-lg border border-border/40 p-3" data-event={key}>
            <h3 className="font-semibold">
              {key} <span className="text-xs font-normal text-muted-foreground">{text(at(event, "trigger"))} · {text(at(event, "business_process"))}</span>
            </h3>
            <ol className="mt-2" data-cash-steps="">
              {cash.map((component, index) => <ComponentRow key={index} component={component} code={code} minorUnit={minorUnit} />)}
            </ol>
            <Total label="Gross cash" total={at(event, "gross_cash")} code={code} minorUnit={minorUnit} testId="event-gross-cash" />
            <Total label="Retained cash" total={at(event, "retained_cash")} code={code} minorUnit={minorUnit} testId="event-retained-cash" />
            {(notCash.length > 0 || obj(at(event, "market_value")) !== null) && (
              <div className="mt-3 rounded-md border border-dashed border-border/60 p-2" data-market-value-line="">
                <p className="text-xs font-semibold">Market-value reaction: its own line, never added to cash</p>
                <ol>
                  {notCash.map((component, index) => <ComponentRow key={index} component={component} code={code} minorUnit={minorUnit} />)}
                </ol>
                <Total label="Market value" total={at(event, "market_value")} code={code} minorUnit={minorUnit} testId="event-market-value" />
              </div>
            )}
          </div>
        );
      })}
    </FigureSection>
  );
}

// ------------------------------------------------------------------ 4. tornado

/** A bar's width from a ranked parameter's importance: a share of variance, never money. */
function shareWidth(importance: unknown): string {
  const share = typeof importance === "string" && /^\d+(\.\d+)?$/.test(importance) ? Number(importance) : 0;
  return `${Math.min(100, Math.max(0, share * 100))}%`;
}

/** The sensitivity rows as served, in the report's rank order. */
export function Tornado({ report }: { report: Doc }) {
  const { code, minorUnit } = currencyOf(report);
  const sensitivity = obj(report.sensitivity);
  const parameters = obj(report.parameters) ?? {};
  if (sensitivity === null || "not_reported" in sensitivity) {
    return (
      <FigureSection title="Sensitivity tornado" id="tornado" doc={report}>
        <NotServed why={text(sensitivity?.not_reported) ?? undefined} />
      </FigureSection>
    );
  }
  return (
    <FigureSection
      title="Sensitivity tornado"
      id="tornado"
      doc={report}
      note={
        <>
          Output: {text(sensitivity.output) ?? "?"}, basis {text(sensitivity.basis) ?? "?"}. A bar is the parameter&apos;s
          served importance (its share of the variance), not money. Baseline outcome{" "}
          <Money value={at(sensitivity, "baseline", "outcome")} currency={code} minorUnit={minorUnit} />.
        </>
      }
    >
      <ol className="space-y-2" data-testid="tornado-rows">
        {list(sensitivity.tornado).map((entry) => {
          const name = text(at(entry, "name")) ?? "?";
          const swing = obj(at(entry, "swing"));
          const money = isMoneyUnit(at(parameters, name, "unit"));
          const quantile = (key: string) =>
            money ? <Money value={swing?.[key]} currency={code} /> : <Served value={swing?.[key]} />;
          return (
            <li key={name} className="rounded-md border border-border/30 p-2" data-tornado-row={name}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  <span className="text-muted-foreground">#{String(at(entry, "rank") ?? "?")}</span>{" "}
                  <span className="font-mono">{name}</span>{" "}
                  <span className="text-xs text-muted-foreground">{text(at(entry, "direction"))}</span>
                </span>
                <span className="text-xs">importance {text(at(entry, "importance")) ?? "?"}</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-muted/30" aria-hidden="true">
                <div className="h-1.5 rounded bg-primary/60" style={{ width: shareWidth(at(entry, "importance")) }} />
              </div>
              {swing === null ? (
                <p className="mt-1 text-xs"><NotServed why="no swing for this parameter" /></p>
              ) : (
                <p className="mt-1 text-xs">
                  at its P10 {quantile("p10")} the outcome is{" "}
                  <Money value={swing.low_outcome} currency={code} minorUnit={minorUnit} />; at its P90 {quantile("p90")} it is{" "}
                  <Money value={swing.high_outcome} currency={code} minorUnit={minorUnit} /> (P50 {quantile("p50")})
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {list(sensitivity.fixed).length > 0 && (
        <p className="text-xs text-muted-foreground">
          Fixed ({text(at(sensitivity, "statements", "fixed")) ?? ""}): {list(sensitivity.fixed).map((one) => text(at(one, "name"))).join(", ")}
        </p>
      )}
      {strings(sensitivity.not_in_gross_cash).length > 0 && (
        <p className="text-xs text-muted-foreground">
          Not in gross cash ({text(at(sensitivity, "statements", "not_in_gross_cash")) ?? ""}): {strings(sensitivity.not_in_gross_cash).join(", ")}
        </p>
      )}
    </FigureSection>
  );
}

// ------------------------------------------------------------------ 7. validity card

function Downgrades({ grade }: { grade: unknown }) {
  const downgrades = list(at(grade, "downgrades"));
  if (downgrades.length === 0) return <span className="text-muted-foreground">no downgrade</span>;
  return (
    <ul className="space-y-0.5">
      {downgrades.map((one, index) => (
        <li key={index} data-downgrade={text(at(one, "rule")) ?? ""}>
          <Mark kind="downgraded">{text(at(one, "rule"))}</Mark>{" "}
          <span className="text-xs text-muted-foreground">{text(at(one, "meaning")) ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

const SHARES = [
  ["customer_specific_share", "Customer-specific"],
  ["benchmark_derived_share", "Benchmark-derived"],
  ["expert_estimated_share", "Expert-estimated"],
] as const;

/** The Validity Card as the report serves it: its grade and every downgrade, its shares, its freshness. */
export function ValidityCardView({ report, refused }: { report: Doc; refused: boolean }) {
  const card = obj(report.validity_card);
  if (card === null || "not_reported" in card) {
    return (
      <FigureSection title="Validity Card" id="validity-card" doc={report}>
        <NotServed why={text(card?.not_reported) ?? undefined} />
      </FigureSection>
    );
  }
  const fields = obj(card.fields) ?? {};
  const grade = obj(fields.confidence_grade);
  const freshness = obj(fields.data_freshness);
  if (refused) {
    // A refused result shows no figure: the card's grade, its digest and its
    // downgrades only; the rest of the card is in the report's bytes.
    return (
      <FigureSection title="Validity Card" id="validity-card" doc={report}>
        <dl>
          <Row label="Grade" testId="card-grade">{text(card.grade) ?? "not served"}</Row>
          <Row label="Digest"><span className="font-mono text-xs">{text(card.digest)}</span></Row>
          {grade !== null && <Row label="Downgrades" testId="card-downgrades"><Downgrades grade={grade} /></Row>}
        </dl>
        <p className="text-xs text-muted-foreground">The run was refused: the card&apos;s other fields are in the report&apos;s bytes.</p>
      </FigureSection>
    );
  }
  const staleNames = new Set([...strings(freshness?.stale), ...strings(freshness?.stale_not_graded)]);
  return (
    <FigureSection title="Validity Card" id="validity-card" doc={report}>
      <dl>
        <Row label="Grade" testId="card-grade">{text(card.grade) ?? "not served"}</Row>
        <Row label="Digest"><span className="font-mono text-xs">{text(card.digest)}</span></Row>
        <Row label="Issued"><Served value={card.issued_at} /></Row>
        <Row label="Model"><Served value={at(card, "model_version", "version")} /></Row>
        <Row label="Reviewer status at issue"><Served value={card.reviewer_status_at_issue} /></Row>
        {grade !== null && (
          <>
            <Row label="Base grade"><Served value={grade.base_grade} /></Row>
            <Row label="Downgrades" testId="card-downgrades"><Downgrades grade={grade} /></Row>
            <Row label="Graded line"><Served value={grade.line} /></Row>
            <Row label="Why"><Served value={grade.reason} /></Row>
            {CASH_LINES.map((line) => {
              const lineGrade = obj(at(grade, "lines", line));
              return (
                <Row key={line} label={`${LINE_LABEL[line]} grade`}>
                  {lineGrade === null ? <NotServed why="not graded" /> : (
                    <span data-card-line={line}>
                      {text(lineGrade.grade) ?? "?"} <Downgrades grade={lineGrade} />
                    </span>
                  )}
                </Row>
              );
            })}
            {strings(grade.stale_parameters).length > 0 && (
              <Row label="Stale figures the grade reads" testId="card-stale-parameters">
                {strings(grade.stale_parameters).map((name) => <span key={name} className="mr-2 font-mono">{name}<Mark kind="stale" /></span>)}
              </Row>
            )}
          </>
        )}
      </dl>
      <dl>
        {SHARES.map(([key, label]) => (
          <Row key={key} label={`${label} share`}>
            {text(at(fields, key, "share")) ?? <NotServed why={text(at(fields, key, "unavailable")) ?? undefined} />}{" "}
            <span className="text-xs text-muted-foreground">{text(at(fields, key, "meaning")) ?? ""}</span>
          </Row>
        ))}
      </dl>
      {freshness !== null && (
        <div data-testid="data-freshness">
          <h3 className="text-sm font-semibold">Data freshness at {text(freshness.as_of) ?? "?"}</h3>
          <p className="text-xs text-muted-foreground">{text(freshness.statement) ?? ""}</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {list(freshness.parameters).map((one) => {
              const name = text(at(one, "name")) ?? "?";
              const stale = at(one, "stale") === true || staleNames.has(name);
              return (
                <li key={name} data-freshness={name} data-stale={stale ? "true" : "false"}>
                  <span className="font-mono">{name}</span>{" "}
                  <span className="text-muted-foreground">
                    effective {text(at(one, "effective_date")) ?? "?"}, fresh until {text(at(one, "fresh_until")) ?? "no limit stated"}
                  </span>
                  {stale ? <Mark kind="stale" /> : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <dl>
        <Row label="Last calibrated"><Served value={at(fields, "last_calibrated", "statement")} /></Row>
        <Row label="System fingerprint"><span className="font-mono text-xs"><Served value={at(fields, "system_fingerprint", "value")} /></span></Row>
        <Row label="Technical evidence">
          {list(at(fields, "technical_evidence", "findings")).map((finding, index) => (
            <span key={index} className="mr-2 font-mono text-xs">
              {text(at(finding, "finding"))} ({text(at(finding, "role"))}, {text(at(finding, "status_at_issue", "severity"))} {text(at(finding, "status_at_issue", "status"))})
            </span>
          ))}
        </Row>
        <Row label="Reproduction">
          <span className="text-xs">
            seed {text(at(fields, "reproduction", "seed")) ?? "?"}, {String(at(fields, "reproduction", "draws") ?? "?")} draws, result{" "}
            <span className="font-mono">{text(at(fields, "reproduction", "result_digest")) ?? "?"}</span>
          </span>
        </Row>
      </dl>
      <p className="text-xs text-muted-foreground">{text(card.statement) ?? ""}</p>
    </FigureSection>
  );
}

// ------------------------------------------------------------------ 8. receipt

/** Where a report would name a route for its receipt's signed bytes (it names none today). */
const RECEIPT_BYTES: string[][] = [["receipt", "url"], ["receipt", "href"], ["receipt", "download"]];

/**
 * The report's bytes, pinned to the result on screen, with the digest it carries;
 * and the receipt's reference as the report states it. The receipt's signed bytes
 * are offered only once the report names a route for them; it names none today.
 */
export function ReceiptPanel({ report, href }: { report: Doc; href: string | null }) {
  const receipt = obj(report.receipt);
  return (
    <PlainSection title="Receipt and download" id="receipt">
      <dl>
        <Row label="Report digest" testId="report-digest">
          <span className="font-mono text-xs">{text(report.digest) ?? "not served"}</span>{" "}
          <span className="text-xs text-muted-foreground">(as served; not verified by this dashboard)</span>
        </Row>
        <Row label="Report bytes">
          {href === null ? (
            <NotServed why="the report names no result uuid to pin a download to" />
          ) : (
            <>
              <a className="text-primary underline" href={href} download data-testid="report-download">
                Download this result&apos;s report, its bytes as served
              </a>
              <p className="text-xs text-muted-foreground">
                A fresh read of the same result: the backend builds the report from its stored rows when it is read, so a
                review or card recorded since can change its bytes and digest.
              </p>
            </>
          )}
        </Row>
      </dl>
      {receipt === null || "not_reported" in receipt ? (
        <p data-testid="receipt-reference"><NotServed why={text(receipt?.not_reported) ?? undefined} /></p>
      ) : (
        <dl data-testid="receipt-reference">
          <Row label="Receipt id"><span className="font-mono text-xs">{text(receipt.receipt_id)}</span></Row>
          <Row label="Signing key"><span className="font-mono text-xs">{text(receipt.key_id)}</span></Row>
          <Row label="Generated"><Served value={receipt.generated_at} /></Row>
          <Row label="Signed document digest" testId="receipt-digest"><span className="font-mono text-xs">{text(receipt.document_digest)}</span></Row>
          <Row label="Validity Card digest it signs"><span className="font-mono text-xs">{text(receipt.validity_card_digest)}</span></Row>
          <Row label="Verified">
            {receipt.verified === true ? "yes" : "no"} <span className="text-xs text-muted-foreground">{text(receipt.statement) ?? ""}</span>
          </Row>
        </dl>
      )}
      <p data-testid="receipt-download">
        Signed receipt bytes:{" "}
        <Presence doc={report} paths={RECEIPT_BYTES} absent="the report names no route for a receipt's signed bytes" showsValue={false} />
      </p>
    </PlainSection>
  );
}
