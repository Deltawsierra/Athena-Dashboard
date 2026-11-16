/**
 * Recovery records: each incident of a deployment -- a finding Athena-Backend keeps a
 * recovery record for (SPINE SP-1) -- with its current step and every step before it,
 * oldest first. Read from Athena-Backend's
 * GET /api/assurance/deployments/<uuid>/recovery-records/ (a page of 50 incidents) and, for
 * one incident, GET /api/assurance/findings/<uuid>/recovery-record/, through this
 * console's server (server/assurance.ts recoveryRecords, findingRecoveryRecord), as the
 * signed-in person.
 *
 * Every step is shown with what supports it: its S1 state (the state names are S1's,
 * shown as served), every condition with its witness, every gap -- called a gap, and in
 * words -- every restriction, the coverage it rests on, the release word it yields, the
 * residual uncertainty with each source, and the owner's acceptance exactly as recorded:
 * who, until when, and that it has lapsed once its end has passed. And with the scope
 * it was taken under (SPINE SP-3; ./IncidentScope.tsx): the incident's current scope
 * revision, the revision each step was taken under, each thing about the scope that
 * keeps a step back, and every item that was removed with who removed it and why. A
 * step the scope keeps back is never drawn as standing: its state and an allowed release
 * are marked, and the later revision and each item it added are named.
 *
 * NEVER A SINGLE "CLEAN" BADGE (H p.18). No incident and no deployment gets a summary
 * verdict: an incident's current state is one step's, beside its conditions, gaps and
 * coverage, and nothing here is drawn in the positive tone. An incident with a gap names
 * the gap, so it never reads like one without. `recovery_accepted` reads "accepted by
 * <owner> until <date>", with its conditions beside it.
 *
 * Honest by construction: a field the backend did not serve says so in words, never as
 * an empty list; a deployment or finding the backend answers 404 for reads "Not found",
 * never as an empty record; and while not every incident is loaded, the footer says how
 * many are shown and how many more are recorded. Nothing here writes, accepts or offers
 * an acceptance: every read is a GET, and the backend's write is not relayed.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { LifeBuoy } from "lucide-react";
import type {
  FindingRecoveryRecord,
  RecoveryCondition,
  RecoveryCoverage,
  RecoveryIncident,
  RecoveryRecords,
  RecoveryStep,
  ResidualUncertainty,
} from "@shared/recovery-record";
import { ApiError } from "@/lib/queryClient";
import type { IncidentScope } from "@shared/incident-scope";
import { Absent, Chip, Count, Fact, NotInHand, Section, When, served, type Tone } from "./parts";
import { HistoryPages, OnDemand, answeredFor, nextOffset, type PageSlot } from "./history";
import {
  IncidentScopeSummary, OneScopeAtATime, ScopeStandingChip, StepScopeFacts, scopeGapInWords, scopeStanding,
} from "./IncidentScope";

// ---- the words: S1's state names as served, and the release words and gaps in words ----

/** How each S1 recovery state is drawn. None is positive: a state is one step's, never a verdict. */
const STATE_TONES: Record<string, Tone> = {
  under_investigation: "neutral",
  contained_with_gaps: "caution",
  repair_proposed: "info",
  repair_tested: "info",
  restored_with_restrictions: "caution",
  recovery_accepted: "info",
  recovery_incomplete: "warning",
};

/** S1's two states that say a recovery was reached. Each stands only for the scope revision its step was taken under. */
const REACHED = new Set(["restored_with_restrictions", "recovery_accepted"]);

/**
 * A step's S1 recovery state, by its own name. One this console does not know is shown as served, and read as none.
 * `notStanding`: the state is served beside something about the scope that keeps the step back (or beside a scope
 * standing that is not known), so it is marked as not standing and never drawn as the plain state.
 */
