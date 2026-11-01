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
 * What is not here because the backend does not serve it: the decision's earlier
 * revisions (recorded, not served), the cap a scan that stopped short imposes
 * (folded into the decision and named in its note, not served on its own), and a
 * per-build release decision with per-gate results, which Minotaur-Backend keeps
 * and this console does not read.
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import { VerdictChip } from "./AuthorityChains";
import {
  Absent,
  Chip,
  Digest,
  Fact,
  NotInHand,
  NotServed,
  Section,
  ToolName,
  decisionLabel,
  decisionTone,
  served,
} from "./parts";
import type { DecisionSupport } from "./types";

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

function Named({ title, count, children, testId }: { title: string; count: number; children: ReactNode; testId: string }) {
  if (count === 0) return null;
  return (
    <div data-testid={testId}>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {title} ({count})
      </p>
      <ul className="mt-1 space-y-1">{children}</ul>
    </div>
  );
}

export function ReleaseGateView({ data }: { data: DecisionSupport }) {
  const claims = data.claims;
  const named =
    claims.contradicted.length + claims.stale.length + claims.unknown.length +
    claims.supersededToolContracts.length + claims.authorityChainsBroken.length +
    claims.authorityChainsUnproven.length + claims.authorityChainsMissing.length + claims.effectClassesUnknown.length;
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
        {named === 0 ? (
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
            <Named title="Bound to a tool contract that has since changed" count={claims.supersededToolContracts.length} testId="superseded-contracts">
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
                </li>
              ))}
            </Named>
            <Named
              title="Effects with no chain in force, or of an unknown class"
              count={claims.authorityChainsMissing.length + claims.effectClassesUnknown.length}
              testId="effects-held"
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

      <NotServed testId="release-history-not-served">
        Release decisions over time: Athena-Backend records each change of this decision and serves only the one in
        force, with its revision. A per-build release decision with a result for each of its gates is kept by
        Minotaur-Backend, which this console does not read, so none is shown.
      </NotServed>
    </div>
  );
}

export default function ReleaseGateScreen({ deployment }: { deployment: string }) {
  const source = served(
    useQuery<DecisionSupport>({ queryKey: [`/api/assurance/deployments/${encodeURIComponent(deployment)}/decision-support`] }),
  );
  if (source.state !== "ready") return <NotInHand source={source} what="the release decision" />;
  return <ReleaseGateView data={source.data} />;
}
