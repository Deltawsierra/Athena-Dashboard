/**
 * A scan finding's confidence, printed with the engine's own basis for it.
 *
 * The engine's number is ordinal. mythos-core `evidence.annotate` sets it from
 * how many independent signals the finding's evidence carries (0.10 for none, up
 * to 0.90 for five or more) and puts the basis beside it on every finding it
 * scores, as `confidence_basis`: "ordinal: derived from the number of independent
 * signals in the evidence. Not a probability that this finding is real." The scan
 * screens printed `confidence 0.65` alone, and a bare 0.65 beside a finding reads
 * as a 65% chance that it is real.
 *
 * So the number is never shown without its basis, and the basis is the engine's,
 * verbatim, as text. Where the engine sent none, that is said, and none is made
 * up. Where it sent no number, that is said too, and it is never a zero. It is
 * never a percentage, a meter or a bar. The basis is shown the way a claim's
 * strength basis is on the Assurance page: as the number's title, in the text a
 * screen reader reads with it, and on screen.
 *
 * The BFF answers the engine's findings as the engine sent them
 * (`GET /api/scans/:testId` -> `engine.findings`), so the basis arrives under the
 * engine's own key.
 */

/**
 * A finding's confidence and the engine's basis for it, under the engine's own
 * keys. Read off the wire, so neither is trusted to be the type it should be.
 */
export interface EngineConfidence {
  confidence?: unknown;
  confidence_basis?: unknown;
}

/** Said where the engine sent a number and no basis for it. */
const NO_BASIS = "The engine sent no basis for this number.";
/** Said where the engine sent a basis that is not text: it is not shown as anything else. */
const BASIS_NOT_TEXT = "The engine sent a basis for this number that is not text, so it is not shown.";
/** Said where the engine sent no number at all. */
const NO_CONFIDENCE = "no confidence recorded";
/** Said where the engine sent a confidence that cannot be printed as a number. */
const CONFIDENCE_NOT_A_NUMBER = "confidence not shown: the engine sent a value that is not a number";

/**
 * Whether a basis has anything in it to read: a character that is not a space,
 * a separator, a control, format, private-use or unassigned one (`\p{C}`,
 * `\p{Z}`), or a default-ignorable one (`\p{Default_Ignorable_Code_Point}`:
 * the combining grapheme joiner, variation selectors, the Hangul fillers and
 * the like, which render as nothing and are in neither category). A basis of
 * only zero-width spaces, NULs, soft hyphens or Hangul fillers printed "The
 * engine's basis for this number: " followed by nothing a person sees or a
 * screen reader reads.
 *
 * Built with the constructor: the client's tsconfig names no target, and tsc
 * refuses the `u` flag in a literal below ES6. Every browser the app ships to has
 * it, and the property escape (ES2018).
 */
const VISIBLE = new RegExp("[^\\s\\p{C}\\p{Z}\\p{Default_Ignorable_Code_Point}]", "u");

/** The engine's basis, as it sent it, said to be the engine's. */
function engineBasis(basis: string): string {
  return `The engine's basis for this number: ${basis}`;
}

/**
 * The number to two places, as the scan screens have always printed it, unless
 * two places would change it: 0.004 is printed as sent, not as 0.00.
 */
function asSent(value: number): string {
  const fixed = value.toFixed(2);
  return Number(fixed) === value ? fixed : String(value);
}

/**
 * What a finding's confidence line says, and the basis it is read with. `basis` is
 * null where there is no number for a basis to describe.
 */
function findingConfidence(finding: EngineConfidence): { value: string; basis: string | null } {
  const { confidence, confidence_basis: basis } = finding;
  // NaN is not a number: nothing that is a confidence was recorded.
  if (confidence === undefined || confidence === null || Number.isNaN(confidence)) {
    return { value: NO_CONFIDENCE, basis: null };
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return { value: CONFIDENCE_NOT_A_NUMBER, basis: null };
  }
  const value = `confidence ${asSent(confidence)}`;
  // Shown verbatim, invisible characters and all, when there is something to read in it.
  if (typeof basis === "string" && VISIBLE.test(basis)) return { value, basis: engineBasis(basis) };
  if (basis === undefined || basis === null || typeof basis === "string") return { value, basis: NO_BASIS };
  return { value, basis: BASIS_NOT_TEXT };
}

/** One finding's confidence line, with its basis as title, screen-reader text and visible text. */
export default function FindingConfidence({ finding }: { finding: EngineConfidence }) {
  const { value, basis } = findingConfidence(finding);
  if (basis === null) {
    return (
      <p className="athena-mono text-[11px] text-muted-foreground" data-testid="text-finding-confidence">
        <span data-testid="text-finding-confidence-value">{value}</span>
      </p>
    );
  }
  return (
    <div data-testid="finding-confidence">
      <p className="athena-mono text-[11px] text-muted-foreground" title={basis} data-testid="text-finding-confidence">
        <span data-testid="text-finding-confidence-value">{value}</span>
        <span className="sr-only" data-testid="text-finding-confidence-sr">
          {` (${basis})`}
        </span>
      </p>
      <p className="text-[11px] leading-snug text-muted-foreground" data-testid="text-finding-confidence-basis">
        {basis}
      </p>
    </div>
  );
}
