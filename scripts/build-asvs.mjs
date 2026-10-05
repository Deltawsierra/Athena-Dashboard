/**
 * Generate shared/asvs.ts from the OWASP ASVS 4.0.3 release data.
 *
 * Run with the ASVS repository checked out somewhere and its path passed in:
 *
 *   node scripts/build-asvs.mjs /path/to/ASVS
 *
 * WHAT IS AND IS NOT EMBEDDED
 *
 * Identifiers only. ASVS requirement text is CC BY-SA 4.0, and share-alike on
 * text inlined into a proprietary product is a licensing decision rather than
 * an engineering one. So the generated file carries requirement ids, chapter
 * and section ids, CWE ids and the L1/L2/L3 levels -- facts and references --
 * and every requirement links out to the published standard for its wording.
 * `req_description` is read here, at build time, to locate the right
 * requirements; it is never written to the output.
 *
 * THE MAPPING
 *
 * Each entry below pairs one engine finding type with the ASVS requirements it
 * bears on. This table is Mythos's own judgement -- it is the one part of this
 * that is not derived -- so each entry records the search that located it, and
 * the build fails if any requirement id is not in the catalogue. A mapping
 * that silently points at nothing is worse than no mapping, because the
 * coverage figures downstream would still look plausible.
 *
 * Finding types deliberately absent from this table are listed in
 * UNMAPPED_FINDINGS with the reason. "Not mapped" is a first-class answer.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ASVS_ROOT = process.argv[2];
if (!ASVS_ROOT) {
  console.error("usage: node scripts/build-asvs.mjs /path/to/ASVS");
  process.exit(2);
}

const FLAT = join(
  ASVS_ROOT,
  "4.0/docs_en/OWASP Application Security Verification Standard 4.0.3-en.flat.json",
);

const VERSION = "4.0.3";
// The git tag the chapter files are read from. Not "v4.0.3": the repository
// tags releases as v<version>_release, and a link built on the wrong tag 404s
// exactly as convincingly as one built on the right one.
const TAG = "v4.0.3_release";
const LICENCE = "CC BY-SA 4.0";
const HOME = "https://owasp.org/www-project-application-security-verification-standard/";

/**
 * finding type -> { requirements, why }
 *
 * `why` records how the requirement was located in the standard, so a reviewer
 * can repeat the search rather than take the pairing on trust.
 */
const MAPPING = {
  command_injection: {
    requirements: ["V5.3.8"],
    why: 'the only requirement whose text names OS command injection ("operating system")',
  },
  sql_injection: {
    requirements: ["V5.3.4", "V5.3.5"],
    why: "the requirements carrying CWE-89: parameterized queries (V5.3.4) and context-specific output encoding against injection (V5.3.5)",
  },
  xss: {
    requirements: ["V5.3.3"],
    why: "the requirement carrying CWE-79: context-aware output escaping against reflected, stored and DOM XSS",
  },
  rce: {
    // The scanner sends ${7*7} and friends and looks for 49 in the response:
    // it detects server-side template injection, not deserialization or
    // arbitrary code upload. The requirements that name template injection are
    // the honest home for it.
    requirements: ["V5.2.5", "V5.2.8"],
    why: 'requirements whose text names template injection; the scanner tests ${7*7} evaluation',
  },
  ssrf: {
    requirements: ["V5.2.6"],
    why: "the requirement whose text names SSRF",
  },
  directory_traversal: {
    // The scanner requests ?file=../../etc/passwd and looks for "root:", which
    // is local file inclusion. V12.3.1 covers the filename-metadata half.
    requirements: ["V5.3.9", "V12.3.1"],
    why: "requirements naming Local File Inclusion and path traversal",
  },
  open_redirect: {
    requirements: ["V5.1.5"],
    why: "the requirement whose text names URL redirects and forwards",
  },
  json_injection: {
    requirements: ["V5.3.6", "V13.2.2"],
    why: "requirements naming JSON injection and JSON schema validation",
  },
  header_injection: {
    requirements: ["V5.1.1", "V13.1.1"],
    why: "parameter pollution and consistent parsing; the scanner injects CRLF and payloads into request headers",
  },
  auth_bruteforce: {
    requirements: ["V2.2.1"],
    why: "the requirement whose text names brute force and anti-automation of credential testing",
  },
  rate_limit_missing: {
    requirements: ["V11.1.4"],
    why: "the requirement naming anti-automation controls against excessive calls",
  },
  api_fuzz: {
    // The scanner flags 5xx responses and stack traces. A stack trace reaching
    // a client is a production debug-mode failure; the rest is an anomaly that
    // needs a person, which is why this maps to one requirement and not many.
    requirements: ["V14.3.2"],
    why: "the requirement naming debug modes disabled in production; the scanner flags stack traces and 5xx",
  },
  ssl_error: {
    requirements: ["V9.1.1", "V9.2.1"],
    why: "requirements naming TLS for all client connectivity and trusted TLS certificates",
  },
  subdomain: {
    requirements: ["V10.3.3"],
    why: "the requirement naming subdomain takeover",
  },
  idor: {
    requirements: ["V4.2.1"],
    why: "the requirement whose text names Insecure Direct Object Reference (IDOR), CWE-639",
  },
  csrf: {
    requirements: ["V4.2.2", "V13.2.3"],
    why: "the requirements naming a strong anti-CSRF mechanism (CWE-352), for the application (V4.2.2) and for cookie-using REST services (V13.2.3)",
  },
  xxe: {
    requirements: ["V5.5.2"],
    why: "the requirement whose text names XML External Entity (XXE) attacks and restrictive XML parser configuration, CWE-611",
  },
  cors_misconfiguration: {
    requirements: ["V14.5.3"],
    why: "the requirement that the CORS Access-Control-Allow-Origin header uses a strict allow list of trusted domains, CWE-346",
  },
  tls_certificate: {
    requirements: ["V9.2.1"],
    why: "the requirement that connections use trusted TLS certificates, CWE-295; the scanner flags expired, self-signed, and hostname-mismatched certificates",
  },
  tls_deprecated_protocol: {
    requirements: ["V9.1.2", "V9.1.3"],
    why: "the requirements that only strong cipher suites (V9.1.2) and only the latest TLS versions, 1.2 and 1.3 (V9.1.3), are enabled, CWE-326",
  },
  insecure_cookie: {
    requirements: ["V3.4.1", "V3.4.2"],
    why: "the requirements that session cookies set the Secure (V3.4.1, CWE-614) and HttpOnly (V3.4.2, CWE-1004) attributes",
  },
  vulnerable_component: {
    requirements: ["V14.2.1"],
    why: "the requirement that all components are up to date, CWE-1026; the scanner correlates disclosed component versions to known CVEs",
  },
};

