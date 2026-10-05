/**
 * Where an engagement stands against OWASP ASVS 4.0.3.
 *
 * The whole risk in a compliance screen is that it makes an untested control
 * look like a passing one. A product whose scanners bear on 35 of the
 * standard's 286 requirements, rendering 286 rows with 251 of them green, has
 * told a customer something false about the other 251 -- and it is the most
 * convincing kind of false, because the 35 are real.
 *
 * So a requirement is in one of four states and never fewer:
 *
 *   failing      a finding from this engagement's scans maps to it
 *   tested       a scanner that can produce such a finding ran, and did not
 *   not_covered  nothing this engine tests for bears on this requirement
 *   not_run      something bears on it, but that scanner was not loaded
 *
 * `not_covered` and `not_run` are kept apart because they call for different
 * actions: the first is a limit of the product, the second is a deployment
 * that turned something off. Collapsing either into `tested` is the failure
 * this module exists to prevent, and collapsing them into each other hides a
 * misconfiguration behind a limitation.
 */

import {
  ASVS_CATALOGUE, ASVS_VERSION, FINDING_MAPPING, HEADER_MAPPING,
  SCANNER_FINDINGS, UNMAPPED_FINDINGS,
  type AsvsRequirement,
} from "@shared/asvs";

export type ControlState = "failing" | "tested" | "not_covered" | "not_run";

export interface ControlRow {
  requirement: AsvsRequirement;
  state: ControlState;
  /** Findings from this engagement that bear on it. */
  findings: ControlFinding[];
  /** Which scanners can bear on it at all, whether or not they ran. */
  scanners: string[];
  /** How the pairing was located in the standard. */
  why: string | null;
  /** True when the standard names nothing for this and the nearest was taken. */
  approximate: boolean;
}

export interface ControlFinding {
  type: string;
  severity: string | null;
  message: string | null;
  testId: string;
}

export interface ComplianceSummary {
  version: string;
  failing: number;
  tested: number;
  notRun: number;
  notCovered: number;
  total: number;
  /** Finding types this engagement produced that map to no requirement. */
  unmapped: Array<{ type: string; reason: string; count: number }>;
}

/** A finding as it comes off a test row, with the test it came from. */
export interface ScanFinding {
  testId: string;
  type?: string;
  header?: string;
  severity?: string;
  message?: string;
  internal?: boolean;
}

/**
 * Which requirements each finding type bears on.
 *
 * `missing_security_header` is expanded per header, because five different
 * controls arrive under one finding type and reporting them as one control
 * would say a site with no CSP has the same gap as one with no Referrer-Policy.
 */
function requirementsFor(finding: ScanFinding): { ids: string[]; why: string | null; approximate: boolean } {
  if (finding.type === "missing_security_header") {
    // No header name means the finding cannot be attributed to a control:
    // five different requirements arrive under this one type. Unmapped is the
    // honest answer, and the summary says which case it was.
    const entry = finding.header ? HEADER_MAPPING[finding.header] : undefined;
    if (!entry) return { ids: [], why: null, approximate: false };
    return { ids: entry.requirements, why: entry.why, approximate: entry.approximate === true };
  }
  const entry = finding.type ? FINDING_MAPPING[finding.type] : undefined;
  if (!entry) return { ids: [], why: null, approximate: false };
  return { ids: entry.requirements, why: entry.why, approximate: entry.approximate === true };
}

