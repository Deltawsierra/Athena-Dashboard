/**
 * Persona microcopy lint — a TypeScript mirror of the Mythos persona fence.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ CANONICAL SOURCE = the owner's CHARTER + `mythos_core.persona`.             │
 * │ A FENCE CHANGE MUST BE MIRRORED HERE.                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The persona fence is shared in Python as `mythos_core.persona`
 * (`mythos_core.persona.lexicon.FORBIDDEN_WORDS` + its lint). Athena and
 * Achilles render findings through it. Athena-Dashboard is TypeScript/React and
 * CANNOT import the Python fence, so this file TRANSCRIBES the forbidden-words
 * list and the lint rules from the SAME source the Python fence derived them
 * from — the owner's charter — so the dashboard's LIGHT-persona microcopy is
 * held to the identical rules. This is a transcription, never a hand-fork of the
 * Python code.
 *
 * `FORBIDDEN_WORDS` below is PINNED by tests/persona-microcopy.test.ts to an
 * exact expected set, so any edit is a reviewed change. When the fence's
 * forbidden list or rules change, mirror the change here and update that pin in
 * the same reviewed PR.
 *
 * Charter, Surfaces table (verbatim): "Forbidden, on any finding surface:
 * secure, safe, clean, guaranteed, clearly, obviously, no issues, pass, fail,
 * you're protected, and any sentence recommending ship or hold. The lint is a
 * test, not a guideline." Plus (Guardrails): "No reassurance, dramatization or
 * boasting."
 *
 * Zero-drift follow-up (FOR THE LEAD; NOT IN THIS PR): have the fence export its
 * forbidden list as a JSON data artifact the dashboard vendors and this file
 * reads, so the two can never silently diverge. Out of scope here.
 *
 * DASHBOARD-SIDE TIGHTENING (mirrored into `mythos_core.persona` by Mythos-Core
 * #55; a change here is made there too): the fence matched whole words, so a
 * verdict in another form slipped past it -- a "Failing" label past `fail`, a
 * "Safer AI" sign-off past `safe`. Here each verdict token also matches its
 * inflections (see FORBIDDEN_PATTERNS), and a promise of confidence ("Deploy
 * with confidence") is false reassurance. `FORBIDDEN_WORDS` (the charter's
 * list, pinned by a test) is unchanged. The reassurance phrases match on whole
 * words and a number or a measure after "confidence" is a measure (see
 * REASSURANCE_PATTERNS and CONFIDENCE_PROMISE): the first versions refused honest
 * copy. The page copy is held to all of it by tests/page-copy-lints-clean.test.ts.
 */

/**
 * The charter's forbidden terms, transcribed verbatim and in charter order.
 * Mirror of `mythos_core.persona.lexicon.FORBIDDEN_WORDS`. PINNED by a test.
 */
export const FORBIDDEN_WORDS = [
  "secure",
  "safe",
  "clean",
  "guaranteed",
  "clearly",
  "obviously",
  "no issues",
  "pass",
  "fail",
  "you're protected",
] as const;

export type ForbiddenWord = (typeof FORBIDDEN_WORDS)[number];

/** A single lint failure: which rule tripped, and on what term. */
export interface Violation {
  /** One of: "forbidden-word", "ship-or-hold", "dramatization", "false-reassurance". */
  rule: "forbidden-word" | "ship-or-hold" | "dramatization" | "false-reassurance";
  /** The matched term, lower-cased. */
  term: string;
}

/**
 * How each forbidden term is matched. Matching is case-insensitive and on WHOLE
 * words, so the charter's verdict tokens are caught ("pass", "fail", "Your data
 * is safe") while honest, non-verdict English passes ("the request failed",
 * "could not load", "failsafe", "bypass", "password"). This is the faithful
 * reading of the charter, which names the verdict words, not every string that
 * contains their letters, and it is what keeps the dashboard's existing honest
 * error copy legal.
 *
 * A verdict word in another form is the same verdict, so each token also
 * matches its inflections, still on whole words: safe/safer/safest,
 * secure/secured/securely, clean/cleaner, pass/passing/passed, fail/failing. A
 * "Failing" state label or a "Safer AI" sign-off says the verdict the bare word
 * would be refused for. The reported `term` stays the charter's word.
 *
 * `failed` is NOT matched. "The request failed" / "The read failed" say that an
 * operation did not complete, which is the honest error copy this fence exists
 * to protect: tests/persona-microcopy.test.ts pins both as legal, and the
 * registry's own `requestFailed` is one. Telling that apart from a "Failed"
 * RESULT label needs more than a word list, and is the owner's call.
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<readonly [ForbiddenWord, RegExp]> = [
  ["secure", /\b(?:secure|secured|securely)\b/i],
  ["safe", /\b(?:safe|safer|safest)\b/i],
  ["clean", /\b(?:clean|cleaner)\b/i],
  ["guaranteed", /\bguaranteed\b/i],
  ["clearly", /\bclearly\b/i],
  ["obviously", /\bobviously\b/i],
  ["no issues", /\bno\s+issues\b/i],
  ["pass", /\b(?:pass|passing|passed)\b/i],
  ["fail", /\b(?:fail|failing)\b/i],
  // "you're protected", tolerant of apostrophe style and "you are"/"youre".
  ["you're protected", /\byou(?:'re|re|\s+are)\s+protected\b/i],
];

/** A release decision the persona may never urge (charter: "ship or hold"). */
const SHIP_OR_HOLD = /\b(?:ship|hold)\b/i;