export function RecoveryStateChip({ state, notStanding = false }: { state: string | null; notStanding?: boolean }) {
  if (state === null) return <Chip tone="neutral" testId="step-state">no state served</Chip>;
  if (notStanding) return <Chip tone="caution" testId="step-state">{`${state}: not standing under the scope`}</Chip>;
  const tone = STATE_TONES[state];
  if (!tone) return <Chip tone="neutral" testId="step-state">{`state not recognised here: ${state}`}</Chip>;
  return (
    <Chip tone={tone} testId="step-state">
      {state}
    </Chip>
  );
}

/**
 * The release word a step yields (S1's release states), in words. AUDIT_INCOMPLETE is
 * incomplete, never a release; a word this console does not know is shown as served.
 */
const RELEASES: Record<string, { label: string; tone: Tone }> = {
  AUDIT_INCOMPLETE: { label: "Release: audit incomplete", tone: "caution" },
  FAIL: { label: "Release: not allowed on this step", tone: "neutral" },
  PASS: { label: "Release: allowed on this step", tone: "neutral" },
  NOT_RUN: { label: "Release: not run", tone: "neutral" },
};

/** A release word in the words this screen uses for it: the same for a step's release and for the one its row recorded. */
export function releaseInWords(release: string | null): string {
  if (release === null) return "no release word served";
  return Object.prototype.hasOwnProperty.call(RELEASES, release) ? RELEASES[release].label : `release word not recognised here: ${release}`;
}

export function ReleaseChip({ release }: { release: string | null }) {
  const known = release === null ? undefined : RELEASES[release];
  return (
    <span data-testid="step-release" data-release={release ?? ""}>
      <Chip tone={known?.tone ?? "neutral"}>
        {known ? known.label : release === null ? "no release word served" : `release word not recognised here: ${release}`}
      </Chip>
    </span>
  );
}

/**
 * A gap as the backend names it, in words: a coverage gap (`coverage:<kind>:<subject>`,
 * `coverage:missing:<source>`, `coverage:unknown_inventory:<source>`,
 * `coverage:no_required_source`), an effect that was not applied
 * (`effect_not_applied:receipt:<id>`), a scope gap (`scope:not_declared`, `scope:unreadable`,
 * `scope:revision:<n>:added:<kind>:<ref>`; ./IncidentScope.tsx), or a gap the record states in its own words.
 */
export function gapInWords(gap: string): string {
  const scope = scopeGapInWords(gap);
  if (scope !== null) return scope;
  const [head, kind, ...rest] = gap.split(":");
  const tail = rest.join(":");
  if (head === "coverage") {
    if (kind === "missing" && tail) return `Coverage gap: ${tail} was not observed over all of the interval it is required for`;
    if (kind === "unknown_inventory" && tail) return `Coverage gap: what ${tail} covers is not known (unknown inventory)`;
    if (kind === "no_required_source" && rest.length === 0) {
      return "Coverage gap: no required source is declared, so nothing is known to have been observed";
    }
    if (kind && tail) return `Coverage gap: ${kind.replace(/_/g, " ")}, at ${tail}`;
  }
  if (head === "effect_not_applied" && kind === "receipt" && tail) return `Gap: the effect receipt ${tail} reads back was not applied`;
  return `Gap: ${gap}`;
}

/** A residual uncertainty's statement in words: a coverage gap, an effect nobody can say took, or the record's own words. */
export function uncertaintyInWords(statement: string): string {
  if (statement === "effect_unknown") return "Whether the effect took is not known";
  if (statement.startsWith("coverage:") || statement.startsWith("scope:")) return gapInWords(statement);
  return statement;
}

/** Whether an acceptance is in force at `now`: its end not passed, passed, or not a date read here. */
export type AcceptanceStanding = "in_force" | "lapsed" | "unreadable";

export function acceptanceStanding(until: string | null, now: number): AcceptanceStanding {
  const end = until === null ? Number.NaN : Date.parse(until);
  if (Number.isNaN(end)) return "unreadable";
  return end > now ? "in_force" : "lapsed";
}

// ---- one step ----

