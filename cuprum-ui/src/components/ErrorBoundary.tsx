import { Component, type ErrorInfo, type ReactNode } from "react";
import { api, getLastInvokedCommand } from "@/lib/api";
import { Button } from "@/components/ui/Button";

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
    void api.crash.reportFrontend(
      error.message,
      `${error.stack ?? ""}\n${info.componentStack ?? ""}`,
      getLastInvokedCommand(),
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="text-lg font-medium">Произошла ошибка</p>
          <Button onClick={() => window.location.reload()}>Перезагрузить</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
