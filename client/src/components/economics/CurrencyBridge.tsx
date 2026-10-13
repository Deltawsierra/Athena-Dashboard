/**
 * The currency bridge, as a v2 report serves it (`currency_bridge`, Athena-Backend
 * #163): the run's valuation date and where it was read from, the reporting
 * currency, and the normalization record of each figure the run converted
 * (`conversions`), with the backend's statement of why there are none -- a run
 * converts nothing, so `conversions` is empty and the statement is shown. Every
 * value is the report's; nothing is converted, dated or filled in here.
 *
 * A conversion record, were one served, is Athena-Backend's own provenance record
 * (`Normalization.as_dict()`, spec section 12.6): native amount -> event-date FX ->
 * cost index -> valuation-date FX, each step with its source, its observation date
 * and its snapshot hash, rendered exactly (<BridgeRecord>): every rate, ratio and
 * amount is the record's string. "Not served" is said only where a report has no
 * currency bridge at all (v1).
 */
import Money from "@/components/economics/Money";
import { FigureSection, Mark, NotServed, Served, ValuationDate } from "@/components/economics/sections";
import { at, has, list, obj, text, type Doc } from "@/lib/economics";

const STEP_LABEL: Record<string, string> = {
  event_fx: "Event-date FX",
  cost_index: "Cost index",
  valuation_fx: "Valuation-date FX",
};

function marks(step: unknown) {
  return (
    <>
      {at(step, "stale") === true ? <Mark kind="stale" /> : null}
      {at(step, "estimate") === true ? <Mark kind="estimate" /> : null}
      {list(at(step, "downgrades")).map((one, index) => <Mark key={index} kind="downgraded">{String(one)}</Mark>)}
    </>
  );
}

function amount(part: unknown) {
  return <Money value={at(part, "amount")} currency={text(at(part, "currency")) ?? ""} />;
}

