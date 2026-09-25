import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { loaded } from "@/lib/loaded";
import { motion, AnimatePresence } from "framer-motion";
import { MessageSquare, Send, Paperclip, FileText, Copy, Check, Bot, User, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { AIChatMessage } from "@shared/schema";

interface AssistantStatus {
  configured: boolean;
  model: string | null;
  detail: string;
}
import AnimatedContainer from "@/components/AnimatedContainer";
import GlassCard from "@/components/GlassCard";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";

export default function AIChat() {
  const { toast } = useToast();
  const [message, setMessage] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Read error-first (lib/loaded.ts): the conversation is refetched after
  // every message sent, and a refetch that failed used to leave the last list
  // on screen as if it were the whole conversation.
  const messages$ = loaded(useQuery<AIChatMessage[]>({
    queryKey: ["/api/chat"],
  }));
  const messages = messages$.state === "ready" ? messages$.data : [];
  const isLoading = messages$.state === "loading";
  const messagesFailed = messages$.state === "error";
  // A failed read is not an empty conversation: its counts are unknown.
  const tally = (n: number) => (messagesFailed ? "—" : n);

  // Whether an assistant is connected, as the server last said -- or unknown.
  // A failed read is neither "connected" nor "not connected".
  const assistant$ = loaded(useQuery<AssistantStatus>({
    queryKey: ["/api/assistant/status"],
  }));
  const assistant = assistant$.state === "ready" ? assistant$.data : undefined;

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      const response = await apiRequest("POST", "/api/chat", { message: text });
      return (await response.json()) as {
        message: AIChatMessage;
        reply: AIChatMessage | null;
        error?: string;
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat"] });
      setMessage("");
      // The reply comes back from the server or it does not come back. What
      // used to be here picked one of five strings out of this file at random
      // and POSTed it as an AI message -- so the record could not tell an
      // answer from a placeholder, and three messages in the same sentence
      // came round again.
      if (result.error) {
        toast({
          title: "The assistant did not answer",
          description: result.error,
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Send Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSend = () => {
    if (!message.trim()) return;
    
    sendMutation.mutate(message.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    toast({
      title: "Copied",
      description: "Message copied to clipboard",
    });
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      toast({
        title: "File Selected",
        description: `${files[0].name} ready to upload`,
      });
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-primary border-r-transparent"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="container mx-auto p-6 space-y-6 max-w-5xl">
        <AnimatedContainer direction="up" delay={0}>
          <div className="space-y-2">
            <motion.h1
              className="text-3xl md:text-4xl font-bold tracking-tight flex items-center gap-3"
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1.2, delay: 0.3 }}
            >
              <MessageSquare className="w-10 h-10 text-primary" />
              AI <span className="bg-gradient-to-r from-gold via-primary to-gold-dim bg-clip-text text-transparent">Assistant</span>
            </motion.h1>
            <div className="athena-meander max-w-xs" aria-hidden="true" />
            <motion.p
              className="text-muted-foreground"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.8, duration: 1 }}
            >
              Communicate with Athena AI for security analysis and system control
            </motion.p>
          </div>
        </AnimatedContainer>

        {assistant$.state === "error" && (
          <GlassCard ruling>
            <p className="text-sm text-muted-foreground" data-testid="text-assistant-unread">
              Could not check whether an assistant is connected: {assistant$.message}
            </p>
          </GlassCard>
        )}

        {assistant && !assistant.configured && (
          <GlassCard ruling>
            <div className="flex gap-3 items-start">
              <Unplug className="w-5 h-5 mt-0.5 athena-gold shrink-0" />
              <div className="space-y-1">
                <div className="athena-label">No assistant connected</div>
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="text-assistant-detail"
                >
                  {assistant.detail}
                </p>
                <p className="text-sm text-muted-foreground">
                  What you type is still kept, so this stays a record of the
                  conversation. It will not be answered.
                </p>
              </div>
            </div>
          </GlassCard>
        )}

        {/* Chat Container */}
        <AnimatedContainer direction="up" delay={0.2}>
          <GlassCard className="overflow-hidden">
            <CardHeader className="border-b">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Bot className="w-5 h-5 text-primary" />
                  Athena AI Assistant
                </CardTitle>
                {/* What the badge says is now a fact about the deployment.
                    It was the literal word "Online" beside a pulsing green
                    dot, hardcoded -- so it read Online on a machine with no
                    assistant configured at all, which is the same defect as
                    the five canned replies wearing a smaller badge. */}
                <Badge
                  variant={assistant?.configured ? "default" : "outline"}
                  className="gap-1"
                  data-testid="badge-assistant"
                >
                  <div
                    className={`w-2 h-2 rounded-full ${
                      assistant?.configured ? "athena-live" : ""
                    }`}
                    style={{
                      background: assistant?.configured
                        ? "hsl(var(--primary))"
                        : "hsl(var(--sev-info))",
                    }}
                  />
                  {assistant
                    ? assistant.configured ? assistant.model : "Not connected"
                    : assistant$.state === "error" ? "Status unknown" : "Checking…"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {/* Messages Area */}
              <div className="h-[500px] overflow-y-auto p-6 space-y-4" data-testid="chat-messages">
                <AnimatePresence mode="popLayout">
                  {messages.map((msg, index) => {
                    const isUser = msg.sender === "user";
                    const isCopied = copiedId === msg.id;

                    return (
                      <motion.div
                        key={msg.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        transition={{ delay: index * 0.05 }}
                        className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}
                        data-testid={`message-${msg.id}`}
                      >
                        {/* Avatar */}
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                          isUser ? "bg-primary/20" : "bg-primary/20"
                        }`}>
                          {isUser ? (
                            <User className="w-5 h-5 text-primary" />
                          ) : (
                            <Bot className="w-5 h-5 text-primary" />
                          )}
                        </div>

                        {/* Message Bubble */}
                        <div className={`flex-1 max-w-[70%] space-y-1`}>
                          <div className={`flex items-center gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
                            <span className="text-sm font-semibold">
                              {isUser ? "You" : "Athena AI"}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(msg.timestamp), "h:mm a")}
                            </span>
                          </div>
                          
                          <div className={`relative group ${isUser ? "text-right" : "text-left"}`}>
                            <div className={`inline-block p-3 rounded-lg ${
                              isUser 
                                ? "bg-primary text-primary-foreground" 
                                : "bg-muted"
                            }`}>
                              <p className="whitespace-pre-wrap break-words">
                                {msg.message}
                              </p>
                            </div>
                            
                            <Button
                              variant="ghost"
                              size="icon"
                              className={`absolute top-1 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity ${
                                isUser ? "left-0" : "right-0"
                              }`}
                              onClick={() => handleCopy(msg.message, msg.id)}
                              data-testid={`button-copy-${msg.id}`}
                            >
                              {isCopied ? (
                                <Check className="w-3 h-3" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </Button>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
                
                {messages.length === 0 && (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center space-y-2">
                      <Bot className="w-16 h-16 text-muted-foreground mx-auto opacity-50" />
                      <p className="text-muted-foreground">
                        {messages$.state === "error"
                          ? `Could not load the conversation: ${messages$.message}`
                          : "No messages yet. Start a conversation with Athena AI"}
                      </p>
                    </div>
                  </div>
                )}
                
                <div ref={messagesEndRef} />
              </div>

              {/* Input Area */}
              <div className="border-t p-4 bg-background/50 backdrop-blur">
                <div className="flex gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={handleFileChange}
                    accept="image/*,.pdf,.txt,.doc,.docx"
                  />
                  
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleFileSelect}
                    data-testid="button-attach-file"
                  >
                    <Paperclip className="w-4 h-4" />
                  </Button>

                  <div className="flex-1 relative">
                    <Textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={
                        assistant?.configured
                          ? "Ask about this deployment… (Shift+Enter for a new line)"
                          : "No assistant is connected. This will be kept, not answered."
                      }
                      className="resize-none pr-12 min-h-[60px]"
                      data-testid="input-message"
                    />
                  </div>

                  <Button
                    onClick={handleSend}
                    disabled={!message.trim() || sendMutation.isPending}
                    size="icon"
                    className="self-end"
                    data-testid="button-send"
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </div>

                {/* Where the text goes, said before it goes. This product's
                    subject matter is other companies' vulnerabilities, and an
                    operator pointing the assistant at a hosted provider is
                    sending to a third party -- so the disclosure sits under
                    the composer rather than in a settings page nobody opens. */}
                <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                  <FileText className="w-3 h-3 shrink-0" />
                  {assistant?.configured ? (
                    <span data-testid="text-assistant-disclosure">
                      Sent to the configured endpoint as{" "}
                      <span className="athena-mono">{assistant.model}</span>,
                      with a summary of this deployment: how many clients,
                      sites and tests exist, and the severity counts already on
                      the record. Not the contents of findings or documents.
                    </span>
                  ) : (
                    <span>Kept on this machine. Nothing is sent anywhere.</span>
                  )}
                </div>
              </div>
            </CardContent>
          </GlassCard>
        </AnimatedContainer>

        {/* Chat Info */}
        <AnimatedContainer direction="up" delay={0.3}>
          <Card>
            <CardContent className="pt-6">
              <div className="grid gap-4 md:grid-cols-3 text-center">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Total Messages</p>
                  <p className="text-2xl font-bold" data-testid="text-total-messages">
                    {tally(messages.length)}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">AI Responses</p>
                  <p className="text-2xl font-bold" data-testid="text-ai-responses">
                    {tally(messages.filter(m => m.sender === "ai").length)}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Your Messages</p>
                  <p className="text-2xl font-bold" data-testid="text-user-messages">
                    {tally(messages.filter(m => m.sender === "user").length)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </AnimatedContainer>
      </div>
    </div>
  );
}
