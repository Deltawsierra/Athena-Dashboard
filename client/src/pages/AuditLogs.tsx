import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "@/lib/loaded";
import { Search, Filter, FileText, Calendar, User, Activity } from "lucide-react";
import { motion } from "framer-motion";
import { format } from "date-fns";
import GlassCard from "@/components/GlassCard";
import AnimatedContainer from "@/components/AnimatedContainer";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActivityLog } from "@shared/schema";

export default function AuditLogs() {
  const [searchQuery, setSearchQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>("all");

  const {
    data: logs = [],
    isLoading,
    isError: logsFailed,
    error: logsError,
  } = useQuery<ActivityLog[]>({
    queryKey: ["/api/logs"],
  });

  const filteredLogs = logs.filter((log) => {
    const matchesSearch = log.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         log.entityType.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         log.entityId?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesAction = actionFilter === "all" || log.action === actionFilter;
    const matchesEntityType = entityTypeFilter === "all" || log.entityType === entityTypeFilter;
    
    return matchesSearch && matchesAction && matchesEntityType;
  });

  const uniqueActions = Array.from(new Set(logs.map(l => l.action)));
  const uniqueEntityTypes = Array.from(new Set(logs.map(l => l.entityType)));

  const getActionColor = (action: string) => {
    switch (action) {
      case "created":
        return "default";
      case "updated":
        return "secondary";
      case "deleted":
        return "destructive";
      case "login":
        return "default";
      case "logout":
        return "outline";
      default:
        return "outline";
    }
  };

  const getActionIcon = (action: string) => {
    switch (action) {
      case "created":
        return "+";
      case "updated":
        return "✎";
      case "deleted":
        return "×";
      case "login":
        return "→";
      case "logout":
        return "←";
      default:
        return "•";
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
          <div className="space-y-2">
            <motion.h1
              className="text-3xl md:text-4xl font-bold tracking-tight flex items-center gap-3"
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1.2, delay: 0.3 }}
            >
              <FileText className="w-10 h-10 text-primary" />
              Audit <span className="bg-gradient-to-r from-gold via-primary to-gold-dim bg-clip-text text-transparent">Logs</span>
            </motion.h1>
            <div className="athena-meander max-w-xs" aria-hidden="true" />
            <motion.p
              className="text-muted-foreground"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.8, duration: 1 }}
            >
              Complete activity tracking and system audit trail
            </motion.p>
          </div>
        </AnimatedContainer>

        <AnimatedContainer direction="up" delay={0.1}>
          <GlassCard>
            <div className="flex flex-col md:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search logs by action, entity type, or ID..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  data-testid="input-search"
                />
              </div>
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger className="w-full md:w-48" data-testid="select-filter-action">
                  <Filter className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="Filter by action" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Actions</SelectItem>
                  {uniqueActions.map((action) => (
                    <SelectItem key={action} value={action}>
                      {action}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={entityTypeFilter} onValueChange={setEntityTypeFilter}>
                <SelectTrigger className="w-full md:w-48" data-testid="select-filter-entity">
                  <Filter className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="Filter by entity" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Entities</SelectItem>
                  {uniqueEntityTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </GlassCard>
        </AnimatedContainer>

        <AnimatedContainer direction="up" delay={0.2}>
          <GlassCard>
            {logsFailed ? (
              // A failed read is not an empty log: say so, not "No Activity Logs Found".
              <div className="text-center py-12">
                <Activity className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground">Could not load the activity log: {errorMessage(logsError)}</p>
              </div>
            ) : filteredLogs.length === 0 ? (
              <div className="text-center py-12">
                <Activity className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No Activity Logs Found</h3>
                <p className="text-muted-foreground">
                  {searchQuery || actionFilter !== "all" || entityTypeFilter !== "all"
                    ? "Try adjusting your filters"
                    : "Activity will appear here as actions are performed"}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-3 px-4 text-xs uppercase tracking-wide text-muted-foreground font-semibold">
                        Timestamp
                      </th>
                      <th className="text-left py-3 px-4 text-xs uppercase tracking-wide text-muted-foreground font-semibold">
                        Action
                      </th>
                      <th className="text-left py-3 px-4 text-xs uppercase tracking-wide text-muted-foreground font-semibold">
                        Entity Type
                      </th>
                      <th className="text-left py-3 px-4 text-xs uppercase tracking-wide text-muted-foreground font-semibold">
                        Entity ID
                      </th>
                      <th className="text-left py-3 px-4 text-xs uppercase tracking-wide text-muted-foreground font-semibold">
                        User ID
                      </th>
                      <th className="text-left py-3 px-4 text-xs uppercase tracking-wide text-muted-foreground font-semibold">
                        IP Address
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLogs.map((log, index) => (
                      <motion.tr
                        key={log.id}
                        className="border-b border-border hover-elevate"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.02, duration: 0.3 }}
                      >
                        <td className="py-3 px-4 text-sm">
                          <div className="flex items-center gap-2">
                            <Calendar className="w-3 h-3 text-muted-foreground" />
                            <span className="font-mono" data-testid={`text-timestamp-${log.id}`}>
                              {format(new Date(log.timestamp), "MMM dd, yyyy HH:mm:ss")}
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <Badge variant={getActionColor(log.action)} data-testid={`badge-action-${log.id}`}>
                            <span className="mr-1">{getActionIcon(log.action)}</span>
                            {log.action}
                          </Badge>
                        </td>
                        <td className="py-3 px-4">
                          <Badge variant="outline" data-testid={`badge-entity-type-${log.id}`}>
                            {log.entityType}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-sm font-mono text-muted-foreground" data-testid={`text-entity-id-${log.id}`}>
                          {log.entityId ? log.entityId.substring(0, 8) + "..." : "-"}
                        </td>
                        <td className="py-3 px-4 text-sm">
                          {log.userId ? (
                            <div className="flex items-center gap-2">
                              <User className="w-3 h-3 text-muted-foreground" />
                              <span className="font-mono" data-testid={`text-user-id-${log.id}`}>
                                {log.userId.substring(0, 8)}...
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-sm font-mono text-muted-foreground" data-testid={`text-ip-${log.id}`}>
                          {log.ipAddress || "-"}
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </GlassCard>
        </AnimatedContainer>

        {filteredLogs.length > 0 && (
          <AnimatedContainer direction="up" delay={0.3}>
            <div className="text-center text-sm text-muted-foreground">
              Showing {filteredLogs.length} of {logs.length} log entries
            </div>
          </AnimatedContainer>
        )}
      </div>
    </div>
  );
}
