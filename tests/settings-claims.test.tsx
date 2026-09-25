// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";

import Settings from "@/pages/Settings";
import AppShell from "@/components/AppShell";
import { settingsSample, shellSample } from "@/sample";
import { SETTINGS_SAMPLE } from "@/sample/settings";

/**
 * Settings used to tell every operator "SSO is enabled", "Secure defaults
 * enabled", "Training data reuse is disabled -- customer data will not be used
 * for model training", "Secure Defaults: Active" and "Approval Gates 4 / 5".
 * This build has no SSO, no secure-defaults check and no approval-gate store.
 *
 * With sample mode off the page may say only what a source reports, and says
 * "not reported" for the rest. With it on, the fixture values show, each card
 * that carries one labelled as sample. Every tab is visited, because a claim
 * behind a tab is still a claim.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const CONNECTIONS = {
  fields: [
    { field: "engineUrl", secret: false, source: "stored", set: true, value: "https://engine.internal:8443", env: "ATHENA_ENGINE_URL" },
    { field: "engineKey", secret: true, source: "stored", set: true, value: null, env: "ATHENA_ENGINE_KEY" },
    { field: "assistantUrl", secret: false, source: "environment", set: true, value: "http://127.0.0.1:11434", env: "ATHENA_ASSISTANT_URL" },
    { field: "assistantKey", secret: true, source: "unset", set: false, value: null, env: "ATHENA_ASSISTANT_KEY" },
    { field: "assistantModel", secret: false, source: "unset", set: false, value: null, env: "ATHENA_ASSISTANT_MODEL" },
  ],
};
const ENGINE = { configured: true, reachable: true, authorized: true, url: "https://engine.internal:8443", detail: "ok" };
const API_KEYS = [
  { id: "k1", name: "nightly-export", prefix: "ath_7Qx", createdBy: "u1", createdAt: "2026-09-01T00:00:00Z", lastUsedAt: null, revokedAt: null },
  { id: "k2", name: "old-ci", prefix: "ath_2Lm", createdBy: "u1", createdAt: "2026-08-01T00:00:00Z", lastUsedAt: null, revokedAt: "2026-09-02T00:00:00Z" },
];

function mount() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ queryKey }) => {
          throw new Error(`unexpected fetch for ${JSON.stringify(queryKey)}`);
        },
      },
    },
  });
  client.setQueryData(["/api/settings/connections"], CONNECTIONS);
  client.setQueryData(["/api/engine/status"], ENGINE);
  client.setQueryData(["/api/api-keys"], API_KEYS);
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  );
}

function openTab(name: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^\\s*${name}$`) }));
}

function figureOf(testId: string): string {
  return screen.getByTestId(testId).querySelector(".athena-figure")?.textContent ?? "";
}

/** Every sample sentence and value long enough not to collide by accident. */
function sampleStrings(): string[] {
  const s = SETTINGS_SAMPLE;
  return [
    s.secureDefaults.sublabel,
    s.approvalGates.value,
    s.approvalGates.sublabel,
    ...s.guidance.flatMap((g) => [g.title, g.note]),
    s.organization.name,
    s.organization.logoText,
    s.organization.timeZone,
    s.organization.color,
    s.preferences.defaultView,
    s.preferences.theme,
    ...s.preferences.toggles.map((t) => t.label),
    s.modelRoutes.primary,
    s.modelRoutes.model,
    s.modelRoutes.fallback,
    s.modelRoutes.embedding,
    ...s.modelRoutes.routing,
    ...s.apiKeys.flatMap((k) => [k.name, k.perms, k.created]),
    s.training.note,
    s.training.policy,
    s.retention.scan,
    s.retention.evidence,
    s.retention.audit,
  ];
}

function noSampleValue() {
  const text = document.body.textContent ?? "";
  for (const phrase of sampleStrings()) {
    expect(text, `sample text "${phrase}" reached the real Settings view`).not.toContain(phrase);
  }
  expect(screen.queryByTestId("sample-mode-banner")).toBeNull();
  expect(screen.queryAllByTestId("sample-panel-label")).toHaveLength(0);
}