/** Every requirement any mapping can reach, with the scanners that reach it. */
function reachIndex(): Map<string, { scanners: Set<string>; why: string; approximate: boolean }> {
  const scannerOf = new Map<string, string[]>();
  for (const [scanner, types] of Object.entries(SCANNER_FINDINGS)) {
    for (const type of types) {
      scannerOf.set(type, [...(scannerOf.get(type) ?? []), scanner]);
    }
  }

  const index = new Map<string, { scanners: Set<string>; why: string; approximate: boolean }>();
  const add = (ids: string[], types: string[], why: string, approximate: boolean) => {
    for (const id of ids) {
      const existing = index.get(id) ?? { scanners: new Set<string>(), why, approximate };
      for (const type of types) {
        for (const scanner of scannerOf.get(type) ?? []) existing.scanners.add(scanner);
      }
      // An exact pairing anywhere makes the requirement exact; approximate is
      // only claimed when nothing exact reaches it.
      existing.approximate = existing.approximate && approximate;
      index.set(id, existing);
    }
  };

  for (const [type, entry] of Object.entries(FINDING_MAPPING)) {
    add(entry.requirements, [type], entry.why, entry.approximate === true);
  }
  for (const entry of Object.values(HEADER_MAPPING)) {
    add(entry.requirements, ["missing_security_header"], entry.why, entry.approximate === true);
  }
  return index;
}

const REACH = reachIndex();

/**
 * Build the control map.
 *
 * `loadedScanners` is what the engine reports it has loaded, measured from
 * disk. When it is null -- no engine, or one that would not answer -- every
 * requirement a scanner could reach is reported `not_run` rather than
 * `tested`: an engine we could not ask has not told us anything ran, and
 * reading silence as a pass is how this screen would lie.
 */
export function controlMap(
  findings: ScanFinding[],
  loadedScanners: string[] | null,
): { rows: ControlRow[]; summary: ComplianceSummary } {
  const real = findings.filter((one) => one.internal !== true && one.type);

  const byRequirement = new Map<string, ControlFinding[]>();
  const unmappedCounts = new Map<string, number>();

  for (const finding of real) {
    const { ids } = requirementsFor(finding);
    if (ids.length === 0) {
      const type = finding.type as string;
      unmappedCounts.set(type, (unmappedCounts.get(type) ?? 0) + 1);
      continue;
    }
    for (const id of ids) {
      byRequirement.set(id, [
        ...(byRequirement.get(id) ?? []),
        {
          type: finding.type as string,
          severity: finding.severity ?? null,
          message: finding.message ?? null,
          testId: finding.testId,
        },
      ]);
    }
  }

  const loaded = loadedScanners === null ? null : new Set(loadedScanners);

  const rows: ControlRow[] = ASVS_CATALOGUE.map((requirement) => {
    const reach = REACH.get(requirement.id);
    const hits = byRequirement.get(requirement.id) ?? [];
    const scanners = reach ? Array.from(reach.scanners).sort() : [];

    let state: ControlState;
    if (hits.length > 0) {
      state = "failing";
    } else if (!reach) {
      state = "not_covered";
    } else if (loaded === null) {
      // Nothing told us a scanner ran.
      state = "not_run";
    } else if (scanners.some((one) => loaded.has(one))) {
      state = "tested";
    } else {
      state = "not_run";
    }

    return {
      requirement,
      state,
      findings: hits,
      scanners,
      why: reach?.why ?? null,
      approximate: reach?.approximate === true,
    };
  });

  const count = (state: ControlState) => rows.filter((row) => row.state === state).length;

  return {
    rows,
    summary: {
      version: ASVS_VERSION,
      failing: count("failing"),
      tested: count("tested"),
      notRun: count("not_run"),
      notCovered: count("not_covered"),
      total: rows.length,
      unmapped: Array.from(unmappedCounts.entries())
        .map(([type, count]) => ({
          type,
          // A missing-header finding is not unmapped because the standard is
          // silent -- it is unmapped because this header is not one of the
          // five the mapping knows, or the finding did not name one. Saying
          // "the standard does not cover it" there would be false.
          reason: UNMAPPED_FINDINGS[type]
            ?? (type === "missing_security_header"
              ? "the finding did not name a header this mapping knows, so it cannot be attributed to one of the five header requirements"
              : "no requirement in this version of the standard covers it"),
          count,
        }))
        .sort((a, b) => b.count - a.count),
    },
  };
}
