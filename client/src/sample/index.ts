/**
 * The only way into the sample figures.
 *
 * Pages import from "@/sample" and nothing deeper (tests/sample-mode.test.tsx
 * holds them to it). The figures themselves are reachable only through the
 * accessors below, and each accessor throws when sample mode is off -- so a
 * real view that reached for them by mistake would fail loudly in development
 * and in the test suite, rather than quietly show a customer an invented
 * number.
 */
import { isSampleMode, SAMPLE_MODE_ENV } from "./mode";
import { OVERVIEW_SAMPLE } from "./overview";
import { SETTINGS_SAMPLE } from "./settings";
import { SHELL_SAMPLE } from "./shell";

export { isSampleMode, SAMPLE_MODE_ENV } from "./mode";
export { SAMPLE_LABEL, SampleModeBanner, SamplePanelLabel } from "./labels";

function guarded<T>(screen: string, figures: T): T {
  if (!isSampleMode()) {
    throw new Error(
      `The ${screen} sample figures were requested while sample mode is off. ` +
        `They are shown only in a build made with ${SAMPLE_MODE_ENV}=1.`,
    );
  }
  return figures;
}

export function overviewSample() {
  return guarded("Overview", OVERVIEW_SAMPLE);
}

export function settingsSample() {
  return guarded("Settings", SETTINGS_SAMPLE);
}

export function shellSample() {
  return guarded("header", SHELL_SAMPLE);
}
