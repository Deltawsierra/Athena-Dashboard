import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { errorMessage } from "@/lib/loaded";
import { Plus, Search, Filter, FileText, Download, Trash2, Calendar, Pencil } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import SampleDataNotice from "@/components/SampleDataNotice";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Document, Client, InsertDocument } from "@shared/schema";

export default function Documents() {
  const [searchQuery, setSearchQuery] = useState("");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingDocument, setEditingDocument] = useState<Document | null>(null);
  const { toast } = useToast();

  const {
    data: held,
    isLoading,
    isError: documentsFailed,
    error: documentsError,
  } = useQuery<Document[]>({
    queryKey: ["/api/documents"],
  });
  // Every create, edit and delete refetches the list. A refetch that failed
  // keeps the last list in the cache; drawn under the error, it read as the
  // current record. The error wins (lib/loaded.ts): no rows from a failed read.
  const documents = documentsFailed ? [] : held ?? [];

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: InsertDocument) => apiRequest("POST", "/api/documents", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      toast({ title: "Document created successfully" });
      setIsCreateDialogOpen(false);
    },
    onError: (error) => {
      toast({ title: "Failed to create document", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<Document> }) =>
      apiRequest("PATCH", `/api/documents/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      toast({ title: "Document updated successfully" });
      setIsEditDialogOpen(false);
      setEditingDocument(null);
    },
    onError: (error) => {
      toast({ title: "Failed to update document", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/documents/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      toast({ title: "Document deleted successfully" });
    },
    onError: (error) => {
      toast({ title: "Failed to delete document", description: error.message, variant: "destructive" });
    },
  });

  const handleCreateDocument = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const data: InsertDocument = {
      clientId: formData.get("clientId") as string,
      title: formData.get("title") as string,
      description: formData.get("description") as string || null,
      documentType: formData.get("documentType") as string,
      fileUrl: formData.get("fileUrl") as string || null,
      createdBy: null,
    };
    createMutation.mutate(data);
  };

  const handleEditDocument = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingDocument) return;
    const formData = new FormData(e.currentTarget);
    const data: Partial<Document> = {
      title: formData.get("title") as string,
      description: formData.get("description") as string || null,
      documentType: formData.get("documentType") as string,
      fileUrl: formData.get("fileUrl") as string || null,
    };
    updateMutation.mutate({ id: editingDocument.id, data });
  };

  const filteredDocuments = documents.filter((doc) => {
    const matchesSearch = doc.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         doc.description?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesClient = clientFilter === "all" || doc.clientId === clientFilter;
    const matchesType = typeFilter === "all" || doc.documentType === typeFilter;
    
    return matchesSearch && matchesClient && matchesType;
  });

  const getTypeColor = (type: string) => {
    switch (type.toLowerCase()) {
      case "report":
        return "default";
      case "contract":
        return "secondary";
      case "invoice":
        return "outline";
      case "test-results":
        return "default";
      default:
        return "outline";
    }
  };

  const uniqueTypes = Array.from(new Set(documents.map(d => d.documentType)));

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
                <FileText className="w-10 h-10 text-primary" />
                Document <span className="bg-gradient-to-r from-gold via-primary to-gold-dim bg-clip-text text-transparent">Management</span>
              </motion.h1>
              <div className="athena-meander max-w-xs" aria-hidden="true" />
              <motion.p
                className="text-muted-foreground"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.8, duration: 1 }}
              >
                Organize and manage security documents, reports, and contracts for all clients
              </motion.p>
            </div>
            <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button data-testid="button-create-document" className="gap-2">
                  <Plus className="w-4 h-4" />
                  New Document
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add New Document</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleCreateDocument} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="clientId">Client</Label>
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
                    <Label htmlFor="title">Document Title</Label>
                    <Input id="title" name="title" placeholder="e.g., Q1 Security Report" required data-testid="input-title" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="documentType">Document Type</Label>
                    <Select name="documentType" required>
                      <SelectTrigger data-testid="select-type">
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="report">Report</SelectItem>
                        <SelectItem value="contract">Contract</SelectItem>
                        <SelectItem value="invoice">Invoice</SelectItem>
                        <SelectItem value="test-results">Test Results</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="description">Description</Label>
                    <Textarea id="description" name="description" placeholder="Brief description of the document..." rows={3} data-testid="input-description" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="fileUrl">File URL (Optional)</Label>
                    <Input id="fileUrl" name="fileUrl" placeholder="https://..." data-testid="input-url" />
                  </div>
                  <div className="flex justify-end gap-3">
                    <Button type="button" variant="outline" onClick={() => setIsCreateDialogOpen(false)} data-testid="button-cancel">
                      Cancel
                    </Button>
                    <Button type="submit" disabled={createMutation.isPending} data-testid="button-save">
                      {createMutation.isPending ? "Creating..." : "Create Document"}
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </AnimatedContainer>

        <AnimatedContainer direction="up" delay={0.05}>
          <SampleDataNotice counts={["documents"]} />
        </AnimatedContainer>

        <AnimatedContainer direction="up" delay={0.1}>
          <GlassCard>
            <div className="flex flex-col md:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search documents by title or description..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  data-testid="input-search"
                />
              </div>
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
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-full md:w-48" data-testid="select-filter-type">
                  <Filter className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="Filter by type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {uniqueTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </GlassCard>
        </AnimatedContainer>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {documentsFailed && (
            // A failed read is not an empty record: say so, not "No Documents Found".
            <div className="col-span-full">
              <GlassCard>
                <div className="text-center py-12">
                  <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                  <p className="text-muted-foreground">Could not load documents: {errorMessage(documentsError)}</p>
                </div>
              </GlassCard>
            </div>
          )}
          {!documentsFailed && filteredDocuments.length === 0 && (
            <div className="col-span-full">
              <AnimatedContainer direction="up" delay={0.2}>
                <GlassCard>
                  <div className="text-center py-12">
                    <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No Documents Found</h3>
                    <p className="text-muted-foreground">
                      {searchQuery || clientFilter !== "all" || typeFilter !== "all"
                        ? "Try adjusting your filters"
                        : "Create your first document to get started"}
                    </p>
                  </div>
                </GlassCard>
              </AnimatedContainer>
            </div>
          )}
          {filteredDocuments.map((doc, index) => {
            const client = clients.find(c => c.id === doc.clientId);
            
            return (
              <AnimatedContainer key={doc.id} direction="up" delay={0.2 + index * 0.05}>
                <GlassCard className="h-full hover-elevate active-elevate-2 transition-all cursor-pointer">
                  <div className="flex flex-col h-full space-y-4">
                    <div className="flex items-start justify-between gap-2">
                      <FileText className="w-8 h-8 text-primary flex-shrink-0" />
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingDocument(doc);
                            setIsEditDialogOpen(true);
                          }}
                          data-testid={`button-edit-${doc.id}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteMutation.mutate(doc.id);
                          }}
                          disabled={deleteMutation.isPending}
                          data-testid={`button-delete-${doc.id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="flex-1 space-y-3">
                      <div>
                        <h3 className="text-lg font-semibold mb-1 line-clamp-2" data-testid={`text-title-${doc.id}`}>
                          {doc.title}
                        </h3>
                        <Badge variant={getTypeColor(doc.documentType)} data-testid={`badge-type-${doc.id}`}>
                          {doc.documentType}
                        </Badge>
                      </div>

                      {doc.description && (
                        <p className="text-sm text-muted-foreground line-clamp-3" data-testid={`text-description-${doc.id}`}>
                          {doc.description}
                        </p>
                      )}

                      {client && (
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-muted-foreground">Client:</span>
                          <span className="font-medium" data-testid={`text-client-${doc.id}`}>{client.name}</span>
                        </div>
                      )}

                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Calendar className="w-4 h-4" />
                        <span data-testid={`text-date-${doc.id}`}>
                          {format(new Date(doc.createdAt), "MMM dd, yyyy")}
                        </span>
                      </div>
                    </div>

                    {doc.fileUrl && (
                      <div className="pt-2 border-t">
                        <a
                          href={doc.fileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`link-download-${doc.id}`}
                        >
                          <Download className="w-4 h-4" />
                          Download File
                        </a>
                      </div>
                    )}
                  </div>
                </GlassCard>
              </AnimatedContainer>
            );
          })}
        </div>

        {/* Edit Dialog */}
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Edit Document</DialogTitle>
            </DialogHeader>
            {editingDocument && (
              <form onSubmit={handleEditDocument} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="title">Title *</Label>
                  <Input
                    name="title"
                    placeholder="Document title..."
                    defaultValue={editingDocument.title}
                    required
                    data-testid="input-edit-title"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="documentType">Document Type *</Label>
                  <Select name="documentType" required defaultValue={editingDocument.documentType}>
                    <SelectTrigger data-testid="select-edit-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="report">Report</SelectItem>
                      <SelectItem value="contract">Contract</SelectItem>
                      <SelectItem value="invoice">Invoice</SelectItem>
                      <SelectItem value="test-results">Test Results</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    name="description"
                    placeholder="Document description..."
                    rows={4}
                    defaultValue={editingDocument.description || ""}
                    data-testid="input-edit-description"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="fileUrl">File URL</Label>
                  <Input
                    name="fileUrl"
                    placeholder="https://example.com/document.pdf"
                    type="url"
                    defaultValue={editingDocument.fileUrl || ""}
                    data-testid="input-edit-url"
                  />
                </div>

                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setIsEditDialogOpen(false)} data-testid="button-edit-cancel">
                    Cancel
                  </Button>
                  <Button type="submit" disabled={updateMutation.isPending} data-testid="button-edit-save">
                    {updateMutation.isPending ? "Updating..." : "Update Document"}
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
