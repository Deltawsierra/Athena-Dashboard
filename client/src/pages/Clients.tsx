import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Plus, Search, Building2, Mail, Phone, Calendar, AlertCircle, FileText, Shield } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import GlassCard from "@/components/GlassCard";
import AnimatedContainer from "@/components/AnimatedContainer";
import SampleDataNotice from "@/components/SampleDataNotice";
import type { Client, InsertClient } from "@shared/schema";

export default function Clients() {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [formStatus, setFormStatus] = useState<string>("active");

  const { data: clients = [], isLoading } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
  });

  const { data: tests = [] } = useQuery<any[]>({
    queryKey: ["/api/tests"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: InsertClient) => {
      return apiRequest("POST", "/api/clients", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
      setIsDialogOpen(false);
      toast({ title: "Client created successfully" });
    },
    onError: (error) => {
      console.error("Error creating client:", error);
      toast({ title: "Error creating client", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<InsertClient> }) =>
      apiRequest("PATCH", `/api/clients/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
      setIsDialogOpen(false);
      setEditingClient(null);
      toast({ title: "Client updated successfully" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/clients/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
      toast({ title: "Client deleted successfully" });
    },
  });

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const data = {
      name: formData.get("name") as string,
      company: formData.get("company") as string,
      email: formData.get("email") as string,
      phone: (formData.get("phone") as string) || null,
      status: formStatus,
      notes: (formData.get("notes") as string) || null,
    };

    if (editingClient) {
      updateMutation.mutate({ id: editingClient.id, data });
    } else {
      createMutation.mutate(data);
    }
  };
  
  const handleDialogOpenChange = (open: boolean) => {
    setIsDialogOpen(open);
    if (!open) {
      setEditingClient(null);
      setFormStatus("active");
    } else if (editingClient) {
      setFormStatus(editingClient.status);
    }
  };

  const filteredClients = clients.filter((client) => {
    const matchesSearch =
      client.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      client.company.toLowerCase().includes(searchTerm.toLowerCase()) ||
      client.email.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === "all" || client.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getClientTestCount = (clientId: string) => {
    return tests.filter((test: any) => test.clientId === clientId).length;
  };

  return (
    <div className="min-h-screen">
      <div className="container mx-auto p-6 space-y-8">
        <AnimatedContainer direction="up" delay={0}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight flex items-center gap-3">
                <Building2 className="w-10 h-10 text-primary" />
                Client Management
              </h1>
              <div className="athena-meander max-w-xs" aria-hidden="true" />
              <p className="text-muted-foreground mt-2">
                Manage clients, sites, and security assessments
              </p>
            </div>
            <Dialog open={isDialogOpen} onOpenChange={handleDialogOpenChange}>
              <DialogTrigger asChild>
                <Button
                  size="default"
                  data-testid="button-add-client"
                  onClick={() => {
                    setEditingClient(null);
                    setFormStatus("active");
                  }}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Client
                </Button>
              </DialogTrigger>
              <DialogContent data-testid="dialog-client-form">
                <DialogHeader>
                  <DialogTitle>{editingClient ? "Edit Client" : "Add New Client"}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Contact Name</Label>
                    <Input
                      id="name"
                      name="name"
                      defaultValue={editingClient?.name}
                      required
                      data-testid="input-client-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="company">Company</Label>
                    <Input
                      id="company"
                      name="company"
                      defaultValue={editingClient?.company}
                      required
                      data-testid="input-client-company"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      defaultValue={editingClient?.email}
                      required
                      data-testid="input-client-email"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="phone">Phone</Label>
                    <Input
                      id="phone"
                      name="phone"
                      defaultValue={editingClient?.phone || ""}
                      data-testid="input-client-phone"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="status">Status</Label>
                    <Select value={formStatus} onValueChange={setFormStatus}>
                      <SelectTrigger data-testid="select-client-status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="inactive">Inactive</SelectItem>
                        <SelectItem value="pending">Pending</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="notes">Notes</Label>
                    <Textarea
                      id="notes"
                      name="notes"
                      defaultValue={editingClient?.notes || ""}
                      rows={3}
                      data-testid="input-client-notes"
                    />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setIsDialogOpen(false);
                        setEditingClient(null);
                      }}
                      data-testid="button-cancel"
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      disabled={createMutation.isPending || updateMutation.isPending}
                      data-testid="button-save-client"
                    >
                      {editingClient ? "Update" : "Create"}
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </AnimatedContainer>

        <AnimatedContainer direction="up" delay={0.05}>
          <SampleDataNotice counts={["clients", "sites"]} />
        </AnimatedContainer>

        <AnimatedContainer direction="up" delay={0.1}>
          <GlassCard>
            <div className="flex flex-wrap gap-4 items-center">
              <div className="flex-1 min-w-[200px]">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search clients..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10"
                    data-testid="input-search-clients"
                  />
                </div>
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[180px]" data-testid="select-filter-status">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </GlassCard>
        </AnimatedContainer>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-primary border-r-transparent"></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {filteredClients.map((client, index) => (
              <AnimatedContainer key={client.id} direction="up" delay={0.05 * index}>
                <GlassCard className="hover-elevate">
                  <div className="space-y-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3
                            className="text-xl font-semibold"
                            data-testid={`text-client-name-${client.id}`}
                          >
                            {client.name}
                          </h3>
                          <Badge
                            variant={
                              client.status === "active"
                                ? "default"
                                : client.status === "inactive"
                                ? "secondary"
                                : "outline"
                            }
                            data-testid={`badge-client-status-${client.id}`}
                          >
                            {client.status}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                          <Building2 className="w-3 h-3" />
                          {client.company}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                      <div className="flex items-center gap-2">
                        <Mail className="w-4 h-4 text-muted-foreground" />
                        <span className="truncate">{client.email}</span>
                      </div>
                      {client.phone && (
                        <div className="flex items-center gap-2">
                          <Phone className="w-4 h-4 text-muted-foreground" />
                          <span>{client.phone}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-muted-foreground" />
                        <span>Created {format(new Date(client.createdAt), "MMM dd, yyyy")}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Shield className="w-4 h-4 text-muted-foreground" />
                        <span>{getClientTestCount(client.id)} Tests</span>
                      </div>
                    </div>

                    {client.notes && (
                      <div className="p-3 rounded-lg bg-muted/30 text-sm">
                        <div className="flex items-center gap-2 text-muted-foreground mb-1">
                          <FileText className="w-3 h-3" />
                          <span className="text-xs uppercase tracking-wide">Notes</span>
                        </div>
                        <p className="text-foreground">{client.notes}</p>
                      </div>
                    )}

                    <div className="flex gap-2 flex-wrap">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingClient(client);
                          setIsDialogOpen(true);
                        }}
                        data-testid={`button-edit-client-${client.id}`}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (confirm("Are you sure you want to delete this client?")) {
                            deleteMutation.mutate(client.id);
                          }
                        }}
                        data-testid={`button-delete-client-${client.id}`}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </GlassCard>
              </AnimatedContainer>
            ))}
          </div>
        )}

        {!isLoading && filteredClients.length === 0 && (
          <AnimatedContainer direction="up" delay={0.2}>
            <GlassCard>
              <div className="text-center py-12">
                <AlertCircle className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No clients found</h3>
                <p className="text-muted-foreground mb-4">
                  {searchTerm || statusFilter !== "all"
                    ? "Try adjusting your search or filters"
                    : "Get started by adding your first client"}
                </p>
                {!searchTerm && statusFilter === "all" && (
                  <Button onClick={() => setIsDialogOpen(true)} data-testid="button-add-first-client">
                    <Plus className="w-4 h-4 mr-2" />
                    Add Your First Client
                  </Button>
                )}
              </div>
            </GlassCard>
          </AnimatedContainer>
        )}
      </div>
    </div>
  );
}
