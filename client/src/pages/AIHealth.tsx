/**
 * What this deployment can measure about itself.
 *
 * What this replaced is the point. The page read a single row that the
 * installer had written -- 24% CPU, 41% memory, a 98% success rate, 94%
 * detection accuracy, a 3% false-positive rate -- and graded itself
 * "excellent" off three of those constants. Nothing measured any of it and
 * nothing ever wrote a second row, so the two charts drew one point and the
 * badge said the same word on every machine forever.
 *
 * On a screen called AI Health, where detection accuracy and the
 * false-positive rate are the two figures a customer or an investor would
 * most want to trust.
 *
 * Now the server takes a reading every minute and this draws them. Where
 * there is no source, the figure is absent and the page says so in a
 * sentence: a gap invites a reader to assume, and the assumption is always
 * more flattering than the truth.
 *
 * Detection is shown as the engine measured it, from its own run of its
 * detection benchmark, and never as one number. Every share of attacks caught
 * (security) sits beside the share of legitimate work let through (utility),
 * with the counts they are shares of and the run, commit and time they came
 * from. Beside each is its change since the different measurement before it,
 * so a remediation that catches more by blocking legitimate work shows as
 * exactly that. With no measurement, there is no number, only why.
 */

import { useQuery } from "@tanstack/react-query";
import { loaded, notInHand } from "@/lib/loaded";
import { formatDistanceToNow } from "date-fns";
import {
  Activity, Boxes, Clock, Cpu, Gauge, MemoryStick, ScanLine, ShieldCheck,
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";

import GlassCard from "@/components/GlassCard";
import PageHeader from "@/components/PageHeader";
import AnimatedContainer from "@/components/AnimatedContainer";
import type {
  AIHealthMetric, BenchmarkReading, EngineMeasurement, MeasuredPair,
} from "@shared/schema";

/** A reading that has not been taken. Never rendered as a number. */
function Absent({ why }: { why: string }) {
  return (
    <div>
      <div className="athena-figure text-2xl text-muted-foreground">—</div>
      <p className="mt-1 text-xs text-muted-foreground">{why}</p>
    </div>
  );
}

function Reading({
  label, value, unit, icon: Icon, absent, testId,
}: {
  label: string;
  value: number | null;
  unit?: string;
  icon: typeof Cpu;
  /** Said when the value is null. Why there is no number, not "no data". */
  absent: string;
  testId: string;
}) {
  return (
    <GlassCard data-testid={testId}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="athena-label">{label}</div>
          {value === null ? (
            <Absent why={absent} />
          ) : (
            <div className="athena-figure mt-1 text-3xl">
              {value}
              {unit && <span className="ml-1 text-lg text-muted-foreground">{unit}</span>}
            </div>
          )}
        </div>
        <Icon className="h-4 w-4 shrink-0 text-primary" />
      </div>
    </GlassCard>
  );
}

/** A share as a percentage, to one place. Never rounded up to a perfect score, nor down to none. */
function percent(rate: number): string {
  let shown = Math.round(rate * 1000) / 10;
  if (rate < 1 && shown >= 100) shown = 99.9;
  if (rate > 0 && shown <= 0) shown = 0.1;
  return `${shown.toFixed(1)}%`;
}

/** A share's change since the measurement before, in percentage points. */
function Change({ now, before, testId }: { now: number; before: number | null; testId: string }) {
  if (before === null) {
    return (
      <p className="mt-1 text-xs text-muted-foreground" data-testid={testId}>
        no earlier figure to compare
      </p>
    );
  }
  const change = now - before;
  if (change === 0) {
    return <p className="mt-1 text-xs text-muted-foreground" data-testid={testId}>no change</p>;
  }
  return (
    <p
      className="mt-1 text-xs"
      data-testid={testId}
      style={{ color: change > 0 ? "hsl(var(--primary))" : "hsl(var(--sev-critical))" }}
    >
      {change > 0 ? "▲" : "▼"} {signedPoints(change)} since the measurement before
    </p>
  );
}

function commitOf(one: EngineMeasurement): string {
  if (one.commit === null) return `commit not known (${one.commitUnknown})`;
  const short = `commit ${one.commit.slice(0, 7)}`;
  if (one.commitModified === true) return `${short}, with uncommitted changes to tracked files`;
  if (one.commitModified === null) return `${short} (whether it had uncommitted changes could not be read)`;
  return short;
}

function provenanceOf(one: EngineMeasurement): string {
  return `run ${one.run.slice(0, 8)}, ${commitOf(one)}, measured ${new Date(one.measuredAt).toLocaleString()}`;
}

const CORPORA = [
  {
    key: "tuned" as const,
    label: "Tuned corpus",
    note: "what the patterns were adjusted against, so it scores high by construction",
  },
  {
    key: "holdout" as const,
    label: "Holdout corpus",
    note: "written afterwards and never tuned against: the honest read",
  },
];

/** A change in a share, in percentage points, signed: "+3.7 pts", "−1.2 pts", "<0.1". */
function signedPoints(change: number): string {
  const points = change * 100;
  const size = Math.abs(points) < 0.05 ? "<0.1" : Math.abs(points).toFixed(1);
  return `${points > 0 ? "+" : "−"}${size} pts`;
}

/**
 * The two shares moving apart since the measurement before, in words: any
 * share of attacks caught that rose while any share of legitimate work let
 * through fell, on either corpus, and the other way round.
 */
function tradeOffs(reading: BenchmarkReading): string[] {
  const { current, previous } = reading;
  if (previous === null) return [];
  const moves = CORPORA.flatMap((corpus) => {
    const now = current[corpus.key];
    const before = previous[corpus.key];
    if (now === null || before === null) return [];
    return [{
      where: corpus.label.toLowerCase(),
      security: now.securityRetained - before.securityRetained,
      utility: now.utilityRetained - before.utilityRetained,
    }];
  });
  const which = (share: "security" | "utility", up: boolean) =>
    moves.filter((move) => (up ? move[share] > 0 : move[share] < 0));
  const listed = (found: typeof moves, share: "security" | "utility") =>
    found.map((move) => `${move.where} ${signedPoints(move[share])}`).join(", ");
  const said: string[] = [];
  const securityUp = which("security", true);
  const utilityDown = which("utility", false);
  if (securityUp.length > 0 && utilityDown.length > 0) {
    said.push(
      `Security rose (${listed(securityUp, "security")}) while utility fell ` +
      `(${listed(utilityDown, "utility")}): more attacks are caught, and less legitimate work gets through.`,
    );
  }
  const utilityUp = which("utility", true);
  const securityDown = which("security", false);
  if (utilityUp.length > 0 && securityDown.length > 0) {
    said.push(
      `Utility rose (${listed(utilityUp, "utility")}) while security fell ` +
      `(${listed(securityDown, "security")}): more legitimate work gets through, and fewer attacks are caught.`,
    );
  }
  return said;
}

function PairCells({ pair, before, testId }: { pair: MeasuredPair; before: MeasuredPair | null | undefined; testId: string }) {
  return (
    <>
      <td className="py-3 pr-4 align-top">
        <div className="athena-figure text-2xl" data-testid={`${testId}-security`}>{percent(pair.securityRetained)}</div>
        <p className="text-xs text-muted-foreground">{pair.caught} of {pair.attacks} attack cases caught</p>
        {before !== undefined && (
          <Change now={pair.securityRetained} before={before?.securityRetained ?? null} testId={`${testId}-security-change`} />
        )}
      </td>
      <td className="py-3 align-top">
        <div className="athena-figure text-2xl" data-testid={`${testId}-utility`}>{percent(pair.utilityRetained)}</div>
        <p className="text-xs text-muted-foreground">
          {pair.legitimate - pair.flagged} of {pair.legitimate} legitimate cases let through
        </p>
        {before !== undefined && (
          <Change now={pair.utilityRetained} before={before?.utilityRetained ?? null} testId={`${testId}-utility-change`} />
        )}
      </td>
    </>
  );
}

/**
 * The engine's detection benchmark, as it measured it. Security and utility
 * are one row each time, never one without the other, and there is no number
 * at all when the reading holds no measurement.
 */
function EngineDetection({ reading, unmeasured }: {
  /** Absent from a reading written before the engine reported one. */
  reading: BenchmarkReading | null | undefined;
  unmeasured: string | null | undefined;
}) {
  const said = reading ? tradeOffs(reading) : [];
  return (
    <GlassCard data-testid="reading-detection">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="athena-label">Detection, as the engine measured it</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Two numbers, always together: the share of attacks caught (security
            retained) and the share of legitimate work let through (utility
            retained, 1 − the false-positive rate).
          </p>
        </div>
        <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
      </div>
      {!reading ? (
        <div data-testid="text-detection-unmeasured">
          <Absent why={unmeasured ?? "this reading holds no report of the engine's measurement"} />
        </div>
      ) : (
        <>
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="pb-2 pr-4 font-normal" scope="col">Corpus</th>
                <th className="pb-2 pr-4 font-normal" scope="col">Attacks caught (security)</th>
                <th className="pb-2 font-normal" scope="col">Legitimate work let through (utility)</th>
              </tr>
            </thead>
            <tbody>
              {CORPORA.map((corpus) => {
                const pair = reading.current[corpus.key];
                const testId = `row-detection-${corpus.key}`;
                return (
                  <tr key={corpus.key} data-testid={testId} className="border-t" style={{ borderColor: "hsl(var(--border))" }}>
                    <th className="py-3 pr-4 align-top font-normal" scope="row">
                      <div>{corpus.label}</div>
                      <p className="text-xs text-muted-foreground">{corpus.note}</p>
                    </th>
                    {pair === null ? (
                      <td colSpan={2} className="py-3 align-top text-muted-foreground" data-testid={`${testId}-unmeasured`}>
                        <div className="athena-figure text-2xl">—</div>
                        <p className="text-xs">
                          Not measured: {reading.current.holdoutUnmeasured ?? "the engine did not say why"}
                        </p>
                      </td>
                    ) : (
                      <PairCells
                        pair={pair}
                        before={reading.previous === null ? undefined : reading.previous[corpus.key]}
                        testId={testId}
                      />
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {said.map((sentence) => (
            <p key={sentence} className="mt-3 text-sm" style={{ color: "hsl(var(--sev-critical))" }} data-testid="text-detection-trade-off">
              {sentence}
            </p>
          ))}
          <p className="mt-3 text-xs text-muted-foreground" data-testid="text-detection-provenance">
            Measured by the engine: {provenanceOf(reading.current)}.
          </p>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="text-detection-previous">
            {reading.previous === null
              ? "No earlier measurement that differs from this one is on record here, so no change is shown."
              : `Changes are against the measurement before it that differs: ${provenanceOf(reading.previous)}.`}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            The engine runs its detection benchmark once each time it starts, against the
            corpora checked in beside its code. Neither corpus says anything about traffic
            unlike it, and no Validity Card has been issued for this benchmark.
          </p>
        </>
      )}
    </GlassCard>
  );
}

const AXIS = { fontSize: 11, fill: "hsl(var(--muted-foreground))" } as const;
const TOOLTIP = {
  background: "hsl(var(--surface-1))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 10,
  fontSize: 12,
} as const;

export default function AIHealth() {
  const latestQ = useQuery<AIHealthMetric | null>({
    queryKey: ["/api/ai-health/latest"],
    // A sample is written every minute; there is no point reading faster.
    refetchInterval: 60_000,
  });
  // Both sources are polled, and React Query keeps the last answer after a
  // poll fails. Read raw, the tiles went on showing that answer, unlabelled,
  // under the "could not load" card. Read through loaded(), the error wins:
  // the old reading is not drawn, and only its time is said.
  const latest$ = loaded(latestQ);
  const latest = latest$.state === "ready" ? latest$.data : undefined;
  const heldBefore = latest$.state === "error" ? latestQ.data ?? null : null;

  const history$ = loaded(useQuery<AIHealthMetric[]>({
    queryKey: ["/api/ai-health"],
    refetchInterval: 60_000,
  }));
  const history = history$.state === "ready" ? history$.data : [];

  // Oldest first, so time runs left to right.
  const series = [...history]
    .slice(0, 60)
    .reverse()
    .map((one) => ({
      time: new Date(one.timestamp).toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit",
      }),
      cpu: one.cpuUsage,
      memory: one.memoryUsage,
      response: one.averageResponseTime,
      scans: one.activeScans,
    }));

  const models = latest?.modelsLoaded ?? [];

  return (
    <div className="min-h-screen">
      <div className="container mx-auto space-y-6 p-6">
        <PageHeader
          title="Health"
          icon={<Activity className="h-8 w-8 text-primary" />}
          description="Measured on this machine once a minute, with detection as the engine measured it. Anything without a source is shown as absent rather than as a number."
        />

        {latest$.state === "error" && (
          // A reading that could not be fetched is not "no reading yet", and
          // is no evidence the sampler has stopped.
          <GlassCard ruling>
            <p className="text-sm text-muted-foreground" data-testid="text-reading-failed">
              Could not load the latest reading: {latest$.message}
            </p>
            {heldBefore && (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="text-reading-held">
                The last reading this page received was taken at{" "}
                {new Date(heldBefore.timestamp).toLocaleString()}. It is not shown, because it is not current.
              </p>
            )}
          </GlassCard>
        )}

        {latest === null && (
          <GlassCard ruling>
            <div className="athena-label">No reading yet</div>
            <p className="mt-2 text-sm text-muted-foreground" data-testid="text-no-reading">
              The first sample is taken when the server starts and one follows
              every minute. If this persists, the server is not running the
              sampler.
            </p>
          </GlassCard>
        )}

        {latest && (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
              <AnimatedContainer direction="up" delay={0.05}>
                <Reading
                  testId="reading-cpu" label="CPU" icon={Cpu} unit="%"
                  value={latest.cpuUsage} absent="not measured"
                />
              </AnimatedContainer>
              <AnimatedContainer direction="up" delay={0.1}>
                <Reading
                  testId="reading-memory" label="Memory" icon={MemoryStick} unit="%"
                  value={latest.memoryUsage} absent="not measured"
                />
              </AnimatedContainer>
              <AnimatedContainer direction="up" delay={0.15}>
                <Reading
                  testId="reading-active" label="Scans running" icon={ScanLine}
                  value={latest.activeScans} absent="not counted"
                />
              </AnimatedContainer>
              <AnimatedContainer direction="up" delay={0.2}>
                <Reading
                  testId="reading-today" label="Scans today" icon={Gauge}
                  value={latest.totalScansToday} absent="not counted"
                />
              </AnimatedContainer>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <AnimatedContainer direction="up" delay={0.1}>
                <Reading
                  testId="reading-success" label="Scans that completed" icon={ShieldCheck} unit="%"
                  value={latest.successRate}
                  absent="no scan has finished yet, and 100% of nothing is not a success rate"
                />
              </AnimatedContainer>
              <AnimatedContainer direction="up" delay={0.15}>
                <Reading
                  testId="reading-response" label="Response time" icon={Clock} unit="ms"
                  value={latest.averageResponseTime}
                  absent="no requests were served in the last interval"
                />
              </AnimatedContainer>
              <AnimatedContainer direction="up" delay={0.2}>
                <GlassCard data-testid="reading-guards">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="athena-label">Engine detection guards</div>
                      {latest.guardsChecked === null ? (
                        <Absent why="no engine answered when this reading was taken" />
                      ) : (
                        <>
                          <div
                            className="athena-figure mt-1 text-3xl"
                            style={{
                              color:
                                (latest.guardsFailing ?? 0) > 0
                                  ? "hsl(var(--sev-critical))"
                                  : "hsl(var(--primary))",
                            }}
                          >
                            {latest.guardsChecked - (latest.guardsFailing ?? 0)}
                            <span className="text-lg text-muted-foreground">
                              /{latest.guardsChecked}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            answering at the engine's last start
                          </p>
                        </>
                      )}
                    </div>
                    <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
                  </div>
                </GlassCard>
              </AnimatedContainer>
            </div>

            <AnimatedContainer direction="up" delay={0.1}>
              <EngineDetection reading={latest.benchmark} unmeasured={latest.benchmarkUnmeasured} />
            </AnimatedContainer>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <AnimatedContainer direction="up" delay={0.1}>
                <GlassCard>
                  <div className="athena-label mb-4">This machine</div>
                  {history$.state !== "ready" ? (
                    <p className="text-sm text-muted-foreground" data-testid="text-history-failed">
                      {notInHand(history$, "the reading history")}
                    </p>
                  ) : series.length < 2 ? (
                    <p className="text-sm text-muted-foreground" data-testid="text-thin-series">
                      One reading so far. The line appears once there are two,
                      about a minute from now.
                    </p>
                  ) : (
                    <div className="h-56">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={series}>
                          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                          <XAxis dataKey="time" tick={AXIS} axisLine={false} tickLine={false} />
                          <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, 100]} />
                          <Tooltip contentStyle={TOOLTIP} />
                          <Area
                            type="monotone" dataKey="cpu" name="CPU %"
                            stroke="hsl(var(--primary))"
                            fill="hsl(var(--primary) / 0.18)"
                          />
                          <Area
                            type="monotone" dataKey="memory" name="Memory %"
                            stroke="hsl(var(--accent-violet))"
                            fill="hsl(var(--accent-violet) / 0.14)"
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </GlassCard>
              </AnimatedContainer>

              <AnimatedContainer direction="up" delay={0.15}>
                <GlassCard>
                  <div className="athena-label mb-4">Response time</div>
                  {history$.state !== "ready" ? (
                    <p className="text-sm text-muted-foreground">{notInHand(history$, "the reading history")}</p>
                  ) : series.filter((one) => one.response !== null).length < 2 ? (
                    <p className="text-sm text-muted-foreground">
                      Not enough readings with traffic in them to draw a line.
                    </p>
                  ) : (
                    <div className="h-56">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={series}>
                          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                          <XAxis dataKey="time" tick={AXIS} axisLine={false} tickLine={false} />
                          <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                          <Tooltip contentStyle={TOOLTIP} />
                          <Line
                            type="monotone" dataKey="response" name="ms"
                            stroke="hsl(var(--gold))" dot={false}
                            // A reading with no traffic has no response time.
                            // Joining across it would draw a line through a
                            // number that does not exist.
                            connectNulls={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </GlassCard>
              </AnimatedContainer>
            </div>

            <AnimatedContainer direction="up" delay={0.2}>
              <GlassCard>
                <div className="athena-label mb-3 flex items-center gap-2">
                  <Boxes className="h-3.5 w-3.5" />
                  Models loaded
                </div>
                {models.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="text-no-models">
                    No classifier is registered as active, so nothing is loaded.
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-2" data-testid="list-models">
                    {models.map((name) => (
                      <li
                        key={name}
                        className="athena-mono rounded-md border px-2 py-1 text-xs"
                        style={{ borderColor: "hsl(var(--border))" }}
                      >
                        {name}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  {latest.lastTrainingDate
                    ? `Most recently trained ${formatDistanceToNow(new Date(latest.lastTrainingDate), { addSuffix: true })}.`
                    : "No training date is recorded against any of them."}
                </p>
              </GlassCard>
            </AnimatedContainer>

          </>
        )}
      </div>
    </div>
  );
}
