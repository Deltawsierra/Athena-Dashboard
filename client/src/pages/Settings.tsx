/**
 * Settings: the environment's own configuration -- where it connects, which
 * programmatic keys exist, and what it can say about its own posture.
 *
 * This screen used to state a security posture nothing had measured: "Secure
 * defaults enabled -- your configuration aligns with Mythos security best
 * practices", "SSO is enabled -- your organization uses SAML SSO", "Training
 * data reuse is disabled -- customer data will not be used for model training",
 * "Secure Defaults: Active", "Approval Gates 4 / 5", beside a fixture tenant
 * ("Acme Financial"), fixture model routes and three fixture API keys. Nothing
 * in this build checks secure defaults, configures SSO or stores approval
 * gates, so every one of those sentences was an assurance product vouching for
 * something it had not looked at.
 *
 * Now the page says only what a source reports:
 *
 * - connection fields, and the engine and assistant addresses in force
 *                                      /api/settings/connections
 * - whether the engine answers        /api/engine/status
 * - the dashboard's API keys          /api/api-keys (created and revoked on Teams)
 *
 * Everything else reads "not reported" or "not stored", with where the real
 * answer lives when there is one (a deployment's declared data boundary, on
 * the Assurance page, is where training reuse is recorded). The fixture values
 * are kept for prospect demos behind sample mode -- see client/src/sample.
 */
