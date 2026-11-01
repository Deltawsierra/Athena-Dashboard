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
 * When it changed: each registration's contract history, read when a person opens
 * it, a page at a time (components/authority/history.tsx), from two more reads as
 * the person, narrowed to the registration (?kind=&identifier=):
 * GET /api/assurance/deployments/<uuid>/tool-contracts/ -- every contract recorded
 * for it, when, when the next superseded it, whether it is the one in force and the
 * digest in force now (served for every tool, so for one no approval binds too) --
 * and GET /api/assurance/deployments/<uuid>/tool-contract-bindings/ -- every
 * binding of an approval or a claim to one of its contracts, live or released, with
 * when and why the invalidation engine found it superseded.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { FileCode2 } from "lucide-react";
import { ContractStanding } from "./ApprovedWorkflows";
import { HistoryPageFrame, HistoryPages, OnDemand, answeredFor, type PageSlot } from "./history";
import { Absent, Chip, Digest, Fact, NotInHand, Section, ToolName, When, served, toolKindLabel, TOOL_KINDS } from "./parts";
import type {
  ApprovedTool,
  ApprovedWorkflows,
  ToolAsset,
  ToolContractBindingRecord,
  ToolContractBindings,
  ToolContractHistory,
  ToolContractRecord,
} from "./types";

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

