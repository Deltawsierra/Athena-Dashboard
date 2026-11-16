/**
 * Observed effects, on the authority chains screen: what Athena-Backend shows of each
 * observed effect's signed record (`effect_reading`, Athena-Backend #234), read from
 * GET /api/assurance/deployments/<uuid>/chain-outcomes/ (through
 * /api/assurance/deployments/:uuid/chain-outcomes on this server). For each record:
 *
 *   - the tool binding its permit was decided for: the tool, its effect, its targets and
 *     their bound, each approval it rests on with that approval's own limit per window
 *     and what was counted under it -- and, where the binding's bound is larger than an
 *     approval's, the backend's named finding in its own words;
 *   - which stage of execution it shows, in the core's word and the core's words;
 *   - what is keyed: a version 5 record names its action, its answer and its targets by
 *     keyed references only the holder of the engine's key can compute. Each is labelled
 *     "keyed" with the backend's words for what it can check ("keyed: not checkable
 *     here") and the id of the key; its value is never drawn, so nothing here reads as a
 *     hash a person could compare. An older record's plain digests are withheld from this
 *     reader, and said to be.
 *
 * NOT RECORDED IS SAID. A version 1 to 4 record has no binding, no execution field and
 * no keyed reference: each part says "not recorded" beside the core's words the backend
 * serves for it ("no tool binding recorded", "accepted, from the recorded 2xx; this
 * version has no execution field", "plain digests: withheld from this reader"). A part
 * the backend did not serve says "not served"; one it served in a shape that cannot be
 * read says so; a row that cannot be read is counted (parts.tsx UnreadableRows). A
 * backend from before #234 serves no reading at all: each record says it is not
 * reported by this backend, never that there is nothing to show.
 *
 * Every string here came from the backend's record and is drawn as text by the app's own
 * runtime, which marks any character that hides or reorders text (lib/hiddenChars.ts).
 *
 * OFF THE STOP PATH. Nothing here writes. The read is one GET with the screen, beside the
 * chains' own read and never before it: the chains are drawn without it. A left screen
 * cancels it (lib/queryClient.ts), and this console's server cuts it at the read deadline
 * (server/read-deadline.ts). Every Stop and the failsafe console are elsewhere and read
 * none of this.
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import {
  BINDING_BOUND_OVER_APPROVAL,
  EXECUTION_STATES,
  WITHHELD_PLAIN_DIGEST,
  effectVersionOf,
  isObservedEffect,
  type BindingApproval,
  type BindingFinding,
  type ChainOutcomeRow,
  type ChainOutcomes,
  type EffectExecution,
  type EffectReading,
  type EffectReference,
  type KeyedUnder,
  type ToolBinding,
  type WindowCount,
} from "@shared/observed-effect";
import { Absent, Chip, Count, Fact, NotInHand, NotServed, Section, UnreadableRows, When, served, toolKindLabel, unreadableIn, type Tone } from "./parts";

// ---- what stands where a value is not ----

type HoldsFields = { unreadableFields?: string[] };

/** A part served in a shape that cannot be read: said, in caution, never drawn as absent or as a value. */
function CouldNotBeRead({ testId }: { testId?: string }) {
  return (
    <span data-unreadable="true" data-testid={testId} className="text-amber-400">
      could not be read
    </span>
  );
}

/** What stands in a part's place when it has no value: it could not be read, or it was not served. */
function Missing({ from, field, testId }: { from: HoldsFields; field: string; testId?: string }) {
  return from.unreadableFields?.includes(field) ? <CouldNotBeRead testId={testId} /> : <Absent testId={testId}>not served</Absent>;
}

/** A word or sentence as served, or what stands in its place. */
function Served({ value, from, field, testId, code = false }: { value: string | null; from: HoldsFields; field: string; testId?: string; code?: boolean }) {
  if (value === null) return <Missing from={from} field={field} testId={testId} />;
  return code ? (
    <code data-testid={testId} className="font-mono text-[12px] text-foreground">{value}</code>
  ) : (
    <span data-testid={testId} className="text-foreground">{value}</span>
  );
}