import {
  Link2,
  ShieldCheck,
  Lock,
  Clock,
  Settings as Cog,
  Shield,
  Plug,
  ScanLine,
  Bell,
  Database,
  CheckCircle2,
  Users,
  Boxes,
  ChevronRight,
  ChevronDown,
  Plus,
  Sparkles,
  AlertTriangle,
  BookOpen,
  HelpCircle,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import PageHero from "@/components/mythos/PageHero";
import StatCard from "@/components/mythos/StatCard";
import GlassCard from "@/components/GlassCard";
import { Divider } from "@/components/mythos/Ornament";
import { isSampleMode, settingsSample, SampleModeBanner, SamplePanelLabel } from "@/sample";
import { cn } from "@/lib/utils";

const TABS = [
  { label: "General", icon: Cog },
  { label: "Security", icon: Shield },
  { label: "Integrations", icon: Plug },
  { label: "Scan Defaults", icon: ScanLine },
  { label: "Notifications", icon: Bell },
  { label: "Data Handling", icon: Database },
  { label: "Approvals", icon: CheckCircle2 },
];

/* ---- the sample figures' shape (the values live in client/src/sample) ---- */

/** "ok" and "warn" are judgements a source backs; "unreported" is the absence of one. */
export type GuideTone = "ok" | "warn" | "unreported";
export interface Guidance { tone: GuideTone; title: string; note: string }

export interface SettingsSample {
  secureDefaults: { value: string; sublabel: string };
  approvalGates: { value: string; sublabel: string };
  guidance: Guidance[];
  organization: { name: string; environment: string; logoText: string; color: string; timeZone: string };
  preferences: { defaultView: string; itemsPerPage: string; theme: string; toggles: { label: string; on: boolean }[] };
  modelRoutes: { primary: string; model: string; fallback: string; embedding: string; routing: string[] };
  apiKeys: { name: string; perms: string; created: string }[];
  training: { reuseAllowed: boolean; note: string; policy: string };
  retention: { scan: string; evidence: string; audit: string; autoDelete: boolean };
}

/* ---- small presentational parts ------------------------------------------ */

function Field({ label, value }: { label: string; value: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <span className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-surface-1/50 px-3 py-2 text-[13px] text-foreground">
        {value}<ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
    </label>
  );
}
function Input({ label, value }: { label: string; value: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <span className="block rounded-lg border border-border/60 bg-surface-1/50 px-3 py-2 text-[13px] text-foreground">{value}</span>
    </label>
  );
}
/** A value as the server reports it, and where it came from. Read-only. */
function Reported({ label, value, source }: { label: string; value: string | null; source?: string }) {
  return (
    <div>
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <span className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-surface-1/50 px-3 py-2 text-[13px]">
        <span className={cn("min-w-0 truncate", value ? "text-foreground" : "text-muted-foreground")}>{value ?? "Not set"}</span>
        {source && <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/80">{source}</span>}
      </span>
    </div>
  );
}
function Toggle({ on, label }: { on: boolean; label: string }) {
  const [v, setV] = useState(on);
  return (
    <button type="button" role="switch" aria-checked={v} onClick={() => setV((x) => !x)} className="flex items-center gap-2.5 text-left">
      <span className={cn("inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors", v ? "bg-gold" : "bg-surface-2")}>
        <span className={cn("h-4 w-4 rounded-full bg-white transition-transform", v && "translate-x-4")} />
      </span>
      <span className="text-[12px] text-foreground">{label}</span>
    </button>
  );
}
function Radio({ on, label, onSelect }: { on: boolean; label: string; onSelect?: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onSelect} className="flex w-full items-center gap-2.5 text-left">
      <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors", on ? "border-primary" : "border-border/70")}>
        {on && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className="text-[12px] text-foreground">{label}</span>
    </button>
  );
}
function CardHead({ icon: Icon, title, blurb }: { icon: typeof Cog; title: string; blurb: string }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gold-dim/40 bg-gold/5 text-gold"><Icon className="h-5 w-5" /></span>
      <div>
        <p className="text-[14px] font-semibold text-foreground">{title}</p>
        <p className="text-[11px] text-muted-foreground">{blurb}</p>
      </div>
    </div>
  );
}
/** A settings card, carrying the sample label inside it when it shows sample values. */
function Card({ id, sample, className, children }: { id: string; sample: boolean; className?: string; children: ReactNode }) {
  return (
    <GlassCard hover={false} className={className} data-testid={`settings-card-${id}`}>
      {sample && <SamplePanelLabel className="mb-3" />}
      {children}
    </GlassCard>
  );
}
/** The one sentence a card shows in place of a value nothing reports. */
function Unstated({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-border/50 bg-surface-1/40 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
      <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/* ---- live sources ------------------------------------------------------- */

interface ConnField { field: string; secret: boolean; source: string; set: boolean; value: string | null; env: string }
interface Connections { fields: ConnField[] }
interface EngineStatus { configured: boolean; reachable: boolean; authorized: boolean | null; url: string | null; detail: string }
// An API key as the server returns it: metadata only, never the secret or hash.
interface ApiKey {
  id: string; name: string; prefix: string; createdBy: string | null;
  createdAt: string; lastUsedAt: string | null; revokedAt: string | null;
}

const SOURCE_LABEL: Record<string, string> = { stored: "saved here", environment: "environment", unset: "" };

/**
 * The posture statements nothing reports. Each says so, and says where the
 * real answer lives when one exists -- never a green tick for a thing nobody
 * checked.
 */
const UNREPORTED: Guidance[] = [
  {
    tone: "unreported",
    title: "Secure defaults: not reported",
    note: "Nothing in this build checks the configuration against a secure baseline, so no alignment is claimed.",
  },
  {
    tone: "unreported",
    title: "SSO: not reported",
    note: "No identity-provider configuration is reported to this page. Accounts are managed on the Teams page.",
  },
  {
    tone: "unreported",
    title: "Training-data reuse: not reported",
    note: "No environment-wide training policy is recorded. Each deployment's declared data boundary, on the Assurance page, records whether training is allowed.",
  },
  {
    tone: "unreported",
    title: "Approval gates: not reported",
    note: "No approval-gate configuration is recorded. Each deployment's assurance decision is on the Assurance page.",
  },
  {
    tone: "unreported",
    title: "Data retention: not configured",
    note: "No retention schedule is set in this build. An administrator can remove records on the Deletion page.",
  },
];

/* ---- the page ----------------------------------------------------------- */

export default function Settings() {
  const sample = isSampleMode();
  // Asked for only on the sample branch; settingsSample() refuses otherwise.
  const demo = sample ? settingsSample() : null;

  const { data: conn, isError: connError } = useQuery<Connections>({ queryKey: ["/api/settings/connections"] });
  const { data: engine } = useQuery<EngineStatus>({ queryKey: ["/api/engine/status"] });
  const { data: apiKeys, isError: keysError } = useQuery<ApiKey[]>({ queryKey: ["/api/api-keys"], enabled: !sample });
  const [tab, setTab] = useState("General");
  const [routing, setRouting] = useState(demo?.modelRoutes.routing[0] ?? "");

  const fields = conn?.fields;
  const setCount = fields?.filter((f) => f.set).length ?? 0;
  const field = (name: string) => fields?.find((f) => f.field === name);
  const engineOk = engine?.configured && engine?.reachable && engine?.authorized !== false;

  const engineGuidance: Guidance = engine?.configured
    ? engineOk
      ? { tone: "ok", title: "Engine is connected", note: `Reachable at ${engine?.url ?? "the configured address"} and authorized.` }
      : { tone: "warn", title: "Engine configured but not reachable", note: engine?.detail ?? "Check the engine address and operator key." }
    : { tone: "warn", title: "No engine is configured", note: "Set the engine address and an operator key (or ATHENA_ENGINE_URL / ATHENA_ENGINE_KEY) before scanning." };

  const wired = ["General", "Integrations", "Data Handling"];

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-8">
      <PageHero
        title="Settings"
        subtitle="Configure your environment. Strengthen security. Enable responsible AI at scale."
        background="vista"
        verbs={["Trusted", "AI Adoption", "At Enterprise", "Scale"]}
      />
      {sample && <SampleModeBanner />}
      <Divider variant="key" className="mt-5" />

      {/* stats -- integrations and engine live; the posture tiles only what is reported */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          layout="tile"
          label="Connected Integrations"
          value={fields ? `${setCount} / ${fields.length}` : connError ? "—" : "…"}
          icon={Link2}
          sublabel={connError ? "Could not load connection settings" : "Connection fields configured"}
        />
        <StatCard
          layout="tile"
          label="Engine"
          value={engine ? (engineOk ? "Connected" : engine.configured ? "Unreachable" : "Not set") : "…"}
          icon={ShieldCheck}
          sublabel={engine?.configured ? (engine?.url ?? "") : "No address configured"}
        />
        <StatCard
          layout="tile"
          data-testid="settings-stat-secure-defaults"
          label="Secure Defaults"
          value={demo ? demo.secureDefaults.value : "—"}
          icon={Lock}
          sublabel={demo ? demo.secureDefaults.sublabel : "Not reported: nothing checks this yet"}
          tag={demo ? <SamplePanelLabel /> : undefined}
        />
        <StatCard
          layout="tile"
          data-testid="settings-stat-approval-gates"
          label="Approval Gates"
          value={demo ? demo.approvalGates.value : "—"}
          icon={Clock}
          sublabel={demo ? demo.approvalGates.sublabel : "Not reported: no gate configuration is recorded"}
          tag={demo ? <SamplePanelLabel /> : undefined}
        />
      </div>

      {/* tabs -- switch which settings sections show */}
      <GlassCard hover={false} className="mt-5" bodyClassName="flex flex-wrap gap-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.label;
          return (
            <button key={t.label} onClick={() => setTab(t.label)} className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors", active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="h-3.5 w-3.5" /> {t.label}
            </button>
          );
        })}
      </GlassCard>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 grid grid-cols-1 gap-5 lg:grid-cols-3">
          {!wired.includes(tab) && (
            <GlassCard hover={false} className="lg:col-span-3">
              <p className="text-[13px] text-muted-foreground">The <span className="text-foreground">{tab}</span> section has no settings in this build yet.</p>
            </GlassCard>
          )}

          {tab === "General" && (demo ? (
            <>
              <Card id="organization" sample>
                <CardHead icon={Users} title="Organization & Tenant" blurb="Basic information and branding for your Mythos environment." />
                <div className="space-y-3">
                  <Input label="Organization Name" value={demo.organization.name} />
                  <Field label="Environment" value={demo.organization.environment} />
                  <div>
                    <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Tenant Logo</span>
                    <div className="flex items-center gap-3">
                      <span className="flex h-16 flex-1 items-center justify-center rounded-lg border border-border/60 bg-surface-1/50 font-serif text-[13px] tracking-widest text-gold">{demo.organization.logoText}</span>
                      <div className="space-y-2">
                        <button className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-[11px] text-foreground">Change Logo</button>
                        <span className="flex items-center gap-2 text-[11px] text-muted-foreground"><span className="h-4 w-4 rounded-full bg-gold" /> {demo.organization.color}</span>
                      </div>
                    </div>
                  </div>
                  <Field label="Time Zone" value={demo.organization.timeZone} />
                </div>
              </Card>
              <Card id="preferences" sample>
                <CardHead icon={Cog} title="Platform Preferences" blurb="Customize your experience and default behavior." />
                <div className="space-y-3">
                  <Field label="Default View" value={demo.preferences.defaultView} />
                  <Field label="Items per page" value={demo.preferences.itemsPerPage} />
                  <Field label="UI Theme" value={demo.preferences.theme} />
                  <div className="space-y-3 border-t border-border/40 pt-3">
                    {demo.preferences.toggles.map((t) => <Toggle key={t.label} on={t.on} label={t.label} />)}
                  </div>
                </div>
              </Card>
            </>
          ) : (
            <Card id="organization" sample={false} className="lg:col-span-2">
              <CardHead icon={Users} title="Organization & Preferences" blurb="Tenant profile and default behavior." />
              <Unstated>
                Not stored. This build keeps no organization name, environment label, logo, time zone
                or per-tenant preferences, so none is shown. The theme follows the toggle in the header.
              </Unstated>
            </Card>
          ))}

          {tab === "Integrations" && (demo ? (
            <Card id="model-routes" sample>
              <CardHead icon={Boxes} title="Model Routes & Providers" blurb="Configure default models and routing for scans and analysis." />
              <div className="space-y-3">
                <Field label="Primary LLM Provider" value={demo.modelRoutes.primary} />
                <Field label="Default Model" value={demo.modelRoutes.model} />
                <Field label="Fallback Provider" value={demo.modelRoutes.fallback} />
                <Field label="Embedding Model" value={demo.modelRoutes.embedding} />
                <div className="space-y-2.5 border-t border-border/40 pt-3" role="radiogroup" aria-label="Provider Routing">
                  <span className="block text-[11px] font-medium text-muted-foreground">Provider Routing</span>
                  {demo.modelRoutes.routing.map((label) => (
                    <Radio key={label} label={label} on={routing === label} onSelect={() => setRouting(label)} />
                  ))}
                </div>
              </div>
            </Card>
          ) : (
            <Card id="model-routes" sample={false}>
              <CardHead icon={Boxes} title="Engine & Assistant" blurb="The addresses in force, as the server reports them." />
              {fields ? (
                <div className="space-y-3">
                  <Reported label="Engine address" value={field("engineUrl")?.value ?? null} source={SOURCE_LABEL[field("engineUrl")?.source ?? "unset"]} />
                  <Reported label="Assistant address" value={field("assistantUrl")?.value ?? null} source={SOURCE_LABEL[field("assistantUrl")?.source ?? "unset"]} />
                  <Reported label="Assistant model" value={field("assistantModel")?.value ?? null} source={SOURCE_LABEL[field("assistantModel")?.source ?? "unset"]} />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Keys are reported only as set or not set. This build has no provider routing or
                    fallback: the assistant uses the one address above.
                  </p>
                </div>
              ) : (
                <Unstated>{connError ? "Could not load the connection settings." : "Loading…"}</Unstated>
              )}
            </Card>
          ))}

          {tab === "Data Handling" && (demo ? (
            <>
              <Card id="training" sample>
                <CardHead icon={Sparkles} title="Training & Feedback" blurb="Control how your data is used to improve model performance." />
                <Toggle on={demo.training.reuseAllowed} label="Allow training/feedback reuse" />
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{demo.training.note}</p>
                <p className="mt-3 flex items-start gap-2 rounded-lg border border-border/50 bg-surface-1/40 px-3 py-2 text-[11px] text-muted-foreground"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" /> {demo.training.policy}</p>
              </Card>
              <Card id="retention" sample>
                <CardHead icon={Database} title="Data Retention" blurb="Manage how long data is stored in Mythos." />
                <div className="space-y-3">
                  <Field label="Scan data retention" value={demo.retention.scan} />
                  <Field label="Evidence files" value={demo.retention.evidence} />
                  <Field label="Audit logs" value={demo.retention.audit} />
                  <div className="border-t border-border/40 pt-3"><Toggle on={demo.retention.autoDelete} label="Auto-delete expired data" /></div>
                </div>
              </Card>
            </>
          ) : (
            <>
              <Card id="training" sample={false}>
                <CardHead icon={Sparkles} title="Training & Feedback" blurb="Whether data may be reused to train models." />
                <Unstated>
                  Not reported. No environment-wide training policy is recorded here, so none is
                  claimed. Each deployment's declared data boundary, on the Assurance page, records
                  whether training is allowed for that deployment.
                </Unstated>
              </Card>
              <Card id="retention" sample={false}>
                <CardHead icon={Database} title="Data Retention" blurb="How long records are kept." />
                <Unstated>
                  Not configured. No retention schedule is set in this build. An administrator can
                  remove records on the Deletion page.
                </Unstated>
              </Card>
            </>
          ))}

          {tab === "Integrations" && (demo ? (
            <Card id="api-keys" sample>
              <CardHead icon={Lock} title="Tenant API Keys" blurb="Manage API access for programmatic integrations." />
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground/80">
                      {["Name", "Permissions", "Created", "Status"].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {demo.apiKeys.map((k) => (
                      <tr key={k.name} className="border-t border-border/40">
                        <td className="px-2 py-2 text-[12px] text-foreground">{k.name}</td>
                        <td className="px-2 py-2 text-[11px] text-muted-foreground">{k.perms}</td>
                        <td className="px-2 py-2 text-[11px] text-muted-foreground">{k.created}</td>
                        <td className="px-2 py-2"><span className="inline-flex items-center gap-1 text-[11px] text-emerald-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Active</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : (
            <Card id="api-keys" sample={false}>
              <CardHead icon={Lock} title="API Keys" blurb="This dashboard's programmatic credentials. Each acts as the account that created it." />
              {apiKeys ? (
                apiKeys.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">No API keys have been created.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground/80">
                          {["Name", "Key", "Created", "Status"].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {apiKeys.map((k) => (
                          <tr key={k.id} className="border-t border-border/40">
                            <td className="px-2 py-2 text-[12px] text-foreground">{k.name}</td>
                            <td className="px-2 py-2 font-mono text-[11px] text-muted-foreground">{k.prefix}…</td>
                            <td className="px-2 py-2 text-[11px] text-muted-foreground">{new Date(k.createdAt).toLocaleDateString()}</td>
                            <td className="px-2 py-2">
                              {k.revokedAt ? (
                                <span className="text-[11px] text-muted-foreground">Revoked</span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Active</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ) : (
                <p className="text-[12px] text-muted-foreground">{keysError ? "Could not load the API keys." : "Loading…"}</p>
              )}
              <Link href="/admin" className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-[12px] text-foreground hover:border-primary/50"><Plus className="h-3.5 w-3.5" /> Create or revoke keys on Teams</Link>
            </Card>
          ))}
        </div>

        {/* right rail */}
        <Card id="guidance" sample={sample} className="self-start">
          <div className="mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-gold" />
            <p className="text-[15px] font-semibold text-foreground">Safe Configuration Guidance</p>
          </div>
          <p className="mb-4 text-[12px] text-muted-foreground">
            {demo
              ? "Mythos recommendations to keep your environment secure and compliant."
              : "What this environment reports about itself. A statement nothing reports is marked as not reported."}
          </p>
          <ul className="space-y-3">
            {(demo ? demo.guidance : [engineGuidance, ...UNREPORTED]).map((g) => (
              <li
                key={g.title}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border px-3 py-2.5",
                  g.tone === "ok"
                    ? "border-emerald-500/25 bg-emerald-500/[0.06]"
                    : g.tone === "warn"
                      ? "border-amber-500/25 bg-amber-500/[0.06]"
                      : "border-border/50 bg-surface-1/40",
                )}
              >
                {g.tone === "ok"
                  ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  : g.tone === "warn"
                    ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    : <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                <span>
                  <span className="block text-[12px] font-medium text-foreground">{g.title}</span>
                  <span className="block text-[11px] text-muted-foreground">{g.note}</span>
                </span>
              </li>
            ))}
            <li className="flex items-start gap-2.5 rounded-lg border border-border/50 px-3 py-2.5">
              <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
              <span>
                <span className="block text-[12px] font-medium text-foreground">Explore more guidance</span>
                <span className="block text-[11px] text-muted-foreground">View the Mythos Security Configuration Guide for detailed recommendations.</span>
              </span>
              <ChevronRight className="ml-auto mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
