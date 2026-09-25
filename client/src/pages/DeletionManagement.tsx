import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { errorMessage } from "@/lib/loaded";
import { motion } from "framer-motion";
import { Trash2, AlertTriangle, FileText, Users, Shield, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Client, Test, Document } from "@shared/schema";
import AnimatedContainer from "@/components/AnimatedContainer";
import GlassCard from "@/components/GlassCard";
import SampleDataNotice from "@/components/SampleDataNotice";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function DeletionManagement() {
  const { toast } = useToast();
  const [deleteTarget, setDeleteTarget] = useState<{ type: string; id: string; name: string } | null>(null);

  const clientsQ = useQuery<Client[]>({ queryKey: ["/api/clients"] });
  const testsQ = useQuery<Test[]>({ queryKey: ["/api/tests"] });
  const documentsQ = useQuery<Document[]>({ queryKey: ["/api/documents"] });
  const clients = clientsQ.data ?? [];
  const tests = testsQ.data ?? [];
  const documents = documentsQ.data ?? [];
  // A count read from a source that failed, or has not answered, is not zero.
  const countOf = (q: { isError: boolean; data?: unknown[] }) =>
    q.isError ? "—" : q.data === undefined ? "…" : q.data.length;
  const totalItems = [clientsQ, testsQ, documentsQ].some((q) => q.isError)
    ? "—"
    : [clientsQ, testsQ, documentsQ].some((q) => q.data === undefined)
      ? "…"
      : clients.length + tests.length + documents.length;

  const deleteMutation = useMutation({
    mutationFn: async ({ type, id }: { type: string; id: string }) => {
      return await apiRequest("DELETE", `/api/${type}/${id}`);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: [`/api/${variables.type}`] });
      toast({
        title: "Deleted Successfully",
        description: `${variables.type.slice(0, -1)} has been permanently deleted.`,
      });
      setDeleteTarget(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Deletion Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleDelete = (type: string, id: string, name: string) => {
    setDeleteTarget({ type, id, name });
  };

  const confirmDelete = () => {
    if (deleteTarget) {
      deleteMutation.mutate({ type: deleteTarget.type, id: deleteTarget.id });
    }
  };

  const categories = [
    {
      title: "Clients",
      icon: Users,
      type: "clients",
      items: clients,
      query: clientsQ,
      color: "text-primary",
      getName: (item: any) => item.name,
      getDescription: (item: any) => item.company,
    },
    {
      title: "Tests",
      icon: Shield,
      type: "tests",
      items: tests,
      query: testsQ,
      color: "text-purple",
      getName: (item: any) => item.testType,
      getDescription: (item: any) => item.status,
    },
    {
      title: "Documents",
      icon: FileText,
      type: "documents",
      items: documents,
      query: documentsQ,
      color: "text-primary",
      getName: (item: any) => item.title,
      getDescription: (item: any) => item.documentType,
    },
  ];

  return (
    <div className="min-h-screen">
      <div className="container mx-auto p-6 space-y-8">
        <AnimatedContainer direction="up" delay={0}>
          <div className="space-y-2">
            <motion.h1
              className="text-3xl md:text-4xl font-bold tracking-tight flex items-center gap-3"
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1.2, delay: 0.3 }}
            >
              <Trash2 className="w-10 h-10 text-destructive" />
              Deletion <span className="bg-gradient-to-r from-destructive via-red-500 to-orange-500 bg-clip-text text-transparent">Management</span>
            </motion.h1>
            <div className="athena-meander max-w-xs" aria-hidden="true" />
            <motion.p
              className="text-muted-foreground"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.8, duration: 1 }}
            >
              Centralized interface for managing data deletion across all system entities
            </motion.p>
          </div>
        </AnimatedContainer>

        {/* This screen lists and counts every client, test and document --
            seeded demo rows among them -- so it says how many are seeded. */}
        <SampleDataNotice counts={["clients", "tests", "documents"]} />

        {/* Warning Banner */}
        <AnimatedContainer direction="up" delay={0.1}>
          <Card className="border-2 border-destructive/50 bg-destructive/5">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-6 h-6 text-destructive flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-destructive">Permanent Deletion Warning</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    All deletions are permanent and cannot be undone. Please review carefully before confirming any deletion operation.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </AnimatedContainer>

        {/* Deletion Categories */}
        <div className="grid gap-6 md:grid-cols-3">
          {categories.map((category, index) => {
            const Icon = category.icon;
            return (
              <AnimatedContainer key={category.type} direction="up" delay={0.2 + index * 0.1}>
                <GlassCard>
                  <CardHeader>
                    <CardTitle className={`flex items-center gap-2 ${category.color}`}>
                      <Icon className="w-5 h-5" />
                      {category.title}
                    </CardTitle>
                    <CardDescription>
                      {category.query.isError
                        ? `Could not load ${category.title.toLowerCase()}: ${errorMessage(category.query.error)}`
                        : `${category.items.length} item${category.items.length !== 1 ? "s" : ""} available`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 max-h-[400px] overflow-y-auto">
                      {category.query.isError ? null : category.items.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-4">
                          No {category.title.toLowerCase()} to delete
                        </p>
                      ) : (
                        category.items.map((item: any) => (
                          <motion.div
                            key={item.id}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            className="flex items-center justify-between p-3 rounded-lg border hover-elevate"
                            data-testid={`item-${category.type}-${item.id}`}
                          >
                            <div className="flex-1 min-w-0">
                              <p className="font-medium truncate">{category.getName(item)}</p>
                              <p className="text-sm text-muted-foreground truncate">
                                {category.getDescription(item)}
                              </p>
                            </div>
                            <Button
                              variant="destructive"
                              size="icon"
                              onClick={() =>
                                handleDelete(category.type, item.id, category.getName(item))
                              }
                              data-testid={`button-delete-${category.type}-${item.id}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </motion.div>
                        ))
                      )}
                    </div>
                  </CardContent>
                </GlassCard>
              </AnimatedContainer>
            );
          })}
        </div>

        {/* Statistics */}
        <AnimatedContainer direction="up" delay={0.5}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="w-5 h-5" />
                System Statistics
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-4">
                <div className="text-center space-y-1">
                  <p className="text-sm text-muted-foreground">Total Clients</p>
                  <p className="text-3xl font-bold text-primary" data-testid="text-total-clients">
                    {countOf(clientsQ)}
                  </p>
                </div>
                <div className="text-center space-y-1">
                  <p className="text-sm text-muted-foreground">Total Tests</p>
                  <p className="text-3xl font-bold text-purple" data-testid="text-total-tests">
                    {countOf(testsQ)}
                  </p>
                </div>
                <div className="text-center space-y-1">
                  <p className="text-sm text-muted-foreground">Total Documents</p>
                  <p className="text-3xl font-bold text-primary" data-testid="text-total-documents">
                    {countOf(documentsQ)}
                  </p>
                </div>
                <div className="text-center space-y-1">
                  <p className="text-sm text-muted-foreground">Total Items</p>
                  <p className="text-3xl font-bold" data-testid="text-total-items">
                    {totalItems}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </AnimatedContainer>

        {/* Deletion Confirmation Dialog */}
        <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="w-5 h-5" />
                Confirm Permanent Deletion
              </AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to permanently delete <strong>{deleteTarget?.name}</strong>?
                This action cannot be undone and all associated data will be lost.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="button-confirm-delete"
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Deleting..." : "Delete Permanently"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
