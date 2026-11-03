/**
 * Authority chains: the chain of authority recorded behind each effect -- every
 * hop from a person to the effect, with the backend's verdict on it (proven and
 * by what, unproven and why, broken and why) -- and every effect the approvals
 * cover, with whether a chain in force names it. Read from Athena-Backend's
 * GET /api/assurance/deployments/<uuid>/authority-chains/ (through
 * /api/assurance/deployments/:uuid/authority-chains on this server).
 *
 * A hop nothing proves is named on the chain as an unproven hop, and one the
 * record contradicts as a broken hop: a reader goes to the hop rather than infers
 * it. A verdict this console does not know is shown as served and read as none
 * of the three.
 */
import { useQuery } from "@tanstack/react-query";
import { Waypoints } from "lucide-react";
import { Absent, Chip, Count, Digest, Fact, NotInHand, Section, ToolName, UnreadableRows, When, served, unreadableIn, type Tone } from "./parts";
import type { AuthorityChain, AuthorityChains, ChainHop, ChainNode, ConsequentialEffect } from "./types";

const VERDICTS: Record<string, { label: string; hop: string; tone: Tone }> = {
  proven: { label: "Proven", hop: "Proven hop", tone: "positive" },
  unproven: { label: "Unproven", hop: "Unproven hop", tone: "caution" },
  broken: { label: "Broken", hop: "Broken hop", tone: "critical" },
};

/** A chain's or a hop's verdict. Outside proven/unproven/broken it is not read as any of them. */
export function VerdictChip({ verdict, hop = false, testId }: { verdict: string; hop?: boolean; testId?: string }) {
  const known = VERDICTS[verdict];
  if (!known) {
    return (
      <Chip tone="neutral" testId={testId}>
        {verdict ? `verdict not recognised here: ${verdict}` : "no verdict served"}
      </Chip>
    );
  }
  return (
    <Chip tone={known.tone} testId={testId}>
      {hop ? known.hop : known.label}
    </Chip>
  );
}

const RELATIONS: Record<string, string> = {
  authenticated_as: "signed in as",
  delegates_to: "delegates to",
  under_policy: "acts under the approval",
  invokes: "invokes",
  through_identity: "acts through the account",
  performs: "performs",
  produces: "produces",
};

function Node({ node }: { node: ChainNode }) {
  return (
    <span className="text-foreground">
      <span className="text-muted-foreground">{node.kind || "kind not served"}</span>{" "}
      <code className="font-mono text-[12px]">{node.ref || "(no reference)"}</code>
      {node.version && (
        <>
          {" "}
          <span className="text-muted-foreground">version</span> <Digest value={node.version} />
        </>
      )}
    </span>
  );
}

