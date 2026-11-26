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
 * EVERY OBSERVED EFFECT CAN BE READ, A PAGE AT A TIME (Athena-Backend #241). The first
 * page is read with the screen; this console's server asks the backend only for the rows
 * recorded as observed effects. "Show more" reads the page after the last one in hand,
 * with the cursor that page gave: ONE PAGE PER PRESS, never the rest by itself. The
 * section says how many are shown of how many the backend counts, and that is all only
 * when the backend says no page follows. A row recorded as an observed effect whose
 * reading the backend serves as null is drawn as that, never dropped and never as an
 * effect in force. A cursor the backend refuses: the list changed, and the first page is
 * offered again. A page that could not be read keeps the rows in hand and offers that
 * page again, once per press; it is never read as the last. A backend that does not page
 * (it serves no `next`): what it gave, as before, and that more may exist.
 *
 * OFF THE STOP PATH. Nothing here writes. Each read is one GET through the app's cache:
 * the first with the screen, beside the chains' own read and never before it (the chains
 * are drawn without it), a later one on a press of this section's own button. A left
 * screen cancels them (lib/queryClient.ts), and this console's server cuts each at the
 * read deadline (server/read-deadline.ts). The buttons here are this section's alone:
 * they share no state, no queue and no lock with any Stop. Every Stop and the failsafe
 * console are elsewhere and read none of this.
 */
import { useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import {
  BAD_CURSOR,
  BINDING_BOUND_OVER_APPROVAL,
  EXECUTION_STATES,
  WITHHELD_PLAIN_DIGEST,
  effectVersionOf,
  isObservedEffect,
  servesPages,
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

/**
 * One row. `recorded`: it was read under the filter, so it was RECORDED AS an observed
 * effect whatever it reads as now. Such a row that is not an observed effect in force
 * (the backend names another kind of evidence for it and serves no reading: its
 * signature no longer checks) is drawn as that, in the backend's own word for it.
 */
export function ObservedEffectCard({ row, recorded = false }: { row: ChainOutcomeRow; recorded?: boolean }) {
  const inForce = isObservedEffect(row);
  return (
    <li
      className="space-y-2 rounded-lg border border-border/60 bg-surface-1/30 p-3"
      data-testid="observed-effect"
      data-outcome={row.outcomeId ?? ""}
      data-effect-served={row.effect.served}
      data-in-force={inForce ? "true" : "false"}
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
        {recorded && !inForce && (
          <Chip tone="caution" testId="effect-not-in-force">recorded as an observed effect: not one in force</Chip>
        )}
      </div>
      <div className="grid gap-1 md:grid-cols-2">
        <Fact label="Signed by">
          {row.observerEngine ? <span className="text-foreground">{row.observerEngine}</span> : <Absent>not said</Absent>}
        </Fact>
        <Fact label={recorded && !inForce ? "Kind of evidence the backend reads it as" : "Kind of evidence"}>
          <span data-testid="effect-kind">{row.evidenceKindLabel ?? row.evidenceKind ?? <Absent>not said</Absent>}</span>
        </Fact>
        <Fact label="Effect observed at">
          <When iso={row.observedAt} />
        </Fact>
        <Fact label="Recorded at">
          <When iso={row.recordedAt} />
        </Fact>
      </div>
      {recorded && !inForce && row.effect.served === "none" ? (
        <p className="text-[12px] text-amber-400" data-testid="effect-recorded-reading-null">
          This row was recorded as an observed effect. Athena-Backend serves its reading as null and reads its evidence as{" "}
          {row.evidenceKindLabel ?? row.evidenceKind ?? "a kind it does not name"}: the signature it was recorded under does
          not check now. It is shown as recorded, and is not an observed effect in force.
        </p>
      ) : (
        <ReadingAsServed row={row} />
      )}
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
        which stage of execution it shows, and what is keyed. Read from the deployment&apos;s chain outcomes, a page at a time.
      </p>
      {children}
    </Section>
  );
}

/** What became of the page after those in hand. */
export type NextPage =
  | { state: "none" }
  | { state: "reading" }
  /** It could not be read (the network, this server, the backend): never the last page. */
  | { state: "failed"; message: string }
  /** The backend refused it as asked (a 400): its code and its words, as served. */
  | { state: "refused"; code: string | null; error: string | null }
  /** A page in hand was read again and no longer leads to the pages read after it. */
  | { state: "changed" };

/** What a press in this section asks for. Each is this section's own, and reads one page. */
export interface WalkActions {
  /** Read the page after the last one in hand, with the cursor that page gave. */
  more?: (next: string) => void;
  /** Read once more the page that could not be read. */
  again?: () => void;
  /** Read again from the first page. */
  fromFirst?: () => void;
}

const BUTTON = "rounded-md bg-primary/15 px-3 py-1 text-[12px] font-medium text-primary hover:bg-primary/25";

/** A refusal's code and words, as served: text, never markup. */
function Refusal({ code, error }: { code: string | null; error: string | null }) {
  return (
    <span data-testid="effects-refusal">
      <code className="font-mono" data-testid="effects-refusal-code">{code ?? "no code served"}</code>:{" "}
      <span data-testid="effects-refusal-error">{error ?? "no reason served"}</span>
    </span>
  );
}

/** A backend that does not page: the newest outcomes it gave, of every kind, as this section always drew them. */
function NotPagedView({ data }: { data: ChainOutcomes }) {
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
      <NotServed testId="effects-not-paged">
        This backend does not page its chain outcomes: what is shown is what it gave, its newest outcomes of every kind, and
        it did not say how many observed effects there are. More observed effects may exist than are shown.
      </NotServed>
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

/**
 * The pages in hand, oldest read first, and what became of the page after them. A
 * backend that pages serves only rows recorded as observed effects: every one is drawn.
 * The counts are the backend's, from the page read last; none is worked out here but
 * the number of rows on the screen.
 */
export function ObservedEffectsView({
  data, later = [], after = { state: "none" }, actions = {},
}: {
  /** The first page. */
  data: ChainOutcomes;
  /** The pages read after it, in order. */
  later?: ChainOutcomes[];
  after?: NextPage;
  actions?: WalkActions;
}) {
  if (!servesPages(data)) return <NotPagedView data={data} />;
  const pages = [data, ...later];
  const last = pages[pages.length - 1];
  const rows = pages.flatMap((page) => page.outcomes);
  const unread = pages.reduce((sum, page) => sum + unreadableIn(page, "outcomes"), 0);
  const notInForce = rows.filter((row) => !isObservedEffect(row)).length;
  const matching = last.matchingCount;
  const nextUnreadable = last.next === undefined;
  const isLast = last.next === null && after.state === "none";
  return (
    <EffectsSection>
      <p className="text-[13px] text-foreground" data-testid="effects-showing" data-shown={rows.length} data-matching={matching ?? ""}>
        {matching === undefined
          ? `Showing ${rows.length} observed ${rows.length === 1 ? "effect" : "effects"}. This backend did not say how many there are.`
          : `Showing ${rows.length} of ${matching} observed ${matching === 1 ? "effect" : "effects"}.`}
      </p>
      <div className="grid gap-1 md:grid-cols-2">
        <Fact label="Chain outcomes recorded in all, of every kind">
          <Count value={last.recordedCount} testId="effects-recorded" />
        </Fact>
        <Fact label="Pages read">
          <Count value={pages.length} testId="effects-pages" />
        </Fact>
      </div>
      {notInForce > 0 && (
        <p className="text-[12px] text-amber-400" data-testid="effects-not-in-force">
          Of those shown, {notInForce} {notInForce === 1 ? "is" : "are"} recorded as an observed effect and not read as one in
          force: each says so.
        </p>
      )}
      {rows.length === 0 && unread === 0 ? (
        <p className="text-[13px]" data-testid="no-observed-effects">
          <Absent>
            {isLast
              ? "No observed effect is recorded for this deployment."
              : "No observed effect is on the pages read."}
          </Absent>
        </p>
      ) : (
        <ul className="space-y-3">
          {pages.map((page, at) => page.outcomes.map((row, i) => (
            <ObservedEffectCard key={`${at}-${row.uuid}-${i}`} row={row} recorded />
          )))}
        </ul>
      )}
      {pages.map((page, at) => (
        <UnreadableRows key={at} from={page} list="outcomes" label={`chain outcomes, page ${at + 1}`} />
      ))}
      <div className="space-y-2" data-testid="effects-walk" data-after={after.state}>
        {after.state === "reading" && (
          <p className="text-[12px] text-muted-foreground" data-testid="effects-next-reading">Reading the next page…</p>
        )}
        {after.state === "failed" && (
          <>
            <p className="text-[12px] text-amber-400" data-testid="effects-next-not-read">
              The next page could not be read: {after.message}. The observed effects above are those read before it; more are
              recorded than are shown.
            </p>
            {actions.again && (
              <button type="button" className={BUTTON} data-testid="effects-read-again" onClick={actions.again}>
                Read that page again
              </button>
            )}
          </>
        )}
        {after.state === "refused" && (
          <>
            {after.code === BAD_CURSOR ? (
              <p className="text-[12px] text-amber-400" data-testid="effects-list-changed">
                The list changed while it was being read: the backend no longer takes this page&apos;s place in it (
                <Refusal code={after.code} error={after.error} />). The observed effects above are those read before; the next
                page was not read.
              </p>
            ) : (
              <p className="text-[12px] text-amber-400" data-testid="effects-next-refused">
                The backend refused the next page as asked (<Refusal code={after.code} error={after.error} />). It is not asked
                again by itself. The observed effects above are those read before it; more may be recorded than are shown.
              </p>
            )}
            {actions.fromFirst && (
              <button type="button" className={BUTTON} data-testid="effects-from-first" onClick={actions.fromFirst}>
                Read again from the first page
              </button>
            )}
          </>
        )}
        {after.state === "changed" && (
          <>
            <p className="text-[12px] text-amber-400" data-testid="effects-list-changed">
              The list changed while it was being read: a page shown above was read again and no longer leads to the pages
              read after it, which are not shown.
            </p>
            {actions.fromFirst && (
              <button type="button" className={BUTTON} data-testid="effects-from-first" onClick={actions.fromFirst}>
                Read again from the first page
              </button>
            )}
          </>
        )}
        {after.state === "none" && typeof last.next === "string" && (
          <>
            <p className="text-[12px] text-muted-foreground" data-testid="effects-more-follow">
              More follow: the backend serves at most {last.pageSize ?? "a page"} at a time. Each press reads one more page.
            </p>
            {actions.more && (
              <button type="button" className={BUTTON} data-testid="effects-show-more" onClick={() => actions.more?.(last.next as string)}>
                Show more
              </button>
            )}
          </>
        )}
        {after.state === "none" && nextUnreadable && (
          <p className="text-[12px] text-amber-400" data-testid="effects-next-unreadable">
            The backend&apos;s word on whether another page follows could not be read: more observed effects may exist than are
            shown, and this is not read as the last page.
          </p>
        )}
        {isLast && (
          <p className="text-[12px] text-muted-foreground" data-testid="effects-that-is-all">
            That is all: the backend says no page follows this one.
            {matching !== undefined && matching !== rows.length + unread &&
              ` It counts ${matching} now and ${rows.length + unread} ${rows.length + unread === 1 ? "row was" : "rows were"} read: the list changed while it was read.`}
          </p>
        )}
        {isLast && matching !== undefined && matching !== rows.length + unread && actions.fromFirst && (
          <button type="button" className={BUTTON} data-testid="effects-from-first" onClick={actions.fromFirst}>
            Read again from the first page
          </button>
        )}
      </div>
    </EffectsSection>
  );
}

/** The refusal a read's error carries, when this console's server answered it 400: its code and its words, each only as text. */
function refusalOf(error: unknown): { code: string | null; error: string | null } | null {
  const held = error !== null && typeof error === "object" ? (error as { status?: unknown; body?: unknown }) : null;
  if (held === null || held.status !== 400) return null;
  const body = held.body !== null && typeof held.body === "object" ? (held.body as { code?: unknown; error?: unknown }) : {};
  return { code: typeof body.code === "string" ? body.code : null, error: typeof body.error === "string" ? body.error : null };
}

/** One page asked for by a press: the cursor it was asked with, and which reading of it this is. */
interface AskedPage { before: string; attempt: number }
/** The walk of one deployment: which reading of the first page it starts from, and the pages asked for after it. */
interface Walk { deployment: string; round: number; asked: AskedPage[] }

/**
 * The observed effects of a deployment. The first page is read once with the screen
 * and drawn beside the chains; nothing waits on it. A later page is read only when its
 * button is pressed: the list of pages asked for grows by one per press and by nothing
 * else, and no read here is made again by itself.
 */
export function ObservedEffectsSection({ deployment }: { deployment: string }) {
  const path = `/api/assurance/deployments/${encodeURIComponent(deployment)}/chain-outcomes`;
  const [held, setWalk] = useState<Walk>({ deployment, round: 0, asked: [] });
  // Another deployment's walk is not this one's: it starts from its own first page.
  const walk: Walk = held.deployment === deployment ? held : { deployment, round: 0, asked: [] };
  // The trailing number makes a reading asked for again a read of its own in the cache; it is no part of the address.
  const first = useQuery<unknown>({ queryKey: walk.round === 0 ? [path] : [path, {}, walk.round], retry: false });
  const read = useQueries({
    queries: walk.asked.map((page) => ({
      // `before` is the whole query string. What follows it names which reading this is, and is no part of the address.
      queryKey: walk.round === 0 && page.attempt === 0
        ? [path, { before: page.before }]
        : [path, { before: page.before }, `${walk.round}.${page.attempt}`],
      retry: false,
      refetchOnReconnect: false,
    })),
  });
  const source = served(first);
  if (source.state !== "ready") {
    const refusal = first.isError ? refusalOf(first.error) : null;
    return (
      <EffectsSection>
        {refusal === null ? (
          <NotInHand source={source} what="the observed effects" />
        ) : (
          <p className="text-[13px] text-amber-400" data-testid="effects-first-refused">
            The backend refused the read of the observed effects as asked (<Refusal code={refusal.code} error={refusal.error} />).
            It is not asked again by itself, and none of it is read as no effect.
          </p>
        )}
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
  // The pages in hand are those read in order from the first; the first one not in hand is what `after` says.
  const later: ChainOutcomes[] = [];
  let after: NextPage = { state: "none" };
  for (let at = 0; at < read.length; at += 1) {
    const page = read[at];
    // A page follows from the one before it only by the cursor that page gave.
    if (walk.asked[at].before !== (at === 0 ? source.data.next : later[at - 1].next)) {
      after = { state: "changed" };
      break;
    }
    if (page.isError) {
      const refusal = refusalOf(page.error);
      after = refusal === null
        ? { state: "failed", message: page.error instanceof Error ? page.error.message : "the read did not answer" }
        : { state: "refused", ...refusal };
      break;
    }
    if (page.data === undefined || page.isPlaceholderData) {
      after = { state: "reading" };
      break;
    }
    if (!isChainOutcomes(page.data)) {
      after = { state: "failed", message: "the answer for the page could not be read" };
      break;
    }
    later.push(page.data);
  }
  const actions: WalkActions = {
    // One press, one page: a cursor already asked with adds nothing.
    more: (next) => setWalk(walk.asked.some((page) => page.before === next) ? walk : { ...walk, asked: [...walk.asked, { before: next, attempt: 0 }] }),
    // The page that could not be read, once more: the pages before it stay in hand.
    again: () => setWalk({
      ...walk,
      asked: walk.asked.map((page, at) => (at === later.length ? { ...page, attempt: page.attempt + 1 } : page)),
    }),
    fromFirst: () => setWalk({ deployment, round: walk.round + 1, asked: [] }),
  };
  return <ObservedEffectsView data={source.data} later={later} after={after} actions={actions} />;
}
