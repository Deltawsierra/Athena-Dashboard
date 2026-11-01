/**
 * Approved workflows: what is approved on a deployment, the tools each approval
 * binds and the contract each was approved under, and the composition of the
 * chains reported against them -- read from Athena-Backend's
 * GET /api/assurance/deployments/<uuid>/approved-workflows/ (through
 * /api/assurance/deployments/:uuid/approved-workflows on this server).
 *
 * An approval names its workflow and binds tools by kind and identifier. Which
 * agent may use what, and to what effect, is the approval's own prose: the backend
 * holds no structured agent or scope field on it, so none is drawn here.
 *
 * Its history: every recorded version of each approval, newest first, read from
 * GET /api/assurance/deployments/<uuid>/approval-history/ (through
 * /api/assurance/deployments/:uuid/approval-history on this server) -- under the
 * approval it belongs to (?workflow=<slug>), or every approval's together, approvals
 * since withdrawn included. Each version: its digest, or that it was withdrawn; from
 * when and until when it was in force; who declared it, where the backend records
 * that (`declared_by`), and "not recorded" where it does not; and every tool it bound,
 * with the contract it was approved under and the binding live when it came into
 * force. Each is read only when a person opens it, a page at a time
 * (components/authority/history.tsx).
 */
import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";
import {
  Absent,
  CENSUS_LABELS,
  Chip,
  Count,
  Digest,
  Fact,
  NotInHand,
  Section,
  ToolName,
  When,
  censusTone,
  decisionLabel,
  decisionTone,
  served,
} from "./parts";
import { HistoryPageFrame, HistoryPages, OnDemand, type PageSlot } from "./history";
import type {
  ApprovalHistory,
  ApprovalVersion,
  ApprovalVersionTool,
  ApprovedTool,
  ApprovedWorkflow,
  ApprovedWorkflows,
  WorkflowComposition,
} from "./types";

/** Whether an approval still binds the contract in force, in words. Unchanged is a fact, not a clear result. */
export function ContractStanding({ tool }: { tool: ApprovedTool }) {
  if (tool.superseded === true) {
    return (
      <Chip tone="caution" testId="contract-standing">
        {tool.currentDigest === null ? "Tool no longer registered" : "Contract changed since approval"}
      </Chip>
    );
  }
  if (tool.superseded === false) {
    return (
      <Chip tone="neutral" testId="contract-standing">
        Contract unchanged since approval
      </Chip>
    );
  }
  return <Absent testId="contract-standing">whether the contract changed was not said</Absent>;
}

function ToolRow({ tool }: { tool: ApprovedTool }) {
  return (
    <li className="space-y-1 rounded-md border border-border/50 bg-surface-1/40 p-2" data-approved-tool={`${tool.kind}:${tool.identifier}`}>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <ToolName kind={tool.kind} identifier={tool.identifier} />
        <ContractStanding tool={tool} />
      </div>
      <Fact label="Approved under contract">
        <Digest value={tool.approvedDigest} testId="approved-digest" />
      </Fact>
      <Fact label="Bound at">
        <When iso={tool.boundAt} testId="bound-at" />
      </Fact>
      <Fact label="Contract in force now">
        <Digest value={tool.currentDigest} absent="none: the tool is no longer registered" testId="current-digest" />
      </Fact>
    </li>
  );
}

// ---- the approval history ----

/** Whether a version's tool names a binding at all: none on record serves every binding field null. */
function bindingOnRecord(tool: ApprovalVersionTool): boolean {
  return (
    tool.boundAt !== null || tool.boundBy !== null || tool.releasedAt !== null ||
    tool.invalidatedAt !== null || tool.invalidationReason !== null
  );
}

