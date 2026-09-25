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
 * more flattering than the truth. Detection accuracy and the false-positive
 * rate come from a benchmark that runs in the engine's CI and is on no route,
 * so they are not shown at all -- what is shown instead is the engine's boot
 * canary, which is a real statement about whether detection is working.
 */

import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "@/lib/loaded";
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
import type { AIHealthMetric } from "@shared/schema";

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

const AXIS = { fontSize: 11, fill: "hsl(var(--muted-foreground))" } as const;
const TOOLTIP = {
  background: "hsl(var(--surface-1))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 10,
  fontSize: 12,
} as const;

export default function AIHealth() {
  const {
    data: latest,
    isLoading,
    isError: latestFailed,
    error: latestError,
  } = useQuery<AIHealthMetric | null>({
    queryKey: ["/api/ai-health/latest"],
    // A sample is written every minute; there is no point reading faster.
    refetchInterval: 60_000,
  });

  const {
    data: history = [],
    isError: historyFailed,
    error: historyError,
  } = useQuery<AIHealthMetric[]>({
    queryKey: ["/api/ai-health"],
    refetchInterval: 60_000,
  });

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
          description="Measured on this machine, once a minute. Anything without a source is shown as absent rather than as a number."
        />

        {latestFailed && (
          // A reading that could not be fetched is not "no reading yet", and
          // is no evidence the sampler has stopped.
          <GlassCard ruling>
            <p className="text-sm text-muted-foreground" data-testid="text-reading-failed">
              Could not load the latest reading: {errorMessage(latestError)}
            </p>
          </GlassCard>
        )}

        {!isLoading && !latestFailed && !latest && (
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

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <AnimatedContainer direction="up" delay={0.1}>
                <GlassCard>
                  <div className="athena-label mb-4">This machine</div>
                  {historyFailed ? (
                    <p className="text-sm text-muted-foreground" data-testid="text-history-failed">
                      Could not load the reading history: {errorMessage(historyError)}
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
                  {series.filter((one) => one.response !== null).length < 2 ? (
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

            <AnimatedContainer direction="up" delay={0.25}>
              <GlassCard ruling>
                <div className="athena-label athena-gold">
                  Detection accuracy and false positives
                </div>
                <p className="mt-2 text-sm text-muted-foreground" data-testid="text-not-measured">
                  This page does not show either, because this app has no way to
                  measure them. They come from a benchmark that runs against the
                  engine in its CI, with gates on the true- and false-positive
                  rates, and the engine exposes no route that reports the
                  result. When it does, the figures will appear here and be its
                  measurements rather than this app's estimate.
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Until then the guard count above is the honest version of the
                  same question: how many of the engine's detection checks were
                  answering when it last started.
                </p>
              </GlassCard>
            </AnimatedContainer>
          </>
        )}
      </div>
    </div>
  );
}
