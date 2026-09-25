import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { errorMessage } from "@/lib/loaded";
import { motion } from "framer-motion";
import { Brain, Plus, Edit, Trash2, TrendingUp, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Classifier } from "@shared/schema";
import AnimatedContainer from "@/components/AnimatedContainer";
import GlassCard from "@/components/GlassCard";
import { format } from "date-fns";

export default function Classifiers() {
  const { toast } = useToast();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingClassifier, setEditingClassifier] = useState<Classifier | null>(null);
  const [createType, setCreateType] = useState("");
  const [editType, setEditType] = useState("");

  const {
    data: classifiers = [],
    isLoading,
    isError: classifiersFailed,
    error: classifiersError,
  } = useQuery<Classifier[]>({
    queryKey: ["/api/classifiers"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; type: string; accuracy: number; description: string }) => {
      return await apiRequest("POST", "/api/classifiers", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/classifiers"] });
      setIsCreateDialogOpen(false);
      setCreateType("");
      toast({
        title: "Classifier Created",
        description: "New classifier has been added successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Creation Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      return await apiRequest("PATCH", `/api/classifiers/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/classifiers"] });
      setIsEditDialogOpen(false);
      setEditingClassifier(null);
      setEditType("");
      toast({
        title: "Classifier Updated",
        description: "Classifier has been updated successfully.",
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

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest("DELETE", `/api/classifiers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/classifiers"] });
      toast({
        title: "Classifier Deleted",
        description: "Classifier has been removed successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Deletion Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const payload = {
      name: formData.get("name") as string,
      type: createType,
      accuracy: parseInt(formData.get("accuracy") as string),
      description: formData.get("description") as string,
    };
    createMutation.mutate(payload);
  };

  const handleEdit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingClassifier) return;
    const formData = new FormData(e.currentTarget);
    const payload: any = {
      name: formData.get("name") as string,
      type: editType || editingClassifier.type,
      accuracy: parseInt(formData.get("accuracy") as string),
      description: formData.get("description") as string,
    };
    updateMutation.mutate({ id: editingClassifier.id, data: payload });
  };

  const openEditDialog = (classifier: Classifier) => {
    setEditingClassifier(classifier);
    setEditType(classifier.type);
    setIsEditDialogOpen(true);
  };

  const getTypeColor = (type: string) => {
    switch (type.toLowerCase()) {
      case "threat":
        return "destructive";
      case "vulnerability":
        return "default";
      case "anomaly":
        return "secondary";
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
                <Brain className="w-10 h-10 text-primary" />
                AI <span className="bg-gradient-to-r from-gold via-primary to-gold-dim bg-clip-text text-transparent">Classifiers</span>
              </motion.h1>
              <div className="athena-meander max-w-xs" aria-hidden="true" />
              <motion.p
                className="text-muted-foreground"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.8, duration: 1 }}
              >
                Manage machine learning classifiers for threat detection and vulnerability analysis
              </motion.p>
            </div>
            <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button data-testid="button-create-classifier" className="gap-2">
                  <Plus className="w-4 h-4" />
                  New Classifier
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create New Classifier</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleCreate} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Name *</Label>
                    <Input
                      name="name"
                      placeholder="Classifier name..."
                      required
                      data-testid="input-create-name"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="type">Type *</Label>
                    <Select value={createType} onValueChange={setCreateType} required>
                      <SelectTrigger data-testid="select-create-type">
                        <SelectValue placeholder="Select type..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="threat">Threat Detection</SelectItem>
                        <SelectItem value="vulnerability">Vulnerability Analysis</SelectItem>
                        <SelectItem value="anomaly">Anomaly Detection</SelectItem>
                        <SelectItem value="malware">Malware Classification</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="accuracy">Accuracy % *</Label>
                    <Input
                      name="accuracy"
                      type="number"
                      min={0}
                      max={100}
                      placeholder="95"
                      required
                      data-testid="input-create-accuracy"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="description">Description</Label>
                    <Textarea
                      name="description"
                      placeholder="Classifier description..."
                      rows={3}
                      data-testid="input-create-description"
                    />
                  </div>

                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setIsCreateDialogOpen(false)}
                      data-testid="button-create-cancel"
                    >
                      Cancel
                    </Button>
                    <Button type="submit" disabled={createMutation.isPending} data-testid="button-create-submit">
                      {createMutation.isPending ? "Creating..." : "Create Classifier"}
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </AnimatedContainer>

        {/* Classifiers Grid */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {classifiers.map((classifier, index) => (
            <AnimatedContainer key={classifier.id} direction="up" delay={0.1 + index * 0.05}>
              <GlassCard className="group">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="flex items-center gap-2">
                        <Brain className="w-5 h-5 text-primary" />
                        {classifier.name}
                      </CardTitle>
                      <CardDescription className="mt-1">
                        {classifier.description || "No description"}
                      </CardDescription>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEditDialog(classifier)}
                        data-testid={`button-edit-${classifier.id}`}
                      >
                        <Edit className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteMutation.mutate(classifier.id)}
                        data-testid={`button-delete-${classifier.id}`}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Badge variant={getTypeColor(classifier.type)} data-testid={`badge-type-${classifier.id}`}>
                      {classifier.type}
                    </Badge>
                    <Badge variant={classifier.status === "active" ? "default" : "secondary"}>
                      {classifier.status}
                    </Badge>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground flex items-center gap-1">
                        <Target className="w-3 h-3" />
                        Accuracy
                      </span>
                      <span className="font-semibold" data-testid={`text-accuracy-${classifier.id}`}>
                        {classifier.accuracy}%
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground flex items-center gap-1">
                        <TrendingUp className="w-3 h-3" />
                        Training Data
                      </span>
                      <span className="font-semibold" data-testid={`text-training-${classifier.id}`}>
                        {classifier.trainingDataSize.toLocaleString()} samples
                      </span>
                    </div>

                    {classifier.lastTrainedAt && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Last Trained</span>
                        <span className="text-xs">
                          {format(new Date(classifier.lastTrainedAt), "MMM d, yyyy")}
                        </span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </GlassCard>
            </AnimatedContainer>
          ))}

          {classifiersFailed ? (
            // A failed read is not an empty list.
            <div className="col-span-full text-center py-12">
              <Brain className="w-16 h-16 text-muted-foreground mx-auto opacity-50" />
              <p className="text-muted-foreground mt-4">Could not load classifiers: {errorMessage(classifiersError)}</p>
            </div>
          ) : classifiers.length === 0 && (
            <div className="col-span-full text-center py-12">
              <Brain className="w-16 h-16 text-muted-foreground mx-auto opacity-50" />
              <p className="text-muted-foreground mt-4">No classifiers yet. Create one to get started.</p>
            </div>
          )}
        </div>

        {/* Edit Dialog */}
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Classifier</DialogTitle>
            </DialogHeader>
            {editingClassifier && (
              <form onSubmit={handleEdit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    name="name"
                    defaultValue={editingClassifier.name}
                    required
                    data-testid="input-edit-name"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="type">Type *</Label>
                  <Select value={editType} onValueChange={setEditType} required>
                    <SelectTrigger data-testid="select-edit-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="threat">Threat Detection</SelectItem>
                      <SelectItem value="vulnerability">Vulnerability Analysis</SelectItem>
                      <SelectItem value="anomaly">Anomaly Detection</SelectItem>
                      <SelectItem value="malware">Malware Classification</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="accuracy">Accuracy %</Label>
                  <Input
                    name="accuracy"
                    type="number"
                    min={0}
                    max={100}
                    defaultValue={editingClassifier.accuracy}
                    data-testid="input-edit-accuracy"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    name="description"
                    rows={3}
                    defaultValue={editingClassifier.description || ""}
                    data-testid="input-edit-description"
                  />
                </div>

                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsEditDialogOpen(false)}
                    data-testid="button-edit-cancel"
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={updateMutation.isPending} data-testid="button-edit-submit">
                    {updateMutation.isPending ? "Updating..." : "Update Classifier"}
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