/**
 * Which security header maps where. `missing_security_header` findings carry
 * the header name, so this is keyed on the header rather than lumping five
 * different controls under one finding type.
 */
const HEADER_MAPPING = {
  "Content-Security-Policy": {
    requirements: ["V14.4.3"],
    why: "the requirement naming a Content Security Policy response header",
  },
  "X-Frame-Options": {
    requirements: ["V14.4.7"],
    why: "the requirement that content cannot be embedded in a third-party site by default",
  },
  "X-Content-Type-Options": {
    requirements: ["V14.4.4"],
    why: "the requirement naming X-Content-Type-Options: nosniff",
  },
  "Referrer-Policy": {
    requirements: ["V14.4.6"],
    why: "the requirement naming a suitable Referrer-Policy header",
  },
  "Strict-Transport-Security": {
    // V14.4.5 names the header itself: a Strict-Transport-Security header on all
    // responses and all subdomains. Found by searching the 4.0.3 release text
    // for "Strict-Transport-Security". This used to say ASVS 4.0.3 names no HSTS
    // requirement and pair it with V9.1.1 as approximate; the requirement was
    // there all along.
    requirements: ["V14.4.5"],
    why: "the requirement naming a Strict-Transport-Security header on all responses and subdomains",
  },
};

/**
 * Finding types with no ASVS requirement, and why. Rendered in the product:
 * a finding the standard does not cover is a gap in the mapping, and hiding it
 * would make the coverage figure look better than it is.
 */
/**
 * Which scanner produces which finding type, extracted from the engine's own
 * registry in engine/core.py and the `"type"` literals in each scanner module,
 * rather than written from memory.
 *
 * This is load-bearing for honesty, not bookkeeping. Without it the product
 * cannot tell "a scanner looked and found nothing" from "nothing looked",
 * and a requirement nobody tested would render identically to one that
 * passed. Two of these -- port_scanner and subdomain_scanner -- have no `name`
 * attribute of their own and are named only by that registry, which is why the
 * registry is the authority here.
 */
