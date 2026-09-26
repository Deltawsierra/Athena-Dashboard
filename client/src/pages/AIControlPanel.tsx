import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { loaded } from "@/lib/loaded";
import { motion } from "framer-motion";
import { Shield, Power, AlertTriangle, Settings, Activity, Zap, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest, apiFetch, throwIfResNotOk } from "@/lib/queryClient";
import type { AIControlSetting } from "@shared/schema";
import { AI_SYSTEMS, DEFAULT_ACTIVE_SYSTEMS } from "@shared/ai-systems";
import AnimatedContainer from "@/components/AnimatedContainer";
import GlassCard from "@/components/GlassCard";

/** One stop the kill switch sent (server/routes.ts ScanStop). */
interface ScanStop {
  testId: string;
  runId: string;
  target: string | null;
  stopped: boolean;
  detail: string;
}

/** What the server did about running scans when the switch was sent on. */
type KillSwitchStops = { listed: true; scans: ScanStop[] } | { listed: false; detail: string };

/** A run the engine listed as live that no running scan here recorded (server/routes.ts EngineRunStop). */
interface EngineRunStop {
  runId: string;
  target: string | null;
  /** The test that records it, when one does; null when nothing here records it. */
  testId: string | null;
  stopped: boolean;
  detail: string;
}

/**
 * What the server did about the other runs the engine itself listed as live.
 * `unnamed`, when present, counts the live runs it listed with no run id: no
 * stop could name them, so none was sent.
 */
type EngineSweep = { listed: true; runs: EngineRunStop[]; unnamed?: number } | { listed: false; detail: string };