/** A count as served, or what stands in its place: never a zero nobody counted. */
function Num({ value, from, field, testId }: { value: number | null; from: HoldsFields; field: string; testId?: string }) {
  if (value === null) return <Missing from={from} field={field} testId={testId} />;
  return <Count value={value} testId={testId} />;
}

// ---- what is keyed ----

/** The core's words for a keyed reference, used where the record's own words are not served. */
const KEYED_NOT_CHECKABLE = "keyed: not checkable here";

/**
 * How a record refers to something. A keyed reference is labelled "keyed", with the
 * backend's words for what it can check and the key it is under; its value is not
 * drawn (the server does not even relay it). A withheld one says so in the backend's
 * words. One in a form not known here is not drawn either.
 */
function Reference({
  name, reference, reading, from, field, under,
}: {
  name: string;
  reference: EffectReference | undefined;
  reading: EffectReading;
  from: HoldsFields;
  field: string;
  /** The key it is under, where the record names the one its references are keyed under. */
  under?: KeyedUnder | null;
}) {
  if (reference === undefined) return <Missing from={from} field={field} testId="reference-missing" />;
  if (reference.form === "keyed") {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-x-1.5" data-testid="keyed-reference" data-ref={name}>
        <Chip tone="neutral">keyed</Chip>{" "}
        <span className="text-foreground">{reading.digests ?? KEYED_NOT_CHECKABLE}</span>
        {under && under.chainKey !== null && (
          <span className="text-muted-foreground">{" "}
            under key id <code className="font-mono text-[11px]">{under.chainKey}</code>
          </span>
        )}
      </span>
    );
  }
  if (reference.form === "withheld") {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-x-1.5" data-testid="withheld-reference" data-ref={name} data-why={reference.why}>
        <Chip tone="caution">withheld</Chip>{" "}
        {reference.why === WITHHELD_PLAIN_DIGEST ? (
          <Served value={reading.digestsServed} from={reading} field="digestsServed" />
        ) : (
          <span className="text-foreground">
            {reference.why ? `withheld (${reference.why}): what it refers to is not known` : "withheld, for a reason not in a form read here: what it refers to is not known"}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5" data-testid="unrecognised-reference" data-ref={name}>
      <Chip tone="caution">not read</Chip>{" "}
      <span className="text-foreground">served in a form this console does not read: not shown, and not checkable here</span>
    </span>
  );
}

function KeyedUnderView({ reading }: { reading: EffectReading }) {
  const under = reading.keyedUnder;
  if (under === undefined) return <Missing from={reading} field="keyedUnder" testId="effect-keyed-under" />;
  if (under === null) {
    return <Absent testId="effect-keyed-under">not recorded: {reading.digests ?? "the backend did not say how this record refers to its action"}</Absent>;
  }
  return (
    <span data-testid="effect-keyed-under" className="text-foreground">
      chain <Served value={under.chain} from={under} field="chain" code />, key id <Served value={under.chainKey} from={under} field="chainKey" code />
      <span className="text-muted-foreground"> (the id names the engine&apos;s key and holds nothing of it)</span>
    </span>
  );
}

// ---- execution ----

/** How an execution state reads. Never positive: a record shows what was witnessed, not that all went to plan. */
const EXECUTION_TONE: Record<string, Tone> = { denied: "critical", failed: "critical", partial: "caution", unknown: "caution" };

function ExecutionView({ reading }: { reading: EffectReading }) {
  const execution: EffectExecution | undefined = reading.execution;
  if (execution === undefined) return <Missing from={reading} field="execution" testId="effect-execution" />;
  const state = execution.state;
  const known = state !== null && (EXECUTION_STATES as readonly string[]).includes(state);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5" data-testid="effect-execution" data-state={state ?? ""}>
      {state === null ? (
        <Missing from={execution} field="state" testId="effect-execution-state" />
      ) : (
        <Chip tone={known ? EXECUTION_TONE[state] ?? "neutral" : "neutral"} testId="effect-execution-state">
          {known ? state : `not recognised here: ${state}`}
        </Chip>
      )}
      <span className="text-muted-foreground">basis</span>
      <Served value={execution.basis} from={execution} field="basis" testId="effect-execution-basis" code />
      <span className="text-muted-foreground">:</span>
      <Served value={execution.words} from={execution} field="words" testId="effect-execution-words" />
    </span>
  );
}

