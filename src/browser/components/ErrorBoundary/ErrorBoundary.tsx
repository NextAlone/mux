import type { ReactNode } from "react";
import React, { Component } from "react";
import { useLanguage } from "@/browser/contexts/LanguageContext";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  workspaceInfo?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

function ErrorFallback(props: {
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  workspaceInfo?: string;
  onReset: () => void;
}) {
  const { t } = useLanguage();

  return (
    <div className="bg-error-bg-dark border-danger-soft text-danger-soft m-5 rounded border p-5">
      <h3 className="m-0 mb-2.5 text-base">
        {props.workspaceInfo
          ? `${t("Something went wrong in")} ${props.workspaceInfo}`
          : t("Something went wrong")}
      </h3>
      {props.error && (
        <pre className="my-2.5 rounded-sm bg-black/30 p-2.5 text-xs break-all whitespace-pre-wrap">
          {props.error.toString()}
          {props.errorInfo && (
            <>
              <br />
              {props.errorInfo.componentStack}
            </>
          )}
        </pre>
      )}
      <button
        onClick={props.onReset}
        className="bg-danger-soft hover:bg-info-light cursor-pointer rounded-sm border-none px-4 py-2 text-sm text-white"
      >
        {t("Reset")}
      </button>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <ErrorFallback
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          workspaceInfo={this.props.workspaceInfo}
          onReset={this.handleReset}
        />
      );
    }

    return this.props.children;
  }
}
