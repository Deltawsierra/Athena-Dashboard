import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { errorMessage } from "@/lib/loaded";
import { Plus, Search, Filter, Calendar, MapPin, Shield, AlertTriangle, CheckCircle, XCircle, Pencil, FileText, Square } from "lucide-react";
import { motion } from "framer-motion";
import { format } from "date-fns";
import GlassCard from "@/components/GlassCard";
import AnimatedContainer from "@/components/AnimatedContainer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import SampleDataNotice from "@/components/SampleDataNotice";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import NoStopPanel from "@/components/NoStopPanel";
import { failsafeOnly, noStopCanBeSent, unfinishedRunOf } from "@/lib/engineRuns";
import { invalidateTestsAndFindings } from "@/lib/invalidate";
import type { Test, Client, Site, CreateTest } from "@shared/schema";
import { countsNotRecorded, reportedTotal } from "@shared/latest-scans";
import { engineRunIdOf, isEngineRecord } from "@shared/engine-record";

/**
 * Radix Select forbids an empty string as an item value, so optional fields use
 * the sentinel "none". Convert it back to null before sending to the API.
 */
function normalizeOptional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" || text === "none" ? null : text;
}

/**
 * The engine run behind a test, as a person reads it: "run <id>", or what is
 * said of a run the engine gave no id. null when the test is a person's.
 *
 * Decided by the rule the server guards an edit by (shared/engine-record.ts),
 * never by the run id alone: read by its run id, a scan the engine finished
 * without one was offered to edit as a person's test -- its counts and severity
 * editable, the run's JSON in its notes box -- and its summary-only edit sent a
 * severity the server then refused.
 */
function engineRunOf(findings: unknown): string | null {
  if (!isEngineRecord(findings)) return null;
  const runId = engineRunIdOf(findings);
  return runId !== null ? `run ${runId}` : "a run it gave no id";
}

/** A person's notes on a test: the `details` of its findings, when there are any. */
function notesOf(findings: unknown): string | null {
  if (!findings || typeof findings !== "object") return null;
  const details = (findings as { details?: unknown }).details;
  return typeof details === "string" ? details : null;
}

/** `findings` is free-form JSON; show the details field when there is one. */
function renderFindings(findings: unknown): string {
  if (isEngineRecord(findings)) {
    // An engine scan's results are the engine's; its notes are a person's.
    const results = (findings as { results?: unknown }).results;
    const notes = notesOf(findings);
    const n = Array.isArray(results) ? results.length : 0;
    const recorded = results !== undefined && !Array.isArray(results)
      ? "its results could not be read"
      : `${n} result${n === 1 ? "" : "s"} recorded by the engine`;
    const runId = engineRunIdOf(findings);
    return `${runId !== null ? `Engine run ${runId}` : "Engine run with no id"}: ${recorded}.${notes ? ` Notes: ${notes}` : ""}`;
  }
  const notes = notesOf(findings);
  if (notes !== null) return notes;
  return JSON.stringify(findings);
}