// ---- the tool binding ----

/** An approval's limit per window: as served, that it names none, or what stands in its place. */
function Limit({ approval }: { approval: BindingApproval }) {
  if (approval.maxTargets === undefined || approval.windowS === undefined) {
    const field = approval.maxTargets === undefined ? "maxTargets" : "windowS";
    return <Missing from={approval} field={field} testId="approval-limit" />;
  }
  if (approval.maxTargets === null && approval.windowS === null) return <Absent testId="approval-limit">names no limit per window</Absent>;
  return (
    <span data-testid="approval-limit" className="text-foreground">
      at most {approval.maxTargets ?? "(not served)"} targets per {approval.windowS ?? "(not served)"} s
    </span>
  );
}

function Counted({ approval }: { approval: BindingApproval }) {
  const counted: WindowCount | null | undefined = approval.counted;
  if (counted === undefined) return <Missing from={approval} field="counted" testId="approval-counted" />;
  if (counted === null) return <Absent testId="approval-counted">no count recorded</Absent>;
  return (
    <span data-testid="approval-counted" className="text-foreground">
      this dispatch counted <Num value={counted.counted} from={counted} field="counted" /> target(s); the window&apos;s count after
      it <Num value={counted.windowCount} from={counted} field="windowCount" />; the approval&apos;s lifetime count after it{" "}
      <Num value={counted.lifetimeCount} from={counted} field="lifetimeCount" />; rested on an earlier count of its own (a
      retry):{" "}
      {counted.rested === null ? <Missing from={counted} field="rested" /> : <span>{counted.rested ? "yes" : "no"}</span>}
    </span>
  );
}

/** A finding in the backend's words: its code and its sentence. */
function FindingLine({ finding, testId }: { finding: BindingFinding; testId: string }) {
  return (
    <p className="text-[12px] text-amber-400" data-testid={testId} data-code={finding.code ?? ""}>
      <code className="font-mono">{finding.code ?? "no code served"}</code>:{" "}
      {finding.detail === null ? <Missing from={finding} field="detail" /> : finding.detail}
    </p>
  );
}

function ApprovalRow({ approval, reading, findings }: { approval: BindingApproval; reading: EffectReading; findings: BindingFinding[] }) {
  const own = findings.filter((finding) => finding.approval !== null && finding.approval === approval.approval);
  return (
    <li className="space-y-0.5 rounded-md border border-border/40 p-1.5" data-testid="binding-approval" data-approval={approval.approval ?? ""}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
        <span className="text-muted-foreground">approval</span>
        <Served value={approval.approval} from={approval} field="approval" testId="approval-id" code />
        <span className="text-muted-foreground">effect</span>
        <Served value={approval.effect} from={approval} field="effect" testId="approval-effect" />
      </div>
      <Fact label="Its population">
        <Num value={approval.targetCount} from={approval} field="targetCount" testId="approval-target-count" /> target(s),{" "}
        <Reference name="approval-targets" reference={approval.targets} reading={reading} from={approval} field="targets" under={reading.keyedUnder} />
      </Fact>
      <Fact label="Its limit per window">
        <Limit approval={approval} />
      </Fact>
      <Fact label="Counted under it">
        <Counted approval={approval} />
      </Fact>
      {own.map((finding, i) => (
        <FindingLine key={`${finding.code}-${i}`} finding={finding} testId="approval-finding" />
      ))}
    </li>
  );
}

