/**
 * The recovery record (SPINE SP-1) as this console's server maps it from
 * Athena-Backend (athena-backend assurance/recovery_record.py: `served` for a
 * step, `finding_record` for one incident, `deployment_records` for a page of a
 * deployment's incidents), for the recovery screen
 * (client/src/components/authority/RecoveryRecords.tsx) to read.
 *
 * An incident is a finding with a recovery record. Each step is one
 * `mythos_core.status` Recovery: one of S1's seven states, the conditions that
 * support it (each with its witness), its gaps, its restrictions, the release
 * word it yields, the coverage it rests on, its residual uncertainty (each item
 * with its sources) and the owner's acceptance as recorded. The words are S1's
 * and the backend's, carried as served: nothing here is a vocabulary of its own.
 *
 * camelCase. A null is what the backend served as absent, or did not serve:
 * never a value filled in here, and never an empty list in place of one not
 * served. A record that cannot be read whole is not served in part (the server
 * answers it as unavailable instead).
 */

/** What a condition rests on: the kind of witness and its reference. */
export interface RecoveryWitness {
  kind: string | null;
  ref: string | null;
}

/** One condition a step's state rests on, with its witness (null: none served). */
export interface RecoveryCondition {
  condition: string | null;
  witness: RecoveryWitness | null;
}

/** One source a residual uncertainty names. */
export interface RecoverySource {
  kind: string | null;
  ref: string | null;
}

/** One item of a step's residual uncertainty, with every source it names (null: none served). */
export interface ResidualUncertainty {
  statement: string | null;
  sources: RecoverySource[] | null;
}

/** An interval of a coverage source, as served. */
export interface CoverageInterval {
  start: string | null;
  end: string | null;
}

/** A source the step's coverage manifest requires. */
export interface CoverageSource extends CoverageInterval {
  source: string | null;
  kind: string | null;
}

/** A gap the step's coverage manifest declares. */
export interface CoverageGap extends CoverageInterval {
  kind: string | null;
  subject: string | null;
  detail: string | null;
}

/** The coverage a step rests on: its manifest as recorded, and what `coverage.coverage_ratio` measures of it. */
export interface RecoveryCoverage {
  /** The required sources the manifest declares. */
  sources: CoverageSource[] | null;
  /** The gaps the manifest declares. */
  declaredGaps: CoverageGap[] | null;
  observedSources: number | null;
  requiredSources: number | null;
  complete: boolean | null;
  /** Each required source not fully observed, with the intervals left unobserved. */
  missing: Record<string, CoverageInterval[]> | null;
  unknownInventory: string[] | null;
}

/** One step of an incident's recovery record. */
export interface RecoveryStep {
  /** The step's id: what a later step names when it reopens this one. */
  ref: string | null;
  version: number | null;
  /** One of S1's recovery states, as served. */
  state: string | null;
  /** The step this one reopens; null when it reopens none. */
  reopens: string | null;
  conditions: RecoveryCondition[] | null;
  gaps: string[] | null;
  restrictions: string[] | null;
  /** The release word this step yields (S1's release states), as served. */
  release: string | null;
  residualUncertainty: ResidualUncertainty[] | null;
  coverage: RecoveryCoverage | null;
  /** Who accepted, as recorded; null when nobody is on record. */
  acceptedBy: string | null;
  /** When the acceptance ends, as recorded; null when none is on record. */
  acceptedUntil: string | null;
  recordedBy: string | null;
  recordedAt: string | null;
}

/** The incident's latest step, as the backend names it. */
export interface RecoveryCurrent {
  version: number | null;
  state: string | null;
  release: string | null;
}

/** One incident -- a finding with a recovery record -- and every step, oldest first as served. */
export interface RecoveryIncident {
  finding: string | null;
  title: string | null;
  severity: string | null;
  /** null: the backend named no current step. */
  current: RecoveryCurrent | null;
  steps: RecoveryStep[];
}

/** One page of a deployment's incidents (athena-backend `deployment_records`, 50 a page). */
export interface RecoveryRecords {
  /** The deployment the backend answered for; null when it named none. */
  deployment: string | null;
  incidents: RecoveryIncident[];
  /** How many incidents the deployment has, whether or not all were returned. */
  incidentCount: number | null;
  returned: number | null;
  /** true: more incidents are recorded than this page; `offset + returned` reads on. null: not said. */
  truncated: boolean | null;
  pageSize: number | null;
  offset: number | null;
}

/** One incident's recovery record, read by its finding (athena-backend `finding_record`). */
export interface FindingRecoveryRecord extends RecoveryIncident {
  deployment: string | null;
}