const SCANNER_FINDINGS = {
  api_fuzz: ["api_fuzz"],
  basic_scanner: ["basic_info", "ssl_error"],
  bruteforce: ["auth_bruteforce"],
  command_injection: ["command_injection"],
  sql_injection: ["sql_injection"],
  xss: ["xss"],
  cors: ["cors_misconfiguration"],
  csrf: ["csrf"],
  tls: ["tls_certificate", "tls_deprecated_protocol"],
  xxe: ["xxe"],
  sca: ["vulnerable_component"],
  hygiene: ["insecure_cookie", "missing_security_txt"],
  idor: ["idor"],
  directory_traversal: ["directory_traversal"],
  endpoint_discovery: ["endpoint_exposed"],
  header_injection: ["header_injection"],
  header_scanner: ["missing_security_header"],
  json_injection: ["json_injection"],
  open_redirect: ["open_redirect"],
  port_scanner: ["open_port"],
  prompt_injection: ["prompt_injection"],
  rate_limit_tester: ["rate_limit_missing"],
  rce: ["rce"],
  ssrf: ["ssrf"],
  subdomain_scanner: ["subdomain"],
  waf_detector: ["waf_detected"],
};

const UNMAPPED_FINDINGS = {
  prompt_injection: "ASVS 4.0.3 contains no requirement about LLM prompt injection. The standard predates it.",
  basic_info: "reconnaissance output, not a control failure",
  open_port: "an observation about the host, not an application control",
  waf_detected: "an observation about the deployment, not a control failure",
  endpoint_exposed: "a discovered path; whether it should be reachable is a question for a person",
  missing_security_txt: "ASVS 4.0.3 has no requirement for a security.txt / vulnerability-disclosure file; its absence is an operational hygiene note, not a control the standard names",
  error: "the engine reporting its own trouble, not a finding about the target",
  timeout: "the engine reporting its own trouble, not a finding about the target",
};

/**
 * Chapter id to the file that holds its requirements, read from the checkout
 * rather than computed.
 *
 * The first version of this derived the filename arithmetically -- 0x10 for
 * V1, so 0x + (10 + n) in hex -- and every link it produced was a 404. The
 * real prefixes are not hex arithmetic (they run 0x10..0x19 then jump to
 * 0x20), V3 and V4 share 0x12, and each name carries a descriptive suffix.
 * There was no formula to get right. So the names are read from disk and the
 * build fails if a chapter has no file.
 */
function chapterFiles() {
  const dir = join(ASVS_ROOT, "4.0/en");
  const found = {};
  for (const name of readdirSync(dir)) {
    const match = /^0x[0-9a-f]+-(V\d+)-.+\.md$/.exec(name);
    if (match) found[match[1]] = name;
  }
  return found;
}

const raw = JSON.parse(readFileSync(FLAT, "utf8")).requirements;

// The flat JSON comes in two shapes. The file committed at the release tag has
// Item/Section/CWE/L1-L3; the export tool's other flattening has req_id,
// chapter_id, section_id, cwe and level1-3. Read either, so the documented
// source -- a checkout of the release tag -- regenerates this file as it is.
const field = (r, name, other) => (r[name] !== undefined ? r[name] : r[other]);
const catalogue = raw
  .map((r) => {
    const id = field(r, "req_id", "Item");
    const cwe = field(r, "cwe", "CWE");
    return {
      id,
      chapter: field(r, "chapter_id", "Section"),
      section: r.section_id !== undefined ? r.section_id : id.split(".").slice(0, 2).join("."),
      cwe: cwe ? Number(cwe) : null,
      l1: field(r, "level1", "L1") !== "",
      l2: field(r, "level2", "L2") !== "",
      l3: field(r, "level3", "L3") !== "",
    };
  })
  // Requirement order, numerically, whatever order the source lists them in.
  .sort((a, b) => {
    const x = a.id.slice(1).split(".").map(Number);
    const y = b.id.slice(1).split(".").map(Number);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });

const known = new Set(catalogue.map((r) => r.id));

// A mapped id that is not in the catalogue would produce a control the product
// claims to test and cannot name. Fail the build rather than ship it.
const missing = [];
for (const [finding, entry] of Object.entries(MAPPING)) {
  for (const id of entry.requirements) if (!known.has(id)) missing.push(`${finding} -> ${id}`);
}
for (const [header, entry] of Object.entries(HEADER_MAPPING)) {
  for (const id of entry.requirements) if (!known.has(id)) missing.push(`${header} -> ${id}`);
}
if (missing.length) {
  console.error("these mapped requirements are not in ASVS " + VERSION + ":");
  for (const one of missing) console.error("  " + one);
  process.exit(1);
}

// Every finding type in the mapping must be one some scanner can actually
// produce. A mapping for a finding type nothing emits is a control the
// product claims to cover and never will.
const emitted = new Set(Object.values(SCANNER_FINDINGS).flat());
// `error` and `timeout` are excluded: the engine emits them itself, marked
// internal, to report its own trouble rather than anything about the target.
// They are listed as unmapped because they do turn up in results and a reader
// deserves to know why they map to nothing.
const ENGINE_INTERNAL = new Set(["error", "timeout"]);
const phantom = [
  ...Object.keys(MAPPING),
  ...Object.keys(UNMAPPED_FINDINGS),
].filter((finding) => !emitted.has(finding) && !ENGINE_INTERNAL.has(finding));
if (phantom.length) {
  console.error("no scanner emits these finding types: " + phantom.join(", "));
  process.exit(1);
}