/** The owner's acceptance exactly as the step records it: who, until when, and whether its end has passed. */
function AcceptanceLine({ step, now }: { step: RecoveryStep; now: number }) {
  if (step.acceptedBy === null && step.acceptedUntil === null) {
    return (
      <p className="text-[12px]" data-testid="step-acceptance" data-acceptance="none">
        <Absent>No owner&apos;s acceptance is recorded on this step.</Absent>
      </p>
    );
  }
  const standing = acceptanceStanding(step.acceptedUntil, now);
  return (
    <p className="flex flex-wrap items-center gap-2 text-[12px]" data-testid="step-acceptance" data-acceptance={standing}>
      <span className="text-foreground" data-testid="acceptance-words">
        accepted by {step.acceptedBy ?? <Absent>someone no longer on record</Absent>} until{" "}
        <When iso={step.acceptedUntil} absent="no end on record" />
      </span>
      {standing === "lapsed" && (
        <Chip tone="caution" testId="acceptance-lapsed">
          Lapsed: its end is in the past
        </Chip>
      )}
      {standing === "in_force" && <span className="text-muted-foreground" data-testid="acceptance-in-force">in force until its end</span>}
      {standing === "unreadable" && (
        <Absent testId="acceptance-unreadable">
          {step.acceptedUntil === null
            ? "No end is recorded, so whether it is in force is not known here."
            : "Its end is not a date this console reads, so whether it is in force is not known here."}
        </Absent>
      )}
    </p>
  );
}