describe("Settings with sample mode off (the default)", () => {
  it("claims no posture nothing reports, on any tab", () => {
    mount();
    // The two posture tiles: a dash and the reason, never "Active" or "4 / 5".
    expect(figureOf("settings-stat-secure-defaults")).toBe("—");
    expect(screen.getByText("Not reported: nothing checks this yet")).toBeTruthy();
    expect(figureOf("settings-stat-approval-gates")).toBe("—");
    expect(screen.getByText("Not reported: no gate configuration is recorded")).toBeTruthy();

    // The guidance rail says what is not reported, in so many words.
    const guidance = screen.getByTestId("settings-card-guidance");
    for (const title of [
      "Secure defaults: not reported",
      "SSO: not reported",
      "Training-data reuse: not reported",
      "Approval gates: not reported",
      "Data retention: not configured",
    ]) {
      expect(within(guidance).getByText(title)).toBeTruthy();
    }
    // The one statement a source does report stays: the engine answered.
    expect(within(guidance).getByText("Engine is connected")).toBeTruthy();

    noSampleValue();
    openTab("Integrations");
    noSampleValue();
    openTab("Data Handling");
    noSampleValue();
    openTab("Security");
    noSampleValue();
  });

  it("shows the organization as not stored rather than as Acme Financial", () => {
    mount();
    const org = screen.getByTestId("settings-card-organization");
    expect(within(org).getByText(/Not stored\. This build keeps no organization name/)).toBeTruthy();
  });

  it("reads the addresses and API keys from the server", () => {
    mount();
    openTab("Integrations");
    const routes = screen.getByTestId("settings-card-model-routes");
    expect(within(routes).getByText("https://engine.internal:8443")).toBeTruthy();
    expect(within(routes).getByText("http://127.0.0.1:11434")).toBeTruthy();
    // Unset is said as unset, not filled with a model name.
    expect(within(routes).getByText("Not set")).toBeTruthy();

    const keys = screen.getByTestId("settings-card-api-keys");
    expect(within(keys).getByText("nightly-export")).toBeTruthy();
    expect(within(keys).getByText("old-ci")).toBeTruthy();
    expect(within(keys).getByText("Revoked")).toBeTruthy();
  });

  it("says training reuse and retention are not reported, instead of a policy", () => {
    mount();
    openTab("Data Handling");
    expect(within(screen.getByTestId("settings-card-training")).getByText(/^Not reported\. No environment-wide training policy/)).toBeTruthy();
    expect(within(screen.getByTestId("settings-card-retention")).getByText(/^Not configured\. No retention schedule/)).toBeTruthy();
  });

  it("refuses to hand the sample figures to anything while sample mode is off", () => {
    expect(() => settingsSample()).toThrow(/sample mode is off/);
  });
});

describe("Settings with sample mode on", () => {
  it("labels the page and every card showing a sample value, on every tab", () => {
    vi.stubEnv("VITE_MYTHOS_SAMPLE_MODE", "1");
    mount();
    expect(screen.getByTestId("sample-mode-banner").textContent).toContain("Sample data — not from your environment");

    const labelled = (id: string) =>
      expect(
        within(screen.getByTestId(id)).getByTestId("sample-panel-label").textContent,
        `${id} carries no sample label`,
      ).toContain("Sample data — not from your environment");

    labelled("settings-stat-secure-defaults");
    labelled("settings-stat-approval-gates");
    labelled("settings-card-guidance");
    expect(figureOf("settings-stat-secure-defaults")).toBe("Active");
    expect(figureOf("settings-stat-approval-gates")).toBe("4 / 5");
    expect(screen.getByText("SSO is enabled")).toBeTruthy();

    labelled("settings-card-organization");
    labelled("settings-card-preferences");
    expect(screen.getByText("ACME FINANCIAL")).toBeTruthy();
    // Tiles + guidance + the two General cards; nothing sample goes unlabelled.
    expect(screen.getAllByTestId("sample-panel-label")).toHaveLength(5);

    openTab("Integrations");
    labelled("settings-card-model-routes");
    labelled("settings-card-api-keys");
    expect(screen.getAllByTestId("sample-panel-label")).toHaveLength(5);

    openTab("Data Handling");
    labelled("settings-card-training");
    labelled("settings-card-retention");
    expect(screen.getAllByTestId("sample-panel-label")).toHaveLength(5);
  });
});

describe("the header's organization", () => {
  // The header named "Acme Financial · Enterprise" on every screen, in a build
  // that stores no organization -- the same fixture tenant Settings showed.
  const shell = () =>
    render(
      <AppShell onLogout={() => {}} isAdmin username="operator">
        <p>page</p>
      </AppShell>,
    );

  it("names no organization when sample mode is off", () => {
    shell();
    expect(screen.queryByTestId("button-org-switcher")).toBeNull();
    expect(document.body.textContent).not.toContain("Acme Financial");
    expect(() => shellSample()).toThrow(/sample mode is off/);
  });

  it("names the sample organization, labelled, when sample mode is on", () => {
    vi.stubEnv("VITE_MYTHOS_SAMPLE_MODE", "1");
    shell();
    const switcher = screen.getByTestId("button-org-switcher");
    expect(within(switcher).getByText("Acme Financial")).toBeTruthy();
    expect(within(switcher).getByTestId("org-sample-label").textContent).toBe("Sample data");
    expect(switcher.getAttribute("title")).toBe("Sample data — not from your environment");
  });
});