/** One tool a version bound: the contract it was approved under, and the binding live when the version came into force. */
export function VersionToolRow({ tool }: { tool: ApprovalVersionTool }) {
  return (
    <li
      className="space-y-1 rounded-md border border-border/50 bg-surface-1/40 p-2"
      data-version-tool={`${tool.kind ?? ""}:${tool.identifier ?? ""}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {tool.kind === null && tool.identifier === null ? (
          <Absent testId="version-tool-name">the tool is not recorded on this version</Absent>
        ) : (
          <ToolName kind={tool.kind ?? "kind not recorded"} identifier={tool.identifier ?? ""} />
        )}
        {tool.invalidatedAt !== null && (
          <Chip tone="caution" testId="version-tool-invalidated">
            Binding invalidated
          </Chip>
        )}
      </div>
      <Fact label="Approved under contract">
        <Digest value={tool.contractDigest} testId="version-tool-digest" />
      </Fact>
      {bindingOnRecord(tool) ? (
        <>
          <Fact label="Bound at">
            <When iso={tool.boundAt} testId="version-tool-bound-at" />
          </Fact>
          <Fact label="Bound by">
            {tool.boundBy ? (
              <span className="text-foreground" data-testid="version-tool-bound-by">{tool.boundBy}</span>
            ) : (
              <Absent testId="version-tool-bound-by">not on record</Absent>
            )}
          </Fact>
          <Fact label="Released at">
            <When iso={tool.releasedAt} absent="not released" testId="version-tool-released-at" />
          </Fact>
          <Fact label="Invalidated">
            {tool.invalidatedAt !== null ? (
              <span data-testid="version-tool-invalidation">
                <When iso={tool.invalidatedAt} />{" "}
                {tool.invalidationReason ? (
                  <span className="text-foreground">{tool.invalidationReason}</span>
                ) : (
                  <Absent>no reason recorded</Absent>
                )}
              </span>
            ) : (
              <Absent testId="version-tool-invalidation">not invalidated</Absent>
            )}
          </Fact>
        </>
      ) : (
        <p className="text-[12px]">
          <Absent testId="version-tool-no-binding">
            No binding of it is on record for when this version came into force.
          </Absent>
        </p>
      )}
    </li>
  );
}

/** One recorded version of an approval. Withdrawn is a fact about the approval, drawn neutral. */
export function ApprovalVersionRow({ version, showWorkflow }: { version: ApprovalVersion; showWorkflow: boolean }) {
  const withdrawn = version.withdrawn === true;
  return (
    <li className="space-y-1.5 rounded-md border border-border/60 bg-surface-1/30 p-2.5" data-approval-version={version.version ?? ""}>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {showWorkflow &&
          (version.workflow ? (
            <code className="font-mono text-[12px] text-foreground" data-testid="version-workflow">{version.workflow}</code>
          ) : (
            <Absent testId="version-workflow">workflow not recorded</Absent>
          ))}
        <span className="text-muted-foreground">
          Version{" "}
          {version.version ? <code className="font-mono text-[11px]">{version.version}</code> : <Absent>id not served</Absent>}
        </span>
        {withdrawn && (
          <Chip tone="neutral" testId="version-withdrawn">
            Withdrawn
          </Chip>
        )}
        {version.withdrawn === null && <Absent testId="version-withdrawn">whether it was withdrawn was not said</Absent>}
      </div>
      <Fact label="Approval digest">
        {withdrawn ? (
          <Absent testId="version-digest">none: withdrawn</Absent>
        ) : (
          <Digest value={version.digest} testId="version-digest" />
        )}
      </Fact>
      <Fact label="In force from">
        <When iso={version.inForceFrom} testId="version-from" />
      </Fact>
      <Fact label="In force until">
        <When iso={version.inForceUntil} absent="no later version is recorded" testId="version-until" />
      </Fact>
      <Fact label="Recorded at">
        <When iso={version.recordedAt} testId="version-recorded-at" />
      </Fact>
      <Fact label="Declared by">
        {version.declaredBy ? (
          <span className="text-foreground" data-testid="version-declared-by">{version.declaredBy}</span>
        ) : (
          <Absent testId="version-declared-by">not recorded</Absent>
        )}
      </Fact>
      {version.tools.length === 0 ? (
        <p className="text-[12px]" data-testid="version-no-tools">
          <Absent>{withdrawn ? "A withdrawn approval binds no tools." : "This version bound no tools."}</Absent>
        </p>
      ) : (
        <ul className="space-y-1.5">
          {version.tools.map((tool, index) => (
            <VersionToolRow key={`${tool.kind}:${tool.identifier}:${index}`} tool={tool} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A page of approval versions, newest first; an empty first page says no version is recorded. */
export function ApprovalVersionList({
  versions,
  showWorkflow,
  empty,
}: {
  versions: ApprovalVersion[];
  showWorkflow: boolean;
  /** What an empty page says; null for a later page, which says nothing. */
  empty: string | null;
}) {
  if (versions.length === 0) {
    return empty === null ? null : (
      <p className="text-[12px]" data-testid="no-versions">
        <Absent>{empty}</Absent>
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {versions.map((version, index) => (
        <ApprovalVersionRow key={version.version ?? `at-${index}`} version={version} showWorkflow={showWorkflow} />
      ))}
    </ul>
  );
}

/** One page of the approval history: one approval's (`workflow`), or every approval's. */
function ApprovalHistoryPage({ deployment, workflow, slot }: { deployment: string; workflow?: string; slot: PageSlot }) {
  const offset = slot.offset;
  const source = served(
    useQuery<ApprovalHistory>({
      queryKey: [`/api/assurance/deployments/${encodeURIComponent(deployment)}/approval-history`, { workflow, offset }],
    }),
  );
  return (
    <HistoryPageFrame
      source={source}
      deployment={deployment}
      slot={slot}
      what={workflow ? "this approval's version history" : "the approval history"}
      count={(page) => page.versionCount}
      rows={(page) => page.versions.length}
    >
      {(page) => (
        <ApprovalVersionList
          versions={page.versions}
          showWorkflow={!workflow}
          empty={
            offset !== 0
              ? null
              : workflow
                ? "No version of this approval is recorded."
                : "No approval version is recorded for this deployment."
          }
        />
      )}
    </HistoryPageFrame>
  );
}

/** A history of approval versions, from its first page, kept per deployment and workflow. */
export function ApprovalHistoryPages({ deployment, workflow }: { deployment: string; workflow?: string }) {
  return (
    <HistoryPages
      key={`${deployment}:${workflow ?? ""}`}
      page={(slot) => <ApprovalHistoryPage deployment={deployment} workflow={workflow} slot={slot} />}
    />
  );
}

function WorkflowCard({ workflow, deployment }: { workflow: ApprovedWorkflow; deployment?: string }) {
  return (
    <li className="space-y-2 rounded-lg border border-border/60 bg-surface-1/30 p-3" data-workflow={workflow.slug}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">{workflow.name || workflow.slug}</h3>
        <code className="font-mono text-[11px] text-muted-foreground">{workflow.slug}</code>
      </div>
      <Fact label="Approved to do">
        {workflow.description ? (
          <span className="text-foreground" data-testid="workflow-description">{workflow.description}</span>
        ) : (
          <Absent testId="workflow-description">not recorded: the approval says nothing of what it covers</Absent>
        )}
      </Fact>
      <Fact label="Last declared by">
        {workflow.approvedBy ? (
          <span className="text-foreground" data-testid="approved-by">{workflow.approvedBy}</span>
        ) : (
          <Absent testId="approved-by">not on record: the approver&apos;s account was removed</Absent>
        )}
      </Fact>
      <Fact label="Last declared at">
        <When iso={workflow.approvedAt} testId="approved-at" />
      </Fact>
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Tools this approval binds</p>
        {workflow.tools.length === 0 ? (
          <p className="mt-1 text-[12px]" data-testid="no-tools">
            <Absent>This approval binds no tools.</Absent>
          </p>
        ) : (
          <ul className="mt-1 space-y-2">
            {workflow.tools.map((tool) => (
              <ToolRow key={`${tool.kind}:${tool.identifier}`} tool={tool} />
            ))}
          </ul>
        )}
      </div>
      {deployment && workflow.slug && (
        <OnDemand label="version history" testId="approval-version-history">
          {() => <ApprovalHistoryPages deployment={deployment} workflow={workflow.slug} />}
        </OnDemand>
      )}
    </li>
  );
}

/** The chains reported against the approved set, as the backend composes them. */
export function CompositionFacts({ composition }: { composition: WorkflowComposition | null }) {
  if (composition === null) {
    return <Absent testId="composition">The composition of the workflow chains was not served.</Absent>;
  }
  return (
    <div className="space-y-2" data-testid="composition">
      <Fact label="Approved workflows the chains are measured against">
        {composition.workflowsExpected === null ? (
          <Absent testId="workflows-expected">none: no approved set is recorded</Absent>
        ) : (
          <Count value={composition.workflowsExpected} testId="workflows-expected" />
        )}
      </Fact>
      <Fact label="Workflows with a chain outcome">
        <Count value={composition.workflowsAssessed} />
      </Fact>
      <Fact label="Approved workflows nobody reported">
        <Count value={composition.workflowsUnreported} />
      </Fact>
      <Fact label="Outcomes for workflows nobody approved">
        <Count value={composition.workflowsUnapproved} />
      </Fact>
      <div className="flex flex-wrap gap-2" data-testid="composition-census">
        {Object.keys(composition.census).length === 0 ? (
          <Absent>no status census was served</Absent>
        ) : (
          Object.entries(composition.census).map(([status, count]) => (
            <Chip key={status} tone={count > 0 ? censusTone(status) : "neutral"}>
              {CENSUS_LABELS[status] ?? status}: {count}
            </Chip>
          ))
        )}
      </div>
      <Fact label="What the chains contribute to the decision">
        {composition.signal === null ? (
          <Absent testId="composition-signal">nothing</Absent>
        ) : (
          <Chip tone={decisionTone(composition.signal, { asInput: true })} testId="composition-signal">
            {decisionLabel(composition.signal)}
          </Chip>
        )}
      </Fact>
      {composition.explanation && (
        <p className="text-[12px] leading-relaxed text-muted-foreground" data-testid="composition-explanation">
          {composition.explanation}
        </p>
      )}
    </div>
  );
}

export function ApprovedWorkflowsView({
  data,
  deployment,
}: {
  data: ApprovedWorkflows;
  /** The deployment the approvals are of; with it, each approval offers its version history. */
  deployment?: string;
}) {
  const shownAll = data.truncated !== true;
  return (
    <div className="space-y-4" data-screen="approved-workflows">
      <Section title="What is approved" icon={<ClipboardCheck className="h-4 w-4 text-primary" />} testId="approved-section">
        <Fact label="Approvals recorded">
          <Count value={data.approvedCount} testId="approved-count" />
        </Fact>
        {!shownAll && (
          <p className="text-[12px] text-amber-400" data-testid="approved-truncated">
            Showing {data.returned ?? "some"} of {data.approvedCount ?? "more"}: the backend returns at most{" "}
            {data.pageSize ?? "a page"} at a time.
          </p>
        )}
        {data.approved.length === 0 ? (
          <p className="text-[13px]" data-testid="no-approvals">
            <Absent>
              No approved set is recorded for this deployment. Until one is, the backend measures no workflow
              chain against an approval.
            </Absent>
          </p>
        ) : (
          <ul className="space-y-3">
            {data.approved.map((workflow) => (
              <WorkflowCard key={workflow.uuid || workflow.slug} workflow={workflow} deployment={deployment} />
            ))}
          </ul>
        )}
        <p className="text-[12px] leading-relaxed text-muted-foreground" data-testid="approval-history-note">
          Approval history: each approval&apos;s earlier versions are read from Athena-Backend&apos;s record, under the
          approval, or every approval&apos;s together below, approvals since withdrawn included. A version names who
          declared it where the backend records that, and reads not recorded where it does not; who bound each tool,
          and when, is on record.
        </p>
      </Section>
      {deployment && (
        <Section title="Every recorded approval version" testId="approval-history-section">
          <p className="text-[12px] text-muted-foreground">
            Every version of every approval on this deployment, newest first, including approvals since withdrawn.
          </p>
          <OnDemand label="every recorded version" testId="every-approval-version">
            {() => <ApprovalHistoryPages deployment={deployment} />}
          </OnDemand>
        </Section>
      )}
      <Section title="Chains reported against the approved set" testId="composition-section">
        <CompositionFacts composition={data.composition} />
      </Section>
    </div>
  );
}

export default function ApprovedWorkflowsScreen({ deployment }: { deployment: string }) {
  const source = served(
    useQuery<ApprovedWorkflows>({ queryKey: [`/api/assurance/deployments/${encodeURIComponent(deployment)}/approved-workflows`] }),
  );
  if (source.state !== "ready") return <NotInHand source={source} what="the approved workflows" />;
  return <ApprovedWorkflowsView data={source.data} deployment={deployment} />;
}