function Conditions({ conditions }: { conditions: RecoveryCondition[] | null }) {
  if (conditions === null) return <Absent testId="step-conditions-not-served">The conditions were not served.</Absent>;
  if (conditions.length === 0) return <Absent testId="step-no-conditions">No condition is recorded on this step.</Absent>;
  return (
    <ul className="space-y-1" data-testid="step-conditions">
      {conditions.map((one, index) => (
        <li key={index} className="flex flex-wrap items-baseline gap-x-2 text-[12px]" data-condition={one.condition ?? ""}>
          <code className="font-mono text-foreground">{one.condition ?? "no condition named"}</code>
          <span className="text-muted-foreground">witness</span>
          {one.witness === null ? (
            <Absent>no witness served</Absent>
          ) : (
            <span data-testid="condition-witness">
              <span className="text-muted-foreground">{one.witness.kind ?? "kind not served"}</span>{" "}
              <code className="break-all font-mono text-foreground/90">{one.witness.ref ?? "no reference"}</code>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Every gap of a step, called a gap and in words, with the backend's own name for it beside. */
function Gaps({ gaps, release }: { gaps: string[] | null; release: string | null }) {
  if (gaps === null) return <Absent testId="step-gaps-not-served">The gaps were not served, so whether this step has one is not known.</Absent>;
  return (
    <div className="space-y-1" data-testid="step-gaps" data-gap-count={gaps.length}>
      <p className="text-[12px] font-medium text-foreground">
        {gaps.length === 0 ? "No gap is recorded on this step." : `${gaps.length} gap${gaps.length === 1 ? "" : "s"} recorded on this step`}
        {release === "AUDIT_INCOMPLETE" && gaps.length > 0 && (
          <span className="font-normal text-muted-foreground"> -- these keep its release incomplete</span>
        )}
      </p>
      {release === "AUDIT_INCOMPLETE" && gaps.length === 0 && (
        <Absent testId="step-incomplete-without-gaps">Its release is incomplete, and the record names no gap for it.</Absent>
      )}
      {gaps.length > 0 && (
        <ul className="space-y-1">
          {gaps.map((gap, index) => (
            <li key={index} className="text-[12px]" data-gap={gap}>
              <span className="text-amber-400" data-testid="gap-words">{gapInWords(gap)}</span>{" "}
              <code className="break-all font-mono text-[11px] text-muted-foreground">{gap}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Restrictions({ restrictions }: { restrictions: string[] | null }) {
  if (restrictions === null) return <Absent testId="step-restrictions-not-served">The restrictions were not served.</Absent>;
  if (restrictions.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground" data-testid="step-restrictions" data-restriction-count={0}>
        No restriction is recorded on this step.
      </p>
    );
  }
  return (
    <ul className="space-y-1" data-testid="step-restrictions" data-restriction-count={restrictions.length}>
      {restrictions.map((one, index) => (
        <li key={index} className="text-[12px] text-foreground" data-restriction={one}>
          Restriction: {one}
        </li>
      ))}
    </ul>
  );
}

function CoverageFacts({ coverage }: { coverage: RecoveryCoverage | null }) {
  if (coverage === null) return <Absent testId="step-coverage-not-served">The coverage this step rests on was not served.</Absent>;
  const complete = coverage.complete;
  return (
    <div className="space-y-1" data-testid="step-coverage" data-coverage-complete={complete === null ? "" : String(complete)}>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <Chip tone={complete === true ? "neutral" : "caution"} testId="coverage-standing">
          {complete === true ? "Coverage complete" : complete === false ? "Coverage incomplete" : "whether coverage is complete was not said"}
        </Chip>
        <span className="text-muted-foreground">
          observed <Count value={coverage.observedSources} /> of <Count value={coverage.requiredSources} /> required sources
        </span>
      </div>
      {coverage.declaredGaps === null ? (
        <Absent>The gaps the coverage declares were not served.</Absent>
      ) : (
        coverage.declaredGaps.map((gap, index) => (
          <p key={index} className="text-[12px] text-amber-400" data-testid="coverage-declared-gap">
            Declared coverage gap: {(gap.kind ?? "kind not served").replace(/_/g, " ")}, at {gap.subject ?? "no subject served"}
            {gap.detail ? ` (${gap.detail})` : ""}
            {gap.start || gap.end ? ` from ${gap.start ?? "?"} to ${gap.end ?? "?"}` : ""}
          </p>
        ))
      )}
      {coverage.missing !== null &&
        Object.entries(coverage.missing).map(([source, left]) => (
          <p key={source} className="text-[12px] text-amber-400" data-testid="coverage-missing">
            Not observed: {source}
            {left.map((one) => ` from ${one.start ?? "?"} to ${one.end ?? "?"}`).join(";")}
          </p>
        ))}
      {coverage.unknownInventory !== null &&
        coverage.unknownInventory.map((source) => (
          <p key={source} className="text-[12px] text-amber-400" data-testid="coverage-unknown-inventory">
            Unknown inventory: {source}
          </p>
        ))}
      {coverage.sources !== null && coverage.sources.length > 0 && (
        <p className="text-[12px] text-muted-foreground" data-testid="coverage-sources">
          Required sources:{" "}
          {coverage.sources
            .map((one) => `${one.source ?? "source not named"} (${one.kind ?? "kind not served"}) from ${one.start ?? "?"} to ${one.end ?? "?"}`)
            .join("; ")}
        </p>
      )}
    </div>
  );
}

/** A step's residual uncertainty: every item, in words, with every source it names. */
function Uncertainty({ items }: { items: ResidualUncertainty[] | null }) {
  if (items === null) return <Absent testId="step-uncertainty-not-served">The residual uncertainty was not served.</Absent>;
  if (items.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground" data-testid="step-uncertainty" data-uncertainty-count={0}>
        No residual uncertainty is recorded on this step.
      </p>
    );
  }
  return (
    <ul className="space-y-1" data-testid="step-uncertainty" data-uncertainty-count={items.length}>
      {items.map((item, index) => (
        <li key={index} className="space-y-0.5 text-[12px]" data-uncertainty={item.statement ?? ""}>
          <span className="text-foreground" data-testid="uncertainty-words">
            {item.statement === null ? <Absent>no statement served</Absent> : uncertaintyInWords(item.statement)}
          </span>
          <div className="text-muted-foreground" data-testid="uncertainty-sources">
            {item.sources === null ? (
              <Absent>its sources were not served</Absent>
            ) : item.sources.length === 0 ? (
              <Absent>it names no source</Absent>
            ) : (
              <>
                {item.sources.length === 1 ? "Source: " : "Sources: "}
                {item.sources.map((source, at) => (
                  <span key={at} data-source={`${source.kind ?? ""}:${source.ref ?? ""}`}>
                    {at > 0 ? "; " : ""}
                    {source.kind ?? "kind not served"} <code className="break-all font-mono">{source.ref ?? "no reference"}</code>
                  </span>
                ))}
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Heading({ children }: { children: string }) {
  return <p className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>;
}

/**
 * One step: its state with the acceptance beside it, what supports it, and what it does not settle.
 * `incidentScope` is the incident's own scope block, for the revision the scope is at now.
 *
 * Never a look of standing on a step the scope keeps back. Athena-Backend already serves such a step with the
 * state it was at before and an incomplete release. Should a step still be served as reached, or with an
 * allowed release, beside a scope gap -- or beside scope gaps that were not served or could not be read whole
 * -- it is not drawn so here: the state is marked as not standing and the release as not read as allowed.
 */
export function StepBody({ step, now, incidentScope }: { step: RecoveryStep; now: number; incidentScope?: IncidentScope }) {
  const standing = scopeStanding(step);
  const against = standing === "kept_back" || standing === "not_known";
  return (
    <div className="space-y-2" data-recovery-step={step.version ?? ""} data-step-state={step.state ?? ""}>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-mono text-muted-foreground">
          {step.version === null ? "step (no version served)" : `step ${step.version}`}
        </span>
        <RecoveryStateChip state={step.state} notStanding={against && step.state !== null && REACHED.has(step.state)} />
        {against && step.release === "PASS" ? (
          <span data-testid="step-release" data-release={step.release} data-release-standing="false">
            <Chip tone="caution">
              {standing === "kept_back"
                ? "Release: not read as allowed while the scope keeps this step back"
                : "Release: not read as allowed while what the scope says of this step is not known"}
            </Chip>
          </span>
        ) : (
          <ReleaseChip release={step.release} />
        )}
        <ScopeStandingChip step={step} />
      </div>
      <StepScopeFacts step={step} incident={incidentScope} releaseInWords={releaseInWords} />
      <AcceptanceLine step={step} now={now} />
      {step.reopens && (
        <Fact label="Reopens step">
          <code className="font-mono text-[11px]">{step.reopens}</code>
        </Fact>
      )}
      <Heading>Conditions, each with its witness</Heading>
      <Conditions conditions={step.conditions} />
      <Gaps gaps={step.gaps} release={step.release} />
      <Restrictions restrictions={step.restrictions} />
      <Heading>Coverage it rests on</Heading>
      <CoverageFacts coverage={step.coverage} />
      <Heading>Residual uncertainty</Heading>
      <Uncertainty items={step.residualUncertainty} />
      <Fact label="Recorded">
        <When iso={step.recordedAt} /> <span className="text-muted-foreground">by</span>{" "}
        {step.recordedBy ?? <Absent>someone no longer on record</Absent>}
      </Fact>
    </div>
  );
}

// ---- one incident ----

/** The step the record names as current, or why there is none to show. */
function currentStep(incident: RecoveryIncident): { step: RecoveryStep | null; why: string | null } {
  if (incident.current === null) {
    return incident.steps.length === 0
      ? { step: null, why: "No step is recorded for this incident." }
      : { step: null, why: "The record names no current step." };
  }
  const named = incident.current.version;
  const step = incident.steps.find((one) => one.version !== null && one.version === named) ?? null;
  return step ? { step, why: null } : { step: null, why: `The current step the record names (${named ?? "no version"}) is not among the steps served.` };
}

export function IncidentCard({ incident, deployment, now, alone = false }: {
  incident: RecoveryIncident;
  deployment: string;
  now: number;
  alone?: boolean;
}) {
  const { step, why } = currentStep(incident);
  const count = incident.steps.length;
  return (
    <li className="space-y-3 rounded-md border border-border/50 bg-surface-1/40 p-3" data-testid="incident" data-incident={incident.finding ?? ""}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[13px] font-medium text-foreground" data-testid="incident-title">
          {incident.title ?? <Absent>no title served</Absent>}
        </span>
        <span className="text-[12px] text-muted-foreground">
          severity {incident.severity ?? <Absent>not served</Absent>}
        </span>
        <code className="break-all font-mono text-[11px] text-muted-foreground">{incident.finding ?? "no finding id served"}</code>
      </div>
      <IncidentScopeSummary incident={incident} deployment={deployment} />
      <div className="space-y-2" data-testid="incident-current">
        <p className="text-[12px] text-muted-foreground">Current step</p>
        {step ? <StepBody step={step} now={now} incidentScope={incident.scope} /> : <Absent testId="incident-no-current">{why}</Absent>}
      </div>
      <OnDemand label={`the ${count} recorded step${count === 1 ? "" : "s"}, oldest first`} testId="incident-steps">
        {() => (
          <ol className="space-y-3">
            {incident.steps.map((one, index) => (
              <li key={one.ref ?? index} className="rounded-md border border-border/40 p-2" data-testid="history-step">
                <StepBody step={one} now={now} incidentScope={incident.scope} />
              </li>
            ))}
          </ol>
        )}
      </OnDemand>
      {!alone && incident.finding && (
        <Link
          href={`/authority/recovery?deployment=${encodeURIComponent(deployment)}&finding=${encodeURIComponent(incident.finding)}`}
          className="text-[12px] text-primary hover:underline"
          data-testid="incident-alone"
        >
          Open this incident on its own
        </Link>
      )}
    </li>
  );
}

// ---- the reads ----

/** Whether a read was answered not found: the backend's 404 (a deployment or finding not yours to read, or none). */
function notFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function NotFound({ what }: { what: "deployment" | "finding" }) {
  return (
    <div
      className="space-y-1 rounded-md border border-dashed border-border/70 bg-surface-1/40 px-3 py-2 text-[12px]"
      data-testid="recovery-not-found"
      data-not-found={what}
    >
      <p className="font-medium text-foreground">Not found.</p>
      <p className="text-muted-foreground">
        {`Athena-Backend answers that it has no such ${what} for you. It answers a ${what} you may not read exactly as one that does not exist, and a backend without the recovery-record routes answers the same. This is not an empty record: nothing of this ${what}'s recovery was read.`}
      </p>
    </div>
  );
}

function OtherDeployment({ served: answered }: { served: string | null }) {
  return (
    <p className="text-[12px]" data-testid="recovery-other-deployment">
      <Absent>Athena-Backend answered this read for another deployment ({answered}), so it is not shown here.</Absent>
    </p>
  );
}

/** Below the last page read: how many incidents are shown, how many more are recorded, and the read of the next page. */
function RecoveryFooter({ page, offset, onMore }: { page: RecoveryRecords; offset: number; onMore: (next: number) => void }) {
  const shown = offset + page.incidents.length;
  const count = page.incidentCount;
  const more = count !== null && count > shown ? count - shown : null;
  const next = nextOffset(offset, page);
  return (
    <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground" data-testid="recovery-footer">
      <span data-testid="recovery-shown">
        {count === null
          ? `Showing ${shown} incident${shown === 1 ? "" : "s"}; how many are recorded was not said.`
          : `Showing ${shown} of ${count} incident${count === 1 ? "" : "s"}.`}
      </span>
      {more !== null && (
        <span className="font-medium text-amber-400" data-testid="recovery-not-loaded">
          {`${more} more ${more === 1 ? "is" : "are"} recorded and not loaded.`}
        </span>
      )}
      {next !== null && (
        <button
          type="button"
          data-testid="recovery-load-more"
          className="rounded-md bg-primary/15 px-3 py-1 text-[12px] font-medium text-primary hover:bg-primary/25"
          onClick={() => onMore(next)}
        >
          Load more
        </button>
      )}
      {next === null && page.truncated === true && (
        <Absent testId="recovery-no-next">More are recorded than shown, and this page does not say where the next one starts.</Absent>
      )}
      {page.truncated === null && <Absent testId="recovery-truncation-not-said">Whether more are recorded was not said.</Absent>}
    </div>
  );
}

/** One page of a deployment's incidents, read when its slot is drawn. */
function IncidentPage({ deployment, slot }: { deployment: string; slot: PageSlot }) {
  const query = useQuery<RecoveryRecords>({
    queryKey: [`/api/assurance/deployments/${encodeURIComponent(deployment)}/recovery-records`, { offset: slot.offset }],
  });
  if (query.isError && notFound(query.error)) return <NotFound what="deployment" />;
  const source = served(query);
  if (source.state !== "ready") {
    return <NotInHand source={source} what={slot.offset === 0 ? "the recovery records" : "more of the recovery records"} />;
  }
  const page = source.data;
  if (!answeredFor(page.deployment, deployment)) return <OtherDeployment served={page.deployment} />;
  const now = Date.now();
  return (
    <div className="space-y-3" data-recovery-page={slot.offset}>
      {slot.offset === 0 && page.incidents.length === 0 && page.incidentCount === 0 && (
        <p className="text-[12px] text-muted-foreground" data-testid="recovery-empty">
          Athena-Backend records no recovery record for any finding of this deployment. A finding without one is not listed
          here, and its absence says nothing about that finding&apos;s recovery.
        </p>
      )}
      {page.incidents.length > 0 && (
        <ul className="space-y-3">
          {page.incidents.map((incident, index) => (
            <IncidentCard key={incident.finding ?? `at-${slot.offset + index}`} incident={incident} deployment={deployment} now={now} />
          ))}
        </ul>
      )}
      {slot.last && <RecoveryFooter page={page} offset={slot.offset} onMore={slot.onMore} />}
    </div>
  );
}

/** One incident's record, read by its finding. */
function FindingRecovery({ deployment, finding }: { deployment: string; finding: string }) {
  const query = useQuery<FindingRecoveryRecord>({
    queryKey: [`/api/assurance/findings/${encodeURIComponent(finding)}/recovery-record`],
  });
  if (query.isError && notFound(query.error)) return <NotFound what="finding" />;
  const source = served(query);
  if (source.state !== "ready") return <NotInHand source={source} what="this incident's recovery record" />;
  const record = source.data;
  if (!answeredFor(record.deployment, deployment)) return <OtherDeployment served={record.deployment} />;
  if (record.steps.length === 0 && record.current === null) {
    return (
      <p className="text-[12px] text-muted-foreground" data-testid="recovery-empty">
        Athena-Backend records no recovery step for this finding.
      </p>
    );
  }
  return (
    <ul>
      <IncidentCard incident={record} deployment={deployment} now={Date.now()} alone />
    </ul>
  );
}

export default function RecoveryRecordsScreen({ deployment, finding }: { deployment: string; finding?: string }) {
  return (
    <div className="space-y-4" data-screen="recovery-records">
      <Section
        title={finding ? "One incident's recovery record" : "Recovery records"}
        icon={<LifeBuoy className="h-4 w-4 text-primary" />}
        testId="recovery-section"
      >
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Each incident of this deployment with a recovery record -- a finding Athena-Backend records recovery steps for --
          with its current step and every step before it, oldest first: its state, the conditions that support it and the
          witness of each, every gap and restriction, the coverage it rests on, the residual uncertainty with its sources,
          and the owner&apos;s acceptance as recorded. A state here is one step&apos;s, beside what supports it: no
          incident and no deployment is summed up in one word. Each incident also shows its scope -- what is believed
          affected -- where Athena-Backend reports it: the revision it is at, the revision each step was taken under,
          what about the scope keeps a step back, and every item removed with who removed it and why.
        </p>
        {/* One incident's scope open at a time, on this screen: its read is the only one of its kind in flight. */}
        <OneScopeAtATime>
          {finding ? (
            <>
              <FindingRecovery key={`${deployment}:${finding}`} deployment={deployment} finding={finding} />
              <Link
                href={`/authority/recovery?deployment=${encodeURIComponent(deployment)}`}
                className="text-[12px] text-primary hover:underline"
                data-testid="recovery-all-incidents"
              >
                Every incident of this deployment
              </Link>
            </>
          ) : (
            <HistoryPages key={deployment} page={(slot) => <IncidentPage deployment={deployment} slot={slot} />} />
          )}
        </OneScopeAtATime>
      </Section>
    </div>
  );
}
