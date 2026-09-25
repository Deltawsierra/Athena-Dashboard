/**
 * Sample mode: the one switch that puts invented figures on screen.
 *
 * The Overview and Settings screens were drawn with fixture values -- 42 AI
 * systems, a 62% "Moderate Risk" ring, "SSO is enabled", "Secure defaults
 * active" -- and shipped that way, with nothing on the page to say none of it
 * was measured. A customer opening their own install read somebody else's
 * estate as theirs.
 *
 * Those figures are useful for one thing: a prospect demo before there is an
 * estate to show. They are useful there only if nobody can mistake them for
 * measurements. So they are OFF unless the build says otherwise:
 *
 *   VITE_MYTHOS_SAMPLE_MODE=1 npm run build:client   (or npm run dev)
 *
 * turns them on. Any other value, or the variable being absent, leaves every
 * screen reading real data. With it on, each affected screen carries a
 * page-level banner and every affected panel carries its own label, so a
 * screenshot cropped to one card still says what it is.
 *
 * A build flag rather than an in-app toggle, on purpose: a customer's install
 * should not be one click away from showing figures that are not theirs.
 */

/** The variable that turns sample mode on, for the words that name it. */
export const SAMPLE_MODE_ENV = "VITE_MYTHOS_SAMPLE_MODE";

/** True only when the build was made with VITE_MYTHOS_SAMPLE_MODE=1. */
export function isSampleMode(): boolean {
  return import.meta.env.VITE_MYTHOS_SAMPLE_MODE === "1";
}
