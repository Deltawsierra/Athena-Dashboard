/**
 * Tool contracts: each tool's effective contract -- what its registration
 * declares it may do (its schemas, its declared effect class, its MCP
 * annotations, its permissions, the server it runs on) -- and, for each approval
 * that binds it, the contract it was approved under against the one in force now.
 *
 * Two reads, both as the signed-in person: the deployment's assets
 * (GET /api/assurance/assets?deployment=, already on this server) for the
 * registrations, and its approved workflows for the bindings. The contract fields
 * are the ones athena-backend hashes into a tool's contract digest
 * (assurance/tool_contract.py CONTRACT_FIELDS), shown as the registration states
 * them; a field it does not state reads "not declared", which the backend carries
 * as a null in the contract, never as a default.
 *
 * When it changed: the backend records each new contract of a registration, and
 * when, and serves none of that history to this console. Shown instead is what it
 * does serve: when each approval was bound to a contract, and whether the
 * contract in force is still that one.
 */
import { useQuery } from "@tanstack/react-query";
import { FileCode2 } from "lucide-react";
import { ContractStanding } from "./ApprovedWorkflows";
import { Absent, Chip, Digest, Fact, NotInHand, NotServed, Section, ToolName, When, served, toolKindLabel, TOOL_KINDS } from "./parts";
import type { ApprovedTool, ApprovedWorkflows, ToolAsset } from "./types";

/** The fields a tool's contract is made of, in the backend's order, with what each is called here. */
export const CONTRACT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["effect_class", "Declared effect class"],
  ["input_schema", "Input schema"],
  ["output_schema", "Output schema"],
  ["annotations", "MCP annotations"],
  ["permissions", "Permissions"],
  ["server", "Server"],
];

/** A tool kind that carries a contract. */
export function isTool(kind: string): boolean {
  return (TOOL_KINDS as readonly string[]).includes(kind);
}

