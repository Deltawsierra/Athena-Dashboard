/**
 * Authority: four read-only screens over the assurance records Athena-Backend
 * keeps for a deployment, each at its own route.
 *
 *   /authority/workflows   Approved workflows: what is approved, the tools each
 *                          approval binds, and the contract each was approved under.
 *   /authority/chains      Authority chains: the chain of authority behind each
 *                          effect, every hop with its verdict, unproven hops named.
 *   /authority/contracts   Tool contracts: each tool's effective contract, and the
 *                          contract each approval of it was bound under.
 *   /authority/release     Release gate: the deployment's release decision and every
 *                          input the backend combines into it.
 *
 * The deployment is chosen from the deployments Athena-Backend lists for you
 * (?deployment=<uuid>). Every read goes there as you, through this console's
 * server (server/assurance.ts), exactly as the Assurance page's do: the backend's
 * tenant scoping and role checks apply, and a person with no backend sign-in signs
 * in from the banner here. Nothing on these screens writes, starts or stops
 * anything; the live poll and every Stop are elsewhere and untouched.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { RefreshCw, ShieldQuestion, Waypoints } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import GlassCard from "@/components/GlassCard";
import { BackendSignIn, bannerHeadline } from "@/pages/Assurance";
import ApprovedWorkflowsScreen from "@/components/authority/ApprovedWorkflows";
import AuthorityChainsScreen from "@/components/authority/AuthorityChains";
import ToolContractsScreen from "@/components/authority/ToolContracts";
import ReleaseGateScreen from "@/components/authority/ReleaseGate";
import { Absent, decisionLabel } from "@/components/authority/parts";
import { loaded } from "@/lib/loaded";
import { BACKEND_RECORD } from "@/lib/sourceLabels";
import { cn } from "@/lib/utils";

export const SCREENS = [
  { key: "workflows", label: "Approved workflows" },
  { key: "chains", label: "Authority chains" },
  { key: "contracts", label: "Tool contracts" },
  { key: "release", label: "Release gate" },
] as const;

export type ScreenKey = (typeof SCREENS)[number]["key"];

/** The screen a path names; the first when it names none or one that is not a screen. */
export function screenOf(name: string | undefined): ScreenKey {
  return SCREENS.find((screen) => screen.key === name)?.key ?? "workflows";
}

interface AssuranceStatus {
  configured: boolean;
  reachable: boolean | null;
  authorized: boolean | null;
  url: string | null;
  detail: string;
  code?: string;
  signedInAs?: string | null;
}

interface DeploymentRow {
  uuid: string;
  name: string;
  environment: string;
  decision: string | null;
  decisionLabel: string;
}

const SIGN_IN_REQUIRED = "backend_sign_in_required";

/**
 * A deployment id as this page will put it in a read's path: letters, digits,
 * '-' and '_' only (Athena-Backend's are UUIDs). ?deployment= is whatever the link
 * says, so anything else -- "..", "/", "?", "#", "%" -- would walk the read off this
 * deployment's record onto another route; such a link reads nothing.
 */
const DEPLOYMENT_ID = /^[0-9A-Za-z][0-9A-Za-z_-]*$/;

function hrefFor(screen: ScreenKey, deployment: string): string {
  return deployment ? `/authority/${screen}?deployment=${encodeURIComponent(deployment)}` : `/authority/${screen}`;
}

function ScreenTabs({ current, deployment }: { current: ScreenKey; deployment: string }) {
  return (
    <nav className="inline-flex flex-wrap overflow-hidden rounded-lg border border-border/60" aria-label="Authority screens">
      {SCREENS.map((screen) => (
        <Link
          key={screen.key}
          href={hrefFor(screen.key, deployment)}
          data-testid={`authority-tab-${screen.key}`}
          aria-current={current === screen.key ? "page" : undefined}
          className={cn(
            "px-3 py-1.5 text-[12px] font-medium transition-colors",
            current === screen.key
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-surface-1/50 hover:text-foreground",
          )}
        >
          {screen.label}
        </Link>
      ))}
    </nav>
  );
}

