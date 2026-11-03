/**
 * Release gate: the release decision Athena-Backend records for a deployment --
 * its six-state decision, the revision it was read at and the policy it was made
 * under -- and every input the backend combines into it, each with what it
 * contributes. Read from GET /api/assurance/deployments/<uuid>/decision-support/
 * (through /api/assurance/deployments/:uuid/decision-support on this server).
 *
 * Nothing is decided here. Each input can only lower the decision
 * (athena-backend assurance/decision.py); the decision shown is the backend's, and
 * a release stays a person's to make from it.
 *
 * Honest by construction. An input that places no cap is shown as placing none,
 * in a neutral tone -- never as a clear result: a coverage cap of none can mean no
 * declared architecture to measure a gap against. Under the operator failsafe
 * pause the backend reads no input, and each says so. AUDIT_INCOMPLETE, and an
 * undecided deployment, are never drawn as a positive result: only a READY
 * decision is.
 *
 * How it changed: every accepted change of the decision, newest first by revision,
 * from GET /api/assurance/deployments/<uuid>/decision-history/ (through
 * /api/assurance/deployments/:uuid/decision-history on this server), a page at a
 * time (components/authority/history.tsx): from what, to what, on what basis, when,
 * and whether a downstream consumer confirmed it. Drawn in neutral tones, every
 * decision named in words: a past READY is a fact about the record, not a result
 * drawn on this screen.
 *
 * What is not here because the backend does not serve it: the cap a scan that
 * stopped short imposes (folded into the decision and named in its note, not served
 * on its own), and a per-build release decision with per-gate results, which
 * Minotaur-Backend keeps and this console does not read.
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Scale } from "lucide-react";
import { VerdictChip } from "./AuthorityChains";
import { HistoryPageFrame, HistoryPages, type PageSlot } from "./history";
import {
  Absent,
  Chip,
  Digest,
  Fact,
  NotInHand,
  NotServed,
  Section,
  ToolName,
  UnreadableRows,
  When,
  decisionLabel,
  decisionTone,
  served,
  unreadableIn,
} from "./parts";
import type { DecisionHistory, DecisionSupport, DecisionTransitionRecord } from "./types";

/** The decision itself. Only READY reads positive; an undecided deployment reads "Not assessed". */
export function ReleaseDecisionChip({ decision, label }: { decision: string | null; label?: string | null }) {
  if (decision === null) {
    return (
      <Chip tone="neutral" testId="release-decision">
        Not assessed: no decision is recorded
      </Chip>
    );
  }
  return (
    <Chip tone={decisionTone(decision)} testId="release-decision">
      {decisionLabel(decision, label)}
    </Chip>
  );
}

interface Input {
  key: string;
  label: string;
  /** The decision state this input places, or null when it places none. */
  value: string | null;
  /** Whether the backend reads nothing for this input under the failsafe pause. */
  nulledByPause: boolean;
  /** What a null means for this input, in words. */
  none: string;
  detail?: ReactNode;
}

function inputsOf(data: DecisionSupport): Input[] {
  const composition = data.composition;
  return [
    {
      key: "findings",
      label: "Findings",
      value: data.fromFindings,
      nulledByPause: true,
      none: "Not assessed: no finding-based signal",
    },
    {
      key: "claims",
      label: "Assurance claims",
      value: data.claimCap,
      nulledByPause: false,
      none: data.claims.hasClaims
        ? "Places no cap: no current claim holds the decision back"
        : "Places no cap: no current assurance claim bears on the decision",
    },
    {
      key: "coverage",
      label: "Coverage",
      value: data.coverageCap,
      nulledByPause: true,
      none:
        "Places no cap. Not a complete-coverage result: with no declared architecture there is nothing to measure a gap against",
    },
    {
      key: "accepted-risk",
      label: "Accepted risk",
      value: data.acceptedRiskCap,
      nulledByPause: true,
      none: "Places no cap: no accepted risk holds the decision back",
    },
    {
      key: "workflow-chains",
      label: "Approved-workflow chains",
      value: composition?.signal ?? null,
      nulledByPause: true,
      none: composition === null ? "Not served" : "Contributes nothing to the decision",
      detail: composition?.explanation ? (
        <span className="text-muted-foreground">{composition.explanation}</span>
      ) : undefined,
    },
  ];
}

