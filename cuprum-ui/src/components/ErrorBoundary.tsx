import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportCrashSafe } from "@/lib/api";
import { Button } from "@/components/ui/Button";
// Class components cannot use hooks; access the shared i18n instance directly.
import i18n from "@/i18n";

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportCrashSafe(error.message, `${error.stack ?? ""}\n${info.componentStack ?? ""}`);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="text-lg font-medium">{i18n.t("crash:boundary.title")}</p>
          <Button onClick={() => window.location.reload()}>{i18n.t("crash:boundary.reload")}</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
