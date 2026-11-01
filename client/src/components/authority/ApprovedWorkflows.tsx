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
 * Its history: the backend serves the approval as it stands now -- who last
 * declared it and when, and when each tool was bound -- and records each earlier
 * version without serving it to this console. The screen says so.
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
  NotServed,
  Section,
  ToolName,
  When,
  censusTone,
  decisionLabel,
  decisionTone,
  served,
} from "./parts";
import type { ApprovedTool, ApprovedWorkflow, ApprovedWorkflows, WorkflowComposition } from "./types";

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

function WorkflowCard({ workflow }: { workflow: ApprovedWorkflow }) {
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

export function ApprovedWorkflowsView({ data }: { data: ApprovedWorkflows }) {
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
              <WorkflowCard key={workflow.uuid || workflow.slug} workflow={workflow} />
            ))}
          </ul>
        )}
        <NotServed testId="approval-history-not-served">
          Approval history: Athena-Backend records each earlier version of an approval and does not serve it to this
          console. Shown is each approval as it stands now: who last declared it and when, and when each tool was
          bound to its contract.
        </NotServed>
      </Section>
      <Section title="Chains reported against the approved set" testId="composition-section">
        <CompositionFacts composition={data.composition} />
      </Section>
    </div>
  );
}

export default function ApprovedWorkflowsScreen({ deployment }: { deployment: string }) {
  const source = served(
    useQuery<ApprovedWorkflows>({ queryKey: [`/api/assurance/deployments/${deployment}/approved-workflows`] }),
  );
  if (source.state !== "ready") return <NotInHand source={source} what="the approved workflows" />;
  return <ApprovedWorkflowsView data={source.data} />;
}