function Step({ step }: { step: unknown }) {
  const name = text(at(step, "step")) ?? "?";
  const fx = name !== "cost_index";
  return (
    <li className="rounded-md border border-border/40 p-2" data-bridge-step={name}>
      <p className="font-semibold">
        {STEP_LABEL[name] ?? name}
        {marks(step)}
      </p>
      <p className="text-xs">
        {amount(at(step, "input"))} to {amount(at(step, "output"))}
      </p>
      {fx ? (
        <p className="text-xs text-muted-foreground">
          {text(at(step, "from"))} to {text(at(step, "to"))}, rate {text(at(step, "quoted_rate")) ?? "?"} ({text(at(step, "direction"))},
          factor {text(at(step, "factor")) ?? "?"}), {text(at(step, "rule"))}; source {text(at(step, "provider")) ?? "?"}{" "}
          {text(at(step, "rate_type")) ?? ""}, rate of {text(at(step, "rate_date")) ?? "?"} for {text(at(step, "requested_date")) ?? "?"}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          series {text(at(step, "series_id")) ?? "?"} ({text(at(step, "category")) ?? ""}), {text(at(step, "from_period"))} to{" "}
          {text(at(step, "period_used"))}, ratio {text(at(step, "ratio")) ?? "?"}, {text(at(step, "rule"))}
        </p>
      )}
      <ul className="mt-1 space-y-0.5 text-[11px]">
        {list(at(step, "observations")).map((observation, index) => (
          <li key={index} data-observation="">
            {text(at(observation, "provider")) ?? text(at(observation, "series_id")) ?? "?"}:{" "}
            {text(at(observation, "rate")) ?? text(at(observation, "value")) ?? "?"}, observed{" "}
            {text(at(observation, "effective_date")) ?? text(at(observation, "period")) ?? "?"}
            {text(at(observation, "observed_at")) ? ` (at ${text(at(observation, "observed_at"))})` : ""}
            {text(at(observation, "vintage_date")) ? ` (vintage ${text(at(observation, "vintage_date"))})` : ""}; snapshot{" "}
            <span className="font-mono" data-snapshot-hash="">{text(at(observation, "source_snapshot_hash")) ?? "not served"}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** A served Normalization record, step by step. */
export function BridgeRecord({ record }: { record: Doc }) {
  const unavailable = obj(record.unavailable);
  return (
    <div data-testid="bridge-record" data-status={text(record.status) ?? ""}>
      <p className="text-sm">
        Native {amount(record.native)} on {text(record.event_date) ?? "?"}, valued at {text(record.valuation_date) ?? "?"} in{" "}
        {text(record.reporting_currency) ?? "?"} (base {text(record.base_currency) ?? "?"})
        {record.stale === true ? <Mark kind="stale" /> : null}
        {record.estimate === true ? <Mark kind="estimate" /> : null}
        {list(record.confidence_downgrades).map((one, index) => <Mark key={index} kind="downgraded">{String(one)}</Mark>)}
      </p>
      <ol className="mt-2 space-y-2">
        {list(record.chain).map((step, index) => <Step key={index} step={step} />)}
      </ol>
      {unavailable !== null ? (
        <p className="mt-2 text-sm" data-bridge-unavailable="">
          <Mark kind="unavailable" /> at {text(unavailable.step) ?? "?"}: {text(unavailable.reason) ?? "?"}{" "}
          <span className="text-xs text-muted-foreground">{text(unavailable.detail) ?? ""}</span>
        </p>
      ) : (
        <p className="mt-2 text-sm">
          Value {amount(record.value)}; shown as <span className="font-mono" data-bridge-display="">{text(record.display) ?? "not served"}</span>{" "}
          <span className="text-xs text-muted-foreground">({text(record.display_rounding) ?? ""})</span>
        </p>
      )}
    </div>
  );
}

/** One served conversion: a normalization record step by step, or said to be unread. */
function Conversion({ conversion, index }: { conversion: unknown; index: number }) {
  const record = obj(conversion);
  if (record !== null && Array.isArray(record.chain)) return <BridgeRecord record={record} />;
  return (
    <p className="text-muted-foreground" data-not-read="">
      served (currency_bridge.conversions[{index}]), but not read by this dashboard version yet
    </p>
  );
}

/** The bridge's conversions: each record, or the backend's statement of why there is none. */
function Conversions({ bridge }: { bridge: Doc }) {
  if (!has(bridge, "conversions")) {
    return <NotServed why="the report's currency bridge names no conversions" />;
  }
  const conversions = bridge.conversions;
  if (!Array.isArray(conversions)) {
    return (
      <p className="text-muted-foreground" data-not-read="">
        served (currency_bridge.conversions), but not read by this dashboard version yet
      </p>
    );
  }
  if (conversions.length === 0) {
    return (
      <p data-testid="bridge-no-conversion">
        No figure was converted.{" "}
        <span className="text-muted-foreground" data-testid="bridge-statement">
          {text(bridge.statement) ?? "(the report served no statement why)"}
        </span>
      </p>
    );
  }
  return (
    <ol className="space-y-3">
      {conversions.map((one, index) => (
        <li key={index}><Conversion conversion={one} index={index} /></li>
      ))}
    </ol>
  );
}

/**
 * The bridge section of a report: its currency, valuation date and snapshots, and
 * the bridge itself. A section with figures, so under the report's banner like
 * every other.
 */
export default function CurrencyBridge({ report }: { report: Doc }) {
  const snapshots = obj(report.source_snapshots);
  const oneCurrency = list(report.limitations).find((line) => typeof line === "string" && line.startsWith("one reporting currency"));
  const bridge = has(report, "currency_bridge") ? obj(report.currency_bridge) : null;
  // A report before v2 might carry a normalization record by itself: rendered as served.
  const legacy = !has(report, "currency_bridge") && has(report, "normalization") ? obj(report.normalization) : null;
  return (
    <FigureSection title="Currency bridge" id="currency-bridge" doc={report}>
      <dl className="text-sm">
        <div className="py-1"><span className="text-muted-foreground">Reporting currency </span><Served value={at(report, "currency", "code")} />{" "}
          <span className="text-xs text-muted-foreground">(minor unit {String(at(report, "currency", "minor_unit") ?? "?")}; {text(at(report, "currency", "rounding")) ?? ""})</span>
        </div>
        <div className="py-1" data-testid="bridge-valuation-date">
          <span className="text-muted-foreground">Valuation date </span><ValuationDate report={report} />
        </div>
        {bridge !== null && has(bridge, "reporting_currency") ? (
          <div className="py-1" data-testid="bridge-reporting-currency">
            <span className="text-muted-foreground">The bridge&apos;s reporting currency </span><Served value={bridge.reporting_currency} />
          </div>
        ) : null}
      </dl>
      <div>
        <h3 className="text-sm font-semibold">Source snapshots</h3>
        {snapshots === null || "not_reported" in snapshots ? (
          <NotServed why={text(snapshots?.not_reported) ?? undefined} />
        ) : (
          <ul className="text-xs" data-testid="source-snapshots">
            {list(snapshots.snapshots).map((one, index) => (
              <li key={index}><span className="font-mono">{text(at(one, "snapshot_id"))}</span> <span className="font-mono text-muted-foreground">{text(at(one, "content_hash"))}</span></li>
            ))}
          </ul>
        )}
      </div>
      <div data-testid="bridge-steps">
        <h3 className="text-sm font-semibold">Native to reporting currency</h3>
        {bridge !== null ? (
          <Conversions bridge={bridge} />
        ) : has(report, "currency_bridge") ? (
          <p className="text-muted-foreground" data-not-read="">served (currency_bridge), but not read by this dashboard version yet</p>
        ) : legacy !== null && Array.isArray(legacy.chain) ? (
          <BridgeRecord record={legacy} />
        ) : has(report, "normalization") ? (
          <p className="text-muted-foreground" data-not-read="">served (normalization), but not read by this dashboard version yet</p>
        ) : (
          <p>
            <NotServed why={`Athena-Backend serves no currency bridge for this report${typeof oneCurrency === "string" ? ` (${oneCurrency})` : ""}`} />
          </p>
        )}
      </div>
    </FigureSection>
  );
}
