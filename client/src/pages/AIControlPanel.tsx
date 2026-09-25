import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { errorMessage } from "@/lib/loaded";
import { motion } from "framer-motion";
import { Shield, Power, AlertTriangle, Settings, Activity, Zap, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { AIControlSetting } from "@shared/schema";
import AnimatedContainer from "@/components/AnimatedContainer";
import GlassCard from "@/components/GlassCard";

export default function AIControlPanel() {
  const { toast } = useToast();
  const [isKillSwitchConfirmOpen, setIsKillSwitchConfirmOpen] = useState(false);

  const {
    data: settings,
    isLoading,
    isError: settingsFailed,
    error: settingsError,
  } = useQuery<AIControlSetting>({
    queryKey: ["/api/ai-control"],
  });
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

  const handleKillSwitch = () => {
    if (!isKillSwitchConfirmOpen) {
      setIsKillSwitchConfirmOpen(true);
      return;
    }

    updateMutation.mutate({
      killSwitchEnabled: true,
      systemStatus: "shutdown",
      activeSystems: [],
    });
    setIsKillSwitchConfirmOpen(false);
  };

  const handleReactivate = () => {
    updateMutation.mutate({
      killSwitchEnabled: false,
      systemStatus: "active",
      activeSystems: ["penetration-testing", "vulnerability-scanner", "threat-detection"],
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

  const handleOverrideMode = (enabled: boolean) => {
    updateMutation.mutate({ overrideMode: enabled });
  };

  const handleUpdateThreshold = (value: number) => {
    updateMutation.mutate({ autoShutdownThreshold: value });
  };

  const handleUpdateMaxTests = (value: number) => {
    updateMutation.mutate({ maxConcurrentTests: value });
  };

  const systemOptions = [
    { id: "penetration-testing", label: "Penetration Testing", icon: Shield },
    { id: "vulnerability-scanner", label: "Vulnerability Scanner", icon: Activity },
    { id: "threat-detection", label: "Threat Detection", icon: AlertTriangle },
  ];

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-primary border-r-transparent"></div>
      </div>
    );
  }

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
                Monitor and control all AI systems with emergency override capabilities
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
              Could not load the AI control settings: {errorMessage(settingsError)}
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
                Immediate shutdown of all AI systems and testing operations
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {isEmergency ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 rounded-lg bg-destructive/10 border border-destructive">
                    <div className="flex items-center gap-3">
                      <Power className="w-6 h-6 text-destructive animate-pulse" />
                      <div>
                        <p className="font-semibold text-destructive">System Shutdown Active</p>
                        <p className="text-sm text-muted-foreground">All AI operations have been terminated</p>
                      </div>
                    </div>
                  </div>
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
                      Kill switch state unknown: the settings could not be read. Activating it still sends the shutdown.
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
                          This will immediately stop all active tests and AI operations
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={handleKillSwitch}
                          variant="destructive"
                          className="flex-1"
                          data-testid="button-confirm-kill-switch"
                          disabled={updateMutation.isPending}
                        >
                          <Check className="w-4 h-4 mr-2" />
                          Confirm Shutdown
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
                  Enable or disable individual AI systems
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
                        <Label htmlFor={`system-${system.id}`} className="cursor-pointer">
                          {system.label}
                        </Label>
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
                  Adjust system parameters and limits
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="override-mode">Override Mode</Label>
                    <Switch
                      id="override-mode"
                      checked={settings?.overrideMode ?? false}
                      onCheckedChange={handleOverrideMode}
                      disabled={!known || isEmergency || updateMutation.isPending}
                      data-testid="switch-override-mode"
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Bypass safety protocols for emergency operations
                  </p>
                </div>

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
                </div>

                <div className="space-y-2">
                  <Label htmlFor="shutdown-threshold">Auto-Shutdown Threshold</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="shutdown-threshold"
                      type="number"
                      min={50}
                      max={100}
                      value={settings?.autoShutdownThreshold ?? ""}
                      onChange={(e) => handleUpdateThreshold(parseInt(e.target.value))}
                      disabled={!known || isEmergency || updateMutation.isPending}
                      data-testid="input-shutdown-threshold"
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    System load threshold for automatic safety shutdown
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
              <div className="grid gap-4 md:grid-cols-3">
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
                  <p className="text-sm text-muted-foreground">Override Mode</p>
                  <p className="text-2xl font-bold" data-testid="text-override-status">
                    {known ? (settings.overrideMode ? "Enabled" : "Disabled") : "—"}
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