function InputRow({ input, paused }: { input: Input; paused: boolean }) {
  let reading: ReactNode;
  if (input.value !== null) {
    // An input is never drawn as a positive result: only the decision is.
    reading = (
      <Chip tone={decisionTone(input.value, { asInput: true })} testId="input-reading">
        {decisionLabel(input.value)}
      </Chip>
    );
  } else if (paused && input.nulledByPause) {
    reading = <Absent testId="input-reading">Not read: the operator failsafe pause decides</Absent>;
  } else {
    reading = <Absent testId="input-reading">{input.none}</Absent>;
  }
  return (
    <li className="space-y-1 rounded-md border border-border/50 bg-surface-1/40 p-2" data-input={input.key}>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="min-w-[11rem] font-medium text-foreground">{input.label}</span>
        {reading}
      </div>
      {input.detail && <p className="text-[12px] leading-relaxed">{input.detail}</p>}
    </li>
  );
}

/**
 * One kind of thing the backend names as holding the decision, with how many. `lists`
 * names the served lists it is drawn from, so their rows that could not be read are
 * counted under it (a kind with only such rows still shows).
 */
function Named({
  title,
  count,
  children,
  testId,
  from,
  lists = [],
}: {
  title: string;
  count: number;
  children: ReactNode;
  testId: string;
  from?: DecisionSupport["claims"];
  lists?: string[];
}) {
  const unread = lists.reduce((sum, list) => sum + unreadableIn(from, list), 0);
  if (count === 0 && unread === 0) return null;
  return (
    <div data-testid={testId}>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {title} ({count})
      </p>
      <ul className="mt-1 space-y-1">{children}</ul>
      {lists.map((list) => (
        <UnreadableRows key={list} from={from} list={list} />
      ))}
    </div>
  );
}

/** The served lists of what holds the decision (server/assurance.ts mapDecisionSupport), by name. */
const HOLDING_LISTS = [
  "supersededToolContracts", "authorityChainsBroken", "authorityChainsUnproven", "authorityChainsMissing", "effectClassesUnknown",
];

/** A decision a transition names, in words and a neutral tone: the history is a record, never a result drawn here. */
function PastDecision({ state, none, testId }: { state: string | null; none: string; testId: string }) {
  if (state === null) return <Absent testId={testId}>{none}</Absent>;
  return (
    <Chip tone="neutral" testId={testId}>
      {decisionLabel(state)}
    </Chip>
  );
}

/** One accepted change of the decision. */
export function DecisionTransitionRow({ transition }: { transition: DecisionTransitionRecord }) {
  return (
    <li
      className="space-y-1 rounded-md border border-border/50 bg-surface-1/40 p-2"
      data-transition={transition.revision === null ? "" : String(transition.revision)}
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {transition.revision === null ? (
          <Absent testId="transition-revision">revision not served</Absent>
        ) : (
          <span className="font-mono text-foreground" data-testid="transition-revision">r{transition.revision}</span>
        )}
        <PastDecision state={transition.fromDecision} none="none before" testId="transition-from" />
        <span className="text-muted-foreground" aria-label="to">→</span>
        <PastDecision state={transition.toDecision} none="none after" testId="transition-to" />
      </div>
      <Fact label="Computed from">
        <Digest value={transition.basisDigest} absent="no basis digest supplied" testId="transition-basis" />
      </Fact>
      <Fact label="Accepted at">
        <When iso={transition.createdAt} testId="transition-created-at" />
      </Fact>
      <Fact label="Confirmed downstream at">
        <When iso={transition.deliveredAt} absent="not yet confirmed" testId="transition-delivered-at" />
      </Fact>
    </li>
  );
}

/** A page of decision changes, newest first; an empty first page says none is recorded. */
export function DecisionTransitionList({ transitions, first }: { transitions: DecisionTransitionRecord[]; first: boolean }) {
  if (transitions.length === 0) {
    return first ? (
      <p className="text-[12px]" data-testid="no-transitions">
        <Absent>No change of this deployment&apos;s decision is recorded.</Absent>
      </p>
    ) : null;
  }
  return (
    <ul className="space-y-1.5">
      {transitions.map((transition, index) => (
        <DecisionTransitionRow key={transition.revision ?? `at-${index}`} transition={transition} />
      ))}
    </ul>
  );
}

