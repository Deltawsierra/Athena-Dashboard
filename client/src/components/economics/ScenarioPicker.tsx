/**
 * Which scenario version to read: a deployment from the assurance deployments
 * list, then one of its scenario versions from Athena-Backend's scenario list
 * (#163, through server/economics.ts `/api/economics/scenarios`), a page at a
 * time. No uuid is typed.
 *
 * Each version is shown as the list serves it: its title, its templates, its
 * latest exposure run's status, and that run's grade, banner and exclusion from
 * every total, with why. The list's banner rule is the report's: a version not
 * graded A to D carries its banner (or the fail-closed line) beside it. Nothing
 * is totalled or counted here: the page, the pages, the count and the next and
 * previous pages are the list's own numbers, and paging moves only to a page the
 * list names (`previous`, `next`), never one worked out here.
 *
 * Picking a version reads its latest exposure run (the list's `latest_exposure_run`);
 * a version with none has no result to read. Every read passes its AbortSignal
 * (lib/queryClient.ts) and is under the relay's read deadline.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import GlassCard from "@/components/GlassCard";
import { Banner, NotServed, Served } from "@/components/economics/sections";
import { at, list, obj, text, type Doc } from "@/lib/economics";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A deployment as the assurance list serves it here (server/assurance.ts). */
interface DeploymentOption {
  uuid: string;
  name: string;
  environment?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "the read failed";
}

/** A page number the list names: a whole number from 1, or null. */
function pageOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/** Where the page goes for one version's result. */
export function targetOf(deployment: string, entry: unknown): string | null {
  const scenario = text(at(entry, "uuid"));
  const run = text(at(entry, "latest_exposure_run", "uuid"));
  if (scenario === null || run === null || !UUID.test(scenario) || !UUID.test(run)) return null;
  return `/economics?${new URLSearchParams({ deployment, scenario, simulation: run }).toString()}`;
}