function ContractValue({ value, field }: { value: unknown; field: string }) {
  if (value === undefined || value === null) {
    return <Absent testId={`contract-${field}`}>not declared</Absent>;
  }
  if (typeof value === "string") {
    return (
      <code className="font-mono text-[12px] text-foreground" data-testid={`contract-${field}`}>
        {value}
      </code>
    );
  }
  return (
    <pre
      className="mt-1 max-h-48 overflow-auto rounded-md border border-border/50 bg-surface-1/50 p-2 font-mono text-[11px] text-foreground/90"
      data-testid={`contract-${field}`}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

interface Binding {
  workflow: string;
  workflowName: string;
  tool: ApprovedTool;
}

function bindingsByTool(workflows: ApprovedWorkflows | null): Map<string, Binding[]> {
  const out = new Map<string, Binding[]>();
  for (const workflow of workflows?.approved ?? []) {
    for (const tool of workflow.tools) {
      const key = `${tool.kind}:${tool.identifier}`;
      const list = out.get(key) ?? [];
      list.push({ workflow: workflow.slug, workflowName: workflow.name || workflow.slug, tool });
      out.set(key, list);
    }
  }
  return out;
}

function BindingList({ bindings }: { bindings: Binding[] }) {
  return (
    <ul className="space-y-1.5">
      {bindings.map((b) => (
        <li key={b.workflow} className="space-y-0.5 rounded-md border border-border/50 bg-surface-1/40 p-2" data-binding={b.workflow}>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="text-foreground">{b.workflowName}</span>
            <code className="font-mono text-[11px] text-muted-foreground">{b.workflow}</code>
            <ContractStanding tool={b.tool} />
          </div>
          <Fact label="Approved under">
            <Digest value={b.tool.approvedDigest} />
          </Fact>
          <Fact label="Bound at">
            <When iso={b.tool.boundAt} testId="binding-bound-at" />
          </Fact>
        </li>
      ))}
    </ul>
  );
}

/** The digest in force for a tool, as an approval's binding reads it; the backend serves it only there. */
function digestInForce(bindings: Binding[]) {
  if (bindings.length === 0) {
    return <Absent testId="digest-in-force">not served for a tool no approval binds</Absent>;
  }
  const current = bindings.find((b) => b.tool.currentDigest !== null)?.tool.currentDigest ?? null;
  return <Digest value={current} absent="none: the tool is no longer registered" testId="digest-in-force" />;
}

function ToolCard({
  asset,
  bindings,
  bindingsSource,
}: {
  asset: ToolAsset;
  bindings: Binding[];
  bindingsSource: { state: "loading" } | { state: "error"; message: string } | { state: "ready" };
}) {
  const retired = Boolean(asset.metadata.retired);
  return (
    <li className="space-y-2 rounded-lg border border-border/60 bg-surface-1/30 p-3" data-tool={`${asset.kind}:${asset.identifier}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">{asset.name || asset.identifier || "unnamed"}</h3>
        <span className="text-[12px] text-muted-foreground">{asset.kindLabel || toolKindLabel(asset.kind)}</span>
        {asset.identifier ? (
          <code className="font-mono text-[11px] text-muted-foreground">{asset.identifier}</code>
        ) : (
          <Absent>no identifier</Absent>
        )}
        {asset.classificationLabel && <Chip tone="neutral">{asset.classificationLabel}</Chip>}
        {retired && (
          <Chip tone="neutral" testId="tool-retired">
            Retired from the declared inventory: no contract in force
          </Chip>
        )}
      </div>
      {!asset.identifier && (
        <p className="text-[12px]">
          <Absent>A registration without an identifier carries no contract the backend can bind an approval to.</Absent>
        </p>
      )}
      <div className="space-y-1" data-testid="contract-fields">
        {CONTRACT_FIELDS.map(([field, label]) => (
          <Fact key={field} label={label}>
            <ContractValue value={asset.metadata[field]} field={field} />
          </Fact>
        ))}
      </div>
      <Fact label="Contract digest in force">
        {bindingsSource.state === "ready" ? digestInForce(bindings) : <Absent>not read</Absent>}
      </Fact>
      <Fact label="Registration first seen">
        <When iso={asset.firstSeen} />
      </Fact>
      <Fact label="Registration last seen">
        <When iso={asset.lastSeen} />
      </Fact>
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Approvals that bind it</p>
        {bindingsSource.state === "loading" && <Absent>reading the approvals…</Absent>}
        {bindingsSource.state === "error" && (
          <Absent testId="bindings-error">the approvals could not be read: {bindingsSource.message}</Absent>
        )}
        {bindingsSource.state === "ready" &&
          (bindings.length === 0 ? (
            <Absent testId="no-bindings">No approval binds this tool.</Absent>
          ) : (
            <BindingList bindings={bindings} />
          ))}
      </div>
    </li>
  );
}

export function ToolContractsView({
  assets,
  workflows,
  workflowsError = null,
}: {
  assets: ToolAsset[];
  /** null while the approvals are being read, or when they could not be (workflowsError). */
  workflows: ApprovedWorkflows | null;
  workflowsError?: string | null;
}) {
  const tools = assets.filter((asset) => isTool(asset.kind));
  const byTool = bindingsByTool(workflows);
  const bindingsSource =
    workflowsError !== null
      ? ({ state: "error", message: workflowsError } as const)
      : workflows === null
        ? ({ state: "loading" } as const)
        : ({ state: "ready" } as const);
  const registered = new Set(tools.map((asset) => `${asset.kind}:${asset.identifier}`));
  // Tools an approval binds that no registration on the deployment now answers to.
  const unregistered = Array.from(byTool.entries()).filter(([key]) => !registered.has(key));
  return (
    <div className="space-y-4" data-screen="tool-contracts">
      <Section title="Tool contracts" icon={<FileCode2 className="h-4 w-4 text-primary" />} testId="contracts-section">
        {tools.length === 0 ? (
          <p className="text-[13px]" data-testid="no-tools">
            <Absent>No tool, MCP server or agent skill is registered on this deployment.</Absent>
          </p>
        ) : (
          <ul className="space-y-3">
            {tools.map((asset) => (
              <ToolCard
                key={asset.uuid || `${asset.kind}:${asset.identifier}`}
                asset={asset}
                bindings={byTool.get(`${asset.kind}:${asset.identifier}`) ?? []}
                bindingsSource={bindingsSource}
              />
            ))}
          </ul>
        )}
        <NotServed testId="contract-history-not-served">
          When a contract changed: Athena-Backend records each new contract of a registration, and when it was
          recorded, and does not serve that history to this console. Shown is the contract the registration declares
          now, when each approval was bound to a contract, and whether the contract in force is still that one.
        </NotServed>
      </Section>
      {unregistered.length > 0 && (
        <Section title="Approved tools with no registration now" testId="unregistered-section">
          <ul className="space-y-2">
            {unregistered.map(([key, bindings]) => (
              <li key={key} className="space-y-1" data-unregistered-tool={key}>
                <ToolName kind={bindings[0].tool.kind} identifier={bindings[0].tool.identifier} />
                <BindingList bindings={bindings} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

export default function ToolContractsScreen({ deployment }: { deployment: string }) {
  const assets = served(useQuery<ToolAsset[]>({ queryKey: ["/api/assurance/assets", { deployment }] }));
  const workflows = served(
    useQuery<ApprovedWorkflows>({ queryKey: [`/api/assurance/deployments/${deployment}/approved-workflows`] }),
  );
  if (assets.state !== "ready") return <NotInHand source={assets} what="the tool registrations" />;
  return (
    <ToolContractsView
      assets={assets.data}
      workflows={workflows.state === "ready" ? workflows.data : null}
      workflowsError={workflows.state === "error" ? workflows.message : null}
    />
  );
}