/**
 * False reassurance / boasting beyond the evidence (charter guardrail). Several
 * of these also contain a forbidden word; they are listed so the reason is named
 * precisely. The forbidden-word list and the dramatization rule do the rest.
 *
 * Matched on whole words, a hyphen counting as part of a word: a substring match
 * refused honest copy whose words merely run into a phrase ("overall goodput"
 * holds "all good", "everything is fine-grained" holds "everything is fine").
 * Found by linting every string the engines ship against the shared fence; the
 * same rule is in `mythos_core.persona.lint`.
 */
const REASSURANCE_PHRASES = [
  "rest assured",
  "don't worry",
  "do not worry",
  "no need to worry",
  "nothing to worry",
  "you're all set",
  "you are all set",
  "all good",
  "everything is fine",
  "everything's fine",
  "we've got you",
  "we have got you",
  "got you covered",
  "fully protected",
  "completely protected",
  "totally secure",
  "safe and sound",
  "sit back and relax",
  "no cause for concern",
] as const;

/** Each phrase as a whole-word pattern, any run of whitespace between its words.
 * No lookbehind: the client bundle runs this too, and older Safari has none. */
const REASSURANCE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = REASSURANCE_PHRASES.map(
  (phrase) =>
    [
      phrase,
      new RegExp(
        `(?:^|[^\\w-])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}(?![\\w-])`,
        "i",
      ),
    ] as const,
);

/**
 * Confidence as a PROMISE -- "Deploy with confidence", "From evidence to
 * confidence" -- is reassurance beyond the evidence, and in a tagline a release
 * call. Confidence as a MEASURE ("sorted with confidence scores", "with
 * confidence level 0.8", "scored with confidence 0.82", "with confidence of
 * 0.82") is data about a finding, not a promise, and stays legal: the lookahead
 * leaves out a number, "of" and a number, and a measure's name.
 */
const CONFIDENCE_PROMISE =
  /\b(?:with|to)\s+confidence\b(?!\s*(?:[:=]|\.?[0-9]|of\s+\.?[0-9]|(?:interval|score|level|threshold|band|rating|value|figure|basis|estimate|weight|metric|measure)s?\b))/i;

/** Straighten curly apostrophes so phrase matching is not defeated by typography. */
function normalize(text: string): string {
  return text.replace(/[‘’]/g, "'");
}

/**
 * Lint one microcopy string against the fence's rules. Returns every violation
 * found (empty array = clean). Mirrors the four rule-families the Python fence
 * holds: forbidden words; no ship/hold recommendation; no dramatization
 * (exclamation); no false reassurance / boasting.
 */
export function lintMicrocopy(text: string): Violation[] {
  const normalized = normalize(text);
  const violations: Violation[] = [];

  for (const [word, pattern] of FORBIDDEN_PATTERNS) {
    if (pattern.test(normalized)) violations.push({ rule: "forbidden-word", term: word });
  }

  const shipHold = SHIP_OR_HOLD.exec(normalized);
  if (shipHold) violations.push({ rule: "ship-or-hold", term: shipHold[0].toLowerCase() });

  // Dramatization: an exclamation mark. LIGHT is dry-minimal, never theatrical,
  // and never levity on an error.
  if (normalized.includes("!")) violations.push({ rule: "dramatization", term: "!" });

  for (const [phrase, pattern] of REASSURANCE_PATTERNS) {
    if (pattern.test(normalized)) violations.push({ rule: "false-reassurance", term: phrase });
  }

  const promise = CONFIDENCE_PROMISE.exec(normalized);
  if (promise) violations.push({ rule: "false-reassurance", term: promise[0].toLowerCase().replace(/\s+/g, " ") });

  return violations;
}

/** Convenience: true when a string trips no rule. */
export function isClean(text: string): boolean {
  return lintMicrocopy(text).length === 0;
}