function BindingView({ reading }: { reading: EffectReading }) {
  const binding: ToolBinding | null | undefined = reading.toolBinding;
  const words = (
    <Served value={reading.toolBindingReading} from={reading} field="toolBindingReading" testId="effect-binding-reading" />
  );
  if (binding === undefined) {
    return (
      <span data-testid="effect-binding" data-binding="missing">
        <Missing from={reading} field="toolBinding" /> <span className="text-muted-foreground">(the backend reads it as:</span> {words}
        <span className="text-muted-foreground">)</span>
      </span>
    );
  }
  if (binding === null) {
    return (
      <span data-testid="effect-binding" data-binding="not-recorded">
        <Absent testId="effect-binding-not-recorded">not recorded:</Absent> {words}
      </span>
    );
  }
  const findings = reading.findings ?? [];
  const approvals = binding.approvals;
  return (
    <div className="space-y-1" data-testid="effect-binding" data-binding="recorded">
      <Fact label="Reads">{words}</Fact>
      <Fact label="Tool">
        <span className="text-foreground" data-testid="effect-binding-tool">
          <span className="text-muted-foreground">{binding.kind === null ? <Missing from={binding} field="kind" /> : toolKindLabel(binding.kind)}</span>{" "}
          <Served value={binding.identifier} from={binding} field="identifier" code />
        </span>
      </Fact>
      <Fact label="Its effect">
        <Served value={binding.effect} from={binding} field="effect" testId="effect-binding-effect" />
      </Fact>
      <Fact label="Targets, and the binding's bound">
        <span data-testid="effect-binding-targets">
          <Num value={binding.targetCount} from={binding} field="targetCount" /> of a bound of{" "}
          <Num value={binding.maxTargets} from={binding} field="maxTargets" />
        </span>
      </Fact>
      <Fact label="Its targets">
        <Reference name="targets" reference={binding.targets} reading={reading} from={binding} field="targets" under={reading.keyedUnder} />
      </Fact>
      <Fact label="Registry generation">
        <Reference name="generation" reference={binding.generation} reading={reading} from={binding} field="generation" />
      </Fact>
      <div className="space-y-1">
        <span className="text-[12px] text-muted-foreground">Approvals it rests on</span>
        {approvals === undefined ? (
          <p className="text-[12px]"><Missing from={binding} field="approvals" testId="binding-approvals-missing" /></p>
        ) : approvals.length === 0 && unreadableIn(binding, "approvals") === 0 ? (
          <p className="text-[12px]"><Absent testId="binding-no-approvals">it rests on no approval</Absent></p>
        ) : (
          <ul className="space-y-1">
            {approvals.map((approval, i) => (
              <ApprovalRow key={`${approval.approval ?? ""}-${i}`} approval={approval} reading={reading} findings={findings} />
            ))}
          </ul>
        )}
        <UnreadableRows from={binding} list="approvals" label="approvals" />
      </div>
    </div>
  );
}

// ---- the findings ----

function FindingsView({ reading }: { reading: EffectReading }) {
  const findings = reading.findings;
  if (findings === undefined) return <Missing from={reading} field="findings" testId="effect-findings-missing" />;
  const unread = unreadableIn(reading, "findings");
  return (
    <div className="space-y-0.5" data-testid="effect-findings">
      {findings.length === 0 && unread === 0 &&
        (reading.toolBinding ? (
          <Absent testId="effect-no-finding">the backend names no finding on this binding</Absent>
        ) : (
          <Absent testId="effect-no-finding">none to name: no binding is recorded</Absent>
        ))}
      {findings.map((finding, i) => (
        <FindingLine key={`${finding.code}-${i}`} finding={finding} testId="effect-finding" />
      ))}
      <UnreadableRows from={reading} list="findings" label="findings" />
    </div>
  );
}

// ---- one record ----

