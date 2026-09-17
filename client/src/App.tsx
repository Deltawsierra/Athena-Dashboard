import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient, onUnauthorized } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Suspense, lazy, useCallback, useEffect, useState } from "react";

import AppShell from "@/components/AppShell";
import WebGLBoundary from "@/components/three/WebGLBoundary";
import MagneticCursor from "@/components/MagneticCursor";
import CursorGlow from "@/components/CursorGlow";
import SmoothScroll from "@/components/SmoothScroll";
import ErrorBoundary from "@/components/ErrorBoundary";
import Login from "@/pages/Login";
import Overview from "@/pages/Overview";
import PentestScan from "@/pages/PentestScan";
import AthenaScan from "@/pages/AthenaScan";
import Compliance from "@/pages/Compliance";
import Risks from "@/pages/Risks";
import Deployments from "@/pages/Deployments";
import Teams from "@/pages/Teams";
import CVEClassifier from "@/pages/CVEClassifier";
import Settings from "@/pages/Settings";
import Evidence from "@/pages/Evidence";
import AuditLogs from "@/pages/AuditLogs";
import Tests from "@/pages/Tests";
import Documents from "@/pages/Documents";
import AIHealth from "@/pages/AIHealth";
import AIControlPanel from "@/pages/AIControlPanel";
import AIChat from "@/pages/AIChat";
import DeletionManagement from "@/pages/DeletionManagement";
import Classifiers from "@/pages/Classifiers";
import Failsafe from "@/pages/Failsafe";
import Assurance from "@/pages/Assurance";
import NotFound from "@/pages/not-found";
import { checkAuth, logout as apiLogout, isAdmin } from "@/utils/auth";
import { applyStoredTheme } from "@/lib/theme";
import type { PublicUser } from "@shared/schema";

const AmbientField = lazy(() => import("@/components/three/AmbientField"));

type AuthStatus = "loading" | "authenticated" | "anonymous";

/**
 * Routes available once signed in. Admin-only screens are not registered at all
 * for non-admins, so they fall through to NotFound rather than rendering a page
 * whose API calls would 403.
 */
function AppRoutes({ admin }: { admin: boolean }) {
  return (
    <Switch>
      <Route path="/login">
        <Redirect to="/dashboard" />
      </Route>
      <Route path="/dashboard" component={Overview} />
      <Route path="/athena" component={AthenaScan} />
      <Route path="/clients" component={Deployments} />
      <Route path="/tests" component={Tests} />
      <Route path="/documents" component={Documents} />
      <Route path="/pentest" component={PentestScan} />
      <Route path="/findings" component={Risks} />
      <Route path="/assurance">{() => <Assurance admin={admin} />}</Route>
      <Route path="/compliance" component={Compliance} />
      <Route path="/classify-cve" component={CVEClassifier} />
      <Route path="/ai-health" component={AIHealth} />
      {admin && <Route path="/audit-logs" component={AuditLogs} />}
      <Route path="/ai-chat" component={AIChat} />
      <Route path="/classifiers" component={Classifiers} />
      {admin && <Route path="/evidence" component={Evidence} />}
      {admin && <Route path="/settings" component={Settings} />}
      {admin && <Route path="/admin" component={Teams} />}
      {admin && <Route path="/ai-control" component={AIControlPanel} />}
      {admin && <Route path="/deletion" component={DeletionManagement} />}
      {admin && <Route path="/failsafe" component={Failsafe} />}
      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<PublicUser | null>(null);

  // Apply the theme before anything renders so the login screen is themed too.
  useEffect(() => {
    applyStoredTheme();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void checkAuth().then((state) => {
      if (cancelled) return;
      setUser(state.user);
      setStatus(state.authenticated && state.user ? "authenticated" : "anonymous");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A session can expire, or the server restart, while the app is open. Without
  // this the app stayed in its authenticated state and every screen showed an
  // empty list, which reads as lost data rather than as a lost session.
  useEffect(
    () =>
      onUnauthorized(() => {
        queryClient.clear();
        setUser(null);
        setStatus("anonymous");
        setLocation("/login");
      }),
    [setLocation],
  );

  const handleAuthenticated = useCallback(
    (nextUser: PublicUser) => {
      setUser(nextUser);
      setStatus("authenticated");
      setLocation("/dashboard");
    },
    [setLocation],
  );

  const handleLogout = useCallback(async () => {
    await apiLogout();
    queryClient.clear();
    setUser(null);
    setStatus("anonymous");
    setLocation("/login");
  }, [setLocation]);

  let content: JSX.Element;
  if (status === "loading") {
    content = (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div
          className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-primary border-r-transparent"
          role="status"
          aria-label="Checking your session"
        />
      </div>
    );
  } else if (!user) {
    content = <Login onAuthenticated={handleAuthenticated} />;
  } else {
    content = (
      <AppShell onLogout={handleLogout} isAdmin={isAdmin(user)} username={user.username}>
        <AppRoutes admin={isAdmin(user)} />
      </AppShell>
    );
  }

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SmoothScroll>
            {/* The ambient layer is decorative, so a machine that cannot give
                it a WebGL context loses the gradient and keeps the app. */}
            <WebGLBoundary label="ambient field" fallback={null}>
              <Suspense fallback={null}>
                <AmbientField />
              </Suspense>
            </WebGLBoundary>
            <MagneticCursor />
            <CursorGlow />
            <Toaster />
            {content}
          </SmoothScroll>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