// Every chapter the catalogue names must have a file behind it, or its
// requirements link nowhere.
const CHAPTER_FILES = chapterFiles();
const chapterless = Array.from(new Set(catalogue.map((r) => r.chapter)))
  .filter((chapter) => !CHAPTER_FILES[chapter]);
if (chapterless.length) {
  console.error("no chapter file found for: " + chapterless.join(", "));
  process.exit(1);
}

const mapped = new Set([
  ...Object.values(MAPPING).flatMap((entry) => entry.requirements),
  ...Object.values(HEADER_MAPPING).flatMap((entry) => entry.requirements),
]);

const banner = `/**
 * OWASP ASVS ${VERSION}, as identifiers.
 *
 * GENERATED by scripts/build-asvs.mjs. Do not edit by hand; edit the mapping
 * in that script and regenerate.
 *
 * Requirement text is NOT here. ASVS is published under ${LICENCE}, and this
 * file carries only identifiers, CWE references and verification levels, with
 * a link out to the published standard for the wording. Attribution:
 * OWASP Application Security Verification Standard ${VERSION}, ${LICENCE}.
 * ${HOME}
 *
 * ${catalogue.length} requirements. ${mapped.size} of them can be reached by
 * something this engine tests for -- which is the number that matters, and the
 * reason the product says how many it did not test rather than reporting a
 * percentage over the ones it did.
 */
`;

const out = `${banner}
export const ASVS_VERSION = ${JSON.stringify(VERSION)};
export const ASVS_LICENCE = ${JSON.stringify(LICENCE)};
export const ASVS_HOME = ${JSON.stringify(HOME)};
export const ASVS_TAG = ${JSON.stringify(TAG)};

/**
 * Chapter id to its file in the published standard, read from the release
 * checkout. Computing this instead produced links that all 404'd: the
 * prefixes are not arithmetic, V3 and V4 share one, and each has a suffix.
 */
export const ASVS_CHAPTER_FILES: Record<string, string> = ${JSON.stringify(CHAPTER_FILES, null, 2)};

/** The published text for a requirement's chapter. */
export function asvsChapterUrl(chapter: string): string | null {
  const file = ASVS_CHAPTER_FILES[chapter];
  return file
    ? \`https://github.com/OWASP/ASVS/blob/\${ASVS_TAG}/4.0/en/\${file}\`
    : null;
}

export interface AsvsRequirement {
  id: string;
  chapter: string;
  section: string;
  /** The CWE the standard associates with this requirement, where it names one. */
  cwe: number | null;
  l1: boolean;
  l2: boolean;
  l3: boolean;
}

export interface FindingMapping {
  requirements: string[];
  /** How the pairing was located in the standard, so a reviewer can repeat it. */
  why: string;
  /** True when the standard has no requirement for this and the nearest was taken. */
  approximate?: boolean;
}

export const ASVS_CATALOGUE: AsvsRequirement[] = ${JSON.stringify(catalogue, null, 2)};

/** Engine finding type to the requirements it bears on. */
export const FINDING_MAPPING: Record<string, FindingMapping> = ${JSON.stringify(MAPPING, null, 2)};

/** \`missing_security_header\` carries the header name; each header is its own control. */
export const HEADER_MAPPING: Record<string, FindingMapping> = ${JSON.stringify(HEADER_MAPPING, null, 2)};

/**
 * Which scanner produces which finding type, from the engine's own registry.
 * Without this the product cannot tell a requirement that was tested and
 * passed from one nothing ever looked at.
 */
export const SCANNER_FINDINGS: Record<string, string[]> = ${JSON.stringify(SCANNER_FINDINGS, null, 2)};

/** Finding types with no requirement behind them, and why. Shown, not hidden. */
export const UNMAPPED_FINDINGS: Record<string, string> = ${JSON.stringify(UNMAPPED_FINDINGS, null, 2)};
`;

writeFileSync(join(process.cwd(), "shared/asvs.ts"), out);
console.log(
  `wrote shared/asvs.ts: ${catalogue.length} requirements, ` +
    `${mapped.size} reachable by ${Object.keys(MAPPING).length + Object.keys(HEADER_MAPPING).length} mappings, ` +
    `${Object.keys(UNMAPPED_FINDINGS).length} finding types deliberately unmapped`,
);