function ContractValue({ value, field, prefix = "contract" }: { value: unknown; field: string; prefix?: string }) {
  if (value === undefined || value === null) {
    return <Absent testId={`${prefix}-${field}`}>not declared</Absent>;
  }
  if (typeof value === "string") {
    return (
      <code className="font-mono text-[12px] text-foreground" data-testid={`${prefix}-${field}`}>
        {value}
      </code>
    );
  }
  return (
    <pre
      className="mt-1 max-h-48 overflow-auto rounded-md border border-border/50 bg-surface-1/50 p-2 font-mono text-[11px] text-foreground/90"
      data-testid={`${prefix}-${field}`}
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

// ---- a registration's contract history ----

/** Whether a recorded contract is the one in force: a fact about the row, drawn neutral. */
function InForce({ record }: { record: ToolContractRecord }) {
  if (record.inForce === true) {
    return (
      <Chip tone="neutral" testId="record-in-force">
        In force now
      </Chip>
    );
  }
  if (record.inForce === false) {
    return (
      <Chip tone="neutral" testId="record-in-force">
        Not in force
      </Chip>
    );
  }
  return <Absent testId="record-in-force">whether it is in force was not said</Absent>;
}

/** One contract recorded for a registration: when, until when, and the one in force now. */
export function ContractRecordRow({ record }: { record: ToolContractRecord }) {
  const contract = record.contract;
  return (
    <li className="space-y-1 rounded-md border border-border/50 bg-surface-1/40 p-2" data-contract-record={record.digest ?? ""}>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <Digest value={record.digest} testId="record-digest" />
        <InForce record={record} />
      </div>
      <Fact label="Recorded at">
        <When iso={record.recordedAt} testId="record-recorded-at" />
      </Fact>
      <Fact label="Superseded at">
        <When iso={record.supersededAt} absent="not superseded: no later contract of it is recorded" testId="record-superseded-at" />
      </Fact>
      <Fact label="Contract in force now">
        <Digest value={record.currentDigest} absent="none: the tool is no longer registered" testId="record-current-digest" />
      </Fact>
      {record.inForce === false && record.supersededAt === null && record.currentDigest !== null && (
        <p className="text-[12px] text-amber-400" data-testid="record-unrecorded-change">
          The contract in force now is not this one, and no later contract of the registration is recorded.
        </p>
      )}
      <details className="text-[12px]">
        <summary className="cursor-pointer text-muted-foreground">Contract as recorded</summary>
        {contract === null ? (
          <Absent testId="record-contract">not served</Absent>
        ) : (
          <div className="mt-1 space-y-1" data-testid="record-contract">
            {CONTRACT_FIELDS.map(([field, label]) => (
              <Fact key={field} label={label}>
                <ContractValue value={contract[field]} field={field} prefix="record-contract" />
              </Fact>
            ))}
          </div>
        )}
      </details>
    </li>
  );
}

/** What a binding binds: an approval of a workflow, or an assurance claim. */
function BindingSubject({ binding }: { binding: ToolContractBindingRecord }) {
  if (binding.subject === "workflow") {
    return (
      <span className="text-foreground" data-testid="binding-subject">
        Approval of{" "}
        {binding.workflow ? <code className="font-mono text-[12px]">{binding.workflow}</code> : <Absent>a workflow not named</Absent>}
      </span>
    );
  }
  if (binding.subject === "claim") {
    return (
      <span className="text-foreground" data-testid="binding-subject">
        Assurance claim{" "}
        {binding.claimFingerprint ? (
          <code className="break-all font-mono text-[11px]">{binding.claimFingerprint}</code>
        ) : (
          <Absent>not named</Absent>
        )}
      </span>
    );
  }
  if (binding.subject === null) return <Absent testId="binding-subject">what it binds was not said</Absent>;
  return <Absent testId="binding-subject">{`not recognised here: ${binding.subject}`}</Absent>;
}

/** Live or released, and for a live one whether its contract moved. Unchanged is a fact, not a clear result. */
function BindingStanding({ binding }: { binding: ToolContractBindingRecord }) {
  const live =
    binding.live === true ? (
      <Chip tone="neutral" testId="binding-live">Live</Chip>
    ) : binding.live === false ? (
      <Chip tone="neutral" testId="binding-live">Released</Chip>
    ) : (
      <Absent testId="binding-live">whether it is live was not said</Absent>
    );
  let standing = null;
  if (binding.superseded === true) {
    standing = (
      <Chip tone="caution" testId="binding-standing">
        {binding.currentDigest === null ? "Tool no longer registered" : "Contract changed since it was bound"}
      </Chip>
    );
  } else if (binding.superseded === false) {
    standing = (
      <Chip tone="neutral" testId="binding-standing">
        Contract unchanged since it was bound
      </Chip>
    );
  } else if (binding.live !== false) {
    // A released binding holds nothing, so the backend serves no standing for it.
    standing = <Absent testId="binding-standing">whether the contract changed was not said</Absent>;
  }
  return (
    <>
      {live}
      {standing}
    </>
  );
}

/** One binding of an approval or a claim to a contract of the registration, live or released. */
export function BindingRecordRow({ binding }: { binding: ToolContractBindingRecord }) {
  return (
    <li
      className="space-y-1 rounded-md border border-border/50 bg-surface-1/40 p-2"
      data-binding-record={`${binding.subject ?? ""}:${binding.workflow ?? binding.claimFingerprint ?? ""}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <BindingSubject binding={binding} />
        <BindingStanding binding={binding} />
        {binding.invalidatedAt !== null && (
          <Chip tone="caution" testId="binding-invalidated">
            Invalidated
          </Chip>
        )}
      </div>
      <Fact label="Bound under">
        <Digest value={binding.contractDigest} testId="binding-digest" />
      </Fact>
      <Fact label="Contract in force now">
        <Digest value={binding.currentDigest} absent="none: the tool is no longer registered" testId="binding-current-digest" />
      </Fact>
      <Fact label="Bound at">
        <When iso={binding.boundAt} testId="binding-record-bound-at" />
      </Fact>
      <Fact label="Bound by">
        {binding.boundBy ? (
          <span className="text-foreground" data-testid="binding-bound-by">{binding.boundBy}</span>
        ) : (
          <Absent testId="binding-bound-by">not on record</Absent>
        )}
      </Fact>
      <Fact label="Released at">
        <When iso={binding.releasedAt} absent="not released" testId="binding-released-at" />
      </Fact>
      <Fact label="Invalidated">
        {binding.invalidatedAt !== null ? (
          <span data-testid="binding-invalidation">
            <When iso={binding.invalidatedAt} />{" "}
            {binding.invalidationReason ? (
              <span className="text-foreground">{binding.invalidationReason}</span>
            ) : (
              <Absent>no reason recorded</Absent>
            )}
          </span>
        ) : (
          <Absent testId="binding-invalidation">not invalidated</Absent>
        )}
      </Fact>
    </li>
  );
}

/** A page of a registration's recorded contracts, newest first. */
export function ContractRecordList({ records, first }: { records: ToolContractRecord[]; first: boolean }) {
  if (records.length === 0) {
    return first ? (
      <p className="text-[12px]" data-testid="no-contract-records">
        <Absent>No contract of this registration is recorded.</Absent>
      </p>
    ) : null;
  }
  return (
    <ul className="space-y-1.5">
      {records.map((record, index) => (
        <ContractRecordRow key={`${record.digest ?? ""}:${record.recordedAt ?? ""}:${index}`} record={record} />
      ))}
    </ul>
  );
}

/** A page of the bindings to a registration's contracts, newest first. */
export function BindingRecordList({ bindings, first }: { bindings: ToolContractBindingRecord[]; first: boolean }) {
  if (bindings.length === 0) {
    return first ? (
      <p className="text-[12px]" data-testid="no-binding-records">
        <Absent>No approval or claim is on record as bound to a contract of this registration.</Absent>
      </p>
    ) : null;
  }
  return (
    <ul className="space-y-1.5">
      {bindings.map((binding, index) => (
        <BindingRecordRow key={`${binding.subject}:${binding.workflow ?? binding.claimFingerprint}:${binding.boundAt}:${index}`} binding={binding} />
      ))}
    </ul>
  );
}

interface Registration {
  kind: string;
  identifier: string;
}

/** A page of a registration's recorded contracts, from `offset`. */
function useContractRecords(deployment: string, { kind, identifier }: Registration, offset: number) {
  return served(
    useQuery<ToolContractHistory>({
      queryKey: [`/api/assurance/deployments/${encodeURIComponent(deployment)}/tool-contracts`, { kind, identifier, offset }],
    }),
  );
}

function ContractRecordsPage({ deployment, tool, slot }: { deployment: string; tool: Registration; slot: PageSlot }) {
  const source = useContractRecords(deployment, tool, slot.offset);
  return (
    <HistoryPageFrame
      source={source}
      deployment={deployment}
      slot={slot}
      what="the contracts recorded for it"
      count={(page) => page.contractCount}
      rows={(page) => page.contracts.length}
    >
      {(page) => <ContractRecordList records={page.contracts} first={slot.offset === 0} />}
    </HistoryPageFrame>
  );
}

function BindingRecordsPage({ deployment, tool, slot }: { deployment: string; tool: Registration; slot: PageSlot }) {
  const { kind, identifier } = tool;
  const offset = slot.offset;
  const source = served(
    useQuery<ToolContractBindings>({
      queryKey: [`/api/assurance/deployments/${encodeURIComponent(deployment)}/tool-contract-bindings`, { kind, identifier, offset }],
    }),
  );
  return (
    <HistoryPageFrame
      source={source}
      deployment={deployment}
      slot={slot}
      what="the bindings to its contracts"
      count={(page) => page.bindingCount}
      rows={(page) => page.bindings.length}
    >
      {(page) => <BindingRecordList bindings={page.bindings} first={slot.offset === 0} />}
    </HistoryPageFrame>
  );
}

/** A registration's contract history: its recorded contracts, and every binding to one of them. */
export function ContractHistory({ deployment, tool }: { deployment: string; tool: Registration }) {
  const key = `${deployment}:${tool.kind}:${tool.identifier}`;
  return (
    <div className="space-y-3" data-testid="contract-history">
      <div className="space-y-1.5" data-testid="contract-records">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Contracts recorded, newest first</p>
        <HistoryPages key={key} page={(slot) => <ContractRecordsPage deployment={deployment} tool={tool} slot={slot} />} />
      </div>
      <div className="space-y-1.5" data-testid="binding-records">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Bindings to its contracts, live and released, newest first
        </p>
        <HistoryPages key={key} page={(slot) => <BindingRecordsPage deployment={deployment} tool={tool} slot={slot} />} />
      </div>
    </div>
  );
}

/**
 * The digest in force for a tool. An approval's binding serves it; for a tool no
 * approval binds, its contract history does, once that is read.
 */
function DigestInForce({
  bindings,
  deployment,
  tool,
  historyOpen,
}: {
  bindings: Binding[];
  deployment?: string;
  tool: Registration;
  historyOpen: boolean;
}) {
  if (bindings.length > 0) {
    const current = bindings.find((b) => b.tool.currentDigest !== null)?.tool.currentDigest ?? null;
    return <Digest value={current} absent="none: the tool is no longer registered" testId="digest-in-force" />;
  }
  if (!deployment || !tool.identifier) {
    return <Absent testId="digest-in-force">not read: no approval binds this tool</Absent>;
  }
  if (!historyOpen) {
    return <Absent testId="digest-in-force">no approval binds this tool: read with its contract history</Absent>;
  }
  return <DigestFromHistory deployment={deployment} tool={tool} />;
}

/** The digest in force as the first page of the registration's contract history serves it (the same read, shared). */
function DigestFromHistory({ deployment, tool }: { deployment: string; tool: Registration }) {
  const records = useContractRecords(deployment, tool, 0);
  if (records.state === "loading") return <Absent testId="digest-in-force">reading…</Absent>;
  if (records.state === "error") return <Absent testId="digest-in-force">{`could not be read: ${records.message}`}</Absent>;
  if (!answeredFor(records.data.deployment, deployment)) {
    return <Absent testId="digest-in-force">not shown: answered for another deployment</Absent>;
  }
  const first = records.data.contracts[0];
  if (!first) return <Absent testId="digest-in-force">no contract of this registration is recorded</Absent>;
  return <Digest value={first.currentDigest} absent="none: the tool is no longer registered" testId="digest-in-force" />;
}

function ToolCard({
  asset,
  bindings,
  bindingsSource,
  deployment,
}: {
  asset: ToolAsset;
  bindings: Binding[];
  bindingsSource: { state: "loading" } | { state: "error"; message: string } | { state: "ready" };
  deployment?: string;
}) {
  const retired = Boolean(asset.metadata.retired);
  const [historyOpen, setHistoryOpen] = useState(false);
  const tool = { kind: asset.kind, identifier: asset.identifier };
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
        {bindingsSource.state === "ready" ? (
          <DigestInForce bindings={bindings} deployment={deployment} tool={tool} historyOpen={historyOpen} />
        ) : (
          <Absent>not read</Absent>
        )}
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
      {deployment && asset.identifier && (
        <OnDemand label="contract history" testId="tool-contract-history" open={historyOpen} onToggle={setHistoryOpen}>
          {() => <ContractHistory deployment={deployment} tool={tool} />}
        </OnDemand>
      )}
    </li>
  );
}

export function ToolContractsView({
  assets,
  workflows,
  workflowsError = null,
  deployment,
}: {
  assets: ToolAsset[];
  /** null while the approvals are being read, or when they could not be (workflowsError). */
  workflows: ApprovedWorkflows | null;
  workflowsError?: string | null;
  /** The deployment the tools are registered on; with it, each tool offers its contract history. */
  deployment?: string;
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
                deployment={deployment}
              />
            ))}
          </ul>
        )}
      </Section>
      {unregistered.length > 0 && (
        <Section title="Approved tools with no registration now" testId="unregistered-section">
          <ul className="space-y-2">
            {unregistered.map(([key, bindings]) => (
              <li key={key} className="space-y-1" data-unregistered-tool={key}>
                <ToolName kind={bindings[0].tool.kind} identifier={bindings[0].tool.identifier} />
                <BindingList bindings={bindings} />
                {deployment && bindings[0].tool.identifier && (
                  <OnDemand label="contract history" testId="tool-contract-history">
                    {() => (
                      <ContractHistory
                        deployment={deployment}
                        tool={{ kind: bindings[0].tool.kind, identifier: bindings[0].tool.identifier }}
                      />
                    )}
                  </OnDemand>
                )}
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
    useQuery<ApprovedWorkflows>({ queryKey: [`/api/assurance/deployments/${encodeURIComponent(deployment)}/approved-workflows`] }),
  );
  if (assets.state !== "ready") return <NotInHand source={assets} what="the tool registrations" />;
  return (
    <ToolContractsView
      assets={assets.data}
      workflows={workflows.state === "ready" ? workflows.data : null}
      workflowsError={workflows.state === "error" ? workflows.message : null}
      deployment={deployment}
    />
  );
}
