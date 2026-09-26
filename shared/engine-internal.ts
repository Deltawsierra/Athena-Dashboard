/**
 * Whether the engine marked a finding as its own diagnostic rather than a
 * vulnerability, read the way the engine reads its own mark.
 *
 * athena-engine decides it with Python truthiness, `if item.get("internal"):`,
 * in `engine/utils/scoring.py` (a7131b2, on athena-engine's main):
 * `score_finding` and `score_and_tier_findings` score such a finding 0 and
 * "info", and the worst-tier pass skips it. So any truthy `internal` is
 * internal, not only `true`.
 *
 * The BFF's severity counts and both scan screens use this one rule. They
 * disagreed: the counts skipped only `internal === true`, and the screens filed
 * any truthy `internal` under notes. A row with `internal: "yes"` was then
 * counted as a high while the screen listed no findings, and said the scan
 * returned none beside High 1.
 *
 * Python's truthiness differs from JavaScript's for an empty list and an empty
 * object, which are falsy there and truthy here: they are read as Python reads
 * them. (NaN, the other difference, cannot travel over JSON.)
 */
export function isEngineInternal(internal: unknown): boolean {
  // A list's keys are its indexes, so this reads an empty list as empty too.
  if (internal !== null && typeof internal === "object") return Object.keys(internal).length > 0;
  return Boolean(internal);
}