/** One scenario version, as the list serves it. */
function Entry({ deployment, entry, chosen }: { deployment: string; entry: Doc; chosen: string | null }) {
  const [, setLocation] = useLocation();
  const uuid = text(entry.uuid);
  const run = obj(entry.latest_exposure_run);
  const templates = list(entry.templates);
  const target = targetOf(deployment, entry);
  const excluded = entry.excluded_from_totals;
  return (
    <li
      className="rounded-md border border-border/40 p-3"
      data-scenario-entry={uuid ?? ""}
      data-chosen={uuid !== null && uuid === chosen ? "true" : "false"}
    >
      <Banner doc={entry} />
      <p className="font-semibold"><Served value={entry.title} /></p>
      <p className="font-mono text-[11px] text-muted-foreground">{uuid ?? "?"}</p>
      <dl className="mt-2 grid grid-cols-[minmax(8rem,12rem)_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Recorded</dt>
        <dd><Served value={entry.recorded_at} /></dd>
        {text(entry.supersedes) !== null ? (
          <>
            <dt className="text-muted-foreground">Supersedes</dt>
            <dd className="font-mono">{text(entry.supersedes)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Templates</dt>
        <dd data-testid="entry-templates">
          {templates.length === 0 ? (
            "none recorded"
          ) : (
            templates.map((one, index) => (
              <span key={index} className="mr-2">
                {text(at(one, "template_id")) ?? "?"} v{typeof at(one, "version") === "number" ? String(at(one, "version")) : "?"}
              </span>
            ))
          )}
        </dd>
        <dt className="text-muted-foreground">Latest exposure run</dt>
        <dd data-testid="entry-run">
          {run === null ? (
            "none recorded"
          ) : (
            <>
              <Served value={run.status} />
              {text(run.refusal_code) !== null ? <> <span className="font-mono">{text(run.refusal_code)}</span></> : null}
              {", recorded "}
              <Served value={run.recorded_at} />
            </>
          )}
        </dd>
        <dt className="text-muted-foreground">Grade</dt>
        <dd data-testid="entry-grade">{text(entry.grade) ?? "not graded"}</dd>
        <dt className="text-muted-foreground">Excluded from every total</dt>
        <dd data-testid="entry-excluded">
          {excluded === false ? "no" : excluded === true ? "yes" : "not served (read as yes)"}
          {text(entry.banner_reason) !== null ? <span className="text-muted-foreground"> ({text(entry.banner_reason)})</span> : null}
        </dd>
      </dl>
      <div className="mt-2">
        {target === null ? (
          <span className="text-xs text-muted-foreground" data-testid="entry-no-result">no exposure run recorded: no result to read</span>
        ) : (
          <button
            type="button"
            className="rounded-md border border-primary/50 px-3 py-1 text-xs"
            onClick={() => setLocation(target)}
            data-testid="entry-read"
          >
            Read this version&apos;s latest result
          </button>
        )}
      </div>
    </li>
  );
}

/** A deployment's scenario versions, a page at a time, as the list serves them. */
export function ScenarioList({ deployment, chosen }: { deployment: string; chosen: string | null }) {
  const [page, setPage] = useState<number | undefined>(undefined);
  const scenarios = useQuery<Doc>({ queryKey: ["/api/economics/scenarios", { deployment, page }] });
  if (scenarios.isError) {
    return <p className="text-sm" data-testid="scenarios-error">The scenario versions could not be read: {errorText(scenarios.error)}</p>;
  }
  if (scenarios.data === undefined) {
    return <p className="text-sm text-muted-foreground" data-testid="scenarios-loading">Reading the scenario versions...</p>;
  }
  const doc = obj(scenarios.data) ?? {};
  const entries = list(doc.scenarios).map(obj).filter((one): one is Doc => one !== null);
  const previous = pageOf(doc.previous);
  const next = pageOf(doc.next);
  return (
    <div className="space-y-3" data-testid="scenario-list">
      <p className="text-xs text-muted-foreground" data-testid="scenario-page">
        Page {String(doc.page ?? "?")} of {String(doc.pages ?? "?")} ({String(doc.page_size ?? "?")} a page; {String(doc.count ?? "?")} scenario
        versions listed, in record order)
      </p>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="scenarios-none">No scenario version on this page.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry, index) => (
            <Entry key={text(entry.uuid) ?? index} deployment={deployment} entry={entry} chosen={chosen} />
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        {previous !== null ? (
          <button type="button" className="rounded-md border border-border px-3 py-1 text-xs" onClick={() => setPage(previous)} data-testid="scenarios-previous">
            Previous page ({previous})
          </button>
        ) : null}
        {next !== null ? (
          <button type="button" className="rounded-md border border-border px-3 py-1 text-xs" onClick={() => setPage(next)} data-testid="scenarios-next">
            Next page ({next})
          </button>
        ) : null}
      </div>
      {text(doc.statement) !== null ? <p className="text-[11px] text-muted-foreground">{text(doc.statement)}</p> : null}
    </div>
  );
}

/** The deployment to read, from the assurance deployments list. */
function DeploymentChoice({ deployment }: { deployment: string }) {
  const [, setLocation] = useLocation();
  const deployments = useQuery<DeploymentOption[]>({ queryKey: ["/api/assurance/deployments"] });
  if (deployments.isError) {
    return <p className="text-sm" data-testid="deployments-error">The deployments could not be read: {errorText(deployments.error)}</p>;
  }
  if (deployments.data === undefined) {
    return <p className="text-sm text-muted-foreground" data-testid="deployments-loading">Reading the deployments...</p>;
  }
  const options = (Array.isArray(deployments.data) ? deployments.data : []).filter((one) => typeof one?.uuid === "string" && UUID.test(one.uuid));
  const known = options.some((one) => one.uuid === deployment);
  return (
    <label className="block text-sm" htmlFor="economics-deployment">
      <span className="text-muted-foreground">Deployment</span>
      <select
        id="economics-deployment"
        className="mt-1 w-full rounded-md border border-border bg-background/60 px-2 py-1 text-sm"
        value={known ? deployment : ""}
        onChange={(event) => {
          const chosen = event.target.value;
          setLocation(chosen ? `/economics?${new URLSearchParams({ deployment: chosen }).toString()}` : "/economics");
        }}
        data-testid="deployment-choice"
      >
        <option value="">{options.length === 0 ? "No deployment is under assurance" : "Choose a deployment"}</option>
        {options.map((one) => (
          <option key={one.uuid} value={one.uuid}>
            {one.name || one.uuid}{one.environment ? ` (${one.environment})` : ""}
          </option>
        ))}
      </select>
      {deployment !== "" && !known ? (
        <span className="mt-1 block text-xs text-muted-foreground" data-testid="deployment-unlisted">
          <NotServed why="the deployment named in this page's address is not in the deployments list" />
        </span>
      ) : null}
    </label>
  );
}

/** The picker: a deployment, then one of its scenario versions. */
export default function ScenarioPicker({ deployment, scenario }: { deployment: string; scenario: string | null }) {
  const valid = UUID.test(deployment);
  return (
    <GlassCard hover={false} glow={false}>
      <div className="space-y-4" data-testid="choose-scenario">
        <DeploymentChoice deployment={deployment} />
        {valid ? <ScenarioList key={deployment} deployment={deployment} chosen={scenario} /> : null}
      </div>
    </GlassCard>
  );
}
