/**
 * The shapes the authority screens read, as this console's server maps them from
 * Athena-Backend (server/assurance.ts: ApprovedWorkflows, AuthorityChains,
 * DecisionSupport, AssuranceAsset). camelCase; a null is what the backend served
 * as absent, or did not serve -- never a value filled in here.
 */

export interface WorkflowComposition {
  signal: string | null;
  ruleDecision: string | null;
  census: Record<string, number>;
  deciding: string[];
  workflowsAssessed: number | null;
  /** null: nobody has recorded the approved set. */
  workflowsExpected: number | null;
  workflowsUnreported: number | null;
  workflowsUnapproved: number | null;
  workflowsUnexercised: number | null;
  unexercised: string[];
  authorizationChecked: string[];
  offRoute: string[];
  explanation: string;
}

export interface ApprovedTool {
  kind: string;
  identifier: string;
  approvedDigest: string | null;
  boundAt: string | null;
  /** null: the tool is no longer registered. */
  currentDigest: string | null;
  superseded: boolean | null;
}

export interface ApprovedWorkflow {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /** null: the backend names no approver (the approver's account was removed). */
  approvedBy: string | null;
  approvedAt: string | null;
  tools: ApprovedTool[];
}

export interface ApprovedWorkflows {
  approved: ApprovedWorkflow[];
  returned: number | null;
  truncated: boolean | null;
  pageSize: number | null;
  approvedCount: number | null;
  composition: WorkflowComposition | null;
}

export interface ChainNode {
  kind: string;
  ref: string;
  version: string | null;
}

export interface ChainReading {
  verdict: string;
  code: string;
  detail: string;
}

export interface ChainHop {
  index: number | null;
  from: ChainNode;
  relation: string;
  to: ChainNode;
  verdict: string;
  provenBy: ChainReading[];
  reasons: ChainReading[];
}

export interface AuthorityChain {
  uuid: string;
  workflow: string;
  effect: string;
  digest: string;
  standing: boolean | null;
  verdict: string;
  basis: string;
  basisInForce: string;
  signed: boolean | null;
  observerEngine: string | null;
  outcomeId: string | null;
  gateOutcomeId: string | null;
  effectOutcomeId: string | null;
  route: string | null;
  observedAt: string | null;
  recordedAt: string | null;
  recordedBy: string | null;
  source: string;
  note: string;
  unprovenHops: number[];
  brokenHops: number[];
  hops: ChainHop[];
}

export interface ConsequentialEffect {
  digest: string;
  workflow: string | null;
  toolKind: string;
  toolIdentifier: string;
  effectClass: string | null;
  effectKind: string;
  status: string;
  reasons: string[];
  chains: string[];
  toDo: string | null;
}

export interface AuthorityChains {
  chains: AuthorityChain[];
  returned: number | null;
  truncated: boolean | null;
  pageSize: number | null;
  recorded: number | null;
  standing: number | null;
  superseded: number | null;
  verdictCensus: Record<string, number>;
  approvalsInForce: Record<string, string>;
  effects: ConsequentialEffect[];
  effectCensus: Record<string, number>;
}

export interface ChainBrief {
  uuid: string;
  workflow: string;
  effect: string;
  digest: string;
  verdict: string;
  hops: Array<{ index: number | null; relation: string; from: ChainNode; to: ChainNode; verdict: string; reasons: string[] }>;
}

export interface SupersededToolContract {
  subject: string;
  claimFingerprint: string | null;
  workflow: string | null;
  toolKind: string;
  toolIdentifier: string;
  boundDigest: string | null;
  currentDigest: string | null;
}

export interface ClaimBrief {
  uuid: string;
  claimType: string;
  status: string;
  statement: string;
}

