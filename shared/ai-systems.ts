/**
 * The AI systems the AI Control page switches on and off, and what each
 * switch governs.
 *
 * The page offered "Active Systems" switches, a concurrency limit, an
 * auto-shutdown threshold and an override mode; the server stored them and
 * read none of them, so an operator who switched scanning off to halt it had
 * stopped nothing. Each switch here is enforced where it can be -- when a
 * scan STARTS (POST /api/scans refuses a scan whose system is off) -- and
 * never at a stop: no setting on that page can hold back a Stop, a kill
 * switch or a failsafe pause. A system this build has nothing to switch off
 * (the page's old "Threat Detection") is not offered at all.
 */

export const AI_SYSTEMS = [
  { id: "penetration-testing", label: "Penetration Testing" },
  { id: "vulnerability-scanner", label: "Vulnerability Scanner" },
] as const;

export type AiSystemId = (typeof AI_SYSTEMS)[number]["id"];

/** What an install starts with: every system this build can switch, on. */
export const DEFAULT_ACTIVE_SYSTEMS: string[] = AI_SYSTEMS.map((one) => one.id);

/**
 * The system an engine scan of this type runs under: a vulnerability scan
 * under the scanner, and every other engine scan -- the scan screens' default
 * "penetration_test" and any other type -- under penetration testing, so no
 * choice of test type gets a scan past both switches.
 */
export function systemOfScan(testType: string): AiSystemId {
  return /vuln/i.test(testType) ? "vulnerability-scanner" : "penetration-testing";
}

/**
 * What the installer wrote before its ids matched the page's. The page drew
 * every switch off over it while the record said three systems were on.
 * Exactly this list -- nobody has switched anything since install -- is the
 * installer's default, and is read as today's default (see
 * migrateLegacyActiveSystems). Any other list is someone's choice and is left
 * as it is: an id the page does not know is shown as unknown, never guessed.
 */
export const LEGACY_SEEDED_SYSTEMS = ["threat_detection", "vulnerability_scanner", "log_analyzer"];