function DecisionHistoryPage({ deployment, slot }: { deployment: string; slot: PageSlot }) {
  const offset = slot.offset;
  const source = served(
    useQuery<DecisionHistory>({
      queryKey: [`/api/assurance/deployments/${encodeURIComponent(deployment)}/decision-history`, { offset }],
    }),
  );
  return (
    <HistoryPageFrame
      source={source}
      deployment={deployment}
      slot={slot}
      what="the decision history"
      count={(page) => page.transitionCount}
      rows={(page) => page.transitions.length}
      list="transitions"
    >
      {(page) => <DecisionTransitionList transitions={page.transitions} first={offset === 0 && unreadableIn(page, "transitions") === 0} />}
    </HistoryPageFrame>
  );
}

/** How the decision changed, revision by revision, read for one deployment. */
export function DecisionHistorySection({ deployment }: { deployment: string }) {
  return (
    <Section title="How the decision changed" icon={<History className="h-4 w-4 text-muted-foreground" />} testId="decision-history-section">
      <p className="text-[12px] text-muted-foreground">
        Every accepted change of this deployment&apos;s decision, newest first by revision, as Athena-Backend records
        it. A record of the past, read as it stands: the decision in force is the one above.
      </p>
      <HistoryPages key={deployment} page={(slot) => <DecisionHistoryPage deployment={deployment} slot={slot} />} />
    </Section>
  );
}