/** The server's whole account of one engagement of the switch. */
interface StopReport {
  /** Set when the switch itself could not be stored: why, in the server's words. The stops went out regardless. */
  notEngaged?: string;
  stops: KillSwitchStops;
  /** Absent when the server said nothing about the engine's own list; then nothing is said of it. */
  engineRuns?: EngineSweep;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What the kill switch did, from the server's own account of it: how many
 * running scans were sent a stop, how many the engine accepted, and which it
 * did not, with the reason. Never "all terminated": an accepted stop is the
 * engine's word that it is stopping, and a refused or unreachable one is said.
 */
function stopSentence(report: KillSwitchStops, lead = "Kill switch engaged"): string {
  if (!report.listed) {
    return `${lead}, but the running scans could not be listed, so none was sent a stop: ${report.detail}. ` +
      "Stop them from the scan screens, or pause the engine from the Failsafe console.";
  }
  const { scans } = report;
  if (scans.length === 0) {
    return `${lead}. No engine scan was recorded as running, so none was sent a stop.`;
  }
  const accepted = scans.filter((one) => one.stopped).length;
  const failed = scans.filter((one) => !one.stopped);
  const sent = `${lead}; ${count(scans.length, "running scan")} ${scans.length === 1 ? "was" : "were"} sent a stop`;
  const took = `the engine accepted ${accepted === scans.length ? (scans.length === 1 ? "it" : "all of them") : accepted}`;
  if (failed.length === 0) return `${sent}, and ${took}.`;
  const why = failed.map((one) => `${one.target ?? one.testId}: ${one.detail}`).join("; ");
  return `${sent}; ${took}; ${failed.length} could not be stopped (${why}). ` +
    "They may still be running: stop them from the scan screens, or pause the engine from the Failsafe console.";
}

/**
 * What the kill switch did about the runs the engine itself listed as live
 * that no running scan here recorded -- a run whose row was deleted, or one
 * started from elsewhere. Said from the engine's list, or said to be unread.
 */
function engineSweepSentence(sweep: EngineSweep): string {
  if (!sweep.listed) {
    return `The engine's own list of live runs could not be read (${sweep.detail}), so a run it has that no scan here ` +
      "records may still be running: pause the engine from the Failsafe console to be sure.";
  }
  const { runs } = sweep;
  const unnamed = sweep.unnamed ?? 0;
  // A live run listed with no run id: nothing here can name it to stop it.
  const unnamedSentence = unnamed === 0 ? "" :
    `The engine listed ${count(unnamed, "live run")} with no run id, so no stop could name ${unnamed === 1 ? "it" : "them"} ` +
    `and none was sent: ${unnamed === 1 ? "it" : "they"} may still be running. Pause, stand down or terminate the engine ` +
    "from the Failsafe console.";
  const namedSentence = namedSweepSentence(runs);
  if (namedSentence === null) return unnamedSentence || "The engine listed no other live run.";
  return unnamedSentence ? `${namedSentence} ${unnamedSentence}` : namedSentence;
}

/** What came of the stops sent to the named runs the engine listed that no running scan here recorded; null for none. */
function namedSweepSentence(runs: EngineRunStop[]): string | null {
  if (runs.length === 0) return null;
  const unrecorded = runs.filter((one) => one.testId === null).length;
  const failed = runs.filter((one) => !one.stopped);
  const accepted = runs.length - failed.length;
  const listed = `The engine also listed ${count(runs.length, "live run")} that no running scan here recorded` +
    (unrecorded > 0 ? ` (${unrecorded} with no record here at all)` : "") +
    `; ${runs.length === 1 ? "it was" : "each was"} sent a stop`;
  const took = `the engine accepted ${accepted === runs.length ? (runs.length === 1 ? "it" : "all of them") : accepted}`;
  if (failed.length === 0) return `${listed}, and ${took}.`;
  const why = failed.map((one) => `${one.target ?? one.runId}: ${one.detail}`).join("; ");
  return `${listed}; ${took}; ${failed.length} could not be stopped (${why}). ` +
    "They may still be running: pause the engine from the Failsafe console.";
}

/** The lead of the report: engaged, or not -- with the stops sent regardless. */
const leadOf = (report: StopReport) => (report.notEngaged !== undefined ? "Kill switch NOT engaged, stops sent anyway" : "Kill switch engaged");

/** Whether every stop the report names was accepted, and nothing went unlisted. */
function everyStopTook(report: StopReport): boolean {
  const recorded = report.stops.listed && report.stops.scans.every((one) => one.stopped);
  const engine = report.engineRuns === undefined
    || (report.engineRuns.listed && report.engineRuns.runs.every((one) => one.stopped) && !report.engineRuns.unnamed);
  return recorded && engine;
}

export default function AIControlPanel() {
  const { toast } = useToast();
  const [isKillSwitchConfirmOpen, setIsKillSwitchConfirmOpen] = useState(false);

  // Read error-first (lib/loaded.ts). Every change below invalidates and
  // refetches these settings, and a refetch that failed used to leave the last
  // answer in place -- the kill switch drawn in a state nobody had read since,
  // right under "Could not load the AI control settings".
  const settings$ = loaded(useQuery<AIControlSetting>({
    queryKey: ["/api/ai-control"],
  }));
  const settings = settings$.state === "ready" ? settings$.data : undefined;
  const isLoading = settings$.state === "loading";
  const settingsFailed = settings$.state === "error";
  // Whether the settings are in hand. When they are not, no control is drawn
  // in a state nobody read: not the kill switch as off, not a system as
  // offline, not a limit at a default the record may not hold.
  const known = settings !== undefined && settings !== null;

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<AIControlSetting>) => {
      return await apiRequest("PATCH", "/api/ai-control", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-control"] });
      toast({
        title: "Settings Updated",
        description: "AI control settings have been updated successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Update Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // What the server did when the switch was last sent on from this page: which
  // running scans it sent a stop, and which the engine accepted. The page says
  // that and nothing more -- it used to say "All AI operations have been
  // terminated" over a scan that was still running, because the switch told
  // the engine nothing.
  const [stopReport, setStopReport] = useState<StopReport | null>(null);

  // Its own mutation, never held back by another control: while any other
  // setting was saving, the shared mutation's pending state disabled "Confirm
  // Shutdown". Nor is it disabled while its own request is out: sending the
  // switch on twice sends the stops twice, which is harmless.
  const engage = useMutation({
    mutationFn: async () => {
      const response = await apiFetch("PATCH", "/api/ai-control", {
        killSwitchEnabled: true,
        systemStatus: "shutdown",
        activeSystems: [],
      });
      // A switch that could not be stored still sent every stop, and the
      // server's 500 says what each came to: that is read, not thrown away.
      const answered = (await response.clone().json().catch(() => null)) as
        (AIControlSetting & { stops?: KillSwitchStops; engineRuns?: EngineSweep; engaged?: false; message?: string }) | null;
      if (!response.ok && answered?.engaged === false && answered.stops) {
        return { ...answered, notEngaged: answered.message ?? "the setting could not be saved" };
      }
      await throwIfResNotOk(response);
      return answered as AIControlSetting & { stops?: KillSwitchStops; engineRuns?: EngineSweep; notEngaged?: string };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-control"] });
      const report: StopReport | null = result.stops
        ? { stops: result.stops, engineRuns: result.engineRuns, notEngaged: result.notEngaged }
        : null;
      setStopReport(report);
      toast({
        title: result.notEngaged !== undefined ? "The kill switch was not engaged" : "Kill switch engaged",
        description: report
          ? [
              report.notEngaged ?? "",
              stopSentence(report.stops, leadOf(report)),
              report.engineRuns ? engineSweepSentence(report.engineRuns) : "",
            ].filter(Boolean).join(" ")
          : "The server did not say what it stopped.",
        variant: report && report.notEngaged === undefined && everyStopTook(report) ? undefined : "destructive",
      });
    },
    onError: (error: Error) => {
      toast({ title: "The kill switch was not engaged", description: error.message, variant: "destructive" });
    },
  });

  const handleKillSwitch = () => {
    if (!isKillSwitchConfirmOpen) {
      setIsKillSwitchConfirmOpen(true);
      return;
    }

    engage.mutate();
    setIsKillSwitchConfirmOpen(false);
  };

  const handleReactivate = () => {
    // The report is about the engagement this page sent; it says nothing about a later one.
    setStopReport(null);
    updateMutation.mutate({
      killSwitchEnabled: false,
      systemStatus: "active",
      activeSystems: [...DEFAULT_ACTIVE_SYSTEMS],
    });
  };

  const handleToggleSystem = (system: string) => {
    if (!settings) return;
    const currentSystems = settings.activeSystems || [];
    const newSystems = currentSystems.includes(system)
      ? currentSystems.filter((s) => s !== system)
      : [...currentSystems, system];
    
    updateMutation.mutate({ activeSystems: newSystems });
  };

  const handleUpdateMaxTests = (value: number) => {
    updateMutation.mutate({ maxConcurrentTests: value });
  };

  // The systems the server switches (shared/ai-systems.ts), and what switching
  // each off does. "Threat Detection" was offered beside them and governed
  // nothing -- this build does no threat detection -- so it is not offered.
  const ICONS: Record<string, typeof Shield> = { "penetration-testing": Shield, "vulnerability-scanner": Activity };
  const EFFECT: Record<string, string> = {
    "penetration-testing": "Off: no penetration test (the scan screens' scans) can be started.",
    "vulnerability-scanner": "Off: no vulnerability scan can be started.",
  };
  const systemOptions = AI_SYSTEMS.map((one) => ({ ...one, icon: ICONS[one.id] ?? Shield, effect: EFFECT[one.id] ?? "" }));
  // Ids on record that are not a system this build switches (the installer's
  // old ids, or anything written through the API): shown, not guessed at.
  const unknownSystems = known
    ? (settings.activeSystems ?? []).filter((id) => !systemOptions.some((one) => one.id === id))
    : [];

  // No full-page spinner while the settings load: it hid the kill switch
  // until they answered, so a read that hung held the stop out of reach. The
  // switch is drawn at once, in no state, and sends the shutdown either way.

  const isEmergency = settings?.killSwitchEnabled || settings?.systemStatus === "shutdown";
  // The status as recorded. It used to read "Offline" for anything but
  // "active", so the installer's "operational" showed as offline.
  const statusLabel = !known
    ? "—"
    : isEmergency
      ? "Shut down"
      : settings.systemStatus === "active" || settings.systemStatus === "operational"
        ? "Operational"
        : settings.systemStatus.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="min-h-screen">
      <div className="container mx-auto p-6 space-y-8">
        <AnimatedContainer direction="up" delay={0}>
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <motion.h1
                className="text-3xl md:text-4xl font-bold tracking-tight flex items-center gap-3"
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1.2, delay: 0.3 }}
              >
                <Settings className="w-10 h-10 text-primary" />
                AI <span className="bg-gradient-to-r from-gold via-primary to-gold-dim bg-clip-text text-transparent">Control Panel</span>
              </motion.h1>
              <div className="athena-meander max-w-xs" aria-hidden="true" />
              <motion.p
                className="text-muted-foreground"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.8, duration: 1 }}
              >
                Stop what is running, and decide which scans may start
              </motion.p>
            </div>

            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.5, type: "spring" }}
            >
              <Badge 
                variant={isEmergency ? "destructive" : "default"}
                className="text-lg px-4 py-2"
                data-testid="badge-system-status"
              >
                {isEmergency ? "SHUTDOWN" : settings?.systemStatus?.toUpperCase() || "UNKNOWN"}
              </Badge>
            </motion.div>
          </div>
        </AnimatedContainer>

        {settingsFailed && (
          <GlassCard className="border border-destructive/50">
            <CardContent className="pt-6 text-sm text-muted-foreground" data-testid="text-settings-failed">
              Could not load the AI control settings: {settings$.state === "error" ? settings$.message : ""}
            </CardContent>
          </GlassCard>
        )}

        {/* Emergency Kill Switch */}
        <AnimatedContainer direction="up" delay={0.2}>
          <GlassCard className="border-2 border-destructive/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="w-6 h-6" />
                Emergency Controls
              </CardTitle>
              <CardDescription>
                Refuse every write except stops, and send a stop to every engine scan recorded as running and
                every run the engine lists as live by a run id
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* The server's account of the stops this page sent, shown
                  whatever the settings read says since: it is a record of what
                  happened, not a reading of the switch. */}
              {stopReport?.notEngaged !== undefined && (
                <p className="text-sm p-3 rounded-lg border border-destructive" data-testid="text-kill-switch-not-engaged">
                  {stopReport.notEngaged}
                </p>
              )}
              {stopReport && (
                <p className="text-sm p-3 rounded-lg border border-destructive/50" data-testid="text-kill-switch-stops">
                  {stopSentence(stopReport.stops, leadOf(stopReport))}
                </p>
              )}
              {stopReport?.engineRuns && (
                <p className="text-sm p-3 rounded-lg border border-destructive/50" data-testid="text-kill-switch-engine-runs">
                  {engineSweepSentence(stopReport.engineRuns)}
                </p>
              )}
              {isEmergency ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 rounded-lg bg-destructive/10 border border-destructive">
                    <div className="flex items-center gap-3">
                      <Power className="w-6 h-6 text-destructive animate-pulse" />
                      <div>
                        <p className="font-semibold text-destructive">Kill switch engaged</p>
                        <p className="text-sm text-muted-foreground" data-testid="text-kill-switch-engaged">
                          Writes are refused while it is engaged, except stops: a scan&apos;s Stop, and a failsafe
                          pause, stand-down or terminate, stay available.
                          {!stopReport &&
                            " This page has not sent it in this session, so it does not say what was stopped; each" +
                              " stop sent when it was engaged is in the audit log."}
                        </p>
                      </div>
                    </div>
                  </div>
                  <Button
                    onClick={() => engage.mutate()}
                    variant="destructive"
                    size="lg"
                    className="w-full"
                    data-testid="button-resend-stops"
                  >
                    <Power className="w-5 h-5 mr-2" />
                    {engage.isPending ? "Sending the stops…" : "Send the stops again"}
                  </Button>
                  <Button
                    onClick={handleReactivate}
                    variant="default"
                    size="lg"
                    className="w-full"
                    data-testid="button-reactivate"
                    disabled={updateMutation.isPending}
                  >
                    <Zap className="w-5 h-5 mr-2" />
                    Reactivate All Systems
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {!known && (
                    <p className="text-sm text-muted-foreground" data-testid="text-kill-switch-unknown">
                      {isLoading
                        ? "Kill switch state not read yet: the settings are still loading."
                        : "Kill switch state unknown: the settings could not be read."}{" "}
                      Activating it still sends the shutdown.
                    </p>
                  )}
                  {!isKillSwitchConfirmOpen ? (
                    <Button
                      onClick={handleKillSwitch}
                      variant="destructive"
                      size="lg"
                      className="w-full"
                      data-testid="button-kill-switch"
                    >
                      <Power className="w-5 h-5 mr-2" />
                      Activate Kill Switch
                    </Button>
                  ) : (
                    <div className="space-y-3">
                      <div className="p-4 rounded-lg bg-destructive/10 border border-destructive">
                        <p className="font-semibold text-destructive flex items-center gap-2">
                          <AlertTriangle className="w-5 h-5" />
                          Confirm Emergency Shutdown
                        </p>
                        <p className="text-sm text-muted-foreground mt-1">
                          Every write except a stop is refused, and every engine scan recorded as running -- and every
                          other run the engine lists as live by a run id -- is sent a stop. This page then says which the
                          engine accepted, which it could not be reached for, and any live run it listed with no run id,
                          which no stop can name.
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={handleKillSwitch}
                          variant="destructive"
                          className="flex-1"
                          data-testid="button-confirm-kill-switch"
                        >
                          <Check className="w-4 h-4 mr-2" />
                          {engage.isPending ? "Engaging…" : "Confirm Shutdown"}
                        </Button>
                        <Button
                          onClick={() => setIsKillSwitchConfirmOpen(false)}
                          variant="outline"
                          className="flex-1"
                          data-testid="button-cancel-kill-switch"
                        >
                          <X className="w-4 h-4 mr-2" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </GlassCard>
        </AnimatedContainer>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Active Systems Control */}
          <AnimatedContainer direction="left" delay={0.3}>
            <GlassCard>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="w-5 h-5" />
                  Active Systems
                </CardTitle>
                <CardDescription>
                  Enforced when a scan starts: a scan whose system is switched off is refused. A scan already
                  running is not stopped by a switch -- use its Stop or the kill switch -- and no switch ever holds
                  back a stop.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {systemOptions.map((system, index) => {
                  const isActive = settings?.activeSystems?.includes(system.id) ?? false;
                  const Icon = system.icon;
                  
                  return (
                    <motion.div
                      key={system.id}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.1 * index }}
                      className="flex items-center justify-between p-3 rounded-lg border hover-elevate"
                      data-testid={`system-${system.id}`}
                    >
                      <div className="flex items-center gap-3">
                        <Icon className={`w-5 h-5 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} />
                        <div>
                          <Label htmlFor={`system-${system.id}`} className="cursor-pointer">
                            {system.label}
                          </Label>
                          <p className="text-xs text-muted-foreground">{system.effect}</p>
                        </div>
                      </div>
                      <Switch
                        id={`system-${system.id}`}
                        checked={isActive}
                        onCheckedChange={() => handleToggleSystem(system.id)}
                        disabled={!known || isEmergency || updateMutation.isPending}
                        data-testid={`switch-${system.id}`}
                      />
                    </motion.div>
                  );
                })}
                {unknownSystems.length > 0 && (
                  <p className="text-sm text-muted-foreground" data-testid="text-unknown-systems">
                    Also on record, and not a system this build switches, so it governs nothing:{" "}
                    {unknownSystems.join(", ")}.
                  </p>
                )}
              </CardContent>
            </GlassCard>
          </AnimatedContainer>

          {/* System Settings */}
          <AnimatedContainer direction="right" delay={0.3}>
            <GlassCard>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Settings className="w-5 h-5" />
                  System Configuration
                </CardTitle>
                <CardDescription>
                  Enforced when a scan starts. Stops are never limited.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="max-tests">Max Concurrent Tests</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="max-tests"
                      type="number"
                      min={1}
                      max={20}
                      value={settings?.maxConcurrentTests ?? ""}
                      onChange={(e) => handleUpdateMaxTests(parseInt(e.target.value))}
                      disabled={!known || isEmergency || updateMutation.isPending}
                      data-testid="input-max-tests"
                    />
                    <span className="text-sm text-muted-foreground whitespace-nowrap">tests</span>
                  </div>
                  <p className="text-sm text-muted-foreground" data-testid="text-max-tests-effect">
                    A scan is refused while this many engine scans are running (as the engine lists them; as recorded here when it cannot be asked).
                  </p>
                </div>
              </CardContent>
            </GlassCard>
          </AnimatedContainer>
        </div>

        {/* System Status Info */}
        <AnimatedContainer direction="up" delay={0.4}>
          <GlassCard>
            <CardHeader>
              <CardTitle>System Information</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Active Systems</p>
                  <p className="text-2xl font-bold" data-testid="text-active-count">
                    {/* Only the systems this page lists, so the count agrees
                        with the switches above; an id it does not know is
                        not an active system it can show. */}
                    {known
                      ? `${systemOptions.filter((o) => settings.activeSystems?.includes(o.id)).length} / ${systemOptions.length}`
                      : "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">System Status</p>
                  <p className="text-2xl font-bold" data-testid="text-status">
                    {statusLabel}
                  </p>
                </div>
              </div>
            </CardContent>
          </GlassCard>
        </AnimatedContainer>
      </div>
    </div>
  );
}
