import { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Error caught by boundary:", error, errorInfo);
    this.setState({ error, errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
    // Use Electron reload if available, otherwise use window reload
    if (true) {
      window.location.reload();
    } else {
      window.location.href = '/';
    }
  };

  handleHome = () => {
    // Navigate to dashboard using proper routing
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
    window.location.href = '/dashboard';
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <div className="max-w-2xl w-full space-y-8">
            <div className="text-center space-y-4">
              <div className="flex justify-center">
                <div className="relative">
                  <div className="absolute inset-0 blur-3xl bg-destructive/20 rounded-full"></div>
                  <AlertTriangle className="w-24 h-24 text-destructive relative" />
                </div>
              </div>
              
              <h1 className="text-4xl font-bold">Something went wrong</h1>
              <p className="text-muted-foreground text-lg">
                The application encountered an unexpected error. The error was written to the browser console, and its details are shown below.
              </p>
            </div>

            <div className="bg-card border rounded-lg p-6 space-y-4">
              <div className="space-y-2">
                <h3 className="font-semibold text-sm text-muted-foreground">Error Details</h3>
                <code className="block p-3 bg-muted rounded text-sm overflow-auto max-h-32">
                  {this.state.error?.message || "Unknown error occurred"}
                </code>
              </div>

              {process.env.NODE_ENV === "development" && this.state.errorInfo && (
                <div className="space-y-2">
                  <h3 className="font-semibold text-sm text-muted-foreground">Stack Trace</h3>
                  <pre className="p-3 bg-muted rounded text-xs overflow-auto max-h-48">
                    {this.state.errorInfo.componentStack}
                  </pre>
                </div>
              )}
            </div>

            <div className="flex gap-4 justify-center">
              <Button
                onClick={this.handleHome}
                variant="outline"
                className="gap-2"
              >
                <Home className="w-4 h-4" />
                Go to Dashboard
              </Button>
              <Button
                onClick={this.handleReset}
                className="gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                Reload Application
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}