export function ReleaseGateView({ data, history }: { data: DecisionSupport; history?: ReactNode }) {
  const claims = data.claims;
  const named =
    claims.contradicted.length + claims.stale.length + claims.unknown.length +
    claims.supersededToolContracts.length + claims.authorityChainsBroken.length +
    claims.authorityChainsUnproven.length + claims.authorityChainsMissing.length + claims.effectClassesUnknown.length;
  const unread = HOLDING_LISTS.reduce((sum, list) => sum + unreadableIn(claims, list), 0);
  return (
    <div className="space-y-4" data-screen="release-gate">
      <Section title="Release decision" icon={<Scale className="h-4 w-4 text-primary" />} testId="decision-section">
        <div className="flex flex-wrap items-center gap-2">
          <ReleaseDecisionChip decision={data.decision} label={data.decisionLabel} />
          {data.paused && <Chip tone="neutral" testId="decision-paused">Operator failsafe paused</Chip>}
        </div>
        <Fact label="Revision">
          {data.revision === null ? (
            <Absent testId="decision-revision">not served</Absent>
          ) : (
            <span className="font-mono text-foreground" data-testid="decision-revision">r{data.revision}</span>
          )}
        </Fact>
        <Fact label="Made under policy">
          <Digest value={data.policyVersion} absent="not served" testId="decision-policy" />
        </Fact>
        {data.note && (
          <p className="text-[12px] leading-relaxed text-muted-foreground" data-testid="decision-note">
            {data.note}
          </p>
        )}
        <p className="text-[12px] text-muted-foreground">
          The decision is Athena-Backend&apos;s. It is evidence for a release a person decides, not that decision.
        </p>
      </Section>

      <Section title="What the decision is made from" testId="inputs-section">
        <p className="text-[12px] text-muted-foreground">
          Each input can only lower the decision, never raise it. Where one places no cap, that is what it says, and
          nothing more.
        </p>
        <ul className="space-y-1.5">
          {inputsOf(data).map((input) => (
            <InputRow key={input.key} input={input} paused={data.paused} />
          ))}
        </ul>
        {claims.retestPending && (
          <p className="text-[12px] text-amber-400" data-testid="retest-pending">
            A retest is pending: supporting evidence is not current until it runs.
          </p>
        )}
      </Section>

      <Section title="What holds it where it is" testId="holds-section">
        {named === 0 && unread === 0 ? (
          <Absent testId="nothing-named">The backend names no claim, chain, effect or contract here.</Absent>
        ) : (
          <div className="space-y-3">
            <Named title="Contradicted claims" count={claims.contradicted.length} testId="claims-contradicted">
              {claims.contradicted.map((c) => (
                <li key={c.uuid} className="text-[12px] text-muted-foreground">
                  <span className="text-foreground">{c.claimType}</span> — {c.statement}
                </li>
              ))}
            </Named>
            <Named title="Stale or unproven claims" count={claims.stale.length + claims.unknown.length} testId="claims-stale">
              {[...claims.stale, ...claims.unknown].map((c) => (
                <li key={c.uuid} className="text-[12px] text-muted-foreground">
                  <span className="text-foreground">{c.claimType}</span> ({c.status}) — {c.statement}
                </li>
              ))}
            </Named>
            <Named title="Bound to a tool contract that has since changed" count={claims.supersededToolContracts.length} testId="superseded-contracts" from={claims} lists={["supersededToolContracts"]}>
              {claims.supersededToolContracts.map((b, i) => (
                <li key={`${b.toolKind}:${b.toolIdentifier}:${b.workflow ?? b.claimFingerprint ?? i}`} className="space-y-0.5 text-[12px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <ToolName kind={b.toolKind} identifier={b.toolIdentifier} />
                    <span className="text-muted-foreground">
                      {b.subject === "workflow" ? `approval of ${b.workflow ?? "an unnamed workflow"}` : "an assurance claim"}
                    </span>
                  </div>
                  <Fact label="Bound under">
                    <Digest value={b.boundDigest} />
                  </Fact>
                  <Fact label="In force now">
                    <Digest value={b.currentDigest} absent="none: the tool is no longer registered" />
                  </Fact>
                </li>
              ))}
            </Named>
            <Named
              title="Authority chains with a broken or unproven hop"
              count={claims.authorityChainsBroken.length + claims.authorityChainsUnproven.length}
              testId="chains-held"
              from={claims}
              lists={["authorityChainsBroken", "authorityChainsUnproven"]}
            >
              {[...claims.authorityChainsBroken, ...claims.authorityChainsUnproven].map((chain) => (
                <li key={chain.uuid || chain.digest} className="space-y-0.5 text-[12px]" data-held-chain={chain.uuid}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-foreground">{chain.workflow}</span>
                    <span className="text-muted-foreground">to</span>
                    <code className="font-mono">{chain.effect}</code>
                    <VerdictChip verdict={chain.verdict} />
                  </div>
                  {chain.hops.map((hop, i) => (
                    <p key={`${hop.index ?? i}`} className="text-muted-foreground">
                      #{hop.index ?? "?"} {hop.relation}: <VerdictChip verdict={hop.verdict} hop />{" "}
                      <span className="font-mono text-[11px]">{hop.reasons.join(", ")}</span>
                    </p>
                  ))}
                  <UnreadableRows from={chain} list="hops" />
                </li>
              ))}
            </Named>
            <Named
              title="Effects with no chain in force, or of an unknown class"
              count={claims.authorityChainsMissing.length + claims.effectClassesUnknown.length}
              testId="effects-held"
              from={claims}
              lists={["authorityChainsMissing", "effectClassesUnknown"]}
            >
              {[...claims.authorityChainsMissing, ...claims.effectClassesUnknown].map((effect) => (
                <li key={`${effect.status}:${effect.digest}`} className="space-y-0.5 text-[12px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <ToolName kind={effect.toolKind} identifier={effect.toolIdentifier} />
                    {effect.workflow && <code className="font-mono text-muted-foreground">{effect.workflow}</code>}
                  </div>
                  {effect.toDo && <p className="text-amber-400">To do: {effect.toDo}</p>}
                </li>
              ))}
            </Named>
          </div>
        )}
      </Section>

      {history}

      <NotServed testId="release-per-build-not-served">
        A per-build release decision with a result for each of its gates is kept by Minotaur-Backend, which this
        console does not read, so none is shown.
      </NotServed>
    </div>
  );
}

export default function ReleaseGateScreen({ deployment }: { deployment: string }) {
  const source = served(
    useQuery<DecisionSupport>({ queryKey: [`/api/assurance/deployments/${encodeURIComponent(deployment)}/decision-support`] }),
  );
  if (source.state !== "ready") return <NotInHand source={source} what="the release decision" />;
  return <ReleaseGateView data={source.data} history={<DecisionHistorySection deployment={deployment} />} />;
}
