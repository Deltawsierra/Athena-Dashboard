/**
 * The Settings screen's sample figures: the fixture tenant, posture and keys
 * the page was first drawn with, kept for prospect demos and nothing else.
 * None of it describes a real environment -- there is no SSO, no secure-defaults
 * check and no approval-gate store behind these words. Reach it through
 * `settingsSample()` in ./index, which refuses when sample mode is off.
 */
import type { SettingsSample } from "@/pages/Settings";

export const SETTINGS_SAMPLE: SettingsSample = {
  secureDefaults: { value: "Active", sublabel: "Aligned with Mythos recommendations" },
  approvalGates: { value: "4 / 5", sublabel: "Human oversight configured" },
  guidance: [
    { tone: "ok", title: "Secure defaults enabled", note: "Your configuration aligns with Mythos security best practices." },
    { tone: "warn", title: "Consider enabling human approval for high-risk deployments", note: "You have 1 high-risk scenario without approval gates." },
    { tone: "warn", title: "Data retention is set to 365 days", note: "Consider a shorter retention period if not required for compliance." },
    { tone: "ok", title: "SSO is enabled", note: "Your organization uses SAML SSO." },
    { tone: "ok", title: "Training data reuse is disabled", note: "Good — customer data will not be used for model training." },
  ],
  organization: {
    name: "Acme Financial",
    environment: "Production",
    logoText: "ACME FINANCIAL",
    color: "#D4AF37",
    timeZone: "(UTC-5) Eastern Time (ET)",
  },
  preferences: {
    defaultView: "Athena Scan Results",
    itemsPerPage: "25",
    theme: "Mythos Dark",
    toggles: [
      { label: "Show risk score color indicators", on: true },
      { label: "Enable advanced filters by default", on: true },
      { label: "Play sound for critical findings", on: false },
    ],
  },
  modelRoutes: {
    primary: "OpenAI",
    model: "GPT-4o",
    fallback: "Anthropic — Claude 3.5 Sonnet",
    embedding: "text-embedding-3-large",
    routing: [
      "Use primary provider (recommended)",
      "Auto-failover on error",
      "Route by data classification",
      "Custom routing rules",
    ],
  },
  apiKeys: [
    { name: "prod-scanner", perms: "Scan, Read", created: "Jan 12, 2025" },
    { name: "ci-cd-pipeline", perms: "Deploy, Read", created: "Feb 3, 2025" },
    { name: "analytics", perms: "Read", created: "Mar 18, 2025" },
  ],
  training: {
    reuseAllowed: false,
    note: "When enabled, de-identified data may be used to improve model performance. We recommend keeping this disabled for sensitive environments.",
    policy: "Customer data is not used for model training by default at Mythos.",
  },
  retention: { scan: "90 days", evidence: "180 days", audit: "365 days", autoDelete: true },
};