export default function Tests() {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingTest, setEditingTest] = useState<Test | null>(null);
  const { toast } = useToast();

  const {
    data: tests = [],
    isLoading,
    isError: testsFailed,
    error: testsError,
  } = useQuery<Test[]>({
    queryKey: ["/api/tests"],
  });

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
  });

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ["/api/sites"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: CreateTest) => apiRequest("POST", "/api/tests", data),
    onSuccess: () => {
      // Not only the list: the findings summary and every other answer
      // computed from tests (lib/invalidate.ts).
      void invalidateTestsAndFindings();
      toast({ title: "Test created successfully" });
      setIsCreateDialogOpen(false);
    },
    onError: (error) => {
      toast({ title: "Failed to create test", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<Test> }) =>
      apiRequest("PATCH", `/api/tests/${id}`, data),
    onSuccess: () => {
      void invalidateTestsAndFindings();
      toast({ title: "Test updated successfully" });
      setIsEditDialogOpen(false);
      setEditingTest(null);
    },
    onError: (error) => {
      toast({ title: "Failed to update test", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    // `force`: a scan no Stop can reach (failsafeOnly) is deleted only when
    // asked in so many words; the server refuses it otherwise.
    mutationFn: async ({ id, force }: { id: string; force?: boolean }) => {
      const response = await apiRequest("DELETE", `/api/tests/${id}${force ? "?force=1" : ""}`);
      return (await response.json().catch(() => ({}))) as { stops?: Array<{ runId: string; stopped: boolean }>; detail?: string };
    },
    onSuccess: (result) => {
      void invalidateTestsAndFindings();
      // A running scan is deleted only after the engine accepted its stop; say that it was stopped.
      const stopped = (result.stops ?? []).filter((one) => one.stopped).map((one) => one.runId);
      toast({
        title: "Test deleted successfully",
        ...(stopped.length > 0
          ? { description: `Its engine run ${stopped.join(", ")} was sent a stop first, and the engine accepted it.` }
          : result.detail ? { description: `Its record is deleted; ${result.detail}.` } : {}),
      });
    },
    onError: (error) => {
      toast({ title: "Failed to delete test", description: error.message, variant: "destructive" });
    },
  });

  // A running engine scan's Stop, on its row. It existed only on the scan
  // screen that started the scan, so once that page was left -- or for a scan
  // someone else started -- this list showed the scan with Edit and Delete
  // and no way to stop it. The abort route asks the engine and says if it did
  // not stop; nothing here decides that a scan has stopped.
  const stopMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await apiRequest("POST", `/api/scans/${id}/abort`, undefined);
      return (await response.json()) as { stopped: boolean; runId: string };
    },
    onSuccess: (result, id) => {
      queryClient.invalidateQueries({ queryKey: [`/api/scans/${id}`] });
      void invalidateTestsAndFindings();
      toast({ title: "Stop sent", description: `The engine accepted the stop for run ${result.runId}.` });
    },
    onError: (error) => {
      toast({ title: "Not stopped", description: error.message, variant: "destructive" });
    },
  });

  const handleCreateTest = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const findingsText = formData.get("findings") as string || "";
    // The route's own schema's type: no `executedBy` (the server records who
    // ran it from the session, and refuses a body that names it) and no
    // `completedAt` (the server stamps it when a test is created completed).
    const data: CreateTest = {
      clientId: formData.get("clientId") as string,
      siteId: normalizeOptional(formData.get("siteId")),
      testType: formData.get("testType") as string,
      status: formData.get("status") as string,
      severity: normalizeOptional(formData.get("severity")),
      summary: formData.get("summary") as string || null,
      findings: findingsText ? { details: findingsText } : null,
      vulnerabilitiesFound: parseInt(formData.get("vulnerabilitiesFound") as string) || 0,
      criticalCount: parseInt(formData.get("criticalCount") as string) || 0,
      highCount: parseInt(formData.get("highCount") as string) || 0,
      mediumCount: parseInt(formData.get("mediumCount") as string) || 0,
      lowCount: parseInt(formData.get("lowCount") as string) || 0,
    };
    createMutation.mutate(data);
  };

  const handleEditTest = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingTest) return;
    const formData = new FormData(e.currentTarget);
    const findingsText = formData.get("findings") as string || "";
    if (engineRunOf(editingTest.findings)) {
      // An engine scan: only what a person writes. The form sent the whole
      // findings back as `details`, which wrote over the run id -- a running
      // scan lost its Stop and its results were never filed. Its status,
      // severity and counts are the engine's, and the server refuses a change
      // to them (and keeps the run's keys whatever is sent).
      updateMutation.mutate({
        id: editingTest.id,
        data: {
          summary: formData.get("summary") as string || null,
          testType: formData.get("testType") as string,
          findings: findingsText.trim() ? { details: findingsText } : null,
        },
      });
      return;
    }
    const data: Partial<Test> = {
      summary: formData.get("summary") as string || null,
      testType: formData.get("testType") as string,
      status: formData.get("status") as string,
      severity: normalizeOptional(formData.get("severity")),
      findings: findingsText ? { details: findingsText } : null,
      vulnerabilitiesFound: parseInt(formData.get("vulnerabilitiesFound") as string) || 0,
      criticalCount: parseInt(formData.get("criticalCount") as string) || 0,
      highCount: parseInt(formData.get("highCount") as string) || 0,
      mediumCount: parseInt(formData.get("mediumCount") as string) || 0,
      lowCount: parseInt(formData.get("lowCount") as string) || 0,
    };
    updateMutation.mutate({ id: editingTest.id, data });
  };

  const filteredTests = tests.filter((test) => {
    const matchesSearch = test.summary?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         test.testType.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || test.status === statusFilter;
    const matchesClient = clientFilter === "all" || test.clientId === clientFilter;
    
    return matchesSearch && matchesStatus && matchesClient;
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "default";
      case "in-progress":
        return "secondary";
      case "pending":
        return "outline";
      case "failed":
        return "destructive";
      default:
        return "outline";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle className="w-4 h-4" />;
      case "failed":
        return <XCircle className="w-4 h-4" />;
      case "in-progress":
        return <AlertTriangle className="w-4 h-4" />;
      default:
        return null;
    }
  };

  const getSeverityColor = (severity: string | null) => {
    switch (severity) {
      case "critical":
        return "destructive";
      case "high":
        return "destructive";
      case "medium":
        return "secondary";
      case "low":
        return "outline";
      default:
        return "outline";
    }
  };

  // The engine run behind the test being edited, if there is one: its status,
  // severity, counts and results are the engine's, not the form's.
  const editingRun = editingTest ? engineRunOf(editingTest.findings) : null;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-primary border-r-transparent"></div>
      </div>
    );
  }

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
                <Shield className="w-10 h-10 text-primary" />
                Security <span className="bg-gradient-to-r from-gold via-primary to-gold-dim bg-clip-text text-transparent">Tests</span>
              </motion.h1>
              <div className="athena-meander max-w-xs" aria-hidden="true" />
              <motion.p
                className="text-muted-foreground"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.8, duration: 1 }}
              >
                Comprehensive test tracking with detailed results and vulnerability analysis
              </motion.p>
            </div>

            <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button data-testid="button-create-test">
                  <Plus className="w-4 h-4 mr-2" />
                  Create Test
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Create New Test</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleCreateTest} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="clientId">Client *</Label>
                      <Select name="clientId" required>
                        <SelectTrigger data-testid="select-client">
                          <SelectValue placeholder="Select client" />
                        </SelectTrigger>
                        <SelectContent>
                          {clients.map((client) => (
                            <SelectItem key={client.id} value={client.id}>
                              {client.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="siteId">Site (Optional)</Label>
                      <Select name="siteId">
                        <SelectTrigger data-testid="select-site">
                          <SelectValue placeholder="Select site" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {sites.map((site) => (
                            <SelectItem key={site.id} value={site.id}>
                              {site.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="testType">Test Type *</Label>
                      <Select name="testType" required>
                        <SelectTrigger data-testid="select-test-type">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="penetration-test">Penetration Test</SelectItem>
                          <SelectItem value="vulnerability-scan">Vulnerability Scan</SelectItem>
                          <SelectItem value="code-review">Code Review</SelectItem>
                          <SelectItem value="social-engineering">Social Engineering</SelectItem>
                          <SelectItem value="compliance-audit">Compliance Audit</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="status">Status *</Label>
                      <Select name="status" required defaultValue="pending">
                        <SelectTrigger data-testid="select-status">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pending">Pending</SelectItem>
                          <SelectItem value="in-progress">In Progress</SelectItem>
                          <SelectItem value="completed">Completed</SelectItem>
                          <SelectItem value="failed">Failed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="severity">Severity</Label>
                    <Select name="severity">
                      <SelectTrigger data-testid="select-severity">
                        <SelectValue placeholder="Select severity" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="critical">Critical</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="low">Low</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="summary">Summary</Label>
                    <Input name="summary" placeholder="Test summary..." data-testid="input-summary" />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="findings">Findings</Label>
                    <Textarea
                      name="findings"
                      placeholder="Detailed findings..."
                      rows={4}
                      data-testid="input-findings"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="vulnerabilitiesFound">Total Vulnerabilities</Label>
                      <Input
                        type="number"
                        name="vulnerabilitiesFound"
                        defaultValue="0"
                        min="0"
                        data-testid="input-vulnerabilities"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="criticalCount">Critical Count</Label>
                      <Input
                        type="number"
                        name="criticalCount"
                        defaultValue="0"
                        min="0"
                        data-testid="input-critical"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="highCount">High</Label>
                      <Input
                        type="number"
                        name="highCount"
                        defaultValue="0"
                        min="0"
                        data-testid="input-high"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="mediumCount">Medium</Label>
                      <Input
                        type="number"
                        name="mediumCount"
                        defaultValue="0"
                        min="0"
                        data-testid="input-medium"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="lowCount">Low</Label>
                      <Input
                        type="number"
                        name="lowCount"
                        defaultValue="0"
                        min="0"
                        data-testid="input-low"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit">
                      {createMutation.isPending ? "Creating..." : "Create Test"}
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </AnimatedContainer>

        <AnimatedContainer direction="up" delay={0.05}>
          <SampleDataNotice counts={["tests", "findings"]} />
        </AnimatedContainer>

        <AnimatedContainer direction="up" delay={0.1}>
          <GlassCard>
            <div className="flex flex-col md:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search tests by summary or type..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  data-testid="input-search"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full md:w-48" data-testid="select-filter-status">
                  <Filter className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="in-progress">In Progress</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={clientFilter} onValueChange={setClientFilter}>
                <SelectTrigger className="w-full md:w-48" data-testid="select-filter-client">
                  <Filter className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="Filter by client" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Clients</SelectItem>
                  {clients.map((client) => (
                    <SelectItem key={client.id} value={client.id}>
                      {client.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </GlassCard>
        </AnimatedContainer>

        <AnimatedContainer direction="up" delay={0.2}>
          <div className="grid gap-6">
            {testsFailed ? (
              // A failed read is not an empty record: say so, not "No Tests Found".
              <GlassCard>
                <div className="text-center py-12">
                  <Shield className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                  <p className="text-muted-foreground">
                    Could not load tests: {errorMessage(testsError)}
                  </p>
                </div>
              </GlassCard>
            ) : filteredTests.length === 0 ? (
              <GlassCard>
                <div className="text-center py-12">
                  <Shield className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No Tests Found</h3>
                  <p className="text-muted-foreground mb-4">
                    {searchQuery || statusFilter !== "all" || clientFilter !== "all"
                      ? "Try adjusting your filters"
                      : "Create your first security test to get started"}
                  </p>
                </div>
              </GlassCard>
            ) : (
              filteredTests.map((test, index) => {
                const client = clients.find((c) => c.id === test.clientId);
                const site = sites.find((s) => s.id === test.siteId);

                return (
                  <motion.div
                    key={test.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.05, duration: 0.3 }}
                  >
                    <GlassCard className="hover-elevate">
                      <div className="space-y-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 space-y-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-xl font-semibold" data-testid={`text-test-type-${test.id}`}>
                                {test.testType.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())}
                              </h3>
                              <Badge variant={getStatusColor(test.status)} data-testid={`badge-status-${test.id}`}>
                                {getStatusIcon(test.status)}
                                <span className="ml-1">{test.status}</span>
                              </Badge>
                              {test.severity && (
                                <Badge variant={getSeverityColor(test.severity)} data-testid={`badge-severity-${test.id}`}>
                                  {test.severity}
                                </Badge>
                              )}
                            </div>
                            {test.summary && (
                              <p className="text-muted-foreground" data-testid={`text-summary-${test.id}`}>
                                {test.summary}
                              </p>
                            )}
                          </div>
                          <div className="flex gap-2">
                            {unfinishedRunOf(test) && (
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => stopMutation.mutate(test.id)}
                                disabled={stopMutation.isPending && stopMutation.variables === test.id}
                                data-testid={`button-stop-${test.id}`}
                              >
                                <Square className="w-4 h-4 mr-1" />
                                {stopMutation.isPending && stopMutation.variables === test.id ? "Stopping…" : "Stop"}
                              </Button>
                            )}
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => {
                                setEditingTest(test);
                                setIsEditDialogOpen(true);
                              }}
                              data-testid={`button-edit-${test.id}`}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button size="icon" variant="ghost" data-testid={`button-delete-${test.id}`}>
                                  <XCircle className="w-4 h-4" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete Test</AlertDialogTitle>
                                  <AlertDialogDescription data-testid={`text-delete-warning-${test.id}`}>
                                    {failsafeOnly(test) && !noStopCanBeSent(test)
                                      ? "This scan may still be running. The engine gave it an id no Stop is offered " +
                                        "for (only space), but a stop can still reach it by that id: deleting it sends " +
                                        "that stop first, and deletes the test only once the engine accepts it; if it " +
                                        "does not, nothing is deleted. This action cannot be undone."
                                      : noStopCanBeSent(test)
                                      ? "This scan may still be running, and the engine gave it no run id a stop can " +
                                        "name, so no stop can be sent: deleting it only removes its record here, and " +
                                        "the run, if it is running, goes on. Stop it from the Failsafe console first " +
                                        "(pause, stand down or terminate the engine). Deleting it anyway sends no stop. " +
                                        "This action cannot be undone."
                                      : unfinishedRunOf(test)
                                      ? `This scan's engine run ${unfinishedRunOf(test)} may still be running. Deleting ` +
                                        "it sends the engine a stop first, and deletes the test only once the engine " +
                                        "accepts the stop; if it does not, nothing is deleted and the scan keeps its " +
                                        "Stop. This action cannot be undone."
                                      : "Are you sure you want to delete this test? This action cannot be undone."}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => deleteMutation.mutate({ id: test.id, force: noStopCanBeSent(test) })}
                                    data-testid={`button-confirm-delete-${test.id}`}
                                  >
                                    {noStopCanBeSent(test) ? "Delete without a stop" : "Delete"}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </div>

                        {/* The engine gave this scan no run id a stop can name: no
                            Stop here, and what stops it said in its place. */}
                        {failsafeOnly(test) && (
                          <div className="space-y-2">
                            <NoStopPanel testId={test.id} />
                            <p className="text-sm text-muted-foreground" data-testid={`text-no-stop-record-${test.id}`}>
                              This app cannot ask the engine about a scan with no run id, so its record stays running
                              after the engine has stopped it, and counts toward Max Concurrent Tests whenever the
                              engine&apos;s list of live runs cannot be read. Once it has stopped, delete this record to
                              free its place.
                            </p>
                          </div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="flex items-center gap-2 text-sm">
                            <Calendar className="w-4 h-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Started:</span>
                            <span data-testid={`text-started-${test.id}`}>
                              {format(new Date(test.startedAt), "MMM dd, yyyy")}
                            </span>
                          </div>
                          {client && (
                            <div className="flex items-center gap-2 text-sm">
                              <span className="text-muted-foreground">Client:</span>
                              <span className="font-medium" data-testid={`text-client-${test.id}`}>
                                {client.name}
                              </span>
                            </div>
                          )}
                          {site && (
                            <div className="flex items-center gap-2 text-sm">
                              <MapPin className="w-4 h-4 text-muted-foreground" />
                              <span className="text-muted-foreground">Site:</span>
                              <span data-testid={`text-site-${test.id}`}>{site.name}</span>
                            </div>
                          )}
                        </div>

                        {/* By the counts too: a test recorded with only "Critical
                            Count: 2" has a total of 0, and hid its criticals here. */}
                        {reportedTotal(test) > 0 && (
                          <div className="border-t border-border pt-4">
                            <div className="flex items-center gap-2 mb-3">
                              <AlertTriangle className="w-4 h-4 text-primary" />
                              <span className="font-semibold" data-testid={`text-found-${test.id}`}>
                                {reportedTotal(test)} Vulnerabilities Found
                              </span>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                              {test.criticalCount > 0 && (
                                <div className="text-sm">
                                  <span className="text-muted-foreground">Critical:</span>{" "}
                                  <span className="font-semibold text-destructive" data-testid={`text-critical-${test.id}`}>
                                    {test.criticalCount}
                                  </span>
                                </div>
                              )}
                              {test.highCount > 0 && (
                                <div className="text-sm">
                                  <span className="text-muted-foreground">High:</span>{" "}
                                  <span className="font-semibold" data-testid={`text-high-${test.id}`}>
                                    {test.highCount}
                                  </span>
                                </div>
                              )}
                              {test.mediumCount > 0 && (
                                <div className="text-sm">
                                  <span className="text-muted-foreground">Medium:</span>{" "}
                                  <span data-testid={`text-medium-${test.id}`}>{test.mediumCount}</span>
                                </div>
                              )}
                              {test.lowCount > 0 && (
                                <div className="text-sm">
                                  <span className="text-muted-foreground">Low:</span>{" "}
                                  <span data-testid={`text-low-${test.id}`}>{test.lowCount}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {test.findings != null && (
                          <div className="border-t border-border pt-4">
                            <div className="flex items-center gap-2 mb-2">
                              <FileText className="w-4 h-4 text-muted-foreground" />
                              <span className="font-semibold">Findings</span>
                            </div>
                            <p className="text-sm text-muted-foreground" data-testid={`text-findings-${test.id}`}>
                              {renderFindings(test.findings)}
                            </p>
                          </div>
                        )}
                      </div>
                    </GlassCard>
                  </motion.div>
                );
              })
            )}
          </div>
        </AnimatedContainer>

        {/* Edit Dialog */}
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Test</DialogTitle>
            </DialogHeader>
            {editingTest && (
              <form onSubmit={handleEditTest} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="testType">Test Type *</Label>
                    <Select name="testType" required defaultValue={editingTest.testType}>
                      <SelectTrigger data-testid="select-edit-test-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="penetration-test">Penetration Test</SelectItem>
                        <SelectItem value="vulnerability-scan">Vulnerability Scan</SelectItem>
                        <SelectItem value="code-review">Code Review</SelectItem>
                        <SelectItem value="social-engineering">Social Engineering</SelectItem>
                        <SelectItem value="compliance-audit">Compliance Audit</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {editingRun ? (
                    <div className="space-y-2">
                      <Label>Status</Label>
                      <p className="text-sm pt-2" data-testid="text-edit-status">{editingTest.status}</p>
                    </div>
                  ) : (
                  <div className="space-y-2">
                    <Label htmlFor="status">Status *</Label>
                    <Select name="status" required defaultValue={editingTest.status}>
                      <SelectTrigger data-testid="select-edit-status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="in-progress">In Progress</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                        <SelectItem value="failed">Failed</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  )}
                </div>

                {editingRun && (
                  <p className="text-sm text-muted-foreground rounded-lg border border-border p-3" data-testid="text-edit-engine-owned">
                    Recorded by the engine from {editingRun}: its status, severity and counts
                    {editingTest.status !== "completed"
                      ? " (none until it completes)"
                      : countsNotRecorded(editingTest)
                        ? " (counts not recorded)"
                        : ` (${reportedTotal(editingTest)} found; ${editingTest.criticalCount} critical, ${editingTest.highCount} high, ${editingTest.mediumCount} medium, ${editingTest.lowCount} low)`}
                    {" "}and its results are the engine&apos;s, and are not edited here. The summary, the test type and
                    the notes are yours.
                  </p>
                )}

                {!editingRun && (
                <div className="space-y-2">
                  <Label htmlFor="severity">Severity</Label>
                  <Select name="severity" defaultValue={editingTest.severity ?? "none"}>
                    <SelectTrigger data-testid="select-edit-severity">
                      <SelectValue placeholder="Select severity" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="critical">Critical</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="summary">Summary</Label>
                  <Input
                    name="summary"
                    placeholder="Test summary..."
                    defaultValue={editingTest.summary || ""}
                    data-testid="input-edit-summary"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="findings">{editingRun ? "Notes" : "Findings"}</Label>
                  <Textarea
                    name="findings"
                    placeholder={editingRun ? "Your notes on this scan..." : "Detailed findings..."}
                    rows={4}
                    defaultValue={
                      editingRun
                        ? notesOf(editingTest.findings) ?? ""
                        : editingTest.findings != null ? renderFindings(editingTest.findings) : ""
                    }
                    data-testid="input-edit-findings"
                  />
                </div>

                {!editingRun && (
                <>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="vulnerabilitiesFound">Total Vulnerabilities</Label>
                    <Input
                      type="number"
                      name="vulnerabilitiesFound"
                      defaultValue={editingTest.vulnerabilitiesFound}
                      min="0"
                      data-testid="input-edit-vulnerabilities"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="criticalCount">Critical Count</Label>
                    <Input
                      type="number"
                      name="criticalCount"
                      defaultValue={editingTest.criticalCount}
                      min="0"
                      data-testid="input-edit-critical"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="highCount">High</Label>
                    <Input
                      type="number"
                      name="highCount"
                      defaultValue={editingTest.highCount}
                      min="0"
                      data-testid="input-edit-high"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mediumCount">Medium</Label>
                    <Input
                      type="number"
                      name="mediumCount"
                      defaultValue={editingTest.mediumCount}
                      min="0"
                      data-testid="input-edit-medium"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lowCount">Low</Label>
                    <Input
                      type="number"
                      name="lowCount"
                      defaultValue={editingTest.lowCount}
                      min="0"
                      data-testid="input-edit-low"
                    />
                  </div>
                </div>
                </>
                )}

                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setIsEditDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={updateMutation.isPending} data-testid="button-edit-submit">
                    {updateMutation.isPending ? "Updating..." : "Update Test"}
                  </Button>
                </div>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
