import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { errorMessage } from "@/lib/loaded";
import { Plus, Search, Filter, Calendar, MapPin, Shield, AlertTriangle, CheckCircle, XCircle, Pencil, FileText } from "lucide-react";
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
import type { Test, Client, Site, InsertTest } from "@shared/schema";

/**
 * Radix Select forbids an empty string as an item value, so optional fields use
 * the sentinel "none". Convert it back to null before sending to the API.
 */
function normalizeOptional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" || text === "none" ? null : text;
}

/** `findings` is free-form JSON; show the details field when there is one. */
function renderFindings(findings: unknown): string {
  if (findings && typeof findings === "object" && "details" in findings) {
    const details = (findings as { details: unknown }).details;
    if (typeof details === "string") return details;
  }
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
    mutationFn: async (data: InsertTest) => apiRequest("POST", "/api/tests", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tests"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/tests"] });
      toast({ title: "Test updated successfully" });
      setIsEditDialogOpen(false);
      setEditingTest(null);
    },
    onError: (error) => {
      toast({ title: "Failed to update test", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/tests/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tests"] });
      toast({ title: "Test deleted successfully" });
    },
    onError: (error) => {
      toast({ title: "Failed to delete test", description: error.message, variant: "destructive" });
    },
  });

  const handleCreateTest = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const findingsText = formData.get("findings") as string || "";
    const data: InsertTest = {
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
      executedBy: null,
      completedAt: null,
    };
    createMutation.mutate(data);
  };

  const handleEditTest = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingTest) return;
    const formData = new FormData(e.currentTarget);
    const findingsText = formData.get("findings") as string || "";
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
                                  <AlertDialogDescription>
                                    Are you sure you want to delete this test? This action cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => deleteMutation.mutate(test.id)}
                                    data-testid={`button-confirm-delete-${test.id}`}
                                  >
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </div>

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

                        {test.vulnerabilitiesFound > 0 && (
                          <div className="border-t border-border pt-4">
                            <div className="flex items-center gap-2 mb-3">
                              <AlertTriangle className="w-4 h-4 text-primary" />
                              <span className="font-semibold">
                                {test.vulnerabilitiesFound} Vulnerabilities Found
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
                </div>

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
                  <Label htmlFor="findings">Findings</Label>
                  <Textarea
                    name="findings"
                    placeholder="Detailed findings..."
                    rows={4}
                    defaultValue={editingTest.findings != null ? renderFindings(editingTest.findings) : ""}
                    data-testid="input-edit-findings"
                  />
                </div>

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