function HopRow({ hop }: { hop: ChainHop }) {
  const readings = hop.verdict === "proven" ? hop.provenBy : hop.reasons;
  const readingsList = hop.verdict === "proven" ? "provenBy" : "reasons";
  return (
    <li
      className="space-y-1 rounded-md border border-border/50 bg-surface-1/40 p-2"
      data-hop={hop.index ?? ""}
      data-hop-verdict={hop.verdict}
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-mono text-muted-foreground">#{hop.index ?? "?"}</span>
        <Node node={hop.from} />
        <span className="text-muted-foreground">{RELATIONS[hop.relation] ?? hop.relation}</span>
        <Node node={hop.to} />
        <VerdictChip verdict={hop.verdict} hop testId="hop-verdict" />
      </div>
      {readings.length === 0 && unreadableIn(hop, readingsList) === 0 ? (
        <p className="text-[11px]">
          <Absent>{hop.verdict === "proven" ? "nothing named as proving it" : "no reason served"}</Absent>
        </p>
      ) : (
        <ul className="space-y-0.5">
          {readings.map((reading, i) => (
            <li key={`${reading.code}-${i}`} className="text-[11px] text-muted-foreground" data-reading={reading.code}>
              <code className="font-mono">{reading.code}</code>
              {reading.detail ? `: ${reading.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
      <UnreadableRows from={hop} list={readingsList} />
    </li>
  );
}

const ROUTES: Record<string, string> = {
  current: "recorded against the route serving now",
  moved: "recorded against a route that no longer serves",
  unrecorded: "the route it was recorded against is not recorded",
};

function ChainCard({ chain }: { chain: AuthorityChain }) {
  const hops = [...chain.hops].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return (
    <li className="space-y-2 rounded-lg border border-border/60 bg-surface-1/30 p-3" data-chain={chain.uuid} data-chain-verdict={chain.verdict}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">
          {chain.workflow || "no workflow named"} <span className="text-muted-foreground">to</span>{" "}
          <code className="font-mono text-[12px]">{chain.effect || "no effect named"}</code>
        </h3>
        <VerdictChip verdict={chain.verdict} testId="chain-verdict" />
        {chain.standing === true && <Chip tone="neutral" testId="chain-standing">In force for its effect</Chip>}
        {chain.standing === false && <Chip tone="neutral" testId="chain-standing">Superseded by a later chain</Chip>}
        {chain.standing === null && <Absent testId="chain-standing">whether it is in force was not said</Absent>}
      </div>
      {chain.unprovenHops.length > 0 && (
        <p className="text-[12px] text-amber-400" data-testid="unproven-hops">
          Unproven hop{chain.unprovenHops.length === 1 ? "" : "s"}: {chain.unprovenHops.map((i) => `#${i}`).join(", ")}
        </p>
      )}
      {chain.brokenHops.length > 0 && (
        <p className="text-[12px] text-sev-high" data-testid="broken-hops">
          Broken hop{chain.brokenHops.length === 1 ? "" : "s"}: {chain.brokenHops.map((i) => `#${i}`).join(", ")}
        </p>
      )}
      <div className="grid gap-1 md:grid-cols-2">
        <Fact label="Rests on">
          {chain.basisInForce === "demonstrated" ? (
            <span className="text-foreground">a signature by {chain.observerEngine ?? "an engine"} that verifies now</span>
          ) : chain.basisInForce === "attested" ? (
            <span className="text-foreground">
              {chain.basis === "demonstrated"
                ? "a signature that no longer verifies: read as typed in"
                : "what was typed in: no engine signed it"}
            </span>
          ) : (
            <Absent>not said</Absent>
          )}
        </Fact>
        <Fact label="Route">
          {chain.route ? <span className="text-foreground">{ROUTES[chain.route] ?? chain.route}</span> : <Absent>not said</Absent>}
        </Fact>
        <Fact label="Effect observed at">
          <When iso={chain.observedAt} />
        </Fact>
        <Fact label="Recorded at">
          <When iso={chain.recordedAt} />
        </Fact>
        <Fact label="Recorded by">
          {chain.recordedBy ? <span className="text-foreground">{chain.recordedBy}</span> : <Absent>not on record</Absent>}
        </Fact>
        <Fact label="Chain digest">
          <Digest value={chain.digest || null} />
        </Fact>
      </div>
      {chain.note && <p className="text-[12px] text-muted-foreground">{chain.note}</p>}
      {hops.length === 0 && unreadableIn(chain, "hops") === 0 ? (
        <Absent>no hops served</Absent>
      ) : (
        <ol className="space-y-1.5">
          {hops.map((hop, i) => (
            <HopRow key={`${hop.index ?? i}`} hop={hop} />
          ))}
        </ol>
      )}
      <UnreadableRows from={chain} list="hops" />
    </li>
  );
}

const EFFECT_STATUS: Record<string, { label: string; tone: Tone }> = {
  covered: { label: "A chain in force names it", tone: "info" },
  missing: { label: "No chain in force names it", tone: "caution" },
  unknown: { label: "Effect class unknown", tone: "caution" },
  not_required: { label: "Read-only: needs no chain", tone: "neutral" },
};

const EFFECT_KINDS: Record<string, string> = {
  consequential: "Consequential",
  read_only: "Read-only",
  unknown: "Unknown",
};

export function EffectRow({ effect }: { effect: ConsequentialEffect }) {
  const status = EFFECT_STATUS[effect.status];
  return (
    <li className="space-y-1 rounded-md border border-border/50 bg-surface-1/40 p-2" data-effect={effect.digest} data-effect-status={effect.status}>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <ToolName kind={effect.toolKind} identifier={effect.toolIdentifier} />
        <span className="text-muted-foreground">for</span>
        {effect.workflow ? (
          <code className="font-mono text-[12px] text-foreground">{effect.workflow}</code>
        ) : (
          <Absent>no approval binds it</Absent>
        )}
        <Chip tone={status?.tone ?? "neutral"} testId="effect-status">
          {status?.label ?? `status not recognised here: ${effect.status || "none served"}`}
        </Chip>
      </div>
      <Fact label="Declared effect class">
        {effect.effectClass === null ? (
          <Absent testId="effect-class">not declared</Absent>
        ) : (
          <code className="font-mono text-[12px] text-foreground" data-testid="effect-class">{effect.effectClass}</code>
        )}
      </Fact>
      <Fact label="Read as">
        <span className="text-foreground">{EFFECT_KINDS[effect.effectKind] ?? (effect.effectKind || "not said")}</span>
      </Fact>
      {effect.reasons.length > 0 && (
        <Fact label="Why">
          <span className="font-mono text-[11px] text-muted-foreground">{effect.reasons.join(", ")}</span>
        </Fact>
      )}
      {effect.toDo && <p className="text-[12px] text-amber-400" data-testid="effect-to-do">To do: {effect.toDo}</p>}
    </li>
  );
}

function Census({ census, labels, testId }: { census: Record<string, number>; labels: Record<string, string>; testId: string }) {
  const entries = Object.entries(census);
  if (entries.length === 0) return <Absent testId={testId}>no census was served</Absent>;
  return (
    <div className="flex flex-wrap gap-2" data-testid={testId}>
      {entries.map(([key, count]) => (
        <Chip key={key} tone="neutral">
          {labels[key] ?? key}: {count}
        </Chip>
      ))}
    </div>
  );
}

export function AuthorityChainsView({ data }: { data: AuthorityChains }) {
  const approvals = Object.entries(data.approvalsInForce);
  return (
    <div className="space-y-4" data-screen="authority-chains">
      <Section title="Chains recorded" icon={<Waypoints className="h-4 w-4 text-primary" />} testId="chains-section">
        <div className="grid gap-1 md:grid-cols-3">
          <Fact label="Recorded">
            <Count value={data.recorded} testId="chains-recorded" />
          </Fact>
          <Fact label="In force">
            <Count value={data.standing} testId="chains-standing" />
          </Fact>
          <Fact label="Superseded">
            <Count value={data.superseded} testId="chains-superseded" />
          </Fact>
        </div>
        <Fact label="Chains in force, by verdict">
          <Census census={data.verdictCensus} labels={{ proven: "Proven", unproven: "Unproven", broken: "Broken" }} testId="verdict-census" />
        </Fact>
        {data.truncated === true && (
          <p className="text-[12px] text-amber-400" data-testid="chains-truncated">
            Showing the newest {data.returned ?? "few"} of {data.recorded ?? "more"}: the backend returns at most{" "}
            {data.pageSize ?? "a page"} at a time.
          </p>
        )}
        {data.chains.length === 0 && unreadableIn(data, "chains") === 0 ? (
          <p className="text-[13px]" data-testid="no-chains">
            <Absent>No authority chain is recorded for this deployment.</Absent>
          </p>
        ) : (
          <ul className="space-y-3">
            {data.chains.map((chain) => (
              <ChainCard key={chain.uuid || chain.digest} chain={chain} />
            ))}
          </ul>
        )}
        <UnreadableRows from={data} list="chains" />
      </Section>
      <Section title="Effects the approvals cover" testId="effects-section">
        <Fact label="By status">
          <Census census={data.effectCensus} labels={Object.fromEntries(Object.entries(EFFECT_STATUS).map(([k, v]) => [k, v.label]))} testId="effect-census" />
        </Fact>
        {data.effects.length === 0 && unreadableIn(data, "effects") === 0 ? (
          <p className="text-[13px]" data-testid="no-effects">
            <Absent>No effect is covered by an approval: no approved workflow, or none that reaches a tool.</Absent>
          </p>
        ) : (
          <ul className="space-y-2">
            {data.effects.map((effect) => (
              <EffectRow key={effect.digest} effect={effect} />
            ))}
          </ul>
        )}
        <UnreadableRows from={data} list="effects" />
      </Section>
      <Section title="Approval versions in force" testId="approvals-in-force-section">
        <p className="text-[12px] text-muted-foreground">
          What a chain&apos;s policy hop names: each approved workflow&apos;s approval, as a digest over what it covers.
        </p>
        {approvals.length === 0 ? (
          <Absent testId="no-approvals-in-force">No approval is in force.</Absent>
        ) : (
          <ul className="space-y-1">
            {approvals.map(([slug, digest]) => (
              <li key={slug} className="text-[12px]" data-approval-in-force={slug}>
                <code className="font-mono text-foreground">{slug}</code> <Digest value={digest} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

export default function AuthorityChainsScreen({ deployment }: { deployment: string }) {
  const source = served(
    useQuery<AuthorityChains>({ queryKey: [`/api/assurance/deployments/${encodeURIComponent(deployment)}/authority-chains`] }),
  );
  if (source.state !== "ready") return <NotInHand source={source} what="the authority chains" />;
  return <AuthorityChainsView data={source.data} />;
}
