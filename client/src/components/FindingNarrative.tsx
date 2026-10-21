/**
 * A scan finding's narrative: the engine's own account of the finding, in
 * prose, when it sent one.
 *
 * mythos-core's persona (`persona.report_voice`) may render a short narrative
 * for a real finding and place it on the finding row as `narrative`, a plain
 * string, under the engine's own key. It is additive, and off by default on the
 * engine side: a finding the engine sent none for is shown exactly as it was
 * before, and this dashboard never writes a narrative of its own.
 *
 * Read off the wire, so it is not trusted to be the type it should be. It is
 * shown only when it is a string with something in it a person can see. A
 * narrative that is absent, null, empty, blank, or not a string at all is shown
 * as nothing -- not an empty line, not a placeholder, not `[object Object]`.
 * Shown verbatim, and as text: markup in it reaches the screen as the
 * characters it is, never as HTML (React escapes it).
 *
 * The BFF answers the engine's findings as the engine sent them
 * (`GET /api/scans/:testId` -> `engine.findings`), so the narrative arrives
 * under the engine's own key.
 */

/**
 * A finding's narrative, under the engine's own key. Read off the wire, so it
 * is not trusted to be the type it should be.
 */
export interface EngineNarrative {
  narrative?: unknown;
}

/**
 * Whether a narrative has anything in it to read: a character that is not a
 * space, a separator, a control, format, private-use or unassigned one
 * (`\p{C}`, `\p{Z}`) or a default-ignorable one
 * (`\p{Default_Ignorable_Code_Point}`: the combining grapheme joiner, variation
 * selectors, the Hangul fillers and the like, which render as nothing and are
 * in neither category). A narrative of only zero-width spaces, NULs, soft
 * hyphens or Hangul fillers would print as an empty line, so it is treated as
 * absent and nothing is shown.
 *
 * Built with the constructor, as FindingConfidence's is: the client's tsconfig
 * names no target, and tsc refuses the `u` flag in a literal below ES6. Every
 * browser the app ships to has the flag and the property escape (ES2018).
 */
const VISIBLE = new RegExp("[^\\s\\p{C}\\p{Z}\\p{Default_Ignorable_Code_Point}]", "u");

/**
 * One finding's narrative, shown verbatim as text when the engine sent a string
 * with something to read in it; nothing at all otherwise.
 */
export default function FindingNarrative({ finding }: { finding: EngineNarrative }) {
  const { narrative } = finding;
  if (typeof narrative !== "string" || !VISIBLE.test(narrative)) return null;
  return (
    <p className="text-[13px] leading-snug text-muted-foreground" data-testid="text-finding-narrative">
      {narrative}
    </p>
  );
}