export interface DecisionSupport {
  decision: string | null;
  decisionLabel: string | null;
  revision: number | null;
  fromFindings: string | null;
  claimCap: string | null;
  coverageCap: string | null;
  acceptedRiskCap: string | null;
  policyVersion: string | null;
  composition: WorkflowComposition | null;
  paused: boolean;
  claims: {
    hasClaims: boolean;
    retestPending: boolean;
    contradicted: ClaimBrief[];
    stale: ClaimBrief[];
    unknown: ClaimBrief[];
    supporting: ClaimBrief[];
    supersededToolContracts: SupersededToolContract[];
    authorityChainsBroken: ChainBrief[];
    authorityChainsUnproven: ChainBrief[];
    authorityChainsMissing: ConsequentialEffect[];
    effectClassesUnknown: ConsequentialEffect[];
  };
  note: string;
}

/** The fields of an asset the tool-contract screen reads (server/assurance.ts AssuranceAsset). */
export interface ToolAsset {
  uuid: string;
  deploymentUuid: string | null;
  kind: string;
  kindLabel: string;
  name: string;
  identifier: string;
  classification: string;
  classificationLabel: string;
  metadata: Record<string, unknown>;
  firstSeen: string | null;
  lastSeen: string | null;
}

// ---- the recorded histories (server/assurance.ts: ApprovalHistory, ToolContractHistory,
// ToolContractBindings, DecisionHistory) ----

/** The page every history read answers with: what it was read for, and how much of it this is. */
export interface HistoryPage {
  /** The deployment the backend answered for; null when it named none. */
  deployment: string | null;
  returned: number | null;
  /** true: the history holds more than this page. null: not said. */
  truncated: boolean | null;
  pageSize: number | null;
  offset: number | null;
}

export interface ApprovalVersionTool {
  kind: string | null;
  identifier: string | null;
  contractDigest: string | null;
  boundAt: string | null;
  /** null: no binder on record. */
  boundBy: string | null;
  releasedAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
}

export interface ApprovalVersion {
  version: string | null;
  workflow: string | null;
  /** null once withdrawn. */
  digest: string | null;
  withdrawn: boolean | null;
  inForceFrom: string | null;
  /** null while no later version is recorded. */
  inForceUntil: string | null;
  recordedAt: string | null;
  /** null: Athena-Backend serves no declarer for the version (the field absent, or null). */
  declaredBy: string | null;
  tools: ApprovalVersionTool[];
}

export interface ApprovalHistory extends HistoryPage {
  workflow: string | null;
  versions: ApprovalVersion[];
  versionCount: number | null;
}

export interface ToolContractRecord {
  kind: string | null;
  identifier: string | null;
  digest: string | null;
  contract: Record<string, unknown> | null;
  recordedAt: string | null;
  /** null while no later contract of the registration is recorded. */
  supersededAt: string | null;
  /** null: the tool is no longer registered. */
  currentDigest: string | null;
  inForce: boolean | null;
}

export interface ToolContractHistory extends HistoryPage {
  kind: string | null;
  identifier: string | null;
  contracts: ToolContractRecord[];
  contractCount: number | null;
}

export interface ToolContractBindingRecord {
  subject: string | null;
  workflow: string | null;
  claimFingerprint: string | null;
  kind: string | null;
  identifier: string | null;
  contractDigest: string | null;
  currentDigest: string | null;
  live: boolean | null;
  /** null on a released binding, which holds nothing. */
  superseded: boolean | null;
  boundAt: string | null;
  boundBy: string | null;
  releasedAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
}

export interface ToolContractBindings extends HistoryPage {
  kind: string | null;
  identifier: string | null;
  bindings: ToolContractBindingRecord[];
  bindingCount: number | null;
}

export interface DecisionTransitionRecord {
  revision: number | null;
  /** null: no decision before (the deployment's first). */
  fromDecision: string | null;
  toDecision: string | null;
  /** null: the writer supplied none. */
  basisDigest: string | null;
  createdAt: string | null;
  /** null: not yet confirmed downstream. */
  deliveredAt: string | null;
}

export interface DecisionHistory extends HistoryPage {
  transitions: DecisionTransitionRecord[];
  transitionCount: number | null;
}