function DeploymentPicker({
  deployments,
  selected,
  onChoose,
}: {
  deployments: DeploymentRow[];
  selected: string;
  onChoose: (uuid: string) => void;
}) {
  const listed = deployments.some((d) => d.uuid === selected);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="authority-deployment" className="text-[12px] text-muted-foreground">
        Deployment
      </label>
      <select
        id="authority-deployment"
        data-testid="authority-deployment"
        className="rounded-md border border-border/60 bg-surface-1/60 px-2 py-1 text-[12px] text-foreground"
        value={selected}
        onChange={(event) => onChoose(event.target.value)}
      >
        <option value="">Choose a deployment</option>
        {deployments.map((d) => (
          <option key={d.uuid} value={d.uuid}>
            {d.name} · {d.environment} · {d.decision === null ? "not assessed" : decisionLabel(d.decision, d.decisionLabel)}
          </option>
        ))}
        {selected && !listed && <option value={selected}>{selected} (not in your list)</option>}
      </select>
      {selected && !listed && (
        <Absent testId="deployment-not-listed">
          Athena-Backend does not list this deployment for you; what it answers for it is shown as it answers.
        </Absent>
      )}
    </div>
  );
}

function ScreenFor({ screen, deployment }: { screen: ScreenKey; deployment: string }) {
  // Keyed by the deployment, so nothing read for one deployment is ever drawn under another.
  switch (screen) {
    case "chains":
      return <AuthorityChainsScreen key={deployment} deployment={deployment} />;
    case "contracts":
      return <ToolContractsScreen key={deployment} deployment={deployment} />;
    case "release":
      return <ReleaseGateScreen key={deployment} deployment={deployment} />;
    default:
      return <ApprovedWorkflowsScreen key={deployment} deployment={deployment} />;
  }
}

export default function Authority({ params }: { params?: { screen?: string } }) {
  const screen = screenOf(params?.screen);
  const asked = new URLSearchParams(useSearch()).get("deployment") ?? "";
  const deployment = DEPLOYMENT_ID.test(asked) ? asked : "";
  const [, navigate] = useLocation();

  const status$ = loaded(useQuery<AssuranceStatus>({ queryKey: ["/api/assurance/status"], refetchInterval: 30_000 }));
  const status = status$.state === "ready" ? status$.data : undefined;
  const reachable = status?.configured === true && status?.reachable === true && status?.authorized === true;
  const deployments$ = loaded(useQuery<DeploymentRow[]>({ queryKey: ["/api/assurance/deployments"], enabled: reachable }));
  const title = SCREENS.find((one) => one.key === screen)?.label ?? "Approved workflows";

  return (
    <div className="space-y-6 p-6" data-authority-screen={screen}>
      <PageHeader
        title={title}
        icon={<Waypoints className="h-8 w-8" />}
        description="Approvals, the authority behind each effect, the contracts tools are approved under, and the release decision: read-only, as Athena-Backend records them."
        actions={<ScreenTabs current={screen} deployment={deployment} />}
      />
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" data-testid="text-authority-source">
        {BACKEND_RECORD}
      </p>

      {status$.state === "loading" && (
        <GlassCard bodyClassName="flex items-center gap-3">
          <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">Checking the control plane…</p>
        </GlassCard>
      )}
      {status$.state === "error" && (
        <GlassCard bodyClassName="flex items-start gap-3">
          <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-sev-high" />
          <p className="text-[13px] text-muted-foreground">Could not check the control plane: {status$.message}</p>
        </GlassCard>
      )}
      {status && !reachable && (
        <GlassCard bodyClassName="flex items-start gap-3">
          <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
          <div className="text-[13px] leading-relaxed">
            <p className="font-medium text-foreground">{bannerHeadline(status)}</p>
            <p className="mt-1 text-muted-foreground">{status.detail}</p>
            {status.code === SIGN_IN_REQUIRED && <BackendSignIn />}
          </div>
        </GlassCard>
      )}

      {reachable && (
        <>
          {deployments$.state === "loading" && <p className="text-[13px] text-muted-foreground">Reading the deployments…</p>}
          {deployments$.state === "error" && (
            <p className="text-[13px] text-muted-foreground">Could not read the deployments: {deployments$.message}</p>
          )}
          {deployments$.state === "ready" && (
            <DeploymentPicker
              deployments={deployments$.data}
              selected={deployment}
              onChoose={(uuid) => navigate(hrefFor(screen, uuid))}
            />
          )}
          {asked && !deployment && (
            <Absent testId="deployment-id-refused">
              This link does not name a deployment id Athena-Backend issues, so no record is read for it.
            </Absent>
          )}
          {deployment ? (
            <ScreenFor screen={screen} deployment={deployment} />
          ) : (
            deployments$.state === "ready" && (
              <p className="text-[13px] text-muted-foreground" data-testid="choose-deployment">
                {deployments$.data.length === 0
                  ? "Athena-Backend lists no deployment for you."
                  : "Choose a deployment to read its records."}
              </p>
            )
          )}
        </>
      )}
    </div>
  );
}