/** A field's name here as a reader says it: "toolBindingReading" is "tool binding reading". */
function fieldWords(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

export function EffectReadingView({ reading }: { reading: EffectReading }) {
  const version = effectVersionOf(reading.schema);
  const named = reading.findings?.length ?? 0;
  return (
    <div className="space-y-1.5" data-testid="effect-reading" data-version={version ?? ""}>
      {named > 0 && (
        <p className="text-[12px] text-amber-400" data-testid="effect-findings-named">
          The backend names {named === 1 ? "a finding" : `${named} findings`} on this record&apos;s tool binding: see below.
        </p>
      )}
      <Fact label="Record">
        <Served value={reading.schema} from={reading} field="schema" testId="effect-schema" code />
        {reading.schema !== null && (
          <span className="text-muted-foreground" data-testid="effect-version">
            {version === null ? "a schema not read here as a version" : `version ${version}`}
          </span>
        )}
      </Fact>
      <Fact label="Execution">
        <ExecutionView reading={reading} />
      </Fact>
      <div className="space-y-1 text-[12px]">
        <span className="text-muted-foreground">Tool binding</span>
        <BindingView reading={reading} />
      </div>
      <Fact label="How it names its action and its answer">
        <Served value={reading.digests} from={reading} field="digests" testId="effect-digests" />
      </Fact>
      <Fact label="Its action">
        <Reference name="action" reference={reading.actionReference} reading={reading} from={reading} field="actionReference" under={reading.keyedUnder} />
      </Fact>
      <Fact label="Its answer">
        <Reference name="response" reference={reading.responseReference} reading={reading} from={reading} field="responseReference" under={reading.keyedUnder} />
      </Fact>
      <Fact label="Keyed under">
        <KeyedUnderView reading={reading} />
      </Fact>
      <p className="text-[11px] text-muted-foreground" data-testid="effect-keyed-note">
        A keyed value is never shown here: only the holder of the engine&apos;s key can compute it, and nothing on this screen
        can check one.
      </p>
      <div className="space-y-0.5 text-[12px]">
        <span className="text-muted-foreground">Findings on its binding</span>
        <FindingsView reading={reading} />
      </div>
      {reading.unreadableFields && reading.unreadableFields.length > 0 && (
        <p className="text-[12px] text-amber-400" data-testid="effect-unreadable-fields">
          Served in a shape that could not be read: {reading.unreadableFields.map(fieldWords).join(", ")}
        </p>
      )}
    </div>
  );
}

const STATUS_TONE: Record<string, Tone> = { violated: "critical", incomplete: "caution", not_demonstrated: "caution" };

function ReadingAsServed({ row }: { row: ChainOutcomeRow }) {
  switch (row.effect.served) {
    case "reading":
      return <EffectReadingView reading={row.effect.reading} />;
    case "not_reported":
      return (
        <NotServed testId="effect-not-reported">
          This record&apos;s reading (its tool binding, its execution and what is keyed) is not reported by this backend. The
          record may carry all three: this backend does not say.
        </NotServed>
      );
    case "none":
      return (
        <p className="text-[12px] text-amber-400" data-testid="effect-no-reading">
          Athena-Backend serves no reading of this record: it holds no evidence document for it that matches its signed
          digest, so what it was bound to, how far it went and what is keyed are not known.
        </p>
      );
    default:
      return (
        <p className="text-[12px] text-amber-400" data-testid="effect-reading-unreadable">
          This record&apos;s reading was served in a shape that could not be read.
        </p>
      );
  }
}

export function ObservedEffectCard({ row }: { row: ChainOutcomeRow }) {
  return (
    <li
      className="space-y-2 rounded-lg border border-border/60 bg-surface-1/30 p-3"
      data-testid="observed-effect"
      data-outcome={row.outcomeId ?? ""}
      data-effect-served={row.effect.served}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">
          {row.workflow ? <code className="font-mono text-[12px]">{row.workflow}</code> : <Absent>no workflow named</Absent>}{" "}
          <span className="text-muted-foreground">outcome</span>{" "}
          {row.outcomeId ? <code className="font-mono text-[12px]">{row.outcomeId}</code> : <Absent>no id served</Absent>}
        </h3>
        <Chip tone={STATUS_TONE[row.status] ?? "neutral"} testId="effect-status">
          {row.statusLabel ?? (row.status || "no status served")}
        </Chip>
      </div>
      <div className="grid gap-1 md:grid-cols-2">
        <Fact label="Signed by">
          {row.observerEngine ? <span className="text-foreground">{row.observerEngine}</span> : <Absent>not said</Absent>}
        </Fact>
        <Fact label="Kind of evidence">
          {row.evidenceKindLabel ?? row.evidenceKind ?? <Absent>not said</Absent>}
        </Fact>
        <Fact label="Effect observed at">
          <When iso={row.observedAt} />
        </Fact>
        <Fact label="Recorded at">
          <When iso={row.recordedAt} />
        </Fact>
      </div>
      <ReadingAsServed row={row} />
    </li>
  );
}

// ---- the section ----

/** Whether an answer is the shape this console's server sends: anything else is said, never drawn as none. */
export function isChainOutcomes(data: unknown): data is ChainOutcomes {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const outcomes = (data as { outcomes?: unknown }).outcomes;
  return Array.isArray(outcomes) && outcomes.every((row) => {
    const effect = row !== null && typeof row === "object" ? (row as { effect?: unknown }).effect : null;
    return effect !== null && typeof effect === "object" && typeof (effect as { served?: unknown }).served === "string";
  });
}

function EffectsSection({ children }: { children: ReactNode }) {
  return (
    <Section title="Observed effects" icon={<Eye className="h-4 w-4 text-primary" />} testId="observed-effects-section">
      <p className="text-[12px] text-muted-foreground">
        What Athena-Backend shows of each observed effect&apos;s signed record: the tool binding its permit was decided for,
        which stage of execution it shows, and what is keyed. Read from the deployment&apos;s newest chain outcomes.
      </p>
      {children}
    </Section>
  );
}

export function ObservedEffectsView({ data }: { data: ChainOutcomes }) {
  const effects = data.outcomes.filter(isObservedEffect);
  const reported = data.outcomes.filter((row) => row.effect.served !== "not_reported").length;
  // Rows that say neither what kind of evidence they are nor carry a reading: any could be an observed effect.
  const unsaid = data.outcomes.filter((row) => row.evidenceKind === null && row.effect.served === "not_reported").length;
  const unread = unreadableIn(data, "outcomes");
  return (
    <EffectsSection>
      <div className="grid gap-1 md:grid-cols-3">
        <Fact label="Chain outcomes read">
          <Count value={data.returned} testId="effects-returned" />
        </Fact>
        <Fact label="Recorded">
          <Count value={data.recordedCount} testId="effects-recorded" />
        </Fact>
        <Fact label="Observed effects among them">
          <Count value={effects.length} testId="effects-count" />
        </Fact>
      </div>
      {data.truncated === true && (
        <p className="text-[12px] text-amber-400" data-testid="effects-truncated">
          Showing the observed effects among the newest {data.returned ?? "few"} of {data.recordedCount ?? "more"} chain outcomes:
          the backend returns at most {data.pageSize ?? "a page"} at a time.
        </p>
      )}
      {data.outcomes.length > 0 && reported === 0 && (
        <NotServed testId="effects-not-reported">
          An observed effect&apos;s reading (its tool binding, its execution and what is keyed) is not reported by this backend.
          Each record below says so; none is read as having nothing to show.
        </NotServed>
      )}
      {unsaid > 0 && (
        <NotServed testId="effects-kind-not-said">
          Chain outcomes that name no kind of evidence and carry no reading: {unsaid}. Any of them may be an observed effect
          this backend does not report.
        </NotServed>
      )}
      {effects.length === 0 && unread === 0 && unsaid === 0 ? (
        <p className="text-[13px]" data-testid="no-observed-effects">
          <Absent>
            {data.outcomes.length === 0
              ? "No chain outcome is among those read for this deployment."
              : "No observed effect is among the chain outcomes read."}
          </Absent>
        </p>
      ) : (
        <ul className="space-y-3">
          {effects.map((row, i) => (
            <ObservedEffectCard key={`${row.uuid}-${i}`} row={row} />
          ))}
        </ul>
      )}
      <UnreadableRows from={data} list="outcomes" label="chain outcomes" />
    </EffectsSection>
  );
}

/** The observed effects of a deployment, read once with the screen and drawn beside the chains. Nothing waits on it. */
export function ObservedEffectsSection({ deployment }: { deployment: string }) {
  const source = served(
    useQuery<unknown>({ queryKey: [`/api/assurance/deployments/${encodeURIComponent(deployment)}/chain-outcomes`] }),
  );
  if (source.state !== "ready") {
    return (
      <EffectsSection>
        <NotInHand source={source} what="the observed effects" />
      </EffectsSection>
    );
  }
  if (!isChainOutcomes(source.data)) {
    return (
      <EffectsSection>
        <p className="text-[13px] text-amber-400" data-testid="effects-answer-unreadable">
          The answer for the observed effects could not be read: none of it is shown, and none of it is read as no effect.
        </p>
      </EffectsSection>
    );
  }
  return <ObservedEffectsView data={source.data} />;
}
